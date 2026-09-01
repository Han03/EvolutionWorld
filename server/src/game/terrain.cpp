// terrain.cpp - 确定性噪声 + 高度场地形实现（与 JS terrain.js 逐位一致）
#include "terrain.h"
#include "../util/random.h"
#include <cmath>
#include <algorithm>

namespace ew {

// ---- 整数坐标哈希（Math.imul 语义：32 位有符号乘法溢出） ----
static inline uint32_t imul32(uint32_t a, uint32_t b) {
  // 用 64 位乘法取低 32 位
  return (uint32_t)((uint64_t)a * b);
}

double hash2i(int64_t x, int64_t z) {
  uint32_t hx = imul32((uint32_t)(x ^ 0x9e3779b9LL), 0x85ebca6b);
  uint32_t hz = imul32((uint32_t)(z ^ 0xc2b2ae3dLL), 0x27d4eb2f);
  uint32_t h = hx ^ hz;
  h = imul32(h ^ (h >> 16), 0x45d9f3b);
  h = imul32(h ^ (h >> 16), 0x45d9f3b);
  h = h ^ (h >> 16);
  return (double)h / 4294967296.0;
}

static inline double smoothStep(double t) { return t * t * (3 - 2 * t); }

double noise2(double x, double z) {
  double ix = std::floor(x);
  double iz = std::floor(z);
  double fx = x - ix;
  double fz = z - iz;
  double a = hash2i((int64_t)ix, (int64_t)iz);
  double b = hash2i((int64_t)ix + 1, (int64_t)iz);
  double c = hash2i((int64_t)ix, (int64_t)iz + 1);
  double d = hash2i((int64_t)ix + 1, (int64_t)iz + 1);
  double ux = smoothStep(fx);
  double uz = smoothStep(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

double fbm2(double x, double z, int octaves) {
  double amp = 0.5;
  double freq = 1.0;
  double sum = 0.0;
  double norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

double terrainHeight(double x, double z) {
  double base = fbm2(x * 0.006, z * 0.006, 5);
  double detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5;
  double h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  return std::max(-12.0, std::min(34.0, h));
}

void randomSpawn(Mulberry32& rng, double& x, double& y, double& z) {
  for (int attempt = 0; attempt < 32; attempt++) {
    double angle = rng.next() * 6.283185307179586;
    double r = std::sqrt(rng.next()) * 60.0;
    x = std::cos(angle) * r;
    z = std::sin(angle) * r;
    double h = terrainHeight(x, z);
    // 只选干地出生点（高于水面，留 1.0m 缓冲）
    if (h > kWaterLevel + 1.0) {
      y = h + 1.5;
      return;
    }
  }
  // 兜底：任意点
  double angle = rng.next() * 6.283185307179586;
  double r = std::sqrt(rng.next()) * 60.0;
  x = std::cos(angle) * r;
  z = std::sin(angle) * r;
  y = terrainHeight(x, z) + 1.5;
}

} // namespace ew
