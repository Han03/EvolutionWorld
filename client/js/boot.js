/**
 * EvolutionWorld 客户端入口
 * 流程：登录（HTTP）→ 建立 WebSocket → 进入 3D 世界 → 主循环
 */
import { NetworkClient } from './network.js';
import { InputState } from './input.js';
import { createRenderer } from './renderer.js';
import { EntityViewManager } from './entities.js';
import { Predictor } from './predict.js';
import { ITEM_DEFS, itemDef, itemName, itemIcon, typeName, itemDesc, SLOT_NAME, skillDef, skillName } from './items.js';
import { EVT } from './protocol.js';

const $ = (id) => document.getElementById(id);
const overlay = $('login-overlay');
const loading = $('loading');
const hud = $('hud');
const net = new NetworkClient();

// 全局错误展示（便于排查与用户反馈）
window.addEventListener('error', (e) => {
  $('loading-text').textContent = '客户端错误：' + (e.message || 'unknown');
  try {
    const st = (e.error && e.error.stack || '').split('\n');
    protocolLog('ERR', { msg: e.message || 'unknown', at: st[1] ? st[1].trim() : '' });
  } catch (_) {}
  console.error(e.error || e);
});
window.addEventListener('unhandledrejection', (e) => {
  $('loading-text').textContent = '客户端错误：' + (e.reason?.message || e.reason);
  console.error(e.reason);
});

let renderer = null;
let entities = null;
let input = null;
let predictor = null;
let running = false;
let lastT = 0;
let fpsAcc = 0;
let fpsCount = 0;
let inputAcc = 0;
let bossStates = new Map(); // wid -> 世界Boss共享状态（S2C_BOSS 最新）
let bossDisplay = null;     // HUD 顶栏展示的 Boss
// 物品系统状态（服务端权威，S2C_INVENTORY/S2C_STATS 刷新）
let playerStats = { maxHp: 100, maxMp: 50, attack: 12, defense: 3, hp: 100, mp: 50 };
let inventory = {};   // itemId -> 数量
let equip = {};       // 槽位值 -> itemId
let gold = 0;
let shopData = null;  // {shopId, name, entries[]}
let toastTimer = null;
// 技能系统状态（服务端权威，S2C_SKILLS/S2C_BUFFS 刷新）
let learnedSkills = [];   // [{id, cdMs}] 已学技能 + 剩余冷却（ms）
let myBuffs = [];         // [{skillId, type, value, remainSec}]
let skillCastFeedback = null; // 最近一次技能施放反馈（用于日志/提示）
// 技能栏展示映射：slot(1-8) -> skillId（按技能 ID 升序填槽）
let skillBar = [];        // skillId 数组（与技能栏 UI 顺序一致）
// 渲染器物品名映射（renderer.js 读取）
window.__itemNames = {};
for (const [id, d] of Object.entries(ITEM_DEFS)) window.__itemNames[id] = d.name;

// ---------------- 登录 UI ----------------

function showMsg(text, ok) {
  const el = $('login-msg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}

async function doLogin(username, password) {
  showMsg('登录中…', false);
  try {
    const data = await net.login(username, password);
    await enterWorld(data.token, data.user.username, data.world);
  } catch (e) {
    showMsg(e.message);
  }
}

async function doRegister(username, password) {
  showMsg('注册中…', false);
  try {
    await net.register(username, password);
    await doLogin(username, password);
  } catch (e) {
    showMsg(e.message);
  }
}

$('btn-login').addEventListener('click', () =>
  doLogin($('username').value.trim(), $('password').value)
);
$('btn-register').addEventListener('click', () =>
  doRegister($('username').value.trim(), $('password').value)
);
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  doLogin($('username').value.trim(), $('password').value);
});

// ---------------- 进入世界 ----------------

