/**
 * 本地预测模块（Prediction / Client-Side Prediction）
 *
 * 需求：客户端预测保持流畅，服务端后校验不通过则退回。
 *
 * 实现：
 *  - 纯 2D 水平物理模拟（摩擦/加速度/地形碰撞 + 物理层实体阻挡），
 *    以 20Hz（50ms）步进，保证与服务端权威模拟逐位对齐。
 *  - 输入即时生效（零延迟），并上报预测位置 px/py/pz 供服务端防作弊校验。
 *  - 收到服务端 correction 时把预测状态硬回退（rollback）到权威位置。
 *  - 渲染层在两帧预测状态之间线性插值，保证 60fps 视觉平滑。
 *  - Y 轴由渲染层对齐 terrainHeight，不参与物理模拟（无跳跃/重力）。
 *  - NPC/怪物阻挡在物理层生效（_collideEntities 直接修正 this.pos 并上报）：
 *    服务端 handleInput 无条件采纳「可达 + 地形可通行」的上报位置，故角色真正被
 *    挡住而非穿过；渲染直接插值物理位置，不再有独立的碰撞推挤偏移。
 */
import { terrainHeight, terrainBlocked, terrainBlockedExact } from './terrain.js';
import { qSnap } from './protocol.js';

export const PHYS = {
  MAX_MOVE_SPEED: 7.0,
  ACCELERATION: 40.0,
  FRICTION: 12.0,
  RADIUS: 0.55,
  TICK_MS: 50, // 与服务端 tick 对齐
};
const CFG = PHYS;

// 2.5D 静态地形碰撞：圆盘（半径 r）是否与不可通行（湖泊/河流/悬崖/陡坡）重叠。
// 精确几何判定：圆心 + 3×3 邻域墙格的圆-矩形最近点检测，并在墙格凸角处做
// 尖角削角（chamfer）。替代旧的「圆心 + 8 圆周点采样」：采样在尖角处有盲区
// （漏判穿角 / 轴滑双候选同时被挡 → 挂角卡死），几何判定无方向盲区。
// exact=true ：全精度地形判定。玩家物理路径必须开启——上报位置过服务端中心点校验
//              （服务端已降为中心点判定，见 anticheat.cpp），圆心距墙/凸角满足
//              削角约束即可通过，无橡皮筋。
// exact=false：0.1m 缓存判定。怪物外推/渲染推挤等纯视觉路径用，误差不可见，性能优先。
export const CHAMFER = 0.1; // 尖角削去量（m）：凸角处碰撞边界内缩 0.1m，圆心距凸角 ≥ r−0.1 即放行

// 格点 (gx,gz)（整数坐标，即墙格角点）是否为需削角的凸角：
// 检查其 2×2 邻块的墙格数 —— 单墙转角（n==1）与对角双墙缝顶点（n==2 且对角）为凸角；
// 边中点（n==2 同行/同列）、内凹/满墙（n==3/4）、开放（n==0）不削。
// 地形 mask 静态 → 结果缓存（整数哈希键，覆盖 ±2048m 世界）。
const cornerCache = new Map();
function isCorner(gx, gz, exact = false) {
  // 16 位包装 + exact 位：地形 mask 静态常驻，|gx|,|gz| < 65536 内无冲突；
  // exact 区分全精度/缓存判定（两者对同一角点结论可能不同，不能串用缓存）。
  const k = ((gx & 0xFFFF) * 65536 + (gz & 0xFFFF)) * 2 + (exact ? 1 : 0);
  const hit = cornerCache.get(k);
  if (hit !== undefined) return hit;
  const b = exact ? terrainBlockedExact : terrainBlocked;
  const c00 = b(gx, gz) ? 1 : 0;
  const c10 = b(gx + 1, gz) ? 1 : 0;
  const c01 = b(gx, gz + 1) ? 1 : 0;
  const c11 = b(gx + 1, gz + 1) ? 1 : 0;
  const n = c00 + c10 + c01 + c11;
  const r = n === 1 || (n === 2 && ((c00 && c11) || (c01 && c10)));
  cornerCache.set(k, r);
  return r;
}

