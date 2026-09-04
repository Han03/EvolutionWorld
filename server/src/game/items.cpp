// items.cpp - 物品/属性/商店/配置系统实现（内置默认数据 + JSON 覆盖）
#include "items.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <algorithm>

namespace ew {

// ---------- 槽位工具 ----------
const char* GameData::slotName(EquipSlot s) {
  switch (s) {
    case EquipSlot::HELM: return "头盔";
    case EquipSlot::CHEST: return "上衣";
    case EquipSlot::PANTS: return "裤子";
    case EquipSlot::GLOVES: return "手套";
    case EquipSlot::BOOTS: return "鞋子";
    default: return "武器";
  }
}
const char* GameData::slotKey(EquipSlot s) {
  switch (s) {
    case EquipSlot::HELM: return "helm";
    case EquipSlot::CHEST: return "chest";
    case EquipSlot::PANTS: return "pants";
    case EquipSlot::GLOVES: return "gloves";
    case EquipSlot::BOOTS: return "boots";
    default: return "weapon";
  }
}
bool GameData::slotIndex(EquipSlot s, int& idx) {
  int v = (int)s;
  if (v < (int)EquipSlot::HELM || v > (int)EquipSlot::WEAPON) return false;
  idx = v - 1;
  return true;
}
EquipSlot GameData::indexSlot(int idx) {
  return (EquipSlot)((int)EquipSlot::HELM + idx);
}
ItemType GameData::itemTypeFromJson(const Json& j, ItemType def) {
  const std::string& t = j.asString();
  if (t == "equip") return ItemType::EQUIP;
  if (t == "consumable") return ItemType::CONSUMABLE;
  if (t == "quest") return ItemType::QUEST;
  if (t == "material") return ItemType::MATERIAL;
  return def;
}
EquipSlot GameData::slotFromJson(const Json& j, EquipSlot def) {
  const std::string& s = j.asString();
  if (s == "helm") return EquipSlot::HELM;
  if (s == "chest") return EquipSlot::CHEST;
  if (s == "pants") return EquipSlot::PANTS;
  if (s == "gloves") return EquipSlot::GLOVES;
  if (s == "boots") return EquipSlot::BOOTS;
  if (s == "weapon") return EquipSlot::WEAPON;
  return def;
}
const char* GameData::itemTypeToString(ItemType t) {
  switch (t) {
    case ItemType::CONSUMABLE: return "consumable";
    case ItemType::QUEST: return "quest";
    case ItemType::MATERIAL: return "material";
    default: return "equip";
  }
}
const char* GameData::slotToString(EquipSlot s) { return slotKey(s); }

// ---------- 查询 ----------
const ItemDef* GameData::item(uint32_t id) const {
  auto it = items_.find(id);
  return it == items_.end() ? nullptr : &it->second;
}
const MonsterDef* GameData::monster(const std::string& type) const {
  auto it = monsters_.find(type);
  return it == monsters_.end() ? nullptr : &it->second;
}
const ShopDef* GameData::shop(uint32_t shopId) const {
  auto it = shops_.find(shopId);
  return it == shops_.end() ? nullptr : &it->second;
}
const std::vector<ShopEntry>* GameData::shopEntries(uint32_t shopId) const {
  const ShopDef* s = shop(shopId);
  return s ? &s->entries : nullptr;
}
// ---------- 技能表 ----------
const SkillDef* GameData::skill(uint32_t id) const {
  auto it = skills_.find(id);
  return it == skills_.end() ? nullptr : &it->second;
}

// ---------- 内置默认数据（兜底；可在 data/*.json 覆盖） ----------
void GameData::addDefaultItem(uint32_t id, const char* name, const char* desc, const char* icon,
                              ItemType type, EquipSlot slot, double hp, double mp, double atk, double def,
                              double rHp, double rMp, uint32_t price, uint32_t stack) {
  ItemDef d;
  d.id = id; d.name = name; d.desc = desc; d.icon = icon;
  d.type = type; d.slot = slot;
  d.hpBonus = hp; d.mpBonus = mp; d.attackBonus = atk; d.defenseBonus = def;
  d.restoreHp = rHp; d.restoreMp = rMp;
  d.price = price; d.stackMax = stack;
  items_[id] = d;
}
void GameData::addDefaultMonster(const char* type, const char* name, int level, double hp, double mp,
                                 double atk, double def, uint32_t gMin, uint32_t gMax) {
  MonsterDef d;
  d.type = type; d.name = name; d.level = level;
  d.hp = hp; d.mp = mp; d.attack = atk; d.defense = def;
  d.goldMin = gMin; d.goldMax = gMax;
  monsters_[type] = d;
}
void GameData::addDefaultSkill(uint32_t id, const char* name, const char* desc, const char* icon,
                               SkillTarget target, SkillEffect effect, double mana, uint32_t cdMs,
                               double range, double radius, double dmgMul, double flatDmg, double heal,
                               BuffType buffType, double buffValue, double buffDur, double lifesteal,
                               uint16_t castTimeMs, bool cancelOnMove, bool cancelOnHit,
                               double knockback, bool superArmor) {
  SkillDef s;
  s.id = id; s.name = name; s.desc = desc; s.icon = icon;
  s.target = target; s.effect = effect;
  s.manaCost = mana; s.cooldownMs = cdMs;
  s.range = range; s.radius = radius;
  s.dmgMul = dmgMul; s.flatDmg = flatDmg; s.heal = heal;
  s.buffType = buffType; s.buffValue = buffValue; s.buffDurSec = buffDur;
  s.lifesteal = lifesteal;
  s.castTimeMs = castTimeMs;
  s.castCancelOnMove = cancelOnMove;
  s.castCancelOnHit = cancelOnHit;
  s.knockback = knockback;
  s.superArmor = superArmor;
  skills_[id] = s;
}
void GameData::loadDefaults() {
  // ---- 装备：6 槽位各 2 档（新手/精良） ----
  // 头盔
  addDefaultItem(1001, "皮帽", "轻便的皮质头盔，+1 防御", "helm1", ItemType::EQUIP, EquipSlot::HELM, 0, 0, 0, 1, 0, 0, 8);
  addDefaultItem(1002, "铁盔", "精钢锻造的头盔，+3 防御 +10 生命", "helm2", ItemType::EQUIP, EquipSlot::HELM, 10, 0, 0, 3, 0, 0, 30);
  // 上衣
  addDefaultItem(1101, "布衣", "普通布质上衣，+1 防御", "chest1", ItemType::EQUIP, EquipSlot::CHEST, 0, 0, 0, 1, 0, 0, 10);
  addDefaultItem(1102, "锁子甲", "精良锁子甲，+3 防御 +15 生命", "chest2", ItemType::EQUIP, EquipSlot::CHEST, 15, 0, 0, 3, 0, 0, 35);
  // 裤子
  addDefaultItem(1201, "皮裤", "轻便皮裤，+1 防御", "pants1", ItemType::EQUIP, EquipSlot::PANTS, 0, 0, 0, 1, 0, 0, 9);
  addDefaultItem(1202, "钢裤", "精钢护腿，+2 防御 +5 生命", "pants2", ItemType::EQUIP, EquipSlot::PANTS, 5, 0, 0, 2, 0, 0, 28);
  // 手套
  addDefaultItem(1301, "皮手套", "灵活皮手套，+1 攻击", "gloves1", ItemType::EQUIP, EquipSlot::GLOVES, 0, 0, 1, 0, 0, 0, 9);
  addDefaultItem(1302, "钢手套", "精钢护手，+2 攻击 +5 生命", "gloves2", ItemType::EQUIP, EquipSlot::GLOVES, 5, 0, 2, 0, 0, 0, 28);
  // 鞋子
  addDefaultItem(1401, "皮靴", "轻快皮靴，+1 防御", "boots1", ItemType::EQUIP, EquipSlot::BOOTS, 0, 0, 0, 1, 0, 0, 8);
  addDefaultItem(1402, "钢靴", "精钢战靴，+2 防御 +5 生命", "boots2", ItemType::EQUIP, EquipSlot::BOOTS, 5, 0, 0, 2, 0, 0, 26);
  // 武器
  addDefaultItem(1501, "青铜剑", "新手青铜剑，+2 攻击", "weapon1", ItemType::EQUIP, EquipSlot::WEAPON, 0, 0, 2, 0, 0, 0, 12);
  addDefaultItem(1502, "铁剑", "锋利的铁剑，+5 攻击", "weapon2", ItemType::EQUIP, EquipSlot::WEAPON, 0, 0, 5, 0, 0, 0, 40);
  addDefaultItem(1503, "烈焰剑", "附魔烈焰之剑，+9 攻击 +10 生命", "weapon3", ItemType::EQUIP, EquipSlot::WEAPON, 10, 0, 9, 0, 0, 0, 120);

  // ---- 消耗品 ----
  addDefaultItem(2001, "小血瓶", "恢复 30 点生命", "hp1", ItemType::CONSUMABLE, EquipSlot::WEAPON, 0, 0, 0, 0, 30, 0, 5, 20);
  addDefaultItem(2002, "大血瓶", "恢复 80 点生命", "hp2", ItemType::CONSUMABLE, EquipSlot::WEAPON, 0, 0, 0, 0, 80, 0, 15, 20);
  addDefaultItem(2101, "小蓝瓶", "恢复 30 点法力", "mp1", ItemType::CONSUMABLE, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 30, 5, 20);
  addDefaultItem(2102, "大蓝瓶", "恢复 80 点法力", "mp2", ItemType::CONSUMABLE, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 80, 15, 20);

  // ---- 任务道具（怪物掉落，可卖钱/留作任务） ----
  addDefaultItem(3001, "狼牙", "野狼的獠牙，可卖钱", "fang", ItemType::QUEST, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 4, 50);
  addDefaultItem(3002, "哥布林徽记", "哥布林首领的徽记", "badge", ItemType::QUEST, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 8, 50);
  addDefaultItem(3003, "骷髅碎片", "骷髅兵的骨片，蕴含魔力", "bone", ItemType::QUEST, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 12, 50);
  addDefaultItem(3004, "石像鬼之核", "石像鬼的能量核心，稀有", "core", ItemType::QUEST, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 25, 50);

  // ---- 材料（强化/分解/合成用；不可穿戴、可堆叠、可交易）----
  // 分解产出材料（按品质分档 4001-4005；亦为阶段4合成原料）
  addDefaultItem(4001, "铁屑", "分解普通装备得到的碎料", "iron", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 3, 99);
  addDefaultItem(4002, "精钢碎片", "分解优秀装备得到的材料", "steel", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 8, 99);
  addDefaultItem(4003, "魔晶", "分解稀有装备凝聚的魔力结晶", "crystal", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 20, 99);
  addDefaultItem(4004, "龙鳞", "分解史诗装备获得的珍贵材料", "scale", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 50, 99);
  addDefaultItem(4005, "星辰核心", "分解传说装备得到的稀世之物", "starcore", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 120, 99);
  // 强化石：每次强化按等级消耗若干；保护符：强化失败时消耗 1 个可防止装备降级。
  addDefaultItem(4006, "强化石", "装备强化的必需材料，等级越高消耗越多", "estone", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 50, 99);
  addDefaultItem(4007, "保护符", "强化失败时防止装备降级（仅 +6 起可用）", "protect", ItemType::MATERIAL, EquipSlot::WEAPON, 0, 0, 0, 0, 0, 0, 200, 99);

  // ---- 品质/需求等级示例（其余默认 rarity=0 / levelReq=1） ----
  items_[1002].rarity = 1; items_[1002].levelReq = 2;  // 铁盔
  items_[1102].rarity = 1; items_[1102].levelReq = 2;  // 锁子甲
  items_[1502].rarity = 1; items_[1502].levelReq = 3;  // 铁剑
  items_[1503].rarity = 2; items_[1503].levelReq = 5;  // 烈焰剑

  // ---- 怪物：由内向外难度梯度 ----
  addDefaultMonster("wolf", "野狼", 1, 45, 10, 7, 1, 2, 5);
  monsters_["wolf"].desc = "游荡在近郊的饥饿野狼，成群出没";
  monsters_["wolf"].expReward = 25; monsters_["wolf"].moveSpeed = 1.7;
  monsters_["wolf"].drops = {{3001, 0.35}, {2001, 0.10}, {1001, 0.03}};
  monsters_["wolf"].skillIds = {2001};
  addDefaultMonster("goblin", "哥布林", 2, 70, 20, 10, 3, 4, 9);
  monsters_["goblin"].desc = "狡诈的绿皮掠夺者，随身携带赃物";
  monsters_["goblin"].expReward = 45; monsters_["goblin"].moveSpeed = 1.5;
  monsters_["goblin"].drops = {{3002, 0.30}, {2001, 0.15}, {1501, 0.05}, {1101, 0.03}};
  monsters_["goblin"].skillIds = {2002};

  // NPC 默认数据已迁移到 NpcManager::loadDefaults()（见 npc.cpp）

  addDefaultMonster("skeleton", "骷髅兵", 3, 95, 30, 13, 5, 6, 14);
  monsters_["skeleton"].desc = "被亡灵法术复苏的枯骨士兵";
  monsters_["skeleton"].expReward = 70; monsters_["skeleton"].moveSpeed = 1.3;
  monsters_["skeleton"].drops = {{3003, 0.28}, {2002, 0.08}, {1502, 0.05}, {1002, 0.03}, {1202, 0.03}};
  monsters_["skeleton"].skillIds = {2003};
  addDefaultMonster("gargoyle", "石像鬼", 5, 150, 50, 17, 8, 10, 24);
  monsters_["gargoyle"].desc = "边境石柱上苏醒的魔法石像，坚硬凶猛";
  monsters_["gargoyle"].expReward = 120; monsters_["gargoyle"].moveSpeed = 1.2;
  monsters_["gargoyle"].drops = {{3004, 0.20}, {2002, 0.12}, {1503, 0.04}, {1102, 0.04}, {1302, 0.03}};
  monsters_["gargoyle"].skillIds = {2004};

  // ---- 商店：一个商店 NPC 出售全部物品 ----
  // ShopEntry 字段序：{itemId, price, discountPrice, stock, buyLimit, category, refreshType, sellPrice}
  //   discountPrice>0 时优先结算（划线原价）；buyLimit>0 按玩家累计限购，refreshType 周期重置（1每日/2每周）；
  //   category 0自动(按物品类型)/1装备/2消耗品/3材料/4特殊；sellPrice=0 时回收价按 ItemDef.price×默认回收率。
  ShopDef shop;
  shop.shopId = 1;
  shop.name = "全能杂货铺";
  shop.desc = "主城杂货商人，出售装备/消耗品，含每日特惠与每周限购";
  shop.entries = {
    {1001, 8, 0}, {1002, 30, 0}, {1101, 10, 0}, {1102, 35, 0},
    {1201, 9, 0}, {1202, 28, 0}, {1301, 9, 0}, {1302, 28, 0},
    {1401, 8, 0}, {1402, 26, 0}, {1501, 12, 0},
    {1502, 40, 0, 0, 2, 1, 2, 20},   // 铁剑：每周限购 2 件（装备分类），回收价 20
    {1503, 120, 0},
    {2001, 5, 3, 0, 5, 2, 1, 2},     // 小血瓶：每日特惠 3 金（原价 5），每日限购 5（消耗品），回收价 2
    {2002, 15, 0}, {2101, 5, 0}, {2102, 15, 0},
  };
  shops_[1] = shop;
  // ---- 技能表（大型网游规模：单目标/AOE/治疗/Buff，数据驱动） ----
  // 1000 普通攻击：基础近战攻击（瞬发，零耗蓝，玩家默认习得）
  addDefaultSkill(1000, "普通攻击", "基础近战攻击，造成 100% 攻击伤害", "atk",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 0, 500, 3.2, 0, 1.0, 0, 0,
                  BuffType::NONE, 0, 0, 0, 200);  // 前摇 0.2s，冷却 0.5s
  // 1001 冲刺斩：单目标物理伤害（起始技）
  addDefaultSkill(1001, "冲刺斩", "迅猛突进的一击，造成 220% 攻击伤害", "s1",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 8, 3000, 3.5, 0, 2.2, 0, 0,
                  BuffType::NONE, 0, 0, 0, 0);  // 瞬发
  // 1002 烈焰冲击：区域火伤（起始技）
  addDefaultSkill(1002, "烈焰冲击", "向目标区域喷吐烈焰，对 4m 内敌人造成 150% 攻击伤害", "s2",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 15, 6000, 8, 4, 1.5, 0, 0,
                  BuffType::NONE, 0, 0, 0, 600);  // 前摇 0.6s
  // 1003 治疗之光：恢复自身生命（起始技）
  addDefaultSkill(1003, "治疗之光", "凝聚圣光治疗自身，恢复 60 点生命", "s3",
                  SkillTarget::SELF, SkillEffect::HEAL, 15, 8000, 0, 0, 0, 0, 60,
                  BuffType::NONE, 0, 0, 0, 500);  // 前摇 0.5s
  // 1004 冰霜新星：区域伤害 + 减速
  addDefaultSkill(1004, "冰霜新星", "冰霜爆发，对 4m 内敌人造成 120% 伤害并减速 40%（3 秒）", "s4",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 18, 10000, 8, 4, 1.2, 0, 0,
                  BuffType::MOVE_SLOW, 0.4, 3.0, 0, 800);  // 前摇 0.8s
  // 1005 战吼：自身攻击增益
  addDefaultSkill(1005, "战吼", "咆哮鼓舞，攻击力 +8（10 秒）", "s5",
                  SkillTarget::SELF, SkillEffect::BUFF, 10, 12000, 0, 0, 0, 0, 0,
                  BuffType::ATK, 8, 10.0, 0, 400);  // 前摇 0.4s
  // 1006 雷霆一击：单目标高伤害
  addDefaultSkill(1006, "雷霆一击", "召唤雷电轰击单体，造成 300% 攻击伤害", "s6",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 25, 12000, 4.5, 0, 3.0, 0, 0,
                  BuffType::NONE, 0, 0, 0, 1000);  // 前摇 1.0s
  // 1007 吸血打击：单目标伤害 + 吸血
  addDefaultSkill(1007, "吸血打击", "吸取目标生命，造成 180% 伤害并恢复 35% 伤害量", "s7",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 12, 6000, 3.5, 0, 1.8, 0, 0,
                  BuffType::NONE, 0, 0, 0.35, 300);  // 前摇 0.3s
  // 1008 荆棘护体：反弹伤害 Buff
  addDefaultSkill(1008, "荆棘护体", "周身环绕荆棘，受到伤害时反弹 20%（8 秒）", "s8",
                  SkillTarget::SELF, SkillEffect::BUFF, 12, 15000, 0, 0, 0, 0, 0,
                  BuffType::THORNS, 0.2, 8.0, 0, 600);  // 前摇 0.6s
  // ---- 大型网游扩展：控制/减益/增益/击退 ----
  // 1010 铁壁守护：不可打断 + 霸体 + 防御增益（免疫眩晕/击退，前摇期间移动/受击均不打断）
  addDefaultSkill(1010, "铁壁守护", "摆出铁壁架势，防御 +15 并进入霸体（免疫眩晕/击退，施放不可打断），持续 8 秒", "s10",
                  SkillTarget::SELF, SkillEffect::BUFF, 15, 18000, 0, 0, 0, 0, 0,
                  BuffType::DEF, 15, 8.0, 0, 800, false, false, 0, true);  // 前摇 0.8s，不可打断+霸体
  // 1011 撕裂：范围伤害 + 流血 DoT（每秒 10 点，5 秒）
  addDefaultSkill(1011, "撕裂", "撕开目标的伤口，造成 130% 伤害并使其流血（每秒 10 点，5 秒）", "s11",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 14, 9000, 8, 4, 1.3, 0, 0,
                  BuffType::BLEED, 10, 5.0, 0, 700);  // 前摇 0.7s
  // 1012 破甲斩：范围伤害 + 减防（防御 -12，6 秒）
  addDefaultSkill(1012, "破甲斩", "重击破开护甲，造成 140% 伤害并降低目标防御 12 点（6 秒）", "s12",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 15, 10000, 7, 3, 1.4, 0, 0,
                  BuffType::DEF_DOWN, -12, 6.0, 0, 600);  // 前摇 0.6s
  // 1013 虚弱咒印：范围减攻（攻击 -8，8 秒）
  addDefaultSkill(1013, "虚弱咒印", "施加虚弱诅咒，使目标攻击力 -8（8 秒）", "s13",
                  SkillTarget::AOE, SkillEffect::BUFF, 12, 12000, 8, 4, 0, 0, 0,
                  BuffType::ATK_DOWN, -8, 8.0, 0, 500);  // 前摇 0.5s
  // 1014 震荡波：范围伤害 + 眩晕（2 秒）
  addDefaultSkill(1014, "震荡波", "冲击波震击目标，造成 100% 伤害并眩晕 2 秒", "s14",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 18, 14000, 7, 3.5, 1.0, 0, 0,
                  BuffType::STUN, 1, 2.0, 0, 800);  // 前摇 0.8s
  // 1015 疾风步：加速（移速 +50%，8 秒）
  addDefaultSkill(1015, "疾风步", "脚下生风，移动速度 +50%（8 秒）", "s15",
                  SkillTarget::SELF, SkillEffect::BUFF, 8, 12000, 0, 0, 0, 0, 0,
                  BuffType::SPEED, 0.5, 8.0, 0, 300);  // 前摇 0.3s
  // 1016 猛击：范围伤害 + 击退 6m
  addDefaultSkill(1016, "猛击", "巨力挥击，造成 180% 伤害并击退目标 6 米", "s16",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 16, 10000, 6, 3, 1.8, 0, 0,
                  BuffType::NONE, 0, 0, 0, 500, true, true, 6.0);  // 前摇 0.5s，击退 6m
  // 1017 生命涌动：持续回血（每秒 25 点，8 秒）
  addDefaultSkill(1017, "生命涌动", "生命之力涌动，每秒恢复 25 点生命（8 秒）", "s17",
                  SkillTarget::SELF, SkillEffect::BUFF, 14, 16000, 0, 0, 0, 0, 0,
                  BuffType::REGEN, 25, 8.0, 0, 400);  // 前摇 0.4s
  // ---- 怪物专属技能（ID 2000+，不与玩家技能冲突）----
  // 2001 撕咬：野狼普攻，附带流血 DoT
  addDefaultSkill(2001, "撕咬", "野狼凶猛撕咬，造成 100% 伤害并使其流血（每秒 8 点，3 秒）", "m_atk1",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 0, 1000, 3.0, 3.0, 1.0, 0, 0,
                  BuffType::BLEED, 8, 3.0, 0, 400);  // 前摇 0.4s，范围 3m
  // 2002 利爪挥击：哥布林普攻，附带减速
  addDefaultSkill(2002, "利爪挥击", "哥布林挥动利爪，造成 100% 伤害并减速 20%（2 秒）", "m_atk2",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 0, 1000, 3.0, 3.0, 1.0, 0, 0,
                  BuffType::MOVE_SLOW, 0.2, 2.0, 0, 500);  // 前摇 0.5s，范围 3m
  // 2003 骨刺投掷：骷髅兵普攻，远程附带减防
  addDefaultSkill(2003, "骨刺投掷", "投掷尖锐骨刺，造成 90% 伤害并降低目标防御 3 点（4 秒）", "m_atk3",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 0, 1200, 5.0, 5.0, 0.9, 0, 0,
                  BuffType::DEF_DOWN, -3, 4.0, 0, 600);  // 前摇 0.6s，范围 5m
  // 2004 石像冲击：石像鬼普攻，高伤附带击退
  addDefaultSkill(2004, "石像冲击", "石像鬼重击目标，造成 120% 伤害并击退 2 米", "m_atk4",
                  SkillTarget::ENEMY, SkillEffect::DAMAGE, 0, 1500, 3.0, 3.0, 1.2, 0, 0,
                  BuffType::NONE, 0, 0, 0, 700, false, false, 2.0);  // 前摇 0.7s，范围 3m
  // ---- Boss 专属技能（ID 2100+）----
  // 2100 地裂冲击：Boss AOE，范围伤害 + 击退（前摇 1.5s 蓄力提示）
  addDefaultSkill(2100, "地裂冲击", "巨兽踏裂大地，对 6m 内敌人造成 80% 伤害并击退 3 米", "b_s1",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 0, 8000, 0, 6, 0.8, 0, 0,
                  BuffType::NONE, 0, 0, 0, 1500, false, false, 3.0);
  // 2101 暗影波动：Boss AOE，范围伤害 + 减速（前摇 2s 蓄力提示）
  addDefaultSkill(2101, "暗影波动", "释放暗影波动，对 8m 内敌人造成 60% 伤害并减速 35%（4 秒）", "b_s2",
                  SkillTarget::AOE, SkillEffect::DAMAGE, 0, 10000, 0, 8, 0.6, 0, 0,
                  BuffType::MOVE_SLOW, 0.35, 4.0, 0, 2000, false, false, 0);
  // 新玩家自动习得：普通攻击 / 冲刺斩 / 烈焰冲击 / 治疗之光（开箱即测）
  starterSkills_ = {1000, 1001, 1002, 1003};
}

// ---------- JSON 覆盖加载 ----------
static std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}
// 物品 JSON → ItemDef（loadFromJson 与 replaceItems 共用；新字段均有 has() 守卫保证向后兼容）
static ItemDef parseItemDef(const Json& j) {
  ItemDef d;
  d.id = (uint32_t)j.at("id").asInt();
  if (j.has("name")) d.name = j.at("name").asString();
  if (j.has("desc")) d.desc = j.at("desc").asString();
  if (j.has("icon")) d.icon = j.at("icon").asString();
  if (j.has("type")) d.type = GameData::itemTypeFromJson(j.at("type"), ItemType::EQUIP);
  if (j.has("slot")) d.slot = GameData::slotFromJson(j.at("slot"), EquipSlot::WEAPON);
  d.hpBonus = j.at("hpBonus").asNumber();
  d.mpBonus = j.at("mpBonus").asNumber();
  d.attackBonus = j.at("attackBonus").asNumber();
  d.defenseBonus = j.at("defenseBonus").asNumber();
  d.restoreHp = j.at("restoreHp").asNumber();
  d.restoreMp = j.at("restoreMp").asNumber();
  d.price = (uint32_t)j.at("price").asInt();
  d.stackMax = (uint32_t)(j.has("stackMax") ? j.at("stackMax").asInt() : 99);
  d.rarity = (int)(j.has("rarity") ? j.at("rarity").asInt() : 0);
  d.levelReq = (int)(j.has("levelReq") ? j.at("levelReq").asInt() : 1);
  return d;
}
// 生物 JSON → MonsterDef（type 为键；新增 desc/expReward/moveSpeed/skillIds 解析）
static MonsterDef parseMonsterDef(const std::string& type, const Json& j) {
  MonsterDef d;
  d.type = type;
  if (j.has("name")) d.name = j.at("name").asString();
  if (j.has("desc")) d.desc = j.at("desc").asString();
  d.level = j.has("level") ? (int)j.at("level").asInt() : 1;
  d.hp = j.at("hp").asNumber();
  d.mp = j.at("mp").asNumber();
  d.attack = j.at("attack").asNumber();
  d.defense = j.at("defense").asNumber();
  d.moveSpeed = j.has("moveSpeed") ? j.at("moveSpeed").asNumber() : 1.5;
  d.expReward = (uint32_t)(j.has("expReward") ? j.at("expReward").asInt() : 0);
  d.goldMin = (uint32_t)j.at("goldMin").asInt();
  d.goldMax = (uint32_t)j.at("goldMax").asInt();
  if (j.has("drops") && j.at("drops").type() == Json::Type::Array) {
    for (const auto& e : j.at("drops").asArray()) {
      DropEntry de;
      de.itemId = (uint32_t)e.at("item").asInt();
      de.prob = e.has("prob") ? e.at("prob").asNumber() : 0.0;
      if (de.itemId) d.drops.push_back(de);
    }
  }
  if (j.has("skillIds") && j.at("skillIds").type() == Json::Type::Array) {
    for (const auto& s : j.at("skillIds").asArray()) {
      uint32_t sid = (uint32_t)s.asInt();
      if (sid) d.skillIds.push_back(sid);
    }
  }
  // Boss 扩展字段（has() 守卫，旧 JSON 无此字段时保持默认 false）
  if (j.has("isBoss")) d.isBoss = j.at("isBoss").asBool();
  if (j.has("aggroRange")) d.aggroRange = j.at("aggroRange").asNumber();
  if (j.has("chaseSpeed")) d.chaseSpeed = j.at("chaseSpeed").asNumber();
  if (j.has("attackRange")) d.attackRange = j.at("attackRange").asNumber();
  return d;
}
bool GameData::loadFromJson(const std::string& dir) {
  bool any = false;
  std::string sep = dir.empty() || dir.back() == '/' ? "" : "/";
  // items.json
  {
    std::string content = readFile(dir + sep + "items.json");
    if (!content.empty()) {
      try {
        Json arr = Json::parse(content);
        if (arr.type() == Json::Type::Array) {
          for (const auto& j : arr.asArray()) {
            ItemDef d = parseItemDef(j);
            if (d.id == 0) continue;
            items_[d.id] = d;
          }
          any = true;
          fprintf(stderr, "[gamedata] 加载 items.json: %zu 件物品\n", items_.size());
        }
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] items.json 解析失败（用默认）: %s\n", e.what());
      }
    }
  }
  // monsters.json
  {
    std::string content = readFile(dir + sep + "monsters.json");
    if (!content.empty()) {
      try {
        Json obj = Json::parse(content);
        if (obj.type() == Json::Type::Object) {
          for (auto& [type, j] : obj.asObject()) {
            MonsterDef d = parseMonsterDef(type, j);
            monsters_[type] = d;
          }
          any = true;
          fprintf(stderr, "[gamedata] 加载 monsters.json: %zu 种怪物\n", monsters_.size());
        }
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] monsters.json 解析失败（用默认）: %s\n", e.what());
      }
    }
  }
  // shop.json
  {
    std::string content = readFile(dir + sep + "shop.json");
    if (!content.empty()) {
      try {
        Json obj = Json::parse(content);
        if (obj.type() == Json::Type::Object) {
          for (auto& [sid, j] : obj.asObject()) {
            ShopDef d;
            d.shopId = (uint32_t)atoi(sid.c_str());
            d.name = j.at("name").asString();
            d.desc = j.has("desc") ? j.at("desc").asString() : "";
            d.shopType = (uint8_t)(j.has("shopType") ? j.at("shopType").asInt() : 0);
            d.currencyItemId = (uint32_t)(j.has("currencyItemId") ? j.at("currencyItemId").asInt() : 0);
            for (const auto& e : j.at("entries").asArray()) {
              ShopEntry se;
              se.itemId = (uint32_t)e.at("item").asInt();
              se.price = (uint32_t)(e.has("price") ? e.at("price").asInt() : 0);
              se.discountPrice = (uint32_t)(e.has("discountPrice") ? e.at("discountPrice").asInt() : 0);
              se.stock = (uint32_t)(e.has("stock") ? e.at("stock").asInt() : 0);
              se.buyLimit = (uint32_t)(e.has("buyLimit") ? e.at("buyLimit").asInt() : 0);
              se.category = (uint8_t)(e.has("category") ? e.at("category").asInt() : 0);
              se.refreshType = (uint8_t)(e.has("refreshType") ? e.at("refreshType").asInt() : 0);
              se.sellPrice = (uint32_t)(e.has("sellPrice") ? e.at("sellPrice").asInt() : 0);
              if (se.itemId) d.entries.push_back(se);
            }
            shops_[d.shopId] = d;
          }
          any = true;
          fprintf(stderr, "[gamedata] 加载 shop.json: %zu 个商店\n", shops_.size());
        }
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] shop.json 解析失败（用默认）: %s\n", e.what());
      }
    }
  }
  // skills.json
  {
    std::string content = readFile(dir + sep + "skills.json");
    if (!content.empty()) {
      try {
        Json arr = Json::parse(content);
        if (arr.type() == Json::Type::Array) {
          for (const auto& j : arr.asArray()) {
            SkillDef s;
            s.id = (uint32_t)j.at("id").asInt();
            if (s.id == 0) continue;
            s.name = j.at("name").asString();
            s.desc = j.at("desc").asString();
            s.icon = j.at("icon").asString();
            s.target = SkillDef::targetFromStr(j.at("target").asString());
            s.effect = SkillDef::effectFromStr(j.at("effect").asString());
            s.manaCost = j.at("mana").asNumber();
            s.cooldownMs = (uint32_t)j.at("cooldownMs").asInt();
            s.range = j.at("range").asNumber();
            s.radius = j.at("radius").asNumber();
            s.dmgMul = j.at("dmgMul").asNumber();
            s.flatDmg = j.at("flatDmg").asNumber();
            s.heal = j.at("heal").asNumber();
            s.buffType = SkillDef::buffFromStr(j.at("buffType").asString());
            s.buffValue = j.at("buffValue").asNumber();
            s.buffDurSec = j.at("buffDur").asNumber();
            s.lifesteal = j.at("lifesteal").asNumber();
            s.castTimeMs = (uint16_t)(j.has("castTimeMs") ? j.at("castTimeMs").asInt() : 0);
            s.castCancelOnMove = !(j.has("cancelOnMove") && j.at("cancelOnMove").asInt() == 0);
            s.castCancelOnHit = !(j.has("cancelOnHit") && j.at("cancelOnHit").asInt() == 0);
            s.knockback = j.has("knockback") ? j.at("knockback").asNumber() : 0;
            s.superArmor = j.has("superArmor") && j.at("superArmor").asInt() != 0;
            skills_[s.id] = s;
          }
          any = true;
          fprintf(stderr, "[gamedata] 加载 skills.json: %zu 个技能\n", skills_.size());
        }
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] skills.json 解析失败（用默认）: %s\n", e.what());
      }
    }
  }
  return any;
}

