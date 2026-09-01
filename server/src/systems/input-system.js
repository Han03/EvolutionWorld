/**
 * 输入系统
 * 把玩家网络输入（moveX/moveZ/jump）转成移动意图。
 * 后续可扩展：技能输入、交互输入、聊天等。
 */
import { BaseSystem } from './base-system.js';

export class InputSystem extends BaseSystem {
  constructor(world, config) {
    super(world, config);
    this.priority = 10;
  }

  update() {
    const speed = this.config.MAX_MOVE_SPEED;
    for (const player of this.world.players.values()) {
      const inp = player.input;
      // 归一化斜向移动，避免斜向速度更快
      const len = Math.hypot(inp.moveX, inp.moveZ);
      let mx = 0;
      let mz = 0;
      if (len > 1e-4) {
        mx = (inp.moveX / len) * speed;
        mz = (inp.moveZ / len) * speed;
      }
      // 以玩家朝向为准：目前未实现朝向系统，输入直接映射世界坐标
      player.input._targetVX = mx;
      player.input._targetVZ = mz;

      if (inp.jump) {
        inp.jump = false; // 消费跳Input（单次触发）
        this.world.physics.tryJump(player);
      }
    }
  }
}
