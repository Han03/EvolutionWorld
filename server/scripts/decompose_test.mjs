#!/usr/bin/env node
/**
 * decompose_test.mjs - 阶段3「装备分解系统」端到端验证（服务端权威，确定性测试）
 *
 * 覆盖验收标准（任务书 430-431）：
 *  1) 分解高强化装备返还更多强化石：烈焰剑 +8 返还 5 强化石 > +0 返还 0
 *  2) 品质越高材料越好：rarity0→铁屑(4001)、rarity1→精钢碎片(4002)、rarity2→魔晶(4003)
 *  3) 已穿戴装备需先卸下才能分解：穿戴中 → failCode=4
 *  4) 锁定装备不可分解：locked → failCode=1
 *  另覆盖：超距拒绝(failCode=6)、金币按品质比例返还、分解后实例移除、材料/金币入账。
 *
 * 依赖控制台命令（需服务端 EW_DEBUG=1）：
 *   anticheat / monsterpause / enhanceforce / level / gold / item / lockitem
 * 依赖默认配置：
 *   青铜剑(1501)=rarity0/price12/WEAPON/levelReq1；铁剑(1502)=rarity1/price40/levelReq3；
 *   烈焰剑(1503)=rarity2/price120/levelReq5；强化石(4006)。
 *   分解规则：r0{gold0.30,stone0.5,4001×2-4}；r1{gold0.35,stone0.6,4002×2-4 + 4001×1-3@50%}；
 *             r2{gold0.40,stone0.7,4003×2-4 + 4002×1-3@60%}。
 */
