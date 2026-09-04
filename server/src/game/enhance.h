// enhance.h - 装备强化 + 分解系统（铁匠域：+0~+15 强化 / 品质分档分解产出）
//
// 设计要点（插件模式，由 EconomySystem 聚合、World 持有 unique_ptr）：
//  - 数据驱动：内置 15 级消耗/成功率表 + enhance.json 覆盖 + 编辑器热替换（replaceConfig）
//  - 确定性随机：成功率判定使用服务端 Mulberry32 RNG，可复现；测试用 forceOutcome 旁路
//  - 装备实例：强化作用于 ItemInstance.enhance（0..maxLevel）；失败按 failDegrade 降级，保护符可防降
//  - 属性加成：recomputeStats 时按 ItemDef 加成 ×(1 + enhance × attrPerLevel) 叠加（见 world.cpp）
//  - 材料解耦：doEnhance 只依赖 ItemInstance + 金币/背包堆叠引用，不耦合 Entity（便于单测）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <utility>
#include <unordered_map>
#include "util/json.h"
#include "util/random.h"
#include "items.h"   // ItemInstance

namespace ew {

// ---------- 单级强化定义（目标等级 targetLevel = 当前等级 + 1） ----------
struct EnhanceLevelDef {
  int level = 1;               // 目标等级（1..maxLevel）
  double successRate = 1.0;    // 成功率 0..1
  uint32_t goldCost = 0;       // 金币消耗
  uint32_t stoneItemId = 4006; // 强化石 itemId
  uint32_t stoneCount = 1;     // 强化石消耗数量
  int failDegrade = 0;         // 失败降级数（0=不降，负数=掉级，如 -1）
  bool canProtect = false;     // 是否可用保护符防降级
};

// ---------- 强化全局配置 ----------
struct EnhanceConfig {
  int maxLevel = 15;
  uint32_t stoneItemId = 4006;         // 强化石 itemId
  uint32_t protectStoneItemId = 4007;  // 保护符 itemId
  double attrPerLevelAtk = 0.08;       // 每级攻击加成系数（+8%/级）
  double attrPerLevelDef = 0.06;       // 每级防御加成系数（+6%/级）
  double attrPerLevelHp  = 0.05;       // 每级生命加成系数（+5%/级）
  std::vector<EnhanceLevelDef> levels; // 等级表（levels[i] 对应目标等级 i+1）
};

// ---------- 强化结果 ----------
struct EnhanceResult {
  bool ok = false;        // 流程是否有效执行（false=被拒绝，见 failCode）
  bool success = false;   // 强化是否成功（仅 ok=true 时有意义）
  int newLevel = 0;       // 强化后的装备等级
  uint32_t goldLeft = 0;  // 强化后剩余金币
  // failCode：0=无；1=已满级；2=金币不足；3=强化石不足；4=保护符不足；7=实例无效/非装备
  int failCode = 0;
};

// ---------- 分解产出（单条材料：概率 + 数量区间）----------
struct DecomposeResult {
  uint32_t itemId = 0;         // 产出物品 itemId（材料）
  uint32_t minCount = 1;       // 最小数量
  uint32_t maxCount = 1;       // 最大数量
  double prob = 1.0;           // 产出概率 0..1（1.0=必出）
};
// ---------- 分解规则（按品质 0..4 一档）----------
struct DecomposeRule {
  int rarity = 0;                    // 品质 0普通 1优秀 2稀有 3史诗 4传说
  double goldReturnRate = 0.3;       // 金币返还比例（× ItemDef.price）
  double enhanceStoneRate = 0.5;     // 强化石返还系数（× enhance 等级，向下取整）
  std::vector<DecomposeResult> results;  // 材料产出表
};
// ---------- 分解全局配置 ----------
struct DecomposeConfig {
  uint32_t stoneItemId = 4006;       // 返还强化石 itemId
  std::vector<DecomposeRule> rules;  // 按品质索引（rules[r].rarity == r）
};
// ---------- 分解产出结果 ----------
struct DecomposeOutput {
  bool ok = false;         // 是否成功分解（false=被拒绝，见 failCode）
  // failCode：0=无；1=锁定不可分解；2=实例无效/非装备；3=无匹配规则；4=已穿戴需先卸下；6=不在铁匠附近
  int failCode = 0;
  uint32_t goldGain = 0;   // 返还金币
  std::vector<std::pair<uint32_t, uint32_t>> items;  // 产出清单 (itemId, count)
};

// ---------- 强化系统（插件：配置表 + 核心强化逻辑） ----------
class EnhanceSystem {
public:
  void loadDefaults();                          // 内置 15 级消耗/成功率表
  bool loadFromJson(const std::string& dir);    // 可选 enhance.json 覆盖
  std::string configToJson() const;             // 序列化（客户端 /api/gamedata、编辑器用）
  bool replaceConfig(const Json& obj);          // 热替换（编辑器保存）
  bool replaceDecomposeConfig(const Json& obj); // 分解配置热替换（编辑器分解面板，格式同 decomposeConfigToJson）

  const EnhanceConfig& config() const { return cfg_; }
  // 目标等级 → 定义（越界返回 nullptr）
  const EnhanceLevelDef* levelDef(int targetLevel) const;

  // 核心强化：
  //   inst   装备实例引用（成功升级 / 失败降级直接改 inst.enhance）
  //   gold   金币引用（扣除 goldCost）
  //   inv    堆叠背包引用（扣除强化石 / 保护符）
  //   rng    服务端确定性 RNG
  //   useProtect 请求消耗保护符防降级（需 levelDef.canProtect 且背包有保护符）
  //   forceOutcome 0=正常判定 / 1=强制成功 / 2=强制失败（测试旁路）
  EnhanceResult doEnhance(ItemInstance& inst, uint32_t& gold,
                          std::unordered_map<uint32_t, uint32_t>& inv,
                          Mulberry32& rng, bool useProtect, int forceOutcome = 0) const;

  // ---------- 装备分解（阶段3，铁匠域）----------
  const DecomposeConfig& decomposeConfig() const { return decfg_; }
  // 品质 → 分解规则（越界钳制到有效档；无规则返回 nullptr）
  const DecomposeRule* decomposeRule(int rarity) const;
  // 核心分解：读 inst（enhance/locked），按 rarity 规则产出材料 + 金币 + 强化石，写入 gold/inv。
  //   rarity/basePrice 由调用方（world）从 ItemDef 查得传入，保持与 GameData 解耦。
  //   锁定实例拒绝（failCode=1）。返回 DecomposeOutput（含产出清单，供 S2C_DECOMPOSE）。
  DecomposeOutput doDecompose(const ItemInstance& inst, int rarity, uint32_t basePrice,
                              uint32_t& gold, std::unordered_map<uint32_t, uint32_t>& inv,
                              Mulberry32& rng) const;
  std::string decomposeConfigToJson() const;   // 序列化（客户端预览、编辑器用）

private:
  EnhanceConfig cfg_;
  DecomposeConfig decfg_;   // 分解规则（按品质 0..4）
};

} // namespace ew
