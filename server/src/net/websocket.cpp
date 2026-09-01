// websocket.cpp - RFC6455 实现
#include "websocket.h"
#include "util/base64.h"
#include <openssl/sha.h>
#include <cstring>
#include <stdexcept>

namespace ew {

static const char* WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

std::string wsAcceptKey(const std::string& key) {
  std::string in = key + WS_GUID;
  unsigned char digest[SHA_DIGEST_LENGTH];
  SHA1((const unsigned char*)in.data(), in.size(), digest);
  return base64Encode(digest, SHA_DIGEST_LENGTH);
}

bool wsDecodeFrame(const std::string& in, size_t& consumed, bool& fin, int& opcode, std::string& payload) {
  consumed = 0;
  if (in.size() < 2) return false;
  unsigned char b0 = (unsigned char)in[0];
  unsigned char b1 = (unsigned char)in[1];
  fin = (b0 & 0x80) != 0;
  opcode = b0 & 0x0F;
  bool masked = (b1 & 0x80) != 0;
  uint64_t len = b1 & 0x7F;
  size_t idx = 2;
  if (len == 126) {
    if (in.size() < 4) return false;
    len = ((unsigned char)in[2] << 8) | (unsigned char)in[3];
    idx = 4;
  } else if (len == 127) {
    if (in.size() < 10) return false;
    len = 0;
    for (int i = 0; i < 8; i++) len = (len << 8) | (unsigned char)in[2 + i];
    idx = 10;
  }
  // 客户端帧必须掩码
  if (masked && in.size() < idx + 4) return false;
  if (in.size() < idx + (masked ? 4 : 0) + len) return false; // 载荷未完整

  size_t payloadStart = idx + (masked ? 4 : 0);
  payload.assign(in, payloadStart, (size_t)len);
  if (masked) {
    const unsigned char* mask = (const unsigned char*)in.data() + idx;
    for (size_t i = 0; i < payload.size(); i++) payload[i] ^= mask[i & 3];
  }
  consumed = payloadStart + (size_t)len;
  return true;
}

std::string wsEncodeFrame(int opcode, const std::string& payload, bool fin) {
  std::string out;
  unsigned char b0 = (unsigned char)opcode;
  if (fin) b0 |= 0x80;
  out += (char)b0;
  size_t len = payload.size();
  if (len < 126) {
    out += (char)(0x80 | len); // 服务端不掩码，但按协议服务器帧 mask 位为 0；此处统一置 0
    out.back() = (char)len;
  } else if (len <= 0xFFFF) {
    out += (char)126;
    out += (char)((len >> 8) & 0xFF);
    out += (char)(len & 0xFF);
  } else {
    out += (char)127;
    for (int i = 7; i >= 0; i--) out += (char)((len >> (i * 8)) & 0xFF);
  }
  out += payload;
  return out;
}

} // namespace ew
