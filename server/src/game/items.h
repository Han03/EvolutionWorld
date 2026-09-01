// items.h - 物品/属性/商店/配置系统（大型网游规模，数据驱动）
//
//  - 物品：装备（6 槽位）/ 消耗品 / 任务道具，按 ID 管理（名称/描述/缩略图/穿戴属性/价格）
//  - 属性：血量/蓝量/攻击力/防御力；装备影响基础属性（服务端权威计算）
//  - 商店：商店 NPC 出售物品（价格/库存），金币购买
//  - 配置：内置默认数据 + 可选 JSON 文件覆盖（data/items.json / monsters.json / shop.json）
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

// ---------- 物品类型 ----------
enum class ItemType : uint8_t {
  EQUIP = 1,      // 装备
  CONSUMABLE = 2, // 消耗品
  QUEST = 3,      // 任务道具
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
};

// ---------- 掉落表（怪物配置） ----------
struct DropEntry { uint32_t itemId = 0; double prob = 0.0; }; // prob 0..1（每次击杀独立判定）
struct MonsterDef {
  std::string type;      // 怪物类型 key（配置文件/程序内引用）
  std::string name;
  int level = 1;
  double hp = 50, mp = 20, attack = 8, defense = 2;
  uint32_t goldMin = 1, goldMax = 3;   // 击杀掉落金币区间
  std::vector<DropEntry> drops;        // 掉落物品概率表
  double dropRadius = 1.6;             // 掉落物散布半径
};

// ---------- 商店配置 ----------
struct ShopEntry { uint32_t itemId = 0; uint32_t price = 0; uint32_t stock = 0; }; // stock=0 无限
struct ShopDef {
  uint32_t shopId = 0;
  std::string name;
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
                       uint16_t castTimeMs = 0, bool cancelOnMove = true, bool cancelOnHit = true);
  std::unordered_map<uint32_t, ItemDef> items_;
  std::unordered_map<std::string, MonsterDef> monsters_;
  std::unordered_map<uint32_t, ShopDef> shops_;
  std::unordered_map<uint32_t, SkillDef> skills_;
  std::vector<uint32_t> starterSkills_;
};

} // namespace ew
