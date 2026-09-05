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
# 或统一用 EW_CONFIG 部署配置（key1=value,key2=value2,...，未知 key 忽略；自托管 runner 连托管库）
# 支持 mysql_host/port/user/pass/db 与 redis_host/port/pass/prefix
EW_CONFIG="mysql_host=db.internal:3306,mysql_user=ew,mysql_pass=xxx,mysql_db=ew,redis_host=cache.internal:6379,redis_prefix=prod:" ./evolution_server
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
node scripts/items_test.mjs                   # 物品/属性/商店端到端：掉落/拾取/购买/穿戴/使用
node scripts/map_collision_death_test.mjs       # 地图碰撞/怪物刷新/玩家死亡复活端到端（9/9）
node scripts/skills_debuff_test.mjs            # 技能扩展端到端：无目标施放/范围命中/流血/眩晕/击退/霸体/不可打断/减防/减攻（15/15）
node scripts/ai_void_test.mjs                  # AI 空洞区域判断：怪物追击不穿洞/卡住脱战回巢/NPC不进入空洞（6/6）

```

---

## 部署（两种方式）

服务端只能跑在 Linux（依赖 `epoll` / POSIX socket / `fcntl`），本机开发环境为
**Windows + WSL2 Ubuntu**：MySQL / Redis 装在 Windows 侧，WSL2 通过
`/etc/resolv.conf` 的 nameserver 动态拿到 Windows 主机 IP 再连过去（重启后 IP 会变）。
两种方式最终都部署到 WSL 内的 `/opt/evolutionworld`。

### 方式一：推送代码触发 GitHub 自托管 runner（`.github/workflows/ci.yml`）
`git push origin main` → 本机 self-hosted runner 领取任务 → 在 WSL2 内构建 →
部署到 `/opt/evolutionworld` → 启动并保留常驻，供浏览器手动验证。
特点：代码来源为 GitHub 上的 `main`；每次 `rm -rf build` 全量重建；每次
`rm -rf /opt/evolutionworld`（**运行时数据会被清空**）。

### 方式二：本机直接部署脚本（日常推荐，不走 GitHub）
直接用本地工作副本（含未提交改动）部署到同一台机器的 WSL2，无需提交 / 推送：

```powershell
# 完整部署：增量构建 + 停旧进程 + 部署 + 启动 + 健康检查
powershell -ExecutionPolicy Bypass -File deploy\deploy-local.ps1
# 等价快捷方式
npm run deploy:wsl
```

常用参数：

| 命令 | 用途 |
|---|---|
| `deploy\deploy-local.ps1` | 增量构建 + 部署 + 重启 + 健康检查（实测约 45s） |
| `-Clean` | 清空 `server/build` 全量重建 |
| `-SkipBuild` | 只改了客户端静态文件时跳过 C++ 构建，直接重新部署（实测约 20s） |
| `-Status` | 查看部署产物 / 进程 / 端口 / 健康状态 / 运行时数据 |
| `-StopOnly` | 停止服务（实测约 6s） |
| `-NoStart` | 只构建 + 部署，不启动 |
| `-WipeData` | 清空运行时数据（账号 / 地形编辑 / 出生点），对齐 CI 行为 |
| `-NoDb` | 不注入 MySQL/Redis，纯内存模式 |
| `-Port 4000` | 换端口（注入 `EW_PORT`） |
| `-Distro Ubuntu-22.04` | 指定其他 WSL 发行版 |

也可以绕过 PowerShell 编排层，直接在 WSL 内执行 bash 脚本：

```bash
bash deploy/deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld
bash deploy/deploy_wsl.sh --status
bash deploy/deploy_wsl.sh --stop-only
bash deploy/deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld --clean
```

**与方式一的差异（均为有意设计）**
- **保留运行时数据**：默认不清空 `/opt/evolutionworld/server/data`
  （`users.json` 账号 / `terrain_edit.json` 地形编辑 / `spawns.json` 出生点），
  而 CI 的 `rm -rf /opt/evolutionworld` 会一并删掉；
- **增量构建**：默认复用 `server/build` 缓存，CI 每次全量重建；
- **代码来源**：本地工作副本，CI 取 GitHub 上的 `main`。

**脚本内建的 WSL2 容错（踩过的坑，勿改回）**
1. **分级唤醒**：先做 25s 快速探活；探活失败时用 `vmmem`/`vmmemWSL` 是否存在来区分
   「VM 在跑但会话被残留 `wsl.exe` 客户端阻塞」（清理客户端，秒级恢复）与
   「VM 未运行的真冷启动」（首次调用会打印 `Provisioning the new WSL instance`，
   实测 1-3 分钟，只能耐心等且期间不能清理任何进程）。
2. **不使用 `wsl --shutdown`**：有用户会话时它会无限期挂死；恢复统一走 Windows 层
   `Stop-Process` / `taskkill` 强杀 `wslservice`、`wslhost`（与 CI 一致），
   服务管理也完全绕开 `systemctl`。
3. **超时只清理本次新起的 `wsl.exe`**：无差别杀光所有 `wsl.exe` 会连带拆掉 WSL VM，
   导致下次调用又要重新 provisioning。
4. **所有 WSL 调用都放在后台作业里并带超时**：直接前台调用一旦挂死会无限期阻塞，
   同时输出仍能流式打印。
5. **两阶段启动**：先 `timeout 5` 前台跑一遍把启动期崩溃直接打到控制台，确认正常后
   再 `nohup ... & disown` 常驻（直接后台启动时崩溃日志常常来不及落盘）。
6. **精确停进程**：按 `/proc/<pid>/exe` 的真实二进制匹配来 kill，**不用**
   `pkill -f evolution_server` —— 脚本自身命令行含 `--log /tmp/evolution_server.log`，
   会被该模式匹配到而自杀（进程 comm 名也被内核截断成 `evolution_serve`，
   `pgrep -x` 同样不可靠）。
7. **行尾与编码**：`.gitattributes` 强制 `*.sh` 用 LF（CRLF 会让 bash 直接报语法错误），
   部署前还会再生成一份剥掉 CR 的副本 `deploy/.deploy_wsl.local.sh`（已 gitignore）；
   WSL 侧脚本的运行时输出一律用 ASCII，避免 Windows 控制台（gb2312 代码页）
   解码 UTF-8 时乱码。

> 注：`deploy-local.ps1` 含中文，必须以 **UTF-8 with BOM** 保存，否则
> Windows PowerShell 5.1 会按 ANSI 代码页解析而报一堆莫名的语法错误。

部署完成后浏览器打开 `http://localhost:3000`；服务日志在 WSL 内
`/tmp/evolution_server.log`。

