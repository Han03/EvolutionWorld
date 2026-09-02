/**
 * editor.js - EvolutionWorld 世界/剧本编辑器
 * 俯视 2D 编辑器，两种模式：
 *  - 地形：画刷（抬高/降低/铺平/平滑/挖空/恢复），浅灰=可通行 / 白色=空洞，可选高度色带
 *  - 生物出生点（剧本）：新增/拖动/删除怪物、NPC、Boss 出生点，保存后服务端热重载
 * 性能：256×256 格颜色缓存（每格一次地形查询），redraw 仅按可见格逐块填充（O(可见格)），
 *       彻底消除逐像素地形查询卡顿与 DPR 稀疏点阵导致的"多图"伪影。
 * 交互：WASD/方向键平移 · 滚轮缩放 · 左键画刷/拖拽 · 右键平移。
 * 数据：地形与服务端 terrain.cpp / 游戏 terrain.js 同源；出生点走 /api/spawns(/edit)。
 */
import {
  terrainHeight, terrainBlocked, setEditCell, clearEdit, loadEditCells,
  getEditCells, editCellCount, WATER_LEVEL,
} from './terrain.js';

const $ = (id) => document.getElementById(id);
const BASE = '';
const WORLD = 128;   // 世界 [-128,128) 米
const N = 256, OFF = 128;

let token = '', username = '';
let mode = 'terrain';     // 'terrain' | 'spawn'
let showHeight = false;

// ---- 视图（世界坐标中心 + 缩放） ----
const view = { cx: 0, cz: 0, scale: 3 };
let panning = false, lastPan = { x: 0, y: 0 };
const keys = {};

// ---- 画刷 ----
const brush = { type: 'raise', radius: 4, strength: 1.2, falloff: 'soft', targetH: 8 };
let hoverWorld = { x: 0, z: 0, in: false };
let editing = false;

// ---- 生物出生点（剧本） ----
let spawns = [];          // {kind,type,name,shopId,x,z,count}
let spawnDraft = { kind: 'monster', type: 'wolf', count: 1 };
let selectedSpawn = -1;   // 选中下标（-1=无）
let dragSpawn = null;     // {index, offX, offZ} 正在拖动的出生点
let spawnsDirty = false;

// ---- 撤销/重做（仅地形） ----
let undoStack = [], redoStack = [];
function snapshot() { return JSON.stringify(getEditCells()); }
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  refreshButtons();
}
function restore(snap) { loadEditCells(snap ? JSON.parse(snap).cells : null); }
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  refreshButtons(); computeAllCells(); redraw();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  refreshButtons(); computeAllCells(); redraw();
}
function refreshButtons() {
  $('btn-undo').disabled = undoStack.length === 0;
  $('btn-redo').disabled = redoStack.length === 0;
}

// ---- 画布与颜色缓存 ----
const canvas = $('editor-canvas');
const ctx = canvas.getContext('2d');
let img = null, imgData = null;
const CELL = new Uint32Array(N * N); // ABGR 格颜色缓存（一次地形查询/格）
function cellIdx(gx, gz) { return (gz + OFF) * N + (gx + OFF); }
function pack(r, g, b) { return (255 << 24) | (b << 16) | (g << 8) | r; }

