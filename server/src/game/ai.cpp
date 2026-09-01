// ai.cpp - 大型网游 AI 框架实现（状态机 + 调度）
#include "ai.h"
#include "../config.h"
#include "world.h"
#include "terrain.h"
#include "net/protocol.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
namespace ew {
namespace {
double rng01() { return (double)std::rand() / (double)RAND_MAX; }
} // namespace

// ---------------- 工具 ----------------
Entity* pickAggroTarget(World& w, Entity& e) {
  uint32_t best = 0; double bh = -1;
  for (auto& [wid2, h] : e.aggro) {
    Entity* pl = w.findByWid(wid2);
    if (!pl || pl->kind != EntityKind::Player || !pl->active || pl->hp <= 0) continue;
    if (h > bh) { bh = h; best = wid2; }
  }
  return best ? w.findByWid(best) : nullptr;
}

bool moveToward(Entity& e, const Vec3& t, double speed, double arriveDist) {
  double dx = t.x - e.pos.x, dz = t.z - e.pos.z;
  double d = std::hypot(dx, dz);
  if (d <= arriveDist) { e.ai.targetVX = 0; e.ai.targetVZ = 0; return true; }
  double inv = 1.0 / (d + 1e-6);
  e.ai.targetVX = dx * inv * speed;
  e.ai.targetVZ = dz * inv * speed;
  return false;
}

// ---------------- 调度器（时间片轮转 + 距离分级 + AOI 激活） ----------------
bool AiScheduler::shouldTick(World& w, Entity& e, uint64_t tick) {
  if (!e.active) return false;
  // ① AOI 激活：没有玩家在视野内 → 休眠（省算力，位置由 move 系统保留）
  if (!w.chunks().isEntityVisible(e)) return false;
  // ② 距离分级（AI LOD）：距最近存活玩家越近更新越频繁
  double dmin = 1e18;
  for (const auto& pid : w.players()) {
    const Entity* pl = w.findEntity(pid);
    if (!pl || pl->hp <= 0) continue;
    double d = pl->pos.dist2D(e.pos);
    if (d < dmin) dmin = d;
  }
  uint32_t stride = 1;
  if (dmin > cfg_.aiLodMidM) stride = cfg_.aiLodFarStride;      // 远端：低频
  else if (dmin > cfg_.aiLodNearM) stride = 2;                   // 中距：半频
  e.ai.tickStride = stride;
  // ③ 时间片轮转：用 wid 做相位偏移，把同档位实体摊到不同 tick（避免帧峰）
  return ((tick + e.wid) % stride) == 0;
}

// ---------------- 生物（Monster）状态机 ----------------
void tickMonsterAi(World& w, Entity& e, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
  auto& ai = e.ai;
  // 感知：清理失效仇恨（离线/死亡玩家）
  for (auto it = e.aggro.begin(); it != e.aggro.end();) {
    Entity* pl = w.findByWid(it->first);
    if (!pl || pl->kind != EntityKind::Player || !pl->active || pl->hp <= 0) it = e.aggro.erase(it);
    else ++it;
  }
  Entity* target = pickAggroTarget(w, e);
  // 感知②：无仇恨时，玩家进入仇恨范围 → 主动入仇（近战怪标准行为；可扩展视野/声音/仇恨列表）
  if (!target) {
    for (const auto& pid : w.players()) {
      const Entity* pl = w.findEntity(pid);
      if (!pl || pl->hp <= 0) continue;
      if (pl->pos.dist2D(e.pos) <= cfg.monsterAggroRange) {
        e.aggro[pl->wid] += 1.0; // 入仇权重（可加冷却/概率/受击仇恨衰减扩展）
        if (ai.aiState != AS_CHASE && ai.aiState != AS_ATTACK) ai.aiState = AS_CHASE;
      }
    }
    target = pickAggroTarget(w, e);
  }
  double homeD = std::hypot(e.pos.x - ai.homeX, e.pos.z - ai.homeZ);
  if (target) {
    double d = e.pos.dist2D(target->pos);
    // 超出最大追击距离 → 脱战回巢
    if (d > cfg.monsterLeashRange || homeD > cfg.monsterLeashRange * 2.0) {
      e.aggro.clear();
      ai.aiState = AS_RETURN;
    } else if (d <= cfg.monsterAttackRange) {
      // 近战攻击
      ai.aiState = AS_ATTACK;
      ai.targetVX = ai.targetVZ = 0;
      if (nowMs - e.lastAttackMs >= (uint64_t)(cfg.monsterAttackCdSec * 1000.0)) {
        e.lastAttackMs = nowMs;
        double dmg = e.attack * (0.9 + rng01() * 0.2);
        target->hp -= dmg;
        target->lastDamageMs = nowMs;
        w.pushEvent(proto::EVT_DAMAGE, target->wid, (uint32_t)dmg, 0, 0);
        if (target->hp <= 0) target->hp = 1; // 玩家不死亡（演示保护）
      }
    } else {
      // 追击
      ai.aiState = AS_CHASE;
      moveToward(e, target->pos, ai.speed * 1.8, cfg.monsterAttackRange);
    }
    return;
  }
  // 无仇恨：远离出生点 → 回巢；否则巡逻
  if (homeD > cfg.monsterPatrolRadius) {
    ai.aiState = AS_RETURN;
    moveToward(e, {ai.homeX, e.pos.y, ai.homeZ}, ai.speed, cfg.monsterPatrolRadius * 0.5);
    return;
  }
  ai.aiState = AS_PATROL;
  ai.timer -= dt;
  if (ai.timer <= 0) {
    ai.dirX = rng01() * 2.0 - 1.0;
    ai.dirZ = rng01() * 2.0 - 1.0;
    ai.timer = cfg.monsterPatrolPauseSec + rng01() * 2.0;
  }
  if (homeD > cfg.monsterPatrolRadius * 0.6) {
    // 巡逻越界微回拉
    moveToward(e, {ai.homeX, e.pos.y, ai.homeZ}, ai.speed * 0.6, 2.0);
  } else {
    ai.targetVX = ai.dirX * ai.speed;
    ai.targetVZ = ai.dirZ * ai.speed;
  }
}

// ---------------- NPC 状态机 ----------------
void tickNpcAi(World& w, Entity& e, double dt) {
  (void)w;
  auto& ai = e.ai;
  // 交互态（预留：对话/商店/任务）：站桩
  if (ai.aiState == AS_INTERACT) { ai.targetVX = ai.targetVZ = 0; return; }
  ai.timer -= dt;
  if (ai.timer <= 0) {
    if (rng01() < 0.5) {
      ai.aiState = AS_IDLE; ai.targetVX = ai.targetVZ = 0;
    } else {
      ai.aiState = AS_WANDER;
      ai.dirX = rng01() * 2.0 - 1.0;
      ai.dirZ = rng01() * 2.0 - 1.0;
    }
    ai.timer = 4.0 + rng01() * 6.0;
  }
  if (ai.aiState == AS_WANDER) {
    double homeD = std::hypot(e.pos.x - ai.homeX, e.pos.z - ai.homeZ);
    if (homeD > 6.0) {
      moveToward(e, {ai.homeX, e.pos.y, ai.homeZ}, ai.speed * 0.5, 1.0);
    } else {
      ai.targetVX = ai.dirX * ai.speed * 0.4;
      ai.targetVZ = ai.dirZ * ai.speed * 0.4;
    }
  }
}

// ---------------- 世界 Boss 状态机（全区共享） ----------------
void tickBossAi(World& w, Entity& e, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
  // DEAD：复活计时（全局推进，不依赖视野）
  if (e.bossState == BS_DEAD) {
    if (nowMs >= e.respawnAtMs) {
      e.hp = e.maxHp;
      e.bossState = BS_IDLE;
      e.bossPhase = 1;
      e.bossTarget = 0;
      e.aggro.clear();
      e.pos.x = e.ai.homeX;
      e.pos.z = e.ai.homeZ;
      e.pos.y = terrainHeight(e.pos.x, e.pos.z) + e.radius + 0.3;
      e.vel = {0, 0, 0};
      w.physics().step(e, dt);
      w.addAliveBoss(1);
      w.pushEvent(proto::EVT_RESPAWN, e.wid, 0, 0, 0);
      w.markBossDirty();
    }
    return;
  }
  // 感知：清理失效仇恨
  for (auto it = e.aggro.begin(); it != e.aggro.end();) {
    Entity* pl = w.findByWid(it->first);
    if (!pl || pl->kind != EntityKind::Player || !pl->active || pl->hp <= 0) it = e.aggro.erase(it);
    else ++it;
  }
  // IDLE：脱战回血 + 侦测仇恨
  if (e.bossState == BS_IDLE) {
    if (e.hp < e.maxHp) {
      e.hp = std::min(e.maxHp, e.hp + cfg.bossRegenPerSec * dt);
      w.markBossDirty();
    }
    for (const auto& pid : w.players()) {
      const Entity* pl = w.findEntity(pid);
      if (!pl || pl->hp <= 0) continue;
      if (pl->pos.dist2D(e.pos) <= cfg.bossAggroRange) {
        e.aggro[pl->wid] += 10.0 * dt;
        e.bossState = BS_ENGAGE;
        w.markBossDirty();
      }
    }
  }
  Entity* target = pickAggroTarget(w, e);
  if (!target) {
    if (e.bossState != BS_IDLE) { e.bossState = BS_IDLE; w.markBossDirty(); }
    e.bossTarget = 0;
    e.ai.targetVX = e.ai.targetVZ = 0;
    return;
  }
  if (e.bossTarget != target->wid) { e.bossTarget = target->wid; w.markBossDirty(); }
  if (e.bossState != BS_ENGAGE) { e.bossState = BS_ENGAGE; w.markBossDirty(); }
  // 阶段切换（按血量比例：<=65% P2，<=35% P3）
  uint8_t newPhase = (e.hp / e.maxHp <= 0.35) ? 3 : ((e.hp / e.maxHp <= 0.65) ? 2 : 1);
  if (newPhase != e.bossPhase) { e.bossPhase = newPhase; w.markBossDirty(); }
  double dist = e.pos.dist2D(target->pos);
  if (dist > cfg.bossAttackRange) {
    e.ai.aiState = AS_CHASE;
    moveToward(e, target->pos, cfg.bossChaseSpeed, cfg.bossAttackRange);
  } else {
    e.ai.aiState = AS_ATTACK;
    e.ai.targetVX = e.ai.targetVZ = 0;
    if (nowMs - e.lastAttackMs >= (uint64_t)(cfg.bossAttackCdSec * 1000.0)) {
      e.lastAttackMs = nowMs;
      double dmg = e.attack * (0.9 + rng01() * 0.2);
      target->hp -= dmg;
      target->lastDamageMs = nowMs;
      e.aggro[target->wid] -= dmg * 0.3; // 被攻击目标仇恨衰减
      w.pushEvent(proto::EVT_DAMAGE, target->wid, (uint32_t)dmg, 0, 0);
      if (target->hp <= 0) target->hp = 1;
      // 范围技能（周期性 AOE，全区广播）
      e.bossSkillCd -= dt;
      if (e.bossSkillCd <= 0) {
        e.bossSkillCd = cfg.bossSkillCdSec;
        w.pushEvent(proto::EVT_SKILL, e.wid, 1, (int32_t)e.pos.x, (int32_t)e.pos.z);
        for (const auto& pid : w.players()) {
          Entity* pl = w.findEntity(pid);
          if (!pl || pl->hp <= 0) continue;
          if (pl->pos.dist2D(e.pos) <= cfg.bossSkillRange) {
            double sdmg = e.attack * 0.8;
            pl->hp -= sdmg;
            pl->lastDamageMs = nowMs;
            w.pushEvent(proto::EVT_DAMAGE, pl->wid, (uint32_t)sdmg, 0, 0);
            if (pl->hp <= 0) pl->hp = 1;
          }
        }
      }
    }
  }
}
} // namespace ew
