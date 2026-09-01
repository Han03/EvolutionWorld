# EvolutionWorld · 无缝世界网络游戏服务端（空壳版 · C++）

一个可扩展的 **空壳（Shell）网络游戏服务端 + 网页测试客户端**：
HTTP 账号密码登录 → 进入**固定俯视角无缝世界**（高度场地形）→ 实时操控角色移动/跳跃，内置
**服务端权威 + 防作弊系统** 与 **大型网游规模的数据传输方案**，并预留了清晰的系统扩展框架。

> 当前为骨架/演示版本：核心系统已可运行，各玩法系统（世界 Boss、战斗、任务、聊天、持久化 DB 等）
> 通过统一框架预留扩展位。

---

## 技术栈
- **服务端：C++17**，单线程 `epoll` 事件循环 + 手写 HTTP/WebSocket（RFC6455）协议层，无第三方框架依赖（仅链接 OpenSSL 用于 SHA-1/SHA-256）
- **客户端：Canvas 2D（零依赖）**，固定俯视角渲染，无需 WebGL/Three.js，任何现代浏览器可用
- **数据传输：自定义二进制协议**（帧头 + 量化坐标 + 增量/LOD/校准快照），带宽比 JSON 省 4-6 倍
- 运行环境：Linux（g++ ≥ 9 / cmake ≥ 3.10），现代浏览器

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
EW_DEBUG=1 ./evolution_server          # 输出防作弊日志 + /api/debug/players + /api/terrain/chunk
```
浏览器打开 `http://localhost:3000` → 输入账号密码 → 点「注册」自动注册并登录（或注册后点「登录」）→ 进入俯视角无缝世界。

**验证测试**（另开终端，需服务端运行中）：
```bash
python3 scripts/ws_smoke_test.py --normal     # 合法客户端：移动，应无回退
python3 scripts/ws_smoke_test.py --teleport   # 瞬移作弊：应收到回退并最终踢出
python3 scripts/ws_smoke_test.py --flood      # 高频轰炸：应被限频踢出
python3 scripts/ws_smoke_test.py --jump       # 跳跃：高度场碰撞与预测一致
node scripts/prediction_test.mjs              # 预测轨迹 vs 服务端权威轨迹一致性
```

---

## 已实现功能
| 模块 | 说明 |
|---|---|
| **HTTP 登录** | `POST /api/register` / `POST /api/login`，SHA-256 加盐哈希，JSON 文件持久化（可换真实 DB） |
| **WebSocket 网关** | `/ws?token=xxx`，token 鉴权，二进制协议帧 |
| **无缝世界** | 程序化无缝高度场地形（确定性整数哈希噪声，服务端 C++ 与客户端 JS **逐位一致**） |
| **固定俯视角渲染** | Canvas 2D 高度场网格地形（离屏预渲染区块 + 可见范围流式加载）+ 水面/湖泊 + 实体圆球投影，**无需 WebGL** |
| **高度场数据存储** | 服务端按区块缓存 33×33 高度网格（世界地图数据存储层），`/api/terrain/chunk?x=&z=` 提供数据接口 |
| **高度场碰撞** | 客户端预测器与服务端物理使用**同一 `terrainHeight(x,z)` 连续高度场**（已验证 4.5e-5m 精度一致） |
| **可见范围加载** | 区块（Chunk）管理，只加载/模拟/广播玩家 **100 米**内的实体与数据 |
| **实体渲染** | 当前角色=橙色球 + 半透明白色描边；怪物=红色球；其他玩家=绿色球 + 昵称；NPC=蓝色球 |
| **基础物理** | 重力、高度场地表碰撞、加速度/摩擦、跳跃（服务端权威） |
| **客户端预测** | 本地预测即时移动（零延迟），服务端后校验不通过则下发 `SELF` 回退 |
| **防作弊系统** | ① 客户端预测 + 服务端后校验/回退；② 随机采样校验 + 轨迹校验；③ 令牌桶限频 + 序号仲裁；④ 不信任客户端时间戳，带网络容错 |
| **操作** | WASD / 方向键移动、空格跳跃（固定俯视角，无自由镜头） |
| **AI 演示** | 怪物/NPC 在出生点附近随机游走（仅玩家视野内的实体被模拟） |

---