// 高度 -> 地形色带（-2..34m：深蓝→青→绿→黄→棕→白）
const HSTOPS = [
  [45, 70, 160], [80, 150, 195], [110, 185, 120],
  [225, 215, 130], [175, 135, 85], [245, 245, 245],
];
function heightColor(h) {
  const u = Math.max(0, Math.min(1, (h + 2) / 36));
  const seg = u * (HSTOPS.length - 1);
  const i = Math.min(HSTOPS.length - 2, Math.floor(seg));
  const t = seg - i;
  const a = HSTOPS[i], b = HSTOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
// 基础浅灰（按坡度明暗，同游戏渲染口径）
function baseGray(gx, gz, h) {
  const n = terrainHeight(gx + 0.5, gz - 0.5);
  const s = terrainHeight(gx - 0.5, gz + 0.5);
  const e = terrainHeight(gx + 1.5, gz + 0.5);
  const w = terrainHeight(gx + 0.5, gz + 1.5);
  let slope = 0;
  if (h < 1e9) slope = Math.abs(h - n) + Math.abs(h - s) + Math.abs(h - e) + Math.abs(h - w);
  const shade = Math.max(0, Math.min(1, 0.12 * slope / 2));
  return Math.round(196 * (1 - shade) + 160 * shade);
}
function computeCell(gx, gz) {
  const cx = gx + 0.5, cz = gz + 0.5;
  if (terrainBlocked(cx, cz)) { CELL[cellIdx(gx, gz)] = 0xFFFFFFFF; return; } // 空洞/深水/悬崖=白
  const h = terrainHeight(cx, cz);
  if (showHeight) {
    const [r, g, b] = heightColor(h);
    CELL[cellIdx(gx, gz)] = pack(r, g, b);
  } else {
    const g = baseGray(gx, gz, h);
    CELL[cellIdx(gx, gz)] = pack(g, g, g);
  }
}
function computeAllCells() {
  for (let gz = -WORLD; gz < WORLD; gz++)
    for (let gx = -WORLD; gx < WORLD; gx++) computeCell(gx, gz);
}
function updateCells(x0, z0, x1, z1) {
  const gx0 = Math.max(-WORLD, Math.floor(x0)), gx1 = Math.min(WORLD - 1, Math.floor(x1));
  const gz0 = Math.max(-WORLD, Math.floor(z0)), gz1 = Math.min(WORLD - 1, Math.floor(z1));
  for (let gz = gz0; gz <= gz1; gz++)
    for (let gx = gx0; gx <= gx1; gx++) computeCell(gx, gz);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    img = ctx.createImageData(w, h);
    imgData = img.data;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 世界 -> 屏幕（CSS 坐标）
function w2s(wx, wz) {
  const cw = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
  const ch = canvas.height / Math.min(window.devicePixelRatio || 1, 2);
  return { x: (wx - view.cx) * view.scale + cw / 2, y: (wz - view.cz) * view.scale + ch / 2 };
}
function s2w(px, py) {
  const cw = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
  const ch = canvas.height / Math.min(window.devicePixelRatio || 1, 2);
  return { x: (px - cw / 2) / view.scale + view.cx, z: (py - ch / 2) / view.scale + view.cz };
}

// ---- 主渲染：按可见格逐块填充（颜色缓存，性能核心） ----
function redraw() {
  if (!img) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.width, h = canvas.height;
  const cw = w / dpr, ch = h / dpr;
  const halfW = cw / 2, halfH = ch / 2;
  // 背景白（空洞区打底）
  imgData.fill(0xFFFFFFFF);
  const gx0 = Math.max(-WORLD, Math.floor((0 - halfW) / view.scale + view.cx));
  const gx1 = Math.min(WORLD - 1, Math.floor((cw - halfW) / view.scale + view.cx));
  const gz0 = Math.max(-WORLD, Math.floor((0 - halfH) / view.scale + view.cz));
  const gz1 = Math.min(WORLD - 1, Math.floor((ch - halfH) / view.scale + view.cz));
  for (let gz = gz0; gz <= gz1; gz++) {
    const sy = Math.round((gz - view.cz) * view.scale + halfH);
    const py0 = Math.max(0, Math.round(sy * dpr));
    const py1 = Math.min(h, Math.round((sy + 1) * dpr));
    if (py1 <= py0) continue;
    for (let gx = gx0; gx <= gx1; gx++) {
      const sx = Math.round((gx - view.cx) * view.scale + halfW);
      const px0 = Math.max(0, Math.round(sx * dpr));
      const px1 = Math.min(w, Math.round((sx + 1) * dpr));
      if (px1 <= px0) continue;
      const col = CELL[cellIdx(gx, gz)];
      const r = col & 0xff, gg = (col >> 8) & 0xff, b = (col >> 16) & 0xff;
      for (let py = py0; py < py1; py++) {
        let base = (py * w + px0) * 4;
        for (let px = px0; px < px1; px++) {
          imgData[base] = r; imgData[base + 1] = gg; imgData[base + 2] = b; imgData[base + 3] = 255;
          base += 4;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  drawOverlays();
}

function drawOverlays() {
  const cw = canvas.width / Math.min(window.devicePixelRatio || 1, 2);
  const ch = canvas.height / Math.min(window.devicePixelRatio || 1, 2);
  const halfW = cw / 2, halfH = ch / 2;
  // 网格线（10m 大格，放大后显示）
  ctx.strokeStyle = 'rgba(0,0,0,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 10 / view.scale;
  if (step >= 6) {
    const sx0 = Math.floor((0 - halfW) / view.scale / 10) * 10, sx1 = Math.ceil((cw - halfW) / view.scale / 10) * 10;
    for (let gx = sx0; gx <= sx1; gx += 10) { const sx = (gx - view.cx) * view.scale + halfW; ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); }
    const sz0 = Math.floor((0 - halfH) / view.scale / 10) * 10, sz1 = Math.ceil((ch - halfH) / view.scale / 10) * 10;
    for (let gz = sz0; gz <= sz1; gz += 10) { const sy = (gz - view.cz) * view.scale + halfH; ctx.moveTo(0, sy); ctx.lineTo(cw, sy); }
  }
  ctx.stroke();
  // 坐标轴
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  const ox = (0 - view.cx) * view.scale + halfW, oy = (0 - view.cz) * view.scale + halfH;
  if (ox >= 0 && ox <= cw) { ctx.moveTo(ox, 0); ctx.lineTo(ox, ch); }
  if (oy >= 0 && oy <= ch) { ctx.moveTo(0, oy); ctx.lineTo(cw, oy); }
  ctx.stroke();
  // 主城标记
  const tw = w2s(0, 0);
  ctx.fillStyle = '#2f6fed';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('主城', tw.x, tw.y - 7);
  ctx.strokeStyle = '#2f6fed';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tw.x, tw.y, 4.5, 0, Math.PI * 2); ctx.stroke();

  // 出生点标记（生物模式 / 地形模式也半透明显示）
  drawSpawnMarkers(cw, ch, halfW, halfH);

  // 画刷预览（地形模式）
  if (mode === 'terrain' && hoverWorld.in) {
    const s = w2s(hoverWorld.x, hoverWorld.z);
    const R = brush.radius * view.scale;
    ctx.strokeStyle = 'rgba(255,45,45,0.9)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2, R), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,45,45,0.15)';
    ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2, R), 0, Math.PI * 2); ctx.fill();
  }
}
const SPAWN_STYLE = {
  monster: { color: '#e5484d', label: 'M' },
  npc: { color: '#3b82f6', label: 'N' },
  boss: { color: '#a855f7', label: 'B' },
};
function drawSpawnMarkers(cw, ch, halfW, halfH) {
  if (!spawns.length) return;
  const minX = (0 - halfW) / view.scale + view.cx, maxX = (cw - halfW) / view.scale + view.cx;
  const minZ = (0 - halfH) / view.scale + view.cz, maxZ = (ch - halfH) / view.scale + view.cz;
  ctx.textAlign = 'center';
  ctx.font = 'bold 10px sans-serif';
  for (let i = 0; i < spawns.length; i++) {
    const sp = spawns[i];
    if (sp.x < minX || sp.x > maxX || sp.z < minZ || sp.z > maxZ) continue;
    const st = SPAWN_STYLE[sp.kind] || SPAWN_STYLE.monster;
    const s = w2s(sp.x, sp.z);
    const r = sp.kind === 'boss' ? 9 : 7;
    // 半透明描边（同游戏"悬浮圆球"风格）
    ctx.fillStyle = st.color;
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = st.color;
    ctx.beginPath(); ctx.arc(s.x, s.y, r - 1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(sp.kind === 'npc' ? (sp.name ? '商' : st.label) : (sp.type ? sp.type[0].toUpperCase() : st.label), s.x, s.y + 3);
    // 选中高亮
    if (i === selectedSpawn) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 数量徽标
    if (sp.kind === 'monster' && sp.count > 1) {
      ctx.fillStyle = '#fff';
      ctx.font = '9px sans-serif';
      ctx.fillText('×' + sp.count, s.x + r + 4, s.y - r + 2);
      ctx.font = 'bold 10px sans-serif';
    }
  }
}

// ---- 画刷应用 ----
function applyBrushAt(wx, wz, push = false) {
  if (push) pushHistory();
  const r = brush.radius;
  const x0 = Math.floor(wx - r), x1 = Math.floor(wx + r);
  const z0 = Math.floor(wz - r), z1 = Math.floor(wz + r);
  const falloffHard = brush.falloff === 'hard';
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const d = Math.hypot(gx + 0.5 - wx, gz + 0.5 - wz);
      if (d > r) continue;
      let fo = 1;
      if (!falloffHard && r > 0.01) fo = Math.max(0, Math.min(1, 1 - d / r));
      fo *= fo * (3 - 2 * fo); // smoothstep
      const cx = gx + 0.5, cz = gz + 0.5;
      switch (brush.type) {
        case 'raise': setEditCell(cx, cz, { h: terrainHeight(cx, cz) + brush.strength * fo }); break;
        case 'lower': setEditCell(cx, cz, { h: terrainHeight(cx, cz) - brush.strength * fo }); break;
        case 'flatten': setEditCell(cx, cz, { h: brush.targetH }); break;
        case 'smooth': {
          let sum = 0, n = 0;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            sum += terrainHeight(cx + dx, cz + dz); n++;
          }
          setEditCell(cx, cz, { h: sum / n });
          break;
        }
        case 'void': setEditCell(cx, cz, { v: 1 }); break;
        case 'fill': {
          const cur = terrainHeight(cx, cz);
          setEditCell(cx, cz, { h: Math.max(cur, WATER_LEVEL + 1.5), v: 0 });
          break;
        }
      }
    }
  }
  updateCells(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
}

// ---- 出生点操作 ----
function findSpawnAt(wx, wz, px, py) {
  // 优先像素距离（屏幕半径 14px），其次世界距离
  let best = -1, bestD = 1e9;
  for (let i = 0; i < spawns.length; i++) {
    const s = w2s(spawns[i].x, spawns[i].z);
    const d = Math.hypot(s.x - px, s.y - py);
    if (d < bestD && d < 18) { bestD = d; best = i; }
  }
  return best;
}
function addSpawn(wx, wz) {
  const sp = {
    kind: spawnDraft.kind,
    type: spawnDraft.kind === 'monster' || spawnDraft.kind === 'boss' ? spawnDraft.type : '',
    name: '',
    shopId: spawnDraft.kind === 'npc' ? 1 : 0,
    x: Math.round(wx * 2) / 2,
    z: Math.round(wz * 2) / 2,
    count: spawnDraft.kind === 'monster' ? spawnDraft.count : 1,
  };
  spawns.push(sp);
  selectedSpawn = spawns.length - 1;
  spawnsDirty = true;
  renderSpawnList();
  redraw();
}
function removeSpawn(i) {
  if (i < 0 || i >= spawns.length) return;
  spawns.splice(i, 1);
  selectedSpawn = -1;
  spawnsDirty = true;
  renderSpawnList();
  redraw();
}
function renderSpawnList() {
  $('spawn-count-label').textContent = spawns.length;
  const box = $('spawn-list');
  box.innerHTML = '';
  spawns.forEach((sp, i) => {
    const div = document.createElement('div');
    div.className = 'spawn-item' + (i === selectedSpawn ? ' sel' : '');
    const st = SPAWN_STYLE[sp.kind] || SPAWN_STYLE.monster;
    const kindName = sp.kind === 'npc' ? 'NPC' : (sp.kind === 'boss' ? 'Boss' : '怪物');
    const typeName = sp.kind === 'npc' ? (sp.name || 'NPC') : (sp.type || '-');
    div.innerHTML = `<span class="sp-dot" style="background:${st.color}"></span>
      <span class="sp-txt">${kindName}·${typeName}</span>
      <span class="sp-pos">(${sp.x.toFixed(1)},${sp.z.toFixed(1)})${sp.kind === 'monster' && sp.count > 1 ? '×' + sp.count : ''}</span>
      <button class="sp-del" title="删除">✕</button>`;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('sp-del')) { removeSpawn(i); return; }
      selectedSpawn = i;
      renderSpawnList(); redraw();
    });
    box.appendChild(div);
  });
}
function centerOnSelected() {
  if (selectedSpawn >= 0 && selectedSpawn < spawns.length) {
    view.cx = spawns[selectedSpawn].x;
    view.cz = spawns[selectedSpawn].z;
    redraw();
  }
}

