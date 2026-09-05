/**
 * 实体数据管理（二进制协议版，Canvas 2D 圆形渲染）
 *  - 当前角色：橙色圆圈 / 其他玩家：绿色圆圈 / 怪物：红色圆圈 / NPC：蓝色圆圈
 *
 * 怪物同步（消除 rubber-banding，重构后）：
 *  - 服务端广播「移动意图」（aiState + 目标速度 + 速度倍率）+ 权威位置/瞬时速度；
 *  - 客户端对每个怪物/NPC/精英维护一份与服务端同款物理的确定性推演（sim，复用 predict.js stepSim），
 *    收到意图后按 20Hz 步进外推，不再用指数衰减朝最新位置追赶；
 *  - 渲染走「快照插值」：hist 存最近 4 个推演快照，渲染时钟落后一拍（renderClock ≤ simTime-1），
 *    在两份快照间线性插值平滑输出 60fps——吸收速度量化抖动；
 *    相机同步延迟一帧（boot.js），使实体与相机时间参考系对齐，消除视差偏移；
 *  - AI 推演增加静态地形碰撞（circleBlocked），防止旧意图下怪物走入空洞/水域后闪回；
 *  - 收到新权威位置时分级处理：偏差≤噪声阈值忽略（信任外推）→ 偏差≤快照阈值平滑收敛归位 →
 *    超阈值硬快照（瞬移，仅网络级失步触发）。
 */
import { KIND, MASK } from './protocol.js';
import { stepSim, PHYS, circleBlocked } from './predict.js';
import { terrainHeight } from './terrain.js';

const KIND_NAME = { [KIND.PLAYER]: 'player', [KIND.MONSTER]: 'monster', [KIND.NPC]: 'npc', [KIND.ITEM]: 'item' };
const TICK_SEC = PHYS.TICK_MS / 1000;      // 0.05s（与服务端 tick 对齐）
const SNAP_M = 3.0;                        // 权威位置偏差超此值 → 硬快照（瞬移）
const CONVERGE_M = 0.15;                   // 偏差低于此值 → 噪声内忽略（信任确定性外推）
const CORR_RATE = 0.35;                    // 平滑收敛：每 tick 收敛剩余偏差的比例
const CORR_MAX_TICKS = 8;                  // 平滑收敛最大持续 tick 数
const AI_KINDS = new Set(['monster', 'npc']);

export class EntityViewManager {
  // 死亡动画时长（ms）：淡出 + 下沉
  DEATH_ANIM_MS = 1100;
  constructor(selfWid) {
    this.selfWid = selfWid;
    this.views = new Map(); // wid -> view
    this._renderArr = [];     // 复用渲染数组
    this._renderPool = new Map(); // wid -> 复用对象
  }
  _kindName(kind) { return KIND_NAME[kind] || 'monster'; }
  _isAi(v) { return AI_KINDS.has(v.kind); }

