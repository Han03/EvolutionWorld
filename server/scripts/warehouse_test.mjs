#!/usr/bin/env node
/**
 * warehouse_test.mjs - 阶段5「仓库系统」端到端验证（服务端权威，确定性测试）
 *
 * 覆盖验收标准（任务书 471-474）：
 *  1) 存取装备保留强化等级；堆叠物品正确合并
 *  2) 扩展花费金币递增（1000×1.5^n）；满 150 格拒绝扩展
 *  3) 仓库数据下线/重连后保留（serialize→store→deserialize 全链路）
 *  另覆盖：银行 NPC 邻近校验(WH_NO_NPC=5)、取金不足(WH_NO_GOLD=3)、存金/取金、
 *          装备存入移出背包/取出回背包、堆叠部分取出。
 *
 * 依赖控制台命令（需服务端 EW_DEBUG=1）：anticheat / monsterpause / level / gold / item / setenhance
 * 仓库默认配置（warehouse.cpp loadDefaults）：
 *   initialSlots=30  slotsPerPage=30  maxSlots=150
 *   expandBaseCost=1000  expandCostMul=1.5  maxGold=1亿
 *   扩展费用序列 30→60→90→120→150：1000 / 1500 / 2250 / 3375
 */
import { encodeWarehouseOpen, encodeWarehouseDeposit, encodeWarehouseWithdraw, encodeWarehouseExpand, parseS2C, MSG, KIND } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'whtest' + Math.floor(Math.random() * 100000);
const PW = 'pass1234';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(path + ' ' + JSON.stringify(j));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---- 常量（与服务端 warehouse.h / protocol.js 对齐）----
const NPC_TAG_BANK = 128;
const WH_OP = { OPEN: 0, DEPOSIT: 1, WITHDRAW: 2, EXPAND: 3 };
const WH = { OK: 0, FULL: 1, NOT_FOUND: 2, NO_GOLD: 3, MAX_SLOTS: 4, NO_NPC: 5, BAD_COUNT: 6, LOCKED: 7, GOLD_LIMIT: 8 };
const SWORD = 1502;      // 铁剑（装备实例，测强化保留）
const POTION_L = 2002;   // 大血瓶（堆叠，测合并）
const INITIAL_SLOTS = 30, MAX_SLOTS = 150;
const EXPAND_COSTS = [1000, 1500, 2250, 3375];   // 30→60→90→120→150（1000×1.5^n）
const ENH_LV = 7;        // 测试用强化等级

async function login() {
  await post('/api/register', { username: UN, password: PW }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: PW });
  return j.token;
}
async function consoleCmd(token, command) {
  const r = await fetch(BASE + '/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, command }),
  });
  return r.json().catch(() => ({ ok: false }));
}
// 建立一个 WS 会话（返回带状态与发送/等待辅助的对象）
function makeSession(token) {
  const s = {
    ws: null, ref: { x: 0, y: 0, z: 0 }, inventory: null, stats: null,
    warehouse: null, whResult: null, known: new Map(), gotHello: false, ready: null,
  };
  const ws = new WebSocket(WS + '?token=' + token);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  s.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) { s.ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; s.gotHello = true; }
    else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) { for (const e of msg.entities) s.known.set(e.wid, e); }
    else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) s.known.delete(w); }
    else if (msg.type === MSG.S2C_INVENTORY) s.inventory = msg;
    else if (msg.type === MSG.S2C_STATS) s.stats = msg;
    else if (msg.type === MSG.S2C_WAREHOUSE) s.warehouse = msg;
    else if (msg.type === MSG.S2C_WAREHOUSE_RESULT) s.whResult = msg;
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, s.ref.x, s.ref.y, s.ref.z)); } catch (e) { console.error('decode', e); }
    }
  };
  return s;
}
// 会话内辅助（闭包引用当前 s）
let S = null;
const wait = (condFn, ms) => new Promise(async (res) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); }
  res(condFn());
});
const send = (b) => S.ws.send(b);
const goldOf = () => (S.inventory ? S.inventory.gold : -1);
const invCount = (id) => (S.inventory && S.inventory.inventory ? (S.inventory.inventory[id] || 0) : 0);
const bagInst = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.find((it) => it.itemId === itemId) : null);
const bagHasInst = (instId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.some((it) => it.instId === instId) : false);
const whInstSlot = (instId) => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.find((sl) => sl.isInstance && sl.instId === instId) : null);
const whStackSlots = (itemId) => (S.warehouse && S.warehouse.slots ? S.warehouse.slots.filter((sl) => !sl.isInstance && sl.itemId === itemId) : []);
const whUnlocked = () => (S.warehouse ? S.warehouse.unlocked : -1);
const whGold = () => (S.warehouse ? S.warehouse.gold : -1);
async function tp(token, x, z) { const r = await post('/api/debug/teleport', { token, x, z }); S.ref = { x: r.x, y: r.y, z: r.z }; return r; }
// 多点探测累积 AOI 视野，找到银行 NPC（BANK 标签）
async function findBanker(token) {
  for (const [px, pz] of [[6, 6], [15, 0], [0, 15], [15, 15], [18, 0], [0, 18], [-6, -6], [12, 12], [20, 20], [-12, 12], [10, -10], [-10, -10]]) {
    await tp(token, px, pz);
    await wait(() => [...S.known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BANK)), 1000);
    const b = [...S.known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BANK));
    if (b) return b;
  }
  return null;
}