// ---- 输入事件 ----
function onMouseMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const w = s2w(px, py);
  hoverWorld.x = w.x; hoverWorld.z = w.z; hoverWorld.in = true;
  $('editor-coord').textContent =
    `x:${Math.floor(w.x)} z:${Math.floor(w.z)} h:${terrainHeight(w.x, w.z).toFixed(1)} ${terrainBlocked(w.x, w.z) ? '■空洞' : '·可通行'} ${mode === 'spawn' ? '·出生点:' + spawns.length : '·编辑格:' + editCellCount()}`;
  if (panning) {
    view.cx -= (ev.clientX - lastPan.x) / view.scale;
    view.cz -= (ev.clientY - lastPan.y) / view.scale;
    lastPan = { x: ev.clientX, y: ev.clientY };
    redraw();
    return;
  }
  if (mode === 'spawn' && dragSpawn) {
    const sp = spawns[dragSpawn.index];
    sp.x = Math.round((w.x - dragSpawn.offX) * 2) / 2;
    sp.z = Math.round((w.z - dragSpawn.offZ) * 2) / 2;
    spawnsDirty = true;
    renderSpawnList(); redraw();
    return;
  }
  if (mode === 'terrain' && editing) {
    applyBrushAt(w.x, w.z, false);
    redraw();
  }
  redraw();
}
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mousedown', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  if (ev.button === 2) { panning = true; lastPan = { x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button !== 0) return;
  const w = s2w(px, py);
  if (mode === 'spawn') {
    const idx = findSpawnAt(w.x, w.z, px, py);
    if (idx >= 0) {
      selectedSpawn = idx;
      dragSpawn = { index: idx, offX: w.x - spawns[idx].x, offZ: w.z - spawns[idx].z };
      renderSpawnList(); redraw();
    } else {
      addSpawn(w.x, w.z); // 空白处点击 = 新增出生点
    }
    return;
  }
  applyBrushAt(w.x, w.z, true);
  editing = true;
  redraw();
});
window.addEventListener('mouseup', () => { editing = false; panning = false; dragSpawn = null; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('mouseleave', () => { hoverWorld.in = false; redraw(); });
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const { x, z } = s2w(ev.clientX - rect.left, ev.clientY - rect.top);
  const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.scale = Math.max(0.4, Math.min(12, view.scale * k));
  view.cx = x - (x - view.cx) / k;
  view.cz = z - (z - view.cz) / k;
  redraw();
}, { passive: false });

