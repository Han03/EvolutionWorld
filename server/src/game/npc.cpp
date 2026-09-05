// npc.cpp - NPC 管理插件实现（ID 驱动 + 标签功能路由 + 唯一性追踪）
#include "npc.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <algorithm>

namespace ew {

static std::string readFileNpc(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

NpcManager::NpcManager() {}

// ---------- 查询 ----------
const NpcDef* NpcManager::npc(const std::string& npcId) const {
  auto it = npcs_.find(npcId);
  return it == npcs_.end() ? nullptr : &it->second;
}

// ---------- 运行时唯一性追踪 ----------
bool NpcManager::markSpawned(const std::string& npcId) {
  if (spawned_.count(npcId)) return false;  // 已存在，拒绝重复生成
  spawned_.insert(npcId);
  return true;
}
void NpcManager::markDespawned(const std::string& npcId) {
  spawned_.erase(npcId);
}
bool NpcManager::isSpawned(const std::string& npcId) const {
  return spawned_.count(npcId) > 0;
}
void NpcManager::clearSpawned() {
  spawned_.clear();
}

// ---------- JSON 加载（可选覆盖） ----------
bool NpcManager::loadFromJson(const std::string& dir) {
  std::string sep = dir.empty() || dir.back() == '/' ? "" : "/";
  std::string content = readFileNpc(dir + sep + "npcs.json");
  if (content.empty()) return false;
  try {
    Json obj = Json::parse(content);
    if (obj.type() != Json::Type::Object) return false;
    for (const auto& [id, jv] : obj.asObject()) {
      if (id.empty()) continue;
      NpcDef d;
      d.npcId = id;
      if (jv.has("name")) d.name = jv.at("name").asString();
      if (jv.has("desc")) d.desc = jv.at("desc").asString();
      if (jv.has("model")) d.model = jv.at("model").asString();
      d.npcTag = (uint32_t)(jv.has("npcTag") ? jv.at("npcTag").asInt() : (int)NPC_TAG_BASIC);
      d.shopId = (int)(jv.has("shopId") ? jv.at("shopId").asInt() : 0);
      d.level = (int)(jv.has("level") ? jv.at("level").asInt() : 1);
      d.wanderRadius = jv.has("wanderRadius") ? jv.at("wanderRadius").asNumber() : 0;
      if (jv.has("dialogue")) d.dialogue = jv.at("dialogue").asString();
      npcs_[id] = d;
    }
    fprintf(stderr, "[npc] 加载 npcs.json: %zu 种 NPC\n", npcs_.size());
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[npc] npcs.json 解析失败（用默认）: %s\n", e.what());
    return false;
  }
}

// ---------- 序列化（供编辑器读取） ----------
std::string NpcManager::npcsToJson() const {
  // 按 npcId 排序输出（编辑器列表稳定）
  std::vector<std::string> ids;
  ids.reserve(npcs_.size());
  for (const auto& [id, _] : npcs_) ids.push_back(id);
  std::sort(ids.begin(), ids.end());

  Json obj = Json::object();
  for (const auto& id : ids) {
    const NpcDef& d = npcs_.at(id);
    Json j = Json::object();
    j["name"] = d.name;
    j["desc"] = d.desc;
    j["model"] = d.model;
    j["npcTag"] = (int64_t)d.npcTag;
    j["shopId"] = (int64_t)d.shopId;
    j["level"] = (int64_t)d.level;
    j["wanderRadius"] = d.wanderRadius;
    j["dialogue"] = d.dialogue;
    obj[id] = j;
  }
  return obj.dump();
}

// ---------- 热替换（编辑器保存完整列表 → 清空重填） ----------
bool NpcManager::replaceNpcs(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  std::unordered_map<std::string, NpcDef> next;
  for (const auto& [id, jv] : obj.asObject()) {
    if (id.empty()) continue;
    NpcDef d;
    d.npcId = id;
    if (jv.has("name")) d.name = jv.at("name").asString();
    if (jv.has("desc")) d.desc = jv.at("desc").asString();
    if (jv.has("model")) d.model = jv.at("model").asString();
    d.npcTag = (uint32_t)(jv.has("npcTag") ? jv.at("npcTag").asInt() : (int)NPC_TAG_BASIC);
    d.shopId = (int)(jv.has("shopId") ? jv.at("shopId").asInt() : 0);
    d.level = (int)(jv.has("level") ? jv.at("level").asInt() : 1);
    d.wanderRadius = jv.has("wanderRadius") ? jv.at("wanderRadius").asNumber() : 0;
    if (jv.has("dialogue")) d.dialogue = jv.at("dialogue").asString();
    next[id] = d;
  }
  npcs_ = std::move(next);
  return true;
}

} // namespace ew
