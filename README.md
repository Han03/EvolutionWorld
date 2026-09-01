# EvolutionWorld · 无缝世界网络游戏服务端（空壳版 · C++）

一个可扩展的 **空壳（Shell）网络游戏服务端 + 3D 客户端**：
HTTP 账号密码登录 → 进入**无缝世界**（SDF 体积地形）→ 实时操控角色移动/跳跃，内置**服务端权威 + 防作弊系统**，并预留了清晰的系统扩展框架。

> 当前为骨架/演示版本：核心系统已可运行，各玩法系统（战斗、任务、聊天、AI 行为树、持久化 DB 等）通过统一框架预留扩展位。

---
## 技术栈
- **服务端：C++17**，单线程 `epoll` 事件循环 + 手写 HTTP/WebSocket（RFC6455）协议层，无第三方框架依赖（仅链接 OpenSSL 用于 SHA-1/SHA-256）
- 客户端：Three.js r160（本地文件，离线可用）+ 自定义 GLSL（SDF 体积地形光线步进）
- 运行环境：Linux（g++ ≥ 9 / cmake ≥ 3.10），现代浏览器（WebGL 2）

---
## 快速开始

```bash
cd server
# 方式一：CMake
cmake -B build && cmake --build build -j
# 方式二：直接 make
make

# 启动（默认端口 3000；可用 EW_PORT 覆盖）
./evolution_server
# 或
EW_DEBUG=1 ./evolution_server          # 输出防作弊日志 + /api/debug/players
```

浏览器打开 `http://localhost:3000` → 输入账号密码 → 点「注册」自动注册并登录（或注册后点「登录」）→ 进入 3D 无缝世界。

**验证测试**（另开终端，需服务端运行中）：
```bash
python3 scripts/ws_smoke_test.py --normal     # 合法客户端：移动，应无回退
python3 scripts/ws_smoke_test.py --teleport   # 瞬移作弊：应收到回退并最终踢出
python3 scripts/ws_smoke_test.py --flood      # 高频轰炸：应被限频踢出
node scripts/prediction_test.mjs              # 预测轨迹 vs 服务端权威轨迹一致性
```

---
## 已实现功能

| 模块 | 说明 |
|---|---|
| **HTTP 登录** | `POST /api/register` / `POST /api/login`，SHA-256 加盐哈希，JSON 文件持久化（可换真实 DB） |
| **WebSocket 网关** | `/ws?token=xxx`，token 鉴权，welcome + 快照 + 输入 + correction/kick 消息 |
| **无缝世界** | 程序化无缝地形（确定性整数哈希噪声，服务端 C++ 与客户端 GLSL **逐位一致**） |
| **SDF 体积地形** | 客户端 GLSL 光线步进（raymarching）渲染：地表 + 体积云 + 大气透视 + 真实深度遮挡 |
| **可见范围加载** | 区块（Chunk）管理，只加载/模拟/广播玩家 **100 米**内的实体与数据 |
| **实体渲染** | 当前角色=橙色球 + 半透明白色描边；怪物=红色球；其他玩家=绿色球 + 昵称；NPC=蓝色球 |
| **基础物理** | 重力、地表碰撞（SDF 高度采样）、加速度/摩擦、跳跃（服务端权威） |
| **客户端预测** | 本地预测即时移动（零延迟），预测轨迹与服务端权威轨迹逐 tick 一致；服务端后校验不通过则下发 `correction` 回退 |
| **防作弊系统** | ① 客户端预测 + 服务端后校验/回退；② 随机采样校验 + 双轨迹校验（位移可达性 + 轨迹连续性）；③ 令牌桶限频（防高频瞬移包轰炸）+ 序号乱序/跳变校验；④ 不信任客户端时间戳，全部使用服务端时钟与序号，带网络容错阈值 |
| **操作** | WASD / 方向键移动、空格跳跃、鼠标拖拽旋转视角（第三人称跟随相机） |
| **AI 演示** | 怪物/NPC 在出生点附近随机游走（仅玩家视野内的实体被模拟） |