// ---------- 序列化（供编辑器/客户端读取，字段与 loadFromJson 对齐） ----------
std::string GameData::itemsToJson() const {
  std::vector<uint32_t> ids;
  ids.reserve(items_.size());
  for (const auto& [id, d] : items_) { (void)d; ids.push_back(id); }
  std::sort(ids.begin(), ids.end());
  Json arr = Json::array();
  for (uint32_t id : ids) {
    const ItemDef& d = items_.at(id);
    Json j = Json::object();
    j["id"] = (int64_t)d.id;
    j["name"] = d.name;
    j["desc"] = d.desc;
    j["icon"] = d.icon;
    j["type"] = itemTypeToString(d.type);
    j["slot"] = slotToString(d.slot);
    j["hpBonus"] = d.hpBonus;
    j["mpBonus"] = d.mpBonus;
    j["attackBonus"] = d.attackBonus;
    j["defenseBonus"] = d.defenseBonus;
    j["restoreHp"] = d.restoreHp;
    j["restoreMp"] = d.restoreMp;
    j["price"] = (int64_t)d.price;
    j["stackMax"] = (int64_t)d.stackMax;
    j["rarity"] = (int64_t)d.rarity;
    j["levelReq"] = (int64_t)d.levelReq;
    arr.push_back(j);
  }
  return arr.dump();
}
std::string GameData::monstersToJson() const {
  Json obj = Json::object();
  for (const auto& [type, d] : monsters_) {
    Json j = Json::object();
    j["name"] = d.name;
    j["desc"] = d.desc;
    j["level"] = (int64_t)d.level;
    j["hp"] = d.hp;
    j["mp"] = d.mp;
    j["attack"] = d.attack;
    j["defense"] = d.defense;
    j["moveSpeed"] = d.moveSpeed;
    j["expReward"] = (int64_t)d.expReward;
    j["goldMin"] = (int64_t)d.goldMin;
    j["goldMax"] = (int64_t)d.goldMax;
    Json drops = Json::array();
    for (const auto& de : d.drops) {
      Json e = Json::object();
      e["item"] = (int64_t)de.itemId;
      e["prob"] = de.prob;
      drops.push_back(e);
    }
    j["drops"] = drops;
    Json sk = Json::array();
    for (uint32_t sid : d.skillIds) sk.push_back(Json((int64_t)sid));
    j["skillIds"] = sk;
    // Boss 扩展字段（仅 isBoss=true 时输出，向后兼容）
    if (d.isBoss) {
      j["isBoss"] = true;
      j["aggroRange"] = d.aggroRange;
      j["chaseSpeed"] = d.chaseSpeed;
      j["attackRange"] = d.attackRange;
    }
    obj[type] = j;
  }
  return obj.dump();
}
// NPC 序列化已委托给 NpcManager（见 npc.cpp）
// 商店序列化（阶段1扩展字段，键=shopId，与 loadFromJson 的 shop.json 对齐）
std::string GameData::shopsToJson() const {
  Json obj = Json::object();
  for (const auto& [sid, d] : shops_) {
    Json j = Json::object();
    j["name"] = d.name;
    j["desc"] = d.desc;
    j["shopType"] = (int64_t)d.shopType;
    j["currencyItemId"] = (int64_t)d.currencyItemId;
    Json arr = Json::array();
    for (const auto& e : d.entries) {
      Json je = Json::object();
      je["item"] = (int64_t)e.itemId;
      je["price"] = (int64_t)e.price;
      je["discountPrice"] = (int64_t)e.discountPrice;
      je["stock"] = (int64_t)e.stock;
      je["buyLimit"] = (int64_t)e.buyLimit;
      je["category"] = (int64_t)e.category;
      je["refreshType"] = (int64_t)e.refreshType;
      je["sellPrice"] = (int64_t)e.sellPrice;
      arr.push_back(je);
    }
    j["entries"] = arr;
    obj[std::to_string(sid)] = j;
  }
  return obj.dump();
}