export function circleBlocked(x, z, r, exact = false) {
  const b = exact ? terrainBlockedExact : terrainBlocked;
  // 圆心在墙内 → 挡
  if (b(x, z)) return true;
  const fx = Math.floor(x), fz = Math.floor(z);
  const r2 = r * r;
  // 圆盘与 3×3 邻域墙格几何碰撞（圆-矩形最近点）
  for (let gx = fx - 1; gx <= fx + 1; gx++) {
    for (let gz = fz - 1; gz <= fz + 1; gz++) {
      if (!b(gx, gz)) continue;
      // 圆心到墙格 [gx,gx+1]×[gz,gz+1] 的最近点
      const nx = Math.max(gx, Math.min(x, gx + 1));
      const nz = Math.max(gz, Math.min(z, gz + 1));
      const dx = x - nx, dz = z - nz;
      const d2 = dx * dx + dz * dz;
      // 最近点落在墙格角点（圆心在角点对角象限）→ 凸角削角：距凸角 < r−CHAMFER 才挡；
      // 非凸角角点（边中点/内凹）维持 r。最近点在边上 → 距边 < r 挡。
      const atCorner = (nx === gx || nx === gx + 1) && (nz === gz || nz === gz + 1);
      if (atCorner) {
        const lim = r - (isCorner(nx, nz, exact) ? CHAMFER : 0);
        if (lim > 0 && d2 < lim * lim) return true;
      } else if (d2 < r2) {
        return true;
      }
    }
  }
  return false;
}
// 8 向单位向量表：与服务端 collision.cpp 的 kEscapeDir 是同一组字面量。
// 不用 Math.cos/Math.sin —— libm 与 JS Math 的三角函数末位 ulp 可能不同，
// 边界探测点会因此选到不同方向，破坏双端同构。
const ESCAPE_DIR = [
  [1.0, 0.0],
  [0.7071067811865476, 0.7071067811865476],
  [0.0, 1.0],
  [-0.7071067811865476, 0.7071067811865476],
  [-1.0, 0.0],
  [-0.7071067811865476, -0.7071067811865476],
  [0.0, -1.0],
  [0.7071067811865476, -0.7071067811865476],
];
const ESCAPE_STEP = 0.2;   // = 服务端 Collision::kEscapeStep
const ESCAPE_RINGS = 5;    // = 服务端 Collision::kEscapeRings（最大脱困半径 1.0m）
/** 脱困搜索：(ox,oz) 自身落在阻挡区时，由近及远做 8 向探测，取最近的严格可通行点。
 *  找到返回 {x,z}，搜遍全部环仍无落点返回 null。与服务端 Collision::escapeBlocked 同构。
 *  仅在 slideMove 兜底分支（起点已被阻挡的退化态）触发，不影响正常移动热路径。 */
