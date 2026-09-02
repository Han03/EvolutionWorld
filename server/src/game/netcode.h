// netcode.h - 大规模 MMO 数据传输：每玩家兴趣集 + 增量/LOD + 校准快照
//
// 每 tick 为每个在线玩家生成一个二进制输出缓冲，包含：
//   - ENTER / LEAVE：视野内实体进出（AOI 生命周期）
//   - UPDATE：变化字段增量（mask 位图）+ 更新率分级（近高频/远低频）
//   - SNAPSHOT：周期校准全量（丢包/失步自愈）
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "game/entity.h"
#include "game/aoi.h"
#include "net/protocol.h"
#include "config.h"
namespace ew {
class World;
// 每个玩家上次发送给该玩家的实体状态（绝对量化，用于增量判定）
struct LastEnt {
  int32_t ax = 0, az = 0;   // 绝对位置量化（0.01m）
  int16_t ay = 0;
  int16_t avx = 0, avz = 0; // 绝对速度量化
  uint8_t state = 0;
  // AI 移动意图（M_INTENT 去重）
  uint8_t aiState = 0;
  int16_t itx = 0, itz = 0; // 目标速度量化
  uint8_t imult = 100;      // 速度倍率 0-100
  bool has = false;
};
struct PlayerView {
  std::unordered_set<uint32_t> seen;                 // 当前视野内 wid
  std::unordered_map<uint32_t, LastEnt> last;        // 上次发送状态
  uint64_t lastSnapTick = 0;                          // 上次校准快照 tick
  bool forceSnap = false;                             // 校正/异常后强制快照
};
class Netcode {
public:
  Netcode(World& w, const Config& cfg) : w_(w), cfg_(cfg) {}
  // 玩家接入 → HELLO 帧
  std::string helloFor(const Entity& player);
  // 玩家断线清理
  void resetPlayer(const std::string& playerId);
  // 每 tick：构建所有在线玩家的待发缓冲
  const std::unordered_map<std::string, std::string>& tickBroadcast();
  // 校正触发强制校准快照（预测回退后重锚定全部可见实体）
  void requestResync(const std::string& playerId);
  // 通用静态帧构造
  static std::string correctionFrame(const Entity& p, const std::string& reason, uint32_t tick) {
    return proto::selfCorrection(reason, p, tick);
  }
private:
  World& w_;
  const Config& cfg_;
  std::unordered_map<std::string, PlayerView> views_;
  std::unordered_map<std::string, std::string> out_;
};
} // namespace ew
