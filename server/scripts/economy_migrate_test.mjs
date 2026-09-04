#!/usr/bin/env node
/**
 * economy_migrate_test.mjs - 阶段8「旧存档迁移测试」（P8-d，服务端权威）
 *
 * 覆盖任务书 P8-d：旧存档无实例 → 装备转实例（applySaveItems 迁移路径）。
 * 内存模式无磁盘存档、同进程 e2e 无法自然产生旧格式存档，故经 /api/debug/loadlegacy
 * 调试端点注入旧格式存档 JSON，复现「登录读档」路径，调用真实 applySaveItems 迁移代码，
 * 再经 WS S2C_INVENTORY 帧验证迁移结果。
 *
 * 场景：
 *   A) 旧格式装备槽 {"weapon":1502,"helm":1001}（槽位键→itemId，无实例）
 *      → equip 槽自动分配 instId 转实例；
 *      旧格式背包堆叠装备 {"1502":3}（EQUIP 曾按 itemId 堆叠）→ equipBag 3 个独立实例；
 *      非装备 {"2001":10,"4006":5}（消耗品/材料）→ 保持堆叠（inventory）；
 *      全部迁移实例 instId 互异（无冲突 / 无泄漏）、迁移无损（数量守恒）。
 *   B) 新格式回归 {"slots":[...],"bag":[...]} → instId/enhance/locked 原样保留（不重分配）。
 *   C) instId 水位推进：迁移含高 instId 后，新发放装备 instId 更高且与迁移实例互异
 *      （applySaveItems 末尾 setInstIdFloor(maxInst) 防新旧 ID 冲突）。
 *
 * 依赖调试端点（EW_DEBUG=1）：/api/debug/loadlegacy；控制台命令：anticheat / monsterpause / item
 */
import { parseS2C, MSG } from '../../client/js/protocol.js';

const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'ecomigrate' + Math.floor(Math.random() * 100000);
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
const HELM_SLOT = 1, WEAPON_SLOT = 6;
const SWORD = 1502;        // 铁剑（EQUIP / WEAPON）
const HELM = 1001;         // 皮帽（EQUIP / HELM）
const FLAME = 1503;        // 烈焰剑（EQUIP / WEAPON，r2）
const POTION = 2001;       // 小血瓶（CONSUMABLE，堆叠）
const POTION_L = 2002;     // 大血瓶（CONSUMABLE，堆叠）
const STONE = 4006;        // 强化石（MATERIAL，堆叠）
// 新格式回归用的高位 instId（远高于全新进程计数器，确保 setInstIdFloor 水位推进可观测）
const NEW_INST_SLOT = 9001, NEW_INST_BAG = 9002;

let S = null, TOKEN = '';
function makeSession(token) {
  const s = { ws: null, ref: { x: 0, y: 0, z: 0 }, gotHello: false, inventory: null, stats: null, ready: null };
  const ws = new WebSocket(WS + '?token=' + token);
  ws.binaryType = 'arraybuffer'; s.ws = ws;
  s.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const handle = (m) => {
    if (m.type === MSG.S2C_HELLO) { s.ref = { x: m.self.x, y: m.self.y, z: m.self.z }; s.gotHello = true; }
    else if (m.type === MSG.S2C_INVENTORY) s.inventory = m;
    else if (m.type === MSG.S2C_STATS) s.stats = m;
  };
  ws.onmessage = (ev) => { for (const f of decodeFrames(new Uint8Array(ev.data))) { try { handle(parseS2C(f.type, f.payload, s.ref.x, s.ref.y, s.ref.z)); } catch (e) {} } };
  return s;
}
const wait = (condFn, ms) => new Promise(async (res) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); } res(condFn()); });
async function cc(command) { const r = await req('/api/console', 'POST', { token: TOKEN, command }); return r.j || { ok: false }; }

