// worldinit.cpp - 世界初始化执行器实现（数据驱动、稳定安全、可连通）
//
// 生成流程（对应需求，全部由 config 参数驱动，代码不含任何硬编码坐标/布局）：
//   1) 生长可通行区域：主城圆盘 + N 条主干道随机游走（偏好天然干地）+ 分支 + 沿途空地；
//      仅把「天然干地」（非深水/非悬崖）标记为候选可通行 → 生物投放不会落入水中/悬崖。
//   2) BFS 可达性裁剪：从主城中心 8 连通洪泛，未被到达的候选格清空 → 保证全图连通、无孤岛。
//   3) 安装 mask 到 terrain（terrainVoid/terrainBlocked 数据源），并采集可通行格用于投放。
//   4) 生物投放：
//        - NPC：主城内环形均匀分布，首位=商店老板；
//        - 怪物：按距主城距离分档，档内怪物类型按等级升序（近弱远强）；每群同种、群内散布；
//                主城免怪半径内不投放；群锚点保持最小间距避免扎堆；
//        - Boss：远境均匀分布，取最强怪物类型。
#include "worldinit.h"
#include "world.h"
#include "terrain.h"
#include "items.h"
#include "../config.h"
#include "../util/random.h"
#include "../util/base64.h"
#include "../util/json.h"
#include <cmath>
#include <cstdio>
#include <vector>
#include <queue>
#include <algorithm>

