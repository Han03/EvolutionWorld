/**
 * editor.js - EvolutionWorld 世界编辑器（主编排文件）
 * 导入子模块并注入依赖，保留事件绑定、模式切换、登录与初始化。
 *
 * 子模块：
 *  - editor-state.js    共享状态 + 工具函数
 *  - editor-terrain.js  地形画刷 + 撤销重做 + 地形保存
 *  - editor-entities.js 出生点 + 物品 + 生物 + NPC + 任务
 *  - editor-economy.js  强化 + 分解 + 合成 + 商店
 */
import { WebGLRenderer } from './canvas-renderer.js';
import { saveSession, clearSession, logoutSession } from './session.js';
import { initLogin, hideLogin, showLogin } from './login.js';

// ---- 共享状态 ----
import { S, BASE, MODE_TIP, esc, saveFailText, openNewModal, reindexCollapsedSet, initCollapsedAll } from './editor-state.js';

// ---- 子模块 ----
import {
  configure as configureTerrain,
  pushHistory, undo, redo, refreshUndoButtons,
  updateLegend, frame, applyBrushAt, saveTerrain,
  terrainHeight, terrainBlocked, editCellCount, clearEdit, loadEditCells, loadWalkMask,
} from './editor-terrain.js';

import {
  configure as configureEntities,
  findSpawnAt, addSpawn, removeSpawn, renderSpawnList, centerOnSelected, openPlaceSpawnModal, saveSpawns,
  itemOptionsHtml, buildIconPresets, renderItemList, renderItemForm, bindItemForm, newItem, deleteItem, saveItems,
  updateItemConditional,
  renderCreatureList, renderCreatureForm, bindCreatureForm, addDrop, newCreature, deleteCreature, saveCreatures,
  renderNpcList, renderNpcForm, bindNpcForm, newNpc, deleteNpc, saveNpcs, updateNpcTagConfig,
  renderQuestList, renderQuestForm, bindQuestForm, newQuest, deleteQuest, saveQuests,
  addQuestRewardItem, addQuestObjective,
  renderSkillList, renderSkillForm, bindSkillForm, newSkill, deleteSkill, saveSkills,
  loadGameData, loadQuestData,
} from './editor-entities.js';

import {
  configure as configureEconomy,
  renderEnhanceForm, renderEnhanceLevels, bindEnhanceForm, addEnhanceLevel, saveEnhance,
  renderDecomposeForm, renderDecomposeRules, bindDecomposeForm, addDecomposeRule, saveDecompose,
  renderCraftList, renderCraftForm, renderCraftMaterials, bindCraftForm, newCraft, deleteCraft, addCraftMaterial, saveCraft,
  renderShopList, renderShopForm, renderShopEntries, bindShopForm, newShop, deleteShop, addShopEntry, saveShops,
} from './editor-economy.js';

// ============================================================================
// 本地工具
// ============================================================================
const $ = (id) => document.getElementById(id);

function setStatus(text) { $('editor-status').textContent = text; }

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

// ---- 出生点列表高度动态计算 ----
function recalcSpawnListHeight() {
  const el = $('spawn-list');
  const group = el ? el.closest('.spawn-list-group') : null;
  if (!group || S.mode !== 'terrain') return;
  const rect = group.getBoundingClientRect();
  const available = window.innerHeight - rect.top - 12;
  group.style.minHeight = Math.max(400, available) + 'px';
}

// ============================================================================
// 配置子模块（注入依赖）
// ============================================================================
const terrainDeps = { $, authedPost, refreshButtons: refreshUndoButtons };

// 经济模块的渲染函数需要被实体模块的 loadGameData 调用，
// 用箭头函数包装，确保 configure 赋值后调用的是正确引用
const entitiesDeps = {
  $, authedPost, setStatus,
  renderCreatureList, renderCreatureForm,
  renderNpcList, renderNpcForm,
  renderQuestList, renderQuestForm,
  renderItemList, renderItemForm,
  renderEnhanceForm: () => renderEnhanceForm(),
  renderDecomposeForm: () => renderDecomposeForm(),
  renderCraftList: () => renderCraftList(),
  renderCraftForm: () => renderCraftForm(),
  renderShopList: () => renderShopList(),
  renderShopForm: () => renderShopForm(),
  recalcSpawnListHeight,
};

