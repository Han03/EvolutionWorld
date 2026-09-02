// quests.h - 任务系统（大型网游规模，数据驱动）
//
// 设计要点：
//  - 任务定义 QuestDef 按 ID 管理：名称/描述/分类/前置/目标/奖励
//  - 分类：主线 / 支线 / 日常 / 可重复
//  - 目标类型：击杀怪物 / 收集物品 / 到达坐标 / 对话 NPC / 护送（预留）
//  - 状态机：UNAVAILABLE -> AVAILABLE -> ACTIVE -> COMPLETABLE -> COMPLETED
//  - 服务端权威：进度/奖励/冷却全部由服务端校验
//  - 数据驱动：内置默认任务 + 可选 JSON 覆盖（data/quests.json）
//  - 持久化：通过 Store 抽象层（MySQL + 内存兜底）
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "util/json.h"

namespace ew {

class World;
struct Entity;

// ---------- 任务分类 ----------
enum class QuestCategory : uint8_t {
  MAIN = 1,       // 主线
  SIDE = 2,       // 支线
  DAILY = 3,      // 日常（每日重置）
  REPEATABLE = 4, // 可重复
};

// ---------- 目标类型 ----------
enum class QuestObjType : uint8_t {
  KILL_MONSTER  = 1, // 击杀指定怪物类型 N 只
  COLLECT_ITEM  = 2, // 收集指定物品 N 个
  REACH_LOCATION = 3, // 到达指定坐标范围
  TALK_NPC      = 4, // 与指定 NPC 对话
  ESCORT        = 5, // 护送 NPC（预留）
};

// ---------- 任务目标定义 ----------
struct QuestObjective {
  uint8_t index = 0;              // 目标序号（0-based）
  QuestObjType type = QuestObjType::KILL_MONSTER;
  std::string targetKey;          // 怪物类型 key / itemId 字符串 / NPC id
  uint32_t targetId = 0;          // 数值 ID（itemId / npcWid 等）
  double targetX = 0, targetZ = 0; // 坐标目标用
  double radius = 0;              // 到达判定半径（REACH_LOCATION）
  uint32_t required = 1;          // 需要数量
  std::string desc;               // 客户端展示文本
};

// ---------- 任务奖励 ----------
struct QuestReward {
  uint32_t gold = 0;
  uint32_t exp = 0;               // 经验值（预留，当前项目无经验系统）
  std::vector<std::pair<uint32_t, uint16_t>> items; // itemId, count
  std::vector<uint32_t> skills;   // 解锁技能 ID
};

// ---------- 任务操作码（供客户端识别） ----------
enum QuestOp : uint8_t {
  QUEST_OP_ACCEPT  = 0,
  QUEST_OP_ABANDON = 1,
  QUEST_OP_TURNIN  = 2,
  QUEST_OP_LIST    = 3,
};

// ---------- 任务操作结果码 ----------
enum QuestResult : uint8_t {
  QUEST_OK = 0,
  QUEST_ERR_NOT_FOUND = 1,       // 任务不存在
  QUEST_ERR_ALREADY_ACTIVE = 2,  // 已在进行中
  QUEST_ERR_PREREQ = 3,          // 前置任务未完成
  QUEST_ERR_LEVEL = 4,           // 等级不足
  QUEST_ERR_FULL = 5,            // 活跃任务已满
  QUEST_ERR_NOT_ACTIVE = 6,      // 任务不在进行中
  QUEST_ERR_NOT_COMPLETABLE = 7, // 目标未完成
  QUEST_ERR_NPC_RANGE = 8,       // 不在 NPC 交互范围
  QUEST_ERR_COOLDOWN = 9,        // 日常冷却中
  QUEST_ERR_NOT_REPEATABLE = 10, // 不可重复
};

// ---------- 任务模板（数据驱动，按 ID 管理） ----------
struct QuestDef {
  uint32_t id = 0;
  std::string name;
  std::string desc;
  QuestCategory category = QuestCategory::SIDE;
  int levelReq = 1;                         // 接取等级要求
  std::vector<uint32_t> prerequisites;      // 前置任务 ID
  std::vector<QuestObjective> objectives;
  QuestReward rewards;
  uint32_t dailyCooldownSec = 0;            // 日常任务重置冷却（秒）
  uint32_t repeatLimit = 0;                 // 可重复次数上限（0=无限）
  uint32_t talkNpcWid = 0;                  // 接取/提交 NPC 的 wid（0=任意）
  bool autoTrack = true;                    // 接受后自动追踪
  // 显示辅助
  static const char* categoryName(QuestCategory c);
  static const char* objTypeName(QuestObjType t);
  static QuestCategory categoryFromStr(const std::string& s);
  static QuestObjType objTypeFromStr(const std::string& s);
};

// ---------- 玩家活跃任务实例（运行时状态） ----------
struct ActiveQuest {
  uint32_t questId = 0;
  uint64_t acceptedAtMs = 0;              // 接受时间（服务端单调时钟 ms）
  std::vector<uint32_t> progress;         // 每个目标的当前进度（与 objectives 对齐）
  uint8_t status = 0;                     // 0=active, 1=completable
};

// ---------- 任务系统 ----------
class QuestSystem {
public:
  explicit QuestSystem(World& w);
  void init();  // 加载默认任务 + JSON 覆盖

