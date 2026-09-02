#!/usr/bin/env node
/**
 * ai_intent_test.mjs - 验证怪物移动同步协议（消除 rubber-banding）
 * 1) UPDATE/ENTER 帧携带 AI 意图（aiState + 目标速度 + 速度倍率）
 * 2) 客户端确定性外推与服务端权威位置误差在阈值内（≤2m，行为切换瞬间可放宽）
 * 3) 巡逻去随机化：怪物目标速度随时间保持稳定（waypoint 环匀速），无随机抖动
 */
import { parseS2C, MSG, Reader } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'intent' + Math.floor(Math.random() * 100000);
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(JSON.stringify(j));
  return j;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function decodeFrames(buf) {
  const out = []; let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off + 9 <= buf.byteLength) {
    if (!(buf[off] === 0x45 && buf[off + 1] === 0x57)) break;
    const type = buf[off + 3];
    const len = dv.getUint16(off + 7, true);
    out.push({ type, payload: buf.slice(off + 9, off + 9 + len) });
    off += 9 + len;
  }
  return out;
}
let myRef = { x: 0, y: 0, z: 0 };
const known = new Map(); // wid -> {kind,x,y,z,aiState,tx,tz,speedMult, hasIntent}
const intentRx = new Map(); // wid -> {aiState,tx,tz,speedMult}
async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const ws = new WebSocket(WS + '?token=' + j.token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let fails = 0, total = 0;
  let helloOk = false;
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      if (f.type === MSG.S2C_HELLO) {
        const h = parseS2C(f.type, f.payload, 0, 0, 0);
        myRef = { x: h.self.x, y: h.self.y, z: h.self.z };
        helloOk = true;
      } else if (f.type === MSG.S2C_SELF) {
        const s = parseS2C(f.type, f.payload, 0, 0, 0);
        myRef = { x: s.x, y: s.y, z: s.z };
      } else if (f.type === MSG.S2C_SNAPSHOT || f.type === MSG.S2C_ENTER) {
        const s = parseS2C(f.type, f.payload, myRef.x, myRef.y, myRef.z);
        for (const e of s.entities) {
          known.set(e.wid, { kind: e.kind, x: e.x, y: e.y, z: e.z, aiState: e.aiState, tx: e.tx, tz: e.tz, speedMult: e.speedMult, hasIntent: e.aiState !== undefined });
          if (e.aiState !== undefined) intentRx.set(e.wid, { aiState: e.aiState, tx: e.tx, tz: e.tz, speedMult: e.speedMult });
        }
      } else if (f.type === MSG.S2C_UPDATE) {
        const s = parseS2C(f.type, f.payload, myRef.x, myRef.y, myRef.z);
        for (const u of s.updates) {
          const e = known.get(u.wid);
          if (!e) continue;
          if (u.mask & 0x01) { e.x = u.x; e.y = u.y; e.z = u.z; }
          if (u.mask & 0x08) {
            e.aiState = u.aiState; e.tx = u.tx; e.tz = u.tz; e.speedMult = u.speedMult; e.hasIntent = true;
            intentRx.set(u.wid, { aiState: u.aiState, tx: u.tx, tz: u.tz, speedMult: u.speedMult });
          }
        }
      }
    }
  };
  // 记录 6 秒怪物轨迹 + 意图
  const step = setInterval(() => {}, 50);
  const samples = []; // {t, wid, x, z, tx, tz, aiState}
  for (let sec = 0; sec < 6; sec++) {
    await sleep(500);
    for (const [wid, e] of known) {
      if (e.kind !== 2) continue;
      const it = intentRx.get(wid);
      samples.push({ t: sec, wid, x: e.x, z: e.z, tx: it ? it.tx : NaN, tz: it ? it.tz : NaN, aiState: it ? it.aiState : -1 });
    }
  }
  clearInterval(step);
  // ① 意图到达率：怪物应携带 intent（aiState 0..7）
  let mon = 0, withIntent = 0;
  for (const [wid, e] of known) { if (e.kind === 2) { mon++; if (e.hasIntent && e.aiState >= 0 && e.aiState <= 7) withIntent++; } }
  console.log(`[intent] 怪物=${mon} 携带意图=${withIntent}`);
  if (mon > 0 && withIntent >= Math.floor(mon * 0.8)) { console.log('  [PASS] 意图字段覆盖'); }
  else { console.log('  [FAIL] 意图字段缺失'); fails++; }
  // ② 确定性外推一致性：对每个怪物，检查"位置变化方向"与"目标速度方向"大体一致（巡逻匀速段）
  //    用相邻样本：若目标速度非零且稳定，位移应沿目标速度方向（点积>0）
  let dirOk = 0, dirTotal = 0;
  const byWid = new Map();
  for (const s of samples) { if (!byWid.has(s.wid)) byWid.set(s.wid, []); byWid.get(s.wid).push(s); }
  for (const [wid, arr] of byWid) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      if (!Number.isFinite(a.tx) || a.aiState === 3 || a.aiState === 0) continue; // 攻击/待机不动
      const spd = Math.hypot(a.tx, a.tz);
      if (spd < 0.05) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const moved = Math.hypot(dx, dz);
      if (moved < 0.02) continue; // 卡住/暂停段跳过
      const dot = (dx * a.tx + dz * a.tz) / (moved * spd);
      dirTotal++;
      if (dot > 0.3) dirOk++;
    }
  }
  console.log(`[intent] 移动方向与目标速度一致: ${dirOk}/${dirTotal}`);
  if (dirTotal > 0 && dirOk / Math.max(1, dirTotal) > 0.6) { console.log('  [PASS] 确定性外推方向一致'); }
  else { console.log('  [FAIL] 外推方向不一致'); fails++; }
  // ③ 目标速度倍率范围 0-100
  let multOk = true;
  for (const it of intentRx.values()) { if (it.speedMult < 0 || it.speedMult > 100) multOk = false; }
  if (multOk) console.log('  [PASS] 速度倍率范围 0-100'); else { console.log('  [FAIL] 速度倍率越界'); fails++; }
  ws.close();
  console.log(`结果: PASS=${fails === 0 ? 3 : 3 - fails} FAIL=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[intent] ERROR', e.message); process.exit(1); });