// ---- WSAD / 方向键平移 ----
function panKey() {
  const speed = 320 / view.scale; // CSS px/s → 世界单位/s
  let dx = 0, dz = 0;
  if (keys.w || keys.arrowup) dz -= speed;
  if (keys.s || keys.arrowdown) dz += speed;
  if (keys.a || keys.arrowleft) dx -= speed;
  if (keys.d || keys.arrowright) dx += speed;
  if (dx || dz) {
    view.cx += dx;
    view.cz += dz;
    redraw();
  }
  requestAnimationFrame(panKey);
}
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|SELECT|TEXTAREA)$/i.test(tag)) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    keys[k] = true;
    e.preventDefault();
  }
  if (e.key === 'Delete' && mode === 'spawn' && selectedSpawn >= 0) {
    e.preventDefault();
    removeSpawn(selectedSpawn);
  }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

// ---- 模式切换 ----
function setMode(m) {
  mode = m;
  $('panel-terrain').classList.toggle('hidden', mode !== 'terrain');
  $('panel-spawn').classList.toggle('hidden', mode !== 'spawn');
  $('mode-tip').textContent = mode === 'terrain'
    ? '画刷编辑地形：浅灰=可通行 / 白=空洞'
    : '点击空白=新增出生点 · 拖动标记=移动 · 点选后 Del=删除';
  $('editor-status').textContent = mode === 'terrain'
    ? '就绪（WASD 平移 · 滚轮缩放 · 左键画刷）'
    : `生物出生点（${spawns.length} 个）· WASD 平移 · 左键新增/拖拽`;
  redraw();
}

