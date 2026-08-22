# impl-review2 — water.js / postfx.js 实现审查（three r185）

范围：仅 `src/water.js`、`src/postfx.js`。只读审查，12 分钟时间盒（覆盖必查点 a–g，未逐条深挖 caustics 纹理生成）。
核实基准：pnpm 安装的 `three@0.185.1`（`node_modules/three`），addons 取 `three/addons/objects/Reflector.js`、`postprocessing/{GTAOPass,SMAAPass,OutputPass}.js`。

结论：**需修订**（无崩溃级缺陷；有 3 条会造成可见画面错误 / 1 条一致性错误）。

---

## 一、核实通过、无需改动（先排除误报）

| 必查点 | 结论 | 证据 |
|---|---|---|
| a 斜近平面裁剪 | **逐行等价** Reflector 透视分支：`q.x/q.y` 用 `elements[8]/[0]`、`[9]/[5]`，`q.z=-1`，`q.w=(1+e10)/e14`，写回 `e2/e6/e10=z+1-clipBias/e14=w`；`clipBias=0.003` 与 Reflector 文档默认值一致，符号（`- clipBias`）正确 | Reflector.js:181-213（透视分支 186-213）；water.js:328-336 |
| a 镜像相机 | 用 `(camX,0,camZ)` 作共面点数学上等价于用面心（`p'=p-2dn`），`up.reflect`、`lookAt`、`projectionMatrix.copy` 顺序与 Reflector 一致；`uTextureMatrix` 在斜投影修改**前**构建，与 Reflector 相同（斜投影只改 z 行，不影响 UV） | Reflector.js:148-168；water.js:307-321 |
| b 折射 UV 尺寸自洽 | **自洽**。`gl_FragCoord/uResolution` 用的是归一化 UV，与 RT 分辨率无关；且 `renderer.setPixelRatio(1)` + `setSize(w,h,false)` 使 drawingBuffer==CSS 尺寸，`uResolution` 正确 | main.js:30,146；water.js:58,266 |
| b 深度语义 | **正确**。r185 vendor 无 reverse-depth 代码路径（`reverseDepth` 全库 0 命中），window depth ∈[0,1]，`rawDepth*2-1` 得 NDC z；`DepthFormat+FloatType` 映射到 `DEPTH_COMPONENT32F`，合法；RT 尺寸变化时 renderer 会自动同步 depthTexture 尺寸 | three.module.js:11287、12777-12781 |
| c uInvViewProj | **正确**。`P·V`（`multiplyMatrices(projectionMatrix, matrixWorldInverse)`）后 `.invert()`，顺序与逆运算都对；且在 Pass B 之后计算，此时 `camera.matrixWorldInverse` 已被 renderer 刷新 | water.js:358-359 |
| d NaN | **无 NaN 风险**。`NoV` 已 clamp 到 [0,1] → `pow(1-NoV,5)` 底数非负；`sqrt(max(0,·))`；`vReflectUV.w` 走 `max(w,1e-4)`；`length(d2)+1e-4` | water.js:76,87,120,127 |
| d 法线翻转一致性 | **一致**。`reflect` 对 ±n 结果相同 → 镜像相机两侧同一个；`below` 只改裁剪半空间（保留水下半场），与片元 `N=-N` 方向一致 | water.js:84,296,324-326 |
| f pass 顺序/参数 | 全部真实存在：`UnrealBloomPass(Vector2, strength, radius, threshold)` ✓；`GTAOPass(scene,camera,w,h,parameters,aoParameters)` 第 6 参就是 aoParameters，且 `radius/distanceExponent/thickness/scale/samples/screenSpaceRadius` 六个字段在 `updateGtaoMaterial` 内**逐个都有**分支 ✓；`GTAOPass.OUTPUT.Default=0` ✓；`SMAAPass` 在 r185 **确实是无参构造**且源码注释声明"输出 linear-srgb，必须在 OutputPass 之前" ✓ | GTAOPass.js:56、227-231、374-417、717-725；SMAAPass.js:15,30 |
| f 二次 tone map | **不会**。renderer 只在渲染到默认帧缓冲时启用 tone mapping（`material.toneMapped && currentRenderTarget===null`），Grade/SMAA 都渲到 composer RT → 不 tone map；OutputPass 用 **RawShaderMaterial**（无 prefix 注入），自己 defines 做 AgX → 只做一次 | three.module.js:7549-7559；OutputPass.js:63,97-114 |
| g 每帧分配 | **干净**。`renderTargets` 全部走 `this._tmp` 复用池，无 new Vector/Matrix/数组；`Vector3.reflect` 内部用静态临时量，不污染 `t.normal` | water.js:249-254,291-359 |

---

## 二、需要修的问题

### R1 [中-高] 反射矩阵用的是**上一帧**的相机变换 → 移动时反射"滑动/迟滞"
`src/water.js:296-321`（镜像相机与 `uTextureMatrix` 读 `camera.matrixWorld`/`matrixWorldInverse`）。
`renderTargets()` 在 `main.js:225` 于 composer 之前调用，而 main.js 全程没有 `camera.updateMatrixWorld()`；相机的 `matrixWorld` 只会在 Pass B 的 `renderer.render(scene, camera)` 内部才被刷新（water.js:352）。官方 Reflector 是在 `onBeforeRender` 里做的，那时矩阵必然已更新（Reflector.js:121）。后果：本帧 `uTextureMatrix` 用旧相机、`uInvViewProj`（water.js:358，在 Pass B 之后）用新相机 → 反射贴图与水面像素错位一帧、且反射/折射两套投影不同源，快速转身时反射整体平移。
**改法**：`renderTargets()` 第一行加 `camera.updateMatrixWorld();`（幂等、无开销）。