---

## 已实现功能
| 模块 | 说明 |
|---|---|
| **HTTP 登录** | `POST /api/register` / `POST /api/login`，SHA-256 加盐哈希，JSON 文件持久化（可换真实 DB） |
| **WebSocket 网关** | `/ws?token=xxx`，token 鉴权，二进制协议帧 |
| **无缝世界** | 程序化无缝高度场地形（确定性整数哈希噪声，服务端 C++ 与客户端 JS **逐位一致**） |
| **路径地图（空洞 / 走廊 / 空地，大型网游规模）** | 去除湖泊河流彩色地形，改版为**确定性程序化路径地图**：主城圆盘（出生/商店）+ **6 条主干道**（确定性随机游走走廊，沿途分叉短支路）+ **16 个随机空地**，其余全部为**空洞（不可达）区**；`terrainVoid(x,z)` 256×256 mask（覆盖 [-128,128)m）懒生成缓存，`terrainBlocked` = 编辑层 → 空洞 mask → 深水 → 陡坡（坡度>1.3），客户端 C++/JS **逐位一致**；空洞区不渲染、白色打底，仅浅灰渲染可通行格（见渲染行） |
| **斜上方 45° 等距 2.5D 渲染** | Canvas 2D **2:1 斜等测投影**（固定斜上 45° 视角）：可通行格统一**浅灰色**顶面（按坡度 ±12% 明暗），**空洞格整格跳过不渲染**（白色背景透出），悬崖侧壁暗色；区块高度场预渲染为等距切片 + 可见范围流式加载；实体/掉落/技能效果 2.5D 投影 + 深度排序，**无需 WebGL** |
| **斜上方 45° 等距 2.5D 渲染** | Canvas 2D **2:1 斜等测投影**（固定斜上 45° 视角）：区块高度场预渲染为等距切片（顶面 + 悬崖侧壁 + 半透明水面湖泊）+ 可见范围流式加载；实体/掉落/技能效果 2.5D 投影 + 深度排序，**无需 WebGL** |
| **高度场数据存储** | 服务端按区块缓存 33×33 高度网格（世界地图数据存储层），`/api/terrain/chunk?x=&z=` 提供数据接口 |
| **高度场碰撞** | 客户端预测器与服务端物理使用**同一 `terrainHeight(x,z)` 连续高度场**（已验证 4.5e-5m 精度一致）；编辑层 `EditCell{hasH,h,hasV,v}` 覆盖高度/空洞，客户端预测逐位复刻（`prediction_test` 0 回退） |
| **物体碰撞系统（2.5D，大型网游规模）** | `collision.h/cpp` 三层：① **静态地形碰撞**（湖泊/河流深水、悬崖/陡坡不可通行，`circleBlocked` 圆盘采样）；② **沿轴滑动回退**（`slideMove`，被障碍阻挡沿墙滑动，客户端预测逐位复刻）；③ **实体间圆形分离**（玩家/怪物/Boss/NPC 不可互相穿透，重叠各推开一半，推开落障碍回退） |
| **可见范围加载** | 区块（Chunk）管理，只加载/模拟/广播玩家 **100 米**内的实体与数据 |
| **实体渲染** | 当前角色=橙色球 + 半透明白色描边；怪物=红色球；其他玩家=绿色球 + 昵称；NPC=蓝色球；世界 Boss=暗红大球 + 头顶共享血条；立体圆球径向渐变 |
| **基础物理** | 重力、高度场地表碰撞、加速度/摩擦、跳跃（服务端权威） |
| **客户端预测** | 本地预测即时移动（零延迟），服务端后校验不通过则下发 `SELF` 回退；**预测包含 2.5D 地形碰撞**（与服务端 `moveEntityCollide` 逐位一致） |
| **防作弊系统** | ① 客户端预测 + 服务端后校验/回退；② 随机采样校验 + 轨迹校验；③ 令牌桶限频 + 序号仲裁；④ 不信任客户端时间戳，带网络容错 |
| **操作** | WASD / 方向键移动、空格跳跃（固定斜上方 45° 等距视角，无自由镜头） |
| **死亡/复活机制** | **玩家**：HP≤0 → 死亡（静止/不可施放/清仇恨 + `EVT_DEATH` 广播）→ `playerRespawnSec=3s` 后满血回安全点复活（`EVT_RESPAWN` + 校正快照 + 防作弊重置）；**怪物/Boss**：死亡 → `monsterRespawnSec=10s` / `bossRespawnSec=30s` 定时刷新回巢；**浏览器客户端死亡动画**：怪物/Boss/其他玩家淡出+下沉（~1.1s），玩家自身死亡遮罩 + 复活倒计时 |
| **世界怪物/Boss 状态共享** | 3 只全区共享世界 Boss（荒原巨兽/深渊领主/冰霜女王），服务端单点权威：HP/仇恨/阶段/生死，`S2C_BOSS` 全局广播（dirty 去重）+ 加入即一致的 HELLO 帧 + 共享事件队列（伤害/死亡/复活/技能，全区每 tick 广播） |
| **生物/NPC/Boss AI 框架** | `ai.h/cpp` 状态机（8 态）+ 大规模调度：AOI 激活、时间片轮转、距离分级（LOD）；怪物入仇/追击/近战/脱战回巢/巡逻；NPC 低频游走（预留交互态）；Boss 脱战回血/仇恨侦测/阶段切换(≤65%/≤35%)/追击/普攻/AOE 技能/死亡复活 |
| **物品系统** | 装备/消耗品/任务道具三类物品，`ItemDef` 按 ID 管理（名称/描述/缩略图/类型/穿戴属性）；怪物死亡随机掉落物品 + 金币（金币也是物品，`itemId=0`）；地面掉落物 60s 过期，2m 拾取 |
| **属性系统** | 玩家/怪物/ Boss 血量、蓝量、攻击力、防御力；6 槽位装备（头盔/上衣/裤子/手套/鞋子/武器）穿戴影响派生属性；伤害公式 `atk×var×100/(100+def)`（防御减伤，最低 1 点） |
| **商店系统** | 商店 NPC「商店老板·全能杂货铺」固定 (6,6)，4m 内可打开，出售全部物品；`stock=0` 表示无限库存；金币购买，背包/金币同步（S2C_INVENTORY） |
| **配置系统** | `data/items.json|monsters.json|shop.json|skills.json` 可热配置：怪物属性与掉落概率（`DropEntry`）、NPC 商店售价/库存、按 ID 管理物品、技能（伤害倍率/冷却/蓝耗/范围/**前摇 castTimeMs**/打断开关）；未提供配置时内置 `loadDefaults()` 兜底 |
| **地形编辑器（画刷）** | 独立页面 `client/editor.html`（`GET/POST /api/terrain/edit`）：俯视 2D 画布 + **6 种画刷**（抬高/降低/铺平/平滑/删除地区=挖空/增加地区=恢复）+ **画刷参数**（半径 1-16m、力度 0.2-5m/次、强度曲线 soft/hard、铺平目标高度）+ 高度色带显示；左键画、右键平移、滚轮缩放、撤销/重做（60 快照）、重置、保存到服务器（`data/terrain_edit.json` 持久化，重启加载）；保存后**游戏端实时生效**（在线玩家地形立即更新，重进自动加载） |
| **预置测试物品** | 20 件默认物品：铁剑/烈焰剑等武器、皮帽/铁盔/锁子甲等防具、小血瓶/大血瓶消耗品、任务道具（可卖金币） |
| **技能系统** | 16 个技能（8 基础 + 8 扩展：铁壁守护/撕裂/破甲斩/虚弱咒印/震荡波/疾风步/猛击/生命涌动），`SkillDef` 按 ID 配置；**取消目标检测（无目标也可施放，命中全部按落点+radius 范围计算）** + 三层范围判定 + **前摇 castTimeMs + 释放时间判定**：前摇期间不生效、到期才结算，**移动/受击可打断**（逐技能 `cancelOnMove/cancelOnHit` 可关闭=不可打断）；**霸体**（`superArmor` 免疫眩晕/击退）、**击退**（`knockback`）、**Buff 12 种**（含流血 DoT/减防/减攻/眩晕/加速）；冷却/蓝量/范围校验服务端权威 |
| **游戏控制台** | 服务端调试控制台：HTTP `POST /api/console` + WS `CONSOLE`(0x0B/0x93) 双通道，命令：`help/gold/level/stat/status/skill/items/boss/entities/heal/cdreset/spawn/kill/buff/buffmon/echo/…`，用于功能测试与在线调试 |

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
- **确定性巡逻（去随机化）**：怪物巡逻改为**固定 waypoint 环**（`initWaypoints/waypointTarget`）——6 个 waypoint 由出生点坐标确定性哈希生成（同 seed 跨服/跨重启一致），每个 waypoint 就近吸附干地避免走进空洞；到达后暂停固定时长再顺时针推进，卡住则推进到下一 waypoint。**移除 `rng01()` 随机掉头与越界回拉抖动**，巡逻目标速度长期稳定，是"客户端确定性外推"的服务器端前提。

