/**
 * 简单物理系统
 * 目前实现：
 *  - 重力
 *  - 地形高度碰撞（通过 SDF 地表高度采样，把实体保持在可走地形之上）
 *  - 水平移动的加/减速（加速度模型）
 *  - 跳跃（垂直初速度）
 * 预留扩展位：
 *  - 实体间 AABB/球体碰撞（EntityCollision 阶段）
 *  - 移动阻挡、传送门、水域等（后续系统接入）
 */
export class PhysicsWorld {
  constructor(config, terrain) {
    this.config = config;
    this.terrain = terrain;
  }

  /** 对单个实体做一帧物理积分 */
  step(entity, dt) {
    if (!entity.active) return;

    const { GRAVITY, PLAYER_RADIUS } = this.config;
    const p = entity.pos;
    const v = entity.vel;

    // 1) 重力
    v.y += GRAVITY * dt;

    // 2) 水平阻尼（停止输入时逐渐停下）
    const hSpeed = Math.hypot(v.x, v.z);
    if (hSpeed > 0) {
      const drag = this.config.FRICTION * dt;
      const newSpeed = Math.max(0, hSpeed - drag);
      const scale = newSpeed / hSpeed;
      v.x *= scale;
      v.z *= scale;
    }

    // 3) 积分位置
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // 4) 地表碰撞
    const groundY = this.terrain.terrainHeight(p.x, p.z);
    const footY = groundY + entity.radius;
    if (p.y <= footY) {
      p.y = footY;
      v.y = 0;
      entity.grounded = true;
    } else {
      entity.grounded = false;
    }
  }

  /** 触发跳跃：仅在地面时可起跳 */
  tryJump(entity) {
    if (entity.grounded) {
      entity.vel.y = this.config.JUMP_VELOCITY;
      entity.grounded = false;
      return true;
    }
    return false;
  }

  /** 设置水平目标速度（带加速度限制），由移动系统调用 */
  setHorizontalVelocity(entity, targetX, targetZ, dt) {
    const v = entity.vel;
    const cur = { x: v.x, z: v.z };
    const accel = this.config.ACCELERATION * dt;
    const d = Math.hypot(targetX - cur.x, targetZ - cur.z);
    if (d <= accel) {
      v.x = targetX;
      v.z = targetZ;
    } else {
      const k = accel / d;
      v.x = cur.x + (targetX - cur.x) * k;
      v.z = cur.z + (targetZ - cur.z) * k;
    }
  }
}
