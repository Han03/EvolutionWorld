// items.h - 物品/属性/商店/配置系统（大型网游规模，数据驱动）
//
//  - 物品：装备（6 槽位）/ 消耗品 / 任务道具，按 ID 管理（名称/描述/缩略图/穿戴属性/价格）
//  - 属性：血量/蓝量/攻击力/防御力；装备影响基础属性（服务端权威计算）
//  - 商店：商店 NPC 出售物品（价格/库存），金币购买
//  - 配置：内置默认数据 + 商店 JSON 覆盖；物品/生物由编辑器热替换，数据库模式持久化
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include "util/json.h"
#include "skills.h"
#include <cmath>

namespace ew {
// 属性系统伤害公式（服务端权威，客户端只展示）：
// 伤害 = 攻击力 × 浮动系数 × 100/(100+防御力)，最低 1 点
inline double calcDamage(double atk, double def, double variance) {
  double base = atk * variance;
  double mitigation = 100.0 / (100.0 + std::max(0.0, def));
  double d = base * mitigation;
  return std::max(1.0, d);
}

// 玩家升级经验曲线（服务端权威，protocol/world 共用）：
// 升到下一级所需经验 = 100 × 1.35^(level-1)（level 1→100, 2→135, 3→182 …）
inline uint32_t playerExpToNext(int level) {
  if (level < 1) level = 1;
  return (uint32_t)(100.0 * std::pow(1.35, (double)(level - 1)));
}

// ---------- 物品类型 ----------
enum class ItemType : uint8_t {
  EQUIP = 1,      // 装备（实例化：每件独立，携带强化等级）
  CONSUMABLE = 2, // 消耗品（可堆叠）
  QUEST = 3,      // 任务道具（可堆叠）
  MATERIAL = 4,   // 材料（可堆叠，强化/分解/合成用）
};

// ---------- 装备实例（大型网游：每件装备独立存在，携带强化等级/锁定） ----------
// 仅 ItemType::EQUIP 走实例化；消耗品/材料/任务道具仍按 itemId 堆叠。
struct ItemInstance {
  uint64_t instId = 0;    // 全局唯一实例 ID（服务端单调递增分配，0=空/无效）
  uint32_t itemId = 0;    // 物品定义 ID（引用 ItemDef）
  uint8_t  enhance = 0;   // 强化等级 0..15（阶段 2 启用，初期恒为 0）
  bool     locked = false;// 锁定（仓库/背包防误操作）
};

// ---------- 装备槽位（上衣/裤子/手套/鞋子/头盔/武器） ----------
enum class EquipSlot : uint8_t {
  HELM = 1,    // 头盔
  CHEST = 2,   // 上衣
  PANTS = 3,   // 裤子
  GLOVES = 4,  // 手套
  BOOTS = 5,   // 鞋子
  WEAPON = 6,  // 武器
};
constexpr int kEquipSlots = 6; // 与槽位一一对应，索引 = 槽位值-1

// ---------- 物品定义（按 ID 管理） ----------
struct ItemDef {
  uint32_t id = 0;
  std::string name;      // 名称
  std::string desc;      // 描述
  std::string icon;      // 缩略图标识（客户端映射为图标/颜色）
  ItemType type = ItemType::EQUIP;
  EquipSlot slot = EquipSlot::WEAPON; // 装备专属
  // 穿戴属性加成
  double hpBonus = 0, mpBonus = 0, attackBonus = 0, defenseBonus = 0;
  // 消耗品效果
  double restoreHp = 0, restoreMp = 0;
  uint32_t price = 0;     // 商店售价（金币）
  uint32_t stackMax = 99; // 单格堆叠上限
  int rarity = 0;         // 品质/稀有度：0普通 1优秀 2稀有 3史诗 4传说（客户端着色展示）
  int levelReq = 1;       // 需求等级（穿戴校验：玩家等级 < levelReq 不可装备）
};

// ---------- 掉落表（怪物配置） ----------
struct DropEntry { uint32_t itemId = 0; double prob = 0.0; }; // prob 0..1（每次击杀独立判定）
struct MonsterDef {
  std::string type;      // 怪物类型 key（配置文件/程序内引用；亦即生物「ID」）
  std::string name;
  std::string desc;      // 描述（编辑器配置，客户端展示）
  int level = 1;
  double hp = 50, mp = 20, attack = 8, defense = 2;
  double moveSpeed = 1.5;            // 移动速度（写入 Entity.ai.speed；对齐 makeMonster 默认 1.5）
  uint32_t expReward = 0;            // 击杀奖励经验（接入玩家升级系统）
  uint32_t goldMin = 1, goldMax = 3;   // 击杀掉落金币区间
  std::vector<DropEntry> drops;        // 掉落物品概率表
  double dropRadius = 1.6;             // 掉落物散布半径
  std::vector<uint32_t> skillIds;      // 该怪物类型可用的技能 ID
  // ---- Boss 扩展（isBoss=true 时使用以下字段覆盖 Config 全局默认值）----
  bool isBoss = false;                 // Boss 标志
  double aggroRange = 18.0;            // Boss 仇恨侦测范围（米）
  double chaseSpeed = 3.0;             // Boss 追击速度（m/s）
  double attackRange = 2.5;            // Boss 攻击范围（米，覆盖怪物默认值）
};

// ---------- NPC 定义已移至 npc.h（NPC 插件模块） ----------
// NpcDef 和 NpcTag 现在由 NpcManager 统一管理（见 npc.h）

// ---------- 商店配置（阶段1扩展：折扣/限购/分类/刷新/回收） ----------
struct ShopEntry {
  uint32_t itemId = 0;
  uint32_t price = 0;          // 原价
  uint32_t discountPrice = 0;  // 折扣价（0=无折扣，>0 时优先结算）
  uint32_t stock = 0;          // 库存（0=无限）
  uint32_t buyLimit = 0;       // 限购（0=不限；按玩家累计，refreshType 周期重置）
  uint8_t  category = 0;       // 0自动(按物品类型) 1装备 2消耗品 3材料 4特殊
  uint8_t  refreshType = 0;    // 0不刷新 1每日 2每周（周期重置 buyLimit 计数）
  uint32_t sellPrice = 0;      // 回收价（0=按 ItemDef.price×默认回收率）
};
struct ShopDef {
  uint32_t shopId = 0;
  std::string name;
  std::string desc;             // 商店描述
  uint8_t shopType = 0;         // 0普通 1限时 2声望 3货币兑换
  uint32_t currencyItemId = 0;  // 兑换货币 itemId（0=金币）
  std::vector<ShopEntry> entries;
};

// ---------- 游戏数据表（配置系统） ----------
class GameData {
public:
  void loadDefaults();   // 内嵌默认数据（无配置文件兜底，保证任何环境可运行）
  bool loadFromJson(const std::string& dir); // 可选外部配置覆盖（失败仅告警，用默认）

