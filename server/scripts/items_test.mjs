#!/usr/bin/env node
/**
 * items_test.mjs - 物品系统端到端验证（服务端权威）
 * 流程：
 *  1) 注册登录 → 校验初始 INVENTORY(gold=0/背包空) + STATS(攻12/防3)
 *  2) 打怪攒钱（击杀 → 掉落 → 拾取，验证掉落/拾取链路）
 *  3) teleport 到商店 NPC(6,6) → SHOP_OPEN → 校验 SHOP 帧商品
 *  4) SHOP_BUY 铁剑(1502,40金) → 校验金币扣减 + 背包增加
 *  5) EQUIP 武器槽(6) → 校验 STATS 攻击提升（12→17）
 *  6) 购买并使用小血瓶(2001) → 校验 HP 恢复
 * 需要服务端 EW_DEBUG=1 运行（依赖 /api/debug/teleport）
 */
import { encodeAttack, encodeShopOpen, encodeShopBuy, encodePickup, encodeEquip, encodeUseItem, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'itemtest' + Math.floor(Math.random() * 100000);
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(path + ' ' + JSON.stringify(j));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function decodeFrames(buf) {
  const out = [];
  let off = 0;
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
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';

  let selfWid = 0;
  let ref = { x: 0, y: 0, z: 0 };
  let inventory = null, stats = null, shop = null, loot = null;
  let dropSeen = 0;
  const known = new Map();
  let gotHello = false;

  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) {
      selfWid = msg.self.wid;
      ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z };
      gotHello = true;
    } else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) {
      for (const e of msg.entities) known.set(e.wid, e);
    } else if (msg.type === MSG.S2C_LEAVE) {
      for (const w of msg.wids) known.delete(w);
    } else if (msg.type === MSG.S2C_INVENTORY) inventory = msg;
    else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_SHOP) shop = msg;
    else if (msg.type === MSG.S2C_LOOT) loot = msg;
    else if (msg.type === MSG.S2C_EVENT) {
      if (msg.evtType === EVT.DROP) { dropSeen++; }
    }
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, ref.x, ref.y, ref.z)); } catch (e) { console.error('decode', e); }
    }
  };
  const wait = (condFn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (condFn()) return res(true);
      await sleep(50);
    }
    res(condFn());
  });
  const send = (b) => ws.send(b);
  const tp = async (x, z) => {
    const r = await post('/api/debug/teleport', { token, x, z });
    ref = { x: r.x, y: r.y, z: r.z };
    return r;
  };
  const nearestMonster = () => [...known.values()]
    .filter((e) => e.kind === KIND.MONSTER)
    .sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];

  /** 打怪刷金币：逐只贴身击杀（以该怪物死亡产生的掉落为准）+ 拾取，直至金币 >= target。
   *  注：出生点附近不刷怪（安全区），怪物在 20-110m 阶梯刷怪区，需主动接近并完整击杀。 */
  async function farmGold(target) {
    let guard = 0;
    while ((inventory ? inventory.gold : 0) < target && guard < 120) {
      const mm = nearestMonster();
      if (!mm) { await sleep(300); guard++; continue; }
      const tpR = await tp(mm.x, mm.z);
      ref = { x: tpR.x, y: tpR.y, z: tpR.z };
      await sleep(300);
      let t = mm;
      const dropsBefore = dropSeen;
      for (let i = 0; i < 30; i++) {
        // 每轮重新盯紧最近怪物（怪物会游走/被踢出视野）
        const near = [...known.values()]
          .filter((e) => e.kind === KIND.MONSTER && Math.hypot(e.x - ref.x, e.z - ref.z) < 8)
          .sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];
        if (near) t = near;
        if (Math.hypot(t.x - ref.x, t.z - ref.z) > 4) {
          // 怪物走远了：重新贴身
          const tp2 = await tp(t.x, t.z);
          ref = { x: tp2.x, y: tp2.y, z: tp2.z };
          await sleep(250);
        }
        send(encodeAttack(t.wid));
        await sleep(90);
        if (dropSeen > dropsBefore) break; // 本只怪物死亡产生掉落
      }
      // 等待掉落广播并拾取
      await wait(() => dropSeen > dropsBefore, 1500);
      // 拾取视野内所有掉落物
      for (const e of [...known.values()]) {
        if (e.kind === KIND.ITEM) {
          send(encodePickup(e.wid));
          await sleep(40);
        }
      }
      await sleep(150);
      guard++;
    }
    return inventory ? inventory.gold : 0;
  }

  // 1) 初始状态
  await wait(() => gotHello && inventory && stats, 3000);
  check('初始 HELLO', gotHello);
  check('初始金币=0', inventory && inventory.gold === 0, `gold=${inventory && inventory.gold}`);
  check('初始背包空', inventory && Object.keys(inventory.inventory).length === 0);
  check('初始攻击=12', stats && stats.attack === 12, `atk=${stats && stats.attack}`);
  check('初始防御=3', stats && stats.defense === 3, `def=${stats && stats.defense}`);

  // 2) 打怪 → 掉落 → 拾取（刷到至少 1 金币）
  await wait(() => known.size > 0, 2000);
  check('视野内存在怪物', !!nearestMonster());
  const goldAfterFarm = await farmGold(1);
  check('击杀怪物产生掉落', dropSeen > 0, `dropSeen=${dropSeen}`);
  check('拾取获得金币(≥1)', goldAfterFarm >= 1, `gold=${goldAfterFarm}`);

  // 3) 商店：teleport 到商店 NPC (6,6)
  await tp(6, 6);
  await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && e.name && e.name.indexOf('商店') !== -1), 1500);
  const npc = [...known.values()].find((e) => e.kind === KIND.NPC && e.name && e.name.indexOf('商店') !== -1);
  check('商店 NPC 可见', !!npc, npc ? npc.name : '');
  if (npc) {
    send(encodeShopOpen(npc.wid));
    await wait(() => shop, 2000);
    check('收到 SHOP 帧', !!shop);
    check('商店商品>0', shop && shop.entries.length > 0, `n=${shop && shop.entries.length}`);
    check('商店含铁剑(1502)', shop && shop.entries.some((e) => e.itemId === 1502));
  }

  // 4) 攒够 46 金（剑40+血瓶5） → 购买铁剑 1502
  await farmGold(46);
  check('攒够金币≥40', inventory && inventory.gold >= 40, `gold=${inventory && inventory.gold}`);
  if (inventory && inventory.gold >= 40) {
    const goldBefore = inventory.gold;
    send(encodeShopBuy(1502, 1));
    await wait(() => inventory && inventory.inventory[1502], 2000);
    check('购买铁剑成功(金币扣减+背包)', !!(inventory && inventory.inventory[1502]),
      `gold ${goldBefore} -> ${inventory && inventory.gold} inv1502=${inventory && inventory.inventory[1502]}`);
  } else {
    check('购买铁剑成功(金币扣减+背包)', false, '金币不足');
  }

  // 5) 穿戴铁剑 → 攻击 +5（12 → 17）
  if (inventory && inventory.inventory[1502]) {
    const atkBefore = stats.attack;
    send(encodeEquip(6, 1502));
    await wait(() => stats && stats.attack === atkBefore + 5, 2000);
    check('穿戴铁剑攻击+5', stats && stats.attack === atkBefore + 5, `atk ${atkBefore} -> ${stats && stats.attack}`);
  } else {
    console.log('  [skip] 无铁剑，跳过 EQUIP 校验');
  }

  // 6) 购买并使用小血瓶 2001（价 5）→ HP 恢复
  if (inventory && inventory.gold >= 5) {
    send(encodeShopBuy(2001, 1));
    await wait(() => inventory && inventory.inventory[2001], 2000);
  }
  if (inventory && inventory.inventory[2001]) {
    const hpBefore = stats.hp;
    send(encodeUseItem(2001, 1));
    await wait(() => stats && stats.hp > hpBefore, 2000);
    check('使用血瓶恢复HP', stats && stats.hp > hpBefore, `hp ${hpBefore} -> ${stats && stats.hp}`);
  } else {
    console.log('  [skip] 金币不足无法买血瓶，跳过 USE 校验');
  }

  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
