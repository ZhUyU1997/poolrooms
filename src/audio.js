// Poolrooms 程序化音景（纯 WebAudio，零素材、零网络；不依赖 three，顶层绝不触碰 AudioContext）。
// 信号图：各音源 → dryBus ─┐
//         └→ wetSend → convolverA/B/C(三种IR) → wetGain ┤→ masterLowpass → masterGain → compressor → destination
// 约定：运行期参数一律 setTargetAtTime(0.15~0.6s) 平滑，仅初始化直接赋 .value，杜绝突变爆音。

// ============================ 小工具 ============================
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => clamp(x, 0, 1);

// 确定性 PRNG：让 buildImpulseResponse 成为纯函数（相同输入 → 相同输出）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(...args) {
  let h = 2166136261 >>> 0;
  for (const a of args) {
    const s = String(a);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

// ============================ 纯函数：脉冲响应 ============================
// 噪声 × 指数衰减包络 + 一阶低通（亮度）+ 左右去相关（立体声宽度）+ predelay 静音段
// + 早期反射离散脉冲簇 + 末尾淡出。返回 [left, right]，峰值 ≤ 1，无 NaN。
export function buildImpulseResponse(sampleRate, seconds, params = {}) {
  const sr = sampleRate > 0 ? sampleRate : 48000;
  const secs = Math.max(0.02, Number(seconds) || 0.02);
  const decay = Math.max(0.05, Number(params.decay) || secs); // 60dB 衰减时长(s)
  const brightness = clamp01(params.brightness == null ? 0.8 : Number(params.brightness));
  const predelay = Math.max(0, Number(params.predelay) || 0); // 前静音(s)
  const stereoWidth = clamp01(params.stereoWidth == null ? 0.6 : Number(params.stereoWidth));

  const len = Math.max(1, Math.round(sr * secs));
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const pre = Math.min(len - 1, Math.round(sr * predelay));

  const rng = mulberry32(hashSeed(sr, secs, decay, brightness, predelay, stereoWidth));
  const lp = clamp01(brightness); // 一阶低通系数：越大越亮（越接近 1 越不滤波）

  // 主尾：噪声 × 指数衰减包络（60dB 衰减），左右用不同随机相位造宽度
  let lState = 0;
  let rState = 0;
  for (let i = pre; i < len; i++) {
    const t = (i - pre) / sr;
    const env = Math.pow(0.001, t / decay);
    const common = rng() * 2 - 1; // 单声道共享分量
    const nl = rng() * 2 - 1; // 左去相关分量
    const nr = rng() * 2 - 1; // 右去相关分量
    const wL = common + stereoWidth * nl;
    const wR = common + stereoWidth * nr;
    lState += lp * (wL * env - lState);
    rState += lp * (wR * env - rState);
    L[i] = lState;
    R[i] = rState;
  }

  // 早期反射簇：predelay 之后的几个离散脉冲（很轻），让 IR 不只是纯噪声尾
  const erCount = 5 + Math.floor(rng() * 4);
  const erSpan = Math.min(len - pre - 2, Math.round(sr * 0.025));
  for (let e = 0; e < erCount; e++) {
    const idx = pre + 1 + Math.floor(rng() * Math.max(1, erSpan));
    if (idx >= len) continue;
    const amp = (0.5 - e * 0.05) * (0.6 + rng() * 0.4);
    L[idx] += amp * (rng() < 0.5 ? -1 : 1);
    R[idx] += amp * (rng() < 0.5 ? -1 : 1);
  }

  // 末尾 10ms 淡出，避免截断咔嗒
  const fade = Math.min(len, Math.round(sr * 0.01));
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade;
    L[len - 1 - i] *= g;
    R[len - 1 - i] *= g;
  }

  // 归一化到峰值 0.98（保证峰值 ≤ 1）
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0) {
    const s = 0.98 / peak;
    for (let i = 0; i < len; i++) {
      L[i] *= s;
      R[i] *= s;
    }
  }
  return [L, R];
}

