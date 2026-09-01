# EvolutionWorld · 无缝世界网络游戏服务端（空壳版）

一个可扩展的 **空壳（Shell）网络游戏服务端 + 3D 客户端**：
HTTP 账号密码登录 → 进入**无缝世界**（SDF 体积地形）→ 实时操控角色移动/跳跃，并预留了清晰的系统扩展框架。

> 当前为骨架/演示版本：核心系统已可运行，各玩法系统（战斗、任务、聊天、AI 行为树、持久化 DB 等）通过统一框架预留扩展位。

---

## 快速开始

```bash
# 1. 安装依赖（仅 express + ws，无需构建）
npm install

# 2. 启动服务端
npm start
# 或开发模式自动重启
npm run dev

# 3. 浏览器打开（默认端口 3000）
#    http://localhost:3000
```

浏览器打开后：输入账号密码 → 点「注册」自动注册并登录，或注册后点「登录」→ 进入 3D 无缝世界。

**验证测试**（另开终端）：
```bash
npm run test:api        # WebSocket 网关冒烟测试（注册→登录→连接→快照）
```

---

## 已实现功能

| 模块 | 说明 |
|---|---|
| **HTTP 登录** | `POST /api/register` / `POST /api/login`，密码 scrypt 加盐哈希，JSON 文件持久化（可换真实 DB） |
| **WebSocket 网关** | `/ws?token=xxx`，token 鉴权，welcome + 快照 + 输入消息 |
| **无缝世界** | 程序化无缝地形（确定性噪声，服务端与客户端算法逐位一致） |
| **SDF 体积地形** | 客户端 GLSL 光线步进（raymarching）渲染：地表 + 体积云 + 大气透视 + 真实深度遮挡 |
| **可见范围加载** | 区块（Chunk）管理，只加载/模拟/广播玩家**100 米**内的实体与数据 |
| **实体渲染** | 当前角色=橙色球 + 半透明白色描边；怪物=红色球；其他玩家=绿色球 + 昵称；NPC=蓝色球 |
| **基础物理** | 重力、地表碰撞（SDF 高度采样）、加速度/摩擦、跳跃 |
| **操作** | WASD / 方向键移动、空格跳跃、鼠标拖拽旋转视角（第三人称跟随相机） |
| **AI 演示** | 怪物/NPC 在出生点附近随机游走（仅玩家视野内的实体被模拟） |

---

## 项目结构

```
EvolutionWorld/
├── package.json
├── client/                        # 3D 客户端（Three.js，本地自包含，无需 CDN）
│   ├── index.html                 # 登录页 + HUD
│   ├── css/style.css
│   ├── vendor/three.module.js     # 本地 Three.js r160
│   └── js/
│       ├── boot.js                # 入口：登录流程 + 主循环
│       ├── renderer.js            # Three.js 场景 / 相机 / 光照
│       ├── glsl.js                # SDF 体积地形着色器（与服务端地形逐位一致）
│       ├── entities.js            # 实体球体渲染 + 快照插值
│       ├── network.js             # HTTP 登录 + WebSocket 客户端
│       └── input.js               # 键盘 / 鼠标输入
└── server/src/
    ├── index.js                   # 服务端入口（装配所有模块）
    ├── config.js                  # 全局配置（世界种子/可见范围/物理参数…）
    ├── core/
    │   └── world-manager.js       # 世界核心：实体注册表 / tick 循环 / 系统调度 / 快照
    ├── net/
    │   ├── http-api.js            # HTTP 网关（注册/登录/静态资源）
    │   └── ws-api.js              # WebSocket 网关（鉴权/输入/快照广播）
    ├── auth/
    │   ├── auth-service.js        # 注册/登录/会话令牌
    │   └── user-store.js          # 用户存储（JSON，可替换 DB）
    ├── world/
    │   ├── terrain.js             # 确定性噪声 + SDF 地形（服务端权威物理）
    │   └── chunk-manager.js       # 区块加载：100m 可见范围
    ├── entities/
    │   ├── entity.js              # 实体基类（预留 data/ai/display 扩展位）
    │   ├── player.js  monster.js  npc.js
    ├── physics/
    │   └── physics-world.js       # 简单物理：重力/碰撞/加速度/跳跃
    ├── systems/                   # ★ 可扩展系统框架 ★
    │   ├── base-system.js         # 系统基类（update/onEvent/priority）
    │   ├── input-system.js        # 输入 → 移动意图
    │   ├── move-system.js         # 移动 + 物理积分
    │   └── ai-system.js           # 怪物/NPC 简单游走 AI
    ├── scripts/ws-smoke-test.mjs  # 自包含冒烟测试
    └── data/                      # 运行时生成：users.json（已被 .gitignore 忽略）
```

