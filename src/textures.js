// Poolrooms 程序化 PBR 纹理生成模块
// ============================================================
// 纯 TypedArray 数学实现：不碰 DOM / canvas / ImageData，不联网。
// 全部噪声用种子化 PRNG + 周期性格点 value noise，保证：
//  1) 确定性（刷新不变，便于反复调参）
//  2) 可平铺（格点坐标按频率取模、正弦波波矢取整数格、Sobel 采样环绕）
// 法线由高度场 Sobel 生成（OpenGL 风格 +Y 朝上，切线空间，编码 n*0.5+0.5）。

import * as THREE from 'three';

// 太阳方位（度）：与 createSkyEquirect 里画出的太阳盘严格对齐。
// 主程序可用它算方向光朝向。约定（与 three r185 equirectUv 一致）：
//   u = SUN_AZIMUTH_DEG / 360，v = 0.5 + SUN_ELEVATION_DEG / 180
//   az = (u - 0.5) * 2π，el = (v - 0.5) * π
//   太阳方向(从场景指向太阳) = (cos az * cos el, sin el, sin az * cos el)
export const SUN_AZIMUTH_DEG = 20;
export const SUN_ELEVATION_DEG = 42;

export const TEXTURE_SETS = ['mosaic', 'wallTile', 'deck', 'deckWet', 'plaster', 'blueTrim', 'metal'];

// ---------------- 基础数学 ----------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
// 三次平滑阶跃：两端导数为 0，避免噪声里出现硬折角
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const fract = (v) => v - Math.floor(v);
const toByte = (v) => Math.round(clamp01(v) * 255);

// ---------------- 种子 PRNG ----------------
// mulberry32：体积小、速度快、足够好的 32 位种子 PRNG。
// 关键点：全程不用 Math.random()，保证逐像素结果可复现。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- 周期性 value noise ----------------
// 格点哈希：整数格点 → [0,1)。用整数混合而非 sin，稳定且可复现。
function hash2(ix, iy, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (ix | 0), 0x9e3779b1) | 0;
  h = Math.imul(h ^ (iy | 0), 0x85ebca77) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x297a2d39) | 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// 格点值表缓存：一张 (seed, freq) 只建一次，内层循环纯查表，避免重复哈希。
const latticeCache = new Map();
function getLattice(seed, freq) {
  const key = seed * 1048576 + freq;
  let tab = latticeCache.get(key);
  if (!tab) {
    tab = new Float32Array(freq * freq);
    for (let j = 0; j < freq; j++) {
      for (let i = 0; i < freq; i++) tab[j * freq + i] = hash2(i, j, seed);
    }
    latticeCache.set(key, tab);
  }
  return tab;
}

