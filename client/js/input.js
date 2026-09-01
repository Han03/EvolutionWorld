/**
 * 输入模块：键盘（WASD/方向键 + 空格跳跃）
 * 固定俯视角 MMO：视角固定，移动直接映射到世界坐标（W=向屏幕上方=-z，与协议 moveZ 一致）
 */
export class InputState {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.jumpQueued = false; // 边沿触发，发送后清除
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
}
