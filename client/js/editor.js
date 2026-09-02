/**
 * editor.js - EvolutionWorld 世界/剧本编辑器（2.5D 等距视角）
 * 使用共享 terrain-renderer.js 渲染，与游戏客户端 renderer.js 同源同构。
 *
 * 两种模式：
 *  - 地形：画刷（抬高/降低/铺平/平滑/挖空/恢复），浅灰=可通行 / 白色=空洞，可选高度色带
 *  - 生物出生点（剧本）：新增/拖动/删除怪物、NPC、Boss 出生点，保存后服务端热重载
 *
 * 渲染：TerrainRenderer 2.5D 等距投影（与游戏 index.html 共用模块），chunk 流式加载。
 * 交互：WASD/方向键平移 · 滚轮缩放 · 左键画刷/拖拽 · 右键平移。
 * 数据：地形与服务端 terrain.cpp / 游戏 terrain.js 同源；出生点走 /api/spawns(/edit)。
 */
import {
  terrainHeight, terrainBlocked, setEditCell, clearEdit, loadEditCells,
  getEditCells, editCellCount, WATER_LEVEL,
} from './terrain.js';
import { TerrainRenderer, heightColor } from './terrain-renderer.js';

const $ = (id) => document.getElementById(id);
const BASE = '';
const WORLD = 128;   // 世界 [-128,128) 米
const VIEW_RANGE = 160; // 编辑器视距（足够覆盖整个编辑区域）

let token = '', username = '';
let mode = 'terrain';     // 'terrain' | 'spawn'
let showHeight = false;

// ---- 共享地形渲染器 ----
const canvas = $('editor-canvas');
let tr = null; // TerrainRenderer 实例
let running = false;

// ---- 画刷 ----
const brush = { type: 'raise', radius: 4, strength: 1.2, falloff: 'soft', targetH: 8 };
let hoverWorld = { x: 0, z: 0, in: false };
let editing = false;
let panning = false, lastPan = { x: 0, y: 0 };
const keys = {};

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
  refreshButtons();
  tr.invalidateAllChunks();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  refreshButtons();
  tr.invalidateAllChunks();
}
function refreshButtons() {
  $('btn-undo').disabled = undoStack.length === 0;
  $('btn-redo').disabled = redoStack.length === 0;
}

// ---- 高度色带图例 ----
function updateLegend() {
  const legend = $('editor-legend');
  if (!showHeight) { legend.classList.add('hidden'); return; }
  legend.classList.remove('hidden');
  if (legend.innerHTML.trim() === '') {
    legend.innerHTML = '高度色带（米）<div class="legend-bar"></div><div class="legend-scale"><span>-2</span><span>10</span><span>22</span><span>34</span></div>';
  }
}

// ---- 出生点样式 ----
const SPAWN_STYLE = {
  monster: { color: '#e5484d', label: 'M' },
  npc: { color: '#3b82f6', label: 'N' },
  boss: { color: '#a855f7', label: 'B' },
};

// ============================================================================
// 渲染循环（requestAnimationFrame 持续渲染，保证画刷预览等实时刷新）
// ============================================================================
function frame() {
  if (!running || !tr) return;
  const ctx = tr.ctx;
  const cw = tr.cssWidth, ch = tr.cssHeight;
  if (cw < 2 || ch < 2) { requestAnimationFrame(frame); return; }

  // 更新区块
  tr.updateChunks(tr.cam.cx, tr.cam.cz, VIEW_RANGE);

  // 清屏 + 背景
  tr.clear(ctx);
  tr.drawBackground(ctx);

  // 地形
  tr.drawChunks(ctx);

  // 网格 + 坐标轴
  tr.drawGrid(ctx);

  // 主城标记
  tr.drawOriginMarker(ctx);

  // 出生点标记
  drawSpawnMarkers(ctx);

  // 画刷预览（地形模式）
  if (mode === 'terrain' && hoverWorld.in) {
    tr.drawBrushPreview(ctx, hoverWorld.x, hoverWorld.z, brush.radius);
  }

  requestAnimationFrame(frame);
}

// ---- 出生点绘制 ----
function drawSpawnMarkers(ctx) {
  if (!spawns.length) return;
  ctx.textAlign = 'center';
  ctx.font = 'bold 10px sans-serif';
  for (let i = 0; i < spawns.length; i++) {
    const sp = spawns[i];
    const s = tr.w2s(sp.x, sp.z);
    // 可见性检查
    if (s.x < -30 || s.x > tr.cssWidth + 30 || s.y < -30 || s.y > tr.cssHeight + 30) continue;
    const st = SPAWN_STYLE[sp.kind] || SPAWN_STYLE.monster;
    const r = sp.kind === 'boss' ? 9 : 7;
    // 半透明光晕
    ctx.fillStyle = st.color;
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    // 描边 + 填充
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = st.color;
    ctx.beginPath(); ctx.arc(s.x, s.y, r - 1, 0, Math.PI * 2); ctx.fill();
    // 标签
    ctx.fillStyle = '#fff';
    ctx.fillText(
      sp.kind === 'npc' ? (sp.name ? '商' : st.label) : (sp.type ? sp.type[0].toUpperCase() : st.label),
      s.x, s.y + 3
    );
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

// ============================================================================
// 画刷应用
// ============================================================================
function applyBrushAt(wx, wz, pushHist = false) {
  if (pushHist) pushHistory();
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
  // 失效受影响的区块（下次渲染时自动重建）
  tr.invalidateRegion(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
}

// ============================================================================
// 出生点操作
// ============================================================================
function findSpawnAt(px, py) {
  let best = -1, bestD = 1e9;
  for (let i = 0; i < spawns.length; i++) {
    const s = tr.w2s(spawns[i].x, spawns[i].z);
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
}
function removeSpawn(i) {
  if (i < 0 || i >= spawns.length) return;
  spawns.splice(i, 1);
  selectedSpawn = -1;
  spawnsDirty = true;
  renderSpawnList();
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
      renderSpawnList();
    });
    box.appendChild(div);
  });
}
function centerOnSelected() {
  if (selectedSpawn >= 0 && selectedSpawn < spawns.length) {
    tr.cam.cx = spawns[selectedSpawn].x;
    tr.cam.cz = spawns[selectedSpawn].z;
  }
}

