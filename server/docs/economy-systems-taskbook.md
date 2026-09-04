# EvolutionWorld 经济系统任务书

> 商店系统 · 装备强化 · 装备分解 · 物品合成 · 仓库系统
>
> 版本 v1.0 ｜ 目标：按大型网游（MMORPG）规模与风格，构建完整的物品经济闭环。
> 实施原则：**插件化子系统 + 数据驱动 + 服务端权威 + 无 DB 不影响功能**。

---

## 一、文档说明

### 1.1 目标

在现有 World 中心调度架构上，新增 5 个经济子系统，形成「获取 → 强化 → 分解 → 合成 → 存储」的完整物品循环：

| 系统 | 核心玩法 | 绑定 NPC 标签 |
|------|----------|---------------|
| 商店系统（扩展） | 分类商品、限购、折扣、出售回收 | `NPC_TAG_SHOP` |
| 装备强化系统 | +0~+15 强化、成功率、保护符、属性加成 | `NPC_TAG_BLACKSMITH` |
| 装备分解系统 | 分解返还材料/金币/强化石 | `NPC_TAG_BLACKSMITH` |
| 物品合成系统 | 配方驱动，材料 → 产出 | `NPC_TAG_CRAFT` |
| 仓库系统 | 多页存储、扩展、锁定、存金 | `NPC_TAG_BANK` |

### 1.2 硬约束

1. **服务端权威**：所有数值判定（成功率、消耗、产出、限购）在服务端完成，客户端只做展示与请求。
2. **无 DB 不影响功能**：纯内存模式必须完整可用；MySQL/Redis 仅做持久化增强（对齐 `storage-design.md`）。
3. **向后兼容**：旧存档（`equipJson`/`inventoryJson`）必须能被新系统无损加载（迁移逻辑）。
4. **插件化**：新系统以独立 `.h/.cpp` 模块实现，World 通过 `unique_ptr` 持有，与 `NpcManager`/`QuestSystem` 同级。
5. **协议号不冲突**：严格使用本任务书第五章分配的号段（现有 `0x30`、`0x94` 等已占用）。

### 1.3 设计原则

- **数据驱动**：强化消耗表、分解产出表、合成配方表均为可配置数据（内置默认 + JSON 覆盖 + 编辑器热替换）。
- **装备实例化**：装备（`ItemType::EQUIP`）从「按 itemId 堆叠」升级为「独立实例」，携带强化等级；消耗品/材料/任务道具仍按 itemId 堆叠。
- **确定性随机**：强化成功率、分解产出使用 `util/random.h` 的服务端 RNG，可复现。

---

## 二、现状分析

### 2.1 当前物品/装备/商店模型

```
Entity.pl {
  uint32_t gold;                              // 金币
  std::array<uint32_t, 6> equip;              // 槽位 → itemId（无实例数据）
  std::unordered_map<uint32_t,uint32_t> inventory;  // itemId → 数量（可堆叠）
  uint32_t openShopId;                        // 当前打开的商店
}

GameData { items_, monsters_, shops_, skills_ }   // 配置表（NPC 已迁至 NpcManager）
ShopDef { shopId, name, vector<ShopEntry> }
ShopEntry { itemId, price, stock }

持久化 PlayerSave { gold, equipJson, inventoryJson, questsJson }
协议 inventoryFrame(gold + equip[slot]→itemId + inventory[itemId]→count)
```

### 2.2 核心矛盾：装备无实例

**问题**：装备以 `itemId` 堆叠存储，两把「铁剑(1502)」完全等价、共享一个计数。强化系统要求「这把铁剑是 +7，那把是 +0」，**必须为装备引入唯一实例**。

**结论**：阶段 0 先做**装备实例化改造**，这是后续所有系统的地基。改造范围：
- 数据结构：新增 `ItemInstance`，背包拆分为「实例装备包 + 堆叠物品包」。
- 协议：`inventoryFrame` 增加实例编码（instId + itemId + enhance）。
- 持久化：`inventoryJson` 升级为实例数组格式，保留旧格式迁移读取。
- 客户端：背包/装备渲染读取实例字段，展示强化等级。