## 怪物移动同步重构（消除 rubber-banding，客户端确定性外推 + 快照插值）

### 问题
旧实现客户端怪物位置靠「服务端广播位置 + 指数衰减插值」`v.x += (v.tx-v.x)*9*dt`——**朝最新目标追赶**，网络/广播延迟下严重闪回（目标一跳，插值反复追）。

### 方案：同步「移动意图」而非「位置结果」
**服务端**（保持权威，攻击/伤害/状态切换全在服务端）：
- 协议 `UPDATE` 帧新增 `M_INTENT(0x08)` 增量：**AI 状态 `aiState` + 目标速度 `targetVX/VZ`（含减速 buff 后的最终速度）+ 速度倍率 `speedMult(0-100)`**，位置/瞬时速度字段保留。
- `ENTER/SNAPSHOT` 实体全量追加 **AI 意图块**（`radius + aiState + targetVX/VZ + speedMult`）——客户端外推所需半径与服务端逐位一致。
- `netcode` 仅在意图变化时补发（去重），并按既有 LOD（近 1/中 2/远 4 tick）分级。

**客户端**（`entities.js` + 复用 `predict.js` 确定性物理）：
- 每个怪物/NPC/Boss 维护一份**与服务端同款物理的确定性推演** `sim`（`stepSim`：加速度逼近目标速度→重力→摩擦→积分→2.5D 地形滑动→贴地，与 `moveEntityCollide` 逐位一致）；收到意图后以 20Hz 步进外推，**不再朝最新目标追赶**。意图缺失回退为「按当前速度惯性滑行」（纯客户端外推）。
- **快照插值渲染**：`hist` 保留最近 4 个推演快照，渲染时钟**落后一拍**（`renderClock ≤ simTime-1`）在相邻快照间线性插值，输出 60fps 平滑，同时吸收网络抖动。
- **权威校正分级**：收到新权威位置时，偏差 ≤0.15m 噪声内忽略（信任外推）→ ≤3.0m 平滑收敛归位（每 tick 收敛剩余偏差 35%，≤8 tick）→ 超 3.0m 硬快照（仅网络级失步）。行为切换（转向/停手/脱战）只触发一次平滑校正。
- `predict.js` 重构：抽取共享 `stepSim/circleBlocked/slideMove/PHYS` 导出，玩家预测（`Predictor._tickStep`）与怪物外推复用同一实现，玩家预测 0 回退基线不变。
- 修复历史隐患：`UPDATE` 位置解码统一为**绝对坐标**（`相对量+ref`），与 `ENTER/SNAPSHOT` 一致（旧代码把相对量当绝对量用，仅在出生点附近近似成立）。

