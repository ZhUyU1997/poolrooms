// analyze-shot.mjs —— 把截图变成可读的数字（本模型看不了图，只能量化"看")
// 用法: node tools/analyze-shot.mjs <png> [gridCols] [gridRows]
// 输出：整体亮度分布、8x6 分区亮度/RGB/色相、细节密度(梯度)、纯黑/过曝占比
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit supported, got ' + bitDepth);
  if (interlace) throw new Error('interlaced png unsupported');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      switch (ft) {
        case 1: cur[i] = (cur[i] + a) & 255; break;
        case 2: cur[i] = (cur[i] + b) & 255; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hueName(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 12) return 'gray';
  let hh;
  if (mx === r) hh = 60 * (((g - b) / (mx - mn)) % 6);
  else if (mx === g) hh = 60 * ((b - r) / (mx - mn) + 2);
  else hh = 60 * ((r - g) / (mx - mn) + 4);
  if (hh < 0) hh += 360;
  if (hh < 20 || hh >= 330) return 'red';
  if (hh < 45) return 'orange';
  if (hh < 70) return 'yellow';
  if (hh < 160) return 'green';
  if (hh < 200) return 'cyan';
  if (hh < 260) return 'blue';
  return 'magenta';
}

const file = process.argv[2];
const cols = Number(process.argv[3] || 8);
const rows = Number(process.argv[4] || 6);
const img = decodePNG(fs.readFileSync(file));
const { w, h, ch, data } = img;

let sum = 0, black = 0, hot = 0, n = w * h;
const hist = new Array(16).fill(0);
for (let i = 0; i < n; i++) {
  const o = i * ch;
  const L = lum(data[o], data[o + 1], data[o + 2]);
  sum += L;
  if (L < 3) black++;
  if (L > 250) hot++;
  hist[Math.min(15, Math.floor(L / 16))]++;
}

// 细节密度：水平+垂直梯度均值（判断"糊不糊/有没有纹理"）
let grad = 0, gn = 0;
for (let y = 1; y < h; y += 2) {
  for (let x = 1; x < w; x += 2) {
    const o = (y * w + x) * ch, ol = (y * w + x - 1) * ch, ou = ((y - 1) * w + x) * ch;
    const L = lum(data[o], data[o + 1], data[o + 2]);
    grad += Math.abs(L - lum(data[ol], data[ol + 1], data[ol + 2]))
      + Math.abs(L - lum(data[ou], data[ou + 1], data[ou + 2]));
    gn++;
  }
}

console.log(`file      ${file}`);
console.log(`size      ${w}x${h} ch=${ch}`);
console.log(`mean lum  ${(sum / n).toFixed(1)} / 255`);
console.log(`black%    ${(black / n * 100).toFixed(2)}   hot%(>250) ${(hot / n * 100).toFixed(2)}`);
console.log(`detail    ${(grad / gn).toFixed(2)} (相邻像素亮度差均值; <1 偏糊, >4 细节丰富)`);
console.log(`histogram ${hist.map((v) => Math.round(v / n * 100)).join('|')}  (16 档亮度占比 %)`);
console.log(`\n分区网格 ${cols}x${rows}  [亮度 R,G,B 色相]`);
for (let gy = 0; gy < rows; gy++) {
  const cells = [];
  for (let gx = 0; gx < cols; gx++) {
    const x0 = Math.floor(gx * w / cols), x1 = Math.floor((gx + 1) * w / cols);
    const y0 = Math.floor(gy * h / rows), y1 = Math.floor((gy + 1) * h / rows);
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const o = (y * w + x) * ch;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; c++;
    }
    r /= c; g /= c; b /= c;
    cells.push(`${String(Math.round(lum(r, g, b))).padStart(3)} ${String(Math.round(r)).padStart(3)},${String(Math.round(g)).padStart(3)},${String(Math.round(b)).padStart(3)} ${hueName(r, g, b).padEnd(7)}`);
  }
  console.log(' ' + cells.join(' | '));
}
