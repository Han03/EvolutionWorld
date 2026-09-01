// netcode.cpp - 每玩家二进制输出构建
#include "netcode.h"
#include "world.h"
#include <cmath>
#include <algorithm>
namespace ew {
static double dist2D(const Vec3& a, const Vec3& b) {
  double dx = a.x - b.x, dz = a.z - b.z;
  return std::sqrt(dx * dx + dz * dz);
}
// 更新率分级（LOD）：近 → 高频，远 → 低频
static int lodRate(double dist, const Config& cfg) {
  double near_ = cfg.aoiNearM;
  double mid_ = cfg.aoiMidM;
  if (dist <= near_) return 1;          // 每 tick
  if (dist <= mid_) return 2;           // 每 2 tick
  return 4;                             // 每 4 tick
}
std::string Netcode::helloFor(const Entity& player) {
  PlayerView& v = views_[player.id];
  v.seen.clear();
  v.last.clear();
  v.forceSnap = false;
  return proto::hello(cfg_, player);
}
void Netcode::resetPlayer(const std::string& playerId) {
  views_.erase(playerId);
  out_.erase(playerId);
}
void Netcode::requestResync(const std::string& playerId) {
  auto it = views_.find(playerId);
  if (it != views_.end()) it->second.forceSnap = true;
}
const std::unordered_map<std::string, std::string>& Netcode::tickBroadcast() {
  out_.clear();
  for (const auto& pid : w_.players()) {
    const Entity* player = w_.findEntity(pid);
    if (!player) continue;
    PlayerView& v = views_[pid];
    // ---- 1. 视野实体（AOI 网格 + 距离过滤）----
    std::vector<uint32_t> cand = w_.aoi().inRange(player->pos.x, player->pos.z, cfg_.viewRangeM);
    std::vector<const Entity*> vis;
    std::unordered_set<uint32_t> visSet;
    vis.reserve(cand.size());
    for (uint32_t wid : cand) {
      const Entity* e = w_.findByWid(wid);
      if (!e || !e->active) continue;
      if (dist2D(e->pos, player->pos) > cfg_.viewRangeM) continue;
      vis.push_back(e);
      visSet.insert(wid);
    }
    // ---- 2. ENTER / LEAVE ----
    std::vector<const Entity*> enters;
    for (const Entity* e : vis) {
      if (!v.seen.count(e->wid)) enters.push_back(e);
    }
    std::vector<uint32_t> leaves;
    for (uint32_t wid : v.seen) {
      if (!visSet.count(wid)) leaves.push_back(wid);
    }
    for (const Entity* e : enters) v.seen.insert(e->wid);
    for (uint32_t wid : leaves) {
      v.seen.erase(wid);
      v.last.erase(wid);
    }
    std::string buf;
    if (!enters.empty()) buf += proto::enter(enters, player->pos);
    if (!leaves.empty()) buf += proto::leave(leaves);
    // ---- 3. UPDATE（增量 + LOD）----
    std::vector<uint32_t> uWids;
    std::vector<uint8_t> uMasks;
    std::vector<const Entity*> uEnts;
    const uint64_t tick = w_.tickCount();
    for (const Entity* e : vis) {
      if ((tick % (uint64_t)lodRate(dist2D(e->pos, player->pos), cfg_)) != 0) continue;
      LastEnt& last = v.last[e->wid];
      uint8_t mask = 0;
      int32_t ax = proto::qAbs(e->pos.x);
      int32_t az = proto::qAbs(e->pos.z);
      int16_t ay = proto::qAbs(e->pos.y);
      int16_t avx = proto::qVel(e->vel.x);
      int16_t avz = proto::qVel(e->vel.z);
      uint8_t st = proto::entityState(*e);
      if (!last.has || ax != last.ax || az != last.az || ay != last.ay) mask |= proto::M_POS;
      if (!last.has || avx != last.avx || avz != last.avz) mask |= proto::M_VEL;
      if (!last.has || st != last.state) mask |= proto::M_STATE;
      if (mask) {
        uWids.push_back(e->wid);
        uMasks.push_back(mask);
        uEnts.push_back(e);
        last = {ax, az, ay, avx, avz, st, true};
      }
    }
    if (!uWids.empty()) buf += proto::update(uWids, uMasks, uEnts, player->pos);
    // ---- 4. 周期校准快照（自愈）----
    bool needSnap = v.forceSnap ||
                    (tick - v.lastSnapTick) >= (uint64_t)cfg_.snapshotIntervalTicks;
    if (needSnap) {
      buf += proto::snapshot((uint32_t)tick, vis, player->pos);
      v.lastSnapTick = tick;
      v.forceSnap = false;
    }
    if (!buf.empty()) out_[player->id] = std::move(buf);
  }
  return out_;
}
} // namespace ew