  // 任务模板查询
  const QuestDef* questDef(uint32_t id) const;
  const std::unordered_map<uint32_t, QuestDef>& quests() const { return quests_; }

  // 玩家操作（服务端权威校验）
  QuestResult acceptQuest(const std::string& playerId, uint32_t questId);
  QuestResult abandonQuest(const std::string& playerId, uint32_t questId);
  QuestResult turnInQuest(const std::string& playerId, uint32_t questId, uint32_t npcWid);

  // 事件钩子（由 World 系统调用）
  void onMonsterKill(Entity& player, const std::string& monsterType);
  void onItemAcquired(Entity& player, uint32_t itemId, uint32_t count);
  void onPlayerMove(Entity& player);
  void onTalkNpc(Entity& player, uint32_t npcWid);

  // 每 tick 处理（日常重置检测等）
  void tick(double dt);

  // 网络帧（供 World/Netcode 调用）
  std::string questListFrame(const Entity& p) const;
  std::string questProgressFrame(const Entity& p) const;
  std::string questResultFrame(uint8_t op, uint8_t code, uint32_t questId) const;
  std::string questNotifyFrame(uint32_t questId, uint8_t objIndex,
                               uint32_t current, uint32_t required, bool allComplete) const;
  std::string questCompleteFrame(uint32_t questId) const;

  // 可接任务列表（基于前置/等级/冷却）
  std::vector<const QuestDef*> availableQuests(const Entity& p) const;

  // 活跃任务中可提交的（目标全部完成）
  std::vector<const ActiveQuest*> completableQuests(const Entity& p) const;

  // 查询任务状态
  const ActiveQuest* findActiveQuest(const Entity& p, uint32_t questId) const;
  bool isCompleted(const Entity& p, uint32_t questId) const;

  // 持久化
  std::string serializeQuests(const Entity& p) const;
  bool deserializeQuests(Entity& p, const std::string& json) const;

  // 任务变化后标记，netcode 每 tick 补发 S2C_QUEST_PROGRESS
  void markQuestDirty(const std::string& playerId);
  const std::unordered_set<std::string>& questDirty() const { return questDirty_; }
  void clearQuestDirty() { questDirty_.clear(); }

private:
  World& world_;
  std::unordered_map<uint32_t, QuestDef> quests_;
  std::unordered_set<std::string> questDirty_; // 需要补发任务进度的玩家

  void loadDefaults();
  bool loadFromJson(const std::string& dir);
  bool checkPrerequisites(const Entity& p, const QuestDef& qd) const;
  bool isOnCooldown(const Entity& p, const QuestDef& qd, uint64_t nowMs) const;
  void updateProgress(Entity& p, uint32_t questId, uint8_t objIndex, uint32_t delta);
  void grantRewards(Entity& p, const QuestReward& rw);
  void checkCompletable(ActiveQuest& aq, const QuestDef& qd);
  void addDefaultQuest(uint32_t id, const char* name, const char* desc,
                       QuestCategory cat, int levelReq);
};

} // namespace ew
