// test-level.mjs —— 在 node 里直接跑 buildLevel 做几何探针 + 天空贴图方位校验
// 这些都是纯数学，不需要 WebGL，所以能在 node 里断言，比看截图猜靠谱。
import * as THREE from '../vendor/three/build/three.module.js';
import { buildLevel, WATER_Y } from '../src/level.js';
import { createSkyEquirect, SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from '../src/textures.js';

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

// --- 用桩材质库跑 buildLevel（只要 get()/emissive() 返回可用对象即可） ---
const stub = {
  get: (name) => ({ name, isMaterial: true, dispose() {} }),
  emissive: (c, i) => ({ name: 'emissive', isMaterial: true, dispose() {} }),
};
const level = buildLevel(stub);
const zones2 = level.zones;

console.log('== 关卡统计 ==');
const groups = [];
level.root.traverse((o) => {
  if (o.isMesh) groups.push([o.name, o.geometry.index.count / 3]);
});
console.log('  面组: ' + groups.map(([n, t]) => `${n.replace('surf_', '')}=${t}`).join(' '));
console.log('  三角形总数: ' + level.root.userData.triangles);
console.log('  水域: ' + level.waterAreas.length + '  光柱: ' + level.lightShafts.length + '  点光: ' + level.lights.length);

// --- 收集所有三角形，做"某点是否被实体覆盖"的探针 ---
const tris = [];
level.root.traverse((o) => {
  if (!o.isMesh) return;
  const p = o.geometry.attributes.position, idx = o.geometry.index;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    tris.push([
      new THREE.Vector3(p.getX(a), p.getY(a), p.getZ(a)),
      new THREE.Vector3(p.getX(b), p.getY(b), p.getZ(b)),
      new THREE.Vector3(p.getX(c), p.getY(c), p.getZ(c)),
    ]);
  }
});
console.log('  探针三角形池: ' + tris.length);

const ray = new THREE.Ray();
const hitPoint = new THREE.Vector3();
/** 从 origin 沿 dir 打一条射线，返回最近命中距离（双面）；无命中返回 Infinity */
function cast(origin, dir, maxDist = 200) {
  ray.set(origin, dir.clone().normalize());
  let best = Infinity;
  for (const [a, b, c] of tris) {
    const r = ray.intersectTriangle(a, b, c, false, hitPoint);
    if (r) {
      const d = hitPoint.distanceTo(origin);
      if (d > 1e-4 && d < best) best = d;
    }
  }
  return best;
}

console.log('\n== 开口探针（向上打射线，应"打不到东西"= 开口通天） ==');
const SKY = [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]];
for (const [x, z] of SKY) {
  const d = cast(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, 1, 0));
  ok(d === Infinity, `天窗 (${x},${z}) 通天 (命中距离=${d === Infinity ? '无' : d.toFixed(2)})`);
}
{
  const d = cast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0));
  ok(d !== Infinity && Math.abs(d - 4) < 0.6, `中庭正中上方有天花 (命中距离=${d === Infinity ? '无' : d.toFixed(2)}, 期望≈4)`);
}
for (const z of [-16, -26, -41]) {
  const d = cast(new THREE.Vector3(-3.5, 3.0, z), new THREE.Vector3(-1, 0, 0));
  ok(d === Infinity, `柱廊高窗 z=${z} 朝西通外 (命中距离=${d === Infinity ? '无' : d.toFixed(2)})`);
}
{
  const d = cast(new THREE.Vector3(14, 9.9, 20), new THREE.Vector3(-1, 0, 0));
  ok(d === Infinity, `深井高窗缝朝西通外 (命中距离=${d === Infinity ? '无' : d.toFixed(2)})`);
}

console.log('\n== 门洞探针（应能穿过；相邻房间之间 0.5m 间隙有套框但中间是空的） ==');
const doors = [
  ['中庭→柱廊', [0, 1.2, -11], [0, 0, -1]],
  ['柱廊→露台', [0, 1.2, -43.5], [0, 0, -1]],
  ['柱廊→阶梯厅', [3.6, 0.6, -28], [1, 0, 0]],
  ['阶梯厅→连接段', [10.5, -0.6, -27.5], [1, 0, 0]],
  ['隧道→深井', [14.5, -0.6, 12], [0, 0, 1]],
  ['深井→通道', [13.5, 0.9, 23.5], [-1, 0, 0]],
  ['通道→更衣', [10.5, 1.2, 23.5], [-1, 0, 0]],
  ['更衣→回廊', [4.6, 1.2, 22.5], [-1, 0, 0]],
  ['回廊→中庭', [2.2, 1.2, 13], [0, 0, -1]],
];
for (const [name, o, d] of doors) {
  const dist = cast(new THREE.Vector3(...o), new THREE.Vector3(...d), 8);
  ok(dist > 3, `${name} 可穿越 (最近命中=${dist === Infinity ? '无' : dist.toFixed(2)}, 需>3)`);
}

