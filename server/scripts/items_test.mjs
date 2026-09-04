#!/usr/bin/env node
/**
 * items_test.mjs - 物品系统端到端验证（服务端权威，确定性测试）
 * 流程：
 *  1) 注册登录 → 校验初始 INVENTORY(gold=0/背包空) + STATS(攻12/防3)
 *  2) 打怪 → 掉落 → 拾取（验证击杀/掉落/拾取链路）
 *  3) teleport 到商店 NPC(6,6) → SHOP_OPEN → 校验 SHOP 帧商品
 *  4) SHOP_BUY 铁剑(1502,40金) → 校验金币扣减 + 背包装备实例(equipBag)增加
 *  5) EQUIP 武器槽(6) 按 instId 穿戴 → 校验 STATS 攻击提升（+5）
 *  6) 购买并使用小血瓶(2001) → 校验 HP 恢复
 *
 * 确定性保障（借助游戏内控制台测试命令，去除不可预测/耗时操作）：
 *  - anticheat off  : 关闭防作弊，teleport 不被轨迹校验误判
 *  - monsterpause on: 全局冻结怪物 AI/移动/攻击 → 目标稳定、玩家不受伤害、无需刷怪走位
 *  - freecast on    : 普攻无冷却 → 快速击杀，无需等待攻击间隔
 *  - gold <n>       : 直接发放金币（替代耗时且依赖 RNG 的刷怪攒钱循环）
 *  - sethp <v>      : 确定性压低当前 HP（替代不可靠的流血压血）验证血瓶恢复
 * 需要服务端 EW_DEBUG=1 运行（依赖 /api/debug/teleport 与 /api/console）
 */
