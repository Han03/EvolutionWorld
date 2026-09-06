/**
 * minimap.js — MMORPG 风格小地图（右上角罗盘）
 *  俯视地形概览 + 实体标点 + 玩家标记箭头 + 罗盘刻度 + 迷雾渐晕
 *  地形渲染到带 margin 的离屏 canvas，通过 drawImage 源矩形平滑滚动，
 *  仅当玩家接近 buffer 边缘时才重绘（大幅降低重绘频率，消除卡顿）。
 *  2D 俯视角：小地图正北朝上，与相机方向一致，无需旋转。
 */
import { terrainColor, terrainBlocked, terrainHeight, WATER_LEVEL, walkMaskReady } from './terrain.js';

const TAU = Math.PI * 2;

export class Minimap {
  constructor(containerId) {
    // ── 可调参数 ──
    this.SIZE       = 160;       // 显示尺寸 (CSS px)
    this.BORDER     = 4;         // 金边宽度 (px)
    this.TERRAIN_RES = 2;        // 地形采样步长 (m/px)，越大越快但越粗糙

    // 三档可视范围（米）：小=近距详细 / 中=默认 / 大=远距概览
    this._zoomLevels = [120, 220, 360];
    this._zoomIndex  = 1;        // 默认中
    this.VIEW_RANGE  = this._zoomLevels[this._zoomIndex];

    // ── DOM ──
    this.container = document.getElementById(containerId);
    this.canvas    = this.container.querySelector('.minimap-canvas');
    this.ctx       = this.canvas.getContext('2d');

    // ── 离屏地形缓存（带 margin 平滑滚动） ──
    this._tc = document.createElement('canvas');
    this._tx = this._tc.getContext('2d');

    this._initSize();
    this._bindEvents();
    this._updateBtn();
  }

  /* ═══════════ 初始化 ═══════════ */

  _initSize() {
    // canvas 内部分辨率必须匹配 CSS 显示尺寸（SIZE + 两侧 BORDER），
    // 否则浏览器缩放 drawImage 时亚像素坐标会产生偏移（近/中视角尤为明显）
    const s = this.SIZE + this.BORDER * 2;
    this.canvas.width  = s;
    this.canvas.height = s;
    this._cssSize = s;
    // 离屏 buffer 按最大缩放档位计算，保证所有档位都有足够数据
    this._TM = 30;   // margin (buffer px)：滚动缓冲区
    this._TR = 10;   // trigger (buffer px)：重绘阈值，必须 < _TM
    const maxRange = Math.max(...this._zoomLevels);
    const maxVisBuf = Math.ceil(maxRange / this.TERRAIN_RES);
    const bufPx = maxVisBuf + this._TM * 2;
    this._tc.width  = bufPx;
    this._tc.height = bufPx;
    this._cx = 0;            // buffer 中心的世界坐标
    this._cz = 0;
    this._sx = this._TM;     // 当前源偏移 (buffer px)
    this._sy = this._TM;
    this._dirty = true;      // 地形缓存脏标记
  }

  _bindEvents() {
    const btn = this.container.querySelector('.minimap-toggle');
    if (btn) btn.addEventListener('click', () => this._cycleZoom());
  }

  _cycleZoom() {
    this._zoomIndex = (this._zoomIndex + 1) % this._zoomLevels.length;
    this.VIEW_RANGE = this._zoomLevels[this._zoomIndex];
    this._dirty = true;
    this._updateBtn();
  }

  _updateBtn() {
    const labels = ['近', '中', '远'];
    const btn = this.container.querySelector('.minimap-toggle');
    if (btn) btn.textContent = labels[this._zoomIndex];
  }

  /** 外部调用：强制重绘地形（编辑器修改地形后调用） */
  invalidate() { this._dirty = true; }

  /* ═══════════ 地形颜色采样 ═══════════ */

  _sampleColor(wx, wz) {
    if (terrainBlocked(wx, wz)) {
      // 不可通行区域：天空蓝（浮岛间空隙）
      return [140, 190, 230];
    }
    const h = terrainHeight(wx, wz);
    if (h < WATER_LEVEL) {
      // 河床/湖底 → 沙泥色
      return [148, 134, 92];
    }
    // 取地形着色 → 压暗 + 微暖化 → 复古地图风格
    const tc = terrainColor(wx, wz);
    return [
      Math.round(tc.r * 175 + 18),
      Math.round(tc.g * 168 + 12),
      Math.round(tc.b * 148 + 8),
    ];
  }

