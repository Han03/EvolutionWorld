// chunk.h - 区块管理器：100m 可见范围加载/模拟 + 高度场世界数据存储
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "entity.h"
#include "terrain.h"
#include "../config.h"
namespace ew {
class World;
// 区块高度场数据（世界地图的数据存储层）
// 每个区块缓存一张 (grid × grid) 高度采样网格，作为地图数据的权威存储；
// 连续高度采样（物理/碰撞/渲染）由 terrainHeight 提供（即该网格的连续形式）。
struct ChunkTerrainData {
  int64_t cx = 0, cz = 0;   // 区块坐标
  int grid = 0;             // 每边采样点数（含两端）
  double step = 0;          // 采样间距
  std::vector<float> heights; // grid*grid 高度，row-major
  // 高度场碰撞采样：双线性插值
  double heightAt(double x, double z) const;
};
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
  // ---- 世界地图高度场数据存储 ----
  // 获取/生成区块高度场数据（缓存，map 数据存储层）
  const ChunkTerrainData* getTerrainData(int64_t cx, int64_t cz);
  // 高度场碰撞采样（物理使用 terrainHeight 连续函数；此接口供数据层/调试）
  double groundHeight(double x, double z);
  const std::unordered_map<std::string, ChunkTerrainData>& terrainCache() const { return terrain_; }
  size_t terrainCacheSize() const { return terrain_.size(); }
private:
  std::string chunkKey(int64_t ix, int64_t iz) const;
  std::unordered_set<std::string> chunksInRange(const Vec3& center, double range) const;
  World& world_;
  const Config& cfg_;
  // chunkKey -> 实体 id 集合
  std::unordered_map<std::string, std::unordered_set<std::string>> chunks_;
  // playerId -> 已加载 chunkKey 集合
  std::unordered_map<std::string, std::unordered_set<std::string>> playerChunks_;
  // 世界地图高度场数据缓存（区块数据存储层）
  std::unordered_map<std::string, ChunkTerrainData> terrain_;
};
} // namespace ew
