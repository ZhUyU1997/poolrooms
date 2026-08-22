// level.js —— 七区池核关卡：几何、开洞、水域表、灯光、光柱数据、分区与 GI 体积。
//
// 空间约定：X 东、Z 南、Y 上。**全场水面恒在 y = 0（WATER_Y）**，只有池底深度不同
// → 平面反射只需一次、涉水判定简单。
//
// 几何约定：
//  * 墙体是「单面平面」。相邻房间各有自己的墙面，中间留 0.5m 实心间隙，门洞处补 4 片套框
//    (jamb) 造出墙厚 → 既不共面 z-fighting，也不会出现双层墙。
//  * 所有 UV 由世界坐标三平面投影得到（单位：米），配合 materials.js 的 repeat=1/span，
//    全场瓷砖物理尺寸一致、绝不拉伸。
//  * 湿区墙面按高度分三段材质：水下马赛克 / 水线钴蓝腰线 / 水上大墙砖 —— 池核的灵魂细节。
import * as THREE from 'three';

export const WATER_Y = 0;
const JAMB = 0.5;          // 相邻房间墙面之间的实心间隙 = 门洞套框深度
const EPS = 1e-6;

// GI 强度档（materials.js 的世界空间 GI 场用）
// 数值经实测校准：室内即使"明亮区"也只能吃到很少的天光间接光，否则整个画面会被泡成一片灰
const GI_LEVEL = { bright: 0.55, sky: 0.95, mid: 0.24, dim: 0.13, dark: 0.065, warm: 0.08 };

// ---------------------------------------------------------------------------
// 房间壳体表（inner 尺寸；floor/ceil 为世界 y）
// ---------------------------------------------------------------------------
const ROOMS = {
  atrium:     { x: [-12, 12],    z: [-12, 12],    floor: 0.25,  ceil: 9.0,  gi: 'bright', wet: false, audio: 'atrium' },
  colonnade:  { x: [-4, 4],      z: [-44, -12.5], floor: -0.25, ceil: 6.0,  gi: 'bright', wet: true,  audio: 'colonnade' },
  terrace:    { x: [-9, 9],      z: [-58, -44.5], floor: -0.35, ceil: null, wallTop: 5.0, gi: 'sky', wet: true, audio: 'terrace' },
  stairwell:  { x: [4.5, 11],    z: [-32, -24],   floor: -1.45, ceil: 2.4,  gi: 'dim',    wet: true,  audio: 'stairwell' },
  connStair:  { x: [11.5, 12.5], z: [-29, -26],   floor: -1.45, ceil: 1.0,  gi: 'dark',   wet: true,  audio: 'tunnel' },
  tunnel:     { x: [13, 16],     z: [-32, 12.5],  floor: -1.45, ceil: 1.0,  gi: 'dark',   wet: true,  audio: 'tunnel' },
  deepwell:   { x: [13, 27],     z: [13, 27],     floor: -4.0,  ceil: 12.0, gi: 'dim',    wet: true,  audio: 'deepwell' },
  // 注意：本段地面从 -1.2 一路升到 +0.25，天花必须按**最高处**算净高（曾设 1.9 → 顶部净高仅 1.65m，玩家被夹死）
  connLocker: { x: [10, 12.5],   z: [22, 25],     floor: -1.2,  ceil: 2.6,  gi: 'dim',    wet: true,  audio: 'deepwell' },
  locker:     { x: [4, 9.5],     z: [20, 27],     floor: 0.25,  ceil: 3.05, gi: 'warm',   wet: false, audio: 'locker' },
  corridor:   { x: [1, 3.5],     z: [12.5, 24],   floor: 0.25,  ceil: 2.85, gi: 'dim',    wet: false, audio: 'locker' },
};

