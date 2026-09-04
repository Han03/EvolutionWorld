#!/usr/bin/env node
/**
 * craft_test.mjs - 阶段4「物品合成系统」端到端验证（服务端权威，确定性测试）
 *
 * 覆盖验收标准（任务书 451-452）：
 *  1) 材料齐全才能合成；产出正确（装备实例 / 堆叠物品）
 *  2) 隐藏 / 等级不足配方不显示（服务端 availableRecipes 过滤）
 *  另覆盖：超距拒绝(failCode=6)、等级不足合成拒绝(failCode=2)、材料不足(failCode=3)、
 *          金币扣除、材料扣除、批量合成(count)、装备实例入背包。
 *
 * 依赖控制台命令（需服务端 EW_DEBUG=1）：anticheat / monsterpause / level / gold / item
 * 依赖默认配方（craft.cpp loadDefaults）：
 *   R1 小血瓶×3 ← 狼牙(3001)×1            gold2  lv1（堆叠·批量）
 *   R2 大血瓶   ← 狼牙×2 + 铁屑(4001)×1    gold5  lv1（堆叠）
 *   R3 大蓝瓶   ← 骷髅碎片(3003)×2 + 铁屑×1 gold5  lv1（堆叠）
 *   R4 强化石   ← 精钢(4002)×3 + 魔晶(4003)×1 gold20 lv3（堆叠）
 *   R5 保护符   ← 龙鳞(4004)×2 + 星辰核心(4005)×1 gold100 lv8（堆叠）
 *   R6 铁剑     ← 铁屑×5 + 精钢×2          gold30 lv3（装备实例）
 *   R7 锁子甲   ← 精钢×4 + 铁屑×2          gold40 lv3（装备实例）
 *   R8 烈焰剑   ← 魔晶×3 + 龙鳞×2          gold150 lv5（隐藏）
 */
