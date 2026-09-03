// terrain.cpp - 确定性噪声 + 高度场地形实现（与 JS terrain.js 逐位一致）
// 地形要素：
//  1) 基础丘陵高度场（原 fbm）
//  2) 河流下切：两条蜿蜒主河（东西向 + 南北向），河床压到水面以下 → 形成河流/湖泊
//  3) 山脊抬升：ridged noise 生成陡峭山脊 → 悬崖（局部坡度 > 阈值即不可通行）
//  4) 路径地图空洞：可到达区域收缩为「主干道走廊 + 分支 + 随机空地」，其余为空洞
//  5) 地形编辑器编辑层：稀疏格子覆盖（绝对高度 h / 可通行性 v），优先于程序化
#include "terrain.h"
#include "../util/random.h"
#include "../util/json.h"
#include <cmath>
#include <algorithm>
#include <vector>
#include <unordered_map>
#include <cstdio>
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
// 平滑阶跃（与 JS sstep 一致）：0→1 平滑过渡
static inline double sstep(double t, double a, double b) {
  if (t <= a) return 0.0;
  if (t >= b) return 1.0;
  double x = (t - a) / (b - a);
  return x * x * (3 - 2 * x);
}
// 平滑阶跃（与 JS sstep 一致）：0→1 平滑过渡
static inline double sstep01(double t) {
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  return t * t * (3 - 2 * t);
}
// 中央高原抬升（城镇/安全区/出生点）：中心半径 ~24m，最高 +16，平滑衰减。
// 保证世界中心为干地高地（新手出生与商店所在），四周为湖泊/河流。
double centralPlateau(double x, double z) {
  double d = std::hypot(x, z);
  double u = d / 24.0;
  if (u >= 1.0) return 0.0;
  return 16.0 * (1.0 - sstep01(u));
}
// 河流通道值 [0,1]：两条蜿蜒主河（东西向沿 z≈-28、南北向沿 x≈32），取较大者
double riverBand(double x, double z) {
  // 东西向河：中心 z 随 x 蜿蜒（地图南部）
  double zc = -28.0 + 60.0 * (fbm2(x * 0.0025 + 13.7, 0.0, 3) - 0.5);
  double b1 = 1.0 - std::abs(z - zc) / kRiverHalfWidth;
  // 南北向河：中心 x 随 z 蜿蜒（地图东部）
  double xc = 32.0 + 55.0 * (fbm2(0.0, z * 0.0025 + 7.9, 3) - 0.5);
  double b2 = 1.0 - std::abs(x - xc) / kRiverHalfWidth;
  return std::max(0.0, std::max(b1, b2));
}
// ==================== 可通行 mask（数据驱动：世界初始化执行器生成 / 数据库加载） ====================
// 可到达区域 = 主城 + 主干道路网（BFS 裁剪保证全图连通），每格 1=可通行 / 0=空洞。
// 代码不再程序化生成布局：mask 由 WorldInitializer 生成后 terrainSetWalkMask 安装，或从数据库加载。
static std::vector<uint8_t> g_walk;   // 1=可通行（数据驱动）
static int g_walkN = 0;               // mask 边长（格）
static int g_walkOff = 0;             // mask 原点偏移（世界坐标 -off 起）
static bool g_walkReady = false;      // mask 是否已安装且尺寸自洽
void terrainSetWalkMask(std::vector<uint8_t> mask, int n, int off) {
  g_walkReady = (n > 0 && mask.size() == (size_t)n * (size_t)n);
  g_walkN = n;
  g_walkOff = off;
  g_walk = std::move(mask);
}
bool terrainWalkMaskReady() { return g_walkReady; }
int  terrainWalkMaskN() { return g_walkN; }
int  terrainWalkMaskOff() { return g_walkOff; }
const std::vector<uint8_t>& terrainWalkMask() { return g_walk; }
// 自然地形阻挡：仅深水 / 悬崖（不含空洞 mask）。世界初始化生长可通行区域时判定“天然干地”。
bool terrainNaturalBlocked(double x, double z) {
  if (terrainHeight(x, z) < kWaterLevel) return true;   // 深水（湖泊/河流床）
  if (terrainSlope(x, z) > kCliffSlope) return true;     // 悬崖/陡坡
  return false;
}
bool terrainVoid(double x, double z) {
  if (!g_walkReady) return true;  // mask 未就绪：一律视为空洞（阻挡），等待世界初始化/加载
  int gx = (int)std::floor(x) + g_walkOff;
  int gz = (int)std::floor(z) + g_walkOff;
  if (gx < 0 || gx >= g_walkN || gz < 0 || gz >= g_walkN) return true; // 超出 mask 范围视为空洞
  return g_walk[(size_t)gz * g_walkN + (size_t)gx] == 0;
}

