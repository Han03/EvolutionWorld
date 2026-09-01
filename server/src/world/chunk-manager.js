/**
 * 区块（Chunk）管理器 —— 「地图只加载当前玩家可见范围内的数据（100 米）」的核心实现。
 *
 * 设计：
 *  - 世界按 CHUNK_SIZE_M 划分为网格区块；区块只是「加载/模拟范围」的载体（空壳阶段地形为程序化无缝生成，
 *    无需持久化区块数据，但保留扩展位：后续可在此挂载地块数据、AOI 网格、持久化加载）。
 *  - 每个玩家维护一份「已加载区块集合 loadedChunks」：当其跨越区块边界时，增补进入视野的区块、
 *    剔除离开视野的区块（enter/exit 事件供后续扩展：资源加载、消息广播、AI 激活等）。
 *  - 实体按坐标挂到区块上，支持按范围取实体，供快照生成与 AI 激活判定。
 */
export class ChunkManager {
  constructor(world, config) {
    this.world = world;
    this.chunkSize = config.CHUNK_SIZE_M;
    this.viewRange = config.VIEW_RANGE_M;
    // chunkKey(ix,iz) -> { ix, iz, entities:Set }
    this.chunks = new Map();
    // playerId -> Set<chunkKey>
    this.playerChunks = new Map();
  }

  /** 坐标 -> 区块整数坐标 */
  chunkCoord(x, z) {
    return {
      ix: Math.floor(x / this.chunkSize),
      iz: Math.floor(z / this.chunkSize),
    };
  }

  chunkKey(ix, iz) {
    return `${ix},${iz}`;
  }

  _ensureChunk(ix, iz) {
    const key = this.chunkKey(ix, iz);
    let c = this.chunks.get(key);
    if (!c) {
      c = { ix, iz, key, entities: new Set() };
      this.chunks.set(key, c);
    }
    return c;
  }

  /** 实体移动/加入时更新其所在区块 */
  updateEntityChunk(entity) {
    const { ix, iz } = this.chunkCoord(entity.pos.x, entity.pos.z);
    const key = this.chunkKey(ix, iz);
    if (entity.__chunkKey === key) return;
    if (entity.__chunkKey) {
      const old = this.chunks.get(entity.__chunkKey);
      if (old) old.entities.delete(entity.id);
    }
    const c = this._ensureChunk(ix, iz);
    c.entities.add(entity.id);
    entity.__chunkKey = key;
  }

  removeEntity(entity) {
    if (entity.__chunkKey) {
      const c = this.chunks.get(entity.__chunkKey);
      if (c) c.entities.delete(entity.id);
      entity.__chunkKey = null;
    }
  }

  /** 获取某点周围 viewRange 内的区块 key 集合 */
  chunksInRange(x, z, range = this.viewRange) {
    const { ix, iz } = this.chunkCoord(x, z);
    const span = Math.ceil(range / this.chunkSize);
    const keys = new Set();
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const cx = ix + dx;
        const cz = iz + dz;
        // 区块中心是否在范围内（粗略），减少边缘区块
        const wx = cx * this.chunkSize + this.chunkSize / 2;
        const wz = cz * this.chunkSize + this.chunkSize / 2;
        const d = Math.hypot(wx - x, wz - z);
        if (d <= range + this.chunkSize * 0.8) keys.add(this.chunkKey(cx, cz));
      }
    }
    return keys;
  }

  /**
   * 更新某玩家的加载集合，返回 { entered:[chunkKey], exited:[chunkKey] }
   * 供后续扩展：进入视野区块时触发资源/数据加载，退出时触发卸载。
   */
  updatePlayerChunks(player) {
    const need = this.chunksInRange(player.pos.x, player.pos.z);
    const have = this.playerChunks.get(player.id) || new Set();
    const entered = [];
    const exited = [];
    for (const k of need) if (!have.has(k)) entered.push(k);
    for (const k of have) if (!need.has(k)) exited.push(k);
    this.playerChunks.set(player.id, need);
    if (entered.length || exited.length) {
      this.world.emit('chunk-change', { player, entered, exited });
    }
    return { entered, exited };
  }

  /** 玩家断开时清理 */
  removePlayer(playerId) {
    this.playerChunks.delete(playerId);
  }

  /** 判断某实体是否位于任一在线玩家视野内（AI 激活判定） */
  isEntityVisible(entity) {
    for (const p of this.world.players.values()) {
      if (!p.active) continue;
      const d = Math.hypot(entity.pos.x - p.pos.x, entity.pos.z - p.pos.z);
      if (d <= this.viewRange + this.chunkSize) return true;
    }
    return false;
  }

  /** 取某范围内所有实体（可见快照数据源） */
  entitiesInRange(x, z, range = this.viewRange) {
    const keys = this.chunksInRange(x, z, range);
    const out = new Set();
    for (const key of keys) {
      const c = this.chunks.get(key);
      if (!c) continue;
      for (const id of c.entities) {
        const e = this.world.entities.get(id);
        if (!e || !e.active) continue;
        const d = Math.hypot(e.pos.x - x, e.pos.z - z);
        if (d <= range) out.add(e);
      }
    }
    return out;
  }
}
