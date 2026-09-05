// canvas-renderer.js — Canvas 2D 俯视角渲染器（游戏客户端 + 编辑器共享）
// 正交俯视：X→右, Z→下；简洁扁平风格：色块地形 + 彩色圆圈实体
import {
  terrainHeight, terrainBlocked, terrainColor,
  WATER_LEVEL, walkMaskN, walkMaskOff,
} from './terrain.js';

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

const BASE_PX_PER_UNIT = 10;   // 基础像素/世界单位（zoom=1 时）
const MAX_SKILL = 64;
const BOUNCE_MIN_SPD  = 0.35;
const BOUNCE_IDLE_AMP = 0.35;
const BOUNCE_AMP      = 0.35;
const BOUNCE_RATE     = 3.0;
const BOUNCE_SPD_K    = 1.0;

// ════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════

function hexRgb(h) {
  let r = h.replace('#', '');
  if (r.length === 3) r = r[0] + r[0] + r[1] + r[1] + r[2] + r[2];
  const n = parseInt(r, 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function rgbStr(r, g, b, a = 1) {
  return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`;
}

// ════════════════════════════════════════════════════════════
// WebGLRenderer（公共 API 与旧 Three.js 版完全一致）
// ════════════════════════════════════════════════════════════

export class WebGLRenderer {
  constructor(container, opts = {}) {
    this.editorMode = !!opts.editorMode;

    // ---- Canvas 2D 基础设施 ----
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // ---- 相机（正交俯视：X→右, Z→下） ----
    this.cam = { cx: 0, cz: 0, zoom: 3 };

    // ---- 状态 ----
    this._self = null;
    this._dirTarget = null;  // {x, z} 鼠标世界坐标（方向指示器用）
    this._entities = [];
    this._effects = [];
    this._spawnMarkers = [];
    this._brushPreview = null;
    this._clickIndicators = [];
    this._gridVisible = false;
    this.heightColorMode = false;  // 高度色带着色模式（编辑器）
    this._selfPos = null; // {x, z} 自身位置（交互按键提示用）
    this._bounce = new Map();
    this._bounceActive = new Set();
    this._lastBuildMs = 0;

    // ---- Label overlay (entity names) ----
    this._labelBox = document.createElement('div');
    this._labelBox.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
    container.appendChild(this._labelBox);
    this._labelEls = new Map();

    // ---- Init ----
    this.resize();
  }

  // ════════════════════════════════════════════════════════
  // 相机
  // ════════════════════════════════════════════════════════

  setCameraFollow(x, z) {
    this.cam.cx = x;
    this.cam.cz = z;
  }
  setCameraFree(cx, cz, zoom) {
    this.cam.cx = cx;
    this.cam.cz = cz;
    if (zoom) this.cam.zoom = zoom;
  }
  pan(dx, dz) {
    this.cam.cx += dx;
    this.cam.cz += dz;
  }
  zoomAt(factor) {
    this.cam.zoom = Math.max(0.3, Math.min(14, this.cam.zoom * factor));
  }

  // ════════════════════════════════════════════════════════
  // 坐标变换
  // ════════════════════════════════════════════════════════

  w2s(wx, _wy, wz) {
    // 兼容旧 API（3 参数），_wy 忽略（2D 俯视无 Y 轴投影）
    if (wz === undefined) {
      // 2 参数调用：w2s(wx, wz)
      wz = _wy;
    }
    const scale = this.cam.zoom * BASE_PX_PER_UNIT;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return {
      x: (wx - this.cam.cx) * scale + cw / 2,
      y: (wz - this.cam.cz) * scale + ch / 2,
    };
  }

  s2w(sx, sy) {
    const scale = this.cam.zoom * BASE_PX_PER_UNIT;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return {
      x: (sx - cw / 2) / scale + this.cam.cx,
      z: (sy - ch / 2) / scale + this.cam.cz,
    };
  }

  // ════════════════════════════════════════════════════════
  // 实体
  // ════════════════════════════════════════════════════════

  setSelf(x, y, z, name, dead) {
    this._self = { x, y, z, name, dead };
    this._selfPos = { x, z };
  }
  setDirectionTarget(x, z) {
    this._dirTarget = (x != null && z != null) ? { x, z } : null;
  }
  setEntities(list) { this._entities = list; }
  addClickRipple(x, z) {
    this._clickIndicators.push({ x, z, time: performance.now() });
    if (this._clickIndicators.length > 16) this._clickIndicators.shift(); // 防止堆积
  }

  // ════════════════════════════════════════════════════════
  // 技能效果
  // ════════════════════════════════════════════════════════

  addSkillEffect(eff) {
    if (eff.kind === 'cast') {
      for (let i = this._effects.length - 1; i >= 0; i--)
        if (this._effects[i].kind === 'cast' && this._effects[i].wid === eff.wid)
          this._effects.splice(i, 1);
    }
    this._effects.push(Object.assign({ startMs: performance.now(), durMs: 800, color: '#ffd166', radius: 0 }, eff));
    if (this._effects.length > MAX_SKILL) this._effects.splice(0, this._effects.length - MAX_SKILL);
  }
  clearCasting(wid) {
    for (let i = this._effects.length - 1; i >= 0; i--)
      if (this._effects[i].kind === 'cast' && this._effects[i].wid === wid) this._effects.splice(i, 1);
  }
  showAoePreview(x, z, radius, color) {
    this._effects.push({
      kind: 'aoe', wid: -1, x, z, radius,
      color: color || '#ff6b35', startMs: performance.now(), durMs: 1200,
    });
  }
  fxSnapshot() {
    return this._effects.map(e => ({ kind: e.kind, x: +e.x.toFixed(1), z: +e.z.toFixed(1), radius: e.radius, color: e.color, durMs: e.durMs }));
  }

  // ════════════════════════════════════════════════════════
  // 编辑器辅助
  // ════════════════════════════════════════════════════════

  setGridVisible(v) { this._gridVisible = v; }
  setBrushPreview(wx, wz, r) {
    this._brushPreview = r > 0 ? { wx, wz, r } : null;
  }
  setSpawnMarkers(list) { this._spawnMarkers = list || []; }

  // ════════════════════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════════════════════

  render() {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    const scale = this.cam.zoom * BASE_PX_PER_UNIT;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 背景
    ctx.fillStyle = '#ffffffff';
    ctx.fillRect(0, 0, cw, ch);

    if (scale < 2) {
      // ── 低缩放快速路径：ImageData 像素直写 + 跳过不可见的叠加层 ──
      // 视角拉高时可见格数可达 65K+，逐格 fillRect 开销远超像素写入。
      // voidGrid / water 在亚像素尺度下不可见，直接跳过。
      this._drawTerrainFast(ctx, cw, ch, scale);
      if (this._gridVisible) this._drawGrid(ctx, cw, ch, scale);
    } else {
      // ── 正常路径 ──
      this._drawVoidGrid(ctx, cw, ch, scale);
      this._drawTerrain(ctx, cw, ch, scale);
      this._drawWater(ctx, cw, ch, scale);
      if (this._gridVisible) this._drawGrid(ctx, cw, ch, scale);
    }

    // 实体 + 自身
    this._drawEntities(ctx, scale);

    // 技能效果
    this._drawSkillEffects(ctx, scale);

    // 点击指示器（支持多个波纹同时显示）
    this._drawClickIndicators(ctx, scale);

    // 出生点标记
    if (this._spawnMarkers.length) this._drawSpawnMarkers(ctx, scale);

    // 画刷预览
    if (this._brushPreview) this._drawBrush(ctx, scale);

    // 名字标签（HTML overlay）
    this._updateLabels();

    ctx.restore();
  }

  // ── 空洞区域网格（无地形处显示，类似编辑器网格） ──
  _drawVoidGrid(ctx, cw, ch, scale) {
    const mn = walkMaskN(), moff = walkMaskOff();
    if (mn <= 0) return;

    const halfW = cw / 2 / scale;
    const halfH = ch / 2 / scale;
    const wxMin = this.cam.cx - halfW;
    const wxMax = this.cam.cx + halfW;
    const wzMin = this.cam.cz - halfH;
    const wzMax = this.cam.cz + halfH;

    const giMin = Math.max(0, Math.floor(wxMin) + moff);
    const giMax = Math.min(mn - 1, Math.ceil(wxMax) + moff);
    const gjMin = Math.max(0, Math.floor(wzMin) + moff);
    const gjMax = Math.min(mn - 1, Math.ceil(wzMax) + moff);

    ctx.strokeStyle = 'rgba(140,190,230,0.25)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();

    for (let gj = gjMin; gj <= gjMax; gj++) {
      for (let gi = giMin; gi <= giMax; gi++) {
        const wx = gi - moff;
        const wz = gj - moff;
        if (terrainBlocked(wx + 0.5, wz + 0.5)) {
          // 量化到整数像素，消除亚像素闪烁
          const sx = Math.round((wx - this.cam.cx) * scale + cw / 2);
          const sy = Math.round((wz - this.cam.cz) * scale + ch / 2);
          const sw = Math.round(scale);
          ctx.rect(sx, sy, sw, sw);
        }
      }
    }
    ctx.stroke();
  }

  // ── 地形着色采样（与小地图 _sampleColor 一致） ──
  _sampleTerrainRgb(wx, wz) {
    if (terrainBlocked(wx, wz)) {
      return [140, 190, 230]; // 不可通行区域：天空蓝（浮岛间空隙）
    }
    const h = terrainHeight(wx, wz);
    if (this.heightColorMode) {
      return this._heightToBandRgb(h);
    }
    if (h < WATER_LEVEL) {
      return [148, 134, 92]; // 河床/湖底 → 沙泥色
    }
    // 取地形着色 → 压暗 + 微暖化 → 复古地图风格
    const tc = terrainColor(wx, wz);
    return [
      Math.round(tc.r * 175 + 18),
      Math.round(tc.g * 168 + 12),
      Math.round(tc.b * 148 + 8),
    ];
  }

  // ── 高度 → 色带 RGB（匹配图例渐变） ──
  _heightToBandRgb(h) {
    const stops = [
      [-2,  45,  70, 160],
      [ 4,  80, 150, 195],
      [10, 110, 185, 120],
      [16, 225, 215, 130],
      [22, 175, 135,  85],
      [34, 245, 245, 245],
    ];
    if (h <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
    const last = stops[stops.length - 1];
    if (h >= last[0]) return [last[1], last[2], last[3]];
    for (let i = 0; i < stops.length - 1; i++) {
      if (h >= stops[i][0] && h < stops[i + 1][0]) {
        const t = (h - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        return [
          Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * t),
          Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * t),
          Math.round(stops[i][3] + (stops[i + 1][3] - stops[i][3]) * t),
        ];
      }
    }
    return [200, 200, 200];
  }

  // ── 地形渲染（连续色块，与小地图一致） ──
  _drawTerrain(ctx, cw, ch, scale) {
    // 低缩放分流：亚像素格使用 ImageData 快速路径
    if (scale < 2) {
      this._drawTerrainFast(ctx, cw, ch, scale);
      return;
    }
    const mn = walkMaskN(), moff = walkMaskOff();
    if (mn <= 0) {
      if (!this._terrainDiagLogged) {
        this._terrainDiagLogged = true;
        console.warn('[Renderer] terrain mask NOT loaded, walkMaskN()=0 — skipping terrain draw');
      }
      return;
    }
    if (!this._terrainDiagLogged) {
      this._terrainDiagLogged = true;
      let walkable = 0, blocked = 0;
      const halfW = cw / 2 / scale, halfH = ch / 2 / scale;
      const giMin = Math.max(0, Math.floor(this.cam.cx - halfW) + moff);
      const giMax = Math.min(mn - 1, Math.ceil(this.cam.cx + halfW) + moff);
      const gjMin = Math.max(0, Math.floor(this.cam.cz - halfH) + moff);
      const gjMax = Math.min(mn - 1, Math.ceil(this.cam.cz + halfH) + moff);
      for (let gj = gjMin; gj <= gjMax; gj++) {
        for (let gi = giMin; gi <= giMax; gi++) {
          const wx = gi - moff + 0.5, wz = gj - moff + 0.5;
          if (terrainBlocked(wx, wz)) blocked++; else walkable++;
        }
      }
      console.log(`[Renderer] terrain mask loaded: n=${mn}, off=${moff}, visible walkable=${walkable}, blocked=${blocked}`);
    }

    const halfW = cw / 2 / scale;
    const halfH = ch / 2 / scale;
    const wxMin = this.cam.cx - halfW;
    const wxMax = this.cam.cx + halfW;
    const wzMin = this.cam.cz - halfH;
    const wzMax = this.cam.cz + halfH;

    const giMin = Math.max(0, Math.floor(wxMin) + moff);
    const giMax = Math.min(mn - 1, Math.ceil(wxMax) + moff);
    const gjMin = Math.max(0, Math.floor(wzMin) + moff);
    const gjMax = Math.min(mn - 1, Math.ceil(wzMax) + moff);

    for (let gj = gjMin; gj <= gjMax; gj++) {
      for (let gi = giMin; gi <= giMax; gi++) {
        const wx = gi - moff;
        const wz = gj - moff;
        if (terrainBlocked(wx + 0.5, wz + 0.5)) continue;

        const sx = ((wx + 0.5) - this.cam.cx) * scale + cw / 2;
        const sy = ((wz + 0.5) - this.cam.cz) * scale + ch / 2;

        const [r, g, b] = this._sampleTerrainRgb(wx + 0.5, wz + 0.5);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect((sx - scale / 2 | 0) - 1, (sy - scale / 2 | 0) - 1, Math.ceil(scale) + 2, Math.ceil(scale) + 2);
      }
    }
  }

  // ── 水面（低洼区域用蓝色点阵覆盖） ──
  _drawWater(ctx, cw, ch, scale) {
    const mn = walkMaskN(), moff = walkMaskOff();
    if (mn <= 0) return;

    const halfW = cw / 2 / scale;
    const halfH = ch / 2 / scale;
    const wxMin = this.cam.cx - halfW;
    const wxMax = this.cam.cx + halfW;
    const wzMin = this.cam.cz - halfH;
    const wzMax = this.cam.cz + halfH;

    const giMin = Math.max(0, Math.floor(wxMin) + moff);
    const giMax = Math.min(mn - 1, Math.ceil(wxMax) + moff);
    const gjMin = Math.max(0, Math.floor(wzMin) + moff);
    const gjMax = Math.min(mn - 1, Math.ceil(wzMax) + moff);

    const dotR = Math.max(1.2, scale * 0.25);
    const dotD = dotR * 2;
    ctx.fillStyle = 'rgba(40,80,130,0.50)';

    for (let gj = gjMin; gj <= gjMax; gj++) {
      for (let gi = giMin; gi <= giMax; gi++) {
        const wx = gi - moff;
        const wz = gj - moff;
        if (!terrainBlocked(wx + 0.5, wz + 0.5)) {
          const h = terrainHeight(wx + 0.5, wz + 0.5);
          if (h < WATER_LEVEL) {
            const sx = ((wx + 0.5) - this.cam.cx) * scale + cw / 2;
            const sy = ((wz + 0.5) - this.cam.cz) * scale + ch / 2;
            ctx.fillRect(sx - dotR | 0, sy - dotR | 0, Math.ceil(dotD), Math.ceil(dotD));
          }
        }
      }
    }
  }

  // ── 编辑器网格 ──
  _drawGrid(ctx, cw, ch, scale) {
    const mn = walkMaskN(), moff = walkMaskOff();
    const WS = mn > 0 ? Math.max(moff, mn - moff) : 128;
    const step = 20;

    const halfW = cw / 2 / scale;
    const halfH = ch / 2 / scale;

    ctx.strokeStyle = 'rgba(128,128,128,0.18)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();

    // 竖线
    const xStart = Math.floor((this.cam.cx - halfW) / step) * step;
    const xEnd = Math.ceil((this.cam.cx + halfW) / step) * step;
    for (let x = xStart; x <= xEnd; x += step) {
      const sx = (x - this.cam.cx) * scale + cw / 2;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, ch);
    }
    // 横线
    const zStart = Math.floor((this.cam.cz - halfH) / step) * step;
    const zEnd = Math.ceil((this.cam.cz + halfH) / step) * step;
    for (let z = zStart; z <= zEnd; z += step) {
      const sy = (z - this.cam.cz) * scale + ch / 2;
      ctx.moveTo(0, sy);
      ctx.lineTo(cw, sy);
    }
    ctx.stroke();

    // 坐标轴（RGB → XZ）
    const AX = 35;
    const ox = (0 - this.cam.cx) * scale + cw / 2;
    const oz = (0 - this.cam.cz) * scale + ch / 2;
    // X 轴 — 红
    ctx.strokeStyle = 'rgba(255,50,50,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox, oz);
    ctx.lineTo((AX - this.cam.cx) * scale + cw / 2, oz);
    ctx.stroke();
    // Z 轴 — 蓝
    ctx.strokeStyle = 'rgba(50,50,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(ox, oz);
    ctx.lineTo(ox, (AX - this.cam.cz) * scale + ch / 2);
    ctx.stroke();
  }

  // ── 实体渲染 ──
  _drawEntities(ctx, scale) {
    const nowMs = performance.now();
    let dt = this._lastBuildMs ? (nowMs - this._lastBuildMs) / 1000 : 0;
    this._lastBuildMs = nowMs;
    if (dt > 0.1) dt = 0.1;
    this._bounceActive.clear();

    const COLORS = {
      player: '#4ade80', monster: '#f87171',
      npc: '#60a5fa', item: '#fbbf24',
    };

    const drawCircle = (x, z, radius, color, dying) => {
      const sx = (x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
      const sy = (z - this.cam.cz) * scale + this.canvas.clientHeight / 2;
      const sr = radius * scale;
      if (sr < 0.5) return;

      const alpha = dying ? 0.4 : 1;
      ctx.globalAlpha = alpha;

      // 描边（暗色圆环）
      ctx.beginPath();
      ctx.arc(sx, sy, sr * 1.08, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();

      // 主体
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.globalAlpha = 1;
    };

    for (const e of this._entities) {
      const color = COLORS[e.kind] || COLORS.monster;
      const r = e.kind === 'item' ? 0.4 : 0.55;
      const bn = (e.kind === 'item' || e.dying) ? 0 : this._bounceOffset(e.wid, e.x, e.z, dt);
      drawCircle(e.x, e.z + bn * 0.3, r, color, e.dying);

      // 仇恨状态怪物血条（aiState=2追击/3战斗）
      if (e.kind === 'monster' && e.maxHp > 0 && (e.aiState === 2 || e.aiState === 3)) {
        const sx = (e.x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
        const sy = (e.z + bn * 0.3 - this.cam.cz) * scale + this.canvas.clientHeight / 2;
        const sr = r * scale;
        const barW = sr * 2.2;
        const barH = Math.max(3, sr * 0.25);
        const barY = sy - sr - barH - 4;
        const barX = sx - barW / 2;
        const ratio = Math.max(0, Math.min(1, e.hp / e.maxHp));

        // 背景
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
        // 红色底
        ctx.fillStyle = '#4a1c1c';
        ctx.fillRect(barX, barY, barW, barH);
        // 血量填充（绿→黄→红渐变）
        const hpColor = ratio > 0.5 ? '#4ade80' : ratio > 0.25 ? '#fbbf24' : '#ef4444';
        ctx.fillStyle = hpColor;
        ctx.fillRect(barX, barY, barW * ratio, barH);
      }
    }

    if (this._self) {
      const s = this._self;
      const bn = s.dead ? 0 : this._bounceOffset('self', s.x, s.z, dt);
      drawCircle(s.x, s.z + bn * 0.3, 0.55, '#ff8c1a', s.dead);

      // 方向指示器：玩家外圈指向鼠标方向的三角箭头
      if (this._dirTarget && !s.dead) {
        const dx = this._dirTarget.x - s.x;
        const dz = this._dirTarget.z - s.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.1) {
          const angle = Math.atan2(dz, dx);
          const arrowDist = 0.75;  // 箭头距球心距离（略大于球半径 0.55）
          const ax = s.x + Math.cos(angle) * arrowDist;
          const az = s.z + Math.sin(angle) * arrowDist;
          const sax = (ax - this.cam.cx) * scale + this.canvas.clientWidth / 2;
          const say = (az - this.cam.cz) * scale + this.canvas.clientHeight / 2;
          const arrowSize = Math.max(4, scale * 0.18);

          ctx.save();
          ctx.translate(sax, say);
          ctx.rotate(angle);
          ctx.fillStyle = 'rgba(255,140,26,0.85)';
          ctx.beginPath();
          ctx.moveTo(arrowSize, 0);
          ctx.lineTo(-arrowSize * 0.6, -arrowSize * 0.6);
          ctx.lineTo(-arrowSize * 0.6, arrowSize * 0.6);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // 清理已离开视野实体的弹跳状态
    for (const k of this._bounce.keys()) {
      if (!this._bounceActive.has(k)) this._bounce.delete(k);
    }
  }

  _bounceOffset(key, x, z, dt) {
    this._bounceActive.add(key);
    let b = this._bounce.get(key);
    if (!b) {
      b = { px: x, pz: z, phase: Math.random() * Math.PI, amp: 0 };
      this._bounce.set(key, b);
    }
    const dx = x - b.px, dz = z - b.pz;
    b.px = x; b.pz = z;
    const spd = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    const moving = spd > BOUNCE_MIN_SPD;
    const target = moving ? Math.min(BOUNCE_AMP, BOUNCE_IDLE_AMP + spd * 0.03) : BOUNCE_IDLE_AMP;
    b.amp += (target - b.amp) * Math.min(1, dt * 8);
    b.phase += dt * (BOUNCE_RATE + (moving ? spd * BOUNCE_SPD_K : 0));
    if (b.phase > 1e4) b.phase %= Math.PI;
    return b.amp * Math.abs(Math.sin(b.phase));
  }

  // ── 技能效果 ──
  _drawSkillEffects(ctx, scale) {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const now = performance.now();

    for (let i = this._effects.length - 1; i >= 0; i--) {
      const ef = this._effects[i];
      const life = (now - ef.startMs) / ef.durMs;
      if (life >= 1) { this._effects.splice(i, 1); continue; }
      const alpha = (1 - life) * 0.85;
      const [r, g, b] = hexRgb(ef.color || '#ffd166');
      let ex = ef.x, ez = ef.z, rad = ef.radius || 1.5;

      // cast 效果：跟随施法者实体位置
      let casterX = ex, casterZ = ez;
      if (ef.kind === 'cast' && ef.wid > 0) {
        for (const e of this._entities) {
          if (e.wid === ef.wid) { casterX = e.x; casterZ = e.z; ex = e.x; ez = e.z; break; }
        }
      }

      const sx = (ex - this.cam.cx) * scale + cw / 2;
      const sy = (ez - this.cam.cz) * scale + ch / 2;
      const sr = rad * scale;

      if (ef.kind === 'cast') {
        // ── 前摇蓄力圈：虚线边框 + 扇形进度填充 ──
        // 蓄力方向：施法者 → 落点
        const dirAngle = Math.atan2(ef.z - casterZ, ef.x - casterX);
        const startAngle = dirAngle - Math.PI / 2;
        const sweepAngle = life * Math.PI * 2;

        // 虚线边框圆（完整圆，低透明度）
        ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.5);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1, sr), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // 扇形填充（从起始终角度扫过 progress × 2π）
        if (sweepAngle > 0.01) {
          ctx.fillStyle = rgbStr(r, g, b, alpha * 0.3);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.arc(sx, sy, Math.max(1, sr), startAngle, startAngle + sweepAngle);
          ctx.closePath();
          ctx.fill();

          // 扫掠边沿线（高亮当前进度前沿）
          const edgeAngle = startAngle + sweepAngle;
          const edgeX = sx + Math.cos(edgeAngle) * sr;
          const edgeY = sy + Math.sin(edgeAngle) * sr;
          ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.9);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(edgeX, edgeY);
          ctx.stroke();
        }
      } else {
        // ── 其他效果（AOE 结算等）：简单圆形边框 + 半透明填充 ──
        ctx.strokeStyle = rgbStr(r, g, b, alpha);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1, sr), 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = rgbStr(r, g, b, alpha * 0.15);
        ctx.fill();
      }
    }
  }

  // ── 点击位置指示器 ──
  _drawClickIndicators(ctx, scale) {
    const inds = this._clickIndicators;
    if (inds.length === 0) return;
    const now = performance.now();
    const dur = 1.2;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;

    for (let i = inds.length - 1; i >= 0; i--) {
      const ind = inds[i];
      const elapsed = (now - ind.time) / 1000;
      if (elapsed >= dur) { inds.splice(i, 1); continue; }
      const t = elapsed / dur;
      const alpha = (1 - t) * 0.8;
      const radius = 0.4 + t * 1.2;
      const sx = (ind.x - this.cam.cx) * scale + cw / 2;
      const sy = (ind.z - this.cam.cz) * scale + ch / 2;

      ctx.strokeStyle = rgbStr(0.95, 0.85, 0.3, alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, radius * scale, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = rgbStr(1.0, 0.95, 0.5, alpha * 0.9);
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── 出生点标记 ──
  _drawSpawnMarkers(ctx, scale) {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const COLORS = { monster: '#e5484d', npc: '#3b82f6', boss: '#a855f7' };

    for (const sp of this._spawnMarkers) {
      const sx = (sp.x - this.cam.cx) * scale + cw / 2;
      const sy = (sp.z - this.cam.cz) * scale + ch / 2;
      const color = COLORS[sp.kind] || COLORS.monster;
      const r = (sp.kind === 'boss' ? 1.8 : 1.2) * scale;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();

      // 中心标记
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── 画刷预览 ──
  _drawBrush(ctx, scale) {
    const bp = this._brushPreview;
    if (!bp) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;

    const sx = (bp.wx - this.cam.cx) * scale + cw / 2;
    const sy = (bp.wz - this.cam.cz) * scale + ch / 2;
    const sr = bp.r * scale;

    ctx.strokeStyle = 'rgba(255,46,46,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,46,46,0.08)';
    ctx.fill();
  }

  // ── 名字标签 (HTML overlay) ──
  _updateLabels() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const used = new Set();
    const all = [];

    for (const e of this._entities) {
      if (e.name) all.push({ x: e.x, z: e.z, name: e.name, id: 'e' + e.wid, kind: e.kind });
    }
    if (this._self && this._self.name) {
      all.push({ x: this._self.x, z: this._self.z, name: this._self.name, id: 'self', kind: 'self' });
    }

    // 交互按键提示：只对最近的可交互目标显示按键徽标
    const hints = [];
    if (this._selfPos) {
      const px = this._selfPos.x, pz = this._selfPos.z;
      // NPC：只选 4m 范围内最近的一个
      let bestNpc = null, bestNpcD = 4;
      // 掉落物：只选 2.5m 范围内最近的一个
      let bestItem = null, bestItemD = 2.5;
      for (const e of this._entities) {
        const d = Math.hypot(e.x - px, e.z - pz);
        if (e.kind === 'npc' && d < bestNpcD) { bestNpcD = d; bestNpc = e; }
        else if (e.kind === 'item' && d < bestItemD) { bestItemD = d; bestItem = e; }
      }
      if (bestNpc) hints.push({ id: 'h_e' + bestNpc.wid, x: bestNpc.x, z: bestNpc.z, key: 'G', hasName: !!bestNpc.name });
      if (bestItem) hints.push({ id: 'h_e' + bestItem.wid, x: bestItem.x, z: bestItem.z, key: 'E', hasName: !!bestItem.name });
    }

    for (const lb of all) {
      const s = this.w2s(lb.x, lb.z);
      if (s.x < -60 || s.x > cw + 60 || s.y < -40 || s.y > ch + 40) continue;
      let el = this._labelEls.get(lb.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = 'position:absolute;color:#fff;font:11px "PingFang SC","Microsoft YaHei",sans-serif;text-shadow:0 1px 3px rgba(0,0,0,.9);white-space:nowrap;pointer-events:none';
        this._labelBox.appendChild(el);
        this._labelEls.set(lb.id, el);
      }
      el.textContent = lb.name;
      el.style.left = s.x + 'px';
      el.style.top = (s.y - 12) + 'px';
      el.style.transform = 'translate(-50%,-100%)';
      used.add(lb.id);
    }

    // 渲染交互按键提示（姓名上方的按键徽标）
    for (const h of hints) {
      const s = this.w2s(h.x, h.z);
      if (s.x < -60 || s.x > cw + 60 || s.y < -40 || s.y > ch + 40) continue;
      let el = this._labelEls.get(h.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = 'position:absolute;pointer-events:none;white-space:nowrap;' +
          'font:bold 10px monospace;color:#ffd700;background:rgba(0,0,0,0.6);' +
          'padding:1px 5px;border-radius:3px;border:1px solid rgba(255,215,0,0.4);';
        this._labelBox.appendChild(el);
        this._labelEls.set(h.id, el);
      }
      el.textContent = h.key;
      el.style.left = s.x + 'px';
      // 有名字时浮于姓名上方，无名字时贴近实体
      el.style.top = (s.y - (h.hasName ? 26 : 14)) + 'px';
      el.style.transform = 'translate(-50%,-100%)';
      used.add(h.id);
    }

    for (const [id, el] of this._labelEls) {
      if (!used.has(id)) { el.remove(); this._labelEls.delete(id); }
    }
  }

  // ════════════════════════════════════════════════════════
  // 公共方法
  // ════════════════════════════════════════════════════════

  // ── 低缩放快速地形渲染（ImageData 像素直写） ──
  // 视角拉高（scale<2）时，每格 <2px，逐格 fillRect 的 Canvas 2D 开销
  // （路径构建 + 样式设置 + 光栅化）远超直接像素写入。
  // 此方法将全部可见地形一次性写入 ImageData 缓冲区，单次 putImageData 上屏。
  // 同时内联颜色计算，消除每格的对象创建（terrainColor 返回 {r,g,b}）和冗余缓存查找。
  _drawTerrainFast(ctx, cw, ch, scale) {
    const mn = walkMaskN(), moff = walkMaskOff();
    if (mn <= 0) return;

    const iw = this.canvas.width;
    const ih = this.canvas.height;
    const imgData = ctx.createImageData(iw, ih);
    const data = imgData.data;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 背景填充（不透明白）
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }

    const halfW = cw / 2 / scale;
    const halfH = ch / 2 / scale;
    const giMin = Math.max(0, Math.floor(this.cam.cx - halfW) + moff);
    const giMax = Math.min(mn - 1, Math.ceil(this.cam.cx + halfW) + moff);
    const gjMin = Math.max(0, Math.floor(this.cam.cz - halfH) + moff);
    const gjMax = Math.min(mn - 1, Math.ceil(this.cam.cz + halfH) + moff);

    const cx = this.cam.cx, cz = this.cam.cz;
    const subPx = scale < 1; // 亚像素：多格映射到同一像素，需取后者

    for (let gj = gjMin; gj <= gjMax; gj++) {
      const wz = gj - moff;
      for (let gi = giMin; gi <= giMax; gi++) {
        const wx = gi - moff;
        const sampleX = wx + 0.5, sampleZ = wz + 0.5;
        if (terrainBlocked(sampleX, sampleZ)) continue;

        // 内联颜色计算 —— 避免 terrainColor 每格创建 {r,g,b} 对象
        const h = terrainHeight(sampleX, sampleZ);
        let r, g, b;
        if (this.heightColorMode) {
          // 高度色带模式：使用图例渐变颜色
          const band = this._heightToBandRgb(h);
          r = band[0]; g = band[1]; b = band[2];
        } else if (h < WATER_LEVEL) {
          // 湖床 → 暖沙色（暗化版）
          r = 148; g = 134; b = 92;
        } else if (h < 6) {
          // 草地 → 暗化暖绿
          r = 79; g = 139; b = 62;
        } else if (h < 18) {
          // 土坡 → 暗化暖棕
          r = 119; g = 98; b = 62;
        } else if (h < 26) {
          // 岩石 → 暗化浅灰
          r = 126; g = 114; b = 109;
        } else {
          // 雪顶 → 暗化亮白
          r = 184; g = 187; b = 192;
        }

        // 屏幕坐标（CSS 像素）
        const sx = ((wx + 0.5) - cx) * scale + cw / 2;
        const sy = ((wz + 0.5) - cz) * scale + ch / 2;

        if (subPx) {
          // 亚像素：每格 <1px，只写最近的一个物理像素
          const px = (sx * dpr) | 0;
          const py = (sy * dpr) | 0;
          if (px >= 0 && px < iw && py >= 0 && py < ih) {
            const idx = (py * iw + px) * 4;
            data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
          }
        } else {
          // 1≤scale<2：每格占 1~4 物理像素，填充对应矩形
          const px0 = Math.max(0, ((sx - scale / 2) * dpr) | 0);
          const py0 = Math.max(0, ((sy - scale / 2) * dpr) | 0);
          const px1 = Math.min(iw, Math.ceil((sx + scale / 2) * dpr));
          const py1 = Math.min(ih, Math.ceil((sy + scale / 2) * dpr));
          for (let py = py0; py < py1; py++) {
            const rowOff = py * iw;
            for (let px = px0; px < px1; px++) {
              const idx = (rowOff + px) * 4;
              data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  invalidateTerrain() { /* 2D 每帧重绘，无需脏标记 */ }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  dispose() {
    this._labelBox.remove();
  }
}