import { encodeCraft, encodeCraftList, parseS2C, MSG, KIND } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'crafttest' + Math.floor(Math.random() * 100000);
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
const NPC_TAG_CRAFT = 64;
// 配方 ID（craft.cpp loadDefaults）
const R_POTION_S = 1;    // 小血瓶×3 ← 狼牙×1（堆叠·批量）
const R_POTION_L = 2;    // 大血瓶   ← 狼牙×2 + 铁屑×1（堆叠）
const R_MANA_L = 3;      // 大蓝瓶   ← 骷髅碎片×2 + 铁屑×1（堆叠）
const R_STONE = 4;       // 强化石   ← 精钢×3 + 魔晶×1（堆叠, lv3）
const R_PROTECT = 5;     // 保护符   ← 龙鳞×2 + 星辰核心×1（堆叠, lv8）
const R_IRON_SWORD = 6;  // 铁剑     ← 铁屑×5 + 精钢×2（装备实例, lv3）
const R_CHAINMAIL = 7;   // 锁子甲   ← 精钢×4 + 铁屑×2（装备实例, lv3）
const R_FLAME_SWORD = 8; // 烈焰剑（隐藏, lv5）
// 材料 / 产物 itemId
const MAT_FANG = 3001, MAT_BONE = 3003, MAT_IRON = 4001, MAT_STEEL = 4002;
const MAT_CRYSTAL = 4003, MAT_SCALE = 4004, MAT_STAR = 4005;
const POTION_S = 2001, POTION_L = 2002, IRON_SWORD = 1502;
// 期望值
const GOLD_R2 = 5;             // R2 金币消耗
const GOLD_R6 = 30;            // R6 金币消耗
const RESULT_R1_BATCH3 = 9;    // R1 resultCount(3) × count(3) = 9

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
  let inventory = null, stats = null, craftResult = null, craftList = null;
  const known = new Map();
  let gotHello = false;
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) { ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true; }
    else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) { for (const e of msg.entities) known.set(e.wid, e); }
    else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) known.delete(w); }
    else if (msg.type === MSG.S2C_INVENTORY) inventory = msg;
    else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_CRAFT) craftResult = msg;
    else if (msg.type === MSG.S2C_CRAFT_LIST) craftList = msg;
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
  const bagCountOf = (itemId) => (inventory && inventory.equipBag ? inventory.equipBag.filter((it) => it.itemId === itemId).length : 0);

  // ---- 测试环境准备 ----
  await consoleCmd('anticheat off');
  await consoleCmd('monsterpause on');
  await consoleCmd('level 1');
  await consoleCmd('gold 100000');
  await consoleCmd('item 3001 30');   // 狼牙
  await consoleCmd('item 3003 30');   // 骷髅碎片
  await consoleCmd('item 4001 60');   // 铁屑
  await consoleCmd('item 4002 60');   // 精钢碎片
  await consoleCmd('item 4003 60');   // 魔晶
  await consoleCmd('item 4004 60');   // 龙鳞
  await consoleCmd('item 4005 60');   // 星辰核心
  await wait(() => gotHello && inventory && stats, 3000);
  await wait(() => matCount(MAT_FANG) >= 30 && matCount(MAT_IRON) >= 60 && matCount(MAT_STEEL) >= 60, 3000);
  check('发放测试材料进背包', matCount(MAT_FANG) >= 30 && matCount(MAT_IRON) >= 60, `fang=${matCount(MAT_FANG)} iron=${matCount(MAT_IRON)}`);

  // 1) 超距拒绝合成：tp 城中心 (0,0)，城内 NPC 均在半径 ≥15m 处（>4m 交互距离）→ failCode=6
  await tp(0, 0);
  await sleep(250);
  craftResult = null;
  send(encodeCraft(R_POTION_L, 1));
  await wait(() => craftResult, 2000);
  check('超距拒绝合成(failCode=6)', craftResult && !craftResult.ok && craftResult.failCode === 6,
    craftResult ? `ok=${craftResult.ok} failCode=${craftResult.failCode}` : '无回执');

  // 找到合成 NPC（CRAFT 标签）并贴近：城内多点探测累积 AOI 视野
  let alch = null;
  for (const [px, pz] of [[6, 6], [15, 0], [0, 15], [15, 15], [18, 0], [0, 18], [-6, -6], [12, 12]]) {
    await tp(px, pz);
    await wait(() => [...known.values()].some((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_CRAFT)), 1200);
    alch = [...known.values()].find((e) => e.kind === KIND.NPC && (e.npcTag & NPC_TAG_CRAFT));
    if (alch) break;
  }
  check('合成 NPC 可见', !!alch, alch ? alch.name : '');
  if (!alch) finish(1);
  await tp(alch.x, alch.z);
  await sleep(200);

  // 2) 等级不足配方不显示 + 隐藏配方不显示：level 1 请求配方列表
  craftList = null;
  send(encodeCraftList(alch.wid));
  await wait(() => craftList, 2000);
  const ids1 = craftList ? (craftList.recipeIds || []) : [];
  check('Lv1 列表含基础配方(1,2,3)', [R_POTION_S, R_POTION_L, R_MANA_L].every((id) => ids1.includes(id)), `ids=[${ids1}]`);
  check('Lv1 列表不含等级不足配方(4,5,6,7)', [R_STONE, R_PROTECT, R_IRON_SWORD, R_CHAINMAIL].every((id) => !ids1.includes(id)), `ids=[${ids1}]`);
  check('隐藏配方(8)不显示', !ids1.includes(R_FLAME_SWORD), `ids=[${ids1}]`);

  // 3) 材料不足拒绝：批量 count=999（小血瓶 R1 需狼牙×999 > 持有）→ failCode=3
  craftResult = null;
  send(encodeCraft(R_POTION_S, 999));
  await wait(() => craftResult, 2000);
  check('材料不足拒绝合成(failCode=3)', craftResult && !craftResult.ok && craftResult.failCode === 3,
    craftResult ? `ok=${craftResult.ok} failCode=${craftResult.failCode}` : '无回执');

  // 4) 堆叠产出正确：合成大血瓶 R2（狼牙×2 + 铁屑×1, gold5）→ 2002 +1，材料/金币扣除
  const g0 = goldOf(), p0 = matCount(POTION_L), fang0 = matCount(MAT_FANG), iron0 = matCount(MAT_IRON);
  craftResult = null;
  send(encodeCraft(R_POTION_L, 1));
  await wait(() => craftResult && craftResult.ok, 2000);
  check('大血瓶合成成功回执(ok)', craftResult && craftResult.ok,
    craftResult ? `ok=${craftResult.ok} failCode=${craftResult.failCode}` : '无回执');
  check('产出为堆叠物品(isInstance=false, itemId=大血瓶)',
    craftResult && craftResult.isInstance === false && craftResult.resultItemId === POTION_L && craftResult.resultCount === 1,
    craftResult ? `isInstance=${craftResult.isInstance} itemId=${craftResult.resultItemId} count=${craftResult.resultCount}` : '');
  await wait(() => matCount(POTION_L) === p0 + 1 && goldOf() === g0 - GOLD_R2 &&
    matCount(MAT_FANG) === fang0 - 2 && matCount(MAT_IRON) === iron0 - 1, 2500);
  check('大血瓶入背包+1', matCount(POTION_L) === p0 + 1, `${p0}->${matCount(POTION_L)}`);
  check('金币扣除5', goldOf() === g0 - GOLD_R2, `${g0}->${goldOf()}`);
  check('材料扣除(狼牙-2, 铁屑-1)', matCount(MAT_FANG) === fang0 - 2 && matCount(MAT_IRON) === iron0 - 1,
    `fang ${fang0}->${matCount(MAT_FANG)} iron ${iron0}->${matCount(MAT_IRON)}`);

  // 5) 批量合成：小血瓶 R1 count=3（狼牙×1 each → 小血瓶×3 each = 9）
  const ps0 = matCount(POTION_S), fang1 = matCount(MAT_FANG);
  craftResult = null;
  send(encodeCraft(R_POTION_S, 3));
  await wait(() => craftResult && craftResult.ok, 2000);
  check('批量合成成功回执(count=3 → resultCount=9)',
    craftResult && craftResult.ok && craftResult.resultCount === RESULT_R1_BATCH3,
    craftResult ? `resultCount=${craftResult.resultCount}` : '无回执');
  await wait(() => matCount(POTION_S) === ps0 + RESULT_R1_BATCH3 && matCount(MAT_FANG) === fang1 - 3, 2500);
  check('批量产出小血瓶+9, 狼牙-3', matCount(POTION_S) === ps0 + RESULT_R1_BATCH3 && matCount(MAT_FANG) === fang1 - 3,
    `potionS ${ps0}->${matCount(POTION_S)} fang ${fang1}->${matCount(MAT_FANG)}`);

  // 6) 等级不足合成拒绝：直接发 R5（保护符, lv8）在 level 1 → failCode=2（服务端权威，绕过列表过滤）
  craftResult = null;
  send(encodeCraft(R_PROTECT, 1));
  await wait(() => craftResult, 2000);
  check('等级不足拒绝合成(failCode=2)', craftResult && !craftResult.ok && craftResult.failCode === 2,
    craftResult ? `ok=${craftResult.ok} failCode=${craftResult.failCode}` : '无回执');

  // 7) 升级解锁配方：level 3 → 列表含 4,6,7；仍不含隐藏(8)与 lv8(5)
  await consoleCmd('level 3');
  await wait(() => stats && stats.level >= 3, 2000);
  craftList = null;
  send(encodeCraftList(alch.wid));
  await wait(() => craftList, 2000);
  const ids3 = craftList ? (craftList.recipeIds || []) : [];
  check('Lv3 列表解锁配方(4,6,7)', [R_STONE, R_IRON_SWORD, R_CHAINMAIL].every((id) => ids3.includes(id)), `ids=[${ids3}]`);
  check('Lv3 仍不含隐藏配方(8)', !ids3.includes(R_FLAME_SWORD), `ids=[${ids3}]`);
  check('Lv3 仍不含 lv8 配方(5)', !ids3.includes(R_PROTECT), `ids=[${ids3}]`);

  // 8) 装备实例产出：合成铁剑 R6（铁屑×5 + 精钢×2, gold30）→ equipBag 新增铁剑实例
  const sword0 = bagCountOf(IRON_SWORD), iron1 = matCount(MAT_IRON), steel0 = matCount(MAT_STEEL), g2 = goldOf();
  craftResult = null;
  send(encodeCraft(R_IRON_SWORD, 1));
  await wait(() => craftResult && craftResult.ok, 2000);
  check('铁剑合成成功回执(ok)', craftResult && craftResult.ok,
    craftResult ? `ok=${craftResult.ok} failCode=${craftResult.failCode}` : '无回执');
  check('产出为装备实例(isInstance=true, instId>0)',
    craftResult && craftResult.isInstance === true && craftResult.instId > 0 && craftResult.resultItemId === IRON_SWORD,
    craftResult ? `isInstance=${craftResult.isInstance} instId=${craftResult.instId}` : '');
  await wait(() => bagCountOf(IRON_SWORD) === sword0 + 1 && matCount(MAT_IRON) === iron1 - 5 &&
    matCount(MAT_STEEL) === steel0 - 2 && goldOf() === g2 - GOLD_R6, 2500);
  check('铁剑实例入背包+1', bagCountOf(IRON_SWORD) === sword0 + 1, `${sword0}->${bagCountOf(IRON_SWORD)}`);
  check('铁剑材料扣除(铁屑-5, 精钢-2)', matCount(MAT_IRON) === iron1 - 5 && matCount(MAT_STEEL) === steel0 - 2,
    `iron ${iron1}->${matCount(MAT_IRON)} steel ${steel0}->${matCount(MAT_STEEL)}`);
  check('铁剑金币扣除30', goldOf() === g2 - GOLD_R6, `${g2}->${goldOf()}`);

  // 9) 高级配方解锁：level 8 → 列表含保护符(5)；隐藏(8)仍不显示
  await consoleCmd('level 8');
  await wait(() => stats && stats.level >= 8, 2000);
  craftList = null;
  send(encodeCraftList(alch.wid));
  await wait(() => craftList, 2000);
  const ids8 = craftList ? (craftList.recipeIds || []) : [];
  check('Lv8 列表解锁保护符配方(5)', ids8.includes(R_PROTECT), `ids=[${ids8}]`);
  check('Lv8 仍不含隐藏配方(8)', !ids8.includes(R_FLAME_SWORD), `ids=[${ids8}]`);

  // ---- 复位测试标志 ----
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat on');
  finish(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
