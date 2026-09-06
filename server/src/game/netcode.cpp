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
  // 加入即一致：HELLO 后附当前世界精英全局共享状态
  return proto::hello(cfg_, player) + w_.eliteFrame(true);
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
  // 世界共享状态：提取本 tick 事件 + 精英状态帧（变化去重）
  auto sharedEvents = w_.takeSharedEvents();
  // 精英全局共享状态帧（所有玩家都收到，不论距离——世界精英是全区公共信息）
  std::string eliteSuffix = w_.eliteFrame(false);
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
    // ---- 1b. 可视范围事件过滤（Fog of War）----
    // 共享事件按玩家视野过滤：只下发主体实体在视野内的事件，
    // 防止脚本通过全区事件流获取视野外的怪物位置/战斗/掉落等信息。
    // 死亡实体（active=false）不在 visSet 中，但上一帧仍在 v.seen 的
    // 需要纳入事件投递范围，否则 EVT_DEATH 永远到不了客户端（幽灵怪）。
    std::unordered_set<uint32_t> evtVis = visSet;
    for (uint32_t wid : v.seen) {
      if (!evtVis.count(wid)) {
        const Entity* dead = w_.findByWid(wid);
        if (dead && !dead->active) evtVis.insert(wid);
      }
    }
    std::string evtBuf;
    for (const auto& ev : sharedEvents) {
      if (evtVis.count(ev.wid)) {
        evtBuf += proto::eventFrame(ev.type, ev.wid, ev.b, ev.x, ev.z);
      }
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
      // AI 移动意图（怪物/NPC/精英）：客户端确定性外推的“移动意图”信号，变化才广播
      if (e->kind == EntityKind::Monster || e->kind == EntityKind::Npc) {
        const int16_t itx = proto::qVel(e->ai.targetVX);
        const int16_t itz = proto::qVel(e->ai.targetVZ);
        const uint8_t ist = e->ai.aiState;
        const uint8_t imult = (uint8_t)std::lround(e->moveScale() * 100.0);
        const uint16_t ihp = (uint16_t)std::lround(e->hp);
        const uint16_t imhp = (uint16_t)std::lround(e->maxHp);
        if (!last.has || ist != last.aiState || itx != last.itx || itz != last.itz || imult != last.imult
            || ihp != last.hp || imhp != last.maxHp) {
          mask |= proto::M_INTENT;
          last.aiState = ist; last.itx = itx; last.itz = itz; last.imult = imult;
          last.hp = ihp; last.maxHp = imhp;
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
    // 视野内事件 + 精英全局状态（精英是全区公共信息，不受距离限制）
    buf += evtBuf + eliteSuffix;
    // 玩家自身属性/资源变化（战斗掉血/回血/回蓝）：补发 S2C_STATS
    if (w_.statsDirty().count(player->id)) buf += proto::statsFrame(*player);
    // 背包/金币变化（控制台/调试发放）：补发 S2C_INVENTORY
    if (w_.invDirty().count(player->id)) buf += proto::inventoryFrame(*player);
    // 技能/冷却变化：补发 S2C_SKILLS
    if (w_.skillsDirty().count(player->id)) buf += w_.skillsFrame(*player);
    // Buff 变化：补发 S2C_BUFFS
    if (w_.buffsDirty().count(player->id)) buf += w_.buffsFrame(*player);
    // 任务进度变化：补发 S2C_QUEST_PROGRESS
    if (w_.questDirty().count(player->id)) buf += w_.quests().questProgressFrame(*player);
    if (!buf.empty()) out_[player->id] = std::move(buf);
  }
  // 施放结算失败通知：定向发给目标玩家（S2C_SKILL_CAST ok=0，客户端重置冷却）
  for (auto& nf : w_.takeCastFailNotifs()) {
    // 构建 S2C_SKILL_CAST ok=0 帧
    std::string failFrame = proto::skillCastFrame(false, nf.skillId, nf.targetWid, 0, 0, 0);
    // 写入该玩家的输出缓冲（追加或新建）
    auto it = out_.find(nf.playerId);
    if (it != out_.end()) it->second += failFrame;
    else out_[nf.playerId] = failFrame;
  }
  w_.clearStatsDirty();
  w_.clearInvDirty();
  w_.clearSkillsDirty();
  w_.clearBuffsDirty();
  w_.clearQuestDirty();
  return out_;
}
} // namespace ew
