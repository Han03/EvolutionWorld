// quests.cpp - 任务系统实现（数据驱动 + 服务端权威）
#include "quests.h"
#include "entity.h"
#include "world.h"
#include "net/protocol.h"
#include <cstdio>
#include <fstream>
#include <cmath>
#include <algorithm>

namespace ew {

// ---------- QuestDef 显示辅助 ----------
const char* QuestDef::categoryName(QuestCategory c) {
  switch (c) {
    case QuestCategory::MAIN: return "主线";
    case QuestCategory::SIDE: return "支线";
    case QuestCategory::DAILY: return "日常";
    case QuestCategory::REPEATABLE: return "可重复";
    default: return "未知";
  }
}
const char* QuestDef::objTypeName(QuestObjType t) {
  switch (t) {
    case QuestObjType::KILL_MONSTER: return "击杀";
    case QuestObjType::COLLECT_ITEM: return "收集";
    case QuestObjType::REACH_LOCATION: return "到达";
    case QuestObjType::TALK_NPC: return "对话";
    case QuestObjType::ESCORT: return "护送";
    default: return "未知";
  }
}
QuestCategory QuestDef::categoryFromStr(const std::string& s) {
  if (s == "main") return QuestCategory::MAIN;
  if (s == "side") return QuestCategory::SIDE;
  if (s == "daily") return QuestCategory::DAILY;
  if (s == "repeatable") return QuestCategory::REPEATABLE;
  return QuestCategory::SIDE;
}
QuestObjType QuestDef::objTypeFromStr(const std::string& s) {
  if (s == "kill") return QuestObjType::KILL_MONSTER;
  if (s == "collect") return QuestObjType::COLLECT_ITEM;
  if (s == "reach") return QuestObjType::REACH_LOCATION;
  if (s == "talk") return QuestObjType::TALK_NPC;
  if (s == "escort") return QuestObjType::ESCORT;
  return QuestObjType::KILL_MONSTER;
}

// ---------- QuestSystem ----------
QuestSystem::QuestSystem(World& w) : world_(w) {}

void QuestSystem::init() {
  loadDefaults();
  loadFromJson(world_.config().dataDir);
  fprintf(stderr, "[quests] 初始化完成: %zu 个任务模板\n", quests_.size());
}

const QuestDef* QuestSystem::questDef(uint32_t id) const {
  auto it = quests_.find(id);
  return it == quests_.end() ? nullptr : &it->second;
}

// ---------- 默认任务数据 ----------
void QuestSystem::addDefaultQuest(uint32_t id, const char* name, const char* desc,
                                   QuestCategory cat, int levelReq) {
  QuestDef q;
  q.id = id; q.name = name; q.desc = desc;
  q.category = cat; q.levelReq = levelReq;
  quests_[id] = q;
}

void QuestSystem::loadDefaults() {
  // 1. 主线：初入世界 - 与任意NPC对话 → 击杀5只狼 → 与任意NPC对话报告
  //    链式：完成后解锁 1002「荒原威胁」
  {
    addDefaultQuest(1001, "初入世界", "你来到了这片陌生的大陆。先与当地人交谈，了解这片世界的情况，然后消灭附近的狼群威胁。",
                    QuestCategory::MAIN, 1);
    auto& q = quests_[1001];
    QuestObjective o1; o1.index = 0; o1.type = QuestObjType::TALK_NPC;
    o1.desc = "与村民交谈"; o1.required = 1; o1.targetId = 0;
    q.objectives.push_back(o1);
    QuestObjective o2; o2.index = 1; o2.type = QuestObjType::KILL_MONSTER;
    o2.targetKey = "wolf"; o2.desc = "击杀灰狼"; o2.required = 5;
    q.objectives.push_back(o2);
    QuestObjective o3; o3.index = 2; o3.type = QuestObjType::TALK_NPC;
    o3.desc = "向村民报告"; o3.required = 1; o3.targetId = 0;
    q.objectives.push_back(o3);
    q.rewards.gold = 50;
    q.rewards.items.push_back({1501, 1}); // 铁剑
    q.nextQuestIds.push_back(1002);       // 链式：解锁「荒原威胁」
  }
  // 2. 支线：采集药草 - 收集3个草药
  {
    addDefaultQuest(2001, "采集药草", "村里的药师需要一些草药来制作绷带。收集草药并交付。",
                    QuestCategory::SIDE, 1);
    auto& q = quests_[2001];
    QuestObjective o; o.index = 0; o.type = QuestObjType::COLLECT_ITEM;
    o.targetId = 3001; o.targetKey = "3001"; o.desc = "收集草药"; o.required = 3;
    q.objectives.push_back(o);
    q.rewards.gold = 20;
    q.rewards.items.push_back({2001, 3}); // 小血瓶 x3
  }
  // 3. 支线：探索遗迹 - 到达指定坐标
  {
    addDefaultQuest(2002, "探索遗迹", "据说大陆中央有一处古老遗迹，前去探索并回报。",
                    QuestCategory::SIDE, 1);
    auto& q = quests_[2002];
    QuestObjective o; o.index = 0; o.type = QuestObjType::REACH_LOCATION;
    o.targetX = 60; o.targetZ = 60; o.radius = 8.0;
    o.desc = "到达古老遗迹"; o.required = 1;
    q.objectives.push_back(o);
    q.rewards.gold = 30;
  }
  // 4. 日常：猎魔修行 - 击杀10只任意怪物
  {
    addDefaultQuest(3001, "猎魔修行", "通过战斗磨炼自己。击杀任意怪物10只。",
                    QuestCategory::DAILY, 1);
    auto& q = quests_[3001];
    QuestObjective o; o.index = 0; o.type = QuestObjType::KILL_MONSTER;
    o.targetKey = "*"; o.desc = "击杀任意怪物"; o.required = 10;
    q.objectives.push_back(o);
    q.rewards.gold = 30;
    q.dailyCooldownSec = 86400; // 24h
  }
  // 5. 支线：商人的委托 - 与NPC对话 → 收集物品
  {
    addDefaultQuest(2003, "商人的委托", "旅行商人需要一批物资。先与他交谈了解详情。",
                    QuestCategory::SIDE, 3);
    auto& q = quests_[2003];
    QuestObjective o1; o1.index = 0; o1.type = QuestObjType::TALK_NPC;
    o1.desc = "与旅行商人交谈"; o1.required = 1;
    q.objectives.push_back(o1);
    QuestObjective o2; o2.index = 1; o2.type = QuestObjType::COLLECT_ITEM;
    o2.targetId = 3001; o2.targetKey = "3001"; o2.desc = "收集草药"; o2.required = 5;
    q.objectives.push_back(o2);
    QuestObjective o3; o3.index = 2; o3.type = QuestObjType::TALK_NPC;
    o3.desc = "向旅行商人交付"; o3.required = 1;
    q.objectives.push_back(o3);
    q.rewards.gold = 40;
    q.rewards.items.push_back({2002, 2}); // 中血瓶 x2
  }
  // 6. 主线：荒原威胁 - 前置：1001 → 击杀Boss → 链式：解锁 2004「勇者试炼」
  {
    addDefaultQuest(1002, "荒原威胁", "荒原深处的巨兽开始频繁出没，威胁到城镇安全。前往消灭它！",
                    QuestCategory::MAIN, 5);
    auto& q = quests_[1002];
    q.prerequisites.push_back(1001);
    QuestObjective o; o.index = 0; o.type = QuestObjType::KILL_MONSTER;
    o.targetKey = "gargoyle"; o.desc = "击杀荒原巨兽"; o.required = 1;
    q.objectives.push_back(o);
    q.rewards.gold = 200;
    q.rewards.skills.push_back(1003); // 解锁技能
    q.nextQuestIds.push_back(2004);   // 链式：解锁「勇者试炼」
  }
  // 7. 日常：矿材收集 - 收集5个矿石
  {
    addDefaultQuest(3002, "矿材收集", "铁匠需要矿石来打造装备。帮忙收集一些。",
                    QuestCategory::DAILY, 2);
    auto& q = quests_[3002];
    QuestObjective o; o.index = 0; o.type = QuestObjType::COLLECT_ITEM;
    o.targetId = 3002; o.targetKey = "3002"; o.desc = "收集矿石"; o.required = 5;
    q.objectives.push_back(o);
    q.rewards.gold = 25;
    q.dailyCooldownSec = 86400;
  }
  // 8. 支线：勇者试炼 - 前置：完成主线1 → 击杀精英怪
  {
    addDefaultQuest(2004, "勇者试炼", "证明你的实力。击败荒原上的石像鬼。",
                    QuestCategory::SIDE, 5);
    auto& q = quests_[2004];
    q.prerequisites.push_back(1001);
    QuestObjective o; o.index = 0; o.type = QuestObjType::KILL_MONSTER;
    o.targetKey = "gargoyle"; o.desc = "击败石像鬼"; o.required = 1;
    q.objectives.push_back(o);
    q.rewards.gold = 100;
    q.rewards.items.push_back({1502, 1}); // 皮甲
  }
}

bool QuestSystem::loadFromJson(const std::string& dir) {
  std::string path = dir + "/quests.json";
  std::ifstream f(path);
  if (!f.is_open()) return false;
  std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if (content.empty()) return false;
  try {
    Json root = Json::parse(content);
    if (root.type() != Json::Type::Array) return false;
    for (const auto& j : root.asArray()) {
      QuestDef q;
      q.id = (uint32_t)j.at("id").asInt();
      if (q.id == 0) continue;
      q.name = j.at("name").asString();
      q.desc = j.at("desc").asString();
      q.category = QuestDef::categoryFromStr(j.at("category").asString());
      q.levelReq = (int)j.at("levelReq").asInt();
      if (j.has("prereq") && j.at("prereq").type() == Json::Type::Array) {
        for (const auto& p : j.at("prereq").asArray())
          q.prerequisites.push_back((uint32_t)p.asInt());
      }
      if (j.has("objectives") && j.at("objectives").type() == Json::Type::Array) {
        uint8_t idx = 0;
        for (const auto& oj : j.at("objectives").asArray()) {
          QuestObjective o;
          o.index = idx++;
          o.type = QuestDef::objTypeFromStr(oj.at("type").asString());
          o.targetKey = oj.has("targetKey") ? oj.at("targetKey").asString() : "";
          o.targetId = (uint32_t)(oj.has("targetId") ? oj.at("targetId").asInt() : 0);
          o.targetX = oj.has("x") ? oj.at("x").asNumber() : 0;
          o.targetZ = oj.has("z") ? oj.at("z").asNumber() : 0;
          o.radius = oj.has("radius") ? oj.at("radius").asNumber() : 0;
          o.required = (uint32_t)(oj.has("required") ? oj.at("required").asInt() : 1);
          o.desc = oj.has("desc") ? oj.at("desc").asString() : "";
          q.objectives.push_back(o);
        }
      }
      if (j.has("rewards")) {
        auto& rj = j.at("rewards");
        q.rewards.gold = (uint32_t)(rj.has("gold") ? rj.at("gold").asInt() : 0);
        q.rewards.exp = (uint32_t)(rj.has("exp") ? rj.at("exp").asInt() : 0);
        if (rj.has("items") && rj.at("items").type() == Json::Type::Array) {
          for (const auto& ij : rj.at("items").asArray()) {
            uint32_t itemId = (uint32_t)ij.at("id").asInt();
            uint16_t cnt = (uint16_t)(ij.has("count") ? ij.at("count").asInt() : 1);
            if (itemId) q.rewards.items.push_back({itemId, cnt});
          }
        }
        if (rj.has("skills") && rj.at("skills").type() == Json::Type::Array) {
          for (const auto& sj : rj.at("skills").asArray())
            q.rewards.skills.push_back((uint32_t)sj.asInt());
        }
      }
      q.dailyCooldownSec = (uint32_t)(j.has("dailyCd") ? j.at("dailyCd").asInt() : 0);
      q.repeatLimit = (uint32_t)(j.has("repeatLimit") ? j.at("repeatLimit").asInt() : 0);
      q.talkNpcWid = (uint32_t)(j.has("npcWid") ? j.at("npcWid").asInt() : 0);
      q.giverNpcWid = (uint32_t)(j.has("giverNpc") ? j.at("giverNpc").asInt() : 0);
      if (j.has("nextQuests") && j.at("nextQuests").type() == Json::Type::Array) {
        for (const auto& nq : j.at("nextQuests").asArray())
          q.nextQuestIds.push_back((uint32_t)nq.asInt());
      }
      quests_[q.id] = q;
    }
    fprintf(stderr, "[quests] 加载 quests.json: %zu 个任务\n", quests_.size());
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[quests] quests.json 解析失败（用默认）: %s\n", e.what());
    return false;
  }
}

// ---------- 编辑器：序列化 / 热替换 ----------
static const char* categoryToStr(QuestCategory c) {
  switch (c) {
    case QuestCategory::MAIN: return "main";
    case QuestCategory::SIDE: return "side";
    case QuestCategory::DAILY: return "daily";
    case QuestCategory::REPEATABLE: return "repeatable";
    default: return "side";
  }
}
static const char* objTypeToStr(QuestObjType t) {
  switch (t) {
    case QuestObjType::KILL_MONSTER: return "kill";
    case QuestObjType::COLLECT_ITEM: return "collect";
    case QuestObjType::REACH_LOCATION: return "reach";
    case QuestObjType::TALK_NPC: return "talk";
    case QuestObjType::ESCORT: return "escort";
    default: return "kill";
  }
}

std::string QuestSystem::questsToJson() const {
  Json arr = Json::array();
  for (const auto& [id, q] : quests_) {
    Json j = Json::object();
    j["id"] = (int64_t)q.id;
    j["name"] = q.name;
    j["desc"] = q.desc;
    j["category"] = categoryToStr(q.category);
    j["levelReq"] = (int64_t)q.levelReq;
    // 前置任务
    Json prereq = Json::array();
    for (uint32_t p : q.prerequisites) prereq.push_back((int64_t)p);
    j["prereq"] = prereq;
    // 目标
    Json objs = Json::array();
    for (const auto& o : q.objectives) {
      Json oj = Json::object();
      oj["type"] = objTypeToStr(o.type);
      oj["targetKey"] = o.targetKey;
      oj["targetId"] = (int64_t)o.targetId;
      oj["x"] = o.targetX;
      oj["z"] = o.targetZ;
      oj["radius"] = o.radius;
      oj["required"] = (int64_t)o.required;
      oj["desc"] = o.desc;
      objs.push_back(oj);
    }
    j["objectives"] = objs;
    // 奖励
    Json rw = Json::object();
    rw["gold"] = (int64_t)q.rewards.gold;
    rw["exp"] = (int64_t)q.rewards.exp;
    Json items = Json::array();
    for (const auto& [itemId, cnt] : q.rewards.items) {
      Json ij = Json::object();
      ij["id"] = (int64_t)itemId;
      ij["count"] = (int64_t)cnt;
      items.push_back(ij);
    }
    rw["items"] = items;
    Json skills = Json::array();
    for (uint32_t s : q.rewards.skills) skills.push_back((int64_t)s);
    rw["skills"] = skills;
    j["rewards"] = rw;
    j["dailyCd"] = (int64_t)q.dailyCooldownSec;
    j["repeatLimit"] = (int64_t)q.repeatLimit;
    j["npcWid"] = (int64_t)q.talkNpcWid;
    j["giverNpc"] = (int64_t)q.giverNpcWid;
    Json next = Json::array();
    for (uint32_t nq : q.nextQuestIds) next.push_back((int64_t)nq);
    j["nextQuests"] = next;
    arr.push_back(j);
  }
  return arr.dump();
}

bool QuestSystem::replaceQuests(const Json& arr) {
  if (arr.type() != Json::Type::Array) return false;
  std::unordered_map<uint32_t, QuestDef> newQuests;
  for (const auto& j : arr.asArray()) {
    QuestDef q;
    q.id = (uint32_t)j.at("id").asInt();
    if (q.id == 0) continue;
    q.name = j.at("name").asString();
    q.desc = j.at("desc").asString();
    q.category = QuestDef::categoryFromStr(j.at("category").asString());
    q.levelReq = (int)j.at("levelReq").asInt();
    if (j.has("prereq") && j.at("prereq").type() == Json::Type::Array) {
      for (const auto& p : j.at("prereq").asArray())
        q.prerequisites.push_back((uint32_t)p.asInt());
    }
    if (j.has("objectives") && j.at("objectives").type() == Json::Type::Array) {
      uint8_t idx = 0;
      for (const auto& oj : j.at("objectives").asArray()) {
        QuestObjective o;
        o.index = idx++;
        o.type = QuestDef::objTypeFromStr(oj.at("type").asString());
        o.targetKey = oj.has("targetKey") ? oj.at("targetKey").asString() : "";
        o.targetId = (uint32_t)(oj.has("targetId") ? oj.at("targetId").asInt() : 0);
        o.targetX = oj.has("x") ? oj.at("x").asNumber() : 0;
        o.targetZ = oj.has("z") ? oj.at("z").asNumber() : 0;
        o.radius = oj.has("radius") ? oj.at("radius").asNumber() : 0;
        o.required = (uint32_t)(oj.has("required") ? oj.at("required").asInt() : 1);
        o.desc = oj.has("desc") ? oj.at("desc").asString() : "";
        q.objectives.push_back(o);
      }
    }
    if (j.has("rewards")) {
      auto& rj = j.at("rewards");
      q.rewards.gold = (uint32_t)(rj.has("gold") ? rj.at("gold").asInt() : 0);
      q.rewards.exp = (uint32_t)(rj.has("exp") ? rj.at("exp").asInt() : 0);
      if (rj.has("items") && rj.at("items").type() == Json::Type::Array) {
        for (const auto& ij : rj.at("items").asArray()) {
          uint32_t itemId = (uint32_t)ij.at("id").asInt();
          uint16_t cnt = (uint16_t)(ij.has("count") ? ij.at("count").asInt() : 1);
          if (itemId) q.rewards.items.push_back({itemId, cnt});
        }
      }
      if (rj.has("skills") && rj.at("skills").type() == Json::Type::Array) {
        for (const auto& sj : rj.at("skills").asArray())
          q.rewards.skills.push_back((uint32_t)sj.asInt());
      }
    }
    q.dailyCooldownSec = (uint32_t)(j.has("dailyCd") ? j.at("dailyCd").asInt() : 0);
    q.repeatLimit = (uint32_t)(j.has("repeatLimit") ? j.at("repeatLimit").asInt() : 0);
    q.talkNpcWid = (uint32_t)(j.has("npcWid") ? j.at("npcWid").asInt() : 0);
    q.giverNpcWid = (uint32_t)(j.has("giverNpc") ? j.at("giverNpc").asInt() : 0);
    if (j.has("nextQuests") && j.at("nextQuests").type() == Json::Type::Array) {
      for (const auto& nq : j.at("nextQuests").asArray())
        q.nextQuestIds.push_back((uint32_t)nq.asInt());
    }
    newQuests[q.id] = q;
  }
  quests_ = std::move(newQuests);
  fprintf(stderr, "[quests] 热替换任务配置：%zu 个任务\n", quests_.size());
  return true;
}

// ---------- 前置/冷却检测 ----------
bool QuestSystem::checkPrerequisites(const Entity& p, const QuestDef& qd) const {
  for (uint32_t preId : qd.prerequisites) {
    if (!isCompleted(p, preId)) return false;
  }
  return true;
}

bool QuestSystem::isOnCooldown(const Entity& p, const QuestDef& qd, uint64_t nowMs) const {
  if (qd.category != QuestCategory::DAILY && qd.category != QuestCategory::REPEATABLE)
    return false;
  auto it = p.questCooldown.find(qd.id);
  if (it == p.questCooldown.end()) return false;
  return nowMs < it->second;
}

// ---------- 玩家操作 ----------
QuestResult QuestSystem::acceptQuest(const std::string& playerId, uint32_t questId, uint32_t npcWid) {
  Entity* p = world_.findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return QUEST_ERR_NOT_FOUND;
  const QuestDef* qd = questDef(questId);
  if (!qd) return QUEST_ERR_NOT_FOUND;
  // 已在进行中
  if (findActiveQuest(*p, questId)) return QUEST_ERR_ALREADY_ACTIVE;
  // 等级
  if (p->level < qd->levelReq) return QUEST_ERR_LEVEL;
  // 前置任务链
  if (!checkPrerequisites(*p, *qd)) return QUEST_ERR_PREREQ;
  // 活跃上限
  if (p->activeQuests.size() >= world_.config().maxActiveQuests) return QUEST_ERR_FULL;
  // 日常/可重复冷却
  uint64_t nowMs = world_.logicNowMs();
  if (isOnCooldown(*p, *qd, nowMs)) return QUEST_ERR_COOLDOWN;
  // 一次性任务已完成且不可重复
  if (isCompleted(*p, questId) && qd->category == QuestCategory::MAIN) return QUEST_ERR_NOT_REPEATABLE;
  if (isCompleted(*p, questId) && qd->category == QuestCategory::SIDE && qd->repeatLimit == 0)
    return QUEST_ERR_NOT_REPEATABLE;
  // NPC 绑定校验：giverNpcWid > 0 时，必须在发布者 NPC 附近接取
  if (qd->giverNpcWid > 0) {
    Entity* npc = world_.findByWid(qd->giverNpcWid);
    if (!npc || npc->kind != EntityKind::Npc) return QUEST_ERR_NOT_GIVER;
    if (p->pos.dist2D(npc->pos) > world_.config().questTalkRangeM) return QUEST_ERR_NOT_GIVER;
  } else if (npcWid > 0) {
    // giverNpcWid=0 时，如果客户端传入了 npcWid，做通用距离校验
    Entity* npc = world_.findByWid(npcWid);
    if (!npc || npc->kind != EntityKind::Npc) return QUEST_ERR_NPC_RANGE;
    if (p->pos.dist2D(npc->pos) > world_.config().questTalkRangeM) return QUEST_ERR_NPC_RANGE;
  }
  // 接受
  ActiveQuest aq;
  aq.questId = questId;
  aq.acceptedAtMs = nowMs;
  aq.progress.resize(qd->objectives.size(), 0);
  aq.status = 0;
  p->activeQuests.push_back(aq);
  markQuestDirty(playerId);
  fprintf(stderr, "[quest] %s 接受任务 %u (%s) [giverNpc=%u]\n", p->username.c_str(),
          questId, qd->name.c_str(), qd->giverNpcWid);
  return QUEST_OK;
}

QuestResult QuestSystem::abandonQuest(const std::string& playerId, uint32_t questId) {
  Entity* p = world_.findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return QUEST_ERR_NOT_FOUND;
  auto it = std::find_if(p->activeQuests.begin(), p->activeQuests.end(),
    [questId](const ActiveQuest& aq) { return aq.questId == questId; });
  if (it == p->activeQuests.end()) return QUEST_ERR_NOT_ACTIVE;
  const QuestDef* qd = questDef(questId);
  p->activeQuests.erase(it);
  markQuestDirty(playerId);
  fprintf(stderr, "[quest] %s 放弃任务 %u (%s)\n", p->username.c_str(), questId,
          qd ? qd->name.c_str() : "?");
  return QUEST_OK;
}

QuestResult QuestSystem::turnInQuest(const std::string& playerId, uint32_t questId, uint32_t npcWid) {
  Entity* p = world_.findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return QUEST_ERR_NOT_FOUND;
  const QuestDef* qd = questDef(questId);
  if (!qd) return QUEST_ERR_NOT_FOUND;
  const ActiveQuest* aq = findActiveQuest(*p, questId);
  if (!aq) return QUEST_ERR_NOT_ACTIVE;
  // 必须可提交
  if (aq->status != 1) return QUEST_ERR_NOT_COMPLETABLE;
  // NPC 距离校验（talkNpcWid > 0 时）
  if (qd->talkNpcWid > 0 && npcWid > 0) {
    Entity* npc = world_.findByWid(npcWid);
    if (!npc || npc->kind != EntityKind::Npc) return QUEST_ERR_NPC_RANGE;
    if (p->pos.dist2D(npc->pos) > world_.config().questTalkRangeM) return QUEST_ERR_NPC_RANGE;
  }
  // 发放奖励
  grantRewards(*p, qd->rewards);
  // 标记完成
  p->completedQuests.insert(questId);
  // 移除活跃
  auto it = std::find_if(p->activeQuests.begin(), p->activeQuests.end(),
    [questId](const ActiveQuest& aq2) { return aq2.questId == questId; });
  if (it != p->activeQuests.end()) p->activeQuests.erase(it);
  // 日常/可重复：设置冷却
  if (qd->category == QuestCategory::DAILY && qd->dailyCooldownSec > 0) {
    uint64_t nowMs = world_.logicNowMs();
    p->questCooldown[questId] = nowMs + (uint64_t)qd->dailyCooldownSec * 1000;
  }
  markQuestDirty(playerId);
  world_.markInvDirty(playerId);  // 背包/金币可能变化
  world_.markStatsDirty(playerId);
  world_.markSkillsDirty(playerId); // 可能解锁技能
  fprintf(stderr, "[quest] %s 完成任务 %u (%s) 奖励 gold=%u items=%zu skills=%zu\n",
          p->username.c_str(), questId, qd->name.c_str(), qd->rewards.gold,
          qd->rewards.items.size(), qd->rewards.skills.size());
  return QUEST_OK;
}

// ---------- 事件钩子 ----------
void QuestSystem::onMonsterKill(Entity& player, const std::string& monsterType) {
  if (player.kind != EntityKind::Player) return;
  for (auto& aq : player.activeQuests) {
    const QuestDef* qd = questDef(aq.questId);
    if (!qd || aq.status == 1) continue; // 已完成的不处理
    for (size_t i = 0; i < qd->objectives.size(); i++) {
      const auto& obj = qd->objectives[i];
      if (obj.type != QuestObjType::KILL_MONSTER) continue;
      if (obj.targetKey != "*" && obj.targetKey != monsterType) continue;
      if (aq.progress[i] < obj.required) {
        aq.progress[i]++;
        checkCompletable(aq, *qd);
        markQuestDirty(player.id);
        // 进度通知
        std::string notify = questNotifyFrame(aq.questId, obj.index,
          aq.progress[i], obj.required, aq.status == 1);
        // 通过 world 推送给该玩家（此处直接标记，由 netcode tick 发送）
        // 实际上我们可以直接通过 netcode 发送，但为了解耦，用 dirty 标记
        (void)notify; // 进度通知在 questProgressFrame 中统一发送
      }
    }
  }
}

void QuestSystem::onItemAcquired(Entity& player, uint32_t itemId, uint32_t count) {
  if (player.kind != EntityKind::Player) return;
  for (auto& aq : player.activeQuests) {
    const QuestDef* qd = questDef(aq.questId);
    if (!qd || aq.status == 1) continue;
    for (size_t i = 0; i < qd->objectives.size(); i++) {
      const auto& obj = qd->objectives[i];
      if (obj.type != QuestObjType::COLLECT_ITEM) continue;
      if (obj.targetId != itemId) continue;
      if (aq.progress[i] < obj.required) {
        aq.progress[i] = std::min(aq.progress[i] + count, obj.required);
        checkCompletable(aq, *qd);
        markQuestDirty(player.id);
      }
    }
  }
}

void QuestSystem::onPlayerMove(Entity& player) {
  if (player.kind != EntityKind::Player) return;
  for (auto& aq : player.activeQuests) {
    const QuestDef* qd = questDef(aq.questId);
    if (!qd || aq.status == 1) continue;
    for (size_t i = 0; i < qd->objectives.size(); i++) {
      const auto& obj = qd->objectives[i];
      if (obj.type != QuestObjType::REACH_LOCATION) continue;
      if (aq.progress[i] >= obj.required) continue;
      double r = obj.radius > 0 ? obj.radius : world_.config().questReachRadius;
      double dx = player.pos.x - obj.targetX;
      double dz = player.pos.z - obj.targetZ;
      if (std::sqrt(dx * dx + dz * dz) <= r) {
        aq.progress[i] = obj.required;
        checkCompletable(aq, *qd);
        markQuestDirty(player.id);
      }
    }
  }
}

void QuestSystem::onTalkNpc(Entity& player, uint32_t npcWid) {
  if (player.kind != EntityKind::Player) return;
  (void)npcWid; // targetId=0 表示任意 NPC
  for (auto& aq : player.activeQuests) {
    const QuestDef* qd = questDef(aq.questId);
    if (!qd || aq.status == 1) continue;
    for (size_t i = 0; i < qd->objectives.size(); i++) {
      const auto& obj = qd->objectives[i];
      if (obj.type != QuestObjType::TALK_NPC) continue;
      // targetId=0 表示任意 NPC，否则需匹配
      if (obj.targetId != 0 && obj.targetId != npcWid) continue;
      if (aq.progress[i] < obj.required) {
        aq.progress[i] = obj.required; // 对话一次即完成
        checkCompletable(aq, *qd);
        markQuestDirty(player.id);
      }
    }
  }
}

// ---------- tick（日常重置检测） ----------
void QuestSystem::tick(double dt) {
  (void)dt;
  // 日常冷却检测：由客户端请求列表时服务端校验，此处无需主动处理
  // 预留：自动追踪标记等
}

// ---------- 辅助 ----------
void QuestSystem::checkCompletable(ActiveQuest& aq, const QuestDef& qd) {
  bool allDone = true;
  for (size_t i = 0; i < qd.objectives.size(); i++) {
    if (aq.progress[i] < qd.objectives[i].required) { allDone = false; break; }
  }
  if (allDone) aq.status = 1; // completable
}

void QuestSystem::updateProgress(Entity& p, uint32_t questId, uint8_t objIndex, uint32_t delta) {
  ActiveQuest* aq = nullptr;
  for (auto& a : p.activeQuests) if (a.questId == questId) { aq = &a; break; }
  if (!aq) return;
  const QuestDef* qd = questDef(questId);
  if (!qd || objIndex >= qd->objectives.size()) return;
  aq->progress[objIndex] = std::min(aq->progress[objIndex] + delta, qd->objectives[objIndex].required);
  checkCompletable(*aq, *qd);
  markQuestDirty(p.id);
}

void QuestSystem::grantRewards(Entity& p, const QuestReward& rw) {
  if (rw.gold > 0) {
    p.pl.gold += rw.gold;
  }
  for (const auto& [itemId, count] : rw.items) {
    world_.giveItemSmart(p, itemId, (uint16_t)count);  // 装备→实例；其余→堆叠
  }
  for (uint32_t skillId : rw.skills) {
    p.learnedSkills.insert(skillId);
    p.skillCd[skillId] = 0;
  }
}

const ActiveQuest* QuestSystem::findActiveQuest(const Entity& p, uint32_t questId) const {
  for (const auto& aq : p.activeQuests)
    if (aq.questId == questId) return &aq;
  return nullptr;
}

bool QuestSystem::isCompleted(const Entity& p, uint32_t questId) const {
  return p.completedQuests.count(questId) > 0;
}

std::vector<const QuestDef*> QuestSystem::availableQuests(const Entity& p, uint32_t npcWid) const {
  std::vector<const QuestDef*> out;
  uint64_t nowMs = world_.logicNowMs();
  for (const auto& [id, qd] : quests_) {
    if (p.level < qd.levelReq) continue;
    if (findActiveQuest(p, id)) continue; // 已在进行中
    if (isCompleted(p, id)) {
      // 已完成：仅日常/可重复可再次接受
      if (qd.category == QuestCategory::MAIN) continue;
      if (qd.category == QuestCategory::SIDE && qd.repeatLimit == 0) continue;
      if (isOnCooldown(p, qd, nowMs)) continue;
    }
    if (!checkPrerequisites(p, qd)) continue;
    // NPC 过滤：npcWid > 0 时仅返回该 NPC 发布的任务
    if (npcWid > 0 && qd.giverNpcWid != 0 && qd.giverNpcWid != npcWid) continue;
    out.push_back(&qd);
  }
  // 按分类+ID 排序（主线优先）
  std::sort(out.begin(), out.end(), [](const QuestDef* a, const QuestDef* b) {
    if ((int)a->category != (int)b->category) return (int)a->category < (int)b->category;
    return a->id < b->id;
  });
  return out;
}

std::vector<const ActiveQuest*> QuestSystem::completableQuests(const Entity& p) const {
  std::vector<const ActiveQuest*> out;
  for (const auto& aq : p.activeQuests)
    if (aq.status == 1) out.push_back(&aq);
  return out;
}

// ---------- 网络帧 ----------
std::string QuestSystem::questListFrame(const Entity& p, uint32_t npcWid) const {
  auto avail = availableQuests(p, npcWid);
  proto::Writer w;
  w.u16((uint16_t)avail.size());
  for (const QuestDef* qd : avail) {
    w.u32(qd->id);
    w.u8((uint8_t)qd->category);
    w.str(qd->name);
    w.str(qd->desc);
    w.i32((int32_t)qd->levelReq);
    w.u32(qd->giverNpcWid); // 发布者 NPC wid（客户端用于显示 NPC 名称）
    w.u16((uint16_t)qd->objectives.size());
    for (const auto& obj : qd->objectives) {
      w.u8((uint8_t)obj.type);
      w.u32(obj.targetId);
      w.u32(obj.required);
      w.str(obj.desc);
    }
    w.u32(qd->rewards.gold);
    w.u16((uint16_t)qd->rewards.items.size());
    for (const auto& [itemId, cnt] : qd->rewards.items) {
      w.u32(itemId);
      w.u16(cnt);
    }
    w.u16((uint16_t)qd->rewards.skills.size());
    for (uint32_t sid : qd->rewards.skills) w.u32(sid);
    // 链式后续任务 ID 列表
    w.u16((uint16_t)qd->nextQuestIds.size());
    for (uint32_t nqId : qd->nextQuestIds) w.u32(nqId);
  }
  return proto::frame(proto::S2C_QUEST_LIST, w.data());
}

std::string QuestSystem::questProgressFrame(const Entity& p) const {
  proto::Writer w;
  w.u16((uint16_t)p.activeQuests.size());
  for (const auto& aq : p.activeQuests) {
    const QuestDef* qd = questDef(aq.questId);
    w.u32(aq.questId);
    w.u8(aq.status);
    uint16_t objCount = qd ? (uint16_t)qd->objectives.size() : (uint16_t)aq.progress.size();
    w.u16(objCount);
    for (uint16_t i = 0; i < objCount; i++) {
      uint32_t current = i < aq.progress.size() ? aq.progress[i] : 0;
      uint32_t required = (qd && i < qd->objectives.size()) ? qd->objectives[i].required : 0;
      w.u32(current);
      w.u32(required);
    }
  }
  return proto::frame(proto::S2C_QUEST_PROGRESS, w.data());
}

std::string QuestSystem::questResultFrame(uint8_t op, uint8_t code, uint32_t questId) const {
  proto::Writer w;
  w.u8(op);
  w.u8(code);
  w.u32(questId);
  return proto::frame(proto::S2C_QUEST_RESULT, w.data());
}

std::string QuestSystem::questNotifyFrame(uint32_t questId, uint8_t objIndex,
                                           uint32_t current, uint32_t required,
                                           bool allComplete) const {
  proto::Writer w;
  w.u32(questId);
  w.u8(objIndex);
  w.u32(current);
  w.u32(required);
  w.u8(allComplete ? 1 : 0);
  return proto::frame(proto::S2C_QUEST_NOTIFY, w.data());
}

std::string QuestSystem::questCompleteFrame(uint32_t questId) const {
  proto::Writer w;
  w.u32(questId);
  return proto::frame(proto::S2C_QUEST_COMPLETE, w.data());
}

std::string QuestSystem::questChainFrame(uint32_t completedQuestId,
                                          const std::vector<uint32_t>& nextIds) const {
  proto::Writer w;
  w.u32(completedQuestId);
  w.u16((uint16_t)nextIds.size());
  for (uint32_t id : nextIds) w.u32(id);
  return proto::frame(proto::S2C_QUEST_CHAIN, w.data());
}

// ---------- 持久化 ----------
std::string QuestSystem::serializeQuests(const Entity& p) const {
  Json root = Json::object();
  // 活跃任务
  Json active = Json::array();
  for (const auto& aq : p.activeQuests) {
    Json aqj = Json::object();
    aqj["questId"] = (int64_t)aq.questId;
    aqj["acceptedAt"] = (int64_t)aq.acceptedAtMs;
    aqj["status"] = (int64_t)aq.status;
    Json prog = Json::array();
    for (uint32_t v : aq.progress) prog.push_back((int64_t)v);
    aqj["progress"] = prog;
    active.push_back(std::move(aqj));
  }
  root["active"] = std::move(active);
  // 已完成
  Json completed = Json::array();
  for (uint32_t id : p.completedQuests) completed.push_back((int64_t)id);
  root["completed"] = std::move(completed);
  // 日常任务冷却：存「剩余毫秒」而非「到期时刻」，键名 cooldownRemain 同时充当格式标记。
  // 原因：questCooldown 的值是逻辑时钟（原点=本进程启动）下的到期时刻，而逻辑钟重启
  // 即归零；若直接落库，每次重启都会把「已流逝的真实时间」清零重算 —— 24h 日常冷却被
  // 延长（延长量 = 重启前进程已运行时长），频繁重启可致日常任务长期锁死。
  // 存剩余量则与时钟原点完全解耦，天然抗重启。
  // 语义副作用（有意接受）：离线期间冷却不流逝，等价于「按在线时长计的日常」。
  // 若需真实自然日语义，须改存 system_clock 的 Unix 毫秒并做回拨防护（独立议题）。
  const uint64_t nowMs = world_.logicNowMs();
  Json cd = Json::object();
  for (const auto& [id, readyAtMs] : p.questCooldown) {
    if (readyAtMs <= nowMs) continue;   // 已到期：不落库，避免脏数据无限累积
    cd[std::to_string(id)] = (int64_t)(readyAtMs - nowMs);
  }
  root["cooldownRemain"] = std::move(cd);
  return root.dump();
}

bool QuestSystem::deserializeQuests(Entity& p, const std::string& json) const {
  if (json.empty()) return false;
  try {
    Json root = Json::parse(json);
    p.activeQuests.clear();
    p.completedQuests.clear();
    p.questCooldown.clear();
    if (root.has("active") && root.at("active").type() == Json::Type::Array) {
      for (const auto& aqj : root.at("active").asArray()) {
        ActiveQuest aq;
        aq.questId = (uint32_t)aqj.at("questId").asInt();
        aq.acceptedAtMs = (uint64_t)aqj.at("acceptedAt").asInt();
        aq.status = (uint8_t)aqj.at("status").asInt();
        if (aqj.has("progress") && aqj.at("progress").type() == Json::Type::Array) {
          for (const auto& v : aqj.at("progress").asArray())
            aq.progress.push_back((uint32_t)v.asInt());
        }
        p.activeQuests.push_back(std::move(aq));
      }
    }
    if (root.has("completed") && root.at("completed").type() == Json::Type::Array) {
      for (const auto& v : root.at("completed").asArray())
        p.completedQuests.insert((uint32_t)v.asInt());
    }
    // 冷却：新格式 cooldownRemain 存剩余毫秒；旧格式 cooldown 存逻辑钟到期时刻。
    const uint64_t nowMs = world_.logicNowMs();
    if (root.has("cooldownRemain") && root.at("cooldownRemain").type() == Json::Type::Object) {
      for (const auto& [k, v] : root.at("cooldownRemain").asObject()) {
        uint32_t id = (uint32_t)atoi(k.c_str());
        int64_t remain = v.asInt();
        if (remain <= 0) continue;
        p.questCooldown[id] = nowMs + (uint64_t)remain;
      }
    } else if (root.has("cooldown") && root.at("cooldown").type() == Json::Type::Object) {
      // 旧档迁移（一次性）：旧值与当前逻辑钟分属不同进程的原点，相减本无意义，故只做
      // 安全收敛 —— 以该任务的 dailyCooldownSec 为上界，clamp 后从「现在」重新起算。
      // 效果：存量污染（已被重启延长过的冷却）被修正为最多一个完整周期，不会更糟。
      for (const auto& [k, v] : root.at("cooldown").asObject()) {
        uint32_t id = (uint32_t)atoi(k.c_str());
        int64_t stored = v.asInt();
        if (stored <= 0) continue;
        if ((uint64_t)stored <= nowMs) continue;   // 在当前钟下已过期 → 视为就绪
        const QuestDef* qd = questDef(id);
        if (!qd || qd->dailyCooldownSec == 0) continue;  // 无定义/无冷却配置 → 不锁玩家
        const uint64_t cap = (uint64_t)qd->dailyCooldownSec * 1000;
        p.questCooldown[id] = nowMs + std::min<uint64_t>((uint64_t)stored - nowMs, cap);
      }
    }
    return true;
  } catch (...) {
    return false;
  }
}

void QuestSystem::markQuestDirty(const std::string& playerId) {
  questDirty_.insert(playerId);
}

std::vector<uint32_t> QuestSystem::getNextQuestIds(uint32_t completedQuestId) const {
  const QuestDef* qd = questDef(completedQuestId);
  if (!qd) return {};
  return qd->nextQuestIds;
}

} // namespace ew