### R2 [中] 水面雾与场景雾用的深度不同量 → 远处水墙交界出现雾色断层
`src/water.js:160`：`f = 1 - exp(-pow(distCam*uFogDensity,2))`，其中 `distCam` 是**欧氏距离**（water.js:98）；three 的 FogExp2 用的是 `vFogDepth = -mvPosition.z`，即**视空间 z**（three.module.js:371）。屏幕边缘两者差 `1/cos(θ)`（90° FOV 角落约 1.3×）→ 同一距离的水面比墙面更雾，走廊尽头水线处可见接缝。
**改法**：顶点里加 `varying float vViewZ; vViewZ = -(viewMatrix*wp).z;`，片元雾改用 `vViewZ` 而非 `distCam`（distCam 仍可留给扰动衰减）。

### R3 [中] 折射深度取自 0.6× RT，用主画布 UV 最近邻采样 → 物体轮廓处吸收/caustics 有 1~2px 错边
`src/water.js:90-95`（`texture2D(tRefractDepth, screenUV)`，DepthTexture 默认 NearestFilter）。深度是 0.6× 分辨率，`screenUV` 是全分辨率像素中心 → 池底与水上墙的剪影边缘会拿到隔壁几何的深度，`path` 突变，表现为轮廓边一圈亮/暗描边（同一处 `underMask` 的 ±0.04 软化不覆盖 xy 方向错位）。
**改法**：把深度采样对齐到 RT 像素中心（传入 `uRefractResolution`，`uv = (floor(screenUV*rt)+0.5)/rt`），或让折射 RT 与主 RT 同分辨率只降色彩分辨率。

### R4 [中] GTAO 用无水面场景 → 池底 AO 会**穿过水面**乘到水面像素上（含反射/高光）
`src/postfx.js:75-86`。GTAO 是屏幕空间乘性合成（`OUTPUT.Default`，`blendMaterial` 用 `DstColorFactor` 相乘，GTAOPass.js:205-215），深度/法线来自 aoScene（无水面）→ 水面像素拿到的是其**背后池底墙角**的 AO，把已经混好的反射色和太阳高光一起压暗；即注释想避免的"水面假暗角"换了个形式仍然存在（墙脚水面一圈暗带）。
**改法**：把水面写进 aoScene 的深度（`GTAOPass.setGBuffer` 传自建深度）或让水面 mesh 在 AO 场景里以 `MeshDepthMaterial` 占位；最省事的临时手段是把 `blendIntensity` 降到 ~0.5 并靠 `setSceneClipBox` 收紧范围。**存疑**：严重程度取决于池壁夹角实际暗度，需截图确认。

### R5 [低-中] Grade 的颗粒/色散在 SMAA **之前** → 颗粒被当成边缘，AA 空转且颗粒被抹
`src/postfx.js:62-63, 91-95`。`uGrain=0.010` 的高频噪声进入 SMAA 边缘检测（阈值按 LDR 调的，HDR 线性域下本就偏钝），既让 SMAA 误判边缘、也让颗粒被 blend 掉。
**改法**：把 grain（和暗角）拆成 OutputPass 之后的独立小 pass，或把 Grade 挪到 SMAA 之后（仅保留线性域的曝光/染色在 SMAA 前）。

### R6 [低] `bottom.xz` 无 clamp：正式路径被 `depthFade` 兜住，调试路径没兜住
`src/water.js:111-116` 与 `150-153`。正式分支里 `caus` 乘了 `depthFade = smoothstep(0.02,0.35,path)*exp(-path*0.22)`，远处/掠射（path 大或 underMask=0 → path=0）都会衰减到 0，**天文数值不会进画面**；但 `uDebug==4` 分支（150-153）完全没有 `depthFade`/`underMask` 门控，远处会出现 cuv 巨大导致的摩尔纹+精度抖动；另外掠射时 `cuv` 的屏幕导数很大，caustic 贴图若无 mipmap 会闪烁。
**改法**：调试分支复用 `underMask*depthFade`；并给 `cuv` 加 `clamp(bottom.xz, vWorld.xz-60.0, vWorld.xz+60.0)`。

### R7 [低] 水下看水面几乎无折射扭曲（分支互斥导致的功能空转）
`src/water.js:94-99`。水下抬头时反算命中点在水面之上 → `underMask=0 → path=0 → distort=0`，水面变成一块平玻璃；同时 `if (b2.y>0.06 && uSubmerged<0.5)` 的掩膜在水下被关掉，等于水下完全没有扰动逻辑。
**改法**：水下时用固定扰动幅度（如 `0.02*N.xz`）替代 `min(path,3.5)` 项。

### R8 [低] `setQuality` 的 level 1/2 对 bloom 无区别、且不恢复 GTAO 之外的开销
`src/postfx.js:108-112`：`level>=1 ? 0.34 : 0.22`，level 2 与 1 的 bloom 完全相同，注释里"1=关 GTAO"成立但降档几乎不省 GPU（bloom 全分辨率 mip 链仍在跑）。
**改法**：level<=1 时同时 `this.smaa.enabled=false` 或把 bloom 强度/`resolution` 一起下调。

---

## 三、附：Pass A/B 的两点提醒（非缺陷）
- Pass A 使用被斜投影污染的 `rc.projectionMatrix` 而 `rc.projectionMatrixInverse` 未同步——与官方 Reflector 行为一致，仅在有材质读 `projectionMatrixInverse` 时才有影响，当前链路无此依赖。
- `renderer.clear()` 在 `autoClear=true` 下是冗余调用（每 pass 多一次 clear），可删，收益极小。
