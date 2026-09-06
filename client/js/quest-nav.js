/**
 * quest-nav.js — 任务目标自动寻路导航
 *
 * 状态机：IDLE → NAVIGATING → ARRIVED → IDLE
 * 玩家在任务追踪 HUD 点击目标旁的导航按钮后，角色自动寻路到目标位置。
 * 到达后停止移动，等待玩家下一步操作（手动逐步模式）。
 *
 * 目标解析：
 *   reach  → 直接使用任务配置的 x/z 坐标
 *   kill   → 在视野实体中查找匹配 targetKey 的怪物
 *   talk   → 在视野实体中查找匹配 wid 的 NPC
 *   collect→ 先找地面掉落物，再找掉落该物品的怪物
 *
 * 取消条件：玩家新点击 / 按键 / 死亡 / 目标实体消失
 */

// 到达判定阈值（米）
const ARRIVE = { reach: 2.0, talk: 3.0, kill: 2.5, collect: 2.0, escort: 2.0 };

// 目标类型数字 → 字符串（S2C_QUEST_PROGRESS 下发数字，gamedata 使用字符串）
const OBJ_TYPE_NAME = { 1: 'kill', 2: 'collect', 3: 'reach', 4: 'talk', 5: 'escort' };

export class QuestNavigator {
  constructor() {
    this.state = 'idle';           // idle | navigating | arrived
    this.objective = null;         // {questId, objIndex, type, targetKey, targetId, x, z, desc}
    this.targetPos = null;         // {x, z} 导航终点
    this.arrivedAt = 0;            // 到达时间戳
    this._trackedWid = 0;          // 追踪的实体 wid（kill/talk/collect 时）
    this._navMouseDown = false;    // 导航期间鼠标是否按下
    this._prevMouseDown = false;   // 上一帧鼠标按下状态
    this._navKeyPressed = false;   // 导航期间是否按了键
    this._rippleCd = 0;           // 波纹冷却（每 2s 在目标位置画波纹）
    this._onChange = null;        // 状态变化回调（UI 刷新用）

    // 由 boot.js 注入
    this.input = null;
    this.entities = null;
    this.predictor = null;
    this.renderer = null;
    this.S = null;                 // 共享状态（读取 gamedata/selfDead 等）
  }

  // ═══════════ 对外 API ═══════════

  /** 开始导航到指定任务目标 */
  navigate(questId, objIndex) {
    const gamedata = this.S && this.S._gamedata;
    if (!gamedata || !gamedata.quests) return false;
    const qDef = gamedata.quests.find(q => q.id === questId);
    if (!qDef || !qDef.objectives || !qDef.objectives[objIndex]) return false;

    const objDef = qDef.objectives[objIndex];
    const type = this._normType(objDef.type);
    const pos = this._resolveTarget(type, objDef);
    if (!pos) {
      this._toast('目标不在附近，无法自动寻路');
      return false;
    }

    this.objective = {
      questId, objIndex, type,
      targetKey: objDef.targetKey || '',
      targetId: objDef.targetId || 0,
      x: objDef.x || 0, z: objDef.z || 0,
      desc: objDef.desc || '',
    };
    this.targetPos = { x: pos.x, z: pos.z };
    this._trackedWid = pos.wid || 0;
    this.state = 'navigating';
    // 初始化鼠标状态：同步当前 _mouseHeld，避免导航发起的 mousedown 被误判为“新点击”
    const curMouse = this.input ? !!this.input._mouseHeld : false;
    this._navMouseDown = curMouse;
    this._prevMouseDown = curMouse;
    this._navKeyPressed = false;
    this._rippleCd = 0;

    // 设置移动目标（复用 A* 寻路）
    if (this.input) {
      this.input.clickTarget = { x: pos.x, z: pos.z };
      this.input.pathfinder.clear();
    }
    // 在目标位置画波纹
    if (this.renderer) this.renderer.addClickRipple(pos.x, pos.z);
    this._toast(`正在导航：${this.objective.desc}`);
    this._notifyChange();
    return true;
  }

  /** 取消当前导航 */
  cancel() {
    if (this.state === 'navigating') {
      this._toast('已取消导航');
    }
    this.state = 'idle';
    this.objective = null;
    this.targetPos = null;
    this._trackedWid = 0;
    this._navKeyPressed = false;
    this._notifyChange();
  }