// ==================== 地形编辑器编辑层（稀疏格子覆盖） ====================
// key：((uint32)x << 32) | (uint32)z（唯一映射；与 JS "x,z" 字符串键通过序列化对齐）
static std::unordered_map<int64_t, EditCell> g_edit;
static inline int64_t editKey(int64_t x, int64_t z) {
  return (int64_t)(((uint64_t)(uint32_t)x << 32) | (uint32_t)z);
}
void terrainSetEdit(int64_t x, int64_t z, const EditCell& c) {
  if (!c.hasH && !c.hasV) { g_edit.erase(editKey(x, z)); return; }
  g_edit[editKey(x, z)] = c;
}
void terrainClearEdit() { g_edit.clear(); }
size_t terrainEditSize() { return g_edit.size(); }
const std::unordered_map<int64_t, EditCell>& terrainEdits() { return g_edit; }
std::string terrainEditToJson() {
  Json cells = Json::object();
  for (const auto& [k, c] : g_edit) {
    int64_t x = (int32_t)(k >> 32);          // 还原 x
    int64_t z = (int32_t)(k & 0xFFFFFFFFLL); // 还原 z
    char key[64];
    snprintf(key, sizeof(key), "%lld,%lld", (long long)x, (long long)z);
    Json j = Json::object();
    if (c.hasH) j["h"] = c.h;
    if (c.hasV) j["v"] = (int64_t)c.v;
    cells[key] = j;
  }
  Json root = Json::object();
  root["cells"] = cells;
  return root.dump();
}
bool terrainEditFromJson(const std::string& json) {
  try {
    Json root = Json::parse(json);
    Json cells = root["cells"];
    if (cells.type() != Json::Type::Object) return false;
    std::unordered_map<int64_t, EditCell> next;
    for (const auto& [key, val] : cells.asObject()) {
      // key = "x,z"
      size_t comma = key.find(',');
      if (comma == std::string::npos) continue;
      int64_t x = std::atoll(key.substr(0, comma).c_str());
      int64_t z = std::atoll(key.substr(comma + 1).c_str());
      EditCell c;
      if (val.has("h")) { c.hasH = true; c.h = val.at("h").asNumber(); }
      if (val.has("v")) { c.hasV = true; c.v = (int8_t)val.at("v").asInt(); }
      if (c.hasH || c.hasV) next[editKey(x, z)] = c;
    }
    g_edit = std::move(next);
    return true;
  } catch (...) {
    return false;
  }
}

double terrainHeight(double x, double z) {
  // 编辑器编辑层优先：绝对高度覆盖
  {
    auto it = g_edit.find(editKey((int64_t)std::floor(x), (int64_t)std::floor(z)));
    if (it != g_edit.end() && it->second.hasH) return it->second.h;
  }
  double base = fbm2(x * 0.006, z * 0.006, 5);
  double detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5;
  double h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  // 山脊抬升：山脉区域 + 山脊噪声 → 陡峭山脊（悬崖）
  double mountain = sstep(fbm2(x * 0.004 + 31.7, z * 0.004 + 8.2, 3), 0.58, 0.78);
  double ridged = 1.0 - std::abs(2.0 * fbm2(x * 0.012 + 5.1, z * 0.012 + 9.3, 4) - 1.0);
  h += mountain * ridged * 26.0;
  // 中央高原抬升（城镇/安全区干地）
  h += centralPlateau(x, z);
  // 河流下切：河床压到水面以下 → 形成河流/湖泊（水不可通行）
  double rv = riverBand(x, z);
  if (rv > 0.0) h = std::min(h, kWaterLevel - 2.5 * rv);
  return std::max(-12.0, std::min(34.0, h));
}
double terrainSlope(double x, double z) {
  double e = kSlopeSample;
  double hx = terrainHeight(x + e, z);
  double hxm = terrainHeight(x - e, z);
  double hz = terrainHeight(x, z + e);
  double hzm = terrainHeight(x, z - e);
  double sx = std::abs(hx - hxm) / (2.0 * e);
  double sz = std::abs(hz - hzm) / (2.0 * e);
  return std::max(sx, sz);
}
bool terrainBlocked(double x, double z) {
  // 编辑器编辑层优先：可通行性覆盖
  {
    auto it = g_edit.find(editKey((int64_t)std::floor(x), (int64_t)std::floor(z)));
    if (it != g_edit.end() && it->second.hasV) return it->second.v == 1;
  }
  // 路径地图空洞：可到达区域外的白色空洞（不可通行、不渲染）
  if (terrainVoid(x, z)) return true;
  // 深水（湖泊/河流床）：水面以下不可通行
  if (terrainHeight(x, z) < kWaterLevel) return true;
  // 悬崖/陡坡：局部坡度超过阈值不可通行
  if (terrainSlope(x, z) > kCliffSlope) return true;
  return false;
}
void randomSpawn(Mulberry32& rng, double& x, double& y, double& z,
                 double minR, double maxR) {
  const double range = maxR - minR;
  for (int attempt = 0; attempt < 64; attempt++) {
    double angle = rng.next() * 6.283185307179586;
    double r = minR + std::sqrt(rng.next()) * range;
    x = std::cos(angle) * r;
    z = std::sin(angle) * r;
    double h = terrainHeight(x, z);
    // 只选可通行的干地（非水、非悬崖，留缓冲）
    if (!terrainBlocked(x, z) && h > kWaterLevel + 1.0) {
      y = h + 1.5;
      return;
    }
  }
  // 兜底：范围内任意点
  double angle = rng.next() * 6.283185307179586;
  double r = minR + std::sqrt(rng.next()) * range;
  x = std::cos(angle) * r;
  z = std::sin(angle) * r;
  y = terrainHeight(x, z) + 1.5;
}
// 城镇出生点：主城圆盘内（开放空地，玩家出生/复活安全区）
void townSpawn(Mulberry32& rng, double& x, double& y, double& z) {
  for (int attempt = 0; attempt < 64; attempt++) {
    double angle = rng.next() * 6.283185307179586;
    double r = std::sqrt(rng.next()) * kTownSpawnRadius;
    x = std::cos(angle) * r;
    z = std::sin(angle) * r;
    double h = terrainHeight(x, z);
    if (!terrainBlocked(x, z) && h > kWaterLevel + 1.0) {
      y = h + 1.5;
      return;
    }
  }
  // 兜底：城镇中心
  x = 0; z = 0;
  y = terrainHeight(0, 0) + 1.5;
}
} // namespace ew