---
## 项目结构
```
EvolutionWorld/
├── client/                        # 3D 客户端（Three.js，本地自包含，无需 CDN）
│   ├── index.html                 # 登录页 + HUD
│   ├── css/style.css
│   ├── vendor/three.module.js     # 本地 Three.js r160
│   └── js/
│       ├── boot.js                # 入口：登录流程 + 主循环 + 预测/回退接线
│       ├── predict.js             # ★ 客户端预测器（与服务端物理/地形逐位一致）
│       ├── renderer.js            # Three.js 场景 / 相机 / 光照
│       ├── glsl.js                # SDF 体积地形着色器 + JS 版地形高度（预测用）
│       ├── entities.js            # 实体球体渲染 + 快照插值
│       ├── network.js             # HTTP 登录 + WebSocket + correction/kick 处理
│       └── input.js               # 键盘 / 鼠标输入
└── server/                        # ★ C++17 服务端
    ├── CMakeLists.txt / Makefile  # 两种构建方式
    ├── scripts/                   # 冒烟/防作弊/预测/浏览器验证脚本
    └── src/
        ├── main.cpp               # 入口：装配 + 配置环境变量覆盖 + 信号处理
        ├── config.h               # 全局配置（世界/物理/防作弊参数集中管理）
        ├── util/                  # json（自研解析/序列化）、base64、random
        ├── net/                   # epoll 事件循环 + HTTP + WebSocket(RFC6455)
        │   ├── server.h/cpp       # 单线程事件循环 / tick 调度 / 消息分发
        │   ├── http.h/cpp         # HTTP/1.1 解析与响应
        │   └── websocket.h/cpp    # WS 握手 / 帧编解码（掩码 / 分片）
        ├── auth/                  # 注册/登录/会话令牌（SHA-256 加盐）
        ├── game/                  # ★ 游戏逻辑（权威模拟）
        │   ├── world.h/cpp        # 实体注册表 / tick / 系统调度 / 快照
        │   ├── terrain.h/cpp      # 确定性噪声 + SDF 地形（与客户端逐位一致）
        │   ├── entity.h/cpp       # 实体（玩家/怪物/NPC）+ 扩展位
        │   ├── physics.h/cpp      # 简单物理：重力/碰撞/加速度/跳跃
        │   └── chunk.h/cpp        # 区块加载：100m 可见范围
        └── anticheat/             # ★ 防作弊系统
            └── anticheat.h/cpp    # 限频/序号/随机采样/轨迹校验/回退/踢出
```
（`server/data/users.json` 为运行时生成的账号数据，已被 .gitignore 忽略。）

---
## 如何扩展（扩展性设计）

服务端采用「**系统（System）+ 实体（Entity）**」框架，新增玩法无需改动既有代码：

### 1. 新增一个系统（如战斗）
在 `game/world.cpp` 中实现系统函数并在构造函数注册（按 priority 排序执行）：
```cpp
static void combatSystem(World& w, double dt) {
  for (auto& [id, e] : w.entitiesMut()) {
    if (e.kind != EntityKind::Monster || !e.active) continue;
    // ... 战斗逻辑；实体额外数据放在 e.data 中
  }
}
// 构造函数中：
addSystem(40, "combat", combatSystem);
```
### 2. 新增消息协议
在 `net/server.cpp` 的 `handleWsMessage` 中加一个 `type == "chat" / "skill" / "interact"` 分支即可；需要新下行消息时调用 `sendTo()`。
### 3. 实体类型扩展
在 `entity.h` 的 `EntityKind` 加枚举、`makeXxx()` 工厂，并在 `serialize()` 输出客户端可见字段；客户端在 `entities.js` 的 `STYLE` 中加对应颜色。
### 4. 区块/持久化扩展
`game/chunk.cpp` 的 `updatePlayerChunks` 已返回 `enter/exit` 区块列表，可在此挂载地块数据加载、AOI 网格、持久化存档。`auth/auth.cpp` 的用户存储为纯 JSON 文件，可无痛替换为 MySQL/Mongo/Redis。
### 5. 物理扩展
`game/physics.cpp` 已分阶段：重力 → 摩擦 → 积分 → 地表碰撞；可追加实体间碰撞、水域、传送门等阶段。
### 6. 防作弊扩展
`anticheat/anticheat.cpp` 的校验阶段清晰分离（限频 → 序号 → 随机采样/轨迹），可追加行为分析、客户端完整性校验、验证码等策略；所有阈值集中在 `config.h`。

