// chunk.h - 区块管理器：100m 可见范围加载/模拟
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "entity.h"
#include "../config.h"

namespace ew {

class World;

class ChunkManager {
public:
  ChunkManager(World& world, const Config& cfg) : world_(world), cfg_(cfg) {}

  void updateEntityChunk(Entity& e);
  void removeEntity(Entity& e);
  // 更新玩家加载集合，返回 enter/exit 区块列表（供后续扩展）
  struct ChunkChange { std::vector<std::string> entered, exited; };
  ChunkChange updatePlayerChunks(const Entity& player);
  void removePlayer(const std::string& playerId);
  // 某点 viewRange 内所有实体
  std::vector<Entity*> entitiesInRange(const Vec3& center, double range);
  // 实体是否位于任一在线玩家视野内（AI 激活判定）
  bool isEntityVisible(const Entity& e);

private:
  std::string chunkKey(int64_t ix, int64_t iz) const;
  std::unordered_set<std::string> chunksInRange(const Vec3& center, double range) const;

  World& world_;
  const Config& cfg_;
  // chunkKey -> 实体 id 集合
  std::unordered_map<std::string, std::unordered_set<std::string>> chunks_;
  // playerId -> 已加载 chunkKey 集合
  std::unordered_map<std::string, std::unordered_set<std::string>> playerChunks_;
};

} // namespace ew
