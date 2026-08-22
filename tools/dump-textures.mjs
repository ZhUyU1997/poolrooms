// 把程序化纹理导出为 PNG 供人眼检查（node 内置 zlib 写最小 PNG 编码器，无依赖）。
// 运行：node tools/dump-textures.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tex = await import('../src/textures.js');

// ---------------- 最小 PNG 编码器 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
// rgba: Uint8Array RGBA；colorType 2=RGB, 6=RGBA
function encodePNG(width, height, rgba, colorType = 2) {
  const bpp = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // 行滤波类型 None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[p++] = rgba[i];
      raw[p++] = rgba[i + 1];
      raw[p++] = rgba[i + 2];
      if (bpp === 4) raw[p++] = rgba[i + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// HDR float RGBA → 8bit RGB（简单曝光 tone map：1 - exp(-v)）
function tonemapFloat(data, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    out[o] = Math.round(Math.min(1, 1 - Math.exp(-data[o])) * 255);
    out[o + 1] = Math.round(Math.min(1, 1 - Math.exp(-data[o + 1])) * 255);
    out[o + 2] = Math.round(Math.min(1, 1 - Math.exp(-data[o + 2])) * 255);
    out[o + 3] = 255;
  }
  return out;
}

// ---------------- 生成并写盘 ----------------
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });

const files = [];
function save(name, texture, opts = {}) {
  const w = texture.image.width, h = texture.image.height;
  const isFloat = texture.type === 1015; // THREE.FloatType
  const data = isFloat ? tonemapFloat(texture.image.data, w, h) : texture.image.data;
  const buf = encodePNG(w, h, data, opts.rgba ? 6 : 2);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, buf);
  files.push([name, buf.length]);
}

for (const name of tex.TEXTURE_SETS) {
  const set = tex.createTextureSet(name);
  save(`${name}_albedo.png`, set.map);
  save(`${name}_normal.png`, set.normalMap);
  save(`${name}_roughness.png`, set.roughnessMap);
}
save('caustic.png', tex.createCausticTexture());
save('ripple.png', tex.createRippleNormal(1));
save('sky.png', tex.createSkyEquirect());
save('dot.png', tex.createSoftDotTexture(), { rgba: true });

console.log('导出目录：' + outDir);
for (const [n, b] of files) console.log(`${String(b).padStart(9)}  ${n}`);
console.log(`共 ${files.length} 个文件`);