const economyDeps = { $, authedPost, setStatus, itemOptionsHtml };

configureTerrain(terrainDeps);
configureEntities(entitiesDeps);
configureEconomy(economyDeps);

// ============================================================================
// 输入事件
// ============================================================================
function onMouseMove(ev) {
  const rect = S.tr.canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const w = S.tr.s2w(px, py);
  S.hoverWorld.x = w.x; S.hoverWorld.z = w.z; S.hoverWorld.in = true;
  const h = terrainHeight(w.x, w.z);
  const blocked = terrainBlocked(w.x, w.z);
  $('editor-coord').textContent =
    `x:${Math.floor(w.x)} z:${Math.floor(w.z)} h:${h.toFixed(1)} ${blocked ? '■空洞' : '·可通行'} ·编辑格:${editCellCount()} ·出生点:${S.spawns.length}`;
  if (S.panning) {
    const screenDx = ev.clientX - S.lastPan.x;
    const screenDy = ev.clientY - S.lastPan.y;
    const worldPerPx = 20 / (S.tr.cam.zoom * (S.tr.canvas.clientHeight || 1));
    S.tr.pan(-screenDx * worldPerPx, -screenDy * worldPerPx);
    S.lastPan = { x: ev.clientX, y: ev.clientY };
    return;
  }
  if (S.dragSpawn && S.mode === 'terrain' && S.brush.type === 'select') {
    const sp = S.spawns[S.dragSpawn.index];
    sp.x = Math.round((w.x - S.dragSpawn.offX) * 2) / 2;
    sp.z = Math.round((w.z - S.dragSpawn.offZ) * 2) / 2;
    S.spawnsDirty = true;
    renderSpawnList();
    return;
  }
  if (S.mode === 'terrain' && S.editing && !['select', 'place'].includes(S.brush.type)) {
    applyBrushAt(w.x, w.z, false);
  }
}

function setupEditorEvents() {
  const canvas = S.tr.canvas;
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', (ev) => {
    if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/i.test(document.activeElement.tagName)) {
      document.activeElement.blur();
    }
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.button === 2) { S.panning = true; S.lastPan = { x: ev.clientX, y: ev.clientY }; return; }
    if (ev.button !== 0) return;
    const w = S.tr.s2w(px, py);
    if (S.mode === 'terrain') {
      if (S.brush.type === 'select') {
        const idx = findSpawnAt(px, py);
        if (idx >= 0) {
          S.selectedSpawn = idx;
          S.dragSpawn = { index: idx, offX: w.x - S.spawns[idx].x, offZ: w.z - S.spawns[idx].z };
          renderSpawnList();
          return;
        }
        S.selectedSpawn = -1;
        renderSpawnList();
      } else if (S.brush.type === 'place') {
        openPlaceSpawnModal(w.x, w.z);
      } else {
        applyBrushAt(w.x, w.z, true); S.editing = true;
      }
    }
  });
  window.addEventListener('mouseup', () => { S.editing = false; S.panning = false; S.dragSpawn = null; });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('mouseleave', () => { S.hoverWorld.in = false; });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    S.tr.zoomAt(k);
  }, { passive: false });
}

// ---- WASD 平移 ----
function panKey(ts) {
  if (!S.running || !S.tr) return;
  const dt = S.lastPanTs ? (ts - S.lastPanTs) : 16.667;
  S.lastPanTs = ts;
  const dtScale = Math.max(0, Math.min(3, dt / 16.667));
  const speed = (S.panSpeed / S.tr.cam.zoom) * dtScale * 0.2;
  let dx = 0, dz = 0;
  if (S.keys.w || S.keys.arrowup) dz -= speed;
  if (S.keys.s || S.keys.arrowdown) dz += speed;
  if (S.keys.a || S.keys.arrowleft) dx -= speed;
  if (S.keys.d || S.keys.arrowright) dx += speed;
  if (dx || dz) S.tr.pan(dx, dz);
}
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|SELECT|TEXTAREA)$/i.test(tag)) return;
  if (!e.key) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    S.keys[k] = true;
    e.preventDefault();
  }
  if (e.key === 'Delete' && S.mode === 'terrain' && S.brush.type === 'select' && S.selectedSpawn >= 0) {
    e.preventDefault();
    removeSpawn(S.selectedSpawn);
  }
});
window.addEventListener('keyup', (e) => { if (e.key) S.keys[e.key.toLowerCase()] = false; });