  /* ═══════════ 地形预渲染 ═══════════ */

  _renderTerrain(px, pz) {
    const w   = this._tc.width;
    const h   = this._tc.height;
    const res = this.TERRAIN_RES;
    const img = this._tx.createImageData(w, h);
    const d   = img.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wx = px + (x - w / 2) * res;
        const wz = pz + (y - h / 2) * res;
        const [r, g, b] = this._sampleColor(wx, wz);
        const i = (y * w + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    this._tx.putImageData(img, 0, 0);
    this._cx = px;
    this._cz = pz;
    // 源偏移不在这里重置——由 update() 根据当前 visBuf 计算正确中心
    this._dirty = false;
  }

  /* ═══════════ 每帧渲染 ═══════════ */

  /**
   * @param {number} px  玩家 X
   * @param {number} pz  玩家 Z
   * @param {Array}  ents  实体列表（forRender() 返回值，不含自身）
   */
  update(px, pz, ents) {
    const res   = this.TERRAIN_RES;
    const sz    = this._cssSize;
    const inner = sz - this.BORDER * 2;
    const half  = inner / 2;
    const mid   = sz / 2;
    const range = this.VIEW_RANGE;
    const scale = inner / range;   // px per meter

    // ── 平滑滚动：玩家移动 → 偏移源矩形，仅在接近 buffer 边缘时重绘 ──
    const visBuf    = this.VIEW_RANGE / res;
    const maxVisBuf = this._tc.width - this._TM * 2;
    // 源矩形基准偏移：使 buffer 中心（玩家世界位置）对齐可视区中心
    // visBuf == maxVisBuf（远视角）时 srcOff == _TM；近/中视角时 srcOff > _TM
    const srcOff    = this._TM + (maxVisBuf - visBuf) / 2;

    if (this._dirty) {
      this._renderTerrain(px, pz);
      this._sx = srcOff;
      this._sy = srcOff;
    } else {
      const dx = px - this._cx;
      const dz = pz - this._cz;
      // 世界位移 → buffer 像素偏移（同方向：玩家右移 → 源右移 → 地形左滚）
      this._sx = srcOff + dx / res;
      this._sy = srcOff + dz / res;
      // 偏移接近 margin 极限 → 重绘 buffer 以玩家为中心
      // 有效边距 = _TM - (_TM - _TR) = _TR，保证各缩放档重绘频率一致
      if (Math.abs(dx) >= this._TR * res || Math.abs(dz) >= this._TR * res) {
        this._renderTerrain(px, pz);
        this._sx = srcOff;
        this._sy = srcOff;
      }
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, sz, sz);

    // ── 1. 圆形裁剪 ──
    ctx.save();
    ctx.beginPath();
    ctx.arc(mid, mid, half, 0, TAU);
    ctx.clip();

    // ── 2. 底色（未探索区域 → 天空蓝） ──
    ctx.fillStyle = '#8cbfe6';
    ctx.fillRect(0, 0, sz, sz);

    // ── 3. 地形（从离屏 buffer 裁切可见区域 → 平滑滚动） ──
    if (walkMaskReady()) {
      ctx.drawImage(
        this._tc,
        this._sx, this._sy, visBuf, visBuf,  // 源：buffer 内裁切
        this.BORDER, this.BORDER, inner, inner // 目标：主 canvas 可视区
      );
    }

    // ── 4. 迷雾渐晕（边缘柔和过渡，匹配天空浮岛主题） ──
    const fog = ctx.createRadialGradient(mid, mid, half * 0.45, mid, mid, half);
    fog.addColorStop(0, 'rgba(140,190,230,0)');
    fog.addColorStop(0.7, 'rgba(140,190,230,0.10)');
    fog.addColorStop(1, 'rgba(140,190,230,0.40)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, sz, sz);

    // ── 5. 实体标点 ──
    if (ents) {
      for (const e of ents) {
        const dx = (e.x - px) * scale;
        const dz = (e.z - pz) * scale;
        if (dx * dx + dz * dz > half * half) continue;  // 圆外跳过
        const sx = mid + dx;
        const sy = mid + dz;

        let color, radius;
        if (e.isElite) {
          color = '#a855f7'; radius = 3;
        } else {
          switch (e.kind) {
            case 'player':  color = '#4ade80'; radius = 2.5; break;
            case 'monster': color = '#f87171'; radius = 2;   break;
            case 'npc':     color = '#60a5fa'; radius = 2.5; break;
            case 'item':    color = '#fbbf24'; radius = 1.5; break;
            default:        color = '#888';    radius = 1.5; break;
          }
        }

        // 发光
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 1.5, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();

        // 实心点
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // ── 4. 玩家标记（金色六边形） ──
    this._drawPlayer(ctx, mid, mid);

    // ── 5. 罗盘刻度 + 方向文字（固定指北） ──
    this._drawCompass(ctx, mid, mid, half);

    // ── 6. 金色边框 ──
    this._drawBorder(ctx, mid, half);

    ctx.restore();  // 取消裁剪
  }

  /* ═══════════ 绘制子程序 ═══════════ */

  _drawPlayer(ctx, x, y) {
    const r = 5;
    ctx.save();
    // 外发光
    ctx.beginPath();
    ctx.arc(x, y, r + 3, 0, TAU);
    ctx.fillStyle = 'rgba(201,168,76,0.25)';
    ctx.fill();

    // 六边形主体
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i - Math.PI / 2;
      const vx = x + r * Math.cos(a);
      const vy = y + r * Math.sin(a);
      i === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fillStyle = '#c9a84c';
    ctx.fill();
    ctx.strokeStyle = '#1a1400';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 北方方向三角（小箭头从六边形顶部伸出）
    ctx.beginPath();
    ctx.moveTo(x, y - r - 3);
    ctx.lineTo(x - 2.5, y - r + 1);
    ctx.lineTo(x + 2.5, y - r + 1);
    ctx.closePath();
    ctx.fillStyle = '#e8d48b';
    ctx.fill();

    ctx.restore();
  }

  _drawCompass(ctx, mid, half) {
    // 主刻度（每 30°）
    ctx.strokeStyle = 'rgba(201,168,76,0.45)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI / 6) * i - Math.PI / 2;
      const r0 = half - 1;
      const r1 = half + 3;
      ctx.beginPath();
      ctx.moveTo(mid + r0 * Math.cos(a), mid + r0 * Math.sin(a));
      ctx.lineTo(mid + r1 * Math.cos(a), mid + r1 * Math.sin(a));
      ctx.stroke();
    }

    // 副刻度（每 15°，短刻度）
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 24; i++) {
      if (i % 2 === 0) continue;
      const a = (Math.PI / 12) * i - Math.PI / 2;
      const r0 = half - 1;
      const r1 = half + 1.5;
      ctx.beginPath();
      ctx.moveTo(mid + r0 * Math.cos(a), mid + r0 * Math.sin(a));
      ctx.lineTo(mid + r1 * Math.cos(a), mid + r1 * Math.sin(a));
      ctx.stroke();
    }

    // 方向文字
    ctx.font = 'bold 9px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const dirs = [
      { label: 'N', angle: -Math.PI / 2, color: '#e57373' },
      { label: 'S', angle:  Math.PI / 2, color: 'rgba(201,168,76,0.5)' },
      { label: 'E', angle:  0,           color: 'rgba(201,168,76,0.5)' },
      { label: 'W', angle:  Math.PI,     color: 'rgba(201,168,76,0.5)' },
    ];
    const labelR = half + 11;
    for (const d of dirs) {
      ctx.fillStyle = d.color;
      ctx.fillText(
        d.label,
        mid + labelR * Math.cos(d.angle),
        mid + labelR * Math.sin(d.angle)
      );
    }
  }

  _drawBorder(ctx, mid, half) {
    // 外圈（暗底）
    ctx.beginPath();
    ctx.arc(mid, mid, half + this.BORDER, 0, TAU);
    ctx.strokeStyle = '#1a1400';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 金环
    ctx.beginPath();
    ctx.arc(mid, mid, half + 1, 0, TAU);
    ctx.strokeStyle = '#c9a84c';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 内环线（细）
    ctx.beginPath();
    ctx.arc(mid, mid, half - 1, 0, TAU);
    ctx.strokeStyle = 'rgba(201,168,76,0.2)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // 外发光
    ctx.beginPath();
    ctx.arc(mid, mid, half + this.BORDER + 1, 0, TAU);
    ctx.strokeStyle = 'rgba(201,168,76,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}
