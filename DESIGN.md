# Poolrooms Web Simulator — 设计文档 v1

> 需求方：尘 · 实现：汐 · 2026-08-20
> 流程：dev-loop（设计 → 审设计 → 实现 → 审实现 → 实测验收 → 复盘）

## 0. 需求与边界

**需求原文要点**：网页版 3D Poolrooms（池核）模拟器；**无任何 UI、无任务**，仅自由探索；第一人称，身高约 1.7m；**优先画面真实感与沉浸感**；风格参考 UE5 Lumen + Nanite（真实材质、光影、水面反射）；氛围**宁静、美好、悠远**；地图要有**场景与明暗变化**；材质纹理细腻贴近氛围。

**非目标**（明确不做）：任务/收集/恐怖 jumpscare、菜单/设置面板/HUD/准星、存档、多人、移动端触屏、关卡编辑器、外部美术资源下载。

**交付形态**：纯静态站点（原生 ESM，无构建步骤），本地 HTTP 启动，**完全离线可跑**（three.js 已 vendor 到本地，纹理与音频全部运行时程序化生成，零外部请求）。

## 1. 技术选型与硬约束

| 项 | 选择 | 理由 |
|---|---|---|
| 引擎 | three.js **0.185.1**，本地 `vendor/three/`（`build/three.module.js` + `three.core.js` + addons 子集） | 免 CDN、免代理（CVR 关着也能跑）；addons 里现成有 `Octree`/`Capsule`/后处理全套 |
| 渲染器 | `WebGLRenderer`（WebGL2） | 稳定性优先；WebGPU 在 Chrome 上后处理链路仍有坑 |
| 模块 | 原生 ESM + `<script type="importmap">` 映射 `three`、`three/addons/` | 零构建、可直接改文件刷新看效果 |
| 纹理 | **100% 运行时程序化生成**（canvas2D + 噪声 → albedo/normal/roughness） | 离线、体积零、参数可调（"贴近氛围"要反复调） |
| 音频 | **100% WebAudio 程序化合成**（噪声整形 + 生成脉冲响应卷积混响） | 同上；水声/滴水/脚步/混响不依赖任何素材 |
| 服务 | `tools/serve.mjs`（node 内置模块，零依赖静态服务器，默认端口 8123） | ESM 在 `file://` 下被 CORS 拦，必须走 HTTP |
| 目标机 | RTX 3060 Laptop + Chrome，1080p，目标 60fps | 自适应分辨率兜底（0.65~1.0） |