export function escapeBlocked(ox, oz, r, exact = false) {
  for (let ring = 1; ring <= ESCAPE_RINGS; ring++) {
    const d = ESCAPE_STEP * ring;
    for (let i = 0; i < 8; i++) {
      const cx = ox + ESCAPE_DIR[i][0] * d;
      const cz = oz + ESCAPE_DIR[i][1] * d;
      if (!circleBlocked(cx, cz, r, exact)) return { x: cx, z: cz };
    }
  }
  return null;
}
// 尖角削角滑动：轴滑双候选被挡（卡在凸角尖上）时，沿削角圆弧切向滑过尖角。
// 找到距圆心 < r 的最近凸角点，把移动向量投影到「以角点为圆心、半径 r−CHAMFER
// 的圆弧」的切线上，落点贴弧面并保留切向分量（角色绕弧滑过尖角而非退回原点）。
// 仅向量代数（无三角函数），返回 false 表示无适用凸角/落点仍被挡，交由调用方兜底。
function cornerSlide(e, ox, oz, nx, nz, r, exact = false) {
  const lim = r - CHAMFER;
  if (lim <= 0) return false;
  const fx = Math.floor(nx), fz = Math.floor(nz);
  const r2 = r * r;
  let best = null, bestD2 = lim * lim;
  for (let ix = fx - 1; ix <= fx + 1; ix++) {
    for (let iz = fz - 1; iz <= fz + 1; iz++) {
      if (!isCorner(ix, iz, exact)) continue;
      const dx = nx - ix, dz = nz - iz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r2 && d2 <= bestD2) { bestD2 = d2; best = [ix, iz]; }
    }
  }
  if (!best) return false;
  const px = best[0], pz = best[1];
  const d = Math.sqrt(bestD2) || 1e-9;
  const nxx = (nx - px) / d, nzz = (nz - pz) / d;  // 角点→圆心 径向单位
  const tx = -nzz, tz = nxx;                        // 圆弧切向
  const vx = nx - ox, vz = nz - oz;
  const vt = vx * tx + vz * tz;                     // 移动向量切向分量
  const cx = px + nxx * lim + tx * vt;
  const cz = pz + nzz * lim + tz * vt;
  if (!circleBlocked(cx, cz, r, exact)) { e.x = cx; e.z = cz; return true; }
  return false;
}
// 沿轴滑动回退：实体已从 (ox,oz) 移到 (nx,nz)，与障碍重叠时逐轴尝试，模拟沿墙滑动
export function slideMove(e, ox, oz, nx, nz, r, exact = false) {
  if (!circleBlocked(nx, nz, r, exact)) { e.x = nx; e.z = nz; return false; }
  // X 轴单独尝试（沿 X 滑动 → 结果 (nx, oz)）
  const okX = !circleBlocked(nx, oz, r, exact);
  // Z 轴单独尝试（沿 Z 滑动 → 结果 (ox, nz)）
  const okZ = !circleBlocked(ox, nz, r, exact);
  if (okX && okZ) {
    if (Math.abs(nx - ox) >= Math.abs(nz - oz)) { e.x = nx; e.z = oz; }
    else { e.x = ox; e.z = nz; }
  } else if (okX) {
    e.x = nx; e.z = oz;
  } else if (okZ) {
    e.x = ox; e.z = nz;
  } else {
    // 兜底：三个滑动候选全被阻挡。先试尖角削角滑动（卡在凸角尖上的场景）——
    // 沿削角圆弧切向滑过尖角；失败再退回起点/脱困搜索（同旧实现）。旧实现无条件
    // 退回起点 (ox,oz)，但起点自身也可能落在阻挡区（出生/复活用点判定而非圆盘判定、
    // 被外力改写 pos、mask 运行时变更），此时退回起点等于永久卡死：每次上报都判
    // terrain_blocked，服务端 clampToWalkable 又因锚点不可通行而放弃夹紧，客户端被
    // 反复校正回同一个坑里。故脱困搜索保留。
    const cs = cornerSlide(e, ox, oz, nx, nz, r, exact);
    if (cs) return true;
    if (circleBlocked(ox, oz, r, exact)) {
      const esc = escapeBlocked(ox, oz, r, exact);
      if (esc) { e.x = esc.x; e.z = esc.z; return true; }
    }
    e.x = ox; e.z = oz;
  }
  return true;
}

/**
 * 纯 2D 水平物理步进（加速度/摩擦/地形碰撞）：
 * 给定 sim 状态 {x,z,vx,vz,radius} 与目标水平速度 (tx,tz)，推进一个 dt 步长。
 * Y 轴不参与模拟（渲染层对齐 terrainHeight）。
 * 玩家预测（Predictor）与怪物/AI 外推（entities.js）复用同一实现。
 * @param {boolean} exact 地形判定精度：玩家=true（上报位置需与服务端逐位一致），怪物=false（纯视觉，走缓存）
 */
export function stepSim(s, tx, tz, dt, exact = false) {
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
  // 2) 水平摩擦
  const hSpeed = Math.hypot(nvx, nvz);
  if (hSpeed > 0) {
    const ns = Math.max(0, hSpeed - PHYS.FRICTION * dt);
    const sc = ns / hSpeed;
    nvx *= sc; nvz *= sc;
  }
  // 3) 积分水平位置
  let nx = s.x + nvx * dt;
  let nz = s.z + nvz * dt;
  // 3.5) 上报量化对齐：先把积分结果吸附到协议的 0.01m 格，**再做**碰撞判定。
  //      服务端收到并校验的是 dqAbs(qAbs(pos)) == 吸附值；在未吸附值上判定可通行，
  //      等于让服务端去校验一个客户端从未验证过的点（每轴 ±0.005m，地形边界处
  //      足以翻转圆盘判定）→ 走容差夹紧 → correction 往返 → 橡皮筋。
  //      吸附后 (ox,oz) 与 (nx,nz) 同在格点上，slideMove 的三个候选 (nx,oz)/(ox,nz)/(ox,oz)
  //      也都在格点上 → 整条碰撞解算链闭合在 0.01m 格内，「上报值 == 已验证值」恒成立。
  //      唯一例外是 escapeBlocked 的斜向脱困点（含 √2/2，非格点），下一 tick 自动复位。
  //      注：qSnap 用 JS Math.round（半数向上）而服务端 qAbs 用 std::lround（半数远离零），
  //      仅在 v*100 恰好落在 n+0.5 时相差 0.01m —— 这是协议层的既有差异，由服务端
  //      terrainToleranceM 容差完全吸收。
  nx = qSnap(nx);
  nz = qSnap(nz);
  // 4) 2D 静态地形碰撞：圆盘与不可通行重叠 → 沿轴滑动回退
  if (circleBlocked(nx, nz, s.radius, exact)) {
    const tmp = { x: nx, z: nz };
    slideMove(tmp, ox, oz, nx, nz, s.radius, exact);
    nx = tmp.x; nz = tmp.z;
  }
  s.x = nx; s.z = nz; s.vx = nvx; s.vz = nvz;
}

