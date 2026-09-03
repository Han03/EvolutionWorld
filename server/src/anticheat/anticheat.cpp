// anticheat.cpp - 防作弊实现
#include "anticheat.h"
#include <cmath>
#include <algorithm>
#include <cstdlib>

namespace ew {

AntiCheatResult AntiCheat::process(Entity& p, const Json& msg, uint64_t nowMs) {
  AntiCheatResult out;

  // ---- 0) 解析并清洗输入（不信任任何客户端数值） ----
  double moveX = msg.at("moveX").isNull() ? 0.0 : msg.at("moveX").asNumber();
  double moveZ = msg.at("moveZ").isNull() ? 0.0 : msg.at("moveZ").asNumber();
  bool jump = msg.at("jump").asBool();
  int64_t seq = msg.at("seq").asInt();
  bool hasClaim = msg.has("px") && msg.has("py") && msg.has("pz");
  double px = hasClaim ? msg.at("px").asNumber() : 0;
  double py = hasClaim ? msg.at("py").asNumber() : 0;
  double pz = hasClaim ? msg.at("pz").asNumber() : 0;

  // 数值清洗：NaN/Inf 一律当作 0；move 限制在 [-1,1]
  if (!std::isfinite(moveX)) moveX = 0; else moveX = std::max(-1.0, std::min(1.0, moveX));
  if (!std::isfinite(moveZ)) moveZ = 0; else moveZ = std::max(-1.0, std::min(1.0, moveZ));
  if (!std::isfinite(px)) px = p.pos.x;
  if (!std::isfinite(py)) py = p.pos.y;
  if (!std::isfinite(pz)) pz = p.pos.z;

  // ---- 测试模式：跳过频率/序号/轨迹全部校验，输入直接接受（不下发 correction/kick）----
  if (bypass_) {
    p.input.moveX = moveX;
    p.input.moveZ = moveZ;
    if (jump) p.input.jump = true;
    p.lastSeq = seq;
    p.acceptedInputs++;
    p.lastAcceptMs = nowMs;
    return out;  // accepted=true, correction=false, kick=false
  }

  // ---- 1) 限制上报频率（令牌桶，防高频瞬移包轰炸） ----
  if (!checkRate(p, nowMs)) {
    p.rateDrops++;
    out.accepted = false;
    out.reason = "rate_limit";
    // 持续超频直接踢出
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

  // 通过频率/序号校验后，才写入输入（服务端权威模拟）
  p.input.moveX = moveX;
  p.input.moveZ = moveZ;
  if (jump) p.input.jump = true;
  p.lastSeq = seq;

  // ---- 3) 随机采样 + 轨迹校验 ----
  bool sample = (p.acceptedInputs >= cfg_.graceInputs) &&
                (std::rand() % 100 < cfg_.sampleRatePct);
  if (sample && hasClaim) {
    std::string why;
    if (!validateClaim(p, px, py, pz, nowMs, why)) {
      onViolation(p, out, why);
      return out;
    }
  }
  p.acceptedInputs++;
  p.lastAcceptMs = nowMs;
  return out;
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

bool AntiCheat::validateClaim(Entity& p, double px, double py, double pz, uint64_t nowMs, std::string& why) {
  const double maxSpeed = cfg_.maxMoveSpeed;

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

  // 检查 B：纵向可达性（跳跃高度 + 重力落差 + 容错）
  double dy = std::fabs(py - p.pos.y);
  if (dy > cfg_.verticalToleranceM) {
    why = "teleport:y_dist=" + std::to_string((int)dy);
    return false;
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

void AntiCheat::reset(Entity& p) {
  buckets_.erase(p.id);
  claims_.erase(p.id);
}

} // namespace ew
