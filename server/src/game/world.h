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
  std::string bossFrame_;
  bool bossDirty_ = true;
  uint32_t aliveBoss_ = 0;
  uint64_t tick_ = 0;
  int64_t entitySeq_ = 0;
  int64_t wireSeq_ = 0;
  Mulberry32 rng_;
};
} // namespace ew