// ============================================================================
// 输入事件
// ============================================================================
function onMouseMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const w = tr.s2w(px, py);
  hoverWorld.x = w.x; hoverWorld.z = w.z; hoverWorld.in = true;
  // 坐标信息
  const h = terrainHeight(w.x, w.z);
  const blocked = terrainBlocked(w.x, w.z);
  $('editor-coord').textContent =
    `x:${Math.floor(w.x)} z:${Math.floor(w.z)} h:${h.toFixed(1)} ${blocked ? '■空洞' : '·可通行'} ${mode === 'spawn' ? '·出生点:' + spawns.length : '·编辑格:' + editCellCount()}`;
  // 右键平移
  if (panning) {
    tr.pan(ev.clientX - lastPan.x, ev.clientY - lastPan.y);
    lastPan = { x: ev.clientX, y: ev.clientY };
    return;
  }
  // 出生点拖动
  if (mode === 'spawn' && dragSpawn) {
    const sp = spawns[dragSpawn.index];
    sp.x = Math.round((w.x - dragSpawn.offX) * 2) / 2;
    sp.z = Math.round((w.z - dragSpawn.offZ) * 2) / 2;
    spawnsDirty = true;
    renderSpawnList();
    return;
  }
  // 地形画刷拖动
  if (mode === 'terrain' && editing) {
    applyBrushAt(w.x, w.z, false);
  }
}

canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mousedown', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  if (ev.button === 2) { panning = true; lastPan = { x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button !== 0) return;
  const w = tr.s2w(px, py);
  if (mode === 'spawn') {
    const idx = findSpawnAt(px, py);
    if (idx >= 0) {
      selectedSpawn = idx;
      dragSpawn = { index: idx, offX: w.x - spawns[idx].x, offZ: w.z - spawns[idx].z };
      renderSpawnList();
    } else {
      addSpawn(w.x, w.z);
    }
    return;
  }
  applyBrushAt(w.x, w.z, true);
  editing = true;
});
window.addEventListener('mouseup', () => { editing = false; panning = false; dragSpawn = null; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('mouseleave', () => { hoverWorld.in = false; });
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  tr.zoomAt(px, py, k);
}, { passive: false });

// ---- WASD / 方向键平移 ----
function panKey() {
  if (!running || !tr) return;
  const speed = 12 / tr.cam.zoom; // 世界单位/帧
  let dx = 0, dz = 0;
  if (keys.w || keys.arrowup) dz -= speed;
  if (keys.s || keys.arrowdown) dz += speed;
  if (keys.a || keys.arrowleft) dx -= speed;
  if (keys.d || keys.arrowright) dx += speed;
  if (dx || dz) tr.panWorld(dx, dz);
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

// ============================================================================
// 模式切换
// ============================================================================
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
}

// ============================================================================
// 工具栏绑定
// ============================================================================
function bindTools() {
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener('change', () => setMode(el.value));
  });
  document.querySelectorAll('input[name="brush"]').forEach((el) => {
    el.addEventListener('change', () => { brush.type = el.value; });
  });
  const radius = $('brush-radius'), strength = $('brush-strength');
  radius.addEventListener('input', () => { brush.radius = parseFloat(radius.value); $('brush-radius-v').textContent = brush.radius + 'm'; });
  strength.addEventListener('input', () => { brush.strength = parseFloat(strength.value); $('brush-strength-v').textContent = brush.strength; });
  $('brush-falloff').addEventListener('change', (e) => { brush.falloff = e.target.value; });
  $('brush-target').addEventListener('input', (e) => { brush.targetH = parseFloat(e.target.value) || 0; });
  $('show-height').addEventListener('change', (e) => {
    showHeight = e.target.checked;
    tr.showHeight = showHeight;
    updateLegend();
    tr.invalidateAllChunks();
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
    tr.invalidateAllChunks();
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

// ============================================================================
// 登录
// ============================================================================
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

  // 初始化共享地形渲染器
  tr = new TerrainRenderer({ canvas, worldSize: WORLD, showGrid: true, gridStep: 10 });
  tr.resize();
  tr.showHeight = showHeight;

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

  renderSpawnList();
  $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${spawns.length}`;
  setStatus(`已加载服务器数据（地形 ${editCellCount()} 格 / 出生点 ${spawns.length} 个）。WASD 平移，滚轮缩放。`);
  refreshButtons();

  // 启动渲染循环
  running = true;
  requestAnimationFrame(frame);
  // 键盘平移循环
  requestAnimationFrame(panKeyLoop);
}
function panKeyLoop() {
  if (!running) return;
  panKey();
  requestAnimationFrame(panKeyLoop);
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

// ============================================================================
// 初始化
// ============================================================================
window.addEventListener('resize', () => { if (tr) { tr.resize(); } });
bindTools();
refreshButtons();