### 2.3 已具备的基础

- ✅ NPC 标签路由（`npc.h`：SHOP/BLACKSMITH/CRAFT/BANK）
- ✅ 商店打开/购买链路（`openShop`/`buyItem` + `C2S_SHOP_OPEN`/`C2S_SHOP_BUY`）
- ✅ 物品定义含 `rarity`/`levelReq`/`price`
- ✅ Store 三级降级（内存/MySQL/Redis）
- ✅ 编辑器热替换框架（`applyItems`/`applyNpcs`）
- ✅ 二进制协议 Writer/Reader

---

## 三、架构设计

### 3.1 新增插件模块

```
server/src/game/
├── economy.h / economy.cpp        # 经济系统门面：聚合强化/分解/合成配置表 + 统一入口
├── enhance.h / enhance.cpp        # 装备强化 + 分解（铁匠域）
├── craft.h / craft.cpp            # 物品合成（配方域）
└── warehouse.h / warehouse.cpp    # 仓库系统（存储域，含玩家仓库数据）
```

> 说明：强化与分解同属「铁匠域」，共用材料表与装备实例操作，合并到 `enhance.*`；商店系统在现有 `items.*` 上扩展，不新建模块。

### 3.2 World 集成（与 NpcManager 同模式）

```cpp
// world.h
class World {
  std::unique_ptr<EconomySystem> economy_;   // 强化/分解/合成配置 + 逻辑
  std::unique_ptr<WarehouseSystem> warehouse_; // 仓库（玩家数据存 Entity.pl.warehouse）
public:
  EconomySystem& economy() { return *economy_; }
  WarehouseSystem& warehouse() { return *warehouse_; }
};
```

### 3.3 数据流

```
客户端点击强化 → C2S_ENHANCE(instId) → server.cpp 分发
  → World::enhanceEquip(playerId, instId)
  → EconomySystem::doEnhance(装备实例, 玩家背包/金币, RNG)
  → 判定成功率/扣材料/改 enhance 等级/失败降级
  → recomputeStats(玩家)   // 强化影响属性
  → S2C_ENHANCE(结果) + S2C_INVENTORY(背包刷新) + S2C_STATS(属性刷新)
  → markPlayerDirty(持久化)
```

---

## 四、关键设计决策：装备实例化

### 4.1 ItemInstance 结构

```cpp
// items.h 新增
struct ItemInstance {
  uint64_t instId = 0;      // 全局唯一实例 ID（服务端单调递增分配）
  uint32_t itemId = 0;      // 物品定义 ID（引用 ItemDef）
  uint8_t  enhance = 0;     // 强化等级 0..15
  bool     locked = false;  // 锁定（仓库/背包防误操作）
  // 预留：随机词条（大型网游扩展位）
  // uint32_t affixMask = 0;
};
```

### 4.2 背包重构（Entity.pl）

```cpp
struct {
  double baseHp, baseMp, baseAttack, baseDefense;
  uint32_t gold;
  uint64_t exp;
  // —— 装备实例（新）——
  std::array<uint64_t, 6> equip = {};        // 槽位 → instId（0=空）
  std::vector<ItemInstance> equipBag;         // 背包中的装备实例（不可堆叠）
  // —— 堆叠物品（保留）——
  std::unordered_map<uint32_t,uint32_t> inventory;  // 消耗品/材料/任务道具：itemId → 数量
  uint32_t openShopId;
  // —— 仓库（新，见第八章）——
  WarehouseData warehouse;
} pl;
```

### 4.3 实例 ID 分配

- World 持有 `uint64_t nextInstId_`，`allocInstId()` 单调递增。
- 启动时从存档扫描最大 instId + 1 作为起点（避免重启后 ID 冲突）。
- instId=0 保留为「空/无效」。