namespace ew {

using Json = ew::Json;

// mask 网格：覆盖世界 [-128,128)，每格 1 米（与 terrainVoid 的 floor(x)+off 索引一致）
static const int kMaskN = 256;
static const int kMaskOff = 128;
static const double kTwoPi = 6.283185307179586;

// 可通行格（含到主城中心的距离，供分档投放用）
struct Cell { int gx = 0, gz = 0; double d = 0.0; };

static inline double cellX(int gx) { return (double)(gx - kMaskOff) + 0.5; }
static inline double cellZ(int gz) { return (double)(gz - kMaskOff) + 0.5; }
static inline int toCellX(double x) { return (int)std::floor(x) + kMaskOff; }
static inline int toCellZ(double z) { return (int)std::floor(z) + kMaskOff; }

// 在可通行格集合中找最接近 (tx,tz) 且到中心距离落在 [minD,maxD] 的格；找不到返回 -1
static int nearestCell(const std::vector<Cell>& walk, double tx, double tz,
                       double minD, double maxD) {
  int best = -1;
  double bd = 1e18;
  for (size_t i = 0; i < walk.size(); i++) {
    const Cell& c = walk[i];
    if (c.d < minD || c.d > maxD) continue;
    double dd = std::hypot(cellX(c.gx) - tx, cellZ(c.gz) - tz);
    if (dd < bd) { bd = dd; best = (int)i; }
  }
  return best;
}

bool generateWorld(World& w, const Config& cfg) {
  const int N = kMaskN, OFF = kMaskOff;
  const size_t NN = (size_t)N * N;
  std::vector<uint8_t> grown(NN, 0);   // 候选可通行（天然干地 + 生长标记）
  Mulberry32 rng((uint32_t)cfg.worldSeed ^ 0x5eed1u);

  auto naturalOk = [&](int gx, int gz) -> bool {
    if (gx < 0 || gx >= N || gz < 0 || gz >= N) return false;
    return !terrainNaturalBlocked(cellX(gx), cellZ(gz));
  };
  // 标记一个圆盘为候选可通行（仅天然干地格）
  auto markDisc = [&](double cx, double cz, double r) {
    int x0 = std::max(0, (int)std::floor(cx - r) + OFF);
    int x1 = std::min(N - 1, (int)std::floor(cx + r) + OFF);
    int z0 = std::max(0, (int)std::floor(cz - r) + OFF);
    int z1 = std::min(N - 1, (int)std::floor(cz + r) + OFF);
    double r2 = r * r;
    for (int gz = z0; gz <= z1; gz++) {
      for (int gx = x0; gx <= x1; gx++) {
        double dx = cellX(gx) - cx, dz = cellZ(gz) - cz;
        if (dx * dx + dz * dz <= r2 && naturalOk(gx, gz)) grown[(size_t)gz * N + gx] = 1;
      }
    }
  };

  // ---- 1) 主城圆盘（出生/商店安全区，中心高原为天然干地）----
  const double cityR = cfg.worldCityRadius > 1.0 ? cfg.worldCityRadius : 11.0;
  markDisc(0.0, 0.0, cityR);

  // ---- 2) 主干道路网：从主城向外随机游走（偏好天然干地），带分支与沿途空地 ----
  const int ROADS = cfg.worldRoads > 0 ? cfg.worldRoads : 8;
  const int STEPS = cfg.worldRoadSteps > 0 ? cfg.worldRoadSteps : 55;
  const double roadW = cfg.worldRoadWidth > 0.5 ? cfg.worldRoadWidth : 2.6;
  const double stepLen = 2.0;
  for (int i = 0; i < ROADS; i++) {
    double baseAng = i * (kTwoPi / ROADS) + (rng.next() - 0.5) * 0.4;
    double px = 0.0, pz = 0.0, dir = baseAng;
    for (int s = 0; s < STEPS; s++) {
      // 方向选择：在当前方向附近采样候选，优先能落在天然干地的方向（避开深水/悬崖）
      bool found = false;
      double bestDir = dir;
      for (int t = 0; t < 6 && !found; t++) {
        double cand = dir + (rng.next() - 0.5) * 1.4;
        double nx = px + std::cos(cand) * stepLen, nz = pz + std::sin(cand) * stepLen;
        if (naturalOk(toCellX(nx), toCellZ(nz))) { bestDir = cand; found = true; }
      }
      dir = found ? bestDir : dir + (rng.next() - 0.5) * 0.9;
      // 轻微拉回主方向，防止过度漂移出世界边界
      double da = baseAng - dir;
      while (da > M_PI) da -= kTwoPi;
      while (da < -M_PI) da += kTwoPi;
      dir += da * 0.08;
      px += std::cos(dir) * stepLen;
      pz += std::sin(dir) * stepLen;
      markDisc(px, pz, roadW);
      // 分支：每 6 步分叉一条短支路（增加可达区域与投放空间）
      if (s % 6 == 3) {
        double bdir = dir + (rng.next() - 0.5) * 2.2, bx = px, bz = pz;
        for (int bs = 0; bs < 14; bs++) {
          bdir += (rng.next() - 0.5) * 0.7;
          bx += std::cos(bdir) * 1.8;
          bz += std::sin(bdir) * 1.8;
          markDisc(bx, bz, 2.2);
        }
      }
      // 沿途空地：开阔区，供怪物成群投放
      if (s % 9 == 5) {
        double ox = px + (rng.next() - 0.5) * 12.0;
        double oz = pz + (rng.next() - 0.5) * 12.0;
        markDisc(ox, oz, 4.0 + rng.next() * 4.5);
      }
    }
  }

  // ---- 3) BFS 可达性裁剪：从主城中心 8 连通洪泛，未达格清空 → 保证全图连通、无孤岛 ----
  std::vector<uint8_t> mask(NN, 0);
  int cgx = toCellX(0.0), cgz = toCellZ(0.0);
  if (cgx >= 0 && cgx < N && cgz >= 0 && cgz < N && grown[(size_t)cgz * N + cgx]) {
    static const int dx8[8] = { 1, -1, 0, 0, 1, 1, -1, -1 };
    static const int dz8[8] = { 0, 0, 1, -1, 1, -1, 1, -1 };
    std::vector<char> vis(NN, 0);
    std::queue<int> q;
    int start = cgz * N + cgx;
    vis[start] = 1;
    q.push(start);
    while (!q.empty()) {
      int idx = q.front(); q.pop();
      int gz = idx / N, gx = idx % N;
      mask[idx] = 1;
      for (int k = 0; k < 8; k++) {
        int nx = gx + dx8[k], nz = gz + dz8[k];
        if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
        int ni = nz * N + nx;
        if (!vis[ni] && grown[ni]) { vis[ni] = 1; q.push(ni); }
      }
    }
  }
  // 安装可通行 mask（terrainVoid/terrainBlocked 数据源；客户端通过 /api/terrain/mask 同步）
  terrainSetWalkMask(mask, N, OFF);

  // 采集可通行格（含到中心距离），供生物投放选取锚点
  std::vector<Cell> walk;
  walk.reserve(4096);
  for (int gz = 0; gz < N; gz++) {
    for (int gx = 0; gx < N; gx++) {
      if (mask[(size_t)gz * N + gx]) {
        Cell c; c.gx = gx; c.gz = gz;
        c.d = std::hypot(cellX(gx), cellZ(gz));
        walk.push_back(c);
      }
    }
  }

  // ---- 4) 生物投放（数据驱动：全部锚点取自 mask 可通行格 → 不进空洞）----
  std::vector<SpawnPoint> list;

  // 4a) 城镇 NPC：主城内环形均匀分布，首位=商店老板（中心）
  int nNpc = cfg.npcCount > 0 ? cfg.npcCount : 12;
  for (int i = 0; i < nNpc; i++) {
    double ang = (double)i / (double)nNpc * kTwoPi;
    double rr = (i == 0) ? 0.0 : cityR * 0.55;   // 商店老板居中，其余环城
    double tx = std::cos(ang) * rr, tz = std::sin(ang) * rr;
    int idx = nearestCell(walk, tx, tz, 0.0, cityR + 1.0);
    if (idx < 0) continue;
    SpawnPoint sp;
    sp.kind = SP_NPC;
    sp.x = cellX(walk[idx].gx);
    sp.z = cellZ(walk[idx].gz);
    if (i == 0) { sp.shopId = 1; sp.name = "商店老板·全能杂货铺"; }
    list.push_back(sp);
  }

  // 4b) 怪物：按距离分档（近弱远强），相同怪物成群，主城免怪半径内不投放
  //     怪物类型按等级升序排列（取自 GameData，不硬编码类型名）
  std::vector<std::pair<int, std::string>> typesByLevel;
  for (const auto& kv : w.data().monsters()) typesByLevel.push_back({ kv.second.level, kv.first });
  std::sort(typesByLevel.begin(), typesByLevel.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
  const double freeR = cfg.worldMonsterFreeRadius > 0 ? cfg.worldMonsterFreeRadius : 28.0;
  const double maxR = cfg.worldMonsterMaxRadius > freeR ? cfg.worldMonsterMaxRadius : 112.0;
  const int T = (int)typesByLevel.size();
  if (T > 0 && !walk.empty()) {
    int groups = cfg.worldMonsterGroups > 0 ? cfg.worldMonsterGroups : 22;
    int gMin = cfg.worldMonsterGroupMin > 0 ? cfg.worldMonsterGroupMin : 3;
    int gMax = cfg.worldMonsterGroupMax >= gMin ? cfg.worldMonsterGroupMax : gMin;
    double spacing = cfg.worldMonsterGroupSpacing > 0 ? cfg.worldMonsterGroupSpacing : 14.0;
    std::vector<std::pair<double, double>> anchors;   // 已放置群锚点（保证间距）
    for (int g = 0; g < groups; g++) {
      int band = (int)((long long)g * T / groups);    // 0..T-1：近档→远档
      if (band >= T) band = T - 1;
      double b0 = freeR + (maxR - freeR) * band / T;
      double b1 = freeR + (maxR - freeR) * (band + 1) / T;
      const std::string& type = typesByLevel[band].second;
      // 在档内随机找一个满足间距的可通行格
      int pick = -1;
      for (int attempt = 0; attempt < 96; attempt++) {
        int ci = (int)(rng.next() * (float)walk.size());
        if (ci < 0 || ci >= (int)walk.size()) continue;
        const Cell& c = walk[ci];
        if (c.d < b0 || c.d > b1) continue;
        double minSep = 1e18;
        for (const auto& a : anchors)
          minSep = std::min(minSep, std::hypot(cellX(c.gx) - a.first, cellZ(c.gz) - a.second));
        if (minSep < spacing) continue;   // 与已有群太近，重试
        pick = ci; break;
      }
      // 放宽：忽略间距，只要落在档内即可（保证投放数量）
      if (pick < 0) {
        for (int attempt = 0; attempt < 96; attempt++) {
          int ci = (int)(rng.next() * (float)walk.size());
          if (ci < 0 || ci >= (int)walk.size()) continue;
          if (walk[ci].d >= b0 && walk[ci].d <= b1) { pick = ci; break; }
        }
      }
      if (pick < 0) continue;
      int cnt = gMin + (int)(rng.next() * (float)(gMax - gMin + 1));
      if (cnt > gMax) cnt = gMax;
      SpawnPoint sp;
      sp.kind = SP_MONSTER;
      sp.type = type;
      sp.x = cellX(walk[pick].gx);
      sp.z = cellZ(walk[pick].gz);
      sp.count = cnt;
      list.push_back(sp);
      anchors.push_back({ sp.x, sp.z });
    }
  }

  // 4c) 世界 Boss：远境均匀分布，取最强怪物类型
  int nBoss = cfg.bossCount > 0 ? cfg.bossCount : 3;
  static const char* kBossNames[] = { "荒原巨兽", "深渊领主", "冰霜女王", "熔岩魔君", "幽冥主宰" };
  const int kBossNameN = 5;
  if (!walk.empty()) {
    for (int i = 0; i < nBoss; i++) {
      double ang = (double)i / (double)nBoss * kTwoPi + rng.next() * 0.5;
      double rr = maxR * 0.82;
      double tx = std::cos(ang) * rr, tz = std::sin(ang) * rr;
      // Boss 应居远境：优先在外圈 [60%,100%] 选点，无则逐步放宽到 [40%..] / [免怪半径..]
      int idx = nearestCell(walk, tx, tz, maxR * 0.60, maxR);
      if (idx < 0) idx = nearestCell(walk, tx, tz, maxR * 0.40, maxR);
      if (idx < 0) idx = nearestCell(walk, tx, tz, freeR, maxR);
      if (idx < 0) continue;
      SpawnPoint sp;
      sp.kind = SP_BOSS;
      sp.type = (T > 0) ? typesByLevel[T - 1].second : std::string("gargoyle");
      sp.name = kBossNames[i % kBossNameN];
      sp.x = cellX(walk[idx].gx);
      sp.z = cellZ(walk[idx].gz);
      list.push_back(sp);
    }
  }

  // 写入世界出生点配置（覆盖旧数据）
  w.spawnsMut().clear();
  for (auto& sp : list) w.spawnsMut().listMut().push_back(sp);

  size_t walkCount = 0;
  for (size_t i = 0; i < NN; i++) if (mask[i]) walkCount++;
  fprintf(stderr, "[worldinit] 生成完成：可通行格 %zu/%zu（%.1f%%），出生点 %zu（NPC/怪物群/Boss）\n",
          walkCount, NN, 100.0 * (double)walkCount / (double)NN, list.size());
  return walkCount > 0;
}

std::string walkMaskToBase64() {
  const std::vector<uint8_t>& m = terrainWalkMask();
  return base64Encode(m.data(), m.size());
}

std::string worldDataToJson(const SpawnConfig& spawns) {
  Json root = Json::object();
  root["version"] = (int64_t)1;
  Json mj = Json::object();
  mj["n"] = (int64_t)terrainWalkMaskN();
  mj["off"] = (int64_t)terrainWalkMaskOff();
  mj["b64"] = walkMaskToBase64();
  root["mask"] = mj;
  try {
    root["spawns"] = Json::parse(spawns.toJson())["spawns"];
  } catch (...) {
    root["spawns"] = Json::array();
  }
  return root.dump();
}

bool worldDataFromJson(World& w, const std::string& json) {
  try {
    Json root = Json::parse(json);
    if (!root.has("mask")) return false;
    Json mj = root.at("mask");
    int n = (int)mj.at("n").asInt();
    int off = (int)mj.at("off").asInt();
    std::string raw = base64Decode(mj.at("b64").asString());
    if (n <= 0 || (size_t)n * (size_t)n != raw.size()) return false;
    std::vector<uint8_t> mask(raw.begin(), raw.end());
    terrainSetWalkMask(std::move(mask), n, off);
    if (root.has("spawns")) {
      Json sr = Json::object();
      sr["spawns"] = root.at("spawns");
      w.spawnsMut().fromJson(sr.dump());
    } else {
      w.spawnsMut().clear();
    }
    return true;
  } catch (...) {
    return false;
  }
}

} // namespace ew