---

## 如何扩展（扩展性设计）

服务端采用「**系统（System）+ 实体（Entity）+ 事件（Event）**」的 ECS 风格框架，新增玩法不需要改动既有代码：

### 1. 新增一个系统（如战斗）

```js
// server/src/systems/combat-system.js
import { BaseSystem } from './base-system.js';

export class CombatSystem extends BaseSystem {
  constructor(world, config) {
    super(world, config);
    this.priority = 40; // 执行顺序，越小越先
  }
  update(dt) {
    // 遍历实体做战斗逻辑；实体额外数据放在 e.data 中
  }
  onEvent(name, payload) {
    // 可订阅 world.emit 的事件，如 'chunk-change'
  }
}
```

然后在 `world-manager.js` 的 `createDefaultSystems()` 中注册：

```js
this.addSystem(new CombatSystem(this, this.config));
```

### 2. 新增消息协议

在 `ws-api.js` 的 `handleMessage` switch 中加一个 `case 'chat'` / `'skill'` / `'interact'` 即可。

### 3. 实体类型扩展

继承 `Entity`，覆写 `serializeExtra()` 返回客户端可见字段；客户端在 `entities.js` 的 `STYLE` 中加对应颜色。

### 4. 区块/持久化扩展

`chunk-manager.js` 已预留 `enter/exit` 事件（`world.emit('chunk-change')`），可在此挂载地块数据加载、AOI 网格、持久化存档。用户存储 `user-store.js` 为纯接口，可无痛替换为 MySQL/Mongo/Redis。

### 5. 物理扩展

`physics-world.js` 已分阶段：重力 → 摩擦 → 积分 → 地表碰撞；可追加实体间碰撞、水域、传送门等阶段。

---

## 网络协议

```
HTTP
  POST /api/register  {username, password}        -> { ok }
  POST /api/login     {username, password}        -> { ok, token, user, world{seed,viewRange,...} }

WebSocket  /ws?token=xxx   （JSON）
  S->C  { type:'welcome', entityId, username, world, you }
  S->C  { type:'snapshot', tick, t, viewRange, count, entities:[{id,kind,x,y,z,username?}] }
  S->C  { type:'error', message }
  C->S  { type:'input', seq, moveX(-1..1), moveZ(-1..1), jump:bool }
```

快照按**玩家可见范围（100m）**裁剪；空壳阶段为全量快照，后续可无缝升级为增量快照 / 状态同步。

---

## 关键设计说明

- **地形一致性**：客户端 GLSL 与服务端 JS 使用**同一种确定性整数哈希噪声**（`hash2i → noise2 → fbm2 → terrainHeight`），保证渲染地形与物理高度完全一致，角色不会陷地或悬空。
- **体积感**：光线步进对地表高度场做球面追踪，沿射线叠加指数雾、云层、大气透视，实现 SDF 体积地形效果；通过 `gl_FragDepth` 写入真实深度，实体球体能被山体正确遮挡。
- **权威服务端**：所有位置/物理由服务端权威计算，客户端仅做插值渲染，为后续防作弊、状态同步打好基础。
- **配置集中**：世界种子、可见范围、区块大小、物理参数、实体数量等全部集中在 `server/src/config.js`。

---

## 技术栈

- 服务端：Node.js（ESM）+ Express + ws，无构建步骤
- 客户端：Three.js r160（本地文件，离线可用）+ 自定义 GLSL
- 运行环境：Node >= 18，现代浏览器（WebGL 2）

## License

MIT
