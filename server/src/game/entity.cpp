// entity.cpp
#include "entity.h"
#include "items.h"
#include <cmath>

namespace ew {

static double r2(double v) { return std::round(v * 100.0) / 100.0; }

Json Entity::serialize() const {
  Json j = Json::object();
  j["id"] = id;
  switch (kind) {
    case EntityKind::Player: j["kind"] = "player"; break;
    case EntityKind::Monster: j["kind"] = "monster"; break;
    case EntityKind::Npc: j["kind"] = "npc"; break;
    case EntityKind::Item: j["kind"] = "item"; break;
  }
  j["x"] = r2(pos.x);
  j["y"] = r2(pos.y);
  j["z"] = r2(pos.z);
  if (kind == EntityKind::Player) j["username"] = username;
  else if (kind == EntityKind::Monster) j["name"] = name.empty() ? "Monster" : name;
  else if (kind == EntityKind::Npc) j["name"] = name.empty() ? "NPC" : name;
  else if (kind == EntityKind::Item) {
    j["itemId"] = (int64_t)dropItemId;
    j["gold"] = (int64_t)dropGold;
  }
  if (kind == EntityKind::Player) {
    j["hp"] = r2(hp);
    j["maxHp"] = r2(maxHp);
    j["mp"] = r2(mp);
    j["maxMp"] = r2(maxMp);
    j["attack"] = r2(attack);
    j["defense"] = r2(defense);
    j["gold"] = (int64_t)pl.gold;
  }
  return j;
}

Entity makePlayer(const std::string& id, const std::string& username) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Player;
  e.radius = 0.55;
  e.username = username;
  e.hp = e.maxHp = 100;
  e.mp = e.maxMp = 50;
  e.attack = 12;
  e.defense = 3;
  e.level = 1;
  return e;
}

Entity makeMonster(const std::string& id, const std::string& type) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Monster;
  e.radius = 0.5;
  e.ai.speed = 1.5;
  e.hp = e.maxHp = 60;
  e.mp = e.maxMp = 20;
  e.attack = 8;
  e.defense = 2;
  e.level = 1;
  e.name = "Monster";
  (void)type; // 具体属性由 World 用 GameData 应用（makeMonster 保持无依赖）
  return e;
}

Entity makeNpc(const std::string& id) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Npc;
  e.radius = 0.5;
  e.ai.speed = 0.8;
  e.hp = e.maxHp = 100;
  e.mp = e.maxMp = 50;
  e.attack = 0;
  e.defense = 0;
  e.level = 1;
  e.name = "NPC";
  return e;
}

Entity makeDrop(const std::string& id, double x, double y, double z,
                uint32_t itemId, uint32_t gold) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Item;
  e.radius = 0.35;
  e.pos = {x, y, z};
  e.dropItemId = itemId;
  e.dropGold = gold;
  return e;
}

} // namespace ew