**红线**：不改 DSH 官方文件；本项目自成目录 `D:\dsh-home\poolrooms\`，删目录即完全回滚；bat 全 ASCII。

## 2. "UE5 观感"的网页等效方案（原理 → 做法）

Lumen/Nanite 本身无法移植，抓的是**它们造成的观感特征**，逐条找等效：

| UE5 特征 | 观感表现 | 网页等效做法 |
|---|---|---|
| Lumen 全局光照 | 阴影里不死黑、有环境色渗透 | IBL：程序化 equirect 天光 → `PMREMGenerator` → `scene.environment`；**按房间克隆材质改 `envMapIntensity`**（0.12~1.0）模拟局部间接光强弱 |
| Lumen 反射 | 湿地面/水面反射真实环境 | 水面走**平面反射 RT**（全场景水面统一 y=0，只需一次反射渲染）；湿瓷砖走 IBL 镜面 + 低 roughness |
| Lumen 天光遮蔽 | 角落、缝隙有柔和暗角 | **GTAOPass**（屏幕空间地平线追踪 AO），multiply 混合 |
| Nanite 高密度细节 | 表面不平、边缘有倒角高光 | 几何：所有墙/柱做**倒角边**（0.01~0.02m 斜面）让高光有一条亮线；纹理：**1cm 内有细节**的高频 normal（瓷砖倒角+釉面波纹+污渍） |
| 电影级色彩 | 高光柔和过曝、暗部有色 | HDR half-float 管线 → 线性空间调色/颗粒/暗角 → SMAA → **ACESFilmic tone mapping**（`OutputPass`，末位） |
| 体积光 | 空气中可见光柱 | 每个天窗/高窗按太阳方向挤出**光柱棱台**（加性、深度软化、噪声流动）+ 光柱内**尘埃粒子** |
| 屏幕空间效果 | 泛光、镜头脏污 | `UnrealBloomPass`（阈值 0.85 / 强度 0.35 / 半径 0.75） |

## 3. 场景设计：七区，明暗有节奏

坐标：X 东、Z 南、Y 上。**全场水面统一在 y = 0**（只有池底深度不同）——这是"单次平面反射"的前提，也简化涉水判定。

| # | 区域 | 尺寸(m) | 池底 y | 层高 | 光照 | 氛围 | 声音 |
|---|---|---|---|---|---|---|---|
| 1 | **中庭主池 Atrium**（出生点） | 24×24 | −1.4 | 9 | 顶部 4 个 3×3 天窗 → 4 道强光柱直插水面；caustics 打墙 | 明亮、过曝、青绿；开阔 | 水波荡漾 + 长混响 |
| 2 | **柱廊 Colonnade** | 8×30 | −0.25 | 6 | 西墙 6 扇 2×4 高窗 → 平行光刀切地面 | **最"美好悠远"的一幕**；浅水漫步 | 涉水脚步 + 远处回声 |
| 3 | **天光露台 Terrace** | 16×12 | −0.35 | 无顶（露天） | 全天光，最亮，天空过曝成白 | 静谧、辽远、天空倒影 | 风的白噪 + 细碎水声 |
| 4 | **下潜阶梯 Stairwell** | 6×10 | 阶梯 −0.15/级 至 −1.6 | 3.2 | 仅上游漏光 + 1 盏壁灯 | 由亮转暗的过渡 | 混响变紧、水声变闷 |
| 5 | **潜水隧道 Tunnel** | 3×26 | −1.7 | 2.6 | 3 盏水下灯形成孤立光团，其余漆黑 | **最暗的一拍**；胸口深水缓行 | 滴水 + 闷响 |
| 6 | **深井厅 Deep Well** | 14×14 | −4.0 | 12 | 12m 高处一道 0.6m 窗缝 → 一把光刃劈在远墙 | 幽深、清冷、敬畏；可游泳 | 极长混响 + 低频嗡鸣 |
| 7 | **更衣角 Locker Nook** | 6×8 | 干地 +0.25 | 2.8 | 一盏暖黄壁灯 | 温暖、狭小、安心，与 6 强对比 | 干燥回声 + 滴水 |

**连通与回路**：1 →(北门洞)→ 2 →(北端拱门)→ 3（尽头）；2 中段 →(东侧洞口)→ 4 → 5 → 6 → 7 →(短水道)→ 1。构成**闭环**，自由探索不会走进死胡同，且明暗节奏为：亮 → 更亮 → 最亮 → 渐暗 → 最暗 → 幽深 → 暖暗 → 回到亮。

**"悠远"手法**：①闭环 + 门洞层层套叠，永远能看见"下一个空间的光"；②空气雾（FogExp2 密度 0.006，暖白）拉开纵深；③深井厅与柱廊尽头各设一处**不可达的光之门洞**（背后是雾+发光面），暗示空间无限延伸；④水面把光柱倒影拉长。

**细节道具**（少而准，都是池核符号）：泳池边**钴蓝腰线瓷砖**、池底泳道线、不锈钢扶梯与栏杆、排水格栅、墙角积水、更衣角长凳与淋浴喷头、天窗金属框。全部程序化盒体/圆柱，带倒角。

## 4. 渲染管线（每帧三次场景渲染）

```
[Pass A] 反射：镜像相机 + y=0 裁剪面 → rtReflect (half res, 隐藏水面/粒子)
[Pass B] 折射：正常相机 → rtRefract (color + depthTexture, 隐藏水面)
[Pass C] 主渲染（EffectComposer）：
   RenderPass(scene 含水面, 水面着色器采样 rtReflect/rtRefract)
   → GTAOPass(独立 AO 场景, multiply, 半径 0.55m)
   → UnrealBloomPass(Vector2(w,h), 0.34, 0.75, 0.86)
   → GradePass(线性域: 暗角/颗粒/色散/水下蓝染与扰动)
   → SMAAPass          ← 必须在 OutputPass 之前(r185 源码: 运行于 linear-srgb)
   → OutputPass(ACESFilmic + sRGB, 末位)
