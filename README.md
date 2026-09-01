# EvolutionWorld · 无缝世界网络游戏服务端（空壳版 · C++）

一个可扩展的 **空壳（Shell）网络游戏服务端 + 网页测试客户端**：
HTTP 账号密码登录 → 进入**固定俯视角无缝世界**（高度场地形）→ 实时操控角色移动/跳跃，内置
**服务端权威 + 防作弊系统**、**大型网游规模的数据传输方案**、**世界怪物/Boss 状态共享**、
**生物/NPC/Boss AI 整体框架**、**MySQL+Redis 存储**，以及**物品/属性/商店/配置四系统**，
并预留了清晰的系统扩展框架。

> 当前为可运行演示版本：核心系统 + 世界 Boss + 大规模 AI + 物品经济 + 存储已落地；任务、聊天、
> 副本等玩法系统通过统一框架预留扩展位。

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
# 启用外部存储（可选；不设置则纯内存模式，功能不受影响）
EW_DB_MYSQL=127.0.0.1:3306 EW_DB_MYSQL_USER=root EW_DB_MYSQL_PASS=secret EW_DB_MYSQL_DB=evolutionworld \
EW_DB_REDIS=127.0.0.1:6379 ./evolution_server
```
浏览器打开 `http://localhost:3000` → 输入账号密码 → 点「注册」自动注册并登录（或注册后点「登录」）→ 进入俯视角无缝世界。