### 验收实测（浏览器 E2E，7s）
| 指标 | 旧（指数衰减） | 新（确定性外推+插值） |
|---|---|---|
| 逐帧最大渲染位移 | 闪回明显 | **0.105m**（不可感知） |
| 权威位置>3m 硬快照 | — | **0 次** |
| 平滑收敛校正 | — | 68 次（行为切换） |
| 噪声内信任外推 | — | 989/1057（93.5%） |
| 外推误差（近/中/远） | — | 平均 ≤0.11m / 最大 ≤0.25m |
- 新增回归 `ai_intent_test.mjs`：意图字段覆盖、移动方向与目标速度一致（103/109）、速度倍率范围 —— 3/3 PASS。

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
├── .github/workflows/ci.yml       # 部署方式一：推送触发本机自托管 runner 部署到 WSL2
├── deploy/                        # ★ 部署方式二：本机直接部署到 WSL2（不走 GitHub）
│   ├── deploy-local.ps1           # Windows 侧编排：WSL 唤醒/分级恢复 + 流式调用 + 超时兜底
│   └── deploy_wsl.sh              # WSL 内执行：构建 → 停旧进程 → 部署产物 → 两阶段启动 → 健康检查
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

## 技能系统（无目标施放 / 范围命中 / 前摇 / 霸体 / 减益 / 击退）

**命中判定：全部按「落点 + radius」范围计算（取消目标检测）**
- 任何技能都**无目标可施放**（`targetWid=0`）；落点语义：SELF=自身位置，ENEMY/AOE=客户端落点；
- 仅保留基础约束：SELF 落点锁定自身、落点距施法者 ≤ `range`（防超距施法）；
- 结算命中半径 `hitRadius = radius>0 ? radius : 1.2m`（近战贴身），对落点 `radius` 内怪物统一施加伤害/减益/击退，不再依赖锁定目标。

**前摇与释放时间判定（castTimeMs）**
- `SkillDef.castTimeMs`：0=瞬发，>0=有前摇（铁壁守护 800ms、震荡波 800ms…）；
- 施放 → 进入「施放中」状态（`beginCast`），**立即广播 `EVT_SKILL_CASTING`**（客户端画前摇进度圈）；
- 前摇期间技能**不生效**，**到期才结算**（`resolveCast`：扣蓝/上冷却/`EVT_SKILL`/施加效果）——被打断则完全不消耗；
- **打断规则**：`cancelOnMove`（移动即打断，`EVT_SKILL_CANCEL` reason=1）/ `cancelOnHit`（受击打断，reason=2），可逐技能在 skills.json 关闭（如铁壁守护两者全关=不可打断）；
- **霸体**：`superArmor=true` 技能施放即挂 SUPER_ARMOR（持续=前摇+0.5s），期间**免疫眩晕/击退**（`applyBuff` 对 STUN 做霸体免疫，`applyKnockback` 对霸体目标无效）；
- 系统调度优先级：AI(30) → **castSystem(32)** → Buff(35)，每 tick 检查移动打断与前摇到期结算。

**Buff 系统（12 种）**
- 增益：ATK 攻击+/ DEF 防御+/ SPEED 移速+ / REGEN 持续回血 / THORNS 反伤 / SUPER_ARMOR 霸体；
- 减益：BLEED 流血（DoT 每秒扣血，逐秒推 `EVT_DAMAGE`）/ DEF_DOWN 减防 / ATK_DOWN 减攻 / STUN 眩晕（无法移动/跳跃，怪物 AI 眩晕短路）/ MOVE_SLOW 减速（与加速叠加，速度下限 0.05）；
- `recomputeStats` 合并增益减益（ATK/ATK_DOWN、DEF/DEF_DOWN），攻击下限保护 ≥1；`applyBuff` 触发重算，`EVT_BUFFS`(0x92) 同步客户端。

**击退**：`SkillDef.knockback`（米），结算时沿「施法者→目标」方向位移目标、落回地形高度；霸体目标免疫；击退视为受击（打断目标前摇）。

**扩展技能一览（1010-1017）**
| ID | 名称 | 效果 | 前摇 | 特点 |
|---|---|---|---|---|
| 1010 | 铁壁守护 | DEF+15（8s） | 800ms | **不可打断 + 霸体** |
| 1011 | 撕裂 | 130% AOE + 流血 10/s·5s | 700ms | 流血 DoT |
| 1012 | 破甲斩 | 140% AOE + 减防 12·6s | 600ms | 减防 |
| 1013 | 虚弱咒印 | AOE 减攻 8·8s | 500ms | 减攻 |
| 1014 | 震荡波 | 100% AOE + 眩晕 2s | 800ms | 眩晕控制 |
| 1015 | 疾风步 | 移速+50%（8s） | 300ms | 加速 |
| 1016 | 猛击 | 180% AOE + 击退 6m | 500ms | 击退 |
| 1017 | 生命涌动 | 回血 25/s（8s） | 400ms | 持续回血 |

