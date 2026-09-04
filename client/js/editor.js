/**
 * editor.js - EvolutionWorld 世界编辑器（Canvas 2D 渲染）
 * 使用共享 canvas-renderer.js 渲染，与游戏客户端同源同构。
 *
 * 两种模式：
 *  - 地形：画刷（抬高/降低/铺平/平滑/挖空/恢复），浅灰=可通行 / 白色=空洞，可选高度色带
 *  - 生物出生点（剧本）：新增/拖动/删除怪物、NPC、Boss 出生点，保存后服务端热重载
 *
 * 渲染：WebGLRenderer Canvas 2D（与游戏 index.html 共用模块），色块地形 + 实体圆圈。
 * 交互：WASD/方向键平移 · 滚轮缩放 · 左键画刷/拖拽 · 右键平移。
 * 数据：地形与服务端 terrain.cpp / 游戏 terrain.js 同源；出生点走 /api/spawns(/edit)。
 */
import {
  terrainHeight, terrainBlocked, setEditCell, clearEdit, loadEditCells,
  getEditCells, editCellCount, WATER_LEVEL, loadWalkMask,
} from './terrain.js';
import { WebGLRenderer } from './canvas-renderer.js';
import { resolveIcon } from './items.js';
// 登录态持久化：与游戏客户端（boot.js）共用同一份 localStorage 会话
import { saveSession, clearSession, logoutSession } from './session.js';
import { initLogin, hideLogin, showLogin, showLoading, setLoadingText } from './login.js';

const $ = (id) => document.getElementById(id);
const BASE = '';
const WORLD = 128;   // 世界 [-128,128) 米

let token = '', username = '';
let mode = 'terrain';     // 'terrain' | 'spawn'
let showHeight = false;

// ---- WebGL 渲染器 ----
let tr = null; // WebGLRenderer 实例
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
let gameNpcs = {};         // NPC 对象（键=type）
let selectedItem = -1;     // gameItems 选中下标
let selectedCreature = ''; // 选中生物 type 键
let selectedNpc = '';      // 选中 NPC type 键
let gameQuests = [];       // 任务数组（服务端格式）
let selectedQuest = -1;    // gameQuests 选中下标
// ---- 经济配置（阶段7编辑器；来自 /api/gamedata，保存回 /api/{enhance,decompose,craft,shop}/edit）----
let gameEnhance = null;    // 强化配置对象 {maxLevel, ..., levels:[...]}
let gameDecompose = null;  // 分解配置对象 {stoneItemId, rules:[...]}
let gameCraft = [];        // 合成配方数组（recipes）
let selectedCraft = -1;    // gameCraft 选中下标
let gameShops = {};        // 商店对象（键=shopId）
let selectedShop = '';     // 选中商店 shopId 键
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
  tr.invalidateTerrain();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  refreshButtons();
  tr.invalidateTerrain();
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

  // 每帧检查 canvas 尺寸是否与容器同步：编辑器 canvas 在 flex 布局内，
  // 初始创建时容器可能尚未完成布局，导致 canvas.width/height 与 CSS 尺寸不一致，
  // 使投影矩阵 aspect 与 s2w 逆投影 aspect 不匹配 → 鼠标点击偏移
  tr.resize();

  // 出生点标记
  tr.setSpawnMarkers(spawns.map((sp, i) => ({ ...sp, _selected: i === selectedSpawn })));

  // 画刷预览（地形模式）
  if (mode === 'terrain' && hoverWorld.in) {
    tr.setBrushPreview(hoverWorld.x, hoverWorld.z, brush.radius);
  } else {
    tr.setBrushPreview(0, 0, 0);
  }

  tr.render();
  requestAnimationFrame(frame);
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
  // 地形已变，标记重建
  tr.invalidateTerrain();
}

// ============================================================================
// 出生点操作
// ============================================================================
function findSpawnAt(px, py) {
  let best = -1, bestD = 1e9;
  for (let i = 0; i < spawns.length; i++) {
    const s = tr.w2s(spawns[i].x, 0, spawns[i].z);
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
    tr.setCameraFree(spawns[selectedSpawn].x, spawns[selectedSpawn].z);
  }
}

// ============================================================================
// 输入事件
// ============================================================================
function onMouseMove(ev) {
  const rect = tr.canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const w = tr.s2w(px, py);
  hoverWorld.x = w.x; hoverWorld.z = w.z; hoverWorld.in = true;
  // 坐标信息
  const h = terrainHeight(w.x, w.z);
  const blocked = terrainBlocked(w.x, w.z);
  $('editor-coord').textContent =
    `x:${Math.floor(w.x)} z:${Math.floor(w.z)} h:${h.toFixed(1)} ${blocked ? '■空洞' : '·可通行'} ${mode === 'spawn' ? '·出生点:' + spawns.length : '·编辑格:' + editCellCount()}`;
  // 右键平移（屏幕像素 → 世界坐标近似转换）
  if (panning) {
    const screenDx = ev.clientX - lastPan.x;
    const screenDy = ev.clientY - lastPan.y;
    const worldPerPx = 20 / (tr.cam.zoom * (tr.canvas.clientHeight || 1));
    tr.pan(-screenDx * worldPerPx, -screenDy * worldPerPx);
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

// ---- 事件绑定（延迟到渲染器创建后） ----
function setupEditorEvents() {
  const canvas = tr.canvas;
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
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    tr.zoomAt(k);
  }, { passive: false });
}