// ============================ 分区参数表 ============================
// water/hum/air/wind/deep：各音床分量目标音量（线性，刻意很轻）
// dry/wet：全局干湿比；lowpass：水上主低通截止(Hz)
// drip/splash/tick：泊松事件平均间隔(s)
// ir：[hall, tight, dry] 三条卷积支路交叉淡化权重（和为 1）
const ZONE_PARAMS = {
  atrium:    { water: 0.09, hum: 0.020, air: 0.020, wind: 0.00, deep: 0.00, dry: 0.55, wet: 0.85, lowpass: 18000, drip: 7.0, splash: 9.0,  tick: 40, ir: [1.0, 0.0, 0.0] },
  colonnade: { water: 0.08, hum: 0.022, air: 0.022, wind: 0.00, deep: 0.00, dry: 0.55, wet: 0.80, lowpass: 16000, drip: 5.0, splash: 8.0,  tick: 40, ir: [0.7, 0.3, 0.0] },
  terrace:   { water: 0.06, hum: 0.012, air: 0.030, wind: 0.10, deep: 0.00, dry: 0.75, wet: 0.55, lowpass: 18000, drip: 9.0, splash: 7.0,  tick: 45, ir: [0.2, 0.0, 0.8] },
  stairwell: { water: 0.05, hum: 0.025, air: 0.012, wind: 0.00, deep: 0.00, dry: 0.45, wet: 0.75, lowpass: 12000, drip: 2.5, splash: 10.0, tick: 38, ir: [0.0, 1.0, 0.0] },
  tunnel:    { water: 0.035, hum: 0.030, air: 0.008, wind: 0.00, deep: 0.00, dry: 0.40, wet: 0.80, lowpass: 9000,  drip: 2.5, splash: 11.0, tick: 42, ir: [0.0, 1.0, 0.0] },
  deepwell:  { water: 0.05, hum: 0.035, air: 0.010, wind: 0.00, deep: 0.10, dry: 0.45, wet: 0.95, lowpass: 12000, drip: 6.0, splash: 10.0, tick: 40, ir: [1.0, 0.0, 0.0] },
  locker:    { water: 0.03, hum: 0.030, air: 0.015, wind: 0.00, deep: 0.00, dry: 0.75, wet: 0.55, lowpass: 11000, drip: 5.0, splash: 14.0, tick: 36, ir: [0.0, 0.0, 1.0] },
};
const ZONE_NAMES = Object.keys(ZONE_PARAMS);

function cloneZone(p) {
  return {
    water: p.water, hum: p.hum, air: p.air, wind: p.wind, deep: p.deep,
    dry: p.dry, wet: p.wet, lowpass: p.lowpass,
    drip: p.drip, splash: p.splash, tick: p.tick,
    ir: p.ir.slice(),
  };
}

// ============================ Soundscape ============================
export class Soundscape {
  constructor() {
    // 只存参数，绝不创建 AudioContext（等用户手势）
    this.enabled = false;
    this._ctx = null;
    this._disposed = false;
    this._masterVolume = 0.8;

    // 平滑插值用的当前 zone 参数（穿门不跳变）
    this._zoneCur = cloneZone(ZONE_PARAMS.atrium);
    this._prevSubmerged = false;
    this._time = 0; // 模块自有时钟（驱动 LFO / 事件）

    // 泊松事件计时器
    this._eventTimers = { drip: 2.0, splash: 3.0, tick: 5.0 };
    this._strokeTimer = 0.2;
    this._bubbleTimer = 0.5;
    this._voices = []; // 活跃的一次性音源（用完回收）

    this._beds = null;
    this._noise = null;
    this._dryBus = null;
    this._wetSend = null;
    this._wetGain = null;
    this._masterLowpass = null;
    this._masterGain = null;
    this._compressor = null;
    this._convs = [];
    this._convGains = [];
  }

