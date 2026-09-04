#!/usr/bin/env node
/**
 * enhance_test.mjs - 阶段2「装备强化系统」端到端验证（服务端权威，确定性测试）
 *
 * 覆盖验收标准（任务书 409-412）：
 *  1) 非铁匠/超距拒绝强化：城中心 (0,0) 距最近铁匠 ≥15m（>4m 交互距离）→ failCode=6
 *  2) 强化消耗金币+强化石，成功升级：+0→+1 扣 100 金 + 1 强化石，等级=1
 *  3) 强化后属性正确提升：穿戴烈焰剑(attackBonus=9)，+1→+8 攻击显著上升
 *  4) 失败降级：+8 强化失败（failDegrade=-1，无保护符）→ 降为 +7
 *  5) 保护符防降：+7 强化失败但用保护符（canProtect）→ 保持 +7，消耗 1 保护符
 *
 * 依赖控制台命令（需服务端 EW_DEBUG=1）：
 *   anticheat / monsterpause / enhanceforce / level / gold / item
 * 依赖默认配置：
 *   烈焰剑(1503)=WEAPON槽/attackBonus9/levelReq5；强化石(4006)；保护符(4007)
 *   强化表：+1{100金,1石,不降}, +8{6000金,4石,降1,可保护}, +9{9000金,5石,降1,可保护}
 */
import { encodeEnhance, encodeEquip, parseS2C, MSG, KIND } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'enhancetest' + Math.floor(Math.random() * 100000);
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

