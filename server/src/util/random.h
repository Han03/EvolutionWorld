// random.h
#pragma once
#include <string>
#include <cstdint>

namespace ew {
// 从 /dev/urandom 读取随机字节
bool randomBytes(unsigned char* buf, size_t len);
std::string randomHex(size_t bytes);
// 简易确定性 RNG（mulberry32，供出生点等使用）
class Mulberry32 {
public:
  explicit Mulberry32(uint32_t seed) : a_(seed) {}
  float next(); // [0,1)
private:
  uint32_t a_;
};
}