async function enterWorld(token, username, worldMeta) {
  overlay.classList.add('hidden');
  loading.classList.remove('hidden');
  $('loading-text').textContent = '连接世界中…';

  try {
    // 先挂回调，再建立连接（welcome 可能立刻到达）
    net.onHello = (msg) => {
      hud.classList.remove('hidden');
      $('hud-user').textContent = net.selfName;
      $('hud-conn').textContent = '已连接';
      $('hud-conn').className = 'hud-chip on';
    };
    net.onDisconnect = () => {
      $('hud-conn').textContent = '连接断开';
      $('hud-conn').className = 'hud-chip off';
    };
    await net.connect(token);
  } catch (e) {
    loading.classList.add('hidden');
    overlay.classList.remove('hidden');
    showMsg('连接失败：' + e.message);
    return;
  }

  // 等待 hello（拿到 selfWid 与世界参数）
  if (!net.hello) {
    await new Promise((resolve) => {
      const old = net.onHello;
      net.onHello = (msg) => {
        old && old(msg);
        resolve();
      };
    });
  }
  $('loading-text').textContent = '初始化渲染器…';

  // 初始化 3D
  try {
    renderer = createRenderer($('app'));
  } catch (e) {
    $('loading-text').textContent = '渲染器错误：' + (e && e.message ? e.message : e);
    console.error(e);
    throw e;
  }
  $('loading-text').textContent = '创建实体管理器…';
  try {
    entities = new EntityViewManager(net.selfWid);
  } catch (e) {
    $('loading-text').textContent = '实体管理器错误：' + (e && e.message ? e.message : e);
    console.error(e);
    throw e;
  }
  window.__ewEntities = entities; // 测试/调试钩子
  input = new InputState(renderer.canvas);
  window.__ewInput = input;
  // 本地预测器：从 hello 位置起步
  predictor = new Predictor();
  if (net.hello && net.hello.self) {
    predictor.setPosition(net.hello.self.x, net.hello.self.y, net.hello.self.z);
    entities.setSelf(net.hello.self.x, net.hello.self.y, net.hello.self.z);
  }
  window.__ewPredictor = predictor; // 测试/调试钩子
  window.__ewFx = () => renderer.fxSnapshot(); // 测试/调试钩子：技能效果快照
  $('loading-text').textContent = '接收世界数据…';

  // 二进制协议：AOI 进出 + 增量 + 校准快照 + 预测回退
  net.onEnter = (ents) => entities.applyEnter(ents);
  net.onLeave = (wids) => entities.applyLeave(wids);
  net.onUpdate = (ups) => entities.applyUpdate(ups);
  net.onSnapshot = (snap) => entities.applySnapshot(snap.entities);

  // 世界 Boss 全局共享状态（S2C_BOSS）：更新渲染 + HUD 顶栏
  net.onBoss = (b) => {
    bossStates.set(b.wid, b);
    renderer.setBossState(b);
    updateBossHud();
  };
  // 世界共享事件（S2C_EVENT）：伤害/死亡/复活/技能
  net.onEvent = (ev) => {
    if (ev.evtType === 2 && ev.wid === net.selfWid) {
      $('hud-conn').textContent = '你被击倒了（已回血保护）';
      $('hud-conn').className = 'hud-chip warn';
    }
    // 技能简易效果（前摇圈 / AOE 范围圈 / 打断闪红）
    if (ev.evtType === EVT.SKILL_CASTING) {
      const sd = skillDef(ev.b);
      renderer.addSkillEffect({
        kind: 'cast', wid: ev.wid, x: ev.x, z: ev.z,
        color: sd.color, durMs: Math.max(200, sd.castMs),
      });
    } else if (ev.evtType === EVT.SKILL_CANCEL) {
      renderer.clearCasting(ev.wid);
      // 打断闪红（定位施法者当前位置）
      const ent = findEntityByWid(ev.wid);
      if (ent) {
        renderer.addSkillEffect({ kind: 'cancel', wid: ev.wid, x: ent.x, z: ent.z, durMs: 260 });
      }
    } else if (ev.evtType === EVT.SKILL) {
      const sd = skillDef(ev.b);
      if (sd.radius > 0) { // 仅 AOE 画范围圈（结算落点）
        renderer.addSkillEffect({ kind: 'aoe', x: ev.x, z: ev.z, radius: sd.radius, color: sd.color, durMs: 900 });
      }
    }
  };

  // 物品系统：背包/装备/金币（服务端权威全量）
  net.onInventory = (msg) => {
    inventory = msg.inventory;
    equip = msg.equip;
    gold = msg.gold;
    renderInventory();
    renderEquip();
    renderHud();
  };
  // 自身属性：血量/蓝量/攻击/防御
  net.onStats = (msg) => {
    playerStats = msg;
    renderHud();
  };
  // 商店列表
  net.onShop = (msg) => {
    shopData = msg;
    openShopPanel();
  };
  // 拾取反馈
  net.onLoot = (msg) => {
    if (msg.ok) toast('拾取成功', 'ok');
    else toast('拾取失败');
  };

  // 技能系统：已学技能 + 冷却（服务端权威）
  net.onSkills = (msg) => {
    learnedSkills = msg.skills;
    skillBar = msg.skills.map((s) => s.id).sort((a, b) => a - b);
    renderSkillBar();
  };
  // 技能施放反馈
  net.onSkillCast = (msg) => {
    skillCastFeedback = msg;
    const sd = skillDef(msg.skillId);
    if (msg.ok) {
      toast(`释放【${sd.name}】`, 'ok');
      // 有前摇：本地立即画自身前摇圈（服务器 EVT_SKILL_CASTING 随后到达，同 wid 去重）
      if (msg.castTimeMs > 0) {
        renderer.addSkillEffect({
          kind: 'cast', wid: net.selfWid, x: msg.x, z: msg.z,
          color: sd.color, durMs: msg.castTimeMs,
        });
      }
    } else {
      toast(`【${sd.name}】施放失败（冷却/蓝量/距离）`);
    }
    renderSkillBar();
  };
  // 自身 Buff 列表
  net.onBuffs = (msg) => {
    myBuffs = msg.buffs;
    renderBuffBar();
  };
  // 控制台结果（S2C_CONSOLE）：展示到右下角日志区
  net.onConsole = (msg) => {
    protocolLog('s2c', { type: 'CONSOLE', text: msg.text });
  };

  net.onSelf = (msg) => {
    // 服务端后校验不通过 → 回退到权威位置
    predictor.correction(msg.x, msg.y, msg.z);
    entities.setSelf(msg.x, msg.y, msg.z);
    console.warn('[prediction] 服务端回退:', msg.reason, msg.x.toFixed(2), msg.y.toFixed(2), msg.z.toFixed(2));
  };

  net.onKick = (msg) => {
    $('hud-conn').textContent = '已断开（' + (msg.reason || '违规') + '）';
    $('hud-conn').className = 'hud-chip off';
    running = false;
    net.close();
  };
  // 协议透传转换：把每次二进制帧解码结果实时投递到监控面板
  net.onProtocol = (dir, msg) => protocolLog(dir, msg);
  net.onBytes = (n) => {
    window.__ewBytes = (window.__ewBytes || 0) + n;
  };

  $('loading-text').textContent = '进入世界…';
  loading.classList.add('hidden');
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
}
// ---------------- 协议透传转换监控（二进制 ↔ 可读对象 实时解码展示） ----------------
function protocolLog(dir, msg) {
  const box = $('proto-log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'proto-line ' + dir;
  const t = msg.type;
  let detail = '';
  switch (t) {
    case 'HELLO': detail = `wid=${msg.self.wid} pos=(${msg.self.x.toFixed(1)},${msg.self.y.toFixed(1)},${msg.self.z.toFixed(1)}) seed=${msg.seed}`; break;
    case 'ENTER': detail = `count=${msg.entities.length}`; break;
    case 'LEAVE': detail = `wids=[${msg.wids.join(',')}]`; break;
    case 'UPDATE': detail = `count=${msg.updates.length}`; break;
    case 'SNAPSHOT': detail = `tick=${msg.tick} count=${msg.entities.length}`; break;
    case 'SELF': detail = `reason=${msg.reason} pos=(${msg.x.toFixed(1)},${msg.y.toFixed(1)},${msg.z.toFixed(1)})`; break;
    case 'KICK': detail = `reason=${msg.reason}`; break;
    case 'INPUT': detail = `seq=${msg.seq} mv=(${msg.moveX},${msg.moveZ}) jump=${msg.jump}`; break;
    case 'ATTACK': detail = `targetWid=${msg.targetWid} slot=${msg.slot}` + (msg.note ? ` ${msg.note}` : ''); break;
    case 'BOSS': detail = `wid=${msg.wid} ${msg.name} hp=${Math.round(msg.hp)}/${Math.round(msg.maxHp)} state=${msg.state} phase=${msg.phase} target=${msg.target}`; break;
    case 'EVENT': {
      const names = { 1: '伤害', 2: '死亡', 3: '复活', 4: '范围技能', 5: '掉落', 6: '技能前摇', 7: '技能打断' };
      detail = `${names[msg.evtType] || msg.evtType} wid=${msg.wid} b=${msg.b}`;
      break;
    }
    case 'SHOP': detail = `shopId=${msg.shopId} ${msg.name} 商品=${msg.entries.length}`; break;
    case 'INVENTORY': detail = `金币=${msg.gold} 装备=${Object.keys(msg.equip).length} 背包=${Object.keys(msg.inventory).length}`; break;
    case 'STATS': detail = `hp=${msg.hp}/${msg.maxHp} mp=${msg.mp}/${msg.maxMp} 攻=${msg.attack} 防=${msg.defense}`; break;
    case 'LOOT': detail = `ok=${msg.ok} item=${msg.itemId} count=${msg.count} gold=${msg.gold}`; break;
    case 'SHOP_OPEN': detail = `npcWid=${msg.npcWid}`; break;
    case 'SHOP_BUY': detail = `itemId=${msg.itemId} count=${msg.count}`; break;
    case 'PICKUP': detail = `dropWid=${msg.dropWid}`; break;
    case 'EQUIP': detail = `slot=${msg.slot} itemId=${msg.itemId}`; break;
    case 'USE_ITEM': detail = `itemId=${msg.itemId} count=${msg.count}`; break;
    case 'CAST_SKILL': detail = `skillId=${msg.skillId} target=${msg.targetWid} at(${msg.tx},${msg.tz})`; break;
    case 'CONSOLE': detail = `cmd=${msg.cmd || ''}${msg.text ? ' → ' + msg.text.replace(/\n/g, ' | ') : ''}`; break;
    case 'SKILLS': detail = `已学=${msg.skills.length} ${msg.skills.map((s) => `${skillName(s.id)}${s.cdMs ? '(cd' + (s.cdMs / 1000).toFixed(0) + 's)' : ''}`).join(' ')}`; break;
    case 'SKILL_CAST': detail = `ok=${msg.ok} skill=${skillName(msg.skillId)} target=${msg.targetWid}`; break;
    case 'BUFFS': detail = `buffs=${msg.buffs.length} ${msg.buffs.map((b) => `#${b.skillId}@${b.value.toFixed(1)}(${b.remainSec.toFixed(1)}s)`).join(' ')}`; break;
    default: detail = JSON.stringify(msg).slice(0, 80); break;
  }
  line.textContent = `[${dir === 's2c' ? '↓S2C' : '↑C2S'}] ${t} ${detail}`;
  box.appendChild(line);
  while (box.childNodes.length > 40) box.removeChild(box.firstChild);
}
// 供测试/调试挂载协议监控（渲染启动后设置）
window.__ewProtocolLog = protocolLog;

// 攻击范围（米，与服务端 playerAttackRange 一致）
const ATTACK_RANGE = 3.2;
function findNearestAttackable(px, pz) {
  let best = null, bestD = ATTACK_RANGE + 1;
  for (const e of entities.forRender()) {
    if (e.kind !== 'monster') continue;
    const d = Math.hypot(e.x - px, e.z - pz);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
// ---------------- 物品系统 UI（背包/装备/商店/属性） ----------------
function toast(text, cls) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 1800);
}
function renderHud() {
  const hpPct = playerStats.maxHp ? Math.max(0, Math.min(100, (playerStats.hp / playerStats.maxHp) * 100)) : 0;
  const mpPct = playerStats.maxMp ? Math.max(0, Math.min(100, (playerStats.mp / playerStats.maxMp) * 100)) : 0;
  const hf = $('hp-fill'), mf = $('mp-fill');
  if (hf) { hf.style.width = hpPct + '%'; $('hp-text').textContent = `${Math.round(playerStats.hp)}/${Math.round(playerStats.maxHp)}`; }
  if (mf) { mf.style.width = mpPct + '%'; $('mp-text').textContent = `${Math.round(playerStats.mp)}/${Math.round(playerStats.maxMp)}`; }
  const g = $('hud-gold');
  if (g) g.textContent = gold;
  const sa = $('stat-attack'), sd = $('stat-defense');
  if (sa) sa.textContent = Math.round(playerStats.attack);
  if (sd) sd.textContent = Math.round(playerStats.defense);
}
function findNearbyShopNpc(px, pz, range) {
  let best = null, bestD = range;
  for (const e of entities.forRender()) {
    if (e.kind !== 'npc' || !(e.name && e.name.indexOf('商店') !== -1)) continue;
    const d = Math.hypot(e.x - px, e.z - pz);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
function nearbyDrops(px, pz, range) {
  const out = [];
  for (const e of entities.forRender()) {
    if (e.kind !== 'item') continue;
    if (Math.hypot(e.x - px, e.z - pz) <= range) out.push(e);
  }
  return out;
}
function autoPickup(px, pz, range) {
  if (!entities || !net) return;
  for (const e of nearbyDrops(px, pz, range)) net.sendPickup(e.wid);
}
function pickupNearbyDrops(px, pz, range) {
  const drops = nearbyDrops(px, pz, range);
  if (!drops.length) { toast('附近没有可拾取的掉落物'); return; }
  for (const e of drops) net.sendPickup(e.wid);
}
function toggleInventoryPanel() {
  const p = $('inventory-panel');
  if (!p) return;
  const hidden = p.classList.contains('hidden');
  p.classList.toggle('hidden', !hidden);
  if (!hidden) { closeShopPanel(); }
  if (p.classList.contains('hidden') === false) renderInventory();
}
function openShopPanel() {
  if (!shopData) return;
  const p = $('shop-panel');
  if (!p) return;
  closeInventoryPanel();
  p.classList.remove('hidden');
  $('shop-title').textContent = shopData.name || '商店';
  const list = $('shop-list');
  list.innerHTML = '';
  for (const e of shopData.entries) {
    const d = itemDef(e.itemId);
    const row = document.createElement('div');
    row.className = 'shop-item';
    row.innerHTML =
      `<span class="item-icon">${d.icon}</span>
       <span class="item-name">${d.name}</span>
       <span class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}</span>
       <span class="item-desc">${itemDesc(e.itemId)}</span>
       <button class="buy-btn" data-id="${e.itemId}" data-price="${e.price}">${e.price}💰 购买</button>`;
    row.querySelector('.buy-btn').addEventListener('click', () => {
      if (gold < e.price) { toast('金币不足'); return; }
      net.sendShopBuy(e.itemId, 1);
    });
    list.appendChild(row);
  }
}
function closeShopPanel() { const p = $('shop-panel'); if (p) p.classList.add('hidden'); }
function closeInventoryPanel() { const p = $('inventory-panel'); if (p) p.classList.add('hidden'); }
function renderInventory() {
  const grid = $('inv-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const ids = Object.keys(inventory).map(Number).sort((a, b) => a - b);
  if (!ids.length) {
    grid.innerHTML = '<div class="inv-empty">背包空空如也（击杀怪物拾取掉落物）</div>';
  }
  for (const id of ids) {
    const cnt = inventory[id];
    const d = itemDef(id);
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.innerHTML = `
      <div class="item-icon">${d.icon}</div>
      <div class="item-cnt">×${cnt}</div>
      <div class="item-name">${d.name}</div>
      <div class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}</div>
      <div class="item-actions">
        ${d.type === 'equip' ? `<button class="act-btn" data-act="equip" data-slot="${d.slot}" data-id="${id}">穿戴</button>` : ''}
        ${d.type === 'consumable' ? `<button class="act-btn" data-act="use" data-id="${id}">使用</button>` : ''}
      </div>`;
    const act = cell.querySelector('.act-btn');
    if (act) {
      act.addEventListener('click', () => {
        const a = act.dataset.act;
        if (a === 'equip') { net.sendEquip(Number(act.dataset.slot), Number(act.dataset.id)); toast('装备中…'); }
        else if (a === 'use') { net.sendUseItem(Number(act.dataset.id), 1); toast('使用中…'); }
      });
    }
    grid.appendChild(cell);
  }
}
function renderEquip() {
  const list = $('equip-list');
  if (!list) return;
  list.innerHTML = '';
  for (let slot = 1; slot <= 6; slot++) {
    const itemId = equip[slot] || 0;
    const d = itemDef(itemId);
    const row = document.createElement('div');
    row.className = 'equip-row' + (itemId ? ' filled' : '');
    row.innerHTML = `
      <span class="equip-slot">${SLOT_NAME[slot] || slot}</span>
      <span class="item-icon">${itemId ? d.icon : '—'}</span>
      <span class="equip-name">${itemId ? d.name : '（空）'}</span>
      ${itemId ? `<button class="act-btn" data-slot="${slot}">卸下</button>` : ''}`;
    const btn = row.querySelector('.act-btn');
    if (btn) {
      btn.addEventListener('click', () => { net.sendEquip(slot, 0); toast('已卸下'); });
    }
    list.appendChild(row);
  }
}

// ---------------- 技能系统 UI（技能栏 + Buff 栏） ----------------
function renderSkillBar() {
  const bar = $('skill-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const now = performance.now();
  // 从服务端冷却（cdMs 剩余毫秒）倒计时展示
  const cdMap = {};
  for (const s of learnedSkills) cdMap[s.id] = s.cdMs || 0;
  skillBar.forEach((id, idx) => {
    const sd = skillDef(id);
    const cell = document.createElement('div');
    const cdLeft = cdMap[id] || 0;
    const onCd = cdLeft > 0;
    cell.className = 'skill-cell' + (onCd ? ' cd' : '');
    cell.innerHTML = `
      <div class="skill-icon">${sd.icon}</div>
      <div class="skill-key">${idx + 1}</div>
      <div class="skill-name">${sd.name}</div>
      <div class="skill-cd">${onCd ? (cdLeft / 1000).toFixed(1) + 's' : ''}</div>`;
    cell.addEventListener('click', () => {
      const sid = skillBar[idx];
      if (sid) castSkillNow(sid);
    });
    bar.appendChild(cell);
  });
  if (!skillBar.length) {
    bar.innerHTML = '<div class="skill-cell empty">未习得技能（控制台 skill 1001 学习）</div>';
  }
}
function renderBuffBar() {
  const bar = $('buff-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const buffNameMap = { 1: '攻击↑', 2: '防御↑', 3: '减速', 4: '回血', 5: '反伤' };
  for (const b of myBuffs) {
    const cell = document.createElement('div');
    cell.className = 'buff-cell';
    cell.innerHTML = `<span>${buffNameMap[b.type] || '#' + b.type}</span><span class="buff-t">${b.remainSec.toFixed(0)}s</span>`;
    bar.appendChild(cell);
  }
}
/** 施放技能：自动选取目标（单目标 → 最近怪物；AOE/自身 → 落点在自身位置） */
function castSkillNow(skillId) {
  if (!net || !predictor) return;
  const selfPos = predictor.predicted();
  const sd = skillDef(skillId);
  // 单目标技能：找最近的可攻击怪物（范围由服务端权威校验）
  let targetWid = 0;
  const isEnemy = [1001, 1006, 1007].includes(skillId); // 镜像：单目标伤害技能
  if (isEnemy) {
    let best = null, bestD = 6;
    for (const e of entities.forRender()) {
      if (e.kind !== 'monster') continue;
      const d = Math.hypot(e.x - selfPos.x, e.z - selfPos.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) targetWid = best.wid;
  }
  // AOE 技能：本地预览落点范围圈（对准最近怪物，无则自身前方）
  if (sd.radius > 0) {
    let ax = selfPos.x, az = selfPos.z;
    let best = null, bestD = sd.radius + 1;
    for (const e of entities.forRender()) {
      if (e.kind !== 'monster') continue;
      const d = Math.hypot(e.x - selfPos.x, e.z - selfPos.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) { ax = best.x; az = best.z; }
    renderer.showAoePreview(ax, az, sd.radius, sd.color);
  }
  net.sendCastSkill(skillId, targetWid, selfPos.x, selfPos.z);
}
// 按 wid 查找可见实体（技能效果定位用）
function findEntityByWid(wid) {
  for (const e of entities.forRender()) {
    if (e.wid === wid) return e;
  }
  return null;
}
// ---------------- 世界Boss HUD（全区共享血量条） ----------------
function updateBossHud() {
  const bar = $('boss-bar');
  if (!bar) return;
  // 展示：优先正在仇恨本玩家的 Boss，否则存活 Boss
  let pick = null;
  for (const b of bossStates.values()) {
    if (b.state === 1 && b.target === net.selfWid) { pick = b; break; }
  }
  if (!pick) {
    for (const b of bossStates.values()) {
      if (b.state !== 2 && (pick === null || b.hp / b.maxHp < pick.hp / pick.maxHp)) pick = b;
    }
  }
  if (!pick) { bar.style.display = 'none'; return; }
  bossDisplay = pick;
  bar.style.display = 'block';
  $('boss-name').textContent = `${pick.name || '世界Boss'} Lv.${pick.phase} ${pick.state === 2 ? '· 已阵亡' : ''}`;
  const pct = Math.max(0, Math.min(100, (pick.hp / pick.maxHp) * 100));
  $('boss-fill').style.width = pct + '%';
  $('boss-hp').textContent = `${Math.round(pick.hp)} / ${Math.round(pick.maxHp)}`;
}

// ---------------- 主循环 ----------------

function loop(now) {
  if (!running) return;
  const rawDt = (now - lastT) / 1000;         // 真实墙钟 dt（预测器用，保证实时推进）
  const dt = Math.min(0.1, rawDt);            // 插值/HUD 用 dt（防止爆炸）
  lastT = now;

  // 1) 读取输入 → 本地预测即时生效
  const mv = input.moveVector();
  inputAcc += dt;
  // 与服务端同频（20Hz）发送并推进预测
  if (inputAcc >= 0.05) {
    inputAcc -= 0.05;
    const jump = input.takeJump();
    predictor.applyInput(mv.x, mv.z, jump);
    const pred = predictor.predicted();
    net.sendInput(mv.x, mv.z, jump, pred);
  }

  // 2) 推进预测（内部按 50ms 步进；用真实 dt 保持与服务端实时同步），插值位置驱动自身渲染
  const selfPos = predictor.step(rawDt);
  net.setRef(selfPos.x, selfPos.y, selfPos.z); // 二进制相对坐标解码基准
  entities.setSelf(selfPos.x, selfPos.y, selfPos.z);

  // 攻击：J 键 → 攻击范围内最近的世界怪物/Boss（服务端权威校验）
  if (input.takeAttack()) {
    const target = findNearestAttackable(selfPos.x, selfPos.z);
    if (target) net.sendAttack(target.wid);
    else protocolLog('c2s', { type: 'ATTACK', targetWid: 0, slot: 0, note: '范围内无目标' });
  }
  // 技能系统：数字键 1-8 → 技能栏对应技能（服务端权威校验）
  const slot = input.takeSkillSlot();
  if (slot >= 1 && slot <= skillBar.length) {
    castSkillNow(skillBar[slot - 1]);
  }
  // 冷却倒计时/Buff 展示刷新（20Hz 足够，避免高刷）
  renderSkillBar();
  renderBuffBar();
  // 物品系统交互（selfPos 已就绪）
  if (input.takeInvToggle()) toggleInventoryPanel();
  if (input.takeShop()) {
    const npc = findNearbyShopNpc(selfPos.x, selfPos.z, 4);
    if (npc) net.sendShopOpen(npc.wid);
    else {
      toast('附近没有商店 NPC（走接近紫色描边的商店老板）');
      // 调试：列出视野内 NPC
      for (const e of entities.forRender()) {
        if (e.kind === 'npc') {
          protocolLog('c2s', { type: 'DBG_NPC', wid: e.wid, name: e.name, d: Math.hypot(e.x - selfPos.x, e.z - selfPos.z).toFixed(1), pos: `${e.x.toFixed(1)},${e.z.toFixed(1)}` });
        }
      }
    }
  }
  if (input.takePickup()) pickupNearbyDrops(selfPos.x, selfPos.z, 2.2);
  // 自动拾取：走到掉落物上自动捡起（服务端校验距离）
  autoPickup(selfPos.x, selfPos.z, 1.9);

  // 3) 其他实体插值
  entities.update(dt);
  // 地形流式加载（俯视 MMO：仅加载玩家可见范围内区块，超出卸载）+ 绘制
  renderer.updateTerrain(selfPos.x, selfPos.z);
  renderer.setSelf(selfPos.x, selfPos.y, selfPos.z, net.selfName);
  renderer.setEntities(entities.forRender());
  renderer.draw();

  // 4) HUD
  fpsAcc += dt;
  fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    $('hud-fps').textContent = `fps:${fps}`;
    $('hud-pos').textContent = `x:${selfPos.x.toFixed(1)} y:${selfPos.y.toFixed(1)} z:${selfPos.z.toFixed(1)}`;
    const b = $('proto-bps');
    if (b && window.__ewBytes) b.textContent = (window.__ewBytes / 1024).toFixed(1) + 'KB';
    fpsAcc = 0;
    fpsCount = 0;
  }

  window.__ewFrames = (window.__ewFrames || 0) + 1;
  requestAnimationFrame(loop);
}

// 供自动化测试暂停/恢复渲染（不影响正常用户）
// 面板关闭按钮
window.addEventListener('DOMContentLoaded', () => {
  const ic = $('inv-close'); if (ic) ic.addEventListener('click', closeInventoryPanel);
  const sc = $('shop-close'); if (sc) sc.addEventListener('click', closeShopPanel);
});

window.__ewPause = () => {
  running = false;
};
window.__ewResume = () => {
  if (running) return;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
};
