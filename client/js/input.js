/**
 * 输入模块：鼠标点击地面移动 + 键盘（WASD/方向键 + 空格跳跃）
 * 固定俯视角 MMO：视角固定，移动直接映射到世界坐标（W=向屏幕上方=-z，与协议 moveZ 一致）
 * 移动优先级：WASD/方向键 > 鼠标点击目标（按键盘即取消点击移动）
 */
export class InputState {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.jumpQueued = false; // 边沿触发，发送后清除
    this.attackQueued = false; // J：攻击世界实体（世界怪物/Boss）
    this.shopQueued = false;   // B：附近商店 NPC 打开商店
    this.invToggleQueued = false; // I：切换背包/装备面板
    this.pickupQueued = false; // E：主动拾取
    this.questToggleQueued = false; // L：切换任务日志面板
    this.socialToggleQueued = 0;    // 1=好友(F) / 2=公会(G) / 3=聊天(Enter)
    this.skillQueued = 0;      // 技能栏热键（1-8）：最近一次按下的技能 ID
    // ---- 鼠标点击移动 ----
    this.clickTarget = null;   // {x, z} 世界坐标目标点；null = 无
    this.terrainRenderer = null; // 由 boot.js 设置，用于 s2w 屏幕→世界转换
    this._setupClickToMove();
    window.addEventListener('keydown', (e) => {
      // 当焦点在输入框时忽略游戏输入（聊天/好友添加/公会搜索等）
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      // WASD/方向键按下时取消点击移动目标
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
        this.clickTarget = null;
      }
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (e.code === 'KeyJ') {
        this.attackQueued = true;
      }
      if (e.code === 'KeyB') {
        this.shopQueued = true;
      }
      if (e.code === 'KeyI') {
        this.invToggleQueued = true;
      }
      if (e.code === 'KeyE') {
        this.pickupQueued = true;
      }
      if (e.code === 'KeyL') {
        this.questToggleQueued = true;
      }
      if (e.code === 'KeyF') {
        this.socialToggleQueued = 1; // 好友面板
      }
      if (e.code === 'KeyG') {
        this.socialToggleQueued = 2; // 公会面板
      }
      if (e.code === 'Enter') {
        this.socialToggleQueued = 3; // 聊天面板
        e.preventDefault();
      }
      // 技能栏热键：1-9 数字 → 槽 1-9；0/-/= → 槽 10/11/12；Q/R/T/Y → 槽 13-16
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 9) this.skillQueued = n;
      } else if (e.code === 'Digit0') {
        this.skillQueued = 10;
      } else if (e.code === 'Minus') {
        this.skillQueued = 11;
      } else if (e.code === 'Equal') {
        this.skillQueued = 12;
      } else if (e.code === 'KeyQ') {
        this.skillQueued = 13;
      } else if (e.code === 'KeyR') {
        this.skillQueued = 14;
      } else if (e.code === 'KeyT') {
        this.skillQueued = 15;
      } else if (e.code === 'KeyY') {
        this.skillQueued = 16;
      }
      this.keys.add(e.code);
      // 阻止方向键滚动页面
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }
  /** 设置地形渲染器引用（boot.js 初始化后调用） */
  setTerrainRenderer(tr) {
    this.terrainRenderer = tr;
  }
  /** 鼠标点击移动：canvas 右键/左键点击地面 → 世界坐标目标 */
  _setupClickToMove() {
    this.dom.addEventListener('click', (e) => {
      if (!this.terrainRenderer) return;
      // 忽略 UI 元素上的点击
      if (e.target !== this.dom) return;
      const rect = this.dom.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const world = this.terrainRenderer.s2w(px, py);
      this.clickTarget = { x: world.x, z: world.z };
    });
    // 右键也支持（兼容习惯）
    this.dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.terrainRenderer) return;
      const rect = this.dom.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const world = this.terrainRenderer.s2w(px, py);
      this.clickTarget = { x: world.x, z: world.z };
    });
  }
  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }
  /**
   * 计算世界坐标移动向量（固定俯视：屏幕上方 = -z，右侧 = +x）
   * @param {Object} [selfPos] - 当前角色世界坐标 {x, z}（用于点击移动方向计算）
   * 返回 { x, z }，归一化到 [-1,1]
   */
  moveVector(selfPos) {
    // 键盘输入优先
    let vert = 0;
    let strafe = 0;
    if (this.isDown('KeyW', 'ArrowUp')) vert += 1;
    if (this.isDown('KeyS', 'ArrowDown')) vert -= 1;
    if (this.isDown('KeyD', 'ArrowRight')) strafe += 1;
    if (this.isDown('KeyA', 'ArrowLeft')) strafe -= 1;
    if (vert !== 0 || strafe !== 0) {
      let mx = strafe;   // 右 = +x
      let mz = -vert;    // 上 = -z
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }
      return { x: mx, z: mz };
    }
    // 鼠标点击移动：朝目标点方向
    if (this.clickTarget && selfPos) {
      const dx = this.clickTarget.x - selfPos.x;
      const dz = this.clickTarget.z - selfPos.z;
      const dist = Math.hypot(dx, dz);
      // 到达阈值（0.3m）：停止移动，清除目标
      if (dist < 0.3) {
        this.clickTarget = null;
        return { x: 0, z: 0 };
      }
      return { x: dx / dist, z: dz / dist };
    }
    return { x: 0, z: 0 };
  }
  /** 消费跳跃边沿信号 */
  takeJump() {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }
  /** 消费攻击边沿信号（J） */
  takeAttack() {
    const a = this.attackQueued;
    this.attackQueued = false;
    return a;
  }
  /** 消费打开商店信号（B） */
  takeShop() {
    const s = this.shopQueued;
    this.shopQueued = false;
    return s;
  }
  /** 消费背包面板切换信号（I） */
  takeInvToggle() {
    const s = this.invToggleQueued;
    this.invToggleQueued = false;
    return s;
  }
  /** 消费主动拾取信号（E） */
  takePickup() {
    const s = this.pickupQueued;
    this.pickupQueued = false;
    return s;
  }
  /** 消费任务面板切换信号（L） */
  takeQuestToggle() {
    const s = this.questToggleQueued;
    this.questToggleQueued = false;
    return s;
  }
  /** 消费社交面板切换信号（F/G/Enter） */
  takeSocialToggle() {
    const n = this.socialToggleQueued;
    this.socialToggleQueued = 0;
    return n;
  }
  /** 消费技能栏热键信号（数字 1-8 → 技能槽位） */
  takeSkillSlot() {
    const n = this.skillQueued;
    this.skillQueued = 0;
    return n;
  }
}
