/**
 * boot-game.js — 技能施放 + NPC 交互 + 精英 HUD + 主循环 + 调试
 * 依赖注入：由 boot.js 调用 configure() 传入共享依赖。
 */
import { S, CLIENT_VERSION, PLAYER_RESPAWN_SEC, SKILL_KEY_LABEL, toast, renderHud, protocolLog } from './boot-state.js';
import { itemDef, skillDef, skillName } from './items.js';
import { terrainHeight, terrainBlocked, terrainBlockedExact, terrainColor } from './terrain.js';
import { NPC_TAG } from './protocol.js';
import { EVT } from './protocol.js';

let $, net;
let toggleInventoryPanel, closeInventoryPanel, closeShopPanel, openShopPanel, renderInventory, renderEquip,
    closeEnhancePanel, openEnhancePanel, closeCraftPanel, openCraftPanel, closeWarehousePanel, openWarehousePanel,
    renderEnhanceList, renderEnhanceDetail, renderDecomposeList, renderDecomposeDetail,
    renderCraftList, renderCraftDetail,
    renderWarehouseBag, renderWarehouseGold, renderWarehouseFooter;

export function configure(deps) {
  $ = deps.$;
  net = deps.net;
  toggleInventoryPanel = deps.toggleInventoryPanel;
  closeInventoryPanel = deps.closeInventoryPanel;
  closeShopPanel = deps.closeShopPanel;
  openShopPanel = deps.openShopPanel;
  renderInventory = deps.renderInventory;
  renderEquip = deps.renderEquip;
  closeEnhancePanel = deps.closeEnhancePanel;
  openEnhancePanel = deps.openEnhancePanel;
  closeCraftPanel = deps.closeCraftPanel;
  openCraftPanel = deps.openCraftPanel;
  closeWarehousePanel = deps.closeWarehousePanel;
  openWarehousePanel = deps.openWarehousePanel;
  renderEnhanceList = deps.renderEnhanceList;
  renderEnhanceDetail = deps.renderEnhanceDetail;
  renderDecomposeList = deps.renderDecomposeList;
  renderDecomposeDetail = deps.renderDecomposeDetail;
  renderCraftList = deps.renderCraftList;
  renderCraftDetail = deps.renderCraftDetail;
  renderWarehouseBag = deps.renderWarehouseBag;
  renderWarehouseGold = deps.renderWarehouseGold;
  renderWarehouseFooter = deps.renderWarehouseFooter;
}

// 从 quests.js / social.js 直接导入（无循环依赖）
import { toggleQuestPanel, sendTalkNpc, sendQuestAccept, sendQuestTurnIn, getQuestList, getQuestProgress, setNpcFilter, sendQuestList } from './quests.js';
import { toggleFriendPanel, toggleGuildPanel, toggleChatFocus } from './social.js';

// ============================================================================
// NPC 交互
// ============================================================================
function isShopNpc(e) { return e.kind === 'npc' && ((e.npcTag || 0) & NPC_TAG.SHOP) !== 0; }

