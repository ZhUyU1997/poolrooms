// player.js —— 第一人称控制器：胶囊碰撞、涉水/游泳、镜头动态
//
// 身体尺寸：胶囊半径 0.32，脚底到头顶 1.70m，眼高 1.66m（真人比例，头顶留 4cm）。
// 碰撞用 three 官方 fps 范式：Octree.capsuleIntersect + 每帧多次子步长（防穿薄墙）。
// 胶囊的圆底能自然跨过 ≤0.2m 的台阶，所有阶梯每级 ≤0.19m 就是为此定的。
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { WATER_Y } from './level.js';

const R = 0.32;            // 胶囊半径
const H = 1.70;            // 总身高
const EYE = 1.66;          // 眼高
const GRAVITY = 18.0;      // 略强于真实，手感更干脆
const WALK = 2.76, RUN = 3.2, SWIM = 1.25;   // 尘验收：步行速度翻倍

export class Player {
  constructor(camera, level, octree) {
    this.camera = camera;
    this.level = level;
    this.octree = octree;

    this.capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), R);
    this.velocity = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    this.enabled = false;

    this.onGround = false;
    this.swimming = false;
    this.inWater = false;
    this.submersion = 0;      // 水面到脚底的深度（身体浸没量）
    this.waterDepth = 0;      // 该点水体总深度（池底到水面）
    this.footstep = false;
    this.eyeSubmerged = false;

    this._stepDist = 0;
    this._bob = 0;
    this._landDip = 0;
    this._time = 0;
    this._ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    this._wish = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();

    this.reset();
    this._bind();
  }

  reset() {
    const s = this.level.spawn;
    this.capsule.start.set(s.position.x, s.position.y + R, s.position.z);
    this.capsule.end.set(s.position.x, s.position.y + H - R, s.position.z);
    this.capsule.radius = R;
    this.velocity.set(0, 0, 0);
    this.yaw = s.yaw; this.pitch = 0;
  }

  _bind() {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['Space', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const s = 0.0021;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s;
      const lim = Math.PI / 2 - 0.08;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
  }

  get feetY() { return this.capsule.start.y - R; }

  _updateWater() {
    const p = this.capsule.start;
    const area = this.level.waterAt(p.x, p.z);
    this.inWater = !!area;
    this.submersion = area ? Math.max(0, WATER_Y - this.feetY) : 0;

    if (area) {
      // 向下投射取真实池底高度（阶梯/浅台都能正确读到）
      this._ray.origin.set(p.x, p.y + 0.05, p.z);
      this._ray.direction.set(0, -1, 0);
      const hit = this.octree.rayIntersect(this._ray);
      const bottomY = hit ? this._ray.origin.y - hit.distance : area.floorY;
      this.waterDepth = Math.max(0, WATER_Y - bottomY);
    } else {
      this.waterDepth = 0;
    }

    // 游泳判定带滞回（防止在临界水深反复切换）
    if (!this.swimming) {
      if (this.inWater && this.waterDepth > 1.55 && this.submersion > 1.12) this.swimming = true;
    } else if (!this.inWater || this.submersion < 0.8) {
      this.swimming = false;
    }
  }

  _collide() {
    const r = this.octree.capsuleIntersect(this.capsule);
    this.onGround = false;
    this._blocked = false;
    if (!r) return;
    this.onGround = r.normal.y > 0.35;
    if (this.onGround) {
      if (this.velocity.y < -4.5) this._landDip = Math.min(0.075, -this.velocity.y * 0.012);
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this._blocked = true;
      // 沿法线抵消侵入速度 → 贴墙滑动而不是被弹开
      this.velocity.addScaledVector(r.normal, -r.normal.dot(this.velocity));
      // 深水里被"齐水面的台沿"挡住时给一点上爬助力：胶囊底部低于台面时永远爬不上去，
      // 会把玩家永久困在水里（实测于深井西台）。上限 = 水面 +0.3m，防止顺着墙爬出水面。
      if (this.inWater && this.submersion > 0.75 && Math.abs(r.normal.y) < 0.45 && this.feetY < WATER_Y + 0.3) {
        this.velocity.y = Math.max(this.velocity.y, 1.4);
      }
    }
    this.capsule.translate(r.normal.multiplyScalar(r.depth));
  }

  _step(dt, wish, running) {
    const swimming = this.swimming;
    const sub = this.submersion;

    // 涉水阻力：越深越慢（膝 0.7 / 腰 0.5 / 胸 0.35 附近）
    // 涉水阻力曲线：1.35 系数下胸深(1.45m)只有 0.47m/s，44m 隧道要走 94 秒太折磨；
    // 0.8 系数下胸深 0.63m/s、按 Shift 1.17m/s，既保留".水里走不快"的体感又不至于难受
    const wade = this.inWater ? 1 / (1 + Math.max(0, sub) * 0.8) : 1;
    const speed = swimming ? SWIM : (running ? RUN : WALK) * wade;

    const accel = swimming ? 6 : (this.onGround ? 26 : 7);
    const damp = swimming ? 3.6 : (this.onGround ? (this.inWater ? 9 : 12) : 1.2);

    // 水平加速（游泳时按视线方向，含俯仰）
    if (wish.lengthSq() > 0) {
      this.velocity.x += (wish.x * speed - this.velocity.x) * Math.min(1, accel * dt);
      this.velocity.z += (wish.z * speed - this.velocity.z) * Math.min(1, accel * dt);
      if (swimming) this.velocity.y += (wish.y * speed - this.velocity.y) * Math.min(1, accel * dt);
    } else {
      const k = Math.min(1, damp * dt);
      this.velocity.x -= this.velocity.x * k;
      this.velocity.z -= this.velocity.z * k;
    }

    if (swimming) {
      // 浮力：把身体缓缓推到"头刚好出水"的姿态；主动下潜/上浮时让位
      const wantUp = this.keys.has('Space');
      const wantDown = this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC');
      const targetFeet = WATER_Y - (EYE - 0.10);       // 眼睛略高于水面
      if (!wantUp && !wantDown) {
        const err = targetFeet - this.feetY;
        this.velocity.y += (err * 1.9 - this.velocity.y) * Math.min(1, 3.2 * dt);
      } else {
        const dir = (wantUp ? 1 : 0) + (wantDown ? -1 : 0);
        this.velocity.y += (dir * 1.5 - this.velocity.y) * Math.min(1, 5 * dt);
      }
      this.velocity.y -= this.velocity.y * Math.min(1, 1.5 * dt);
    } else {
      this.velocity.y -= GRAVITY * dt;
      // 浅水里也有一点浮力/阻尼，落水不会像石头
      if (this.inWater && sub > 0.2) this.velocity.y += Math.min(sub, 1) * 6.5 * dt;
      if (this.onGround && this.keys.has('Space')) this.velocity.y = 3.4;
    }

    this.capsule.translate(this._tmpMove(dt));
    this._collide();
    if (this._blocked && !swimming && wish.lengthSq() > 0) this._tryStepUp(wish);
  }

  /** 经典 step-up：被近垂直面挡住时，若"抬高 0.45m 后再前进 0.18m"是空的，就把胶囊抬上去。
   *  这一步让台阶、门槛、齐膝矮沿、几何薄片全部可通过，也让关卡设计不必对级高吹毛求疵。
   *  （实测：出水通道 0.24m 级高、门槛 7cm 薄唇都会让纯胶囊解算永久卡死） */
  _tryStepUp(wish) {
    if (!this._probe) this._probe = this.capsule.clone();
    const probe = this._probe;
    probe.copy(this.capsule);
    const up = this._up || (this._up = new THREE.Vector3());
    const fwd = this._fwdStep || (this._fwdStep = new THREE.Vector3());
    up.set(0, 0.45, 0);
    fwd.set(wish.x, 0, wish.z).normalize().multiplyScalar(0.18);
    probe.translate(up);
    if (this.octree.capsuleIntersect(probe)) return false;   // 头顶不够高，不是台阶
    probe.translate(fwd);
    if (this.octree.capsuleIntersect(probe)) return false;   // 前方也堵，是真墙
    this.capsule.translate(up);
    this.capsule.translate(fwd);
    if (this.velocity.y < 0) this.velocity.y = 0;             // 交给重力自然落到台面上
    return true;
  }

  _tmpMove(dt) {
    if (!this._mv) this._mv = new THREE.Vector3();
    return this._mv.copy(this.velocity).multiplyScalar(dt);
  }

  update(dt) {
    this._time += dt;
    this.footstep = false;
    this._updateWater();

    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    // 输入 → 世界方向
    const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const s = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const wish = this._wish.set(0, 0, 0);
    if (this.enabled && (f || s)) {
      const pitchFactor = this.swimming ? Math.sin(this.pitch) : 0;
      this._fwd.set(-Math.sin(this.yaw), pitchFactor, -Math.cos(this.yaw));
      this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      wish.addScaledVector(this._fwd, f).addScaledVector(this._right, s).normalize();
    }

    // 3 个子步长：18m/s² 的重力 + 薄墙下更稳
    const steps = 3;
    for (let i = 0; i < steps; i++) this._step(dt / steps, wish, running);

    // 掉出世界 / 坐标异常 → 回到出生点
    const p = this.capsule.start;
    if (!isFinite(p.x + p.y + p.z) || p.y < -30 || p.y > 40) this.reset();

    // ---- 镜头 ----
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = this.swimming ? 1.7 : (running ? 0.95 : 0.78);
    if ((this.onGround || this.inWater) && hSpeed > 0.25) {
      this._stepDist += hSpeed * dt;
      if (this._stepDist >= stride) { this._stepDist -= stride; this.footstep = true; }
      this._bob = (this._stepDist / stride) * Math.PI * 2;
    } else {
      this._stepDist = Math.max(0, this._stepDist - dt * 0.6);
    }
    this._landDip = Math.max(0, this._landDip - dt * 0.28);

    const moveAmp = Math.min(1, hSpeed / RUN);
    const bobY = Math.sin(this._bob) * 0.013 * moveAmp;
    const bobRoll = Math.cos(this._bob * 0.5) * 0.0055 * moveAmp;
    // 静止时的呼吸摇摆（沉浸感的关键小动作）
    const breath = Math.sin(this._time * 0.62) * 0.0045 + Math.sin(this._time * 1.31) * 0.0018;
    const breathPitch = Math.sin(this._time * 0.51) * 0.0009;

    const eyeY = this.feetY + EYE + bobY + breath - this._landDip;
    this.camera.position.set(p.x, eyeY, p.z);
    this.camera.rotation.set(this.pitch + breathPitch, this.yaw, bobRoll, 'YXZ');

    // 眼睛是否在水下（水面 y=0，2cm 死区）
    this.eyeSubmerged = this.inWater && eyeY < WATER_Y - 0.02;

    // 复用同一个 state 对象：主循环每帧都会读它，别每帧 new（长时间运行的 GC 抖动）
    const st = this._state || (this._state = {});
    st.zone = this.level.zoneAt(p.x, p.z).audio;
    st.submerged = this.eyeSubmerged;
    st.waterDepth = this.inWater ? Math.max(this.submersion, 0) : 0;
    st.speed = hSpeed;
    st.onGround = this.onGround;
    st.footstep = this.footstep;
    st.swimming = this.swimming;
    return st;
  }
}
