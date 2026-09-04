#!/usr/bin/env node
/**
 * economy_test.mjs - 阶段8「经济系统全链路集成测试」（P8-a，服务端权威，确定性）
 *
 * 目标：在单条 WS 会话中串起「获取→强化→分解→合成→存储」完整物品循环，
 *       验证各子系统协同工作时金币 / 背包 / 属性 / 实例状态的连续一致性。
 *       （各子系统单独的深度验收见 shop_econ/enhance/decompose/craft/warehouse_test.mjs）
 *
 * 闭环叙事（同一玩家、连续状态流转）：
 *   A 获取：商店买入烈焰剑(1503)           → 扣金 = 商品价，背包装备实例 +1
 *   B 强化：铁匠强化 +0→+5                  → 扣金/扣强化石（读配置累计），攻击随强化系数上升
 *   C 分解：铁匠分解 +5 烈焰剑              → 已穿戴先拒绝(failCode=4)→卸下→返还金币/强化石/魔晶，实例移除
 *   D 合成：炼金用「分解所得魔晶」合成强化石 → 扣材料/扣金，产出强化石(4006)（分解→合成闭环）
 *   E 存储：银行存入合成所得强化石 + 存金    → 仓库存取数量/金币一致（合成→存储闭环）
 *
 * 自配置：所有期望值（强化累计消耗、分解返还率、合成配方材料/金币、商品价）
 *         均从 GET /api/gamedata 实时读取计算，避免与配置漂移耦合。
 *
 * 依赖控制台命令（需服务端 EW_DEBUG=1）：anticheat / monsterpause / level / gold / item / enhanceforce
 */
import {
  encodeShopOpen, encodeShopBuy,
  encodeEnhance, encodeEquip, encodeDecompose,
  encodeCraft, encodeCraftList,
  encodeWarehouseOpen, encodeWarehouseDeposit, encodeWarehouseWithdraw,
  parseS2C, MSG, KIND,
} from '../../client/js/protocol.js';

// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'econchain' + Math.floor(Math.random() * 100000);
const PW = 'pass1234';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
async function post(path, body) {
  const r = await req(path, 'POST', body);
  if (r.status !== 200 || !r.j || !r.j.ok) throw new Error(path + ' ' + JSON.stringify(r.j));
  return r.j;
}
function decodeFrames(buf) {
  const out = []; let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const HDR = 9;
  while (off + HDR <= buf.byteLength) {
    if (!(buf[off] === 0x45 && buf[off + 1] === 0x57)) break;
    const type = buf[off + 3];
    const len = dv.getUint16(off + 7, true);
    out.push({ type, payload: buf.slice(off + HDR, off + HDR + len) });
    off += HDR + len;
  }
  return out;
}

// ---- 常量（与服务端 items/enhance/craft/warehouse + protocol.js 对齐）----
const NPC_TAG_SHOP = 4;         // 商店
const NPC_TAG_BLACKSMITH = 8;   // 铁匠（强化 / 分解）
const NPC_TAG_CRAFT = 64;       // 炼金（合成）
const NPC_TAG_BANK = 128;       // 银行（仓库）
const WEAPON_SLOT = 6;          // EquipSlot::WEAPON
const FLAME_ID = 1503;          // 烈焰剑：rarity2 / price120 / attackBonus9 / levelReq5
const STONE_ID = 4006;          // 强化石（强化消耗 / 分解返还 / 合成产物）
const MAT_STEEL = 4002;         // 精钢碎片（合成强化石材料）
const MAT_CRYSTAL = 4003;       // 魔晶（分解 rarity2 保证产出 → 合成强化石材料）
const R_STONE = 4;              // 合成配方：强化石 ← 精钢×3 + 魔晶×1（lv3）
const ENH_TARGET = 5;           // 强化目标等级（+0→+5，读配置累计消耗）
const PROBE = [[6, 6], [15, 0], [0, 15], [15, 15], [18, 0], [0, 18], [-6, -6], [12, 12], [20, 20], [-12, 12], [10, -10], [-10, -10]];

