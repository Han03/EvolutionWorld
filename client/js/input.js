/**
 * 输入模块：键盘（WASD/方向键 + 空格跳跃）+ 鼠标拖拽旋转视角
 */
export class InputState {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.jumpQueued = false; // 边沿触发，发送后清除
    this.yaw = 0;            // 相机水平角
    this.pitch = 0.52;       // 相机俯仰
    this._drag = { active: false, lx: 0, ly: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      this.keys.add(e.code);
      // 阻止方向键滚动页面
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    domElement.addEventListener('mousedown', (e) => {
      this._drag.active = true;
      this._drag.lx = e.clientX;
      this._drag.ly = e.clientY;
    });
    window.addEventListener('mouseup', () => (this._drag.active = false));
    window.addEventListener('mousemove', (e) => {
      if (!this._drag.active) return;
      const dx = e.clientX - this._drag.lx;
      const dy = e.clientY - this._drag.ly;
      this._drag.lx = e.clientX;
      this._drag.ly = e.clientY;
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(0.15, Math.min(1.25, this.pitch + dy * 0.004));
    });
  }

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /**
   * 计算世界坐标移动向量（相对相机朝向），返回 { x, z }
   * forward: 朝向；right: 右方向
   */
  moveVector() {
    const fwd = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    const right = { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };

    let vert = 0;
    let strafe = 0;
    if (this.isDown('KeyW', 'ArrowUp')) vert += 1;
    if (this.isDown('KeyS', 'ArrowDown')) vert -= 1;
    if (this.isDown('KeyD', 'ArrowRight')) strafe += 1;
    if (this.isDown('KeyA', 'ArrowLeft')) strafe -= 1;

    let mx = fwd.x * vert + right.x * strafe;
    let mz = fwd.z * vert + right.z * strafe;
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
}