### 4.4 装备获取路径改造

所有产出装备的入口都改为「创建实例」：
- 怪物掉落装备 → 生成 `ItemInstance` 掉落物实体（`dropInstId`）。
- 商店购买装备 → 直接入 `equipBag` 新实例。
- 任务奖励装备 → 入 `equipBag` 新实例。
- 合成产出装备 → 入 `equipBag` 新实例。

> 消耗品/材料仍走 `inventory[itemId] += n` 堆叠逻辑，不变。

---

## 五、协议号分配（重新分配，避免冲突）

> ⚠️ 现有占用：C2S `0x01-0x18`/`0x20-0x2B`/`0x30`；S2C `0x81-0x94`/`0xA0-0xA3`/`0xB0-0xB4`/`0xC0-0xC2`/`0xD0-0xD5`。
> 经济系统统一使用 **C2S `0x40-0x4F`**、**S2C `0xE0-0xEF`** 号段。

### 5.1 C2S（客户端 → 服务端）

| 消息 | 号 | Payload |
|------|-----|---------|
| `C2S_SHOP_SELL` | `0x40` | u64 instId（装备）/ u32 itemId + u16 count（堆叠）+ u8 isInstance |
| `C2S_ENHANCE` | `0x41` | u64 instId, u8 useProtect(0/1) |
| `C2S_DECOMPOSE` | `0x42` | u64 instId |
| `C2S_CRAFT_LIST` | `0x43` | u32 npcWid（按 NPC 过滤配方）|
| `C2S_CRAFT` | `0x44` | u32 recipeId, u16 count |
| `C2S_WAREHOUSE_OPEN` | `0x45` | u32 npcWid |
| `C2S_WAREHOUSE_DEPOSIT` | `0x46` | u8 isInstance, u64 instId / u32 itemId, u16 count |
| `C2S_WAREHOUSE_WITHDRAW` | `0x47` | u8 isInstance, u64 instId / u32 itemId, u16 count |
| `C2S_WAREHOUSE_EXPAND` | `0x48` | （无 payload）|

### 5.2 S2C（服务端 → 客户端）

| 消息 | 号 | Payload |
|------|-----|---------|
| `S2C_ENHANCE` | `0xE0` | u8 ok, u64 instId, u8 newLevel, u8 success(0/1), u32 goldLeft |
| `S2C_DECOMPOSE` | `0xE1` | u8 ok, u16 resultCount, [u32 itemId, u16 count]..., u32 goldGain |
| `S2C_CRAFT_LIST` | `0xE2` | u16 count, [CraftRecipeBrief...] |
| `S2C_CRAFT` | `0xE3` | u8 ok, u32 recipeId, u32 resultItemId, u16 resultCount, u8 isInstance, u64 instId |
| `S2C_WAREHOUSE` | `0xE4` | 全量仓库（gold + unlockedSlots + [slot...]）|
| `S2C_WAREHOUSE_RESULT` | `0xE5` | u8 op, u8 code |
| `S2C_SELL_RESULT` | `0xE6` | u8 ok, u32 goldGain |

### 5.3 inventoryFrame 升级（S2C_INVENTORY 复用，扩展 payload）

```
u32 gold
u8  equipCount
  [u8 slot, u64 instId, u32 itemId, u8 enhance]   # 已穿戴（实例）
u16 equipBagCount
  [u64 instId, u32 itemId, u8 enhance, u8 locked]  # 背包装备实例
u16 stackCount
  [u32 itemId, u16 count]                          # 堆叠物品（保留）
```

---

## 六、数据结构定义

### 6.1 商店扩展（items.h）

