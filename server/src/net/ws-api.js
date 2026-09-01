/**
 * WebSocket 游戏网关
 * 协议（JSON）：
 *  - 连接：/ws?token=xxx
 *  - C->S: { type:'input', seq:number, moveX:number(-1..1), moveZ:number(-1..1), jump:bool }
 *  - S->C: { type:'welcome', entityId, username, world:{...}, you:{...} }
 *          { type:'snapshot', tick, t, viewRange, count, entities:[{id,kind,x,y,z,username?}] }
 *  - S->C: { type:'error', message }
 *
 * 快照按「玩家可见范围（100m）」裁剪后发送；空壳阶段为全量快照，后续可升级为增量/状态同步。
 */
import { WebSocketServer } from 'ws';

export function createWsApi({ server, config, auth, world }) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const session = auth.verifyToken(token);

    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: '无效或过期的令牌，请重新登录' }));
      ws.close(4001, 'unauthorized');
      return;
    }

    // 将玩家接入世界
    const player = world.spawnPlayer(session.userId, session.username);
    player.session = ws;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    // 发送欢迎消息（含自身实体信息与世界配置）
    send(ws, {
      type: 'welcome',
      entityId: player.id,
      username: player.username,
      world: {
        seed: config.WORLD_SEED,
        viewRange: config.VIEW_RANGE_M,
        chunkSize: config.CHUNK_SIZE_M,
        tickRate: config.TICK_RATE_HZ,
      },
      you: player.serialize(),
    });

    // 客户端输入
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleMessage({ ws, config, world }, player, msg);
    });

    ws.on('close', () => {
      world.despawnPlayer(player.id);
    });
    ws.on('error', (e) => {
      console.warn(`[WS] 连接异常 ${player.id}:`, e.message);
    });
  });

  // 心跳保活
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 10000);
  heartbeat.unref();

  return wss;
}

/** 客户端消息分发（集中于此，便于后续扩展新消息类型） */
function handleMessage({ ws, config, world }, player, msg) {
  switch (msg.type) {
    case 'input': {
      const moveX = clampNum(msg.moveX, -1, 1);
      const moveZ = clampNum(msg.moveZ, -1, 1);
      player.input.moveX = moveX;
      player.input.moveZ = moveZ;
      if (msg.jump === true) player.input.jump = true;
      if (typeof msg.seq === 'number') player.lastSeq = msg.seq;
      if (process.env.EW_DEBUG) {
        console.log(`[DBG] ${player.id} input move=(${moveX},${moveZ}) jump=${!!msg.jump} seq=${msg.seq}`);
      }
      break;
    }
    // ---- 预留扩展消息类型示例 ----
    // case 'chat': ...
    // case 'interact': ...
    // case 'skill': ...
    default:
      // 未知消息类型忽略（可在此上报监控）
      break;
  }
}

/** 定期向所有玩家广播其可见范围快照（由入口启动时调度） */
export function startSnapshotBroadcast({ config, world }) {
  const interval = setInterval(() => {
    for (const player of world.players.values()) {
      const ws = player.session;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      const snap = world.buildSnapshot(player);
      send(ws, { type: 'snapshot', ...snap });
    }
  }, config.TICK_MS);
  interval.unref();
  return interval;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}
