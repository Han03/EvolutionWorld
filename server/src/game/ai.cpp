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

// 应用减速 Buff（MOVE_SLOW 比例 0..1，多 Buff 取最大减速；复用 Entity::moveScale 与协议广播一致）
static double slowedSpeed(const Entity& e, double base) {
  return base * e.moveScale();
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

// ---------------- 确定性巡逻 waypoint 环（去随机化） ----------------
// 怪物出生后围绕出生点逆时针遍历固定 waypoint 环，取代 rng01() 随机掉头与越界回拉抖动。
// 环参数由出生点坐标确定性哈希生成（同 seed 跨服/跨重启一致）；每个 waypoint 就近吸附到干地，
// 避免走进空洞/水面。客户端无需复刻本公式——它只消费服务端广播的移动意图（targetVX/VZ）。
static uint32_t hash2(double x, double z, uint32_t seed) {
  uint32_t h = (uint32_t)std::lround(x * 13.7) * 73856093u
             ^ (uint32_t)std::lround(z * 7.3) * 19349663u
             ^ seed ^ 0x9e3779b9u;
  h ^= h >> 16;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  return h;
}
static bool waypointOk(double x, double z) {
  return !terrainBlocked(x, z) && terrainHeight(x, z) > kWaterLevel + 1.0;
}
// waypoint 命中空洞/水面 → 就近确定性搜索最近干地
static void snapWaypoint(double& wx, double& wz) {
  if (waypointOk(wx, wz)) return;
  for (double rr = 1.0; rr <= 7.0; rr += 1.0) {
    for (int k = 0; k < 24; k++) {
      double a = (double)k / 24.0 * 6.2831853;
      double px = wx + std::cos(a) * rr, pz = wz + std::sin(a) * rr;
      if (waypointOk(px, pz)) { wx = px; wz = pz; return; }
    }
  }
}
static void initWaypoints(const Config& cfg, Entity& e) {
  auto& ai = e.ai;
  ai.wpCount = 6;
  ai.wpR = std::max(3.0, cfg.monsterPatrolRadius * 0.5);
  ai.wpPhase = (double)(hash2(ai.homeX, ai.homeZ, 0x51ab7c9a) & 0xFFFF) / 65535.0 * 6.283185307;
  ai.wpIdx = 0;
  ai.wpInit = true;
  ai.timer = cfg.monsterPatrolPauseSec;
}
static void waypointTarget(const Config& cfg, Entity& e, double& wx, double& wz) {
  auto& ai = e.ai;
  if (!ai.wpInit) initWaypoints(cfg, e);
  double ang = ai.wpPhase + (double)ai.wpIdx * (6.283185307 / (double)ai.wpCount);
  wx = ai.homeX + std::cos(ang) * ai.wpR;
  wz = ai.homeZ + std::sin(ang) * ai.wpR;
  snapWaypoint(wx, wz);
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

// ---------------- 怪物技能选择（优先特殊效果，回退基础攻击） ----------------
static const SkillDef* pickMonsterSkill(World& w, Entity& e, Entity& target, uint64_t nowMs) {
  const SkillDef* fallback = nullptr;
  double dist = e.pos.dist2D(target.pos);
  for (uint32_t sid : e.skillIds) {
    const SkillDef* sd = w.data().skill(sid);
    if (!sd) continue;
    auto cdIt = e.skillCd.find(sid);
    if (cdIt != e.skillCd.end() && nowMs < cdIt->second) continue;
    double range = sd->range > 0 ? sd->range : 3.0;
    if (dist > range) continue;
    if (sd->buffType != BuffType::NONE || sd->dmgMul > 1.0 || sd->knockback > 0) return sd;
    if (!fallback) fallback = sd;
  }
  return fallback;
}

// 选择精英 AOE 技能（target=AOE，冷却好可用）
static const SkillDef* pickEliteAoeSkill(World& w, Entity& e, uint64_t nowMs) {
  for (uint32_t sid : e.skillIds) {
    const SkillDef* sd = w.data().skill(sid);
    if (!sd || sd->target != SkillTarget::AOE) continue;
    auto cdIt = e.skillCd.find(sid);
    if (cdIt != e.skillCd.end() && nowMs < cdIt->second) continue;
    return sd;
  }
  return nullptr;
}

// ---------------- 生物（Monster）状态机 ----------------
// 状态机：游走态(PATROL) ⇄ 仇恨态(CHASE/ATTACK) → 恢复态(RECOVER) → 游走态(PATROL)
//
// 游走态：沿确定性 waypoint 环巡逻
// 仇恨态-追击(CHASE)：被攻击或玩家进入仇恨范围 → 记录当前 waypoint → 追击目标
// 仇恨态-战斗(ATTACK)：目标进入攻击范围 → 攻击/施法；离开范围 → 回到追击
// 恢复态(RECOVER)：仇恨态连续追击 >15s 未中断 → 无敌+回血+加速归位 → 到达记录点后回到游走态（被攻击则重置计时）
void tickMonsterAi(World& w, Entity& e, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.logicNowMs();
  auto& ai = e.ai;
  // 眩晕：无法移动/攻击（霸体可免疫挂载；期间保持静止）
  if (e.hasBuff((uint8_t)BuffType::STUN)) {
    ai.targetVX = 0;
    ai.targetVZ = 0;
    return;
  }
  // 前摇结算：怪物施放中的技能到期后结算
  if (e.castingSkillId != 0) {
    const SkillDef* csd = w.data().skill(e.castingSkillId);
    if (csd && nowMs >= e.castStartMs + (uint64_t)csd->castTimeMs) {
      Entity* ct = w.findByWid(e.castTargetWid);
      if (ct && ct->active && ct->hp > 0) {
        w.pushEvent(proto::EVT_SKILL, e.wid, csd->id, proto::qAbs(ct->pos.x), proto::qAbs(ct->pos.z));
        w.applySkillToTarget(e, *ct, *csd, 0.9 + rng01() * 0.2);
      }
      e.castingSkillId = 0;
    } else {
      ai.targetVX = ai.targetVZ = 0; // 前摇中静止
      return;
    }
  }
  // 感知：清理失效仇恨（离线/死亡玩家）
  for (auto it = e.aggro.begin(); it != e.aggro.end();) {
    Entity* pl = w.findByWid(it->first);
    if (!pl || pl->kind != EntityKind::Player || !pl->active || pl->hp <= 0) it = e.aggro.erase(it);
    else ++it;
  }
  // 确保 waypoint 环已初始化
  if (!ai.wpInit) initWaypoints(cfg, e);
  // 计算当前 waypoint 目标位置（用于进入仇恨态时记录归位点）
  double curWpX, curWpZ;
  waypointTarget(cfg, e, curWpX, curWpZ);
  // 感知②：非仇恨/非恢复态时，玩家进入仇恨范围 → 主动入仇
  // 恢复态期间不主动入仇（无视玩家），但被攻击产生的仇恨仍会累积
  if (ai.aiState != AS_CHASE && ai.aiState != AS_ATTACK && ai.aiState != AS_RECOVER) {
    for (const auto& pid : w.players()) {
      const Entity* pl = w.findEntity(pid);
      if (!pl || pl->hp <= 0) continue;
      if (pl->pos.dist2D(e.pos) <= cfg.monsterAggroRange) {
        e.aggro[pl->wid] += 1.0;
        // 记录进入仇恨态时的轨迹点（归位目标）
        ai.recoverWpX = curWpX;
        ai.recoverWpZ = curWpZ;
        ai.chaseTime = 0;
        break;
      }
    }
  }
  Entity* target = pickAggroTarget(w, e);
  double homeD = std::hypot(e.pos.x - ai.homeX, e.pos.z - ai.homeZ);
  // ---- 恢复态：无敌 + 回血 + 加速归位 ----
  if (ai.aiState == AS_RECOVER) {
    // 回血
    if (e.hp < e.maxHp)
      e.hp = std::min(e.maxHp, e.hp + cfg.monsterRecoverRegenPerSec * dt);
    // 加速回到记录的轨迹点
    bool arrived = moveToward(e, {ai.recoverWpX, e.pos.y, ai.recoverWpZ},
                              slowedSpeed(e, ai.speed * cfg.monsterRecoverSpeedMul),
                              cfg.monsterPatrolArrive);
    if (arrived) {
      // 归位完成 → 转为游走态，取消无敌
      ai.aiState = AS_PATROL;
      ai.invincible = false;
      ai.chaseTime = 0;
      ai.stuckT = 0;
      ai.timer = cfg.monsterPatrolPauseSec;
      e.aggro.clear(); // 清除仇恨，重新开始
    }
    return;
  }
  // ---- 有仇恨目标：仇恨态（追击/战斗） ----
  if (target) {
    double d = e.pos.dist2D(target->pos);
    // 超出最大追击距离 → 脱战回巢
    if (d > cfg.monsterLeashRange || homeD > cfg.monsterLeashRange * 2.0) {
      e.aggro.clear();
      ai.aiState = AS_RETURN;
      ai.chaseTime = 0;
      ai.invincible = false;
    } else if (d <= cfg.monsterAttackRange) {
      // ---- 战斗态：目标在攻击范围内 ----
      ai.aiState = AS_ATTACK;
      ai.targetVX = ai.targetVZ = 0;
      ai.chaseTime = 0; // 进入战斗态重置追击计时
      if (nowMs - e.lastAttackMs >= (uint64_t)(cfg.monsterAttackCdSec * 1000.0)) {
        const SkillDef* sd = pickMonsterSkill(w, e, *target, nowMs);
        if (sd) {
          e.lastAttackMs = nowMs;
          e.skillCd[sd->id] = nowMs + (uint64_t)sd->cooldownMs;
          if (sd->castTimeMs > 0) {
            e.castingSkillId = sd->id;
            e.castStartMs = nowMs;
            e.castTargetWid = target->wid;
            e.castTx = target->pos.x;
            e.castTz = target->pos.z;
            w.pushEvent(proto::EVT_SKILL_CASTING, e.wid, sd->id,
                        proto::qAbs(target->pos.x), proto::qAbs(target->pos.z));
          } else {
            w.pushEvent(proto::EVT_SKILL, e.wid, sd->id,
                        proto::qAbs(target->pos.x), proto::qAbs(target->pos.z));
            w.applySkillToTarget(e, *target, *sd, 0.9 + rng01() * 0.2);
          }
        }
      }
    } else {
      // ---- 追击态：朝目标移动 ----
      ai.aiState = AS_CHASE;
      ai.chaseTime += dt;
      // 追击超时 → 进入恢复态（无敌 + 回血 + 加速归位）
      if (ai.chaseTime >= cfg.monsterRecoverChaseThreshold) {
        ai.aiState = AS_RECOVER;
        ai.invincible = true;
        return;
      }
      // 卡住解困：被空洞/悬崖/深水墙挡住持续卡住 → 放弃追击回巢
      if (ai.stuckT > 2.0) {
        e.aggro.clear();
        ai.aiState = AS_RETURN;
        ai.stuckT = 0;
        ai.chaseTime = 0;
        ai.invincible = false;
        return;
      }
      moveToward(e, target->pos, slowedSpeed(e, ai.speed * 1.8), cfg.monsterAttackRange);
    }
    return;
  }
  // ---- 无仇恨：远离出生点 → 回巢；否则游走态 ----
  if (homeD > cfg.monsterPatrolRadius) {
    ai.aiState = AS_RETURN;
    moveToward(e, {ai.homeX, e.pos.y, ai.homeZ},
               slowedSpeed(e, ai.speed), cfg.monsterPatrolRadius * 0.5);
    return;
  }
  // ---- 游走态：沿确定性 waypoint 环巡逻 ----
  ai.aiState = AS_PATROL;
  ai.invincible = false; // 确保游走态无无敌
  // 卡住（空洞/悬崖/实体墙）→ 推进到下一个 waypoint
  if (ai.stuckT > 1.5) {
    ai.wpIdx = (ai.wpIdx + 1) % ai.wpCount;
    ai.stuckT = 0;
    ai.timer = 0;
  }
  const double arrive = std::hypot(curWpX - e.pos.x, curWpZ - e.pos.z);
  if (arrive <= cfg.monsterPatrolArrive) {
    // 到达 waypoint：暂停后去下一个（固定 pause 时长）
    ai.timer -= dt;
    if (ai.timer <= 0) {
      ai.wpIdx = (ai.wpIdx + 1) % ai.wpCount;
      ai.timer = cfg.monsterPatrolPauseSec;
    }
    ai.targetVX = ai.targetVZ = 0;
  } else {
    // 朝当前 waypoint 匀速移动（含减速 buff 倍率）
    moveToward(e, {curWpX, e.pos.y, curWpZ},
               slowedSpeed(e, ai.speed), cfg.monsterPatrolArrive);
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
    // 空洞/障碍前卡住 → 换游走方向
    if (ai.stuckT > 1.5) {
      ai.dirX = rng01() * 2.0 - 1.0;
      ai.dirZ = rng01() * 2.0 - 1.0;
      ai.timer = 3.0 + rng01() * 4.0;
      ai.stuckT = 0;
    }
    double homeD = std::hypot(e.pos.x - ai.homeX, e.pos.z - ai.homeZ);
    if (homeD > 6.0) {
      moveToward(e, {ai.homeX, e.pos.y, ai.homeZ}, slowedSpeed(e, ai.speed * 0.5), 1.0);
    } else {
      ai.targetVX = ai.dirX * ai.speed * 0.4;
      ai.targetVZ = ai.dirZ * ai.speed * 0.4;
    }
  }
}

// ---------------- 世界精英状态机（全区共享） ----------------
void tickEliteAi(World& w, Entity& e, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.logicNowMs();
  // DEAD：复活计时（全局推进，不依赖视野）
  if (e.eliteState == ES_DEAD) {
    if (nowMs >= e.respawnAtMs) {
      e.hp = e.maxHp;
      e.eliteState = ES_IDLE;
      e.elitePhase = 1;
      e.eliteTarget = 0;
      e.aggro.clear();
      e.pos.x = e.ai.homeX;
      e.pos.z = e.ai.homeZ;
      e.pos.y = groundFootY(e.pos.x, e.pos.z, e.radius);
      e.vel = {0, 0, 0};
      w.physics().step(e, dt);
      w.addAliveElite(1);
      w.pushEvent(proto::EVT_RESPAWN, e.wid, 0, 0, 0);
      w.markEliteDirty();
    }
    return;
  }
  // 眩晕：无法移动/攻击（霸体可免疫挂载）
  const bool eliteStunned = e.hasBuff((uint8_t)BuffType::STUN);
  // 感知：清理失效仇恨
  for (auto it = e.aggro.begin(); it != e.aggro.end();) {
    Entity* pl = w.findByWid(it->first);
    if (!pl || pl->kind != EntityKind::Player || !pl->active || pl->hp <= 0) it = e.aggro.erase(it);
    else ++it;
  }
  if (eliteStunned) {
    e.ai.targetVX = 0;
    e.ai.targetVZ = 0;
    // IDLE 脱战回血不受眩晕影响
    if (e.eliteState == ES_IDLE && e.hp < e.maxHp) {
      e.hp = std::min(e.maxHp, e.hp + cfg.eliteRegenPerSec * dt);
    }
    return;
  }
  // 前摇结算：精英施放中的技能到期后结算
  if (e.castingSkillId != 0) {
    const SkillDef* csd = w.data().skill(e.castingSkillId);
    if (csd && nowMs >= e.castStartMs + (uint64_t)csd->castTimeMs) {
      // AOE 技能：对范围内所有玩家施加效果
      double aoeRange = csd->radius > 0 ? csd->radius : 6.0;
      w.pushEvent(proto::EVT_SKILL, e.wid, csd->id, proto::qAbs(e.pos.x), proto::qAbs(e.pos.z));
      for (const auto& pid : w.players()) {
        Entity* pl = w.findEntity(pid);
        if (!pl || pl->hp <= 0) continue;
        if (pl->pos.dist2D(e.pos) <= aoeRange) {
          w.applySkillToTarget(e, *pl, *csd, 1.0);
        }
      }
      e.castingSkillId = 0;
    } else {
      e.ai.targetVX = e.ai.targetVZ = 0; // 前摇中静止
      return;
    }
  }
  // IDLE：脱战回血 + 侦测仇恨
  if (e.eliteState == ES_IDLE) {
    if (e.hp < e.maxHp) {
      e.hp = std::min(e.maxHp, e.hp + cfg.eliteRegenPerSec * dt);
      w.markEliteDirty();
    }
    for (const auto& pid : w.players()) {
      const Entity* pl = w.findEntity(pid);
      if (!pl || pl->hp <= 0) continue;
      if (pl->pos.dist2D(e.pos) <= cfg.eliteAggroRange) {
        e.aggro[pl->wid] += 10.0 * dt;
        e.eliteState = ES_ENGAGE;
        w.markEliteDirty();
      }
    }
  }
  Entity* target = pickAggroTarget(w, e);
  if (!target) {
    if (e.eliteState != ES_IDLE) { e.eliteState = ES_IDLE; w.markEliteDirty(); }
    e.eliteTarget = 0;
    e.ai.targetVX = e.ai.targetVZ = 0;
    return;
  }
  if (e.eliteTarget != target->wid) { e.eliteTarget = target->wid; w.markEliteDirty(); }
  if (e.eliteState != ES_ENGAGE) { e.eliteState = ES_ENGAGE; w.markEliteDirty(); }
  // 阶段切换（按血量比例：<=65% P2，<=35% P3）
  uint8_t newPhase = (e.hp / e.maxHp <= 0.35) ? 3 : ((e.hp / e.maxHp <= 0.65) ? 2 : 1);
  if (newPhase != e.elitePhase) { e.elitePhase = newPhase; w.markEliteDirty(); }
  double dist = e.pos.dist2D(target->pos);
  if (dist > cfg.eliteAttackRange) {
    e.ai.aiState = AS_CHASE;
    moveToward(e, target->pos, slowedSpeed(e, cfg.eliteChaseSpeed), cfg.eliteAttackRange);
  } else {
    e.ai.aiState = AS_ATTACK;
    e.ai.targetVX = e.ai.targetVZ = 0;
    if (nowMs - e.lastAttackMs >= (uint64_t)(cfg.eliteAttackCdSec * 1000.0)) {
      // 普攻（接入技能系统，选第一个非 AOE 技能）
      const SkillDef* atkSkill = nullptr;
      for (uint32_t sid : e.skillIds) {
        const SkillDef* sd = w.data().skill(sid);
        if (!sd || sd->target == SkillTarget::AOE) continue;
        auto cdIt = e.skillCd.find(sid);
        if (cdIt != e.skillCd.end() && nowMs < cdIt->second) continue;
        atkSkill = sd;
        break;
      }
      if (atkSkill) {
        e.lastAttackMs = nowMs;
        e.skillCd[atkSkill->id] = nowMs + (uint64_t)atkSkill->cooldownMs;
        w.pushEvent(proto::EVT_SKILL, e.wid, atkSkill->id, proto::qAbs(target->pos.x), proto::qAbs(target->pos.z));
        w.applySkillToTarget(e, *target, *atkSkill, 0.9 + rng01() * 0.2);
        e.aggro[target->wid] -= target->lastDamageMs == nowMs ? 0 : 0; // 仇恨衰减由 applySkillToTarget 内的 aggro 增长平衡
      }
      // 范围技能（AOE，独立冷却，有前摇则进入施放状态）
      const SkillDef* aoeSkill = pickEliteAoeSkill(w, e, nowMs);
      if (aoeSkill) {
        e.skillCd[aoeSkill->id] = nowMs + (uint64_t)aoeSkill->cooldownMs;
        if (aoeSkill->castTimeMs > 0) {
          // 有前摇：进入施放状态（广播 EVT_SKILL_CASTING 供客户端显示范围提示）
          e.castingSkillId = aoeSkill->id;
          e.castStartMs = nowMs;
          e.castTargetWid = 0;
          e.castTx = e.pos.x;
          e.castTz = e.pos.z;
          w.pushEvent(proto::EVT_SKILL_CASTING, e.wid, aoeSkill->id, proto::qAbs(e.pos.x), proto::qAbs(e.pos.z));
        } else {
          w.pushEvent(proto::EVT_SKILL, e.wid, aoeSkill->id, proto::qAbs(e.pos.x), proto::qAbs(e.pos.z));
          const double aoeRange = aoeSkill->radius > 0 ? aoeSkill->radius : 6.0;
          for (const auto& pid : w.players()) {
            Entity* pl = w.findEntity(pid);
            if (!pl || pl->hp <= 0) continue;
            if (pl->pos.dist2D(e.pos) <= aoeRange) {
              w.applySkillToTarget(e, *pl, *aoeSkill, 1.0);
            }
          }
        }
      }
    }
  }
}
} // namespace ew
