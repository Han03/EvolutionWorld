// items.cpp - 物品/属性/商店/配置系统实现（内置默认数据 + JSON 覆盖）
#include "items.h"
#include <cstdio>
#include <fstream>
#include <sstream>

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

  // ---- 怪物：由内向外难度梯度 ----
  addDefaultMonster("wolf", "野狼", 1, 45, 10, 7, 1, 2, 5);
  monsters_["wolf"].drops = {{3001, 0.35}, {2001, 0.10}, {1001, 0.03}};
  addDefaultMonster("goblin", "哥布林", 2, 70, 20, 10, 3, 4, 9);
  monsters_["goblin"].drops = {{3002, 0.30}, {2001, 0.15}, {1501, 0.05}, {1101, 0.03}};
  addDefaultMonster("skeleton", "骷髅兵", 3, 95, 30, 13, 5, 6, 14);
  monsters_["skeleton"].drops = {{3003, 0.28}, {2002, 0.08}, {1502, 0.05}, {1002, 0.03}, {1202, 0.03}};
  addDefaultMonster("gargoyle", "石像鬼", 5, 150, 50, 17, 8, 10, 24);
  monsters_["gargoyle"].drops = {{3004, 0.20}, {2002, 0.12}, {1503, 0.04}, {1102, 0.04}, {1302, 0.03}};

  // ---- 商店：一个商店 NPC 出售全部物品 ----
  ShopDef shop;
  shop.shopId = 1;
  shop.name = "全能杂货铺";
  shop.entries = {
    {1001, 8, 0}, {1002, 30, 0}, {1101, 10, 0}, {1102, 35, 0},
    {1201, 9, 0}, {1202, 28, 0}, {1301, 9, 0}, {1302, 28, 0},
    {1401, 8, 0}, {1402, 26, 0}, {1501, 12, 0}, {1502, 40, 0}, {1503, 120, 0},
    {2001, 5, 0}, {2002, 15, 0}, {2101, 5, 0}, {2102, 15, 0},
  };
  shops_[1] = shop;
}

// ---------- JSON 覆盖加载 ----------
static std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
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
            ItemDef d;
            d.id = (uint32_t)j.at("id").asInt();
            if (d.id == 0) continue;
            d.name = j.at("name").asString();
            d.desc = j.at("desc").asString();
            d.icon = j.at("icon").asString();
            d.type = itemTypeFromJson(j.at("type"), ItemType::EQUIP);
            d.slot = slotFromJson(j.at("slot"), EquipSlot::WEAPON);
            d.hpBonus = j.at("hpBonus").asNumber();
            d.mpBonus = j.at("mpBonus").asNumber();
            d.attackBonus = j.at("attackBonus").asNumber();
            d.defenseBonus = j.at("defenseBonus").asNumber();
            d.restoreHp = j.at("restoreHp").asNumber();
            d.restoreMp = j.at("restoreMp").asNumber();
            d.price = (uint32_t)j.at("price").asInt();
            d.stackMax = (uint32_t)(j.has("stackMax") ? j.at("stackMax").asInt() : 99);
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
            MonsterDef d;
            d.type = type;
            d.name = j.at("name").asString();
            d.level = (int)j.at("level").asInt();
            d.hp = j.at("hp").asNumber();
            d.mp = j.at("mp").asNumber();
            d.attack = j.at("attack").asNumber();
            d.defense = j.at("defense").asNumber();
            d.goldMin = (uint32_t)j.at("goldMin").asInt();
            d.goldMax = (uint32_t)j.at("goldMax").asInt();
            if (j.has("drops") && j.at("drops").type() == Json::Type::Array) {
              for (const auto& e : j.at("drops").asArray()) {
                DropEntry de;
                de.itemId = (uint32_t)e.at("item").asInt();
                de.prob = e.at("prob").asNumber();
                if (de.itemId) d.drops.push_back(de);
              }
            }
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
            for (const auto& e : j.at("entries").asArray()) {
              ShopEntry se;
              se.itemId = (uint32_t)e.at("item").asInt();
              se.price = (uint32_t)(e.has("price") ? e.at("price").asInt() : 0);
              se.stock = (uint32_t)(e.has("stock") ? e.at("stock").asInt() : 0);
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
  return any;
}

} // namespace ew