// 测试常量
const NPC_TAG_BLACKSMITH = 8;
const WEAPON_SLOT = 6;        // EquipSlot::WEAPON
const STONE_ID = 4006;        // 强化石
const PROTECT_ID = 4007;      // 保护符
const SWORD_ID = 1503;        // 烈焰剑（attackBonus=9, levelReq=5）

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
  let inventory = null, stats = null, enhanceResult = null;
  const known = new Map();
  let gotHello = false;
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) { ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true; }
    else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) { for (const e of msg.entities) known.set(e.wid, e); }
    else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) known.delete(w); }
    else if (msg.type === MSG.S2C_INVENTORY) inventory = msg;
    else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_ENHANCE) enhanceResult = msg;
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
  const finish = (code) => { console.log(`\n结果: PASS=${pass} FAIL=${fail}`); try { ws.close(); } catch (e) {} process.exit(code); };
  // 按 instId 跨「已穿戴 + 背包」查找装备实例（读取强化等级）
  const findSword = (instId) => {
    if (!inventory) return null;
    for (let s = 1; s <= 6; s++) { const ins = inventory.equip[s]; if (ins && ins.instId === instId) return ins; }
    if (inventory.equipBag) { const ins = inventory.equipBag.find((it) => it.instId === instId); if (ins) return ins; }
    return null;
  };
  const stoneCount = () => (inventory && inventory.inventory ? (inventory.inventory[STONE_ID] || 0) : 0);
  const protectCount = () => (inventory && inventory.inventory ? (inventory.inventory[PROTECT_ID] || 0) : 0);

  // ---- 测试环境准备 ----
  await consoleCmd('anticheat off');
  await consoleCmd('monsterpause on');
  await consoleCmd('enhanceforce off');
  await consoleCmd('level 10');          // 满足烈焰剑 levelReq=5，并可穿戴
  await consoleCmd('gold 500000');
  await consoleCmd('item 4006 300');     // 强化石
  await consoleCmd('item 4007 30');      // 保护符
  await consoleCmd('item 1503 1');       // 烈焰剑（背包装备实例）
  await wait(() => gotHello && inventory && stats, 3000);
  await wait(() => inventory && inventory.equipBag && inventory.equipBag.some((it) => it.itemId === SWORD_ID), 2000);
  const sword = inventory.equipBag.find((it) => it.itemId === SWORD_ID);
  check('发放烈焰剑进背包装备实例', !!sword, sword ? `instId=${sword.instId}` : '无实例');
  if (!sword) finish(1);
  const swordId = sword.instId;

  // 1) 非铁匠/超距拒绝强化：tp 到城中心 (0,0)，城内 NPC 均在半径 ≥15m 处 → failCode=6
  await tp(0, 0);
  await sleep(250);
  enhanceResult = null;
  send(encodeEnhance(swordId, false));
  await wait(() => enhanceResult, 2000);
  check('超距拒绝强化(failCode=6)', enhanceResult && !enhanceResult.ok && enhanceResult.failCode === 6,
    enhanceResult ? `ok=${enhanceResult.ok} failCode=${enhanceResult.failCode}` : '无回执');

  // 找到铁匠 NPC 并贴近（满足 4m 交互距离）
  await tp(6, 6);
  await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BLACKSMITH)), 2500);
  const smith = [...known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BLACKSMITH));
  check('铁匠 NPC 可见', !!smith, smith ? smith.name : '');
  if (!smith) finish(1);
  await tp(smith.x, smith.z);
  await sleep(200);

  // 2) 成功升级 +0→+1：扣 100 金 + 1 强化石，等级=1
  await consoleCmd('enhanceforce success');
  const goldBefore = inventory.gold, stoneBefore = stoneCount();
  enhanceResult = null;
  send(encodeEnhance(swordId, false));
  await wait(() => enhanceResult, 2000);
  check('强化成功回执(ok/success/newLevel=1)',
    enhanceResult && enhanceResult.ok && enhanceResult.success && enhanceResult.newLevel === 1,
    enhanceResult ? `ok=${enhanceResult.ok} success=${enhanceResult.success} lv=${enhanceResult.newLevel}` : '无回执');
  await wait(() => findSword(swordId) && findSword(swordId).enhance === 1, 2000);
  check('消耗金币100+强化石1',
    inventory.gold === goldBefore - 100 && stoneCount() === stoneBefore - 1,
    `gold ${goldBefore}->${inventory.gold} stone ${stoneBefore}->${stoneCount()}`);
  check('背包装备强化等级=1', findSword(swordId) && findSword(swordId).enhance === 1,
    `enhance=${findSword(swordId) && findSword(swordId).enhance}`);

  // 3) 属性提升：穿戴烈焰剑 → 记录攻击 → 强化 +1→+8 → 攻击显著上升
  send(encodeEquip(WEAPON_SLOT, swordId));
  await wait(() => inventory && inventory.equip[WEAPON_SLOT] && inventory.equip[WEAPON_SLOT].instId === swordId, 2000);
  check('烈焰剑穿戴到武器槽', inventory.equip[WEAPON_SLOT] && inventory.equip[WEAPON_SLOT].instId === swordId);
  await sleep(300);
  const atkAt1 = stats.attack;
  for (let lv = 2; lv <= 8; lv++) {
    enhanceResult = null;
    send(encodeEnhance(swordId, false));
    await wait(() => findSword(swordId) && findSword(swordId).enhance === lv, 2500);
  }
  check('连续强化至 +8', findSword(swordId) && findSword(swordId).enhance === 8,
    `enhance=${findSword(swordId) && findSword(swordId).enhance}`);
  await sleep(300);
  const atkAt8 = stats.attack;
  check('强化后攻击提升(+1→+8)', atkAt8 > atkAt1, `atk ${atkAt1}->${atkAt8} (Δ${atkAt8 - atkAt1})`);
  // 烈焰剑 attackBonus=9：+1=9×1.08≈9.7, +8=9×1.64≈14.8 → Δ≈5（截断取整后 ≥4）
  check('攻击提升幅度符合强化系数(Δ≥4)', atkAt8 - atkAt1 >= 4, `Δ=${atkAt8 - atkAt1}`);

  // 4) 失败降级：enhanceforce fail，无保护符，+8→target+9(failDegrade=-1)→降为 +7
  await consoleCmd('enhanceforce fail');
  enhanceResult = null;
  send(encodeEnhance(swordId, false));
  await wait(() => enhanceResult, 2000);
  check('强化失败回执(ok/success=false)', enhanceResult && enhanceResult.ok && !enhanceResult.success,
    enhanceResult ? `ok=${enhanceResult.ok} success=${enhanceResult.success}` : '无回执');
  await wait(() => findSword(swordId) && findSword(swordId).enhance === 7, 2000);
  check('失败降级 +8→+7(failDegrade=-1)',
    findSword(swordId) && findSword(swordId).enhance === 7 && enhanceResult.newLevel === 7,
    `enhance=${findSword(swordId) && findSword(swordId).enhance} newLevel=${enhanceResult && enhanceResult.newLevel}`);

  // 5) 保护符防降：enhanceforce fail + useProtect，+7→target+8(canProtect)→保持 +7，消耗 1 保护符
  const protBefore = protectCount();
  enhanceResult = null;
  send(encodeEnhance(swordId, true));
  await wait(() => enhanceResult, 2000);
  check('保护符强化失败回执(ok/success=false)', enhanceResult && enhanceResult.ok && !enhanceResult.success,
    enhanceResult ? `ok=${enhanceResult.ok} success=${enhanceResult.success}` : '无回执');
  await wait(() => findSword(swordId) && findSword(swordId).enhance === 7 && protectCount() === protBefore - 1, 2000);
  check('保护符防降级(保持+7)',
    findSword(swordId) && findSword(swordId).enhance === 7 && enhanceResult.newLevel === 7,
    `enhance=${findSword(swordId) && findSword(swordId).enhance} newLevel=${enhanceResult && enhanceResult.newLevel}`);
  check('保护符消耗1个', protectCount() === protBefore - 1, `protect ${protBefore}->${protectCount()}`);

  // ---- 复位测试标志 ----
  await consoleCmd('enhanceforce off');
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat on');
  finish(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