  const ItemDef* item(uint32_t id) const;
  const std::unordered_map<uint32_t, ItemDef>& items() const { return items_; }
  const MonsterDef* monster(const std::string& type) const;
  const std::unordered_map<std::string, MonsterDef>& monsters() const { return monsters_; }
  // NPC 查询已委托给 NpcManager（见 World::npcs()）
  const ShopDef* shop(uint32_t shopId) const;
  const std::unordered_map<uint32_t, ShopDef>& shops() const { return shops_; }
  // 商店条目（用于 S2C_SHOP 编码）
  const std::vector<ShopEntry>* shopEntries(uint32_t shopId) const;
  // ---- 技能表（技能系统，数据驱动）----
  const SkillDef* skill(uint32_t id) const;
  const std::unordered_map<uint32_t, SkillDef>& skills() const { return skills_; }
  // 默认起始技能（新玩家自动习得，用于开箱即测）
  const std::vector<uint32_t>& starterSkills() const { return starterSkills_; }

  // 槽位工具
  static const char* slotName(EquipSlot s);    // "头盔/上衣/…"
  static const char* slotKey(EquipSlot s);     // "helm/chest/…"
  static bool slotIndex(EquipSlot s, int& idx); // 0..5（equip 数组下标）
  static EquipSlot indexSlot(int idx);

  static ItemType itemTypeFromJson(const Json& j, ItemType def);
  static EquipSlot slotFromJson(const Json& j, EquipSlot def);
  // 反查：枚举 → JSON 字符串（序列化用，与上面两个互逆）
  static const char* itemTypeToString(ItemType t);
  static const char* slotToString(EquipSlot s);

  // ---- 序列化 / 热替换（世界编辑器物品·生物配置用） ----
  std::string itemsToJson() const;    // ItemDef 数组（字段与 loadFromJson 对齐）
  std::string monstersToJson() const; // MonsterDef 对象（键=type）
  std::string shopsToJson() const;    // ShopDef 对象（键=shopId，含扩展字段，与 shop.json 对齐）
  // NPC 序列化已委托给 NpcManager（见 World::npcs()）
  bool replaceItems(const Json& arr);    // 清空并用完整数组重填 items_
  bool replaceMonsters(const Json& obj); // 清空并用完整对象重填 monsters_
  bool replaceShops(const Json& obj);    // 清空并用完整对象重填 shops_（键=shopId，字段与 shop.json 对齐）

private:
  void addDefaultItem(uint32_t id, const char* name, const char* desc, const char* icon,
                      ItemType type, EquipSlot slot, double hp, double mp, double atk, double def,
                      double rHp, double rMp, uint32_t price, uint32_t stack = 99);
  void addDefaultMonster(const char* type, const char* name, int level, double hp, double mp,
                         double atk, double def, uint32_t gMin, uint32_t gMax);
  void addDefaultSkill(uint32_t id, const char* name, const char* desc, const char* icon,
                       SkillTarget target, SkillEffect effect, double mana, uint32_t cdMs,
                       double range, double radius, double dmgMul, double flatDmg, double heal,
                       BuffType buffType, double buffValue, double buffDur, double lifesteal,
                       uint16_t castTimeMs = 0, bool cancelOnMove = true, bool cancelOnHit = true,
                       double knockback = 0, bool superArmor = false);
  std::unordered_map<uint32_t, ItemDef> items_;
  std::unordered_map<std::string, MonsterDef> monsters_;
  // NPC 数据已委托给 NpcManager（见 npc.h）
  std::unordered_map<uint32_t, ShopDef> shops_;
  std::unordered_map<uint32_t, SkillDef> skills_;
  std::vector<uint32_t> starterSkills_;
};

} // namespace ew