**验证测试**（另开终端，需服务端运行中）：
```bash
python3 scripts/ws_smoke_test.py --normal     # 合法客户端：移动，应无回退
python3 scripts/ws_smoke_test.py --teleport   # 瞬移作弊：应收到回退并最终踢出
python3 scripts/ws_smoke_test.py --flood      # 高频轰炸：应被限频踢出
python3 scripts/ws_smoke_test.py --jump       # 跳跃：高度场碰撞与预测一致
python3 scripts/ws_smoke_test.py --boss       # 世界 Boss 共享状态（攻击/死亡/复活/新客户端一致）
node scripts/prediction_test.mjs              # 预测轨迹 vs 服务端权威轨迹一致性
node scripts/ai_behavior_test.mjs             # AI 行为：怪物/Boss 入仇、追击、攻击
node scripts/ai_behavior_test.mjs             # AI 行为：怪物/Boss 入仇、追击、攻击
node scripts/items_test.mjs                   # 物品/属性/商店端到端：掉落/拾取/购买/穿戴/使用（16/16）

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
| **世界怪物/Boss 状态共享** | 3 只全区共享世界 Boss（荒原巨兽/深渊领主/冰霜女王），服务端单点权威：HP/仇恨/阶段/生死，`S2C_BOSS` 全局广播（dirty 去重）+ 加入即一致的 HELLO 帧 + 共享事件队列（伤害/死亡/复活/技能，全区每 tick 广播） |
| **生物/NPC/Boss AI 框架** | `ai.h/cpp` 状态机（8 态）+ 大规模调度：AOI 激活、时间片轮转、距离分级（LOD）；怪物入仇/追击/近战/脱战回巢/巡逻；NPC 低频游走（预留交互态）；Boss 脱战回血/仇恨侦测/阶段切换(≤65%/≤35%)/追击/普攻/AOE 技能/死亡复活 |
| **物品系统** | 装备/消耗品/任务道具三类物品，`ItemDef` 按 ID 管理（名称/描述/缩略图/类型/穿戴属性）；怪物死亡随机掉落物品 + 金币（金币也是物品，`itemId=0`）；地面掉落物 60s 过期，2m 拾取 |
| **属性系统** | 玩家/怪物/ Boss 血量、蓝量、攻击力、防御力；6 槽位装备（头盔/上衣/裤子/手套/鞋子/武器）穿戴影响派生属性；伤害公式 `atk×var×100/(100+def)`（防御减伤，最低 1 点） |
| **商店系统** | 商店 NPC「商店老板·全能杂货铺」固定 (6,6)，4m 内可打开，出售全部物品；`stock=0` 表示无限库存；金币购买，背包/金币同步（S2C_INVENTORY） |
| **配置系统** | `data/items.json|monsters.json|shop.json|skills.json` 可热配置：怪物属性与掉落概率（`DropEntry`）、NPC 商店售价/库存、按 ID 管理物品、技能（伤害倍率/冷却/蓝耗/范围/**前摇 castTimeMs**/打断开关）；未提供配置时内置 `loadDefaults()` 兜底 |
| **预置测试物品** | 20 件默认物品：铁剑/烈焰剑等武器、皮帽/铁盔/锁子甲等防具、小血瓶/大血瓶消耗品、任务道具（可卖金币） |
| **技能系统** | 8 个技能（冲刺斩/烈焰冲击/治疗之光/冰霜新星/战吼/雷霆一击/吸血打击/荆棘护体），`SkillDef` 按 ID 配置；三层范围判定（施法距离/AOE 落点距离/AOE 命中半径）+ **技能前摇（castTimeMs）+ 释放时间判定**：前摇期间不生效、到期才结算（扣蓝/冷却/施加效果），**移动/受击可打断**（打断不消耗，`EVT_SKILL_CANCEL` 广播）；冷却/蓝量/范围/目标校验服务端权威 |
| **游戏控制台** | 服务端调试控制台：HTTP `POST /api/console` + WS `CONSOLE`(0x0B/0x93) 双通道，命令：`help/gold/level/stat/status/skill/items/boss/entities/echo/…`，用于功能测试与在线调试 |

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
| `EVENT`(0x87) / `PING`(0x88) / `KICK`(0x89) / `ERROR`(0x8A) | 共享事件（伤害/死亡/复活/技能）/ 心跳 / 踢出 / 错误 |
| `BOSS`(0x8B) | 世界 Boss 全局共享状态（HP/状态/阶段/仇恨目标） |
| `SHOP`(0x8C) | 商店列表（商店名 + 条目{itemId,price,stock}） |
| `INVENTORY`(0x8D) | 背包/金币/装备全量（登录即下发 + 变更后同步） |
| `LOOT`(0x8E) | 拾取反馈（成功/失败） |
| `STATS`(0x8F) | 自身属性（HP/MP/攻击/防御，穿戴后重算下发） |
| `SKILLS`(0x90) | 已学技能列表（含冷却 cdMs） |
| `SKILL_CAST`(0x91) | 施放反馈：ok + skillId + 落点 + **castTimeMs（前摇毫秒）** |
| `BUFFS`(0x92) | 自身 Buff 列表（剩余时间） |
| `CONSOLE`(0x93) | 控制台回显（命令 + 输出文本） |
### 上行消息（C2S）
| 消息 | 作用 |
|---|---|
| `INPUT`(0x01) | 输入 + 预测位置（防作弊校验依据），20Hz |
| `EVENT`(0x02) / `PONG`(0x03) | 事件 / 心跳 |
| `ATTACK`(0x04) | 攻击世界实体：目标 wid + 技能槽（服务端权威校验伤害/仇恨/死亡/复活） |
| `SHOP_OPEN`(0x05) / `SHOP_BUY`(0x06) | 打开商店 / 金币购买（服务端校验距离/金币/库存） |
| `PICKUP`(0x07) | 拾取地面掉落物（服务端校验 2m） |
| `EQUIP`(0x08) | 穿戴/卸下装备（6 槽位，重算派生属性） |
| `USE_ITEM`(0x09) | 使用消耗品（如血瓶回血） |
| `CAST_SKILL`(0x0A) | 施放技能：skillId + 目标 wid + AOE 落点(qAbs)（服务端前摇/范围/冷却/蓝量权威校验） |
| `CONSOLE`(0x0B) | 控制台命令（与 HTTP 通道等价） |
### AOI + 增量 + LOD
- **AOI 空间网格**（`aoi.cpp`，cell 25m）+ 距离过滤：只向玩家广播其兴趣集内实体
- **LOD 分级**：近 25m 每 tick、中 50m 每 2 tick、远每 4 tick 更新
- **带宽观测**：`EW_NETDBG=1` 输出每玩家带宽日志；客户端右下角「协议透传」面板实时显示解码后的每一帧（二进制 ↔ 可读对象）

---

## 世界怪物 / 世界 Boss 状态共享（全区同步）
按大型网游的规模，世界 Boss 采用**服务端单点权威 + 全局共享 + 全区广播**：
- **服务端单点权威**：3 只固定锚点世界 Boss（荒原巨兽/深渊领主/冰霜女王）在服务端 `World` 中全局模拟，所有玩家共享同一份 HP/仇恨表/阶段/生死，不存在"副本私有数据"。
- **全局广播**：`S2C_BOSS`(0x8B) 帧携带全部存活 Boss 的 `{wid, state, phase, hp, maxHp, bossTarget}`；状态变化经 `markBossDirty()` 标记，`netcode.tickBroadcast` 每 tick 全局广播（dirty 去重，无变化不发）。
- **加入即一致**：新玩家 HELLO 帧强制附带一次 `bossFrame(true)`，保证任何时刻进入世界的玩家看到的是同一个世界状态。
- **共享事件队列**：`pushEvent`/`takeSharedEvents` 维护全区事件（`EVT_DAMAGE/DEATH/RESPAWN/SKILL`），每 tick 拼接在广播末尾，全区玩家同步收到。
- **跨 Zone 扩展位**：事件/帧结构预留 `wid/b/x/z` 字段，后续可按 Zone 过滤广播、按区域分片（Sharding），或接入跨服共享状态服务。
详见 `server/docs/world-shared-state.md`。

## 生物 / NPC / Boss AI 整体方案（大型网游规模）
`server/src/game/ai.h / ai.cpp` 实现 **状态机（FSM）+ 三级调度**，在单线程 20Hz 权威 tick 上支撑大规模实体：
- **状态机（8 态）**：`IDLE / PATROL / CHASE / ATTACK / RETURN / WANDER / INTERACT / DEAD`。
  - **怪物** `tickMonsterAi`：感知清失效仇恨 → 玩家进入 `monsterAggroRange` 主动入仇 → 追击（`speed×1.8`）→ 近战攻击（服务端计算伤害+事件）；超出 `monsterLeashRange` 脱战回巢；无仇恨时按 `patrolRadius` 巡逻、越界回巢。
  - **NPC** `tickNpcAi`：低频 IDLE/WANDER 游走，`INTERACT` 交互态已预留（对话/商店/任务扩展位）。
  - **世界 Boss** `tickBossAi`（全区共享，不走 LOD）：IDLE 脱战回血 + 仇恨侦测 → ENGAGE 追击（`bossChaseSpeed`）→ 普攻 + 周期 AOE 范围技能（`EVT_SKILL` 广播）→ 按血量阶段切换（≤65% P2 / ≤35% P3）→ DEAD 复活计时回满血回锚点并广播复活。
- **三级调度** `AiScheduler::shouldTick`（大型网游核心——摊帧峰、省算力）：
  1. **AOI 激活**：玩家视野外的实体直接休眠（不模拟，位置由 move 系统保留）；
  2. **距离分级（AI LOD）**：距最近玩家 `<aiLodNearM(25m)` 每 tick、`<aiLodMidM(50m)` 每 2 tick、其余每 `aiLodFarStride(4)` tick；
  3. **时间片轮转**：`(tick + wid) % stride == 0` 把同档位实体摊到不同 tick，避免帧峰。
- **仇恨模型**：`aggro[wid]` 权重表；攻击增仇、Boss 被击目标仇恨衰减；玩家离线/死亡自动清仇；`pickAggroTarget` 取最高仇恨，便于后续扩展（威胁值衰减/距离权重/坦克切换）。
- **扩展位**：AI 参数全部集中在 `config.h`（仇恨/追击/巡逻/LOD 阈值），可用环境变量覆盖；新行为 = 新状态 + 新系统，不改既有系统。

## 存储系统（MySQL + Redis，无 DB 不影响功能）
`server/src/store/` 实现 **存储抽象层**：账号/玩家存档 → MySQL 持久化；会话/缓存 → Redis；**内存兜底，连不上外部存储自动降级，纯内存模式完整可用**。
- **三层架构**：`IStore` 抽象接口（业务层只依赖它）+ `MemoryStore`（永远可用、读权威、兜底）+ 外部后端（`MysqlStore` 账号/存档、`RedisStore` 会话/缓存）。
- **降级策略**：启动探测连接失败/运行期断线 → `available()=false` → 门面路由到内存，**不抛异常不崩溃**；启动时 MySQL 账号全量灌入内存缓存，断线后读仍命中。
- **MySQL**：libmysqlclient 预处理语句（防 SQL 注入）+ 幂等建表 `accounts` / `player_saves`；编译期检测头文件，缺库编译为空实现（全内存），不因无 MySQL 开发库而失败。
- **Redis**：自写最小 RESP 协议客户端（零第三方依赖，`PING/AUTH/SET(EX)/GET/DEL/EXISTS/EXPIRE`），键前缀 `ew:`，会话 `sess:<token>` 带 TTL。
- **玩家存档**：WS 登录按存档恢复出生点；每 100 tick（≈5s）周期落盘 + 下线落盘。
- **会话**：内存 + Redis(EXPIRE)，多实例可共享 token（A 实例签发、B 实例校验）。
- **配置**：`EW_DB_MYSQL[=host:port]` + `EW_DB_MYSQL_USER/PASS/DB`、`EW_DB_REDIS[=host:port]` + `EW_DB_REDIS_PASS/PREFIX`；未设置即纯内存模式。
详见 `server/docs/storage-design.md`。


## 物品 / 属性 / 商店 / 配置系统（大型网游规模）
`server/src/game/items.h/cpp` 实现四系统核心数据与逻辑，`GameData` 单例持有三张表（物品/怪物/商店），
服务端权威计算，客户端仅做展示（`client/js/items.js` 为默认物品的展示镜像）。

### 1. 物品系统（装备 / 消耗品 / 任务道具 + 掉落金币）
- **物品类型** `ItemType`：`Equip`（可穿戴）/ `Consumable`（使用消耗）/ `Quest`（任务道具）/ `Gold`（金币，`itemId=0`）。
- **物品定义** `ItemDef`：`id / type / name / desc / icon(emoji 缩略图) / slot / price / sell / stats{hp,mp,atk,def} / stackable`。
- **掉落**：怪物死亡 `rollDrops` 按 `DropEntry{prob,min,max}` 概率表掷物品 + 金币区间；掉落物以 `EntityKind::Item` 实体落在地面（金色菱形=物品 / 黄点=金币），`dropLifetimeSec(60s)` 过期由 `dropSystem` 清理。
- **拾取**：`playerPickup` 2m 距离校验；金币直接入 `gold`，物品入背包（可堆叠）。`S2C_LOOT` 反馈 + `S2C_INVENTORY` 全量同步。
- **使用/丢弃**：消耗品 `useItem`（如血瓶回血），背包上限扩展位预留。

### 2. 属性系统（血量 / 蓝量 / 攻击 / 防御 + 6 槽位穿戴）
- **基础属性**：玩家 `hp/mp/attack/defense`（默认 100/50/12/3），怪物/Boss 由 `MonsterDef` 配置（`applyMonsterStats`）。
- **6 槽位装备**：`EquipSlot` 枚举 `Head/Chest/Legs/Hands/Feet/Weapon`，玩家 `pl.equip[6]` 存 itemId。
- **派生属性**：`recomputeStats` 派生 = 基础 + 装备加成（`ItemDef.stats`），穿戴/卸下即时重算并下发 `S2C_STATS`。
- **伤害公式**：`calcDamage(atk, def, variance) = max(1, atk × variance × 100 / (100 + def))`——防御按比例减伤、最低 1 点；Boss 额外有 `bossDefense/bossMp`。

### 3. 商店系统（商店 NPC 出售全部物品）
- **商店 NPC**：`seedWorld` 固定生成「商店老板·全能杂货铺」锚点 (6,6)、`shopId=1`、`aiState=0` 守店不游走（紫色描边）。
- **打开**：`openShop` 校验玩家与商店 4m（`shopOpenRangeM`）内，`S2C_SHOP` 下发商店名 + 全部条目。
- **购买**：`buyItem` 服务端校验 `openShopId`、金币、库存；`stock=0` 无限；成功扣金币 + 入背包 + 下发 `INVENTORY/STATS`。
- **金币**：玩家 `pl.gold`，掉落/出售/购买共用同一货币（金币本身是物品，`itemId=0`）。

### 4. 配置系统（JSON 热配置 + 内置兜底）
- `data/items.json`：物品表（`id/name/desc/icon/type/slot/stats/price/sell`）。
- `data/monsters.json`：怪物表（`type/name/level/hp/mp/atk/def/aggroRange/leashRange` + `drops[{itemId,prob,min,max}]` 掉落概率）。
- `data/shop.json`：商店表（`shopId/name/npc{x,z}/entries[{itemId,price,stock}]`）。
- 启动加载 `loadFromJson(dataDir)`，任一文件缺失/解析失败仅告警并回退内置 `loadDefaults()`——**不影响功能**（与存储层降级同理）。
- 怪物按位置哈希 8m 格分配类型（wolf/goblin/skeleton/gargoyle），`monsterTypeAt` 确定性可复现。

### 协议扩展（物品/属性/商店）
| 方向 | 消息 | 作用 |
|---|---|---|
| C2S | `SHOP_OPEN`(0x05) / `SHOP_BUY`(0x06) / `PICKUP`(0x07) / `EQUIP`(0x08) / `USE_ITEM`(0x09) | 开商店 / 购买 / 拾取 / 穿戴卸下 / 使用消耗品 |
| S2C | `SHOP`(0x8C) / `INVENTORY`(0x8D) / `LOOT`(0x8E) / `STATS`(0x8F) | 商店列表 / 背包+金币+装备 / 拾取反馈 / 自身属性 |
| 实体 | `KIND_ITEM=4`，`writeEntityFull` 对 Item 写 `itemId u32 + gold u32`（替代 name 字段） | 掉落物实体编解码 |
| 事件 | `EVT_DROP=5` | 掉落物生成广播 |
| 事件 | `EVT_SKILL_CASTING=6` | 技能**前摇开始**（wid 施法者 + skillId + 落点） |
| 事件 | `EVT_SKILL_CANCEL=7` | 技能前摇被打断（reason：1=移动 / 2=受击） |

**自动化验证**：`node scripts/items_test.mjs`（16/16 PASS）覆盖「登录属性 → 打怪掉落 → 拾取金币/物品 → 开商店 → 金币买铁剑(攻 12→17) → 穿戴 → 买血瓶 → 使用回血」全链路。
浏览器端：`I` 背包/装备面板、`B` 商店（靠近紫色描边老板）、`E` 主动拾取、走到掉落物上自动拾取、HUD 显示 HP/MP/攻击/防御。

## 项目结构
```
EvolutionWorld/
├── client/                        # 网页测试客户端（Canvas 2D，零依赖）
│   ├── index.html                 # 登录页 + HUD + 协议透传监控面板
│   ├── css/style.css
│   └── js/
│       ├── boot.js                # 入口：登录流程 + 主循环 + 预测/回退接线 + 物品/商店/背包 UI
│       ├── items.js               # 默认物品展示镜像（ITEM_DEFS，名称/描述/图标/穿戴属性）
│       ├── predict.js             # ★ 客户端预测器（与服务端物理/地形逐位一致）
│       ├── terrain.js             # ★ 高度场地形数据（与服务端 terrain.cpp 逐位一致）
│       ├── renderer.js            # Canvas 2D 俯视角渲染：区块地形 + 水面 + 实体圆球
│       ├── entities.js            # 实体数据管理（ENTER/LEAVE/UPDATE/SNAPSHOT + 插值）
│       ├── protocol.js            # ★ 二进制协议编解码（与 C++ 逐位对应，透传转换层）
│       ├── network.js             # HTTP 登录 + 二进制 WS + 协议解码分发
│       └── input.js               # 键盘输入（WASD/方向键 + 空格跳跃）
└── server/                        # ★ C++17 服务端
    ├── CMakeLists.txt / Makefile
    ├── scripts/                   # 冒烟/防作弊/预测/AI/物品/技能/控制台 端到端测试脚本
    ├── data/                      # 可选 JSON 配置：items.json / monsters.json / shop.json / skills.json（缺失则内置兜底）
    └── src/
        ├── main.cpp               # 入口：装配 + 配置环境变量覆盖 + 信号处理
        ├── config.h               # 全局配置（世界/物理/防作弊/AOI 参数集中管理）
        ├── util/                  # json（自研）、base64、random
        ├── net/                   # epoll 事件循环 + HTTP + WebSocket + 二进制协议
        │   ├── server.h/cpp       # 事件循环 / tick 调度 / handleBinary / 带宽日志
        │   ├── http.h/cpp / websocket.h/cpp
        │   ├── protocol.h/cpp     # ★ 二进制帧/量化/编解码
        │   └── ...
        ├── auth/                  # 注册/登录/会话令牌（SHA-256 加盐，接 Store）
        ├── anticheat/             # ★ 防作弊：限频/序号/随机采样/轨迹/回退/踢出
        ├── store/                 # ★ 存储层：IStore 抽象 + 内存兜底 + MySQL/Redis（无 DB 不影响功能）
        └── game/                  # ★ 游戏逻辑（权威模拟）
            ├── world.h/cpp        # 实体注册表 / tick / 系统调度 / 快照
            ├── terrain.h/cpp      # 确定性噪声 + 高度场（与客户端逐位一致）
            ├── entity.h/cpp       # 实体（玩家/怪物/NPC）+ 扩展位
            ├── physics.h/cpp      # 重力/高度场碰撞/加速度/跳跃
            ├── chunk.h/cpp        # 区块加载 + ★ 高度场数据存储
            ├── aoi.h/cpp          # ★ AOI 空间网格
            ├── ai.h/cpp           # ★ 生物/NPC/Boss AI 框架（状态机 + 三级调度）
            ├── items.h/cpp        # ★ 物品/属性/商店/配置四系统（ItemDef/MonsterDef/DropEntry/ShopDef/GameData）
            └── netcode.h/cpp      # ★ 每玩家兴趣集 + 增量/LOD/校准快照 + Boss 全局广播
    └── docs/
        ├── world-shared-state.md  # 世界怪物/Boss 状态共享方案设计文档
        └── storage-design.md      # 存储系统（MySQL+Redis 降级）设计文档
