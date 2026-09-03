/**
 * editor.js - EvolutionWorld 世界编辑器（2.5D 等距视角）
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
  getEditCells, editCellCount, WATER_LEVEL, loadWalkMask,
} from './terrain.js';
import { TerrainRenderer, heightColor } from './terrain-renderer.js';
import { resolveIcon } from './items.js';
// 登录态持久化：与游戏客户端（boot.js）共用同一份 localStorage 会话
import { saveSession, loadSession, clearSession, verifySession, logoutSession } from './session.js';

const $ = (id) => document.getElementById(id);
const BASE = '';
const WORLD = 128;   // 世界 [-128,128) 米
const VIEW_RANGE = 160; // 编辑器视距（足够覆盖整个编辑区域）

let token = '', username = '';
let loggingIn = false;  // 登录防重入：submit 按钮会同时触发 click+submit
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

// ---- 物品/生物配置（编辑器；来自 /api/gamedata，保存回 /api/items|monsters/edit） ----
let gameItems = [];        // 物品数组（服务端格式）
let gameCreatures = {};    // 生物对象（键=type）
let selectedItem = -1;     // gameItems 选中下标
let selectedCreature = ''; // 选中生物 type 键
// ---- 视图平移（WASD）：速度可调 + 帧率无关 ----
let panSpeed = 5;
let lastPanTs = 0;

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
  if (mode === 'terrain') { applyBrushAt(w.x, w.z, true); editing = true; }
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

// ---- WASD / 方向键平移（速度随缩放自适应 + 帧率无关；panSpeed 界面可调） ----
function panKey(ts) {
  if (!running || !tr) return;
  // dtScale：以 60fps（16.667ms/帧）为基准归一，clamp [0,3] 防止后台切回时跳变
  const dt = lastPanTs ? (ts - lastPanTs) : 16.667;
  lastPanTs = ts;
  const dtScale = Math.max(0, Math.min(3, dt / 16.667));
  // 除以 zoom：缩放大（拉近）时世界位移小，保持恒定屏幕速度
  const speed = (panSpeed / tr.cam.zoom) * dtScale;
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
const MODE_TIP = {
  terrain: '画刷编辑地形：浅灰=可通行 / 白=空洞',
  spawn: '点击空白=新增出生点 · 拖动标记=移动 · 点选后 Del=删除',
  item: '配置物品：名称/描述/属性/品质/需求等级；保存后热重载',
  creature: '配置生物：属性/经验/移速/掉落；保存后世界生物热重载',
};
function setMode(m) {
  mode = m;
  $('panel-terrain').classList.toggle('hidden', mode !== 'terrain');
  $('panel-spawn').classList.toggle('hidden', mode !== 'spawn');
  $('panel-item').classList.toggle('hidden', mode !== 'item');
  $('panel-creature').classList.toggle('hidden', mode !== 'creature');
  $('mode-tip').textContent = MODE_TIP[mode] || '';
  // 撤销/重做/重置仅对地形有意义，其余模式禁用
  const terrainOnly = mode === 'terrain';
  $('btn-reset').disabled = !terrainOnly;
  if (terrainOnly) refreshButtons();
  else { $('btn-undo').disabled = true; $('btn-redo').disabled = true; }
  if (mode === 'terrain') $('editor-status').textContent = '就绪（WASD 平移 · 滚轮缩放 · 左键画刷）';
  else if (mode === 'spawn') $('editor-status').textContent = `生物出生点（${spawns.length} 个）· WASD 平移 · 左键新增/拖拽`;
  else if (mode === 'item') $('editor-status').textContent = `物品配置（${gameItems.length} 件）· 编辑后点“保存到服务器”`;
  else $('editor-status').textContent = `生物配置（${Object.keys(gameCreatures).length} 种）· 编辑后点“保存到服务器”`;
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
  // 重新执行世界初始化（大型网游规模）：服务端重新生成连通地形+主城+分组生物投放
  const wiBtn = $('btn-worldinit');
  if (wiBtn) wiBtn.addEventListener('click', async () => {
    if (!confirm('重新执行世界初始化？\n将重新生成连通地形、主城与生物投放（怪物由主城向外逐渐增强、成群出现），并覆盖当前世界数据。此操作不可撤销。')) return;
    setStatus('正在重新初始化世界…');
    try {
      const j = await authedPost('/api/world/reinit', { token });
      if (j && j.ok) {
        if (j.b64) loadWalkMask(j);                       // 安装新可通行 mask
        if (Array.isArray(j.spawns)) { spawns = j.spawns; renderSpawnList(); }
        tr.invalidateAllChunks();                          // 地形已变，重绘所有区块
        $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${spawns.length}`;
        setStatus(`世界已重新初始化：${spawns.length} 个出生点，可通行区域已重建（在线玩家需重新进入以同步新地形）。`);
      } else if (j && j.auth) {
        setStatus('会话已过期，请重新登录后再初始化世界。');
      } else {
        setStatus('世界初始化失败：' + ((j && j.error) || '未知错误'));
      }
    } catch (e) { setStatus('世界初始化失败：网络错误'); }
  });
  $('btn-save').addEventListener('click', async () => {
    if (mode === 'spawn') {
      setStatus('保存出生点…');
      const ok = await saveSpawns();
      setStatus(ok ? `已保存 ${spawns.length} 个出生点，服务器已热重载世界生物` : saveFailText());
    } else if (mode === 'item') {
      setStatus('保存物品…');
      const ok = await saveItems();
      setStatus(ok ? `已保存 ${gameItems.length} 件物品，服务器已热重载` : saveFailText());
    } else if (mode === 'creature') {
      setStatus('保存生物…');
      const ok = await saveCreatures();
      setStatus(ok ? `已保存 ${Object.keys(gameCreatures).length} 种生物，世界生物已热重载` : saveFailText());
    } else {
      setStatus('保存地形…');
      const ok = await saveTerrain();
      setStatus(ok ? `已保存 ${editCellCount()} 个编辑格，运行时地形已更新` : saveFailText());
    }
  });
  // 视图导航：平移速度（WASD）
  const panSpeedEl = $('pan-speed');
  panSpeedEl.addEventListener('input', () => { panSpeed = parseFloat(panSpeedEl.value) || 5; $('pan-speed-v').textContent = panSpeed; });
  // 物品/生物配置面板
  buildIconPresets();
  bindItemForm();
  bindCreatureForm();
  $('btn-item-new').addEventListener('click', newItem);
  $('btn-item-del').addEventListener('click', deleteItem);
  $('btn-creature-new').addEventListener('click', newCreature);
  $('btn-creature-del').addEventListener('click', deleteCreature);
  $('btn-drop-add').addEventListener('click', addDrop);
}
function setStatus(text) { $('editor-status').textContent = text; }

/** 保存失败提示：区分“会话过期”（已弹出重新登录）与普通失败 */
function saveFailText() {
  return $('editor-login').classList.contains('hidden')
    ? '保存失败（见上方）'
    : '会话已过期：请重新登录后再保存（未提交的修改已保留）';
}

