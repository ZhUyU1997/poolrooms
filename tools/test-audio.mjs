// tools/test-audio.mjs —— node 自测（注入最小 AudioContext mock，零真实音频）
// 用法：node tools/test-audio.mjs

// ============================ 最小 AudioContext mock ============================
class MockAudioParam {
  constructor(ctx, defaultValue = 0) {
    this._ctx = ctx;
    this._value = defaultValue;
    this._tcLog = []; // 记录所有 setTargetAtTime 的时间常数
    ctx._params.push(this);
  }
  get value() { return this._value; }
  set value(v) {
    if (Number.isNaN(v)) this._ctx._violations.push('AudioParam.value = NaN');
    this._value = v;
  }
  setValueAtTime(v, t) { this._check(v, 'setValueAtTime'); this._value = v; }
  setTargetAtTime(v, t, tc) {
    this._check(v, 'setTargetAtTime');
    if (!(tc > 0)) this._ctx._violations.push(`setTargetAtTime tc<=0 (${tc})`);
    this._tcLog.push(tc);
    this._value = v;
  }
  linearRampToValueAtTime(v, t) { this._check(v, 'linearRamp'); this._value = v; }
  exponentialRampToValueAtTime(v, t) { this._check(v, 'exponentialRamp'); this._value = v; }
  _check(v, name) { if (Number.isNaN(v)) this._ctx._violations.push(`${name} value NaN`); }
}

class MockNode {
  constructor(ctx) {
    this._ctx = ctx;
    this._out = new Set();
    this._dead = false;
    this._stopped = false;
    this._started = false;
    ctx._nodes.push(this);
  }
  connect(dest) {
    if (this._dead) return dest;
    this._out.add(dest);
    return dest;
  }
  disconnect(dest) {
    if (dest === undefined) { this._out.clear(); this._dead = true; }
    else this._out.delete(dest);
  }
  start(when, offset, duration) { this._started = true; }
  stop(when) { this._stopped = true; this._dead = true; }
}

class MockGainNode extends MockNode {
  constructor(ctx) { super(ctx); this.gain = new MockAudioParam(ctx, 1); }
}
class MockBiquadFilterNode extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new MockAudioParam(ctx, 350);
    this.Q = new MockAudioParam(ctx, 1);
    this.gain = new MockAudioParam(ctx, 0);
    this.detune = new MockAudioParam(ctx, 0);
  }
}
class MockBufferSourceNode extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new MockAudioParam(ctx, 1);
    this.detune = new MockAudioParam(ctx, 0);
    this.onended = null;
  }
}
class MockConvolverNode extends MockNode {
  constructor(ctx) { super(ctx); this.buffer = null; this.normalize = true; }
}
class MockOscillatorNode extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.type = 'sine';
    this.frequency = new MockAudioParam(ctx, 440);
    this.detune = new MockAudioParam(ctx, 0);
    this.onended = null;
  }
}
class MockDynamicsCompressorNode extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.threshold = new MockAudioParam(ctx, -24);
    this.knee = new MockAudioParam(ctx, 30);
    this.ratio = new MockAudioParam(ctx, 12);
    this.attack = new MockAudioParam(ctx, 0.003);
    this.release = new MockAudioParam(ctx, 0.25);
  }
}
class MockStereoPannerNode extends MockNode {
  constructor(ctx) { super(ctx); this.pan = new MockAudioParam(ctx, 0); }
}
class MockDelayNode extends MockNode {
  constructor(ctx) { super(ctx); this.delayTime = new MockAudioParam(ctx, 0); }
}
class MockWaveShaperNode extends MockNode {
  constructor(ctx) { super(ctx); this.curve = null; this.oversample = 'none'; }
}
class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._ch = [];
    for (let i = 0; i < channels; i++) this._ch.push(new Float32Array(length));
  }
  getChannelData(i) { return this._ch[i]; }
}

class MockAudioContext {
  static instances = [];
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0; // 可推进
    this.state = 'suspended';
    this._closed = false;
    this._nodes = [];
    this._params = [];
    this._violations = [];
    this.destination = new MockNode(this);
    MockAudioContext.instances.push(this);
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this._closed = true; this.state = 'closed'; return Promise.resolve(); }
  createGain() { return new MockGainNode(this); }
  createBufferSource() { return new MockBufferSourceNode(this); }
  createBiquadFilter() { return new MockBiquadFilterNode(this); }
  createConvolver() { return new MockConvolverNode(this); }
  createOscillator() { return new MockOscillatorNode(this); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(this); }
  createStereoPanner() { return new MockStereoPannerNode(this); }
  createDelay() { return new MockDelayNode(this); }
  createWaveShaper() { return new MockWaveShaperNode(this); }
  createBuffer(channels, length, sampleRate) { return new MockAudioBuffer(channels, length, sampleRate); }
  liveCount() { return this._nodes.filter((n) => !n._dead).length; }
  get nodeCount() { return this._nodes.length; }
}

globalThis.AudioContext = MockAudioContext;

// ============================ 载入被测模块 ============================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcText = readFileSync(resolve(__dirname, '../src/audio.js'), 'utf8');
const modUrl = 'data:text/javascript;base64,' + Buffer.from(srcText).toString('base64');
const { Soundscape, buildImpulseResponse } = await import(modUrl);

