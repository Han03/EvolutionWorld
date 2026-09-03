#!/usr/bin/env node
/**
 * map_collision_death_test.mjs - 地图优化轮端到端验证
 * 覆盖：
 *  1) 2.5D 静态地形碰撞：向河流（不可通行）移动被阻挡（服务端权威 + 客户端预测一致）
 *  2) 玩家死亡 → 复活：EVT_DEATH(self) → 计时 → EVT_RESPAWN(self) → 满血
 *  3) 怪物死亡 → 定时刷新：击杀怪物 → EVT_DEATH → 计时 → EVT_RESPAWN（同 wid）
 * 需要服务端 EW_DEBUG=1 运行（依赖 /api/console 与 /api/debug/teleport）
 */
import { encodeInput, encodeAttack, encodeConsole, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
import { terrainBlocked, loadWalkMask } from '../../client/js/terrain.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'map' + Math.floor(Math.random() * 100000);
let pass = 0, fail = 0;
let ref = { x: 0, y: 0, z: 0 }; // 最近权威位置（delta 快照解码基准；debugTp 后更新）
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
  return j;
}
async function postConsole(token, command) {
  const j = await post('/api/console', { token, command });
  if (!j.ok) throw new Error('console ' + command + ': ' + JSON.stringify(j));
  return j;
}
async function debugTp(token, x, z) {
  const j = await post('/api/debug/teleport', { token, x, z });
  if (!j.ok) throw new Error('tp: ' + JSON.stringify(j));
  ref = { x: j.x, y: j.y, z: j.z };
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(cond, timeoutMs, step = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}
// 数据驱动世界：找一个可通行且某正交相邻格被阻挡的落点，返回朝阻挡方向的单位向量
function findBlockedEdge() {
  for (let z = -40; z < 40; z++) for (let x = -40; x < 40; x++) {
    const cx = x + 0.5, cz = z + 0.5;
    if (terrainBlocked(cx, cz)) continue;
    if (terrainBlocked(cx + 1, cz)) return { x: cx, z: cz, dx: 1, dz: 0 };
    if (terrainBlocked(cx - 1, cz)) return { x: cx, z: cz, dx: -1, dz: 0 };
    if (terrainBlocked(cx, cz + 1)) return { x: cx, z: cz, dx: 0, dz: 1 };
    if (terrainBlocked(cx, cz - 1)) return { x: cx, z: cz, dx: 0, dz: -1 };
  }
  return null;
}
async function main() {
  const mj = await (await fetch(BASE + '/api/terrain/mask')).json();
  if (!loadWalkMask(mj)) { console.error('FATAL: 无法加载可通行 mask', JSON.stringify(mj)); process.exit(1); }
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let selfWid = 0;
  let stats = null;
  const known = new Map();
  const evtDeath = [];     // {wid, b, ts}
  const evtRespawn = [];   // {wid, ts}
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
    } else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_EVENT) {
      if (msg.evtType === EVT.DEATH) evtDeath.push({ wid: msg.wid, b: msg.b, ts: Date.now() });
      else if (msg.evtType === EVT.RESPAWN) evtRespawn.push({ wid: msg.wid, ts: Date.now() });
    }
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, ref.x, ref.y, ref.z)); } catch (e) { /* 解码错误忽略 */ }
    }
  };
  function send(bytes) { ws.send(bytes); }
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
  await wait(() => gotHello, 3000);
  check('HELLO 到达', gotHello, `wid=${selfWid}`);
  // 从 entities 命令读取当前玩家位置（服务端权威）
  async function selfPosFromConsole() {
    const r = await postConsole(token, 'entities');
    // 结果行如: [0]name(wid=..) hp=.. @(x,z)；玩家 kind=0（EntityKind::Player）
    const lines = (r.output || '').split('\n');
    for (const ln of lines) {
      const m = ln.match(/\[0\][^@]*@\((-?[\d.]+),(-?[\d.]+)\)/);
      if (m) return { x: parseFloat(m[1]), z: parseFloat(m[2]) };
    }
    return null;
  }
  // ============ 1) 静态地形碰撞：向不可通行区移动被阻挡 ============
  console.log('\n[1] 2.5D 静态地形碰撞（不可通行区，服务端阻挡）');
  // 数据驱动世界：找一个可通行↔阻挡相邻边界，从可通行格朝阻挡方向推动，验证被阻挡。
  const edge = findBlockedEdge();
  check('找到可通行↔阻挡边界落点', !!edge,
    edge ? `@(${edge.x.toFixed(1)},${edge.z.toFixed(1)}) 朝(${edge.dx},${edge.dz})` : '');
  if (edge) {
    await debugTp(token, edge.x, edge.z);
    await sleep(250);
    let sent = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 1800) {
      send(encodeInput(++sent, edge.dx, edge.dz, 0, edge.x, 0, edge.z)); // 朝阻挡方向移动
      await sleep(50);
    }
    const finalPos = await selfPosFromConsole();
    const dry = finalPos && !terrainBlocked(finalPos.x, finalPos.z);
    check('向阻挡区移动被阻挡（仍停在可通行格）', !!finalPos && dry,
      finalPos ? `@(${finalPos.x.toFixed(2)},${finalPos.z.toFixed(2)}) blocked=${terrainBlocked(finalPos.x, finalPos.z)}` : '无位置');
  }
  // ============ 2) 怪物死亡 → 定时刷新 ============
  console.log('\n[2] 怪物死亡后定时刷新');
  const farm = await postConsole(token, 'spawn wolf');
  const widM = (farm.output || '').match(/wid=(\d+)/);
  const monsterWid = widM ? parseInt(widM[1], 10) : 0;
  check('生成怪物成功', monsterWid > 0, `wid=${monsterWid}`);
  // 贴身怪物并击杀（攻击直至 EVT_DEATH 广播该 wid）；等待怪物进入 AOI 快照（避免竞态）
  await wait(() => [...known.values()].some((e) => e.wid === monsterWid), 2500);
  const m0 = [...known.values()].find((e) => e.wid === monsterWid);
  if (m0) { await debugTp(token, m0.x, m0.z); await sleep(250); }
  let killed = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 10000 && !killed) {
    const mm = [...known.values()].find((e) => e.wid === monsterWid);
    if (mm) {
      // 超出攻击范围（怪物游走/被推开）则重新贴身
      if (Math.hypot(mm.x - ref.x, mm.z - ref.z) > 2.2) {
        await debugTp(token, mm.x, mm.z);
        await sleep(200);
        continue;
      }
      send(encodeAttack(monsterWid));
      await sleep(90);
      if (evtDeath.some((d) => d.wid === monsterWid)) killed = true;
    } else {
      await sleep(120);
    }
  }
  check('击杀怪物 → EVT_DEATH 广播', killed, `wid=${monsterWid}`);
  // 等待该怪物刷新（monsterRespawnSec=10s）
  const respawned = await wait(() => evtRespawn.some((r2) => r2.wid === monsterWid), 13000);
  check('怪物定时刷新 → EVT_RESPAWN（同 wid）', respawned, `wid=${monsterWid}`);
  // ============ 3) 玩家死亡 → 复活 ============
  console.log('\n[3] 玩家死亡 → 复活');
  const hp0 = stats ? stats.maxHp : 100;
  // stat hp 修改 baseHp（→maxHp）。用 20 作为临时基础血量：玩家能扛几刀，且复活后满血判定清晰
  await postConsole(token, `stat hp 20`);
  await wait(() => stats && stats.maxHp === 20, 3000);
  // 生成一只狼贴身攻击
  const farm2 = await postConsole(token, 'spawn wolf');
  const widM2 = (farm2.output || '').match(/wid=(\d+)/);
  const killerWid = widM2 ? parseInt(widM2[1], 10) : 0;
  if (killerWid) {
    const m2 = [...known.values()].find((e) => e.wid === killerWid);
    if (m2) { await debugTp(token, m2.x, m2.z); await sleep(300); }
  }
  // 狼需要仇恨到玩家并贴身攻击；等待玩家死亡（EVT_DEATH self）
  const selfDied = await wait(() => evtDeath.some((d) => d.wid === selfWid), 12000);
  check('玩家死亡 → EVT_DEATH(self)', selfDied, `killer=${(evtDeath.find((d) => d.wid === selfWid) || {}).b}`);
  // 等待复活（playerRespawnSec=8s + 网络余量）
  const selfRespawned = await wait(() => evtRespawn.some((r2) => r2.wid === selfWid), 13000);
  check('玩家复活 → EVT_RESPAWN(self)', selfRespawned);
  // 复活后满血（相对当前 maxHp=20）
  const hpFull = await wait(() => stats && stats.hp >= stats.maxHp && stats.maxHp === 20, 3000);
  check('复活后满血', hpFull, stats ? `hp=${Math.round(stats.hp)}/${Math.round(stats.maxHp)}` : '无STATS');
  // 清理：恢复基础血量并回满
  await postConsole(token, `stat hp ${hp0}`);
  await postConsole(token, 'heal');
  await wait(() => stats && stats.hp >= stats.maxHp, 3000);
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  ws.close();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