// 鉴权写请求统一入口：401 / {"error":"auth"} → 清除本地会话并回到登录界面
async function authedPost(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (r.status === 401 || (j && j.error === 'auth')) { requireRelogin(); return { ok: false, auth: true }; }
  return j || { ok: false, error: 'bad response' };
}

async function saveTerrain() {
  try {
    const j = await authedPost('/api/terrain/edit', { token, cells: getEditCells() });
    return j.ok === true;
  } catch (e) { return false; }
}
async function saveSpawns() {
  try {
    const j = await authedPost('/api/spawns/edit', { token, spawns });
    if (j.ok) spawnsDirty = false;
    return !!j.ok;
  } catch (e) { return false; }
}

// ============================================================================
// 物品 / 生物配置面板（/api/gamedata 读取，/api/items|monsters/edit 保存）
// ============================================================================
const ICON_PRESETS = ['⛑','🪖','👕','🛡','👖','🧤','🥾','⚔','🗡','🔥','🧪','🔵','🦷','🎖','🦴','💎','🍖','📜','💰','🏹','🔮','⚗'];
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadGameData() {
  try {
    const r = await fetch(BASE + '/api/gamedata');
    const jd = await r.json();
    if (jd && jd.ok) {
      gameItems = Array.isArray(jd.items) ? jd.items : [];
      gameCreatures = (jd.monsters && typeof jd.monsters === 'object') ? jd.monsters : {};
    }
  } catch (e) {}
  selectedItem = gameItems.length ? 0 : -1;
  const ckeys = Object.keys(gameCreatures);
  selectedCreature = ckeys.length ? ckeys[0] : '';
  renderItemList(); renderItemForm();
  renderCreatureList(); renderCreatureForm();
}
function buildIconPresets() {
  const box = $('it-icon-presets');
  if (!box || box.childElementCount) return;
  for (const emo of ICON_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = emo;
    b.addEventListener('click', () => {
      const it = gameItems[selectedItem]; if (!it) return;
      it.icon = emo; $('it-icon').value = emo; renderItemList();
    });
    box.appendChild(b);
  }
}
// ---- 物品列表 / 表单 ----
function renderItemList() {
  $('item-count-label').textContent = gameItems.length;
  const box = $('item-list'); box.innerHTML = '';
  if (!gameItems.length) { box.innerHTML = '<div class="cfg-empty">暂无物品，点“新建”添加</div>'; return; }
  gameItems.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'cfg-item' + (i === selectedItem ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">${resolveIcon(it.icon)}</span><span class="cfg-nm">${esc(it.name) || '(未命名)'}</span><span class="cfg-id">#${it.id}</span>`;
    div.addEventListener('click', () => { selectedItem = i; renderItemList(); renderItemForm(); });
    box.appendChild(div);
  });
}
function setItemFormEnabled(on) {
  ['it-id','it-name','it-desc','it-icon','it-type','it-slot','it-rarity','it-levelReq','it-hpBonus','it-mpBonus','it-attackBonus','it-defenseBonus','it-restoreHp','it-restoreMp','it-price','it-stackMax'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
}
function updateItemConditional() {
  const it = gameItems[selectedItem];
  const type = it ? (it.type || 'equip') : 'equip';
  $('it-slot-row').style.display = type === 'equip' ? '' : 'none';
  $('it-restore-row').style.display = type === 'consumable' ? '' : 'none';
}
function renderItemForm() {
  const it = gameItems[selectedItem];
  if (!it) { $('item-form').style.opacity = '0.4'; setItemFormEnabled(false); return; }
  $('item-form').style.opacity = '1'; setItemFormEnabled(true);
  $('it-id').value = it.id;
  $('it-name').value = it.name || '';
  $('it-desc').value = it.desc || '';
  $('it-icon').value = it.icon || '';
  $('it-type').value = it.type || 'equip';
  $('it-slot').value = it.slot || 'weapon';
  $('it-rarity').value = String(it.rarity || 0);
  $('it-levelReq').value = it.levelReq || 1;
  $('it-hpBonus').value = it.hpBonus || 0;
  $('it-mpBonus').value = it.mpBonus || 0;
  $('it-attackBonus').value = it.attackBonus || 0;
  $('it-defenseBonus').value = it.defenseBonus || 0;
  $('it-restoreHp').value = it.restoreHp || 0;
  $('it-restoreMp').value = it.restoreMp || 0;
  $('it-price').value = it.price || 0;
  $('it-stackMax').value = it.stackMax || 99;
  updateItemConditional();
}
function bindItemForm() {
  const it = () => gameItems[selectedItem];
  const num = (id, key, isInt) => {
    const el = $(id);
    el.addEventListener('input', () => { const o = it(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); o[key] = isNaN(v) ? 0 : v; });
  };
  num('it-id', 'id', true);
  num('it-levelReq', 'levelReq', true);
  num('it-hpBonus', 'hpBonus', false);
  num('it-mpBonus', 'mpBonus', false);
  num('it-attackBonus', 'attackBonus', false);
  num('it-defenseBonus', 'defenseBonus', false);
  num('it-restoreHp', 'restoreHp', false);
  num('it-restoreMp', 'restoreMp', false);
  num('it-price', 'price', true);
  num('it-stackMax', 'stackMax', true);
  const nameEl = $('it-name');
  nameEl.addEventListener('input', () => { const o = it(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderItemList());
  const descEl = $('it-desc');
  descEl.addEventListener('input', () => { const o = it(); if (!o) return; o.desc = descEl.value; });
  const iconEl = $('it-icon');
  iconEl.addEventListener('input', () => { const o = it(); if (!o) return; o.icon = iconEl.value; });
  iconEl.addEventListener('change', () => renderItemList());
  $('it-id').addEventListener('change', () => renderItemList());
  const typeEl = $('it-type');
  typeEl.addEventListener('change', () => { const o = it(); if (!o) return; o.type = typeEl.value; updateItemConditional(); });
  const slotEl = $('it-slot');
  slotEl.addEventListener('change', () => { const o = it(); if (!o) return; o.slot = slotEl.value; });
  const rarEl = $('it-rarity');
  rarEl.addEventListener('change', () => { const o = it(); if (!o) return; o.rarity = parseInt(rarEl.value, 10) || 0; });
}
function newItem() {
  let maxId = 1000;
  for (const o of gameItems) if ((o.id | 0) > maxId) maxId = o.id | 0;
  gameItems.push({ id: maxId + 1, name: '新物品', desc: '', icon: '❔', type: 'equip', slot: 'weapon', hpBonus: 0, mpBonus: 0, attackBonus: 0, defenseBonus: 0, restoreHp: 0, restoreMp: 0, price: 0, stackMax: 99, rarity: 0, levelReq: 1 });
  selectedItem = gameItems.length - 1;
  renderItemList(); renderItemForm();
}
function deleteItem() {
  if (selectedItem < 0 || selectedItem >= gameItems.length) { setStatus('请先选择要删除的物品'); return; }
  const o = gameItems[selectedItem];
  if (!confirm(`删除物品 #${o.id}「${o.name}」？`)) return;
  gameItems.splice(selectedItem, 1);
  selectedItem = Math.min(selectedItem, gameItems.length - 1);
  renderItemList(); renderItemForm();
}
async function saveItems() {
  const seen = new Set();
  for (const o of gameItems) {
    if (!o.id || o.id <= 0) { setStatus('物品 ID 必须为正整数'); return false; }
    if (seen.has(o.id)) { setStatus(`物品 ID 重复：#${o.id}`); return false; }
    seen.add(o.id);
  }
  try {
    const j = await authedPost('/api/items/edit', { token, items: gameItems });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}
// ---- 生物列表 / 表单 ----
function renderCreatureList() {
  const keys = Object.keys(gameCreatures);
  $('creature-count-label').textContent = keys.length;
  const box = $('creature-list'); box.innerHTML = '';
  if (!keys.length) { box.innerHTML = '<div class="cfg-empty">暂无生物，点“新建”添加</div>'; return; }
  keys.forEach((type) => {
    const cr = gameCreatures[type];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (type === selectedCreature ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🐾</span><span class="cfg-nm">${esc(cr.name) || type}</span><span class="cfg-id">${esc(type)}</span>`;
    div.addEventListener('click', () => { selectedCreature = type; renderCreatureList(); renderCreatureForm(); });
    box.appendChild(div);
  });
}
function setCreatureFormEnabled(on) {
  ['cr-type','cr-name','cr-desc','cr-level','cr-moveSpeed','cr-hp','cr-mp','cr-attack','cr-defense','cr-expReward','cr-goldMin','cr-goldMax','cr-skillIds'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const da = $('btn-drop-add'); if (da) da.disabled = !on;
}
function renderCreatureForm() {
  const cr = gameCreatures[selectedCreature];
  if (!cr) {
    $('creature-form').style.opacity = '0.4'; setCreatureFormEnabled(false);
    $('drop-list').innerHTML = '<div class="cfg-empty">选择或新建生物</div>'; $('drop-count-label').textContent = 0;
    return;
  }
  $('creature-form').style.opacity = '1'; setCreatureFormEnabled(true);
  $('cr-type').value = selectedCreature;
  $('cr-name').value = cr.name || '';
  $('cr-desc').value = cr.desc || '';
  $('cr-level').value = cr.level || 1;
  $('cr-moveSpeed').value = (cr.moveSpeed != null ? cr.moveSpeed : 1.5);
  $('cr-hp').value = cr.hp || 0;
  $('cr-mp').value = cr.mp || 0;
  $('cr-attack').value = cr.attack || 0;
  $('cr-defense').value = cr.defense || 0;
  $('cr-expReward').value = cr.expReward || 0;
  $('cr-goldMin').value = cr.goldMin || 0;
  $('cr-goldMax').value = cr.goldMax || 0;
  $('cr-skillIds').value = (cr.skillIds || []).join(',');
  renderDropList();
}
function bindCreatureForm() {
  const cr = () => gameCreatures[selectedCreature];
  const num = (id, key, isInt) => {
    const el = $(id);
    el.addEventListener('input', () => { const c = cr(); if (!c) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); c[key] = isNaN(v) ? 0 : v; });
  };
  num('cr-level', 'level', true);
  num('cr-moveSpeed', 'moveSpeed', false);
  num('cr-hp', 'hp', false);
  num('cr-mp', 'mp', false);
  num('cr-attack', 'attack', false);
  num('cr-defense', 'defense', false);
  num('cr-expReward', 'expReward', true);
  num('cr-goldMin', 'goldMin', true);
  num('cr-goldMax', 'goldMax', true);
  const nameEl = $('cr-name');
  nameEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderCreatureList());
  const descEl = $('cr-desc');
  descEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.desc = descEl.value; });
  const skEl = $('cr-skillIds');
  skEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.skillIds = skEl.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0); });
  // ID(type) 重命名：保留顺序重建对象键
  const typeEl = $('cr-type');
  typeEl.addEventListener('change', () => {
    const oldType = selectedCreature;
    const c = gameCreatures[oldType]; if (!c) return;
    const newType = typeEl.value.trim();
    if (!newType) { typeEl.value = oldType; setStatus('生物 ID 不能为空'); return; }
    if (newType === oldType) return;
    if (gameCreatures[newType]) { typeEl.value = oldType; setStatus(`生物 ID 已存在：${newType}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(gameCreatures)) {
      if (k === oldType) rebuilt[newType] = c; else rebuilt[k] = gameCreatures[k];
    }
    gameCreatures = rebuilt;
    selectedCreature = newType;
    renderCreatureList();
  });
}
// ---- 掉落子表 ----
function itemOptionsHtml(selId) {
  let html = '<option value="0">（无）</option>';
  for (const o of gameItems) {
    const id = o.id | 0;
    html += `<option value="${id}"${id === selId ? ' selected' : ''}>#${id} ${esc(o.name)}</option>`;
  }
  return html;
}
function renderDropList() {
  const cr = gameCreatures[selectedCreature];
  const box = $('drop-list'); box.innerHTML = '';
  if (!cr) return;
  const drops = cr.drops || (cr.drops = []);
  $('drop-count-label').textContent = drops.length;
  if (!drops.length) { box.innerHTML = '<div class="cfg-empty">无掉落，点“添加掉落”</div>'; return; }
  drops.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'drop-row';
    const sel = document.createElement('select');
    sel.innerHTML = itemOptionsHtml(d.item | 0);
    sel.addEventListener('change', () => { d.item = parseInt(sel.value, 10) || 0; });
    const pct = document.createElement('input');
    pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = '1';
    pct.value = Math.round((d.prob || 0) * 100);
    pct.addEventListener('input', () => { let v = parseFloat(pct.value); if (isNaN(v)) v = 0; d.prob = Math.max(0, Math.min(100, v)) / 100; });
    const lbl = document.createElement('span'); lbl.className = 'drop-pct'; lbl.textContent = '%';
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { drops.splice(i, 1); renderDropList(); });
    row.appendChild(sel); row.appendChild(pct); row.appendChild(lbl); row.appendChild(del);
    box.appendChild(row);
  });
}
function addDrop() {
  const cr = gameCreatures[selectedCreature];
  if (!cr) { setStatus('请先选择生物'); return; }
  if (!cr.drops) cr.drops = [];
  cr.drops.push({ item: gameItems.length ? (gameItems[0].id | 0) : 0, prob: 0.1 });
  renderDropList();
}
function newCreature() {
  let n = 1, type = 'creature1';
  while (gameCreatures[type]) { n++; type = 'creature' + n; }
  gameCreatures[type] = { name: '新生物', desc: '', level: 1, hp: 50, mp: 20, attack: 8, defense: 2, moveSpeed: 1.5, expReward: 20, goldMin: 1, goldMax: 3, drops: [], skillIds: [] };
  selectedCreature = type;
  renderCreatureList(); renderCreatureForm();
}
function deleteCreature() {
  if (!selectedCreature || !gameCreatures[selectedCreature]) { setStatus('请先选择要删除的生物'); return; }
  if (!confirm(`删除生物「${gameCreatures[selectedCreature].name}」(${selectedCreature})？`)) return;
  delete gameCreatures[selectedCreature];
  const keys = Object.keys(gameCreatures);
  selectedCreature = keys.length ? keys[0] : '';
  renderCreatureList(); renderCreatureForm();
}
async function saveCreatures() {
  for (const type of Object.keys(gameCreatures)) {
    if (!type) { setStatus('生物 ID 不能为空'); return false; }
  }
  try {
    const j = await authedPost('/api/monsters/edit', { token, monsters: gameCreatures });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
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
  // resume=true：会话过期后重新登录。此时编辑器已初始化完成，仅换发新令牌，
  // 保留未保存的地形/出生点/物品/生物修改，避免重登导致工作丢失。
  const resume = running;
  token = j.token;
  username = j.user.username;
  saveSession(token, username);
  $('editor-login').classList.add('hidden');
  $('editor-app').classList.remove('hidden');
  $('editor-user-name').textContent = username;
  if (resume) {
    setStatus(`已重新登录（${username}），之前未保存的修改仍在，可继续保存。`);
    return;
  }

  // 加载服务器可通行 mask（世界初始化产物）——必须在创建渲染器前安装，
  // 否则未加载时全图视为空洞，编辑器将渲染为一片白色。
  try {
    const r = await fetch(BASE + '/api/terrain/mask');
    const jd = await r.json();
    if (jd && jd.ok) loadWalkMask(jd);
  } catch (e) {}

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
  // 加载游戏数据（物品/生物配置）
  await loadGameData();

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
function panKeyLoop(ts) {
  if (!running) return;
  panKey(ts);
  requestAnimationFrame(panKeyLoop);
}

function loginMsg(text, ok) {
  const el = $('editor-login-msg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}
// 会话失效（服务端重启 / 令牌过期）：回到登录界面重新取令牌。
// 编辑器已加载的修改全部保留在内存中，重登后可直接继续保存。
function requireRelogin(reason) {
  clearSession();
  token = '';
  if (!$('editor-login').classList.contains('hidden')) return; // 已在提示中，避免重复覆盖文案
  $('editor-user-name').textContent = '-';
  $('editor-login').classList.remove('hidden');
  loginMsg(reason || '会话已过期，请重新登录（未保存的修改已保留）', false);
}

async function doLogin() {
  if (loggingIn) return;
  const un = $('editor-user').value.trim();
  const pw = $('editor-pass').value;
  if (!un || !pw) { loginMsg('请输入账号密码', false); return; }
  loggingIn = true;
  loginMsg('登录中…', false);
  try {
    const j = await post('/api/login', { username: un, password: pw });
    if (j.ok) await enterEditor(j);
    else loginMsg(j.error || '登录失败', false);
  } catch (e) { loginMsg('网络错误', false); }
  finally { loggingIn = false; }
}

// 刷新页面自动恢复会话：与游戏客户端共用 localStorage 中的登录态，
// 因此先在游戏里登录再打开编辑器（或反之）都无需重复登录。
async function restoreSession() {
  const s = loadSession();
  if (!s) return;
  $('editor-user').value = s.username || '';
  loginMsg('正在恢复会话…', false);
  // verifySession 返回 null = 无法判定（服务端无 /api/me 或网络异常）→ 乐观恢复；
  // 若令牌确实已失效，首次保存时 authedPost 会收到 401 并弹出重新登录（修改不丢）。
  if (await verifySession(s.token) === false) {
    clearSession();
    loginMsg('会话已过期，请重新登录', false);
    return;
  }
  try {
    await enterEditor({ token: s.token, user: { username: s.username || '' } });
  } catch (e) {
    clearSession();
    loginMsg('恢复会话失败，请重新登录', false);
  }
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
// 退出登录：销毁服务端令牌 + 清本地会话（否则共享会话会让刷新后又自动登录）
// 容忍旧版缓存的 editor.html 尚无此按钮：缺失时跳过绑定，避免整个模块抛错
const logoutBtn = $('editor-logout');
if (logoutBtn) logoutBtn.addEventListener('click', async () => {
  if (!confirm('退出登录？未保存的修改将丢失。')) return;
  await logoutSession(token);
  token = ''; username = '';
  running = false;                       // 停止渲染与键盘平移循环
  undoStack = []; redoStack = []; spawnsDirty = false;
  $('editor-app').classList.add('hidden');
  $('editor-user-name').textContent = '-';
  $('editor-pass').value = '';
  $('editor-login').classList.remove('hidden');
  loginMsg('已退出登录', true);
});

// ============================================================================
// 初始化
// ============================================================================
window.addEventListener('resize', () => { if (tr) { tr.resize(); } });
bindTools();
refreshButtons();
restoreSession();
