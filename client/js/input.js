/**
 * 输入模块：鼠标点击/长按移动 + A* 自动寻路
 * 固定俯视角 MMO：视角固定，移动直接映射到世界坐标
 * 移动方式：鼠标点击目标点（自动寻路）/ 长按拖拽跟随
 * 按键系统：通过 KeybindManager 集中管理所有键盘输入
 */
import { PathFinder } from './pathfind.js';
import { KeybindManager } from './keybinds.js';

export class InputState {
  constructor(domElement) {
    this.dom = domElement;
    // ---- 按键绑定系统 ----
    this.keybinds = new KeybindManager();
    // ---- 鼠标点击移动 + 自动寻路 ----
    this.clickTarget = null;   // {x, z} 世界坐标目标点；null = 无
    this._mouseHeld = false;   // 鼠标左键是否按住（长按跟随）
    this.pathfinder = new PathFinder();  // A* 寻路器
    this.renderer = null; // 由 boot.js 设置，用于 s2w 屏幕→世界转换
    this._lastMouseScreen = null; // {x, y} 最近鼠标屏幕坐标（长按跟随用）
    this._lastCamForTarget = null; // {x, z} 设置 clickTarget 时的相机位置（相机移动补偿用）
    this._lastMoveThrottle = 0; // 上次 mousemove 处理时间戳（10ms 节流用）
    this._rippleInterval = null; // 长按波纹定时器 ID
    this._setupClickToMove();
  }
  /** 设置渲染器引用（boot.js 初始化后调用） */
  setRenderer(r) {
    this.renderer = r;
  }
  /** 鼠标点击/长按移动：左键点击自动寻路，长按拖拽持续更新路径 */
  _setupClickToMove() {
    const toWorld = (e) => {
      const rect = this.dom.getBoundingClientRect();
      return this.renderer.s2w(e.clientX - rect.left, e.clientY - rect.top);
    };
    // 左键按下：开始跟踪 + 自动寻路到点击位置
    // 注意：直接检查 e.button，不用 keybinds.poll()（canvas 监听器先于 window 触发，poll 会拿不到未写入的信号）
    this.dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.renderer) return;
      if (e.target !== this.dom) return;
      this._mouseHeld = true;
      this._lastMouseScreen = { x: e.clientX, y: e.clientY };
      const w = toWorld(e);
      this.clickTarget = { x: w.x, z: w.z };
      if (this.renderer) this.renderer.addClickRipple(w.x, w.z);
      if (this.renderer) this._lastCamForTarget = { x: this.renderer.cam.cx, z: this.renderer.cam.cz };
      // 启动长按波纹间隔（每 400ms 在当前位置绘制波纹）
      this._rippleInterval = setInterval(() => {
        if (this._mouseHeld && this.renderer && this.clickTarget) {
          this.renderer.addClickRipple(this.clickTarget.x, this.clickTarget.z);
        }
      }, 400);
    });
    // 鼠标移动：按住时持续更新目标（10ms 节流，降低操作频率）
    window.addEventListener('mousemove', (e) => {
      if (!this._mouseHeld || !this.renderer) return;
      const now = performance.now();
      if (now - this._lastMoveThrottle < 10) return;
      this._lastMoveThrottle = now;
      this._lastMouseScreen = { x: e.clientX, y: e.clientY };
      const w = toWorld(e);
      this.clickTarget = { x: w.x, z: w.z };
      if (this.renderer) this._lastCamForTarget = { x: this.renderer.cam.cx, z: this.renderer.cam.cz };
    });
    // 鼠标释放：停止拖拽，但保留路径（角色继续走向终点）
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      if (this._mouseHeld) {
        this._mouseHeld = false;
        if (this._rippleInterval) { clearInterval(this._rippleInterval); this._rippleInterval = null; }
      }
    });
  }
  /** @deprecated 相机补偿已移入 moveVector 内部，保留空方法兼容 */
  updateTargetForCamera() {}
  /**
   * 内部：根据保存的屏幕坐标 + 当前相机位置重新计算 clickTarget
   * 不依赖 renderer.s2w（其相机状态可能未更新），直接用正交投影反公式
   */
  _recalcTargetFromScreen(camX, camZ) {
    if (!this._lastMouseScreen || !this.renderer) return;
    const scale = this.renderer.cam.zoom * 10; // BASE_PX_PER_UNIT = 10，与 canvas-renderer 一致
    const cw = this.dom.clientWidth;
    const ch = this.dom.clientHeight;
    const rect = this.dom.getBoundingClientRect();
    const sx = this._lastMouseScreen.x - rect.left;
    const sy = this._lastMouseScreen.y - rect.top;
    this.clickTarget = {
      x: (sx - cw / 2) / scale + camX,
      z: (sy - ch / 2) / scale + camZ,
    };
  }
  /**
   * 计算移动向量（A* 自动寻路 / 长按跟随）
   * @param {Object} selfPos - 当前角色世界坐标 {x, y, z}
   * @param {number} camX - 当前相机 X（用于长按时补偿相机移动）
   * @param {number} camZ - 当前相机 Z
   * 返回 { x, z }，归一化到 [-1,1]
   */
  moveVector(selfPos, camX, camZ) {
    if (!selfPos) return { x: 0, z: 0 };
    // 长按跟随：相机移动后，用当前相机位置重新计算目标（在计算方向之前）
    if (this._mouseHeld && this._lastMouseScreen && this._lastCamForTarget &&
        camX !== undefined && camZ !== undefined) {
      const dx = camX - this._lastCamForTarget.x;
      const dz = camZ - this._lastCamForTarget.z;
      if (Math.abs(dx) >= 0.01 || Math.abs(dz) >= 0.01) {
        this._recalcTargetFromScreen(camX, camZ);
        this._lastCamForTarget = { x: camX, z: camZ };
      }
    }
    // 有目标 → 根据距离决定策略
    if (this.clickTarget) {
      const dist = Math.hypot(
        this.clickTarget.x - selfPos.x,
        this.clickTarget.z - selfPos.z
      );
      
      // 短距离（战斗/微操场景 < 8m）：直接直线移动，零延迟
      if (dist < 8.0) {
        this.pathfinder.clear(); // 清除旧路径，避免干扰
        if (dist < 0.3) {
          this.clickTarget = null;
          return { x: 0, z: 0 };
        }
        const dx = this.clickTarget.x - selfPos.x;
        const dz = this.clickTarget.z - selfPos.z;
        return { x: dx / dist, z: dz / dist };
      }
      
      // 长距离：使用 A* 寻路绕开障碍
      const dest = this.pathfinder.getDestination();
      if (!this.pathfinder.hasPath() ||
          !dest || Math.hypot(dest.x - this.clickTarget.x, dest.z - this.clickTarget.z) > 5.0) {
        this.pathfinder.moveTo(selfPos.x, selfPos.z, this.clickTarget.x, this.clickTarget.z);
      }
    }
    // 沿路径跟随
    const mv = this.pathfinder.getMoveVector(selfPos.x, selfPos.z);
    // 路径走完了——仅在鼠标未按住时清除目标（按住时保留以实现持续跟随）
    if (!this.pathfinder.hasPath() && !this._mouseHeld) {
      this.clickTarget = null;
    }
    return mv;
  }

  // ═══════════ 消费 API（转发到 KeybindManager） ═══════════

  /** 消费 NPC 交互信号（G） */
  takeInteract() { return this.keybinds.poll('INTERACT'); }
  /** 消费打开商店信号（B，已废弃） */
  takeShop() { return this.keybinds.poll('SHOP'); }
  /** 消费背包面板切换信号（I） */
  takeInvToggle() { return this.keybinds.poll('INVENTORY'); }
  /** 消费主动拾取信号（E） */
  takePickup() { return this.keybinds.poll('PICKUP'); }
  /** 消费任务面板切换信号（L） */
  takeQuestToggle() { return this.keybinds.poll('QUEST'); }
  /** 消费 3D 参考网格切换信号（H） */
  takeGridToggle() { return this.keybinds.poll('GRID'); }
  /** 消费社交面板切换信号（F=1 / Enter=3） */
  takeSocialToggle() {
    if (this.keybinds.poll('FRIENDS')) return 1;
    if (this.keybinds.poll('CHAT')) return 3;
    return 0;
  }
  /** 消费技能栏热键信号（1-16 槽位） */
  takeSkillSlot() {
    for (let i = 1; i <= 16; i++) {
      if (this.keybinds.poll('SKILL_' + i)) return i;
    }
    return 0;
  }

  /** 清除移动目标（NPC 交互时停止移动） */
  clearMovement() {
    this.clickTarget = null;
    this.pathfinder.clear();
    this._mouseHeld = false;
    if (this._rippleInterval) {
      clearInterval(this._rippleInterval);
      this._rippleInterval = null;
    }
  }
}
