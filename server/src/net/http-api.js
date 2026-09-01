/**
 * HTTP 网关
 * 提供：账号注册 / 登录 / 登出 / 健康检查，以及客户端静态资源托管。
 * 登录成功后客户端携带 token 建立 WebSocket 连接进入世界。
 */
import express from 'express';
import path from 'node:path';

export function createHttpApi({ config, auth, world }) {
  const app = express();
  app.use(express.json({ limit: config.HTTP_BODY_LIMIT }));

  // ---- 健康检查 ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'EvolutionWorld', ts: Date.now() });
  });

  // ---- 注册 ----
  app.post('/api/register', async (req, res) => {
    const { username, password } = req.body || {};
    const r = await auth.register(username, password);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, message: '注册成功，请登录' });
  });

  // ---- 登录 ----
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    const r = await auth.login(username, password);
    if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
    res.json({
      ok: true,
      token: r.token,
      user: r.user,
      world: {
        seed: config.WORLD_SEED,
        viewRange: config.VIEW_RANGE_M,
        chunkSize: config.CHUNK_SIZE_M,
        tickRate: config.TICK_RATE_HZ,
      },
    });
  });

  // ---- 登出 ----
  app.post('/api/logout', (req, res) => {
    const token = (req.body && req.body.token) || '';
    auth.logout(token);
    res.json({ ok: true });
  });

  // ---- 调试：在线玩家状态（仅 EW_DEBUG=1 时开放） ----
  if (process.env.EW_DEBUG && world) {
    app.get('/api/debug/players', (_req, res) => {
      const players = [...world.players.values()].map((p) => ({
        id: p.id,
        username: p.username,
        x: Math.round(p.pos.x * 10) / 10,
        y: Math.round(p.pos.y * 10) / 10,
        z: Math.round(p.pos.z * 10) / 10,
        vx: Math.round(p.vel.x * 100) / 100,
        vz: Math.round(p.vel.z * 100) / 100,
        grounded: p.grounded,
      }));
      res.json({ tick: world._tick, players });
    });
  }

  // ---- 客户端静态资源 ----
  const clientDir = config.CLIENT_DIR;
  app.use(express.static(clientDir));
  // SPA 回退：未知路径返回 index.html（便于后续前端路由）
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  return app;
}