// 对格点表双线性插值。x,y ∈ [0, freq)，格点下标按 freq 取模 → 天然周期、可平铺。
function valueNoise(x, y, tab, freq) {
  const mask = freq - 1;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = xi & mask, x1 = (xi + 1) & mask;
  const y0 = yi & mask, y1 = (yi + 1) & mask;
  const a = tab[y0 * freq + x0], b = tab[y0 * freq + x1];
  const c = tab[y1 * freq + x0], d = tab[y1 * freq + x1];
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// fbm：多倍频叠加。baseFreq 为最低频倍频（2 的幂），每层频率 ×2、幅度 ×0.5。
// 返回 [0,1) 区间、对 (x,y)∈[0,1) 可平铺的值。各层频率是整数倍 → 叠加后仍可平铺。
function makeFbm(seed, octaves, baseFreq) {
  const layers = [];
  let f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    layers.push({ tab: getLattice(seed + o * 7919, f), freq: f });
    f *= 2;
  }
  return function (x, y) {
    let sum = 0, norm = 0, amp = 0.5;
    for (let l = 0; l < layers.length; l++) {
      const L = layers[l];
      sum += amp * valueNoise(x * L.freq, y * L.freq, L.tab, L.freq);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

// ridged 噪声：1 - |2n-1|，在 n≈0.5 处形成细脊线。
const ridge = (n) => 1 - Math.abs(2 * n - 1);

// ---------------- 贴图装配 ----------------
function makeDataTexture(data, w, h, opts = {}) {
  const t = new THREE.DataTexture(data, w, h, opts.format, opts.type);
  t.wrapS = t.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  t.magFilter = opts.magFilter ?? THREE.LinearFilter;
  t.minFilter = opts.minFilter ?? THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = opts.generateMipmaps ?? true;
  t.anisotropy = opts.anisotropy ?? 1;
  if (opts.colorSpace !== undefined) t.colorSpace = opts.colorSpace;
  if (opts.mapping !== undefined) t.mapping = opts.mapping;
  t.needsUpdate = true;
  return t;
}

// 高度场 → 切线空间法线（Sobel，环绕采样）。strength 控制凹凸强度。
// 编码 n*0.5+0.5，z 基准 1（nz 恒正）。
function heightToNormal(h, w, hh, strength) {
  const out = new Uint8Array(w * hh * 4);
  for (let y = 0; y < hh; y++) {
    const yu = y === 0 ? hh - 1 : y - 1;
    const yd = y === hh - 1 ? 0 : y + 1;
    for (let x = 0; x < w; x++) {
      const xl = x === 0 ? w - 1 : x - 1;
      const xr = x === w - 1 ? 0 : x + 1;
      const hl = h[y * w + xl], hr = h[y * w + xr];
      const hu = h[yu * w + x], hd = h[yd * w + x];
      const gx = (hr - hl) * strength;
      const gy = (hd - hu) * strength;
      const nx = -gx, ny = -gy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * w + x) * 4;
      out[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

function allocBuffers(size) {
  return {
    size,
    albedo: new Uint8Array(size * size * 4),
    height: new Float32Array(size * size),
    rough: new Uint8Array(size * size * 4),
  };
}

// 环绕偏移表：画接近边缘的圆盘时，在对边补一份，保证贴图平铺。
function wrapOffsets(cx, cy, R, size) {
  const offs = [[0, 0]];
  if (cx < R) offs.push([size, 0]);
  if (cx > size - R) offs.push([-size, 0]);
  if (cy < R) offs.push([0, size]);
  if (cy > size - R) offs.push([0, -size]);
  if (cx < R && cy < R) offs.push([size, size]);
  if (cx < R && cy > size - R) offs.push([size, -size]);
  if (cx > size - R && cy < R) offs.push([-size, size]);
  if (cx > size - R && cy > size - R) offs.push([-size, -size]);
  return offs;
}

// 往 (stain 污渍遮罩 + height 高度) 上盖一个软圆盘。
function stampDisk(out, stain, size, cx, cy, radius, strength, depthAmt) {
  cx -= Math.floor(cx / size) * size;
  cy -= Math.floor(cy / size) * size;
  const R = Math.ceil(radius);
  const offs = wrapOffsets(cx, cy, R, size);
  for (let k = 0; k < offs.length; k++) {
    const sx = cx + offs[k][0], sy = cy + offs[k][1];
    const x0 = Math.max(0, Math.floor(sx - R)), x1 = Math.min(size - 1, Math.floor(sx + R));
    const y0 = Math.max(0, Math.floor(sy - R)), y1 = Math.min(size - 1, Math.floor(sy + R));
    for (let y = y0; y <= y1; y++) {
      const dy = y - sy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - sx;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius) continue;
        const fall = 1 - smoothstep(0, radius, Math.sqrt(d2));
        const i = y * size + x;
        const sv = strength * fall;
        if (sv > stain[i]) stain[i] = sv;
        if (depthAmt !== 0) out.height[i] -= depthAmt * fall;
      }
    }
  }
}

function stampLine(out, stain, size, x0, y0, x1, y1, radius, strength, depth) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 0.8));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stampDisk(out, stain, size, x0 + dx * t, y0 + dy * t, radius, strength, depth);
  }
}

