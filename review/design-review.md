# Poolrooms Web Simulator — 设计文档审查报告

- 审查对象：`D:\dsh-home\poolrooms\DESIGN.md`（v1，2026-08-20）
- 审查基准：`vendor\three\` 下真实源码（r185 = 0.185.1），逐条读源码核实，非凭记忆
- 结论：**需修订后通过**
- 说明：核心架构（三次渲染 + composer 线性 HDR + 平面反射 + 程序化纹理 + 胶囊碰撞）自洽且所有引用的 API 均真实存在；但存在 1 处确定的 pass 顺序错误、1 处构造签名误用、GTAO 对透明水面的处理缺陷、以及明显被低估的性能预算。按下列"必须修改"修订后可进入实现。

---

## 一、API 核实结果（r185 源码证据）

| 设计引用 | 核实结论 | 源码证据 |
|---|---|---|
| `AgXToneMapping` | ✅ 存在，`OutputPass` 支持（`AGX_TONE_MAPPING` define） | `build\three.module.js:499`（`vec3 AgXToneMapping(...)`）、`addons\postprocessing\OutputPass.js:110` |
| `OutputPass` | ✅ 存在，构造无参；tone mapping + sRGB 均取自 renderer | `OutputPass.js:38-77`、`:92-116` |
| `GTAOPass` | ✅ 存在；**构造签名 `(scene, camera, width=512, height=512, parameters, aoParameters, pdParameters)`**，需 scene+camera；默认内部渲染 depth+normal GBuffer；`OUTPUT.Default`(0) 即 multiply 混合，由 `blendIntensity` 控制；`setSize(w,h)` 由 composer 调用 | `GTAOPass.js:56`、`:114`、`:304-326`（`setGBuffer` 内部 DepthTexture+MeshNormalMaterial）、`:526-586`（Default 走 `blendMaterial`，`blendSrc=DstColorFactor` 即乘法）、`:717-725`（OUTPUT 枚举）、`:247-263`（setSize） |
| `SMAAPass` | ✅ 存在，**构造无参**（`constructor()`）；**源码注释明确：运行于 linear-srgb，必须放在 `OutputPass` 之前** | `SMAAPass.js:30`、`:14-15`、`:183-192`（setSize 写 1/w,1/h） |
| `UnrealBloomPass` | ✅ 存在；**构造签名 `(resolution: Vector2, strength=1, radius, threshold)`，首参是 Vector2**；省略则退化为 256×256 | `UnrealBloomPass.js:46`、`:78`、`:59-63`（radius 域 [0,1]） |
| `EffectComposer` + `HalfFloatType` | ✅ 默认内部 RT 即 `type: HalfFloatType` | `EffectComposer.js:69` |
| `PMREMGenerator.fromEquirectangular` | ✅ 存在 `fromEquirectangular(equirectangular, renderTarget=null)`，内部 `_fromTexture` 可吃任意 Texture（含 FloatType DataTexture） | `three.module.js:2750`、`:2857-2883` |
| `scene.environmentIntensity` / `backgroundIntensity` | ✅ 均存在 | `three.module.js:18690`（`envMapIntensity.value = scene.environmentIntensity`）、`:1432/1501`（background 用 `backgroundIntensity`）、`three.core.js:15097`（默认 1） |
| `SpotLight.map` | ✅ 存在，**且不需要 castShadow 即生效**（`if (light.map)` 独立于 `castShadow`；castShadow 只额外加阴影项） | `three.module.js:8687-8696` |
| `Octree.fromGraphNode` + `capsuleIntersect` | ✅ 存在；`capsuleIntersect` 返回 `{ normal: Vector3, depth: number }` 或 `false`；`fromGraphNode` 对 indexed geometry 调用 `toNonIndexed()`（重复一份几何），每顶点 `new Vector3()` | `addons\math\Octree.js:746`、`:668-699`、`:761`、`:773-775` |
| `Capsule` | ✅ 构造 `(start: Vector3, end: Vector3, radius=1)` | `addons\math\Capsule.js:22` |
| `BufferGeometryUtils.mergeGeometries` | ✅ 存在 `mergeGeometries(geometries, useGroups=false)` | `addons\utils\BufferGeometryUtils.js:133` |
| `WebGLRenderTarget` 附加 `depthTexture` | ✅ 存在；**必须是 `DepthTexture` 实例**（否则运行时 throw），**尺寸必须与 RT 一致**（否则 throw）；RT 颜色纹理默认 `colorSpace=NoColorSpace`（线性）、`flipY=false`；RT.setSize 时 depthTexture 会自动同步尺寸 | `three.module.js:12768`、`:18938`、`:12777-12782`；`three.core.js:9271`（`this.depthTexture = options.depthTexture`）、`:9303-9333` |
| `renderer.clippingPlanes` / `material.clippingPlanes` / `localClippingEnabled` | ✅ 均存在；**全局 `renderer.clippingPlanes` 非空即对全场景生效（不需要 localClippingEnabled）**；`material.clippingPlanes` 才需要 `renderer.localClippingEnabled=true` | `three.module.js:16245`、`:16253`（默认 false）、`:2515/2521`、`:17797/17949/18037`（`setGlobalState`） |

**核实结论：设计引用的 API 全部真实存在，没有"不存在的 API"。** 问题在于三处"用法/顺序错误"（见下），不涉及 API 不存在。

---

## 二、问题清单

### P1【严重】GTAO 会把透明水面当不透明渲染，遮挡池底并产生伪暗角
- 位置：§4 Pass C、§5 水体
- 描述：`GTAOPass` 默认内部 GBuffer 渲染用 `scene.overrideMaterial = MeshNormalMaterial`（`GTAOPass.js:161`、`:641-643`）。overrideMaterial 会**替换掉水面材质**，水面自己的 `transparent/depthWrite` 全部失效，水面被当作不透明平面写入 depth+normal。后果：① 池底/池壁被水面平面遮挡，其 AO 全部丢失；② 水面平面自身在与墙交界处被算出 AO 暗角（透明表面不该有）；③ `_overrideVisibility` 只隐藏 Points/Line/Line2（`GTAOPass.js:651-667`），不会排除透明 mesh。水面是"画面第一优先级"，此问题直接影响第一观感。
- 建议：给 `GTAOPass` 传入一个**不含水面/粒子/光柱的 AO 场景**。由于关卡静态且 `buildLevel` 一次性构建，最省事的正确做法是 `const aoScene = scene.clone(true)`（`Object3D.clone(true)` 与 `Mesh.clone()` 只克隆节点，**共享 geometry/material 引用**，内存开销可忽略），然后 `aoScene.getObjectByName('water').visible = false`（粒子、光柱同理）；`new GTAOPass(aoScene, camera, w, h, undefined, { radius: 0.5 })`。若坚持共用场景，则必须在 GTAO 的 GBuffer 渲染期间临时隐藏水面（需子类化 GTAOPass，把 `water.visible=false` 包在 `_renderGBuffer` 前后），不推荐。

### P2【严重】SMAA 顺序错 + OutputPass 非末位 → 色彩空间错误 / 双重编码风险
- 位置：§4 渲染管线
- 描述：r185 `SMAAPass` 源码注释明确"**operates in linear-srgb so this pass must be executed before OutputPass**"（`SMAAPass.js:14-15`）。设计链为 `OutputPass → SMAAPass → FinalPass`，把 SMAA 放到了 AgX tone map + sRGB 之后：SMAA 的 luma 边缘检测在**非线性 sRGB 数据**上运行，结果错误（边缘判定失真、混合权重不对）。同时 `OutputPass` 文档要求"应放在 pass 链末尾"（`OutputPass.js:17-21`），设计在其后还放 `FinalPass`（LDR 颗粒/暗角/水下），会带来两重风险：OutputPass 已把 tone-mapped + sRGB 编码数据写回 HalfFloat RT，其后任何以 `ShaderMaterial`（`toneMapped` 默认 true）渲染到屏幕的 pass，其输出会**再被 renderer 套一次 AgX tone map + 一次 sRGB 编码**（`three.module.js:18345-18355` tone mapping 在 `_currentRenderTarget===null` 时启用；`:18336` 色彩空间在屏幕渲染时为 `outputColorSpace`）→ 双重 tone map / 双重 gamma。
- 说明（正面）：设计的另一处判断是**正确**的——`RenderPass` 渲染进 composer RT 时 `_currentRenderTarget!==null`，tone mapping 被置 `NoToneMapping`（`three.module.js:18347-18353`），不会 double tone map；`OutputPass` 是 r185 唯一负责 tone map + sRGB 的环节。所以问题**只在 OutputPass 之后**。
- 建议：改为 `RenderPass → GTAO → UnrealBloom → Grade(线性) → 水下蓝染/UV扰动(线性) → SMAAPass(线性) → OutputPass(AgX+sRGB，末位) → 屏幕`。颗粒/暗角并非必须 LDR，移到 OutputPass 前在**线性域**做（分级在线性域反而更正确）；若执意要"胶片颗粒在显示域"，则末位 pass 必须用**自定义 RawShaderMaterial 且 `toneMapped=false`、着色器内不做任何再编码**，并把它当输出直通——脆弱，不推荐。颗粒/暗角建议直接做成一个线性 ShaderPass 插在 SMAA 前。

### P3【中等】`UnrealBloomPass` 构造签名误用（缺 resolution，参数错位）
- 位置：§2 表格、§4 Pass C
- 描述：设计写"`UnrealBloomPass(0.35 / 0.75 / 0.85)`"（强度/半径/阈值），但 r185 签名为 `constructor(resolution: Vector2, strength=1, radius, threshold)`（`UnrealBloomPass.js:46`）。若照字面写 `new UnrealBloomPass(0.35, 0.75, 0.85)`，会把 `0.35` 当 resolution、`0.75` 当 strength、`0.85` 当 radius，阈值变成 undefined → 参数全错位 + resolution 不是 Vector2 会出 NaN/异常。若省略 resolution，则退化为 256×256 的模糊 bloom。
- 建议：`new UnrealBloomPass(new THREE.Vector2(w, h), 0.35, 0.75, 0.85)`（strength=0.35, radius=0.75, threshold=0.85），并在 resize 时 `bloomPass.setSize(w, h)`（composer.setSize 会代调）。

### P4【中等】水体方案的前提被场景自身打破 + 反射/折射状态未闭环
- 位置：§3、§4、§5
- 描述：
  1. §3 说"全场水面统一 y=0 只需一次平面反射"，但 §3 第 7 区"更衣角 干地 +0.25m"、第 2 区"浅水 −0.25"等与 y=0 并不冲突（水面仍 y=0，只是池底/干地不同），**前提本身成立**；真正的风险是：更衣角干地 +0.25 与露台/柱廊的"浅水/涉水"在**同一连续地面网格**上若被合并进同一个水面 quad（覆盖了干地区域），会出现"干地上也铺水"。需保证 `waterAreas` 只覆盖真正有水的多边形，干地 +0.25 区域不生成水面。
  2. 反射 RT 用 `renderer.clippingPlanes`（全局）时，**必须 save/restore**：Pass A 设 `renderer.clippingPlanes=[Plane(+Y, 0)]`，Pass B/C 前恢复为 `[]`，否则主渲染会被裁掉水面以下一切。且裁剪在 shadow pass 也生效（`three.module.js:17949/18037`），若恢复顺序不对会污染 4096 阴影。
  3. 水线"接触软化"要用的"背景深度"**必须是 `rtRefract.depthTexture`**（它隐藏了水面，记录的是水面背后的墙/池底深度）；不能指望主深度缓冲（透明水面在主 pass 里 depthWrite 顺序不可靠）。
- 建议：显式写出 pass 编排的"状态包围"：`saveClipping = renderer.clippingPlanes; renderer.clippingPlanes=[waterPlane]; render(rtReflect); renderer.clippingPlanes=saveClipping;`，并对 `renderer.shadowMap.autoUpdate` 一并管理（见 P6）。水线羽化显式声明采样 `rtRefract.depthTexture`。

### P5【中等】水下（相机 y<0）反射镜像相机与裁剪面翻转未定义
- 位置：§4 Pass A、§5 水下
- 描述：设计只定义了水上情形（镜像相机 + y=0 裁剪面、隐藏水面）。§5 说"水下…从下方按全内反射渲染（近镜面）"，但没讲清：① 水下时镜像相机应绕 y=0 翻到**水面上方**，且裁剪面方向要**翻转**（水上情形裁 `y<0` 保留 `y>0`；水下看水面时应当裁 `y>0` 保留 `y<0`，即显示水下侧的"倒影"）；② 水面从下方观察时的 Fresnel/折射采样源需要切换（水下不再用 `rtRefract` 的"正常相机→水下景物"当折射，而应改采 `rtReflect` 或换一套）。设计里这两点空白。
- 建议：把"水下渲染分支"写成对称状态机：`camera.y<0` 时，镜像相机 `position.y = -position.y`、`rotation` 按水面对称翻转；裁剪面由 `Plane(+Y,0)` 换成 `Plane(-Y,0)`；Fresnel 的混合源按"水上/水下"二选一。并用 §10 的 ±2cm 死区 + 平滑过渡，避免相机穿水面瞬间的 RT 源硬切换闪烁。

### P6【严重】性能预算被低估：实际是 4~5 次全场景几何渲染 + 每帧 3× 阴影重渲 + 前向 ~20 灯
- 位置：§4、§10
- 描述：
  1. "每帧三次场景渲染"名不副实：反射(半分辨率)+折射+主渲染 = 3 次，**GTAO 内部还会用 `MeshNormalMaterial` 把全场景几何再渲染一遍 depth+normal（GBuffer）**（`GTAOPass.js:502-508`），即第 4 次全场景几何遍历；再加 4096 太阳阴影 = 第 5 次。半分辨率只减轻了反射那一次。
  2. **阴影被反复重渲**：`renderer.render()` 每次调用都会重渲所有 `castShadow` 光的 shadow map（`autoUpdate` 默认 true）。3~4 次 render()/帧 → 4096 阴影贴图每帧被渲染 3~4 遍，这是设计完全没计入的最大隐性开销之一。
  3. **前向渲染灯数陷阱**：`每区 1~3 个 PointLight/SpotLight` ≈ 最多 ~20 个点/聚光 + 3 个 caustics SpotLight + 1 方向光。three 前向 PBR 里每个 mesh 片元会循环所有影响它的光（无 cluster/deferred），20+ 灯在 1080p 下对 3060 Laptop 是实质风险。
  4. 7 套 1024² 纹理 ×(albedo+normal+roughness) ≈ 84~112MB VRAM（含 mipmap），可接受；但 `anisotropy = max`（16x AF）叠加多 pass 采样是额外带宽成本。
  5. `Octree` 输入若用"带倒角 + 多面"的可见几何而非简化碰撞几何，三角形数会爆炸且 `fromGraphNode` 还会 `toNonIndexed()` 再复制一份（`Octree.js:761`）。
- 判断：按设计原样，1080p@60fps **大概率守不住**，最可能瓶颈依次是：① 每帧 3~4× 阴影重渲 + 全场景多 pass；② GTAO（官方文档自述"比 SSAO 更贵"）；③ 前向灯数。设计的降级顺序（先降分辨率、再关 GTAO、永不关反射）方向合理，但"永不关反射"与"反射 RT 也是全场景几何渲染"叠加后，单靠关 GTAO 可能不够。
- 建议（可直接照改）：
  1. `renderer.shadowMap.autoUpdate = false;` 每帧只在主渲染前 `renderer.shadowMap.needsUpdate = true` 一次，阴影每帧只渲 1 次并在 3 个 pass 复用；或反射/折射 pass 期间临时 `dirLight.castShadow = false`（反射水面本身也不需要精确阴影）。
  2. 反射 RT 进一步降本：反射 pass 用更简 LOD / 关次要灯光 / 半分辨率（已做），并考虑反射内容只渲染"会被水面反射到"的上半空间对象（简单遮挡剔除）。
  3. 点/聚光从"每区 1~3 个"砍到**全场景 ≤6~8 个**真实灯；其余"假反弹"改用自发光面片（emissive 材质 + 低亮度）或并入 IBL（见 P7），不用实时点光。
  4. `collisionRoot` 必须用**单独的低模盒体/胶囊近似**（墙=薄盒、柱=柱体），不要喂倒角后的可见网格；可见网格的倒角用 `RoundedBoxGeometry` 时控制 segment 数，避免三角形爆量。
  5. `anisotropy` 用 `Math.min(8, renderer.capabilities.getMaxAnisotropy())` 而非字面 "max"。

### P7【中等】按房间克隆材质改 `envMapIntensity` 伪造局部 GI → 可见接缝 + 盒状光照
- 位置：§2、§6"明暗分区"
- 描述：IBL（scene.environment）是全局、无遮挡的，设计用"每套材质按区域克隆 bright/dim/dark 三档、只改 envMapIntensity + 轻微 color"来伪造局部间接光。破绽：
  1. **共享墙两侧材质不同 → 硬接缝**：一面墙同时属于亮区与暗区时，Box 两侧用不同材质，转角处出现明显亮/暗分界线；门洞处"亮区看暗区"的过渡是**阶跃**而非 Lumen 的连续渐变，直接破坏"宁静悠远"的沉浸感。
  2. `envMapIntensity` 只缩放 IBL 项，不改直接光：暗区的天窗/太阳直射光斑依然全亮，与"暗区环境色很暗"叠加后显得"死黑里一块亮斑"，不自然。
  3. 21 个材质实例（7×3）带来材质/程序分裂，且"轻微 color 偏移"会与 AgX 后处理叠加导致偏色。
- 建议（按性价比排序）：
  1. 保留"每区 1~2 个真实局部灯"作为明暗主手段（本来就是"局部灯具与假反弹"），`envMapIntensity` 只做全局基准，**不要按房间克隆材质**；这是改动最小、最不破坏画面一致性的方案。
  2. 若仍要"区域间接光渐变"，改用**连续的世界空间衰减**：在自定义 `onBeforeCompile` 里给标准材质加一个基于 `worldPosition` 的 irradiance 修正项（或插值 2~3 个 LightProbe），让亮度随位置连续变化，而不是硬切材质。
  3. 共享墙统一材质，避免转角/门洞接缝。

### P8【轻微~中等】边界表 §10 的遗漏
- 位置：§10
- 逐项补充：
  1. **pointer lock 失败/被拒**：`requestPointerLock` 可能被拒绝（iframe 权限、立即 Esc、`pointerlockerror`）。"进入后零覆盖层"意味着失败后玩家完全无法操作。→ 监听 `pointerlockerror`，失败时重新淡入那行进入提示（这是唯一允许的 UI）。
  2. **`webglcontextrestored` 恢复**：§10 只写"黑屏 + 说明"，等于放弃恢复。three 会重建 GL 状态，但**程序化生成的 DataTexture / PMREM / 各 RT 内容不会自动回来**，必须监听 `webglcontextrestored` 重跑 `textures.js` 的生成 + `pmremGenerator.fromEquirectangular` + 重建 RT。长时间运行的演示必须有这条。
  3. **resize 时反射/折射相机 aspect**：§10 说"所有 RT 与 pass 同步 resize"，但漏了镜像相机与折射相机的 `aspect` 更新（否则窗口变形后反射/折射画面拉伸）。GTAO 的 setSize 会自己 copy `camera.projectionMatrix`（`GTAOPass.js:257-258`），但折射相机 aspect 需手动。
  4. **游泳时相机穿水面**：§7 眼高 1.66、游泳浮力"压在水面"，头部会频繁在水线上下抖动；§10 只有 y=0 的 ±2cm 死区，**不够**。水下后处理应基于相机 y 用滞回（如 ±5~8cm）+ 时长平滑过渡（不硬切），否则头部每次过水线都闪一下蓝染/暗角。游泳/涉水判定（1.5m）同样要滞回。
  5. **"无 UI"与"点击进入"冲突**：§7 已承认"进入前一行淡出提示文字"，这与 §0"无任何 UI"字面冲突。这是浏览器硬限制（pointer lock + 音频必须手势），不可绕过。→ 在文档里把"无 UI"精确为"**无常驻 HUD/菜单/准星**"，首屏一行可淡出的点击提示是唯一例外；这是最不破坏需求的做法（比"无提示直接锁指针但被浏览器拒"或"弹出菜单"都要好）。
  6. **掉落重置只查 y<−30**：应同时查 `y>+30`（被顶穿/弹飞上天）或 NaN 坐标。
  7. **首次编译卡顿**：程序化 shader + 大阴影 + PMREM 首次生成会有一帧长 hitch，验收标准"3s 内出画面"应允许异步预热（`pmremGenerator.compileEquirectangularShader()` 等），并避免首帧 dt 被拉爆。

### P9【轻微】depth 反算的数学前提与边界未写清
- 位置：§5 吸收/caustics
- 描述：
  1. **深度精度**：`new DepthTexture(w,h)` 默认 `UnsignedIntType`（24-bit 定点）。近 0.05/远 250 下，24-bit 深度在 ~10m 处步长约 cm 级、~4m 处亚 mm 级——对平滑吸收足够，但为稳妥，`rtRefract` 的 depthTexture 建议用 `FloatType`（32-bit）以支持鲁棒的世界坐标反算。
  2. **不要开 `logarithmicDepthBuffer`**：一旦开启，depthTexture 存的是对数深度，标准逆投影反算全错（需额外还原 log）。设计未提，需明确"保持 `logarithmicDepthBuffer=false`"。
  3. **必须排除水面自身**：Pass B 已"隐藏水面"，正确；但要确认隐藏后 depthTexture 里存的是池底/墙，而非水面 y=0。这一点设计做了，予以肯定。
  4. **命中点高于水面的边界**：透过水面看一面**延伸到水面上方**的墙时，反算出的世界点是墙的**干区（y>0）**，"水深 d = 0 − y_hit < 0"会导致 `exp(-σ·d)` 变成**增亮**、caustics 贴错。→ 反算后必须 `waterDepth = clamp(0, hitY, 4.0)` 的语义：`d = max(0, waterSurfaceY - hitY)`，`hitY > waterSurfaceY` 时按水线（d≈0、无 caustics）处理。
  5. 深度差羽化与 0.25m/4m 是否共用参数：羽化本质是"水面与墙的屏幕空间过渡"，应先把 depthTexture 反算成**线性世界距离**再做羽化（固定世界宽度如 0.1~0.2m），不能在 NDC 深度差上用一个定值——那样浅水(0.25m)与深水(4m)在掠射角下羽化像素宽度不一致。

### P10【轻微】其它小项
- §6"`anisotropy = max`"与契约 A `{ anisotropy = 8 }` 不一致；且"metal 拉丝各向异性感"需要的是 `MeshPhysicalMaterial.anisotropy`（反射各向异性），与纹理的 `texture.anisotropy`（各向异性过滤）是两回事，文档里混用了同一词。→ 分开命名。
- `createSkyEquirect()` 返回的 equirect 纹理需显式 `mapping = EquirectangularReflectionMapping` 及正确 `colorSpace`，否则 `scene.background`/`scene.environment`/`fromEquirectangular` 显示或采样会错（PMREM 的 `_fromTexture` 依赖 mapping 区分 cube/equirect，`three.module.js:2859-2867`）。
- §4"灯光走 three 物理单位"未给出 intensity 数值，无法核对；物理单位下 DirectionalLight 与 PointLight 的 intensity 量纲不同（cd 与 cd/m²），建议给出具体强度并验收时实测过曝。

---

## 三、需求一致性（g）小结
- 设计整体确实服务于"宁静、美好、悠远 + 无任务自由探索"，闭环动线、雾、光柱、水面反射、明暗节奏都是对味的。没有发现"纯粹为炫技而炫技"的硬伤。
- **建议砍掉/替换的**：① §6"按房间克隆材质改 envMapIntensity"是性价比最低、且会产生接缝的一块（改法见 P7）；② 若 60fps 吃紧，优先把 GTAO 换成更便宜的 SSAO 或直接关闭（设计已把它列为第一个降级项，方向对）；③ 胶片颗粒（film grain）对"宁静"氛围是中性甚至略负面的，建议做成可关、默认弱。
- **值得保留的**：Bloom（电影级过曝正是 UE5 观感诉求）、caustics（池核符号，自动贴合池底是真亮点）、光柱+尘埃（"悠远"的关键）、水下后处理（沉浸感）。

---

## 四、必须修改点（Top 5）
1. **SMAA/OutputPass 顺序**：SMAA 必须在 OutputPass 之前（r185 运行于 linear-srgb），OutputPass 应为末位；把所有分级/颗粒/暗角/水下 PP 移到 OutputPass 前的线性域。
2. **GTAO 水面隔离**：GTAO 的 overrideMaterial 会把透明水面当不透明写深度，遮挡池底 AO；给 GTAOPass 传 `scene.clone(true)` 并隐藏水面/粒子/光柱。
3. **UnrealBloomPass 构造**：首参是 Vector2 resolution，改为 `new UnrealBloomPass(new Vector2(w,h), 0.35, 0.75, 0.85)` 并 resize 时 setSize。
4. **性能预算**：阴影每帧被 3~4 次 render() 重渲 + GTAO 第四次全场景 + ~20 前向灯，1080p@60fps 大概率守不住；`shadowMap.autoUpdate=false` 每帧渲一次阴影、反射/折射关 castShadow、点/聚光砍到个位数、碰撞用低模。
5. **水下状态闭环**：水下镜像相机需绕 y=0 翻转 + 裁剪面翻转；depth 反算钳制 `d=max(0, y_surface−y_hit)`，命中点 y>0 按水线处理，禁用 logarithmicDepthBuffer。

## 五、"写错 / 用法错"的 API 清单
- `UnrealBloomPass`：构造缺 resolution（Vector2），照文档字面写会导致参数错位/异常。
- `SMAAPass`：顺序错——必须置于 `OutputPass` 之前（r185 源码注释 + 运行于 linear-srgb）。
- `OutputPass`：非末位使用——其后放 LDR pass 会诱发 double tone map + double sRGB。
- `GTAOPass`：构造需 `(scene, camera, ...)`（文档未写全），且对透明水面语义错误（overrideMaterial 不透明化）。

（注：`AgXToneMapping`、`OutputPass`、`GTAOPass`、`SMAAPass`、`UnrealBloomPass`、`EffectComposer+HalfFloatType`、`PMREMGenerator.fromEquirectangular`、`scene.environmentIntensity/backgroundIntensity`、`SpotLight.map`、`Octree.fromGraphNode/capsuleIntersect`、`Capsule`、`mergeGeometries`、`WebGLRenderTarget.depthTexture`、`renderer.clippingPlanes/localClippingEnabled` 均为真实存在且语义与设计意图一致的 API，见第一节证据。）
