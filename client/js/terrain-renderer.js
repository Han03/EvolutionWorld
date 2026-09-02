// terrain-renderer.js - 共享 2.5D 等距地形渲染器（editor.html + index.html 共用）
// 固定斜上方 45° 等距视角（2:1 斜等测投影），支持两种渲染模式：
//   1. chunk 流式模式（游戏）：按区块离屏画布预渲染 + 可见范围流加载，含悬崖侧壁
//   2. cell 缓存模式（编辑器）：256×256 格颜色缓存，仅按可见格绘制，画刷局部更新
// 渲染风格：可通行地形统一浅灰（按坡度微明暗），不可通行区域白色打底透出（路径地图）。
import {
  terrainHeight, terrainBlocked, WATER_LEVEL,
  TERRAIN_CHUNK, TERRAIN_RES,
} from './terrain.js';

// ---- 等距投影参数（斜上方 45°，2:1 斜等测） ----
export const ISO = 8;           // 像素/米（水平轴）
export const HS = 5;            // 像素/米（垂直高度夸张）
const PAD = 10;                 // 区块画布留白（像素）
const CELL = TERRAIN_RES;       // 地形采样粒度（米）
const CHUNK_N = TERRAIN_CHUNK / CELL;

// ---- 等距投影 ----
/** 世界 → 等距 x */
export function isoGx(wx, wz) { return (wx - wz) * ISO; }
/** 世界 → 等距 y（含高度） */
export function isoGy(wx, wy, wz) { return (wx + wz) * ISO * 0.5 - wy * HS; }

// ---- 高度色带（-2..34m：深蓝→青→绿→黄→棕→白） ----
const HSTOPS = [
  [45, 70, 160], [80, 150, 195], [110, 185, 120],
  [225, 215, 130], [175, 135, 85], [245, 245, 245],
];
export function heightColor(h) {
  const u = Math.max(0, Math.min(1, (h + 2) / 36));
  const seg = u * (HSTOPS.length - 1);
  const i = Math.min(HSTOPS.length - 2, Math.floor(seg));
  const t = seg - i;
  const a = HSTOPS[i], b = HSTOPS[i + 1];
  return {
    r: Math.round(a[0] + (b[0] - a[0]) * t),
    g: Math.round(a[1] + (b[1] - a[1]) * t),
    b: Math.round(a[2] + (b[2] - a[2]) * t),
  };
}

// ---- 基础浅灰（按坡度微明暗） ----
export function baseGray(gx, gz, h) {
  const n = terrainHeight(gx + 0.5, gz - 0.5);
  const s = terrainHeight(gx - 0.5, gz + 0.5);
  const e = terrainHeight(gx + 1.5, gz + 0.5);
  const w = terrainHeight(gx + 0.5, gz + 1.5);
  let slope = 0;
  if (h < 1e9) slope = Math.abs(h - n) + Math.abs(h - s) + Math.abs(h - e) + Math.abs(h - w);
  const shade = Math.max(0, Math.min(1, 0.12 * slope / 2));
  return Math.round(196 * (1 - shade) + 160 * shade);
}

// ---- 工具函数 ----
function fillQuad(o, A, B, C, D, style) {
  o.fillStyle = style;
  o.beginPath();
  o.moveTo(A[0], A[1]); o.lineTo(B[0], B[1]);
  o.lineTo(C[0], C[1]); o.lineTo(D[0], D[1]);
  o.closePath(); o.fill();
}