// ============================ 测试辅助 ============================
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}
function peak(a) { let p = 0; for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (x > p) p = x; } return p; }
function hasNaN(a) { for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) return true; return false; }
function segRMS(a, segs = 10) {
  const n = Math.floor(a.length / segs);
  const out = [];
  for (let s = 0; s < segs; s++) {
    let sum = 0;
    for (let i = s * n; i < (s + 1) * n; i++) sum += a[i] * a[i];
    out.push(Math.sqrt(sum / n));
  }
  return out;
}
function monotonic(r) { for (let i = 1; i < r.length; i++) if (!(r[i] < r[i - 1])) return false; return true; }
function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============================ 测试 1：构造函数不建图 ============================
const s = new Soundscape();
check('1. 构造函数不创建任何节点', MockAudioContext.instances.length === 0,
  `AudioContext实例数=${MockAudioContext.instances.length}`);

// ============================ 测试 2：start 与幂等 ============================
s.start();
const ctx = MockAudioContext.instances[0];
check('2a. start() 创建了 AudioContext', !!ctx, ctx ? `state=${ctx.state}` : '无实例');
const base = ctx ? ctx.liveCount() : 0;
const before = ctx ? ctx.liveCount() : 0;
s.start(); // 重复调用
check('2b. start() 幂等（节点总数不变）', !!ctx && ctx.liveCount() === before,
  `base=${base} after2nd=${ctx ? ctx.liveCount() : 'n/a'}`);

// ============================ 测试 3：3000 次 update 压力 ============================
const dt = 1 / 60;
const zones = ['atrium', 'colonnade', 'terrace', 'stairwell', 'tunnel', 'deepwell', 'locker'];
let peakNodes = ctx ? ctx.liveCount() : 0;
let threw = null;
for (let i = 0; i < 3000; i++) {
  ctx.currentTime += dt;
  const zone = zones[Math.floor(i / 200) % zones.length]; // 每 ~3.3s 换一区，换遍 7 区
  const cycle = (i % 600) / 600;
  const waterDepth = cycle < 0.5 ? cycle * 5 : (1 - cycle) * 5; // 0 → 2.5 → 0
  const submerged = Math.floor(i / 300) % 2 === 1;              // 每 5s 切换
  const speed = (waterDepth > 1.2 || submerged) ? 1.0 + (i % 5) * 0.35 : 1.35;
  const state = {
    zone, submerged, waterDepth, speed,
    onGround: waterDepth < 1.5,
    footstep: i % 27 === 0, // 每 0.45s 一步
  };
  try { s.update(dt, state); } catch (e) { threw = e; break; }
  if (i % 10 === 0) peakNodes = Math.max(peakNodes, ctx.liveCount());
}
const endNodes = ctx ? ctx.liveCount() : 0;
check('3a. 3000 次 update 无异常', threw === null, threw ? String(threw) : '');
check('3b. 节点数峰值有界（不无限增长）', peakNodes < base + 250, `base=${base} peak=${peakNodes}`);

// 静置排空一次性音源
for (let i = 0; i < 240; i++) {
  ctx.currentTime += dt;
  try {
    s.update(dt, { zone: 'atrium', submerged: false, waterDepth: 0, speed: 0, onGround: true, footstep: false });
  } catch (e) { threw = e; }
}
const drained = ctx ? ctx.liveCount() : 0;
check('3c. 一次性音源被回收（末值≈稳定值）', drained <= base + 16,
  `base=${base} end@3000=${endNodes} drained=${drained}`);

// ============================ 测试 4：参数纪律 ============================
const viols = ctx ? ctx._violations : [];
const tcBad = viols.filter((v) => v.includes('tc<=0'));
const nanBad = viols.filter((v) => v.includes('NaN'));
const tcCount = ctx ? ctx._params.reduce((n, p) => n + p._tcLog.length, 0) : 0;
check('4a. 所有 setTargetAtTime 时间常数 > 0', tcBad.length === 0, `调用${tcCount}次`);
check('4b. 没有对 AudioParam 赋 NaN', nanBad.length === 0, nanBad.length ? nanBad.slice(0, 3).join('; ') : '');

// ============================ 测试 5：buildImpulseResponse ============================
const [L, R] = buildImpulseResponse(48000, 3.2, { decay: 3.0, brightness: 0.9, predelay: 0.01, stereoWidth: 0.7 });
check('5a. IR 长度正确', L.length === 153600 && R.length === L.length, `len=${L.length}`);
check('5b. IR 峰值 ≤ 1', peak(L) <= 1 && peak(R) <= 1, `L=${peak(L).toFixed(3)} R=${peak(R).toFixed(3)}`);
check('5c. IR 无 NaN', !hasNaN(L) && !hasNaN(R));
check('5d. IR 包络分段 RMS 单调衰减', monotonic(segRMS(L)) && monotonic(segRMS(R)),
  `L=${segRMS(L).map((x) => x.toFixed(3)).join(',')}`);
check('5e. IR 左右声道不完全相同', !identical(L, R));

// ============================ 测试 6：dispose 后再 update ============================
s.dispose();
let threwAfter = null;
try {
  s.update(dt, { zone: 'atrium', submerged: false, waterDepth: 0, speed: 0, onGround: true, footstep: true });
} catch (e) { threwAfter = e; }
check('6. dispose() 后 update() 不抛异常', threwAfter === null, threwAfter ? String(threwAfter) : '');

// ============================ 输出 ============================
console.log('=== Poolrooms 音频模块自测 ===\n');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
console.log('\n--- 关键数字 ---');
console.log(`start() 后稳定节点数 (base)  : ${base}`);
console.log(`3000 次 update 峰值节点数     : ${peakNodes}`);
console.log(`3000 次 update 末值节点数     : ${endNodes}`);
console.log(`静置排空后节点数 (drained)    : ${drained}`);
console.log(`累计创建的节点总数 (total)    : ${ctx ? ctx.nodeCount : 0}`);
console.log(`setTargetAtTime 总调用次数    : ${tcCount}`);
console.log('');
console.log(failed === 0 ? 'ALL PASSED' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