**客户端简易效果（俯视 Canvas）**
- **前摇进度圈**：施法者身上金色/技能色圆环，弧线随释放时间 0→360° 填充；打断时红色闪圈并清除；
- **AOE 范围圈**：半透明填充 + 技能色虚线圆 + 半径标注（米），按技能键本地即时预览落点，结算落点由 `EVT_SKILL` 广播再次绘制；
- **Buff 栏**：显示 12 种 Buff 图标与剩余秒数（含流血/减防/减攻/眩晕/霸体/加速）；
- **技能热键**：技能栏按 ID 升序填槽，槽 1-9=数字 1-9、槽 10=0、11=-、12==、13-16=Q/R/T/Y（与移动 WASD / 拾取 E 无冲突）。

## 地图优化 / 物体碰撞 / 死亡复活（大型网游规模）

### 1. 地图要素（路径地图 + 空洞，确定性程序化，服务端 C++ 与客户端 JS 逐位一致）

| 要素 | 实现 | 是否可通行 |
|---|---|---|
| **空洞（白色打底）** | `terrainVoid` 256×256 确定性 mask：主城圆盘 r=9 + 6 条主干道走廊（随机游走）+ 16 个随机空地，**其余全部空洞** | **空洞不可通行** |
| **基础丘陵** | fbm 高度场（clamp [-12,34]） | 可通行（走廊/空地内） |
| **深水/河流** | 保留河床下切逻辑（水面 `kWaterLevel=-2`）作为残留约束 | **深水不可通行** |
| **悬崖/山脊** | ridged noise 抬升 + `terrainSlope`，坡度 > `kCliffSlope=1.3` 判为悬崖 | **不可通行** |

- `terrainBlocked(x,z)` 判定顺序：**编辑层** → **空洞 mask** → 深水 → 陡坡（坡度>1.3）；出生点/怪物/Boss 搜索均避开不可通行区。
- 高度数据存储与区块接口不变（`/api/terrain/chunk`）；渲染改为等距切片（见下）。

### 2. 斜上方 45° 固定视角 2.5D 渲染

- **投影**：2:1 斜等测 —— `gx=(x-z)*ISO`，`gy=(x+z)*ISO/2 - h*HS`（ISO=8px/m、HS=5px/m 高度夸张），相机固定斜上 45°、玩家居中。
- **地形**：每 25m 区块预渲染为等距切片（离屏画布）：**可通行格**统一**浅灰**顶面（基础 196 亮度、按坡度 ±12% 明暗）+ **悬崖侧壁**（朝向相机的 +x/+z 缘，高差>0.6m 时暴露暗色岩壁）；**空洞格整格跳过不渲染**（白色背景透出），背景为白色渐变；区块按 `cx+cz` 深度远→近 blit，仅流式加载可见 100m 内区块。
- **实体/效果**：圆球径向渐变（伪 3D）+ 地面影子 + 高度投影；实体按 `x+z` 深度排序；AOE 范围圈/前摇进度圈/打断闪红改为等距椭圆投影。

### 3. 2.5D 物体碰撞系统（`collision.h/cpp`）

| 层 | 说明 |
|---|---|
| **静态地形** | `isBlocked`→`terrainBlocked`；`circleBlocked(x,z,r)` 中心+圆周 8 点采样判定圆盘是否与不可通行重叠 |
| **沿轴滑动** | `slideMove`：实体移动到目标位若被阻挡，先试 X 轴、再试 Z 轴，模拟**沿墙滑动**；客户端 `predict.js` 逐位复刻，预测与服务端权威一致 |
| **实体分离** | `separate(a,b)`：动态实体（玩家/怪物/Boss/NPC）重叠时沿连线各推开一半（不可穿透），推开后若落入障碍则回退；**玩家永不被实体推挤**（怪物/Boss/NPC 向玩家让行），保证玩家轨迹仅由地形碰撞决定、客户端预测可完全复刻（不被动态阻挡破坏预测一致性） |

接入点：`moveSystem` 的 `moveEntityCollide`（物理积分 → 地形碰撞滑动 → 贴地重算）+ 实体分离（AOI 邻域查找，避免 O(n²)）。

### 4. 死亡 / 复活机制

- **玩家**：任意伤害路径（怪物普攻/Boss 普攻 AOE/荆棘反伤）使 HP≤0 → `World::killPlayer`：置 0、`dead` 标记、复活计时、停止施放/移动、清全图仇恨、广播 `EVT_DEATH`；`playerRespawnSystem` 到期满血回安全点复活（`EVT_RESPAWN` + 网络层 correction/强制快照 + 防作弊重置，避免复活瞬移误判）。
- **怪物**：死亡 → `active=false` + `EVT_DEATH` + 掉落 → `monsterRespawnSec=10s` 回巢刷新（`EVT_RESPAWN`）。
- **Boss**：死亡 → `BS_DEAD` + 计时 → `bossRespawnSec=30s` 回锚点复活（既有机制保留）。
- **客户端**：怪物/Boss/其他玩家死亡播放**淡出+下沉动画**（~1.1s，LEAVE 延迟到动画结束）；玩家自身死亡显示**遮罩 + 复活倒计时**，期间输入门控（不移动/不施放），复活恢复。


## 游戏控制台

服务端内置调试控制台（HTTP + WS 双通道），用于功能测试与在线调试：

| 通道 | 说明 |
|---|---|
| HTTP | `POST /api/console`，body `{token, command}`，返回 `{ok, text}`（无 EW_DEBUG 门控） |
| WS | C2S `CONSOLE`(0x0B) → S2C `CONSOLE`(0x93) 回显 |

常用命令：`help`（列出全部）、`gold <n>`（发金币）、`level <n>`、`stat atk|def|hp|mp <n>`、`status`（查看自身属性/装备/技能/冷却）、`skill <id>`（学习技能）、`skills`（查看已学+冷却）、`items`、`boss`、`entities [range]`（附近实体 hp/atk/def/@坐标）、`spawn <type> [x z]`（生成怪物）、`kill <wid|all|monsters|boss>`、`respawn`、`heal`（回满自身 HP/MP）、`cdreset`（重置技能冷却）、`buff <type> <v> <dur>`（自身挂 Buff：atk/def/slow/regen/thorns/bleed/def_down/atk_down/stun/super_armor/speed）、`buffmon <wid> <type> <v> <dur>`（给指定怪物挂 Buff，便于验证怪物侧减益）、`echo <text>`。