// ---- 工具栏绑定 ----
function bindTools() {
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener('change', () => setMode(el.value));
  });
  document.querySelectorAll('input[name="brush"]').forEach((el) => {
    el.addEventListener('change', () => { brush.type = el.value; redraw(); });
  });
  const radius = $('brush-radius'), strength = $('brush-strength');
  radius.addEventListener('input', () => { brush.radius = parseFloat(radius.value); $('brush-radius-v').textContent = brush.radius + 'm'; redraw(); });
  strength.addEventListener('input', () => { brush.strength = parseFloat(strength.value); $('brush-strength-v').textContent = brush.strength; });
  $('brush-falloff').addEventListener('change', (e) => { brush.falloff = e.target.value; });
  $('brush-target').addEventListener('input', (e) => { brush.targetH = parseFloat(e.target.value) || 0; });
  $('show-height').addEventListener('change', (e) => {
    showHeight = e.target.checked;
    $('editor-legend').classList.toggle('hidden', !showHeight);
    if (showHeight && $('editor-legend').innerHTML.trim() === '') {
      $('editor-legend').innerHTML = '高度色带（米）<div class="legend-bar"></div><div class="legend-scale"><span>-2</span><span>10</span><span>22</span><span>34</span></div>';
    }
    computeAllCells(); redraw();
  });
  // 出生点
  $('spawn-kind').addEventListener('change', (e) => {
    spawnDraft.kind = e.target.value;
    $('spawn-type-row').style.display = spawnDraft.kind === 'npc' ? 'none' : '';
    $('spawn-count-row').style.display = spawnDraft.kind === 'monster' ? '' : 'none';
  });
  $('spawn-type').addEventListener('change', (e) => { spawnDraft.type = e.target.value; });
  $('spawn-count').addEventListener('change', (e) => { spawnDraft.count = Math.max(1, parseInt(e.target.value) || 1); });
  $('btn-spawn-del').addEventListener('click', () => {
    if (selectedSpawn >= 0) removeSpawn(selectedSpawn);
    else setStatus('请先点击选择要删除的出生点');
  });
  // 撤销/保存
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('清除全部地形编辑，还原为程序化地形？此操作会覆盖服务器上的编辑层。')) return;
    clearEdit();
    await saveTerrain();
    computeAllCells(); redraw();
  });
  $('btn-save').addEventListener('click', async () => {
    if (mode === 'spawn') {
      setStatus('保存出生点…');
      const ok = await saveSpawns();
      setStatus(ok ? `已保存 ${spawns.length} 个出生点，服务器已热重载世界生物` : '保存失败（见上方）');
    } else {
      setStatus('保存地形…');
      const ok = await saveTerrain();
      setStatus(ok ? `已保存 ${editCellCount()} 个编辑格，运行时地形已更新` : '保存失败（见上方）');
    }
  });
}
function setStatus(text) { $('editor-status').textContent = text; }

