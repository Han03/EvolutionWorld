// world.h - 世界管理器：实体注册表（单一事实源）/ tick 循环 / 系统调度 / 快照 / 世界共享状态
#pragma once
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <functional>
#include "entity.h"
#include "chunk.h"
#include "physics.h"
#include "aoi.h"
#include "items.h"
#include "util/random.h"
#include "../config.h"
namespace ew {
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
  // 生命周期
  void seedWorld();
  void tick();  // 每 tickMs 调用一次
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
  ChunkManager& chunks() { return chunks_; }
  uint64_t tickCount() const { return tick_; }
  // ---- 物品/属性/商店/掉落（大型网游规模） ----
  GameData& data() { return data_; }
  const GameData& data() const { return data_; }
  const ItemDef* itemDef(uint32_t id) const { return data_.item(id); }
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
private:
  void addEntity(Entity&& e);
  // 怪物死亡掉落：金币 + 按概率表掉物品（生成地面掉落物实体）
  void rollDrops(Entity& killer, Entity& victim);
  void spawnDrop(double x, double z, uint32_t itemId, uint32_t gold);
  // 应用怪物类型配置属性（type 见 monsters.json / GameData 默认）
  void applyMonsterStats(Entity& m, const std::string& type);
  // 目标死亡统一处理（Boss 复活/普通怪物失活+复活+掉落），供普攻/技能复用
  void onVictimDeath(Entity& victim, Entity& killer, uint64_t nowMs);
  // 技能伤害落点（含仇恨/死亡/吸血），skillFalloff=1.0 单目标、0=边缘（预留）
  void applySkillDamage(Entity& caster, Entity& target, const SkillDef& sd, double variance);
  // 击退：沿 from→target 方向把 target 位移 dist 米（霸体免疫；落回地形高度），并触发受击打断
  void applyKnockback(Entity& from, Entity& target, double dist);
  void updateSystems(double dt);
  std::string nextEntityId(const char* prefix);
  void spawnBoss(int idx, double homeX, double homeZ);
  const Config& cfg_;
  GameData data_;
  Physics physics_;
  ChunkManager chunks_;
  AoiGrid aoi_;
  std::unordered_map<std::string, Entity> entities_;
  std::unordered_set<std::string> players_;
  std::unordered_map<uint32_t, std::string> widToId_;
  std::vector<std::pair<int, std::pair<std::string, SystemFn>>> systems_;
  // 世界共享状态（Boss 全局广播 + 战斗事件队列）
  std::vector<SharedEvent> sharedEvents_;
  // 需要补发 S2C_STATS 的玩家（属性/血量/蓝量变化）
  std::unordered_set<std::string> statsDirty_;
  // 需要补发 S2C_INVENTORY 的玩家（背包/金币变化）
  std::unordered_set<std::string> invDirty_;
  // 需要补发 S2C_SKILLS / S2C_BUFFS 的玩家（技能/冷却/Buff 变化）
  std::unordered_set<std::string> skillsDirty_;
  std::unordered_set<std::string> buffsDirty_;
  std::string bossFrame_;
  bool bossDirty_ = true;
  uint32_t aliveBoss_ = 0;
  uint64_t tick_ = 0;
  int64_t entitySeq_ = 0;
  int64_t wireSeq_ = 0;
  Mulberry32 rng_;
};
} // namespace ew
