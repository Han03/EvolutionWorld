/**
 * boot-panels.js — UI 面板：背包/装备/商店/强化/分解/合成/仓库
 * 依赖注入：由 boot.js 调用 configure() 传入共享依赖。
 */
import { S, ENHANCE_FAIL_TEXT, DECOMPOSE_FAIL_TEXT, CRAFT_FAIL_TEXT, WH_OP, WH_FAIL_TEXT, SHOP_CAT_NAME, toast, renderHud } from './boot-state.js';
import { itemDef, itemName, typeName, itemDesc, SLOT_NAME, rarityColor, rarityName, itemRarity, enhanceConfig, enhanceLevelDef, enhanceMultiplier, decomposeConfig, decomposeRule, craftRecipe, warehouseConfig, warehouseExpandCost } from './items.js';
import { NPC_TAG } from './protocol.js';

let $, net;

export function configure(deps) {
  $ = deps.$;
  net = deps.net;
}

// ============================================================================
// 背包 / 装备
// ============================================================================
export function toggleInventoryPanel() {
  const p = $('inventory-panel');
  if (!p) return;
  const hidden = p.classList.contains('hidden');
  p.classList.toggle('hidden', !hidden);
  if (!hidden) { closeShopPanel(); }
  if (p.classList.contains('hidden') === false) renderInventory();
}
export function closeInventoryPanel() { const p = $('inventory-panel'); if (p) p.classList.add('hidden'); }
export function closeShopPanel() { const p = $('shop-panel'); if (p) p.classList.add('hidden'); }

function entryCat(e) {
  if (e.category > 0) return e.category;
  const t = itemDef(e.itemId).type;
  if (t === 'equip') return 1;
  if (t === 'consumable') return 2;
  if (t === 'material') return 3;
  return 4;
}