import { encodeDecompose, encodeEnhance, encodeEquip, parseS2C, MSG, KIND } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'dectest' + Math.floor(Math.random() * 100000);
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
const WEAPON_SLOT = 6;         // EquipSlot::WEAPON
const STONE_ID = 4006;         // 强化石（分解返还）
const BRONZE_ID = 1501;        // 青铜剑 rarity0 price12 levelReq1
const IRON_ID = 1502;          // 铁剑   rarity1 price40 levelReq3
const FLAME_ID = 1503;         // 烈焰剑 rarity2 price120 levelReq5
const MAT_IRON = 4001;         // 铁屑（rarity0 产出）
const MAT_STEEL = 4002;        // 精钢碎片（rarity1 产出）
const MAT_CRYSTAL = 4003;      // 魔晶（rarity2 产出）
// 期望值（floor 取整）
const GOLD_R0 = 3;             // floor(12 × 0.30)
const GOLD_R1 = 14;            // floor(40 × 0.35)
const GOLD_R2 = 48;            // floor(120 × 0.40)
const STONE_FLAME_P8 = 5;      // floor(0.7 × 8)

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
  let inventory = null, stats = null, decomposeResult = null, enhanceResult = null;
  const known = new Map();
  let gotHello = false;
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) { ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true; }
    else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) { for (const e of msg.entities) known.set(e.wid, e); }
    else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) known.delete(w); }
    else if (msg.type === MSG.S2C_INVENTORY) inventory = msg;
    else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_DECOMPOSE) decomposeResult = msg;
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
  const goldOf = () => (inventory ? inventory.gold : 0);
  const matCount = (id) => (inventory && inventory.inventory ? (inventory.inventory[id] || 0) : 0);
  const stoneCount = () => matCount(STONE_ID);
  const bagEnhance = (instId) => {
    if (!inventory || !inventory.equipBag) return -1;
    const ins = inventory.equipBag.find((it) => it.instId === instId);
    return ins ? (ins.enhance || 0) : -1;
  };
  const inBag = (instId) => !!(inventory && inventory.equipBag && inventory.equipBag.some((it) => it.instId === instId));
  // 分解回执中的强化石返还量
  const stoneGainOf = (r) => (r && r.items ? r.items.filter((it) => it.itemId === STONE_ID).reduce((s, it) => s + it.count, 0) : 0);

  // ---- 测试环境准备 ----
  await consoleCmd('anticheat off');
  await consoleCmd('monsterpause on');
  await consoleCmd('enhanceforce off');
  await consoleCmd('level 10');           // 满足穿戴 levelReq（青铜剑/铁剑/烈焰剑）
  await consoleCmd('gold 100000');        // 强化烈焰剑至 +8 需 ~15500 金
  await consoleCmd('item 4006 100');      // 强化石（强化用 + 分解返还基准）
  await consoleCmd('item 1501 3');        // 青铜剑 ×3（基础分解 / 已穿戴拒绝 / 锁定拒绝）
  await consoleCmd('item 1502 1');        // 铁剑 ×1（品质1材料）
  await consoleCmd('item 1503 2');        // 烈焰剑 ×2（+8 与 +0 对比强化石返还）
  await wait(() => gotHello && inventory && stats, 3000);
  await wait(() => inventory && inventory.equipBag &&
    inventory.equipBag.filter((it) => it.itemId === BRONZE_ID).length >= 3 &&
    inventory.equipBag.filter((it) => it.itemId === FLAME_ID).length >= 2 &&
    inventory.equipBag.some((it) => it.itemId === IRON_ID), 3000);
  const bronzes = inventory.equipBag.filter((it) => it.itemId === BRONZE_ID);
  const flames = inventory.equipBag.filter((it) => it.itemId === FLAME_ID);
  const ironSword = inventory.equipBag.find((it) => it.itemId === IRON_ID);
  check('发放测试装备进背包', bronzes.length >= 3 && flames.length >= 2 && !!ironSword,
    `bronze=${bronzes.length} iron=${ironSword ? 1 : 0} flame=${flames.length}`);
  if (bronzes.length < 3 || flames.length < 2 || !ironSword) finish(1);
  const bronzeA = bronzes[0].instId, bronzeB = bronzes[1].instId, bronzeC = bronzes[2].instId;
  const flameD = flames[0].instId, flameE = flames[1].instId;
  const ironId = ironSword.instId;

  // 1) 超距拒绝分解：tp 到城中心 (0,0)，城内 NPC 均在半径 ≥15m 处（>4m 交互距离）→ failCode=6
  await tp(0, 0);
  await sleep(250);
  decomposeResult = null;
  send(encodeDecompose(bronzeA));
  await wait(() => decomposeResult, 2000);
  check('超距拒绝分解(failCode=6)', decomposeResult && !decomposeResult.ok && decomposeResult.failCode === 6,
    decomposeResult ? `ok=${decomposeResult.ok} failCode=${decomposeResult.failCode}` : '无回执');

  // 找到铁匠 NPC 并贴近（满足 4m 交互距离）
  await tp(6, 6);
  await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BLACKSMITH)), 2500);
  const smith = [...known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_BLACKSMITH));
  check('铁匠 NPC 可见', !!smith, smith ? smith.name : '');
  if (!smith) finish(1);
  await tp(smith.x, smith.z);
  await sleep(200);

  // 2) 已穿戴拒绝分解：穿戴青铜剑B → 分解 → failCode=4 → 卸下
  send(encodeEquip(WEAPON_SLOT, bronzeB));
  await wait(() => inventory.equip[WEAPON_SLOT] && inventory.equip[WEAPON_SLOT].instId === bronzeB, 2000);
  check('青铜剑B穿戴到武器槽', inventory.equip[WEAPON_SLOT] && inventory.equip[WEAPON_SLOT].instId === bronzeB);
  decomposeResult = null;
  send(encodeDecompose(bronzeB));
  await wait(() => decomposeResult, 2000);
  check('已穿戴拒绝分解(failCode=4)', decomposeResult && !decomposeResult.ok && decomposeResult.failCode === 4,
    decomposeResult ? `ok=${decomposeResult.ok} failCode=${decomposeResult.failCode}` : '无回执');
  send(encodeEquip(WEAPON_SLOT, 0));   // 卸下
  await wait(() => !(inventory.equip[WEAPON_SLOT] && inventory.equip[WEAPON_SLOT].instId === bronzeB) && inBag(bronzeB), 2000);
  check('卸下后青铜剑B回到背包', inBag(bronzeB));

  // 3) 锁定拒绝分解：lockitem bronzeC 1 → 分解 → failCode=1
  await consoleCmd(`lockitem ${bronzeC} 1`);
  await wait(() => { const it = inventory.equipBag.find((x) => x.instId === bronzeC); return it && it.locked; }, 2000);
  decomposeResult = null;
  send(encodeDecompose(bronzeC));
  await wait(() => decomposeResult, 2000);
  check('锁定拒绝分解(failCode=1)', decomposeResult && !decomposeResult.ok && decomposeResult.failCode === 1,
    decomposeResult ? `ok=${decomposeResult.ok} failCode=${decomposeResult.failCode}` : '无回执');
  await consoleCmd(`lockitem ${bronzeC} 0`);   // 解锁（清理）

  // 4) 基础分解（rarity0 青铜剑A +0）：金币+3、铁屑(4001)×[2-4]、实例移除
  const goldA0 = goldOf(), mat4001A0 = matCount(MAT_IRON);
  decomposeResult = null;
  send(encodeDecompose(bronzeA));
  await wait(() => decomposeResult && decomposeResult.ok, 2000);
  check('青铜剑A分解成功回执(ok)', decomposeResult && decomposeResult.ok,
    decomposeResult ? `ok=${decomposeResult.ok} failCode=${decomposeResult.failCode}` : '无回执');
  check('金币返还=3(floor(12×0.30))', decomposeResult && decomposeResult.goldGain === GOLD_R0,
    `goldGain=${decomposeResult && decomposeResult.goldGain}`);
  await wait(() => goldOf() === goldA0 + GOLD_R0 && matCount(MAT_IRON) >= mat4001A0 + 2 && !inBag(bronzeA), 2500);
  check('金币入账+3', goldOf() === goldA0 + GOLD_R0, `gold ${goldA0}->${goldOf()}`);
  const d4001 = matCount(MAT_IRON) - mat4001A0;
  check('铁屑(4001)产出×[2-4]（rarity0）', d4001 >= 2 && d4001 <= 4, `Δ4001=${d4001}`);
  check('青铜剑A已从背包移除', !inBag(bronzeA));

  // 5) 品质越高材料越好（rarity1 铁剑）：金币+14、精钢碎片(4002)×[2-4]
  const goldI0 = goldOf(), mat4002I0 = matCount(MAT_STEEL);
  decomposeResult = null;
  send(encodeDecompose(ironId));
  await wait(() => decomposeResult && decomposeResult.ok, 2000);
  check('铁剑分解金币返还=14(floor(40×0.35))', decomposeResult && decomposeResult.ok && decomposeResult.goldGain === GOLD_R1,
    `goldGain=${decomposeResult && decomposeResult.goldGain}`);
  await wait(() => goldOf() === goldI0 + GOLD_R1 && matCount(MAT_STEEL) >= mat4002I0 + 2, 2500);
  const d4002 = matCount(MAT_STEEL) - mat4002I0;
  check('精钢碎片(4002)产出×[2-4]（rarity1材料优于rarity0）', d4002 >= 2 && d4002 <= 4, `Δ4002=${d4002}`);

  // 6) 高强化返还更多强化石：烈焰剑D 强化至 +8 → 分解返还 5 强化石
  await consoleCmd('enhanceforce success');
  for (let lv = 1; lv <= 8; lv++) {
    enhanceResult = null;
    send(encodeEnhance(flameD, false));
    await wait(() => bagEnhance(flameD) === lv, 2500);
  }
  check('烈焰剑D强化至+8', bagEnhance(flameD) === 8, `enhance=${bagEnhance(flameD)}`);
  await consoleCmd('enhanceforce off');
  const stoneD0 = stoneCount(), goldD0 = goldOf(), mat4003D0 = matCount(MAT_CRYSTAL);
  decomposeResult = null;
  send(encodeDecompose(flameD));
  await wait(() => decomposeResult && decomposeResult.ok, 2000);
  check('烈焰剑+8分解金币返还=48(floor(120×0.40))', decomposeResult && decomposeResult.ok && decomposeResult.goldGain === GOLD_R2,
    `goldGain=${decomposeResult && decomposeResult.goldGain}`);
  const stoneGainD = stoneGainOf(decomposeResult);
  check('烈焰剑+8返还强化石=5(floor(0.7×8))', stoneGainD === STONE_FLAME_P8, `stoneGain=${stoneGainD}`);
  await wait(() => stoneCount() === stoneD0 + STONE_FLAME_P8 && goldOf() === goldD0 + GOLD_R2 && matCount(MAT_CRYSTAL) >= mat4003D0 + 2, 2500);
  check('强化石入账+5', stoneCount() === stoneD0 + STONE_FLAME_P8, `stone ${stoneD0}->${stoneCount()}`);
  const d4003 = matCount(MAT_CRYSTAL) - mat4003D0;
  check('魔晶(4003)产出×[2-4]（rarity2材料最优）', d4003 >= 2 && d4003 <= 4, `Δ4003=${d4003}`);

  // 7) 对比：烈焰剑E +0 分解返还 0 强化石 → 证明「高强化返还更多强化石」
  decomposeResult = null;
  send(encodeDecompose(flameE));
  await wait(() => decomposeResult && decomposeResult.ok, 2000);
  const stoneGainE = stoneGainOf(decomposeResult);
  check('烈焰剑+0返还强化石=0', stoneGainE === 0, `stoneGain=${stoneGainE}`);
  check('高强化返还更多强化石(+8的5 > +0的0)', stoneGainD > stoneGainE, `${stoneGainD} > ${stoneGainE}`);

  // ---- 复位测试标志 ----
  await consoleCmd('enhanceforce off');
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat on');
  finish(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
