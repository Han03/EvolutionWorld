#!/usr/bin/env node
/**
 * shop_econ_test.mjs - 阶段1「商店系统扩展」端到端验证（服务端权威，确定性测试）
 *
 * 覆盖验收标准：
 *  1) 折扣价正确结算：小血瓶(2001) 原价5/每日特惠3，购买扣 3 金（非 5 金）
 *  2) 限购达上限后拒绝购买：2001 每日限购5，买满5后第6次被拒（金币/数量不变）
 *  3) 每日刷新重置限购：console `shoprefresh` 后 bought 归零，可再次购买
 *  4) 出售堆叠物品返还金币：2001 sellPrice=2 → +2 金，背包数量 -1
 *  5) 出售装备实例返还金币 + 实例移除：
 *     - 铁剑(1502) sellPrice=20，enhance=0 → +20 金，equipBag 移除该实例
 *     - 皮帽(1001) sellPrice=0（自动回收）→ ItemDef.price(8)×0.5 = +4 金
 *
 * 依赖默认商店配置（items.cpp loadDefaults）：
 *   2001 = {price5, discount3, buyLimit5, category2消耗品, refreshType1每日, sellPrice2}
 *   1502 = {price40, buyLimit2, category1装备, refreshType2每周, sellPrice20}
 *   1001 = {price8, sellPrice0(自动)}
 * 依赖控制台命令：gold / shoprefresh / anticheat / monsterpause（需服务端 EW_DEBUG=1）
 */