export function renderInventory() {
  const grid = $('inv-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const ids = Object.keys(S.inventory).map(Number).sort((a, b) => a - b);
  if (!S.equipBag.length && !ids.length) {
    grid.innerHTML = '<div class="inv-empty">背包空空如也（击杀怪物拾取掉落物）</div>';
  }
  for (const ins of S.equipBag) {
    const d = itemDef(ins.itemId);
    const rc = rarityColor(ins.itemId);
    const enh = ins.enhance > 0 ? ` +${ins.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.style.borderColor = rc;
    cell.innerHTML = `
      ${ins.locked ? '<div class="item-lock" title="已锁定">🔒</div>' : ''}
      <div class="item-icon">${d.icon}</div>
      <div class="item-name" style="color:${rc}">${d.name}${enh}</div>
      <div class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}${d.levelReq > 1 ? '·Lv' + d.levelReq : ''}</div>
      <div class="item-actions">
        <button class="act-btn" data-act="equip" data-slot="${d.slot}" data-inst="${ins.instId}">穿戴</button>
        <button class="act-btn act-sell" data-act="sell">出售</button>
      </div>`;
    cell.title = '右键：穿戴/出售/分解/存仓库';
    cell.querySelector('[data-act="equip"]').addEventListener('click', (ev) => {
      const b = ev.currentTarget;
      net.sendEquip(Number(b.dataset.slot), Number(b.dataset.inst));
      toast('装备中…');
    });
    cell.querySelector('[data-act="sell"]').addEventListener('click', () => sellEquipInstance(ins));
    cell.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openInvMenu(ev.clientX, ev.clientY, [
        { icon: '🛡', label: '穿戴', fn: () => { net.sendEquip(d.slot, ins.instId); toast('装备中…'); } },
        { icon: '💰', label: '出售', fn: () => sellEquipInstance(ins) },
        { icon: '⚒', label: '分解', danger: true, fn: () => decomposeEquipInstance(ins) },
        { icon: '🏦', label: '存仓库', fn: () => depositEquipToWarehouse(ins) },
      ]);
    });
    grid.appendChild(cell);
  }
  for (const id of ids) {
    const cnt = S.inventory[id];
    const d = itemDef(id);
    const rc = rarityColor(id);
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.style.borderColor = rc;
    const sellable = d.type !== 'quest';
    cell.innerHTML = `
      <div class="item-icon">${d.icon}</div>
      <div class="item-cnt">×${cnt}</div>
      <div class="item-name" style="color:${rc}">${d.name}</div>
      <div class="item-sub">${typeName(d.type)}${d.levelReq > 1 ? '·Lv' + d.levelReq : ''}</div>
      <div class="item-actions">
        ${d.type === 'consumable' ? `<button class="act-btn" data-act="use" data-id="${id}">使用</button>` : ''}
        ${sellable ? `<button class="act-btn act-sell" data-act="sell" data-id="${id}">出售</button>` : ''}
      </div>`;
    const useBtn = cell.querySelector('[data-act="use"]');
    if (useBtn) useBtn.addEventListener('click', () => { net.sendUseItem(Number(useBtn.dataset.id), 1); toast('使用中…'); });
    const sellBtn = cell.querySelector('[data-act="sell"]');
    if (sellBtn) sellBtn.addEventListener('click', () => sellStackItem(id, 1));
    cell.title = '右键：使用/出售/存仓库';
    cell.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openInvMenu(ev.clientX, ev.clientY, [
        d.type === 'consumable' ? { icon: '🧪', label: '使用', fn: () => { net.sendUseItem(id, 1); toast('使用中…'); } } : null,
        sellable ? { icon: '💰', label: '出售', fn: () => sellStackItem(id, 1) } : null,
        { icon: '🏦', label: '存仓库', fn: () => depositStackToWarehouse(id, cnt) },
      ]);
    });
    grid.appendChild(cell);
  }
}

export function renderEquip() {
  const list = $('equip-list');
  if (!list) return;
  list.innerHTML = '';
  for (let slot = 1; slot <= 6; slot++) {
    const ins = S.equip[slot];
    const itemId = ins ? ins.itemId : 0;
    const enhance = ins ? ins.enhance : 0;
    const d = itemDef(itemId);
    const rc = itemId ? rarityColor(itemId) : '';
    const enh = enhance > 0 ? ` +${enhance}` : '';
    const row = document.createElement('div');
    row.className = 'equip-row' + (itemId ? ' filled' : '');
    row.innerHTML = `
      <span class="equip-slot">${SLOT_NAME[slot] || slot}</span>
      <span class="item-icon">${itemId ? d.icon : '—'}</span>
      <span class="equip-name"${rc ? ` style="color:${rc}"` : ''}>${itemId ? d.name + enh : '（空）'}</span>
      ${itemId ? `<button class="act-btn" data-slot="${slot}">卸下</button>` : ''}`;
    const btn = row.querySelector('.act-btn');
    if (btn) btn.addEventListener('click', () => { net.sendEquip(slot, 0); toast('已卸下'); });
    list.appendChild(row);
  }
}

function sellEquipInstance(ins) {
  if (!S.shopData) { toast('需在商店才能出售'); return; }
  if (ins.locked) { toast('已锁定，无法出售'); return; }
  net.sendShopSell(true, ins.instId, ins.itemId, 1);
}
function sellStackItem(itemId, count) {
  if (!S.shopData) { toast('需在商店才能出售'); return; }
  net.sendShopSell(false, 0, itemId, count || 1);
}
function decomposeEquipInstance(ins) {
  if (ins.locked) { toast('已锁定，无法分解', 'bad'); return; }
  net.sendDecompose(ins.instId);
}
function depositEquipToWarehouse(ins) { net.sendWarehouseDeposit(true, ins.instId, ins.itemId, 1); }
function depositStackToWarehouse(itemId, count) { net.sendWarehouseDeposit(false, 0, itemId, count || 1); }

// ---- 背包右键菜单 ----
export function closeInvMenu() { if (S.invMenuEl) { S.invMenuEl.remove(); S.invMenuEl = null; } }
function openInvMenu(x, y, actions) {
  closeInvMenu();
  const list = actions.filter((a) => !!a);
  if (!list.length) return;
  const m = document.createElement('div');
  m.className = 'inv-ctx-menu';
  for (const a of list) {
    const b = document.createElement('button');
    b.className = 'inv-ctx-item' + (a.danger ? ' danger' : '');
    b.innerHTML = `<span class="inv-ctx-icon">${a.icon || ''}</span><span>${a.label}</span>`;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); closeInvMenu(); a.fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = x, top = y;
  if (left + mw > window.innerWidth) left = Math.max(4, window.innerWidth - mw - 4);
  if (top + mh > window.innerHeight) top = Math.max(4, window.innerHeight - mh - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  S.invMenuEl = m;
}

// ============================================================================
// 商店
// ============================================================================
export function openShopPanel() {
  if (!S.shopData) return;
  const p = $('shop-panel');
  if (!p) return;
  closeInventoryPanel();
  p.classList.remove('hidden');
  $('shop-title').textContent = S.shopData.name || '商店';
  renderShopTabs();
  renderShopList();
}

function renderShopTabs() {
  const bar = $('shop-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const counts = {};
  for (const e of S.shopData.entries) { const c = entryCat(e); counts[c] = (counts[c] || 0) + 1; }
  if (S.shopCategory !== 0 && !counts[S.shopCategory]) S.shopCategory = 0;
  const cats = [0, 1, 2, 3, 4].filter((c) => c === 0 || counts[c]);
  for (const c of cats) {
    const btn = document.createElement('button');
    btn.className = 'shop-tab' + (c === S.shopCategory ? ' active' : '');
    const n = c === 0 ? S.shopData.entries.length : counts[c];
    btn.textContent = `${c === 0 ? '全部' : SHOP_CAT_NAME[c]} ${n}`;
    btn.addEventListener('click', () => { S.shopCategory = c; renderShopTabs(); renderShopList(); });
    bar.appendChild(btn);
  }
}

function renderShopList() {
  const list = $('shop-list');
  if (!list) return;
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  let shown = 0;
  for (const e of S.shopData.entries) {
    if (S.shopCategory !== 0 && entryCat(e) !== S.shopCategory) continue;
    shown++;
    const d = itemDef(e.itemId);
    const rc = rarityColor(e.itemId);
    const hasDiscount = e.discountPrice > 0 && e.discountPrice < e.price;
    const unit = hasDiscount ? e.discountPrice : e.price;
    const priceHtml = hasDiscount
      ? `<span class="price-old">${e.price}💰</span><span class="price-new">${e.discountPrice}💰</span>`
      : `<span class="price-new">${e.price}💰</span>`;
    const soldOut = e.buyLimit > 0 && (e.bought || 0) >= e.buyLimit;
    let limitHtml = '';
    if (e.buyLimit > 0) {
      const rf = e.refreshType === 1 ? '/日' : e.refreshType === 2 ? '/周' : '';
      limitHtml = `<span class="limit-badge${soldOut ? ' limit-max' : ''}">限购 ${e.bought || 0}/${e.buyLimit}${rf}</span>`;
    }
    const row = document.createElement('div');
    row.className = 'shop-item';
    row.innerHTML =
      `<span class="item-icon">${d.icon}</span>
       <span class="item-name" style="color:${rc}">${d.name}</span>
       <span class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}</span>
       <span class="item-desc">${itemDesc(e.itemId)}${limitHtml}</span>
       <span class="item-buy">${priceHtml}<button class="buy-btn"${soldOut ? ' disabled' : ''}>${soldOut ? '已达上限' : '购买'}</button></span>`;
    const btn = row.querySelector('.buy-btn');
    if (btn && !soldOut) {
      btn.addEventListener('click', () => {
        if (S.gold < unit) { toast('金币不足'); return; }
        net.sendShopBuy(e.itemId, 1);
      });
    }
    list.appendChild(row);
  }
  if (!shown) list.innerHTML = '<div class="shop-empty">该分类暂无商品</div>';
  list.scrollTop = keepScroll;
}

// ============================================================================
// 强化面板
// ============================================================================
export function collectEnhanceItems() {
  const out = [];
  for (let slot = 1; slot <= 6; slot++) {
    const ins = S.equip[slot];
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, where: '已穿戴' });
  }
  for (const ins of S.equipBag) {
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, where: '背包' });
  }
  return out;
}
function findEnhanceInstance(instId) {
  if (!instId) return null;
  for (let slot = 1; slot <= 6; slot++) {
    const ins = S.equip[slot];
    if (ins && ins.instId === instId) return ins;
  }
  for (const ins of S.equipBag) {
    if (ins && ins.instId === instId) return ins;
  }
  return null;
}

export function openEnhancePanel() {
  const p = $('enhance-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeCraftPanel();
  closeWarehousePanel();
  p.classList.remove('hidden');
  S.smithTab = 'enhance';
  if (!findEnhanceInstance(S.enhanceTargetInstId)) {
    const items = collectEnhanceItems();
    S.enhanceTargetInstId = items.length ? items[0].instId : 0;
    S.enhanceUseProtect = false;
  }
  applySmithTab();
  renderEnhanceList();
  renderEnhanceDetail();
}
export function closeEnhancePanel() { const p = $('enhance-panel'); if (p) p.classList.add('hidden'); }

export function switchSmithTab(tab) {
  S.smithTab = tab;
  applySmithTab();
  if (tab === 'decompose') {
    if (!findDecomposeInstance(S.decomposeTargetInstId)) {
      const items = collectDecomposeItems();
      S.decomposeTargetInstId = items.length ? items[0].instId : 0;
    }
    renderDecomposeList();
    renderDecomposeDetail();
  } else {
    if (!findEnhanceInstance(S.enhanceTargetInstId)) {
      const items = collectEnhanceItems();
      S.enhanceTargetInstId = items.length ? items[0].instId : 0;
      S.enhanceUseProtect = false;
    }
    renderEnhanceList();
    renderEnhanceDetail();
  }
}
function applySmithTab() {
  const te = $('smith-tab-enhance'), td = $('smith-tab-decompose');
  const be = $('enhance-body'), bd = $('decompose-body');
  if (te) te.classList.toggle('active', S.smithTab === 'enhance');
  if (td) td.classList.toggle('active', S.smithTab === 'decompose');
  if (be) be.classList.toggle('hidden', S.smithTab !== 'enhance');
  if (bd) bd.classList.toggle('hidden', S.smithTab !== 'decompose');
}

function selectEnhanceTarget(instId) {
  S.enhanceTargetInstId = instId;
  S.enhanceUseProtect = false;
  renderEnhanceList();
  renderEnhanceDetail();
}

export function renderEnhanceList() {
  const list = $('enhance-list');
  if (!list) return;
  list.innerHTML = '';
  const items = collectEnhanceItems();
  if (!items.length) { list.innerHTML = '<div class="enhance-hint">没有可强化的装备<br>（击败怪物或商店购买获取）</div>'; return; }
  for (const it of items) {
    const d = itemDef(it.itemId);
    const rc = rarityColor(it.itemId);
    const enh = it.enhance > 0 ? ` +${it.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'enh-item' + (it.instId === S.enhanceTargetInstId ? ' selected' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${enh}</span>
      <span class="enh-item-where">${it.where}</span>`;
    cell.addEventListener('click', () => selectEnhanceTarget(it.instId));
    list.appendChild(cell);
  }
}

export function renderEnhanceDetail() {
  const box = $('enhance-detail');
  if (!box) return;
  const ins = findEnhanceInstance(S.enhanceTargetInstId);
  if (!ins) { box.innerHTML = '<div class="enhance-hint">← 选择一件装备进行强化</div>'; return; }
  const cfg = enhanceConfig();
  const d = itemDef(ins.itemId);
  const rc = rarityColor(ins.itemId);
  const cur = ins.enhance || 0;
  const maxLevel = cfg ? cfg.maxLevel : 15;
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${cur > 0 ? ' +' + cur : ''}</span>
    </div>`;
  if (!cfg) { box.innerHTML = head + '<div class="enhance-hint">强化配置未加载</div>'; return; }
  if (cur >= maxLevel) { box.innerHTML = head + `<div class="enh-maxed">✦ 已达最高强化等级 +${maxLevel}</div>`; return; }
  const target = cur + 1;
  const def = enhanceLevelDef(target);
  if (!def) { box.innerHTML = head + '<div class="enhance-hint">该等级强化数据缺失</div>'; return; }
  const rate = Math.round((def.successRate || 0) * 100);
  const stoneId = cfg.stoneItemId || 4006;
  const protectId = cfg.protectStoneItemId || 4007;
  const stoneHave = S.inventory[stoneId] || 0;
  const stoneNeed = def.stoneCount || 0;
  const goldNeed = def.goldCost || 0;
  const protectHave = S.inventory[protectId] || 0;
  const canAfford = S.gold >= goldNeed && stoneHave >= stoneNeed;
  const attrRows = [];
  if (d.attackBonus) attrRows.push(attrPreviewRow('攻击', d.attackBonus, cur, target, 'atk'));
  if (d.defenseBonus) attrRows.push(attrPreviewRow('防御', d.defenseBonus, cur, target, 'def'));
  if (d.hpBonus) attrRows.push(attrPreviewRow('生命', d.hpBonus, cur, target, 'hp'));
  const attrHtml = attrRows.length ? `<div class="enh-attrs">${attrRows.join('')}</div>` : '';
  const degradeHtml = def.failDegrade < 0
    ? `<div class="enh-warn">⚠ 失败将降级 ${def.failDegrade} 级${def.canProtect ? '（保护符可防止）' : ''}</div>`
    : `<div class="enh-safe">✓ 失败不降级</div>`;
  let protectHtml = '';
  if (def.canProtect) {
    const dis = protectHave < 1 ? ' disabled' : '';
    protectHtml = `<label class="enh-protect"><input type="checkbox" id="enh-protect-chk"${S.enhanceUseProtect ? ' checked' : ''}${dis}> 使用保护符（持有 ${protectHave}）</label>`;
  }
  box.innerHTML = head + `
    <div class="enh-level">强化等级 <b>+${cur}</b> <span class="enh-arrow">→</span> <b class="enh-target">+${target}</b></div>
    <div class="enh-row"><span>成功率</span><b class="enh-rate${rate < 50 ? ' low' : ''}">${rate}%</b></div>
    <div class="enh-row"><span>金币</span><b class="${S.gold >= goldNeed ? '' : 'enh-lack'}">${goldNeed}💰 / 持有 ${S.gold}</b></div>
    <div class="enh-row"><span>强化石</span><b class="${stoneHave >= stoneNeed ? '' : 'enh-lack'}">${stoneNeed}🔩 / 持有 ${stoneHave}</b></div>
    ${attrHtml}
    ${degradeHtml}
    ${protectHtml}
    <button id="enh-do-btn" class="enh-do-btn"${canAfford ? '' : ' disabled'}>强化</button>`;
  const chk = $('enh-protect-chk');
  if (chk) chk.addEventListener('change', (e) => { S.enhanceUseProtect = e.target.checked; });
  const btn = $('enh-do-btn');
  if (btn) btn.addEventListener('click', () => { if (!canAfford) return; net.sendEnhance(S.enhanceTargetInstId, S.enhanceUseProtect); });
}

function attrPreviewRow(label, base, cur, target, attr) {
  const c = Math.round(base * enhanceMultiplier(cur, attr));
  const n = Math.round(base * enhanceMultiplier(target, attr));
  const up = n > c ? `<span class="enh-up">+${n - c}</span>` : '';
  return `<div class="enh-attr"><span>${label}</span><span>${c} → <b>${n}</b> ${up}</span></div>`;
}

export function handleEnhanceResult(msg) {
  if (msg.ok) {
    if (msg.success) toast(`强化成功！装备升至 +${msg.newLevel} ✨`, 'ok');
    else toast(`强化失败，装备降为 +${msg.newLevel}`, 'bad');
    S.gold = msg.goldLeft;
    renderHud();
  } else {
    toast(ENHANCE_FAIL_TEXT[msg.failCode] || '强化失败', 'bad');
  }
}

// ============================================================================
// 分解面板
// ============================================================================
export function collectDecomposeItems() {
  const out = [];
  for (const ins of S.equipBag) {
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, locked: !!ins.locked });
  }
  return out;
}
function findDecomposeInstance(instId) {
  if (!instId) return null;
  for (const ins of S.equipBag) { if (ins && ins.instId === instId) return ins; }
  return null;
}