// ============================================================================
// 模式切换
// ============================================================================
function setMode(m) {
  S.mode = m;
  $('panel-terrain').classList.toggle('hidden', S.mode !== 'terrain');
  $('panel-item').classList.toggle('hidden', S.mode !== 'item');
  $('panel-creature').classList.toggle('hidden', S.mode !== 'creature');
  $('panel-npc').classList.toggle('hidden', S.mode !== 'npc');
  $('panel-quest').classList.toggle('hidden', S.mode !== 'quest');
  $('panel-enhance').classList.toggle('hidden', S.mode !== 'enhance');
  $('panel-decompose').classList.toggle('hidden', S.mode !== 'decompose');
  $('panel-craft').classList.toggle('hidden', S.mode !== 'craft');
  $('panel-shop').classList.toggle('hidden', S.mode !== 'shop');
  $('panel-skill').classList.toggle('hidden', S.mode !== 'skill');
  $('mode-tip').textContent = MODE_TIP[S.mode] || '';
  const terrainOnly = S.mode === 'terrain';
  $('btn-reset').disabled = !terrainOnly;
  if (terrainOnly) refreshUndoButtons();
  else { $('btn-undo').disabled = true; $('btn-redo').disabled = true; }
  if (S.mode === 'terrain') {
    setStatus(`地形+出生点（${S.spawns.length} 个）· WASD 平移 · 滚轮缩放 · 画刷类型切换操作`);
    recalcSpawnListHeight();
  }
  else if (S.mode === 'item') setStatus(`物品配置（${S.gameItems.length} 件）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'creature') setStatus(`生物配置（${Object.keys(S.gameCreatures).length} 种）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'npc') setStatus(`NPC 配置（${Object.keys(S.gameNpcs).length} 种）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'quest') setStatus(`任务配置（${S.gameQuests.length} 个）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'enhance') setStatus(`强化配置（${(S.gameEnhance && S.gameEnhance.levels ? S.gameEnhance.levels.length : 0)} 级）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'decompose') setStatus(`分解配置（${(S.gameDecompose && S.gameDecompose.rules ? S.gameDecompose.rules.length : 0)} 档）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'craft') setStatus(`合成配置（${S.gameCraft.length} 条配方）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'shop') setStatus(`商店配置（${Object.keys(S.gameShops).length} 个）· 编辑后点"保存到服务器"`);
  else if (S.mode === 'skill') setStatus(`技能配置（${S.gameSkills.length} 个）· 编辑后点"保存到服务器"`);
  else setStatus(`生物配置（${Object.keys(S.gameCreatures).length} 种）· 编辑后点"保存到服务器"`);
}

// ============================================================================
// 工具栏绑定
// ============================================================================
function bindTools() {
  document.getElementById('mode-select').addEventListener('change', (e) => {
    setMode(e.target.value);
  });
  document.querySelectorAll('input[name="brush"]').forEach((el) => {
    el.addEventListener('change', () => {
      S.brush.type = el.value;
      if (!['select'].includes(S.brush.type)) { S.selectedSpawn = -1; renderSpawnList(); }
    });
  });
  const radius = $('brush-radius'), strength = $('brush-strength');
  radius.addEventListener('input', () => { S.brush.radius = parseFloat(radius.value); $('brush-radius-v').textContent = S.brush.radius + 'm'; });
  strength.addEventListener('input', () => { S.brush.strength = parseFloat(strength.value); $('brush-strength-v').textContent = S.brush.strength; });
  $('brush-falloff').addEventListener('change', (e) => { S.brush.falloff = e.target.value; });
  $('brush-target').addEventListener('input', (e) => { S.brush.targetH = parseFloat(e.target.value) || 0; });
  $('show-height').addEventListener('change', (e) => {
    S.showHeight = e.target.checked;
    S.tr.heightColorMode = S.showHeight;
    updateLegend();
  });
  $('spawn-search').addEventListener('input', (e) => {
    S.spawnSearchText = e.target.value.trim().toLowerCase();
    renderSpawnList();
  });

  // 撤销/重做/重置
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('清除全部地形编辑，还原为程序化地形？此操作会覆盖服务器上的编辑层。')) return;
    clearEdit();
    await saveTerrain();
    S.tr.invalidateTerrain();
  });
  // 世界初始化
  const wiBtn = $('btn-worldinit');
  if (wiBtn) {
    wiBtn.addEventListener('click', async () => {
      console.log('[editor] 世界初始化按钮被点击');
      try {
        if (!confirm('重新执行世界初始化？\n将重新生成连通地形、主城与生物投放，并覆盖当前世界数据。此操作不可撤销。')) return;
        setStatus('正在重新初始化世界…');
        wiBtn.disabled = true;
        const j = await authedPost('/api/world/reinit', { token: S.token });
        console.log('[editor] /api/world/reinit 响应:', j ? JSON.stringify(j).slice(0, 200) : 'null');
        if (j && j.ok) {
          clearEdit();
          S.undoStack = []; S.redoStack = []; refreshUndoButtons();
          if (j.b64) loadWalkMask(j);
          if (Array.isArray(j.spawns)) { S.spawns = j.spawns; renderSpawnList(); }
          S.tr.invalidateTerrain();
          $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${S.spawns.length}`;
          setStatus(`世界已重新初始化：${S.spawns.length} 个出生点，可通行区域已重建。`);
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
  }
  // 保存按钮
  $('btn-save').addEventListener('click', async () => {
    if (S.mode === 'item') {
      setStatus('保存物品…');
      const ok = await saveItems();
      setStatus(ok ? `已保存 ${S.gameItems.length} 件物品，服务器已热重载` : saveFailText());
    } else if (S.mode === 'creature') {
      setStatus('保存生物…');
      const ok = await saveCreatures();
      setStatus(ok ? `已保存 ${Object.keys(S.gameCreatures).length} 种生物，世界生物已热重载` : saveFailText());
    } else if (S.mode === 'npc') {
      setStatus('保存 NPC…');
      const ok = await saveNpcs();
      setStatus(ok ? `已保存 ${Object.keys(S.gameNpcs).length} 种 NPC，服务器已热重载` : saveFailText());
    } else if (S.mode === 'quest') {
      setStatus('保存任务…');
      const ok = await saveQuests();
      setStatus(ok ? `已保存 ${S.gameQuests.length} 个任务，服务器已热重载` : saveFailText());
    } else if (S.mode === 'enhance') {
      setStatus('保存强化配置…');
      const ok = await saveEnhance();
      setStatus(ok ? `已保存强化配置（${S.gameEnhance.levels.length} 级），服务器已热重载` : saveFailText());
    } else if (S.mode === 'decompose') {
      setStatus('保存分解配置…');
      const ok = await saveDecompose();
      setStatus(ok ? `已保存分解配置（${S.gameDecompose.rules.length} 档），服务器已热重载` : saveFailText());
    } else if (S.mode === 'craft') {
      setStatus('保存合成配方…');
      const ok = await saveCraft();
      setStatus(ok ? `已保存 ${S.gameCraft.length} 条配方，服务器已热重载` : saveFailText());
    } else if (S.mode === 'shop') {
      setStatus('保存商店配置…');
      const ok = await saveShops();
      setStatus(ok ? `已保存 ${Object.keys(S.gameShops).length} 个商店，服务器已热重载` : saveFailText());
    } else if (S.mode === 'skill') {
      setStatus('保存技能配置…');
      const ok = await saveSkills();
      setStatus(ok ? `已保存 ${S.gameSkills.length} 个技能，服务器已热重载` : saveFailText());
    } else {
      setStatus('保存地形+出生点…');
      const ok = await saveTerrain();
      if (ok) {
        const okSp = await saveSpawns();
        setStatus(okSp ? `已保存 ${editCellCount()} 个编辑格 + ${S.spawns.length} 个出生点，服务器已热重载` : saveFailText());
      } else {
        setStatus(saveFailText());
      }
    }
  });
  // 平移速度
  const panSpeedEl = $('pan-speed');
  panSpeedEl.addEventListener('input', () => { S.panSpeed = parseFloat(panSpeedEl.value) || 5; $('pan-speed-v').textContent = S.panSpeed; });
  // 列表搜索框
  const bindSearch = (elId, key, rerender) => {
    const el = $(elId); if (!el) return;
    el.addEventListener('input', () => { S[key] = el.value; rerender(); });
  };
  bindSearch('item-search', 'itemSearchText', () => renderItemList());
  bindSearch('creature-search', 'creatureSearchText', () => renderCreatureList());
  bindSearch('npc-search', 'npcSearchText', () => renderNpcList());
  bindSearch('quest-search', 'questSearchText', () => renderQuestList());
  bindSearch('craft-search', 'craftSearchText', () => renderCraftList());
  bindSearch('shop-search', 'shopSearchText', () => renderShopList());
  bindSearch('skill-search', 'skillSearchText', () => renderSkillList());
  // 物品/生物/NPC 面板
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
  // 任务面板
  bindQuestForm();
  $('btn-quest-new').addEventListener('click', newQuest);
  $('btn-quest-del').addEventListener('click', deleteQuest);
  $('btn-q-reward-add').addEventListener('click', addQuestRewardItem);
  $('btn-q-obj-add').addEventListener('click', addQuestObjective);
  // 经济面板
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
  // 技能面板
  bindSkillForm();
  $('btn-skill-new').addEventListener('click', newSkill);
  $('btn-skill-del').addEventListener('click', deleteSkill);
}

