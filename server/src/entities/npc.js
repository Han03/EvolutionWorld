/**
 * NPC 实体（空壳阶段为可移动的蓝色圆球）
 * 后续可挂载对话、任务、商店等系统。
 */
import { Entity } from './entity.js';

export class NPC extends Entity {
  constructor(id) {
    super(id, 'npc');
    this.radius = 0.5;
    this.display = { name: 'NPC' };
    this.ai = {
      state: 'idle',      // idle | wander
      targetDir: { x: 0, z: 0 },
      timer: 0,
      speed: 0.8,
      homeX: 0,
      homeZ: 0,
    };
  }

  serializeExtra() {
    return { name: this.display.name };
  }
}