async function saveTerrain() {
  try {
    const r = await fetch(BASE + '/api/terrain/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, cells: getEditCells() }),
    });
    return (await r.json()).ok === true;
  } catch (e) { return false; }
}
async function saveSpawns() {
  try {
    const r = await fetch(BASE + '/api/spawns/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, spawns }),
    });
    const j = await r.json();
    if (j.ok) spawnsDirty = false;
    return !!j.ok;
  } catch (e) { return false; }
}

// ---- 登录 ----
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function enterEditor(j) {
  token = j.token;
  username = j.user.username;
  $('editor-login').classList.add('hidden');
  $('editor-app').classList.remove('hidden');
  $('editor-user-name').textContent = username;
  resizeCanvas();
  // 加载地形编辑层
  try {
    const r = await fetch(BASE + '/api/terrain/edit');
    const jd = await r.json();
    if (jd && jd.ok) loadEditCells(jd.cells);
  } catch (e) {}
  // 加载出生点
  try {
    const r = await fetch(BASE + '/api/spawns');
    const jd = await r.json();
    if (jd && jd.ok && Array.isArray(jd.spawns)) spawns = jd.spawns;
  } catch (e) {}
  computeAllCells();
  renderSpawnList();
  $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${spawns.length}`;
  setStatus(`已加载服务器数据（地形 ${editCellCount()} 格 / 出生点 ${spawns.length} 个）。WASD 平移，滚轮缩放。`);
  refreshButtons();
  redraw();
  requestAnimationFrame(panKey);
}
function loginMsg(text, ok) {
  const el = $('editor-login-msg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}
async function doLogin() {
  loginMsg('登录中…', false);
  const username = $('editor-user').value.trim();
  const password = $('editor-pass').value;
  if (!username || !password) { loginMsg('请输入账号密码', false); return; }
  try {
    const j = await post('/api/login', { username, password });
    if (j.ok) await enterEditor(j);
    else loginMsg(j.error || '登录失败', false);
  } catch (e) { loginMsg('网络错误', false); }
}
$('editor-login-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
$('editor-login-btn').addEventListener('click', doLogin);
$('editor-register').addEventListener('click', async () => {
  const username = $('editor-user').value.trim();
  const password = $('editor-pass').value;
  if (!username || !password) { loginMsg('请输入账号密码', false); return; }
  const j = await post('/api/register', { username, password }).catch(() => ({ ok: false, error: '网络错误' }));
  loginMsg(j.ok ? '注册成功，请登录' : (j.error || '注册失败'), !!j.ok);
});

// ---- 初始化 ----
window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
resizeCanvas();
bindTools();
refreshButtons();