// 绘制朝相机方向的悬崖侧壁（+x 缘与 +z 缘）
function drawBankFaces(o, H, x0, z0, i, j, pts, offGx, offGy) {
  const W = pts;
  const cliff = 0.6;
  const P = (wx, wy, wz) => [isoGx(wx, wz) - offGx, isoGy(wx, wy, wz) - offGy];
  // +x 缘（B→C）
  if (i + 1 < CHUNK_N) {
    const nbTop = Math.max(H[i + 1][j], H[i + 1][j + 1]);
    const thisTop = Math.max(W.h1, W.h2);
    if (thisTop - nbTop > cliff) {
      const Bbt = P(x0 + (i + 1) * CELL, nbTop, z0 + j * CELL);
      const Cbt = P(x0 + (i + 1) * CELL, nbTop, z0 + (j + 1) * CELL);
      fillQuad(o, W.B, W.C, Cbt, Bbt, 'rgba(0,0,0,0.22)');
    }
  }
  // +z 缘（D→C）
  if (j + 1 < CHUNK_N) {
    const nbTop = Math.max(H[i][j + 1], H[i + 1][j + 1]);
    const thisTop = Math.max(W.h3, W.h2);
    if (thisTop - nbTop > cliff) {
      const Dbt = P(x0 + i * CELL, nbTop, z0 + (j + 1) * CELL);
      const Cbt = P(x0 + (i + 1) * CELL, nbTop, z0 + (j + 1) * CELL);
      fillQuad(o, W.D, W.C, Cbt, Dbt, 'rgba(0,0,0,0.16)');
    }
  }
}

// ================================================================================
// TerrainRenderer - 共享地形渲染核心
// ================================================================================
export class TerrainRenderer {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas - 目标画布
   * @param {number} [opts.worldSize=128] - 世界半径（[-ws, ws)）
   * @param {boolean} [opts.showHeight=false] - 高度色带模式
   * @param {boolean} [opts.showGrid=false] - 显示网格线
   * @param {number} [opts.gridStep=10] - 网格间距（米）
   */
  constructor({ canvas, worldSize = 128, showHeight = false, showGrid = false, gridStep = 10 }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.worldSize = worldSize;
    this.showHeight = showHeight;
    this.showGrid = showGrid;
    this.gridStep = gridStep;

    // 相机（世界坐标中心 + 缩放）
    this.cam = { cx: 0, cz: 0, zoom: 3 };

    // 区块缓存（chunk 模式）
    this._chunks = new Map();
    this._viewRange = 100;

    // 单元格缓存（cell 模式，编辑器用）
    this._cellCache = null;   // Uint32Array ABGR
    this._cellN = 0;          // 缓存边长（= worldSize * 2）
    this._cellOff = 0;        // 偏移（= worldSize）

    // 画布尺寸
    this._dpr = 1;
    this._cw = 0;
    this._ch = 0;
  }

  // ---- 画布尺寸 ----
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this._cw = w / dpr;
    this._ch = h / dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- 坐标变换 ----
  /** 世界 → 屏幕（CSS 像素） */
  w2s(wx, wz) {
    const h = terrainHeight(wx, wz);
    const sx = (wx - wz) * ISO * this.cam.zoom + this._cw / 2 - this._camSx();
    const sy = ((wx + wz) * ISO * 0.5 - h * HS) * this.cam.zoom + this._ch / 2 - this._camSy();
    return { x: sx, y: sy };
  }
  /** 屏幕 → 世界（考虑地形高度，一次迭代足够精确） */
  s2w(px, py) {
    // 屏幕偏移 → 等距中间量（z=zoom）
    // rawSx = (wx-wz)*ISO*z, rawSy = (wx+wz)*ISO*0.5*z - h*HS*z
    const rawSx = px - this._cw / 2 + this._camSx();
    const rawSy = py - this._ch / 2 + this._camSy();
    const z = this.cam.zoom;
    // 第一步：忽略高度（h=0）求近似
    const a = rawSx / (ISO * z);           // = wx - wz
    const b0 = rawSy / (ISO * 0.5 * z);    // = wx + wz - h*HS/ISO
    let wx = (a + b0) / 2;
    let wz = (b0 - a) / 2;
    // 第二步：用实际高度校正
    const h = terrainHeight(wx, wz);
    const b = (rawSy + h * HS * z) / (ISO * 0.5 * z); // = wx + wz
    wx = (a + b) / 2;
    wz = (b - a) / 2;
    return { x: wx, z: wz };
  }
  /** 相机等距偏移 x */
  _camSx() { return (this.cam.cx - this.cam.cz) * ISO * this.cam.zoom; }
  /** 相机等距偏移 y */
  _camSy() { return (this.cam.cx + this.cam.cz) * ISO * 0.5 * this.cam.zoom; }

