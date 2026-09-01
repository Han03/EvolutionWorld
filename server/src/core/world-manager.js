/**
 * 世界管理器 —— 服务端核心装配层
 * 职责：
 *  - 持有全部实体 / 在线玩家 / 区块 / 物理
 *  - 维护并驱动「系统列表」（可扩展性的入口）
 *  - 固定的 tick 循环（TICK_RATE_HZ）
 *  - 生成玩家可见范围内的实体快照
 *  - 简单事件总线（world.emit / world.on），供系统间解耦通信
 */
import { EventEmitter } from 'node:events';
import { ChunkManager } from '../world/chunk-manager.js';
import { PhysicsWorld } from '../physics/physics-world.js';
import { InputSystem } from '../systems/input-system.js';
import { MoveSystem } from '../systems/move-system.js';
import { AISystem } from '../systems/ai-system.js';
import { Monster } from '../entities/monster.js';
import { NPC } from '../entities/npc.js';
import { Player } from '../entities/player.js';
import { mulberry32, randomSpawn } from '../world/terrain.js';

export class WorldManager extends EventEmitter {
  constructor(config, terrain) {
    super();
    this.config = config;
    this.terrain = terrain;

    this.entities = new Map();  // id -> Entity（全部实体）
    this.players = new Map();   // playerId -> Player（在线玩家索引）

    this.physics = new PhysicsWorld(config, terrain);
    this.chunks = new ChunkManager(this, config);

    /** 系统列表（有序） */
    this.systems = [];
    this._systemsSorted = true;

    this._entitySeq = 0;
    this._tick = 0;
    this._running = false;
    this._timer = null;

    this.createDefaultSystems();
  }

  /** 注册系统（可扩展入口） */
  addSystem(system) {
    this.systems.push(system);
    this._systemsSorted = false;
  }

  createDefaultSystems() {
    this.addSystem(new InputSystem(this, this.config));
    this.addSystem(new MoveSystem(this, this.config));
    this.addSystem(new AISystem(this, this.config));
    this._sortSystems();
  }

  _sortSystems() {
    this.systems.sort((a, b) => a.priority - b.priority);
    this._systemsSorted = true;
  }

  // ---------- 实体管理 ----------

  _nextEntityId(kind) {
    const prefix = { player: 'p', monster: 'm', npc: 'n' }[kind] || 'e';
    return `${prefix}_${++this._entitySeq}`;
  }

  addEntity(entity) {
    this.entities.set(entity.id, entity);
    this.chunks.updateEntityChunk(entity);
    return entity;
  }

  removeEntity(id) {
    const e = this.entities.get(id);
    if (!e) return false;
    this.chunks.removeEntity(e);
    this.entities.delete(id);
    if (e.kind === 'player') this.players.delete(e.id);
    return true;
  }

  spawnPlayer(userId, username, spawnPos) {
    const player = new Player(
      this._nextEntityId('player'),
      userId,
      username
    );
    if (spawnPos) {
      player.pos.x = spawnPos.x;
      player.pos.y = spawnPos.y;
      player.pos.z = spawnPos.z;
    } else {
      const rng = mulberry32((userId.length + Date.now()) % 0xffffffff);
      const sp = randomSpawn(rng);
      player.placeOnGround(sp.x, sp.z, this.terrain);
    }
    this.addEntity(player);
    this.players.set(player.id, player);
    return player;
  }

  despawnPlayer(playerId) {
    this.removeEntity(playerId);
    this.chunks.removePlayer(playerId);
  }

  /** 初始化空壳世界的占位实体（怪物/NPC） */
  seedWorld() {
    const rng = mulberry32(this.config.WORLD_SEED ^ 0x51ab);
    for (let i = 0; i < this.config.MONSTER_COUNT; i++) {
      const m = new Monster(this._nextEntityId('monster'));
      const sp = randomSpawn(rng);
      m.placeOnGround(sp.x, sp.z, this.terrain);
      m.ai.homeX = m.pos.x;
      m.ai.homeZ = m.pos.z;
      this.addEntity(m);
    }
    for (let i = 0; i < this.config.NPC_COUNT; i++) {
      const n = new NPC(this._nextEntityId('npc'));
      const sp = randomSpawn(rng);
      n.placeOnGround(sp.x, sp.z, this.terrain);
      n.ai.homeX = n.pos.x;
      n.ai.homeZ = n.pos.z;
      this.addEntity(n);
    }
  }

  // ---------- 主循环 ----------

  start() {
    if (this._running) return;
    this._running = true;
    const tickMs = this.config.TICK_MS;
    this._timer = setInterval(() => this.tick(), tickMs);
    this.emit('start', { tickHz: this.config.TICK_RATE_HZ });
  }

  stop() {
    this._running = false;
    clearInterval(this._timer);
    this.emit('stop');
  }

  tick() {
    if (!this._systemsSorted) this._sortSystems();
    const dt = this.config.TICK_MS / 1000;
    this._tick++;

    // 1) 系统驱动
    for (const sys of this.systems) {
      if (sys.enabled) sys.update(dt);
    }

    // 2) 同步实体到区块（位置可能变化）
    for (const e of this.entities.values()) {
      this.chunks.updateEntityChunk(e);
    }

    // 3) 更新各玩家加载集合（100m 可见范围）
    for (const p of this.players.values()) {
      this.chunks.updatePlayerChunks(p);
    }

    this.emit('tick', this._tick);
  }

  // ---------- 可见快照 ----------

  /**
   * 为指定玩家生成「可见范围内」的实体快照（100m）
   * 用于网络层广播；空壳阶段每 tick 全量快照，后续可换增量快照。
   */
  buildSnapshot(player) {
    const visible = this.chunks.entitiesInRange(player.pos.x, player.pos.z, this.config.VIEW_RANGE_M);
    const entities = [];
    for (const e of visible) {
      entities.push(e.serialize());
    }
    return {
      tick: this._tick,
      t: Date.now(),
      viewRange: this.config.VIEW_RANGE_M,
      count: entities.length,
      entities,
    };
  }
}
