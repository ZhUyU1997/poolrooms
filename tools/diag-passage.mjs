// diag-passage.mjs —— 针对性诊断：把玩家放在指定位置往指定方向走，逐帧打印位置/碰撞/射线探针
// 用法: node tools/diag-passage.mjs x y z targetX targetZ [seconds]
import * as THREE from '../vendor/three/build/three.module.js';
import { Octree } from '../vendor/three/addons/math/Octree.js';

globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {} };

const { buildLevel } = await import('../src/level.js');
const { Player } = await import('../src/player.js');

const stub = { get: (n) => ({ name: n, isMaterial: true }), emissive: () => ({ isMaterial: true }) };
const level = buildLevel(stub);
const octree = new Octree();
octree.fromGraphNode(level.root);
const camera = new THREE.PerspectiveCamera(65, 1.7, 0.05, 260);
const player = new Player(camera, level, octree);
player.enabled = true;

const [x, y, z, tx, tz, secs] = process.argv.slice(2).map(Number);
player.capsule.start.set(x, y + 0.32, z);
player.capsule.end.set(x, y + 1.38, z);
player.velocity.set(0, 0, 0);

const seconds = secs || 6;
const DT = 1 / 60;
const ray = new THREE.Ray();
const hit = new THREE.Vector3();
const tris = [];
level.root.traverse((o) => {
  if (!o.isMesh) return;
  const p = o.geometry.attributes.position, idx = o.geometry.index;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    tris.push([o.name, new THREE.Vector3(p.getX(a), p.getY(a), p.getZ(a)), new THREE.Vector3(p.getX(b), p.getY(b), p.getZ(b)), new THREE.Vector3(p.getX(c), p.getY(c), p.getZ(c))]);
  }
});
function probe(o, d) {
  ray.set(o, d.clone().normalize());
  let best = Infinity, name = '-';
  for (const [n, a, b, c] of tris) {
    const r = ray.intersectTriangle(a, b, c, false, hit);
    if (r) { const dist = hit.distanceTo(o); if (dist > 1e-4 && dist < best) { best = dist; name = n; } }
  }
  return [best, name];
}

console.log(`起点 (${x},${y},${z}) → 目标 (${tx},${tz})`);
for (let i = 0; i < seconds / DT; i++) {
  const p = player.capsule.start;
  player.yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
  player.keys.clear(); player.keys.add('KeyW');
  player.update(DT);
  if (i % 15 === 0 && i > 90) {
    const feet = p.y - 0.32;
    const col = octree.capsuleIntersect(player.capsule.clone());
    const dirW = new THREE.Vector3(-1, 0, 0);
    const [d1, n1] = probe(new THREE.Vector3(p.x, feet + 0.10, p.z), dirW);
    const [d2, n2] = probe(new THREE.Vector3(p.x, feet + 0.35, p.z), dirW);
    const [d3, n3] = probe(new THREE.Vector3(p.x, feet + 1.0, p.z), dirW);
    const [dd, nd] = probe(new THREE.Vector3(p.x, feet + 0.30, p.z), new THREE.Vector3(0, -1, 0));
    console.log(
      `t=${(i * DT).toFixed(2)}s pos(${p.x.toFixed(2)},${feet.toFixed(3)},${p.z.toFixed(2)})` +
      ` vel(${player.velocity.x.toFixed(2)},${player.velocity.y.toFixed(2)},${player.velocity.z.toFixed(2)})` +
      ` ground=${player.onGround} swim=${player.swimming} sub=${player.submersion.toFixed(2)}` +
      (col ? ` COL n=(${col.normal.x.toFixed(2)},${col.normal.y.toFixed(2)},${col.normal.z.toFixed(2)}) d=${col.depth.toFixed(3)}` : ' COL=none') +
      ` | 西向探针 +0.10m:${d1 === Infinity ? '∞' : d1.toFixed(2)}/${n1} +0.35m:${d2 === Infinity ? '∞' : d2.toFixed(2)}/${n2} +1.0m:${d3 === Infinity ? '∞' : d3.toFixed(2)}/${n3} | 脚下:${dd === Infinity ? '∞' : dd.toFixed(2)}/${nd}`
    );
  }
}

// 结束时把卡住位置附近的三角形全列出来
const p = player.capsule.start;
console.log(`\n== 卡住位置 (${p.x.toFixed(2)},${(p.y - 0.32).toFixed(3)},${p.z.toFixed(2)}) 附近三角形（底球 0.5m 内） ==`);
for (const s of nearby(new THREE.Vector3(p.x, p.y, p.z), 0.55)) console.log('  ' + s);