```cpp
struct ShopEntry {
  uint32_t itemId = 0;
  uint32_t price = 0;          // 原价
  uint32_t discountPrice = 0;  // 折扣价（0=无折扣，>0 时优先）
  uint32_t stock = 0;          // 库存（0=无限）
  uint32_t buyLimit = 0;       // 限购（0=不限，按玩家累计）
  uint8_t  category = 0;       // 0全部 1装备 2消耗品 3材料 4特殊
  uint8_t  refreshType = 0;    // 0不刷新 1每日 2每周（刷新限购/库存）
  uint32_t sellPrice = 0;      // 回收价（0=按 price×sellRate 计算）
};
struct ShopDef {
  uint32_t shopId = 0;
  std::string name;
  std::string desc;
  uint8_t shopType = 0;         // 0普通 1限时 2声望 3货币兑换
  uint32_t currencyItemId = 0;  // 兑换货币（0=金币）
  std::vector<ShopEntry> entries;
};
```

玩家限购追踪（Entity.pl 新增）：
```cpp
std::unordered_map<uint64_t, uint32_t> shopBuyCount; // key=shopId<<32|itemId → 已购数
uint64_t shopRefreshMs = 0;                          // 上次每日/每周刷新时刻
```

### 6.2 强化系统（enhance.h）

```cpp
struct EnhanceLevelDef {
  int level;                 // 目标等级（1..15）
  double successRate;        // 成功率 0..1
  uint32_t goldCost;         // 金币消耗
  uint32_t stoneItemId;      // 强化石 itemId
  uint32_t stoneCount;       // 强化石数量
  int failDegrade;           // 失败降级数（0=不降，负数=掉级）
  bool canProtect;           // 是否可用保护符
};
struct EnhanceConfig {
  int maxLevel = 15;
  uint32_t protectStoneItemId = 4007;  // 保护符 itemId
  double attrPerLevelAtk = 0.08;       // 每级攻击加成 8%
  double attrPerLevelDef = 0.06;       // 每级防御加成 6%
  double attrPerLevelHp  = 0.05;       // 每级生命加成 5%
  std::vector<EnhanceLevelDef> levels; // 15 级消耗/成功率表
};
// 分解
struct DecomposeResult { uint32_t itemId; uint32_t minCount, maxCount; double prob; };
struct DecomposeRule {
  int rarity;                          // 品质 0..4
  double goldReturnRate;               // 金币返还比例
  double enhanceStoneRate;             // 强化石返还系数（× enhance 等级）
  std::vector<DecomposeResult> results;// 材料产出表
};
```

强化属性加成（叠加在 ItemDef 基础上，recomputeStats 时计算）：
```
最终攻击加成 = ItemDef.attackBonus × (1 + enhance × attrPerLevelAtk)
最终防御加成 = ItemDef.defenseBonus × (1 + enhance × attrPerLevelDef)
最终生命加成 = ItemDef.hpBonus × (1 + enhance × attrPerLevelHp)
```

### 6.3 合成系统（craft.h）

```cpp
struct CraftMaterial { uint32_t itemId; uint32_t count; bool isInstance = false; };
struct CraftRecipe {
  uint32_t recipeId;
  std::string name, desc;
  uint8_t  category;             // 1药水 2装备 3材料 4特殊
  uint32_t resultItemId;
  uint32_t resultCount = 1;
  int      resultRarity = -1;    // -1=继承 ItemDef
  bool     resultIsEquip = false;// 产出是否装备（走实例）
  uint32_t goldCost = 0;
  uint32_t craftTimeMs = 0;      // 0=瞬发
  int      playerLevelReq = 1;
  uint32_t npcTagReq = 0;        // 需要的 NPC 标签（0=任意）
  std::vector<CraftMaterial> materials;
};
```

### 6.4 仓库系统（warehouse.h）

