/**
 * EvolutionWorld 服务端入口
 * 装配：HTTP 鉴权网关 + WebSocket 游戏网关 + 世界模拟循环 + 快照广播
 */
import http from 'node:http';
import { CONFIG } from './config.js';
import { AuthService } from './auth/auth-service.js';
import { WorldManager } from './core/world-manager.js';
import { terrain } from './world/terrain.js';
import { createHttpApi } from './net/http-api.js';
import { createWsApi, startSnapshotBroadcast } from './net/ws-api.js';

async function main() {
  const config = CONFIG;

  // 1) 鉴权服务
  const auth = new AuthService(config);

  // 2) 世界（含地形模块、物理、区块、系统）
  const world = new WorldManager(config, terrain);

  // 3) 生成空壳世界占位实体
  world.seedWorld();

  // 4) HTTP + 静态客户端
  const app = createHttpApi({ config, auth, world });
  const server = http.createServer(app);

  // 5) WebSocket 游戏网关
  createWsApi({ server, config, auth, world });

  // 6) 启动世界模拟与快照广播
  world.start();
  startSnapshotBroadcast({ config, world });

  server.listen(config.PORT, config.HOST, () => {
    console.log('======================================================');
    console.log('  EvolutionWorld 服务端已启动');
    console.log(`  地址:      http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
    console.log(`  世界种子:  ${config.WORLD_SEED}`);
    console.log(`  可见范围:  ${config.VIEW_RANGE_M}m  区块大小: ${config.CHUNK_SIZE_M}m`);
    console.log(`  模拟频率:  ${config.TICK_RATE_HZ} Hz`);
    console.log('  HTTP 登录:  POST /api/login  {username,password}');
    console.log('  客户端:     浏览器打开首页即可登录进入世界');
    console.log('======================================================');
  });

  const shutdown = () => {
    console.log('\n[EvolutionWorld] 正在关闭...');
    world.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('服务启动失败:', e);
  process.exit(1);
});
