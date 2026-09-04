// main.cpp - EvolutionWorld C++ 服务端入口
// 用法: ./evolution_server [port]
// 环境变量可覆盖配置: EW_PORT EW_SEED EW_SAMPLE_PCT EW_TOLERANCE EW_TERRAIN_TOL EW_DEBUG ...
#include "config.h"
#include "game/world.h"
#include "auth/auth.h"
#include "anticheat/anticheat.h"
#include "util/random.h"
#include "net/server.h"
#include "store/store.h"
#include "game/terrain.h"
#include <fstream>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <unistd.h>

using namespace ew;

static void onSignal(int) { exit(0); }

static double envDouble(const char* name, double def) {
  const char* v = getenv(name);
  return v ? atof(v) : def;
}
static int envInt(const char* name, int def) {
  const char* v = getenv(name);
  return v ? atoi(v) : def;
}

int main(int argc, char** argv) {
  Config cfg;
  if (argc > 1) cfg.port = atoi(argv[1]);
  cfg.port = envInt("EW_PORT", cfg.port);
  cfg.worldSeed = envInt("EW_SEED", cfg.worldSeed);
  // 种子为 0 时（默认）使用 /dev/urandom 生成随机种子
  bool seedRandomized = (cfg.worldSeed == 0);
  if (seedRandomized) {
    unsigned char sbuf[4];
    ew::randomBytes(sbuf, sizeof(sbuf));
    cfg.worldSeed = (int)((uint32_t)sbuf[0] << 24 | (uint32_t)sbuf[1] << 16 |
                          (uint32_t)sbuf[2] << 8  | (uint32_t)sbuf[3]);
  }
  cfg.sampleRatePct = envInt("EW_SAMPLE_PCT", cfg.sampleRatePct);
  cfg.teleportToleranceM = (float)envDouble("EW_TOLERANCE", cfg.teleportToleranceM);
  cfg.terrainToleranceM = (float)envDouble("EW_TERRAIN_TOL", cfg.terrainToleranceM);
  cfg.maxInputRatePerSec = envInt("EW_MAX_RATE", cfg.maxInputRatePerSec);
  cfg.inputBurst = envInt("EW_BURST", cfg.inputBurst);
  cfg.kickThreshold = envInt("EW_KICK_THRESHOLD", cfg.kickThreshold);
  cfg.bossCount = envInt("EW_BOSS_COUNT", cfg.bossCount);
  cfg.bossHp = (float)envDouble("EW_BOSS_HP", cfg.bossHp);
  cfg.bossAttack = (float)envDouble("EW_BOSS_ATTACK", cfg.bossAttack);
  cfg.bossRespawnSec = (float)envDouble("EW_BOSS_RESPAWN", cfg.bossRespawnSec);
  cfg.monsterRespawnSec = (float)envDouble("EW_MONSTER_RESPAWN", cfg.monsterRespawnSec);
  cfg.playerAttackCdSec = (float)envDouble("EW_PLAYER_ATTACK_CD", cfg.playerAttackCdSec);

  // clientDir 解析为绝对路径（相对当前工作目录）
  char cwd[2048];
  if (getcwd(cwd, sizeof(cwd))) {
    std::string base(cwd);
    if (base.back() != '/') base += '/';
    cfg.clientDir = base + cfg.clientDir;
  }

  // 存储系统：MySQL(账号/存档) + Redis(会话/缓存)，内存兜底；连不上自动降级不影响功能
  StoreConfig sc = storeConfigFromEnv(cfg);
  Store store(cfg, sc);
  store.init();
  // 从 MySQL 批量加载好友/黑名单/公会成员到内存后端（供子系统启动加载）
  store.populateFriendsBlocks();

  World world(cfg);
  world.setStore(&store); // 注入存储层（世界数据/社交系统持久化用）
  // 社交系统启动加载（必须在 setStore 之后）
  world.friends().init();
  world.guilds().init();
  // 世界初始化执行器（大型网游规模）：
  //   种子随机化时：强制重新生成世界（忽略数据库旧数据），保证每次启动都是新世界。
  //   种子显式指定时（EW_SEED）：数据库模式优先从库读取，保持一致的世界。
  //   内存模式：每次启动都执行世界初始化。
  {
    bool dbMode = store.worldDataPersistent();
    bool loaded = false;
    if (dbMode && !seedRandomized) loaded = world.loadWorldFromStore(store);
    if (loaded) {
      fprintf(stderr, "[world] 数据库模式：已从数据库读取世界地形/出生点（跳过初始化，seed=%d，%zu 个出生点）\n",
              cfg.worldSeed, world.spawns().size());
    } else {
      if (seedRandomized && dbMode) {
        fprintf(stderr, "[world] 种子已随机化（seed=%d），强制重新生成世界（跳过数据库旧数据）\n", cfg.worldSeed);
      }
      world.runWorldInit();
      if (dbMode) world.saveWorldToStore(store);
      fprintf(stderr, "[world] %s模式：执行世界初始化（seed=%d，连通可通行地形 + 主城 + 分组生物投放，%zu 个出生点）\n",
              dbMode ? "数据库" : "内存", cfg.worldSeed, world.spawns().size());
    }
  }
  // 装备实例 ID 计数器恢复（跨重启唯一性；数据库模式生效，内存模式为空操作）
  world.loadInstIdCounter();
  // 数据库模式：从 MySQL 加载物品/生物配置（覆盖文件加载）
  if (store.worldDataPersistent()) {
    std::string itemsJson, monstersJson;
    if (store.loadWorldData("items", itemsJson) && !itemsJson.empty()) {
      try {
        Json arr = Json::parse(itemsJson);
        world.data().replaceItems(arr);
        fprintf(stderr, "[gamedata] 数据库模式：从 MySQL 加载物品配置 %zu 件\n", world.data().items().size());
      } catch (...) {}
    }
    if (store.loadWorldData("monsters", monstersJson) && !monstersJson.empty()) {
      try {
        Json obj = Json::parse(monstersJson);
        world.data().replaceMonsters(obj);
        fprintf(stderr, "[gamedata] 数据库模式：从 MySQL 加载生物配置 %zu 种\n", world.data().monsters().size());
      } catch (...) {}
    }
  }
  world.seedWorld();
  // 地形编辑器编辑层：仅数据库模式持久化（MySQL），内存模式重启即重置
  if (store.worldDataPersistent()) {
    std::string editJson;
    if (store.loadWorldData("terrain_edit", editJson) && !editJson.empty()) {
      if (terrainEditFromJson(editJson)) {
        fprintf(stderr, "[terrain] 从数据库加载编辑层（%zu 格）\n", terrainEditSize());
      }
    }
  }
  Auth auth(cfg, store);
  AntiCheat ac(cfg);
  GameServer server(cfg, world, auth, ac, store);

  if (!server.start()) {
    fprintf(stderr, "[EvolutionWorld] 启动失败：端口 %d 可能被占用\n", cfg.port);
    return 1;
  }
  signal(SIGINT, onSignal);
  signal(SIGTERM, onSignal);

  fprintf(stderr, "[EvolutionWorld] C++ 服务端启动成功\n");
  fprintf(stderr, "  HTTP/WS: http://localhost:%d\n", cfg.port);
  fprintf(stderr, "  世界: seed=%d viewRange=%.0fm chunkSize=%.0fm tick=%.0fHz\n",
          cfg.worldSeed, cfg.viewRangeM, cfg.chunkSizeM, cfg.tickRateHz);
  fprintf(stderr, "  防作弊: sample=%d%% tol=%.1fm terrainTol=%.2fm maxRate=%d/s burst=%d kick=%d\n",
          cfg.sampleRatePct, cfg.teleportToleranceM, cfg.terrainToleranceM,
          cfg.maxInputRatePerSec, cfg.inputBurst, cfg.kickThreshold);
  fprintf(stderr, "  存储: %s%s%s\n",
          store.mysqlActive() ? "MySQL" : "MySQL(内存)",
          store.redisActive() ? "+Redis" : "+Redis(内存)",
          store.anyExternal() ? "" : "  [纯内存模式: EW_DB_MYSQL/EW_DB_REDIS 可启用外部存储]");
  fprintf(stderr, "  EW_DEBUG=1 时输出防作弊日志与 /api/debug/players\n");

  server.run();
  return 0;
}