// ---------------- 瓷砖类（mosaic / wallTile / blueTrim 共用骨架） ----------------
function genTiles(p) {
  const size = p.size, Nx = p.Nx, Ny = p.Ny;
  const rng = mulberry32(p.seed);
  const nb = Nx * Ny;
  const jit = new Float32Array(nb); // 每块亮度抖动 1±jitter
  const roughT = new Float32Array(nb); // 每块粗糙度内插 0..1
  const tint = new Float32Array(nb); // 每块偏色强度 0..1
  for (let i = 0; i < nb; i++) {
    jit[i] = 1 + (rng() - 0.5) * 2 * p.jitter;
    roughT[i] = rng();
    tint[i] = rng() < p.tintFrac ? 0.5 + 0.5 * rng() : 0;
  }
  const dirt = makeFbm(p.dirtSeed, 3, 8); // 缝内积垢（低中频）
  const glaze = makeFbm(p.glazeSeed, 2, p.glazeFreq); // 釉面高频波纹
  const wetN = p.wet ? makeFbm(p.wetSeed, 2, 2) : null; // 大尺度干湿分布

  const out = allocBuffers(size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv * Ny;
    const by = Math.floor(v);
    const ly = v - by;
    for (let x = 0; x < size; x++) {
      const u = x * inv * Nx;
      const bx = Math.floor(u);
      const lx = u - bx;
      const bi = by * Nx + bx;
      // 到最近块边的距离（块局部坐标）→ 决定缝/倒角区域
      const ed = Math.min(lx, 1 - lx, ly, 1 - ly);
      const inGrout = ed < p.groutHalf;
      const i = y * size + x, o = i * 4;
      const nx = x * inv, ny = y * inv;

      let r, g, b, rgh;
      if (inGrout) {
        // 缝：暖灰底色，fbm 积垢让局部变深
        const d = dirt(nx, ny) * p.dirtAmount;
        r = p.grout[0] * (1 - d);
        g = p.grout[1] * (1 - d);
        b = p.grout[2] * (1 - d);
        rgh = p.roughGrout;
        out.height[i] = -p.groutDepth;
      } else {
        r = p.base[0] * jit[bi];
        g = p.base[1] * jit[bi];
        b = p.base[2] * jit[bi];
        const t = tint[bi];
        if (t > 0) {
          const ts = t * p.tintStrength;
          r = lerp(r, p.tint[0], ts);
          g = lerp(g, p.tint[1], ts);
          b = lerp(b, p.tint[2], ts);
        }
        // 高度 = 中凸(穹顶) - 边缘倒角 + 釉面高频波纹
        const cx = lx - 0.5, cy = ly - 0.5;
        const dome = Math.max(0, 1 - (cx * cx + cy * cy) * 3.0) * p.dome;
        const chamfer = 1 - smoothstep(0, p.chamferW, ed);
        out.height[i] = dome - chamfer * p.chamferDepth + (glaze(nx, ny) - 0.5) * p.glazeAmp;

        rgh = lerp(p.roughFace[0], p.roughFace[1], roughT[bi]);
        if (wetN) {
          // 大尺度 fbm：局部更湿 → 更亮、更滑
          const wv = smoothstep(0.55, 0.85, wetN(nx, ny));
          r *= 1 + 0.06 * wv;
          g *= 1 + 0.06 * wv;
          b *= 1 + 0.06 * wv;
          rgh -= 0.05 * wv;
        }
      }
      out.albedo[o] = toByte(r);
      out.albedo[o + 1] = toByte(g);
      out.albedo[o + 2] = toByte(b);
      out.albedo[o + 3] = 255;
      const rb = toByte(rgh);
      out.rough[o] = out.rough[o + 1] = out.rough[o + 2] = rb;
      out.rough[o + 3] = 255;
    }
  }
  return { ...out, span: p.span, strength: p.strength };
}