**自动化验证脚本**（`server/scripts/`）：
- `skills_console_test.mjs`：技能+控制台端到端 23/23（含前摇结算时序）
- `cast_time_test.mjs`：前摇专项 13/13（反馈 castTimeMs / EVT_SKILL_CASTING / 移动打断不结算 / 完整前摇结算 / 瞬发无前摇）
- `skills_debuff_test.mjs`：技能扩展端到端 15/15 —— 无目标施放（SELF/AOE/霸体技能）、范围命中（撕裂 AOE）、流血 DoT（HP 持续下降）、眩晕（位置静止）、击退（位移>3m）、霸体免疫眩晕、不可打断（移动不打断仍结算）、减防（def 5→-9）、减攻（atk 7→4）
- `skill_fx_e2e.mjs`：浏览器端到端渲染验证（前摇进度圈 / AOE 范围圈 / 打断清除 / 无 JS 错误，Playwright）
- `map_collision_death_test.mjs`：地图优化端到端 9/9 —— ①向空洞移动被 2.5D 地形碰撞阻挡；②怪物死亡 → `EVT_DEATH` → 定时 `EVT_RESPAWN`（同 wid）；③玩家死亡 → `EVT_DEATH` → 复活 `EVT_RESPAWN` → 满血
- `terrain_edit_test.mjs`：路径地图+地形编辑端到端 11/11 —— 空洞 mask 确定性、主干道连通、编辑层 JS 覆盖（抬高/挖空/fill）、序列化往返、HTTP POST→GET 一致、空编辑清理还原

---

## 路径地图 / 地形编辑器（大型网游规模）

### 1. 路径地图空洞（`terrainVoid`，服务端 C++ ↔ 客户端 JS 逐位一致）
本版把游戏定位固定为**俯视角大型 MMO 路径地图**：不做彩色地形/河水渲染，可通行区域呈「**走廊 + 分叉 + 空地**」的路径图结构，其余为空洞。
- **确定性 mask**：`MASK_N=256 × MASK_OFF=128` 覆盖世界 `[-128,128)m`，懒生成缓存（超出视为空洞）。
- **主城圆盘** `r=9`：世界中心出生地/商店（安全区）。
- **6 条主干道**：从中心按 `baseAng=i*60°+确定性扰动` 随机游走 30-37 步（每步 2m，方向 wob±0.45 + 回拉 0.10），走廊半径 3.6；每 7 步分叉一条 12 步短支路（r=2.8）。
- **16 个随机空地**：半径 5.5-12，坐标 ±110 内，偶尔保留空地供战斗/集合。
- `terrainBlocked` 判定顺序：**编辑层** → **空洞 mask** → 深水 → 坡度>1.3；`terrainHeight` 先查编辑层绝对高度覆盖。
- 渲染：可通行格统一**浅灰**顶面（基础 196 亮度、按坡度 ±12% 明暗），**空洞格整格跳过不渲染、白色背景透出**；保留等距 45° 2.5D 投影与悬崖侧壁暗色。

### 2. 地形编辑器页面（`client/editor.html`）
独立网页（复用 `/api/register`、`/api/login`），用于用**画刷**调整地图，落盘后游戏端实时生效。
- **数据链路**：`GET /api/terrain/edit` 读取既有编辑层 → 画布俯视 2D 渲染（浅灰=可通行 / 白=空洞，可选手动高度色带）→ 画刷操作 → `POST /api/terrain/edit`（`{token,cells}`，服务端 `verifyToken` 校验）→ 持久化 `data/terrain_edit.json` → 重启加载。
- **画刷（6 种）**：
  | 画刷 | 作用 | 对应编辑层 |
  |---|---|---|
  | 抬高 `raise` | 按力度提升地形高度 | `hasH/h` |
  | 降低 `lower` | 按力度降低地形高度 | `hasH/h` |
  | 铺平 `flatten` | 铺平到设定目标高度 | `hasH/h` |
  | 平滑 `smooth` | 8 邻域平均高度（柔化） | `hasH/h` |
  | 删除地区 `void` | 挖空（该格不可达） | `hasV/v=1` |
  | 增加地区 `fill` | 恢复（强制可通行并抬到水面+1.5） | `hasV/v=0` |
- **画刷参数**：半径 1-16m、力度 0.2-5m/次、强度曲线（soft smoothstep / hard）、铺平目标高度、显示高度色带开关。
- **交互**：左键拖动应用画刷、右键平移、**WASD / 方向键平移视角**、滚轮缩放、撤销/重做（JSON 快照栈上限 60）、重置（清空编辑还原程序化地形）、保存。
- **性能重写（解决"特别卡 / 看不到高度 / 显示多个地图"）**：
  - 旧实现每次鼠标移动 `createImageData(全画布)` 逐像素、逐像素调 `terrainHeight/terrainBlocked`（含编辑层哈希查询）→ O(全图×dpr²) 卡顿；`redraw` 内 `halfW/halfH` 未除 dpr 与 `w2s/s2w` 的 dpr 换算不一致 → 缩放平移后坐标错位出现"多个地图"；`showHeight` 只有 150-220 窄灰阶且默认关 → 高度不可读。
  - **新实现**：`CELL` 256×256 颜色缓存（每格仅一次地形查询），`redraw` 按可见世界格**逐块填充**（O(可见格×dpr²)，整图 ~65k 格仍毫秒级）；坐标换算统一 `÷dpr`，消除多图伪影；`showHeight` 默认关闭但一键开启，**6 段高度色带**（-2→34m：深蓝→青→绿→黄→棕→白）+ 图例条，高度一目了然。
