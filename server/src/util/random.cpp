// random.cpp
#include "random.h"
#include <cstdio>
#include <cstring>

namespace ew {

bool randomBytes(unsigned char* buf, size_t len) {
  FILE* f = fopen("/dev/urandom", "rb");
  if (!f) return false;
  size_t got = fread(buf, 1, len, f);
  fclose(f);
  return got == len;
}

static const char* HEX = "0123456789abcdef";
std::string randomHex(size_t bytes) {
  unsigned char buf[64];
  if (bytes > sizeof(buf)) bytes = sizeof(buf);
  if (!randomBytes(buf, bytes)) {
    // 兜底：用时钟混入
    uint64_t t = (uint64_t)0; // placeholder
    for (size_t i = 0; i < bytes; i++) buf[i] = (unsigned char)((i * 37 + (unsigned)(t >> 8)) & 0xFF);
  }
  std::string out;
  out.reserve(bytes * 2);
  for (size_t i = 0; i < bytes; i++) {
    out += HEX[buf[i] >> 4];
    out += HEX[buf[i] & 0xF];
  }
  return out;
}

float Mulberry32::next() {
  a_ += 0x6d2b79f5u;
  uint32_t t = a_;
  t = (uint32_t)((uint64_t)(t ^ (t >> 15)) * (t | 1u));
  t ^= t + (uint32_t)((uint64_t)(t ^ (t >> 7)) * (t | 61u));
  return ((t ^ (t >> 14)) >> 0) / 4294967296.0f;
}

} // namespace ew