// wallTile 专属：竖向水渍流痕 + 细裂纹（随机折线，albedo 变深 + 高度刻痕）
function addWallDetail(out, size, seed) {
  const rng = mulberry32(seed);
  const stain = new Float32Array(size * size);

  // 细裂纹：随机折线，行走不取模，靠 stampDisk 内部环绕 → 裂缝能无缝跨过边缘
  const nCracks = 6 + Math.floor(rng() * 5); // 6~10 条
  for (let c = 0; c < nCracks; c++) {
    let px = rng() * size, py = rng() * size;
    let ang = rng() * Math.PI * 2;
    const segs = 10 + Math.floor(rng() * 8);
    const step = size / (segs * 2.2);
    let x0 = px, y0 = py;
    for (let s = 0; s < segs; s++) {
      ang += (rng() - 0.5) * 1.3;
      px += Math.cos(ang) * step;
      py += Math.sin(ang) * step;
      stampLine(out, stain, size, x0, y0, px, py, 1.1, 0.3, 0.5);
      x0 = px; y0 = py;
    }
  }

  // 竖向水渍流痕：每道从"源头"向下渐淡（源头在上、末梢在下 → 上密下淡），
  // y 方向环绕 → 贴图平铺。用横向高斯衰减模拟水痕边缘。
  const nStreaks = 9 + Math.floor(rng() * 4); // 9~12 道
  for (let i = 0; i < nStreaks; i++) {
    const tr = {
      x: rng() * size,
      y0: rng() * size,
      len: size * (0.5 + rng() * 0.5),
      dark: 0.08 + rng() * 0.14,
      w: 1.5 + rng() * 4,
      phase: rng() * Math.PI * 2,
    };
    const lenPx = Math.ceil(tr.len);
    for (let dy = 0; dy < lenPx; dy++) {
      const y = tr.y0 + dy;
      const fade = tr.dark * (1 - smoothstep(0, tr.len, dy)); // 源头深、末梢淡
      if (fade <= 0.002) continue;
      const sx = tr.x + Math.sin(dy * 0.03 + tr.phase) * 3;
      stampDisk(out, stain, size, sx, y, tr.w, fade, 0);
    }
  }

  // 一次性应用污渍变暗（避免多次相乘叠加变糊）
  for (let i = 0; i < size * size; i++) {
    const s = stain[i];
    if (s > 0) {
      const o = i * 4;
      out.albedo[o] = Math.round(out.albedo[o] * (1 - s));
      out.albedo[o + 1] = Math.round(out.albedo[o + 1] * (1 - s));
      out.albedo[o + 2] = Math.round(out.albedo[o + 2] * (1 - s));
    }
  }
}

// ---------------- 水磨石池边（deck / deckWet） ----------------
const AGG_PALETTE = [
  [0.62, 0.60, 0.57], // 灰
  [0.82, 0.80, 0.76], // 暖白
  [0.45, 0.44, 0.42], // 深灰
  [0.70, 0.66, 0.60], // 暖灰
  [0.75, 0.74, 0.71], // 浅灰
];

function stampEllipse(out, size, cx, cy, rx, ry, ang, col) {
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  const R = Math.ceil(Math.max(rx, ry));
  const offs = wrapOffsets(cx, cy, R, size);
  for (let k = 0; k < offs.length; k++) {
    const sx = cx + offs[k][0], sy = cy + offs[k][1];
    const x0 = Math.max(0, Math.floor(sx - R)), x1 = Math.min(size - 1, Math.floor(sx + R));
    const y0 = Math.max(0, Math.floor(sy - R)), y1 = Math.min(size - 1, Math.floor(sy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - sx, dy = y - sy;
        const lx = dx * cosA + dy * sinA;
        const ly = -dx * sinA + dy * cosA;
        const q = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry);
        if (q >= 1.12) continue; // 边缘略硬：仅在 1px 内软化
        const f = 1 - smoothstep(0.85, 1.0, q);
        if (f <= 0) continue;
        const o = (y * size + x) * 4;
        out.albedo[o] = Math.round(lerp(out.albedo[o], col[0] * 255, f));
        out.albedo[o + 1] = Math.round(lerp(out.albedo[o + 1], col[1] * 255, f));
        out.albedo[o + 2] = Math.round(lerp(out.albedo[o + 2], col[2] * 255, f));
      }
    }
  }
}

function rasterizeAggregates(out, size, rng, count) {
  for (let a = 0; a < count; a++) {
    const cx = rng() * size, cy = rng() * size;
    const rx = 1 + rng() * 3; // 直径 2~8px
    const ry = 1 + rng() * 3;
    const ang = rng() * Math.PI;
    const col = AGG_PALETTE[(rng() * AGG_PALETTE.length) | 0];
    const j = 1 + (rng() - 0.5) * 0.12;
    stampEllipse(out, size, cx, cy, rx, ry, ang, [col[0] * j, col[1] * j, col[2] * j]);
  }
}