// ---- WS 会话（闭包引用模块级 S）----
let S = null;
function makeSession(token) {
  const s = {
    ws: null, ref: { x: 0, y: 0, z: 0 }, gotHello: false, known: new Map(),
    inventory: null, stats: null, shop: null, enhance: null, decompose: null,
    craft: null, craftList: null, warehouse: null, whResult: null, ready: null,
  };
  const ws = new WebSocket(WS + '?token=' + token);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  s.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const handle = (m) => {
    if (m.type === MSG.S2C_HELLO) { s.ref = { x: m.self.x, y: m.self.y, z: m.self.z }; s.gotHello = true; }
    else if (m.type === MSG.S2C_SNAPSHOT || m.type === MSG.S2C_ENTER) { for (const e of m.entities) s.known.set(e.wid, e); }
    else if (m.type === MSG.S2C_LEAVE) { for (const w of m.wids) s.known.delete(w); }
    else if (m.type === MSG.S2C_INVENTORY) s.inventory = m;
    else if (m.type === MSG.S2C_STATS) s.stats = m;
    else if (m.type === MSG.S2C_SHOP) s.shop = m;
    else if (m.type === MSG.S2C_ENHANCE) s.enhance = m;
    else if (m.type === MSG.S2C_DECOMPOSE) s.decompose = m;
    else if (m.type === MSG.S2C_CRAFT) s.craft = m;
    else if (m.type === MSG.S2C_CRAFT_LIST) s.craftList = m;
    else if (m.type === MSG.S2C_WAREHOUSE) s.warehouse = m;
    else if (m.type === MSG.S2C_WAREHOUSE_RESULT) s.whResult = m;
  };
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, s.ref.x, s.ref.y, s.ref.z)); } catch (e) { console.error('decode', e); }
    }
  };
  return s;
}
const wait = (condFn, ms) => new Promise(async (res) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); }
  res(condFn());
});
const send = (b) => S.ws.send(b);
async function consoleCmd(token, command) {
  const r = await req('/api/console', 'POST', { token, command });
  return r.j || { ok: false };
}
async function tp(token, x, z) {
  const r = await post('/api/debug/teleport', { token, x, z });
  S.ref = { x: r.x, y: r.y, z: r.z }; return r;
}
// 多点探测累积 AOI 视野，找到指定 npcTag 位匹配的 NPC
async function findNpc(token, tag) {
  for (const [px, pz] of PROBE) {
    await tp(token, px, pz);
    await wait(() => [...S.known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & tag)), 900);
    const n = [...S.known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & tag));
    if (n) return n;
  }
  return null;
}
async function approach(token, npc) { await tp(token, npc.x, npc.z); await sleep(220); }

// ---- 背包 / 仓库读取辅助 ----
const goldOf = () => (S.inventory ? S.inventory.gold : -1);
const matCount = (id) => (S.inventory && S.inventory.inventory ? (S.inventory.inventory[id] || 0) : 0);
const bagInst = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.find((it) => it.itemId === itemId) : null);
const bagInstCount = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.filter((it) => it.itemId === itemId).length : 0);
const hasInst = (instId) => {
  if (!S.inventory) return false;
  for (let sl = 1; sl <= 6; sl++) { const ins = S.inventory.equip[sl]; if (ins && ins.instId === instId) return true; }
  return !!(S.inventory.equipBag && S.inventory.equipBag.some((it) => it.instId === instId));
};
const findInst = (instId) => {
  if (!S.inventory) return null;
  for (let sl = 1; sl <= 6; sl++) { const ins = S.inventory.equip[sl]; if (ins && ins.instId === instId) return ins; }
  if (S.inventory.equipBag) { const ins = S.inventory.equipBag.find((it) => it.instId === instId); if (ins) return ins; }
  return null;
};
const whStack = (itemId) => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.filter((sl) => !sl.isInstance && sl.itemId === itemId) : []);
const whUnlocked = () => (S.warehouse ? S.warehouse.unlocked : -1);
const whGold = () => (S.warehouse ? S.warehouse.gold : -1);

