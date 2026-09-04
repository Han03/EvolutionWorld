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

void NpcManager::addDefault(const char* npcId, const char* name, const char* desc, const char* model,
                            uint32_t tag, int shopId, int level, double wander, const char* dialogue) {
  NpcDef d;
  d.npcId = npcId;
  d.name = name;
  d.desc = desc;
  d.model = model;
  d.npcTag = tag;
  d.shopId = shopId;
  d.level = level;
  d.wanderRadius = wander;
  d.dialogue = dialogue;
  npcs_[npcId] = d;
}

// ---------- 内置默认 NPC 花名册（大型网游风格，每城一套） ----------
void NpcManager::loadDefaults() {
  // ---- 主城通用 NPC（每城投放一组） ----
  // 基础功能 NPC
  addDefault("guide_001", "新手向导", "热心指引方向的本地居民", "npc_guide",
             NPC_TAG_BASIC, 0, 5, 3.0,
             "欢迎来到这片大陆！附近有商人可以补给，任务使者那里有委托可以接取。");
  addDefault("guide_002", "旅行向导", "走南闯北的旅行者", "npc_guide2",
             NPC_TAG_BASIC | NPC_TAG_TELEPORT, 0, 8, 0,
             "我可以送你去其他城市，需要传送吗？");

  // 任务 NPC
  addDefault("quest_001", "任务使者", "发布各类委托的负责人", "npc_quest",
             NPC_TAG_BASIC | NPC_TAG_QUEST, 0, 10, 0,
             "我这里有几个委托，你有兴趣帮忙吗？");
  addDefault("quest_002", "日常管事", "每日发布日常事务的管事", "npc_daily",
             NPC_TAG_BASIC | NPC_TAG_QUEST | NPC_TAG_DAILY, 0, 12, 0,
             "每天都有新的日常委托，完成可获得稳定奖励。");

  // 商店 NPC
  addDefault("merchant_001", "杂货商人", "经营各类物资的商人", "npc_merchant",
             NPC_TAG_BASIC | NPC_TAG_SHOP, 1, 6, 0,
             "随便看看，装备、药水、武器应有尽有！");
  addDefault("merchant_002", "药草商人", "采集并出售草药的行商", "npc_herb",
             NPC_TAG_BASIC | NPC_TAG_SHOP, 1, 4, 2.0,
             "上好的药草，恢复生命和法力必备。");

  // 铁匠 NPC
  addDefault("smith_001", "铸剑师傅", "精通锻造的工匠", "npc_smith",
             NPC_TAG_BASIC | NPC_TAG_BLACKSMITH, 0, 15, 0,
             "拿来你的装备，我能让它更锋利。");
  addDefault("smith_002", "铠甲匠人", "专攻防具打造的匠人", "npc_armorsmith",
             NPC_TAG_BASIC | NPC_TAG_BLACKSMITH | NPC_TAG_CRAFT, 0, 18, 0,
             "好甲配好盾，防御是最好的攻击。");

  // ---- 特殊功能 NPC（主城 0 或特定城市投放） ----
  // 银行 NPC
  addDefault("banker_001", "银行职员", "管理仓库的银行职员", "npc_banker",
             NPC_TAG_BASIC | NPC_TAG_BANK, 0, 8, 0,
             "可以存储物品，安全又方便。");

  // 传送 NPC
  addDefault("teleport_001", "传送法师", "精通空间魔法的法师", "npc_mage",
             NPC_TAG_BASIC | NPC_TAG_TELEPORT, 0, 25, 0,
             "我可以把你送到任何一座主城，只需片刻。");

  // 合成 NPC
  addDefault("alchemist_001", "炼金术士", "研究物品合成的学者", "npc_alchemist",
             NPC_TAG_BASIC | NPC_TAG_CRAFT, 0, 20, 0,
             "给我材料，我能合成出稀有的药水和道具。");

  // ---- 氛围 NPC（纯装饰，无特殊功能，增加世界活力） ----
  addDefault("villager_001", "村民", "朴实的当地居民", "npc_villager",
             NPC_TAG_BASIC, 0, 1, 5.0,
             "今天天气不错啊。");
  addDefault("villager_002", "巡逻卫兵", "维护城市安全的卫兵", "npc_guard",
             NPC_TAG_BASIC, 0, 20, 4.0,
             "城市很安全，放心休息吧。");
  addDefault("villager_003", "流浪吟游诗人", "四处游历的诗人", "npc_bard",
             NPC_TAG_BASIC, 0, 3, 6.0,
             "要听一首关于远古巨龙的歌吗？");
  addDefault("villager_004", "钓鱼老者", "在河边垂钓的老人", "npc_fisher",
             NPC_TAG_BASIC, 0, 1, 0,
             "嘘……别吓跑我的鱼。");
  addDefault("villager_005", "训练师", "指导新人战斗技巧的教官", "npc_trainer",
             NPC_TAG_BASIC | NPC_TAG_QUEST, 0, 30, 2.0,
             "想要变强？先完成我的训练考验。");

  fprintf(stderr, "[npc] 默认花名册加载：%zu 种 NPC\n", npcs_.size());
}

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
