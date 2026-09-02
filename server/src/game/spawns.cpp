#include "spawns.h"
#include <cmath>
#include <fstream>
#include <sstream>
#include "../util/random.h"
#include "../util/json.h"
#include "terrain.h"

namespace ew {

using Json = ew::Json;

// 距城镇的分层刷怪类型（与初始刷怪设计一致：近弱远强）
static const char* tierTypeAt(double x, double z) {
  double d = std::hypot(x, z);
  if (d < 45.0) return "wolf";
  if (d < 65.0) return "goblin";
  if (d < 90.0) return "skeleton";
  return "gargoyle";
}

void SpawnConfig::loadDefaults(const Config& cfg) {
  list_.clear();
  Mulberry32 rng((uint32_t)cfg.worldSeed ^ 0x7c9a3u);
  // 1) 怪物：环带 [20,110]m，随机可通行干地点，按距离阶梯类型
  int nMon = cfg.monsterCount > 0 ? cfg.monsterCount : 24;
  for (int i = 0; i < nMon; i++) {
    double x = 0, z = 0;
    bool ok = false;
    for (int a = 0; a < 64; a++) {
      double ang = rng.next() * 6.283185307;
      double r = 20.0 + std::sqrt(rng.next()) * 90.0; // [20,110]
      double px = std::cos(ang) * r, pz = std::sin(ang) * r;
      if (!terrainBlocked(px, pz) && terrainHeight(px, pz) > kWaterLevel + 1.0) { x = px; z = pz; ok = true; break; }
    }
    SpawnPoint sp;
    sp.kind = SP_MONSTER;
    sp.type = tierTypeAt(x, z);
    sp.x = x; sp.z = z;
    sp.count = 1;
    list_.push_back(sp);
  }
  // 2) 城镇 NPC：主城圆盘锚点（出生点附近），首位=商店老板
  const double npcAnchors[][2] = {
    {6.0, 6.0}, {0.0, 6.0}, {6.0, 0.0}, {-6.0, 6.0}, {6.0, -6.0},
    {0.0, -6.0}, {-6.0, 0.0}, {-3.0, 7.0}, {7.0, -3.0}, {-7.0, -3.0},
    {3.0, -7.0}, {-7.0, 3.0}
  };
  int nNpc = cfg.npcCount > 0 ? cfg.npcCount : 12;
  for (int i = 0; i < nNpc; i++) {
    SpawnPoint sp;
    sp.kind = SP_NPC;
    sp.x = npcAnchors[i % 12][0];
    sp.z = npcAnchors[i % 12][1];
    if (i == 0) { sp.shopId = 1; sp.name = "商店老板·全能杂货铺"; }
    list_.push_back(sp);
  }
  // 3) 世界 Boss：远离出生点的可通行锚点
  const double bossAnchors[][2] = { {-79.5, -73.5}, {74.5, 38.5}, {-47.5, 44.5} };
  const char* bossNames[] = { "荒原巨兽", "深渊领主", "冰霜女王" };
  int nBoss = cfg.bossCount > 0 ? cfg.bossCount : 3;
  for (int i = 0; i < nBoss && i < 3; i++) {
    SpawnPoint sp;
    sp.kind = SP_BOSS;
    sp.type = "gargoyle";
    sp.name = bossNames[i];
    sp.x = bossAnchors[i][0];
    sp.z = bossAnchors[i][1];
    list_.push_back(sp);
  }
}

bool SpawnConfig::fromJson(const std::string& json) {
  try {
    Json root = Json::parse(json);
    if (root.type() != Json::Type::Object || !root.has("spawns")) return false;
    Json& arr = root["spawns"];
    if (arr.type() != Json::Type::Array) return false;
    std::vector<SpawnPoint> next;
    for (const auto& jv : arr.asArray()) {
      if (jv.type() != Json::Type::Object) continue;
      SpawnPoint sp;
      std::string kind = jv.has("kind") ? jv.at("kind").asString() : "monster";
      if (kind == "monster") sp.kind = SP_MONSTER;
      else if (kind == "npc") sp.kind = SP_NPC;
      else if (kind == "boss") sp.kind = SP_BOSS;
      else continue;
      if (jv.has("type")) sp.type = jv.at("type").asString();
      if (jv.has("name")) sp.name = jv.at("name").asString();
      if (jv.has("shopId")) sp.shopId = (int)jv.at("shopId").asInt();
      if (jv.has("x")) sp.x = jv.at("x").asNumber();
      if (jv.has("z")) sp.z = jv.at("z").asNumber();
      if (jv.has("count")) sp.count = (int)jv.at("count").asInt();
      if (sp.count < 1) sp.count = 1;
      next.push_back(sp);
    }
    list_ = std::move(next);
    return true;
  } catch (...) { return false; }
}

std::string SpawnConfig::toJson() const {
  Json arr = Json::array();
  for (const auto& sp : list_) {
    Json j = Json::object();
    j["kind"] = sp.kind == SP_NPC ? "npc" : (sp.kind == SP_BOSS ? "boss" : "monster");
    if (!sp.type.empty()) j["type"] = sp.type;
    if (!sp.name.empty()) j["name"] = sp.name;
    if (sp.shopId) j["shopId"] = sp.shopId;
    j["x"] = sp.x;
    j["z"] = sp.z;
    j["count"] = sp.count;
    arr.push_back(j);
  }
  Json root = Json::object();
  root["spawns"] = arr;
  return root.dump();
}

bool SpawnConfig::loadFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.is_open()) return false;
  std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if (content.empty()) return false;
  return fromJson(content);
}

bool SpawnConfig::saveFile(const std::string& path) const {
  std::ofstream f(path, std::ios::binary);
  if (!f.is_open()) return false;
  f << toJson();
  return f.good();
}

} // namespace ew
