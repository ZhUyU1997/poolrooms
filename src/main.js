// main.js —— 引导、渲染编排、自适应画质、输入与生命周期
//
// 每帧渲染顺序（依据设计审查的性能与色彩管线结论）：
//   1) shadowMap.needsUpdate = true  → 本帧只渲一次阴影，供三个 pass 复用
//      （renderer.shadowMap.autoUpdate=false，否则每次 render() 都会重渲 4096 阴影）
//   2) 水面反射 RT（镜像相机 + 斜近平面裁剪，半分辨率）
//   3) 水面折射 RT（主相机，隐藏水面，带 FloatType 深度）
//   4) EffectComposer：RenderPass → GTAO → Bloom → Grade → SMAA → OutputPass
import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { MaterialLibrary, setGiZones } from './materials.js';
import { buildLevel } from './level.js';
import { WaterSystem } from './water.js';
import { Volumetrics } from './volumetrics.js';
import { PostFX } from './postfx.js';
import { Player } from './player.js';
import { Soundscape } from './audio.js';
import { createSkyEquirect, SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from './textures.js';

const canvas = document.getElementById('view');
const hint = document.getElementById('hint');
const veil = document.getElementById('veil');
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance',
  stencil: false, logarithmicDepthBuffer: false,   // 深度反算依赖标准深度，不能开对数深度
});
renderer.setPixelRatio(1);                          // 分辨率由我们自己控制
renderer.outputColorSpace = THREE.SRGBColorSpace;
// 色调映射：ACESFilmic 对比更"电影"，AgX 更平但抗高动态；可用 ?tm= 切换比较
const TONEMAPS = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };
renderer.toneMapping = TONEMAPS[params.get('tm')] || THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(params.get('exp')) || 0.88;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // r185 已废弃 PCFSoftShadowMap
renderer.shadowMap.autoUpdate = false;

// ---------------------------------------------------------------- scene / sky
const scene = new THREE.Scene();
const FOG_AIR = { color: new THREE.Color(0.74, 0.81, 0.85), density: 0.0052 };
const FOG_WATER = { color: new THREE.Color(0.055, 0.30, 0.365), density: 0.085 };
const fog = new THREE.FogExp2(FOG_AIR.color.getHex(), FOG_AIR.density);
scene.fog = fog;

const sky = createSkyEquirect();
sky.mapping = THREE.EquirectangularReflectionMapping;
scene.background = sky;
scene.backgroundIntensity = 1.0;
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(sky).texture;
  // 室内不能被无遮挡的天光"泡"成一片灰：IBL 只当微弱补光，明暗交给太阳 + 局部灯 + GI 场
  scene.environmentIntensity = Number(params.get('env')) || 0.18;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 260);

// ---------------------------------------------------------------- sun
// 方位角约定与 textures.js 的 equirect 写法严格一致：u = az/360 ↔ atan2(z,x)/2π+0.5
const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
const sunDir = new THREE.Vector3(
  -Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el),
).normalize();

const sun = new THREE.DirectionalLight(0xfff0da, Number(params.get('sun')) || 5.5);
const sunCenter = new THREE.Vector3(7, 0, -15);
sun.position.copy(sunCenter).addScaledVector(sunDir, 95);
sun.target.position.copy(sunCenter);
sun.castShadow = true;
// ?shadow=1024 用于无头软件渲染验证时降档（4096 在 SwiftShader 下太慢）
const shadowSize = Math.max(512, Math.min(4096, Number(params.get('shadow')) || 4096));
sun.shadow.mapSize.set(shadowSize, shadowSize);
sun.shadow.camera.left = -54; sun.shadow.camera.right = 54;
sun.shadow.camera.top = 54; sun.shadow.camera.bottom = -54;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 230;
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.035;
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);

