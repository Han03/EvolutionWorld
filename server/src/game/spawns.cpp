#include "spawns.h"
#include <cmath>
#include <fstream>
#include <sstream>
#include "../util/random.h"
#include "../util/json.h"
#include "terrain.h"

namespace ew {

using Json = ew::Json;

// 出生点布局不再硬编码：由世界初始化执行器（worldinit.cpp）数据驱动生成，
// 或从数据库加载。本文件仅保留序列化 / 反序列化 / 文件读写。

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
      else if (kind == "elite" || kind == "boss") sp.kind = SP_MONSTER;  // 旧档兼容：精英已统一为普通怪物
      else continue;
      if (jv.has("type")) sp.type = jv.at("type").asString();
      if (jv.has("name")) sp.name = jv.at("name").asString();
      if (jv.has("shopId")) sp.shopId = (int)jv.at("shopId").asInt();
      if (jv.has("x")) sp.x = jv.at("x").asNumber();
      if (jv.has("z")) sp.z = jv.at("z").asNumber();
      if (jv.has("count")) sp.count = (int)jv.at("count").asInt();
      if (sp.count < 1) sp.count = 1;
      if (jv.has("npcTag")) sp.npcTag = (uint32_t)jv.at("npcTag").asInt();
      if (jv.has("npcGroup")) sp.npcGroup = (int)jv.at("npcGroup").asInt();
      if (jv.has("cityId")) sp.cityId = (int)jv.at("cityId").asInt();
      if (jv.has("npcId")) sp.npcId = jv.at("npcId").asString();  // NPC 插件：按 ID 引用
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
    j["kind"] = sp.kind == SP_NPC ? "npc" : "monster";
    if (!sp.type.empty()) j["type"] = sp.type;
    if (!sp.name.empty()) j["name"] = sp.name;
    if (sp.shopId) j["shopId"] = sp.shopId;
    j["x"] = sp.x;
    j["z"] = sp.z;
    j["count"] = sp.count;
    if (sp.kind == SP_NPC) {
      if (!sp.npcId.empty()) j["npcId"] = sp.npcId;  // NPC 插件：按 ID 引用
      if (sp.npcTag) j["npcTag"] = (int64_t)sp.npcTag;
      if (sp.npcGroup) j["npcGroup"] = (int64_t)sp.npcGroup;
      if (sp.cityId >= 0) j["cityId"] = (int64_t)sp.cityId;
    }
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