---
## 网络协议
```
HTTP
  POST /api/register  {username, password}        -> { ok }
  POST /api/login     {username, password}        -> { ok, token, user, world{seed,viewRange,chunkSize,tickRate} }
  POST /api/logout    {token}                     -> { ok }
  GET  /api/health                                -> { ok, name, ts }
  GET  /api/debug/players                         -> 仅 EW_DEBUG=1

WebSocket  /ws?token=xxx   （JSON）
  S->C  { type:'welcome',  entityId, username, world, you }
  S->C  { type:'snapshot', tick, t, viewRange, count, entities:[{id,kind,x,y,z,username?}] }
  S->C  { type:'correction', reason, x, y, z }    # 服务端后校验不通过 → 回退
  S->C  { type:'kick',     reason }               # 累计违规/限频踢出
  S->C  { type:'error',    message }
  C->S  { type:'input', seq, moveX(-1..1), moveZ(-1..1), jump:bool,
          px, py, pz }                            # px/py/pz = 客户端预测位置（防作弊校验依据）
```
快照按**玩家可见范围（100m）**裁剪；空壳阶段为全量快照，后续可无缝升级为增量快照 / 状态同步。

---
## 防作弊设计（对应需求）

| 需求 | 实现 |
|---|---|
| 客户端预测保持流畅，服务端后校验不通过则退回 | 客户端 `predict.js` 本地即时预测（零延迟渲染），输入上报携带预测位置；服务端 `anticheat` 随机采样校验，不通过时下发 `correction`（含权威位置），客户端 `predictor.correction()` 硬回退 |
| 随机采样校验 | `sampleRatePct`（默认 30%）随机对输入做轨迹校验，避免固定模式被绕过 |
| 轨迹校验 | 检查 A：相对服务端权威位置的位移可达性（防瞬移）；检查 B：纵向可达性（跳跃/重力范围内）；检查 C：相邻两次上报的轨迹连续性 |
| 限制上报频率防高频瞬移包轰炸 | 令牌桶限频（`maxInputRatePerSec`/`burst`），持续超频累计到 `rateKickAfter` 直接踢出；`EW_DEBUG=1` 可观察日志 |
| 不信任客户端时间戳 | 所有时间用服务端单调时钟；乱序/跳变用 `seq` 仲裁（`seqReorderWindow`/`seqJumpWindow` 容错窗口） |
| 允许网络容错 | `teleportToleranceM`/`verticalToleranceM` 水平/纵向容错阈值 + `graceInputs` 出生豁免 + 长时间无输入自动重置令牌桶 |

配置集中 `config.h`，可用环境变量运行时覆盖（`EW_SAMPLE_PCT` / `EW_TOLERANCE` / `EW_MAX_RATE` / `EW_KICK_THRESHOLD` …）。

---
## 关键设计说明
- **地形一致性**：客户端 GLSL、客户端预测器（JS）、服务端（C++）使用**同一种确定性整数哈希噪声**（`hash2i → noise2 → fbm2 → terrainHeight`），三端逐位一致，保证渲染、预测、物理落在同一张地形上，角色不会陷地或悬空。
- **权威服务端 + 预测/回退**：所有位置/物理由服务端权威计算；客户端用相同算法本地预测，服务端后校验，不通过时回退到权威位置，在"流畅"与"公平"之间取得平衡。
- **体积感**：光线步进对地表高度场做球面追踪，沿射线叠加指数雾、云层、大气透视；通过 `gl_FragDepth` 写入真实深度，实体球体能被山体正确遮挡。
- **配置集中**：世界种子、可见范围、区块大小、物理参数、实体数量、防作弊阈值全部集中在 `server/src/config.h`。
- **构建可复现**：`make` 或 `cmake -B build` 均可；OpenSSL 仅用于 SHA 哈希与 WS 握手。

## License
MIT