// ============================================================================
// 登录 / 会话
// ============================================================================
async function enterEditor(j) {
  const resume = S.running;
  S.token = j.token;
  S.username = j.user.username;
  saveSession(S.token, S.username);
  hideLogin();
  $('editor-user-name').textContent = S.username;
  if (resume) {
    setStatus(`已重新登录（${S.username}），之前未保存的修改仍在，可继续保存。`);
    return;
  }
  $('editor-app').classList.remove('hidden');

  // 加载可通行 mask
  try {
    const r = await fetch(BASE + '/api/terrain/mask');
    const jd = await r.json();
    if (jd && jd.ok) loadWalkMask(jd);
  } catch (e) {}

  // 初始化 WebGL 渲染器
  S.tr = new WebGLRenderer($('editor-canvas-wrap'), { editorMode: true });
  S.tr.setGridVisible(true);
  S.tr.setCameraFree(0, 0, 1);
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
    if (jd && jd.ok && Array.isArray(jd.spawns)) S.spawns = jd.spawns;
  } catch (e) {}
  // 加载游戏数据
  await loadGameData();
  await loadQuestData();

  renderSpawnList();
  $('editor-conn').textContent = `已连接 · 地形格 ${editCellCount()} · 出生点 ${S.spawns.length}`;
  setStatus(`已加载服务器数据（地形 ${editCellCount()} 格 / 出生点 ${S.spawns.length} 个）。WASD 平移，滚轮缩放。`);
  refreshUndoButtons();

  S.running = true;
  // 单 rAF 主循环：先处理 WASD 平移输入，再渲染，避免双 rAF 争抢主线程
  requestAnimationFrame(editorLoop);
}