function selectDecomposeTarget(instId) {
  S.decomposeTargetInstId = instId;
  renderDecomposeList();
  renderDecomposeDetail();
}

export function renderDecomposeList() {
  const list = $('decompose-list');
  if (!list) return;
  list.innerHTML = '';
  const items = collectDecomposeItems();
  if (!items.length) { list.innerHTML = '<div class="enhance-hint">背包中没有可分解的装备<br>（已穿戴的装备需先卸下）</div>'; return; }
  for (const it of items) {
    const d = itemDef(it.itemId);
    const rc = rarityColor(it.itemId);
    const enh = it.enhance > 0 ? ` +${it.enhance}` : '';
    const lock = it.locked ? ' 🔒' : '';
    const cell = document.createElement('div');
    cell.className = 'enh-item' + (it.instId === S.decomposeTargetInstId ? ' selected' : '') + (it.locked ? ' locked' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${enh}${lock}</span>
      <span class="enh-item-where">${rarityName(it.itemId)}</span>`;
    cell.addEventListener('click', () => selectDecomposeTarget(it.instId));
    list.appendChild(cell);
  }
}

export function renderDecomposeDetail() {
  const box = $('decompose-detail');
  if (!box) return;
  const ins = findDecomposeInstance(S.decomposeTargetInstId);
  if (!ins) { box.innerHTML = '<div class="enhance-hint">← 选择一件装备进行分解</div>'; return; }
  const d = itemDef(ins.itemId);
  const rc = rarityColor(ins.itemId);
  const cur = ins.enhance || 0;
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${cur > 0 ? ' +' + cur : ''}</span>
    </div>`;
  if (ins.locked) { box.innerHTML = head + '<div class="enh-warn">🔒 装备已锁定，无法分解<br>（在背包中解锁后再试）</div>'; return; }
  const cfg = decomposeConfig();
  const rule = decomposeRule(itemRarity(ins.itemId));
  if (!rule) { box.innerHTML = head + '<div class="enhance-hint">分解配置未加载</div>'; return; }
  const goldGain = Math.floor((d.price || 0) * (rule.goldReturnRate || 0));
  const stoneId = (cfg && cfg.stoneItemId) || 4006;
  const stoneGain = Math.floor((rule.enhanceStoneRate || 0) * cur);
  const stoneRow = stoneGain > 0
    ? `<div class="dec-mat"><span class="item-icon">${itemDef(stoneId).icon}</span><span class="dec-mat-name">${itemDef(stoneId).name}</span><b>×${stoneGain}</b></div>`
    : '';
  const matRows = (rule.results || []).map((res) => {
    const md = itemDef(res.itemId);
    const cnt = res.minCount === res.maxCount ? `${res.minCount}` : `${res.minCount}~${res.maxCount}`;
    const prob = res.prob >= 1 ? '' : ` <span class="dec-prob">${Math.round(res.prob * 100)}%</span>`;
    return `<div class="dec-mat"><span class="item-icon">${md.icon}</span><span class="dec-mat-name">${md.name}</span><b>×${cnt}</b>${prob}</div>`;
  }).join('');
  box.innerHTML = head + `
    <div class="dec-section">分解产出</div>
    <div class="dec-gold">💰 金币 <b>+${goldGain}</b></div>
    <div class="dec-mats">${stoneRow}${matRows || '<div class="enhance-hint">无材料产出</div>'}</div>
    <div class="enh-warn">⚠ 分解后装备将被销毁，不可恢复</div>
    <button id="dec-do-btn" class="enh-do-btn">确认分解</button>`;
  const btn = $('dec-do-btn');
  if (btn) btn.addEventListener('click', () => { net.sendDecompose(S.decomposeTargetInstId); });
}

export function handleDecomposeResult(msg) {
  if (msg.ok) {
    const parts = [];
    if (msg.goldGain) parts.push(`+${msg.goldGain}💰`);
    for (const it of (msg.items || [])) parts.push(`${itemName(it.itemId)}×${it.count}`);
    toast(`分解成功！获得 ${parts.length ? parts.join('、') : '材料'}`, 'ok');
    S.gold += (msg.goldGain || 0);
    renderHud();
    const items = collectDecomposeItems();
    S.decomposeTargetInstId = items.length ? items[0].instId : 0;
    renderDecomposeList();
    renderDecomposeDetail();
  } else {
    toast(DECOMPOSE_FAIL_TEXT[msg.failCode] || '分解失败', 'bad');
  }
}

// ============================================================================
// 合成面板
// ============================================================================
export function openCraftPanel() {
  const p = $('craft-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeEnhancePanel();
  closeWarehousePanel();
  p.classList.remove('hidden');
  S.craftNpcWid = S.currentNpcWid;
  S.craftTargetRecipeId = 0;
  S.craftCount = 1;
  S.craftListIds = [];
  renderCraftList();
  renderCraftDetail();
  net.sendCraftList(S.craftNpcWid);
}
export function closeCraftPanel() { const p = $('craft-panel'); if (p) p.classList.add('hidden'); }

export function handleCraftList(msg) {
  S.craftListIds = (msg && msg.recipeIds) ? msg.recipeIds.slice() : [];
  if (!S.craftListIds.some((id) => id === S.craftTargetRecipeId)) {
    S.craftTargetRecipeId = S.craftListIds.length ? S.craftListIds[0] : 0;
    S.craftCount = 1;
  }
  renderCraftList();
  renderCraftDetail();
}

function selectCraftTarget(recipeId) {
  S.craftTargetRecipeId = recipeId;
  S.craftCount = 1;
  renderCraftList();
  renderCraftDetail();
}

export function renderCraftList() {
  const list = $('craft-list');
  if (!list) return;
  list.innerHTML = '';
  const recipes = S.craftListIds.map((id) => craftRecipe(id)).filter((r) => !!r);
  if (!recipes.length) { list.innerHTML = '<div class="enhance-hint">暂无可合成的配方<br>（提升等级或寻找其他合成 NPC）</div>'; return; }
  for (const r of recipes) {
    const d = itemDef(r.resultItemId);
    const rc = rarityColor(r.resultItemId);
    const cell = document.createElement('div');
    cell.className = 'enh-item' + ((r.recipeId | 0) === (S.craftTargetRecipeId | 0) ? ' selected' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${r.resultCount > 1 ? '×' + r.resultCount : ''}</span>
      <span class="enh-item-where">Lv.${r.levelReq || 1}</span>`;
    cell.addEventListener('click', () => selectCraftTarget(r.recipeId));
    list.appendChild(cell);
  }
}

export function renderCraftDetail() {
  const box = $('craft-detail');
  if (!box) return;
  const r = craftRecipe(S.craftTargetRecipeId);
  if (!r) { box.innerHTML = '<div class="enhance-hint">← 选择一个配方进行合成</div>'; return; }
  const d = itemDef(r.resultItemId);
  const rc = rarityColor(r.resultItemId);
  const isEquip = (d.type === 'equip');
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${r.resultCount > 1 ? '×' + r.resultCount : ''}</span>
    </div>`;
  const matRows = (r.materials || []).map((m) => {
    const md = itemDef(m.itemId);
    const need = (m.count || 0) * S.craftCount;
    const have = S.inventory[m.itemId] || 0;
    const lack = have < need ? ' craft-lack' : '';
    return `<div class="dec-mat${lack}"><span class="item-icon">${md.icon}</span><span class="dec-mat-name">${md.name}</span><b>${have}/${need}</b></div>`;
  }).join('');
  const goldNeed = (r.goldCost || 0) * S.craftCount;
  const goldLack = S.gold < goldNeed ? 'craft-lack' : '';
  const pl = S.playerStats.level || 1;
  const levelLack = pl < (r.levelReq || 1) ? 'craft-lack' : '';
  const matsOk = (r.materials || []).every((m) => (S.inventory[m.itemId] || 0) >= (m.count || 0) * S.craftCount);
  const canCraft = matsOk && S.gold >= goldNeed;
  const countHtml = isEquip ? '' : `<div class="craft-count">
      <span>数量</span>
      <button id="craft-dec" class="craft-step">−</button>
      <b id="craft-count-val">${S.craftCount}</b>
      <button id="craft-inc" class="craft-step">＋</button>
    </div>`;
  box.innerHTML = head + `
    <div class="dec-section">产出</div>
    <div class="dec-gold"><span class="item-icon">${d.icon}</span> ${d.name} <b>×${(r.resultCount || 1) * S.craftCount}</b>${isEquip ? ' <span class="dec-prob">装备实例</span>' : ''}</div>
    <div class="dec-section">材料需求</div>
    <div class="dec-mats">${matRows || '<div class="enhance-hint">无需材料</div>'}</div>
    <div class="enh-row"><span>金币</span><b class="${goldLack}">${goldNeed}💰 / 持有 ${S.gold}</b></div>
    <div class="enh-row"><span>需求等级</span><b class="${levelLack}">Lv.${r.levelReq || 1}</b></div>
    ${countHtml}
    <button id="craft-do-btn" class="enh-do-btn"${canCraft ? '' : ' disabled'}>合成</button>`;
  const dec = $('craft-dec'), inc = $('craft-inc');
  if (dec) dec.addEventListener('click', () => { if (S.craftCount > 1) { S.craftCount--; renderCraftDetail(); } });
  if (inc) inc.addEventListener('click', () => { if (S.craftCount < 99) { S.craftCount++; renderCraftDetail(); } });
  const btn = $('craft-do-btn');
  if (btn) btn.addEventListener('click', () => { if (canCraft) net.sendCraft(S.craftTargetRecipeId, S.craftCount); });
}

export function handleCraftResult(msg) {
  if (msg.ok) {
    const d = itemDef(msg.resultItemId);
    toast(`合成成功！获得 ${d.name}×${msg.resultCount}${msg.isInstance ? '（装备）' : ''}`, 'ok');
    const r = craftRecipe(msg.recipeId);
    if (r) { S.gold -= (r.goldCost || 0) * (msg.isInstance ? 1 : S.craftCount); renderHud(); }
    renderCraftDetail();
  } else {
    toast(CRAFT_FAIL_TEXT[msg.failCode] || '合成失败', 'bad');
  }
}

// ============================================================================
// 仓库面板
// ============================================================================
export function openWarehousePanel() {
  const p = $('warehouse-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeEnhancePanel();
  closeCraftPanel();
  p.classList.remove('hidden');
  S.warehouseNpcWid = S.currentNpcWid;
  S.warehousePage = 0;
  net.sendWarehouseOpen(S.warehouseNpcWid);
}
export function closeWarehousePanel() { const p = $('warehouse-panel'); if (p) p.classList.add('hidden'); }

export function handleWarehouse(msg) {
  S.warehouseData = {
    gold: (msg.gold || 0) >>> 0,
    unlocked: (msg.unlocked || 0) >>> 0,
    slots: Array.isArray(msg.slots) ? msg.slots : [],
  };
  const maxPage = Math.max(0, Math.ceil(S.warehouseData.unlocked / whPerPage()) - 1);
  if (S.warehousePage > maxPage) S.warehousePage = maxPage;
  renderWarehouse();
}
export function handleWarehouseResult(msg) {
  if ((msg.code | 0) === 0) {
    if ((msg.op | 0) === WH_OP.EXPAND) toast('仓库扩展成功！', 'ok');
    return;
  }
  toast(WH_FAIL_TEXT[msg.code | 0] || '仓库操作失败', 'bad');
}

function whPerPage() { const c = warehouseConfig(); return (c && (c.slotsPerPage | 0)) || 30; }
function whMaxSlots() { const c = warehouseConfig(); return (c && (c.maxSlots | 0)) || 150; }
function whPageCount() {
  if (!S.warehouseData || !S.warehouseData.unlocked) return 1;
  return Math.max(1, Math.ceil(S.warehouseData.unlocked / whPerPage()));
}
function promptGold(action, cap, cb) {
  const limit = Math.max(1, Math.min(65535, cap | 0));
  const raw = window.prompt(`请输入要${action}的金币数量（1-${limit}）：`, String(limit));
  if (raw == null) return;
  let amt = parseInt(raw, 10);
  if (!isFinite(amt) || amt <= 0) { toast('数量无效', 'bad'); return; }
  if (amt > limit) amt = limit;
  cb(amt);
}

export function renderWarehouse() {
  renderWarehouseGold();
  renderWarehousePages();
  renderWarehouseBag();
  renderWarehouseSlots();
  renderWarehouseFooter();
}

export function renderWarehouseGold() {
  const bar = $('warehouse-goldbar');
  if (!bar) return;
  const wg = S.warehouseData ? S.warehouseData.gold : 0;
  bar.innerHTML = `
    <div class="wh-gold-item"><span class="wh-gold-label">身上</span><b>${S.gold}💰</b></div>
    <div class="wh-gold-item"><span class="wh-gold-label">仓库存金</span><b>${wg}💰</b></div>
    <div class="wh-gold-btns">
      <button id="wh-deposit-gold" class="wh-gold-btn">存金</button>
      <button id="wh-withdraw-gold" class="wh-gold-btn">取金</button>
    </div>`;
  const dg = $('wh-deposit-gold');
  if (dg) dg.addEventListener('click', () => promptGold('存入', S.gold, (amt) => net.sendWarehouseDeposit(false, 0, 0, amt)));
  const wb = $('wh-withdraw-gold');
  if (wb) wb.addEventListener('click', () => promptGold('取出', wg, (amt) => net.sendWarehouseWithdraw(false, 0, 0, amt)));
}

function renderWarehousePages() {
  const box = $('warehouse-pages');
  if (!box) return;
  box.innerHTML = '';
  const n = whPageCount();
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.className = 'wh-page-btn' + (i === S.warehousePage ? ' active' : '');
    b.textContent = `第${i + 1}页`;
    b.addEventListener('click', () => { S.warehousePage = i; renderWarehousePages(); renderWarehouseSlots(); });
    box.appendChild(b);
  }
  const info = document.createElement('span');
  info.className = 'wh-page-info';
  const used = S.warehouseData ? S.warehouseData.slots.length : 0;
  const cap = S.warehouseData ? S.warehouseData.unlocked : 0;
  info.textContent = `${used}/${cap} 格`;
  box.appendChild(info);
}

export function renderWarehouseBag() {
  const box = $('warehouse-bag');
  if (!box) return;
  box.innerHTML = '';
  let any = false;
  for (const ins of S.equipBag) {
    if (!ins || !ins.instId) continue;
    any = true;
    const d = itemDef(ins.itemId);
    const rc = rarityColor(ins.itemId);
    const enh = ins.enhance > 0 ? `+${ins.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'wh-cell filled';
    cell.style.borderColor = rc;
    cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span>${enh ? `<span class="wh-cell-badge wh-enh">${enh}</span>` : ''}${ins.locked ? '<span class="wh-cell-badge wh-lock">🔒</span>' : ''}`;
    cell.title = `${d.name}${enh}（点击存入）`;
    cell.addEventListener('click', () => net.sendWarehouseDeposit(true, ins.instId, ins.itemId, 1));
    box.appendChild(cell);
  }
  for (const key of Object.keys(S.inventory)) {
    const itemId = key | 0;
    const cnt = S.inventory[key] | 0;
    if (!itemId || cnt <= 0) continue;
    any = true;
    const d = itemDef(itemId);
    const cell = document.createElement('div');
    cell.className = 'wh-cell filled';
    cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span><span class="wh-cell-badge wh-count">${cnt}</span>`;
    cell.title = `${d.name} ×${cnt}（点击存入全部）`;
    cell.addEventListener('click', () => net.sendWarehouseDeposit(false, 0, itemId, cnt));
    box.appendChild(cell);
  }
  if (!any) box.innerHTML = '<div class="enhance-hint">背包空空如也</div>';
}

function renderWarehouseSlots() {
  const box = $('warehouse-slots');
  if (!box) return;
  box.innerHTML = '';
  if (!S.warehouseData) return;
  const perPage = whPerPage();
  const start = S.warehousePage * perPage;
  const end = Math.min(start + perPage, S.warehouseData.unlocked);
  for (let gi = start; gi < end; gi++) {
    const s = S.warehouseData.slots[gi];
    const cell = document.createElement('div');
    if (s && (s.isInstance ? s.instId : s.itemId)) {
      const d = itemDef(s.itemId);
      const rc = rarityColor(s.itemId);
      cell.className = 'wh-cell filled';
      cell.style.borderColor = rc;
      if (s.isInstance) {
        const enh = s.enhance > 0 ? `+${s.enhance}` : '';
        cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span>${enh ? `<span class="wh-cell-badge wh-enh">${enh}</span>` : ''}${s.locked ? '<span class="wh-cell-badge wh-lock">🔒</span>' : ''}`;
        cell.title = `${d.name}${enh}（点击取出）`;
        cell.addEventListener('click', () => net.sendWarehouseWithdraw(true, s.instId, s.itemId, 1));
      } else {
        const cnt = Math.min(s.count | 0, 65535);
        cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span><span class="wh-cell-badge wh-count">${s.count}</span>`;
        cell.title = `${d.name} ×${s.count}（点击取出全部）`;
        cell.addEventListener('click', () => net.sendWarehouseWithdraw(false, 0, s.itemId, cnt));
      }
    } else {
      cell.className = 'wh-cell empty';
    }
    box.appendChild(cell);
  }
}

function renderWarehouseFooter() {
  const box = $('warehouse-footer');
  if (!box) return;
  if (!S.warehouseData) { box.innerHTML = ''; return; }
  const unlocked = S.warehouseData.unlocked;
  const maxSlots = whMaxSlots();
  if (unlocked >= maxSlots) {
    box.innerHTML = `<div class="wh-expand-info">仓库已达最大容量 ${maxSlots} 格</div>`;
    return;
  }
  const cost = warehouseExpandCost(unlocked);
  const afford = S.gold >= cost;
  const nextSlots = Math.min(maxSlots, unlocked + whPerPage());
  box.innerHTML = `<button id="wh-expand-btn" class="wh-expand-btn"${afford ? '' : ' disabled'}>扩展仓库 → ${nextSlots} 格（${cost}💰）</button>
    <div class="wh-expand-info">身上金币 ${S.gold}💰</div>`;
  const btn = $('wh-expand-btn');
  if (btn) btn.addEventListener('click', () => { if (afford) net.sendWarehouseExpand(); });
}