  // 首次用户手势后调用：创建 ctx、建图、resume()；重复调用幂等
  start() {
    if (this._disposed) return this;
    if (!this._ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) { this.enabled = false; return this; } // 不可用：静默失败
      try {
        this._ctx = new Ctx();
      } catch (e) {
        this.enabled = false;
        return this;
      }
      this._buildGraph();
      this.enabled = true;
    }
    this._resume();
    return this;
  }

  _resume() {
    const c = this._ctx;
    if (c && c.state !== 'running' && typeof c.resume === 'function') {
      const p = c.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  _now() { return this._ctx.currentTime; }

  // 平滑到目标值（唯一允许的运行时参数变化方式）
  _sm(param, value, tc) { param.setTargetAtTime(value, this._now(), tc); }

  _buildGraph() {
    const ctx = this._ctx;
    const sr = ctx.sampleRate || 48000;

    // 主链：masterLowpass → masterGain → compressor → destination
    this._masterLowpass = ctx.createBiquadFilter();
    this._masterLowpass.type = 'lowpass';
    this._masterLowpass.frequency.value = 18000;
    this._masterLowpass.Q.value = 0.5;

    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = this._masterVolume * 0.85; // 整体克制

    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.value = -12; // dB
    this._compressor.knee.value = 20;
    this._compressor.ratio.value = 3;
    this._compressor.attack.value = 0.003;
    this._compressor.release.value = 0.25;

    // 干湿总线
    this._dryBus = ctx.createGain();
    this._dryBus.gain.value = 0.5;
    this._wetSend = ctx.createGain();
    this._wetSend.gain.value = 1.0;
    this._wetGain = ctx.createGain();
    this._wetGain.gain.value = 0.7;

    // 三条卷积支路（三种空间）
    const IR_CONFIGS = [
      { secs: 3.2,  p: { decay: 3.2,  brightness: 0.95, predelay: 0.012, stereoWidth: 0.7 } },  // 明亮瓷砖大厅
      { secs: 1.1,  p: { decay: 1.1,  brightness: 0.55, predelay: 0.006, stereoWidth: 0.45 } }, // 窄隧道（暗）
      { secs: 0.35, p: { decay: 0.35, brightness: 0.8,  predelay: 0.002, stereoWidth: 0.5 } },  // 小更衣间
    ];
    this._convs = [];
    this._convGains = [];
    for (const cfg of IR_CONFIGS) {
      const [l, r] = buildImpulseResponse(sr, cfg.secs, cfg.p);
      const buf = ctx.createBuffer(2, l.length, sr);
      buf.getChannelData(0).set(l);
      buf.getChannelData(1).set(r);
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0;
      this._convs.push(conv);
      this._convGains.push(g);
    }

    // 接线：wetSend → conv → convGain → wetGain；dryBus/wetGain → masterLowpass
    for (let i = 0; i < 3; i++) {
      this._wetSend.connect(this._convs[i]);
      this._convs[i].connect(this._convGains[i]);
      this._convGains[i].connect(this._wetGain);
    }
    this._dryBus.connect(this._masterLowpass);
    this._wetGain.connect(this._masterLowpass);
    this._masterLowpass.connect(this._masterGain);
    this._masterGain.connect(this._compressor);
    this._compressor.connect(ctx.destination);

    // 共享白噪 buffer（所有噪声源复用）
    this._noise = this._makeNoiseBuffer(2.0);

    // 环境音床（仅建一次）
    this._beds = {
      water: this._makeBed('bandpass', 700, 0.7),   // 水面荡漾
      hum:   this._makeBed('lowpass', 90, 0),       // 房间底噪
      air:   this._makeBed('highpass', 4000, 0),    // 高频空气感
      wind:  this._makeBed('bandpass', 1500, 0.5),  // 露台风声
      deep:  this._makeBed('bandpass', 55, 2.0),    // 深井低频（滤波噪声，非纯正弦）
    };
  }

  _makeNoiseBuffer(seconds) {
    const sr = this._ctx.sampleRate || 48000;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buf = this._ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // 长循环噪声床：source → filter → gain（gain 由 update 平滑调制）
  _makeBed(type, freq, Q) {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (Q) f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.value = 0; // 初始化静音，update() 平滑推起
    src.connect(f);
    f.connect(g);
    g.connect(this._dryBus);
    g.connect(this._wetSend);
    src.start(ctx.currentTime);
    return { src, filter: f, gain: g.gain, gainNode: g }; // gain 是 AudioParam，gainNode 供 dispose 断开
  }

  // 每帧调用；state = { zone, submerged, waterDepth, speed, onGround, footstep }
  update(dt, state) {
    if (!this._ctx || this._disposed) return;
    const s = state || {};
    const d = Math.min(Math.max(Number(dt) || 0, 0), 0.1); // 防切后台瞬移
    this._time += d;

    const zone = ZONE_NAMES.includes(s.zone) ? s.zone : 'atrium';
    const submerged = !!s.submerged;
    const waterDepth = Number.isFinite(s.waterDepth) ? s.waterDepth : 0;
    const speed = Number.isFinite(s.speed) ? s.speed : 0;

    this._smoothZone(d, zone);

    // 入水/出水切换：一次“哗”
    if (submerged !== this._prevSubmerged) {
      this._playTransition(submerged);
      this._prevSubmerged = submerged;
    }

    // 主低通：水下 380Hz，出水平滑恢复（τ≈0.25s）
    this._sm(this._masterLowpass.frequency, submerged ? 380 : this._zoneCur.lowpass, 0.25);

    // 干湿比：水下更湿
    this._sm(this._dryBus.gain, this._zoneCur.dry * (submerged ? 0.5 : 1), 0.3);
    this._sm(this._wetGain.gain, Math.min(1.2, this._zoneCur.wet * (submerged ? 1.1 : 1)), 0.3);

    // 三种 IR 交叉淡化（setTargetAtTime 平滑）
    for (let i = 0; i < 3; i++) this._sm(this._convGains[i].gain, this._zoneCur.ir[i], 0.4);

    // 音床 / 随机事件 / 交互音 / 回收
    this._updateBeds(submerged);
    this._scheduleEvents(d, submerged);
    if (s.footstep) this._playFootstep(waterDepth, speed);
    this._scheduleStroke(d, waterDepth, speed);
    this._scheduleBubbles(d, submerged);
    this._sweepVoices(d);
  }

  // 对当前 zone 参数做平滑插值（穿门不跳变）
  _smoothZone(dt, zone) {
    const t = ZONE_PARAMS[zone] || ZONE_PARAMS.atrium;
    const c = this._zoneCur;
    const k = 1 - Math.exp(-dt / 0.35);
    const keys = ['water', 'hum', 'air', 'wind', 'deep', 'dry', 'wet', 'lowpass', 'drip', 'splash', 'tick'];
    for (const key of keys) c[key] += (t[key] - c[key]) * k;
    for (let i = 0; i < 3; i++) c.ir[i] += (t.ir[i] - c.ir[i]) * k;
  }

  // 音床：缓慢多相位 LFO（0.07~0.2Hz 叠加，避免机械感）+ 水下衰减
  _updateBeds(submerged) {
    const t = this._time;
    const surf = submerged ? 0.35 : 1; // 水下把“水面上的音床”压低
    const waterLFO = 1
      + 0.22 * Math.sin(2 * Math.PI * 0.09 * t + 0.4)
      + 0.13 * Math.sin(2 * Math.PI * 0.147 * t + 2.0)
      + 0.08 * Math.sin(2 * Math.PI * 0.21 * t + 4.1);
    const windLFO = 1
      + 0.30 * Math.sin(2 * Math.PI * 0.11 * t)
      + 0.20 * Math.sin(2 * Math.PI * 0.23 * t + 1.7)
      + 0.12 * Math.sin(2 * Math.PI * 0.37 * t + 3.3);

    this._sm(this._beds.water.gain, clamp(this._zoneCur.water * waterLFO * surf, 0, 0.5), 0.3);
    this._sm(this._beds.hum.gain, clamp(this._zoneCur.hum * surf, 0, 0.2), 0.4);
    this._sm(this._beds.air.gain, clamp(this._zoneCur.air * surf, 0, 0.2), 0.4);
    this._sm(this._beds.wind.gain, clamp(this._zoneCur.wind * windLFO * surf, 0, 0.4), 0.4);
    this._sm(this._beds.deep.gain, clamp(this._zoneCur.deep, 0, 0.4), 0.5); // 深井低频水下保留
  }

  _expRand(mean) {
    const m = Math.max(0.2, Number(mean) || 1);
    return Math.max(0.05, -Math.log(1 - Math.random()) * m); // 泊松式间隔
  }

  // 随机事件（update 计时器累加 + 泊松间隔，不用 setInterval）
  _scheduleEvents(dt, submerged) {
    const t = this._eventTimers;
    t.drip -= dt;
    if (t.drip <= 0) {
      if (!submerged) this._playDrip(); // 滴水是水面上的事件
      t.drip = this._expRand(this._zoneCur.drip);
    }
    t.splash -= dt;
    if (t.splash <= 0) {
      this._playSplash();
      t.splash = this._expRand(this._zoneCur.splash);
    }
    t.tick -= dt;
    if (t.tick <= 0) {
      if (!submerged) this._playTick();
      t.tick = this._expRand(this._zoneCur.tick);
    }
  }

  _scheduleStroke(dt, waterDepth, speed) {
    if (waterDepth > 1.5 && speed > 0.2) {
      this._strokeTimer -= dt;
      if (this._strokeTimer <= 0) {
        this._playStroke();
        this._strokeTimer = clamp(1.3 / Math.max(0.2, speed), 0.5, 1.8);
      }
    } else {
      this._strokeTimer = 0.25;
    }
  }

  _scheduleBubbles(dt, submerged) {
    if (submerged) {
      this._bubbleTimer -= dt;
      if (this._bubbleTimer <= 0) {
        this._playBubble();
        this._bubbleTimer = 0.7 + Math.random() * 1.6;
      }
    } else {
      this._bubbleTimer = 0.4;
    }
  }

  // 一次性音源通用收尾：接线 + start/stop + 登记回收
  _finishVoice(src, chain, gain, wetAmt, dur, startAt) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const t0 = startAt == null ? now : startAt;
    const wet = ctx.createGain();
    wet.gain.value = wetAmt; // 初始化直接赋值
    let prev = src;
    for (const n of chain) { prev.connect(n); prev = n; }
    prev.connect(gain);
    gain.connect(this._dryBus);
    gain.connect(wet);
    wet.connect(this._wetSend);
    try { src.start(t0); } catch (e) {}
    try { src.stop(t0 + dur); } catch (e) {}
    this._voices.push({ src, nodes: [src, ...chain, gain, wet], remaining: (t0 - now) + dur + 0.4 });
  }

  // 通用噪声短爆：source → 滤波(可扫频) → (可选声像) → 包络
  _noiseBurst({ type, freq0, freq1 = null, Q = 1, peak, attack = 0.005, dur, wetAmt, pan = null }) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = Q;
    f.frequency.setValueAtTime(freq0, now);
    if (freq1 != null) f.frequency.exponentialRampToValueAtTime(freq1, now + dur);
    const chain = [f];
    if (pan != null && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      chain.push(p);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    this._finishVoice(src, chain, g, wetAmt, dur);
  }

  // 滴水：短促带音高的“嘀”，走湿支路很湿
  _playDrip() {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const dur = 0.15 * (0.92 + Math.random() * 0.16);
    const f0 = 800 + Math.random() * 1400; // 800~2200Hz
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, f0 * 0.7), now + 0.045); // 轻微下滑
    const chain = [];
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.7;
      chain.push(pan);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, now + 0.004); // 极快起音
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur); // 极快衰减
    this._finishVoice(osc, chain, g, 1.0, dur); // 很湿
  }

  // 远处细碎水花：很轻
  _playSplash() {
    this._noiseBurst({ type: 'bandpass', freq0: 1500 + Math.random() * 1000, freq1: 450 + Math.random() * 300, Q: 1.1, peak: 0.12, attack: 0.012, dur: 0.3 * (0.9 + Math.random() * 0.2), wetAmt: 0.7, pan: (Math.random() * 2 - 1) * 0.8 });
  }

  // 结构轻响（瓷砖热胀“嗒”）：极稀疏、很轻
  _playTick() {
    this._noiseBurst({ type: 'bandpass', freq0: 1500 + Math.random() * 1500, Q: 6, peak: 0.06, attack: 0.003, dur: 0.05 + Math.random() * 0.05, wetAmt: 0.6 });
  }

  // 脚步：按水深分三种
  _playFootstep(depth, speed) {
    const volScale = clamp(0.8 + speed * 0.2, 0.7, 1.4); // 随速度略增
    const jitter = () => 0.92 + Math.random() * 0.16;    // ±8% 随机化
    if (depth < 0.02) this._playFootDry(volScale, jitter());
    else if (depth <= 0.5) this._playFootSplash(volScale, jitter());
    else this._playFootDeep(volScale, jitter());
  }

  // 干地：短脆瓷砖（高通噪声爆 + 高 Q 带通给一点音调感）
  _playFootDry(vol, jit) {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const dur = 0.06 * jit;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500 + Math.random() * 1500;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 7;
    bp.frequency.value = 1800 + Math.random() * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5 * vol, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    this._finishVoice(src, [hp, bp], g, 0.4, dur);
  }

  // 浅水：水花（宽带噪声爆 + 快速下降的 bandpass 扫频）
  _playFootSplash(vol, jit) {
    this._noiseBurst({ type: 'bandpass', freq0: 2600 + Math.random() * 600, freq1: 500 + Math.random() * 300, Q: 1.4, peak: 0.45 * vol, attack: 0.006, dur: 0.13 * jit, wetAmt: 0.55 });
  }

  // 较深：沉闷搅水（低通噪声，包络更长更软）
  _playFootDeep(vol, jit) {
    this._noiseBurst({ type: 'lowpass', freq0: 550 + Math.random() * 250, peak: 0.4 * vol, attack: 0.025, dur: 0.24 * jit, wetAmt: 0.6 });
  }

  // 入水/出水切换的“哗”：噪声爆 + 快速滤波扫频
  _playTransition(submerging) {
    this._noiseBurst({ type: 'bandpass', freq0: submerging ? 600 : 2800, freq1: submerging ? 2800 : 600, Q: 1.0, peak: 0.28, attack: 0.008, dur: 0.4, wetAmt: 0.5 });
  }

  // 游泳划水：轻柔搅水
  _playStroke() {
    this._noiseBurst({ type: 'lowpass', freq0: 650, peak: 0.2, attack: 0.015, dur: 0.28 * (0.9 + Math.random() * 0.2), wetAmt: 0.5 });
  }

  // 气泡串：几个快速上升的正弦短音（稀疏）
  _playBubble() {
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const count = 2 + Math.floor(Math.random() * 3); // 2~4 个
    for (let b = 0; b < count; b++) {
      const when = now + b * 0.045;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f0 = 140 + Math.random() * 160;
      osc.frequency.setValueAtTime(f0, when);
      osc.frequency.exponentialRampToValueAtTime(f0 * 3.5, when + 0.1); // 快速上升
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.09, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
      this._finishVoice(osc, [], g, 0.3, 0.17, when);
    }
  }

  // 回收到期的一次性音源（stop 已在 _finishVoice 安排，这里断开防泄漏）
  _sweepVoices(dt) {
    const arr = this._voices;
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      v.remaining -= dt;
      if (v.remaining <= 0) {
        for (const n of v.nodes) { try { n.disconnect(); } catch (e) {} }
        arr.splice(i, 1);
      }
    }
  }

  setMasterVolume(v) {
    const x = Number.isFinite(v) ? v : 0;
    this._masterVolume = clamp01(x);
    if (this._ctx && this._masterGain) this._sm(this._masterGain.gain, this._masterVolume * 0.85, 0.15);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.enabled = false;
    const ctx = this._ctx;
    if (!ctx) return;
    const kill = (n) => {
      if (!n) return;
      try { if (typeof n.stop === 'function') n.stop(); } catch (e) {}
      try { if (typeof n.disconnect === 'function') n.disconnect(); } catch (e) {}
    };
    if (this._beds) for (const k in this._beds) { const b = this._beds[k]; if (b) { kill(b.src); kill(b.filter); kill(b.gainNode); } }
    if (this._voices) for (const v of this._voices) for (const n of v.nodes) kill(n);
    this._voices = [];
    kill(this._dryBus); kill(this._wetSend); kill(this._wetGain);
    kill(this._masterLowpass); kill(this._masterGain); kill(this._compressor);
    for (const n of this._convs) kill(n);
    for (const n of this._convGains) kill(n);
    try { if (typeof ctx.close === 'function') ctx.close(); } catch (e) {}
    this._ctx = null;
    this._beds = null;
    this._convs = [];
    this._convGains = [];
  }
}