// ---- 存档注入（复现「登录读档」→ applySaveItems 迁移）----
async function loadLegacy(equipJson, inventoryJson) {
  S.inventory = null;   // 清空当前帧，确保随后 wait 读到的是迁移后的新帧
  const r = await req('/api/debug/loadlegacy', 'POST', { token: TOKEN, equipJson, inventoryJson });
  if (r.status !== 200 || !r.j || !r.j.ok) throw new Error('loadlegacy ' + r.status + ' ' + JSON.stringify(r.j));
  return r.j;   // { ok, equipBag, inventory }
}

// ---- INVENTORY 帧读取辅助 ----
const eqSlot = (slot) => (S.inventory && S.inventory.equip ? S.inventory.equip[slot] : null);
const bagOf = (itemId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.filter((it) => it.itemId === itemId) : []);
const bagInst = (instId) => (S.inventory && S.inventory.equipBag ? S.inventory.equipBag.find((it) => it.instId === instId) : null);
const matCount = (id) => (S.inventory && S.inventory.inventory ? (S.inventory.inventory[id] || 0) : 0);
// 汇总 equip 槽(1..6) + equipBag 的全部实例 instId
function allInstIds() {
  const ids = [];
  for (let sl = 1; sl <= 6; sl++) { const it = eqSlot(sl); if (it && it.instId) ids.push(it.instId); }
  if (S.inventory && S.inventory.equipBag) for (const it of S.inventory.equipBag) if (it && it.instId) ids.push(it.instId);
  return ids;
}
const distinct = (arr) => new Set(arr).size === arr.length;

async function login() {
  await req('/api/register', 'POST', { username: UN, password: PW }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: PW });
  TOKEN = j.token; return TOKEN;
}

