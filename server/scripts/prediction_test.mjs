#!/usr/bin/env node
/**
 * prediction_test.mjs - 端到端验证客户端预测与服务端权威轨迹一致
 * 1) 连接 C++ 服务端，拿到 spawn 位置
 * 2) 用真实 Predictor（predict.js）按 20Hz 步进
 * 3) 同时把输入(带预测位置)发给服务端
 * 4) 对比预测轨迹 vs 服务端权威轨迹，统计最大偏差
 * 期望：合法客户端不被 correction，且轨迹偏差 < 1m（主要来自网络/时序）
 */
import { Predictor } from '../../client/js/predict.js';

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 脚本化输入序列（tick 索引 -> {mx, mz, jump}）
function script(tick) {
  if (tick < 40) return { mx: 0, mz: -1, jump: false };   // 前进
  if (tick < 60) return { mx: 1, mz: 0, jump: false };    // 右移
  if (tick === 60) return { mx: 0, mz: 0, jump: true };   // 跳跃
  if (tick < 90) return { mx: 0, mz: 0, jump: false };    // 空中/落地
  return { mx: 0.7, mz: 0.7, jump: false };               // 斜向
}

async function main() {
  const uname = 'pred' + Date.now() % 100000000;
  await post('/api/register', { username: uname, password: 'pass1234' });
  const login = await post('/api/login', { username: uname, password: 'pass1234' });
  const ws = new WebSocket(WS + '?token=' + login.token);

  let selfId = null;
  let you = null;
  let snap = null;
  const corrections = [];

  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
  });
  await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') {
        selfId = m.entityId;
        you = m.you;
        resolve();
      }
    };
  });
  // 读取第一份快照确认 spawn
  await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'snapshot') {
        snap = m;
        resolve();
      }
    };
  });

  const pred = new Predictor();
  pred.setPosition(you.x, you.y, you.z);
  console.log(`[pred] spawn you=(${you.x.toFixed(2)},${you.y.toFixed(2)},${you.z.toFixed(2)})`);

  let seq = 0;
  const serverPoses = [];
  const predPoses = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'correction') {
      corrections.push(m);
      pred.correction(m.x, m.y, m.z);
      console.warn(`[pred] correction: ${m.reason}`);
    } else if (m.type === 'snapshot') {
      for (const e of m.entities) {
        if (e.id === selfId) serverPoses.push({ x: e.x, y: e.y, z: e.z });
      }
    }
  };

  // 20Hz 循环
  const total = 100;
  for (let t = 0; t < total; t++) {
    const s = script(t);
    pred.applyInput(s.mx, s.mz, s.jump);
    pred.step(0.05); // 每 tick 50ms
    const p = pred.predicted();
    predPoses.push({ ...p });
    ws.send(JSON.stringify({
      type: 'input', seq: ++seq, moveX: s.mx, moveZ: s.mz, jump: s.jump,
      px: p.x, py: p.y, pz: p.z,
    }));
    await sleep(50);
  }

  await sleep(200);
  ws.close();

  // 对比
  if (serverPoses.length === 0) {
    console.log('FAIL: 未收到任何服务端自身快照');
    process.exit(1);
  }
  let maxErr = 0, maxIdx = 0;
  const n = Math.min(serverPoses.length, predPoses.length);
  for (let i = 0; i < n; i++) {
    const sp = serverPoses[i], pp = predPoses[i];
    const err = Math.hypot(sp.x - pp.x, sp.z - pp.z);
    if (err > maxErr) { maxErr = err; maxIdx = i; }
  }
  const lastS = serverPoses[serverPoses.length - 1];
  const lastP = predPoses[predPoses.length - 1];
  console.log(`[pred] server last=(${lastS.x.toFixed(2)},${lastS.z.toFixed(2)}) pred last=(${lastP.x.toFixed(2)},${lastP.z.toFixed(2)})`);
  console.log(`[pred] 对比快照数=${serverPoses.length} 最大水平偏差=${maxErr.toFixed(3)}m @#${maxIdx}  corrections=${corrections.length}`);
  const ok = maxErr < 1.5 && corrections.length === 0;
  console.log(ok ? 'PASS: 预测轨迹与服务端权威轨迹一致，无回退' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
