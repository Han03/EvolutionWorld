/**
 * 移动系统
 * 对玩家应用目标水平速度（加速度模型）并做物理积分。
 */
import { BaseSystem } from './base-system.js';

export class MoveSystem extends BaseSystem {
  constructor(world, config) {
    super(world, config);
    this.priority = 20;
  }

  update(dt) {
    // 玩家移动
    for (const player of this.world.players.values()) {
      const t = player.input._targetVX ?? 0;
      const z = player.input._targetVZ ?? 0;
      this.world.physics.setHorizontalVelocity(player, t, z, dt);
      this.world.physics.step(player, dt);
      if (process.env.EW_DEBUG && this.world._tick % 10 === 0) {
        console.log(
          `[DBG] ${player.id} target=(${t.toFixed(1)},${z.toFixed(1)}) vel=(${player.vel.x.toFixed(2)},${player.vel.z.toFixed(2)}) pos=(${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)})`
        );
      }
    }

    // AI 实体（怪物/NPC）移动：由 AI 系统给出目标速度
    for (const e of this.world.entities.values()) {
      if (e.kind === 'player') continue;
      if (!e.active) continue;
      const t = e.ai?.targetVX ?? 0;
      const z = e.ai?.targetVZ ?? 0;
      this.world.physics.setHorizontalVelocity(e, t, z, dt);
      this.world.physics.step(e, dt);
    }
  }
}