function genDeck(wet) {
  const size = 1024, span = 1.6;
  const seed = wet ? 0xda2a418e : 0x3c6ef372;
  const rng = mulberry32(seed);
  const out = allocBuffers(size);
  const tone = makeFbm(seed + 1, 3, 8); // 基色轻微色差
  const roughN = makeFbm(seed + 2, 3, 8); // 表面粗糙与微起伏
  const puddleN = wet ? makeFbm(seed + 3, 3, 8) : null; // 积水分布场
  const GROOVES = 80; // 防滑纹道数：80 道 → 每道 12.8px（整数道数保证平铺）
  const pmask = wet ? new Float32Array(size * size) : null;
  const inv = 1 / size;
  const base = [0.78, 0.76, 0.72];

  for (let y = 0; y < size; y++) {
    const ny = y * inv;
    for (let x = 0; x < size; x++) {
      const nx = x * inv;
      const i = y * size + x, o = i * 4;
      const rn = roughN(nx, ny);
      const tv = (tone(nx, ny) - 0.5) * 0.05;
      const r = base[0] + tv, g = base[1] + tv, b = base[2] + tv;

      // 防滑纹：沿 X 方向的细凹槽（高度谷）
      const gph = fract(x * GROOVES * inv);
      const groove = 1 - smoothstep(0.12, 0.38, Math.min(gph, 1 - gph));
      out.height[i] = (rn - 0.5) * 0.16 - groove * 0.35;

      out.albedo[o] = toByte(r);
      out.albedo[o + 1] = toByte(g);
      out.albedo[o + 2] = toByte(b);
      out.albedo[o + 3] = 255;

      let rgh = lerp(0.5, 0.62, rn);
      if (wet) {
        rgh = 0.18; // 湿基线
        // 积水：fbm 阈值，用窄 smoothstep 制造清晰的湿/干边界
        pmask[i] = smoothstep(0.6, 0.64, puddleN(nx, ny));
      }
      const rb = toByte(rgh);
      out.rough[o] = out.rough[o + 1] = out.rough[o + 2] = rb;
      out.rough[o + 3] = 255;
    }
  }

  rasterizeAggregates(out, size, rng, 420); // 300~600 颗骨料

  if (wet) {
    // 湿：整体 albedo ×0.82（更暗），积水处更深更滑（roughness 0.05）
    for (let i = 0; i < size * size; i++) {
      const pm = pmask[i];
      const o = i * 4;
      const factor = 0.82 * (1 - 0.2 * pm);
      out.albedo[o] = Math.round(out.albedo[o] * factor);
      out.albedo[o + 1] = Math.round(out.albedo[o + 1] * factor);
      out.albedo[o + 2] = Math.round(out.albedo[o + 2] * factor);
      const rb = toByte(lerp(0.18, 0.05, pm));
      out.rough[o] = out.rough[o + 1] = out.rough[o + 2] = rb;
    }
  }
  return { ...out, span, strength: wet ? 1.6 : 1.4 };
}

// ---------------- 顶面涂料 ----------------
function genPlaster() {
  const size = 512, span = 2.4, seed = 0x6b8e23d1;
  const out = allocBuffers(size);
  const big = makeFbm(seed, 2, 2); // 大尺度柔和起伏 (2,4)
  const moldN = makeFbm(seed + 1, 3, 8); // 霉斑/水渍分布
  const roughN = makeFbm(seed + 2, 2, 4); // 粗糙度变化
  const inv = 1 / size;
  const base = [0.92, 0.92, 0.9];

  for (let y = 0; y < size; y++) {
    const ny = y * inv;
    for (let x = 0; x < size; x++) {
      const nx = x * inv;
      const i = y * size + x, o = i * 4;
      const bigv = big(nx, ny);
      out.height[i] = (bigv - 0.5) * 6.0;
      // 霉斑：fbm 阈值 → 微棕灰，低不透明度；再加极轻微明暗云斑
      const mold = smoothstep(0.58, 0.78, moldN(nx, ny));
      const mott = 1 + (bigv - 0.5) * 0.05;
      const r = lerp(base[0], 0.62, mold * 0.18) * mott;
      const g = lerp(base[1], 0.6, mold * 0.18) * mott;
      const b = lerp(base[2], 0.55, mold * 0.18) * mott;
      out.albedo[o] = toByte(r);
      out.albedo[o + 1] = toByte(g);
      out.albedo[o + 2] = toByte(b);
      out.albedo[o + 3] = 255;
      const rb = toByte(lerp(0.78, 0.86, roughN(nx, ny)));
      out.rough[o] = out.rough[o + 1] = out.rough[o + 2] = rb;
      out.rough[o + 3] = 255;
    }
  }
  // 大尺度起伏波长很长（~128~256px），梯度天然很小，需要较大 strength 才能显出柔和明暗起伏
  return { ...out, span, strength: 8.0 };
}