import { encodeShopOpen, encodeShopBuy, encodeShopSell, parseS2C, MSG, KIND } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'shoptest' + Math.floor(Math.random() * 100000);
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
async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const consoleCmd = async (command) => {
    const r = await fetch(BASE + '/api/console', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, command }),
    });
    return r.json().catch(() => ({ ok: false }));
  };
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';

  let ref = { x: 0, y: 0, z: 0 };
  let inventory = null, shop = null, sellResult = null;
  const known = new Map();
  let gotHello = false;
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) { ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true; }
    else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) { for (const e of msg.entities) known.set(e.wid, e); }
    else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) known.delete(w); }
    else if (msg.type === MSG.S2C_INVENTORY) inventory = msg;
    else if (msg.type === MSG.S2C_SHOP) shop = msg;
    else if (msg.type === MSG.S2C_SELL_RESULT) sellResult = msg;
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, ref.x, ref.y, ref.z)); } catch (e) { console.error('decode', e); }
    }
  };
  const wait = (condFn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); }
    res(condFn());
  });
  const send = (b) => ws.send(b);
  const tp = async (x, z) => { const r = await post('/api/debug/teleport', { token, x, z }); ref = { x: r.x, y: r.y, z: r.z }; return r; };
  const entryOf = (id) => (shop ? shop.entries.find((e) => e.itemId === id) : undefined);
  const bagCount = (id) => (inventory && inventory.equipBag ? inventory.equipBag.filter((it) => it.itemId === id).length : 0);

  // ---- 测试环境准备 ----
  await consoleCmd('anticheat off');
  await consoleCmd('monsterpause on');
  await wait(() => gotHello && inventory, 3000);

  // 打开商店（按 npcTag 位判定查找商店 NPC，贴近满足 4m 交互距离）
  await tp(6, 6);
  const NPC_TAG_SHOP = 4;
  await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_SHOP)), 1500);
  const npc = [...known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_SHOP));
  check('商店 NPC 可见', !!npc, npc ? npc.name : '');
  if (!npc) { console.log(`\n结果: PASS=${pass} FAIL=${fail}`); process.exit(1); }
  await tp(npc.x, npc.z);
  await sleep(120);
  send(encodeShopOpen(npc.wid));
  await wait(() => shop, 2000);
  check('收到 SHOP 帧', !!shop);

  // 校验阶段1新字段下发（折扣/限购/分类/刷新/回收 + 商店描述）
  const e2001 = entryOf(2001), e1502 = entryOf(1502);
  check('血瓶(2001)折扣字段下发', e2001 && e2001.price === 5 && e2001.discountPrice === 3,
    e2001 ? `price=${e2001.price} disc=${e2001.discountPrice}` : '无2001');
  check('血瓶(2001)每日限购5', e2001 && e2001.buyLimit === 5 && e2001.refreshType === 1);
  check('铁剑(1502)每周限购2', e1502 && e1502.buyLimit === 2 && e1502.refreshType === 2);
  check('分类字段(2001消耗品/1502装备)', e2001 && e2001.category === 2 && e1502 && e1502.category === 1);
  check('商店描述下发', shop && typeof shop.desc === 'string' && shop.desc.length > 0, shop ? shop.desc : '');

  // 1) 折扣价结算：买血瓶扣 3 金（非原价 5）
  await consoleCmd('gold 500');
  await wait(() => inventory && inventory.gold >= 500, 1500);
  let goldBefore = inventory.gold;
  send(encodeShopBuy(2001, 1));
  await wait(() => inventory && inventory.gold < goldBefore, 2000);
  check('折扣价结算(血瓶扣3金)', inventory.gold === goldBefore - 3, `gold ${goldBefore}->${inventory.gold}`);
  check('限购进度 bought=1', entryOf(2001) && entryOf(2001).bought === 1, `bought=${entryOf(2001) && entryOf(2001).bought}`);

  // 2) 限购达上限拒绝购买：买满 5，第 6 次拒绝
  for (let i = 2; i <= 5; i++) {
    send(encodeShopBuy(2001, 1));
    await wait(() => inventory && inventory.inventory[2001] >= i, 1500);
  }
  await wait(() => entryOf(2001) && entryOf(2001).bought === 5, 1500);
  check('限购内买满5个', inventory.inventory[2001] === 5 && entryOf(2001).bought === 5,
    `inv=${inventory.inventory[2001]} bought=${entryOf(2001).bought}`);
  goldBefore = inventory.gold;
  const invBefore = inventory.inventory[2001];
  send(encodeShopBuy(2001, 1));
  await sleep(400);   // 拒绝无回执：靠"金币/数量不变"判定
  check('超限购拒绝购买(金币/数量不变)',
    inventory.gold === goldBefore && inventory.inventory[2001] === invBefore,
    `gold ${goldBefore}->${inventory.gold} inv ${invBefore}->${inventory.inventory[2001]}`);

  // 3) 每日刷新重置限购：shoprefresh → 重开商店 → bought 归零 → 可再买
  await consoleCmd('shoprefresh');
  await sleep(150);
  await tp(npc.x, npc.z);
  send(encodeShopOpen(npc.wid));
  await wait(() => entryOf(2001) && entryOf(2001).bought === 0, 2000);
  check('刷新后限购计数归零', entryOf(2001) && entryOf(2001).bought === 0, `bought=${entryOf(2001) && entryOf(2001).bought}`);
  const invBeforeRefresh = inventory.inventory[2001];
  send(encodeShopBuy(2001, 1));
  await wait(() => inventory && inventory.inventory[2001] > invBeforeRefresh, 2000);
  check('刷新后可再次购买', inventory.inventory[2001] === invBeforeRefresh + 1,
    `inv ${invBeforeRefresh}->${inventory.inventory[2001]}`);

  // 4) 出售堆叠物品：血瓶 sellPrice=2 → +2 金，数量 -1
  goldBefore = inventory.gold;
  const invBeforeSell = inventory.inventory[2001];
  sellResult = null;
  send(encodeShopSell(false, 0, 2001, 1));
  await wait(() => sellResult, 2000);
  check('出售血瓶回执(ok/gain=2)', sellResult && sellResult.ok && sellResult.goldGain === 2,
    sellResult ? `ok=${sellResult.ok} gain=${sellResult.goldGain}` : '无回执');
  await wait(() => inventory && inventory.gold === goldBefore + 2 && inventory.inventory[2001] === invBeforeSell - 1, 2000);
  check('出售血瓶返还2金+数量-1',
    inventory.gold === goldBefore + 2 && inventory.inventory[2001] === invBeforeSell - 1,
    `gold ${goldBefore}->${inventory.gold} inv ${invBeforeSell}->${inventory.inventory[2001]}`);

  // 5a) 出售装备实例（显式回收价）：买铁剑→卖铁剑，sellPrice=20（enhance=0→×1.0）
  const bag1502Before = bagCount(1502);
  send(encodeShopBuy(1502, 1));
  await wait(() => bagCount(1502) > bag1502Before, 2000);
  const sword = inventory.equipBag.find((it) => it.itemId === 1502);
  check('购买铁剑进背包装备实例', !!sword, sword ? `instId=${sword.instId}` : '无实例');
  if (sword) {
    goldBefore = inventory.gold;
    sellResult = null;
    send(encodeShopSell(true, sword.instId, 1502, 1));
    await wait(() => sellResult, 2000);
    check('出售铁剑回执(ok/gain=20)', sellResult && sellResult.ok && sellResult.goldGain === 20,
      sellResult ? `ok=${sellResult.ok} gain=${sellResult.goldGain}` : '无回执');
    await wait(() => inventory && inventory.gold === goldBefore + 20 && !inventory.equipBag.some((it) => it.instId === sword.instId), 2000);
    check('出售铁剑返还20金+实例移除',
      inventory.gold === goldBefore + 20 && !inventory.equipBag.some((it) => it.instId === sword.instId),
      `gold ${goldBefore}->${inventory.gold}`);
  }

  // 5b) 出售装备实例（自动回收价）：皮帽(1001) sellPrice=0 → ItemDef.price(8)×0.5 = 4
  const bag1001Before = bagCount(1001);
  send(encodeShopBuy(1001, 1));
  await wait(() => bagCount(1001) > bag1001Before, 2000);
  const helm = inventory.equipBag.find((it) => it.itemId === 1001);
  check('购买皮帽进背包装备实例', !!helm, helm ? `instId=${helm.instId}` : '无实例');
  if (helm) {
    goldBefore = inventory.gold;
    sellResult = null;
    send(encodeShopSell(true, helm.instId, 1001, 1));
    await wait(() => sellResult, 2000);
    check('自动回收价(皮帽 gain=4=8×0.5)', sellResult && sellResult.ok && sellResult.goldGain === 4,
      sellResult ? `ok=${sellResult.ok} gain=${sellResult.goldGain}` : '无回执');
    await wait(() => inventory && inventory.gold === goldBefore + 4 && !inventory.equipBag.some((it) => it.instId === helm.instId), 2000);
    check('出售皮帽返还4金+实例移除',
      inventory.gold === goldBefore + 4 && !inventory.equipBag.some((it) => it.instId === helm.instId),
      `gold ${goldBefore}->${inventory.gold}`);
  }

  // ---- 复位测试标志 ----
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat on');
  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
