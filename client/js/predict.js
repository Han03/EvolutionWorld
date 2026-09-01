/**
 * 本地预测模块（Prediction / Client-Side Prediction）
 *
 * 需求：客户端预测保持流畅，服务端后校验不通过则退回。
 *
 * 实现：
 *  - 与服务端完全一致的物理模拟（重力/摩擦/加速度/跳跃/地形碰撞），
 *    以 20Hz（50ms）步进，保证与服务端权威模拟逐位对齐。
 *  - 输入即时生效（零延迟），并上报预测位置 px/py/pz 供服务端防作弊校验。
 *  - 收到服务端 correction 时把预测状态硬回退（rollback）到权威位置。
 *  - 渲染层在两帧预测状态之间线性插值，保证 60fps 视觉平滑。
 */
import { terrainHeight } from './glsl.js';

const CFG = {
  GRAVITY: -9.81,
  JUMP_VELOCITY: 7.0,
  MAX_MOVE_SPEED: 7.0,
  ACCELERATION: 40.0,
  FRICTION: 12.0,
  RADIUS: 0.55,
  TICK_MS: 50, // 与服务端 tick 对齐
};

export class Predictor {
  constructor() {
    this.pos = { x: 0, y: 5, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = true;
    this.moveX = 0;
    this.moveZ = 0;
    this._jumpQueued = false;
    this._acc = 0;          // 累积到 50ms 的步进计时
    this._prevPos = null;   // 上一个 tick 的位置（用于渲染插值）
    this._tickFrac = 0;     // 当前 tick 内进度 [0,1)
    this._lastStepMs = 0;
  }

  /** 从服务端 welcome/快照设置起始位置 */
  setPosition(x, y, z) {
    this.pos = { x, y, z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.grounded = true;
    this._prevPos = { ...this.pos };
    this._acc = 0;
    this._tickFrac = 0;
  }

  /** 应用最新输入（moveX/moveZ 归一化 [-1,1]，jump 边沿） */
  applyInput(moveX, moveZ, jump) {
    this.moveX = moveX;
    this.moveZ = moveZ;
    if (jump) this._jumpQueued = true;
  }

  /** 每帧调用：累积并推进 50ms 预测步进，返回渲染用插值位置 */
  step(dtSeconds) {
    this._acc += dtSeconds * 1000;
    let steps = 0;
    // 上限防止"螺旋死亡"（如页面长时间隐藏后 dt 巨大）；
    // 上限足够高（10s），正常帧率（含低帧率）下不会约束实时推进。
    while (this._acc >= CFG.TICK_MS && steps < 200) {
      this._prevPos = { ...this.pos };
      this._tickStep();
      this._acc -= CFG.TICK_MS;
      this._tickFrac = 0;
      steps++;
    }
    if (this._acc > 200 * CFG.TICK_MS) {
      // 积压过大（页面被挂起很久）：丢弃旧时间，避免瞬间"补帧"瞬移
      this._acc = 0;
    }
    if (steps > 0) {
      this._tickFrac = this._acc / CFG.TICK_MS;
    } else if (this._prevPos) {
      // 未跨 tick：继续用上一步的插值基准
      this._tickFrac = Math.min(1, this._acc / CFG.TICK_MS);
    }
    // 渲染插值位置（预测状态间线性插值，平滑 60fps）
    if (this._prevPos) {
      const f = Math.min(1, Math.max(0, this._tickFrac));
      return {
        x: this._prevPos.x + (this.pos.x - this._prevPos.x) * f,
        y: this._prevPos.y + (this.pos.y - this._prevPos.y) * f,
        z: this._prevPos.z + (this.pos.z - this._prevPos.z) * f,
      };
    }
    return { ...this.pos };
  }

  /** 单次 50ms 物理步进（必须与服务端 physics.cpp + inputSystem 一致） */
  _tickStep() {
    const dt = CFG.TICK_MS / 1000;
    const v = this.vel;
    const p = this.pos;

    // 1) 输入 → 目标水平速度（归一化 * maxSpeed）
    const len = Math.hypot(this.moveX, this.moveZ);
    let tx = 0, tz = 0;
    if (len > 1e-4) {
      tx = (this.moveX / len) * CFG.MAX_MOVE_SPEED;
      tz = (this.moveZ / len) * CFG.MAX_MOVE_SPEED;
    }

    // 2) 跳跃（边沿，仅地面）
    if (this._jumpQueued) {
      this._jumpQueued = false;
      if (this.grounded) {
        v.y = CFG.JUMP_VELOCITY;
        this.grounded = false;
      }
    }

    // 3) 水平速度向目标逼近（加速度模型，同服务端）
    {
      const dx = tx - v.x;
      const dz = tz - v.z;
      const d = Math.hypot(dx, dz);
      const accel = CFG.ACCELERATION * dt;
      if (d <= accel) {
        v.x = tx;
        v.z = tz;
      } else {
        const k = accel / d;
        v.x += dx * k;
        v.z += dz * k;
      }
    }

    // 4) 重力
    v.y += CFG.GRAVITY * dt;

    // 5) 水平摩擦
    const hSpeed = Math.hypot(v.x, v.z);
    if (hSpeed > 0) {
      const ns = Math.max(0, hSpeed - CFG.FRICTION * dt);
      const s = ns / hSpeed;
      v.x *= s;
      v.z *= s;
    }

    // 6) 积分
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // 7) 地表碰撞（同一张 SDF 地形）
    const gy = terrainHeight(p.x, p.z);
    const foot = gy + CFG.RADIUS;
    if (p.y <= foot) {
      p.y = foot;
      v.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }

  /** 服务端校正回退：硬拉到权威位置（rollback） */
  correction(x, y, z) {
    this.setPosition(x, y, z);
  }

  /** 当前预测位置（上报用） */
  predicted() {
    return { ...this.pos };
  }
}
