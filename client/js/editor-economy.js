/**
 * editor-economy.js — 强化 + 分解 + 合成 + 商店 编辑管理
 * 依赖注入：由 editor.js 调用 configure() 传入共享依赖。
 */
import { S, BASE, RARITY_NAMES, SHOP_CATS, SHOP_REFRESH, esc, openNewModal, reindexCollapsedSet, initCollapsedAll } from './editor-state.js';

let $, authedPost, setStatus, itemOptionsHtml;

export function configure(deps) {
  $ = deps.$;
  authedPost = deps.authedPost;
  setStatus = deps.setStatus;
  itemOptionsHtml = deps.itemOptionsHtml;
}

// ============================================================================
// 强化：全局 + 等级表
// ============================================================================
function setEnhanceFormEnabled(on) {
  ['en-maxLevel','en-stoneItemId','en-protectStoneItemId','en-attrPerLevelAtk','en-attrPerLevelDef','en-attrPerLevelHp'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ab = $('btn-en-addlevel'); if (ab) ab.disabled = !on;
}

export function renderEnhanceForm() {
  if (!S.gameEnhance) { setEnhanceFormEnabled(false); return; }
  setEnhanceFormEnabled(true);
  $('en-maxLevel').value = S.gameEnhance.maxLevel || 0;
  $('en-stoneItemId').value = S.gameEnhance.stoneItemId || 0;
  $('en-protectStoneItemId').value = S.gameEnhance.protectStoneItemId || 0;
  $('en-attrPerLevelAtk').value = S.gameEnhance.attrPerLevelAtk || 0;
  $('en-attrPerLevelDef').value = S.gameEnhance.attrPerLevelDef || 0;
  $('en-attrPerLevelHp').value = S.gameEnhance.attrPerLevelHp || 0;
  renderEnhanceLevels();
}

export function renderEnhanceLevels() {
  const box = $('en-levels'); box.innerHTML = '';
  const levels = (S.gameEnhance && Array.isArray(S.gameEnhance.levels)) ? S.gameEnhance.levels : [];
  $('en-level-count').textContent = levels.length;
  if (!levels.length) { box.innerHTML = '<div class="cfg-empty">暂无等级，点"添加等级"</div>'; return; }
  levels.forEach((lv, i) => {
    const collapsed = S.collapsedEnhanceLevels.has(i);
    const card = document.createElement('div');
    card.className = 'en-level-card';
    const head = document.createElement('div');
    head.className = 'en-level-head';
    const headLeft = document.createElement('div');
    headLeft.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0';
    const arrow = document.createElement('span');
    arrow.className = 'collapse-arrow' + (collapsed ? '' : ' open');
    arrow.textContent = '▶';
    const title = document.createElement('span');
    title.className = 'en-level-title';
    title.textContent = 'Lv ' + (i + 1);
    headLeft.appendChild(arrow); headLeft.appendChild(title);
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除该级';
    del.addEventListener('click', (e) => { e.stopPropagation(); levels.splice(i, 1); reindexCollapsedSet(S.collapsedEnhanceLevels, i); renderEnhanceLevels(); });
    head.appendChild(headLeft); head.appendChild(del);
    head.addEventListener('click', () => {
      if (S.collapsedEnhanceLevels.has(i)) S.collapsedEnhanceLevels.delete(i); else S.collapsedEnhanceLevels.add(i);
      renderEnhanceLevels();
    });
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'en-level-body' + (collapsed ? ' hidden' : '');
    const form = document.createElement('div');
    form.className = 'cfg-form';
    const mkField = (label, key, step, isInt) => {
      const row = document.createElement('div');
      row.className = 'cfg-field';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step;
      inp.value = lv[key] != null ? lv[key] : 0;
      inp.addEventListener('input', () => { const v = isInt ? parseInt(inp.value, 10) : parseFloat(inp.value); lv[key] = isNaN(v) ? 0 : v; });
      row.appendChild(lbl); row.appendChild(inp);
      return row;
    };
    form.appendChild(mkField('成功率', 'successRate', '0.01', false));
    form.appendChild(mkField('金币', 'goldCost', '1', true));
    form.appendChild(mkField('石ID', 'stoneItemId', '1', true));
    form.appendChild(mkField('石数', 'stoneCount', '1', true));
    form.appendChild(mkField('降级', 'failDegrade', '1', true));
    const protRow = document.createElement('div');
    protRow.className = 'cfg-field';
    const protLbl = document.createElement('label');
    protLbl.textContent = '保护符';
    const protCb = document.createElement('input');
    protCb.type = 'checkbox'; protCb.checked = !!lv.canProtect;
    protCb.addEventListener('change', () => { lv.canProtect = protCb.checked; });
    const protHint = document.createElement('span');
    protHint.style.cssText = 'font-size:11px;color:#888';
    protHint.textContent = '勾选后降級时可用保护符防降';
    protRow.appendChild(protLbl); protRow.appendChild(protCb); protRow.appendChild(protHint);
    form.appendChild(protRow);
    body.appendChild(form);
    card.appendChild(body);
    box.appendChild(card);
  });
}

export function addEnhanceLevel() {
  if (!S.gameEnhance) return;
  if (!Array.isArray(S.gameEnhance.levels)) S.gameEnhance.levels = [];
  const newIdx = S.gameEnhance.levels.length;
  S.gameEnhance.levels.push({ level: newIdx + 1, successRate: 1, goldCost: 0, stoneItemId: S.gameEnhance.stoneItemId || 4006, stoneCount: 1, failDegrade: 0, canProtect: false });
  S.collapsedEnhanceLevels.add(newIdx);
  S.gameEnhance.maxLevel = S.gameEnhance.levels.length;
  renderEnhanceForm();
}

export function bindEnhanceForm() {
  const num = (id, key, isInt) => {
    const el = $(id); if (!el) return;
    el.addEventListener('input', () => { if (!S.gameEnhance) return; const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value); S.gameEnhance[key] = isNaN(v) ? 0 : v; });
  };
  num('en-maxLevel', 'maxLevel', true);
  num('en-stoneItemId', 'stoneItemId', true);
  num('en-protectStoneItemId', 'protectStoneItemId', true);
  num('en-attrPerLevelAtk', 'attrPerLevelAtk', false);
  num('en-attrPerLevelDef', 'attrPerLevelDef', false);
  num('en-attrPerLevelHp', 'attrPerLevelHp', false);
}