async function main() {
  // ---- 读取实时配置（自配置期望值）----
  const gd = await req('/api/gamedata');
  check('GET /api/gamedata ok', gd.status === 200 && gd.j && gd.j.ok === true, `status=${gd.status}`);
  const G = gd.j || {};
  const items = Array.isArray(G.items) ? G.items : [];
  const enhCfg = G.enhance || { levels: [], attrPerLevelAtk: 0.08 };
  const decRules = (G.decompose && G.decompose.rules) || [];
  const recipes = (G.craft && G.craft.recipes) || [];
  const flameDef = items.find((x) => x.id === FLAME_ID);
  const FLAME_PRICE = flameDef ? flameDef.price : 120;         // 分解金币返还基数
  const FLAME_RARITY = flameDef ? flameDef.rarity : 2;
  // 强化 +0→+ENH_TARGET 累计消耗（读等级表前 ENH_TARGET 项）
  const target = Math.min(ENH_TARGET, (enhCfg.levels || []).length);
  let enhGold = 0, enhStone = 0;
  for (let i = 0; i < target; i++) { enhGold += enhCfg.levels[i].goldCost | 0; enhStone += enhCfg.levels[i].stoneCount | 0; }
  // 分解规则（rarity2）：金币率 / 强化石率 / 保证产出材料
  const rule = decRules.find((r) => r.rarity === FLAME_RARITY) || decRules[decRules.length - 1] || {};
  const decGoldExp = Math.floor(FLAME_PRICE * (rule.goldReturnRate || 0.4));
  const decStoneExp = Math.floor((rule.enhanceStoneRate || 0.7) * target);
  const guaranteed = (rule.results || []).find((x) => (x.prob === undefined || x.prob >= 1));
  // 合成配方 R4：材料 / 金币 / 产物
  const r4 = recipes.find((x) => x.recipeId === R_STONE) || {};
  const r4Gold = r4.goldCost | 0;
  const r4Result = r4.resultItemId || STONE_ID;
  const r4ResultCount = (r4.resultCount | 0) || 1;
  const r4Mats = r4.materials || [];
  check('配置齐备(强化表/分解规则/合成配方/物品)',
    target > 0 && decRules.length > 0 && !!r4.recipeId && !!flameDef,
    `enhLv=${target} decRules=${decRules.length} r4=${r4.recipeId || 0} flame=${flameDef ? flameDef.price : 'NA'}`);

  // ---- 登录 + WS 会话 + 测试环境准备 ----
  await req('/api/register', 'POST', { username: UN, password: PW }).catch(() => {});
  const lg = await post('/api/login', { username: UN, password: PW });
  const token = lg.token;
  S = makeSession(token);
  await S.ready;
  await consoleCmd(token, 'anticheat off');
  await consoleCmd(token, 'monsterpause on');
  await consoleCmd(token, 'enhanceforce off');
  await consoleCmd(token, 'level 10');          // 满足烈焰剑 levelReq5 + 合成 R4 levelReq3
  await consoleCmd(token, 'gold 200000');
  await consoleCmd(token, `item ${STONE_ID} 30`);   // 强化石（强化消耗基准）
  await consoleCmd(token, `item ${MAT_STEEL} 12`);  // 精钢（合成 R4 备份材料）
  await consoleCmd(token, `item ${MAT_CRYSTAL} 6`); // 魔晶（合成 R4 备份材料）
  await wait(() => S.gotHello && S.inventory && S.stats, 3000);
  await wait(() => matCount(STONE_ID) >= 30 && matCount(MAT_STEEL) >= 12 && matCount(MAT_CRYSTAL) >= 6, 3000);
  check('会话就绪 + 发放强化石/精钢/魔晶进背包',
    matCount(STONE_ID) >= 30 && matCount(MAT_STEEL) >= 12 && matCount(MAT_CRYSTAL) >= 6,
    `stone=${matCount(STONE_ID)} steel=${matCount(MAT_STEEL)} crystal=${matCount(MAT_CRYSTAL)}`);

  // ============ A. 获取：商店买入烈焰剑 ============
  console.log('[A] 获取：商店购买烈焰剑(1503)');
  const shopNpc = await findNpc(token, NPC_TAG_SHOP);
  check('商店 NPC 可见', !!shopNpc, shopNpc ? shopNpc.name : '');
  if (!shopNpc) return finish(token, 1);
  await approach(token, shopNpc);
  S.shop = null;
  send(encodeShopOpen(shopNpc.wid));
  await wait(() => S.shop, 2000);
  const shopEntry = S.shop && S.shop.entries ? S.shop.entries.find((e) => e.itemId === FLAME_ID) : null;
  check('收到 SHOP 帧 + 烈焰剑条目(price>0)', !!shopEntry && shopEntry.price > 0,
    shopEntry ? `price=${shopEntry.price} disc=${shopEntry.discountPrice}` : '无1503条目');
  if (!shopEntry) return finish(token, 1);
  const buyPrice = shopEntry.discountPrice > 0 ? shopEntry.discountPrice : shopEntry.price;
  const goldA = goldOf(), flameBagA = bagInstCount(FLAME_ID);
  send(encodeShopBuy(FLAME_ID, 1));
  await wait(() => bagInstCount(FLAME_ID) > flameBagA && goldOf() === goldA - buyPrice, 2500);
  check('购买烈焰剑扣金 = 商品价', goldOf() === goldA - buyPrice, `gold ${goldA}->${goldOf()}（价 ${buyPrice}）`);
  check('烈焰剑进入背包装备实例', bagInstCount(FLAME_ID) === flameBagA + 1, `bag ${flameBagA}->${bagInstCount(FLAME_ID)}`);
  const flame = bagInst(FLAME_ID);
  const flameInstId = flame ? flame.instId : 0;
  check('装备实例 instId 有效(>0)', flameInstId > 0, `instId=${flameInstId}`);
  if (!flameInstId) return finish(token, 1);

  // ============ B. 强化：铁匠 +0→+5 ============
  console.log(`[B] 强化：铁匠强化烈焰剑 +0→+${target}`);
  const smith = await findNpc(token, NPC_TAG_BLACKSMITH);
  check('铁匠 NPC 可见', !!smith, smith ? smith.name : '');
  if (!smith) return finish(token, 1);
  await approach(token, smith);
  // 穿戴后强化，验证属性随强化系数上升
  send(encodeEquip(WEAPON_SLOT, flameInstId));
  await wait(() => S.inventory.equip[WEAPON_SLOT] && S.inventory.equip[WEAPON_SLOT].instId === flameInstId, 2000);
  check('烈焰剑穿戴到武器槽', S.inventory.equip[WEAPON_SLOT] && S.inventory.equip[WEAPON_SLOT].instId === flameInstId);
  await sleep(300);
  const atkAt0 = S.stats ? S.stats.attack : 0;
  await consoleCmd(token, 'enhanceforce success');
  const goldB = goldOf(), stoneB = matCount(STONE_ID);
  let allOk = true;
  for (let lv = 1; lv <= target; lv++) {
    S.enhance = null;
    send(encodeEnhance(flameInstId, false));
    const got = await wait(() => S.enhance && findInst(flameInstId) && findInst(flameInstId).enhance === lv, 2500);
    if (!got || !(S.enhance && S.enhance.ok && S.enhance.success)) allOk = false;
  }
  check(`连续强化至 +${target}（每级回执 ok/success）`,
    allOk && findInst(flameInstId) && findInst(flameInstId).enhance === target,
    `enhance=${findInst(flameInstId) && findInst(flameInstId).enhance}`);
  await wait(() => goldOf() === goldB - enhGold && matCount(STONE_ID) === stoneB - enhStone, 2500);
  check(`强化累计扣金 = ${enhGold}（读配置）`, goldOf() === goldB - enhGold, `gold ${goldB}->${goldOf()}`);
  check(`强化累计扣强化石 = ${enhStone}（读配置）`, matCount(STONE_ID) === stoneB - enhStone, `stone ${stoneB}->${matCount(STONE_ID)}`);
  await sleep(300);
  const atkAt5 = S.stats ? S.stats.attack : 0;
  check(`强化后攻击提升(+0→+${target})`, atkAt5 > atkAt0, `atk ${atkAt0}->${atkAt5} (Δ${atkAt5 - atkAt0})`);

  // ============ C. 分解：铁匠分解 +5 烈焰剑 ============
  console.log(`[C] 分解：铁匠分解 +${target} 烈焰剑（先验证已穿戴拒绝）`);
  // 已穿戴拒绝分解（failCode=4）→ 跨系统防护校验
  S.decompose = null;
  send(encodeDecompose(flameInstId));
  await wait(() => S.decompose, 2000);
  check('已穿戴拒绝分解(failCode=4)', S.decompose && !S.decompose.ok && S.decompose.failCode === 4,
    S.decompose ? `ok=${S.decompose.ok} failCode=${S.decompose.failCode}` : '无回执');
  // 卸下 → 回背包
  send(encodeEquip(WEAPON_SLOT, 0));
  await wait(() => bagInst(FLAME_ID) && bagInst(FLAME_ID).instId === flameInstId, 2000);
  check('卸下烈焰剑回到背包', !!bagInst(FLAME_ID) && bagInst(FLAME_ID).instId === flameInstId);
  // 分解：金币 / 强化石 / 保证材料返还 + 实例移除
  const goldC = goldOf(), stoneC = matCount(STONE_ID);
  const guarBefore = guaranteed ? matCount(guaranteed.itemId) : 0;
  S.decompose = null;
  send(encodeDecompose(flameInstId));
  await wait(() => S.decompose && S.decompose.ok, 2000);
  check('分解成功回执(ok)', S.decompose && S.decompose.ok,
    S.decompose ? `ok=${S.decompose.ok} failCode=${S.decompose.failCode}` : '无回执');
  check(`分解金币返还 = ${decGoldExp}（floor(${FLAME_PRICE}×${rule.goldReturnRate})）`,
    S.decompose && S.decompose.goldGain === decGoldExp, `goldGain=${S.decompose && S.decompose.goldGain}`);
  await wait(() => goldOf() === goldC + decGoldExp && matCount(STONE_ID) === stoneC + decStoneExp && !hasInst(flameInstId), 2500);
  check('分解金币入账', goldOf() === goldC + decGoldExp, `gold ${goldC}->${goldOf()}`);
  check(`分解返还强化石 = ${decStoneExp}（floor(${rule.enhanceStoneRate}×${target})）`,
    matCount(STONE_ID) === stoneC + decStoneExp, `stone ${stoneC}->${matCount(STONE_ID)}`);
  const guarDelta = guaranteed ? (matCount(guaranteed.itemId) - guarBefore) : -1;
  check(`分解产出保证材料(${guaranteed ? guaranteed.itemId : '?'})×[${guaranteed ? guaranteed.minCount : 0}-${guaranteed ? guaranteed.maxCount : 0}]`,
    guaranteed && guarDelta >= guaranteed.minCount && guarDelta <= guaranteed.maxCount, `Δ=${guarDelta}`);
  check('烈焰剑实例已移除', !hasInst(flameInstId), hasInst(flameInstId) ? '仍存在' : 'ok');

  // ============ D. 合成：炼金用分解所得魔晶合成强化石 ============
  console.log('[D] 合成：炼金合成强化石(4006)（分解→合成闭环）');
  const alch = await findNpc(token, NPC_TAG_CRAFT);
  check('合成 NPC 可见', !!alch, alch ? alch.name : '');
  if (!alch) return finish(token, 1);
  await approach(token, alch);
  S.craftList = null;
  send(encodeCraftList(alch.wid));
  await wait(() => S.craftList, 2000);
  const ids = S.craftList ? (S.craftList.recipeIds || []) : [];
  check('配方列表含强化石配方(R4)', ids.includes(R_STONE), `ids=[${ids}]`);
  // 记录合成前材料 / 金币 / 产物数量
  const goldD = goldOf(), stoneD = matCount(STONE_ID);
  const matBefore = {}; for (const m of r4Mats) matBefore[m.itemId] = matCount(m.itemId);
  S.craft = null;
  send(encodeCraft(R_STONE, 1));
  await wait(() => S.craft && S.craft.ok, 2000);
  check('合成成功回执(ok/isInstance=false/产物=强化石)',
    S.craft && S.craft.ok && S.craft.isInstance === false && S.craft.resultItemId === r4Result,
    S.craft ? `ok=${S.craft.ok} isInst=${S.craft.isInstance} item=${S.craft.resultItemId}` : '无回执');
  const matsOk = r4Mats.every((m) => matCount(m.itemId) === matBefore[m.itemId] - m.count);
  await wait(() => matCount(r4Result) >= stoneD + r4ResultCount && goldOf() === goldD - r4Gold && matsOk, 2500);
  check(`合成产出强化石 +${r4ResultCount}`, matCount(r4Result) >= stoneD + r4ResultCount, `4006 ${stoneD}->${matCount(r4Result)}`);
  check('合成扣除材料(读配方)', matsOk, r4Mats.map((m) => `${m.itemId}:${matBefore[m.itemId]}->${matCount(m.itemId)}`).join(' '));
  check(`合成扣金 = ${r4Gold}（读配方）`, goldOf() === goldD - r4Gold, `gold ${goldD}->${goldOf()}`);

  // ============ E. 存储：银行仓库存取强化石 + 存金 ============
  console.log('[E] 存储：银行仓库存取（合成→存储闭环）');
  const banker = await findNpc(token, NPC_TAG_BANK);
  check('银行 NPC 可见', !!banker, banker ? banker.name : '');
  if (!banker) return finish(token, 1);
  await approach(token, banker);
  S.warehouse = null;
  send(encodeWarehouseOpen(banker.wid));
  await wait(() => S.warehouse, 2000);
  check('打开仓库收到全量数据(S2C_WAREHOUSE)', !!S.warehouse, S.warehouse ? `unlocked=${S.warehouse.unlocked} gold=${S.warehouse.gold}` : '无回执');
  check('初始仓库格数=30 / 存金=0', whUnlocked() === 30 && whGold() === 0, `unlocked=${whUnlocked()} gold=${whGold()}`);
  // 存入强化石 ×5（堆叠）→ 仓库单格 count=5，背包 -5
  const stoneBag0 = matCount(STONE_ID);
  send(encodeWarehouseDeposit(false, 0, STONE_ID, 5));
  await wait(() => whStack(STONE_ID).length === 1 && whStack(STONE_ID)[0].count === 5 && matCount(STONE_ID) === stoneBag0 - 5, 2500);
  check('存入强化石×5 → 仓库单格 count=5', whStack(STONE_ID).length === 1 && whStack(STONE_ID)[0] && whStack(STONE_ID)[0].count === 5,
    `slots=${whStack(STONE_ID).length} count=${whStack(STONE_ID)[0] ? whStack(STONE_ID)[0].count : -1}`);
  check('存入后背包强化石 -5', matCount(STONE_ID) === stoneBag0 - 5, `bag ${stoneBag0}->${matCount(STONE_ID)}`);
  // 取出强化石 ×2 → 背包 +2，仓库剩 3
  const stoneBag1 = matCount(STONE_ID);
  send(encodeWarehouseWithdraw(false, 0, STONE_ID, 2));
  await wait(() => whStack(STONE_ID)[0] && whStack(STONE_ID)[0].count === 3 && matCount(STONE_ID) === stoneBag1 + 2, 2500);
  check('取出强化石×2 → 仓库剩 3', whStack(STONE_ID)[0] && whStack(STONE_ID)[0].count === 3,
    `count=${whStack(STONE_ID)[0] ? whStack(STONE_ID)[0].count : -1}`);
  check('取出后背包强化石 +2', matCount(STONE_ID) === stoneBag1 + 2, `bag ${stoneBag1}->${matCount(STONE_ID)}`);
  // 存金 1000 → 仓库存金 +1000，身上 -1000
  const goldE = goldOf();
  send(encodeWarehouseDeposit(false, 0, 0, 1000));
  await wait(() => whGold() === 1000 && goldOf() === goldE - 1000, 2500);
  check('存金 1000 → 仓库存金=1000 / 身上-1000', whGold() === 1000 && goldOf() === goldE - 1000,
    `whGold=${whGold()} bag ${goldE}->${goldOf()}`);
  // 取金 400 → 仓库存金=600，身上 +400
  const goldF = goldOf();
  send(encodeWarehouseWithdraw(false, 0, 0, 400));
  await wait(() => whGold() === 600 && goldOf() === goldF + 400, 2500);
  check('取金 400 → 仓库存金=600 / 身上+400', whGold() === 600 && goldOf() === goldF + 400,
    `whGold=${whGold()} bag ${goldF}->${goldOf()}`);

  return finish(token, fail ? 1 : 0);
}

async function finish(token, code) {
  // ---- 复位测试标志（避免污染运行时）----
  try {
    await consoleCmd(token, 'enhanceforce off');
    await consoleCmd(token, 'monsterpause off');
    await consoleCmd(token, 'anticheat on');
  } catch (_) {}
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  try { if (S && S.ws) S.ws.close(); } catch (_) {}
  process.exit(code);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
