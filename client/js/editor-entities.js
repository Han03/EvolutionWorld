/**
 * editor-entities.js — 出生点 + 物品 + 生物 + NPC + 任务 编辑管理
 * 依赖注入：由 editor.js 调用 configure() 传入共享依赖。
 */
import { terrainHeight, terrainBlocked, editCellCount } from './terrain.js';
import { resolveIcon } from './items.js';
import { S, BASE, SPAWN_STYLE, ICON_PRESETS, QUEST_CAT_NAMES, QUEST_OBJ_TYPES, esc, openNewModal, initCollapsedAll } from './editor-state.js';

let $, authedPost, setStatus, renderEnhanceForm, renderDecomposeForm,
    renderCraftList, renderCraftForm, renderShopList, renderShopForm,
    recalcSpawnListHeight;

export function configure(deps) {
  $ = deps.$;
  authedPost = deps.authedPost;
  setStatus = deps.setStatus;
  renderEnhanceForm = deps.renderEnhanceForm;
  renderDecomposeForm = deps.renderDecomposeForm;
  renderCraftList = deps.renderCraftList;
  renderCraftForm = deps.renderCraftForm;
  renderShopList = deps.renderShopList;
  renderShopForm = deps.renderShopForm;
  recalcSpawnListHeight = deps.recalcSpawnListHeight;
}

// ============================================================================
// 出生点操作
// ============================================================================
export function findSpawnAt(px, py) {
  let best = -1, bestD = 1e9;
  for (let i = 0; i < S.spawns.length; i++) {
    const s = S.tr.w2s(S.spawns[i].x, 0, S.spawns[i].z);
    const d = Math.hypot(s.x - px, s.y - py);
    if (d < bestD && d < 18) { bestD = d; best = i; }
  }
  return best;
}

export function addSpawn(wx, wz, opts) {
  const sp = {
    kind: opts.kind,
    type: (opts.kind === 'monster') ? opts.type : '',
    name: opts.kind === 'npc' ? opts.name : '',
    shopId: opts.kind === 'npc' ? (opts.shopId || 0) : 0,
    x: Math.round(wx * 2) / 2,
    z: Math.round(wz * 2) / 2,
    count: opts.kind === 'monster' ? (opts.count || 1) : 1,
  };
  S.spawns.push(sp);
  S.selectedSpawn = S.spawns.length - 1;
  S.spawnsDirty = true;
  renderSpawnList();
}

export function removeSpawn(i) {
  if (i < 0 || i >= S.spawns.length) return;
  S.spawns.splice(i, 1);
  S.selectedSpawn = -1;
  S.spawnsDirty = true;
  renderSpawnList();
}

export function renderSpawnList() {
  const filtered = S.spawns.map((sp, i) => ({ sp, i })).filter(({ sp }) => {
    if (!S.spawnSearchText) return true;
    const q = S.spawnSearchText;
    const kindName = sp.kind === 'npc' ? 'npc' : '怪物';
    const typeName = sp.kind === 'npc' ? (sp.name || '') : (sp.type || '');
    const haystack = (kindName + ' ' + typeName).toLowerCase();
    return haystack.includes(q);
  });
  $('spawn-count-label').textContent = S.spawns.length;
  const box = $('spawn-list');
  box.innerHTML = '';
  if (!filtered.length) {
    box.innerHTML = '<div class="cfg-empty">' + (S.spawns.length ? '无匹配结果' : '暂无出生点') + '</div>';
    return;
  }
  filtered.forEach(({ sp, i }) => {
    const div = document.createElement('div');
    div.className = 'spawn-item' + (i === S.selectedSpawn ? ' sel' : '');
    const st = SPAWN_STYLE[sp.kind] || SPAWN_STYLE.monster;
    const kindName = sp.kind === 'npc' ? 'NPC' : '怪物';
    const typeName = sp.kind === 'npc' ? (sp.name || 'NPC') : (sp.type || '-');
    div.innerHTML = `<span class="sp-dot" style="background:${st.color}"></span>
      <span class="sp-txt">${kindName}·${typeName}</span>
      <span class="sp-pos">(${sp.x.toFixed(1)},${sp.z.toFixed(1)})${sp.kind === 'monster' && sp.count > 1 ? '×' + sp.count : ''}</span>
      <button class="sp-del" title="删除">✕</button>`;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('sp-del')) { removeSpawn(i); return; }
      S.selectedSpawn = i;
      renderSpawnList();
    });
    box.appendChild(div);
  });
  recalcSpawnListHeight();
}

export function centerOnSelected() {
  if (S.selectedSpawn >= 0 && S.selectedSpawn < S.spawns.length) {
    S.tr.setCameraFree(S.spawns[S.selectedSpawn].x, S.spawns[S.selectedSpawn].z);
  }
}

export function openPlaceSpawnModal(wx, wz) {
  const mask = $('editor-modal-mask');
  $('editor-modal-title').textContent = '放置出生点';
  const body = $('editor-modal-body');
  body.innerHTML = '';
  const kindLbl = document.createElement('label');
  const kindSp = document.createElement('span'); kindSp.textContent = '放置类型'; kindLbl.appendChild(kindSp);
  const kindSel = document.createElement('select'); kindSel.id = 'place-kind';
  [{ value: 'monster', text: '怪物' }, { value: 'npc', text: 'NPC' }]
    .forEach(o => { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.text; kindSel.appendChild(opt); });
  kindLbl.appendChild(kindSel); body.appendChild(kindLbl);
  const typeLbl = document.createElement('label');
  const typeSp = document.createElement('span'); typeSp.textContent = '放置对象'; typeLbl.appendChild(typeSp);
  const typeSel = document.createElement('select'); typeSel.id = 'place-type';
  typeLbl.appendChild(typeSel); body.appendChild(typeLbl);
  const countRow = document.createElement('label');
  const countSp = document.createElement('span'); countSp.textContent = '数量'; countRow.appendChild(countSp);
  const countInp = document.createElement('input');
  countInp.type = 'number'; countInp.id = 'place-count';
  countInp.value = '1'; countInp.min = '1'; countInp.max = '50'; countInp.step = '1';
  countRow.appendChild(countInp); body.appendChild(countRow);
  function updateTypeOptions() {
    typeSel.innerHTML = '';
    const kind = kindSel.value;
    countRow.style.display = kind === 'monster' ? '' : 'none';
    let entries = [];
    if (kind === 'monster') entries = Object.entries(S.gameCreatures).map(([t, c]) => ({ value: t, text: `${c.name || t} (${t})` }));
    else if (kind === 'npc') entries = Object.entries(S.gameNpcs).map(([id, n]) => ({ value: id, text: `${n.name || id} (${id})` }));
    if (!entries.length) entries = [{ value: '', text: '（无可用对象，请先在对应面板创建）' }];
    entries.forEach(o => { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.text; typeSel.appendChild(opt); });
  }
  kindSel.addEventListener('change', updateTypeOptions); updateTypeOptions();
  mask.classList.remove('hidden');
  setTimeout(() => kindSel.focus(), 50);
  const close = () => { mask.classList.add('hidden'); };
  $('editor-modal-cancel').onclick = close;
  $('editor-modal-ok').onclick = () => {
    const kind = kindSel.value, type = typeSel.value, count = parseInt(countInp.value) || 1;
    close();
    if (!type) { setStatus('无可用的放置对象，请先在对应面板创建'); return; }
    const name = kind === 'npc' ? (S.gameNpcs[type] ? S.gameNpcs[type].name : type) : '';
    const shopId = kind === 'npc' ? (S.gameNpcs[type] ? (S.gameNpcs[type].shopId || 0) : 0) : 0;
    addSpawn(wx, wz, { kind, type, name, shopId, count });
  };
  const escKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escKey); } };
  document.addEventListener('keydown', escKey);
}

