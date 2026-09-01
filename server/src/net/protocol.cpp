// protocol.cpp - 二进制协议编解码实现
#include "protocol.h"
#include "config.h"
#include <cstring>
#include <cmath>
namespace ew {
namespace proto {
// ---------- Writer ----------
void Writer::u8(uint8_t v) { buf_.push_back((char)v); }
void Writer::u16(uint16_t v) {
  buf_.push_back((char)(v & 0xFF));
  buf_.push_back((char)((v >> 8) & 0xFF));
}
void Writer::u32(uint32_t v) {
  for (int i = 0; i < 4; i++) buf_.push_back((char)((v >> (8 * i)) & 0xFF));
}
void Writer::i16(int16_t v) { u16((uint16_t)v); }
void Writer::i32(int32_t v) { u32((uint32_t)v); }
void Writer::f32(float v) {
  uint32_t bits;
  memcpy(&bits, &v, 4);
  u32(bits);
}
void Writer::raw(const void* p, size_t n) {
  buf_.append((const char*)p, n);
}
void Writer::str(const std::string& s) {
  u8((uint8_t)(s.size() & 0xFF));
  raw(s.data(), s.size());
}
// ---------- Reader ----------
bool Reader::u8(uint8_t& v) {
  if (!remaining(1)) return false;
  v = (uint8_t)*p_++;
  return true;
}
bool Reader::u16(uint16_t& v) {
  if (!remaining(2)) return false;
  v = (uint16_t)p_[0] | ((uint16_t)p_[1] << 8);
  p_ += 2;
  return true;
}
bool Reader::u32(uint32_t& v) {
  if (!remaining(4)) return false;
  v = 0;
  for (int i = 0; i < 4; i++) v |= ((uint32_t)p_[i]) << (8 * i);
  p_ += 4;
  return true;
}
bool Reader::i16(int16_t& v) {
  uint16_t u;
  if (!u16(u)) return false;
  v = (int16_t)u;
  return true;
}
bool Reader::i32(int32_t& v) {
  uint32_t u;
  if (!u32(u)) return false;
  v = (int32_t)u;
  return true;
}
bool Reader::f32(float& v) {
  uint32_t u;
  if (!u32(u)) return false;
  memcpy(&v, &u, 4);
  return true;
}
bool Reader::raw(void* out, size_t n) {
  if (!remaining(n)) return false;
  memcpy(out, p_, n);
  p_ += n;
  return true;
}
bool Reader::str(std::string& s) {
  uint8_t len;
  if (!u8(len)) return false;
  if (!remaining(len)) return false;
  s.assign((const char*)p_, len);
  p_ += len;
  return true;
}
// ---------- 帧 ----------
std::string frame(uint8_t type, const std::string& payload, uint8_t flags, uint16_t seq) {
  std::string f;
  f.reserve(kHeaderSize + payload.size());
  f.push_back((char)kMagic0);
  f.push_back((char)kMagic1);
  f.push_back((char)kVersion);
  f.push_back((char)type);
  f.push_back((char)flags);
  f.push_back((char)(seq & 0xFF));
  f.push_back((char)((seq >> 8) & 0xFF));
  size_t len = payload.size();
  f.push_back((char)(len & 0xFF));
  f.push_back((char)((len >> 8) & 0xFF));
  f.append(payload);
  return f;
}
bool parseFrame(const std::string& data, size_t offset, size_t& consumed, Frame& f) {
  if (data.size() - offset < kHeaderSize) return false;
  const uint8_t* d = (const uint8_t*)data.data() + offset;
  if (d[0] != kMagic0 || d[1] != kMagic1) return false;
  f.type = d[3];
  f.flags = d[4];
  f.seq = (uint16_t)d[5] | ((uint16_t)d[6] << 8);
  size_t len = (size_t)d[7] | ((size_t)d[8] << 8);
  if (data.size() - offset < kHeaderSize + len) return false;
  f.payload.assign((const char*)d + kHeaderSize, len);
  consumed = offset + kHeaderSize + len;
  return true;
}
// ---------- 实体全量 ----------
void writeEntityFull(Writer& w, const Entity& e, const Vec3& ref) {
  w.u32((uint32_t)e.wid);
  switch (e.kind) {
    case EntityKind::Player: w.u8(KIND_PLAYER); break;
    case EntityKind::Monster: w.u8(KIND_MONSTER); break;
    default: w.u8(KIND_NPC); break;
  }
  w.u8(entityState(e));
  w.i16(qRel(e.pos.x, ref.x));
  w.i16(qRel(e.pos.y, ref.y));
  w.i16(qRel(e.pos.z, ref.z));
  w.i16(qVel(e.vel.x));
  w.i16(qVel(e.vel.z));
  if (e.kind == EntityKind::Player) w.str(e.username);
  else w.str(e.kind == EntityKind::Monster ? "Monster" : "NPC");
}
static std::string entityListToPayload(const std::vector<const Entity*>& ents, const Vec3& ref) {
  Writer w;
  w.u16((uint16_t)ents.size());
  for (const Entity* e : ents) writeEntityFull(w, *e, ref);
  return w.data();
}
std::string hello(const Config& cfg, const Entity& self) {
  Writer w;
  w.i32(cfg.worldSeed);
  w.f32(cfg.viewRangeM);
  w.f32(cfg.chunkSizeM);
  w.f32(cfg.tickRateHz);
  // 自身绝对位置（客户端初始化预测器必需；其余字段用相对自身 = (0,0,0) 编码）
  w.i32(qAbs(self.pos.x));
  w.i16(qAbs(self.pos.y));
  w.i32(qAbs(self.pos.z));
  writeEntityFull(w, self, self.pos);
  return frame(S2C_HELLO, w.data());
}
std::string snapshot(uint32_t tick, const std::vector<const Entity*>& ents, const Vec3& ref) {
  Writer w;
  w.u32(tick);
  w.u16((uint16_t)ents.size());
  for (const Entity* e : ents) writeEntityFull(w, *e, ref);
  return frame(S2C_SNAPSHOT, w.data());
}
std::string enter(const std::vector<const Entity*>& ents, const Vec3& ref) {
  return frame(S2C_ENTER, entityListToPayload(ents, ref));
}
std::string leave(const std::vector<uint32_t>& wids) {
  Writer w;
  w.u16((uint16_t)wids.size());
  for (uint32_t id : wids) w.u32(id);
  return frame(S2C_LEAVE, w.data());
}
std::string update(const std::vector<uint32_t>& wids,
                   const std::vector<uint8_t>& masks,
                   const std::vector<const Entity*>& ents,
                   const Vec3& ref) {
  Writer w;
  w.u16((uint16_t)wids.size());
  for (size_t i = 0; i < wids.size(); i++) {
    w.u32(wids[i]);
    w.u8(masks[i]);
    const Entity& e = *ents[i];
    if (masks[i] & M_POS) {
      w.i16(qRel(e.pos.x, ref.x));
      w.i16(qRel(e.pos.y, ref.y));
      w.i16(qRel(e.pos.z, ref.z));
    }
    if (masks[i] & M_VEL) {
      w.i16(qVel(e.vel.x));
      w.i16(qVel(e.vel.z));
    }
    if (masks[i] & M_STATE) w.u8(entityState(e));
  }
  return frame(S2C_UPDATE, w.data());
}
std::string selfCorrection(const std::string& reason, const Entity& p, uint32_t tick) {
  Writer w;
  w.str(reason);
  w.i32(qAbs(p.pos.x));
  w.i16(qAbs(p.pos.y));
  w.i32(qAbs(p.pos.z));
  w.u32(tick);
  return frame(S2C_SELF, w.data());
}
std::string ping(uint32_t ts) {
  Writer w;
  w.u32(ts);
  return frame(S2C_PING, w.data(), FLAG_ACK);
}
std::string kick(const std::string& reason) {
  Writer w;
  w.str(reason);
  return frame(S2C_KICK, w.data());
}
std::string error(uint8_t code, const std::string& msg) {
  Writer w;
  w.u8(code);
  w.str(msg);
  return frame(S2C_ERROR, w.data());
}
// ---------- C2S 解码 ----------
bool decodeInput(const std::string& payload, InputMsg& out) {
  Reader r(payload);
  uint32_t seq;
  int16_t mx, mz;
  uint8_t jump;
  int32_t px, pz;
  int16_t py;
  if (!r.u32(seq) || !r.i16(mx) || !r.i16(mz) || !r.u8(jump) ||
      !r.i32(px) || !r.i16(py) || !r.i32(pz)) return false;
  out.seq = seq;
  out.moveX = (double)mx / kMoveScale;
  out.moveZ = (double)mz / kMoveScale;
  out.jump = jump != 0;
  out.px = dqAbs(px);
  out.py = dqAbs(py);
  out.pz = dqAbs(pz);
  return true;
}
} // namespace proto
} // namespace ew
