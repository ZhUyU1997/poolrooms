# Poolrooms — 网页版池核第一人称探索

无 UI、无任务，只有一片安静的瓷砖泳池空间。纯静态站点，**完全离线运行**（three.js 已本地化，
所有贴图与声音都是运行时程序化生成的，零外部请求）。

## 运行

双击 `start-poolrooms.bat`（会起一个本机静态服务器并打开 Chrome）。
手动方式：

```
node tools\serve.mjs 8123
# 然后浏览器打开 http://127.0.0.1:8123/
```

停止：关掉那个最小化的 `poolrooms-server` 窗口即可（没有后台常驻服务）。

## 操作

| 键 | 作用 |
|---|---|
| 鼠标 | 视角（点击画面进入，`Esc` 释放鼠标） |
| W A S D / 方向键 | 移动 |
| Shift | 快走 |
| Space | 跳 / 水中上浮 |
| Ctrl 或 C | 水中下潜 |

进入后画面上**没有任何界面元素**（无准星、无 HUD、无菜单）。首屏那行"点击进入"是浏览器的硬性要求
（指针锁定与音频必须由用户手势触发），进入后会淡出。

## 地图（七区闭环，明暗有节奏）

```
        露台(露天·最亮)
             │
        柱廊(高窗光刀)
             │        └── 下潜阶梯 ── 潜水隧道(最暗) ── 深井厅(一道光刃·可游泳)
        中庭主池(出生)                                        │
             └────────── 回廊 ── 更衣角(暖黄·最小) ──────────┘
```

亮 → 更亮 → 最亮 → 渐暗 → 最暗 → 幽深 → 暖暗 → 回到亮。走一圈不会走进死胡同。

## 目录

```
index.html              importmap + canvas（唯一的 DOM）
start-poolrooms.bat     启动器（ASCII/CRLF）
src/main.js             引导、渲染编排、自适应画质、生命周期
src/level.js            七区几何、开洞、水域表、灯光、光柱、GI 分区
src/materials.js        材质库 + 世界空间 GI 场（onBeforeCompile 注入）
src/textures.js         程序化 PBR 贴图（纯 TypedArray，无 canvas）
src/water.js            水面：平面反射 + 折射 + 吸收 + caustics + 水下
src/volumetrics.js      体积光柱 + 尘埃
src/postfx.js           GTAO / Bloom / 调色 / SMAA / OutputPass
src/player.js           胶囊碰撞、涉水、游泳、镜头呼吸与步伐
src/audio.js            程序化音景（水声/滴水/脚步/混响，无素材）
vendor/three/           three.js 0.185.1（build + addons 子集）
tools/                  测试与画面诊断工具（见 DESIGN.md §13.3）
DESIGN.md               设计文档 + 修订记录
```

## 调参（URL 参数，不用改代码）

`http://127.0.0.1:8123/?sun=9&env=0.18&exp=0.95&tm=aces&hemi=0.85`

| 参数 | 默认 | 说明 |
|---|---|---|
| `sun` | 9 | 太阳强度 |
| `env` | 0.18 | 天光 IBL 强度（室内补光） |
| `hemi` | 0.85 | 半球光（伪反弹光）强度 |
| `exp` | 0.95 | 曝光 |
| `tm` | aces | 色调映射：`aces` / `agx` / `neutral` |
| `shadow` | 4096 | 阴影贴图边长 |
| `noao` | - | 带上则关闭 GTAO |
| `cam=x,y,z&look=yaw,pitch` | - | 冻结相机到指定位姿（截图/调试用） |
| `wdebug` | 0 | 水面分量：1 反射 / 2 折射 / 3 水中行程 / 4 caustics / 5 法线 |

## 自测

```
node tools\test-textures.mjs   # 贴图：平铺性/法线/动态范围/耗时
node tools\test-audio.mjs      # 音频：幂等/节点不泄漏/IR 正确
node tools\test-level.mjs      # 关卡：开口/门洞/地面/水域/天空方位/净高
node tools\test-walk.mjs       # 真实物理走完七区闭环（26 航路点）
```

## 性能

目标 1080p 60fps（RTX 3060 Laptop）。每帧 3 次场景渲染（反射 0.5× / 折射 0.6× / 主渲染）
+ 1 次阴影（复用）。帧率不足时自动按序降级：分辨率 1.0→0.62 → 关 GTAO → 弱化 bloom。

## 卸载

删掉 `D:\dsh-home\poolrooms\` 整个目录即可，不写注册表、不装服务、不留后台进程。
