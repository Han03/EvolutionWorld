#!/usr/bin/env node
/**
 * economy_boundary_test.mjs - 阶段8「经济系统边界/拒绝路径测试」（P8-b，服务端权威）
 *
 * 覆盖任务书 514-521 P8-b 命名的 7 类边界（均为“非法/超限操作被正确拒绝、状态不变”）：
 *   [A] 商店：①限购达上限拒绝 ②金币不足拒绝 ③库存不足拒绝（stock<n）
 *   [B] 强化：④金币不足(failCode=2) ⑤强化石不足(failCode=3) ⑥满强化(failCode=1)
 *   [C] 合成：⑦材料不足(failCode=3) ⑧等级不足(failCode=2) ⑨金币不足(failCode=4)
 *   [D] 分解：⑩锁定装备拒绝(failCode=1) ⑪已穿戴拒绝(failCode=4)
 *   [E] 仓库：⑫取金不足(WH_NO_GOLD=3) ⑬满仓库拒绝存入(WH_FULL=1)
 *
 * 拒绝路径判定：多数无独立错误帧（商店购买为静默拒绝），靠“金币/数量/状态不变”验证；
 *               强化/合成/分解/仓库有 failCode / code 回执，直接校验码值。
 *
 * 关键前置编排（避免资源冲突）：
 *   - 全程【不发放强化石】→ 强化石不足(③)天然成立；
 *   - 合成材料【延后发放】→ 材料不足(⑦)先成立，再发放用于金币不足(⑨)；
 *   - 金币不足用例用 zeroGold()（giveGold 负值钳 0）临时清零，用后即恢复。
 *   - 库存不足(③)需 stock>0：经 /api/shop/edit 临时改 stock=2，测毕 finally 还原原配置。
 *
 * 依赖控制台命令（EW_DEBUG=1）：anticheat / monsterpause / level / gold / item / setenhance / lockitem
 */
import {
  encodeShopOpen, encodeShopBuy,
  encodeEnhance, encodeEquip, encodeDecompose,
  encodeCraft, encodeCraftList,
  encodeWarehouseOpen, encodeWarehouseDeposit, encodeWarehouseWithdraw,
  parseS2C, MSG, KIND,
} from '../../client/js/protocol.js';

const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'ecobound' + Math.floor(Math.random() * 100000);
const PW = 'pass1234';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
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

// ---- 常量 ----
const NPC_TAG_SHOP = 4, NPC_TAG_BLACKSMITH = 8, NPC_TAG_CRAFT = 64, NPC_TAG_BANK = 128;
const WEAPON_SLOT = 6;
const POTION_S = 2001;    // 小血瓶：buyLimit5 / discount3
const FLAME_ID = 1503;    // 烈焰剑：price120 / 无限购（金币不足 + 库存不足用例）
const IRON_ID = 1502;     // 铁剑：装备实例（强化/分解/仓库填充）
const MAT_STEEL = 4002, MAT_CRYSTAL = 4003;   // 合成 R4 材料
const R_STONE = 4;        // 强化石 ← 精钢×3 + 魔晶×1（lv3）
const R_PROTECT = 5;      // 保护符（lv8）：等级不足用例
const WH_OP = { DEPOSIT: 1, WITHDRAW: 2 };
const WH = { NO_GOLD: 3, FULL: 1 };
const PROBE = [[6, 6], [15, 0], [0, 15], [15, 15], [18, 0], [0, 18], [-6, -6], [12, 12], [20, 20], [-12, 12], [10, -10], [-10, -10]];

