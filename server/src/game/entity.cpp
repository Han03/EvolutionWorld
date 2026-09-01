// entity.cpp
#include "entity.h"
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
  }
  j["x"] = r2(pos.x);
  j["y"] = r2(pos.y);
  j["z"] = r2(pos.z);
  if (kind == EntityKind::Player) j["username"] = username;
  else if (kind == EntityKind::Monster) j["name"] = "Monster";
  else if (kind == EntityKind::Npc) j["name"] = "NPC";
  return j;
}

Entity makePlayer(const std::string& id, const std::string& username) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Player;
  e.radius = 0.55;
  e.username = username;
  e.hp = e.maxHp = 100;
  e.attack = 12;
  e.level = 1;
  return e;
}

Entity makeMonster(const std::string& id) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Monster;
  e.radius = 0.5;
  e.ai.speed = 1.5;
  e.hp = e.maxHp = 60;
  e.attack = 8;
  e.level = 1;
  e.name = "Monster";
  return e;
}

Entity makeNpc(const std::string& id) {
  Entity e;
  e.id = id;
  e.kind = EntityKind::Npc;
  e.radius = 0.5;
  e.ai.speed = 0.8;
  e.hp = e.maxHp = 100;
  e.attack = 0;
  e.level = 1;
  e.name = "NPC";
  return e;
}

} // namespace ew