```cpp
struct WarehouseSlot {
  bool isInstance = false;   // true=装备实例，false=堆叠物品
  uint64_t instId = 0;       // isInstance 时有效
  uint32_t itemId = 0;       // 堆叠时有效（实例时冗余存 itemId 便于展示）
  uint32_t count = 0;        // 堆叠数量
  uint8_t enhance = 0;       // 实例强化等级
  bool locked = false;
};
struct WarehouseData {
  std::vector<WarehouseSlot> slots;  // 已用格子
  int unlockedSlots = 30;            // 已解锁格子数
  uint32_t gold = 0;                 // 仓库存金
};
struct WarehouseConfig {
  int baseSlots = 30;
  int slotsPerPage = 30;
  int maxPages = 5;                  // 上限 150 格
  uint32_t expandCostBase = 1000;
  double expandCostMul = 1.5;
};
```

### 6.5 新增材料物品（items.cpp loadDefaults）

| itemId | 名称 | 类型 | 用途 |
|--------|------|------|------|
| 4001 | 铁矿石 | MATERIAL | 普通/优秀分解产出、合成材料 |
| 4002 | 钢锭 | MATERIAL | 优秀分解、合成 |
| 4003 | 秘银 | MATERIAL | 稀有分解、高级合成 |
| 4004 | 精金 | MATERIAL | 史诗分解 |
| 4005 | 龙鳞 | MATERIAL | 传说分解 |
| 4006 | 强化石 | MATERIAL | 强化消耗 |
| 4007 | 保护符 | MATERIAL | 强化防降级 |

> 新增 `ItemType::MATERIAL = 4`（区分于装备/消耗品/任务道具，不可穿戴、可堆叠、可交易）。

---

## 七、分阶段实施任务书

> 每阶段独立可编译、可验证；严格按序实施（阶段 0 是地基）。

### 阶段 0：装备实例化改造（地基）⭐

**目标**：装备从 itemId 堆叠升级为独立实例，为强化系统铺路。

**前置依赖**：无。

**任务清单**：
1. `items.h`：新增 `ItemInstance` 结构；新增 `ItemType::MATERIAL = 4`。
2. `entity.h`：`pl.equip` 改为 `std::array<uint64_t,6>`（instId）；新增 `pl.equipBag`（vector<ItemInstance>）；保留 `pl.inventory`（堆叠）。
3. `world.h/cpp`：新增 `allocInstId()`；`nextInstId_` 成员；改造 `equipItem`/`useItem`/`pickup`/掉落生成，装备走实例路径。
4. `protocol.cpp`：`inventoryFrame` 升级为实例编码（见 5.3）；`writeEntityFull` 掉落物增加 `dropInstId`（装备掉落）。
5. `entity.h`：掉落物 `dropInstId`（uint64）字段。
6. `server.cpp`：`serializeEquip`/`serializeInventory`/`applySaveItems` 升级（见第八章持久化）。
7. `protocol.js` + `entities.js` + `boot.js`：客户端解析实例字段，背包装备显示强化等级（初期恒为 +0）。

**验收标准**：
- 编译通过；旧存档能加载（迁移逻辑）。
- 购买/掉落/穿戴装备后，背包中每件装备是独立条目。
- 现有商店购买、装备穿戴、属性计算回归正常。

---

### 阶段 1：商店系统扩展

**目标**：分类、限购、折扣、出售回收。

**前置依赖**：阶段 0。

**任务清单**：
1. `items.h/cpp`：扩展 `ShopEntry`（discountPrice/buyLimit/category/refreshType/sellPrice）；`ShopDef`（desc/shopType/currencyItemId）；`loadFromJson`/`shopsToJson` 支持新字段。
2. `entity.h`：`pl.shopBuyCount` + `pl.shopRefreshMs`。
3. `world.cpp`：`buyItem` 增加限购校验 + 折扣价 + 每日/每周刷新；新增 `sellItem(playerId, isInstance, instId/itemId, count)`（回收：装备按 sellPrice×强化系数，堆叠按 sellPrice）。
4. `protocol.h/cpp`：新增 `C2S_SHOP_SELL`/`S2C_SELL_RESULT`；`shopFrame` 增加新字段编码。
5. `server.cpp`：分发 `C2S_SHOP_SELL`。
6. `client`：商店面板增加分类页签、限购显示、折扣价划线、出售按钮（背包/装备右键出售）。

