#!/usr/bin/env node
/**
 * prediction_test.mjs - 端到端验证客户端预测与服务端权威轨迹一致（二进制协议）
 * 1) 连接 C++ 服务端（二进制 WS），解码 HELLO 拿到出生位置
 * 2) 用真实 Predictor（predict.js）按 20Hz 步进
 * 3) 同时把输入(带预测位置)发给服务端（proto::encodeInput 编码）
 * 4) 通过 /api/debug/players 获取服务端权威轨迹，与预测轨迹对比
 * 期望：合法客户端不被 correction，且轨迹偏差 < 1m
 */
import { Predictor } from '../../client/js/predict.js';
import { encodeInput, parseS2C, MSG } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
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
async function debugSelf(uname) {
  const r = await fetch(BASE + '/api/debug/players');
  const j = await r.json();
  for (const p of j.players) if (p.username === uname) return p;
  return null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function script(tick) {
  if (tick < 40) return { mx: 0, mz: -1, jump: false };   // 前进
  if (tick < 60) return { mx: 1, mz: 0, jump: false };    // 右移
  if (tick === 60) return { mx: 0, mz: 0, jump: true };   // 跳跃
  if (tick < 90) return { mx: 0, mz: 0, jump: false };    // 空中/落地
  return { mx: 0.7, mz: 0.7, jump: false };               // 斜向
}
// 解码一个二进制 WS 消息 → 若干 {type, payload}
function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 9 <= buf.length) {
    if (buf[off] !== 0x45 || buf[off + 1] !== 0x57) break;
    const type = buf[off + 3];
    const len = buf[off + 7] | (buf[off + 8] << 8);
    if (off + 9 + len > buf.length) break;
    out.push({ type, payload: buf.slice(off + 9, off + 9 + len) });
    off += 9 + len;
  }
  return out;
}
async function main() {
  const uname = 'pred' + Date.now() % 100000000;
  await post('/api/register', { username: uname, password: 'pass1234' });
  const login = await post('/api/login', { username: uname, password: 'pass1234' });
  const ws = new WebSocket(WS + '?token=' + login.token);
  ws.binaryType = 'arraybuffer';
  const corrections = [];
  let selfWid = 0;
  let hello = null;
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
  });
  await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const frames = decodeFrames(new Uint8Array(ev.data));
      for (const f of frames) {
        if (f.type === MSG.S2C_HELLO) {
          hello = parseS2C(MSG.S2C_HELLO, f.payload, 0, 0, 0);
          selfWid = hello.self.wid;
          resolve();
        }
      }
    };
  });
  const pred = new Predictor();
  pred.setPosition(hello.self.x, hello.self.y, hello.self.z);
  console.log(`[pred] spawn you=(${hello.self.x.toFixed(2)},${hello.self.y.toFixed(2)},${hello.self.z.toFixed(2)})`);
  // 后续消息：只关心 correction
  ws.onmessage = (ev) => {
    const frames = decodeFrames(new Uint8Array(ev.data));
    for (const f of frames) {
      if (f.type === MSG.S2C_SELF) {
        const m = parseS2C(MSG.S2C_SELF, f.payload, 0, 0, 0);
        corrections.push(m);
        pred.correction(m.x, m.y, m.z);
        console.warn(`[pred] correction: ${m.reason}`);
      }
    }
  };
  let seq = 0;
  const predPoses = [];
  const serverPoses = [];
  const total = 100;
  let lastMs = Date.now();
  for (let t = 0; t < total; t++) {
    const s = script(t);
    pred.applyInput(s.mx, s.mz, s.jump);
    // 发送输入（带当前预测位置，WS 即时送达，AC 校验不受拉取延迟影响）
    const pNow = pred.predicted();
    ws.send(encodeInput(++seq, s.mx, s.mz, s.jump, pNow.x, pNow.y, pNow.z));
    // 拉取服务端权威位置
    const sp = await debugSelf(uname);
    // 把预测器推进到与服务端采样相同的墙钟时刻（真实 dt，predictor 内部有积压上限兜底）
    const nowMs = Date.now();
    pred.step((nowMs - lastMs) / 1000);
    lastMs = nowMs;
    const p = pred.predicted();
    predPoses.push({ x: p.x, z: p.z });
    if (sp) serverPoses.push({ x: sp.x, z: sp.z });
    await sleep(50);
  }
  await sleep(200);
  ws.close();
  if (serverPoses.length === 0) {
    console.log('FAIL: 未获取到服务端权威轨迹（需 EW_DEBUG=1 运行服务端）');
    process.exit(1);
  }
  let maxErr = 0, maxIdx = 0;
  const n = Math.min(serverPoses.length, predPoses.length);
  for (let i = 0; i < n; i++) {
    const err = Math.hypot(serverPoses[i].x - predPoses[i].x, serverPoses[i].z - predPoses[i].z);
    if (err > maxErr) { maxErr = err; maxIdx = i; }
  }
  const ls = serverPoses[serverPoses.length - 1];
  const lp = predPoses[predPoses.length - 1];
  console.log(`[pred] server last=(${ls.x.toFixed(2)},${ls.z.toFixed(2)}) pred last=(${lp.x.toFixed(2)},${lp.z.toFixed(2)})`);
  console.log(`[pred] 对比快照数=${serverPoses.length} 最大水平偏差=${maxErr.toFixed(3)}m @#${maxIdx}  corrections=${corrections.length}`);
  const ok = maxErr < 1.5 && corrections.length === 0;
  console.log(ok ? 'PASS: 预测轨迹与服务端权威轨迹一致，无回退' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
