#!/usr/bin/env node
/**
 * ai_behavior_test.mjs - 验证新 AI 框架（怪物仇恨追击 + 攻击 + Boss 追击）
 * 1) 登录玩家，连接二进制 WS
 * 2) 解析 HELLO/SNAPSHOT/ENTER/UPDATE/SELF 帧，跟踪最近怪物与自身权威位置
 * 3) 走向怪物 → 观察其进入仇恨后追击（向玩家移动）并攻击（S2C_EVENT DAMAGE 命中自己）
 * 判定：能观察到 追击 或 攻击 任一行为即 PASS
 */
import { encodeInput, parseS2C, MSG, EVT, Reader } from '../../client/js/protocol.js';
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
  const ws = new WebSocket(WS + '?token=' + j.token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let ticks = 0;
  let started = false;
  let monsterChase = false;
  let observedAttack = false;
  let moveTo = { mx: 0, mz: 0 };
  let lastPrint = 0;
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      if (f.type === MSG.S2C_HELLO) {
        const h = parseS2C(f.type, f.payload, 0, 0, 0);
        myWid = h.self.wid;
        myRef = { x: h.self.x, y: h.self.y, z: h.self.z };
      } else if (f.type === MSG.S2C_SELF) {
        const s = parseS2C(f.type, f.payload, 0, 0, 0);
        myRef = { x: s.x, y: s.y, z: s.z };
      } else if (f.type === MSG.S2C_SNAPSHOT || f.type === MSG.S2C_ENTER) {
        const s = parseS2C(f.type, f.payload, myRef.x, myRef.y, myRef.z);
        for (const e of s.entities) known.set(e.wid, { kind: e.kind, x: e.x, y: e.y, z: e.z, state: e.state });
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
  const step = setInterval(() => {
    ws.send(encodeInput(ticks, moveTo.mx, moveTo.mz, false, myRef.x, myRef.y, myRef.z));
    ticks++;
  }, 50);
  for (let sec = 0; sec < 16; sec++) {
    await sleep(400);
    let nearest = null, nd = 1e9;
    for (const [wid, e] of known) {
      if (e.kind !== 2) continue;
      const d = Math.hypot(e.x - myRef.x, e.z - myRef.z);
      if (d < nd) { nd = d; nearest = { wid, ...e }; }
    }
    if (nearest) {
      const dNow = Math.hypot(nearest.x - myRef.x, nearest.z - myRef.z);
      if (!started) {
        started = true;
        const dx = nearest.x - myRef.x, dz = nearest.z - myRef.z;
        const dd = Math.hypot(dx, dz);
        if (dd > 1e-3) moveTo = { mx: dx / dd, mz: dz / dd };
        console.log(`[ai] 目标怪物 wid=${nearest.wid} 距离=${nd.toFixed(1)}m，开始靠近`);
      }
      if (nearest.dist !== undefined) {
        const moved = Math.hypot(nearest.x - nearest.dist.x, nearest.z - nearest.dist.z);
        if (moved > 0.2 && dNow < 12) monsterChase = true;
      }
      nearest.dist = { x: nearest.x, z: nearest.z };
      if (sec - lastPrint >= 2 || sec === 0) {
        console.log(`[ai] t=${sec}s 玩家(${myRef.x.toFixed(1)},${myRef.z.toFixed(1)}) 怪物(${nearest.x.toFixed(1)},${nearest.z.toFixed(1)}) 距=${dNow.toFixed(1)}m`);
        lastPrint = sec;
      }
    } else {
      moveTo = { mx: 0, mz: 0 };
      if (sec % 4 === 0) console.log(`[ai] t=${sec}s 视野内无怪物（known=${known.size}）`);
    }
  }
  clearInterval(step);
  const verdict = (monsterChase || observedAttack) ? 'PASS' : 'FAIL';
  console.log(`[ai] 追击=${monsterChase} 攻击=${observedAttack} => ${verdict}`);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('[ai] ERROR', e.message); process.exit(1); });