// ---- WS 会话 ----
let S = null;
function makeSession(token) {
  const s = {
    ws: null, ref: { x: 0, y: 0, z: 0 }, gotHello: false, known: new Map(),
    inventory: null, stats: null, shop: null, enhance: null, decompose: null,
    craft: null, craftList: null, warehouse: null, whResult: null, sawFull: false, ready: null,
  };
  const ws = new WebSocket(WS + '?token=' + token);
  ws.binaryType = 'arraybuffer'; s.ws = ws;
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
    else if (m.type === MSG.S2C_WAREHOUSE_RESULT) { s.whResult = m; if (m.op === 1 && m.code === 1) s.sawFull = true; }
  };
  ws.onmessage = (ev) => { for (const f of decodeFrames(new Uint8Array(ev.data))) { try { handle(parseS2C(f.type, f.payload, s.ref.x, s.ref.y, s.ref.z)); } catch (e) {} } };
  return s;
}
const wait = (condFn, ms) => new Promise(async (res) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); } res(condFn()); });
const send = (b) => S.ws.send(b);
let TOKEN = '';
async function cc(command) { const r = await req('/api/console', 'POST', { token: TOKEN, command }); return r.j || { ok: false }; }
async function tp(x, z) { const r = await post('/api/debug/teleport', { token: TOKEN, x, z }); S.ref = { x: r.x, y: r.y, z: r.z }; return r; }
async function findNpc(tag) {
  for (const [px, pz] of PROBE) {
    await tp(px, pz);
    await wait(() => [...S.known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & tag)), 900);
    const n = [...S.known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & tag));
    if (n) return n;
  }
  return null;
}
async function approach(npc) { await tp(npc.x, npc.z); await sleep(220); }
// 金币临时清零 / 恢复（giveGold 负值钳 0）
async function zeroGold() { await cc(`gold -${goldOf()}`); await wait(() => goldOf() === 0, 1500); }
async function bigGold() { await cc('gold 300000'); await wait(() => goldOf() >= 300000, 1500); }
// ---- 读取辅助 ----
const goldOf = () => (S.inventory ? S.inventory.gold : -1);
const matCount = (id) => (S.inventory && S.inventory.inventory ? (S.inventory.inventory[id] || 0) : 0);
const bagCountOf = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.filter((it) => it.itemId === itemId).length : 0);
const bagInstIds = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.filter((it) => it.itemId === itemId).map((it) => it.instId) : []);
const shopEntry = (id) => (S.shop && S.shop.entries ? S.shop.entries.find((e) => e.itemId === id) : null);
const whSlots = () => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.length : -1);
const whGold = () => (S.warehouse ? S.warehouse.gold : -1);

// 库存不足用例需临时改商店 stock；记录原配置用于 finally 还原
let origShops = null;
async function restoreShops() {
  if (!origShops || !TOKEN) return;
  try { await req('/api/shop/edit', 'POST', { token: TOKEN, shops: origShops }); } catch (_) {}
}

