// main.cpp - EvolutionWorld C++ 服务端入口
// 用法: ./evolution_server [port]
// 环境变量可覆盖配置: EW_PORT EW_SEED EW_SAMPLE_PCT EW_TOLERANCE EW_VERT_TOLERANCE EW_DEBUG ...
#include "config.h"
#include "game/world.h"
#include "auth/auth.h"
#include "anticheat/anticheat.h"
#include "net/server.h"
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

  // clientDir 解析为绝对路径（相对当前工作目录）
  char cwd[2048];
  if (getcwd(cwd, sizeof(cwd))) {
    std::string base(cwd);
    if (base.back() != '/') base += '/';
    cfg.clientDir = base + cfg.clientDir;
  }

  World world(cfg);
  world.seedWorld();
  Auth auth(cfg);
  AntiCheat ac(cfg);
  GameServer server(cfg, world, auth, ac);

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
  fprintf(stderr, "  EW_DEBUG=1 时输出防作弊日志与 /api/debug/players\n");

  server.run();
  return 0;
}