```

**色彩管线**：composer 全程 `HalfFloatType` 线性 HDR；`renderer.toneMapping = ACESFilmicToneMapping`（由末位 `OutputPass` 执行，`RenderPass` 阶段不 tone map；可用 `?tm=agx|neutral` 切换对比）；`outputColorSpace = SRGBColorSpace`；灯光走 three 物理单位。

**光照预算**：1 × DirectionalLight（太阳，4096 阴影贴图，正交范围覆盖全场 ~90m，PCFSoft，`normalBias 0.02`）+ 每区 1~3 个 PointLight/SpotLight（局部灯具与假反弹）+ 3 个带 caustics 贴图的 SpotLight（把水面折射光斑打到墙上）。**不用实时 AreaLight**（RectAreaLight 需要 LTC 且不投影，性价比低）。

## 5. 水体（画面第一优先级）

单个 `WaterSurface` 材质，被所有水域网格共用（同一 y=0 平面）：

- **反射**：`rtReflect`（镜像相机 + `clippingPlanes`），按屏幕 UV + 法线扰动采样；Fresnel（Schlick，F0=0.02）混合反/折射。
- **折射**：`rtRefract` 屏幕 UV + 法线扰动采样；扰动幅度随水深衰减（浅水几乎不扭）。
- **吸收**：从 `rtRefract` 的 depthTexture 反算池底世界坐标 → 光在水中的行程 `d` → `exp(-σ·d)`，σ = (0.42, 0.09, 0.055)/m（红光先死 → 天然青绿渐变，浅处清透、深处幽蓝）。
- **caustics**：用反算出的池底世界坐标采样**程序化 caustic 纹理**（两层不同速度/尺度叠乘，取高次幂），乘进折射色 → 光斑随水波在池底游动，且**自动贴合任何池底几何**，不需改池底材质。
- **水面细节**：两张滚动 ripple normal（0.6m / 2.4m 尺度，方向不同）+ 一层极慢大尺度涌动；太阳镜面高光（GGX 近似）+ 天光反射。
- **接触软化**：用深度差把水面 alpha 与"水线亮边"做羽化，避免水面与墙体交界处的硬切线；水线处加极淡泡沫/湿痕。
- **水下**：相机 y < 0 时 → 切换 `FogExp2`（青绿，密度 0.09）、水面从下方按全内反射渲染（近镜面）、开启水下后处理（UV 摇晃 + 蓝染 + 暗角 + 上方光斑）、音频切低通。
- **涟漪**：玩家涉水/游泳时在水面注入局部扰动（法线偏移场，围绕玩家 XZ 的衰减环，随时间扩散消退）。

## 6. 材质与纹理（程序化）

**世界尺度 UV**：所有几何的 UV 直接以**米**为单位（按面做平面投影），材质 `map.repeat = 1/S`（S=该纹理覆盖米数）→ 全场瓷砖尺寸物理一致，绝不拉伸。

七套材质（每套 albedo + normal + roughness，1024²，`anisotropy = max`）：

| 材质 | 覆盖尺寸 | 特征 |
|---|---|---|
| `mosaic` 小马赛克 | 0.8m（16×16 块，单块 5cm） | 米白微色差抖动、细缝、缝里积垢、釉面高频波纹 |
| `wallTile` 大墙砖 | 1.2m（6×6 块，单块 20cm） | 象牙白、倒角、局部裂纹与水渍流痕 |
| `deck` 池边地面 | 1.6m | 水磨石骨料颗粒、防滑纹、偏粗糙 |
| `deckWet` 湿地面 | 1.6m | 同上但 roughness 更低 + 略深，用于近水 1.2m 带 |
| `plaster` 顶面涂料 | 2.4m | 平涂微起伏、霉斑水渍 |
| `blueTrim` 钴蓝腰线 | 0.4m | 饱和钴蓝、釉面强反射，用于水线腰带与泳道线 |
| `metal` 不锈钢 | 1.0m | metalness 0.95、拉丝各向异性感、局部指纹污 |

**明暗分区**：每套材质按区域亮度克隆出 3 档（`bright / dim / dark`），只改 `envMapIntensity`（1.0 / 0.35 / 0.12）与极轻微 `color` 偏移 —— 这是模拟"局部间接光"的关键，也是"明暗变化"落地的手段。

## 7. 玩家控制（第一人称）

- **胶囊**：半径 0.32，站立胶囊由 y=0.32 到 y=1.38（总高 1.70），**眼高 1.66**（略低于头顶，符合真人）。
- **碰撞**：`Octree.fromGraphNode(collisionRoot)` + `capsuleIntersect`（three 官方 fps 范式）；重力 −18 m/s²（略强于真实，手感干脆），落地阻尼；胶囊圆底自然跨越 ≤0.2m 台阶（阶梯每级 0.15m）。
- **速度**：走 1.35 m/s、`Shift` 快走 2.5 m/s、水中按浸没比例衰减（膝 0.7×、腰 0.5×、胸 0.35×）；加速度/阻尼平滑，无瞬时启停。
- **游泳**：水深 > 1.5m 且脚不着地 → 游泳态（浮力把身体压在水面，`Space` 上浮、`Ctrl/C` 下潜、视线方向移动，阻尼大，动作缓慢安静）。
- **镜头**：FOV 65、near 0.05、far 250；指针锁定鼠标视角（灵敏度 0.0022，轻微平滑）；俯仰限 ±85°；**呼吸摇摆**（idle 0.35Hz 幅 0.6cm）+ **步伐头部起伏**（幅 1.2cm，与脚步声同相）+ 落地轻微下沉。
- **无 UI**：仅进入前一行会淡出的提示文字（指针锁定与音频必须由用户手势触发，这是浏览器硬限制）；进入后**零覆盖层、无准星**。`Esc` 解锁鼠标时提示文字再淡入。

## 8. 音频（程序化，纯 WebAudio）

`master → convolver(生成的 2.8s 明亮混响 IR) → compressor → destination`，另有 dry 支路控制干湿比。

- **环境床**：带通噪声（400~1400Hz）+ 慢 LFO = 水面荡漾；低通 90Hz 房间嗡鸣；高频微光泽。
- **随机事件**：滴水（正弦 + 快速衰减包络 + 高混响）、远处水花、偶发结构嘎吱，泊松分布触发。
- **分区混音**：按玩家所在区插值干湿比/低通/混响长度（中庭长混响、隧道紧闷、更衣角干燥、露台风声）。
- **交互音**：脚步（干地=短脆、浅水=水花、深水=沉闷划水），按步频触发；入水/出水瞬间的"哗"。
- **水下**：全局低通 380Hz + 气泡 + 心跳感低频。
- 全部在首次点击（指针锁定同一手势）后 `resume()`。

## 9. 文件结构与接口契约

```
D:\dsh-home\poolrooms\
  index.html              # importmap + canvas + 进入提示（唯一 DOM）
  start-poolrooms.bat     # ASCII：起服务 + 开 Chrome
  tools\serve.mjs         # 零依赖静态服务器
  DESIGN.md
  src\main.js             # 引导、主循环、三次渲染编排、自适应画质
  src\textures.js         # 程序化纹理工厂
  src\materials.js        # 材质集 + 明暗分区克隆
  src\level.js            # 七区几何、开洞、道具、灯光、碰撞体、水域表
  src\water.js            # 水面材质 + 反射/折射 RT + 水下状态
  src\volumetrics.js      # 光柱 + 尘埃
  src\postfx.js           # composer 链 + 调色/水下 shader
  src\player.js           # 控制器、碰撞、涉水/游泳、镜头动态
  src\audio.js            # 程序化音景
  vendor\three\           # three 0.185.1（build + addons 子集）