// 门洞：[房间A, A墙, 房间B, B墙, u范围(沿墙轴世界坐标), y范围]
const DOORS = [
  ['atrium', '-z', 'colonnade', '+z', [-2.2, 2.2], [0.25, 3.6]],
  ['colonnade', '+x', 'stairwell', '-x', [-29.5, -26.5], [-0.25, 2.3]],
  ['stairwell', '+x', 'connStair', '-x', [-28.4, -26.6], [-1.45, 0.85]],
  ['connStair', '+x', 'tunnel', '-x', [-28.4, -26.6], [-1.45, 0.85]],
  ['tunnel', '+z', 'deepwell', '-z', [13.6, 15.4], [-1.45, 0.85]],
  ['deepwell', '-x', 'connLocker', '+x', [22.5, 24.5], [-1.2, 1.5]],
  ['connLocker', '-x', 'locker', '+x', [22.5, 24.5], [0.25, 2.6]],
  ['locker', '-x', 'corridor', '+x', [21.0, 23.5], [0.25, 2.6]],
  ['corridor', '-z', 'atrium', '+z', [1.4, 3.1], [0.25, 2.6]],
  ['colonnade', '-z', 'terrace', '+z', [-3.4, 3.4], [-0.25, 4.2]],
];

const WINDOW_Z = [-16, -21, -26, -31, -36, -41];   // 柱廊西墙高窗
const SKYLIGHTS = [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]];
const SKY_H = 1.6;                                  // 天窗半宽

// ---------------------------------------------------------------------------
// 面片累加器
// ---------------------------------------------------------------------------
class SurfaceBuilder {
  constructor() { this.groups = new Map(); }

  _g(key) {
    let g = this.groups.get(key);
    if (!g) { g = { pos: [], nor: [], uv: [], idx: [] }; this.groups.set(key, g); }
    return g;
  }