  // ---- 相机控制 ----
  pan(dxScreen, dyScreen) {
    const z = this.cam.zoom;
    // 屏幕偏移 → 等距偏移 → 世界偏移（反解）
    const dGx = -dxScreen / (ISO * z);
    const dGy = -dyScreen / (ISO * 0.5 * z);
    this.cam.cx += (dGx + dGy) / 2;
    this.cam.cz += (dGy - dGx) / 2;
  }
  zoomAt(px, py, factor) {
    const before = this.s2w(px, py);
    this.cam.zoom = Math.max(0.3, Math.min(14, this.cam.zoom * factor));
    const after = this.s2w(px, py);
    this.cam.cx += before.x - after.x;
    this.cam.cz += before.z - after.z;
  }
  panWorld(dx, dz) {
    this.cam.cx += dx;
    this.cam.cz += dz;
  }

  // ============================================================================
  // 模式 A：Chunk 流式渲染（游戏 renderer.js 用）
  // ============================================================================

  /** 更新可见区块（游戏主循环每帧调用） */
  updateChunks(selfX, selfZ, viewRange) {
    this._viewRange = viewRange || 100;
    const ccx = Math.floor(selfX / TERRAIN_CHUNK);
    const ccz = Math.floor(selfZ / TERRAIN_CHUNK);
    const radius = Math.ceil(this._viewRange / TERRAIN_CHUNK) + 1;
    const need = new Set();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const kx = ccx + dx, kz = ccz + dz;
        const wxc = (kx + 0.5) * TERRAIN_CHUNK;
        const wzc = (kz + 0.5) * TERRAIN_CHUNK;
        if (Math.hypot(wxc - selfX, wzc - selfZ) <= this._viewRange + TERRAIN_CHUNK * 0.8) {
          need.add(kx + ',' + kz);
        }
      }
    }
    for (const key of [...this._chunks.keys()]) {
      if (!need.has(key)) this._chunks.delete(key);
    }
    for (const key of need) {
      if (this._chunks.has(key)) continue;
      const [kx, kz] = key.split(',').map(Number);
      this._chunks.set(key, this._buildChunkCanvas(kx, kz));
    }
  }

  /** 绘制 chunk 地形（游戏 draw 调用） */
  drawChunks(ctx) {
    const w = this._cw, h = this._ch;
    const camSx = this._camSx(), camSy = this._camSy();
    const z = this.cam.zoom;
    const chunkList = [...this._chunks.values()].sort((a, b) => (a.cx + a.cz) - (b.cx + b.cz));
    for (const c of chunkList) {
      const px = (c.offGx * z) - camSx + w / 2;
      const py = (c.offGy * z) - camSy + h / 2;
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(z, z);
      ctx.drawImage(c.canvas, 0, 0);
      ctx.restore();
    }
  }

  /** 清除全部区块缓存（编辑器撤销/重做/色带切换时调用） */
  invalidateAllChunks() {
    this._chunks.clear();
  }

  /** 使某世界坐标矩形范围内的区块失效（画刷编辑后调用） */
  invalidateRegion(wx0, wz0, wx1, wz1) {
    const pad = 1;
    const cx0 = Math.floor((wx0 - pad) / TERRAIN_CHUNK);
    const cz0 = Math.floor((wz0 - pad) / TERRAIN_CHUNK);
    const cx1 = Math.floor((wx1 + pad) / TERRAIN_CHUNK);
    const cz1 = Math.floor((wz1 + pad) / TERRAIN_CHUNK);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        this._chunks.delete(cx + ',' + cz);
      }
    }
  }

  /** 获取当前区块缓存数量（调试用） */
  get chunkCount() { return this._chunks.size; }

  /** 构建单个区块离屏画布 */
  _buildChunkCanvas(cx, cz) {
    const x0 = cx * TERRAIN_CHUNK;
    const z0 = cz * TERRAIN_CHUNK;
    const H = [];
    for (let i = 0; i <= CHUNK_N; i++) {
      H[i] = [];
      for (let j = 0; j <= CHUNK_N; j++) {
        H[i][j] = terrainHeight(x0 + i * CELL, z0 + j * CELL);
      }
    }
    let minGx = Infinity, maxGx = -Infinity, minGy = Infinity, maxGy = -Infinity;
    for (let i = 0; i <= CHUNK_N; i++) {
      for (let j = 0; j <= CHUNK_N; j++) {
        const wx = x0 + i * CELL, wz = z0 + j * CELL;
        const ggx = isoGx(wx, wz);
        const ggy = isoGy(wx, H[i][j], wz);
        if (ggx < minGx) minGx = ggx;
        if (ggx > maxGx) maxGx = ggx;
        if (ggy < minGy) minGy = ggy;
        if (ggy > maxGy) maxGy = ggy;
      }
    }
    const offGx = minGx - PAD;
    const offGy = minGy - PAD;
    const cw = Math.ceil(maxGx - minGx + 2 * PAD);
    const ch = Math.ceil(maxGy - minGy + 2 * PAD);
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const o = off.getContext('2d');
    // 画家排序：远→近
    const cells = [];
    for (let j = 0; j < CHUNK_N; j++)
      for (let i = 0; i < CHUNK_N; i++) cells.push([i, j]);
    cells.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    for (const [i, j] of cells) {
      const wx = x0 + i * CELL, wz = z0 + j * CELL;
      const h0 = H[i][j], h1 = H[i + 1][j], h2 = H[i + 1][j + 1], h3 = H[i][j + 1];
      if (terrainBlocked(wx + CELL * 0.5, wz + CELL * 0.5)) continue;
      const A = [isoGx(wx, wz) - offGx, isoGy(wx, h0, wz) - offGy];
      const B = [isoGx(wx + CELL, wz) - offGx, isoGy(wx + CELL, h1, wz) - offGy];
      const C = [isoGx(wx + CELL, wz + CELL) - offGx, isoGy(wx + CELL, h2, wz + CELL) - offGy];
      const D = [isoGx(wx, wz + CELL) - offGx, isoGy(wx, h3, wz + CELL) - offGy];
      const slope = Math.max(Math.abs(h1 - h0), Math.abs(h3 - h0)) / CELL;
      const bright = Math.max(0.86, Math.min(1.12, 1.0 - slope * 0.05));
      const g = Math.round(196 * bright);
      fillQuad(o, A, B, C, D, `rgb(${g},${g},${g})`);
      drawBankFaces(o, H, x0, z0, i, j, { A, B, C, D, h0, h1, h2, h3 }, offGx, offGy);
    }
    return { canvas: off, offGx, offGy, cx, cz };
  }

  // ============================================================================
  // 模式 B：Cell 缓存渲染（编辑器用）
  // ============================================================================

  /** 初始化单元格缓存（编辑器进入时调用一次） */
  initCellCache() {
    const N = this.worldSize * 2;
    this._cellN = N;
    this._cellOff = this.worldSize;
    this._cellCache = new Uint32Array(N * N);
    this.computeAllCells();
  }

  /** 计算单格颜色 */
  _computeCell(gx, gz) {
    const cx = gx + 0.5, cz = gz + 0.5;
    const idx = (gz + this._cellOff) * this._cellN + (gx + this._cellOff);
    if (terrainBlocked(cx, cz)) {
      this._cellCache[idx] = 0xFFFFFFFF; // 白=空洞
      return;
    }
    const h = terrainHeight(cx, cz);
    if (this.showHeight) {
      const c = heightColor(h);
      this._cellCache[idx] = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
    } else {
      const g = baseGray(gx, gz, h);
      this._cellCache[idx] = (255 << 24) | (g << 16) | (g << 8) | g;
    }
  }

  /** 全量重算（编辑器初始化/切换色带/撤销重做时调用） */
  computeAllCells() {
    const ws = this.worldSize;
    for (let gz = -ws; gz < ws; gz++)
      for (let gx = -ws; gx < ws; gx++)
        this._computeCell(gx, gz);
  }

  /** 局部更新（画刷操作后调用） */
  updateCells(x0, z0, x1, z1) {
    const ws = this.worldSize;
    const gx0 = Math.max(-ws, Math.floor(x0));
    const gx1 = Math.min(ws - 1, Math.floor(x1));
    const gz0 = Math.max(-ws, Math.floor(z0));
    const gz1 = Math.min(ws - 1, Math.floor(z1));
    for (let gz = gz0; gz <= gz1; gz++)
      for (let gx = gx0; gx <= gx1; gx++)
        this._computeCell(gx, gz);
  }

  /** 绘制 cell 缓存地形（编辑器每帧/每次交互后调用） */
  drawCells(ctx) {
    if (!this._cellCache) return;
    const w = this.canvas.width, h = this.canvas.height;
    const dpr = this._dpr;
    const cw = this._cw, ch = this._ch;
    const halfW = cw / 2, halfH = ch / 2;
    const z = this.cam.zoom;
    const camSx = this._camSx(), camSy = this._camSy();
    // 背景白（空洞区打底）
    const img = ctx.createImageData(w, h);
    const data = img.data;
    data.fill(0xFF, 3); // alpha=255
    // 设置白色背景
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }
    // 计算可见格范围（通过反投影四个角）
    const corners = [
      this.s2w(0, 0), this.s2w(cw, 0),
      this.s2w(0, ch), this.s2w(cw, ch),
    ];
    let minWx = Infinity, maxWx = -Infinity, minWz = Infinity, maxWz = -Infinity;
    for (const c of corners) {
      if (c.x < minWx) minWx = c.x;
      if (c.x > maxWx) maxWx = c.x;
      if (c.z < minWz) minWz = c.z;
      if (c.z > maxWz) maxWz = c.z;
    }
    const ws = this.worldSize;
    const gx0 = Math.max(-ws, Math.floor(minWx) - 2);
    const gx1 = Math.min(ws - 1, Math.ceil(maxWx) + 2);
    const gz0 = Math.max(-ws, Math.floor(minWz) - 2);
    const gz1 = Math.min(ws - 1, Math.ceil(maxWz) + 2);
    // 逐格绘制等距菱形
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const col = this._cellCache[(gz + this._cellOff) * this._cellN + (gx + this._cellOff)];
        if (col === 0xFFFFFFFF) continue; // 空洞跳过（白色背景已铺）
        const r = col & 0xff, gg = (col >> 8) & 0xff, b = (col >> 16) & 0xff;
        // 四角世界坐标
        const wx0 = gx, wz0 = gz, wx1 = gx + 1, wz1 = gz + 1;
        const h00 = terrainHeight(wx0, wz0);
        const h10 = terrainHeight(wx1, wz0);
        const h11 = terrainHeight(wx1, wz1);
        const h01 = terrainHeight(wx0, wz1);
        // 等距投影 → 屏幕
        const A = this._w2sRaw(wx0, wz0, h00);
        const B = this._w2sRaw(wx1, wz0, h10);
        const C = this._w2sRaw(wx1, wz1, h11);
        const D = this._w2sRaw(wx0, wz1, h01);
        // 光栅化菱形到 ImageData
        this._fillQuadToImage(data, w, h, A, B, C, D, r, gg, b);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** 世界 → 屏幕原始像素（不经过 CSS 缩放，直接到 ImageData 坐标） */
  _w2sRaw(wx, wz, h) {
    const z = this.cam.zoom;
    const dpr = this._dpr;
    const sx = ((wx - wz) * ISO * z - this._camSx() + this._cw / 2) * dpr;
    const sy = (((wx + wz) * ISO * 0.5 - h * HS) * z - this._camSy() + this._ch / 2) * dpr;
    return { x: sx, y: sy };
  }

  /** 光栅化四边形到 ImageData（扫描线填充） */
  _fillQuadToImage(data, imgW, imgH, A, B, C, D, r, g, b) {
    // 按 y 排序顶点，扫描线填充
    const pts = [A, B, C, D].sort((a, b) => a.y - b.y);
    const minY = Math.max(0, Math.floor(pts[0].y));
    const maxY = Math.min(imgH - 1, Math.ceil(pts[3].y));
    for (let y = minY; y <= maxY; y++) {
      // 找四边形在此行的 x 范围
      const xs = [];
      const edges = [[pts[0], pts[1]], [pts[1], pts[2]], [pts[2], pts[3]], [pts[3], pts[0]]];
      for (const [p1, p2] of edges) {
        if (p1.y === p2.y) continue;
        if (y < Math.min(p1.y, p2.y) || y >= Math.max(p1.y, p2.y)) continue;
        const t = (y - p1.y) / (p2.y - p1.y);
        xs.push(p1.x + (p2.x - p1.x) * t);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const x0 = Math.max(0, Math.floor(xs[0]));
      const x1 = Math.min(imgW - 1, Math.ceil(xs[xs.length - 1]));
      for (let x = x0; x <= x1; x++) {
        const idx = (y * imgW + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
  }

  // ============================================================================
  // 共享覆盖层（两种模式均可调用）
  // ============================================================================

  /** 绘制等距网格线 */
  drawGrid(ctx, step) {
    if (!this.showGrid) return;
    step = step || this.gridStep;
    const cw = this._cw, ch = this._ch;
    const z = this.cam.zoom;
    // 仅在足够放大时显示
    if (step * ISO * z < 4) return;
    const ws = this.worldSize;
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 沿 x 方向的线（wz 固定）
    for (let gz = -ws; gz <= ws; gz += step) {
      const start = this.w2s(-ws, gz);
      const end = this.w2s(ws, gz);
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    }
    // 沿 z 方向的线（wx 固定）
    for (let gx = -ws; gx <= ws; gx += step) {
      const start = this.w2s(gx, -ws);
      const end = this.w2s(gx, ws);
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    }
    ctx.stroke();
    // 坐标轴（加粗）
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const ox0 = this.w2s(-ws, 0), ox1 = this.w2s(ws, 0);
    ctx.moveTo(ox0.x, ox0.y); ctx.lineTo(ox1.x, ox1.y);
    const oz0 = this.w2s(0, -ws), oz1 = this.w2s(0, ws);
    ctx.moveTo(oz0.x, oz0.y); ctx.lineTo(oz1.x, oz1.y);
    ctx.stroke();
  }

  /** 绘制主城标记 */
  drawOriginMarker(ctx) {
    const p = this.w2s(0, 0);
    ctx.fillStyle = '#2f6fed';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('主城', p.x, p.y - 7);
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.stroke();
  }

  /** 绘制画刷预览（等距椭圆） */
  drawBrushPreview(ctx, wx, wz, radius) {
    const center = this.w2s(wx, wz);
    const edge = this.w2s(wx + radius, wz);
    const R = Math.max(2, Math.abs(edge.x - center.x));
    ctx.strokeStyle = 'rgba(255,45,45,0.9)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.ellipse(center.x, center.y, R, R * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,45,45,0.15)';
    ctx.beginPath(); ctx.ellipse(center.x, center.y, R, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  /** 绘制背景渐变（白色打底，空洞区透出） */
  drawBackground(ctx) {
    const w = this._cw, h = this._ch;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#ececec');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  /** 清除画布 */
  clear(ctx) {
    ctx.clearRect(0, 0, this._cw, this._ch);
  }

  // ---- 属性访问器 ----
  get cssWidth() { return this._cw; }
  get cssHeight() { return this._ch; }
}