  /** ENTER：实体进入视野 */
  applyEnter(entities) {
    for (const e of entities) {
      if (e.wid === this.selfWid) continue;
      if (this.views.has(e.wid)) {
        this._onAuthoritative(this.views.get(e.wid), e);
      } else {
        this._create(e);
      }
    }
  }
  /** LEAVE：实体离开视野（死亡动画中的实体延迟到动画播完再移除） */
  applyLeave(wids) {
    const now = performance.now();
    for (const wid of wids) {
      const v = this.views.get(wid);
      if (v && v.dying && now - v.dyingAt < this.DEATH_ANIM_MS) {
        v.leavePending = true; // 动画播完后移除
        continue;
      }
      this.views.delete(wid);
    }
  }
  /** 死亡：进入死亡动画状态（渲染层播放淡出+下沉） */
  applyDeath(wid) {
    const v = this.views.get(wid);
    if (!v) return;
    v.dying = true;
    v.dyingAt = performance.now();
    v.dieY = v.y; // 记录死亡时高度，用于下沉动画
  }
  /** 复活：清除死亡动画状态（恢复可见；精英/其他玩家复活时服务端广播） */
  applyRespawn(wid) {
    const v = this.views.get(wid);
    if (!v) return;
    v.dying = false;
    v.dyingAt = 0;
    v.leavePending = false;
  }
  /** UPDATE：增量更新（位置已在协议层解码为绝对坐标） */
  applyUpdate(updates) {
    for (const u of updates) {
      const v = this.views.get(u.wid);
      if (!v) continue;
      if (this._isAi(v)) {
        // —— AI 实体（怪物/NPC/精英）：确定性外推 + 权威校正 ——
        if (u.mask & MASK.POS) {
          const vx = (u.mask & MASK.VEL) ? u.vx : undefined;
          const vz = (u.mask & MASK.VEL) ? u.vz : undefined;
          this._authoritativePos(v, u.x, u.y, u.z, vx, vz);
        }
        if (u.mask & MASK.INTENT) {
          v.intent.has = true;
          v.intent.state = u.aiState;
          v.intent.tx = u.tx;
          v.intent.tz = u.tz;
          v.intent.mult = u.speedMult !== undefined ? u.speedMult : 100;
          // 怪物生命值（服务端 INTENT 块对齐）
          if (u.hp !== undefined) { v.hp = u.hp; v.maxHp = u.maxHp; }
        }
        if (u.state !== undefined) v.state = u.state;
      } else {
        // —— 其他玩家：保持轻量 lerp（玩家移动由自身输入驱动，无意图可外推）——
        if (u.mask & MASK.POS) { v.tx = u.x; v.ty = u.y; v.tz = u.z; }
        if (u.state !== undefined) v.state = u.state;
      }
    }
  }
  /** SNAPSHOT：校准重建（丢包/失步自愈） */
  applySnapshot(entities) {
    const seen = new Set();
    for (const e of entities) {
      if (e.wid === this.selfWid) continue;
      seen.add(e.wid);
      if (this.views.has(e.wid)) {
        this._onAuthoritative(this.views.get(e.wid), e);
      } else {
        this._create(e);
      }
    }
    for (const wid of this.views.keys()) {
      if (!seen.has(wid)) this.views.delete(wid);
    }
  }
  /** 世界精英全局共享帧（S2C_ELITE）：位置作为另一路权威校正（与实体 UPDATE 一致） */
  applyElitePos(wid, x, y, z) {
    const v = this.views.get(wid);
    if (!v || !this._isAi(v)) return;
    this._authoritativePos(v, x, y, z, undefined, undefined);
  }