## 大型网游数据传输方案（二进制协议）
```
帧结构：magic('EW'|2) + version(1) + type(1) + flags(1) + seq(2) + len(2) + payload
坐标量化：位置 0.01m；AOI 内实体以接收玩家位置为基准 int16 相对编码（±327.6m）；速度 0.01m/s；move 输入 -1000..1000
```
### 生命周期消息（S2C）
| 消息 | 作用 |
|---|---|
| `HELLO`(0x81) | 握手：世界种子 / 视野 / 区块 / 自身绝对位置 |
| `SNAPSHOT`(0x82) | 周期校准全量快照（自愈，默认 1.5s 一次） |
| `ENTER`(0x83) / `LEAVE`(0x84) | AOI 进出（显式生命周期） |
| `UPDATE`(0x85) | 增量更新（mask 位图 + 量化相对坐标） |
| `SELF`(0x86) | 预测回退校正（服务端权威位置） |
| `EVENT`(0x87) / `PING`(0x88) / `KICK`(0x89) / `ERROR`(0x8A) | 事件 / 心跳 / 踢出 / 错误 |
### 上行消息（C2S）
| 消息 | 作用 |
|---|---|
| `INPUT`(0x01) | 输入 + 预测位置（防作弊校验依据），20Hz |
| `EVENT`(0x02) / `PONG`(0x03) | 事件 / 心跳 |
### AOI + 增量 + LOD
- **AOI 空间网格**（`aoi.cpp`，cell 25m）+ 距离过滤：只向玩家广播其兴趣集内实体
- **LOD 分级**：近 25m 每 tick、中 50m 每 2 tick、远每 4 tick 更新
- **带宽观测**：`EW_NETDBG=1` 输出每玩家带宽日志；客户端右下角「协议透传」面板实时显示解码后的每一帧（二进制 ↔ 可读对象）

---

## 项目结构
```
EvolutionWorld/
├── client/                        # 网页测试客户端（Canvas 2D，零依赖）
│   ├── index.html                 # 登录页 + HUD + 协议透传监控面板
│   ├── css/style.css
│   └── js/
│       ├── boot.js                # 入口：登录流程 + 主循环 + 预测/回退接线 + 协议透传展示
│       ├── predict.js             # ★ 客户端预测器（与服务端物理/地形逐位一致）
│       ├── terrain.js             # ★ 高度场地形数据（与服务端 terrain.cpp 逐位一致）
│       ├── renderer.js            # Canvas 2D 俯视角渲染：区块地形 + 水面 + 实体圆球
│       ├── entities.js            # 实体数据管理（ENTER/LEAVE/UPDATE/SNAPSHOT + 插值）
│       ├── protocol.js            # ★ 二进制协议编解码（与 C++ 逐位对应，透传转换层）
│       ├── network.js             # HTTP 登录 + 二进制 WS + 协议解码分发
│       └── input.js               # 键盘输入（WASD/方向键 + 空格跳跃）
└── server/                        # ★ C++17 服务端
    ├── CMakeLists.txt / Makefile
    ├── scripts/                   # 冒烟/防作弊/预测/浏览器验证脚本
    └── src/
        ├── main.cpp               # 入口：装配 + 配置环境变量覆盖 + 信号处理
        ├── config.h               # 全局配置（世界/物理/防作弊/AOI 参数集中管理）
        ├── util/                  # json（自研）、base64、random
        ├── net/                   # epoll 事件循环 + HTTP + WebSocket + 二进制协议
        │   ├── server.h/cpp       # 事件循环 / tick 调度 / handleBinary / 带宽日志
        │   ├── http.h/cpp / websocket.h/cpp
        │   ├── protocol.h/cpp     # ★ 二进制帧/量化/编解码
        │   └── ...
        ├── auth/                  # 注册/登录/会话令牌（SHA-256 加盐）
        ├── anticheat/             # ★ 防作弊：限频/序号/随机采样/轨迹/回退/踢出
        └── game/                  # ★ 游戏逻辑（权威模拟）
            ├── world.h/cpp        # 实体注册表 / tick / 系统调度 / 快照
            ├── terrain.h/cpp      # 确定性噪声 + 高度场（与客户端逐位一致）
            ├── entity.h/cpp       # 实体（玩家/怪物/NPC）+ 扩展位
            ├── physics.h/cpp      # 重力/高度场碰撞/加速度/跳跃
            ├── chunk.h/cpp        # 区块加载 + ★ 高度场数据存储
            ├── aoi.h/cpp          # ★ AOI 空间网格
            └── netcode.h/cpp      # ★ 每玩家兴趣集 + 增量/LOD/校准快照
```
（`server/data/users.json` 为运行时生成的账号数据，已被 .gitignore 忽略。）