export class Predictor {
  constructor() {
    this.pos = { x: 0, y: 5, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.moveX = 0;
    this.moveZ = 0;
    this._acc = 0;          // 累积到 50ms 的步进计时
    this._prevPos = null;   // 上一个 tick 的位置（用于渲染插值）
    this._tickFrac = 0;     // 当前 tick 内进度 [0,1)
    this._nearby = [];      // 附近实体列表（用于物理层实体阻挡）
    this._radius = CFG.RADIUS;
    this.speedMul = 1.0;    // 速度倍率（含减速/加速 buff，由外部每帧更新）
  }

  /** 从服务端 welcome/快照设置起始位置 */
  setPosition(x, y, z) {
    this.pos = { x, y, z };
    this.vel = { x: 0, y: 0, z: 0 };
    this._prevPos = { ...this.pos };
    this._acc = 0;
    this._tickFrac = 0;
  }

  /** 更新速度倍率（减速/加速 buff 综合结果，0..N） */
  setSpeedMul(mul) {
    this.speedMul = Math.max(0.05, mul);
  }

  /** 应用最新输入（moveX/moveZ 归一化 [-1,1]） */
  applyInput(moveX, moveZ) {
    this.moveX = moveX;
    this.moveZ = moveZ;
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
    // 渲染插值位置：XZ 线性插值，Y 基于地形高度精确贴地（避免陡坡线性插值伪影）
    if (this._prevPos) {
      const f = Math.min(1, Math.max(0, this._tickFrac));
      const ix = this._prevPos.x + (this.pos.x - this._prevPos.x) * f;
      const iz = this._prevPos.z + (this.pos.z - this._prevPos.z) * f;
      return {
        x: ix,
        y: terrainHeight(ix, iz) + CFG.RADIUS,
        z: iz,
      };
    }
    return { ...this.pos };
  }

  /** 更新附近实体列表（用于物理层实体阻挡） */
  setNearbyEntities(entities) {
    this._nearby = entities || [];
  }

  /**
   * 物理层实体阻挡：把 this.pos 从与附近实体（NPC/怪物/其他玩家）的重叠中推出到
   * 「刚好接触」。直接修正 this.pos（= 上报服务端的纯物理位置），使角色真正被挡住、
   * 不再穿过。服务端 handleInput 无条件采纳「可达 + 地形可通行」的上报位置，故停住
   * 不会触发回退，其他玩家视角与服务端权威位置也同步停在实体边缘。
   *
   * 算法：投影到接触圆（而非沿法线推 overlap）——只消除径向重叠分量、保留切向分量，
   * 玩家会自然贴着实体圆弧滑过，正对中心时稳定停住不抖动。
   *
   * 关键约束：
   *  - 格点闭合：推挤结果必须 qSnap 回 0.01m 格点，再用 exact=true 全精度复检地形。
   *    encodeInput 上报时对坐标做 qAbs 量化；若在未格点化的推挤位置上判定可通行，
   *    服务端校验的却是量化后格点（差 ±0.005m），地形边界处足以翻转圆盘判定 →
   *    terrain_blocked 回退（橡皮筋）。
   *  - 地形优先于实体：推挤若导致落入不可通行区则放弃该次推挤，绝不把玩家推进墙/空洞；
   *    被夹在实体与地形之间时保持原地，交由 stepSim 的 slideMove/escapeBlocked 与下一
   *    tick 处理。
   */
  _collideEntities() {
    if (this._nearby.length === 0) return;
    let px = this.pos.x, pz = this.pos.z;
    const checkR = this._radius + 2.0, checkR2 = checkR * checkR;  // 距离预过滤
    let count = 0;
    for (const e of this._nearby) {
      if (e.dying) continue;                             // 死亡动画中的实体不阻挡
      const rE = e.radius || 0.5, minD = this._radius + rE;
      let dx = px - e.x, dz = pz - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > checkR2 || d2 >= minD * minD) continue;   // 太远 / 未重叠
      let d = Math.sqrt(d2);
      if (d < 1e-6) {                                    // 圆心重合兜底：沿移动反方向推出，避免 n=NaN
        const sp = Math.hypot(this.vel.x, this.vel.z);
        if (sp > 1e-6) { dx = -this.vel.x / sp; dz = -this.vel.z / sp; }
        else { dx = 1; dz = 0; }
        d = 1;
      }
      const nx = dx / d, nz = dz / d;
      // 投影到接触圆 → 格点闭合 → exact 地形复检，通过才采纳
      const gx = qSnap(e.x + nx * minD), gz = qSnap(e.z + nz * minD);
      if (!circleBlocked(gx, gz, this._radius, true)) { px = gx; pz = gz; }
      if (++count >= 8) break;                           // 单 tick 上限，防极端拥挤卡顿
    }
    this.pos.x = px; this.pos.z = pz;
  }

