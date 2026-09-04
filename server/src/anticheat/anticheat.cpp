// anticheat.cpp - 防作弊实现
#include "anticheat.h"
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include "game/terrain.h"
#include "game/collision.h"

namespace ew {

AntiCheatResult AntiCheat::process(Entity& p, int64_t seq, double px, double pz, uint64_t nowMs) {
  AntiCheatResult out;

  // 数值清洗：NaN/Inf 当作服务端当前位置
  if (!std::isfinite(px)) px = p.pos.x;
  if (!std::isfinite(pz)) pz = p.pos.z;

  // ---- 测试模式：跳过频率/序号/轨迹全部校验，位置直接接受 ----
  if (bypass_) {
    p.lastSeq = seq;
    p.acceptedInputs++;
    p.lastAcceptMs = nowMs;
    p.rateDrops = 0;
    return out;  // accepted=true, correction=false, kick=false
  }

  // ---- 1) 限制上报频率（令牌桶，防高频瞬移包轰炸） ----
  if (!checkRate(p, nowMs)) {
    p.rateDrops++;
    out.accepted = false;
    out.reason = "rate_limit";
    if (p.rateDrops >= cfg_.rateKickAfter) {
      p.rateDrops = 0;
      onViolation(p, out, "rate_limit_abuse");
    }
    return out;
  }

  // ---- 2) 序号校验（不信任客户端时间戳，用 seq 做顺序仲裁） ----
  int seqState = checkSeq(p, seq);
  if (seqState < 0) { // 过期乱序：丢弃
    out.accepted = false;
    out.reason = "stale_seq";
    return out;
  }
  if (seqState > 0) { // 序号跳变过大：违规
    onViolation(p, out, "seq_jump");
    return out;
  }

  // 通过频率/序号校验
  p.lastSeq = seq;

  // ---- 3) 位置校验（每次执行，非采样；位置校验是采纳的前提） ----
  if (p.acceptedInputs >= cfg_.graceInputs) {
    const double claimX = px, claimZ = pz;
    std::string why;
    bool soft = false;
    if (!validateClaim(p, px, pz, nowMs, why, soft)) {
      if (soft) {
        // 软失败：双端地形判定的亚厘米级分歧（贴墙行走属正常行为）。
        // 下发校正拉回权威位置，但不计入 violations —— kickThreshold 仅 6，
        // 若计入则沿地形边界正常走六次就会被当外挂踢出。
        p.terrainRejects++;
        out.accepted = false;
        out.correction = true;
        out.reason = why;
        return out;
      }
      onViolation(p, out, why);
      return out;
    }
    // 地形严格级失败但容差级通过：位置已被夹紧，上层必须采纳夹紧后的值
    // （未夹紧时 px/pz 未被触及，与 claimX/claimZ 逐位相等）
    if (px != claimX || pz != claimZ) {
      out.clamped = true;
      out.x = px;
      out.z = pz;
    }
  }
  p.acceptedInputs++;
  p.lastAcceptMs = nowMs;
  return out;  // accepted=true
}

void AntiCheat::onViolation(Entity& p, AntiCheatResult& out, const std::string& reason) {
  p.violations++;
  out.accepted = false;          // 该输入不写入模拟（作为惩罚）
  out.correction = true;         // 下发回退：把客户端拉回服务端权威位置
  out.reason = reason;
  if (p.violations >= cfg_.kickThreshold) {
    out.kick = true;
  }
}

bool AntiCheat::checkRate(Entity& p, uint64_t nowMs) {
  RateBucket& b = buckets_[p.id];
  if (b.lastMs == 0) {
    b.tokens = cfg_.inputBurst;
    b.lastMs = nowMs;
    return true;
  }
  double elapsed = (double)(nowMs - b.lastMs) / 1000.0;
  if (elapsed < 0 || elapsed > 2.0) { // 时钟回拨/长时间无输入：重置桶
    b.tokens = cfg_.inputBurst;
    b.lastMs = nowMs;
    return true;
  }
  b.tokens = std::min((double)cfg_.inputBurst, b.tokens + elapsed * cfg_.maxInputRatePerSec);
  b.lastMs = nowMs;
  if (b.tokens >= 1.0) {
    b.tokens -= 1.0;
    return true;
  }
  return false;
}

int AntiCheat::checkSeq(Entity& p, int64_t seq) {
  if (seq <= p.lastSeq - cfg_.seqReorderWindow) return -1; // 过期/乱序
  if (seq > p.lastSeq + cfg_.seqJumpWindow) return 1;      // 跳变过大
  return 0;
}

bool AntiCheat::validateClaim(Entity& p, double& px, double& pz, uint64_t nowMs,
                              std::string& why, bool& soft) {
  const double maxSpeed = cfg_.maxMoveSpeed;
  soft = false;

  // 时间间隔（服务端时钟，不信任客户端时间戳）
  double dtServer = 0.0;
  if (p.lastAcceptMs != 0) {
    dtServer = (double)(nowMs - p.lastAcceptMs) / 1000.0;
    dtServer = std::max(0.0, std::min(dtServer, 1.0)); // 封顶
  }

  // 检查 A：相对服务端权威位置的位移可达性（防瞬移/传送）
  double distToServer = std::hypot(px - p.pos.x, pz - p.pos.z);
  double reachA = maxSpeed * dtServer + cfg_.teleportToleranceM;
  if (distToServer > reachA) {
    why = "teleport:xz_dist=" + std::to_string((int)distToServer) + ">reach=" + std::to_string((int)reachA);
    return false;
  }

  // 检查 B：地形校验（防穿墙）——两级判定 + 夹紧
  // 严格级：目标位圆盘（radius）不与不可通行区域重叠 → 直接通过（绝大多数上报走这条）。
  // 容差级：上报位置经 0.01m 量化，且双端地形函数存在浮点/数据源分歧，边界处
  //          可能差几毫米。严格级失败时把半径收缩 terrainToleranceM 再判一次；通过则把
  //          位置沿「权威位置→claim」线段夹紧回严格可通行点——既吸收分歧，又保证
  //          权威位置恒可通行（否则后续每次上报都会判 terrain_blocked）。
  //          收缩量是固定的穿透上限（非增量），故不存在逐步蚕食进墙的可能。
  Collision col;
  if (col.circleBlocked(px, pz, p.radius)) {
    const double rTol = p.radius - (double)cfg_.terrainToleranceM;
    const bool withinTolerance = rTol > 0.0 && !col.circleBlocked(px, pz, rTol);
    if (!withinTolerance || !clampToWalkable(p, px, pz)) {
      why = "terrain_blocked";
      soft = true;   // 软失败：不计入 violations
      return false;
    }
  }

  // 检查 C：轨迹连续性（相邻两次上报的位移需符合最大速度）
  auto it = claims_.find(p.id);
  if (it != claims_.end() && it->second.has) {
    double dtClaim = (double)(nowMs - it->second.ms) / 1000.0;
    dtClaim = std::max(0.0, std::min(dtClaim, 1.0));
    double distToLast = std::hypot(px - it->second.x, pz - it->second.z);
    double reachC = maxSpeed * dtClaim + cfg_.teleportToleranceM;
    if (distToLast > reachC) {
      why = "trajectory:seg=" + std::to_string((int)distToLast) + ">reach=" + std::to_string((int)reachC);
      return false;
    }
  }
  claims_[p.id] = {px, pz, nowMs, true};
  return true;
}

// 沿「权威位置→(px,pz)」线段二分回退，找最远的严格可通行点并写回 px/pz。
// 权威位置按不变式恒为严格可通行（采纳前已过检查 B 严格级或已被夹紧），故回退必能收敛；
// 万一权威位置自身落在阻挡区（如被 applyKnockback 推入），返回 false 交由软失败处理，
// 避免把玩家夹到同一个坑里造成永久卡死。
bool AntiCheat::clampToWalkable(const Entity& p, double& px, double& pz) const {
  Collision col;
  const double ax = p.pos.x, az = p.pos.z;
  if (col.circleBlocked(ax, az, p.radius)) return false;  // 锚点自身不可通行：放弃夹紧
  const double dx = px - ax, dz = pz - az;
  const double seg = std::hypot(dx, dz);
  if (seg < 1e-9) return false;  // claim 与锚点重合，无需夹紧
  // 二分：lo 恒为严格可通行、hi 恒为阻挡；8 次迭代收敛到 seg/256（≈ 3mm，远细于 0.01m 量化）
  double lo = 0.0, hi = 1.0;
  for (int i = 0; i < 8; i++) {
    const double mid = (lo + hi) * 0.5;
    if (col.circleBlocked(ax + dx * mid, az + dz * mid, p.radius)) hi = mid;
    else lo = mid;
  }
  px = ax + dx * lo;
  pz = az + dz * lo;
  return true;
}

void AntiCheat::reset(Entity& p) {
  buckets_.erase(p.id);
  claims_.erase(p.id);
  p.terrainRejects = 0;
}

} // namespace ew
