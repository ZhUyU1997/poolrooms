// node 自测脚本：验证 textures.js 的接口契约与质量指标。
// 运行：node tools/test-textures.mjs
import * as THREE from 'three';
const tex = await import('../src/textures.js');

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function stdDev(values) {
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (values[i] - m) * (values[i] - m);
  return Math.sqrt(s / values.length);
}

// 统计 RGB 通道整体标准差（0~255 尺度）
function albedoStd(data, w, h) {
  const vals = new Float32Array(w * h * 3);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    vals[n++] = data[o]; vals[n++] = data[o + 1]; vals[n++] = data[o + 2];
  }
  return stdDev(vals);
}

// roughness G 通道动态范围（0~255 尺度）
function roughRange(data, w, h) {
  let mn = 255, mx = 0;
  for (let i = 0; i < w * h; i++) {
    const g = data[i * 4 + 1];
    if (g < mn) mn = g;
    if (g > mx) mx = g;
  }
  return mx - mn;
}

// 左右列、首末行平均绝对差（0~255 尺度，取 RGB 三通道平均）
function edgeDiff(data, w, h) {
  let sCol = 0, sRow = 0, c = 0;
  for (let y = 0; y < h; y++) {
    const a = (y * w) * 4, b = (y * w + w - 1) * 4;
    sCol += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
    c += 3;
  }
  for (let x = 0; x < w; x++) {
    const a = x * 4, b = ((h - 1) * w + x) * 4;
    sRow += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
    c += 3;
  }
  return { col: sCol / (h * 3), row: sRow / (w * 3) };
}

// 法线合法性：解码后长度接近 1、z 恒正
function normalCheck(data, w, h) {
  let sumLenErr = 0, minZ = 2;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const nx = (data[o] / 255) * 2 - 1;
    const ny = (data[o + 1] / 255) * 2 - 1;
    const nz = (data[o + 2] / 255) * 2 - 1;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    sumLenErr += Math.abs(len - 1);
    if (nz < minZ) minZ = nz;
  }
  return { avgLenErr: sumLenErr / n, minZ };
}

// 无 NaN / Infinity（对 Float 数组有意义）
function noNaN(data) {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

const results = [];
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('== Poolrooms textures 自测 ==\n');

const t0 = performance.now();

// ---- 7 套材质 ----
for (const name of tex.TEXTURE_SETS) {
  const set = tex.createTextureSet(name, { anisotropy: 8 });
  const w = set.map.image.width, h = set.map.image.height;
  const ad = set.map.image.data, nd = set.normalMap.image.data, rd = set.roughnessMap.image.data;

  const p2 = isPow2(w) && isPow2(h);
  const len = ad.length === w * h * 4 && nd.length === w * h * 4 && rd.length === w * h * 4;
  const nan = noNaN(ad) && noNaN(nd) && noNaN(rd);
  const aStd = albedoStd(ad, w, h);
  const rRange = roughRange(rd, w, h);
  const e = edgeDiff(ad, w, h);
  const eMax = Math.max(e.col, e.row);
  const nc = normalCheck(nd, w, h);

  console.log(`[${name}] ${w}x${h}  span=${set.spanMeters}m`);
  check(`尺寸 2 的幂`, p2);
  check(`data.length === w*h*4`, len);
  check(`无 NaN`, nan);
  check(`albedo 非纯色 (std=${aStd.toFixed(2)} > 1.5)`, aStd > 1.5);
  check(`roughness 动态范围 (range=${rRange} > 10)`, rRange > 10);
  check(`平铺 (左/右=${e.col.toFixed(2)}, 上/下=${e.row.toFixed(2)}, max=${eMax.toFixed(2)} < 6)`, eMax < 6);
  check(`法线长度≈1 (err=${nc.avgLenErr.toFixed(4)} < 0.05)`, nc.avgLenErr < 0.05);
  check(`法线 z 恒正 (minZ=${nc.minZ.toFixed(3)} > 0)`, nc.minZ > 0);
  console.log('');
}

// ---- caustic / ripple ----
const caustic = tex.createCausticTexture();
const rip = tex.createRippleNormal(1);
for (const [nm, t] of [['caustic', caustic], ['ripple', rip]]) {
  const w = t.image.width, h = t.image.height, d = t.image.data;
  const e = edgeDiff(d, w, h);
  const eMax = Math.max(e.col, e.row);
  console.log(`[${nm}] ${w}x${h}`);
  check(`${nm} 尺寸 2 的幂`, isPow2(w) && isPow2(h));
  check(`${nm} 平铺 (max=${eMax.toFixed(2)} < 6)`, eMax < 6);
  if (nm === 'ripple') {
    const nc = normalCheck(d, w, h);
    check(`ripple 法线长度≈1 (err=${nc.avgLenErr.toFixed(4)})`, nc.avgLenErr < 0.05);
    check(`ripple 法线 z 恒正`, nc.minZ > 0);
  }
  console.log('');
}

// ---- sky ----
const sky = tex.createSkyEquirect();
{
  const d = sky.image.data;
  const isFloat = sky.type === THREE.FloatType;
  let maxLum = 0, neg = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (l > maxLum) maxLum = l;
    if (d[i] < 0 || d[i + 1] < 0 || d[i + 2] < 0) neg++;
  }
  console.log('[sky] ' + sky.image.width + 'x' + sky.image.height);
  check('sky FloatType', isFloat);
  check(`sky 存在太阳高亮 (maxLum=${maxLum.toFixed(1)} > 10)`, maxLum > 10);
  check(`sky 无负值 (neg=${neg})`, neg === 0);
  check('sky 无 NaN', noNaN(d));
  console.log('');
}

// ---- dot ----
const dot = tex.createSoftDotTexture();
{
  const d = dot.image.data;
  const w = dot.image.width, h = dot.image.height;
  let centerAlpha = d[((h >> 1) * w + (w >> 1)) * 4 + 3];
  let cornerAlpha = d[0 * 4 + 3];
  console.log('[dot] ' + w + 'x' + h);
  check(`dot 中心不透明 (a=${centerAlpha} > 200)`, centerAlpha > 200);
  check(`dot 边缘透明 (a=${cornerAlpha} === 0)`, cornerAlpha === 0);
  console.log('');
}

const dt = performance.now() - t0;
const timeOk = dt < 2500;
if (timeOk) pass++; else fail++;
console.log('总生成耗时：' + dt.toFixed(1) + ' ms' + (timeOk ? '  (< 2500ms ✓)' : '  (超时 ✗)'));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
for (const r of results) console.log(r);
if (fail > 0) process.exit(1);