export async function saveSpawns() {
  try {
    const j = await authedPost('/api/spawns/edit', { token: S.token, spawns: S.spawns });
    if (j.ok) S.spawnsDirty = false;
    return !!j.ok;
  } catch (e) { return false; }
}

// ============================================================================
// 物品列表 / 表单
// ============================================================================
export function itemOptionsHtml(selId) {
  let html = '<option value="0">（无）</option>';
  for (const o of S.gameItems) {
    const id = o.id | 0;
    html += `<option value="${id}"${id === selId ? ' selected' : ''}>#${id} ${esc(o.name)}</option>`;
  }
  return html;
}

export function buildIconPresets() {
  const box = $('it-icon-presets');
  if (!box || box.childElementCount) return;
  for (const emo of ICON_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = emo;
    b.addEventListener('click', () => {
      const it = S.gameItems[S.selectedItem]; if (!it) return;
      it.icon = emo; $('it-icon').value = emo; renderItemList();
    });
    box.appendChild(b);
  }
}

export function renderItemList() {
  const q = S.itemSearchText.toLowerCase();
  const filtered = q ? S.gameItems.filter(it => (it.name || '').toLowerCase().includes(q) || String(it.id).includes(q)) : S.gameItems;
  $('item-count-label').textContent = S.gameItems.length;
  const box = $('item-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配物品' : '暂无物品，点"新建"添加'}</div>`; return; }
  filtered.forEach((it, fi) => {
    const realIdx = S.gameItems.indexOf(it);
    const div = document.createElement('div');
    div.className = 'cfg-item' + (realIdx === S.selectedItem ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">${resolveIcon(it.icon)}</span><span class="cfg-nm">${esc(it.name) || '(未命名)'}</span><span class="cfg-id">#${it.id}</span>`;
    div.addEventListener('click', () => { S.selectedItem = realIdx; renderItemList(); renderItemForm(); });
    box.appendChild(div);
  });
}