// ---------------- 拉丝不锈钢 ----------------
function genMetal() {
  const size = 512, span = 1.0, seed = 0x297a2d39;
  const out = allocBuffers(size);
  const grain = makeFbm(seed, 3, 8); // 拉丝基底
  const stainN = makeFbm(seed + 1, 2, 4); // 指纹/水痕
  const inv = 1 / size;
  const base = [0.72, 0.73, 0.75];

  for (let y = 0; y < size; y++) {
    const ny = y * inv;
    for (let x = 0; x < size; x++) {
      const nx = x * inv;
      const i = y * size + x, o = i * 4;
      // 沿 U(x) 方向拉丝：噪声在 y 方向压缩 32 倍 → 高频细横纹、x 方向长丝。
      const b = grain(nx, ny * 32);
      out.height[i] = (b - 0.5) * 0.5;
      const s = smoothstep(0.62, 0.75, stainN(nx, ny)); // 很淡的指纹/水痕
      out.albedo[o] = toByte(base[0] * (1 - 0.05 * s) * (1 + (b - 0.5) * 0.06));
      out.albedo[o + 1] = toByte(base[1] * (1 - 0.05 * s) * (1 + (b - 0.5) * 0.06));
      out.albedo[o + 2] = toByte(base[2] * (1 - 0.05 * s) * (1 + (b - 0.5) * 0.06));
      out.albedo[o + 3] = 255;
      const rgh = lerp(0.18, 0.3, b) + 0.12 * s; // 拉丝 + 指纹局部抬高粗糙度
      const rb = toByte(rgh);
      out.rough[o] = out.rough[o + 1] = out.rough[o + 2] = rb;
      out.rough[o + 3] = 255;
    }
  }
  return { ...out, span, strength: 1.6 };
}

// ---------------- 各套参数 ----------------
const SET_DEFS = {
  mosaic: {
    size: 1024, span: 0.8, Nx: 16, Ny: 16, seed: 0x9e3779b9,
    base: [0.93, 0.91, 0.87], grout: [0.62, 0.6, 0.56],
    groutHalf: 0.02, jitter: 0.04, tintFrac: 0.05,
    tint: [0.86, 0.9, 0.92], tintStrength: 0.35,
    dome: 0.22, chamferW: 0.06, chamferDepth: 0.55, groutDepth: 0.9,
    roughFace: [0.1, 0.16], roughGrout: 0.72,
    glazeSeed: 0x1101, glazeFreq: 64, glazeAmp: 0.05,
    dirtSeed: 0x1102, dirtAmount: 0.38,
    wet: true, wetSeed: 0x1103,
    strength: 2.2,
  },
  wallTile: {
    size: 1024, span: 1.2, Nx: 6, Ny: 6, seed: 0x7f4a7c15,
    base: [0.9, 0.89, 0.85], grout: [0.66, 0.65, 0.61],
    groutHalf: 0.0075, jitter: 0.03, tintFrac: 0,
    tint: [0, 0, 0], tintStrength: 0,
    dome: 0.16, chamferW: 0.05, chamferDepth: 0.5, groutDepth: 0.8,
    roughFace: [0.12, 0.16], roughGrout: 0.7,
    glazeSeed: 0x2201, glazeFreq: 64, glazeAmp: 0.04,
    dirtSeed: 0x2202, dirtAmount: 0.3,
    wet: false,
    strength: 2.0,
    detailSeed: 0x2203,
  },
  blueTrim: {
    size: 512, span: 0.4, Nx: 4, Ny: 4, seed: 0x2c1b3c6d,
    base: [0.05, 0.22, 0.45], grout: [0.6, 0.62, 0.65],
    groutHalf: 0.022, jitter: 0.05, tintFrac: 0,
    tint: [0, 0, 0], tintStrength: 0,
    dome: 0.15, chamferW: 0.05, chamferDepth: 0.35, groutDepth: 0.7,
    roughFace: [0.06, 0.1], roughGrout: 0.55,
    glazeSeed: 0x4401, glazeFreq: 64, glazeAmp: 0.06,
    dirtSeed: 0x4402, dirtAmount: 0.15,
    wet: false,
    strength: 1.8,
  },
};

