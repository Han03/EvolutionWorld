// craft.h - 物品合成系统（配方域：材料 → 产出，按 NPC 标签 + 等级 + 隐藏过滤）
//
// 设计要点（插件模式，由 EconomySystem 聚合、World 持有）：
//  - 数据驱动：data/craft.json 提供配方 + 编辑器热替换（replaceConfig）
//  - 闭环：分解产出的材料(4001-4005)/怪物掉落(3001-3004) → 合成消耗 → 产出药水/装备/材料
//  - 过滤：availableRecipes(npcTagMask, playerLevel) 按 NPC 标签 + 等级 + 隐藏筛选（列表展示）
//  - 权威：doCraft 服务端校验等级/材料/金币并扣除；装备产出走实例（instId 由 world 分配）
//  - 解耦：doCraft 只依赖 gold/inv 引用 + resultIsEquip 标志，不耦合 Entity/GameData（便于单测）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include "util/json.h"
#include "npc.h"   // NPC_TAG_CRAFT

namespace ew {

// ---------- 合成材料需求（单条）----------
struct CraftMaterial {
  uint32_t itemId = 0;   // 材料 itemId（须为可堆叠物品：材料/消耗品/任务道具）
  uint32_t count = 1;    // 需求数量
};

// ---------- 合成配方 ----------
struct CraftRecipe {
  uint32_t recipeId = 0;           // 配方唯一 ID
  std::string name;                // 配方名（默认取产物名）
  uint32_t npcTag = NPC_TAG_CRAFT; // 需要的 NPC 标签位（哪个 NPC 能合成）
  uint32_t resultItemId = 0;       // 产出物品 itemId
  uint32_t resultCount = 1;        // 产出数量（装备恒为 1）
  uint32_t goldCost = 0;           // 金币消耗
  int levelReq = 1;                // 玩家等级需求（不足则列表不显示 + doCraft 拒绝）
  bool hidden = false;             // 隐藏配方（不在列表显示）
  std::vector<CraftMaterial> materials;  // 材料需求表
};

// ---------- 合成结果 ----------
struct CraftOutput {
  bool ok = false;          // 是否成功合成（false=被拒绝，见 failCode）
  // failCode：0=无；1=配方不存在；2=等级不足；3=材料不足；4=金币不足；
  //           6=不在合成 NPC 附近；7=该 NPC 无法合成此配方
  int failCode = 0;
  uint32_t recipeId = 0;
  uint32_t resultItemId = 0;
  uint32_t resultCount = 0;   // 实际产出数量（装备恒为 1）
  bool isInstance = false;    // true=装备产出（走实例，instId 由 world 填）；false=堆叠产出（已入 inv）
  uint64_t instId = 0;        // 装备实例 ID（isInstance 且 world 分配后）
  uint32_t goldCost = 0;      // 实际扣除金币
};

// ---------- 合成系统（插件：配方表 + 核心合成逻辑）----------
class CraftSystem {
public:
  bool loadFromJson(const std::string& dir);    // 从 data/craft.json 加载配方
  std::string configToJson() const;             // 序列化（客户端 /api/gamedata、编辑器用）
  bool replaceConfig(const Json& obj);          // 热替换（编辑器保存）

  const std::vector<CraftRecipe>& recipes() const { return recipes_; }
  // recipeId → 配方（不存在返回 nullptr）
  const CraftRecipe* recipe(uint32_t recipeId) const;
  // 按 NPC 标签 + 玩家等级筛选可用配方（隐藏配方永不返回；等级不足不返回）
  std::vector<const CraftRecipe*> availableRecipes(uint32_t npcTagMask, int playerLevel) const;

  // 是否可合成（不扣除）：返回 failCode（0=可以）。count 用于批量（装备钳制为 1）。
  int canCraft(const CraftRecipe& r, int playerLevel, uint32_t gold,
               const std::unordered_map<uint32_t, uint32_t>& inv, uint32_t count) const;
  // 核心合成：校验（等级/材料/金币）→ 扣材料+金币 → 产出。
  //   resultIsEquip 由调用方（world）从 ItemDef 查得传入（装备→isInstance，堆叠→写 inv）。
  //   装备产出仅置 resultItemId/isInstance，instId 由 world 分配；堆叠产出直接写入 inv。
  CraftOutput doCraft(const CraftRecipe& r, int playerLevel, bool resultIsEquip,
                      uint32_t& gold, std::unordered_map<uint32_t, uint32_t>& inv,
                      uint32_t count) const;

private:
  std::vector<CraftRecipe> recipes_;
};

} // namespace ew
