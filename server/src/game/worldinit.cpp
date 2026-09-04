// worldinit.cpp - 世界初始化执行器实现（岛屿 + 多主城 + 连通道路网 + 数据驱动生物投放）
//
// 生成流程：
//   1) 岛屿生成：X~2X 个大岛（含主城 0 居中心岛）+ 0~4X 个小岛；
//   2) 主城分布：X 个主城按间隔距离最均匀方式分布在大岛上，每城 ≥100m×100m；
//   3) 道路连接：相邻岛屿间 0~2 条道路，MST 保证所有岛屿整体连通；
//   4) BFS 可达性裁剪：从主城 0 中心 8 连通洪泛，未达格清空 → 全图连通无孤岛；
//   5) NPC 投放：不重复，按组别号+城市标号绑定（基础功能/任务/商店/铁匠），
//      NPC 不够则标号靠后的主城不投放，太多则组别号大的不投放；
//   6) 怪物投放：主城范围内不出怪，按群体投放到主城以外，距主城 0 越远等级越高；
//   7) Boss 投放：远境均匀分布，取最强怪物类型。
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
#include <functional>
#include <algorithm>

namespace ew {

using Json = ew::Json;

// mask 网格：动态计算（根据实际岛屿占地决定大小），每格 1 米
static int gMaskN = 256;    // 默认边长（格）
static int gMaskOff = 128;  // 默认偏移（世界 [-off, N-off)）
static const double kTwoPi = 6.283185307179586;

// 可通行格（含到指定参考点的距离，供分档投放用）
struct Cell { int gx = 0, gz = 0; double d = 0.0; };

static inline double cellX(int gx) { return (double)(gx - gMaskOff) + 0.5; }
static inline double cellZ(int gz) { return (double)(gz - gMaskOff) + 0.5; }
static inline int toCellX(double x) { return (int)std::floor(x) + gMaskOff; }
static inline int toCellZ(double z) { return (int)std::floor(z) + gMaskOff; }

// ---- 岛屿 / 城市辅助结构 ----
struct Island {
  double cx, cz, r;
  int cityIdx;      // -1 = 无城市
};

struct CityInfo {
  int idx;           // 城市标号 0..X-1
  double cx, cz;     // 中心坐标
  double radius;     // 主城半径
  int islandIdx;     // 所在大岛下标
};

// 在可通行格集合中找最接近 (tx,tz) 且到参考点距离落在 [minD,maxD] 的格；找不到返回 -1
static int nearestCell(const std::vector<Cell>& walk, double tx, double tz,
                       double refX, double refZ, double minD, double maxD) {
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
  setTerrainSeed((int32_t)cfg.worldSeed);
  int N = gMaskN, OFF = gMaskOff;   // 默认值，岛屿生成后根据实际占地重算
  std::vector<uint8_t> grown;   // 延迟分配（网格尺寸由岛屿实际占地决定）
  Mulberry32 rng((uint32_t)cfg.worldSeed ^ 0x5eed1u);

  // 标记圆盘为可通行（无条件 → 工程建筑可跨水/跨崖）
  auto markDisc = [&](double cx, double cz, double r) {
    int x0 = std::max(0, (int)std::floor(cx - r) + OFF);
    int x1 = std::min(N - 1, (int)std::floor(cx + r) + OFF);
    int z0 = std::max(0, (int)std::floor(cz - r) + OFF);
    int z1 = std::min(N - 1, (int)std::floor(cz + r) + OFF);
    double r2 = r * r;
    for (int gz = z0; gz <= z1; gz++) {
      for (int gx = x0; gx <= x1; gx++) {
        double dx = cellX(gx) - cx, dz = cellZ(gz) - cz;
        if (dx * dx + dz * dz <= r2) grown[(size_t)gz * N + gx] = 1;
      }
    }
  };

  // 沿两点连线标记窄路（等间距圆盘拼接）
  auto markRoad = [&](double x1, double z1, double x2, double z2, double halfW) {
    double dx = x2 - x1, dz = z2 - z1;
    double len = std::hypot(dx, dz);
    int steps = std::max(1, (int)std::ceil(len / (halfW * 0.8)));
    for (int s = 0; s <= steps; s++) {
      double t = (double)s / (double)steps;
      markDisc(x1 + dx * t, z1 + dz * t, halfW);
    }
  };

  // ================================================================
  // 1) 岛屿生成（约束求解，保证不重叠）
  // ================================================================
  const int X = cfg.worldCityCount > 1 ? cfg.worldCityCount : 5;
  const double cityR = cfg.worldCityRadius >= 50.0 ? cfg.worldCityRadius : 50.0;
  const double kGap = 15.0 + rng.next() * 25.0;   // 大岛间间隙（15~40m，随机）

  // 约束求解：环距保证相邻大岛不重叠
  //   相邻岛心距 = 2·ringDist·sin(π/ringSlots) ≥ 2·rLarge + kGap
  const int numLarge = X + (int)(rng.next() * (X + 1));  // X ~ 2X
  const int numSmall = (int)(rng.next() * (X * 4 + 1));  // 0 ~ 4X
  const int ringSlots = std::max(1, numLarge - 1);       // 除中心岛外的大岛数

  // 基础环距 + 随机拉伸（1.0~1.4x，岛屿越远越分散）
  double baseRingDist;
  if (ringSlots <= 1) {
    baseRingDist = cityR * 2.0 + kGap;
  } else {
    baseRingDist = (cityR + kGap / 2.0) / std::sin(M_PI / ringSlots);
  }
  double ringDistMul = 1.0 + rng.next() * 0.4;   // 1.0~1.4
  double ringDist = baseRingDist * ringDistMul;
  // 大岛最大半径：不小于 cityR（岛必须能承载城市）
  double rLargeMax = cityR + 10.0;  // 额外 10m 边缘空间

  std::vector<Island> islands;
  islands.reserve(numLarge + numSmall);

  // 1a) 中心岛（城市 0，位于原点）
  {
    Island center;
    center.cx = 0; center.cz = 0;
    center.r = cityR + rng.next() * 4.0;
    center.cityIdx = 0;
    islands.push_back(center);
  }

  // 1b) 环形大岛：等角度分布 + 轻微角度抖动 + 每岛距离随机浮动
  //     城市 1..X-1 依次分配给第 1..X-1 个大岛（全部保证放置成功）
  double angJitter = kTwoPi / ringSlots * 0.15;   // 角度抖动量（±15% 间距）
  for (int i = 0; i < ringSlots; i++) {
    double ang = (double)i / (double)ringSlots * kTwoPi
                 + (rng.next() - 0.5) * angJitter;   // 轻微角度扰动
    double distJitter = 1.0 + (rng.next() - 0.5) * 0.15;   // ±7.5% 距离浮动
    double cx = std::cos(ang) * ringDist * distJitter;
    double cz = std::sin(ang) * ringDist * distJitter;
    // 半径在 [cityR, rLargeMax] 内随机（≥cityR 保证岛能承载城市）
    double r = cityR + rng.next() * (rLargeMax - cityR);

    Island isle;
    isle.cx = cx; isle.cz = cz; isle.r = r;
    isle.cityIdx = (i < X - 1) ? (i + 1) : -1;
    islands.push_back(isle);
  }

  // 1c) 小岛：重试 + 缩小兜底（Poisson-disk 风格）
  double sMinR = cfg.worldSmallIslandMinR > 0 ? cfg.worldSmallIslandMinR : 5.0;
  double sMaxR = cfg.worldSmallIslandMaxR > sMinR ? cfg.worldSmallIslandMaxR : sMinR + 7.0;

  for (int i = 0; i < numSmall; i++) {
    bool placed = false;
    double r = sMaxR;
    // 3 轮重试，每轮失败则缩小半径
    for (int attempt = 0; attempt < 3 && !placed; attempt++) {
      if (attempt > 0) r = std::max(sMinR, r * 0.7);
      for (int t = 0; t < 20 && !placed; t++) {
        double ang = rng.next() * kTwoPi;
        double dist = 25.0 + rng.next() * 90.0;
        double cx = std::cos(ang) * dist;
        double cz = std::sin(ang) * dist;
        bool overlap = false;
        for (const auto& isle : islands) {
          if (std::hypot(cx - isle.cx, cz - isle.cz) < r + isle.r + 3.0)
          { overlap = true; break; }
        }
        if (overlap) continue;
        islands.push_back({cx, cz, r, -1});
        placed = true;
      }
    }
  }

  // ================================================================
  // 2) 岛屿间道路连接（MST 保证连通 + 相邻岛 0~2 条额外道路）
  // ================================================================
  const int nIslands = (int)islands.size();
  const double roadW = cfg.worldRoadWidth > 0.5 ? cfg.worldRoadWidth : 4.5;

  struct Edge { int a, b; double dist; };
  std::vector<Edge> edges;
  for (int i = 0; i < nIslands; i++) {
    for (int j = i + 1; j < nIslands; j++) {
      double d = std::hypot(islands[i].cx - islands[j].cx, islands[i].cz - islands[j].cz);
      edges.push_back({i, j, d});
    }
  }

  std::vector<int> parent(nIslands);
  for (int i = 0; i < nIslands; i++) parent[i] = i;
  std::function<int(int)> findP = [&](int x) -> int {
    return parent[x] == x ? x : parent[x] = findP(parent[x]);
  };
  auto unionP = [&](int a, int b) { parent[findP(a)] = findP(b); };

  auto edgesByDist = edges;
  std::sort(edgesByDist.begin(), edgesByDist.end(),
            [](const Edge& a, const Edge& b) { return a.dist < b.dist; });

  std::vector<std::pair<int,int>> roadPairs;
  std::vector<std::vector<bool>> connected(nIslands, std::vector<bool>(nIslands, false));

  for (const auto& e : edgesByDist) {
    if (findP(e.a) != findP(e.b)) {
      unionP(e.a, e.b);
      roadPairs.push_back({e.a, e.b});
      connected[e.a][e.b] = connected[e.b][e.a] = true;
    }
  }
  for (const auto& e : edgesByDist) {
    if (connected[e.a][e.b]) continue;
    if (e.dist > ringDist * 1.6) continue;
    int extra = (int)(rng.next() * 3);
    for (int k = 0; k < extra; k++) roadPairs.push_back({e.a, e.b});
  }

  // ================================================================
  // 3) 根据实际占地动态计算 mask 网格
  // ================================================================
  double boundMinX = 0, boundMaxX = 0, boundMinZ = 0, boundMaxZ = 0;
  auto expandBound = [&](double x, double z, double r) {
    boundMinX = std::min(boundMinX, x - r);
    boundMaxX = std::max(boundMaxX, x + r);
    boundMinZ = std::min(boundMinZ, z - r);
    boundMaxZ = std::max(boundMaxZ, z + r);
  };
  for (const auto& isle : islands) expandBound(isle.cx, isle.cz, isle.r + 2.0);
  for (const auto& rp : roadPairs) {
    expandBound(islands[rp.first].cx, islands[rp.first].cz, roadW + 2.0);
    expandBound(islands[rp.second].cx, islands[rp.second].cz, roadW + 2.0);
  }
  const int pad = 10;
  OFF = (int)std::floor(-std::min(boundMinX, boundMinZ)) + pad;
  N = (int)std::ceil(std::max(boundMaxX, boundMaxZ)) + OFF + pad;
  gMaskN = N;
  gMaskOff = OFF;
  const size_t NN = (size_t)N * N;
  grown.assign(NN, 0);
  fprintf(stderr, "[worldinit] 动态网格: %dx%d (off=%d), 覆盖 [%.0f,%.0f]x[%.0f,%.0f]\n",
          N, N, OFF, (double)(-OFF), (double)(N - OFF), (double)(-OFF), (double)(N - OFF));

  // 标记所有岛屿为可通行
  for (const auto& isle : islands) {
    markDisc(isle.cx, isle.cz, isle.r);
  }
  // 标记道路
  for (const auto& rp : roadPairs) {
    const Island& a = islands[rp.first];
    const Island& b = islands[rp.second];
    markRoad(a.cx, a.cz, b.cx, b.cz, roadW);
  }

  // ================================================================
  // 4) BFS 可达性裁剪：从主城 0 中心 8 连通洪泛
  // ================================================================
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
  terrainSetWalkMask(mask, N, OFF);

  // 采集可通行格（到主城 0 距离），供生物投放
  std::vector<Cell> walk;
  walk.reserve(8192);
  for (int gz = 0; gz < N; gz++) {
    for (int gx = 0; gx < N; gx++) {
      if (mask[(size_t)gz * N + gx]) {
        Cell c; c.gx = gx; c.gz = gz;
        c.d = std::hypot(cellX(gx), cellZ(gz));
        walk.push_back(c);
      }
    }
  }

  // ================================================================
  // 5) 构建城市信息
  // ================================================================
  std::vector<CityInfo> cities;
  cities.reserve(X);
  {
    CityInfo c0;
    c0.idx = 0; c0.cx = 0; c0.cz = 0; c0.radius = cityR;
    c0.islandIdx = 0;
    cities.push_back(c0);
  }
  for (int ci = 1; ci < X; ci++) {
    for (const auto& isle : islands) {
      if (isle.cityIdx == ci) {
        CityInfo c;
        c.idx = ci; c.cx = isle.cx; c.cz = isle.cz;
        c.radius = cityR; c.islandIdx = (int)(&isle - &islands[0]);
        cities.push_back(c);
        break;
      }
    }
  }
  // 确保城市中心可通行
  for (const auto& city : cities) {
    markDisc(city.cx, city.cz, cityR * 0.3);
  }

  // ================================================================
  // 6) 生物投放
  // ================================================================
  std::vector<SpawnPoint> list;

  // ---- 6a) NPC：按组别号 + 城市标号绑定投放（使用 NPC ID 引用 NpcDef） ----
  // 每城最多 worldNpcGroupsPerCity 个组，每组投放多个 NPC（按标签组合）
  // 总组数 = X * groupsPerCity；若 NPC 不够则标号靠后的主城不投放
  const int groupsPerCity = cfg.worldNpcGroupsPerCity > 0 ? cfg.worldNpcGroupsPerCity : 4;
  const int totalNpcGroups = X * groupsPerCity;
  // 实际可用组数受 npcCount 约束：每组 4 个 NPC
  const int maxAvailGroups = cfg.npcCount > 0 ? cfg.npcCount / 4 : totalNpcGroups;
  const int actualGroups = std::min(totalNpcGroups, maxAvailGroups);

  // NPC 插件：按标签筛选可用 NPC ID
  std::vector<std::string> guideIds, questIds, merchantIds, smithIds;
  for (const auto& [id, def] : w.npcs().npcs()) {
    if (NpcManager::hasTag(def.npcTag, NPC_TAG_BASIC) && !NpcManager::hasTag(def.npcTag, NPC_TAG_QUEST))
      guideIds.push_back(id);
    if (NpcManager::hasTag(def.npcTag, NPC_TAG_QUEST))
      questIds.push_back(id);
    if (NpcManager::hasTag(def.npcTag, NPC_TAG_SHOP))
      merchantIds.push_back(id);
    if (NpcManager::hasTag(def.npcTag, NPC_TAG_BLACKSMITH))
      smithIds.push_back(id);
  }
  // 排序保证稳定性
  auto sortVec = [](std::vector<std::string>& v) { std::sort(v.begin(), v.end()); };
  sortVec(guideIds); sortVec(questIds); sortVec(merchantIds); sortVec(smithIds);

  for (const auto& city : cities) {
    int cityGroupStart = city.idx * groupsPerCity;
    int cityGroupEnd = cityGroupStart + groupsPerCity;
    if (cityGroupStart >= actualGroups) continue;   // NPC 不够，该城不投放
    int cityGroupActualEnd = std::min(cityGroupEnd, actualGroups);

    for (int g = cityGroupStart; g < cityGroupActualEnd; g++) {
      int localGroup = g - cityGroupStart;   // 城内局部组号
      // 4 种标签 NPC（按 ID 引用）
      static const uint32_t tags[4] = {
        NPC_TAG_BASIC, NPC_TAG_QUEST, NPC_TAG_SHOP, NPC_TAG_BLACKSMITH
      };
      const std::vector<std::string>* idLists[4] = {&guideIds, &questIds, &merchantIds, &smithIds};

      for (int t = 0; t < 4; t++) {
        // 在城内按局部组号+标签排列（网格布局）
        double slotAng = (double)(localGroup * 4 + t) / (double)(groupsPerCity * 4) * kTwoPi;
        double slotR = cityR * 0.3 + (double)localGroup * (cityR * 0.12);
        if (slotR > cityR * 0.75) slotR = cityR * 0.75;
        double tx = city.cx + std::cos(slotAng) * slotR;
        double tz = city.cz + std::sin(slotAng) * slotR;

        SpawnPoint sp;
        sp.kind = SP_NPC;
        sp.x = tx; sp.z = tz;
        sp.npcGroup = g;
        sp.cityId = city.idx;

        // NPC 插件：按 ID 引用 NpcDef（轮询选择）
        const auto& idList = *idLists[t];
        if (!idList.empty()) {
          sp.npcId = idList[(localGroup + city.idx) % idList.size()];
          const NpcDef* def = w.npcs().npc(sp.npcId);
          if (def) {
            sp.npcTag = def->npcTag;
            sp.name = def->name;
            if (def->shopId) sp.shopId = def->shopId;
          }
        } else {
          // 回退：无可用 NPC ID，使用旧模式
          sp.npcTag = tags[t];
          sp.name = std::string(tags[t] == NPC_TAG_BASIC ? "向导" : tags[t] == NPC_TAG_QUEST ? "任务使者" : tags[t] == NPC_TAG_SHOP ? "商人" : "铁匠");
          if (tags[t] & NPC_TAG_SHOP) sp.shopId = city.idx * 100 + g + 1;
        }
        list.push_back(sp);
      }
    }
  }

  // ---- 6b) 怪物：按距主城 0 距离分级，主城范围内不投放 ----
  std::vector<std::pair<int, std::string>> typesByLevel;
  for (const auto& kv : w.data().monsters())
    typesByLevel.push_back({ kv.second.level, kv.first });
  std::sort(typesByLevel.begin(), typesByLevel.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });

  const double freeR = cfg.worldMonsterFreeRadius > 0 ? cfg.worldMonsterFreeRadius : 55.0;
  const double maxR = cfg.worldMonsterMaxRadius > freeR ? cfg.worldMonsterMaxRadius : 120.0;
  const int T = (int)typesByLevel.size();

  // 判断一点是否在任一主城范围内
  auto inAnyCity = [&](double x, double z, double margin) -> bool {
    for (const auto& city : cities) {
      if (std::hypot(x - city.cx, z - city.cz) < city.radius + margin) return true;
    }
    return false;
  };

  if (T > 0 && !walk.empty()) {
    int groups = cfg.worldMonsterGroups > 0 ? cfg.worldMonsterGroups : 30;
    int gMin = cfg.worldMonsterGroupMin > 0 ? cfg.worldMonsterGroupMin : 3;
    int gMax = cfg.worldMonsterGroupMax >= gMin ? cfg.worldMonsterGroupMax : gMin;
    double spacing = cfg.worldMonsterGroupSpacing > 0 ? cfg.worldMonsterGroupSpacing : 14.0;
    std::vector<std::pair<double, double>> anchors;

    for (int g = 0; g < groups; g++) {
      int band = (int)((long long)g * T / groups);
      if (band >= T) band = T - 1;
      double b0 = freeR + (maxR - freeR) * band / T;
      double b1 = freeR + (maxR - freeR) * (band + 1) / T;
      const std::string& type = typesByLevel[band].second;

      int pick = -1;
      for (int attempt = 0; attempt < 128; attempt++) {
        int ci = (int)(rng.next() * (float)walk.size());
        if (ci < 0 || ci >= (int)walk.size()) continue;
        const Cell& c = walk[ci];
        if (c.d < b0 || c.d > b1) continue;
        double wx = cellX(c.gx), wz = cellZ(c.gz);
        if (inAnyCity(wx, wz, 5.0)) continue;
        double minSep = 1e18;
        for (const auto& a : anchors)
          minSep = std::min(minSep, std::hypot(wx - a.first, wz - a.second));
        if (minSep < spacing) continue;
        pick = ci; break;
      }
      // 放宽：忽略间距，只要落在档内且不在城内
      if (pick < 0) {
        for (int attempt = 0; attempt < 128; attempt++) {
          int ci = (int)(rng.next() * (float)walk.size());
          if (ci < 0 || ci >= (int)walk.size()) continue;
          if (walk[ci].d >= b0 && walk[ci].d <= b1) {
            double wx = cellX(walk[ci].gx), wz = cellZ(walk[ci].gz);
            if (!inAnyCity(wx, wz, 5.0)) { pick = ci; break; }
          }
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

  // ---- 6c) Boss：远境均匀分布，取最强怪物类型 ----
  int nBoss = cfg.bossCount > 0 ? cfg.bossCount : 3;
  static const char* kBossNames[] = { "荒原巨兽", "深渊领主", "冰霜女王", "熔岩魔君", "幽冥主宰" };
  const int kBossNameN = 5;
  if (!walk.empty()) {
    for (int i = 0; i < nBoss; i++) {
      double ang = (double)i / (double)nBoss * kTwoPi + rng.next() * 0.5;
      double rr = maxR * 0.82;
      double tx = std::cos(ang) * rr, tz = std::sin(ang) * rr;
      int idx = nearestCell(walk, tx, tz, 0.0, 0.0, maxR * 0.60, maxR);
      if (idx < 0) idx = nearestCell(walk, tx, tz, 0.0, 0.0, maxR * 0.40, maxR);
      if (idx < 0) idx = nearestCell(walk, tx, tz, 0.0, 0.0, freeR, maxR);
      if (idx < 0) continue;
      double bx = cellX(walk[idx].gx), bz = cellZ(walk[idx].gz);
      if (inAnyCity(bx, bz, 5.0)) continue;
      SpawnPoint sp;
      sp.kind = SP_BOSS;
      sp.type = (T > 0) ? typesByLevel[T - 1].second : std::string("gargoyle");
      sp.name = kBossNames[i % kBossNameN];
      sp.x = bx; sp.z = bz;
      list.push_back(sp);
    }
  }

  // 写入世界出生点配置
  w.spawnsMut().clear();
  for (auto& sp : list) w.spawnsMut().listMut().push_back(sp);

  // ---- 兜底：若出生点为空 ----
  if (list.empty()) {
    fprintf(stderr, "[worldinit] 警告：无可通行格，强制在中心添加 NPC 出生点\n");
    markDisc(0.0, 0.0, cityR);
    terrainSetWalkMask(grown, N, OFF);
    SpawnPoint sp;
    sp.kind = SP_NPC;
    sp.x = 0.0; sp.z = 0.0;
    sp.shopId = 1; sp.name = "商店老板"; sp.npcTag = NPC_TAG_SHOP;
    sp.npcGroup = 0; sp.cityId = 0;
    w.spawnsMut().listMut().push_back(sp);
    list.push_back(sp);
  }

  size_t walkCount = 0;
  for (size_t i = 0; i < NN; i++) if (mask[i]) walkCount++;
  fprintf(stderr, "[worldinit] 生成完成：岛屿 %d（大%d + 小%d），城市 %d，道路 %zu 条，"
          "可通行格 %zu/%zu（%.1f%%），出生点 %zu\n",
          nIslands, numLarge, numSmall, (int)cities.size(), roadPairs.size(),
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