function genMosaic() { return genTiles(SET_DEFS.mosaic); }
function genBlueTrim() { return genTiles(SET_DEFS.blueTrim); }
function genWallTile() {
  const out = genTiles(SET_DEFS.wallTile);
  addWallDetail(out, SET_DEFS.wallTile.size, SET_DEFS.wallTile.detailSeed);
  return out;
}

const GENERATORS = {
  mosaic: genMosaic,
  wallTile: genWallTile,
  deck: () => genDeck(false),
  deckWet: () => genDeck(true),
  plaster: genPlaster,
  blueTrim: genBlueTrim,
  metal: genMetal,
};

// ---------------- 公共 API ----------------
export function createTextureSet(name, { anisotropy = 8 } = {}) {
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`createTextureSet: unknown set "${name}"`);
  const { size, span, strength, albedo, height, rough } = gen();
  const normal = heightToNormal(height, size, size, strength);
  return {
    map: makeDataTexture(albedo, size, size, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace, anisotropy,
    }),
    normalMap: makeDataTexture(normal, size, size, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, anisotropy,
    }),
    roughnessMap: makeDataTexture(rough, size, size, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, anisotropy,
    }),
    spanMeters: span,
  };
}

// 水下光斑：ridged 噪声取高次幂形成细亮丝网，两层不同尺度相乘。
// 用单倍频 value noise（分布更宽，黑底更干净）；R/G/B 用极小相位偏移采样
// （偏移在周期域内，仍可平铺）制造边缘色散。
export function createCausticTexture() {
  const size = 512;
  const n1 = makeFbm(0xca0f00, 1, 8);
  const n2 = makeFbm(0xca1000, 1, 16);
  const D = 0.008;
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  const sample = (u, v) => Math.pow(ridge(n1(u, v)), 6) * Math.pow(ridge(n2(u, v)), 7);
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const r = sample(u, v);
      const g = sample(u + D, v - D);
      const b = sample(u - D, v + D);
      const o = (y * size + x) * 4;
      data[o] = toByte(Math.min(1, r * 3.0));
      data[o + 1] = toByte(Math.min(1, g * 3.0));
      data[o + 2] = toByte(Math.min(1, b * 3.0));
      data[o + 3] = 255;
    }
  }
  return makeDataTexture(data, size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
}

// 水面法线：~24 个方向随机的正弦波叠加，波矢取整数格点（保证平铺），
// 振幅 ∝ 1/|k|（近似水面能量谱，长波主导 → 很平静），相位随机。
export function createRippleNormal(seed = 1) {
  const size = 512;
  const rng = mulberry32(seed >>> 0);
  const waves = [];
  for (let i = 0; i < 24; i++) {
    let kx, ky;
    do {
      kx = Math.floor(rng() * 25) - 12;
      ky = Math.floor(rng() * 25) - 12;
    } while (kx === 0 && ky === 0);
    const k = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: 1 / k, phase: rng() * Math.PI * 2 });
  }
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  const TWO_PI = Math.PI * 2;
  let maxA = 0;
  for (let y = 0; y < size; y++) {
    const yy = y * inv;
    for (let x = 0; x < size; x++) {
      const xx = x * inv;
      let s = 0;
      for (let w = 0; w < waves.length; w++) {
        const W = waves[w];
        s += W.amp * Math.sin((W.kx * xx + W.ky * yy) * TWO_PI + W.phase);
      }
      h[y * size + x] = s;
      const a = Math.abs(s);
      if (a > maxA) maxA = a;
    }
  }
  // 归一化到温和幅度，保证法线扰动平缓
  const scale = maxA > 0 ? 0.6 / maxA : 1;
  if (scale !== 1) for (let i = 0; i < h.length; i++) h[i] *= scale;
  const normal = heightToNormal(h, size, size, 1.2);
  return makeDataTexture(normal, size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
}

