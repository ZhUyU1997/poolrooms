// test-walk.mjs —— 在 node 里用真实碰撞跑完整闭环，验证"能走通、不卡死、不掉出世界"
// 这是无头环境下唯一能验证关卡可玩性的手段（浏览器里没法自动按键）。
import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';

// Player 会在构造时绑定 DOM 事件 → 先补最小桩
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {} };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { buildLevel } = await import('../src/level.js');
const { Player } = await import('../src/player.js');

const stub = { get: (n) => ({ name: n, isMaterial: true }), emissive: () => ({ isMaterial: true }) };
const level = buildLevel(stub);
const octree = new Octree();
octree.fromGraphNode(level.root);

const camera = new THREE.PerspectiveCamera(65, 1.7, 0.05, 260);
const player = new Player(camera, level, octree);
player.enabled = true;

// 闭环航路点（绕开泳池走池边 → 柱廊 → 露台 → 返回 → 阶梯厅 → 隧道 → 深井(游泳) → 通道 → 更衣 → 回廊 → 中庭）
const PATH = [
  ['中庭池边西', -10, 9.6], ['中庭池边西北', -10, -10], ['中庭北门前', 0, -10.6],
  ['柱廊入口', 0, -15], ['柱廊中段', 0, -30], ['柱廊北端', 0, -42.5],
  ['露台', 0, -50], ['露台深处', 0, -56],
  ['回到柱廊', 0, -42], ['柱廊东门前', 3.2, -28], ['阶梯厅', 8, -28],
  ['连接段', 12, -27.5], ['隧道北', 14.5, -27], ['隧道中', 14.5, -10], ['隧道南', 14.5, 10],
  ['深井浅台', 15.5, 14.2], ['深井中央(游泳)', 20, 20], ['深井西台', 13.9, 23.5],
  ['出水台阶', 11, 23.5], ['更衣角', 6.5, 23.5], ['回廊南', 2.2, 22.5],
  ['回廊北', 2.2, 14], ['回到中庭', 2.2, 10.5],
  ['跳进主池', 0, 0], ['池内走向入水阶梯', -5.9, -6.2], ['沿阶梯出水上池边', -6.0, -9.6],
];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m); } };

const DT = 1 / 60;
let totalSteps = 0, minY = 1e9, maxY = -1e9, swamSteps = 0, wadeSteps = 0;
const zonesSeen = new Set();

function walkTo(name, tx, tz, maxSeconds = 60) {
  const maxSteps = Math.round(maxSeconds / DT);
  let best = Infinity, sinceProgress = 0;
  for (let i = 0; i < maxSteps; i++) {
    const p = player.capsule.start;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.3) return { reached: true, steps: i, dist };
    // 朝向目标（camera 前向 = (-sin yaw, ., -cos yaw)）
    player.yaw = Math.atan2(-dx, -dz);
    player.keys.clear();
    player.keys.add('KeyW');
    // 深水里若沉底则主动上浮，模拟玩家会按空格
    if (player.swimming && player.feetY < -2.2) player.keys.add('Space');
    const st = player.update(DT);
    totalSteps++;
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    if (player.swimming) swamSteps++;
    else if (st.waterDepth > 0.05) wadeSteps++;
    zonesSeen.add(st.zone);
    if (dist < best - 0.12) { best = dist; sinceProgress = 0; } else if (++sinceProgress > 260) {
      return { reached: false, steps: i, dist, stuck: true };
    }
  }
  return { reached: false, steps: maxSteps, dist: best, timeout: true };
}

console.log('== 闭环步行测试（真实胶囊碰撞 + Octree） ==');
console.log(`  碰撞三角形: ${level.root.userData.triangles}`);
for (const [name, x, z] of PATH) {
  const r = walkTo(name, x, z);
  const p = player.capsule.start;
  const tag = `${name} (${x},${z})`;
  ok(r.reached, `${tag} ${r.reached ? `到达 用时${(r.steps * DT).toFixed(1)}s` : `未到达 [${r.stuck ? '卡住' : '超时'}] 剩余${r.dist.toFixed(2)}m 位置(${p.x.toFixed(1)},${(p.y - 0.32).toFixed(2)},${p.z.toFixed(1)})`}`);
  if (!r.reached) break;   // 走不通后面就没意义了
}

console.log('\n== 全程健康检查 ==');
ok(minY > -6, `从未掉出世界 (最低 y=${minY.toFixed(2)} > -6)`);
ok(maxY < 15, `从未被弹上天 (最高 y=${maxY.toFixed(2)} < 15)`);
ok(swamSteps > 60, `深井触发过游泳态 (${(swamSteps * DT).toFixed(1)}s)`);
ok(wadeSteps > 300, `有大量涉水行走 (${(wadeSteps * DT).toFixed(1)}s)`);
ok(zonesSeen.size >= 6, `途经分区数 ${zonesSeen.size} >= 6  [${[...zonesSeen].join(',')}]`);
console.log(`  总模拟时长 ${(totalSteps * DT).toFixed(1)}s`);

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
