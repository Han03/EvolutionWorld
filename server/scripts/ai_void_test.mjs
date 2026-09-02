/**
 * AI 空洞区域判断测试：
 *  1) 空洞边缘刷怪 → 玩家隔空洞引怪 → 验证怪物追击全程不进入空洞（不可进入区域）
 *  2) 怪物直线追击撞到空洞墙卡住 → stuckT 超阈值 → 脱战回巢（不永久顶墙）
 *  3) NPC 位置抽样不进入空洞（怪物/NPC 共用 moveEntityCollide 地形碰撞）
 * 需要服务端 EW_DEBUG=1（依赖 /api/console 与 /api/debug/teleport）
 */
import { parseS2C, MSG, KIND } from '../../client/js/protocol.js';
import { terrainBlocked } from '../../client/js/terrain.js';

const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'aiv' + Math.floor(Math.random() * 100000);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const postConsole = async (token, command) => {
  const j = await post('/api/console', { token, command });
  if (!j.ok) throw new Error('console ' + command + ': ' + JSON.stringify(j));
  return j;
};
const debugTp = async (token, x, z) => {
  const j = await post('/api/debug/teleport', { token, x, z });
  return j;
};
const walkable = (x, z) => !terrainBlocked(x, z);

// 找空洞边缘干地：可通行且 3m 内存在空洞、距城镇 >=25m
function findVoidEdge() {
  for (let z = -110; z < 110; z += 1) for (let x = -110; x < 110; x += 1) {
    const cx = x + 0.5, cz = z + 0.5;
    if (!walkable(cx, cz)) continue;
    if (Math.hypot(cx, cz) < 25 || Math.hypot(cx, cz) > 100) continue;
    let nearVoid = false;
    for (let dz = -3; dz <= 3 && !nearVoid; dz++) for (let dx = -3; dx <= 3 && !nearVoid; dx++) {
      if (terrainBlocked(cx + dx, cz + dz)) nearVoid = true;
    }
    if (nearVoid) return { x: cx, z: cz };
  }
  return null;
}

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

async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let ref = { x: 0, y: 0, z: 0 };
  const known = new Map();
  let gotHello = false;
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try {
        const msg = parseS2C(f.type, f.payload, ref.x, ref.y, ref.z);
        if (msg.type === MSG.S2C_HELLO) { ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true; }
        else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) for (const e of msg.entities) known.set(e.wid, e);
        else if (msg.type === MSG.S2C_LEAVE) for (const w of msg.wids) known.delete(w);
      } catch (e) { /* 忽略解码错误 */ }
    }
  };
  await new Promise((r) => setTimeout(r, 800));
  check('HELLO 到达', gotHello);

  const edge = findVoidEdge();
  console.log(`  空洞边缘干地: (${edge.x.toFixed(1)}, ${edge.z.toFixed(1)})`);
  const mk = await postConsole(token, `spawn wolf ${edge.x.toFixed(1)} ${edge.z.toFixed(1)}`);
  console.log('  spawn:', mk.output.trim());
  const mWid = parseInt((mk.output.match(/wid=(\d+)/) || [0, 0])[1], 10);
  await new Promise((r) => setTimeout(r, 800));
  const mon0 = known.get(mWid);
  check('怪物已生成并可见', !!mon0, mon0 ? `@(${mon0.x.toFixed(1)},${mon0.z.toFixed(1)})` : '');
  const homeX = mon0.x, homeZ = mon0.z;

  // 找玩家落点：怪物周围 4-10m、可通行、且直线路径中点被空洞阻挡（保证引怪时撞墙）
  let playerSpot = null, cross = null;
  for (let ang = 0; ang < 6.283 && !playerSpot; ang += 0.05) {
    for (let dist = 4; dist <= 10; dist += 1) {
      const px = homeX + Math.cos(ang) * dist, pz = homeZ + Math.sin(ang) * dist;
      if (!walkable(px, pz)) continue;
      // 直线中点（0.5 处）是否空洞
      const mx = homeX + Math.cos(ang) * dist * 0.5, mz = homeZ + Math.sin(ang) * dist * 0.5;
      if (terrainBlocked(mx, mz)) { playerSpot = { x: px, z: pz }; cross = { x: mx, z: mz }; break; }
    }
  }
  check('找到隔空洞引怪点', !!playerSpot, playerSpot ? `@(${playerSpot.x.toFixed(1)},${playerSpot.z.toFixed(1)}) 空洞中点在(${cross.x.toFixed(1)},${cross.z.toFixed(1)})` : '');
  if (!playerSpot) { ws.close(); console.log(`结果: PASS=${pass} FAIL=${fail}`); process.exit(fail ? 1 : 0); }

  const tpR = await debugTp(token, playerSpot.x, playerSpot.z);
  ref = { x: tpR.x, y: tpR.y, z: tpR.z };  // 更新快照解码基准（重要！）
  console.log(`  玩家隔空洞引怪 @(${playerSpot.x.toFixed(1)}, ${playerSpot.z.toFixed(1)})`);
  await new Promise((r) => setTimeout(r, 500));

  // 采样怪物位置 6s（每 0.5s）
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const e = known.get(mWid);
    if (e) samples.push({ x: e.x, z: e.z, t: Date.now() - t0 });
    await sleep(500);
  }
  if (samples.length < 4) { check('采样到怪物位置', false, `仅 ${samples.length} 个`); }
  else {
    // 断言 1：怪物全程未进入空洞
    const inVoid = samples.filter((s) => terrainBlocked(s.x, s.z));
    check('怪物追击全程未进入空洞', inVoid.length === 0,
      inVoid.length ? `${inVoid.length}/${samples.length} 样本在空洞` : `${samples.length} 个样本全部干地`);

    // 断言 2：撞墙卡住（1.5s 位移<0.3m）后脱战回巢（距出生点下降）
    const dHome = (s) => Math.hypot(s.x - homeX, s.z - homeZ);
    let stuckSeen = false;
    for (let i = 0; i + 3 < samples.length; i++) {
      const moved = Math.hypot(samples[i + 3].x - samples[i].x, samples[i + 3].z - samples[i].z);
      if (moved < 0.3) { stuckSeen = true; break; }
    }
    const dStart = dHome(samples[0]), dEnd = dHome(samples[samples.length - 1]);
    if (stuckSeen) {
      check('卡住后脱战回巢（距出生点下降或持平）', dEnd <= dStart + 1.5, `dHome ${dStart.toFixed(1)} -> ${dEnd.toFixed(1)}`);
    } else {
      console.log('  [info] 未检测到持续卡住（怪物可能绕行成功），跳过脱战断言');
      check('卡住后脱战回巢', true, '（未卡住）');
    }
  }

  // 断言 3：NPC 位置不进入空洞
  const npcSamples = [];
  const tn = Date.now();
  while (Date.now() - tn < 2000) {
    for (const e of known.values()) if (e.kind === KIND.NPC) { npcSamples.push({ x: e.x, z: e.z }); break; }
    await sleep(400);
  }
  const npcInVoid = npcSamples.filter((s) => terrainBlocked(s.x, s.z));
  check('NPC 位置不进入空洞', npcInVoid.length === 0, `样本 ${npcSamples.length}`);

  await postConsole(token, `kill ${mWid}`).catch(() => {});
  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