- **生效方式**：保存后服务端编辑层即时替换（在线玩家下次 AOI 快照/区块请求即用新地形）；游戏端 `boot.js` 连接后 `GET /api/terrain/edit` 加载编辑层，本地预测碰撞同样生效（与 `predict.js` 一致）。

### 3. 碰撞一致性保障
地形任何改动必须**三处同步**：`server/src/game/terrain.cpp` ↔ `client/js/terrain.js` ↔ `client/js/predict.js`（预测碰撞）。用 `prediction_test.mjs`（0 回退）回归；C++/JS 逐位一致性用临时对比程序抽样验证。

---

## 生物（怪物 + NPC + Boss）系统规模化 / 出生点剧本编辑器（大型网游规模）

### 1. 数据驱动出生点（`spawns.h/cpp`，替代硬编码）
按大型网游规模，把"哪里刷什么怪/NPC/Boss"从代码里抽成**数据**，支持运行期热编辑、按需部署、多服对齐。
- **`SpawnKind`**：`monster / npc / boss`；`SpawnPoint{kind,type,name,shopId,x,z,count}`；`SpawnConfig` 负责默认生成、`JSON 序列化/反序列化`、`loadFile/saveFile`（`data/spawns.json`）、`list/mut/size`。
- **确定性默认出生点**：`loadDefaults` 用 `Mulberry32(cfg.worldSeed ^ 0x7c9a3)` 生成——24 怪物（按距离阶梯：近郊野狼→中郊哥布林→远郊骷髅→边境石像鬼，环带 20-110m 就近找干地）、12 NPC（主城圆盘锚点，商店老板守店 (6,6)）、3 世界 Boss（远离出生点锚点 `{-79.5,-73.5}/{74.5,38.5}/{-47.5,44.5}`）。同 seed 不同服出生点**逐位一致**。
- **启动加载**：`main.cpp` 启动时若存在 `data/spawns.json` 则覆盖默认；无则用内置默认，不影响功能。
- **热重载**：`World::applySpawns(json,dataDir)` → 解析 → 落盘 → `reseedCreatures()`（移除 `m_/n_/boss_` 前缀实体、`aliveBoss_` 归零、按新出生点重建）；**在线玩家不受影响**（玩家实体保留）。

### 2. 生物系统 API（剧本编辑器消费）
| 接口 | 说明 |
|---|---|
| `GET /api/spawns` | 返回全部出生点 `{ok,count,spawns:[{kind,type,name,shopId,x,z,count}]}` |
| `POST /api/spawns/edit` | `{token,spawns}` → 鉴权 → `applySpawns` 落盘 + 世界热重载 → `{ok,count}` |

### 3. 剧本编辑器（`editor.html` 生物模式）
同一编辑器页新增 **👾 生物出生点模式**：
- **渲染**：怪物/红、NPC/蓝、Boss/紫 半透明悬浮圆球（白描边），Boss 更大；多数量怪物显示 `×N`；点击选中黄色虚线高亮；地图上随地形一起可见。
- **新增**：选择类型/子类型/数量后，**点击地图空白处**即在该处新增出生点（坐标取整到 0.5m）。
- **移动**：**左键拖动**出生点标记即改位置（实时取整）；列表点击同样选中。
- **删除**：点选标记后按 `Del`，或列表项 ✕ 按钮。
- **列表**：右侧面板列出全部出生点（类型/子类型/坐标/数量），实时计数。
- **保存**：`POST /api/spawns/edit` → 服务器落盘 `data/spawns.json` + **世界生物热重载**——游戏端（含在线玩家）立即看到新布局。

### 4. 生物系统规模化要点（本版实现）
- **AI LOD / 时间片**：`aiSystem` 按实体 `tickStride` 错峰（玩家 1、近 2、远 4）、每 tick 分时处理，万级生物可控。
- **状态机分层**：怪物（巡逻→游走→追击→攻击→脱战回巢）、NPC（守店/原地/游走，商店老板守店不移动）、Boss（独立 `bossSystem`：血量分阶段、召唤/技能、脱战回巢+死亡后 `bossRespawnS` 计时复活）。
- **空洞/地形安全**：出生/掉落/巡逻全部走地形碰撞与"就近找干地"兜底；卡住计时换向（`AiAgent::stuckT`）。
- **持久化扩展位**：`spawns.json` 已是独立数据层，后续加"刷新间隔、活动 AI 参数、Boss 阶段脚本"直接扩字段即可。

---

## 本轮修复与部署（客户端边界 / 登录健壮性 / AI 空洞 / 出生布局 / EW_CONFIG）

### 1. 客户端空洞边界修复（玩家可走到地图外）
- **根因不是"缺空洞判断"**（C++/JS `terrainBlocked` 9 万采样逐位一致），而是预测碰撞回退失效：
  - `client/js/predict.js`：`_tickStep()` 的 `ox/oz` 在积分**之后**取值，`slideMove` 回退基准=被阻挡位置，回退永远无效 → 玩家在空洞内振荡前进；
  - `server/src/game/collision.cpp` 与 predict 同源 bug：`slideMove` 的 okX/okZ 分支只设单轴不还原另一轴，对角残留 → 服务端实测同样穿洞。
- **修复**：`ox/oz` 移到积分前；`slideMove` 两分支完整还原双轴（客户端/服务端一致）。
- 验证：空洞边缘端到端同步停在 `-84.2`、零振荡；`prediction_test.mjs` 最大偏差 0.641m、corrections=0。

### 2. 登录刷新 CONNECTING 报错修复
- **根因**：`btn-login` 为 `type="submit"`，点击同时触发 click+submit → `doLogin` 双调 → `net.connect()` 双执行，第二个连接仍在 CONNECTING 时被放行 `ws.send` → `InvalidStateError`。
- **修复**：`network.js` `connect()` 先关旧 socket 并立即 `connected=false`；新增 `_send(frame)` 检查 `readyState===OPEN`，全部 `this.ws.send` 改走 `_send`；`boot.js` `doLogin` 加 `loggingIn` 防重入（try/finally 复位）。