**验收标准**：
- 限购商品达上限后拒绝购买；折扣价正确结算；每日刷新重置限购。
- 出售装备/物品返还金币，实例从背包移除。

---

### 阶段 2：装备强化系统

**目标**：+0~+15 强化，成功率/保护符/属性加成。

**前置依赖**：阶段 0、阶段 1（材料物品已定义）。

**任务清单**：
1. `enhance.h/cpp`（新建）：`EnhanceConfig`/`EnhanceLevelDef`；`loadDefaults`（15 级表）；`loadFromJson`（enhance.json 覆盖）；`doEnhance(inst, pl, rng)` 核心逻辑。
2. `economy.h/cpp`（新建）：`EconomySystem` 门面，聚合 `EnhanceConfig` + 分解规则 + 合成配方（阶段 3/4 填充）；World 持有。
3. `world.h/cpp`：集成 `economy_`；新增 `enhanceEquip(playerId, instId, useProtect)`；强化后 `recomputeStats`（属性加成公式见 6.2）。
4. `recomputeStats`：装备加成乘以 `(1 + enhance × 系数)`。
5. `protocol.h/cpp`：`C2S_ENHANCE`/`S2C_ENHANCE` 编解码。
6. `server.cpp`：分发 `C2S_ENHANCE`（校验 NPC 距离 + BLACKSMITH 标签）。
7. `client`：铁匠 NPC 对话增加「强化」入口；强化面板（选装备、显示成功率/消耗、强化动画、结果 Toast）；背包装备显示 +N。

**验收标准**：
- 强化消耗金币 + 强化石，成功升级、失败按规则降级（保护符防降）。
- 强化后属性正确提升（攻击/防御/生命）。
- 非铁匠 NPC / 超距拒绝强化。

---

### 阶段 3：装备分解系统

**目标**：分解装备返还材料/金币/强化石。

**前置依赖**：阶段 2（共用 enhance.* 与材料表）。

**任务清单**：
1. `enhance.h/cpp`：新增 `DecomposeRule`/`DecomposeResult`；`loadDefaults`（按品质 5 档规则）；`doDecompose(inst, pl, rng)`。
2. `world.cpp`：新增 `decomposeEquip(playerId, instId)`（校验 BLACKSMITH 标签 + 距离；移除实例；产出材料入 inventory + 金币）。
3. `protocol.h/cpp`：`C2S_DECOMPOSE`/`S2C_DECOMPOSE`。
4. `server.cpp`：分发。
5. `client`：铁匠面板增加「分解」页签（选装备、预览产出、确认分解）。

**验收标准**：
- 分解高强化装备返还更多强化石；品质越高材料越好。
- 已穿戴装备需先卸下才能分解；锁定装备不可分解。

---

### 阶段 4：物品合成系统

**目标**：配方驱动合成（药水/装备/材料）。

**前置依赖**：阶段 0（装备产出走实例）。

**任务清单**：
1. `craft.h/cpp`（新建）：`CraftRecipe`/`CraftMaterial`；`loadDefaults`（内置配方）；`loadFromJson`（craft.json）；`availableRecipes(npcTag, playerLevel)`；`canCraft`/`doCraft`。
2. `economy.h/cpp`：聚合 `craft_`（配方表）。
3. `world.cpp`：新增 `craftItem(playerId, recipeId, count)`（校验材料/金币/等级/NPC 标签；扣材料；产出装备走实例、堆叠走 inventory）。
4. `protocol.h/cpp`：`C2S_CRAFT_LIST`/`C2S_CRAFT`/`S2C_CRAFT_LIST`/`S2C_CRAFT`。
5. `server.cpp`：分发（CRAFT_LIST 按 NPC 过滤，CRAFT 校验距离 + CRAFT 标签）。
6. `client`：炼金 NPC 对话增加「合成」入口；合成面板（配方列表、材料需求高亮缺失、合成按钮、产出提示）。
7. 编辑器：合成配方配置面板（可选，阶段 7）。

