// chunk.cpp
#include "chunk.h"
#include "world.h"
#include <cmath>
namespace ew {

// ---- 高度场世界数据存储 ----
double ChunkTerrainData::heightAt(double x, double z) const {
  if (grid < 2) return 0.0;
  double x0 = cx * grid * step;
  double z0 = cz * grid * step;
  double fx = (x - x0) / step;
  double fz = (z - z0) / step;
  double gx = std::clamp(fx, 0.0, double(grid - 1));
  double gz = std::clamp(fz, 0.0, double(grid - 1));
  int ix = (int)std::floor(gx);
  int iz = (int)std::floor(gz);
  double tx = gx - ix;
  double tz = gz - iz;
  if (ix > grid - 2) ix = grid - 2;
  if (iz > grid - 2) iz = grid - 2;
  double h00 = heights[iz * grid + ix];
  double h10 = heights[iz * grid + ix + 1];
  double h01 = heights[(iz + 1) * grid + ix];
  double h11 = heights[(iz + 1) * grid + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
const ChunkTerrainData* ChunkManager::getTerrainData(int64_t cx, int64_t cz) {
  std::string key = chunkKey(cx, cz);
  auto it = terrain_.find(key);
  if (it != terrain_.end()) return &it->second;
  ChunkTerrainData d;
  d.cx = cx;
  d.cz = cz;
  d.grid = std::max(2, (int)cfg_.terrainGridPoints);
  d.step = cfg_.chunkSizeM / (d.grid - 1);
  d.heights.resize((size_t)d.grid * d.grid);
  double x0 = cx * cfg_.chunkSizeM;
  double z0 = cz * cfg_.chunkSizeM;
  for (int iz = 0; iz < d.grid; iz++) {
    for (int ix = 0; ix < d.grid; ix++) {
      d.heights[iz * d.grid + ix] = (float)terrainHeight(x0 + ix * d.step, z0 + iz * d.step);
    }
  }
  // 简单缓存上限：超过则整体重建（演示级规模无碍）
  constexpr size_t kMaxCache = 1024;
  if (terrain_.size() >= kMaxCache) terrain_.clear();
  auto res = terrain_.emplace(key, std::move(d));
  return &res.first->second;
}
double ChunkManager::groundHeight(double x, double z) {
  int64_t cx = (int64_t)std::floor(x / cfg_.chunkSizeM);
  int64_t cz = (int64_t)std::floor(z / cfg_.chunkSizeM);
  const ChunkTerrainData* d = getTerrainData(cx, cz);
  if (!d) return terrainHeight(x, z);
  return d->heightAt(x, z);
}

std::string ChunkManager::chunkKey(int64_t ix, int64_t iz) const {
  return std::to_string(ix) + "," + std::to_string(iz);
}
void ChunkManager::updateEntityChunk(Entity& e) {
  int64_t ix = (int64_t)std::floor(e.pos.x / cfg_.chunkSizeM);
  int64_t iz = (int64_t)std::floor(e.pos.z / cfg_.chunkSizeM);
  std::string key = chunkKey(ix, iz);
  if (e.__chunkKey == key) return;
  if (!e.__chunkKey.empty()) {
    auto it = chunks_.find(e.__chunkKey);
    if (it != chunks_.end()) it->second.erase(e.id);
  }
  chunks_[key].insert(e.id);
  e.__chunkKey = key;
}
void ChunkManager::removeEntity(Entity& e) {
  if (!e.__chunkKey.empty()) {
    auto it = chunks_.find(e.__chunkKey);
    if (it != chunks_.end()) it->second.erase(e.id);
    e.__chunkKey.clear();
  }
}
std::unordered_set<std::string> ChunkManager::chunksInRange(const Vec3& center, double range) const {
  int64_t ix = (int64_t)std::floor(center.x / cfg_.chunkSizeM);
  int64_t iz = (int64_t)std::floor(center.z / cfg_.chunkSizeM);
  int span = (int)std::ceil(range / cfg_.chunkSizeM);
  std::unordered_set<std::string> keys;
  for (int dx = -span; dx <= span; dx++) {
    for (int dz = -span; dz <= span; dz++) {
      int64_t cx = ix + dx, cz = iz + dz;
      double wx = cx * cfg_.chunkSizeM + cfg_.chunkSizeM / 2.0;
      double wz = cz * cfg_.chunkSizeM + cfg_.chunkSizeM / 2.0;
      if (std::hypot(wx - center.x, wz - center.z) <= range + cfg_.chunkSizeM * 0.8)
        keys.insert(chunkKey(cx, cz));
    }
  }
  return keys;
}
ChunkManager::ChunkChange ChunkManager::updatePlayerChunks(const Entity& player) {
  auto need = chunksInRange(player.pos, cfg_.viewRangeM);
  auto& have = playerChunks_[player.id];
  ChunkChange ch;
  for (const auto& k : need) if (!have.count(k)) ch.entered.push_back(k);
  for (const auto& k : have) if (!need.count(k)) ch.exited.push_back(k);
  have = std::move(need);
  return ch;
}
void ChunkManager::removePlayer(const std::string& playerId) {
  playerChunks_.erase(playerId);
}
std::vector<Entity*> ChunkManager::entitiesInRange(const Vec3& center, double range) {
  auto keys = chunksInRange(center, range);
  std::vector<Entity*> out;
  std::unordered_set<std::string> seen;
  for (const auto& key : keys) {
    auto it = chunks_.find(key);
    if (it == chunks_.end()) continue;
    for (const auto& id : it->second) {
      if (seen.count(id)) continue;
      seen.insert(id);
      Entity* e = world_.findEntity(id);
      if (!e || !e->active) continue;
      if (e->pos.dist2D(center) <= range) out.push_back(e);
    }
  }
  return out;
}
bool ChunkManager::isEntityVisible(const Entity& e) {
  for (const auto& pid : world_.players()) {
    const Entity* p = world_.findEntity(pid);
    if (!p || !p->active) continue;
    if (p->pos.dist2D(e.pos) <= cfg_.viewRangeM + cfg_.chunkSizeM) return true;
  }
  return false;
}
} // namespace ew
