/**
 * 全局配置
 * 所有可调参数集中于此，便于后续扩展与调优。
 */
export const CONFIG = {
  // ---- 服务 ----
  PORT: 3000,
  HOST: '0.0.0.0',
  HTTP_BODY_LIMIT: '1mb',

  // ---- 静态客户端 ----
  CLIENT_DIR: new URL('../../client/', import.meta.url).pathname,

  // ---- 账号鉴权 ----
  USER_DB_FILE: new URL('./data/users.json', import.meta.url).pathname,
  SESSION_TTL_MS: 24 * 60 * 60 * 1000, // 会话有效期 24h

  // ---- 世界 ----
  WORLD_SEED: 20260901,        // 世界种子，客户端与服务端一致以生成相同地形
  VIEW_RANGE_M: 100,           // 玩家可见/加载范围（半径，米）
  CHUNK_SIZE_M: 50,            // 区块边长（米），用于可见区域加载管理
  SPAWN_RADIUS: 8,             // 出生点随机半径
  MAX_ENTITIES_PER_PLAYER: 200,

  // ---- 模拟 ----
  TICK_RATE_HZ: 20,            // 服务端逻辑帧率
  TICK_MS: 50,

  // ---- 物理 ----
  GRAVITY: -9.81,
  JUMP_VELOCITY: 7.0,
  MAX_MOVE_SPEED: 7.0,         // 水平移动最大速度
  ACCELERATION: 40.0,
  FRICTION: 12.0,
  PLAYER_RADIUS: 0.5,

  // ---- 实体 ----
  MONSTER_COUNT: 24,           // 世界刷新的怪物数量（空壳演示用）
  NPC_COUNT: 12,               // 世界刷新的 NPC 数量
};
