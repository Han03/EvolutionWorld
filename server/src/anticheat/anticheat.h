// anticheat.h - 防作弊系统
//
// 设计目标（对应需求）：
//  1. 客户端上报纯物理位置，服务端校验可达性+地形后采纳
//  2. 每次校验（非采样），位置校验是采纳的前提
//  3. 轨迹校验（位移可达性 + 轨迹连续性），限制上报频率（令牌桶），防止高频瞬移包轰炸
//  4. 不信任客户端时间戳（一律使用服务端时钟与序号排序），允许网络容错（可配置阈值）
#pragma once
#include <string>
#include <unordered_map>
#include <cstdint>
#include "game/entity.h"
#include "game/world.h"
#include "../config.h"

namespace ew {

struct AntiCheatResult {
  bool accepted = true;     // 是否接受该输入（写入模拟）
  bool correction = false;  // 是否下发回退
  bool kick = false;        // 是否踢出
  std::string reason;       // 原因（用于日志/调试）
  // 地形容差夹紧：严格级判定失败但收缩半径后通过时，位置被沿「权威位置→claim」
  // 线段夹紧到严格可通行点。上层必须采纳 (x,z) 而不是原始 claim，否则权威位置会落在
  // 阻挡区内（进而使后续每次上报都失败）。
  bool clamped = false;
  double x = 0, z = 0;
};

class AntiCheat {
public:
  explicit AntiCheat(const Config& cfg) : cfg_(cfg) {}

  // 处理一条位置上报消息；上层根据结果决定是否采纳位置/下发 correction/kick
  // 返回 accepted=true 表示位置可采纳，accepted=false 表示不采纳（rate_limit/stale_seq）
  AntiCheatResult process(Entity& p, int64_t seq, double px, double pz, uint64_t nowMs);
  void reset(Entity& p);
  // 测试模式：跳过全部校验（频率/序号/轨迹），输入直接接受（由 World::testFlags().antiCheatBypass 驱动）
  void setBypass(bool b) { bypass_ = b; }

private:
  struct RateBucket { double tokens; uint64_t lastMs; };
  struct Claim { double x, z; uint64_t ms; bool has = false; };

  bool checkRate(Entity& p, uint64_t nowMs);
  int checkSeq(Entity& p, int64_t seq);
  // 轨迹校验（每次执行，位置采纳的前提）
  // px/pz 为传入传出：地形严格级失败但容差级通过时，会被夹紧到严格可通行位置。
  // soft=true 表示「软失败」（双端地形判定分歧，贴墙行走属正常行为）：
  // 上层应下发校正但不得累计 violations，否则正常玩家会被误踢。
  bool validateClaim(Entity& p, double& px, double& pz, uint64_t nowMs,
                     std::string& why, bool& soft);
  // 沿「权威位置→(px,pz)」线段二分回退，找最远的严格可通行点并写回 px/pz。
  // 权威位置自身也不可通行时返回 false（不夹紧，交由软失败处理，避免退到同一个坑里）。
  bool clampToWalkable(const Entity& p, double& px, double& pz) const;
  void onViolation(Entity& p, AntiCheatResult& out, const std::string& reason);

  const Config& cfg_;
  bool bypass_ = false;   // 测试模式：跳过校验（默认关闭）
  std::unordered_map<std::string, RateBucket> buckets_;
  std::unordered_map<std::string, Claim> claims_;
};

} // namespace ew
