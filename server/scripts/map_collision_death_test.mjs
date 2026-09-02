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
import { terrainBlocked } from '../../client/js/terrain.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'map' + Math.floor(Math.random() * 100000);
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
async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let selfWid = 0;
  let ref = { x: 0, y: 0, z: 0 };
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
    // 结果行如: [player]name(wid=...) hp=.. @(x,z)
    const lines = (r.output || '').split('\n');
    for (const ln of lines) {
      const m = ln.match(/@\((-?[\d.]+),(-?[\d.]+)\)/);
      if (m) return { x: parseFloat(m[1]), z: parseFloat(m[2]) };
    }
    return null;
  }
  // ============ 1) 静态地形碰撞：向河流移动被阻挡 ============
  console.log('\n[1] 2.5D 静态地形碰撞（河流不可通行，服务端阻挡）');
  // 河道边界在 x=0 时约为 z=-16.5（z=-16 干 / z=-18 水）。从干地 (0,-13) 向 -z（河流）移动。
  const bankX = 0, bankZ = -13;
  await debugTp(token, bankX, bankZ);
  await sleep(250);
  let sent = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1800) {
    send(encodeInput(++sent, 0, -1, 0, bankX, 0, bankZ)); // 向 -z 移动
    await sleep(50);
  }
  const finalPos = await selfPosFromConsole();
  const dry = finalPos && !terrainBlocked(finalPos.x, finalPos.z);
  check('向河流移动被阻挡（未进入水域）', !!finalPos && dry,
    finalPos ? `@(${finalPos.x.toFixed(2)},${finalPos.z.toFixed(2)}) blocked=${terrainBlocked(finalPos.x, finalPos.z)}` : '无位置');
  if (finalPos) {
    check('停在河岸（z 未越过边界 z≈-17）', finalPos.z >= -17.2, `z=${finalPos.z.toFixed(2)}`);
  }
  // ============ 2) 怪物死亡 → 定时刷新 ============
  console.log('\n[2] 怪物死亡后定时刷新');
  const farm = await postConsole(token, 'spawn wolf');
  const widM = (farm.output || '').match(/wid=(\d+)/);
  const monsterWid = widM ? parseInt(widM[1], 10) : 0;
  check('生成怪物成功', monsterWid > 0, `wid=${monsterWid}`);
  // 贴身怪物并击杀（攻击直至 EVT_DEATH 广播该 wid）
  const m0 = [...known.values()].find((e) => e.wid === monsterWid);
  if (m0) { await debugTp(token, m0.x, m0.z); await sleep(250); }
  let killed = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && !killed) {
    const mm = [...known.values()].find((e) => e.wid === monsterWid);
    if (mm) {
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
  await postConsole(token, `stat hp 1`);
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
  // 复活后满血
  const hpFull = await wait(() => stats && stats.hp >= stats.maxHp, 3000);
  check('复活后满血', hpFull, stats ? `hp=${Math.round(stats.hp)}/${Math.round(stats.maxHp)}` : '无STATS');
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  ws.close();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