  /** 每帧由主循环调用 */
  tick() {
    if (!this.S || !this.predictor || !this.input) return;
    const now = performance.now();

    // 更新鼠标按下边沿检测
    this._prevMouseDown = this._navMouseDown;
    this._navMouseDown = !!(this.input._mouseHeld);

    if (this.state === 'idle') return;

    // ── 死亡取消 ──
    if (this.S.selfDead) { this.cancel(); return; }

    // ── 导航中 ──
    if (this.state === 'navigating') {
      // 取消：新点击（非导航发起的那次）
      const freshClick = this._navMouseDown && !this._prevMouseDown;
      if (freshClick) { this.cancel(); return; }

      // 取消：按键
      if (this._navKeyPressed) { this.cancel(); return; }

      const selfPos = this.predictor.predicted();

      // 动态追踪：更新实体目标位置（移动中的怪物/NPC）
      if (this._trackedWid && this.targetPos) {
        this._updateTrackedTarget();
      }

      if (!this.targetPos) { this.cancel(); return; }

      // 检测到达
      const dist = Math.hypot(this.targetPos.x - selfPos.x, this.targetPos.z - selfPos.z);
      const threshold = ARRIVE[this.objective.type] || 2.0;
      if (dist < threshold) {
        this.state = 'arrived';
        this.arrivedAt = now;
        this.input.clickTarget = null;
        this.input.pathfinder.clear();
        if (this.renderer) this.renderer.addClickRipple(this.targetPos.x, this.targetPos.z);
        this._toast(`已到达：${this.objective.desc}`);
        return;
      }

      // 确保移动目标持续设置（路径走完后续上）
      if (!this.input.clickTarget) {
        this.input.clickTarget = { x: this.targetPos.x, z: this.targetPos.z };
      }

      // 定期在目标位置画波纹（每 2.5s）
      this._rippleCd -= 1 / 60;
      if (this._rippleCd <= 0 && this.renderer) {
        this.renderer.addClickRipple(this.targetPos.x, this.targetPos.z);
        this._rippleCd = 2.5;
      }
    }

    // ── 到达后自动回 idle ──
    if (this.state === 'arrived') {
      if (now - this.arrivedAt > 500) {
        this.state = 'idle';
        this.objective = null;
        this.targetPos = null;
        this._trackedWid = 0;
        this._notifyChange();
      }
    }
  }

  /** 按键取消钩子（由 boot.js 在 keydown 时调用） */
  onKeyPressed() { this._navKeyPressed = true; }

  /** 当前是否正在导航 */
  isNavigating() { return this.state === 'navigating'; }

  /** 获取当前导航目标（UI 高亮用） */
  getActiveObjective() { return this.objective; }

  // ═══════════ 内部方法 ═══════════

  /** 统一目标类型字符串 */
  _normType(t) {
    const s = String(t);
    return OBJ_TYPE_NAME[s] || s;
  }

  /**
   * 根据目标类型解析导航终点
   * @returns {x, z, wid?} 或 null（目标不可达/不在视野）
   */
  _resolveTarget(type, objDef) {
    switch (type) {
      case 'reach':
        return { x: objDef.x || 0, z: objDef.z || 0 };

      case 'talk':
        return this._findNpcTarget(objDef.targetId);

      case 'kill':
        return this._findMonsterTarget(objDef.targetKey);

      case 'collect':
        return this._findCollectTarget(objDef.targetId, objDef.targetKey);

      default:
        return null;
    }
  }

  /** 查找 NPC 目标（按 wid 精确匹配） */
  _findNpcTarget(npcWid) {
    if (!this.entities) return null;
    for (const v of this.entities.views.values()) {
      if (v.kind !== 'npc' || v.dying) continue;
      if (npcWid && v.wid !== npcWid) continue;
      return { x: v.x, z: v.z, wid: v.wid };
    }
    return null;
  }