export async function saveEnhance() {
  if (!S.gameEnhance || !Array.isArray(S.gameEnhance.levels) || !S.gameEnhance.levels.length) { setStatus('强化等级表不能为空'); return false; }
  try {
    const j = await authedPost('/api/enhance_edit', { token: S.token, enhance: S.gameEnhance });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 分解：全局 + 品质规则
// ============================================================================
export function renderDecomposeForm() {
  if (!S.gameDecompose) { $('de-stoneItemId').disabled = true; $('btn-de-addrule').disabled = true; return; }
  $('de-stoneItemId').disabled = false; $('btn-de-addrule').disabled = false;
  $('de-stoneItemId').value = S.gameDecompose.stoneItemId || 0;
  renderDecomposeRules();
}

export function renderDecomposeRules() {
  const box = $('de-rules'); box.innerHTML = '';
  const rules = (S.gameDecompose && Array.isArray(S.gameDecompose.rules)) ? S.gameDecompose.rules : [];
  $('de-rule-count').textContent = rules.length;
  if (!rules.length) { box.innerHTML = '<div class="cfg-empty">暂无规则，点"添加品质档"</div>'; return; }
  rules.forEach((r, i) => {
    if (!Array.isArray(r.results)) r.results = [];
    const collapsed = S.collapsedDecompRules.has(i);
    const wrap = document.createElement('div'); wrap.className = 'de-rule';
    const head = document.createElement('div'); head.className = 'en-level-head';
    const headLeft = document.createElement('div');
    headLeft.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0';
    const arrow = document.createElement('span');
    arrow.className = 'collapse-arrow' + (collapsed ? '' : ' open');
    arrow.textContent = '▶';
    const rar = document.createElement('select'); rar.className = 'de-rar-select';
    for (let k = 0; k < RARITY_NAMES.length; k++) {
      const opt = document.createElement('option'); opt.value = String(k); opt.textContent = k + ' - ' + RARITY_NAMES[k];
      if ((r.rarity | 0) === k) opt.selected = true;
      rar.appendChild(opt);
    }
    rar.addEventListener('change', () => { r.rarity = parseInt(rar.value, 10) || 0; });
    rar.addEventListener('click', (e) => e.stopPropagation());
    rar.addEventListener('mousedown', (e) => e.stopPropagation());
    headLeft.appendChild(arrow); headLeft.appendChild(rar);
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除该档';
    del.addEventListener('click', (e) => { e.stopPropagation(); rules.splice(i, 1); reindexCollapsedSet(S.collapsedDecompRules, i); renderDecomposeRules(); });
    head.appendChild(headLeft); head.appendChild(del);
    head.addEventListener('click', () => {
      if (S.collapsedDecompRules.has(i)) S.collapsedDecompRules.delete(i); else S.collapsedDecompRules.add(i);
      renderDecomposeRules();
    });
    wrap.appendChild(head);
    const body = document.createElement('div');
    body.className = 'cfg-form' + (collapsed ? ' hidden' : '');
    const mkField = (label, key, step, def) => {
      const row = document.createElement('div'); row.className = 'cfg-field';
      const lbl = document.createElement('label'); lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step;
      inp.value = r[key] != null ? r[key] : def;
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); r[key] = isNaN(v) ? 0 : v; });
      row.appendChild(lbl); row.appendChild(inp);
      return row;
    };
    body.appendChild(mkField('金币率', 'goldReturnRate', '0.01', 0.3));
    body.appendChild(mkField('石系数', 'enhanceStoneRate', '0.01', 0.5));
    r.results.forEach((res, ri) => {
      const mcard = document.createElement('div'); mcard.className = 'de-mat-card';
      const mhead = document.createElement('div'); mhead.className = 'de-mat-head';
      const mtitle = document.createElement('span'); mtitle.className = 'de-mat-title'; mtitle.textContent = '材料 ' + (ri + 1);
      const mdel = document.createElement('button');
      mdel.className = 'sp-del'; mdel.textContent = '✕'; mdel.title = '删除材料';
      mdel.addEventListener('click', () => { r.results.splice(ri, 1); renderDecomposeRules(); });
      mhead.appendChild(mtitle); mhead.appendChild(mdel);
      mcard.appendChild(mhead);
      const mform = document.createElement('div'); mform.className = 'cfg-form';
      const itemRow = document.createElement('div'); itemRow.className = 'cfg-field';
      const itemLbl = document.createElement('label'); itemLbl.textContent = '物品';
      const sel = document.createElement('select');
      sel.innerHTML = itemOptionsHtml(res.itemId | 0);
      sel.addEventListener('change', () => { res.itemId = parseInt(sel.value, 10) || 0; });
      itemRow.appendChild(itemLbl); itemRow.appendChild(sel);
      mform.appendChild(itemRow);
      const minRow = document.createElement('div'); minRow.className = 'cfg-field';
      const minLbl = document.createElement('label'); minLbl.textContent = '最小';
      const minInp = document.createElement('input');
      minInp.type = 'number'; minInp.min = '1'; minInp.step = '1'; minInp.value = res.minCount || 1;
      minInp.addEventListener('input', () => { res.minCount = parseInt(minInp.value, 10) || 1; });
      minRow.appendChild(minLbl); minRow.appendChild(minInp);
      mform.appendChild(minRow);
      const maxRow = document.createElement('div'); maxRow.className = 'cfg-field';
      const maxLbl = document.createElement('label'); maxLbl.textContent = '最大';
      const maxInp = document.createElement('input');
      maxInp.type = 'number'; maxInp.min = '1'; maxInp.step = '1'; maxInp.value = res.maxCount || 1;
      maxInp.addEventListener('input', () => { res.maxCount = parseInt(maxInp.value, 10) || 1; });
      maxRow.appendChild(maxLbl); maxRow.appendChild(maxInp);
      mform.appendChild(maxRow);
      const probRow = document.createElement('div'); probRow.className = 'cfg-field';
      const probLbl = document.createElement('label'); probLbl.textContent = '概率';
      const probInp = document.createElement('input');
      probInp.type = 'number'; probInp.min = '0'; probInp.max = '1'; probInp.step = '0.01';
      probInp.value = res.prob != null ? res.prob : 1;
      probInp.addEventListener('input', () => { const v = parseFloat(probInp.value); res.prob = isNaN(v) ? 0 : v; });
      const probHint = document.createElement('span');
      probHint.style.cssText = 'font-size:11px;color:#888';
      probHint.textContent = '0~1';
      probRow.appendChild(probLbl); probRow.appendChild(probInp); probRow.appendChild(probHint);
      mform.appendChild(probRow);
      mcard.appendChild(mform);
      body.appendChild(mcard);
    });
    const madd = document.createElement('button');
    madd.className = 'btn btn-ghost de-mat-add'; madd.textContent = '＋ 材料';
    madd.addEventListener('click', () => { r.results.push({ itemId: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, minCount: 1, maxCount: 1, prob: 1 }); renderDecomposeRules(); });
    body.appendChild(madd);
    wrap.appendChild(body);
    box.appendChild(wrap);
  });
}