console.log('\n== 实心墙探针（应打得到） ==');
for (const [name, o, d, expect] of [
  ['中庭东墙', [0, 2, 0], [1, 0, 0], 12],
  ['中庭南墙', [0, 2, 0], [0, 0, 1], 12],
  ['柱廊东墙', [0, 2, -20], [1, 0, 0], 4],
]) {
  const dist = cast(new THREE.Vector3(...o), new THREE.Vector3(...d));
  ok(Math.abs(dist - expect) < 1.2, `${name} 命中 ${dist === Infinity ? '无' : dist.toFixed(2)} (期望≈${expect})`);
}

console.log('\n== 地面探针（脚下必须有东西，否则会掉出世界） ==');
const groundProbes = [
  ['出生点', level.spawn.position.x, level.spawn.position.z, 0.25],
  ['中庭池底', 0, 0, -1.4],
  ['柱廊', 0, -30, -0.25],
  ['露台', 0, -50, -0.35],
  ['隧道', 14.5, -10, -1.45],
  ['深井浅台', 20, 14, -1.45],
  ['深井底', 20, 22, -4.0],
  ['更衣间', 6, 23, 0.25],
  ['回廊', 2.2, 18, 0.25],
];
for (const [name, x, z, expectY] of groundProbes) {
  const from = new THREE.Vector3(x, expectY + 0.6, z);
  const d = cast(from, new THREE.Vector3(0, -1, 0));
  const y = d === Infinity ? NaN : from.y - d;
  ok(Number.isFinite(y) && Math.abs(y - expectY) < 0.35, `${name} 地面 y=${Number.isFinite(y) ? y.toFixed(2) : '无'} (期望≈${expectY})`);
}

console.log('\n== 水域一致性 ==');
for (const w of level.waterAreas) {
  ok(w.maxX > w.minX && w.maxZ > w.minZ, `水域 ${w.zone} 矩形有效`);
  ok(w.floorY < WATER_Y, `水域 ${w.zone} 池底(${w.floorY}) 低于水面`);
}
{
  // 干地不能有水
  const dry = [[6, 23], [2.2, 18], [0, 10.5]];
  let bad = 0;
  for (const [x, z] of dry) if (level.waterAt(x, z)) bad++;
  ok(bad === 0, `干区(更衣/回廊/中庭池边)没有铺水 (违规=${bad})`);
}

console.log('\n== 净高体检（玩家身高 1.70m，可站立点净高必须 >= 1.85m） ==');
{
  let worst = { clear: 1e9, at: '-' };
  let checked = 0;
  for (const zn of zones2) {
    if (zn.ceil == null) continue;
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        const x = zn.x[0] + (zn.x[1] - zn.x[0]) * i / 4;
        const z = zn.z[0] + (zn.z[1] - zn.z[0]) * j / 4;
        const from = new THREE.Vector3(x, zn.ceil - 0.05, z);
        const d = cast(from, new THREE.Vector3(0, -1, 0));
        if (d === Infinity) continue;
        checked++;
        if (d < worst.clear) worst = { clear: d, at: `${zn.name}(${x.toFixed(1)},${z.toFixed(1)})` };
      }
    }
  }
  ok(worst.clear >= 1.85, `最小净高 ${worst.clear.toFixed(2)}m @ ${worst.at}（采样 ${checked} 点）`);
}
console.log('\n== 天空 equirect 方位校验 ==');
const sky = createSkyEquirect();
const SW = sky.image.width, SH = sky.image.height, SD = sky.image.data;
function skyAt(dir) {
  const d = dir.clone().normalize();
  const u = Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5;
  const v = 0.5 + Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) / Math.PI;
  const x = Math.min(SW - 1, Math.max(0, Math.round(u * (SW - 1))));
  const y = Math.min(SH - 1, Math.max(0, Math.round(v * (SH - 1))));
  const o = (y * SW + x) * 4;
  return [SD[o], SD[o + 1], SD[o + 2]];
}
const up = skyAt(new THREE.Vector3(0, 1, 0));
const down = skyAt(new THREE.Vector3(0, -1, 0));
const horizon = skyAt(new THREE.Vector3(1, 0.02, 0));
const azr = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), elr = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
const sunDir = new THREE.Vector3(-Math.cos(azr) * Math.cos(elr), Math.sin(elr), -Math.sin(azr) * Math.cos(elr));
const atSun = skyAt(sunDir);
const fmt = (c) => `(${c.map(v => v.toFixed(2)).join(', ')})`;
console.log(`  天顶=${fmt(up)}  地平=${fmt(horizon)}  正下=${fmt(down)}  太阳方向=${fmt(atSun)}`);
ok(up[2] > up[0], '天顶偏蓝（B>R），说明贴图没上下颠倒');
ok(atSun[0] > 10, `太阳方向确实很亮 (R=${atSun[0].toFixed(1)} > 10) → 方位角约定与 main.js 一致`);
ok(down[0] < 1.0 && up[0] < 2.0, '地面/天顶亮度在合理范围（不是全白）');

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