```

所有模块统一 `import * as THREE from 'three';`（走 importmap），不通过参数传 THREE。

**契约 A：`textures.js`**（纯 TypedArray 数学，**不用 canvas/DOM** → 可在 node 里跑测试与导出 PNG 检查）
```js
export const TEXTURE_SETS = ['mosaic','wallTile','deck','deckWet','plaster','blueTrim','metal'];
export function createTextureSet(name, { anisotropy = 8 } = {})
  -> { map, normalMap, roughnessMap, spanMeters }  // DataTexture，wrap/colorSpace/mipmap/anisotropy 已设好
export function createCausticTexture()   -> THREE.DataTexture  // 可平铺光斑
export function createRippleNormal(seed) -> THREE.DataTexture  // 可平铺水面法线
export function createSkyEquirect()      -> THREE.DataTexture  // 天光 equirect（背景 + IBL 源，HalfFloat/Float）
export function createSoftDotTexture()   -> THREE.DataTexture  // 尘埃/灯光辉光用软圆点
```
**契约 B：`audio.js`**（模块顶层不碰 `AudioContext`）
```js
export class Soundscape {
  constructor()                       // 不建 AudioContext（等手势）
  start()                             // 首次手势后建 ctx + resume
  update(dt, { zone, submerged, waterDepth, speed, onGround, footstep })
  setMasterVolume(v); dispose()
}
export function buildImpulseResponse(sampleRate, seconds, params) -> [Float32Array, Float32Array]  // 纯函数，可 node 测
```
**契约 C：`level.js`**
```js
export function buildLevel(THREE, ctx) -> {
  root,               // 可见几何（加进 scene）
  collisionRoot,      // 供 Octree 的碰撞几何
  waterAreas: [{ minX, maxX, minZ, maxZ, floorY, zone }],  // 水域与池底（水面恒 y=0）
  spawn: { position, yaw },
  lightShafts: [{ rect, normal, intensity, color }],       // 供 volumetrics 生成光柱
  zones: [{ name, box, brightness, audio }],               // 供音频/材质分区
  sun: { direction, color, intensity },
}
```

## 10. 边界表（必须覆盖的状态与异常）

| 场景 | 期望行为 |
|---|---|
| WebGL2 不可用 / 上下文丢失 | 黑屏 + 一行纯文本说明（不弹窗、不崩死循环） |
| 未点击进入 | 场景照常渲染（可看），只是无鼠标锁与声音 |
| `Esc` 解锁 / 切标签页 | 暂停输入、`dt` 夹在 ≤0.05s（防切回来瞬移穿墙）、音量渐隐 |
| 相机正好在 y=0 附近 | 水面渲染与水下判定用 ±2cm 死区，避免闪烁抖动 |
| 玩家卡进几何 | 每帧胶囊解算 + 掉出世界（y < −30）时重置到 spawn |
| 深水游泳撞到墙 | 沿墙滑动，不弹飞 |
| 窗口尺寸变化 / DPI 变化 | 所有 RT 与 pass 同步 resize（含 GTAO/SMAA/bloom） |
| 帧率低于 50 | 分辨率缩放逐步降到 0.65；仍低则关 GTAO；**永不关水面反射**（画面核心） |
| 长时间运行 | 无每帧 new（复用向量/矩阵）；纹理/RT 只建一次 |

## 11. 验收标准（尘逐项跑，AI 不自封完成）

1. 双击 `start-poolrooms.bat` → 浏览器打开 → 3s 内出画面，控制台无红色报错。
2. 点击进入 → 鼠标视角流畅、无指针漂移；`Esc` 可退出。
3. 站在中庭：能看见天窗光柱、水面反射柱子与天光、池底 caustics 游动、青绿深度渐变。
4. 走进浅水：脚步变水声、有涟漪；进深水自动转游泳；潜入水下：画面蓝染扰动、声音变闷。
5. 走完七区闭环：明暗节奏明显（露台最亮 / 隧道最暗 / 更衣角暖暗），无穿墙、无卡死、无掉出世界。
6. 画质主观达标：瓷砖近看有细节不糊、边缘有高光、暗部不死黑、整体宁静悠远。
7. 帧率：1080p 下体感流畅（60fps 附近，自适应生效时无突兀跳变）。
8. 无 UI：进入后画面上没有任何控件/准星/文字。

## 12. 回滚

删除 `D:\dsh-home\poolrooms\` 即完全回滚（不动系统、不动 DSH、不写注册表、无后台常驻；服务器仅在 bat 运行期存在）。


---

## 13. 修订记录 v1.1（2026-08-20，实现完成后回填）

### 13.1 采纳设计审查 5 项必改（eview/design-review.md）
1. **pass 顺序**：SMAA 移到 OutputPass 之前（r185 SMAAPass 源码声明运行于 linear-srgb），OutputPass 末位；调色/颗粒/暗角/水下效果全部改在线性域完成。
2. **GTAO 水面隔离**：GTAOPass 用**独立 AO 场景**（level.root/decor 的节点克隆，共享 geometry/material），不含水面/光柱/尘埃 —— 否则它的 overrideMaterial 会把水面当不透明遮挡体，池底 AO 全丢且水面出现假暗角。
3. **UnrealBloomPass** 首参补 Vector2(w,h)（原设计漏写会导致参数错位）。
4. **性能**：shadowMap.autoUpdate=false + 每帧只置一次 
eedsUpdate（阴影每帧渲 1 次，被 3 个 pass 复用）；实时点光砍到 8 个（其余灯具只留自发光面片走 bloom）；折射 RT 0.6×、反射 RT 0.5× 分辨率。
5. **水下闭环**：镜像平面法线随相机上下翻转（斜近平面裁剪方向同步）；深度反算钳制 d = max(0, 水面y − 命中点y)；禁用 logarithmicDepthBuffer；折射深度用 FloatType。

### 13.2 实现期实测修正（全部由自动化测试 / 数值化截图暴露）
- **明暗关系重做**：最初"无遮挡天光 IBL"把室内泡成一片灰（直方图只占 2 档、零过曝点、detail 2.1）。改为：IBL 仅作微弱补光(0.18) + 半球光当廉价反弹 + 太阳 9.0 + **连续 GI 场**按房间衰减三个间接光项（irradiance/iblIrradiance/adiance）。改后中庭 detail 6.4、隧道均值 26、露台 219 —— 明暗节奏成立。
- **GI 方案换血**：放弃"按房间克隆材质改 envMapIntensity"（21 个材质实例 + 门洞硬接缝），改为 onBeforeCompile 注入**世界空间盒体 GI 场**（14 盒平滑加权），材质数回到 7，过渡连续无缝。
- **帧缓冲反馈环（真 bug）**：光柱着色器采样折射深度图，而折射 pass 又渲染整个场景（含光柱）→ GL_INVALID_OPERATION: Feedback loop。修法：water.hideDuringRT 在两次 RT 渲染期间隐藏光柱/尘埃。
- **天空动态范围**：地平线 1.6 → 1.05（浅水镜面反射天空导致 30% 像素爆白），并加 ±6% 方位向微变化，让水面反射不是一块死板纯色。
- **r185 废弃 API**：PCFSoftShadowMap → PCFShadowMap；THREE.Clock → performance.now()。
- **净高事故**：出水通道天花按"最低地面"设 1.9m，但该段地面升到 +0.25 → 顶部净高仅 1.65m < 身高 1.70m，胶囊被夹在地板与天花之间，表现为"撞上一面看不见的墙"。已修为 2.6m，并新增**全区净高体检**测试（90 点采样，要求 ≥1.85m）。
- **台阶可攀爬性**：级高必须 ≤ 胶囊半径的一半（≈0.16m），否则圆底胶囊接触台沿时法线几乎水平、爬不上去。出水通道只有 2.25m 长无法满足 → 改 32° 缓坡；中庭入水阶梯 7 级 → 10 级（级高 0.164）。另给控制器加**经典 step-up**（抬 0.45m 试探再前进 0.18m）与**水中齐沿上爬助力**，从机制上消除这一类卡死。
- **涉水速度**：胸深(1.45m)在 1.35 阻力系数下只有 0.47m/s（44m 隧道要走 94 秒），改 0.8 系数 → 0.63m/s，按 Shift 1.17m/s。

### 13.3 本项目的自动化验证手段（无头环境下的替代方案）
本模型无法看图，因此把"看画面"换成可断言的数字：
- 	ools/test-textures.mjs：7 套贴图的平铺性/法线合法性/动态范围/生成耗时（69 项）
- 	ools/test-audio.mjs：AudioContext mock 下跑 3000 帧，验证幂等/无节点泄漏/无 NaN（含 IR 纯函数）
- 	ools/test-level.mjs：node 里直接跑 uildLevel，用射线探针验证天窗/高窗通天、9 处门洞可穿越、实心墙、9 处地面高度、水域一致性、天空 equirect 方位、**全区净高**（51 项）
- 	ools/test-walk.mjs：node 里跑**真实胶囊碰撞 + Octree**，按 26 个航路点走完七区闭环（含游泳过深井、沿阶梯出水），验证连通性/不卡死/不掉出世界（31 项）
- 	ools/shoot.ps1 + 	ools/analyze-shot.mjs：无头 Chrome 截图 → 解码 PNG → 输出均值/直方图/黑与过曝占比/细节密度/分区亮度色相网格，用数字判断画面
- 	ools/diag-passage.mjs：卡点逐帧诊断（位置/速度/碰撞法线/射线探针），定位"看不见的墙"
- ?cam= &look= &sun= &env= &exp= &tm= &hemi= &shadow= &wdebug= &noao= URL 参数：冻结相机与扫参，让画面调试可复现

---

## 14. 修订记录 v1.2（2026-08-20 尘真机验收反馈 + 审查②-2 落地）

### 14.1 尘验收反馈（原话要点：光影很棒、柱廊光柱与地面散射很喜欢；但要修三处）
| 反馈 | 落地 |
|---|---|
| 面对光源会过曝、露天处晃眼看不清 | ①太阳 9.0→5.5 ②曝光 0.95→0.88 ③bloom 阈值 0.86→0.95、强度 0.34→0.28 ④光柱强度 0.5→0.38 ⑤太阳盘亮度减半（水面倒影不再刺眼）⑥**露台池底换深一档马赛克**（`mosaic:0x8fa2ab` 变体：复用同贴图只调基色，材料库新增 `name:tint` 语法）——露台均值 179→138、细节 2.95→5.03、零过曝像素；柱廊保持 151 未被误伤 |
| 阳光亮度过高 | 同上 ①⑤；水面太阳镜面高光 7.0→3.2 并钳制 |
| 步行速度要快一倍 | WALK 1.38→2.76，RUN 2.55→3.2 |

### 14.2 审查②-2（`review/impl-review2.md`）落地项
1. 反射用上一帧相机变换（转身滑移）→ `water.renderTargets()` 首行 `camera.updateMatrixWorld()`
2. 水面雾与场景 FogExp2 深度量不一致 → 顶点传 `vViewZ = -(viewMatrix*wp).z` 供雾用
3. 折射深度按 0.6× RT 像素中心 snap 采样（剪影描边）→ 新增 `snapUV()` + `uDepthRes`
- 审查④（GTAO 池底暗带穿透水面）与⑤（颗粒在 SMAA 前被抹平）**已记录未改**：尘验收未提及、修复需要额外 pass/深度注入，按"不过度修改"原则留给将来。