async function main() {
  // ---- 读配置（自配置期望值）----
  const gd = await req('/api/gamedata');
  check('GET /api/gamedata ok', gd.status === 200 && gd.j && gd.j.ok === true, `status=${gd.status}`);
  const G = gd.j || {};
  origShops = clone(G.shops || {});
  const enhCfg = G.enhance || { maxLevel: 15, levels: [] };
  const MAX_ENH = Math.min(enhCfg.maxLevel || 15, 15);
  const recipes = (G.craft && G.craft.recipes) || [];
  const r4 = recipes.find((x) => x.recipeId === R_STONE) || {};
  const r4Mats = r4.materials || [];
  const r5 = recipes.find((x) => x.recipeId === R_PROTECT) || {};
  check('配置齐备(满强化级/R4材料/R5等级)', MAX_ENH > 0 && r4Mats.length > 0 && r5.levelReq > 1,
    `maxEnh=${MAX_ENH} r4Mats=${r4Mats.length} r5Lv=${r5.levelReq}`);

  // ---- 登录 + WS + 环境准备（全程不发放强化石；合成材料延后发放）----
  await req('/api/register', 'POST', { username: UN, password: PW }).catch(() => {});
  const lg = await post('/api/login', { username: UN, password: PW });
  TOKEN = lg.token;
  S = makeSession(TOKEN);
  await S.ready;
  await cc('anticheat off'); await cc('monsterpause on'); await cc('enhanceforce off');
  await cc('level 10');
  await cc('gold 300000');
  await cc(`item ${IRON_ID} 40`);   // 铁剑×40（强化/分解/仓库填充实例）
  await wait(() => S.gotHello && S.inventory && S.stats, 3000);
  await wait(() => bagCountOf(IRON_ID) >= 40, 3000);
  const ironIds = bagInstIds(IRON_ID);
  check('发放铁剑×40 装备实例', ironIds.length >= 40, `n=${ironIds.length}`);
  if (ironIds.length < 40) return await done(1);
  const swordMax = ironIds[0], swordGold = ironIds[1], swordStone = ironIds[2], swordLock = ironIds[3], swordEquip = ironIds[4];
  const whFill = ironIds.slice(5, 37);   // 32 件用于填满 30 格仓库

  try {
    // ============ [A] 商店边界 ============
    console.log('[A] 商店边界：限购 / 金币不足 / 库存不足');
    const shopNpc = await findNpc(NPC_TAG_SHOP);
    check('商店 NPC 可见', !!shopNpc, shopNpc ? shopNpc.name : '');
    if (!shopNpc) return await done(1);
    await approach(shopNpc);
    S.shop = null; send(encodeShopOpen(shopNpc.wid)); await wait(() => S.shop, 2000);

    // ① 限购达上限拒绝：小血瓶 buyLimit5，买满5后第6次静默拒绝
    const e2001 = shopEntry(POTION_S);
    check('小血瓶条目 buyLimit=5', e2001 && e2001.buyLimit === 5, e2001 ? `buyLimit=${e2001.buyLimit}` : '无2001');
    const limit = e2001 ? e2001.buyLimit : 5;
    for (let i = 0; i < limit; i++) { send(encodeShopBuy(POTION_S, 1)); await wait(() => matCount(POTION_S) >= i + 1, 1500); }
    check('限购内买满 5 个', matCount(POTION_S) === limit && shopEntry(POTION_S).bought === limit,
      `inv=${matCount(POTION_S)} bought=${shopEntry(POTION_S) && shopEntry(POTION_S).bought}`);
    let gBefore = goldOf(), cBefore = matCount(POTION_S);
    send(encodeShopBuy(POTION_S, 1)); await sleep(400);
    check('① 超限购拒绝购买(金币/数量不变)', goldOf() === gBefore && matCount(POTION_S) === cBefore,
      `gold ${gBefore}->${goldOf()} inv ${cBefore}->${matCount(POTION_S)}`);

    // ② 金币不足拒绝购买：清零金币 → 买烈焰剑(120) → 拒绝
    await zeroGold();
    gBefore = goldOf(); const flameBefore = bagCountOf(FLAME_ID);
    send(encodeShopBuy(FLAME_ID, 1)); await sleep(400);
    check('② 金币不足拒绝购买(金币/数量不变)', goldOf() === 0 && bagCountOf(FLAME_ID) === flameBefore,
      `gold=${goldOf()} bag1503 ${flameBefore}->${bagCountOf(FLAME_ID)}`);
    await bigGold();

    // ③ 库存不足拒绝：临时将烈焰剑 stock=2 → 买 5 拒绝 / 买 2 成功 → 还原
    const modShops = clone(origShops);
    let mutated = false;
    for (const k of Object.keys(modShops)) {
      const es = modShops[k].entries || [];
      for (const e of es) if ((e.item | 0) === FLAME_ID) { e.stock = 2; mutated = true; }
    }
    check('③ 商店配置可定位烈焰剑条目(改 stock=2)', mutated);
    if (mutated) {
      const ed = await req('/api/shop/edit', 'POST', { token: TOKEN, shops: modShops });
      check('shop/edit 设置 stock=2 生效', ed.status === 200 && ed.j && ed.j.ok === true, `status=${ed.status}`);
      S.shop = null; send(encodeShopOpen(shopNpc.wid)); await wait(() => S.shop && shopEntry(FLAME_ID) && shopEntry(FLAME_ID).stock === 2, 2000);
      check('重开商店读到 stock=2', shopEntry(FLAME_ID) && shopEntry(FLAME_ID).stock === 2,
        shopEntry(FLAME_ID) ? `stock=${shopEntry(FLAME_ID).stock}` : '无');
      const flameB2 = bagCountOf(FLAME_ID), gB2 = goldOf();
      send(encodeShopBuy(FLAME_ID, 5)); await sleep(400);   // n=5 > stock=2 → 拒绝
      check('③ 库存不足拒绝(count=5>stock=2，数量/金币不变)',
        bagCountOf(FLAME_ID) === flameB2 && goldOf() === gB2, `bag ${flameB2}->${bagCountOf(FLAME_ID)} gold ${gB2}->${goldOf()}`);
      send(encodeShopBuy(FLAME_ID, 2)); await wait(() => bagCountOf(FLAME_ID) === flameB2 + 2, 2000);   // n=2 ≤ stock → 成功
      check('③ 库存内购买成功(count=2≤stock=2)', bagCountOf(FLAME_ID) === flameB2 + 2, `bag ${flameB2}->${bagCountOf(FLAME_ID)}`);
      await restoreShops();
      const gChk = await req('/api/gamedata');
      const restored = ((gChk.j && gChk.j.shops) || {});
      let stockBack = true;
      for (const k of Object.keys(restored)) for (const e of (restored[k].entries || [])) if ((e.item | 0) === FLAME_ID && e.stock !== 0) stockBack = false;
      check('③ 还原后 stock 复原(=0 无限量)', stockBack);
    }

    // ============ [B]+[D] 铁匠边界：强化 + 分解 ============
    console.log('[B/D] 铁匠边界：强化(金币/强化石/满级) + 分解(锁定/已穿戴)');
    const smith = await findNpc(NPC_TAG_BLACKSMITH);
    check('铁匠 NPC 可见', !!smith, smith ? smith.name : '');
    if (!smith) return await done(1);
    await approach(smith);

    // ⑥ 满强化拒绝：setenhance 到 maxLevel → 再强化 failCode=1
    await cc(`setenhance ${swordMax} ${MAX_ENH}`);
    await wait(() => { const it = S.inventory.equipBag.find((x) => x.instId === swordMax); return it && it.enhance === MAX_ENH; }, 2000);
    S.enhance = null; send(encodeEnhance(swordMax, false)); await wait(() => S.enhance, 2000);
    check(`⑥ 满强化(+${MAX_ENH})拒绝(failCode=1)`, S.enhance && !S.enhance.ok && S.enhance.failCode === 1,
      S.enhance ? `ok=${S.enhance.ok} failCode=${S.enhance.failCode}` : '无回执');

    // ④ 强化金币不足：清零金币 → 强化 +0 铁剑 → failCode=2
    await zeroGold();
    S.enhance = null; send(encodeEnhance(swordGold, false)); await wait(() => S.enhance, 2000);
    check('④ 强化金币不足(failCode=2)', S.enhance && !S.enhance.ok && S.enhance.failCode === 2,
      S.enhance ? `ok=${S.enhance.ok} failCode=${S.enhance.failCode}` : '无回执');
    await bigGold();

    // ⑤ 强化石不足：金币充足但全程未发放强化石 → failCode=3
    check('前置：强化石持有=0', matCount(4006) === 0, `stone=${matCount(4006)}`);
    S.enhance = null; send(encodeEnhance(swordStone, false)); await wait(() => S.enhance, 2000);
    check('⑤ 强化石不足(failCode=3)', S.enhance && !S.enhance.ok && S.enhance.failCode === 3,
      S.enhance ? `ok=${S.enhance.ok} failCode=${S.enhance.failCode}` : '无回执');

    // ⑩ 锁定装备拒绝分解：lockitem → 分解 failCode=1
    await cc(`lockitem ${swordLock} 1`);
    await wait(() => { const it = S.inventory.equipBag.find((x) => x.instId === swordLock); return it && it.locked; }, 2000);
    S.decompose = null; send(encodeDecompose(swordLock)); await wait(() => S.decompose, 2000);
    check('⑩ 锁定装备拒绝分解(failCode=1)', S.decompose && !S.decompose.ok && S.decompose.failCode === 1,
      S.decompose ? `ok=${S.decompose.ok} failCode=${S.decompose.failCode}` : '无回执');
    await cc(`lockitem ${swordLock} 0`);

    // ⑪ 已穿戴拒绝分解：穿戴 → 分解 failCode=4 → 卸下
    send(encodeEquip(WEAPON_SLOT, swordEquip));
    await wait(() => S.inventory.equip[WEAPON_SLOT] && S.inventory.equip[WEAPON_SLOT].instId === swordEquip, 2000);
    S.decompose = null; send(encodeDecompose(swordEquip)); await wait(() => S.decompose, 2000);
    check('⑪ 已穿戴拒绝分解(failCode=4)', S.decompose && !S.decompose.ok && S.decompose.failCode === 4,
      S.decompose ? `ok=${S.decompose.ok} failCode=${S.decompose.failCode}` : '无回执');
    send(encodeEquip(WEAPON_SLOT, 0));
    await wait(() => bagCountOf(IRON_ID) > 0 && !(S.inventory.equip[WEAPON_SLOT] && S.inventory.equip[WEAPON_SLOT].instId === swordEquip), 2000);

    // ============ [C] 合成边界 ============
    console.log('[C] 合成边界：材料不足 / 等级不足 / 金币不足');
    const alch = await findNpc(NPC_TAG_CRAFT);
    check('合成 NPC 可见', !!alch, alch ? alch.name : '');
    if (!alch) return await done(1);
    await approach(alch);
    S.craftList = null; send(encodeCraftList(alch.wid)); await wait(() => S.craftList, 2000);

    // ⑦ 材料不足：未发放 4002/4003 → 合成 R4 failCode=3
    check('前置：合成材料持有=0', matCount(MAT_STEEL) === 0 && matCount(MAT_CRYSTAL) === 0, `steel=${matCount(MAT_STEEL)} crystal=${matCount(MAT_CRYSTAL)}`);
    S.craft = null; send(encodeCraft(R_STONE, 1)); await wait(() => S.craft, 2000);
    check('⑦ 合成材料不足(failCode=3)', S.craft && !S.craft.ok && S.craft.failCode === 3,
      S.craft ? `ok=${S.craft.ok} failCode=${S.craft.failCode}` : '无回执');

    // ⑧ 等级不足：level 1 → 合成 R5(lv8) failCode=2（直接发绕过列表过滤）
    await cc('level 1'); await wait(() => S.stats && S.stats.level === 1, 1500);
    S.craft = null; send(encodeCraft(R_PROTECT, 1)); await wait(() => S.craft, 2000);
    check('⑧ 合成等级不足(failCode=2)', S.craft && !S.craft.ok && S.craft.failCode === 2,
      S.craft ? `ok=${S.craft.ok} failCode=${S.craft.failCode}` : '无回执');
    await cc('level 10'); await wait(() => S.stats && S.stats.level >= 10, 1500);

    // ⑨ 金币不足：发放材料 + 清零金币 → 合成 R4 failCode=4
    await cc(`item ${MAT_STEEL} 6`); await cc(`item ${MAT_CRYSTAL} 6`);
    await wait(() => matCount(MAT_STEEL) >= 6 && matCount(MAT_CRYSTAL) >= 6, 2000);
    await zeroGold();
    S.craft = null; send(encodeCraft(R_STONE, 1)); await wait(() => S.craft, 2000);
    check('⑨ 合成金币不足(failCode=4)', S.craft && !S.craft.ok && S.craft.failCode === 4,
      S.craft ? `ok=${S.craft.ok} failCode=${S.craft.failCode}` : '无回执');
    await bigGold();

    // ============ [E] 仓库边界 ============
    console.log('[E] 仓库边界：取金不足 / 满仓库拒绝存入');
    const banker = await findNpc(NPC_TAG_BANK);
    check('银行 NPC 可见', !!banker, banker ? banker.name : '');
    if (!banker) return await done(1);
    await approach(banker);
    S.warehouse = null; send(encodeWarehouseOpen(banker.wid)); await wait(() => S.warehouse, 2000);
    check('打开仓库(unlocked=30)', S.warehouse && S.warehouse.unlocked === 30, S.warehouse ? `unlocked=${S.warehouse.unlocked}` : '无回执');

    // ⑫ 取金不足：存金 1000 → 取 5000 → WH_NO_GOLD
    send(encodeWarehouseDeposit(false, 0, 0, 1000));
    await wait(() => whGold() === 1000, 2000);
    S.whResult = null; send(encodeWarehouseWithdraw(false, 0, 0, 5000)); await wait(() => S.whResult && S.whResult.op === WH_OP.WITHDRAW, 2000);
    check('⑫ 取金不足拒绝(op=WITHDRAW, code=WH_NO_GOLD)',
      S.whResult && S.whResult.op === WH_OP.WITHDRAW && S.whResult.code === WH.NO_GOLD,
      S.whResult ? `op=${S.whResult.op} code=${S.whResult.code}` : '无回执');
    check('⑫ 取金不足后仓库存金不变(=1000)', whGold() === 1000, `whGold=${whGold()}`);

    // ⑬ 满仓库拒绝存入：填满 30 格（存 32 件装备实例）→ 溢出返回 WH_FULL，slots 封顶 30
    for (const instId of whFill) send(encodeWarehouseDeposit(true, instId, IRON_ID, 1));
    await wait(() => whSlots() === 30 && S.sawFull, 5000);
    check('⑬ 仓库填满后 slots 封顶=30', whSlots() === 30, `slots=${whSlots()}`);
    check('⑬ 满仓库拒绝存入(op=DEPOSIT, code=WH_FULL)', S.sawFull,
      S.sawFull ? 'sawFull=true' : (S.whResult ? `last op=${S.whResult.op} code=${S.whResult.code}` : '无回执'));
  } finally {
    await restoreShops();   // 兜底还原商店配置（即使中途异常）
  }
  return await done(fail ? 1 : 0);
}

async function done(code) {
  try { await cc('enhanceforce off'); await cc('monsterpause off'); await cc('anticheat on'); } catch (_) {}
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  try { if (S && S.ws) S.ws.close(); } catch (_) {}
  process.exit(code);
}
main().catch(async (e) => { console.error('FATAL', e); await restoreShops(); process.exit(1); });