**验收标准**：
- 材料齐全才能合成；产出正确（装备实例/堆叠物品）。
- 隐藏/等级不足配方不显示或置灰。

---

### 阶段 5：仓库系统

**目标**：多页存储、扩展、锁定、存金。

**前置依赖**：阶段 0（实例存取）。

**任务清单**：
1. `warehouse.h/cpp`（新建）：`WarehouseSlot`/`WarehouseData`/`WarehouseConfig`；`deposit`/`withdraw`/`expand`/`lock`/`sort`；序列化 `warehouseToJson`/`loadFromJson`。
2. `entity.h`：`pl.warehouse`（WarehouseData）。
3. `world.h/cpp`：集成 `warehouse_`；`openWarehouse`/`depositItem`/`withdrawItem`/`expandWarehouse`（校验 BANK 标签 + 距离 + 金币）。
4. `protocol.h/cpp`：`C2S_WAREHOUSE_OPEN`/`DEPOSIT`/`WITHDRAW`/`EXPAND`；`S2C_WAREHOUSE`/`S2C_WAREHOUSE_RESULT`。
5. `server.cpp`：分发。
6. 持久化：`PlayerSave.warehouseJson`（见第八章）。
7. `client`：银行 NPC 对话增加「仓库」入口；仓库面板（多页切换、格子网格、存入/取出、锁定、扩展按钮、存金）。

**验收标准**：
- 存取装备保留强化等级；堆叠物品正确合并。
- 扩展花费金币递增（1000×1.5^n）；满 150 格拒绝扩展。
- 仓库数据下线/重启后保留（DB 模式）。

---

### 阶段 6：客户端 UI 整合

**目标**：统一经济系统 UI 风格，接入游戏菜单。

**前置依赖**：阶段 1-5。

**任务清单**：
1. `index.html`/`style.css`：强化/分解/合成/仓库面板统一深色 + 金边风格（对齐现有 shop-panel）。
2. `boot.js`：NPC 对话面板按 `npcTag` 动态渲染入口（商店/强化/分解/合成/仓库）。
3. 背包整合：装备显示 +N 强化等级、品质色、锁定标记；右键菜单（穿戴/出售/分解/存仓库）。
4. Toast/动画：强化成功金光、失败灰暗、合成产出提示。

**验收标准**：不同标签 NPC 显示对应功能入口；UI 风格统一；交互流畅无卡顿。

---

### 阶段 7：编辑器配置面板

**目标**：可视化配置强化表/分解表/合成配方/商店。

**前置依赖**：阶段 1-5。

**任务清单**：
1. `editor.html`：新增「强化」「分解」「合成」「商店」配置页签。
2. `editor.js`：表单读写 + 热替换（对齐现有 NPC/物品面板模式）。
3. `server.cpp`：HTTP API `/api/enhance/edit`、`/api/craft/edit`、`/api/shop/edit`（token 鉴权 + applyXxx 热替换 + 落库）。
4. `world.cpp`：`applyEnhance`/`applyCraft`/`applyShop`（委托各子系统 replaceXxx）。

**验收标准**：编辑器修改配置 → 保存 → 服务端热重载生效 → 回读一致。

---

### 阶段 8：测试与验证

**目标**：全链路自动化测试。

**任务清单**：
1. `server/scripts/economy_test.mjs`（新建）：登录 → 购买装备 → 强化（多次）→ 分解 → 合成 → 仓库存取 → 校验金币/背包/属性。
2. 边界测试：限购、库存不足、材料不足、金币不足、满强化、满仓库、锁定装备操作拒绝。
3. 持久化测试：下线重登，强化等级/仓库内容保留。
4. 迁移测试：旧存档（无实例）加载后装备正确转为实例。
5. `wsl make -j4` 零警告编译。