import { encodeAttack, encodeShopOpen, encodeShopBuy, encodePickup, encodeEquip, encodeUseItem, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
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
  // 控制台命令（HTTP 通道）：测试控制/发放资源，返回 {ok, output}
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
  // 最近的存活怪物（hp<=0 视为死亡待复活，跳过，避免选到死怪）
  const nearestMonster = () => [...known.values()]
    .filter((e) => e.kind === KIND.MONSTER && (e.hp === undefined || e.hp > 0))
    .sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];

  /** 击杀最近怪物（确定性）：怪物已 monsterpause 冻结（不移动/不反击），freecast 无攻击冷却，
   *  teleport 贴身连发普攻直到其死亡产生掉落 → 拾取。返回是否观察到掉落。 */
  async function killNearestMonster() {
    const mm = nearestMonster();
    if (!mm) return false;
    await tp(mm.x, mm.z);
    await sleep(150);
    const dropsBefore = dropSeen;
    for (let i = 0; i < 50 && dropSeen <= dropsBefore; i++) {
      send(encodeAttack(mm.wid));
      await sleep(50);
    }
    if (!(await wait(() => dropSeen > dropsBefore, 1500))) return false;
    // 等地面掉落物实体广播 → 贴到掉落物上（拾取范围 2m）→ 全部拾取
    await wait(() => [...known.values()].some((e) => e.kind === KIND.ITEM), 1000);
    const dropEnt = [...known.values()].find((e) => e.kind === KIND.ITEM);
    if (dropEnt) { await tp(dropEnt.x, dropEnt.z); await sleep(120); }
    for (const e of [...known.values()]) {
      if (e.kind === KIND.ITEM) { send(encodePickup(e.wid)); await sleep(50); }
    }
    await wait(() => inventory && inventory.gold >= 1, 1500);
    return true;
  }

  // ---- 测试环境准备：开启确定性控制标志（各测试自身建立所需状态，不依赖上一次复位）----
  await consoleCmd('anticheat off');
  await consoleCmd('monsterpause on');
  await consoleCmd('freecast on');

  // 1) 初始状态
  await wait(() => gotHello && inventory && stats, 3000);
  check('初始 HELLO', gotHello);
  check('初始金币=0', inventory && inventory.gold === 0, `gold=${inventory && inventory.gold}`);
  check('初始背包空', inventory && Object.keys(inventory.inventory).length === 0 && (inventory.equipBag || []).length === 0);
  check('初始攻击=12', stats && stats.attack === 12, `atk=${stats && stats.attack}`);
  check('初始防御=3', stats && stats.defense === 3, `def=${stats && stats.defense}`);

  // 2) 打怪 → 掉落 → 拾取（怪物冻结，确定性击杀）
  await wait(() => known.size > 0, 2000);
  check('视野内存在怪物', !!nearestMonster());
  const killed = await killNearestMonster();
  check('击杀怪物产生掉落', killed && dropSeen > 0, `dropSeen=${dropSeen}`);
  check('拾取获得金币(≥1)', inventory && inventory.gold >= 1, `gold=${inventory && inventory.gold}`);

  // 3) 商店：teleport 到主城，按 SHOP 标签查找商店 NPC
  //    （NPC 插件重构后商店 NPC 名为「杂货商人/药草商人」，不再含「商店」；用 npcTag 位判定更稳健）
  await tp(6, 6);
  const NPC_TAG_SHOP = 4;
  await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_SHOP)), 1500);
  const npc = [...known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_SHOP));
  check('商店 NPC 可见', !!npc, npc ? npc.name : '');
  if (npc) {
    await tp(npc.x, npc.z);   // 贴近 NPC（openShop 校验 4m 交互距离，(6,6) 距商人 >4m）
    await sleep(120);
    send(encodeShopOpen(npc.wid));
    await wait(() => shop, 2000);
    check('收到 SHOP 帧', !!shop);
    check('商店商品>0', shop && shop.entries.length > 0, `n=${shop && shop.entries.length}`);
    check('商店含铁剑(1502)', shop && shop.entries.some((e) => e.itemId === 1502));
  }

  // 4) 购买铁剑 1502（装备实例化：进入 equipBag，不再是 inventory 堆叠）
  await consoleCmd('gold 200');
  await wait(() => inventory && inventory.gold >= 40, 1500);
  check('发放金币≥40', inventory && inventory.gold >= 40, `gold=${inventory && inventory.gold}`);
  if (inventory && inventory.gold >= 40) {
    const goldBefore = inventory.gold;
    const bagBefore = (inventory.equipBag || []).filter((it) => it.itemId === 1502).length;
    send(encodeShopBuy(1502, 1));
    await wait(() => inventory && (inventory.equipBag || []).filter((it) => it.itemId === 1502).length > bagBefore, 2000);
    const bagAfter = (inventory.equipBag || []).filter((it) => it.itemId === 1502).length;
    check('购买铁剑成功(金币扣减+背包装备实例)',
      bagAfter > bagBefore && inventory.gold === goldBefore - 40,
      `gold ${goldBefore}->${inventory.gold} bag1502 ${bagBefore}->${bagAfter}`);
  } else {
    check('购买铁剑成功(金币扣减+背包装备实例)', false, '金币不足');
  }

  // 5) 穿戴铁剑 → 攻击 +5（按实例 instId 穿戴）
  //    铁剑(1502) levelReq=3，初始 1 级不可装备；用 level 命令确定性提到 3 级（免刷怪升级）
  await consoleCmd('level 3');
  await wait(() => stats && stats.attack === 18, 2000); // baseAtk=12+(3-1)*3=18
  const swordInst = inventory && (inventory.equipBag || []).find((it) => it.itemId === 1502);
  if (swordInst) {
    const atkBefore = stats.attack;
    send(encodeEquip(6, swordInst.instId));   // 实例化：按 instId 穿戴
    await wait(() => stats && stats.attack === atkBefore + 5, 2000);
    check('穿戴铁剑攻击+5', stats && stats.attack === atkBefore + 5, `atk ${atkBefore} -> ${stats && stats.attack}`);
  } else {
    console.log('  [skip] 无铁剑实例，跳过 EQUIP 校验');
  }

  // 6) 购买并使用小血瓶 2001 → HP 恢复（sethp 确定性压低当前 HP；怪物冻结不干扰）
  if (inventory && inventory.gold >= 5) {
    send(encodeShopBuy(2001, 1));
    await wait(() => inventory && inventory.inventory[2001], 2000);
  }
  if (inventory && inventory.inventory[2001]) {
    await consoleCmd('sethp 50');
    await wait(() => stats && stats.hp <= 50, 1500);
    const hpBefore = stats.hp;
    send(encodeUseItem(2001, 1));
    await wait(() => stats && stats.hp > hpBefore, 2000);
    check('使用血瓶恢复HP', stats && stats.hp > hpBefore, `hp ${hpBefore} -> ${stats && stats.hp}`);
  } else {
    check('购买小血瓶(2001)', false, '金币不足或未上架');
  }

  // ---- 复位测试标志（良好公民：把服务端恢复为正常玩法，避免污染在线世界）----
  await consoleCmd('freecast off');
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat on');

  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