// 编辑器主循环（panKey + frame 合并，单 rAF 驱动）
function editorLoop(ts) {
  if (!S.running) return;
  panKey(ts);
  frame(ts);
  requestAnimationFrame(editorLoop);
}

function requireRelogin(reason) {
  clearSession();
  S.token = '';
  showLogin(reason || '会话已过期，请重新登录（未保存的修改已保留）');
}

// 退出登录
const logoutBtn = $('editor-logout');
if (logoutBtn) logoutBtn.addEventListener('click', async () => {
  if (!confirm('退出登录？未保存的修改将丢失。')) return;
  await logoutSession(S.token);
  S.token = ''; S.username = '';
  S.running = false;
  S.undoStack = []; S.redoStack = []; S.spawnsDirty = false;
  $('editor-app').classList.add('hidden');
  $('editor-user-name').textContent = '-';
  showLogin('已退出登录');
});

// ============================================================================
// 初始化
// ============================================================================
window.addEventListener('resize', () => { if (S.tr) S.tr.resize(); recalcSpawnListHeight(); });
try { bindTools(); } catch (e) { console.error('[editor] bindTools 异常:', e); }
refreshUndoButtons();
initLogin({
  subtitle: '世界编辑器 · 地形画刷 + 生物出生点编辑',
  hint: '浅灰=可通行 · 白色=空洞(不可通行)<br/>地图为「路径地图」：主干道走廊 + 分支 + 随机空地',
  showRegister: false,
  onLoggedIn: async (tok, user) => {
    await enterEditor({ token: tok, user: { username: user } });
  },
});