---

## 如何扩展（扩展性设计）
服务端采用「**系统（System）+ 实体（Entity）**」框架，新增玩法无需改动既有代码：
### 1. 新增一个系统（如战斗）
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
`net/server.cpp` 的 `handleBinary` 加一个 `C2S_*` 分支；`net/protocol.h/cpp` 定义帧类型与编解码；
`client/js/protocol.js` 加对应解码；`client/js/network.js` 加回调。
### 3. 实体类型扩展
`entity.h` 的 `EntityKind` 加枚举、`makeXxx()` 工厂，并在协议层输出客户端可见字段；客户端在 `entities.js` 加对应样式。
### 4. 区块/持久化扩展
`chunk.cpp` 的 `updatePlayerChunks` 已返回 `enter/exit` 区块列表，可挂载地块数据加载、AOI、持久化存档；
高度场数据存储层（`ChunkTerrainData`）已就绪，可序列化到磁盘/DB。
### 5. 防作弊扩展
`anticheat.cpp` 校验阶段清晰分离（限频 → 序号 → 随机采样/轨迹），可追加行为分析、客户端完整性校验等。

---

## 网络协议（二进制）
```
HTTP
  POST /api/register  {username, password}        -> { ok }
  POST /api/login     {username, password}        -> { ok, token, user, world{seed,viewRange,chunkSize,tickRate} }
  POST /api/logout    {token}                     -> { ok }
  GET  /api/health                                -> { ok, name, ts }
  GET  /api/debug/players                         -> 仅 EW_DEBUG=1
  GET  /api/terrain/chunk?x=&z=                   -> 高度场区块数据（grid/step/heights/waterLevel）
WebSocket  /ws?token=xxx   （二进制，见上文帧结构）
```

---

## 防作弊设计（对应需求）
| 需求 | 实现 |
|---|---|
| 客户端预测保持流畅，服务端后校验不通过则退回 | 客户端 `predict.js` 本地即时预测，输入上报携带预测位置；服务端 `anticheat` 随机采样校验，不通过时下发 `SELF` 回退 |
| 随机采样校验 | `sampleRatePct`（默认 30%）随机对输入做轨迹校验 |
| 轨迹校验 | 位移可达性（防瞬移）+ 纵向可达性（跳跃/重力）+ 相邻上报轨迹连续性 |
| 限制上报频率防高频瞬移包轰炸 | 令牌桶限频（`maxInputRatePerSec`/`burst`），持续超频踢出 |
| 不信任客户端时间戳 | 所有时间用服务端单调时钟；乱序/跳变用 `seq` 仲裁（容错窗口） |
| 允许网络容错 | `teleportToleranceM`/`verticalToleranceM` 容错阈值 + `graceInputs` 出生豁免 + 无输入自动重置令牌桶 |
配置集中 `config.h`，可用环境变量运行时覆盖（`EW_SAMPLE_PCT` / `EW_TOLERANCE` / `EW_MAX_RATE` / `EW_KICK_THRESHOLD` …）。

---

## 关键设计说明
- **地形一致性**：客户端 `terrain.js`、客户端预测器（`predict.js`）、服务端（`terrain.cpp`）使用**同一种确定性整数哈希噪声**（`hash2i → noise2 → fbm2 → terrainHeight`），三端逐位一致（实测高度场 4356 采样点误差 ≤ 4.5e-5m），保证渲染、预测、物理落在同一张地形上。
- **权威服务端 + 预测/回退**：所有位置/物理由服务端权威计算；客户端用相同算法本地预测，服务端后校验，不通过时回退到权威位置，在"流畅"与"公平"之间取得平衡。
- **大型网游传输**：二进制帧 + 量化坐标 + AOI 兴趣集 + 增量/LOD/校准快照，兼顾带宽、流畅与自愈。
- **配置集中**：世界种子、可见范围、区块大小、物理参数、实体数量、防作弊阈值、AOI 参数全部集中在 `server/src/config.h`。
## License
MIT