```
（`server/data/users.json` 为运行时生成的账号数据，已被 .gitignore 忽略。）

---

## 技能系统（前摇 / 释放时间 / 范围判定）

**三层范围判定（服务端权威）**
1. **施法距离**：单目标/AOE 施法点距施法者 ≤ `range`（冲刺斩 3.5m 等）；
2. **AOE 落点距离**：玩家点击落点需在施法范围内；
3. **AOE 命中半径**：结算时对落点 `radius`（如烈焰冲击 4m）内怪物施加伤害/效果，半径外不受影响。

**前摇与释放时间判定（castTimeMs）**
- `SkillDef.castTimeMs`：0=瞬发（冲刺斩/雷霆一击…），>0=有前摇（烈焰冲击 600ms、冰霜新星 800ms、雷霆一击 1000ms…）；
- 施放 → 进入「施放中」状态（`beginCast`），**立即广播 `EVT_SKILL_CASTING`**（客户端画前摇进度圈）；
- 前摇期间技能**不生效**，**到期才结算**（`resolveCast`：扣蓝/上冷却/`EVT_SKILL`/施加效果）——被打断则完全不消耗；
- **打断规则**：`castCancelOnMove`（移动即打断，`EVT_SKILL_CANCEL` reason=1）/ `castCancelOnHit`（受击打断，reason=2），可逐技能在 skills.json 关闭；
- 系统调度优先级：AI(30) → **castSystem(32)** → Buff(35)，每 tick 检查移动打断与前摇到期结算。

**客户端简易效果（俯视 Canvas）**
- **前摇进度圈**：施法者身上金色/技能色圆环，弧线随释放时间 0→360° 填充；打断时红色闪圈并清除；
- **AOE 范围圈**：半透明填充 + 技能色虚线圆 + 半径标注（米），按技能键本地即时预览落点，结算落点由 `EVT_SKILL` 广播再次绘制；
- 单目标/自身技能仅显示前摇圈，无范围圈。

## 游戏控制台

服务端内置调试控制台（HTTP + WS 双通道），用于功能测试与在线调试：

| 通道 | 说明 |
|---|---|
| HTTP | `POST /api/console`，body `{token, command}`，返回 `{ok, text}`（无 EW_DEBUG 门控） |
| WS | C2S `CONSOLE`(0x0B) → S2C `CONSOLE`(0x93) 回显 |

常用命令：`help`（列出全部）、`gold <n>`（发金币）、`level <n>`、`stat atk|def|hp|mp <n>`、`status`（查看自身属性/装备/技能）、`skill <id>`（学习技能）、`items`、`boss`、`entities`、`echo <text>`。

**自动化验证脚本**（`server/scripts/`）：
- `skills_console_test.mjs`：技能+控制台端到端 23/23（含前摇结算时序）
- `cast_time_test.mjs`：前摇专项 14/14（反馈 castTimeMs / EVT_SKILL_CASTING / 移动打断不结算 / 完整前摇≈600ms 结算 / 瞬发无前摇）
- `skill_fx_e2e.mjs`：浏览器端到端渲染验证（前摇进度圈 / AOE 范围圈 / 打断清除，Playwright 截图）

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
