#!/usr/bin/env node
/**
 * economy_persist_test.mjs - 阶段8「经济系统持久化测试」（P8-c，服务端权威）
 *
 * 覆盖任务书 514-521 P8-c：下线 / 重登后经济状态无损保留（内存模式 MemoryStore 读权威，
 * closeConn→savePlayerToStore→serialize；重连→loadPlayer→applySaveItems→deserialize）。
 *
 * 校验下线前建立、重连后仍保留的状态：
 *   1) 背包装备实例强化等级（+7）        —— serializeEquip.bag[].enhance
 *   2) 背包装备实例锁定标记（locked）     —— serializeEquip.bag[].locked
 *   3) 已穿戴装备实例（武器槽 +4）        —— serializeEquip.slots[]
 *   4) 背包堆叠数量 / 金币 / 等级         —— inventoryJson / ps.gold / ps.level
 *   5) 仓库存入的强化装备（+5，instId 一致）—— warehouseJson 实例槽
 *   6) 仓库堆叠数量 / 仓库存金 / 扩展格数  —— warehouseJson
 *
 * 强化等级用 console setenhance 直接置位（确定性，隔离强化 RNG，仅测“值是否跨重连保留”）。
 * 依赖控制台命令（EW_DEBUG=1）：anticheat / monsterpause / level / gold / item / setenhance / lockitem
 */
import {
  encodeEquip, encodeWarehouseOpen, encodeWarehouseDeposit, encodeWarehouseExpand,
  parseS2C, MSG, KIND,
} from '../../client/js/protocol.js';

const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'ecopersist' + Math.floor(Math.random() * 100000);
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

// ---- 常量 ----
const NPC_TAG_BANK = 128, WEAPON_SLOT = 6;
const SWORD = 1502;        // 铁剑（装备实例）
const POTION_L = 2002;     // 大血瓶（堆叠）
const STONE = 4006;        // 强化石（堆叠）
const ENH_BAG = 7, ENH_EQUIP = 4, ENH_WH = 5;
const PROBE = [[6, 6], [15, 0], [0, 15], [15, 15], [18, 0], [0, 18], [-6, -6], [12, 12], [20, 20], [-12, 12], [10, -10], [-10, -10]];

let S = null, TOKEN = '';
function makeSession(token) {
  const s = {
    ws: null, ref: { x: 0, y: 0, z: 0 }, gotHello: false, known: new Map(),
    inventory: null, stats: null, warehouse: null, ready: null,
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
    else if (m.type === MSG.S2C_WAREHOUSE) s.warehouse = m;
  };
  ws.onmessage = (ev) => { for (const f of decodeFrames(new Uint8Array(ev.data))) { try { handle(parseS2C(f.type, f.payload, s.ref.x, s.ref.y, s.ref.z)); } catch (e) {} } };
  return s;
}
const wait = (condFn, ms) => new Promise(async (res) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); } res(condFn()); });
const send = (b) => S.ws.send(b);
async function cc(command) { const r = await req('/api/console', 'POST', { token: TOKEN, command }); return r.j || { ok: false }; }
async function tp(x, z) { const r = await post('/api/debug/teleport', { token: TOKEN, x, z }); S.ref = { x: r.x, y: r.y, z: r.z }; return r; }
async function findBanker() {
  for (const [px, pz] of PROBE) {
    await tp(px, pz);
    await wait(() => [...S.known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BANK)), 900);
    const b = [...S.known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BANK));
    if (b) return b;
  }
  return null;
}
const goldOf = () => (S.inventory ? S.inventory.gold : -1);
const matCount = (id) => (S.inventory && S.inventory.inventory ? (S.inventory.inventory[id] || 0) : 0);
const bagInst = (instId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.find((it) => it.instId === instId) : null);
const equippedInst = (slot) => (S.inventory && S.inventory.equip ? S.inventory.equip[slot] : null);
const whInstSlot = (instId) => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.find((sl) => sl.isInstance && sl.instId === instId) : null);
const whStack = (itemId) => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.filter((sl) => !sl.isInstance && sl.itemId === itemId) : []);
const whUnlocked = () => (S.warehouse ? S.warehouse.unlocked : -1);
const whGold = () => (S.warehouse ? S.warehouse.gold : -1);

async function login() {
  await req('/api/register', 'POST', { username: UN, password: PW }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: PW });
  TOKEN = j.token; return TOKEN;
}

