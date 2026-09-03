// world.h - 世界管理器：实体注册表（单一事实源）/ tick 循环 / 系统调度 / 快照 / 世界共享状态
#pragma once
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <functional>
#include <memory>
#include "entity.h"
#include "chunk.h"
#include "physics.h"
#include "collision.h"
#include "aoi.h"
#include "items.h"
#include "spawns.h"
#include "friends.h"
#include "guild.h"
#include "chat.h"
#include "quests.h"
#include "util/random.h"
#include "../config.h"
namespace ew {
class Store; // 前置声明
// 世界共享事件（S2C_EVENT 数据源：伤害/死亡/复活/技能），由 netcode 每 tick 全区广播
struct SharedEvent {
  uint8_t type;        // proto::EvtType
  uint32_t wid = 0;    // 主体（受击者/死亡者/复活者/施法者）
  uint32_t b = 0;      // 次级（击杀者/技能 id）
  int32_t x = 0, z = 0; // 技能落点
};
class World {
public:
  explicit World(const Config& cfg);
  ~World() = default;
  // 存储层引用（社交系统持久化用，由 main 注入）
  void setStore(Store* s) { store_ = s; }
  Store& store();
  // 生命周期
  void seedWorld();
  void tick();  // 每 tickMs 调用一次
  // ---- 世界初始化执行器（大型网游规模：数据驱动生成，代码不保存地形/生物布局）----
  // 生成连通可通行 mask + 主城 + 分组生物投放（写入 terrain mask 与 spawns_，不刷实体）。
  // 内存模式每次启动调用；数据库模式仅在无存档时调用。调用后需 seedWorld()/reseedCreatures()。
  bool runWorldInit();
  // 世界数据持久化（数据库模式）：把 mask + 出生点保存到 / 从 Store 还原（还原不刷实体）。
  bool saveWorldToStore(Store& s);
  bool loadWorldFromStore(Store& s);
  // ---- 生物出生点（大型网游规模：数据驱动 + 剧本编辑器热重载） ----
  const SpawnConfig& spawns() const { return spawns_; }
  SpawnConfig& spawnsMut() { return spawns_; }
  // 应用新出生点配置（fromJson → 持久化 data/spawns.json → 热重载世界生物）
  bool applySpawns(const std::string& json, const std::string& dataDir);
  // 热重载：清空现有种子生物（m_*/n_*/boss_*）并按当前出生点配置重建
  void reseedCreatures();
  // 实体管理
  Entity* spawnPlayer(const std::string& username, Vec3* spawnHint = nullptr);
  void despawnPlayer(const std::string& id);
  Entity* findEntity(const std::string& id) {
    auto it = entities_.find(id);
    return it == entities_.end() ? nullptr : &it->second;
  }
  // 在线玩家（id 集合，指向 entities_ 单一事实源）
  const std::unordered_set<std::string>& players() const { return players_; }
  const std::unordered_map<std::string, Entity>& entities() const { return entities_; }
  // 内部系统遍历用（非 const）
  std::unordered_map<std::string, Entity>& entitiesMut() { return entities_; }
  // 快照（100m 可见范围，JSON 调试用）
  Json buildSnapshot(const Entity& player);
  // AOI 兴趣网格（大规模传输用）
  AoiGrid& aoi() { return aoi_; }
  const AoiGrid& aoi() const { return aoi_; }
  // 按线上 wid 查实体
  Entity* findByWid(uint32_t wid) {
    auto it = widToId_.find(wid);
    return it == widToId_.end() ? nullptr : findEntity(it->second);
  }
  // 按用户名查在线玩家（调试/管理用）
  Entity* findPlayerByUsername(const std::string& username);
  uint32_t nextWireId() { return (uint32_t)++wireSeq_; }
  // 系统注册（可扩展）
  using SystemFn = std::function<void(World&, double)>;
  void addSystem(int priority, const std::string& name, SystemFn fn);
  const Config& config() const { return cfg_; }
  Physics& physics() { return physics_; }
  Collision& collision() { return collision_; }
  ChunkManager& chunks() { return chunks_; }
  uint64_t tickCount() const { return tick_; }
  // ---- 物品/属性/商店/掉落（大型网游规模） ----
  GameData& data() { return data_; }
  const GameData& data() const { return data_; }
  const ItemDef* itemDef(uint32_t id) const { return data_.item(id); }
  // 应用编辑器提交的物品/生物配置（热替换内存 + 持久化 data/*.json；生物附带世界热重载）
  bool applyItems(const std::string& itemsJson, const std::string& dataDir);
  bool applyMonsters(const std::string& monstersJson, const std::string& dataDir);
  // 玩家攻击世界实体（服务端权威校验 + 伤害/仇恨/死亡/复活/掉落）
  bool playerAttack(const std::string& playerId, uint32_t targetWid, uint8_t slot);
  // 拾取地面掉落物（金币/物品进背包）
  bool playerPickup(const std::string& playerId, uint32_t dropWid);
  // 移除地面掉落物（拾取/超时消失）
  void despawnDrop(const std::string& id);
  // 穿戴/卸下装备（slot 槽位值 1..6，itemId=0 卸下）
  bool equipItem(const std::string& playerId, uint8_t slot, uint32_t itemId);
  // 使用消耗品
  bool useItem(const std::string& playerId, uint32_t itemId, uint16_t count);
  // 打开商店（校验与商店 NPC 距离）
  bool openShop(const std::string& playerId, uint32_t npcWid);
  // 购买物品（金币扣减 + 进背包）
  bool buyItem(const std::string& playerId, uint32_t itemId, uint16_t count);
  // 根据基础属性 + 装备加成重算派生属性（maxHp/maxMp/attack/defense）
  void recomputeStats(Entity& p);
  // 玩家属性/资源变化后标记，netcode 每 tick 向该玩家补发 S2C_STATS
  void markStatsDirty(const std::string& playerId);
  const std::unordered_set<std::string>& statsDirty() const { return statsDirty_; }
  void clearStatsDirty() { statsDirty_.clear(); }
  // 背包/金币变化后标记，netcode 每 tick 向该玩家补发 S2C_INVENTORY
  void markInvDirty(const std::string& playerId);
  const std::unordered_set<std::string>& invDirty() const { return invDirty_; }
  void clearInvDirty() { invDirty_.clear(); }
  // ---- 技能系统（大型网游规模，数据驱动，服务端权威） ----
  // 学习技能（写入 learnedSkills，无冷却）
  bool learnSkill(const std::string& playerId, uint32_t skillId);
  // 开始施放技能：校验已学/冷却/耗蓝/目标/距离 → 前摇(castTimeMs>0)或瞬发结算。
  // 前摇由 castSystem 到期后结算；移动/受击打断（cancelCast）。返回是否成功开始施放。
  bool beginCast(const std::string& playerId, uint32_t skillId, uint32_t targetWid, double tx, double tz);
  // 前摇结算：扣蓝上冷却 → EVT_SKILL 广播 → 施加效果（伤害/治疗/Buff）
  void resolveCast(Entity& caster, const SkillDef& sd, uint32_t targetWid, double tx, double tz);
  // 打断施放：reason=0 被替换 / 1 移动 / 2 受击；受击打断受 castCancelOnHit 约束
  void cancelCast(Entity& e, uint8_t reason);
  // 实体受击：若是施放中的玩家且技能允许受击打断 → 打断（普攻/技能/Boss AOE 共用）
  void cancelCastOnHit(Entity& e);
  // 挂载/移除 Buff（同技能同类型刷新，不同类型并存）
  void applyBuff(Entity& e, uint32_t skillId, uint8_t type, double value, double durSec);
  void removeBuffType(Entity& e, uint8_t type);
  // 荆棘反伤：victim 有 THORNS Buff 时把 dmg×比例反弹给 attacker（返回反弹量）
  double thornsReflect(Entity& victim, Entity& attacker, double dmg);
  // 技能帧（S2C_SKILLS / S2C_BUFFS，供网络层下发）
  std::string skillsFrame(const Entity& p);  // 已学技能 + 剩余冷却
  std::string buffsFrame(const Entity& p);   // 自身 Buff
  // 技能/冷却变化后标记，netcode 每 tick 补发 S2C_SKILLS / S2C_BUFFS
  void markSkillsDirty(const std::string& playerId);
  void markBuffsDirty(const std::string& playerId);
  const std::unordered_set<std::string>& skillsDirty() const { return skillsDirty_; }
  const std::unordered_set<std::string>& buffsDirty() const { return buffsDirty_; }
  void clearSkillsDirty() { skillsDirty_.clear(); }
  void clearBuffsDirty() { buffsDirty_.clear(); }
  // ---- 测试/调试控制标志（控制台命令切换；默认全 false=正常玩法）----
  // 全局生效（影响世界内所有玩家/怪物），供自动化测试确定性构造场景，替代不可预测操作。
  struct TestFlags {
    bool monstersPaused = false;    // 冻结全部怪物/Boss 的 AI、移动与施放（站桩测试）
    bool noSkillCost = false;       // 技能/普攻无蓝耗、无冷却（重复测试同一技能）
    bool antiCheatBypass = false;   // 关闭防作弊频率/序号/轨迹校验（输入直接接受）
  };
  TestFlags& testFlags() { return testFlags_; }
  const TestFlags& testFlags() const { return testFlags_; }
  // ---- 控制台/调试辅助（GameConsole 与 /api/debug 复用） ----
  // 生成一只怪物（type 见 monsters 表），返回实体；坐标非法/水面自动找干地
  Entity* spawnMonster(const std::string& type, double x, double z);
  // 传送玩家（含防作弊重置与客户端校正推送，供控制台/调试 API 复用）
  bool teleportPlayer(const std::string& playerId, double x, double z);
  // 强制击杀实体（触发掉落/死亡/复活逻辑）
  bool killEntity(const std::string& playerId, uint32_t wid);
  // 复活（普通怪物复活 / Boss 复活）
  bool respawnEntity(const std::string& id);
  // 全图怪物复活
  void respawnAllMonsters();
  // 发放物品/金币（控制台测试命令）
  bool giveItem(const std::string& playerId, uint32_t itemId, uint16_t count);
  bool giveGold(const std::string& playerId, int64_t amount);
  // 生成地面掉落物（控制台测试命令）
  void spawnDropAt(double x, double z, uint32_t itemId, uint32_t gold);
  // 世界 Boss 状态摘要（控制台查看）
  Json bossesStatus() const;
  // 视野内/全图实体摘要（控制台查看，limit 限制数量）
  Json entitiesStatus(double px, double pz, double range, int limit) const;
  // 取走本 tick 产生的共享事件（netcode 全区广播用，调用后清空）
  std::vector<SharedEvent> takeSharedEvents();
  // 本 tick 刚复活的玩家（网络层补发校正+强制快照，防作弊重置），调用后清空
  void pushRespawnedPlayer(const std::string& pid) { respawnedThisTick_.push_back(pid); }
  std::vector<std::string> takeRespawnedPlayers() {
    auto out = std::move(respawnedThisTick_);
    respawnedThisTick_.clear();
    return out;
  }
  // 构建世界 Boss 全局共享状态帧（force=true 强制；false 且无变化则返回空）
  std::string bossFrame(bool force);
  // 存活 Boss 数量
  uint32_t aliveBossCount() const { return aliveBoss_; }
  // 所有世界 Boss 实体（调试/传送用）
  std::vector<const Entity*> bosses() const;
  // 世界共享状态辅助（供系统/网络层调用）
  void pushEvent(uint8_t type, uint32_t wid, uint32_t b, int32_t x, int32_t z);
  void markBossDirty() { bossDirty_ = true; }
  void addAliveBoss(int d) { aliveBoss_ = (uint32_t)((int)aliveBoss_ + d); }
  // 玩家死亡统一处理（hp=0+死亡标记+复活计时+EVT_DEATH 广播），供普攻/技能/Boss/反伤复用
  void killPlayer(Entity& p, Entity* killer);
  // 通用技能效果施加：伤害/Buff/击退/死亡/吸血（玩家→怪物、怪物→玩家 均可用）
  void applySkillToTarget(Entity& caster, Entity& target, const SkillDef& sd, double variance);
  // ---- 社交系统（好友/公会/聊天）----
  FriendSystem& friends() { return *friends_; }
  const FriendSystem& friends() const { return *friends_; }
  GuildSystem& guilds() { return *guilds_; }
  const GuildSystem& guilds() const { return *guilds_; }
  ChatSystem& chat() { return *chat_; }
  const ChatSystem& chat() const { return *chat_; }
  // ---- 任务系统（大型网游规模，数据驱动） ----
  QuestSystem& quests() { return *quests_; }
  const QuestSystem& quests() const { return *quests_; }
  // 任务进度变化后标记，netcode 每 tick 补发 S2C_QUEST_PROGRESS
  void markQuestDirty(const std::string& playerId);
  const std::unordered_set<std::string>& questDirty() const { return questDirty_; }
  void clearQuestDirty() { questDirty_.clear(); }
private:
  void addEntity(Entity&& e);
  void despawnEntity(const std::string& id);
  // 按出生点生成一只生物（monster/npc/boss）
  void spawnFromPoint(const SpawnPoint& sp);
  // 按出生点生成一个城镇 NPC（就近找干地，可带商店/名称）
  void spawnNpcAt(const SpawnPoint& sp);
  // 怪物死亡掉落：金币 + 按概率表掉物品（生成地面掉落物实体）
  void rollDrops(Entity& killer, Entity& victim);
  // 玩家获得经验：累加 + 循环升级（成长基础属性/回满血蓝），结束后标记属性脏
  void grantExp(Entity& p, uint32_t amount);
  void spawnDrop(double x, double z, uint32_t itemId, uint32_t gold);
  // 应用怪物类型配置属性（type 见 monsters.json / GameData 默认）
  void applyMonsterStats(Entity& m, const std::string& type);
  // 目标死亡统一处理（Boss 复活/普通怪物失活+复活+掉落），供普攻/技能复用
  void onVictimDeath(Entity& victim, Entity& killer, uint64_t nowMs);
  // 击退：沿 from→target 方向把 target 位移 dist 米（霸体免疫；落回地形高度），并触发受击打断
  void applyKnockback(Entity& from, Entity& target, double dist);
  void updateSystems(double dt);
  std::string nextEntityId(const char* prefix);
  void spawnBossAt(double homeX, double homeZ, const std::string& name);
  const Config& cfg_;
  SpawnConfig spawns_;   // 生物出生点配置（默认确定性生成，可 JSON 覆盖/编辑器修改）
  GameData data_;
  Physics physics_;
  Collision collision_;
  ChunkManager chunks_;
  AoiGrid aoi_;
  std::unordered_map<std::string, Entity> entities_;
  std::unordered_set<std::string> players_;
  std::unordered_map<uint32_t, std::string> widToId_;
  std::vector<std::pair<int, std::pair<std::string, SystemFn>>> systems_;
  // 世界共享状态（Boss 全局广播 + 战斗事件队列）
  std::vector<SharedEvent> sharedEvents_;
  // 本 tick 刚复活的玩家（需补发校正）
  std::vector<std::string> respawnedThisTick_;
  // 需要补发 S2C_STATS 的玩家（属性/血量/蓝量变化）
  std::unordered_set<std::string> statsDirty_;
  // 需要补发 S2C_INVENTORY 的玩家（背包/金币变化）
  std::unordered_set<std::string> invDirty_;
  // 需要补发 S2C_SKILLS / S2C_BUFFS 的玩家（技能/冷却/Buff 变化）
  std::unordered_set<std::string> skillsDirty_;
  std::unordered_set<std::string> buffsDirty_;
  // 需要补发 S2C_QUEST_PROGRESS 的玩家（任务进度/状态变化）
  std::unordered_set<std::string> questDirty_;
  std::string bossFrame_;
  bool bossDirty_ = true;
  uint32_t aliveBoss_ = 0;
  uint64_t tick_ = 0;
  int64_t entitySeq_ = 0;
  int64_t wireSeq_ = 0;
  TestFlags testFlags_;   // 测试/调试控制标志（控制台命令切换，默认正常玩法）
  Mulberry32 rng_;
  // 社交系统
  Store* store_ = nullptr;
  std::unique_ptr<FriendSystem> friends_;
  std::unique_ptr<GuildSystem> guilds_;
  std::unique_ptr<ChatSystem> chat_;
  std::unique_ptr<QuestSystem> quests_;
};
} // namespace ew
