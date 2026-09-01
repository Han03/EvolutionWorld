// protocol.h - 大规模 MMO 数据传输方案：二进制帧协议 + 量化编码
//
// 设计要点（对标大型网络游戏）：
//  - 二进制帧：magic + 版本 + 类型 + flags + seq + 长度，替代 JSON 文本（省 ~4-6x 带宽）
//  - 量化坐标：0.01m 精度定长编码，替代 double/float
//  - 相对坐标：AOI 内实体位置以"接收玩家位置"为基准编码（int16，6 字节/位置）
//  - 增量更新：仅发送变化字段（mask 位图），配合更新率分级（LOD）
//  - 生命周期：ENTITY_ENTER / ENTITY_LEAVE 显式管理，替代每 tick 全量快照
//  - 校准快照：周期性 SNAPSHOT 全量重建（丢包/失步自愈）
//  - 单帧批量：每 tick 每个玩家合并所有消息为一个 TCP 段（避免小包风暴）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "game/entity.h"
#include "config.h"
namespace ew {
namespace proto {
// ---------- 帧头 ----------
constexpr uint8_t kMagic0 = 0x45; // 'E'
constexpr uint8_t kMagic1 = 0x57; // 'W'
constexpr uint8_t kVersion = 1;
constexpr size_t kHeaderSize = 9;

// ---------- 消息类型 ----------
enum MsgType : uint8_t {
  // C2S
  C2S_INPUT = 0x01,   // 移动输入 + 预测位置
  C2S_EVENT = 0x02,   // 通用事件（预留：聊天/技能/交互…）
  C2S_PONG  = 0x03,   // 心跳应答
  C2S_ATTACK= 0x04,   // 攻击世界实体（目标 wid + 技能槽）
  // S2C
  S2C_HELLO   = 0x81, // 握手（world 参数 + 自身完整状态）
  S2C_SNAPSHOT= 0x82, // 校准快照（周期全量，自愈）
  S2C_ENTER   = 0x83, // 实体进入视野
  S2C_LEAVE   = 0x84, // 实体离开视野
  S2C_UPDATE  = 0x85, // 实体增量状态
  S2C_SELF    = 0x86, // 自身权威位置（预测回退/校正）
  S2C_EVENT   = 0x87, // 通用事件（战斗事件：伤害/死亡/复活/技能）
  S2C_PING    = 0x88, // 心跳
  S2C_KICK    = 0x89, // 踢出
  S2C_ERROR   = 0x8A, // 错误
  S2C_BOSS    = 0x8B, // 世界 Boss 全局共享状态（血量/阶段/状态/目标/位置）
};
// ---------- 共享事件类型（S2C_EVENT payload 首字节） ----------
enum EvtType : uint8_t {
  EVT_DAMAGE  = 1,   // 伤害：wid 目标, b 伤害值(有符号), x 保留
  EVT_DEATH   = 2,   // 死亡：wid 死亡者, b 击杀者 wid
  EVT_RESPAWN = 3,   // 复活：wid 复活实体
  EVT_SKILL   = 4,   // 范围技能：wid 施法者, b skillId, x/z 技能落点
};
// ---------- Boss 状态位（S2C_BOSS.state，与 entity.h BossState 一致） ----------
constexpr uint8_t BOSS_IDLE = 0;
constexpr uint8_t BOSS_ENGAGE = 1;
constexpr uint8_t BOSS_DEAD = 2;

// ---------- flags ----------
enum Flags : uint8_t {
  FLAG_ACK = 0x01,     // 要求客户端回 PONG
  FLAG_ZIP = 0x02,     // 预留：负载压缩
};

// ---------- 实体 kind（线上编码） ----------
constexpr uint8_t KIND_PLAYER = 1;
constexpr uint8_t KIND_MONSTER = 2;
constexpr uint8_t KIND_NPC = 3;

// ---------- 实体状态位 ----------
constexpr uint8_t ST_MOVING  = 0x01;
constexpr uint8_t ST_GROUNDED = 0x02;

// ---------- 增量 mask ----------
constexpr uint8_t M_POS   = 0x01; // 位置变化
constexpr uint8_t M_VEL   = 0x02; // 速度变化
constexpr uint8_t M_STATE = 0x04; // 状态（moving/grounded）变化

// ---------- 量化常量 ----------
constexpr int kPosScale = 100;   // 位置 0.01m
constexpr int kVelScale = 100;   // 速度 0.01 m/s
constexpr int kMoveScale = 1000; // 移动输入 -1000..1000
constexpr int16_t kRelClamp = 32760; // int16 相对坐标钳制（±327.6m，覆盖 100m 视野）

// ---------- 帧 ----------
struct Frame {
  uint8_t type = 0;
  uint8_t flags = 0;
  uint16_t seq = 0;
  std::string payload;
};

// 二进制写入器（小端）
class Writer {
public:
  void u8(uint8_t v);
  void u16(uint16_t v);
  void u32(uint32_t v);
  void i16(int16_t v);
  void i32(int32_t v);
  void f32(float v);
  void raw(const void* p, size_t n);
  void str(const std::string& s); // u8 长度 + 字节
  const std::string& data() const { return buf_; }
  size_t size() const { return buf_.size(); }
private:
  std::string buf_;
};

// 二进制读取器（小端，越界安全）
class Reader {
public:
  explicit Reader(const std::string& data) : p_((const uint8_t*)data.data()), end_(p_ + data.size()) {}
  bool u8(uint8_t& v);
  bool u16(uint16_t& v);
  bool u32(uint32_t& v);
  bool i16(int16_t& v);
  bool i32(int32_t& v);
  bool f32(float& v);
  bool raw(void* out, size_t n);
  bool str(std::string& s);
  bool remaining(size_t n) const { return (size_t)(end_ - p_) >= n; }
  size_t left() const { return (size_t)(end_ - p_); }
private:
  const uint8_t* p_;
  const uint8_t* end_;
};

// ---------- 量化 ----------
inline int32_t qAbs(double v) { return (int32_t)std::lround(v * kPosScale); }
inline double dqAbs(int32_t q) { return (double)q / kPosScale; }
// 相对坐标（相对玩家位置），钳制到 int16 安全范围
inline int16_t qRel(double v, double ref) {
  int64_t q = (int64_t)std::lround((v - ref) * kPosScale);
  if (q > kRelClamp) q = kRelClamp;
  if (q < -kRelClamp) q = -kRelClamp;
  return (int16_t)q;
}
inline int16_t qVel(double v) {
  int64_t q = (int64_t)std::lround(v * kVelScale);
  if (q > 32760) q = 32760;
  if (q < -32760) q = -32760;
  return (int16_t)q;
}
inline int16_t qMove(double v) {
  int64_t q = (int64_t)std::lround(v * kMoveScale);
  if (q > 1000) q = 1000;
  if (q < -1000) q = -1000;
  return (int16_t)q;
}
// 实体状态位
inline uint8_t entityState(const Entity& e) {
  uint8_t s = 0;
  if (std::abs(e.vel.x) > 0.01 || std::abs(e.vel.z) > 0.01) s |= ST_MOVING;
  if (e.grounded) s |= ST_GROUNDED;
  return s;
}

// ---------- 帧编码 ----------
std::string frame(uint8_t type, const std::string& payload, uint8_t flags = 0, uint16_t seq = 0);
// 解析一帧（从 offset 处解析；不足返回 false 且不消费）
bool parseFrame(const std::string& data, size_t offset, size_t& consumed, Frame& f);

// ---------- S2C 编码 ----------
// 实体全量（相对 ref 编码；含 name 若 kind==Player）
void writeEntityFull(Writer& w, const Entity& e, const Vec3& ref);
std::string hello(const Config& cfg, const Entity& self);
std::string snapshot(uint32_t tick, const std::vector<const Entity*>& ents, const Vec3& ref);
std::string enter(const std::vector<const Entity*>& ents, const Vec3& ref);
std::string leave(const std::vector<uint32_t>& wids);
std::string update(const std::vector<uint32_t>& wids,
                   const std::vector<uint8_t>& masks,
                   const std::vector<const Entity*>& ents,
                   const Vec3& ref);
std::string selfCorrection(const std::string& reason, const Entity& p, uint32_t tick);
std::string ping(uint32_t ts);
std::string kick(const std::string& reason);
std::string error(uint8_t code, const std::string& msg);
// 世界共享状态（Boss 全区广播 + 战斗事件）
std::string bossState(const Entity& boss);
std::string eventFrame(uint8_t evtType, uint32_t wid, uint32_t b, int32_t x, int32_t z);

// ---------- C2S 解码 ----------
struct InputMsg {
  uint32_t seq = 0;
  double moveX = 0, moveZ = 0;
  bool jump = false;
  double px = 0, py = 0, pz = 0;
};
struct AttackMsg {
  uint32_t targetWid = 0;
  uint8_t slot = 0;   // 0=普攻，1..=技能（预留）
};
bool decodeInput(const std::string& payload, InputMsg& out);
bool decodeAttack(const std::string& payload, AttackMsg& out);
} // namespace proto
} // namespace ew