  // —— AI 实体：创建 / 权威校正 / 确定性推演 / 快照插值 ——
  _create(e) {
    const v = {
      wid: e.wid,
      kind: this._kindName(e.kind),
      name: e.name || (e.kind === KIND.PLAYER ? `玩家${e.wid}` : ''),
      state: e.state,
      dying: false,
    };
    // NPC 插件：存储 npcId + npcTag（客户端据此渲染交互菜单）
    if (e.kind === KIND.NPC) {
      v.npcId = e.npcId || '';
      v.npcTag = e.npcTag || 0;
    }
    // 掉落物：存储 itemId/gold + 装备实例（instId!=0 为装备，携带强化等级）
    if (e.kind === KIND.ITEM) {
      v.itemId = e.itemId || 0;
      v.gold = e.gold || 0;
      v.dropInstId = e.dropInstId || 0;
      v.dropEnhance = e.dropEnhance || 0;
    }
    if (this._isAi(v)) {
      // 确定性推演状态（世界绝对坐标；radius 来自服务端广播，碰撞逐位一致）
      v.sim = {
        x: e.x, y: e.y, z: e.z,
        vx: e.vx || 0, vy: 0, vz: e.vz || 0,
        grounded: true,
        radius: e.radius || 0.5,
      };
      // 移动意图（ENTER 全量即携带；缺失时回退为惯性滑行 = 步骤①纯客户端外推）
      v.intent = {
        has: e.aiState !== undefined,
        state: e.aiState !== undefined ? e.aiState : 0,
        tx: e.tx !== undefined ? e.tx : (e.vx || 0),
        tz: e.tz !== undefined ? e.tz : (e.vz || 0),
        mult: e.speedMult !== undefined ? e.speedMult : 100,
      };
      // 怪物生命值（仇恨血条渲染）
      if (e.kind === KIND.MONSTER) {
        v.hp = e.hp || 0;
        v.maxHp = e.maxHp || 0;
      }
      v.hist = [{ t: 0, x: e.x, y: e.y, z: e.z }];
      v.simTime = 0;
      v.renderClock = 0;
      v.acc = 0;
      v.corr = null;
      v.x = e.x; v.y = e.y; v.z = e.z;
    } else {
      v.x = e.x; v.y = e.y; v.z = e.z;
      v.tx = e.x; v.ty = e.y; v.tz = e.z;
      v.radius = e.radius || 0.5;   // 其他玩家半径：物理层实体阻挡用
    }
    this.views.set(e.wid, v);
  }
  /** 已有实体收到权威数据（ENTER/SNAPSHOT 全量） */
  _onAuthoritative(v, e) {
    if (this._isAi(v)) {
      this._authoritativePos(v, e.x, e.y, e.z, e.vx, e.vz);
      if (e.aiState !== undefined) {
        v.intent.has = true;
        v.intent.state = e.aiState;
        v.intent.tx = e.tx;
        v.intent.tz = e.tz;
        v.intent.mult = e.speedMult !== undefined ? e.speedMult : 100;
      }
      if (e.radius) v.sim.radius = e.radius;
      // 怪物生命值（快照校准）
      if (e.hp !== undefined) { v.hp = e.hp; v.maxHp = e.maxHp; }
      // NPC 插件：同步 npcId + npcTag（编辑器保存后热生效）
      if (v.kind === 'npc') {
        if (e.npcId !== undefined) v.npcId = e.npcId;
        if (e.npcTag !== undefined) v.npcTag = e.npcTag;
      }
    } else {
      v.tx = e.x; v.ty = e.y; v.tz = e.z;
      if (e.radius) v.radius = e.radius;
    }
  }
  /** 权威位置校正：噪声忽略 / 平滑收敛 / 硬快照 */
  _authoritativePos(v, x, y, z, vx, vz) {
    const s = v.sim;
    const d = Math.hypot(x - s.x, z - s.z);
    if (d > SNAP_M) {
      // 网络级失步：硬快照（清历史避免跨缝隙插值）
      s.x = x; s.y = y; s.z = z;
      if (vx !== undefined) { s.vx = vx; s.vz = vz; }
      v.hist = [{ t: v.simTime, x, y, z }];
      v.renderClock = v.simTime;
      v.corr = null;
    } else if (d > CONVERGE_M) {
      // 小偏差（行为切换/实体分离/LOD 间隙）：平滑收敛归位
      v.corr = { tx: x, tz: z, k: CORR_RATE, ticks: CORR_MAX_TICKS };
    }
    // else：噪声内，信任确定性外推，不打断平滑
  }
  /** 单 tick 确定性推演（与服务端 moveEntityCollide 同款物理） */
  _simTick(v) {
    const s = v.sim;
    const it = v.intent;
    // 目标速度：意图驱动；无意图回退为当前速度惯性滑行（步骤①纯客户端外推）
    let tx = it.has ? it.tx : s.vx;
    let tz = it.has ? it.tz : s.vz;
    // 平滑收敛：把 sim 位置向权威目标缓动（每 tick 收敛剩余偏差的一部分）
    if (v.corr) {
      const dx = v.corr.tx - s.x, dz = v.corr.tz - s.z;
      const rem = Math.hypot(dx, dz);
      if (rem <= 0.02) {
        s.x = v.corr.tx; s.z = v.corr.tz;
        v.corr = null;
      } else {
        s.x += dx * v.corr.k;
        s.z += dz * v.corr.k;
        if (--v.corr.ticks <= 0) v.corr = null;
      }
    }
    stepSim(s, tx, tz, TICK_SEC);
    // 贴地：stepSim 是纯 2D 水平物理，不更新 Y；
    // 坡面移动时地形高度变化，必须对齐 terrainHeight 否则球体穿入坡面。
    // 与服务端 Physics::step 地表碰撞一致：grounded 时 pos.y = terrainHeight + radius
    s.y = terrainHeight(s.x, s.z) + s.radius;
    // 地形碰撞：AI 推演也做静态地形阻挡（与服务端 moveEntityCollide 对齐），
    // 防止旧意图下怪物走入空洞/水域后等权威校正闪回
    if (circleBlocked(s.x, s.z, s.radius)) {
      // 回退到推演前位置（hist 末尾即上一 tick 的安全位置）
      const prev = v.hist.length > 0 ? v.hist[v.hist.length - 1] : null;
      if (prev) { s.x = prev.x; s.z = prev.z; }
      s.vx = 0; s.vz = 0;
      // 回退后也需重新贴地
      s.y = terrainHeight(s.x, s.z) + s.radius;
    }
    v.simTime += 1;
    v.hist.push({ t: v.simTime, x: s.x, y: s.y, z: s.z });
    if (v.hist.length > 4) v.hist.shift();
  }
  /** 从推演快照插值渲染（落后一拍缓冲，吸收速度量化抖动） */
  _renderFromHist(v) {
    const h = v.hist;
    if (h.length === 0) { v.x = v.sim.x; v.y = v.sim.y; v.z = v.sim.z; return; }
    const rt = Math.max(0, Math.min(v.simTime - 1, v.renderClock));
    if (rt <= h[0].t) { v.x = h[0].x; v.y = h[0].y; v.z = h[0].z; return; }
    const last = h[h.length - 1];
    if (rt >= last.t) { v.x = last.x; v.y = last.y; v.z = last.z; return; }
    for (let i = 0; i < h.length - 1; i++) {
      if (rt >= h[i].t && rt <= h[i + 1].t) {
        const span = h[i + 1].t - h[i].t;
        const f = span > 0 ? (rt - h[i].t) / span : 0;
        v.x = h[i].x + (h[i + 1].x - h[i].x) * f;
        v.y = h[i].y + (h[i + 1].y - h[i].y) * f;
        v.z = h[i].z + (h[i + 1].z - h[i].z) * f;
        return;
      }
    }
    v.x = last.x; v.y = last.y; v.z = last.z;
  }
  /** 每帧推进：AI 实体确定性外推 + 快照插值；其他玩家轻量 lerp */
  update(dt) {
    const now = performance.now();
    for (const [wid, v] of this.views) {
      if (v.dying && v.leavePending && now - v.dyingAt >= this.DEATH_ANIM_MS) {
        this.views.delete(wid);
        continue;
      }
      if (this._isAi(v)) {
        v.acc += dt;
        if (v.acc > 0.5) v.acc = 0.5; // 页面挂起保护：最多补 10 tick
        let stepped = 0;
        while (v.acc >= TICK_SEC && stepped < 20) {
          v.acc -= TICK_SEC;
          this._simTick(v);
          stepped++;
        }
        // 渲染时钟连续推进，但不得超前于 simTime-1（落后一拍吸收速度量化抖动）
        v.renderClock = Math.min(v.renderClock + dt / TICK_SEC, Math.max(0, v.simTime - 1));
        this._renderFromHist(v);
      } else {
        const k = 9;
        const f = Math.min(1, dt * k);
        v.x += (v.tx - v.x) * f;
        v.y += (v.ty - v.y) * f;
        v.z += (v.tz - v.z) * f;
      }
    }
  }
  /** 直接把自身实体放到预测位置（零延迟渲染 + 回退） */
  setSelf(x, y, z) {
    let v = this.views.get(this.selfWid);
    if (!v) {
      v = { wid: this.selfWid, kind: 'player', name: '', x, y, z, tx: x, ty: y, tz: z, state: 0 };
      this.views.set(this.selfWid, v);
    }
    v.x = x; v.y = y; v.z = z;
    v.tx = x; v.ty = y; v.tz = z;
  }
  /** 供渲染器每帧读取（复用数组+对象，减少 GC） */
  forRender() {
    const arr = this._renderArr;
    const pool = this._renderPool;
    let idx = 0;
    const active = new Set();
    for (const v of this.views.values()) {
      if (v.wid === this.selfWid) continue;
      active.add(v.wid);
      let o = pool.get(v.wid);
      if (!o) { o = { wid: 0, kind: '', name: '', x: 0, y: 0, z: 0, state: 0, radius: 0.5, dying: false, dyingAt: 0, dieY: 0, aiState: 0, hp: 0, maxHp: 0, npcId: '', npcTag: 0 }; pool.set(v.wid, o); }
      o.wid = v.wid; o.kind = v.kind; o.name = v.name;
      o.x = v.x; o.y = v.y; o.z = v.z; o.state = v.state;
      o.radius = this._isAi(v) ? v.sim.radius : (v.radius || 0.5);  // 真实半径：物理层实体阻挡用
      o.dying = v.dying || false; o.dyingAt = v.dyingAt || 0; o.dieY = v.dieY || v.y;
      // AI 状态 + 生命值（仇恨血条渲染）
      o.aiState = this._isAi(v) ? (v.intent.state || 0) : 0;
      o.hp = v.hp || 0;
      o.maxHp = v.maxHp || 0;
      // NPC 插件：交互菜单需要 npcTag + npcId
      if (v.kind === 'npc') { o.npcId = v.npcId || ''; o.npcTag = v.npcTag || 0; }
      arr[idx++] = o;
    }
    arr.length = idx;
    // 清理已移除实体的池对象
    for (const wid of pool.keys()) { if (!active.has(wid)) pool.delete(wid); }
    return arr;
  }
  /** 当前角色位置（相机跟随） */
  selfPosition() {
    const v = this.views.get(this.selfWid);
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 5, z: 0 };
  }
  dispose() { this.views.clear(); }
}
