// world.h - 世界管理器：实体注册表（单一事实源）/ tick 循环 / 系统调度 / 快照
#pragma once
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <functional>
#include "entity.h"
#include "chunk.h"
#include "physics.h"
#include "util/random.h"
#include "../config.h"

namespace ew {

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

  // 快照（100m 可见范围）
  Json buildSnapshot(const Entity& player);

  // 系统注册（可扩展）
  using SystemFn = std::function<void(World&, double)>;
  void addSystem(int priority, const std::string& name, SystemFn fn);

  const Config& config() const { return cfg_; }
  Physics& physics() { return physics_; }
  ChunkManager& chunks() { return chunks_; }
  uint64_t tickCount() const { return tick_; }

private:
  void addEntity(Entity&& e);
  void updateSystems(double dt);
  std::string nextEntityId(const char* prefix);

  const Config& cfg_;
  Physics physics_;
  ChunkManager chunks_;
  std::unordered_map<std::string, Entity> entities_;
  std::unordered_set<std::string> players_;
  std::vector<std::pair<int, std::pair<std::string, SystemFn>>> systems_;
  uint64_t tick_ = 0;
  int64_t entitySeq_ = 0;
  Mulberry32 rng_;
};

} // namespace ew
