// canvas-renderer.js — Canvas 2D 俯视角渲染器（游戏客户端 + 编辑器共享）
// 正交俯视：X→右, Z→下；简洁扁平风格：色块地形 + 彩色圆圈实体
import {
  terrainHeight, terrainBlocked, terrainColor,
  WATER_LEVEL, walkMaskN, walkMaskOff,
} from './terrain.js';
import { skillDef } from './items.js';

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

const BASE_PX_PER_UNIT = 10;   // 基础像素/世界单位（zoom=1 时）
const MAX_SKILL = 128;
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
    this._selfBuffs = [];

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
  setSelfBuffs(buffs) { this._selfBuffs = buffs || []; }
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
      const r = e.kind === 'item' ? 0.4 : (e.radius || 0.55);
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

      // 霸体状态：金色脉冲护盾光环
      if (!s.dead && this._selfBuffs.some(b => b.type === 10)) {
        const asx = (s.x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
        const asy = (s.z - this.cam.cz) * scale + this.canvas.clientHeight / 2;
        const asr = 0.55 * scale;
        const pulse = 0.5 + 0.3 * Math.sin(nowMs / 300);
        ctx.strokeStyle = `rgba(255,215,0,${pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(asx, asy, asr * 1.35, 0, Math.PI * 2);
        ctx.stroke();
      }

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

    // Buff 图标 + 状态视觉（需要 self 引用）
    const s = this._self;
    if (s && this._selfBuffs.length > 0 && !s.dead) {
      const sx = (s.x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
      const sy = (s.z - this.cam.cz) * scale + this.canvas.clientHeight / 2;
      const sr = 0.55 * scale;
      const iconSize = Math.max(10, Math.min(16, scale * 0.35));
      const gap = iconSize + 2;
      const totalW = this._selfBuffs.length * gap;
      const startX = sx - totalW / 2 + iconSize / 2;
      const iconY = sy - sr - 18;
      for (let bi = 0; bi < this._selfBuffs.length; bi++) {
        const buff = this._selfBuffs[bi];
        const bx = startX + bi * gap;
        const isDebuff = buff.type >= 3 && buff.type !== 4 && buff.type !== 5 && buff.type !== 10 && buff.type !== 11;
        ctx.fillStyle = isDebuff ? 'rgba(220,50,50,0.75)' : 'rgba(50,180,80,0.75)';
        const rr = iconSize / 2 + 1;
        ctx.beginPath(); ctx.arc(bx, iconY, rr, 0, Math.PI * 2); ctx.fill();
        const sd = skillDef(buff.skillId);
        ctx.font = `${iconSize}px serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(sd.icon || '❔', bx, iconY);
        if (buff.remainSec > 0) {
          const total = buff.totalSec || 10;
          const ratio = Math.max(0, Math.min(1, buff.remainSec / total));
          ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(bx, iconY, rr + 1.5, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2); ctx.stroke();
        }
      }
    }
    // 减速状态：蓝色冰霜粒子拖尾
    if (s && !s.dead && this._selfBuffs.some(b => b.type === 3)) {
      const sx = (s.x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
      const sy = (s.z - this.cam.cz) * scale + this.canvas.clientHeight / 2;
      const sr = 0.55 * scale;
      for (let p = 0; p < 3; p++) {
        const phase = (nowMs / 400 + p * 2.1) % 1;
        const px = sx + Math.sin(phase * 6.28 + p) * sr * 0.8;
        const py = sy + sr * 0.5 + phase * sr * 0.6;
        const a = (1 - phase) * 0.5;
        ctx.fillStyle = `rgba(100,180,255,${a})`;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.5, 2.5 * (1 - phase)), 0, Math.PI * 2); ctx.fill();
      }
    }
    // 加速状态：绿色风线拖尾
    if (s && !s.dead && this._selfBuffs.some(b => b.type === 11)) {
      const sx = (s.x - this.cam.cx) * scale + this.canvas.clientWidth / 2;
      const sy = (s.z - this.cam.cz) * scale + this.canvas.clientHeight / 2;
      const sr = 0.55 * scale;
      ctx.strokeStyle = 'rgba(105,240,174,0.45)'; ctx.lineWidth = 1.5;
      for (let l = 0; l < 3; l++) {
        const phase = (nowMs / 300 + l * 1.5) % 1;
        const ox = -sr * (0.6 + l * 0.3);
        const oy = (l - 1) * sr * 0.4;
        const len = sr * 0.6;
        ctx.globalAlpha = (1 - phase) * 0.6;
        ctx.beginPath(); ctx.moveTo(sx + ox, sy + oy); ctx.lineTo(sx + ox - len, sy + oy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
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

      // cast 效果：追踪施法者实体位置用于扫掠方向，蓄力圈位置（ex/ez）保持落点不变
      let casterX = ex, casterZ = ez;
      if (ef.kind === 'cast' && ef.wid > 0) {
        for (const e of this._entities) {
          if (e.wid === ef.wid) { casterX = e.x; casterZ = e.z; break; }
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
      } else if (ef.kind === 'dash') {
        // ── 位移拖尾：从施法者旧位置到目标位置的渐隐线迹 ──
        // 跟随施法者实体（如果找到），否则用存储的 casterX/casterZ
        let fromX = ef.x1, fromZ = ef.z1;
        if (ef.wid > 0) {
          for (const e of this._entities) {
            if (e.wid === ef.wid) { fromX = e.x; fromZ = e.z; break; }
          }
        }
        const fsx = (fromX - this.cam.cx) * scale + cw / 2;
        const fsy = (fromZ - this.cam.cz) * scale + ch / 2;
        // 拖尾线（从旧位置到落点）
        ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.9);
        ctx.lineWidth = 3 * (1 - life * 0.5);
        ctx.beginPath();
        ctx.moveTo(fsx, fsy);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        // 落点闪光圆
        const flashR = sr * (1 + life * 0.5);
        ctx.fillStyle = rgbStr(r, g, b, alpha * 0.25);
        ctx.beginPath();
        ctx.arc(sx, sy, flashR, 0, Math.PI * 2);
        ctx.fill();
      } else if (ef.kind === 'float') {
        // ── 伤害/治疗飘字：上升 + 渐隐 + 弹出缩放 ──
        const floatY = sy - life * 45;
        const [fr, fg, fb] = hexRgb(ef.color || '#ef4444');
        const popScale = life < 0.15 ? 0.6 + (life / 0.15) * 0.6 : 1.2 - life * 0.25;
        const fontSize = Math.max(10, Math.round(16 * popScale));
        ctx.font = `bold ${fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = rgbStr(fr, fg, fb, alpha);
        ctx.fillText(ef.text || '', sx, floatY);
      } else if (ef.kind === 'projectile') {
        // ── 追踪射线：施法者 → 目标的飞行弹体 + 元素特效尾迹 ──
        // 玩家自身射线：实时追踪玩家当前位置（移动时射线起点跟随）
        // 怪物射线：固定起点（this._self 不是施法者，距离检查排除）
        let curX1 = ef.x1, curZ1 = ef.z1;
        if (this._self) {
          const dStart = Math.hypot(ef.x1 - this._self.x, ef.z1 - this._self.z);
          if (dStart < 3) { curX1 = this._self.x; curZ1 = this._self.z; }
        }
        const dx = ef.x2 - curX1, dz = ef.z2 - curZ1;
        const px = curX1 + dx * life;
        const pz = curZ1 + dz * life;
        const psx = (px - this.cam.cx) * scale + cw / 2;
        const psy = (pz - this.cam.cz) * scale + ch / 2;
        const ang = Math.atan2(dz, dx);
        const fxAng = ef.initAng !== undefined ? ef.initAng : ang; // 元素特效使用初始角度（避免移动时方向混乱）
        const pat = ef.pattern || 'ring';
        const fadeIn = Math.min(1, life * 6);  // 快速淡入

        // ── 通用尾迹基线（所有元素共享的渐隐拖尾） ──
        const trailCount = 4;
        for (let t = 0; t < trailCount; t++) {
          const tFrac = (t + 1) / (trailCount + 1);
          const segLen = 0.08;
          const la = Math.min(tFrac, life);
          const lb = Math.min(tFrac + segLen, life);
          const lax = curX1 + dx * la, laz = curZ1 + dz * la;
          const lbx = curX1 + dx * lb, lbz = curZ1 + dz * lb;
          const lsx1 = (lax - this.cam.cx) * scale + cw / 2;
          const lsy1 = (laz - this.cam.cz) * scale + ch / 2;
          const lsx2 = (lbx - this.cam.cx) * scale + cw / 2;
          const lsy2 = (lbz - this.cam.cz) * scale + ch / 2;
          const ta = alpha * (0.5 - t * 0.1) * fadeIn;
          ctx.strokeStyle = rgbStr(r, g, b, ta);
          ctx.lineWidth = (3.5 - t * 0.7) * fadeIn;
          ctx.beginPath(); ctx.moveTo(lsx1, lsy1); ctx.lineTo(lsx2, lsy2); ctx.stroke();
        }

        // ── 元素专属弹头 + 粒子 ──
        if (pat === 'fire') {
          // 火焰弹头：橙黄脉动核心 + 火星粒子尾迹
          const pulse = 1 + Math.sin(life * 28) * 0.2;
          const headR = 5 * pulse * fadeIn;
          // 外层火舌光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 3);
          grd.addColorStop(0, rgbStr(1, 0.9, 0.3, alpha * 0.6 * fadeIn));
          grd.addColorStop(0.35, rgbStr(1, 0.5, 0.05, alpha * 0.3 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 3, 0, Math.PI * 2); ctx.fill();
          // 白色热核
          ctx.fillStyle = rgbStr(1, 0.95, 0.8, alpha * 0.95 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.4, 0, Math.PI * 2); ctx.fill();
          // 火星粒子（沿尾迹散布）
          for (let s = 0; s < 5; s++) {
            const sparkLife = (life - s * 0.06 + 1) % 1;
            const sparkT = sparkLife * 0.7;
            const spx = curX1 + dx * sparkT + Math.sin(life * 18 + s * 2.3) * 0.25;
            const spz = curZ1 + dz * sparkT + Math.cos(life * 18 + s * 2.3) * 0.25;
            const ssx = (spx - this.cam.cx) * scale + cw / 2;
            const ssy = (spz - this.cam.cz) * scale + ch / 2;
            const sa = (1 - sparkT / 0.7) * alpha * 0.7 * fadeIn;
            ctx.fillStyle = rgbStr(1, 0.6 + s * 0.06, 0.1, sa);
            ctx.beginPath(); ctx.arc(ssx, ssy, Math.max(1, 2.5 * (1 - sparkT)), 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'ice') {
          // 冰霜弹头：蓝白晶体核心 + 冰晶碎片旋转
          const headR = 5 * fadeIn;
          // 冰蓝光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 2.5);
          grd.addColorStop(0, rgbStr(0.7, 0.9, 1, alpha * 0.65 * fadeIn));
          grd.addColorStop(0.5, rgbStr(0.4, 0.7, 1, alpha * 0.2 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 2.5, 0, Math.PI * 2); ctx.fill();
          // 白色冰核
          ctx.fillStyle = rgbStr(0.9, 0.97, 1, alpha * 0.95 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.35, 0, Math.PI * 2); ctx.fill();
          // 旋转冰晶碎片
          for (let c = 0; c < 4; c++) {
            const cAng = life * 8 + c * Math.PI / 2;
            const cDist = headR * (1.2 + Math.sin(life * 12 + c) * 0.4);
            const cx2 = psx + Math.cos(cAng) * cDist;
            const cy2 = psy + Math.sin(cAng) * cDist;
            const csz = Math.max(1.5, 3 * fadeIn * (1 - c * 0.15));
            ctx.fillStyle = rgbStr(0.8, 0.95, 1, alpha * 0.7 * fadeIn);
            ctx.save(); ctx.translate(cx2, cy2); ctx.rotate(cAng);
            ctx.beginPath(); ctx.moveTo(0, -csz); ctx.lineTo(csz * 0.5, 0); ctx.lineTo(0, csz); ctx.lineTo(-csz * 0.5, 0); ctx.closePath();
            ctx.fill(); ctx.restore();
          }
        } else if (pat === 'lightning') {
          // 雷电弹头：电黄锯齿核心 + 电弧分支
          const headR = 4.5 * fadeIn;
          // 电弧光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 3);
          grd.addColorStop(0, rgbStr(1, 1, 0.85, alpha * 0.7 * fadeIn));
          grd.addColorStop(0.3, rgbStr(0.7, 0.7, 1, alpha * 0.25 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 3, 0, Math.PI * 2); ctx.fill();
          // 白热核心
          ctx.fillStyle = rgbStr(1, 1, 0.95, alpha * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.35, 0, Math.PI * 2); ctx.fill();
          // 电弧分支（沿尾迹方向锯齿）
          ctx.strokeStyle = rgbStr(0.8, 0.85, 1, alpha * 0.6 * fadeIn);
          ctx.lineWidth = 1.5 * fadeIn;
          for (let bolt = 0; bolt < 2; bolt++) {
            const boltDir = bolt === 0 ? 1 : -1;
            ctx.beginPath();
            const perpX = -Math.sin(ang) * boltDir;
            const perpZ = Math.cos(ang) * boltDir;
            let bx = psx, by = psy;
            ctx.moveTo(bx, by);
            for (let seg = 1; seg <= 3; seg++) {
              const segFrac = seg / 3;
              const jitter = (Math.sin(life * 30 + bolt * 5 + seg * 3) * 6 + 4) * segFrac;
              bx = psx - Math.cos(ang) * seg * 8 + perpX * jitter;
              by = psy - Math.sin(ang) * seg * 8 + perpZ * jitter;
              ctx.lineTo(bx, by);
            }
            ctx.stroke();
          }
        } else if (pat === 'smoke') {
          // 暗影弹头：暗紫黑核心 + 烟雾缭绕
          const headR = 5 * fadeIn;
          // 暗紫光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 2.5);
          grd.addColorStop(0, rgbStr(0.4, 0.15, 0.5, alpha * 0.6 * fadeIn));
          grd.addColorStop(0.5, rgbStr(0.2, 0.05, 0.3, alpha * 0.25 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 2.5, 0, Math.PI * 2); ctx.fill();
          // 暗核
          ctx.fillStyle = rgbStr(0.6, 0.2, 0.7, alpha * 0.9 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.4, 0, Math.PI * 2); ctx.fill();
          // 烟雾粒子
          for (let p = 0; p < 4; p++) {
            const pAng = life * 3 + p * Math.PI / 2;
            const pDist = headR * (1 + Math.sin(life * 6 + p * 1.7) * 0.5);
            const ppx = psx + Math.cos(pAng) * pDist;
            const ppy = psy + Math.sin(pAng) * pDist;
            const pr = Math.max(2, (3 + p) * fadeIn * (0.6 + Math.sin(life * 8 + p) * 0.3));
            ctx.fillStyle = rgbStr(0.3, 0.1, 0.4, alpha * 0.2 * fadeIn);
            ctx.beginPath(); ctx.arc(ppx, ppy, pr, 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'holy') {
          // 圣光弹头：金色放射核心 + 光线射线
          const headR = 5 * fadeIn;
          // 金色光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 3);
          grd.addColorStop(0, rgbStr(1, 0.95, 0.7, alpha * 0.7 * fadeIn));
          grd.addColorStop(0.4, rgbStr(1, 0.8, 0.3, alpha * 0.2 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 3, 0, Math.PI * 2); ctx.fill();
          // 白色圣核
          ctx.fillStyle = rgbStr(1, 1, 0.95, alpha * 0.95 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.35, 0, Math.PI * 2); ctx.fill();
          // 放射光线
          ctx.strokeStyle = rgbStr(1, 0.9, 0.5, alpha * 0.5 * fadeIn);
          ctx.lineWidth = 1.5 * fadeIn;
          for (let ray = 0; ray < 6; ray++) {
            const rayAng = ray * Math.PI / 3 + life * 4;
            const rayLen = headR * (1.8 + Math.sin(life * 15 + ray * 2) * 0.6);
            ctx.beginPath();
            ctx.moveTo(psx + Math.cos(rayAng) * headR * 0.5, psy + Math.sin(rayAng) * headR * 0.5);
            ctx.lineTo(psx + Math.cos(rayAng) * rayLen, psy + Math.sin(rayAng) * rayLen);
            ctx.stroke();
          }
        } else if (pat === 'snipe') {
          // 狙击弹头：明亮箭矢 + 发光拖尾
          const headR = 4.5 * fadeIn;
          // 橙色光晕（狙击使用橙色主色调）
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 3.5);
          grd.addColorStop(0, rgbStr(1, 0.85, 0.4, alpha * 0.75 * fadeIn));
          grd.addColorStop(0.3, rgbStr(1, 0.6, 0.15, alpha * 0.35 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 3.5, 0, Math.PI * 2); ctx.fill();
          // 箭矢形状（菱形弹头，沿飞行方向拉伸）使用初始角度
          const arrowLen = headR * 2.2;
          const arrowWid = headR * 0.6;
          ctx.fillStyle = rgbStr(1, 0.95, 0.8, alpha * 0.95 * fadeIn);
          ctx.save(); ctx.translate(psx, psy); ctx.rotate(fxAng);
          ctx.beginPath();
          ctx.moveTo(arrowLen, 0);          // 箭尖
          ctx.lineTo(0, arrowWid);           // 上翼
          ctx.lineTo(-arrowLen * 0.4, 0);    // 箭尾凹口
          ctx.lineTo(0, -arrowWid);          // 下翼
          ctx.closePath(); ctx.fill();
          // 箭矢白色高光核心
          ctx.fillStyle = rgbStr(1, 1, 1, alpha * 0.9 * fadeIn);
          ctx.beginPath();
          ctx.moveTo(arrowLen * 0.6, 0);
          ctx.lineTo(0, arrowWid * 0.4);
          ctx.lineTo(-arrowLen * 0.2, 0);
          ctx.lineTo(0, -arrowWid * 0.4);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          // 发光拖尾线（沿飞行反方向的明亮光带）使用初始角度
          const trailAng = fxAng + Math.PI;
          ctx.strokeStyle = rgbStr(1, 0.8, 0.3, alpha * 0.6 * fadeIn);
          ctx.lineWidth = 2.5 * fadeIn;
          ctx.beginPath();
          ctx.moveTo(psx, psy);
          ctx.lineTo(psx + Math.cos(trailAng) * headR * 4, psy + Math.sin(trailAng) * headR * 4);
          ctx.stroke();
          // 拖尾边缘渐隐细线
          ctx.strokeStyle = rgbStr(1, 0.7, 0.2, alpha * 0.3 * fadeIn);
          ctx.lineWidth = 1.2 * fadeIn;
          for (let tl = 0; tl < 2; tl++) {
            const off = (tl === 0 ? 1 : -1) * 2;
            const perpX = -Math.sin(fxAng) * off;
            const perpZ = Math.cos(fxAng) * off;
            ctx.beginPath();
            ctx.moveTo(psx + perpX, psy + perpZ);
            ctx.lineTo(psx + perpX + Math.cos(trailAng) * headR * 3, psy + perpZ + Math.sin(trailAng) * headR * 3);
            ctx.stroke();
          }
        } else if (pat === 'lifesteal') {
          // 吸血弹头：暗红脉动核心 + 生命吸取粒子（反向流动）
          const pulse = 1 + Math.sin(life * 20) * 0.25;
          const headR = 5 * pulse * fadeIn;
          // 暗红/紫色光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 3);
          grd.addColorStop(0, rgbStr(0.6, 0.1, 0.2, alpha * 0.7 * fadeIn));
          grd.addColorStop(0.4, rgbStr(0.4, 0.05, 0.3, alpha * 0.35 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 3, 0, Math.PI * 2); ctx.fill();
          // 脉动核心（深红色）
          ctx.fillStyle = rgbStr(0.8, 0.15, 0.25, alpha * 0.9 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.5, 0, Math.PI * 2); ctx.fill();
          // 白色高光点
          ctx.fillStyle = rgbStr(1, 0.8, 0.85, alpha * 0.8 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.2, 0, Math.PI * 2); ctx.fill();
          // 生命吸取粒子（从目标方向流向施法者，反向流动）
          const drainAng = fxAng + Math.PI; // 反向（目标→施法者）使用初始角度
          for (let p = 0; p < 5; p++) {
            const pLife = (life * 3 + p * 0.2) % 1;
            const pDist = headR * (1 + pLife * 3);
            const ppx = psx + Math.cos(drainAng) * pDist + Math.sin(life * 12 + p * 1.5) * 3;
            const ppy = psy + Math.sin(drainAng) * pDist + Math.cos(life * 12 + p * 1.5) * 3;
            const pSize = Math.max(1.5, 3 * (1 - pLife) * fadeIn);
            const pAlpha = (1 - pLife) * alpha * 0.6 * fadeIn;
            // 暗红色粒子
            ctx.fillStyle = rgbStr(0.7, 0.1, 0.2, pAlpha);
            ctx.beginPath(); ctx.arc(ppx, ppy, pSize, 0, Math.PI * 2); ctx.fill();
          }
          // 暗影能量线（螺旋缠绕）
          ctx.strokeStyle = rgbStr(0.5, 0.05, 0.3, alpha * 0.4 * fadeIn);
          ctx.lineWidth = 1.5 * fadeIn;
          ctx.beginPath();
          for (let s = 0; s < 8; s++) {
            const t = s / 8;
            const spiralAng = drainAng + t * Math.PI * 2 + life * 8;
            const spiralR = headR * (0.5 + t * 2);
            const spx = psx + Math.cos(spiralAng) * spiralR;
            const spy = psy + Math.sin(spiralAng) * spiralR;
            if (s === 0) ctx.moveTo(spx, spy);
            else ctx.lineTo(spx, spy);
          }
          ctx.stroke();
        } else if (pat === 'thunder') {
          // 雷霆弹头：从天而降的强烈雷电 + 多分支闪电
          const headR = 6 * fadeIn;
          // 强烈的电蓝光晕
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 4);
          grd.addColorStop(0, rgbStr(0.9, 0.95, 1, alpha * 0.8 * fadeIn));
          grd.addColorStop(0.25, rgbStr(0.5, 0.7, 1, alpha * 0.4 * fadeIn));
          grd.addColorStop(0.6, rgbStr(0.3, 0.4, 0.9, alpha * 0.15 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 4, 0, Math.PI * 2); ctx.fill();
          // 白热核心（脉动）
          const pulse = 1 + Math.sin(life * 35) * 0.3;
          ctx.fillStyle = rgbStr(1, 1, 1, alpha * 0.95 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.4 * pulse, 0, Math.PI * 2); ctx.fill();
          // 电蓝色内核
          ctx.fillStyle = rgbStr(0.6, 0.8, 1, alpha * 0.85 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.6 * pulse, 0, Math.PI * 2); ctx.fill();
          // 多分支闪电（从核心向外放射）
          ctx.strokeStyle = rgbStr(0.8, 0.9, 1, alpha * 0.7 * fadeIn);
          ctx.lineWidth = 2 * fadeIn;
          for (let bolt = 0; bolt < 4; bolt++) {
            const boltAng = bolt * Math.PI / 2 + life * 12;
            const boltLen = headR * (1.5 + Math.sin(life * 20 + bolt * 2) * 0.8);
            ctx.beginPath();
            let bx = psx, by = psy;
            ctx.moveTo(bx, by);
            // 锯齿形闪电路径
            for (let seg = 1; seg <= 3; seg++) {
              const segFrac = seg / 3;
              const jitter = Math.sin(life * 40 + bolt * 3 + seg * 5) * 5 * segFrac;
              bx = psx + Math.cos(boltAng) * boltLen * segFrac + Math.cos(boltAng + Math.PI / 2) * jitter;
              by = psy + Math.sin(boltAng) * boltLen * segFrac + Math.sin(boltAng + Math.PI / 2) * jitter;
              ctx.lineTo(bx, by);
            }
            ctx.stroke();
          }
          // 从天而降的雷电轨迹（从上方延伸下来的主闪电）
          const thunderY = psy - headR * 6 * (1 - life * 0.5);
          ctx.strokeStyle = rgbStr(0.9, 0.95, 1, alpha * 0.6 * fadeIn);
          ctx.lineWidth = 2.5 * fadeIn;
          ctx.beginPath();
          ctx.moveTo(psx + Math.sin(life * 25) * 3, thunderY);
          // 锯齿形下落路径
          for (let seg = 1; seg <= 4; seg++) {
            const segY = thunderY + (psy - thunderY) * (seg / 4);
            const jitter = Math.sin(life * 30 + seg * 4) * 4;
            ctx.lineTo(psx + jitter, segY);
          }
          ctx.stroke();
        } else if (pat === 'slash') {
          // 斩击弹头：简洁明快的近战斩击弧线
          const headR = 4 * fadeIn;
          // 白色光晕（简洁）
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 2);
          grd.addColorStop(0, rgbStr(1, 1, 1, alpha * 0.6 * fadeIn));
          grd.addColorStop(0.5, rgbStr(0.9, 0.9, 0.95, alpha * 0.2 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 2, 0, Math.PI * 2); ctx.fill();
          // 白色核心
          ctx.fillStyle = rgbStr(1, 1, 1, alpha * 0.9 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.4, 0, Math.PI * 2); ctx.fill();
          // 斩击弧线（沿飞行方向的弧形斩击）使用初始角度
          const slashAng = fxAng;
          const slashLen = headR * 2.5;
          const slashWidth = Math.PI * 0.6; // 弧线张角
          ctx.strokeStyle = rgbStr(1, 1, 1, alpha * 0.8 * fadeIn);
          ctx.lineWidth = 2.5 * fadeIn;
          ctx.beginPath();
          ctx.arc(psx, psy, slashLen, slashAng - slashWidth, slashAng + slashWidth);
          ctx.stroke();
          // 内层细弧线（更亮的斩击边缘）
          ctx.strokeStyle = rgbStr(1, 0.95, 0.9, alpha * 0.6 * fadeIn);
          ctx.lineWidth = 1.5 * fadeIn;
          ctx.beginPath();
          ctx.arc(psx, psy, slashLen * 0.7, slashAng - slashWidth * 0.8, slashAng + slashWidth * 0.8);
          ctx.stroke();
          // 打击火花粒子（2-3 颗小火花）
          for (let s = 0; s < 3; s++) {
            const sparkAng = slashAng + (s - 1) * 0.3;
            const sparkDist = slashLen * (0.8 + Math.sin(life * 15 + s) * 0.2);
            const spx = psx + Math.cos(sparkAng) * sparkDist;
            const spy = psy + Math.sin(sparkAng) * sparkDist;
            const sparkSize = Math.max(1, 2 * (1 - life) * fadeIn);
            ctx.fillStyle = rgbStr(1, 0.95, 0.8, alpha * 0.7 * (1 - life) * fadeIn);
            ctx.beginPath(); ctx.arc(spx, spy, sparkSize, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          // 物理/默认：简洁白色弹头 + 运动线条
          const headR = 4 * fadeIn;
          const grd = ctx.createRadialGradient(psx, psy, 0, psx, psy, headR * 2);
          grd.addColorStop(0, rgbStr(1, 1, 1, alpha * 0.7 * fadeIn));
          grd.addColorStop(0.5, rgbStr(r, g, b, alpha * 0.2 * fadeIn));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(psx, psy, headR * 2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = rgbStr(1, 1, 1, alpha * 0.9 * fadeIn);
          ctx.beginPath(); ctx.arc(psx, psy, headR * 0.4, 0, Math.PI * 2); ctx.fill();
          // 运动线条
          ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.4 * fadeIn);
          ctx.lineWidth = 1.5 * fadeIn;
          for (let ln = 0; ln < 3; ln++) {
            const off = (ln - 1) * 3;
            const perpX = -Math.sin(ang) * off;
            const perpZ = Math.cos(ang) * off;
            ctx.beginPath();
            ctx.moveTo(psx + perpX - Math.cos(ang) * 4, psy + perpZ - Math.sin(ang) * 4);
            ctx.lineTo(psx + perpX - Math.cos(ang) * (10 + ln * 3), psy + perpZ - Math.sin(ang) * (10 + ln * 3));
            ctx.stroke();
          }
        }

        // ── 命中闪光（life > 0.85 时目标端出现扩散光圈） ──
        if (life > 0.85) {
          const impactAlpha = (life - 0.85) / 0.15;
          const impactR = (1.5 + impactAlpha * 1.5) * scale;
          const isx = (ef.x2 - this.cam.cx) * scale + cw / 2;
          const isy = (ef.z2 - this.cam.cz) * scale + ch / 2;
          ctx.strokeStyle = rgbStr(r, g, b, (1 - impactAlpha) * 0.6);
          ctx.lineWidth = 2 * (1 - impactAlpha);
          ctx.beginPath(); ctx.arc(isx, isy, impactR, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (ef.kind === 'burst') {
        // ── 元素命中特效：按 pattern 分支渲染 ──
        const pat = ef.pattern || 'ring';
        const maxR = sr || 2 * scale;
        if (pat === 'fire') {
          const er = maxR * (0.3 + life * 0.9);
          ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.8);
          ctx.lineWidth = 3 * (1 - life);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          const ir = maxR * life * 0.5;
          ctx.fillStyle = rgbStr(1, 0.85, 0.2, alpha * 0.3);
          ctx.beginPath(); ctx.arc(sx, sy, ir, 0, Math.PI * 2); ctx.fill();
          for (let s = 0; s < 6; s++) {
            const ang = (s / 6) * Math.PI * 2 + life * 2;
            const sd = maxR * (0.2 + life * 0.8);
            const sparkX = sx + Math.cos(ang) * sd;
            const sparkY = sy + Math.sin(ang) * sd - life * 20;
            ctx.fillStyle = rgbStr(1, 0.6, 0.1, alpha * 0.7);
            ctx.beginPath(); ctx.arc(sparkX, sparkY, Math.max(1, 2.5 * (1 - life)), 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'ice') {
          for (let ring = 0; ring < 2; ring++) {
            const rr = maxR * (0.2 + life * (0.7 + ring * 0.3));
            ctx.strokeStyle = rgbStr(r, g, b, alpha * (0.7 - ring * 0.3));
            ctx.lineWidth = 2 - ring * 0.5;
            ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
          }
          for (let c = 0; c < 6; c++) {
            const ang = (c / 6) * Math.PI * 2;
            const cd = maxR * life * 0.9;
            const cx2 = sx + Math.cos(ang) * cd;
            const cy2 = sy + Math.sin(ang) * cd;
            const sz = Math.max(2, 4 * (1 - life));
            ctx.fillStyle = rgbStr(0.8, 0.95, 1, alpha * 0.6);
            ctx.save(); ctx.translate(cx2, cy2); ctx.rotate(ang + life * 2);
            ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.5, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz * 0.5, 0); ctx.closePath();
            ctx.fill(); ctx.restore();
          }
        } else if (pat === 'lightning') {
          const topY = sy - maxR * 2.5;
          ctx.strokeStyle = rgbStr(1, 1, 0.8, alpha * 0.9);
          ctx.lineWidth = 2.5 * (1 - life * 0.5);
          ctx.beginPath(); ctx.moveTo(sx + 2, topY);
          const segs = 5;
          for (let j = 1; j <= segs; j++) {
            const t = j / segs;
            const bx = sx + 2 + (Math.random() - 0.5) * maxR * 0.5 * (1 - t * 0.5);
            const by = topY + (sy - topY) * t;
            ctx.lineTo(bx, by);
          }
          ctx.stroke();
          const flashR = maxR * 0.5 * (1 + life * 0.5);
          ctx.fillStyle = rgbStr(1, 1, 0.9, alpha * 0.4);
          ctx.beginPath(); ctx.arc(sx, sy, flashR, 0, Math.PI * 2); ctx.fill();
        } else if (pat === 'smoke') {
          for (let p = 0; p < 5; p++) {
            const ang = (p / 5) * Math.PI * 2 + life * 0.5;
            const dist = maxR * (0.15 + life * 0.7);
            const px = sx + Math.cos(ang) * dist;
            const py = sy + Math.sin(ang) * dist - life * 12;
            const pr = Math.max(2, (3 + p * 1.5) * (0.5 + life * 0.6));
            ctx.fillStyle = rgbStr(r, g, b, alpha * 0.25);
            ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'snipe') {
          // 狙击命中：明亮扩散光圈 + 十字闪光
          const er = maxR * (0.3 + life * 1.2);
          // 扩散光圈
          ctx.strokeStyle = rgbStr(1, 0.85, 0.4, alpha * 0.8);
          ctx.lineWidth = 3 * (1 - life * 0.6);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          // 内层白色闪光
          if (life < 0.4) {
            const flashA = (0.4 - life) / 0.4;
            ctx.fillStyle = rgbStr(1, 1, 0.9, flashA * 0.6);
            ctx.beginPath(); ctx.arc(sx, sy, maxR * 0.5 * (1 - life / 0.4), 0, Math.PI * 2); ctx.fill();
          }
          // 十字光线
          ctx.strokeStyle = rgbStr(1, 0.9, 0.5, alpha * 0.7);
          ctx.lineWidth = 2 * (1 - life);
          const crossLen = maxR * (0.5 + life * 1.5);
          ctx.beginPath(); ctx.moveTo(sx - crossLen, sy); ctx.lineTo(sx + crossLen, sy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sx, sy - crossLen); ctx.lineTo(sx, sy + crossLen); ctx.stroke();
        } else if (pat === 'lifesteal') {
          // 吸血命中：暗红脉动扩散 + 生命吸取粒子
          const er = maxR * (0.25 + life * 1.1);
          // 暗红扩散光圈
          ctx.strokeStyle = rgbStr(0.7, 0.1, 0.2, alpha * 0.8);
          ctx.lineWidth = 3 * (1 - life * 0.5);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          // 内层紫色闪光
          if (life < 0.5) {
            const flashA = (0.5 - life) / 0.5;
            ctx.fillStyle = rgbStr(0.5, 0.05, 0.3, flashA * 0.5);
            ctx.beginPath(); ctx.arc(sx, sy, maxR * 0.6 * (1 - life / 0.5), 0, Math.PI * 2); ctx.fill();
          }
          // 生命吸取粒子（向外扩散后回收）
          for (let p = 0; p < 6; p++) {
            const pAng = (p / 6) * Math.PI * 2 + life * 3;
            const pDist = maxR * (0.3 + life * 0.8);
            const ppx = sx + Math.cos(pAng) * pDist;
            const ppy = sy + Math.sin(pAng) * pDist;
            const pSize = Math.max(1.5, 3 * (1 - life) );
            ctx.fillStyle = rgbStr(0.8, 0.15, 0.25, alpha * 0.6 * (1 - life));
            ctx.beginPath(); ctx.arc(ppx, ppy, pSize, 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'thunder') {
          // 雷霆命中：强烈电光爆炸 + 多方向闪电扩散
          const er = maxR * (0.3 + life * 1.3);
          // 电蓝扩散光圈
          ctx.strokeStyle = rgbStr(0.6, 0.8, 1, alpha * 0.85);
          ctx.lineWidth = 3.5 * (1 - life * 0.5);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          // 内层白色强烈闪光
          if (life < 0.35) {
            const flashA = (0.35 - life) / 0.35;
            ctx.fillStyle = rgbStr(1, 1, 1, flashA * 0.7);
            ctx.beginPath(); ctx.arc(sx, sy, maxR * 0.7 * (1 - life / 0.35), 0, Math.PI * 2); ctx.fill();
          }
          // 多方向闪电扩散（8 条锯齿闪电）
          ctx.strokeStyle = rgbStr(0.8, 0.9, 1, alpha * 0.7);
          ctx.lineWidth = 2 * (1 - life);
          for (let bolt = 0; bolt < 8; bolt++) {
            const boltAng = (bolt / 8) * Math.PI * 2;
            const boltLen = maxR * (0.5 + life * 1.5);
            ctx.beginPath();
            let bx = sx, by = sy;
            ctx.moveTo(bx, by);
            for (let seg = 1; seg <= 2; seg++) {
              const segFrac = seg / 2;
              const jitter = Math.sin(bolt * 5 + seg * 3) * 4 * segFrac;
              bx = sx + Math.cos(boltAng) * boltLen * segFrac + Math.cos(boltAng + Math.PI / 2) * jitter;
              by = sy + Math.sin(boltAng) * boltLen * segFrac + Math.sin(boltAng + Math.PI / 2) * jitter;
              ctx.lineTo(bx, by);
            }
            ctx.stroke();
          }
        } else if (pat === 'slash') {
          // 斩击命中：快速扩散的白色斩击弧线 + 打击火花
          const er = maxR * (0.3 + life * 1.0);
          // 白色扩散光圈
          ctx.strokeStyle = rgbStr(1, 1, 1, alpha * 0.8);
          ctx.lineWidth = 2.5 * (1 - life * 0.5);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          // 交叉斩击弧线（X 形）
          ctx.strokeStyle = rgbStr(1, 0.95, 0.9, alpha * 0.7 * (1 - life));
          ctx.lineWidth = 2 * (1 - life);
          const slashLen = maxR * (0.6 + life * 0.8);
          // 第一条弧线
          ctx.beginPath();
          ctx.arc(sx, sy, slashLen, -Math.PI * 0.3, Math.PI * 0.3);
          ctx.stroke();
          // 第二条弧线（垂直方向）
          ctx.beginPath();
          ctx.arc(sx, sy, slashLen * 0.8, Math.PI * 0.2, Math.PI * 0.8);
          ctx.stroke();
          // 打击火花（4 颗向外扩散）
          for (let s = 0; s < 4; s++) {
            const sparkAng = (s / 4) * Math.PI * 2 + Math.PI / 4;
            const sparkDist = maxR * (0.4 + life * 0.6);
            const spx = sx + Math.cos(sparkAng) * sparkDist;
            const spy = sy + Math.sin(sparkAng) * sparkDist;
            const sparkSize = Math.max(1.5, 3 * (1 - life));
            ctx.fillStyle = rgbStr(1, 0.9, 0.7, alpha * 0.6 * (1 - life));
            ctx.beginPath(); ctx.arc(spx, spy, sparkSize, 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'inferno') {
          // 烈焰冲击命中：强烈的火焰爆炸 + 火柱扩散 + 火星四溅
          const er = maxR * (0.3 + life * 1.2);
          // 外层火焰扩散（橙红色）
          ctx.fillStyle = rgbStr(1, 0.4, 0.05, alpha * 0.3 * (1 - life));
          ctx.beginPath(); ctx.arc(sx, sy, er * 1.2, 0, Math.PI * 2); ctx.fill();
          // 中层火焰（亮橙色）
          ctx.fillStyle = rgbStr(1, 0.6, 0.1, alpha * 0.4 * (1 - life * 0.5));
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.fill();
          // 内层火焰核心（黄白色）
          if (life < 0.5) {
            const coreA = (0.5 - life) / 0.5;
            ctx.fillStyle = rgbStr(1, 0.9, 0.4, coreA * 0.6);
            ctx.beginPath(); ctx.arc(sx, sy, er * 0.5, 0, Math.PI * 2); ctx.fill();
          }
          // 火焰边缘锯齿（模拟火舌）
          ctx.strokeStyle = rgbStr(1, 0.5, 0.05, alpha * 0.7);
          ctx.lineWidth = 2.5 * (1 - life);
          ctx.beginPath();
          for (let i = 0; i < 12; i++) {
            const ang = (i / 12) * Math.PI * 2 + life * 3;
            const flameLen = er * (0.8 + Math.sin(life * 15 + i * 2) * 0.3);
            const fx = sx + Math.cos(ang) * flameLen;
            const fy = sy + Math.sin(ang) * flameLen;
            if (i === 0) ctx.moveTo(fx, fy);
            else ctx.lineTo(fx, fy);
          }
          ctx.closePath(); ctx.stroke();
          // 火星四溅（8 颗向外飞散的火星）
          for (let s = 0; s < 8; s++) {
            const sparkAng = (s / 8) * Math.PI * 2 + life * 2;
            const sparkDist = maxR * (0.5 + life * 1.5);
            const spx = sx + Math.cos(sparkAng) * sparkDist;
            const spy = sy + Math.sin(sparkAng) * sparkDist - life * 15; // 向上飘
            const sparkSize = Math.max(1.5, 3.5 * (1 - life));
            ctx.fillStyle = rgbStr(1, 0.7 + s * 0.03, 0.1, alpha * 0.7 * (1 - life));
            ctx.beginPath(); ctx.arc(spx, spy, sparkSize, 0, Math.PI * 2); ctx.fill();
          }
        } else if (pat === 'frost') {
          // 冰霜新星命中：华丽的冰晶爆炸 + 冰刺扩散 + 冰晶碎片
          const er = maxR * (0.3 + life * 1.1);
          // 外层冰蓝扩散（淡蓝色光晕）
          const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, er * 1.3);
          grd.addColorStop(0, rgbStr(0.7, 0.9, 1, alpha * 0.4 * (1 - life)));
          grd.addColorStop(0.5, rgbStr(0.5, 0.7, 1, alpha * 0.2 * (1 - life)));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx, sy, er * 1.3, 0, Math.PI * 2); ctx.fill();
          // 内层白色冰核
          if (life < 0.4) {
            const coreA = (0.4 - life) / 0.4;
            ctx.fillStyle = rgbStr(0.9, 0.97, 1, coreA * 0.6);
            ctx.beginPath(); ctx.arc(sx, sy, er * 0.4, 0, Math.PI * 2); ctx.fill();
          }
          // 冰刺扩散（6 根向外延伸的冰刺）
          ctx.strokeStyle = rgbStr(0.7, 0.9, 1, alpha * 0.8);
          ctx.lineWidth = 2.5 * (1 - life * 0.5);
          for (let spike = 0; spike < 6; spike++) {
            const spikeAng = (spike / 6) * Math.PI * 2 + life * 2;
            const spikeLen = er * (0.9 + Math.sin(life * 12 + spike) * 0.2);
            const spikeWid = Math.PI * 0.08; // 冰刺宽度
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + Math.cos(spikeAng - spikeWid) * spikeLen * 0.3, sy + Math.sin(spikeAng - spikeWid) * spikeLen * 0.3);
            ctx.lineTo(sx + Math.cos(spikeAng) * spikeLen, sy + Math.sin(spikeAng) * spikeLen);
            ctx.lineTo(sx + Math.cos(spikeAng + spikeWid) * spikeLen * 0.3, sy + Math.sin(spikeAng + spikeWid) * spikeLen * 0.3);
            ctx.closePath(); ctx.stroke();
            // 冰刺填充（半透明）
            ctx.fillStyle = rgbStr(0.8, 0.95, 1, alpha * 0.3 * (1 - life));
            ctx.fill();
          }
          // 冰晶碎片（8 颗旋转扩散的菱形冰晶）
          for (let c = 0; c < 8; c++) {
            const cAng = (c / 8) * Math.PI * 2 + life * 3;
            const cDist = maxR * (0.4 + life * 1.2);
            const cx2 = sx + Math.cos(cAng) * cDist;
            const cy2 = sy + Math.sin(cAng) * cDist;
            const cSize = Math.max(2, 4 * (1 - life));
            ctx.fillStyle = rgbStr(0.85, 0.95, 1, alpha * 0.7 * (1 - life));
            ctx.save(); ctx.translate(cx2, cy2); ctx.rotate(cAng + life * 4);
            ctx.beginPath(); ctx.moveTo(0, -cSize); ctx.lineTo(cSize * 0.5, 0); ctx.lineTo(0, cSize); ctx.lineTo(-cSize * 0.5, 0); ctx.closePath();
            ctx.fill(); ctx.restore();
          }
        } else if (pat === 'heal') {
          // 治疗之光命中：温暖的治疗光效 + 上升的光粒子
          const er = maxR * (0.3 + life * 1.0);
          // 外层金色光晕（温暖的治疗光）
          const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, er * 1.4);
          grd.addColorStop(0, rgbStr(1, 0.95, 0.7, alpha * 0.5 * (1 - life)));
          grd.addColorStop(0.4, rgbStr(0.6, 0.9, 0.5, alpha * 0.25 * (1 - life)));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx, sy, er * 1.4, 0, Math.PI * 2); ctx.fill();
          // 内层白色核心（明亮的治愈之光）
          if (life < 0.5) {
            const coreA = (0.5 - life) / 0.5;
            ctx.fillStyle = rgbStr(1, 1, 0.9, coreA * 0.7);
            ctx.beginPath(); ctx.arc(sx, sy, er * 0.45, 0, Math.PI * 2); ctx.fill();
          }
          // 柔和扩散光圈（淡绿色）
          ctx.strokeStyle = rgbStr(0.6, 0.95, 0.6, alpha * 0.6 * (1 - life));
          ctx.lineWidth = 2.5 * (1 - life * 0.5);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          // 上升的光粒子（6 颗向上飘散的光点）
          for (let p = 0; p < 6; p++) {
            const pAng = (p / 6) * Math.PI * 2 + life * 1.5;
            const pDist = maxR * (0.3 + life * 0.8);
            const ppx = sx + Math.cos(pAng) * pDist * 0.6;
            const ppy = sy + Math.sin(pAng) * pDist * 0.3 - life * 30; // 向上飘
            const pSize = Math.max(2, 4 * (1 - life));
            // 金色/绿色交替的光粒子
            const isGold = p % 2 === 0;
            ctx.fillStyle = isGold ? rgbStr(1, 0.9, 0.5, alpha * 0.8 * (1 - life)) : rgbStr(0.6, 0.95, 0.6, alpha * 0.8 * (1 - life));
            ctx.beginPath(); ctx.arc(ppx, ppy, pSize, 0, Math.PI * 2); ctx.fill();
            // 光粒子光晕
            ctx.fillStyle = isGold ? rgbStr(1, 0.95, 0.7, alpha * 0.3 * (1 - life)) : rgbStr(0.7, 1, 0.7, alpha * 0.3 * (1 - life));
            ctx.beginPath(); ctx.arc(ppx, ppy, pSize * 1.8, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          const er = maxR * (0.2 + life * 1.0);
          ctx.strokeStyle = rgbStr(r, g, b, alpha * 0.9);
          ctx.lineWidth = 2.5 * (1 - life * 0.5);
          ctx.beginPath(); ctx.arc(sx, sy, er, 0, Math.PI * 2); ctx.stroke();
          if (life < 0.3) {
            ctx.fillStyle = rgbStr(1, 1, 1, (0.3 - life) * 2);
            ctx.beginPath(); ctx.arc(sx, sy, maxR * 0.3 * (1 - life / 0.3), 0, Math.PI * 2); ctx.fill();
          }
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
    const COLORS = { monster: '#e5484d', npc: '#3b82f6', elite: '#a855f7', boss: '#a855f7' };

    for (const sp of this._spawnMarkers) {
      const sx = (sp.x - this.cam.cx) * scale + cw / 2;
      const sy = (sp.z - this.cam.cz) * scale + ch / 2;
      const color = COLORS[sp.kind] || COLORS.monster;
      const r = ((sp.kind === 'boss' || sp.kind === 'elite') ? 1.8 : 1.2) * scale;

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