export function addDecomposeRule() {
  if (!S.gameDecompose) return;
  if (!Array.isArray(S.gameDecompose.rules)) S.gameDecompose.rules = [];
  const newIdx = S.gameDecompose.rules.length;
  S.gameDecompose.rules.push({ rarity: newIdx, goldReturnRate: 0.3, enhanceStoneRate: 0.5, results: [] });
  S.collapsedDecompRules.add(newIdx);
  renderDecomposeRules();
}

export function bindDecomposeForm() {
  const el = $('de-stoneItemId'); if (!el) return;
  el.addEventListener('input', () => { if (!S.gameDecompose) return; const v = parseInt(el.value, 10); S.gameDecompose.stoneItemId = isNaN(v) ? 0 : v; });
}

export async function saveDecompose() {
  if (!S.gameDecompose || !Array.isArray(S.gameDecompose.rules) || !S.gameDecompose.rules.length) { setStatus('分解规则不能为空'); return false; }
  try {
    const j = await authedPost('/api/decompose/edit', { token: S.token, decompose: S.gameDecompose });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 合成：配方列表 + 表单 + 材料子表
// ============================================================================
export function renderCraftList() {
  const q = S.craftSearchText.toLowerCase();
  const filtered = q ? S.gameCraft.filter(r => (r.name || '').toLowerCase().includes(q) || String(r.recipeId).includes(q)) : S.gameCraft;
  $('craft-count-label').textContent = S.gameCraft.length;
  const box = $('craft-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配配方' : '暂无配方，点"新建"添加'}</div>`; return; }
  filtered.forEach((r) => {
    const realIdx = S.gameCraft.indexOf(r);
    const div = document.createElement('div');
    div.className = 'cfg-item' + (realIdx === S.selectedCraft ? ' sel' : '');
    const hidden = r.hidden ? ' 🔒' : '';
    div.innerHTML = `<span class="cfg-ico">⚗</span><span class="cfg-nm">${esc(r.name) || '(未命名)'}</span><span class="cfg-id">#${r.recipeId}${hidden}</span>`;
    div.addEventListener('click', () => { S.selectedCraft = realIdx; renderCraftList(); renderCraftForm(); });
    box.appendChild(div);
  });
}

