// warehouse.h - 仓库系统（存储域：多页格子 + 装备实例/堆叠物品存取 + 扩展 + 存金）
//
// 设计要点（无状态逻辑，玩家数据存 Entity.pl.warehouse，由 World 持有 WarehouseSystem 提供配置+操作）：
//  - 数据分离：WarehouseSystem 只持有全局配置（cfg_）；每个玩家的仓库数据是 WarehouseData（随存档持久化）
//  - 装备保真：装备实例存入保留 instId/enhance/locked，取出原样恢复 → 强化等级不丢失
//  - 堆叠合并：同 itemId 的堆叠物品存入合并到已有格子（验收标准「堆叠物品正确合并」）
//  - 多页扩展：unlocked 格子数按页递增（initialSlots + n×slotsPerPage），费用 expandBaseCost×expandCostMul^n
//  - 存金约定：itemId==0 && !isInstance 视为金币存取（amount=count），pl.gold ↔ wh.gold
//  - 解耦：deposit/withdraw 只依赖 gold/equipBag/inv 引用，不耦合 Entity/GameData（便于单测）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include "util/json.h"
#include "items.h"   // ItemInstance

namespace ew {

// ---------- 仓库格子（统一装备实例与堆叠物品）----------
struct WarehouseSlot {
  bool isInstance = false;   // true=装备实例（保留 instId/enhance/locked）；false=堆叠物品
  uint64_t instId = 0;       // 装备实例 ID（isInstance 时有效，全局唯一）
  uint32_t itemId = 0;       // 物品定义 ID
  uint8_t enhance = 0;       // 强化等级 0..15（装备实例）
  bool locked = false;       // 锁定（装备实例防误操作）
  uint32_t count = 0;        // 堆叠数量（!isInstance 时有效；装备恒为 1）
};

// ---------- 玩家仓库数据（存 Entity.pl.warehouse，随存档持久化）----------
struct WarehouseData {
  uint32_t gold = 0;                 // 存金（仓库金币，独立于 pl.gold）
  uint32_t unlocked = 0;             // 已解锁格子数（0=未初始化，首次操作时 ensureInit 置 initialSlots）
  std::vector<WarehouseSlot> slots;  // 已占用格子（紧凑存储，size ≤ unlocked）
};

// ---------- 仓库配置（全局，data/warehouse.json + 编辑器热替换）----------
struct WarehouseConfig {
  uint32_t initialSlots = 30;      // 初始格子数（1 页）
  uint32_t slotsPerPage = 30;      // 每页格子数（扩展每次 +1 页）
  uint32_t maxSlots = 150;         // 最大格子数（5 页；满则拒绝扩展）
  uint32_t expandBaseCost = 1000;  // 扩展基础费用
  double expandCostMul = 1.5;      // 扩展费用递增系数（cost = base × mul^n）
  uint32_t maxGold = 100000000;    // 存金上限（1 亿）
};

// ---------- 仓库操作码（S2C_WAREHOUSE_RESULT 的 op）----------
enum WarehouseOp : uint8_t {
  WH_OP_OPEN = 0, WH_OP_DEPOSIT = 1, WH_OP_WITHDRAW = 2, WH_OP_EXPAND = 3, WH_OP_LOCK = 4,
};
// ---------- 仓库结果码（S2C_WAREHOUSE_RESULT 的 code；0=成功）----------
enum WarehouseCode : uint8_t {
  WH_OK = 0,          // 成功
  WH_FULL = 1,        // 仓库已满（无空格子）
  WH_NOT_FOUND = 2,   // 物品不存在（instId/itemId 在来源找不到）
  WH_NO_GOLD = 3,     // 金币不足（扩展/取金）
  WH_MAX_SLOTS = 4,   // 已达最大格子（拒绝扩展）
  WH_NO_NPC = 5,      // 不在银行 NPC 附近
  WH_BAD_COUNT = 6,   // 数量非法（0 或超过持有）
  WH_LOCKED = 7,      // 锁定物品不可操作
  WH_GOLD_LIMIT = 8,  // 超过存金上限
};

// ---------- 仓库系统（配置 + 无状态操作逻辑，玩家数据以 WarehouseData& 传入）----------
class WarehouseSystem {
public:
  bool loadFromJson(const std::string& dir);    // 从 data/warehouse.json 加载配置
  std::string configToJson() const;             // 序列化配置（客户端 /api/gamedata、编辑器用）
  bool replaceConfig(const Json& obj);          // 热替换（编辑器保存）
  const WarehouseConfig& config() const { return cfg_; }

  // 首次使用初始化（unlocked==0 → initialSlots；幂等）
  void ensureInit(WarehouseData& wh) const;
  // 当前扩展费用（expandBaseCost×expandCostMul^n，n=已扩展页数）；已满 maxSlots 返回 0
  uint32_t expandCost(const WarehouseData& wh) const;
  // 剩余空格子数（unlocked - slots.size()）
  uint32_t freeSlots(const WarehouseData& wh) const;

  // 存入：isInstance→装备实例（从 equipBag 移除 instId，保留 enhance/locked）；
  //       !isInstance && itemId==0→存金（amount=count）；否则堆叠物品（从 inv 扣 count，同 itemId 合并）。
  //   返回 WarehouseCode。playerGold 为玩家身上金币引用（存金时扣减）。
  uint8_t deposit(WarehouseData& wh, uint32_t& playerGold, bool isInstance, uint64_t instId,
                  uint32_t itemId, uint32_t count, std::vector<ItemInstance>& equipBag,
                  std::unordered_map<uint32_t, uint32_t>& inv) const;
  // 取出：isInstance→装备实例（回 equipBag）；!isInstance && itemId==0→取金；否则堆叠物品（回 inv）。
  uint8_t withdraw(WarehouseData& wh, uint32_t& playerGold, bool isInstance, uint64_t instId,
                   uint32_t itemId, uint32_t count, std::vector<ItemInstance>& equipBag,
                   std::unordered_map<uint32_t, uint32_t>& inv) const;
  // 扩展：扣金币（expandCost），unlocked += slotsPerPage（钳制 maxSlots）；满/金币不足拒绝。
  uint8_t expand(WarehouseData& wh, uint32_t& playerGold) const;
  // 锁定/解锁格子（装备实例）：slotIndex 越界或非装备返回 WH_NOT_FOUND。
  uint8_t lock(WarehouseData& wh, uint32_t slotIndex, bool doLock) const;
  // 整理：装备实例在前（按 itemId 升序），堆叠物品在后（按 itemId 升序），稳定排序。
  void sort(WarehouseData& wh) const;

  // ---- 持久化（pl.warehouse ↔ JSON 字符串，供 server.cpp savePlayerToStore/applySaveItems）----
  std::string serialize(const WarehouseData& wh) const;
  bool deserialize(const std::string& json, WarehouseData& wh) const;

private:
  WarehouseConfig cfg_;
};

} // namespace ew