### 3. AI 空洞区域判断（怪物 / NPC）
- **检查结论**：AI 移动统一经 `moveSystem → moveEntityCollide` 地形碰撞（含空洞）——**AI 不会进入空洞**；`spawnMonster`/`spawnDropAt` 出生/掉落自动向最近干地（`!terrainBlocked && h>kWaterLevel+1.0`）偏移。
- **补缺陷**：追击/巡逻撞空洞墙会永久顶墙（无寻路）→ 新增 `AiAgent::stuckT` 卡住计时（有移动意图但位移<0.05m 累积、否则衰减）：巡逻/游走卡住 >1.5s 立即换向，追击卡住 >2s 清仇恨脱战回巢。
- 验证：`ai_void_test.mjs` 6/6（怪物隔空洞引怪 12 采样点全程干地、卡住后回巢、NPC 位置不进入空洞）。

### 4. 地图重生成：出生空地 / 安全区无怪 / NPC 在出生点旁
- **玩家出生/复活**：改为**主城圆盘开放空地**（`terrain.cpp` 新增 `townSpawn`，r≤8.2，保证玩家圆盘可容纳）；复活点同样回主城。
- **怪物**：出生改为**环带 20-110m**（出生点最近怪实测约 38m），并按距离**阶梯刷怪**（近郊野狼→中郊哥布林→远郊骷髅→边境石像鬼），更符合大型 MMO 刷怪区。
- **NPC**：12 个 NPC 全部布置在出生点附近（4-13m），锚点在主城圆盘内、就近找干地兜底；商店 NPC「商店老板·全能杂货铺」守店于 (6,6)。
- **世界 Boss**：锚点从城镇中心 `(0,0)` 移走，改为 3 个远离出生点且可通行的锚点 `{-79.5,-73.5} / {74.5,38.5} / {-47.5,44.5}`。

### 5. EW_CONFIG 部署配置环境变量
- 服务端启动时检查 `EW_CONFIG`，按 `key1=value,key2=value2,...` 读取白名单配置（未知 key 忽略）：`mysql_host / mysql_port / mysql_user / mysql_pass / mysql_db`、`redis_host / redis_port / redis_pass / redis_prefix`。
- 优先级：EW_CONFIG 先行应用，单独的 `EW_DB_MYSQL`/`EW_DB_REDIS` 等可覆盖对应字段；连接失败自动降级内存、不影响功能（连接超时：MySQL 2s / Redis 2s）。
- 用于自托管 runner 部署时连接托管服务器上的 MySQL/Redis。

---

## 前端自动化测试插件（调试数据面板控制，数据驱动）
浏览器端集成自动化测试插件（`client/js/autobot.js`），**控制开关位于游戏内调试数据面板底部「🤖 自动化测试」行**：
- **任务主导**：按「每日 → 支线 → 主线」优先级自动接取 / 执行 / 提交全部任务（排序 每日3 > 支线2 > 主线1 > 重复4）；每次开始时按服务端任务检查结果续跑，刷新页面后自动恢复
- **自动变强**：按评分（atk×2 + def + hp×0.2）购买更强装备、强化装备（读取强化档表验金币 / 强化石）、任意可合成配方合成
- **自动补给**：血瓶保有 6 / 蓝瓶保有 4，商店购买或配方合成（`craftableNow` 校验防死循环）
- **兜底刷怪**：无可执行任务时刷怪升级 + 强化属性；打不过的怪（maxHp > atk×18）自动跳过
- **零作弊**：全程只走网络协议（移动 / 对话 / 接交任务 / 商店 / 强化 / 合成 / 拾取 / 攻击 / 技能），**不使用任何控制台命令**
- **数据驱动**：任务 / 物品 / 怪物 / 商店 / 配方 / 强化表全部运行时读取 `GET /api/gamedata`（服务端已输出 `quests` 配置），**游戏数据动态修改不影响插件运行**
- **控制与容错**：开始 / 暂停 / 重置；`localStorage` 持久化（`ew_autobot`），手动输入 >5s 自动暂停避让；幽灵怪（目标连续 10 次无伤害）跳过 45s；拾取无响应（掉落物移除事件丢失）本地剔除防死循环
- **空洞绕行（路径地图移动）**：游戏为路径地图（大量空洞 / 不可达区），直线点击寻路会卡在空洞边缘。统一 `goto()` 移动封装：目标可达性校验（`terrainBlocked`，空洞对岸目标直接放弃换目标）→ 前方 2.2m 探点 → 左右扫描 15°~90° 找绕障方向 → 3.5s 位移 <0.4m 卡死检测兜底；所有移动分支（追杀 / 拾取 / NPC / 任务点 / 探索）统一走该封装；目标选取同时过滤站在空洞区的怪物
- **走位攻击（kiting）**：普攻命中后进入走位窗口（约 550ms），期间横向绕圈移动（垂直攻击方向 ±1.7m，被挡自动反向 / 径向退），冷却好再停下攻击——避免站着被怪打死；血量 <35% 时改为径向远离拉开 + 喝血瓶
- **调试钩子**：`window.__ewAutobot`（`start/pause/reset/isRunning/getPhase/getStats/tick/__autobotDebug/__testAttack`）

### 本轮修复
- 修复插件任务进度不推进的根因：`combatAttack` 引用 `S_._lastAttackAt`（带下划线）而状态字段实际为 `lastAttackAt` → `undefined - now = NaN`，`NaN >= 冷却` 恒 false，**普攻帧（0x04）从未发出** → 击杀计数恒 0 → 任务进度 0/N。统一字段名后普攻正常（出站抓包确认 ATTACK 帧），每日任务 3001（击杀任意 ×10）可正常完成提交
- 技能施放改为**普攻为主、技能为辅**（技能分支不再阻塞普攻，避免技能前摇/冷却导致的持续空转）

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