async function main() {
  const token = await login();
  S = makeSession(token);
  await S.ready;

  // ---- 测试环境准备 ----
  await consoleCmd(token, 'anticheat off');
  await consoleCmd(token, 'monsterpause on');
  await consoleCmd(token, 'level 1');
  await consoleCmd(token, 'gold 200000');
  await consoleCmd(token, 'item 2002 5');    // 大血瓶×5（堆叠，测合并）
  await consoleCmd(token, 'item 1502 1');    // 铁剑×1（装备实例，测强化保留）
  await wait(() => S.gotHello && S.inventory && S.stats, 3000);
  await wait(() => invCount(POTION_L) >= 5 && bagInst(SWORD), 3000);
  check('发放测试物品进背包', invCount(POTION_L) >= 5 && !!bagInst(SWORD), `potion=${invCount(POTION_L)} sword=${bagInst(SWORD) ? bagInst(SWORD).instId : 'none'}`);

  // 设置铁剑强化等级 +7（验证存取出保留强化）
  const sword = bagInst(SWORD);
  const swordInstId = sword ? sword.instId : 0;
  await consoleCmd(token, `setenhance ${swordInstId} ${ENH_LV}`);
  await wait(() => { const it = bagInst(SWORD); return it && it.enhance === ENH_LV; }, 2000);
  check('铁剑强化等级设为 +7', bagInst(SWORD) && bagInst(SWORD).enhance === ENH_LV,
    bagInst(SWORD) ? `enhance=${bagInst(SWORD).enhance}` : 'none');

  // 1) 超距拒绝：tp 城中心 (0,0)，银行 NPC 在远处（>交互距离）→ 存入返回 WH_NO_NPC(5)
  await tp(token, 0, 0);
  await sleep(250);
  S.whResult = null;
  send(encodeWarehouseDeposit(false, 0, POTION_L, 1));
  await wait(() => S.whResult, 2000);
  check('超距拒绝存入(op=DEPOSIT, code=WH_NO_NPC)',
    S.whResult && S.whResult.op === WH_OP.DEPOSIT && S.whResult.code === WH.NO_NPC,
    S.whResult ? `op=${S.whResult.op} code=${S.whResult.code}` : '无回执');

  // 找到银行 NPC 并贴近
  const banker = await findBanker(token);
  check('银行 NPC 可见', !!banker, banker ? banker.name : '');
  if (!banker) { console.log(`\n结果: PASS=${pass} FAIL=${fail}`); try { S.ws.close(); } catch (e) {} process.exit(1); }
  await tp(token, banker.x, banker.z);
  await sleep(250);

  // 2) 打开仓库：初始 unlocked=30，gold=0，slots 空
  S.warehouse = null;
  send(encodeWarehouseOpen(banker.wid));
  await wait(() => S.warehouse, 2000);
  check('打开仓库收到全量数据(S2C_WAREHOUSE)', !!S.warehouse, S.warehouse ? `unlocked=${S.warehouse.unlocked} gold=${S.warehouse.gold}` : '无回执');
  check('初始格数=30(initialSlots)', whUnlocked() === INITIAL_SLOTS, `unlocked=${whUnlocked()}`);
  check('初始存金=0', whGold() === 0, `gold=${whGold()}`);
  check('初始仓库为空', S.warehouse && S.warehouse.slots.length === 0, `slots=${S.warehouse ? S.warehouse.slots.length : -1}`);

  // 3) 存入装备：进仓库 + 保留强化 +7 + 从背包移除
  send(encodeWarehouseDeposit(true, swordInstId, SWORD, 1));
  await wait(() => whInstSlot(swordInstId) && !bagHasInst(swordInstId), 2500);
  const depSlot = whInstSlot(swordInstId);
  check('装备存入仓库(isInstance, instId 匹配)', !!depSlot, depSlot ? `instId=${depSlot.instId}` : '未入仓库');
  check('存入装备保留强化等级 +7', depSlot && depSlot.enhance === ENH_LV, depSlot ? `enhance=${depSlot.enhance}` : '');
  check('存入后从背包移除', !bagHasInst(swordInstId), bagHasInst(swordInstId) ? '仍在背包' : 'ok');

  // 4) 取出装备：回背包 + 保留强化 +7 + 从仓库移除
  send(encodeWarehouseWithdraw(true, swordInstId, SWORD, 1));
  await wait(() => bagHasInst(swordInstId) && !whInstSlot(swordInstId), 2500);
  const wdInst = bagInst(SWORD);
  check('装备取出回背包', bagHasInst(swordInstId), bagHasInst(swordInstId) ? 'ok' : '未回背包');
  check('取出装备保留强化等级 +7', wdInst && wdInst.enhance === ENH_LV, wdInst ? `enhance=${wdInst.enhance}` : '');
  check('取出后从仓库移除', !whInstSlot(swordInstId), whInstSlot(swordInstId) ? '仍在仓库' : 'ok');

  // 5) 存入堆叠 ×5 → 仓库一格 count=5，背包清空
  send(encodeWarehouseDeposit(false, 0, POTION_L, 5));
  await wait(() => whStackSlots(POTION_L).length === 1 && whStackSlots(POTION_L)[0].count === 5 && invCount(POTION_L) === 0, 2500);
  check('堆叠存入 大血瓶×5', whStackSlots(POTION_L).length === 1 && whStackSlots(POTION_L)[0].count === 5,
    `slots=${whStackSlots(POTION_L).length} count=${whStackSlots(POTION_L)[0] ? whStackSlots(POTION_L)[0].count : -1}`);
  check('存入后背包大血瓶清空', invCount(POTION_L) === 0, `inv=${invCount(POTION_L)}`);

  // 6) 再存 ×3 → 合并到同一格 count=8（验收：堆叠正确合并）
  await consoleCmd(token, 'item 2002 3');
  await wait(() => invCount(POTION_L) >= 3, 2000);
  send(encodeWarehouseDeposit(false, 0, POTION_L, 3));
  await wait(() => whStackSlots(POTION_L).length === 1 && whStackSlots(POTION_L)[0].count === 8 && invCount(POTION_L) === 0, 2500);
  check('堆叠合并：再存 ×3 → 单格 count=8', whStackSlots(POTION_L).length === 1 && whStackSlots(POTION_L)[0].count === 8,
    `slots=${whStackSlots(POTION_L).length} count=${whStackSlots(POTION_L)[0] ? whStackSlots(POTION_L)[0].count : -1}`);

  // 7) 部分取出 ×3 → 仓库 count=5，背包 +3
  send(encodeWarehouseWithdraw(false, 0, POTION_L, 3));
  await wait(() => whStackSlots(POTION_L)[0] && whStackSlots(POTION_L)[0].count === 5 && invCount(POTION_L) === 3, 2500);
  check('堆叠部分取出 ×3 → 仓库剩 5', whStackSlots(POTION_L)[0] && whStackSlots(POTION_L)[0].count === 5,
    `count=${whStackSlots(POTION_L)[0] ? whStackSlots(POTION_L)[0].count : -1}`);
  check('部分取出后背包 +3', invCount(POTION_L) === 3, `inv=${invCount(POTION_L)}`);

  // 8) 存金 1000：仓库 gold+1000，身上 gold-1000
  const g0 = goldOf();
  send(encodeWarehouseDeposit(false, 0, 0, 1000));
  await wait(() => whGold() === 1000 && goldOf() === g0 - 1000, 2500);
  check('存金 1000 → 仓库存金=1000', whGold() === 1000, `whGold=${whGold()}`);
  check('存金 1000 → 身上金币-1000', goldOf() === g0 - 1000, `${g0}->${goldOf()}`);

  // 9) 取金不足：仓库仅 1000，取 5000 → WH_NO_GOLD(3)
  S.whResult = null;
  send(encodeWarehouseWithdraw(false, 0, 0, 5000));
  await wait(() => S.whResult && S.whResult.op === WH_OP.WITHDRAW, 2000);
  check('取金不足拒绝(op=WITHDRAW, code=WH_NO_GOLD)',
    S.whResult && S.whResult.op === WH_OP.WITHDRAW && S.whResult.code === WH.NO_GOLD,
    S.whResult ? `op=${S.whResult.op} code=${S.whResult.code}` : '无回执');

  // 10) 取金 400：仓库 gold=600，身上 gold+400
  const g1 = goldOf();
  send(encodeWarehouseWithdraw(false, 0, 0, 400));
  await wait(() => whGold() === 600 && goldOf() === g1 + 400, 2500);
  check('取金 400 → 仓库存金=600', whGold() === 600, `whGold=${whGold()}`);
  check('取金 400 → 身上金币+400', goldOf() === g1 + 400, `${g1}->${goldOf()}`);

  // 11) 扩展费用递增：30→60→90→120→150，费用 1000/1500/2250/3375（1000×1.5^n）
  const targetSlots = [60, 90, 120, 150];
  for (let i = 0; i < EXPAND_COSTS.length; i++) {
    const cost = EXPAND_COSTS[i], target = targetSlots[i];
    const gBefore = goldOf();
    send(encodeWarehouseExpand());
    await wait(() => whUnlocked() === target && goldOf() === gBefore - cost, 2500);
    check(`扩展 #${i + 1}：unlocked ${i === 0 ? 30 : targetSlots[i - 1]}→${target}，扣金 ${cost}`,
      whUnlocked() === target && goldOf() === gBefore - cost,
      `unlocked=${whUnlocked()} gold ${gBefore}->${goldOf()}（期望 -${cost}）`);
  }

  // 12) 满 150 格拒绝扩展：code=WH_MAX_SLOTS(4)，unlocked 保持 150
  S.whResult = null;
  send(encodeWarehouseExpand());
  await wait(() => S.whResult && S.whResult.op === WH_OP.EXPAND, 2000);
  check('满 150 格拒绝扩展(op=EXPAND, code=WH_MAX_SLOTS)',
    S.whResult && S.whResult.op === WH_OP.EXPAND && S.whResult.code === WH.MAX_SLOTS,
    S.whResult ? `op=${S.whResult.op} code=${S.whResult.code}` : '无回执');
  check('拒绝后 unlocked 保持 150', whUnlocked() === MAX_SLOTS, `unlocked=${whUnlocked()}`);

  // 13) 持久化：重新存入强化装备 → 断线 → 重连 → 仓库数据保留
  send(encodeWarehouseDeposit(true, swordInstId, SWORD, 1));
  await wait(() => whInstSlot(swordInstId) && whInstSlot(swordInstId).enhance === ENH_LV, 2500);
  check('持久化前：强化装备已入仓库(+7)', whInstSlot(swordInstId) && whInstSlot(swordInstId).enhance === ENH_LV,
    whInstSlot(swordInstId) ? `enhance=${whInstSlot(swordInstId).enhance}` : '未入仓库');
  const expUnlocked = whUnlocked(), expGold = whGold(), expStack = whStackSlots(POTION_L)[0] ? whStackSlots(POTION_L)[0].count : 0;

  // 断线（触发 savePlayerToStore → serialize warehouse）
  try { S.ws.close(); } catch (e) {}
  await sleep(1000);

  // 重连（loadPlayer → applySaveItems → deserialize warehouse）
  const token2 = await login();
  S = makeSession(token2);
  await S.ready;
  await consoleCmd(token2, 'anticheat off');
  await consoleCmd(token2, 'monsterpause on');
  await wait(() => S.gotHello && S.inventory, 3000);
  const banker2 = await findBanker(token2);
  check('重连后银行 NPC 可见', !!banker2, banker2 ? banker2.name : '');
  if (banker2) {
    await tp(token2, banker2.x, banker2.z);
    await sleep(250);
    S.warehouse = null;
    send(encodeWarehouseOpen(banker2.wid));
    await wait(() => S.warehouse, 2500);
    check('重连后仓库 unlocked 保留(150)', whUnlocked() === expUnlocked, `${expUnlocked} -> ${whUnlocked()}`);
    check('重连后仓库存金保留(600)', whGold() === expGold, `${expGold} -> ${whGold()}`);
    const rs = whInstSlot(swordInstId);
    check('重连后强化装备保留 +7', rs && rs.enhance === ENH_LV, rs ? `enhance=${rs.enhance}` : '装备丢失');
    const rstack = whStackSlots(POTION_L)[0];
    check('重连后堆叠数量保留(5)', rstack && rstack.count === expStack, `${expStack} -> ${rstack ? rstack.count : -1}`);
  }

  // ---- 复位测试标志 ----
  await consoleCmd(token2, 'monsterpause off');
  await consoleCmd(token2, 'anticheat on');
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  try { S.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
