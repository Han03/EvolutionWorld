// chunk.cpp
#include "chunk.h"
#include "world.h"
#include <cmath>

namespace ew {

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
