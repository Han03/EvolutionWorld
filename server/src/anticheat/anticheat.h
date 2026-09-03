// anticheat.h - 防作弊系统
//
// 设计目标（对应需求）：
//  1. 客户端预测保持流畅，服务端后校验，不通过则退回（correction 回退包）
//  2. 随机采样校验（sampleRatePct）
//  3. 轨迹校验（位移可达性 + 轨迹连续性），限制上报频率（令牌桶），防止高频瞬移包轰炸
//  4. 不信任客户端时间戳（一律使用服务端时钟与序号排序），允许网络容错（可配置阈值）
#pragma once
#include <string>
#include <unordered_map>
#include <cstdint>
#include "game/entity.h"
#include "game/world.h"
#include "util/json.h"
#include "../config.h"

namespace ew {

struct AntiCheatResult {
  bool accepted = true;     // 是否接受该输入（写入模拟）
  bool correction = false;  // 是否下发回退
  bool kick = false;        // 是否踢出
  std::string reason;       // 原因（用于日志/调试）
};

class AntiCheat {
public:
  explicit AntiCheat(const Config& cfg) : cfg_(cfg) {}

  // 处理一条 input 消息；上层根据结果决定是否应用输入/下发 correction/kick
  AntiCheatResult process(Entity& p, const Json& msg, uint64_t nowMs);
  void reset(Entity& p);
  // 测试模式：跳过全部校验（频率/序号/轨迹），输入直接接受（由 World::testFlags().antiCheatBypass 驱动）
  void setBypass(bool b) { bypass_ = b; }

private:
  struct RateBucket { double tokens; uint64_t lastMs; };
  struct Claim { double x, z; uint64_t ms; bool has = false; };

  bool checkRate(Entity& p, uint64_t nowMs);
  int checkSeq(Entity& p, int64_t seq);
  // 轨迹校验（随机采样时执行）
  bool validateClaim(Entity& p, double px, double py, double pz, uint64_t nowMs, std::string& why);
  void onViolation(Entity& p, AntiCheatResult& out, const std::string& reason);

  const Config& cfg_;
  bool bypass_ = false;   // 测试模式：跳过校验（默认关闭）
  std::unordered_map<std::string, RateBucket> buckets_;
  std::unordered_map<std::string, Claim> claims_;
};

} // namespace ew