  /** 四边形；desired = 期望法线（自动纠正绕向）；UV 由世界坐标三平面投影（米） */
  quad(key, a, b, c, d, desired) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    let pts = [a, b, c, d];
    if (desired && (nx * desired[0] + ny * desired[1] + nz * desired[2]) < 0) {
      pts = [d, c, b, a]; nx = -nx; ny = -ny; nz = -nz;
    }
    const g = this._g(key);
    const base = g.pos.length / 3;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (const p of pts) {
      g.pos.push(p[0], p[1], p[2]);
      g.nor.push(nx, ny, nz);
      if (ay >= ax && ay >= az) g.uv.push(p[0], p[2]);
      else if (ax >= az) g.uv.push(p[2], p[1]);
      else g.uv.push(p[0], p[1]);
    }
    g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** 轴对齐矩形：axis=法线轴, c=该轴坐标, dir=法线朝向, (u,v)=另两轴范围
   *  轴到 (u,v) 的映射固定为 y→(x,z) / x→(z,y) / z→(x,y)，与 UV 投影规则一致 */
  rect(key, axis, c, dir, u0, u1, v0, v1) {
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    if (v0 > v1) { const t = v0; v0 = v1; v1 = t; }
    if (u1 - u0 < EPS || v1 - v0 < EPS) return;
    const P = axis === 'y' ? (u, v) => [u, c, v]
      : axis === 'x' ? (u, v) => [c, v, u]
        : (u, v) => [u, v, c];
    const n = axis === 'y' ? [0, dir, 0] : axis === 'x' ? [dir, 0, 0] : [0, 0, dir];
    this.quad(key, P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), n);
  }

  rectHoles(key, axis, c, dir, u0, u1, v0, v1, holes) {
    for (const r of rectMinusHoles(u0, u1, v0, v1, holes)) {
      this.rect(key, axis, c, dir, r.u0, r.u1, r.v0, r.v1);
    }
  }

  /** 竖直倒角柱：4 主面 + 4 个 45° 倒角条（边缘高光线 = 近似 Nanite 的边缘细节） */
  column(key, x0, x1, z0, z1, y0, y1, ch, cap = false) {
    this.rect(key, 'x', x1, +1, z0 + ch, z1 - ch, y0, y1);
    this.rect(key, 'x', x0, -1, z0 + ch, z1 - ch, y0, y1);
    this.rect(key, 'z', z1, +1, x0 + ch, x1 - ch, y0, y1);
    this.rect(key, 'z', z0, -1, x0 + ch, x1 - ch, y0, y1);
    const corners = [
      [[x1 - ch, z0], [x1, z0 + ch], [1, 0, -1]],
      [[x1, z1 - ch], [x1 - ch, z1], [1, 0, 1]],
      [[x0 + ch, z1], [x0, z1 - ch], [-1, 0, 1]],
      [[x0, z0 + ch], [x0 + ch, z0], [-1, 0, -1]],
    ];
    for (const [p, q, n] of corners) {
      this.quad(key, [p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], n);
    }
    if (cap) this.rect(key, 'y', y1, +1, x0, x1, z0, z1);
  }

  /** 阶梯：沿 axis 从 fromY 降到 toY。descendPositive=true 表示坐标增大时下降。
   *  第 i 级（自高端起）踏面顶 = fromY - rise*(i+1)，踢面在该级靠高端那一侧。 */
  steps(key, axis, a0, a1, o0, o1, fromY, toY, count, descendPositive) {
    const run = (a1 - a0) / count;
    const rise = (fromY - toY) / count;
    for (let i = 0; i < count; i++) {
      const top = fromY - rise * (i + 1);
      const s = descendPositive ? a0 + run * i : a1 - run * (i + 1);
      const e = s + run;
      if (axis === 'x') {
        this.rect(key, 'y', top, +1, s, e, o0, o1);                                  // 踏面
        this.rect(key, 'x', descendPositive ? s : e, descendPositive ? +1 : -1, o0, o1, top, top + rise); // 踢面
      } else {
        this.rect(key, 'y', top, +1, o0, o1, s, e);
        this.rect(key, 'z', descendPositive ? s : e, descendPositive ? +1 : -1, o0, o1, top, top + rise);
      }
    }
  }

  /** 条纹地面（泳道线） */
  stripedFloor(baseKey, stripeKey, y, x0, x1, z0, z1, centers, halfW) {
    const cuts = [x0];
    for (const c of centers) cuts.push(c - halfW, c + halfW);
    cuts.push(x1);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = Math.max(x0, cuts[i]), b = Math.min(x1, cuts[i + 1]);
      if (b - a < EPS) continue;
      this.rect(i % 2 === 1 ? stripeKey : baseKey, 'y', y, +1, a, b, z0, z1);
    }
  }

  build(lib) {
    const group = new THREE.Group();
    group.name = 'levelSurfaces';
    let tris = 0;
    for (const [key, g] of this.groups) {
      if (!g.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
      geo.setIndex(g.idx);
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      tris += g.idx.length / 3;
      const mesh = new THREE.Mesh(geo, lib.get(key));
      mesh.name = 'surf_' + key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    group.userData.triangles = tris;
    return group;
  }
}

/** 矩形挖洞 → 若干子矩形（条带切割：先按 u 切列，再在列内按 v 切段） */
function rectMinusHoles(u0, u1, v0, v1, holes) {
  const hs = (holes || []).filter(h => h.u1 > u0 + EPS && h.u0 < u1 - EPS && h.v1 > v0 + EPS && h.v0 < v1 - EPS);
  if (!hs.length) return [{ u0, u1, v0, v1 }];
  const cuts = new Set([u0, u1]);
  for (const h of hs) { cuts.add(Math.max(u0, h.u0)); cuts.add(Math.min(u1, h.u1)); }
  const us = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < us.length - 1; i++) {
    const a = us[i], b = us[i + 1];
    if (b - a < EPS) continue;
    const mid = (a + b) / 2;
    const col = hs.filter(h => h.u0 <= mid && h.u1 >= mid).sort((p, q) => p.v0 - q.v0);
    let v = v0;
    for (const h of col) {
      const hv0 = Math.max(v0, h.v0), hv1 = Math.min(v1, h.v1);
      if (hv0 > v + EPS) out.push({ u0: a, u1: b, v0: v, v1: hv0 });
      v = Math.max(v, hv1);
    }
    if (v1 > v + EPS) out.push({ u0: a, u1: b, v0: v, v1 });
  }
  return out;
}

function wallInfo(room, wall) {
  const r = ROOMS[room];
  const axis = wall[1];
  const positive = wall[0] === '+';
  return { axis, c: positive ? r[axis][1] : r[axis][0], dir: positive ? +1 : -1 };
}