async function main() {
  // ================= 第一段：建立持久化前状态 =================
  await login();
  S = makeSession(TOKEN);
  await S.ready;
  await cc('anticheat off'); await cc('monsterpause on');
  await cc('level 10');
  await cc('gold 50000');
  await cc(`item ${SWORD} 4`);      // 铁剑×4：A(背包+7) B(背包锁定) C(仓库+5) D(穿戴+4)
  await cc(`item ${POTION_L} 8`);   // 大血瓶×8：存 5 入仓库，背包留 3
  await cc(`item ${STONE} 6`);      // 强化石×6（背包堆叠保留）
  await wait(() => S.gotHello && S.inventory && S.stats, 3000);
  await wait(() => S.inventory.equipBag && S.inventory.equipBag.filter((it) => it.itemId === SWORD).length >= 4
    && matCount(POTION_L) >= 8 && matCount(STONE) >= 6, 3000);
  const swords = S.inventory.equipBag.filter((it) => it.itemId === SWORD).map((it) => it.instId);
  check('发放铁剑×4 + 大血瓶×8 + 强化石×6', swords.length >= 4 && matCount(POTION_L) >= 8,
    `swords=${swords.length} potion=${matCount(POTION_L)} stone=${matCount(STONE)}`);
  if (swords.length < 4) return await done(1);
  const [idA, idB, idC, idD] = swords;

  // 背包：A 强化 +7；B 锁定；D 穿戴后强化 +4
  await cc(`setenhance ${idA} ${ENH_BAG}`);
  await cc(`lockitem ${idB} 1`);
  await cc(`setenhance ${idC} ${ENH_WH}`);
  await cc(`setenhance ${idD} ${ENH_EQUIP}`);
  send(encodeEquip(WEAPON_SLOT, idD));
  await wait(() => bagInst(idA) && bagInst(idA).enhance === ENH_BAG
    && bagInst(idB) && bagInst(idB).locked
    && equippedInst(WEAPON_SLOT) && equippedInst(WEAPON_SLOT).instId === idD
    && equippedInst(WEAPON_SLOT).enhance === ENH_EQUIP, 2500);
  check('建立：背包装备 A 强化 +7', bagInst(idA) && bagInst(idA).enhance === ENH_BAG, `enh=${bagInst(idA) && bagInst(idA).enhance}`);
  check('建立：背包装备 B 已锁定', bagInst(idB) && bagInst(idB).locked === true, `locked=${bagInst(idB) && bagInst(idB).locked}`);
  check(`建立：武器槽穿戴 D 强化 +${ENH_EQUIP}`, equippedInst(WEAPON_SLOT) && equippedInst(WEAPON_SLOT).instId === idD && equippedInst(WEAPON_SLOT).enhance === ENH_EQUIP,
    equippedInst(WEAPON_SLOT) ? `instId=${equippedInst(WEAPON_SLOT).instId} enh=${equippedInst(WEAPON_SLOT).enhance}` : '未穿戴');

  // 仓库：存入 C(+5) + 大血瓶×5 + 存金 2000 + 扩展一次(30→60)
  const banker = await findBanker();
  check('银行 NPC 可见', !!banker, banker ? banker.name : '');
  if (!banker) return await done(1);
  await tp(banker.x, banker.z); await sleep(220);
  S.warehouse = null; send(encodeWarehouseOpen(banker.wid)); await wait(() => S.warehouse, 2000);
  send(encodeWarehouseDeposit(true, idC, SWORD, 1));
  await wait(() => whInstSlot(idC) && whInstSlot(idC).enhance === ENH_WH, 2500);
  send(encodeWarehouseDeposit(false, 0, POTION_L, 5));
  await wait(() => whStack(POTION_L).length === 1 && whStack(POTION_L)[0].count === 5, 2500);
  send(encodeWarehouseDeposit(false, 0, 0, 2000));
  await wait(() => whGold() === 2000, 2500);
  send(encodeWarehouseExpand());
  await wait(() => whUnlocked() === 60, 2500);
  check('建立：仓库存入强化装备 C(+5)', whInstSlot(idC) && whInstSlot(idC).enhance === ENH_WH, `enh=${whInstSlot(idC) && whInstSlot(idC).enhance}`);
  check('建立：仓库存入大血瓶×5', whStack(POTION_L)[0] && whStack(POTION_L)[0].count === 5, `count=${whStack(POTION_L)[0] && whStack(POTION_L)[0].count}`);
  check('建立：仓库存金 2000', whGold() === 2000, `whGold=${whGold()}`);
  check('建立：仓库扩展至 60 格', whUnlocked() === 60, `unlocked=${whUnlocked()}`);

  // 快照下线前状态
  const exp = {
    level: S.stats ? S.stats.level : -1,
    bagGold: goldOf(),
    bagPotion: matCount(POTION_L),   // 8 - 5 = 3
    bagStone: matCount(STONE),
    enhA: bagInst(idA) ? bagInst(idA).enhance : -1,
    lockedB: bagInst(idB) ? !!bagInst(idB).locked : false,
    enhD: equippedInst(WEAPON_SLOT) ? equippedInst(WEAPON_SLOT).enhance : -1,
    whUnlocked: whUnlocked(), whGold: whGold(),
    whEnhC: whInstSlot(idC) ? whInstSlot(idC).enhance : -1,
    whPotion: whStack(POTION_L)[0] ? whStack(POTION_L)[0].count : -1,
    idA, idB, idC, idD,
  };
  check('建立：背包大血瓶剩 3 / 强化石 6', exp.bagPotion === 3 && exp.bagStone === 6, `potion=${exp.bagPotion} stone=${exp.bagStone}`);

  // ================= 断线（触发 savePlayerToStore）=================
  console.log('--- 断线重连（内存 MemoryStore 持久化）---');
  try { S.ws.close(); } catch (_) {}
  await sleep(1300);

  // ================= 第二段：重连验证保留 =================
  await login();
  S = makeSession(TOKEN);
  await S.ready;
  await cc('anticheat off'); await cc('monsterpause on');
  await wait(() => S.gotHello && S.inventory && S.stats, 3500);
  await wait(() => bagInst(exp.idA) && equippedInst(WEAPON_SLOT) && equippedInst(WEAPON_SLOT).instId === exp.idD, 3000);

  check('重连：等级保留(10)', S.stats && S.stats.level === exp.level, `${exp.level} -> ${S.stats && S.stats.level}`);
  check('重连：背包金币保留', goldOf() === exp.bagGold, `${exp.bagGold} -> ${goldOf()}`);
  check('重连：背包大血瓶数量保留(3)', matCount(POTION_L) === exp.bagPotion, `${exp.bagPotion} -> ${matCount(POTION_L)}`);
  check('重连：背包强化石数量保留(6)', matCount(STONE) === exp.bagStone, `${exp.bagStone} -> ${matCount(STONE)}`);
  check('重连：背包装备 A 强化等级保留(+7)', bagInst(exp.idA) && bagInst(exp.idA).enhance === exp.enhA,
    `${exp.enhA} -> ${bagInst(exp.idA) && bagInst(exp.idA).enhance}`);
  check('重连：背包装备 B 锁定标记保留', bagInst(exp.idB) && bagInst(exp.idB).locked === exp.lockedB,
    `locked=${bagInst(exp.idB) && bagInst(exp.idB).locked}`);
  check('重连：武器槽装备 D 保留(instId 一致 + 强化 +4)',
    equippedInst(WEAPON_SLOT) && equippedInst(WEAPON_SLOT).instId === exp.idD && equippedInst(WEAPON_SLOT).enhance === exp.enhD,
    equippedInst(WEAPON_SLOT) ? `instId=${equippedInst(WEAPON_SLOT).instId} enh=${equippedInst(WEAPON_SLOT).enhance}` : '未穿戴');

  // 重连后重开仓库校验
  const banker2 = await findBanker();
  check('重连：银行 NPC 可见', !!banker2, banker2 ? banker2.name : '');
  if (banker2) {
    await tp(banker2.x, banker2.z); await sleep(220);
    S.warehouse = null; send(encodeWarehouseOpen(banker2.wid)); await wait(() => S.warehouse, 2500);
    check('重连：仓库扩展格数保留(60)', whUnlocked() === exp.whUnlocked, `${exp.whUnlocked} -> ${whUnlocked()}`);
    check('重连：仓库存金保留(2000)', whGold() === exp.whGold, `${exp.whGold} -> ${whGold()}`);
    const rc = whInstSlot(exp.idC);
    check('重连：仓库强化装备 C 保留(instId 一致 + 强化 +5)', rc && rc.enhance === exp.whEnhC,
      rc ? `instId=${rc.instId} enh=${rc.enhance}` : '装备丢失');
    const rp = whStack(POTION_L)[0];
    check('重连：仓库大血瓶堆叠保留(5)', rp && rp.count === exp.whPotion, `${exp.whPotion} -> ${rp && rp.count}`);
  }
  return await done(fail ? 1 : 0);
}

async function done(code) {
  try { await cc('monsterpause off'); await cc('anticheat on'); } catch (_) {}
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  try { if (S && S.ws) S.ws.close(); } catch (_) {}
  process.exit(code);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
