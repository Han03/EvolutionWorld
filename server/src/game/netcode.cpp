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
  // 加入即一致：HELLO 后附当前世界 Boss 全局共享状态
  return proto::hello(cfg_, player) + w_.bossFrame(true);
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
  // 世界共享状态（全区广播，每 tick 一次）：共享事件 + Boss 状态帧（变化去重）
  auto sharedEvents = w_.takeSharedEvents();
  std::string sharedSuffix;
  for (const auto& ev : sharedEvents) sharedSuffix += proto::eventFrame(ev.type, ev.wid, ev.b, ev.x, ev.z);
  sharedSuffix += w_.bossFrame(false);
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
      // AI 移动意图（怪物/NPC/Boss）：客户端确定性外推的"移动意图"信号，变化才广播
      if (e->kind == EntityKind::Monster || e->kind == EntityKind::Npc) {
        const int16_t itx = proto::qVel(e->ai.targetVX);
        const int16_t itz = proto::qVel(e->ai.targetVZ);
        const uint8_t ist = e->ai.aiState;
        const uint8_t imult = (uint8_t)std::lround(e->moveScale() * 100.0);
        if (!last.has || ist != last.aiState || itx != last.itx || itz != last.itz || imult != last.imult) {
          mask |= proto::M_INTENT;
          last.aiState = ist; last.itx = itx; last.itz = itz; last.imult = imult;
        }
      }
      if (mask) {
        uWids.push_back(e->wid);
        uMasks.push_back(mask);
        uEnts.push_back(e);
        last = {ax, az, ay, avx, avz, st, last.aiState, last.itx, last.itz, last.imult, true};
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
    buf += sharedSuffix; // 全区共享状态（事件 + Boss 血量/状态）
    // 玩家自身属性/资源变化（战斗掉血/回血/回蓝）：补发 S2C_STATS
    if (w_.statsDirty().count(player->id)) buf += proto::statsFrame(*player);
    // 背包/金币变化（控制台/调试发放）：补发 S2C_INVENTORY
    if (w_.invDirty().count(player->id)) buf += proto::inventoryFrame(*player);
    // 技能/冷却变化：补发 S2C_SKILLS
    if (w_.skillsDirty().count(player->id)) buf += w_.skillsFrame(*player);
    // Buff 变化：补发 S2C_BUFFS
    if (w_.buffsDirty().count(player->id)) buf += w_.buffsFrame(*player);
    if (!buf.empty()) out_[player->id] = std::move(buf);
  }
  w_.clearStatsDirty();
  w_.clearInvDirty();
  w_.clearSkillsDirty();
  w_.clearBuffsDirty();
  return out_;
}
} // namespace ew