async function main() {
  await login();
  S = makeSession(TOKEN);
  await S.ready;
  await cc('anticheat off'); await cc('monsterpause on');
  await wait(() => S.gotHello && S.inventory, 3500);
  check('登录并建立 WS 会话（收到 HELLO + INVENTORY）', S.gotHello && !!S.inventory);

  // ================= 场景 A：旧格式存档 → 装备实例迁移 =================
  console.log('--- 场景 A：旧格式（无实例）→ applySaveItems 迁移为实例 ---');
  // 旧装备槽：槽位键 -> itemId（无 instId）；旧背包：EQUIP 按 itemId 堆叠 + 非装备堆叠
  const respA = await loadLegacy(
    JSON.stringify({ weapon: SWORD, helm: HELM }),
    JSON.stringify({ [SWORD]: 3, [POTION]: 10, [STONE]: 5 }),
  );
  // 迁移后：武器槽 1502 实例 + 头盔槽 1001 实例 + 背包 3× 1502 实例；2001/4006 保持堆叠
  await wait(() => eqSlot(WEAPON_SLOT) && eqSlot(WEAPON_SLOT).itemId === SWORD
    && eqSlot(HELM_SLOT) && eqSlot(HELM_SLOT).itemId === HELM
    && bagOf(SWORD).length === 3 && matCount(POTION) === 10 && matCount(STONE) === 5, 3500);

  const w = eqSlot(WEAPON_SLOT), h = eqSlot(HELM_SLOT), bag = bagOf(SWORD);
  check('旧装备槽 weapon → 1502 实例化（instId>0）', w && w.itemId === SWORD && w.instId > 0,
    w ? `instId=${w.instId} itemId=${w.itemId}` : '空');
  check('旧装备槽 helm → 1001 实例化（instId>0）', h && h.itemId === HELM && h.instId > 0,
    h ? `instId=${h.instId} itemId=${h.itemId}` : '空');
  check('旧背包堆叠装备 1502×3 → 3 个独立实例', bag.length === 3 && bag.every((it) => it.instId > 0),
    `count=${bag.length} ids=[${bag.map((it) => it.instId).join(',')}]`);
  check('背包 3 个迁移实例 instId 互异', distinct(bag.map((it) => it.instId)),
    `ids=[${bag.map((it) => it.instId).join(',')}]`);
  check('非装备消耗品 2001 保持堆叠（=10）', matCount(POTION) === 10, `count=${matCount(POTION)}`);
  check('非装备材料 4006 保持堆叠（=5）', matCount(STONE) === 5, `count=${matCount(STONE)}`);

  const idsA = allInstIds();
  check('全部迁移实例 instId 互异（无 ID 冲突 / 无泄漏）', distinct(idsA) && idsA.length === 5,
    `n=${idsA.length} ids=[${idsA.join(',')}]`);
  // 无损：注入 1502 共 4 件（武器槽 1 + 背包 3）、1001 共 1 件
  const swordTotal = (w && w.itemId === SWORD ? 1 : 0) + bag.length;
  check('迁移无损：1502 实例总数守恒（武器槽1 + 背包3 = 4）', swordTotal === 4, `total=${swordTotal}`);
  check('loadlegacy HTTP 响应计数正确（equipBag=3 / inventory=2）',
    respA.equipBag === 3 && respA.inventory === 2, `equipBag=${respA.equipBag} inventory=${respA.inventory}`);

  // ================= 场景 B：新格式回归（instId/enhance/locked 原样保留）=================
  console.log('--- 场景 B：新格式 {"slots","bag"} → instId/enhance/locked 原样保留 ---');
  await loadLegacy(
    JSON.stringify({
      slots: [{ slot: WEAPON_SLOT, instId: NEW_INST_SLOT, itemId: FLAME, enhance: 9, locked: false }],
      bag: [{ instId: NEW_INST_BAG, itemId: SWORD, enhance: 3, locked: true }],
    }),
    JSON.stringify({ [POTION_L]: 7 }),
  );
  await wait(() => eqSlot(WEAPON_SLOT) && eqSlot(WEAPON_SLOT).instId === NEW_INST_SLOT
    && bagInst(NEW_INST_BAG) && matCount(POTION_L) === 7, 3500);

  const nb = eqSlot(WEAPON_SLOT), nbag = bagInst(NEW_INST_BAG);
  check('新格式 slots：instId 原样保留（9001，不重分配）', nb && nb.instId === NEW_INST_SLOT && nb.itemId === FLAME,
    nb ? `instId=${nb.instId} itemId=${nb.itemId}` : '空');
  check('新格式 slots：enhance 保留（+9）', nb && nb.enhance === 9, `enhance=${nb && nb.enhance}`);
  check('新格式 bag：instId 原样保留（9002）+ itemId 一致', nbag && nbag.itemId === SWORD,
    nbag ? `instId=${nbag.instId} itemId=${nbag.itemId}` : '空');
  check('新格式 bag：enhance(+3) / locked(true) 保留', nbag && nbag.enhance === 3 && nbag.locked === true,
    nbag ? `enhance=${nbag.enhance} locked=${nbag.locked}` : '空');
  check('新格式 inventory：堆叠数量保留（2002=7）', matCount(POTION_L) === 7, `count=${matCount(POTION_L)}`);

  // ================= 场景 C：instId 水位推进（迁移后新发放不冲突）=================
  console.log('--- 场景 C：setInstIdFloor 水位推进 → 迁移后新发放装备 instId 更高且互异 ---');
  // 场景 B 迁移的最大 instId=9002，applySaveItems 末尾 setInstIdFloor(9002) → nextInstId_>=9003
  await cc(`item ${SWORD} 1`);
  await wait(() => bagOf(SWORD).some((it) => it.instId !== NEW_INST_BAG), 3000);
  const fresh = bagOf(SWORD).find((it) => it.instId !== NEW_INST_BAG);
  const idsC = allInstIds();
  check('迁移后新发放装备获得全新 instId（水位推进 > 9002）', fresh && fresh.instId > NEW_INST_BAG,
    fresh ? `newInstId=${fresh.instId}` : '未发放');
  check('新发放 instId 与全部迁移实例互异（无 ID 冲突）', fresh && distinct(idsC) && !idsC.slice(0, -1).includes(fresh.instId),
    `ids=[${idsC.join(',')}]`);

  return await done(fail ? 1 : 0);
}

async function done(code) {
  try { await cc('monsterpause off'); await cc('anticheat on'); } catch (_) {}
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  try { if (S && S.ws) S.ws.close(); } catch (_) {}
  process.exit(code);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