// ---------------------------------------------------------------------------
export function buildLevel(lib) {
  const S = new SurfaceBuilder();
  const holes = new Map();
  const waterAreas = [];
  const lightShafts = [];
  const zones = [];
  const lights = [];
  const giZones = [];
  const decor = new THREE.Group(); decor.name = 'decor';

  const punch = (room, wall, u, v) => {
    const k = `${room}:${wall}`;
    if (!holes.has(k)) holes.set(k, []);
    holes.get(k).push({ u0: u[0], u1: u[1], v0: v[0], v1: v[1] });
  };

  // ---- 1. 开洞登记 -------------------------------------------------------
  for (const [ra, wa, rb, wb, u, v] of DOORS) { punch(ra, wa, u, v); punch(rb, wb, u, v); }
  for (const z of WINDOW_Z) punch('colonnade', '-x', [z - 1, z + 1], [1.2, 5.2]);
  punch('deepwell', '-x', [17, 23], [9.6, 10.2]);

  // ---- 2. 房间壳体 -------------------------------------------------------
  for (const [name, r] of Object.entries(ROOMS)) {
    const top = r.ceil ?? r.wallTop;

    // 地面（stairwell / connLocker 的地面完全由阶梯构成，中庭要挖出泳池）
    // 露台池底用深一档的马赛克（同贴图、基色更暗）：浅水反射天空虽亮，池底不再被太阳晒成一片爆白
    const floorMat = name === 'terrace' ? 'mosaic:0x8fa2ab' : (r.wet ? 'mosaic' : (name === 'atrium' ? 'deck' : 'deckWet'));
    if (name === 'atrium') {
      S.rectHoles(floorMat, 'y', r.floor, +1, r.x[0], r.x[1], r.z[0], r.z[1],
        [{ u0: -8, u1: 8, v0: -8, v1: 8 }]);
    } else if (name !== 'stairwell' && name !== 'connLocker') {
      S.rect(floorMat, 'y', r.floor, +1, r.x[0], r.x[1], r.z[0], r.z[1]);
    }

    // 天花（中庭带 4 个天窗洞）
    if (r.ceil != null) {
      const ceilHoles = name === 'atrium'
        ? SKYLIGHTS.map(([cx, cz]) => ({ u0: cx - SKY_H, u1: cx + SKY_H, v0: cz - SKY_H, v1: cz + SKY_H }))
        : [];
      S.rectHoles('plaster', 'y', r.ceil, -1, r.x[0], r.x[1], r.z[0], r.z[1], ceilHoles);
    }

    // 四面墙：湿区分三段材质
    const bands = r.wet
      ? [[Math.min(r.floor, -1.5) - 0.6, -0.02, 'mosaic'], [-0.02, 0.18, 'blueTrim'], [0.18, top, 'wallTile']]
      : [[r.floor - 0.4, top, 'wallTile']];
    for (const wall of ['-x', '+x', '-z', '+z']) {
      const { axis, c, dir } = wallInfo(name, wall);
      const other = axis === 'x' ? 'z' : 'x';
      const hs = holes.get(`${name}:${wall}`) || [];
      for (const [b0, b1, mat] of bands) {
        S.rectHoles(mat, axis, c, -dir, r[other][0], r[other][1], b0, b1, hs);
      }
    }

    zones.push({ name, audio: r.audio, x: r.x.slice(), z: r.z.slice(), floor: r.floor, ceil: top });
    giZones.push({
      center: new THREE.Vector3((r.x[0] + r.x[1]) / 2, (r.floor + top) / 2, (r.z[0] + r.z[1]) / 2),
      half: new THREE.Vector3((r.x[1] - r.x[0]) / 2 + 0.9, (top - r.floor) / 2 + 0.9, (r.z[1] - r.z[0]) / 2 + 0.9),
      intensity: GI_LEVEL[r.gi],
    });
  }

  // ---- 3. 门洞/窗套框 ----------------------------------------------------
  const jamb = (mat, axis, cA, cB, u0, u1, v0, v1) => {
    const lo = Math.min(cA, cB), hi = Math.max(cA, cB);
    if (axis === 'x') {              // 洞沿 x 贯穿：u = z, v = y
      S.rect(mat, 'z', u0, +1, lo, hi, v0, v1);
      S.rect(mat, 'z', u1, -1, lo, hi, v0, v1);
      S.rect(mat, 'y', v1, -1, lo, hi, u0, u1);
      S.rect(mat, 'y', v0, +1, lo, hi, u0, u1);
    } else {                         // 洞沿 z 贯穿：u = x, v = y
      S.rect(mat, 'x', u0, +1, lo, hi, v0, v1);
      S.rect(mat, 'x', u1, -1, lo, hi, v0, v1);
      S.rect(mat, 'y', v1, -1, u0, u1, lo, hi);
      S.rect(mat, 'y', v0, +1, u0, u1, lo, hi);
    }
  };
  for (const [ra, wa, rb, wb, u, v] of DOORS) {
    const A = wallInfo(ra, wa), B = wallInfo(rb, wb);
    jamb('wallTile', A.axis, A.c, B.c, u[0], u[1], v[0], v[1]);
  }
  for (const z of WINDOW_Z) jamb('wallTile', 'x', -4, -4 - JAMB, z - 1, z + 1, 1.2, 5.2);
  jamb('wallTile', 'x', 13, 13 - JAMB, 17, 23, 9.6, 10.2);
  for (const [cx, cz] of SKYLIGHTS) {   // 天窗井
    S.rect('plaster', 'x', cx - SKY_H, +1, cz - SKY_H, cz + SKY_H, 9.0, 9.0 + JAMB);
    S.rect('plaster', 'x', cx + SKY_H, -1, cz - SKY_H, cz + SKY_H, 9.0, 9.0 + JAMB);
    S.rect('plaster', 'z', cz - SKY_H, +1, cx - SKY_H, cx + SKY_H, 9.0, 9.0 + JAMB);
    S.rect('plaster', 'z', cz + SKY_H, -1, cx - SKY_H, cx + SKY_H, 9.0, 9.0 + JAMB);
  }

  // ---- 4. 中庭泳池 ------------------------------------------------------
  {
    const px0 = -8, px1 = 8, pz0 = -8, pz1 = 8, pf = -1.4, deck = 0.25;
    S.stripedFloor('mosaic', 'blueTrim', pf, px0, px1, pz0, pz1,
      [-6.25, -3.75, -1.25, 1.25, 3.75, 6.25], 0.125);
    for (const [b0, b1, mat] of [[pf, -0.02, 'mosaic'], [-0.02, 0.18, 'blueTrim'], [0.18, deck, 'mosaic']]) {
      S.rect(mat, 'x', px0, +1, pz0, pz1, b0, b1);
      S.rect(mat, 'x', px1, -1, pz0, pz1, b0, b1);
      S.rect(mat, 'z', pz0, +1, px0, px1, b0, b1);
      S.rect(mat, 'z', pz1, -1, px0, px1, b0, b1);
    }
    // 北侧入水阶梯（向南下沉，7 级）+ 最后一段踢面
    // 10 级：级高 0.164 ≤ 胶囊半径的一半，保证能从池里走上来（7 级时级高 0.21 偶发爬不上）
    S.steps('mosaic', 'z', -8, -4.8, -7.5, -4.3, deck, -1.39, 10, true);
    S.rect('mosaic', 'z', -4.8, +1, -7.5, -4.3, -1.4, -1.39);
    waterAreas.push({ minX: px0, maxX: px1, minZ: pz0, maxZ: pz1, floorY: pf, zone: 'atrium' });

    // 四根落水柱：水下马赛克 / 水线钴蓝 / 水上墙砖
    for (const [cx, cz] of [[-5.5, -5.5], [5.5, -5.5], [-5.5, 5.5], [5.5, 5.5]]) {
      const h = 0.45;
      S.column('mosaic', cx - h, cx + h, cz - h, cz + h, pf, -0.02, 0.06);
      S.column('blueTrim', cx - h, cx + h, cz - h, cz + h, -0.02, 0.18, 0.06);
      S.column('wallTile', cx - h, cx + h, cz - h, cz + h, 0.18, 9.0, 0.06);
    }
    // 入水阶梯旁的不锈钢扶手（装饰，不参与碰撞）
    addBar(decor, lib, [-7.7, 0.75, -6.6], [0.06, 1.0, 0.06]);
    addBar(decor, lib, [-7.7, 1.25, -5.6], [0.06, 0.06, 2.1]);
  }

  // ---- 5. 柱廊 ---------------------------------------------------------
  {
    waterAreas.push({ minX: -4, maxX: 4, minZ: -44, maxZ: -13.0, floorY: -0.25, zone: 'colonnade' });
    S.steps('mosaic', 'z', -13.5, -12.5, -2.2, 2.2, 0.25, -0.0833, 2, false);
    S.rect('mosaic', 'z', -13.5, -1, -2.2, 2.2, -0.25, -0.0833);
    for (const cz of WINDOW_Z) {
      S.column('wallTile', 1.2, 1.8, cz - 0.3, cz + 0.3, -0.25, 6.0, 0.05);
      addBar(decor, lib, [-4.06, 3.2, cz], [0.1, 0.1, 2.0]);          // 横档
      addBar(decor, lib, [-4.06, 3.2, cz], [0.1, 4.0, 0.1]);          // 中竖
      lightShafts.push({ axis: 'x', c: -4, dir: +1, u: [cz - 1, cz + 1], v: [1.2, 5.2], intensity: 1.0 });
    }
  }

  // ---- 6. 露台 ---------------------------------------------------------
  {
    waterAreas.push({ minX: -9, maxX: 9, minZ: -58, maxZ: -44.5, floorY: -0.35, zone: 'terrace' });
    for (const cx of [-5.5, 5.5]) {
      S.column('wallTile', cx - 0.35, cx + 0.35, -51.35, -50.65, -0.35, 5.0, 0.05, true);
    }
  }

  // ---- 7. 下潜阶梯厅（西高东低，8 级） ---------------------------------
  {
    S.steps('mosaic', 'x', 4.5, 11, -32, -24, -0.25, -1.45, 8, true);
    waterAreas.push({ minX: 4.5, maxX: 11, minZ: -32, maxZ: -24, floorY: -0.9, zone: 'stairwell' });
    addLamp(decor, lib, lights, [5.05, 1.7, -25.0], 0xffcf96, 15, 0.2);
  }

  // ---- 8. 潜水隧道 -----------------------------------------------------
  {
    waterAreas.push({ minX: 11.5, maxX: 12.5, minZ: -29, maxZ: -26, floorY: -1.45, zone: 'tunnel' });
    waterAreas.push({ minX: 13, maxX: 16, minZ: -32, maxZ: 12.5, floorY: -1.45, zone: 'tunnel' });
    addUnderwaterLight(decor, lib, lights, [15.72, -0.75, -24], true);
    addUnderwaterLight(decor, lib, lights, [15.72, -0.75, -12], true);
    addUnderwaterLight(decor, lib, lights, [15.72, -0.75, 0], true);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 43, 10, 1, true), lib.get('metal'));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(15.6, 0.8, -9.75);
    decor.add(pipe);
  }

  // ---- 9. 深井厅 -------------------------------------------------------
  {
    S.rect('mosaic', 'y', -1.45, +1, 13, 27, 13, 15.5);          // 北侧浅台
    S.rect('mosaic', 'z', 15.5, +1, 13, 27, -4.0, -1.45);
    S.rect('mosaic', 'y', -1.2, +1, 13, 14.6, 22, 25);           // 西门前台
    S.rect('mosaic', 'x', 14.6, +1, 22, 25, -4.0, -1.2);
    S.rect('mosaic', 'z', 22, -1, 13, 14.6, -4.0, -1.2);
    S.rect('mosaic', 'z', 25, +1, 13, 14.6, -4.0, -1.2);
    waterAreas.push({ minX: 13, maxX: 27, minZ: 13, maxZ: 27, floorY: -4.0, zone: 'deepwell' });
    for (let i = 0; i < 9; i++) addBar(decor, lib, [20, -3.8 + i * 0.3, 15.42], [0.5, 0.05, 0.05]);
    lightShafts.push({ axis: 'x', c: 13, dir: +1, u: [17, 23], v: [9.6, 10.2], intensity: 1.4 });
    addLamp(decor, lib, lights, [26.7, 6.0, 20.0], 0x9dc4e8, 30, 0.28);
    addUnderwaterLight(decor, lib, lights, [13.3, -2.2, 19.0], false);
  }

  // ---- 10. 深井→更衣通道（八级出水台阶） -------------------------------
  {
    // 这段只有 2.25m 长，做台阶必然"级高 > 半径的一半"→ 胶囊爬不上去（实测卡死）。
    // 改成缓坡（32°）：法线 y=0.84 会被判为地面，行走稳定；泳池入水坡道也很合理。
    S.rect('mosaic', 'y', 0.25, +1, 10.0, 10.25, 22, 25);
    S.quad('mosaic', [10.25, 0.25, 22], [12.5, -1.2, 22], [12.5, -1.2, 25], [10.25, 0.25, 25], [0, 1, 0]);
    waterAreas.push({ minX: 10.625, maxX: 12.5, minZ: 22, maxZ: 25, floorY: -1.2, zone: 'deepwell' });
  }

  // ---- 11. 更衣角 ------------------------------------------------------
  {
    for (const cz of [20.7, 26.3]) {
      S.column('wallTile', 4.6, 8.9, cz - 0.22, cz + 0.22, 0.25, 0.68, 0.04, true);   // 长凳
    }
    for (const cz of [22.2, 23.5, 24.8]) {
      addBar(decor, lib, [9.3, 2.25, cz], [0.36, 0.07, 0.07]);
      addBar(decor, lib, [9.14, 2.06, cz], [0.07, 0.34, 0.07]);
    }
    addLamp(decor, lib, lights, [4.28, 2.45, 23.5], 0xffb063, 8.5, 0.24);   // 更衣角要"暖而暗"，实测 22 会把小房间照到均值 185
  }

  // ---- 12. 回廊 --------------------------------------------------------
  addLamp(decor, lib, lights, [1.28, 2.45, 18.0], 0xffdcaa, 5.5, 0.18);

  // ---- 13. 天窗光柱 + 金属框 -------------------------------------------
  for (const [cx, cz] of SKYLIGHTS) {
    lightShafts.push({ axis: 'y', c: 9.0, dir: -1, u: [cx - SKY_H, cx + SKY_H], v: [cz - SKY_H, cz + SKY_H], intensity: 1.15 });
    for (const off of [-SKY_H, SKY_H]) {
      addBar(decor, lib, [cx + off, 9.0, cz], [0.09, 0.1, SKY_H * 2]);
      addBar(decor, lib, [cx, 9.0, cz + off], [SKY_H * 2, 0.1, 0.09]);
    }
  }

  // ---- 14. 环境填充光（伪反弹；总点光 8 个以内，前向渲染省灯） ---------
  addFill(lights, [0, 7.2, 0], 0xd8ecff, 40, 26);
  addFill(lights, [0, 4.2, -28], 0xdfeeff, 16, 22);

  const root = S.build(lib);

  return {
    root, decor, waterAreas, lightShafts, zones, lights, giZones,
    spawn: { position: new THREE.Vector3(-1.6, 0.27, 9.6), yaw: 0.06 },
    bounds: new THREE.Box3(new THREE.Vector3(-14, -7, -61), new THREE.Vector3(30, 15, 30)),
    zoneAt(x, z) {
      for (const zn of zones) {
        if (x >= zn.x[0] - 0.7 && x <= zn.x[1] + 0.7 && z >= zn.z[0] - 0.7 && z <= zn.z[1] + 0.7) return zn;
      }
      return zones[0];
    },
    waterAt(x, z) {
      for (const w of waterAreas) {
        if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ) return w;
      }
      return null;
    },
  };
}