// ---- WASD / 方向键平移（速度随缩放自适应 + 帧率无关；panSpeed 界面可调） ----
function panKey(ts) {
  if (!running || !tr) return;
  // dtScale：以 60fps（16.667ms/帧）为基准归一，clamp [0,3] 防止后台切回时跳变
  const dt = lastPanTs ? (ts - lastPanTs) : 16.667;
  lastPanTs = ts;
  const dtScale = Math.max(0, Math.min(3, dt / 16.667));
  // 除以 zoom：缩放大（拉近）时世界位移小，保持恒定屏幕速度
  const speed = (panSpeed / tr.cam.zoom) * dtScale * 0.2;
  let dx = 0, dz = 0;
  if (keys.w || keys.arrowup) dz -= speed;
  if (keys.s || keys.arrowdown) dz += speed;
  if (keys.a || keys.arrowleft) dx -= speed;
  if (keys.d || keys.arrowright) dx += speed;
  if (dx || dz) tr.pan(dx, dz);
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
  npc: '配置 NPC 类型：名称/标签/商店；保存后热重载',
  quest: '配置任务：目标/奖励/链式；保存后热重载',
  enhance: '配置强化：等级表/成功率/消耗/属性系数；保存后热重载',
  decompose: '配置分解：按品质返还金币/材料/强化石；保存后热重载',
  craft: '配置合成：配方材料/产物/等级需求；保存后热重载',
  shop: '配置商店：商品/价格/折扣/限购/回收；保存后热重载',
};
function setMode(m) {
  mode = m;
  $('panel-terrain').classList.toggle('hidden', mode !== 'terrain');
  $('panel-spawn').classList.toggle('hidden', mode !== 'spawn');
  $('panel-item').classList.toggle('hidden', mode !== 'item');
  $('panel-creature').classList.toggle('hidden', mode !== 'creature');
  $('panel-npc').classList.toggle('hidden', mode !== 'npc');
  $('panel-quest').classList.toggle('hidden', mode !== 'quest');
  $('panel-enhance').classList.toggle('hidden', mode !== 'enhance');
  $('panel-decompose').classList.toggle('hidden', mode !== 'decompose');
  $('panel-craft').classList.toggle('hidden', mode !== 'craft');
  $('panel-shop').classList.toggle('hidden', mode !== 'shop');
  $('mode-tip').textContent = MODE_TIP[mode] || '';
  // 撤销/重做/重置仅对地形有意义，其余模式禁用
  const terrainOnly = mode === 'terrain';
  $('btn-reset').disabled = !terrainOnly;
  if (terrainOnly) refreshButtons();
  else { $('btn-undo').disabled = true; $('btn-redo').disabled = true; }
  if (mode === 'terrain') $('editor-status').textContent = '就绪（WASD 平移 · 滚轮缩放 · 左键画刷）';
  else if (mode === 'spawn') $('editor-status').textContent = `生物出生点（${spawns.length} 个）· WASD 平移 · 左键新增/拖拽`;
  else if (mode === 'item') $('editor-status').textContent = `物品配置（${gameItems.length} 件）· 编辑后点“保存到服务器”`;
  else if (mode === 'creature') $('editor-status').textContent = `生物配置（${Object.keys(gameCreatures).length} 种）· 编辑后点“保存到服务器”`;
  else if (mode === 'npc') $('editor-status').textContent = `NPC 配置（${Object.keys(gameNpcs).length} 种）· 编辑后点“保存到服务器”`;
  else if (mode === 'quest') $('editor-status').textContent = `任务配置（${gameQuests.length} 个）· 编辑后点“保存到服务器”`;
  else if (mode === 'enhance') $('editor-status').textContent = `强化配置（${(gameEnhance && gameEnhance.levels ? gameEnhance.levels.length : 0)} 级）· 编辑后点“保存到服务器”`;
  else if (mode === 'decompose') $('editor-status').textContent = `分解配置（${(gameDecompose && gameDecompose.rules ? gameDecompose.rules.length : 0)} 档）· 编辑后点“保存到服务器”`;
  else if (mode === 'craft') $('editor-status').textContent = `合成配置（${gameCraft.length} 条配方）· 编辑后点“保存到服务器”`;
  else if (mode === 'shop') $('editor-status').textContent = `商店配置（${Object.keys(gameShops).length} 个）· 编辑后点“保存到服务器”`;
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
    updateLegend();
    tr.invalidateTerrain();
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
    tr.invalidateTerrain();
  });
  // 重新执行世界初始化（大型网游规模）：服务端重新生成连通地形+主城+分组生物投放
  const wiBtn = $('btn-worldinit');
  if (wiBtn) {
    wiBtn.addEventListener('click', async () => {
      console.log('[editor] 世界初始化按钮被点击');
      try {
        if (!confirm('重新执行世界初始化？\n将重新生成连通地形、主城与生物投放（怪物由主城向外逐渐增强、成群出现），并覆盖当前世界数据。此操作不可撤销。')) return;
        setStatus('正在重新初始化世界…');
        wiBtn.disabled = true;
        const j = await authedPost('/api/world/reinit', { token });
        console.log('[editor] /api/world/reinit 响应:', j ? JSON.stringify(j).slice(0, 200) : 'null');
        if (j && j.ok) {
          if (j.b64) loadWalkMask(j);                       // 安装新可通行 mask
          if (Array.isArray(j.spawns)) { spawns = j.spawns; renderSpawnList(); }
          tr.invalidateTerrain();                             // 地形已变，重建网格
          $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${spawns.length}`;
          setStatus(`世界已重新初始化：${spawns.length} 个出生点，可通行区域已重建（在线玩家需重新进入以同步新地形）。`);
        } else if (j && (j.auth || j.error === 'auth')) {
          setStatus('会话已过期，请重新登录后再初始化世界。');
        } else {
          setStatus('世界初始化失败：' + ((j && j.error) || '未知错误'));
        }
      } catch (e) {
        console.error('[editor] 世界初始化异常:', e);
        setStatus('世界初始化失败：' + (e.message || '网络错误'));
      } finally {
        wiBtn.disabled = false;
      }
    });
  } else {
    console.warn('[editor] btn-worldinit 按钮未找到');
  }
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
    } else if (mode === 'npc') {
      setStatus('保存 NPC…');
      const ok = await saveNpcs();
      setStatus(ok ? `已保存 ${Object.keys(gameNpcs).length} 种 NPC，服务器已热重载` : saveFailText());
    } else if (mode === 'quest') {
      setStatus('保存任务…');
      const ok = await saveQuests();
      setStatus(ok ? `已保存 ${gameQuests.length} 个任务，服务器已热重载` : saveFailText());
    } else if (mode === 'enhance') {
      setStatus('保存强化配置…');
      const ok = await saveEnhance();
      setStatus(ok ? `已保存强化配置（${gameEnhance.levels.length} 级），服务器已热重载` : saveFailText());
    } else if (mode === 'decompose') {
      setStatus('保存分解配置…');
      const ok = await saveDecompose();
      setStatus(ok ? `已保存分解配置（${gameDecompose.rules.length} 档），服务器已热重载` : saveFailText());
    } else if (mode === 'craft') {
      setStatus('保存合成配方…');
      const ok = await saveCraft();
      setStatus(ok ? `已保存 ${gameCraft.length} 条配方，服务器已热重载` : saveFailText());
    } else if (mode === 'shop') {
      setStatus('保存商店配置…');
      const ok = await saveShops();
      setStatus(ok ? `已保存 ${Object.keys(gameShops).length} 个商店，服务器已热重载` : saveFailText());
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
  bindNpcForm();
  $('btn-item-new').addEventListener('click', newItem);
  $('btn-item-del').addEventListener('click', deleteItem);
  $('btn-creature-new').addEventListener('click', newCreature);
  $('btn-creature-del').addEventListener('click', deleteCreature);
  $('btn-drop-add').addEventListener('click', addDrop);
  $('btn-npc-new').addEventListener('click', newNpc);
  $('btn-npc-del').addEventListener('click', deleteNpc);
  bindQuestForm();
  $('btn-quest-new').addEventListener('click', newQuest);
  $('btn-quest-del').addEventListener('click', deleteQuest);
  $('btn-q-reward-add').addEventListener('click', addQuestRewardItem);
  $('btn-q-obj-add').addEventListener('click', addQuestObjective);
  // 经济配置（阶段7：强化/分解/合成/商店）
  bindEnhanceForm();
  $('btn-en-addlevel').addEventListener('click', addEnhanceLevel);
  bindDecomposeForm();
  $('btn-de-addrule').addEventListener('click', addDecomposeRule);
  bindCraftForm();
  $('btn-craft-new').addEventListener('click', newCraft);
  $('btn-craft-del').addEventListener('click', deleteCraft);
  $('btn-cf-mat-add').addEventListener('click', addCraftMaterial);
  bindShopForm();
  $('btn-shop-new').addEventListener('click', newShop);
  $('btn-shop-del').addEventListener('click', deleteShop);
  $('btn-sh-entry-add').addEventListener('click', addShopEntry);
}
function setStatus(text) { $('editor-status').textContent = text; }

/** 保存失败提示：区分“会话过期”与普通失败 */
function saveFailText() {
  return '会话已过期：请重新登录后再保存（未提交的修改已保留）';
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
      gameNpcs = (jd.npcs && typeof jd.npcs === 'object') ? jd.npcs : {};
      gameEnhance = (jd.enhance && typeof jd.enhance === 'object') ? jd.enhance
        : { maxLevel: 15, stoneItemId: 4006, protectStoneItemId: 4007, attrPerLevelAtk: 0.08, attrPerLevelDef: 0.06, attrPerLevelHp: 0.05, levels: [] };
      if (!Array.isArray(gameEnhance.levels)) gameEnhance.levels = [];
      gameDecompose = (jd.decompose && typeof jd.decompose === 'object') ? jd.decompose : { stoneItemId: 4006, rules: [] };
      if (!Array.isArray(gameDecompose.rules)) gameDecompose.rules = [];
      gameCraft = (jd.craft && Array.isArray(jd.craft.recipes)) ? jd.craft.recipes : [];
      gameShops = (jd.shops && typeof jd.shops === 'object') ? jd.shops : {};
    }
  } catch (e) {}
  selectedItem = gameItems.length ? 0 : -1;
  const ckeys = Object.keys(gameCreatures);
  selectedCreature = ckeys.length ? ckeys[0] : '';
  const nkeys = Object.keys(gameNpcs);
  selectedNpc = nkeys.length ? nkeys[0] : '';
  selectedCraft = gameCraft.length ? 0 : -1;
  const skeys = Object.keys(gameShops);
  selectedShop = skeys.length ? skeys[0] : '';
  renderItemList(); renderItemForm();
  renderCreatureList(); renderCreatureForm();
  renderNpcList(); renderNpcForm();
  renderEnhanceForm();
  renderDecomposeForm();
  renderCraftList(); renderCraftForm();
  renderShopList(); renderShopForm();
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
  ['cr-type','cr-name','cr-desc','cr-level','cr-moveSpeed','cr-hp','cr-mp','cr-attack','cr-defense','cr-expReward','cr-goldMin','cr-goldMax','cr-skillIds','cr-isBoss','cr-aggroRange','cr-chaseSpeed','cr-bossAttackRange'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
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
  // Boss 字段
  const isBoss = !!cr.isBoss;
  $('cr-isBoss').checked = isBoss;
  $('cr-boss-fields').classList.toggle('hidden', !isBoss);
  $('cr-aggroRange').value = cr.aggroRange != null ? cr.aggroRange : 18;
  $('cr-chaseSpeed').value = cr.chaseSpeed != null ? cr.chaseSpeed : 3;
  $('cr-bossAttackRange').value = cr.attackRange != null ? cr.attackRange : 2.5;
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
  // Boss 字段
  const bossCb = $('cr-isBoss');
  bossCb.addEventListener('change', () => {
    const c = cr(); if (!c) return;
    c.isBoss = bossCb.checked;
    $('cr-boss-fields').classList.toggle('hidden', !bossCb.checked);
  });
  const numBoss = (id, key) => {
    const el = $(id);
    el.addEventListener('input', () => { const c = cr(); if (!c) return; const v = parseFloat(el.value); c[key] = isNaN(v) ? 0 : v; });
  };
  numBoss('cr-aggroRange', 'aggroRange');
  numBoss('cr-chaseSpeed', 'chaseSpeed');
  numBoss('cr-bossAttackRange', 'attackRange');
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

// ---- NPC 列表 / 表单 ----
function renderNpcList() {
  const keys = Object.keys(gameNpcs);
  $('npc-count-label').textContent = keys.length;
  const box = $('npc-list'); box.innerHTML = '';
  if (!keys.length) { box.innerHTML = '<div class="cfg-empty">暂无 NPC，点"新建"添加</div>'; return; }
  keys.forEach((type) => {
    const npc = gameNpcs[type];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (type === selectedNpc ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🧑</span><span class="cfg-nm">${esc(npc.name) || type}</span><span class="cfg-id">${esc(type)}</span>`;
    div.addEventListener('click', () => { selectedNpc = type; renderNpcList(); renderNpcForm(); });
    box.appendChild(div);
  });
}
function setNpcFormEnabled(on) {
  ['npc-id','npc-name','npc-desc','npc-model','npc-tag','npc-shopId','npc-level','npc-wander','npc-dialogue'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
}
function renderNpcForm() {
  const npc = gameNpcs[selectedNpc];
  if (!npc) { $('npc-form').style.opacity = '0.4'; setNpcFormEnabled(false); return; }
  $('npc-form').style.opacity = '1'; setNpcFormEnabled(true);
  $('npc-id').value = selectedNpc;
  $('npc-name').value = npc.name || '';
  $('npc-desc').value = npc.desc || '';
  $('npc-model').value = npc.model || '';
  // 标签：多选框（位标志组合）
  const tagEl = $('npc-tag');
  const tag = npc.npcTag != null ? npc.npcTag : 1;
  for (const opt of tagEl.options) {
    opt.selected = (tag & parseInt(opt.value, 10)) !== 0;
  }
  $('npc-shopId').value = npc.shopId || 0;
  $('npc-level').value = npc.level || 1;
  $('npc-wander').value = npc.wanderRadius || 0;
  $('npc-dialogue').value = npc.dialogue || '';
}
function bindNpcForm() {
  const npc = () => gameNpcs[selectedNpc];
  const nameEl = $('npc-name');
  nameEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderNpcList());
  const descEl = $('npc-desc');
  descEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.desc = descEl.value; });
  const modelEl = $('npc-model');
  modelEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.model = modelEl.value; });
  // 标签：多选框（位标志组合）
  const tagEl = $('npc-tag');
  tagEl.addEventListener('change', () => {
    const o = npc(); if (!o) return;
    let tag = 0;
    for (const opt of tagEl.options) {
      if (opt.selected) tag |= parseInt(opt.value, 10);
    }
    o.npcTag = tag || 1;
  });
  const shopEl = $('npc-shopId');
  shopEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseInt(shopEl.value, 10); o.shopId = isNaN(v) ? 0 : v; });
  const levelEl = $('npc-level');
  levelEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseInt(levelEl.value, 10); o.level = isNaN(v) ? 1 : v; });
  const wanderEl = $('npc-wander');
  wanderEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseFloat(wanderEl.value); o.wanderRadius = isNaN(v) ? 0 : v; });
  const dialogueEl = $('npc-dialogue');
  dialogueEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.dialogue = dialogueEl.value; });
  // ID(npcId) 重命名
  const idEl = $('npc-id');
  idEl.addEventListener('change', () => {
    const oldType = selectedNpc;
    const o = gameNpcs[oldType]; if (!o) return;
    const newType = idEl.value.trim();
    if (!newType) { idEl.value = oldType; setStatus('NPC ID 不能为空'); return; }
    if (newType === oldType) return;
    if (gameNpcs[newType]) { idEl.value = oldType; setStatus(`NPC ID 已存在：${newType}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(gameNpcs)) {
      if (k === oldType) rebuilt[newType] = o; else rebuilt[k] = gameNpcs[k];
    }
    gameNpcs = rebuilt;
    selectedNpc = newType;
    renderNpcList();
  });
}
function newNpc() {
  let n = 1, type = 'npc1';
  while (gameNpcs[type]) { n++; type = 'npc' + n; }
  gameNpcs[type] = { name: '新NPC', desc: '', model: '', npcTag: 1, shopId: 0, level: 1, wanderRadius: 0, dialogue: '' };
  selectedNpc = type;
  renderNpcList(); renderNpcForm();
}
function deleteNpc() {
  if (!selectedNpc || !gameNpcs[selectedNpc]) { setStatus('请先选择要删除的 NPC'); return; }
  if (!confirm(`删除 NPC「${gameNpcs[selectedNpc].name}」(${selectedNpc})？`)) return;
  delete gameNpcs[selectedNpc];
  const keys = Object.keys(gameNpcs);
  selectedNpc = keys.length ? keys[0] : '';
  renderNpcList(); renderNpcForm();
}
async function saveNpcs() {
  for (const type of Object.keys(gameNpcs)) {
    if (!type) { setStatus('NPC ID 不能为空'); return false; }
  }
  try {
    const j = await authedPost('/api/npcs/edit', { token, npcs: gameNpcs });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ---- 任务配置 ----
const QUEST_CAT_NAMES = { main: '主线', side: '支线', daily: '日常', repeatable: '可重复' };
const QUEST_OBJ_TYPES = [
  { v: 'kill', n: '击杀' }, { v: 'collect', n: '收集' },
  { v: 'reach', n: '到达' }, { v: 'talk', n: '对话' }, { v: 'escort', n: '护送' },
];

async function loadQuestData() {
  try {
    const r = await fetch(BASE + '/api/quests');
    const jd = await r.json();
    if (jd && jd.ok && Array.isArray(jd.quests)) gameQuests = jd.quests;
  } catch (e) {}
  selectedQuest = gameQuests.length ? 0 : -1;
  renderQuestList(); renderQuestForm();
}

function renderQuestList() {
  $('quest-count-label').textContent = gameQuests.length;
  const box = $('quest-list'); box.innerHTML = '';
  if (!gameQuests.length) { box.innerHTML = '<div class="cfg-empty">暂无任务，点“新建”添加</div>'; return; }
  gameQuests.forEach((q, i) => {
    const div = document.createElement('div');
    div.className = 'cfg-item' + (i === selectedQuest ? ' sel' : '');
    const catName = QUEST_CAT_NAMES[q.category] || q.category;
    div.innerHTML = `<span class="cfg-ico">📜</span><span class="cfg-nm">${esc(q.name) || '(未命名)'}</span><span class="cfg-id">#${q.id} ${catName}</span>`;
    div.addEventListener('click', () => { selectedQuest = i; renderQuestList(); renderQuestForm(); });
    box.appendChild(div);
  });
}

function setQuestFormEnabled(on) {
  ['q-id','q-name','q-desc','q-category','q-levelReq','q-giverNpc','q-prereq','q-nextQuests','q-gold','q-exp','q-dailyCd'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ra = $('btn-q-reward-add'); if (ra) ra.disabled = !on;
  const oa = $('btn-q-obj-add'); if (oa) oa.disabled = !on;
}

function renderQuestForm() {
  const q = gameQuests[selectedQuest];
  if (!q) {
    $('quest-form').style.opacity = '0.4'; setQuestFormEnabled(false);
    $('q-reward-items').innerHTML = '<div class="cfg-empty">选择或新建任务</div>';
    $('q-objectives').innerHTML = '';
    $('q-obj-count').textContent = '0';
    return;
  }
  $('quest-form').style.opacity = '1'; setQuestFormEnabled(true);
  $('q-id').value = q.id || 0;
  $('q-name').value = q.name || '';
  $('q-desc').value = q.desc || '';
  $('q-category').value = q.category || 'side';
  $('q-levelReq').value = q.levelReq || 1;
  $('q-giverNpc').value = q.giverNpc || 0;
  $('q-prereq').value = (q.prereq || []).join(',');
  $('q-nextQuests').value = (q.nextQuests || []).join(',');
  $('q-gold').value = (q.rewards && q.rewards.gold) || 0;
  $('q-exp').value = (q.rewards && q.rewards.exp) || 0;
  $('q-dailyCd').value = q.dailyCd || 0;
  renderQuestRewardItems();
  renderQuestObjectives();
}

function bindQuestForm() {
  const q = () => gameQuests[selectedQuest];
  const num = (id, key, isInt) => {
    const el = $(id);
    el.addEventListener('input', () => { const o = q(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); if (key.includes('.')) { const [p, c] = key.split('.'); if (!o[p]) o[p] = {}; o[p][c] = isNaN(v) ? 0 : v; } else { o[key] = isNaN(v) ? 0 : v; } });
  };
  num('q-id', 'id', true);
  num('q-levelReq', 'levelReq', true);
  num('q-giverNpc', 'giverNpc', true);
  num('q-gold', 'rewards.gold', true);
  num('q-exp', 'rewards.exp', true);
  num('q-dailyCd', 'dailyCd', true);
  const nameEl = $('q-name');
  nameEl.addEventListener('input', () => { const o = q(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderQuestList());
  const descEl = $('q-desc');
  descEl.addEventListener('input', () => { const o = q(); if (!o) return; o.desc = descEl.value; });
  const catEl = $('q-category');
  catEl.addEventListener('change', () => { const o = q(); if (!o) return; o.category = catEl.value; renderQuestList(); });
  const prereqEl = $('q-prereq');
  prereqEl.addEventListener('input', () => { const o = q(); if (!o) return; o.prereq = prereqEl.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0); });
  const nextEl = $('q-nextQuests');
  nextEl.addEventListener('input', () => { const o = q(); if (!o) return; o.nextQuests = nextEl.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0); });
  // ID 变更
  $('q-id').addEventListener('change', () => renderQuestList());
}

function rewardItemOptionsHtml(selId) {
  let html = '<option value="0">（无）</option>';
  for (const o of gameItems) {
    const id = o.id | 0;
    html += `<option value="${id}"${id === selId ? ' selected' : ''}>#${id} ${esc(o.name)}</option>`;
  }
  return html;
}

function renderQuestRewardItems() {
  const q = gameQuests[selectedQuest];
  const box = $('q-reward-items'); box.innerHTML = '';
  if (!q) return;
  if (!q.rewards) q.rewards = {};
  if (!q.rewards.items) q.rewards.items = [];
  const items = q.rewards.items;
  if (!items.length) { box.innerHTML = '<div class="cfg-empty">无奖励物品，点“添加”</div>'; return; }
  items.forEach((ri, i) => {
    const row = document.createElement('div');
    row.className = 'drop-row';
    const sel = document.createElement('select');
    sel.innerHTML = rewardItemOptionsHtml(ri.id | 0);
    sel.addEventListener('change', () => { ri.id = parseInt(sel.value, 10) || 0; });
    const cnt = document.createElement('input');
    cnt.type = 'number'; cnt.min = '1'; cnt.step = '1';
    cnt.value = ri.count || 1;
    cnt.addEventListener('input', () => { ri.count = parseInt(cnt.value, 10) || 1; });
    const lbl = document.createElement('span'); lbl.className = 'drop-pct'; lbl.textContent = '个';
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { items.splice(i, 1); renderQuestRewardItems(); });
    row.appendChild(sel); row.appendChild(cnt); row.appendChild(lbl); row.appendChild(del);
    box.appendChild(row);
  });
}

function addQuestRewardItem() {
  const q = gameQuests[selectedQuest];
  if (!q) { setStatus('请先选择任务'); return; }
  if (!q.rewards) q.rewards = {};
  if (!q.rewards.items) q.rewards.items = [];
  q.rewards.items.push({ id: gameItems.length ? (gameItems[0].id | 0) : 0, count: 1 });
  renderQuestRewardItems();
}

function renderQuestObjectives() {
  const q = gameQuests[selectedQuest];
  const box = $('q-objectives'); box.innerHTML = '';
  if (!q) { $('q-obj-count').textContent = '0'; return; }
  if (!q.objectives) q.objectives = [];
  const objs = q.objectives;
  $('q-obj-count').textContent = objs.length;
  if (!objs.length) { box.innerHTML = '<div class="cfg-empty">无目标，点“添加目标”</div>'; return; }
  objs.forEach((o, i) => {
    const row = document.createElement('div');
    row.className = 'quest-obj-row';
    // 类型下拉
    const typeSel = document.createElement('select');
    typeSel.className = 'quest-obj-type';
    for (const t of QUEST_OBJ_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.v; opt.textContent = t.n;
      if (o.type === t.v) opt.selected = true;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener('change', () => { o.type = typeSel.value; });
    // targetKey
    const keyInput = document.createElement('input');
    keyInput.type = 'text'; keyInput.placeholder = 'key/ID';
    keyInput.value = o.targetKey || '';
    keyInput.addEventListener('input', () => { o.targetKey = keyInput.value; });
    // required
    const reqInput = document.createElement('input');
    reqInput.type = 'number'; reqInput.min = '1'; reqInput.step = '1';
    reqInput.value = o.required || 1;
    reqInput.addEventListener('input', () => { o.required = parseInt(reqInput.value, 10) || 1; });
    // desc
    const descInput = document.createElement('input');
    descInput.type = 'text'; descInput.placeholder = '描述';
    descInput.value = o.desc || '';
    descInput.addEventListener('input', () => { o.desc = descInput.value; });
    // 坐标（reach 类型用）
    const xInput = document.createElement('input');
    xInput.type = 'number'; xInput.placeholder = 'x'; xInput.step = '0.5';
    xInput.value = o.x || 0;
    xInput.addEventListener('input', () => { o.x = parseFloat(xInput.value) || 0; });
    const zInput = document.createElement('input');
    zInput.type = 'number'; zInput.placeholder = 'z'; zInput.step = '0.5';
    zInput.value = o.z || 0;
    zInput.addEventListener('input', () => { o.z = parseFloat(zInput.value) || 0; });
    // 删除按钮
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { objs.splice(i, 1); renderQuestObjectives(); });
    row.appendChild(typeSel); row.appendChild(keyInput); row.appendChild(reqInput);
    row.appendChild(descInput); row.appendChild(xInput); row.appendChild(zInput); row.appendChild(del);
    box.appendChild(row);
  });
}

function addQuestObjective() {
  const q = gameQuests[selectedQuest];
  if (!q) { setStatus('请先选择任务'); return; }
  if (!q.objectives) q.objectives = [];
  q.objectives.push({ type: 'kill', targetKey: '', required: 1, desc: '', x: 0, z: 0 });
  renderQuestObjectives();
}

function newQuest() {
  let maxId = 10000;
  for (const q of gameQuests) if ((q.id | 0) > maxId) maxId = q.id | 0;
  gameQuests.push({ id: maxId + 1, name: '新任务', desc: '', category: 'side', levelReq: 1, prereq: [], objectives: [], rewards: { gold: 0, exp: 0, items: [] }, dailyCd: 0, giverNpc: 0, nextQuests: [] });
  selectedQuest = gameQuests.length - 1;
  renderQuestList(); renderQuestForm();
}

function deleteQuest() {
  if (selectedQuest < 0 || selectedQuest >= gameQuests.length) { setStatus('请先选择要删除的任务'); return; }
  const q = gameQuests[selectedQuest];
  if (!confirm(`删除任务 #${q.id}「${q.name}」？`)) return;
  gameQuests.splice(selectedQuest, 1);
  selectedQuest = Math.min(selectedQuest, gameQuests.length - 1);
  renderQuestList(); renderQuestForm();
}

async function saveQuests() {
  for (const q of gameQuests) {
    if (!q.id || q.id <= 0) { setStatus('任务 ID 必须为正整数'); return false; }
  }
  try {
    const j = await authedPost('/api/quests/edit', { token, quests: gameQuests });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 经济配置面板（阶段7：强化/分解/合成/商店）
// 物品下拉选项复用上方 itemOptionsHtml(selId)（掉落子表同源）
// ============================================================================
// ---- 强化：全局 + 等级表 ----
function setEnhanceFormEnabled(on) {
  ['en-maxLevel','en-stoneItemId','en-protectStoneItemId','en-attrPerLevelAtk','en-attrPerLevelDef','en-attrPerLevelHp'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ab = $('btn-en-addlevel'); if (ab) ab.disabled = !on;
}
function renderEnhanceForm() {
  if (!gameEnhance) { setEnhanceFormEnabled(false); return; }
  setEnhanceFormEnabled(true);
  $('en-maxLevel').value = gameEnhance.maxLevel || 0;
  $('en-stoneItemId').value = gameEnhance.stoneItemId || 0;
  $('en-protectStoneItemId').value = gameEnhance.protectStoneItemId || 0;
  $('en-attrPerLevelAtk').value = gameEnhance.attrPerLevelAtk || 0;
  $('en-attrPerLevelDef').value = gameEnhance.attrPerLevelDef || 0;
  $('en-attrPerLevelHp').value = gameEnhance.attrPerLevelHp || 0;
  renderEnhanceLevels();
}
function renderEnhanceLevels() {
  const box = $('en-levels'); box.innerHTML = '';
  const levels = (gameEnhance && Array.isArray(gameEnhance.levels)) ? gameEnhance.levels : [];
  $('en-level-count').textContent = levels.length;
  if (!levels.length) { box.innerHTML = '<div class="cfg-empty">暂无等级，点“添加等级”</div>'; return; }
  levels.forEach((lv, i) => {
    const row = document.createElement('div');
    row.className = 'quest-obj-row';
    const mk = (label, key, step, isInt) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step; inp.placeholder = label; inp.title = label;
      inp.value = lv[key] != null ? lv[key] : 0;
      inp.addEventListener('input', () => { const v = isInt ? parseInt(inp.value, 10) : parseFloat(inp.value); lv[key] = isNaN(v) ? 0 : v; });
      return inp;
    };
    const tag = document.createElement('span'); tag.className = 'drop-pct'; tag.textContent = 'Lv' + (i + 1);
    const protect = document.createElement('input');
    protect.type = 'checkbox'; protect.title = '可用保护符防降'; protect.checked = !!lv.canProtect;
    protect.addEventListener('change', () => { lv.canProtect = protect.checked; });
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除该级';
    del.addEventListener('click', () => { levels.splice(i, 1); renderEnhanceLevels(); });
    row.appendChild(tag);
    row.appendChild(mk('成功率', 'successRate', '0.01', false));
    row.appendChild(mk('金币', 'goldCost', '1', true));
    row.appendChild(mk('石ID', 'stoneItemId', '1', true));
    row.appendChild(mk('石数', 'stoneCount', '1', true));
    row.appendChild(mk('降级', 'failDegrade', '1', true));
    row.appendChild(protect); row.appendChild(del);
    box.appendChild(row);
  });
}
function addEnhanceLevel() {
  if (!gameEnhance) return;
  if (!Array.isArray(gameEnhance.levels)) gameEnhance.levels = [];
  gameEnhance.levels.push({ level: gameEnhance.levels.length + 1, successRate: 1, goldCost: 0, stoneItemId: gameEnhance.stoneItemId || 4006, stoneCount: 1, failDegrade: 0, canProtect: false });
  gameEnhance.maxLevel = gameEnhance.levels.length;
  renderEnhanceForm();
}
function bindEnhanceForm() {
  const num = (id, key, isInt) => {
    const el = $(id); if (!el) return;
    el.addEventListener('input', () => { if (!gameEnhance) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); gameEnhance[key] = isNaN(v) ? 0 : v; });
  };
  num('en-maxLevel', 'maxLevel', true);
  num('en-stoneItemId', 'stoneItemId', true);
  num('en-protectStoneItemId', 'protectStoneItemId', true);
  num('en-attrPerLevelAtk', 'attrPerLevelAtk', false);
  num('en-attrPerLevelDef', 'attrPerLevelDef', false);
  num('en-attrPerLevelHp', 'attrPerLevelHp', false);
}
async function saveEnhance() {
  if (!gameEnhance || !Array.isArray(gameEnhance.levels) || !gameEnhance.levels.length) { setStatus('强化等级表不能为空'); return false; }
  try {
    const j = await authedPost('/api/enhance/edit', { token, enhance: gameEnhance });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ---- 分解：全局 + 品质规则 ----
const RARITY_NAMES = ['普通', '优秀', '稀有', '史诗', '传说'];
function renderDecomposeForm() {
  if (!gameDecompose) { $('de-stoneItemId').disabled = true; $('btn-de-addrule').disabled = true; return; }
  $('de-stoneItemId').disabled = false; $('btn-de-addrule').disabled = false;
  $('de-stoneItemId').value = gameDecompose.stoneItemId || 0;
  renderDecomposeRules();
}
function renderDecomposeRules() {
  const box = $('de-rules'); box.innerHTML = '';
  const rules = (gameDecompose && Array.isArray(gameDecompose.rules)) ? gameDecompose.rules : [];
  $('de-rule-count').textContent = rules.length;
  if (!rules.length) { box.innerHTML = '<div class="cfg-empty">暂无规则，点“添加品质档”</div>'; return; }
  rules.forEach((r, i) => {
    if (!Array.isArray(r.results)) r.results = [];
    const wrap = document.createElement('div'); wrap.className = 'de-rule';
    const head = document.createElement('div'); head.className = 'quest-obj-row';
    const rar = document.createElement('select'); rar.className = 'quest-obj-type'; rar.title = '品质';
    for (let k = 0; k < RARITY_NAMES.length; k++) {
      const opt = document.createElement('option'); opt.value = String(k); opt.textContent = k + RARITY_NAMES[k];
      if ((r.rarity | 0) === k) opt.selected = true;
      rar.appendChild(opt);
    }
    rar.addEventListener('change', () => { r.rarity = parseInt(rar.value, 10) || 0; });
    const goldRate = document.createElement('input');
    goldRate.type = 'number'; goldRate.step = '0.01'; goldRate.title = '金币返还率'; goldRate.placeholder = '金币率';
    goldRate.value = r.goldReturnRate != null ? r.goldReturnRate : 0.3;
    goldRate.addEventListener('input', () => { const v = parseFloat(goldRate.value); r.goldReturnRate = isNaN(v) ? 0 : v; });
    const stoneRate = document.createElement('input');
    stoneRate.type = 'number'; stoneRate.step = '0.01'; stoneRate.title = '强化石返还系数'; stoneRate.placeholder = '石系数';
    stoneRate.value = r.enhanceStoneRate != null ? r.enhanceStoneRate : 0.5;
    stoneRate.addEventListener('input', () => { const v = parseFloat(stoneRate.value); r.enhanceStoneRate = isNaN(v) ? 0 : v; });
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除该档';
    del.addEventListener('click', () => { rules.splice(i, 1); renderDecomposeRules(); });
    head.appendChild(rar); head.appendChild(goldRate); head.appendChild(stoneRate); head.appendChild(del);
    wrap.appendChild(head);
    r.results.forEach((res, ri) => {
      const mrow = document.createElement('div'); mrow.className = 'drop-row';
      const sel = document.createElement('select');
      sel.innerHTML = itemOptionsHtml(res.itemId | 0);
      sel.addEventListener('change', () => { res.itemId = parseInt(sel.value, 10) || 0; });
      const minC = document.createElement('input');
      minC.type = 'number'; minC.min = '1'; minC.step = '1'; minC.title = '最小数量'; minC.value = res.minCount || 1;
      minC.addEventListener('input', () => { res.minCount = parseInt(minC.value, 10) || 1; });
      const maxC = document.createElement('input');
      maxC.type = 'number'; maxC.min = '1'; maxC.step = '1'; maxC.title = '最大数量'; maxC.value = res.maxCount || 1;
      maxC.addEventListener('input', () => { res.maxCount = parseInt(maxC.value, 10) || 1; });
      const prob = document.createElement('input');
      prob.type = 'number'; prob.min = '0'; prob.max = '1'; prob.step = '0.01'; prob.title = '概率 0-1'; prob.value = res.prob != null ? res.prob : 1;
      prob.addEventListener('input', () => { const v = parseFloat(prob.value); res.prob = isNaN(v) ? 0 : v; });
      const mdel = document.createElement('button');
      mdel.className = 'sp-del'; mdel.textContent = '✕'; mdel.title = '删除材料';
      mdel.addEventListener('click', () => { r.results.splice(ri, 1); renderDecomposeRules(); });
      mrow.appendChild(sel); mrow.appendChild(minC); mrow.appendChild(maxC); mrow.appendChild(prob); mrow.appendChild(mdel);
      wrap.appendChild(mrow);
    });
    const madd = document.createElement('button');
    madd.className = 'btn btn-ghost de-mat-add'; madd.textContent = '＋ 材料';
    madd.addEventListener('click', () => { r.results.push({ itemId: gameItems.length ? (gameItems[0].id | 0) : 0, minCount: 1, maxCount: 1, prob: 1 }); renderDecomposeRules(); });
    wrap.appendChild(madd);
    box.appendChild(wrap);
  });
}
function addDecomposeRule() {
  if (!gameDecompose) return;
  if (!Array.isArray(gameDecompose.rules)) gameDecompose.rules = [];
  gameDecompose.rules.push({ rarity: gameDecompose.rules.length, goldReturnRate: 0.3, enhanceStoneRate: 0.5, results: [] });
  renderDecomposeRules();
}
function bindDecomposeForm() {
  const el = $('de-stoneItemId'); if (!el) return;
  el.addEventListener('input', () => { if (!gameDecompose) return; const v = parseInt(el.value, 10); gameDecompose.stoneItemId = isNaN(v) ? 0 : v; });
}
async function saveDecompose() {
  if (!gameDecompose || !Array.isArray(gameDecompose.rules) || !gameDecompose.rules.length) { setStatus('分解规则不能为空'); return false; }
  try {
    const j = await authedPost('/api/decompose/edit', { token, decompose: gameDecompose });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ---- 合成：配方列表 + 表单 + 材料子表 ----
function renderCraftList() {
  $('craft-count-label').textContent = gameCraft.length;
  const box = $('craft-list'); box.innerHTML = '';
  if (!gameCraft.length) { box.innerHTML = '<div class="cfg-empty">暂无配方，点“新建”添加</div>'; return; }
  gameCraft.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'cfg-item' + (i === selectedCraft ? ' sel' : '');
    const hidden = r.hidden ? ' 🔒' : '';
    div.innerHTML = `<span class="cfg-ico">⚗</span><span class="cfg-nm">${esc(r.name) || '(未命名)'}</span><span class="cfg-id">#${r.recipeId}${hidden}</span>`;
    div.addEventListener('click', () => { selectedCraft = i; renderCraftList(); renderCraftForm(); });
    box.appendChild(div);
  });
}
function setCraftFormEnabled(on) {
  ['cf-recipeId','cf-levelReq','cf-name','cf-npcTag','cf-resultItemId','cf-resultCount','cf-goldCost','cf-hidden'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ma = $('btn-cf-mat-add'); if (ma) ma.disabled = !on;
}
function renderCraftForm() {
  const r = gameCraft[selectedCraft];
  if (!r) {
    $('craft-form').style.opacity = '0.4'; setCraftFormEnabled(false);
    $('cf-materials').innerHTML = '<div class="cfg-empty">选择或新建配方</div>'; $('cf-mat-count').textContent = '0';
    return;
  }
  $('craft-form').style.opacity = '1'; setCraftFormEnabled(true);
  $('cf-recipeId').value = r.recipeId || 0;
  $('cf-levelReq').value = r.levelReq || 1;
  $('cf-name').value = r.name || '';
  $('cf-npcTag').value = r.npcTag != null ? r.npcTag : 64;
  $('cf-resultItemId').innerHTML = itemOptionsHtml(r.resultItemId | 0);
  $('cf-resultCount').value = r.resultCount || 1;
  $('cf-goldCost').value = r.goldCost || 0;
  $('cf-hidden').checked = !!r.hidden;
  renderCraftMaterials();
}
function renderCraftMaterials() {
  const r = gameCraft[selectedCraft];
  const box = $('cf-materials'); box.innerHTML = '';
  if (!r) return;
  if (!Array.isArray(r.materials)) r.materials = [];
  const mats = r.materials;
  $('cf-mat-count').textContent = mats.length;
  if (!mats.length) { box.innerHTML = '<div class="cfg-empty">无材料，点“添加材料”</div>'; return; }
  mats.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'drop-row';
    const sel = document.createElement('select');
    sel.innerHTML = itemOptionsHtml(m.itemId | 0);
    sel.addEventListener('change', () => { m.itemId = parseInt(sel.value, 10) || 0; });
    const cnt = document.createElement('input');
    cnt.type = 'number'; cnt.min = '1'; cnt.step = '1'; cnt.value = m.count || 1;
    cnt.addEventListener('input', () => { m.count = parseInt(cnt.value, 10) || 1; });
    const lbl = document.createElement('span'); lbl.className = 'drop-pct'; lbl.textContent = '个';
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { mats.splice(i, 1); renderCraftMaterials(); });
    row.appendChild(sel); row.appendChild(cnt); row.appendChild(lbl); row.appendChild(del);
    box.appendChild(row);
  });
}
function addCraftMaterial() {
  const r = gameCraft[selectedCraft];
  if (!r) { setStatus('请先选择配方'); return; }
  if (!Array.isArray(r.materials)) r.materials = [];
  r.materials.push({ itemId: gameItems.length ? (gameItems[0].id | 0) : 0, count: 1 });
  renderCraftMaterials();
}
function bindCraftForm() {
  const r = () => gameCraft[selectedCraft];
  const num = (id, key, isInt) => {
    const el = $(id); if (!el) return;
    el.addEventListener('input', () => { const o = r(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); o[key] = isNaN(v) ? 0 : v; });
  };
  num('cf-recipeId', 'recipeId', true);
  num('cf-levelReq', 'levelReq', true);
  num('cf-npcTag', 'npcTag', true);
  num('cf-resultCount', 'resultCount', true);
  num('cf-goldCost', 'goldCost', true);
  const nameEl = $('cf-name');
  nameEl.addEventListener('input', () => { const o = r(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderCraftList());
  const resEl = $('cf-resultItemId');
  resEl.addEventListener('change', () => { const o = r(); if (!o) return; o.resultItemId = parseInt(resEl.value, 10) || 0; });
  const hidEl = $('cf-hidden');
  hidEl.addEventListener('change', () => { const o = r(); if (!o) return; o.hidden = hidEl.checked; renderCraftList(); });
  $('cf-recipeId').addEventListener('change', () => renderCraftList());
}
function newCraft() {
  let maxId = 0;
  for (const r of gameCraft) if ((r.recipeId | 0) > maxId) maxId = r.recipeId | 0;
  gameCraft.push({ recipeId: maxId + 1, name: '新配方', npcTag: 64, resultItemId: gameItems.length ? (gameItems[0].id | 0) : 0, resultCount: 1, goldCost: 0, levelReq: 1, hidden: false, materials: [] });
  selectedCraft = gameCraft.length - 1;
  renderCraftList(); renderCraftForm();
}
function deleteCraft() {
  if (selectedCraft < 0 || selectedCraft >= gameCraft.length) { setStatus('请先选择要删除的配方'); return; }
  const r = gameCraft[selectedCraft];
  if (!confirm(`删除配方 #${r.recipeId}「${r.name}」？`)) return;
  gameCraft.splice(selectedCraft, 1);
  selectedCraft = Math.min(selectedCraft, gameCraft.length - 1);
  renderCraftList(); renderCraftForm();
}
async function saveCraft() {
  const seen = new Set();
  for (const r of gameCraft) {
    if (!r.recipeId || r.recipeId <= 0) { setStatus('配方 ID 必须为正整数'); return false; }
    if (seen.has(r.recipeId)) { setStatus(`配方 ID 重复：#${r.recipeId}`); return false; }
    seen.add(r.recipeId);
    if (!r.resultItemId) { setStatus(`配方 #${r.recipeId} 未设置产物`); return false; }
  }
  try {
    const j = await authedPost('/api/craft/edit', { token, craft: { recipes: gameCraft } });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ---- 商店：列表 + 表单 + 条目子表 ----
const SHOP_CATS = ['自动', '装备', '消耗品', '材料', '特殊'];
const SHOP_REFRESH = ['不刷新', '每日', '每周'];
function renderShopList() {
  const keys = Object.keys(gameShops);
  $('shop-count-label').textContent = keys.length;
  const box = $('shop-list'); box.innerHTML = '';
  if (!keys.length) { box.innerHTML = '<div class="cfg-empty">暂无商店，点“新建”添加</div>'; return; }
  keys.forEach((sid) => {
    const s = gameShops[sid];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (sid === selectedShop ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🛒</span><span class="cfg-nm">${esc(s.name) || '(未命名)'}</span><span class="cfg-id">#${sid} · ${(s.entries || []).length}件</span>`;
    div.addEventListener('click', () => { selectedShop = sid; renderShopList(); renderShopForm(); });
    box.appendChild(div);
  });
}
function setShopFormEnabled(on) {
  ['sh-shopId','sh-name','sh-desc','sh-shopType','sh-currencyItemId'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ea = $('btn-sh-entry-add'); if (ea) ea.disabled = !on;
}
function renderShopForm() {
  const s = gameShops[selectedShop];
  if (!s) {
    $('shop-form').style.opacity = '0.4'; setShopFormEnabled(false);
    $('sh-entries').innerHTML = '<div class="cfg-empty">选择或新建商店</div>'; $('sh-entry-count').textContent = '0';
    return;
  }
  $('shop-form').style.opacity = '1'; setShopFormEnabled(true);
  $('sh-shopId').value = selectedShop;
  $('sh-name').value = s.name || '';
  $('sh-desc').value = s.desc || '';
  $('sh-shopType').value = String(s.shopType || 0);
  $('sh-currencyItemId').value = s.currencyItemId || 0;
  renderShopEntries();
}
function renderShopEntries() {
  const s = gameShops[selectedShop];
  const box = $('sh-entries'); box.innerHTML = '';
  if (!s) return;
  if (!Array.isArray(s.entries)) s.entries = [];
  const entries = s.entries;
  $('sh-entry-count').textContent = entries.length;
  if (!entries.length) { box.innerHTML = '<div class="cfg-empty">无商品，点“添加商品”</div>'; return; }
  entries.forEach((e, i) => {
    const wrap = document.createElement('div'); wrap.className = 'de-rule';
    const r1 = document.createElement('div'); r1.className = 'drop-row';
    const sel = document.createElement('select');
    sel.innerHTML = itemOptionsHtml(e.item | 0);
    sel.addEventListener('change', () => { e.item = parseInt(sel.value, 10) || 0; });
    const price = document.createElement('input');
    price.type = 'number'; price.min = '0'; price.step = '1'; price.title = '原价'; price.placeholder = '原价'; price.value = e.price || 0;
    price.addEventListener('input', () => { e.price = parseInt(price.value, 10) || 0; });
    const disc = document.createElement('input');
    disc.type = 'number'; disc.min = '0'; disc.step = '1'; disc.title = '折扣价(0=无)'; disc.placeholder = '折扣'; disc.value = e.discountPrice || 0;
    disc.addEventListener('input', () => { e.discountPrice = parseInt(disc.value, 10) || 0; });
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除商品';
    del.addEventListener('click', () => { entries.splice(i, 1); renderShopEntries(); renderShopList(); });
    r1.appendChild(sel); r1.appendChild(price); r1.appendChild(disc); r1.appendChild(del);
    wrap.appendChild(r1);
    const r2 = document.createElement('div'); r2.className = 'drop-row';
    const stock = document.createElement('input');
    stock.type = 'number'; stock.min = '0'; stock.step = '1'; stock.title = '库存(0=无限)'; stock.placeholder = '库存'; stock.value = e.stock || 0;
    stock.addEventListener('input', () => { e.stock = parseInt(stock.value, 10) || 0; });
    const limit = document.createElement('input');
    limit.type = 'number'; limit.min = '0'; limit.step = '1'; limit.title = '限购(0=不限)'; limit.placeholder = '限购'; limit.value = e.buyLimit || 0;
    limit.addEventListener('input', () => { e.buyLimit = parseInt(limit.value, 10) || 0; });
    const cat = document.createElement('select'); cat.title = '分类';
    SHOP_CATS.forEach((n, k) => { const opt = document.createElement('option'); opt.value = String(k); opt.textContent = n; if ((e.category | 0) === k) opt.selected = true; cat.appendChild(opt); });
    cat.addEventListener('change', () => { e.category = parseInt(cat.value, 10) || 0; });
    const ref = document.createElement('select'); ref.title = '刷新';
    SHOP_REFRESH.forEach((n, k) => { const opt = document.createElement('option'); opt.value = String(k); opt.textContent = n; if ((e.refreshType | 0) === k) opt.selected = true; ref.appendChild(opt); });
    ref.addEventListener('change', () => { e.refreshType = parseInt(ref.value, 10) || 0; });
    const sell = document.createElement('input');
    sell.type = 'number'; sell.min = '0'; sell.step = '1'; sell.title = '回收价(0=默认率)'; sell.placeholder = '回收'; sell.value = e.sellPrice || 0;
    sell.addEventListener('input', () => { e.sellPrice = parseInt(sell.value, 10) || 0; });
    r2.appendChild(stock); r2.appendChild(limit); r2.appendChild(cat); r2.appendChild(ref); r2.appendChild(sell);
    wrap.appendChild(r2);
    box.appendChild(wrap);
  });
}
function addShopEntry() {
  const s = gameShops[selectedShop];
  if (!s) { setStatus('请先选择商店'); return; }
  if (!Array.isArray(s.entries)) s.entries = [];
  s.entries.push({ item: gameItems.length ? (gameItems[0].id | 0) : 0, price: 0, discountPrice: 0, stock: 0, buyLimit: 0, category: 0, refreshType: 0, sellPrice: 0 });
  renderShopEntries(); renderShopList();
}
function bindShopForm() {
  const s = () => gameShops[selectedShop];
  const nameEl = $('sh-name');
  nameEl.addEventListener('input', () => { const o = s(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderShopList());
  const descEl = $('sh-desc');
  descEl.addEventListener('input', () => { const o = s(); if (!o) return; o.desc = descEl.value; });
  const typeEl = $('sh-shopType');
  typeEl.addEventListener('change', () => { const o = s(); if (!o) return; o.shopType = parseInt(typeEl.value, 10) || 0; });
  const curEl = $('sh-currencyItemId');
  curEl.addEventListener('input', () => { const o = s(); if (!o) return; const v = parseInt(curEl.value, 10); o.currencyItemId = isNaN(v) ? 0 : v; });
  const idEl = $('sh-shopId');
  idEl.addEventListener('change', () => {
    const oldId = selectedShop;
    const o = gameShops[oldId]; if (!o) return;
    const nid = parseInt(idEl.value, 10) || 0;
    if (nid <= 0) { idEl.value = oldId; setStatus('商店 ID 必须为正整数'); return; }
    const newId = String(nid);
    if (newId === oldId) return;
    if (gameShops[newId]) { idEl.value = oldId; setStatus(`商店 ID 已存在：${newId}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(gameShops)) { if (k === oldId) rebuilt[newId] = o; else rebuilt[k] = gameShops[k]; }
    gameShops = rebuilt;
    selectedShop = newId;
    renderShopList();
  });
}
function newShop() {
  let maxId = 0;
  for (const k of Object.keys(gameShops)) { const v = parseInt(k, 10) || 0; if (v > maxId) maxId = v; }
  const sid = String(maxId + 1);
  gameShops[sid] = { name: '新商店', desc: '', shopType: 0, currencyItemId: 0, entries: [] };
  selectedShop = sid;
  renderShopList(); renderShopForm();
}
function deleteShop() {
  if (!selectedShop || !gameShops[selectedShop]) { setStatus('请先选择要删除的商店'); return; }
  if (!confirm(`删除商店「${gameShops[selectedShop].name}」(#${selectedShop})？`)) return;
  delete gameShops[selectedShop];
  const keys = Object.keys(gameShops);
  selectedShop = keys.length ? keys[0] : '';
  renderShopList(); renderShopForm();
}
async function saveShops() {
  for (const sid of Object.keys(gameShops)) {
    if (!sid || (parseInt(sid, 10) || 0) <= 0) { setStatus('商店 ID 必须为正整数'); return false; }
  }
  try {
    const j = await authedPost('/api/shop/edit', { token, shops: gameShops });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 登录 / 会话
// ============================================================================
async function enterEditor(j) {
  // resume=true：会话过期后重新登录。此时编辑器已初始化完成，仅换发新令牌，
  // 保留未保存的地形/出生点/物品/生物修改，避免重登导致工作丢失。
  const resume = running;
  token = j.token;
  username = j.user.username;
  saveSession(token, username);
  hideLogin();
  $('editor-user-name').textContent = username;
  if (resume) {
    setStatus(`已重新登录（${username}），之前未保存的修改仍在，可继续保存。`);
    return;
  }
  $('editor-app').classList.remove('hidden');

  // 加载服务器可通行 mask（世界初始化产物）——必须在创建渲染器前安装，
  // 否则未加载时全图视为空洞，编辑器将渲染为一片白色。
  try {
    const r = await fetch(BASE + '/api/terrain/mask');
    const jd = await r.json();
    if (jd && jd.ok) loadWalkMask(jd);
  } catch (e) {}

  // 初始化 WebGL 渲染器
  tr = new WebGLRenderer($('editor-canvas-wrap'), { editorMode: true });
  tr.setGridVisible(true);
  tr.setCameraFree(0, 0, 1);
  setupEditorEvents();

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
  // 加载任务配置
  await loadQuestData();

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

// 会话失效（服务端重启 / 令牌过期）：回到登录界面重新取令牌。
// 编辑器已加载的修改全部保留在内存中，重登后可直接继续保存。
function requireRelogin(reason) {
  clearSession();
  token = '';
  showLogin(reason || '会话已过期，请重新登录（未保存的修改已保留）');
}
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
  showLogin('已退出登录');
});

// ============================================================================
// 初始化
// ============================================================================
window.addEventListener('resize', () => { if (tr) tr.resize(); });
try { bindTools(); } catch (e) { console.error('[editor] bindTools 异常:', e); }
refreshButtons();
// 初始化共享登录模态框（动态创建 DOM + 会话检查）
initLogin({
  subtitle: '世界编辑器 · 地形画刷 + 生物出生点编辑',
  hint: '浅灰=可通行 · 白色=空洞(不可通行)<br/>地图为「路径地图」：主干道走廊 + 分支 + 随机空地',
  showRegister: false,
  onLoggedIn: async (tok, user) => {
    await enterEditor({ token: tok, user: { username: user } });
  },
});
