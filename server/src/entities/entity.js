/**
 * 实体基类
 * 所有世界实体（玩家/怪物/NPC/未来的掉落物等）都继承自该类。
 * 预留扩展位：
 *  - data: 任意附加数据（Buff、属性、装备等）
 *  - systems: 该实体专属的系统钩子
 */
export class Entity {
  /**
   * @param {string} id
   * @param {string} kind  'player' | 'monster' | 'npc' | ...
   */
  constructor(id, kind) {
    this.id = id;
    this.kind = kind;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.radius = 0.5;
    this.grounded = false;
    this.active = true;
    this.createdAt = Date.now();
    /** 扩展位：自定义业务数据 */
    this.data = {};
    /** 扩展位：AI/行为状态机 */
    this.ai = null;
    /** 客户端可见的附加字段（可自定义） */
    this.display = {};
  }

  /** 设置地表位置（自动吸附到地形上方） */
  placeOnGround(x, z, terrain) {
    this.pos.x = x;
    this.pos.z = z;
    this.pos.y = terrain.terrainHeight(x, z) + this.radius + 0.3;
  }

  /** 网络快照（只暴露客户端需要的最小字段） */
  serialize() {
    return {
      id: this.id,
      kind: this.kind,
      x: Math.round(this.pos.x * 100) / 100,
      y: Math.round(this.pos.y * 100) / 100,
      z: Math.round(this.pos.z * 100) / 100,
      ...this.serializeExtra(),
    };
  }

  /** 子类扩展快照字段 */
  serializeExtra() {
    return {};
  }
}
