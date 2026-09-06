// items.cpp - 物品/属性/商店/配置系统实现（data/*.json 加载 + 编辑器热替换）
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

// ---------- JSON 配置加载 ----------
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
  // 精英扩展字段（has() 守卫，旧 JSON 无此字段时保持默认 false；兼容旧档 "isBoss"）
  if (j.has("isElite")) d.isElite = j.at("isElite").asBool();
  else if (j.has("isBoss")) d.isElite = j.at("isBoss").asBool();
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
  // skills.json（支持对象格式 {skills:[], starterSkills:[]} 和旧数组格式）
  {
    std::string content = readFile(dir + sep + "skills.json");
    if (!content.empty()) {
      try {
        Json root = Json::parse(content);
        Json::Array skillArr;
        if (root.type() == Json::Type::Array) {
          skillArr = root.asArray();   // 旧格式：纯数组
        } else if (root.type() == Json::Type::Object) {
          if (root.has("skills") && root.at("skills").type() == Json::Type::Array)
            skillArr = root.at("skills").asArray();
          // 起始技能（新玩家自动习得）
          if (root.has("starterSkills") && root.at("starterSkills").type() == Json::Type::Array) {
            starterSkills_.clear();
            for (const auto& sj : root.at("starterSkills").asArray())
              starterSkills_.push_back((uint32_t)sj.asInt());
          }
        }
        for (const auto& j : skillArr) {
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
          s.dashDist = j.has("dashDist") ? j.at("dashDist").asNumber() : 0;
          s.superArmor = j.has("superArmor") && j.at("superArmor").asInt() != 0;
          skills_[s.id] = s;
        }
        any = true;
        fprintf(stderr, "[gamedata] 加载 skills.json: %zu 个技能, %zu 起始技能\n", skills_.size(), starterSkills_.size());
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] skills.json 解析失败（用默认）: %s\n", e.what());
      }
    }
  }
  // player.json（玩家基础属性）
  {
    std::string content = readFile(dir + sep + "player.json");
    if (!content.empty()) {
      try {
        Json obj = Json::parse(content);
        if (obj.type() == Json::Type::Object) {
          if (obj.has("hp")) playerDefaults_.hp = obj.at("hp").asNumber();
          if (obj.has("mp")) playerDefaults_.mp = obj.at("mp").asNumber();
          if (obj.has("attack")) playerDefaults_.attack = obj.at("attack").asNumber();
          if (obj.has("defense")) playerDefaults_.defense = obj.at("defense").asNumber();
          if (obj.has("level")) playerDefaults_.level = (int)obj.at("level").asInt();
          if (obj.has("radius")) playerDefaults_.radius = obj.at("radius").asNumber();
          any = true;
          fprintf(stderr, "[gamedata] 加载 player.json: HP=%.0f MP=%.0f ATK=%.0f DEF=%.0f Lv=%d\n",
                  playerDefaults_.hp, playerDefaults_.mp, playerDefaults_.attack, playerDefaults_.defense, playerDefaults_.level);
        }
      } catch (const std::exception& e) {
        fprintf(stderr, "[gamedata] player.json 解析失败（用默认）: %s\n", e.what());
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
    // 精英扩展字段（仅 isElite=true 时输出）
    if (d.isElite) {
      j["isElite"] = true;
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

// ---------- 技能序列化 / 热替换（世界编辑器技能配置用） ----------
// BuffType → JSON 字符串（与 SkillDef::buffFromStr 互逆）
static const char* buffToString(BuffType b) {
  switch (b) {
    case BuffType::ATK: return "atk";
    case BuffType::DEF: return "def";
    case BuffType::MOVE_SLOW: return "move_slow";
    case BuffType::REGEN: return "regen";
    case BuffType::THORNS: return "thorns";
    case BuffType::BLEED: return "bleed";
    case BuffType::DEF_DOWN: return "def_down";
    case BuffType::ATK_DOWN: return "atk_down";
    case BuffType::STUN: return "stun";
    case BuffType::SUPER_ARMOR: return "super_armor";
    case BuffType::SPEED: return "speed";
    default: return "none";
  }
}
static const char* targetToString(SkillTarget t) {
  switch (t) {
    case SkillTarget::SELF: return "self";
    case SkillTarget::ENEMY: return "enemy";
    case SkillTarget::AOE: return "aoe";
    default: return "self";
  }
}
static const char* effectToString(SkillEffect e) {
  switch (e) {
    case SkillEffect::DAMAGE: return "damage";
    case SkillEffect::HEAL: return "heal";
    case SkillEffect::BUFF: return "buff";
    default: return "none";
  }
}

std::string GameData::skillsToJson() const {
  // 按 ID 排序输出
  std::vector<uint32_t> ids;
  ids.reserve(skills_.size());
  for (const auto& [id, d] : skills_) { (void)d; ids.push_back(id); }
  std::sort(ids.begin(), ids.end());
  Json arr = Json::array();
  for (uint32_t id : ids) {
    const SkillDef& d = skills_.at(id);
    Json j = Json::object();
    j["id"] = (int64_t)d.id;
    j["name"] = d.name;
    j["desc"] = d.desc;
    j["icon"] = d.icon;
    j["target"] = targetToString(d.target);
    j["effect"] = effectToString(d.effect);
    j["mana"] = d.manaCost;
    j["cooldownMs"] = (int64_t)d.cooldownMs;
    j["range"] = d.range;
    j["radius"] = d.radius;
    j["dmgMul"] = d.dmgMul;
    j["flatDmg"] = d.flatDmg;
    j["heal"] = d.heal;
    j["buffType"] = buffToString(d.buffType);
    j["buffValue"] = d.buffValue;
    j["buffDur"] = d.buffDurSec;
    j["lifesteal"] = d.lifesteal;
    j["castTimeMs"] = (int64_t)d.castTimeMs;
    j["cancelOnMove"] = d.castCancelOnMove ? 1 : 0;
    j["cancelOnHit"] = d.castCancelOnHit ? 1 : 0;
    j["knockback"] = d.knockback;
    j["dashDist"] = d.dashDist;
    j["superArmor"] = d.superArmor ? 1 : 0;
    arr.push_back(j);
  }
  Json root = Json::object();
  Json ss = Json::array();
  for (uint32_t sid : starterSkills_) ss.push_back(Json((int64_t)sid));
  root["starterSkills"] = ss;
  root["skills"] = arr;
  return root.dump();
}

bool GameData::replaceSkills(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  std::unordered_map<uint32_t, SkillDef> next;
  if (obj.has("skills") && obj.at("skills").type() == Json::Type::Array) {
    for (const auto& j : obj.at("skills").asArray()) {
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
      s.dashDist = j.has("dashDist") ? j.at("dashDist").asNumber() : 0;
      s.superArmor = j.has("superArmor") && j.at("superArmor").asInt() != 0;
      next[s.id] = s;
    }
  }
  skills_ = std::move(next);
  // 起始技能
  if (obj.has("starterSkills") && obj.at("starterSkills").type() == Json::Type::Array) {
    starterSkills_.clear();
    for (const auto& sj : obj.at("starterSkills").asArray())
      starterSkills_.push_back((uint32_t)sj.asInt());
  }
  return true;
}

} // namespace ew