// 半球光 = 廉价反弹光：上方天光偏冷白，下方从瓷砖/水面反上来的偏青。
// 它落在 irradiance 项里，因此同样被 GI 场按房间衰减（暗房间不会被它照亮）。
const hemi = new THREE.HemisphereLight(0xe6f2ff, 0x8ad8e8, Number(params.get('hemi')) || 0.85);
scene.add(hemi);

// ---------------------------------------------------------------- level
const lib = new MaterialLibrary(renderer);
const level = buildLevel(lib);
scene.add(level.root, level.decor);
for (const l of level.lights) scene.add(l);
setGiZones(level.giZones);

const octree = new Octree();
octree.fromGraphNode(level.root);

// ---------------------------------------------------------------- water / volumetrics
const water = new WaterSystem(renderer, level);
water.uniforms.uSunDir.value.copy(sunDir);
water.uniforms.uSunColor.value.setRGB(1.0, 0.955, 0.88);
water.uniforms.uDebug.value = Number(params.get('wdebug')) || 0;
scene.add(water.group);

const vol = new Volumetrics(level, sunDir, {
  noise: water.caustic,
  depth: water.rtRefract.depthTexture,
});
scene.add(vol.group);
// 光柱着色器要采样折射 RT 的深度 → 渲染这两张 RT 时必须把它藏起来（防帧缓冲反馈环）
water.hideDuringRT.push(vol.group);

// GTAO 专用场景：只含静态实体，**不含水面/光柱/尘埃**
// （GTAOPass 用 overrideMaterial 渲 GBuffer，会把不透明化的水面当遮挡体 → 池底 AO 丢失）
const aoScene = new THREE.Scene();
aoScene.add(level.root.clone(), level.decor.clone());

const post = new PostFX(renderer, scene, camera, aoScene, level.bounds);
if (params.has('noao')) post.gtao.enabled = false;

// ---------------------------------------------------------------- player / audio
const player = new Player(camera, level, octree);
const audio = new Soundscape();
let audioStarted = false;

// 无头验证用：?cam=x,y,z&look=yaw,pitch 冻结相机到指定位姿
let frozen = false;
if (params.has('cam')) {
  const [x, y, z] = params.get('cam').split(',').map(Number);
  const [yaw, pitch] = (params.get('look') || '0,0').split(',').map(Number);
  camera.position.set(x, y, z);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  frozen = true;
  veil.remove();   // 无头截图要确定性：冻结模式直接去掉黑幕，不等 CSS 过渡
}

// ---------------------------------------------------------------- resize / 自适应分辨率
let baseW = 1, baseH = 1, resScale = 1, quality = 2;
const QUALITY_MAX = params.has('noao') ? 1 : 2;   // noao 模式下永不恢复到开 GTAO 的档位

function applyRes() {
  const w = Math.max(320, Math.floor(baseW * resScale));
  const h = Math.max(200, Math.floor(baseH * resScale));
  renderer.setSize(w, h, false);
  camera.aspect = innerWidth / Math.max(1, innerHeight);
  camera.updateProjectionMatrix();
  post.setSize(w, h);
  water.setSize(w, h);
  vol.setSize(w, h, Math.max(1, w / Math.max(1, innerWidth)));   // 尘埃点尺寸跟随实际缓冲/CSS 比例
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  baseW = Math.floor(innerWidth * dpr);
  baseH = Math.floor(innerHeight * dpr);
  applyRes();
}
addEventListener('resize', layout);
layout();

// ---------------------------------------------------------------- 输入 / 生命周期
function enter() {
  if (!audioStarted) { audio.start(); audioStarted = true; }
  if (!frozen) canvas.requestPointerLock?.();
}
hint.addEventListener('click', enter);
canvas.addEventListener('click', enter);
addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  player.enabled = locked;
  hint.classList.toggle('hidden', locked);
  if (!locked) hint.classList.add('show');
});
document.addEventListener('pointerlockerror', () => {
  // 指针锁定被拒绝时必须把提示放回来，否则玩家完全无从操作
  hint.classList.remove('hidden');
  hint.classList.add('show');
});
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const f = document.getElementById('fatal');
  f.textContent = '图形上下文丢失，正在重新加载…';
  f.style.display = 'flex';
  setTimeout(() => location.reload(), 1200);
});

