/**
 * AI 系统
 * 空壳阶段的简单 AI：怪物/NPC 在出生点附近随机游走。
 * 仅模拟「玩家可见范围（100m）内」的实体，避免全图开销 —— 与区块加载联动。
 * 预留扩展位：行为树、仇恨、巡逻路线、对话触发等。
 */
import { BaseSystem } from './base-system.js';

export class AISystem extends BaseSystem {
  constructor(world, config) {
    super(world, config);
    this.priority = 30;
    this._rand = (n) => Math.random() * 2 - 1;
  }

  update(dt) {
    for (const e of this.world.entities.values()) {
      if (e.kind === 'player' || !e.active || !e.ai) continue;
      // 只有处于某个玩家视野内的实体才被模拟（可配置）
      if (!this.world.chunks.isEntityVisible(e)) continue;

      const ai = e.ai;
      ai.timer -= dt;
      if (ai.timer <= 0) {
        // 重新选择游走方向
        const wanderRadius = e.kind === 'npc' ? 10 : 25;
        ai.targetDir = { x: this._rand(), z: this._rand() };
        ai.timer = 2 + Math.random() * 4;
        ai.state = 'wander';
      }
      // 限制 NPC 在出生点附近活动
      const homeX = ai.homeX ?? e.pos.x;
      const homeZ = ai.homeZ ?? e.pos.z;
      let tx = ai.targetDir.x * ai.speed;
      let tz = ai.targetDir.z * ai.speed;
      if (Math.hypot(e.pos.x - homeX, e.pos.z - homeZ) > 20) {
        // 走太远则折返
        const back = Math.atan2(homeX - e.pos.x, homeZ - e.pos.z);
        tx = Math.sin(back) * ai.speed;
        tz = Math.cos(back) * ai.speed;
      }
      ai.targetVX = tx;
      ai.targetVZ = tz;
    }
  }
}
