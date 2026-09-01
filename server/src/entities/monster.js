/**
 * 怪物实体（空壳阶段为可移动的红色圆球）
 * 后续可挂载战斗、AI 行为树、掉落等系统。
 */
import { Entity } from './entity.js';

export class Monster extends Entity {
  constructor(id) {
    super(id, 'monster');
    this.radius = 0.5;
    this.display = { name: 'Monster' };
    this.ai = {
      state: 'idle',      // idle | wander | chase(预留)
      targetDir: { x: 0, z: 0 },
      timer: 0,
      speed: 1.5,
    };
  }

  serializeExtra() {
    return { name: this.display.name };
  }
}
