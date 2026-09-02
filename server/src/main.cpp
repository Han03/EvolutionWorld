// main.cpp - EvolutionWorld C++ 服务端入口
// 用法: ./evolution_server [port]
// 环境变量可覆盖配置: EW_PORT EW_SEED EW_SAMPLE_PCT EW_TOLERANCE EW_VERT_TOLERANCE EW_DEBUG ...
#include "config.h"
#include "game/world.h"
#include "auth/auth.h"
#include "anticheat/anticheat.h"
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
  cfg.sampleRatePct = envInt("EW_SAMPLE_PCT", cfg.sampleRatePct);
  cfg.teleportToleranceM = (float)envDouble("EW_TOLERANCE", cfg.teleportToleranceM);
  cfg.verticalToleranceM = (float)envDouble("EW_VERT_TOLERANCE", cfg.verticalToleranceM);
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

  World world(cfg);
  world.seedWorld();
  // 地形编辑器编辑层：启动加载 data/terrain_edit.json（无则跳过，不影响功能）
  {
    std::string ep = cfg.dataDir + "/terrain_edit.json";
    std::ifstream ef(ep, std::ios::binary);
    if (ef.is_open()) {
      std::string content((std::istreambuf_iterator<char>(ef)), std::istreambuf_iterator<char>());
      if (!content.empty() && terrainEditFromJson(content)) {
        fprintf(stderr, "[terrain] 加载编辑器编辑层 %s（%zu 格）\n", ep.c_str(), terrainEditSize());
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
  fprintf(stderr, "  防作弊: sample=%d%% tol=%.1fm vertTol=%.1fm maxRate=%d/s burst=%d kick=%d\n",
          cfg.sampleRatePct, cfg.teleportToleranceM, cfg.verticalToleranceM,
          cfg.maxInputRatePerSec, cfg.inputBurst, cfg.kickThreshold);
  fprintf(stderr, "  存储: %s%s%s\n",
          store.mysqlActive() ? "MySQL" : "MySQL(内存)",
          store.redisActive() ? "+Redis" : "+Redis(内存)",
          store.anyExternal() ? "" : "  [纯内存模式: EW_DB_MYSQL/EW_DB_REDIS 可启用外部存储]");
  fprintf(stderr, "  EW_DEBUG=1 时输出防作弊日志与 /api/debug/players\n");

  server.run();
  return 0;
}