function setCraftFormEnabled(on) {
  ['cf-recipeId','cf-levelReq','cf-name','cf-npcTag','cf-resultItemId','cf-resultCount','cf-goldCost','cf-hidden'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ma = $('btn-cf-mat-add'); if (ma) ma.disabled = !on;
}

export function renderCraftForm() {
  const r = S.gameCraft[S.selectedCraft];
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

export function renderCraftMaterials() {
  const r = S.gameCraft[S.selectedCraft];
  const box = $('cf-materials'); box.innerHTML = '';
  if (!r) return;
  if (!Array.isArray(r.materials)) r.materials = [];
  const mats = r.materials;
  $('cf-mat-count').textContent = mats.length;
  if (!mats.length) { box.innerHTML = '<div class="cfg-empty">无材料，点"添加材料"</div>'; return; }
  mats.forEach((m, i) => {
    const card = document.createElement('div'); card.className = 'de-mat-card';
    const head = document.createElement('div'); head.className = 'de-mat-head';
    const title = document.createElement('span'); title.className = 'de-mat-title'; title.textContent = '材料 ' + (i + 1);
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', () => { mats.splice(i, 1); renderCraftMaterials(); });
    head.appendChild(title); head.appendChild(del);
    card.appendChild(head);
    const form = document.createElement('div'); form.className = 'cfg-form';
    const itemRow = document.createElement('div'); itemRow.className = 'cfg-field';
    const itemLbl = document.createElement('label'); itemLbl.textContent = '物品';
    const sel = document.createElement('select');
    sel.innerHTML = itemOptionsHtml(m.itemId | 0);
    sel.addEventListener('change', () => { m.itemId = parseInt(sel.value, 10) || 0; });
    itemRow.appendChild(itemLbl); itemRow.appendChild(sel);
    form.appendChild(itemRow);
    const cntRow = document.createElement('div'); cntRow.className = 'cfg-field';
    const cntLbl = document.createElement('label'); cntLbl.textContent = '数量';
    const cnt = document.createElement('input');
    cnt.type = 'number'; cnt.min = '1'; cnt.step = '1'; cnt.value = m.count || 1;
    cnt.addEventListener('input', () => { m.count = parseInt(cnt.value, 10) || 1; });
    cntRow.appendChild(cntLbl); cntRow.appendChild(cnt);
    form.appendChild(cntRow);
    card.appendChild(form);
    box.appendChild(card);
  });
}

export function addCraftMaterial() {
  const r = S.gameCraft[S.selectedCraft];
  if (!r) { setStatus('请先选择配方'); return; }
  if (!Array.isArray(r.materials)) r.materials = [];
  r.materials.push({ itemId: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, count: 1 });
  renderCraftMaterials();
}

export function bindCraftForm() {
  const r = () => S.gameCraft[S.selectedCraft];
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

export function newCraft() {
  let maxId = 0;
  for (const r of S.gameCraft) if ((r.recipeId | 0) > maxId) maxId = r.recipeId | 0;
  openNewModal($, '新建合成配方', [
    { key: 'id', label: '配方ID', type: 'number', value: maxId + 1, min: 1, step: 1 },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'levelReq', label: '等级需', type: 'number', value: 1, min: 1, step: 1 },
  ], (v) => {
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    if (S.gameCraft.some(r => (r.recipeId | 0) === v.id)) { setStatus(`配方 ID ${v.id} 已存在`); return; }
    S.gameCraft.push({ recipeId: v.id, name: v.name, npcTag: 64, resultItemId: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, resultCount: 1, goldCost: 0, levelReq: v.levelReq, hidden: false, materials: [] });
    S.selectedCraft = S.gameCraft.length - 1;
    renderCraftList(); renderCraftForm();
  });
}

export function deleteCraft() {
  if (S.selectedCraft < 0 || S.selectedCraft >= S.gameCraft.length) { setStatus('请先选择要删除的配方'); return; }
  const r = S.gameCraft[S.selectedCraft];
  if (!confirm(`删除配方 #${r.recipeId}「${r.name}」？`)) return;
  S.gameCraft.splice(S.selectedCraft, 1);
  S.selectedCraft = Math.min(S.selectedCraft, S.gameCraft.length - 1);
  renderCraftList(); renderCraftForm();
}

export async function saveCraft() {
  const seen = new Set();
  for (const r of S.gameCraft) {
    if (!r.recipeId || r.recipeId <= 0) { setStatus('配方 ID 必须为正整数'); return false; }
    if (seen.has(r.recipeId)) { setStatus(`配方 ID 重复：#${r.recipeId}`); return false; }
    seen.add(r.recipeId);
    if (!r.resultItemId) { setStatus(`配方 #${r.recipeId} 未设置产物`); return false; }
  }
  try {
    const j = await authedPost('/api/craft/edit', { token: S.token, craft: { recipes: S.gameCraft } });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

// ============================================================================
// 商店：列表 + 表单 + 条目子表
// ============================================================================
export function renderShopList() {
  const q = S.shopSearchText.toLowerCase();
  const allKeys = Object.keys(S.gameShops);
  const filtered = q ? allKeys.filter(sid => { const s = S.gameShops[sid]; return (s.name || '').toLowerCase().includes(q) || sid.includes(q); }) : allKeys;
  $('shop-count-label').textContent = allKeys.length;
  const box = $('shop-list'); box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = `<div class="cfg-empty">${q ? '无匹配商店' : '暂无商店，点"新建"添加'}</div>`; return; }
  filtered.forEach((sid) => {
    const s = S.gameShops[sid];
    const div = document.createElement('div');
    div.className = 'cfg-item' + (sid === S.selectedShop ? ' sel' : '');
    div.innerHTML = `<span class="cfg-ico">🛒</span><span class="cfg-nm">${esc(s.name) || '(未命名)'}</span><span class="cfg-id">#${sid} · ${(s.entries || []).length}件</span>`;
    div.addEventListener('click', () => { S.selectedShop = sid; renderShopList(); renderShopForm(); });
    box.appendChild(div);
  });
}

function setShopFormEnabled(on) {
  ['sh-shopId','sh-name','sh-desc','sh-shopType','sh-currencyItemId'].forEach((id) => { const el = $(id); if (el) el.disabled = !on; });
  const ea = $('btn-sh-entry-add'); if (ea) ea.disabled = !on;
}

export function renderShopForm() {
  const s = S.gameShops[S.selectedShop];
  if (!s) {
    $('shop-form').style.opacity = '0.4'; setShopFormEnabled(false);
    $('sh-entries').innerHTML = '<div class="cfg-empty">选择或新建商店</div>'; $('sh-entry-count').textContent = '0';
    return;
  }
  $('shop-form').style.opacity = '1'; setShopFormEnabled(true);
  $('sh-shopId').value = S.selectedShop;
  $('sh-name').value = s.name || '';
  $('sh-desc').value = s.desc || '';
  $('sh-shopType').value = String(s.shopType || 0);
  $('sh-currencyItemId').value = s.currencyItemId || 0;
  initCollapsedAll(S.collapsedShopEntries, (s.entries || []).length);
  renderShopEntries();
}

export function renderShopEntries() {
  const s = S.gameShops[S.selectedShop];
  const box = $('sh-entries'); box.innerHTML = '';
  if (!s) return;
  if (!Array.isArray(s.entries)) s.entries = [];
  const entries = s.entries;
  $('sh-entry-count').textContent = entries.length;
  if (!entries.length) { box.innerHTML = '<div class="cfg-empty">无商品，点"添加商品"</div>'; return; }
  entries.forEach((e, i) => {
    const collapsed = S.collapsedShopEntries.has(i);
    const wrap = document.createElement('div'); wrap.className = 'de-rule';
    const head = document.createElement('div'); head.className = 'en-level-head';
    const headLeft = document.createElement('div');
    headLeft.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0';
    const arrow = document.createElement('span');
    arrow.className = 'collapse-arrow' + (collapsed ? '' : ' open');
    arrow.textContent = '▶';
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;min-width:0;font-size:12px;padding:3px 4px;border:1px solid #d8dae0;border-radius:4px';
    sel.innerHTML = itemOptionsHtml(e.item | 0);
    sel.addEventListener('change', () => { e.item = parseInt(sel.value, 10) || 0; });
    sel.addEventListener('click', (e2) => e2.stopPropagation());
    sel.addEventListener('mousedown', (e2) => e2.stopPropagation());
    headLeft.appendChild(arrow); headLeft.appendChild(sel);
    const del = document.createElement('button');
    del.className = 'sp-del'; del.textContent = '✕'; del.title = '删除商品';
    del.addEventListener('click', (e2) => { e2.stopPropagation(); entries.splice(i, 1); reindexCollapsedSet(S.collapsedShopEntries, i); renderShopEntries(); renderShopList(); });
    head.appendChild(headLeft); head.appendChild(del);
    head.addEventListener('click', () => {
      if (S.collapsedShopEntries.has(i)) S.collapsedShopEntries.delete(i); else S.collapsedShopEntries.add(i);
      renderShopEntries();
    });
    wrap.appendChild(head);
    const form = document.createElement('div');
    form.className = 'cfg-form' + (collapsed ? ' hidden' : '');
    const mkNum = (label, key, def) => {
      const row = document.createElement('div'); row.className = 'cfg-field';
      const lbl = document.createElement('label'); lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1';
      inp.value = e[key] != null ? e[key] : def;
      inp.addEventListener('input', () => { e[key] = parseInt(inp.value, 10) || 0; });
      row.appendChild(lbl); row.appendChild(inp);
      return row;
    };
    form.appendChild(mkNum('原价', 'price', 0));
    form.appendChild(mkNum('折扣', 'discountPrice', 0));
    form.appendChild(mkNum('库存', 'stock', 0));
    form.appendChild(mkNum('限购', 'buyLimit', 0));
    form.appendChild(mkNum('回收', 'sellPrice', 0));
    const catRow = document.createElement('div'); catRow.className = 'cfg-field';
    const catLbl = document.createElement('label'); catLbl.textContent = '分类';
    const cat = document.createElement('select');
    SHOP_CATS.forEach((n, k) => { const opt = document.createElement('option'); opt.value = String(k); opt.textContent = n; if ((e.category | 0) === k) opt.selected = true; cat.appendChild(opt); });
    cat.addEventListener('change', () => { e.category = parseInt(cat.value, 10) || 0; });
    catRow.appendChild(catLbl); catRow.appendChild(cat);
    form.appendChild(catRow);
    const refRow = document.createElement('div'); refRow.className = 'cfg-field';
    const refLbl = document.createElement('label'); refLbl.textContent = '刷新';
    const ref = document.createElement('select');
    SHOP_REFRESH.forEach((n, k) => { const opt = document.createElement('option'); opt.value = String(k); opt.textContent = n; if ((e.refreshType | 0) === k) opt.selected = true; ref.appendChild(opt); });
    ref.addEventListener('change', () => { e.refreshType = parseInt(ref.value, 10) || 0; });
    refRow.appendChild(refLbl); refRow.appendChild(ref);
    form.appendChild(refRow);
    wrap.appendChild(form);
    box.appendChild(wrap);
  });
}

export function addShopEntry() {
  const s = S.gameShops[S.selectedShop];
  if (!s) { setStatus('请先选择商店'); return; }
  if (!Array.isArray(s.entries)) s.entries = [];
  const newIdx = s.entries.length;
  s.entries.push({ item: S.gameItems.length ? (S.gameItems[0].id | 0) : 0, price: 0, discountPrice: 0, stock: 0, buyLimit: 0, category: 0, refreshType: 0, sellPrice: 0 });
  S.collapsedShopEntries.add(newIdx);
  renderShopEntries(); renderShopList();
}

export function bindShopForm() {
  const s = () => S.gameShops[S.selectedShop];
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
    const oldId = S.selectedShop;
    const o = S.gameShops[oldId]; if (!o) return;
    const nid = parseInt(idEl.value, 10) || 0;
    if (nid <= 0) { idEl.value = oldId; setStatus('商店 ID 必须为正整数'); return; }
    const newId = String(nid);
    if (newId === oldId) return;
    if (S.gameShops[newId]) { idEl.value = oldId; setStatus(`商店 ID 已存在：${newId}`); return; }
    const rebuilt = {};
    for (const k of Object.keys(S.gameShops)) { if (k === oldId) rebuilt[newId] = o; else rebuilt[k] = S.gameShops[k]; }
    S.gameShops = rebuilt;
    S.selectedShop = newId;
    renderShopList();
  });
}

export function newShop() {
  let maxId = 0;
  for (const k of Object.keys(S.gameShops)) { const v = parseInt(k, 10) || 0; if (v > maxId) maxId = v; }
  openNewModal($, '新建商店', [
    { key: 'id', label: '商店ID', type: 'number', value: maxId + 1, min: 1, step: 1 },
    { key: 'name', label: '名称', type: 'text', value: '' },
    { key: 'shopType', label: '类型', type: 'select', options: [
      { value: '0', text: '普通', selected: true },
      { value: '1', text: '限时' },
      { value: '2', text: '声望' },
      { value: '3', text: '货币兑换' },
    ]},
  ], (v) => {
    const sid = String(v.id | 0);
    if (v.id <= 0) { setStatus('商店 ID 必须为正整数'); return; }
    if (!v.name.trim()) { setStatus('名称不能为空'); return; }
    if (S.gameShops[sid]) { setStatus(`商店 ID ${sid} 已存在`); return; }
    S.gameShops[sid] = { name: v.name, desc: '', shopType: parseInt(v.shopType, 10) || 0, currencyItemId: 0, entries: [] };
    S.selectedShop = sid;
    renderShopList(); renderShopForm();
  });
}

export function deleteShop() {
  if (!S.selectedShop || !S.gameShops[S.selectedShop]) { setStatus('请先选择要删除的商店'); return; }
  if (!confirm(`删除商店「${S.gameShops[S.selectedShop].name}」(#${S.selectedShop})？`)) return;
  delete S.gameShops[S.selectedShop];
  const keys = Object.keys(S.gameShops);
  S.selectedShop = keys.length ? keys[0] : '';
  renderShopList(); renderShopForm();
}

export async function saveShops() {
  for (const sid of Object.keys(S.gameShops)) {
    if (!sid || (parseInt(sid, 10) || 0) <= 0) { setStatus('商店 ID 必须为正整数'); return false; }
  }
  try {
    const j = await authedPost('/api/shop/edit', { token: S.token, shops: S.gameShops });
    if (j && j.error) setStatus('保存失败：' + j.error);
    return !!(j && j.ok);
  } catch (e) { return false; }
}
