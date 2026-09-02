// renderer.js - 大型 MMO 2.5D 渲染器（Canvas 2D，无需 WebGL）
// 固定斜上方 45° 等距视角（2:1 斜等测投影）：世界地图按「高度场 + 河流/湖泊 + 悬崖」区块
// 预渲染为等距切片（离屏画布 + 可见范围流式加载），实体/掉落/技能效果做 2.5D 投影与深度排序。
// 已移除原 SDF 体积地形（光线步进）与 Three.js 依赖。
import {
  terrainHeight, terrainColor, WATER_LEVEL,
  TERRAIN_CHUNK, TERRAIN_RES,
} from './terrain.js';
// ---- 等距投影参数（斜上方 45°，2:1 斜等测） ----
const ISO = 8;            // 像素/米（水平轴）
const HS = 5;             // 像素/米（垂直高度夸张，让丘陵/悬崖可见）
const VIEW_RANGE_M = 100; // 可见范围（与服务端 viewRange 一致，超出卸载）
const CELL = TERRAIN_RES; // 地形采样粒度（米）
const CHUNK_N = TERRAIN_CHUNK / CELL; // 每区块格数（25）
const ENTITY_PX = 16;     // 实体像素比例（px/米，Sprite 略大于地形格，经典 MMO 表现）
const DEATH_ANIM_MS = 1100; // 死亡动画时长（与服务端实体管理器一致）
// 全局等距坐标：gx=(x-z)*ISO, gy=(x+z)*ISO/2 - h*HS
function gx(wx, wz) { return (wx - wz) * ISO; }
function gy(wx, wy, wz) { return (wx + wz) * ISO * 0.5 - wy * HS; }
export function createRenderer(container) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  container.appendChild(canvas);
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);
  // 运行时状态（每帧由 boot 同步）
  const state = { selfX: 0, selfY: 5, selfZ: 0, self: null, entities: [] };
  // 技能简易效果（前摇进度圈 / AOE 范围圈 / 打断闪红）：
  //   {kind:'cast'|'aoe'|'cancel', wid, x, z, radius, color, startMs, durMs}
  const effects = [];
  /** 添加技能效果（boot.js 由 EVT_SKILL_CASTING/EVT_SKILL/EVT_SKILL_CANCEL 与本地施放触发） */
  function addSkillEffect(eff) {
    if (eff.kind === 'cast') {
      for (let i = effects.length - 1; i >= 0; i--) {
        if (effects[i].kind === 'cast' && effects[i].wid === eff.wid) effects.splice(i, 1);
      }
    }
    effects.push(Object.assign({ startMs: performance.now(), durMs: 800, color: '#ffd166', radius: 0 }, eff));
    if (effects.length > 64) effects.splice(0, effects.length - 64);
  }
  /** 移除某施法者的前摇圈（打断时由 boot.js 调用） */
  function clearCasting(wid) {
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i].kind === 'cast' && effects[i].wid === wid) effects.splice(i, 1);
    }
  }
  /** 本地 AOE 落点预览（按技能键即显示，不等服务器往返） */
  function showAoePreview(x, z, radius, color) {
    effects.push({
      kind: 'aoe', wid: -1, x, z, radius,
      color: color || '#ff6b35', startMs: performance.now(), durMs: 1200,
    });
  }
  // 世界 Boss 共享状态（来自 S2C_BOSS，血量/阶段/状态；位置走 AOI 实体插值）
  const bossHp = new Map(); // wid -> {hp,maxHp,state,phase,name}
  // ---- 相机（斜 45° 等距，玩家居中） ----
  function camGx() { return gx(state.selfX, state.selfZ); }
  function camGy() { return gy(state.selfX, state.selfY, state.selfZ); }
  // 世界坐标 -> 屏幕坐标
  function sx(wx, wz) { return gx(wx, wz) - camGx() + window.innerWidth / 2; }
  function sy(wx, wy, wz) { return gy(wx, wy, wz) - camGy() + window.innerHeight / 2; }
  // ---- 区块离屏画布（等距高度场预渲染 + 流式加载） ----
  const chunkCanvases = new Map(); // "cx,cz" -> {canvas, offGx, offGy, cx, cz}
  const PAD = 10;
  function buildChunkCanvas(cx, cz) {
    const x0 = cx * TERRAIN_CHUNK;
    const z0 = cz * TERRAIN_CHUNK;
    // 角点高度网格（复用，避免重复采样）
    const H = [];
    for (let i = 0; i <= CHUNK_N; i++) {
      H[i] = [];
      for (let j = 0; j <= CHUNK_N; j++) {
        const wx = x0 + i * CELL;
        const wz = z0 + j * CELL;
        H[i][j] = terrainHeight(wx, wz);
      }
    }
    // 等距范围（含高度）→ 画布尺寸与偏移
    let minGx = Infinity, maxGx = -Infinity, minGy = Infinity, maxGy = -Infinity;
    for (let i = 0; i <= CHUNK_N; i++) {
      for (let j = 0; j <= CHUNK_N; j++) {
        const wx = x0 + i * CELL, wz = z0 + j * CELL;
        const ggx = gx(wx, wz);
        const ggy = gy(wx, H[i][j], wz);
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
    off.width = cw;
    off.height = ch;
    const o = off.getContext('2d');
    // 画家排序：按 (i+j) 远→近
    const cells = [];
    for (let j = 0; j < CHUNK_N; j++) {
      for (let i = 0; i < CHUNK_N; i++) cells.push([i, j]);
    }
    cells.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    for (const [i, j] of cells) {
      const wx = x0 + i * CELL, wz = z0 + j * CELL;
      const h0 = H[i][j], h1 = H[i + 1][j], h2 = H[i + 1][j + 1], h3 = H[i][j + 1];
      const hc = (h0 + h1 + h2 + h3) * 0.25;
      const col = terrainColor(wx, wz);
      // 顶面四点（带各自高度）
      const A = [gx(wx, wz) - offGx, gy(wx, h0, wz) - offGy];
      const B = [gx(wx + CELL, wz) - offGx, gy(wx + CELL, h1, wz) - offGy];
      const C = [gx(wx + CELL, wz + CELL) - offGx, gy(wx + CELL, h2, wz + CELL) - offGy];
      const D = [gx(wx, wz + CELL) - offGx, gy(wx, h3, wz + CELL) - offGy];
      // 坡度明暗（用格内高度差估算，节省采样）
      const slope = Math.max(Math.abs(h1 - h0), Math.abs(h3 - h0)) / CELL;
      const bright = Math.max(0.55, Math.min(1.15, 1.0 - slope * 0.10));
      const isWater = hc < WATER_LEVEL;
      if (isWater) {
        // 湖泊/河床：床体（暗色）→ 侧壁 → 半透明水面（位于 kWaterLevel）
        const bedCol = shadeCol(col, 0.55);
        fillQuad(o, A, B, C, D, bedCol);
        drawBankFaces(o, H, x0, z0, i, j, { A, B, C, D, h0, h1, h2, h3 }, true, offGx, offGy);
        // 水面：平铺在水位高度
        const wTop = WATER_LEVEL;
        const A2 = [gx(wx, wz) - offGx, gy(wx, wTop, wz) - offGy];
        const B2 = [gx(wx + CELL, wz) - offGx, gy(wx + CELL, wTop, wz) - offGy];
        const C2 = [gx(wx + CELL, wz + CELL) - offGx, gy(wx + CELL, wTop, wz + CELL) - offGy];
        const D2 = [gx(wx, wz + CELL) - offGx, gy(wx, wTop, wz + CELL) - offGy];
        fillQuad(o, A2, B2, C2, D2, 'rgba(56,140,210,0.60)');
        // 水面高光描边
        o.strokeStyle = 'rgba(180,220,255,0.35)';
        o.lineWidth = 1;
        quadPath(o, A2, B2, C2, D2);
        o.stroke();
      } else {
        // 干地：顶面（按坡度明暗）+ 悬崖侧壁（朝向相机的 +x / +z 缘）
        const r = Math.round(col.r * 255 * bright), g = Math.round(col.g * 255 * bright), b = Math.round(col.b * 255 * bright);
        fillQuad(o, A, B, C, D, `rgb(${r},${g},${b})`);
        drawBankFaces(o, H, x0, z0, i, j, { A, B, C, D, h0, h1, h2, h3 }, false, offGx, offGy);
      }
    }
    return { canvas: off, offGx, offGy, cx, cz };
  }
  // 顶面四点填充
  function fillQuad(o, A, B, C, D, style) {
    o.fillStyle = style;
    o.beginPath();
    o.moveTo(A[0], A[1]);
    o.lineTo(B[0], B[1]);
    o.lineTo(C[0], C[1]);
    o.lineTo(D[0], D[1]);
    o.closePath();
    o.fill();
  }
  function quadPath(o, A, B, C, D) {
    o.beginPath();
    o.moveTo(A[0], A[1]);
    o.lineTo(B[0], B[1]);
    o.lineTo(C[0], C[1]);
    o.lineTo(D[0], D[1]);
    o.closePath();
  }
  // 颜色按系数变暗
  function shadeCol(col, k) {
    return `rgb(${Math.round(col.r * 255 * k)},${Math.round(col.g * 255 * k)},${Math.round(col.b * 255 * k)})`;
  }
  // 绘制朝相机方向的悬崖侧壁（+x 缘与 +z 缘，当相邻格显著更低时暴露岩壁）
  function drawBankFaces(o, H, x0, z0, i, j, pts, water, offGx, offGy) {
    const W = pts;
    const cliff = 0.6; // 侧壁可见的最小高差（米）
    const P = (wx, wy, wz) => [gx(wx, wz) - offGx, gy(wx, wy, wz) - offGy];
    // +x 缘（B→C）：邻格为 (i+1, j)
    if (i + 1 < CHUNK_N) {
      const nbTop = Math.max(H[i + 1][j], H[i + 1][j + 1]);
      const thisTop = Math.max(W.h1, W.h2);
      if (thisTop - nbTop > cliff) {
        const base = water ? WATER_LEVEL : nbTop;
        const Bbt = P(x0 + (i + 1) * CELL, base, z0 + j * CELL);
        const Cbt = P(x0 + (i + 1) * CELL, base, z0 + (j + 1) * CELL);
        fillQuad(o, W.B, W.C, Cbt, Bbt, water ? 'rgba(30,60,90,0.85)' : 'rgba(0,0,0,0.22)');
      }
    }
    // +z 缘（D→C）：邻格为 (i, j+1)
    if (j + 1 < CHUNK_N) {
      const nbTop = Math.max(H[i][j + 1], H[i + 1][j + 1]);
      const thisTop = Math.max(W.h3, W.h2);
      if (thisTop - nbTop > cliff) {
        const base = water ? WATER_LEVEL : nbTop;
        const Dbt = P(x0 + i * CELL, base, z0 + (j + 1) * CELL);
        const Cbt = P(x0 + (i + 1) * CELL, base, z0 + (j + 1) * CELL);
        fillQuad(o, W.D, W.C, Cbt, Dbt, water ? 'rgba(25,55,85,0.9)' : 'rgba(0,0,0,0.16)');
      }
    }
  }
  function updateTerrain(selfX, selfZ) {
    state.selfX = selfX;
    state.selfZ = selfZ;
    const ccx = Math.floor(selfX / TERRAIN_CHUNK);
    const ccz = Math.floor(selfZ / TERRAIN_CHUNK);
    const radius = Math.ceil(VIEW_RANGE_M / TERRAIN_CHUNK) + 1;
    const need = new Set();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const kx = ccx + dx, kz = ccz + dz;
        const wxc = (kx + 0.5) * TERRAIN_CHUNK;
        const wzc = (kz + 0.5) * TERRAIN_CHUNK;
        if (Math.hypot(wxc - selfX, wzc - selfZ) <= VIEW_RANGE_M + TERRAIN_CHUNK * 0.8) {
          need.add(kx + ',' + kz);
        }
      }
    }
    for (const key of [...chunkCanvases.keys()]) {
      if (!need.has(key)) chunkCanvases.delete(key);
    }
    for (const key of need) {
      if (chunkCanvases.has(key)) continue;
      const [kx, kz] = key.split(',').map(Number);
      chunkCanvases.set(key, buildChunkCanvas(kx, kz));
    }
  }
  // 等距圆（世界坐标圆 → 屏幕椭圆）：iso 中水平圆投影为椭圆（竖半径=横半径/2）
  function ellipsePath(wx, wy, wz, r) {
    const x = sx(wx, wz), y = sy(wx, wy, wz);
    ctx.beginPath();
    ctx.ellipse(x, y, r * ENTITY_PX, r * ENTITY_PX * 0.5, 0, 0, Math.PI * 2);
    return [x, y];
  }
  function draw() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    // 背景（远景天空）
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#8fb8dd');
    grad.addColorStop(1, '#cfdce6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // 1) 地形区块（等距切片，远→近 blit）
    const chunkList = [...chunkCanvases.values()].sort((a, b) => (a.cx + a.cz) - (b.cx + b.cz));
    for (const c of chunkList) {
      const px = c.offGx - camGx() + w / 2;
      const py = c.offGy - camGy() + h / 2;
      ctx.drawImage(c.canvas, px, py);
    }
    // 1.5) AOE 范围圈（地面层，实体之下）
    drawAoeEffects(performance.now());
    // 2) 实体（2.5D 投影 + 深度排序，远→近）
    const ents = [...state.entities];
    ents.sort((a, b) => (a.x + a.z) - (b.x + b.z));
    for (const e of ents) drawEntity(e);
    // 2.5) 前摇进度圈 + 打断闪红（实体之上）
    drawCastEffects(performance.now());
    // 3) 自身（橙色圆球 + 半透明白色描边，始终居中可见）
    if (state.self) {
      const x = w / 2, y = h / 2;
      // 影子
      const gy0 = terrainHeight(state.self.x, state.self.z);
      const sh = ellipsePath(state.self.x, gy0, state.self.z, state.self.radius || 0.55);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill();
      // 本体（高度投影）
      const bx = sx(state.self.x, state.self.z), by = sy(state.self.x, state.self.y, state.self.z);
      const r = (state.self.radius || 0.55) * ENTITY_PX;
      drawBall(bx, by, r, '#ff8c1a', 'rgba(255,255,255,0.5)', 2);
      // 名字
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(state.self.name || '你', x, by - r - 6);
      // 死亡动画（自己死亡时由 boot 叠遮罩，这里仅当 selfDead 时置灰半透明）
      if (state.self.dead) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(x, by, r, 0, Math.PI * 2);
        ctx.fillStyle = '#666';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  // ---- 技能效果绘制（等距椭圆） ----
  function drawAoeEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind !== 'aoe') continue;
      const life = (now - ef.startMs) / ef.durMs;
      if (life >= 1) { effects.splice(i, 1); continue; }
      const gy0 = terrainHeight(ef.x, ef.z);
      const [x, y] = ellipsePath(ef.x, gy0, ef.z, ef.radius);
      const R = Math.max(4, ef.radius * ENTITY_PX);
      const alpha = Math.max(0, 1 - life) * 0.9;
      ctx.beginPath();
      ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(ef.color, 0.16 * alpha);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(ef.color, 0.85 * alpha);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ef.radius >= 2) {
        ctx.fillStyle = hexToRgba(ef.color, 0.9 * alpha);
        ctx.font = '10px "PingFang SC",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${ef.radius}m`, x, y + 4);
      }
    }
  }
  // 前摇进度圈（等距椭圆，围绕施法者）
  function drawCastEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind === 'cast') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const [x, y] = ellipsePath(ef.x, terrainHeight(ef.x, ef.z) + 1.2, ef.z, 1.6);
        const R = Math.max(16, 1.6 * ENTITY_PX);
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, life));
        ctx.strokeStyle = ef.color || '#ffd166';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(ef.color || '#ffd166', 0.9);
        ctx.fill();
      } else if (ef.kind === 'cancel') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const [x, y] = ellipsePath(ef.x, terrainHeight(ef.x, ef.z) + 1.2, ef.z, 1.6);
        const R = Math.max(16, 1.6 * ENTITY_PX);
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248,113,113,${0.9 * (1 - life)})`;
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    }
  }
  function hexToRgba(hex, a) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // 物品名映射（由 boot.js 填充）
  const ITEM_NAMES = (typeof window !== 'undefined' && window.__itemNames) || {};
  // 立体圆球（径向渐变，伪 3D）
  function drawBall(x, y, r, color, outline, lw) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, lightenHex(color, 0.35));
    g.addColorStop(0.6, color);
    g.addColorStop(1, lightenHex(color, -0.45));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = lw || 1.4;
      ctx.stroke();
    }
  }
  function lightenHex(hex, k) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    let n = parseInt(h, 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + Math.round(255 * k)));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + Math.round(255 * k)));
    const b = Math.max(0, Math.min(255, (n & 255) + Math.round(255 * k)));
    return `rgb(${r},${g},${b})`;
  }
  function drawEntity(e) {
    const boss = bossHp.get(e.wid);
    let color, r;
    if (boss) { color = '#7f1d1d'; r = 1.4; }                       // 世界 Boss：暗红大球
    else if (e.kind === 'player') { color = '#34d399'; r = 0.55; }  // 绿色
    else if (e.kind === 'npc') { color = '#60a5fa'; r = 0.5; }      // 蓝色
    else if (e.kind === 'item') { color = e.itemId ? '#fbbf24' : '#fde047'; r = 0.4; }
    else { color = '#f87171'; r = 0.5; }                            // 红色（怪物）
    // 商店 NPC：紫色描边
    if (e.kind === 'npc' && e.name && e.name.indexOf('商店') !== -1) {
      const rp = r * ENTITY_PX;
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(sx(e.x, e.z), sy(e.x, e.y + 1.2, e.z), rp + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 死亡动画进度（淡出 + 下沉）
    let alpha = 1;
    let bodyY = e.y;
    if (e.dying) {
      const t = Math.max(0, Math.min(1, (performance.now() - (e.dyingAt || 0)) / DEATH_ANIM_MS));
      alpha = 1 - t * t;
      bodyY = (e.dieY || e.y) - t * 1.4; // 下沉
      color = '#777';
    }
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    // 影子（地面投影）
    const gy0 = terrainHeight(e.x, e.z);
    const shR = r * ENTITY_PX;
    ctx.beginPath();
    ctx.ellipse(sx(e.x, e.z), sy(e.x, gy0, e.z), shR, shR * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fill();
    // 本体（高度投影，2.5D）
    const x = sx(e.x, e.z);
    const y = sy(e.x, bodyY, e.z);
    const pr = r * ENTITY_PX;
    if (e.kind === 'item') {
      // 掉落物：菱形（俯视投影）+ 名字
      ctx.beginPath();
      ctx.moveTo(x, y - pr);
      ctx.lineTo(x + pr * 0.6, y);
      ctx.lineTo(x, y + pr);
      ctx.lineTo(x - pr * 0.6, y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const label = e.itemId ? (ITEM_NAMES[e.itemId] || '物品') : `${e.gold} 金币`;
      ctx.fillStyle = 'rgba(253,224,71,0.95)';
      ctx.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - pr - 4);
    } else {
      drawBall(x, y, pr, color, e.kind === 'player' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.4)', 1.4);
      if (boss) {
        // Boss：头顶血条（全区共享）
        const dead = boss.state === 2 || e.dying;
        if (dead) {
          ctx.globalAlpha = alpha * 0.35;
          ctx.beginPath();
          ctx.arc(x, y, pr, 0, Math.PI * 2);
          ctx.fillStyle = '#444';
          ctx.fill();
          ctx.globalAlpha = alpha;
        }
        const barW = 40, barH = 5;
        const bx = x - barW / 2, by = y - pr - 12;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = '#e11d48';
        ctx.fillRect(bx, by, barW, barH);
        const pct = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
        ctx.fillStyle = '#4ade80';
        ctx.fillRect(bx, by, barW * pct, barH);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${boss.name || 'Boss'} Lv.${boss.phase} ${Math.round(boss.hp)}/${Math.round(boss.maxHp)}`, x, by - 4);
      } else if (e.name && !e.dying) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(e.name, x, y - pr - 4);
      }
    }
    ctx.restore();
  }
  /** 同步自身（相机跟随/中心绘制） */
  function setSelf(x, y, z, name, dead) {
    state.selfX = x; state.selfY = y; state.selfZ = z;
    state.self = { x, y, z, name, radius: 0.55, dead: !!dead };
  }
  /** 同步可见实体列表（boot 每帧提供插值后数据） */
  function setEntities(list) {
    state.entities = list;
  }
  /** 同步世界 Boss 共享状态（S2C_BOSS；wid→血量/阶段） */
  function setBossState(b) {
    if (!b || !b.wid) return;
    bossHp.set(b.wid, { hp: b.hp, maxHp: b.maxHp, state: b.state, phase: b.phase, name: b.name });
  }
  // 调试/测试钩子
  function fxSnapshot() {
    return effects.map((e) => ({ kind: e.kind, x: +e.x.toFixed(1), z: +e.z.toFixed(1), radius: e.radius, color: e.color, durMs: e.durMs }));
  }
  return {
    canvas, ctx, updateTerrain, setSelf, setEntities, setBossState, draw, resize,
    addSkillEffect, clearCasting, showAoePreview, fxSnapshot,
  };
}
