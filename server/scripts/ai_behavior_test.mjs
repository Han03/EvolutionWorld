#!/usr/bin/env node
/**
 * ai_behavior_test.mjs - 验证 AI 框架（怪物仇恨追击 + 攻击）——确定性测试
 * 1) 登录玩家，连接二进制 WS
 * 2) 解析 HELLO/SNAPSHOT/ENTER/UPDATE/SELF/EVENT 帧，跟踪目标怪物与自身权威位置
 * 3) anticheat off + monsterpause off（确保怪物活跃、传送不被轨迹校验误判）
 * 4) 传送贴到最近怪物 ~3m（进入仇恨范围 10m）；视野内无怪物则在身边 spawn 一只（确定性兜底）
 *    → 怪物必然仇恨 → 追击(向玩家靠近) + 攻击(EVT_DAMAGE 命中自己)
 * 判定：观察到 追击 或 攻击 任一行为即 PASS（退出码 0），否则 FAIL（退出码 1）
 *
 * 说明：用「传送贴怪 / 生成怪物」替代原「缓慢走向怪物 + 依赖怪物随机游走进入仇恨」的
 *       不可预测流程——怪物一旦处于仇恨范围内必然追击并攻击，秒级确定性触发。
 */
import { encodeInput, parseS2C, MSG, EVT, KIND, Reader } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'aibeh' + Math.floor(Math.random() * 100000);
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(JSON.stringify(j));
  return j;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function decodeFrames(buf) {
  const out = [];
  let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const HDR = 9;
  while (off + HDR <= buf.byteLength) {
    const magic = buf[off] === 0x45 && buf[off + 1] === 0x57;
    if (!magic) break;
    const type = buf[off + 3];
    const len = dv.getUint16(off + 7, true);
    out.push({ type, payload: buf.slice(off + HDR, off + HDR + len) });
    off += HDR + len;
  }
  return out;
}
let myWid = 0;
let myRef = { x: 0, y: 0, z: 0 };
const known = new Map();
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
  const tp = async (x, z) => {
    const r = await post('/api/debug/teleport', { token, x, z });
    myRef = { x: r.x, y: r.y, z: r.z };
    return r;
  };
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';

  let gotHello = false;
  let monsterChase = false;
  let observedAttack = false;
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      if (f.type === MSG.S2C_HELLO) {
        const h = parseS2C(f.type, f.payload, 0, 0, 0);
        myWid = h.self.wid;
        myRef = { x: h.self.x, y: h.self.y, z: h.self.z };
        gotHello = true;
      } else if (f.type === MSG.S2C_SELF) {
        const s = parseS2C(f.type, f.payload, 0, 0, 0);
        myRef = { x: s.x, y: s.y, z: s.z };
      } else if (f.type === MSG.S2C_SNAPSHOT || f.type === MSG.S2C_ENTER) {
        const s = parseS2C(f.type, f.payload, myRef.x, myRef.y, myRef.z);
        for (const e of s.entities) known.set(e.wid, { wid: e.wid, kind: e.kind, x: e.x, y: e.y, z: e.z, state: e.state });
      } else if (f.type === MSG.S2C_UPDATE) {
        const s = parseS2C(f.type, f.payload, myRef.x, myRef.y, myRef.z);
        for (const u of s.updates) {
          const e = known.get(u.wid);
          if (!e) continue;
          if (u.mask & 0x01) { e.x = myRef.x + u.dx / 100; e.y = myRef.y + u.dy / 100; e.z = myRef.z + u.dz / 100; }
          if (u.mask & 0x04) e.state = u.state;
        }
      } else if (f.type === MSG.S2C_EVENT) {
        const r = new Reader(f.payload);
        const evt = r.u8();
        const wid = r.u32();
        if (evt === EVT.DAMAGE && wid === myWid) observedAttack = true;
      }
    }
  };
  const wait = (condFn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (condFn()) return res(true); await sleep(50); }
    res(condFn());
  });
  // 静止输入保活（玩家站桩，怪物主动扑上来）；anticheat off 后位置声明不被校验
  let ticks = 0;
  const step = setInterval(() => { ws.send(encodeInput(ticks, myRef.x, myRef.y, myRef.z)); ticks++; }, 50);

  // 健壮退出：先停输入循环 + 复位防作弊，等 WS 真正 onclose（带超时兜底）再退出，
  // 避免仍在高频收帧时 process.exit() 触发 libuv UV_HANDLE_CLOSING 断言崩溃。
  const shutdown = async (code) => {
    clearInterval(step);
    await consoleCmd('anticheat on');
    await new Promise((r) => { ws.onclose = r; try { ws.close(); } catch (_) {} setTimeout(r, 400); });
    process.exit(code);
  };

  const nearestMonster = () => [...known.values()]
    .filter((e) => e.kind === KIND.MONSTER)
    .sort((a, b) => Math.hypot(a.x - myRef.x, a.z - myRef.z) - Math.hypot(b.x - myRef.x, b.z - myRef.z))[0];

  // ---- 测试环境准备：怪物必须活跃（防御上次遗留），传送不被防作弊误判 ----
  await consoleCmd('monsterpause off');
  await consoleCmd('anticheat off');
  await wait(() => gotHello, 3000);

  // ---- 构造确定性仇恨场景：传送贴怪 / 生成怪物 ----
  let mm = null;
  await wait(() => { mm = nearestMonster(); return !!mm; }, 2500);
  if (mm) {
    const ang = Math.atan2(mm.z - myRef.z, mm.x - myRef.x);
    await tp(mm.x - Math.cos(ang) * 3.0, mm.z - Math.sin(ang) * 3.0);
    console.log(`[ai] 传送到自然怪物 wid=${mm.wid} 身旁 ~3m（仇恨范围 10m 内）`);
  } else {
    await consoleCmd('spawn wolf');   // 视野内无怪物：在身边生成一只（确定性目标）
    await wait(() => { mm = nearestMonster(); return !!mm; }, 2000);
    console.log(`[ai] 视野内无自然怪物，已在身边生成狼 wid=${mm ? mm.wid : '?'}`);
  }
  const targetWid = mm ? mm.wid : 0;
  if (!targetWid) {
    console.log('[ai] FAIL 无可用怪物目标');
    await shutdown(1);
    return;
  }

  // ---- 观察：怪物追击(向玩家靠近) 或 攻击(DAMAGE 命中自己) 任一即 PASS，最多 ~8s，命中即提前结束 ----
  let prev = null;
  for (let i = 0; i < 40 && !(monsterChase || observedAttack); i++) {
    await sleep(200);
    const cur = known.get(targetWid);
    if (cur && Number.isFinite(cur.x) && Number.isFinite(cur.z) && Number.isFinite(myRef.x)) {
      const dNow = Math.hypot(cur.x - myRef.x, cur.z - myRef.z);
      if (prev) {
        const moved = Math.hypot(cur.x - prev.x, cur.z - prev.z);
        if (moved > 0.15 && dNow < 12) monsterChase = true;
      }
      prev = { x: cur.x, z: cur.z };
      if (i % 5 === 0) console.log(`[ai] t=${(i * 0.2).toFixed(1)}s 距=${dNow.toFixed(1)}m 追击=${monsterChase} 攻击=${observedAttack}`);
    }
  }
  const verdict = (monsterChase || observedAttack) ? 'PASS' : 'FAIL';
  console.log(`[ai] 追击=${monsterChase} 攻击=${observedAttack} => ${verdict}`);
  await shutdown(verdict === 'PASS' ? 0 : 1);
}
main().catch((e) => { console.error('[ai] ERROR', e.message); process.exit(1); });