// equirect 天光（HDR FloatType）：天顶浅蓝 → 地平线过曝发白 → 下方地面反弹。
// 太阳盘 + 光晕按角距离衰减，亮度可 >1（供 IBL 与背景共用）。
export function createSkyEquirect() {
  const w = 1024, h = 512;
  const data = new Float32Array(w * h * 4);
  const zenith = [0.55, 0.72, 0.95];
  // 地平线亮度实测校准：1.6 会让"浅水镜面反射天空"整片过曝(30% 像素爆白)，压到 ~1.05
  const horizon = [1.02, 1.06, 1.10];
  const ground = [0.30, 0.33, 0.35];

  // 太阳方向（与导出常量严格一致）
  const uSun = SUN_AZIMUTH_DEG / 360;
  const vSun = 0.5 + SUN_ELEVATION_DEG / 180;
  const az = (uSun - 0.5) * Math.PI * 2;
  const el = (vSun - 0.5) * Math.PI;
  const sx = Math.cos(az) * Math.cos(el);
  const sy = Math.sin(el);
  const sz = Math.sin(az) * Math.cos(el);

  const diskR = 0.02; // 太阳盘角半径 ~1.15°
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const elPix = (v - 0.5) * Math.PI;
    const sinEl = Math.sin(elPix), cosEl = Math.cos(elPix);
    // 每行只算一次基色（只随仰角变）
    let r, g, b;
    if (elPix >= 0) {
      const t = smoothstep(0, 1.15, elPix);
      r = lerp(horizon[0], zenith[0], t);
      g = lerp(horizon[1], zenith[1], t);
      b = lerp(horizon[2], zenith[2], t);
    } else {
      const t = Math.min(1, -elPix / (Math.PI / 2));
      const gd = 1 - 0.18 * t; // 越靠近天底越暗一点
      r = ground[0] * gd;
      g = ground[1] * gd;
      b = ground[2] * gd;
    }
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const azPix = (u - 0.5) * Math.PI * 2;
      const dx = Math.cos(azPix) * cosEl, dy = sinEl, dz = Math.sin(azPix) * cosEl;
      const dot = dx * sx + dy * sy + dz * sz;
      const ang = Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot);
      // 太阳盘 + 近场光晕 + 宽幅光晕（都按角距离衰减）
      let sun = 0;
      if (ang < diskR) sun += 25 + 14 * (1 - ang / diskR);   // 太阳盘减半：直看/水面倒影不再刺眼（光柱靠方向光，不受影响）
      sun += 6.0 * Math.exp(-ang / 0.045);
      sun += 0.6 * Math.exp(-ang / 0.3);
      const o = (y * w + x) * 4;
      // 极轻微的方位向变化：让水面反射到的天空不是一块死板的纯色（±6%）
      const azVar = 1 + 0.06 * Math.sin(azPix + 0.7) + 0.035 * Math.sin(azPix * 2.3 - 1.1);
      data[o] = r * azVar + sun;
      data[o + 1] = g * azVar + sun * 0.95;
      data[o + 2] = b * azVar + sun * 0.85;
      data[o + 3] = 1.0;
    }
  }
  return makeDataTexture(data, w, h, {
    format: THREE.RGBAFormat, type: THREE.FloatType,
    mapping: THREE.EquirectangularReflectionMapping,
    wrap: THREE.ClampToEdgeWrapping,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
}

// 64² 软圆点：白心、alpha 从中心到边缘 smoothstep 衰减到 0（尘埃/辉光用）。
export function createSoftDotTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = 1 - smoothstep(0.0, 1.0, d);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = toByte(a);
    }
  }
  return makeDataTexture(data, size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
}