**验收标准**：测试脚本全绿；无内存泄漏（实例 ID 不冲突）；旧存档无损迁移。

---

## 八、持久化改造

### 8.1 PlayerSave 扩展（store.h）

```cpp
struct PlayerSave {
  // ... 现有字段 ...
  std::string equipJson;      // 升级：{"slots":[{"slot":6,"instId":1001,"itemId":1502,"enhance":7}],
                              //        "bag":[{"instId":1002,"itemId":1501,"enhance":0,"locked":false}]}
  std::string inventoryJson;  // 保留：{"2001":5,"4006":3}（堆叠物品）
  std::string warehouseJson;  // 新增：{"gold":0,"unlocked":30,"slots":[...]}
  std::string questsJson;
};
```

### 8.2 向后兼容迁移

`applySaveItems`（server.cpp）读取 `equipJson` 时：
- **新格式**（含 "slots"/"bag" 键）→ 直接解析实例。
- **旧格式**（`{"helm":1001,...}`）→ 为每个 itemId 分配新 instId，enhance=0，构造实例。
- `inventoryJson` 旧格式（itemId→count）保持不变，直接兼容。

### 8.3 MySQL 建表扩展

`player_saves` 表新增 `warehouse_json TEXT` 列（`mysql_store.cpp` 幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，失败静默降级内存）。绑定参数从 11 个增至 12 个。

### 8.4 落盘时机

复用现有 `savePlayerToStore`（周期 100 tick + 下线），新增 `warehouseJson = warehouse_.serialize(pl.warehouse)`。经济操作（强化/分解/合成/存取）后调用 `markPlayerDirty` 触发下次周期落盘。

---

## 九、里程碑与依赖

```
阶段0(地基) ──┬─→ 阶段1(商店) ──→ 阶段2(强化) ──→ 阶段3(分解)
              ├─→ 阶段4(合成)
              └─→ 阶段5(仓库)
                        └─→ 阶段6(UI) ─→ 阶段7(编辑器) ─→ 阶段8(测试)
```

| 里程碑 | 交付内容 | 关键风险 |
|--------|----------|----------|
| M0 | 装备实例化 + 旧档迁移 | 协议/持久化不兼容 → 迁移逻辑必须双格式兼容 |
| M1 | 商店 + 强化 + 分解 | 强化 RNG 可复现性；属性加成公式一致性 |
| M2 | 合成 + 仓库 | 仓库存取保留强化等级；扩展费用递增 |
| M3 | UI + 编辑器 + 测试 | NPC 标签路由正确；热重载一致性 |

### 风险与规避

1. **装备实例化改动面大**：涉及协议/持久化/客户端渲染。规避——阶段 0 独立交付并回归测试现有商店/装备链路。
2. **协议号冲突**：已在本任务书第五章统一分配 `0x40-0x4F`/`0xE0-0xEF`，实施前再次 grep 校验。
3. **instId 重启冲突**：启动扫描存档最大 instId + 1；DB 模式下从所有存档恢复。
4. **帧长上限**：仓库全量帧（150 格）需评估是否超 u16 len（65535B）；超限则分页下发（对齐地形脏通知模式）。
5. **无 DB 模式**：所有新数据在内存模式下重启重置，属预期行为（对齐现有 inventory 语义）。

---

## 十、实施约定

- 每阶段完成后执行 `wsl make -j4` 确保零错误零警告。
- 新增 `.cpp` 由 Makefile `wildcard src/game/*.cpp` 自动纳入，无需改构建脚本。
- 所有新增配置遵循「内置默认 + JSON 覆盖 + 编辑器热替换」三段式（对齐 items/npc）。
- 随机判定统一使用 `util/random.h`，禁止裸 `rand()`。
- 服务端日志前缀：`[shop]`/`[enhance]`/`[decompose]`/`[craft]`/`[warehouse]`。
