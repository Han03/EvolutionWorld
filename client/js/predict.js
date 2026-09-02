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
import { terrainHeight, terrainBlocked } from './terrain.js';

export const PHYS = {
  GRAVITY: -9.81,
  JUMP_VELOCITY: 7.0,
  MAX_MOVE_SPEED: 7.0,
  ACCELERATION: 40.0,
  FRICTION: 12.0,
  RADIUS: 0.55,
  TICK_MS: 50, // 与服务端 tick 对齐
};
const CFG = PHYS;

// 2.5D 静态地形碰撞（与服务端 collision.cpp 逐位一致）：
// 圆盘（半径 r）是否与不可通行（湖泊/河流/悬崖/陡坡）重叠：中心 + 圆周 8 点采样
export function circleBlocked(x, z, r) {
  if (terrainBlocked(x, z)) return true;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (terrainBlocked(x + r * Math.cos(a), z + r * Math.sin(a))) return true;
  }
  return false;
}
// 沿轴滑动回退（与服务端 Collision::slideMove 一致）：实体已从 (ox,oz) 移到 (nx,nz)，
// 与障碍重叠时逐轴尝试，模拟沿墙滑动
export function slideMove(e, ox, oz, nx, nz, r) {
  if (!circleBlocked(nx, nz, r)) { e.x = nx; e.z = nz; return false; }
  // X 轴单独尝试（沿 X 滑动 → 结果 (nx, oz)）
  const okX = !circleBlocked(nx, oz, r);
  // Z 轴单独尝试（沿 Z 滑动 → 结果 (ox, nz)）
  const okZ = !circleBlocked(ox, nz, r);
  if (okX && okZ) {
    if (Math.abs(nx - ox) >= Math.abs(nz - oz)) { e.x = nx; e.z = oz; }
    else { e.x = ox; e.z = nz; }
  } else if (okX) {
    e.x = nx; e.z = oz;
  } else if (okZ) {
    e.x = ox; e.z = nz;
  } else {
    e.x = ox; e.z = oz;
  }
  return true;
}

/**
 * 通用确定性物理步进（服务端权威，与 moveEntityCollide + Physics::step + setHorizontalVelocity 逐位一致）：
 * 给定 sim 状态 {x,y,z,vx,vy,vz,grounded,radius} 与目标水平速度 (tx,tz)，推进一个 dt 步长。
 * 玩家预测（Predictor）与怪物/AI 外推（entities.js）复用同一实现，保证客户端推演与服务端一致。
 */
export function stepSim(s, tx, tz, dt) {
  const ox = s.x, oz = s.z;
  // 1) 水平速度向目标逼近（加速度模型，同服务端 Physics::setHorizontalVelocity）
  let nvx, nvz;
  {
    const dx = tx - s.vx, dz = tz - s.vz;
    const d = Math.hypot(dx, dz);
    const accel = PHYS.ACCELERATION * dt;
    if (d <= accel) { nvx = tx; nvz = tz; }
    else { const k = accel / d; nvx = s.vx + dx * k; nvz = s.vz + dz * k; }
  }
  // 2) 重力（同服务端 Physics::step）
  let nvy = s.vy + PHYS.GRAVITY * dt;
  // 3) 水平摩擦
  const hSpeed = Math.hypot(nvx, nvz);
  if (hSpeed > 0) {
    const ns = Math.max(0, hSpeed - PHYS.FRICTION * dt);
    const sc = ns / hSpeed;
    nvx *= sc; nvz *= sc;
  }
  // 4) 积分位置（ox/oz 在积分前取值，供滑动回退——与服务端一致）
  let nx = s.x + nvx * dt;
  let ny = s.y + nvy * dt;
  let nz = s.z + nvz * dt;
  // 5) 2.5D 静态地形碰撞：圆盘与不可通行重叠 → 沿轴滑动回退
  if (circleBlocked(nx, nz, s.radius)) {
    const tmp = { x: nx, z: nz };
    slideMove(tmp, ox, oz, nx, nz, s.radius);
    nx = tmp.x; nz = tmp.z;
  }
  // 6) 地表碰撞（滑动后重新贴地）
  const gy = terrainHeight(nx, nz);
  const foot = gy + s.radius;
  let gnd;
  if (ny <= foot) { ny = foot; nvy = 0; gnd = true; } else { gnd = false; }
  s.x = nx; s.y = ny; s.z = nz; s.vx = nvx; s.vy = nvy; s.vz = nvz; s.grounded = gnd;
}

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
        this.vel.y = CFG.JUMP_VELOCITY;
        this.grounded = false;
      }
    }
    // 3-8) 通用确定性物理步进（与服务端 moveEntityCollide 逐位一致；与怪物外推复用同一实现）
    const sim = {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      vx: this.vel.x, vy: this.vel.y, vz: this.vel.z,
      grounded: this.grounded, radius: CFG.RADIUS,
    };
    stepSim(sim, tx, tz, dt);
    this.pos.x = sim.x; this.pos.y = sim.y; this.pos.z = sim.z;
    this.vel.x = sim.vx; this.vel.y = sim.vy; this.vel.z = sim.vz;
    this.grounded = sim.grounded;
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