  /** 查找怪物目标（按 targetKey 匹配怪物名称） */
  _findMonsterTarget(targetKey) {
    if (!this.entities) return null;
    const nameSet = this._monsterNameSet(targetKey);
    let best = null, bestD = Infinity;
    const selfPos = this.predictor ? this.predictor.predicted() : { x: 0, z: 0 };
    for (const v of this.entities.views.values()) {
      if (v.kind !== 'monster' || v.dying) continue;
      if (v.hp !== undefined && v.hp <= 0) continue;
      if (nameSet.size && !nameSet.has(v.name)) continue;
      const d = Math.hypot(v.x - selfPos.x, v.z - selfPos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) return null;
    return { x: best.x, z: best.z, wid: best.wid };
  }

  /** 查找收集目标（先找掉落物，再找掉落该物品的怪物） */
  _findCollectTarget(itemId, targetKey) {
    if (!this.entities) return null;
    const selfPos = this.predictor ? this.predictor.predicted() : { x: 0, z: 0 };

    // 1) 地面掉落物
    let best = null, bestD = Infinity;
    for (const v of this.entities.views.values()) {
      if (v.kind !== 'item' || v.dying) continue;
      if (itemId && v.itemId !== itemId) continue;
      const d = Math.hypot(v.x - selfPos.x, v.z - selfPos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return { x: best.x, z: best.z, wid: best.wid };

    // 2) 掉落该物品的怪物
    if (!itemId) return null;
    const gamedata = this.S && this.S._gamedata;
    if (!gamedata || !gamedata.monsters) return null;
    const monsters = Array.isArray(gamedata.monsters)
      ? gamedata.monsters
      : Object.entries(gamedata.monsters).map(([key, v]) => ({ ...v, key }));
    const dropKeys = new Set();
    for (const m of monsters) {
      if ((m.drops || []).some(d => d.item === itemId)) dropKeys.add(m.name);
    }
    best = null; bestD = Infinity;
    for (const v of this.entities.views.values()) {
      if (v.kind !== 'monster' || v.dying) continue;
      if (v.hp !== undefined && v.hp <= 0) continue;
      if (!dropKeys.has(v.name)) continue;
      const d = Math.hypot(v.x - selfPos.x, v.z - selfPos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) return null;
    return { x: best.x, z: best.z, wid: best.wid };
  }

  /** 根据 targetKey 构建怪物名称集合（兼容 gamedata 字典/数组格式） */
  _monsterNameSet(targetKey) {
    const nameSet = new Set();
    if (!targetKey || targetKey === '*') return nameSet;
    const gamedata = this.S && this.S._gamedata;
    if (!gamedata || !gamedata.monsters) return nameSet;
    const monsters = Array.isArray(gamedata.monsters)
      ? gamedata.monsters
      : Object.entries(gamedata.monsters).map(([key, v]) => ({ ...v, key }));
    const m = monsters.find(x => x.key === targetKey || x.name === targetKey);
    if (m && m.name) nameSet.add(m.name);
    nameSet.add(targetKey);
    return nameSet;
  }

  /** 动态更新追踪目标的位置（实体移动时跟随） */
  _updateTrackedTarget() {
    if (!this._trackedWid || !this.entities) return;
    const v = this.entities.views.get(this._trackedWid);
    if (!v || v.dying) {
      // 实体消失/死亡 → 尝试重新查找同类目标
      const re = this._reacquireTarget();
      if (!re) {
        this._toast('目标已消失');
        this.cancel();
      }
      return;
    }
    const newX = v.x, newZ = v.z;
    const oldX = this.targetPos.x, oldZ = this.targetPos.z;
    // 只在实体移动超过 1m 时更新目标（避免 A* 频繁重算）
    if (Math.hypot(newX - oldX, newZ - oldZ) > 1.0) {
      this.targetPos = { x: newX, z: newZ };
      // 重新设置 clickTarget 触发寻路
      if (this.input) {
        this.input.clickTarget = { x: newX, z: newZ };
      }
    }
  }

  /** 重新获取同类目标（当前追踪目标消失时） */
  _reacquireTarget() {
    if (!this.objective) return null;
    const { type, targetKey, targetId } = this.objective;
    let pos = null;
    if (type === 'kill') pos = this._findMonsterTarget(targetKey);
    else if (type === 'talk') pos = this._findNpcTarget(targetId);
    else if (type === 'collect') pos = this._findCollectTarget(targetId, targetKey);
    if (pos) {
      this.targetPos = { x: pos.x, z: pos.z };
      this._trackedWid = pos.wid || 0;
      if (this.input) this.input.clickTarget = { x: pos.x, z: pos.z };
      return pos;
    }
    return null;
  }

  /** Toast 提示 */
  _toast(text) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast show';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.className = 'toast'; }, 2000);
  }

  /** 状态变化时通知 UI 刷新 */
  _notifyChange() { if (this._onChange) this._onChange(); }
}