  /** 单次 50ms 物理步进（纯 2D 水平物理 + 物理层实体阻挡，直接作用于 this.pos） */
  _tickStep() {
    const dt = CFG.TICK_MS / 1000;
    // 1) 输入 → 目标水平速度（归一化 * maxSpeed）
    const len = Math.hypot(this.moveX, this.moveZ);
    let tx = 0, tz = 0;
    if (len > 1e-4) {
      tx = (this.moveX / len) * CFG.MAX_MOVE_SPEED * this.speedMul;
      tz = (this.moveZ / len) * CFG.MAX_MOVE_SPEED * this.speedMul;
    }
    // 2) 纯 2D 水平物理步进（加速度/摩擦/地形碰撞）→ 写入 this.pos（纯物理位置）
    //    exact=true：玩家位置会上报服务端并接受同款全精度地形校验，
    //    若走 0.1m 缓存则地形边界处客户端放行/服务端拒绝 → terrain_blocked 回退。
    const sim = {
      x: this.pos.x, z: this.pos.z,
      vx: this.vel.x, vz: this.vel.z,
      radius: CFG.RADIUS,
    };
    stepSim(sim, tx, tz, dt, true);
    this.pos.x = sim.x; this.pos.z = sim.z;
    this.vel.x = sim.vx; this.vel.z = sim.vz;
    // 3) 物理层实体阻挡：被 NPC/怪物挡住时直接修正 this.pos（上报位置），角色真正
    //    停在实体边缘而非穿过。详见 _collideEntities 注释。
    this._collideEntities();
    // Y 轴贴地：与服务端 moveEntityCollide 一致，纯 2D 物理后重算地表高度。
    // 用缓存版即可：服务端 handleInput 会用 terrainHeight(px,pz) 重算并忽略上报的 py，
    // 且 Y 不参与任何防作弊校验（纯 XZ 平面），0.05m 视觉误差不可见。
    this.pos.y = terrainHeight(this.pos.x, this.pos.z) + CFG.RADIUS;
  }

  /** 服务端校正回退：硬拉到权威位置（rollback） */
  correction(x, y, z) {
    this.setPosition(x, y, z);
  }

  /** 纯物理位置（上报服务端用；物理层已含实体阻挡，故被挡住时上报的即停住位置） */
  predicted() {
    return { ...this.pos };
  }

  /** 渲染位置（插值物理位置，Y 基于地形高度贴地）。
   *  物理层已做实体阻挡，this.pos 即被挡住后的真实位置，渲染直接插值即可，
   *  不再需要额外的碰撞推挤偏移（原 _renderOffset 已移除）。 */
  renderPos() {
    const f = Math.min(1, Math.max(0, this._tickFrac));
    let ix, iz;
    if (this._prevPos) {
      ix = this._prevPos.x + (this.pos.x - this._prevPos.x) * f;
      iz = this._prevPos.z + (this.pos.z - this._prevPos.z) * f;
    } else {
      ix = this.pos.x;
      iz = this.pos.z;
    }
    return {
      x: ix,
      y: terrainHeight(ix, iz) + CFG.RADIUS,
      z: iz,
    };
  }
}