// ---------- 热替换（编辑器保存完整列表 → 清空重填） ----------
bool GameData::replaceItems(const Json& arr) {
  if (arr.type() != Json::Type::Array) return false;
  std::unordered_map<uint32_t, ItemDef> next;
  for (const auto& j : arr.asArray()) {
    ItemDef d = parseItemDef(j);
    if (d.id == 0) continue;
    next[d.id] = d;
  }
  items_ = std::move(next);
  return true;
}
bool GameData::replaceMonsters(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  std::unordered_map<std::string, MonsterDef> next;
  for (const auto& [type, j] : obj.asObject()) {
    if (type.empty()) continue;
    next[type] = parseMonsterDef(type, j);
  }
  monsters_ = std::move(next);
  return true;
}
// NPC 热替换已委托给 NpcManager（见 npc.cpp）
// 商店热替换（阶段7编辑器）：键=shopId，字段与 loadFromJson 的 shop.json 对齐
bool GameData::replaceShops(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  std::unordered_map<uint32_t, ShopDef> next;
  for (const auto& [sid, j] : obj.asObject()) {
    ShopDef d;
    d.shopId = (uint32_t)atoi(sid.c_str());
    if (d.shopId == 0) continue;
    d.name = j.has("name") ? j.at("name").asString() : "";
    d.desc = j.has("desc") ? j.at("desc").asString() : "";
    d.shopType = (uint8_t)(j.has("shopType") ? j.at("shopType").asInt() : 0);
    d.currencyItemId = (uint32_t)(j.has("currencyItemId") ? j.at("currencyItemId").asInt() : 0);
    if (j.has("entries")) {
      for (const auto& e : j.at("entries").asArray()) {
        ShopEntry se;
        se.itemId = (uint32_t)e.at("item").asInt();
        se.price = (uint32_t)(e.has("price") ? e.at("price").asInt() : 0);
        se.discountPrice = (uint32_t)(e.has("discountPrice") ? e.at("discountPrice").asInt() : 0);
        se.stock = (uint32_t)(e.has("stock") ? e.at("stock").asInt() : 0);
        se.buyLimit = (uint32_t)(e.has("buyLimit") ? e.at("buyLimit").asInt() : 0);
        se.category = (uint8_t)(e.has("category") ? e.at("category").asInt() : 0);
        se.refreshType = (uint8_t)(e.has("refreshType") ? e.at("refreshType").asInt() : 0);
        se.sellPrice = (uint32_t)(e.has("sellPrice") ? e.at("sellPrice").asInt() : 0);
        if (se.itemId) d.entries.push_back(se);
      }
    }
    next[d.shopId] = d;
  }
  shops_ = std::move(next);
  return true;
}

} // namespace ew