// ---------------------------------------------------------------- 主循环
let prevT = performance.now();          // 不用 THREE.Clock（r185 已废弃）
let sub = 0;                 // 水下程度（平滑）
let frames = 0, dtSum = 0, cooldown = 0, ready = 0;
const SHOW_FPS = params.has('fps');   // ?fps=1 → 控制台每 2s 报一次帧率（不产生任何界面元素）
let fpsAcc = 0, fpsFrames = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - prevT) / 1000, 0.05);
  prevT = now;

  const st = frozen
    ? { zone: level.zoneAt(camera.position.x, camera.position.z).audio, submerged: camera.position.y < -0.02, waterDepth: 0, speed: 0, onGround: true, footstep: false }
    : player.update(dt);

  // 涉水涟漪
  if (st.footstep && (st.waterDepth > 0.03 || st.swimming)) {
    water.addRipple(camera.position.x, camera.position.z, st.swimming ? 0.55 : 0.9);
  }

  // 水上/水下雾平滑过渡（相机过水线时不硬切）
  sub += ((st.submerged ? 1 : 0) - sub) * (1 - Math.exp(-dt * 6.5));
  fog.color.copy(FOG_AIR.color).lerp(FOG_WATER.color, sub);
  fog.density = FOG_AIR.density + (FOG_WATER.density - FOG_AIR.density) * sub;

  water.update(dt, camera, sub, fog);
  vol.update(dt, camera, sub, fog.density);
  post.update(dt, sub);
  if (audioStarted) audio.update(dt, st);

  // 本帧唯一一次阴影渲染，随后被反射/折射/主渲染复用
  renderer.shadowMap.needsUpdate = true;
  water.renderTargets(renderer, scene, camera);
  post.render(dt);

  if (SHOW_FPS) {
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 2) {
      console.log("[poolrooms] fps=" + (fpsFrames / fpsAcc).toFixed(1) + " res=" + resScale.toFixed(2) + " q=" + quality);
      fpsAcc = 0; fpsFrames = 0;
    }
  }

  // ---- 自适应分辨率：靠帧间隔判断（vsync 下 >21ms 即掉出 48fps）----
  frames++; dtSum += dt; cooldown -= dt;
  if (frames >= 45) {
    const avg = dtSum / frames;
    frames = 0; dtSum = 0;
    if (cooldown <= 0) {
      if (avg > 0.021 && resScale > 0.62) {
        resScale = Math.max(0.62, resScale - 0.08); applyRes(); cooldown = 1.2;
      } else if (avg > 0.021 && quality > 0) {
        quality--; post.setQuality(quality); cooldown = 1.5;
      } else if (avg < 0.0163 && resScale < 1) {
        resScale = Math.min(1, resScale + 0.05); applyRes(); cooldown = 1.5;
      } else if (avg < 0.0155 && resScale >= 1 && quality < QUALITY_MAX) {
        // 分辨率已满且仍很快 → 把之前降掉的画质档还回来（否则一次瞬时卡顿会永久关掉 GTAO）
        quality++; post.setQuality(quality); cooldown = 2.5;
      }
    }
  }

  if (ready < 4 && ++ready === 4) {
    document.title = 'POOLROOMS_READY';
    veil.classList.add('gone');
    hint.classList.add('show');
    const info = renderer.info;
    console.log(`[poolrooms] ready load=${performance.now() | 0}ms tris=${level.root.userData.triangles} geom=${info.memory.geometries} tex=${info.memory.textures} res=${baseW}x${baseH}`);
  }
}

// 预编译着色器，避免首帧长卡顿
renderer.compile(scene, camera);
frame();

// 调试/验证入口
window.__poolrooms = { THREE, renderer, scene, camera, level, water, vol, post, player, audio, lib };