function setItemFormEnabled(on) {
  ['it-id','it-name','it-desc','it-icon','it-type','it-slot','it-rarity','it-levelReq','it-hpBonus','it-mpBonus','it-attackBonus','it-defenseBonus','it-restoreHp','it-restoreMp','it-price','it-stackMax'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
}

export function updateItemConditional() {
  const it = S.gameItems[S.selectedItem];
  const type = it ? (it.type || 'equip') : 'equip';
  $('it-slot-row').style.display = type === 'equip' ? '' : 'none';
  $('it-restore-row').style.display = type === 'consumable' ? '' : 'none';
}

export function renderItemForm() {
  const it = S.gameItems[S.selectedItem];
  if (!it) { $('item-form').style.opacity = '0.4'; setItemFormEnabled(false); return; }
  $('item-form').style.opacity = '1'; setItemFormEnabled(true);
  $('it-id').value = it.id; $('it-name').value = it.name || ''; $('it-desc').value = it.desc || '';
  $('it-icon').value = it.icon || ''; $('it-type').value = it.type || 'equip';
  $('it-slot').value = it.slot || 'weapon'; $('it-rarity').value = String(it.rarity || 0);
  $('it-levelReq').value = it.levelReq || 1;
  $('it-hpBonus').value = it.hpBonus || 0; $('it-mpBonus').value = it.mpBonus || 0;
  $('it-attackBonus').value = it.attackBonus || 0; $('it-defenseBonus').value = it.defenseBonus || 0;
  $('it-restoreHp').value = it.restoreHp || 0; $('it-restoreMp').value = it.restoreMp || 0;
  $('it-price').value = it.price || 0; $('it-stackMax').value = it.stackMax || 99;
  updateItemConditional();
}

export function bindItemForm() {
  const it = () => S.gameItems[S.selectedItem];
  const num = (id, key, isInt) => { const el = $(id); el.addEventListener('input', () => { const o = it(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); o[key] = isNaN(v) ? 0 : v; }); };
  num('it-id', 'id', true); num('it-levelReq', 'levelReq', true);
  num('it-hpBonus', 'hpBonus', false); num('it-mpBonus', 'mpBonus', false);
  num('it-attackBonus', 'attackBonus', false); num('it-defenseBonus', 'defenseBonus', false);
  num('it-restoreHp', 'restoreHp', false); num('it-restoreMp', 'restoreMp', false);
  num('it-price', 'price', true); num('it-stackMax', 'stackMax', true);
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

export function newItem() {
  let maxId = 1000;
  for (const o of S.gameItems) if ((o.id | 0) > maxId) maxId = o.id | 0;
  openNewModal($, '新建物品', [
    { key: 'id', label: 'ID', type: 'number', value: maxId + 1, min: 1, step: 1 },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'type', label: '类型', type: 'select', options: [{ value: 'equip', text: '装备', selected: true }, { value: 'consumable', text: '消耗品' }, { value: 'quest', text: '任务道具' }] },
    { key: 'slot', label: '槽位', type: 'select', options: [{ value: 'weapon', text: '武器', selected: true }, { value: 'helm', text: '头盔' }, { value: 'chest', text: '上衣' }, { value: 'pants', text: '裤子' }, { value: 'gloves', text: '手套' }, { value: 'boots', text: '鞋子' }] },
    { key: 'rarity', label: '品质', type: 'select', options: [{ value: '0', text: '普通', selected: true }, { value: '1', text: '优秀' }, { value: '2', text: '稀有' }, { value: '3', text: '史诗' }, { value: '4', text: '传说' }] },
    { key: 'levelReq', label: '需等级', type: 'number', value: 1, min: 1, step: 1 },
  ], (v) => {
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    if (S.gameItems.some(o => (o.id | 0) === v.id)) { setStatus(`物品 ID ${v.id} 已存在`); return; }
    S.gameItems.push({ id: v.id, name: v.name, desc: '', icon: '❔', type: v.type, slot: v.slot, hpBonus: 0, mpBonus: 0, attackBonus: 0, defenseBonus: 0, restoreHp: 0, restoreMp: 0, price: 0, stackMax: 99, rarity: parseInt(v.rarity, 10) || 0, levelReq: v.levelReq });
    S.selectedItem = S.gameItems.length - 1;
    renderItemList(); renderItemForm();
  });
}

export function deleteItem() {
  if (S.selectedItem < 0 || S.selectedItem >= S.gameItems.length) { setStatus('请先选择要删除的物品'); return; }
  const o = S.gameItems[S.selectedItem];
  if (!confirm(`删除物品 #${o.id}「${o.name}」？`)) return;
  S.gameItems.splice(S.selectedItem, 1);
  S.selectedItem = Math.min(S.selectedItem, S.gameItems.length - 1);
  renderItemList(); renderItemForm();
}

export async function saveItems() {
  const seen = new Set();
  for (const o of S.gameItems) {
    if (!o.id || o.id <= 0) { setStatus('物品 ID 必须为正整数'); return false; }
    if (seen.has(o.id)) { setStatus(`物品 ID 重复：#${o.id}`); return false; }
    seen.add(o.id);
  }
  try {
    const j = await authedPost('/api/items/edit', { token: S.token, items: S.gameItems });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 生物列表 / 表单
// ============================================================================
export function renderCreatureList() {
  const q = S.creatureSearchText.toLowerCase();
  const allKeys = Object.keys(S.gameCreatures);
  const filtered = q ? allKeys.filter(type => { const cr = S.gameCreatures[type]; return (cr.name || '').toLowerCase().includes(q) || type.toLowerCase().includes(q); }) : allKeys;
  $('creature-count-label').textContent = allKeys.length;
  const box = $('creature-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配生物' : '暂无生物，点"新建"添加'}</div>`; return; }
  filtered.forEach((type) => {
    const cr = S.gameCreatures[type];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (type === S.selectedCreature ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🐾</span><span class="cfg-nm">${esc(cr.name) || type}</span><span class="cfg-id">${esc(type)}</span>`;
    div.addEventListener('click', () => { S.selectedCreature = type; renderCreatureList(); renderCreatureForm(); });
    box.appendChild(div);
  });
}

function setCreatureFormEnabled(on) {
  ['cr-type','cr-name','cr-desc','cr-level','cr-moveSpeed','cr-radius','cr-hp','cr-mp','cr-attack','cr-defense','cr-expReward','cr-goldMin','cr-goldMax','cr-skillIds','cr-isElite','cr-aggroRange','cr-chaseSpeed','cr-attackRange'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const da = $('btn-drop-add'); if (da) da.disabled = !on;
}

export function renderCreatureForm() {
  const cr = S.gameCreatures[S.selectedCreature];
  if (!cr) {
    $('creature-form').style.opacity = '0.4'; setCreatureFormEnabled(false);
    $('drop-list').innerHTML = '<div class="cfg-empty">选择或新建生物</div>'; $('drop-count-label').textContent = 0;
    return;
  }
  $('creature-form').style.opacity = '1'; setCreatureFormEnabled(true);
  $('cr-type').value = S.selectedCreature; $('cr-name').value = cr.name || ''; $('cr-desc').value = cr.desc || '';
  $('cr-level').value = cr.level || 1; $('cr-moveSpeed').value = (cr.moveSpeed != null ? cr.moveSpeed : 1.5);
  $('cr-radius').value = cr.radius != null ? cr.radius : 0.5;
  $('cr-hp').value = cr.hp || 0; $('cr-mp').value = cr.mp || 0;
  $('cr-attack').value = cr.attack || 0; $('cr-defense').value = cr.defense || 0;
  $('cr-expReward').value = cr.expReward || 0; $('cr-goldMin').value = cr.goldMin || 0; $('cr-goldMax').value = cr.goldMax || 0;
  $('cr-skillIds').value = (cr.skillIds || []).join(',');
  const isElite = !!cr.isElite; $('cr-isElite').checked = isElite;
  $('cr-aggroRange').value = cr.aggroRange != null ? cr.aggroRange : 10;
  $('cr-chaseSpeed').value = cr.chaseSpeed != null ? cr.chaseSpeed : 0;
  $('cr-attackRange').value = cr.attackRange != null ? cr.attackRange : 1.6;
  renderDropList();
}

export function bindCreatureForm() {
  const cr = () => S.gameCreatures[S.selectedCreature];
  const num = (id, key, isInt) => { const el = $(id); if (!el) return; el.addEventListener('input', () => { const c = cr(); if (!c) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); c[key] = isNaN(v) ? 0 : v; }); };
  num('cr-level', 'level', true); num('cr-moveSpeed', 'moveSpeed', false); num('cr-radius', 'radius', false);
  num('cr-hp', 'hp', false); num('cr-mp', 'mp', false);
  num('cr-attack', 'attack', false); num('cr-defense', 'defense', false);
  num('cr-expReward', 'expReward', true); num('cr-goldMin', 'goldMin', true); num('cr-goldMax', 'goldMax', true);
  const nameEl = $('cr-name');
  if (nameEl) {
    nameEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.name = nameEl.value; });
    nameEl.addEventListener('change', () => renderCreatureList());
  }
  const descEl = $('cr-desc');
  if (descEl) descEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.desc = descEl.value; });
  const skEl = $('cr-skillIds');
  if (skEl) skEl.addEventListener('input', () => { const c = cr(); if (!c) return; c.skillIds = skEl.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0); });
  const eliteCb = $('cr-isElite');
  if (eliteCb) eliteCb.addEventListener('change', () => { const c = cr(); if (!c) return; c.isElite = eliteCb.checked; });
  const numElite = (id, key) => { const el = $(id); if (!el) return; el.addEventListener('input', () => { const c = cr(); if (!c) return; const v = parseFloat(el.value); c[key] = isNaN(v) ? 0 : v; }); };
  numElite('cr-aggroRange', 'aggroRange'); numElite('cr-chaseSpeed', 'chaseSpeed'); numElite('cr-attackRange', 'attackRange');
  const typeEl = $('cr-type');
  if (typeEl) typeEl.addEventListener('change', () => {
    const oldType = S.selectedCreature; const c = S.gameCreatures[oldType]; if (!c) return;
    const newType = typeEl.value.trim();
    if (!newType) { typeEl.value = oldType; setStatus('生物 ID 不能为空'); return; }
    if (newType === oldType) return;
    if (S.gameCreatures[newType]) { typeEl.value = oldType; setStatus(`生物 ID 已存在：${newType}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(S.gameCreatures)) { if (k === oldType) rebuilt[newType] = c; else rebuilt[k] = S.gameCreatures[k]; }
    S.gameCreatures = rebuilt; S.selectedCreature = newType; renderCreatureList();
  });
}

export function renderDropList() {
  const cr = S.gameCreatures[S.selectedCreature];
  const box = $('drop-list'); box.innerHTML = '';
  if (!cr) return;
  const drops = cr.drops || (cr.drops = []);
  $('drop-count-label').textContent = drops.length;
  if (!drops.length) { box.innerHTML = '<div class="cfg-empty">无掉落，点"添加掉落"</div>'; return; }
  drops.forEach((d, i) => {
    const row = document.createElement('div'); row.className = 'drop-row';
    const sel = document.createElement('select'); sel.innerHTML = itemOptionsHtml(d.item | 0);
    sel.addEventListener('change', () => { d.item = parseInt(sel.value, 10) || 0; });
    const pct = document.createElement('input');
    pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = '1';
    pct.value = Math.round((d.prob || 0) * 100);
    pct.addEventListener('input', () => { let v = parseFloat(pct.value); if (isNaN(v)) v = 0; d.prob = Math.max(0, Math.min(100, v)) / 100; });
    const lbl = document.createElement('span'); lbl.className = 'drop-pct'; lbl.textContent = '%';
    const del = document.createElement('button'); del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { drops.splice(i, 1); renderDropList(); });
    row.appendChild(sel); row.appendChild(pct); row.appendChild(lbl); row.appendChild(del);
    box.appendChild(row);
  });
}

export function addDrop() {
  const cr = S.gameCreatures[S.selectedCreature];
  if (!cr) { setStatus('请先选择生物'); return; }
  if (!cr.drops) cr.drops = [];
  cr.drops.push({ item: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, prob: 0.1 });
  renderDropList();
}

export function newCreature() {
  let n = 1, type = 'creature1';
  while (S.gameCreatures[type]) { n++; type = 'creature' + n; }
  openNewModal($, '新建生物', [
    { key: 'type', label: 'ID(type)', type: 'text', value: type },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'level', label: '等级', type: 'number', value: 1, min: 1, step: 1 },
    { key: 'isBoss', label: 'Boss', type: 'select', options: [{ value: '0', text: '否', selected: true }, { value: '1', text: '是' }] },
  ], (v) => {
    const tid = v.type.trim();
    if (!tid) { setStatus('Type ID 不能为空'); return; }
    if (S.gameCreatures[tid]) { setStatus(`Type ID 已存在：${tid}`); return; }
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    S.gameCreatures[tid] = { name: v.name, desc: '', level: v.level || 1, hp: 50, mp: 20, attack: 8, defense: 2, moveSpeed: 1.5, expReward: 20, goldMin: 1, goldMax: 3, drops: [], skillIds: [], isBoss: v.isBoss === '1' };
    S.selectedCreature = tid; renderCreatureList(); renderCreatureForm();
  });
}

export function deleteCreature() {
  if (!S.selectedCreature || !S.gameCreatures[S.selectedCreature]) { setStatus('请先选择要删除的生物'); return; }
  if (!confirm(`删除生物「${S.gameCreatures[S.selectedCreature].name}」(${S.selectedCreature})？`)) return;
  delete S.gameCreatures[S.selectedCreature];
  const keys = Object.keys(S.gameCreatures);
  S.selectedCreature = keys.length ? keys[0] : '';
  renderCreatureList(); renderCreatureForm();
}

export async function saveCreatures() {
  for (const type of Object.keys(S.gameCreatures)) { if (!type) { setStatus('生物 ID 不能为空'); return false; } }
  try {
    const j = await authedPost('/api/monsters/edit', { token: S.token, monsters: S.gameCreatures });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// NPC 列表 / 表单
// ============================================================================
export function renderNpcList() {
  const q = S.npcSearchText.toLowerCase();
  const allKeys = Object.keys(S.gameNpcs);
  const filtered = q ? allKeys.filter(type => { const npc = S.gameNpcs[type]; return (npc.name || '').toLowerCase().includes(q) || type.toLowerCase().includes(q); }) : allKeys;
  $('npc-count-label').textContent = allKeys.length;
  const box = $('npc-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配 NPC' : '暂无 NPC，点"新建"添加'}</div>`; return; }
  filtered.forEach((type) => {
    const npc = S.gameNpcs[type];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (type === S.selectedNpc ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🧑</span><span class="cfg-nm">${esc(npc.name) || type}</span><span class="cfg-id">${esc(type)}</span>`;
    div.addEventListener('click', () => { S.selectedNpc = type; renderNpcList(); renderNpcForm(); });
    box.appendChild(div);
  });
}

function setNpcFormEnabled(on) {
  ['npc-id','npc-name','npc-desc','npc-model','npc-shopId','npc-level','npc-wander','npc-dialogue'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const tagEl = $('npc-tag'); if (tagEl) tagEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = !on; });
}

export function updateNpcTagConfig() {
  const tagEl = $('npc-tag');
  let tag = 0;
  tagEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.checked) tag |= parseInt(cb.value, 10);
  });
  const dlgSec = $('npc-cfg-dialogue');
  if (dlgSec) dlgSec.classList.toggle('hidden', (tag & 1) === 0);
  const shopSec = $('npc-cfg-shop');
  if (shopSec) shopSec.classList.toggle('hidden', (tag & 4) === 0);
}

export function renderNpcForm() {
  const npc = S.gameNpcs[S.selectedNpc];
  if (!npc) { $('npc-form').style.opacity = '0.4'; setNpcFormEnabled(false); return; }
  $('npc-form').style.opacity = '1'; setNpcFormEnabled(true);
  $('npc-id').value = S.selectedNpc;
  $('npc-name').value = npc.name || '';
  $('npc-desc').value = npc.desc || '';
  $('npc-model').value = npc.model || '';
  const tagEl = $('npc-tag');
  const tag = npc.npcTag != null ? npc.npcTag : 1;
  tagEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = (tag & parseInt(cb.value, 10)) !== 0;
  });
  $('npc-shopId').value = npc.shopId || 0;
  $('npc-level').value = npc.level || 1;
  $('npc-wander').value = npc.wanderRadius || 0;
  $('npc-radius').value = npc.radius || 0.5;
  $('npc-dialogue').value = npc.dialogue || '';
  updateNpcTagConfig();
}

export function bindNpcForm() {
  const npc = () => S.gameNpcs[S.selectedNpc];
  const nameEl = $('npc-name');
  nameEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderNpcList());
  const descEl = $('npc-desc');
  descEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.desc = descEl.value; });
  const modelEl = $('npc-model');
  modelEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.model = modelEl.value; });
  const tagEl = $('npc-tag');
  tagEl.addEventListener('change', () => {
    const o = npc(); if (!o) return;
    let tag = 0;
    tagEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) tag |= parseInt(cb.value, 10);
    });
    o.npcTag = tag || 1;
    updateNpcTagConfig();
  });
  const shopEl = $('npc-shopId');
  shopEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseInt(shopEl.value, 10); o.shopId = isNaN(v) ? 0 : v; });
  const levelEl = $('npc-level');
  levelEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseInt(levelEl.value, 10); o.level = isNaN(v) ? 1 : v; });
  const wanderEl = $('npc-wander');
  wanderEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseFloat(wanderEl.value); o.wanderRadius = isNaN(v) ? 0 : v; });
  const radiusEl = $('npc-radius');
  radiusEl.addEventListener('input', () => { const o = npc(); if (!o) return; const v = parseFloat(radiusEl.value); o.radius = isNaN(v) ? 0.5 : v; });
  const dialogueEl = $('npc-dialogue');
  dialogueEl.addEventListener('input', () => { const o = npc(); if (!o) return; o.dialogue = dialogueEl.value; });
  const idEl = $('npc-id');
  idEl.addEventListener('change', () => {
    const oldType = S.selectedNpc;
    const o = S.gameNpcs[oldType]; if (!o) return;
    const newType = idEl.value.trim();
    if (!newType) { idEl.value = oldType; setStatus('NPC ID 不能为空'); return; }
    if (newType === oldType) return;
    if (S.gameNpcs[newType]) { idEl.value = oldType; setStatus(`NPC ID 已存在：${newType}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(S.gameNpcs)) {
      if (k === oldType) rebuilt[newType] = o; else rebuilt[k] = S.gameNpcs[k];
    }
    S.gameNpcs = rebuilt;
    S.selectedNpc = newType;
    renderNpcList();
  });
}

export function newNpc() {
  let n = 1, type = 'npc1';
  while (S.gameNpcs[type]) { n++; type = 'npc' + n; }
  openNewModal($, '新建 NPC', [
    { key: 'id', label: 'ID', type: 'text', value: type },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'tag', label: '标签', type: 'select', options: [
      { value: '1', text: '基础（对话）', selected: true },
      { value: '2', text: '任务（接取/提交）' },
      { value: '4', text: '商店' },
      { value: '8', text: '铁匠（强化/分解）' },
      { value: '16', text: '传送' },
      { value: '64', text: '合成' },
      { value: '128', text: '仓库' },
    ]},
    { key: 'level', label: '等级', type: 'number', value: 1, min: 1, step: 1 },
  ], (v) => {
    const tid = v.id.trim();
    if (!tid) { setStatus('NPC ID 不能为空'); return; }
    if (S.gameNpcs[tid]) { setStatus(`NPC ID 已存在：${tid}`); return; }
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    S.gameNpcs[tid] = { name: v.name, desc: '', model: '', npcTag: parseInt(v.tag, 10) || 1, shopId: 0, level: v.level || 1, wanderRadius: 0, dialogue: '' };
    S.selectedNpc = tid;
    renderNpcList(); renderNpcForm();
  });
}

export function deleteNpc() {
  if (!S.selectedNpc || !S.gameNpcs[S.selectedNpc]) { setStatus('请先选择要删除的 NPC'); return; }
  if (!confirm(`删除 NPC「${S.gameNpcs[S.selectedNpc].name}」(${S.selectedNpc})？`)) return;
  delete S.gameNpcs[S.selectedNpc];
  const keys = Object.keys(S.gameNpcs);
  S.selectedNpc = keys.length ? keys[0] : '';
  renderNpcList(); renderNpcForm();
}

export async function saveNpcs() {
  for (const type of Object.keys(S.gameNpcs)) {
    if (!type) { setStatus('NPC ID 不能为空'); return false; }
  }
  try {
    const j = await authedPost('/api/npcs/edit', { token: S.token, npcs: S.gameNpcs });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 任务配置
// ============================================================================
export async function loadQuestData() {
  try {
    const r = await fetch(BASE + '/api/quests');
    const jd = await r.json();
    if (jd && jd.ok && Array.isArray(jd.quests)) S.gameQuests = jd.quests;
  } catch (e) {}
  S.selectedQuest = S.gameQuests.length ? 0 : -1;
  renderQuestList(); renderQuestForm();
}

export function renderQuestList() {
  const q = S.questSearchText.toLowerCase();
  const filtered = q ? S.gameQuests.filter(x => (x.name || '').toLowerCase().includes(q) || String(x.id).includes(q)) : S.gameQuests;
  $('quest-count-label').textContent = S.gameQuests.length;
  const box = $('quest-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配任务' : '暂无任务，点"新建"添加'}</div>`; return; }
  filtered.forEach((x) => {
    const realIdx = S.gameQuests.indexOf(x);
    const div = document.createElement('div');
    div.className = 'cfg-item' + (realIdx === S.selectedQuest ? ' sel' : '');
    const catName = QUEST_CAT_NAMES[x.category] || x.category;
    div.innerHTML = `<span class="cfg-ico">📜</span><span class="cfg-nm">${esc(x.name) || '(未命名)'}</span><span class="cfg-id">#${x.id} ${catName}</span>`;
    div.addEventListener('click', () => { S.selectedQuest = realIdx; renderQuestList(); renderQuestForm(); });
    box.appendChild(div);
  });
}

function setQuestFormEnabled(on) {
  ['q-id','q-name','q-desc','q-category','q-levelReq','q-giverNpc','q-talkNpc','q-prereq','q-nextQuests','q-gold','q-exp','q-dailyCd'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ra = $('btn-q-reward-add'); if (ra) ra.disabled = !on;
  const oa = $('btn-q-obj-add'); if (oa) oa.disabled = !on;
}

export function renderQuestForm() {
  const q = S.gameQuests[S.selectedQuest];
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
  $('q-giverNpc').value = q.giverNpc || '';
  $('q-talkNpc').value = q.talkNpc || '';
  $('q-prereq').value = (q.prereq || []).join(',');
  $('q-nextQuests').value = (q.nextQuests || []).join(',');
  $('q-gold').value = (q.rewards && q.rewards.gold) || 0;
  $('q-exp').value = (q.rewards && q.rewards.exp) || 0;
  $('q-dailyCd').value = q.dailyCd || 0;
  renderQuestRewardItems();
  renderQuestObjectives();
}

export function bindQuestForm() {
  const q = () => S.gameQuests[S.selectedQuest];
  const num = (id, key, isInt) => {
    const el = $(id);
    el.addEventListener('input', () => { const o = q(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); if (key.includes('.')) { const [p, c] = key.split('.'); if (!o[p]) o[p] = {}; o[p][c] = isNaN(v) ? 0 : v; } else { o[key] = isNaN(v) ? 0 : v; } });
  };
  num('q-id', 'id', true);
  num('q-levelReq', 'levelReq', true);
  const giverEl = $('q-giverNpc');
  giverEl.addEventListener('input', () => { const o = q(); if (!o) return; o.giverNpc = giverEl.value.trim(); });
  const talkEl = $('q-talkNpc');
  talkEl.addEventListener('input', () => { const o = q(); if (!o) return; o.talkNpc = talkEl.value.trim(); });
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
  $('q-id').addEventListener('change', () => renderQuestList());
}

function rewardItemOptionsHtml(selId) {
  let html = '<option value="0">（无）</option>';
  for (const o of S.gameItems) {
    const id = o.id | 0;
    html += `<option value="${id}"${id === selId ? ' selected' : ''}>#${id} ${esc(o.name)}</option>`;
  }
  return html;
}

function renderQuestRewardItems() {
  const q = S.gameQuests[S.selectedQuest];
  const box = $('q-reward-items'); box.innerHTML = '';
  if (!q) return;
  if (!q.rewards) q.rewards = {};
  if (!q.rewards.items) q.rewards.items = [];
  const items = q.rewards.items;
  if (!items.length) { box.innerHTML = '<div class="cfg-empty">无奖励物品，点"添加"</div>'; return; }
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

export function addQuestRewardItem() {
  const q = S.gameQuests[S.selectedQuest];
  if (!q) { setStatus('请先选择任务'); return; }
  if (!q.rewards) q.rewards = {};
  if (!q.rewards.items) q.rewards.items = [];
  q.rewards.items.push({ id: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, count: 1 });
  renderQuestRewardItems();
}

const QUEST_OBJ_KEY_HINTS = {
  kill: '怪物 type（如 wolf1）',
  collect: '物品 ID',
  reach: '无需填写',
  talk: 'NPC ID',
  escort: 'NPC ID',
};

function renderQuestObjectives() {
  const q = S.gameQuests[S.selectedQuest];
  const box = $('q-objectives'); box.innerHTML = '';
  if (!q) { $('q-obj-count').textContent = '0'; return; }
  if (!q.objectives) q.objectives = [];
  const objs = q.objectives;
  $('q-obj-count').textContent = objs.length;
  if (!objs.length) { box.innerHTML = '<div class="cfg-empty">无目标，点"添加目标"</div>'; return; }
  objs.forEach((o, i) => {
    const card = document.createElement('div');
    card.className = 'q-obj-card';

    // -- 头部：标题 + 类型选择 + 删除 --
    const head = document.createElement('div');
    head.className = 'q-obj-head';
    const title = document.createElement('span');
    title.className = 'q-obj-title';
    title.textContent = `目标 #${i + 1}`;
    const typeSel = document.createElement('select');
    typeSel.className = 'q-obj-type';
    for (const t of QUEST_OBJ_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.v; opt.textContent = t.n;
      if (o.type === t.v) opt.selected = true;
      typeSel.appendChild(opt);
    }
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除目标';
    del.addEventListener('click', () => { objs.splice(i, 1); renderQuestObjectives(); });
    head.appendChild(title); head.appendChild(typeSel); head.appendChild(del);
    card.appendChild(head);

    // -- 字段区域 --
    const body = document.createElement('div');
    body.className = 'q-obj-body';

    // 目标类型提示（动态）
    const hintSpan = document.createElement('div');
    hintSpan.className = 'q-obj-hint';
    hintSpan.textContent = QUEST_OBJ_KEY_HINTS[o.type] || '';
    body.appendChild(hintSpan);

    // 目标 key/ID
    const keyField = document.createElement('div');
    keyField.className = 'cfg-field';
    const keyLabel = document.createElement('label');
    keyLabel.textContent = '目标';
    const keyInput = document.createElement('input');
    keyInput.type = 'text'; keyInput.placeholder = QUEST_OBJ_KEY_HINTS[o.type] || '';
    keyInput.value = o.targetKey || '';
    keyInput.addEventListener('input', () => { o.targetKey = keyInput.value; });
    keyField.appendChild(keyLabel); keyField.appendChild(keyInput);
    body.appendChild(keyField);

    // 数量
    const reqField = document.createElement('div');
    reqField.className = 'cfg-field';
    const reqLabel = document.createElement('label');
    reqLabel.textContent = '数量';
    const reqInput = document.createElement('input');
    reqInput.type = 'number'; reqInput.min = '1'; reqInput.step = '1';
    reqInput.value = o.required || 1;
    reqInput.addEventListener('input', () => { o.required = parseInt(reqInput.value, 10) || 1; });
    reqField.appendChild(reqLabel); reqField.appendChild(reqInput);
    body.appendChild(reqField);

    // 描述
    const descField = document.createElement('div');
    descField.className = 'cfg-field';
    const descLabel = document.createElement('label');
    descLabel.textContent = '描述';
    const descInput = document.createElement('input');
    descInput.type = 'text'; descInput.placeholder = '显示在任务日志中的文本';
    descInput.value = o.desc || '';
    descInput.addEventListener('input', () => { o.desc = descInput.value; });
    descField.appendChild(descLabel); descField.appendChild(descInput);
    body.appendChild(descField);

    // 坐标 X / Z（并排）
    const coordRow = document.createElement('div');
    coordRow.className = 'cfg-row2';
    const xField = document.createElement('div');
    xField.className = 'cfg-field';
    const xLabel = document.createElement('label');
    xLabel.textContent = '坐标X';
    const xInput = document.createElement('input');
    xInput.type = 'number'; xInput.step = '0.5';
    xInput.value = o.x || 0;
    xInput.addEventListener('input', () => { o.x = parseFloat(xInput.value) || 0; });
    xField.appendChild(xLabel); xField.appendChild(xInput);
    const zField = document.createElement('div');
    zField.className = 'cfg-field';
    const zLabel = document.createElement('label');
    zLabel.textContent = '坐标Z';
    const zInput = document.createElement('input');
    zInput.type = 'number'; zInput.step = '0.5';
    zInput.value = o.z || 0;
    zInput.addEventListener('input', () => { o.z = parseFloat(zInput.value) || 0; });
    zField.appendChild(zLabel); zField.appendChild(zInput);
    coordRow.appendChild(xField); coordRow.appendChild(zField);
    body.appendChild(coordRow);

    card.appendChild(body);
    box.appendChild(card);

    // 类型切换时更新提示文本和 placeholder
    typeSel.addEventListener('change', () => {
      o.type = typeSel.value;
      const hint = QUEST_OBJ_KEY_HINTS[o.type] || '';
      hintSpan.textContent = hint;
      keyInput.placeholder = hint;
    });
  });
}

export function addQuestObjective() {
  const q = S.gameQuests[S.selectedQuest];
  if (!q) { setStatus('请先选择任务'); return; }
  if (!q.objectives) q.objectives = [];
  q.objectives.push({ type: 'kill', targetKey: '', required: 1, desc: '', x: 0, z: 0 });
  renderQuestObjectives();
}

export function newQuest() {
  let maxId = 10000;
  for (const q of S.gameQuests) if ((q.id | 0) > maxId) maxId = q.id | 0;
  openNewModal($, '新建任务', [
    { key: 'id', label: 'ID', type: 'number', value: maxId + 1, min: 1, step: 1 },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'category', label: '分类', type: 'select', options: [
      { value: 'main', text: '主线' },
      { value: 'side', text: '支线', selected: true },
      { value: 'daily', text: '日常' },
      { value: 'repeatable', text: '可重复' },
    ]},
    { key: 'levelReq', label: '等级需', type: 'number', value: 1, min: 1, step: 1 },
  ], (v) => {
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    if (S.gameQuests.some(q => (q.id | 0) === v.id)) { setStatus(`任务 ID ${v.id} 已存在`); return; }
    S.gameQuests.push({ id: v.id, name: v.name, desc: '', category: v.category, levelReq: v.levelReq, prereq: [], objectives: [], rewards: { gold: 0, exp: 0, items: [] }, dailyCd: 0, giverNpc: '', talkNpc: '', nextQuests: [] });
    S.selectedQuest = S.gameQuests.length - 1;
    renderQuestList(); renderQuestForm();
  });
}

export function deleteQuest() {
  if (S.selectedQuest < 0 || S.selectedQuest >= S.gameQuests.length) { setStatus('请先选择要删除的任务'); return; }
  const q = S.gameQuests[S.selectedQuest];
  if (!confirm(`删除任务 #${q.id}「${q.name}」？`)) return;
  S.gameQuests.splice(S.selectedQuest, 1);
  S.selectedQuest = Math.min(S.selectedQuest, S.gameQuests.length - 1);
  renderQuestList(); renderQuestForm();
}

export async function saveQuests() {
  for (const q of S.gameQuests) {
    if (!q.id || q.id <= 0) { setStatus('任务 ID 必须为正整数'); return false; }
  }
  try {
    const j = await authedPost('/api/quests/edit', { token: S.token, quests: S.gameQuests });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 技能配置
// ============================================================================
const SKILL_TARGET_NAMES = { self: '自身', enemy: '敌方', aoe: '区域' };
const SKILL_BUFF_NAMES = { atk: '攻击', def: '防御', move_slow: '减速', regen: '回血', thorns: '反伤', bleed: '流血', def_down: '减防', atk_down: '减攻', stun: '眩晕', super_armor: '霸体', speed: '加速' };
function skillEffectLabel(s) {
  const parts = [];
  if ((s.dmgMul || 0) > 0 || (s.flatDmg || 0) > 0) parts.push('伤害');
  if ((s.heal || 0) > 0) parts.push('治疗');
  if (s.buffType && s.buffType !== 'none' && (s.buffDur || 0) > 0) parts.push(SKILL_BUFF_NAMES[s.buffType] || s.buffType);
  return parts.length ? parts.join('+') : '无';
}

export function renderSkillList() {
  const q = S.skillSearchText.toLowerCase();
  const filtered = q ? S.gameSkills.filter(s => (s.name || '').toLowerCase().includes(q) || String(s.id).includes(q)) : S.gameSkills;
  $('skill-count-label').textContent = S.gameSkills.length;
  const box = $('skill-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配技能' : '暂无技能，点"新建"添加'}</div>`; return; }
  filtered.forEach((s) => {
    const realIdx = S.gameSkills.indexOf(s);
    const div = document.createElement('div');
    div.className = 'cfg-item' + (realIdx === S.selectedSkill ? ' sel' : '');
    const tgt = SKILL_TARGET_NAMES[s.target] || s.target;
    const eff = skillEffectLabel(s);
    div.innerHTML = `<span class="cfg-ico">✨</span><span class="cfg-nm">${esc(s.name) || '(未命名)'}</span><span class="cfg-id">#${s.id} ${tgt}·${eff}</span>`;
    div.addEventListener('click', () => { S.selectedSkill = realIdx; renderSkillList(); renderSkillForm(); });
    box.appendChild(div);
  });
}

function setSkillFormEnabled(on) {
  ['sk-id','sk-name','sk-desc','sk-icon','sk-target','sk-mana','sk-cooldownMs','sk-range','sk-radius','sk-dmgMul','sk-flatDmg','sk-heal','sk-lifesteal','sk-buffType','sk-buffValue','sk-buffDur','sk-castTimeMs','sk-knockback','sk-dashDist','sk-superArmor','sk-cancelOnMove','sk-cancelOnHit','sk-starterSkills'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
}

export function renderSkillForm() {
  const s = S.gameSkills[S.selectedSkill];
  if (!s) { $('skill-form').style.opacity = '0.4'; setSkillFormEnabled(false); return; }
  $('skill-form').style.opacity = '1'; setSkillFormEnabled(true);
  $('sk-id').value = s.id; $('sk-name').value = s.name || ''; $('sk-desc').value = s.desc || '';
  $('sk-icon').value = s.icon || ''; $('sk-target').value = s.target || 'self';
  $('sk-mana').value = s.mana || 0; $('sk-cooldownMs').value = s.cooldownMs || 0;
  $('sk-range').value = s.range || 0; $('sk-radius').value = s.radius || 0;
  $('sk-dmgMul').value = s.dmgMul || 0; $('sk-flatDmg').value = s.flatDmg || 0;
  $('sk-heal').value = s.heal || 0; $('sk-lifesteal').value = s.lifesteal || 0;
  $('sk-buffType').value = s.buffType || 'none'; $('sk-buffValue').value = s.buffValue || 0;
  $('sk-buffDur').value = s.buffDur || 0; $('sk-castTimeMs').value = s.castTimeMs || 0;
  $('sk-knockback').value = s.knockback || 0; $('sk-dashDist').value = s.dashDist || 0;
  $('sk-superArmor').checked = !!s.superArmor;
  $('sk-cancelOnMove').checked = s.cancelOnMove !== 0;
  $('sk-cancelOnHit').checked = s.cancelOnHit !== 0;
  $('sk-starterSkills').value = (S.gameStarterSkills || []).join(',');
}

export function bindSkillForm() {
  const sk = () => S.gameSkills[S.selectedSkill];
  const num = (id, key, isInt) => { const el = $(id); el.addEventListener('input', () => { const o = sk(); if (!o) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); o[key] = isNaN(v) ? 0 : v; }); };
  num('sk-id', 'id', true); num('sk-mana', 'mana', false);
  num('sk-cooldownMs', 'cooldownMs', true); num('sk-range', 'range', false);
  num('sk-radius', 'radius', false); num('sk-dmgMul', 'dmgMul', false);
  num('sk-flatDmg', 'flatDmg', false); num('sk-heal', 'heal', false);
  num('sk-lifesteal', 'lifesteal', false); num('sk-buffValue', 'buffValue', false);
  num('sk-buffDur', 'buffDur', false); num('sk-castTimeMs', 'castTimeMs', true);
  num('sk-knockback', 'knockback', false); num('sk-dashDist', 'dashDist', false);
  const nameEl = $('sk-name');
  nameEl.addEventListener('input', () => { const o = sk(); if (!o) return; o.name = nameEl.value; });
  nameEl.addEventListener('change', () => renderSkillList());
  const descEl = $('sk-desc');
  descEl.addEventListener('input', () => { const o = sk(); if (!o) return; o.desc = descEl.value; });
  const iconEl = $('sk-icon');
  iconEl.addEventListener('input', () => { const o = sk(); if (!o) return; o.icon = iconEl.value; });
  iconEl.addEventListener('change', () => renderSkillList());
  const tgtEl = $('sk-target');
  tgtEl.addEventListener('change', () => { const o = sk(); if (!o) return; o.target = tgtEl.value; renderSkillList(); });
  const btEl = $('sk-buffType');
  btEl.addEventListener('change', () => { const o = sk(); if (!o) return; o.buffType = btEl.value; });
  $('sk-superArmor').addEventListener('change', () => { const o = sk(); if (!o) return; o.superArmor = $('sk-superArmor').checked ? 1 : 0; });
  $('sk-cancelOnMove').addEventListener('change', () => { const o = sk(); if (!o) return; o.cancelOnMove = $('sk-cancelOnMove').checked ? 1 : 0; });
  $('sk-cancelOnHit').addEventListener('change', () => { const o = sk(); if (!o) return; o.cancelOnHit = $('sk-cancelOnHit').checked ? 1 : 0; });
  $('sk-id').addEventListener('change', () => renderSkillList());
  // 起始技能（全局配置，不属于单个技能）
  $('sk-starterSkills').addEventListener('input', () => {
    S.gameStarterSkills = $('sk-starterSkills').value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  });
}

export function newSkill() {
  let maxId = 1000;
  for (const s of S.gameSkills) if ((s.id | 0) > maxId) maxId = s.id | 0;
  openNewModal($, '新建技能', [
    { key: 'id', label: 'ID', type: 'number', value: maxId + 1, min: 1, step: 1 },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'target', label: '目标', type: 'select', options: [
      { value: 'enemy', text: '敌方', selected: true },
      { value: 'self', text: '自身' },
      { value: 'aoe', text: '区域' },
    ]},
  ], (v) => {
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    if (S.gameSkills.some(s => (s.id | 0) === v.id)) { setStatus(`技能 ID ${v.id} 已存在`); return; }
    S.gameSkills.push({ id: v.id, name: v.name, desc: '', icon: 's_new', target: v.target, mana: 0, cooldownMs: 3000, range: 3, radius: 0, dmgMul: 1.0, flatDmg: 0, heal: 0, buffType: 'none', buffValue: 0, buffDur: 0, lifesteal: 0, castTimeMs: 0, cancelOnMove: 1, cancelOnHit: 1, knockback: 0, dashDist: 0, superArmor: 0 });
    S.selectedSkill = S.gameSkills.length - 1;
    renderSkillList(); renderSkillForm();
  });
}

export function deleteSkill() {
  if (S.selectedSkill < 0 || S.selectedSkill >= S.gameSkills.length) { setStatus('请先选择要删除的技能'); return; }
  const s = S.gameSkills[S.selectedSkill];
  if (!confirm(`删除技能 #${s.id}「${s.name}」？`)) return;
  S.gameSkills.splice(S.selectedSkill, 1);
  S.selectedSkill = Math.min(S.selectedSkill, S.gameSkills.length - 1);
  renderSkillList(); renderSkillForm();
}

export async function saveSkills() {
  const seen = new Set();
  for (const s of S.gameSkills) {
    if (!s.id || s.id <= 0) { setStatus('技能 ID 必须为正整数'); return false; }
    if (seen.has(s.id)) { setStatus(`技能 ID 重复：#${s.id}`); return false; }
    seen.add(s.id);
  }
  try {
    const payload = { starterSkills: S.gameStarterSkills, skills: S.gameSkills };
    const j = await authedPost('/api/skills/edit', { token: S.token, skills: payload });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 数据加载（汇总）
// ============================================================================
export async function loadGameData() {
  try {
    const r = await fetch(BASE + '/api/gamedata');
    const jd = await r.json();
    if (jd && jd.ok) {
      S.gameItems = Array.isArray(jd.items) ? jd.items : [];
      S.gameCreatures = (jd.monsters && typeof jd.monsters === 'object') ? jd.monsters : {};
      S.gameNpcs = (jd.npcs && typeof jd.npcs === 'object') ? jd.npcs : {};
      S.gameEnhance = (jd.enhance && typeof jd.enhance === 'object') ? jd.enhance
        : { maxLevel: 15, stoneItemId: 4006, protectStoneItemId: 4007, attrPerLevelAtk: 0.08, attrPerLevelDef: 0.06, attrPerLevelHp: 0.05, levels: [] };
      if (!Array.isArray(S.gameEnhance.levels)) S.gameEnhance.levels = [];
      S.gameDecompose = (jd.decompose && typeof jd.decompose === 'object') ? jd.decompose : { stoneItemId: 4006, rules: [] };
      if (!Array.isArray(S.gameDecompose.rules)) S.gameDecompose.rules = [];
      S.gameCraft = (jd.craft && Array.isArray(jd.craft.recipes)) ? jd.craft.recipes : [];
      S.gameShops = (jd.shops && typeof jd.shops === 'object') ? jd.shops : {};
      // 技能配置
      if (jd.skills && typeof jd.skills === 'object') {
        S.gameSkills = Array.isArray(jd.skills.skills) ? jd.skills.skills : [];
        S.gameStarterSkills = Array.isArray(jd.skills.starterSkills) ? jd.skills.starterSkills : [];
      }
    }
  } catch (e) {}
  S.selectedItem = S.gameItems.length ? 0 : -1;
  const ckeys = Object.keys(S.gameCreatures);
  S.selectedCreature = ckeys.length ? ckeys[0] : '';
  const nkeys = Object.keys(S.gameNpcs);
  S.selectedNpc = nkeys.length ? nkeys[0] : '';
  S.selectedCraft = S.gameCraft.length ? 0 : -1;
  const skeys = Object.keys(S.gameShops);
  S.selectedShop = skeys.length ? skeys[0] : '';
  S.selectedSkill = S.gameSkills.length ? 0 : -1;
  initCollapsedAll(S.collapsedEnhanceLevels, (S.gameEnhance && S.gameEnhance.levels) ? S.gameEnhance.levels.length : 0);
  initCollapsedAll(S.collapsedDecompRules, (S.gameDecompose && S.gameDecompose.rules) ? S.gameDecompose.rules.length : 0);
  renderItemList(); renderItemForm();
  renderCreatureList(); renderCreatureForm();
  renderNpcList(); renderNpcForm();
  renderEnhanceForm();
  renderDecomposeForm();
  renderCraftList(); renderCraftForm();
  renderShopList(); renderShopForm();
  renderSkillList(); renderSkillForm();
}