export function findNearbyNpc(px, pz, range) {
  let best = null, bestD = range;
  for (const e of S.entities.forRender()) {
    if (e.kind !== 'npc') continue;
    const d = Math.hypot(e.x - px, e.z - pz);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function nearbyDrops(px, pz, range) {
  const out = [];
  for (const e of S.entities.forRender()) {
    if (e.kind !== 'item') continue;
    if (Math.hypot(e.x - px, e.z - pz) <= range) out.push(e);
  }
  return out;
}

function autoPickup(px, pz, range) {
  if (!S.entities || !net) return;
  for (const e of nearbyDrops(px, pz, range)) net.sendPickup(e.wid);
}

export function pickupNearbyDrops(px, pz, range) {
  const drops = nearbyDrops(px, pz, range);
  if (!drops.length) { toast('附近没有可拾取的掉落物'); return; }
  for (const e of drops) net.sendPickup(e.wid);
}

export function openNpcDialog(npc) {
  // 与 NPC 交互时立即停止移动
  if (S.input) S.input.clearMovement();
  
  S.currentNpcWid = npc.wid;
  S.currentNpcName = npc.name || 'NPC';
  S.currentNpcTag = npc.npcTag || 0;
  S.currentNpcDialogue = '';
  S.npcDialogOpen = true;
  S._npcDialogWasOpen = true; // 标记：移动后需关闭面板
  const dlg = $('npc-dialog');
  if (!dlg) return;
  dlg.classList.remove('hidden');
  $('npc-dialog-name').textContent = S.currentNpcName;
  $('npc-dialog-text').textContent = `\u4f60\u597d\uff0c\u65c5\u884c\u8005\uff01\u6211\u662f${S.currentNpcName}\u3002`;
  const tag = npc.npcTag || 0;
  if ((tag & NPC_TAG.BLACKSMITH) !== 0) {
    openEnhancePanel();
  } else if ((tag & NPC_TAG.CRAFT) !== 0) {
    openCraftPanel();
  } else if ((tag & NPC_TAG.BANK) !== 0) {
    openWarehousePanel();
  } else if (isShopNpc(npc)) {
    net.sendShopOpen(npc.wid);
  }
  setNpcFilter(npc.wid);
  sendTalkNpc(net, npc.wid);
  setTimeout(refreshNpcDialog, 300);
}

export function closeNpcDialog() {
  S.npcDialogOpen = false;
  S.currentNpcWid = 0;
  S.currentNpcName = '';
  setNpcFilter(0);
  const dlg = $('npc-dialog');
  if (dlg) dlg.classList.add('hidden');
}

/** 关闭所有 NPC 相关面板（移动时自动触发） */
export function closeAllNpcPanels() {
  closeNpcDialog();
  if (closeEnhancePanel) closeEnhancePanel();
  if (closeCraftPanel) closeCraftPanel();
  if (closeWarehousePanel) closeWarehousePanel();
  if (closeShopPanel) closeShopPanel();
  if (closeInventoryPanel) closeInventoryPanel();
}

export function refreshNpcDialog() {
  if (!S.npcDialogOpen) return;
  const opts = $('npc-dialog-options');
  if (!opts) return;
  opts.innerHTML = '';
  const available = getQuestList();
  const active = getQuestProgress();
  if ((S.currentNpcTag & NPC_TAG.SHOP) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">🏪</span><span class="npc-opt-text">浏览商品</span><span class="npc-opt-tag tag-shop">商店</span>';
    btn.addEventListener('click', () => { if (S.shopData) openShopPanel(); });
    opts.appendChild(btn);
  }
  if ((S.currentNpcTag & NPC_TAG.BLACKSMITH) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">⚒️</span><span class="npc-opt-text">装备强化 / 分解</span><span class="npc-opt-tag tag-smith">铁匠</span>';
    btn.addEventListener('click', () => openEnhancePanel());
    opts.appendChild(btn);
  }
  if ((S.currentNpcTag & NPC_TAG.CRAFT) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">⚗️</span><span class="npc-opt-text">物品合成</span><span class="npc-opt-tag tag-craft">合成</span>';
    btn.addEventListener('click', () => openCraftPanel());
    opts.appendChild(btn);
  }
  if ((S.currentNpcTag & NPC_TAG.BANK) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">🏦</span><span class="npc-opt-text">打开仓库</span><span class="npc-opt-tag tag-bank">银行</span>';
    btn.addEventListener('click', () => openWarehousePanel());
    opts.appendChild(btn);
  }
  for (const q of available) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    const catName = { 1: '主线', 2: '支线', 3: '日常', 4: '重复' }[q.category] || '任务';
    const chainTag = q.nextQuestIds && q.nextQuestIds.length > 0 ? ' 🔗' : '';
    btn.innerHTML = `<span class="npc-opt-icon">❗</span><span class="npc-opt-text">${q.name}${chainTag}</span><span class="npc-opt-tag tag-accept">${catName}·接取</span>`;
    btn.addEventListener('click', () => {
      sendQuestAccept(net, q.questId, S.currentNpcWid);
      toast(`接受任务【${q.name}】`, 'ok');
      sendTalkNpc(net, S.currentNpcWid);
      setTimeout(refreshNpcDialog, 200);
    });
    opts.appendChild(btn);
  }
  for (const q of active) {
    if (q.status !== 1) continue;
    const listQ = getQuestList().find(lq => lq.questId === q.questId);
    const qName = listQ ? listQ.name : `任务#${q.questId}`;
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = `<span class="npc-opt-icon">✅</span><span class="npc-opt-text">${qName} 已完成</span><span class="npc-opt-tag tag-turnin">提交</span>`;
    btn.addEventListener('click', () => {
      sendQuestTurnIn(net, q.questId, S.currentNpcWid);
      toast(`提交任务【${qName}】`, 'ok');
      setTimeout(() => { sendTalkNpc(net, S.currentNpcWid); setTimeout(refreshNpcDialog, 200); }, 100);
    });
    opts.appendChild(btn);
  }
  if (!available.length && active.filter(q => q.status === 1).length === 0 && (S.currentNpcTag & NPC_TAG.SHOP) === 0 && (S.currentNpcTag & NPC_TAG.BLACKSMITH) === 0 && (S.currentNpcTag & NPC_TAG.CRAFT) === 0 && (S.currentNpcTag & NPC_TAG.BANK) === 0) {
    const empty = document.createElement('div');
    empty.className = 'npc-opt-empty';
    empty.textContent = '（暂无可接或可完成的任务）';
    opts.appendChild(empty);
  }
}

export function interactWithNearestNpc() {
  if (!S.entities || !S.predictor) return;
  const selfPos = S.predictor.predicted();
  const npc = findNearbyNpc(selfPos.x, selfPos.z, 4);
  if (!npc) { toast('附近没有可交互的 NPC'); return; }
  openNpcDialog(npc);
}

// ============================================================================
// 技能系统
// ============================================================================
export function renderSkillBar() {
  const bar = $('skill-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const cdMap = {};
  for (const s of S.learnedSkills) cdMap[s.id] = s.cdMs || 0;
  S.skillBar.forEach((id, idx) => {
    const sd = skillDef(id);
    const cell = document.createElement('div');
    const cdLeft = cdMap[id] || 0;
    const onCd = cdLeft > 0;
    cell.className = 'skill-cell' + (onCd ? ' cd' : '');
    cell.innerHTML = `
      <div class="skill-icon">${sd.icon}</div>
      <div class="skill-key">${SKILL_KEY_LABEL(idx + 1)}</div>
      <div class="skill-name">${sd.name}</div>
      ${onCd ? `<div class="skill-cd">${(cdLeft / 1000).toFixed(1)}s</div>` : ''}`;
    cell.addEventListener('click', () => {
      const sid = S.skillBar[idx];
      if (sid) castSkillNow(sid);
    });
    bar.appendChild(cell);
  });
  if (!S.skillBar.length) bar.innerHTML = '<div class="skill-cell empty">未习得技能</div>';
}

export function renderBuffBar() {
  const bar = $('buff-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const buffNameMap = { 1: '攻击↑', 2: '防御↑', 3: '减速', 4: '回血', 5: '反伤', 6: '流血', 7: '减防', 8: '减攻', 9: '眩晕', 10: '霸体', 11: '加速' };
  for (const b of S.myBuffs) {
    const cell = document.createElement('div');
    cell.className = 'buff-cell';
    cell.innerHTML = `<span>${buffNameMap[b.type] || '#' + b.type}</span><span class="buff-t">${b.remainSec.toFixed(0)}s</span>`;
    bar.appendChild(cell);
  }
}

export function isSkillLearned(skillId) {
  return S.learnedSkills.some((s) => s.id === skillId);
}

export function castSkillNow(skillId) {
  if (!net || !S.predictor) return;
  if (S.selfDead) { toast('已阵亡，无法施放'); return; }
  if (!isSkillLearned(skillId)) { toast('尚未习得该技能'); return; }
  const sd = skillDef(skillId);
  const cdEntry = S.learnedSkills.find((s) => s.id === skillId);
  if (cdEntry && cdEntry.cdMs > 0) { toast(`技能冷却中（${(cdEntry.cdMs / 1000).toFixed(1)}s）`); return; }
  if (sd.mana > 0 && S.playerStats.mp < sd.mana) { toast(`蓝量不足（需要 ${sd.mana}）`); return; }
  const selfPos = S.predictor.predicted();
  let best = null, bestD = Infinity;
  for (const e of S.entities.forRender()) {
    if (e.kind !== 'monster') continue;
    const d = Math.hypot(e.x - selfPos.x, e.z - selfPos.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  let ax = selfPos.x, az = selfPos.z;
  let targetWid = 0;
  if (sd.target === 2 || sd.target === 3) {
    if (best && bestD <= sd.range) {
      // 最近怪物在施法范围内 → 吸附到怪物
      ax = best.x; az = best.z;
      if (sd.target === 2) targetWid = best.wid;
    } else if (S._mouseWorldX != null) {
      // 空放：落点 = 鼠标方向，限制在技能最远距离
      const mdx = S._mouseWorldX - selfPos.x;
      const mdz = S._mouseWorldZ - selfPos.z;
      const mDist = Math.hypot(mdx, mdz);
      if (mDist > 1e-3) {
        const clamp = Math.min(mDist, sd.range) / mDist;
        ax = selfPos.x + mdx * clamp;
        az = selfPos.z + mdz * clamp;
      }
    }
    // else: 鼠标未进入画布，落点保持自身位置（脚下空放）
    // 距离校验（吸附怪物时可能超距）
    if (sd.range > 0) {
      const dist = Math.hypot(ax - selfPos.x, az - selfPos.z);
      if (dist > sd.range) { toast(`超出施法距离（${sd.range}m）`); return; }
    }
  }
  net.sendCastSkill(skillId, targetWid, ax, az);
}

export function findEntityByWid(wid) {
  for (const e of S.entities.forRender()) { if (e.wid === wid) return e; }
  return null;
}

// ============================================================================
// 精英 HUD
// ============================================================================
export function updateEliteHud() {
  const bar = $('elite-bar');
  if (!bar) return;
  let pick = null;
  for (const b of S.eliteStates.values()) {
    if (b.state === 1 && b.target === net.selfWid) { pick = b; break; }
  }
  if (!pick) {
    for (const b of S.eliteStates.values()) {
      if (b.state !== 2 && (pick === null || b.hp / b.maxHp < pick.hp / pick.maxHp)) pick = b;
    }
  }
  if (!pick) { bar.style.display = 'none'; return; }
  S.eliteDisplay = pick;
  bar.style.display = 'block';
  $('elite-name').textContent = `${pick.name || '世界精英'} Lv.${pick.phase} ${pick.state === 2 ? '· 已阵亡' : ''}`;
  const pct = Math.max(0, Math.min(100, (pick.hp / pick.maxHp) * 100));
  $('elite-fill').style.width = pct + '%';
  $('elite-hp').textContent = `${Math.round(pick.hp)} / ${Math.round(pick.maxHp)}`;
}

// ============================================================================
// 主循环
// ============================================================================
export function loop(now) {
  if (!S.running) return;
  const rawDt = (now - S.lastT) / 1000;
  const dt = Math.min(0.1, rawDt);
  S.lastT = now;

  const mv = S.input.moveVector(S.predictor.predicted(), S.renderer.cam.cx, S.renderer.cam.cz);
  
  // 移动时自动关闭 NPC 面板（检测点击移动或 WASD 键盘移动）
  if (S._npcDialogWasOpen && (mv.x !== 0 || mv.z !== 0)) {
    closeAllNpcPanels();
    S._npcDialogWasOpen = false;
  }
  
  S.inputAcc += dt;
  if (S.inputAcc >= 0.05) {
    S.inputAcc -= 0.05;
    if (S.selfDead) {
      S.input.takeSkillSlot();
      S.input.takeInvToggle(); S.input.takeShop(); S.input.takePickup();
      S.input.takeQuestToggle(); S.input.takeSocialToggle(); S.input.takeInteract();
    } else {
      S.predictor.applyInput(mv.x, mv.z);
      const pred = S.predictor.predicted();
      net.sendInput(pred);
    }
  }

  S.entities.update(dt);
  S.predictor.setNearbyEntities(S.entities.forRender());
  const selfPos = S.predictor.step(rawDt);
  const renderPos = S.predictor.renderPos();
  net.setRef(selfPos.x, selfPos.y, selfPos.z);
  S.entities.setSelf(renderPos.x, renderPos.y, renderPos.z);
  const camPos = renderPos;

  // 任务导航驱动（在实体更新后、渲染前调用）
  if (S.questNav) S.questNav.tick();

  if (S.selfDead) {
    const remain = Math.max(0, PLAYER_RESPAWN_SEC - (performance.now() - S.deathAtMs) / 1000);
    const de = $('death-count');
    if (de) de.textContent = remain.toFixed(1) + 's';
  }
  if (!S.selfDead) {
    const slot = S.input.takeSkillSlot();
    if (slot >= 1 && slot <= S.skillBar.length) castSkillNow(S.skillBar[slot - 1]);
    if (S._cdRefMs > 0 && S.learnedSkills.length) {
      const elapsed = now - S._cdRefMs;
      if (elapsed > 0) {
        for (const s of S.learnedSkills) { if (s.cdMs > 0) s.cdMs = Math.max(0, s.cdMs - elapsed); }
        S._cdRefMs = now;
      }
    }
    if (S._skillDirty) { renderSkillBar(); S._skillDirty = false; S._lastCdTick = now; }
    if (S._buffDirty) { renderBuffBar(); S._buffDirty = false; }
    if (now - S._lastCdTick >= 100) {
      S._lastCdTick = now;
      const cdMap = {};
      for (const s of S.learnedSkills) cdMap[s.id] = s.cdMs || 0;
      const bar = $('skill-bar');
      S.skillBar.forEach((id, idx) => {
        const cell = bar ? bar.children[idx] : null;
        if (!cell) return;
        const cd = cdMap[id] || 0;
        let cdEl = cell.querySelector('.skill-cd');
        if (cd > 0 && !cdEl) { cdEl = document.createElement('div'); cdEl.className = 'skill-cd'; cell.appendChild(cdEl); cell.classList.add('cd'); }
        if (cdEl) {
          const newText = (cd / 1000).toFixed(1) + 's';
          if (cdEl.textContent !== newText) cdEl.textContent = newText;
          if (cd <= 0) { cdEl.remove(); cell.classList.remove('cd'); }
        }
      });
    }
    if (S.input.takeInvToggle()) toggleInventoryPanel();
    if (S.input.takeQuestToggle()) toggleQuestPanel();
    const socialToggle = S.input.takeSocialToggle();
    if (socialToggle === 1) toggleFriendPanel();
    else if (socialToggle === 2) toggleGuildPanel();
    else if (socialToggle === 3) toggleChatFocus();
    if (S.input.takeShop()) interactWithNearestNpc();
    if (S.input.takeInteract()) interactWithNearestNpc();
    if (S.input.takePickup()) pickupNearbyDrops(selfPos.x, selfPos.z, 2.2);
    if (S.input.takeGridToggle() && S.renderer) S.renderer.setGridVisible(!S.renderer._gridVisible);
    autoPickup(selfPos.x, selfPos.z, 1.9);
  }

  S.renderer.setCameraFollow(camPos.x, camPos.z);
  S.renderer.setSelf(camPos.x, camPos.y, camPos.z, net.selfName, S.selfDead);
  S.renderer.setSelfBuffs(S.myBuffs || []);
  // 方向指示器：移动时指向移动方向（避免角色走过目标点后箭头翻转）
  if (mv.x !== 0 || mv.z !== 0) {
    const mvLen = Math.hypot(mv.x, mv.z);
    S.renderer.setDirectionTarget(selfPos.x + (mv.x / mvLen) * 5, selfPos.z + (mv.z / mvLen) * 5);
  } else {
    S.renderer.setDirectionTarget(S._mouseWorldX, S._mouseWorldZ);
  }
  S.renderer.setEntities(S.entities.forRender());
  S.renderer.render();

  if (S.minimap) S.minimap.update(renderPos.x, renderPos.z, S.entities.forRender());

  S.fpsAcc += dt;
  S.fpsCount++;
  if (S.fpsAcc >= 0.5) {
    const fps = Math.round(S.fpsCount / S.fpsAcc);
    $('hud-fps').textContent = `fps:${fps}`;
    $('hud-pos').textContent = `x:${selfPos.x.toFixed(1)} z:${selfPos.z.toFixed(1)}`;
    const b = $('proto-bps');
    if (b && window.__ewBytes) b.textContent = (window.__ewBytes / 1024).toFixed(1) + 'KB';
    S.fpsAcc = 0; S.fpsCount = 0;
  }
  window.__ewFrames = (window.__ewFrames || 0) + 1;
  requestAnimationFrame(loop);
}

// ============================================================================
// 调试
// ============================================================================
export function debugPrint(type) {
  if (!S.renderer || !S.predictor) { console.warn('[debug] 渲染器/预测器未初始化'); return; }
  const pos = S.predictor.predicted();
  const ts = new Date().toISOString().slice(11, 23);
  console.group(`%c[调试数据] ${type} @ ${ts}`, 'color:#c9a84c;font-weight:bold');
  try {
    switch (type) {
      case 'terrain': debugTerrain(pos); break;
      case 'self': debugSelf(pos); break;
      case 'npc': debugEntities('npc'); break;
      case 'monster': debugEntities('monster'); break;
      default: console.warn('未知类型:', type);
    }
  } catch (e) { console.error('[debug] 打印失败:', e); }
  console.groupEnd();
}

function debugTerrain(pos) {
  const RANGE = 10, STEP = 2;
  const raw = [];
  for (let dz = -RANGE; dz <= RANGE; dz += STEP) {
    for (let dx = -RANGE; dx <= RANGE; dx += STEP) {
      const wx = pos.x + dx, wz = pos.z + dz;
      const h = terrainHeight(wx, wz);
      const blocked = terrainBlockedExact(wx, wz);
      const c = terrainColor(wx, wz);
      raw.push({ x: +wx.toFixed(2), z: +wz.toFixed(2), height: +h.toFixed(3), blocked, color: `rgb(${(c.r*255)|0},${(c.g*255)|0},${(c.b*255)|0})` });
    }
  }
  console.log(`%c原始数据 (${raw.length} 采样点, STEP=${STEP}m):`, 'color:#81c784');
  console.table(raw);
}

function debugSelf(pos) {
  const renderPos = S.predictor.renderPos();
  const screen = S.renderer.w2s(renderPos.x, renderPos.z);
  const cam = S.renderer.cam;
  console.log('%c物理位置 (predictor.predicted):', 'color:#81c784');
  console.table({ x: +pos.x.toFixed(3), z: +pos.z.toFixed(3) });
  console.log('%c渲染位置 (predictor.renderPos):', 'color:#64b5f6');
  console.table({ x: +renderPos.x.toFixed(3), z: +renderPos.z.toFixed(3) });
  console.log('%c屏幕投影 (renderer.w2s):', 'color:#ffb74d');
  console.table({ screenX: +screen.x.toFixed(1), screenY: +screen.y.toFixed(1) });
  console.log('%c相机参数:', 'color:#ce93d8');
  console.table({ cx: +cam.cx.toFixed(3), cz: +cam.cz.toFixed(3), zoom: cam.zoom });
  console.log('%c地形信息:', 'color:#a89878');
  console.table({ terrainHeight: +terrainHeight(pos.x, pos.z).toFixed(3), blocked: terrainBlockedExact(pos.x, pos.z) });
}

function debugEntities(kind) {
  if (!S.entities) { console.warn('[debug] 实体管理器未初始化'); return; }
  const pos = S.predictor.predicted();
  const list = [];
  for (const e of S.entities.forRender()) {
    if (e.kind !== kind) continue;
    const dist = Math.hypot(e.x - pos.x, e.z - pos.z);
    const scr = S.renderer.w2s(e.x, e.y, e.z);
    list.push({ wid: e.wid, name: e.name || '-', x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), dist: +dist.toFixed(1), screenX: +scr.x.toFixed(0), screenY: +scr.y.toFixed(0), state: e.state, radius: +e.radius.toFixed(2), dying: e.dying || false });
  }
  const label = kind === 'npc' ? 'NPC' : '怪物';
  if (list.length === 0) console.log(`%c当前视野内没有${label}`, 'color:#ffb74d');
  else { console.log(`%c可见${label} (${list.length}个):`, 'color:#81c784'); console.table(list); }
}