// --- 道具 -------------------------------------------------------------------
function addBar(parent, lib, pos, size) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), lib.get('metal'));
  m.position.set(pos[0], pos[1], pos[2]);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function addLamp(parent, lib, lights, pos, color, intensity, size) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(size, size * 1.7, size * 0.45), lib.emissive(color, 4.5));
  box.position.set(pos[0], pos[1], pos[2]);
  parent.add(box);
  const l = new THREE.PointLight(color, intensity, 0, 2);
  l.position.set(pos[0], pos[1], pos[2]);
  lights.push(l);
}

/** 水下灯：withLight=false 时只放自发光灯具（省实时灯，靠 bloom 也能亮） */
function addUnderwaterLight(parent, lib, lights, pos, withLight) {
  const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 16), lib.emissive(0x9fe8ff, 3.5));
  disk.rotation.z = Math.PI / 2;
  disk.position.set(pos[0], pos[1], pos[2]);
  parent.add(disk);
  if (withLight) {
    const l = new THREE.PointLight(0x7fd8ff, 11, 0, 2);
    l.position.set(pos[0] - 0.45, pos[1], pos[2]);
    lights.push(l);
  }
}

function addFill(lights, pos, color, intensity, dist) {
  const l = new THREE.PointLight(color, intensity, dist, 2);
  l.position.set(pos[0], pos[1], pos[2]);
  lights.push(l);
}
