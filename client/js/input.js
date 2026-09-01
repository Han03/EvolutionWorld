/**
 * 输入模块：键盘（WASD/方向键 + 空格跳跃）
 * 固定俯视角 MMO：视角固定，移动直接映射到世界坐标（W=向屏幕上方=-z，与协议 moveZ 一致）
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
    this.skillQueued = 0;      // 技能栏热键（1-8）：最近一次按下的技能 ID
    window.addEventListener('keydown', (e) => {
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
      // 技能栏热键（数字 1-8 → 技能栏顺序）
      if (e.code.startsWith('Digit')) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 8) this.skillQueued = n;
      }
      this.keys.add(e.code);
      // 阻止方向键滚动页面
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }
  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }
  /**
   * 计算世界坐标移动向量（固定俯视：屏幕上方 = -z，右侧 = +x）
   * 返回 { x, z }，归一化到 [-1,1]
   */
  moveVector() {
    let vert = 0;
    let strafe = 0;
    if (this.isDown('KeyW', 'ArrowUp')) vert += 1;
    if (this.isDown('KeyS', 'ArrowDown')) vert -= 1;
    if (this.isDown('KeyD', 'ArrowRight')) strafe += 1;
    if (this.isDown('KeyA', 'ArrowLeft')) strafe -= 1;
    let mx = strafe;   // 右 = +x
    let mz = -vert;    // 上 = -z
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    return { x: mx, z: mz };
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
  /** 消费技能栏热键信号（数字 1-8 → 技能槽位） */
  takeSkillSlot() {
    const n = this.skillQueued;
    this.skillQueued = 0;
    return n;
  }
}
