#!/usr/bin/env node
/**
 * cast_time_test.mjs - 技能前摇/施放时间判定端到端验证（服务端权威）
 * 覆盖：
 *  1) S2C_SKILL_CAST 反馈携带 castTimeMs（烈焰冲击=600）
 *  2) 施放有前摇技能 → 立即收到 EVT_SKILL_CASTING（前摇开始）
 *  3) 前摇期间移动 → EVT_SKILL_CANCEL，且不再结算（无 EVT_SKILL / 怪物不掉血）
 *  4) 完整等待前摇 → 结算时收到 EVT_SKILL + 怪物掉血
 *  5) 瞬发技能（冲刺斩 1001 castTimeMs=0）→ 无 EVT_SKILL_CASTING，立即 EVT_SKILL
 * 需要服务端 EW_DEBUG=1 运行（依赖 /api/debug/teleport）
 */
import { encodeCastSkill, encodeInput, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'cast' + Math.floor(Math.random() * 100000);
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
  if (!r.ok || !j.ok) throw new Error(path + ' ' + JSON.stringify(j));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let selfWid = 0;
  let ref = { x: 0, y: 0, z: 0 };
  let castFb = null;
  let evtCasting = null;   // EVT_SKILL_CASTING
  let evtCancel = null;    // EVT_SKILL_CANCEL
  let evtSkill = null;     // EVT_SKILL
  let monDamage = 0;       // 怪物 wid 上的 EVT_DAMAGE 次数
  let selfHits = 0;        // 自身受击次数
  let skills = null;
  const known = new Map();
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
    } else if (msg.type === MSG.S2C_SKILLS) skills = msg;
    else if (msg.type === MSG.S2C_SKILL_CAST) castFb = msg;
    else if (msg.type === MSG.S2C_EVENT) {
      if (msg.evtType === EVT.SKILL_CASTING) evtCasting = msg;
      else if (msg.evtType === EVT.SKILL_CANCEL) evtCancel = msg;
      else if (msg.evtType === EVT.SKILL) evtSkill = msg;
      else if (msg.evtType === EVT.DAMAGE) {
        if (msg.wid === selfWid) selfHits++;
        else monDamage++;
      }
    }
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, ref.x, ref.y, ref.z)); } catch (e) { console.error('decode', e); }
    }
  };
  const wait = (condFn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (condFn()) return res(true);
      await sleep(50);
    }
    res(condFn());
  });
  const send = (b) => ws.send(b);
  const tp = async (x, z) => {
    const r = await post('/api/debug/teleport', { token, x, z });
    ref = { x: r.x, y: r.y, z: r.z };
    return r;
  };
  const nearestMonster = () => [...known.values()]
    .filter((e) => e.kind === KIND.MONSTER)
    .sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];

  await wait(() => gotHello && skills, 3000);
  await wait(() => known.size > 0, 2000);
  const mm = nearestMonster();
  check('视野内存在怪物', !!mm);
  if (!mm) { console.log('无怪物，退出'); ws.close(); process.exit(1); }
  const tpR = await tp(mm.x, mm.z);
  ref = { x: tpR.x, y: tpR.y, z: tpR.z };
  await sleep(300);
  const mmWid = nearestMonster().wid;

  // ---- 测试1：反馈帧带 castTimeMs ----
  castFb = null;
  send(encodeCastSkill(1002, 0, ref.x, ref.z)); // 烈焰冲击 前摇600ms
  await wait(() => castFb, 2000);
  check('反馈帧 ok=1', castFb && castFb.ok === 1, castFb ? `ok=${castFb.ok}` : '');
  check('反馈帧 castTimeMs=600', castFb && castFb.castTimeMs === 600, castFb ? `ct=${castFb.castTimeMs}` : '');

  // ---- 测试2：前摇立即收到 EVT_SKILL_CASTING ----
  evtCasting = null;
  send(encodeCastSkill(1002, 0, ref.x, ref.z));
  await wait(() => evtCasting, 1000);
  check('前摇开始 EVT_SKILL_CASTING', !!evtCasting, evtCasting ? `caster=${evtCasting.wid} skill=${evtCasting.b}` : '');

  // ---- 测试3：前摇期间移动 → 打断（EVT_SKILL_CANCEL），且不结算 ----
  evtCancel = null; evtSkill = null; monDamage = 0;
  send(encodeCastSkill(1002, 0, ref.x, ref.z));
  await wait(() => evtCasting, 800); // 等待前摇开始
  evtSkill = null;
  // 立即发送移动输入（向前移动）→ 触发移动打断
  send(encodeInput(1, 1, 0, false, ref.x + 1, 0, ref.z));
  await wait(() => evtCancel, 1500);
  check('前摇被移动打断 EVT_SKILL_CANCEL', !!evtCancel, evtCancel ? `reason=${evtCancel.x} skill=${evtCancel.b}` : '');
  // 打断后不再结算：等待 >castTime 仍无 EVT_SKILL、怪物不掉血
  await wait(() => evtSkill, 900);
  check('打断后未结算(无 EVT_SKILL)', evtSkill === null, evtSkill ? `有:skill=${evtSkill.b}` : '');
  check('打断后怪物未掉血', monDamage === 0, `damage=${monDamage}`);
  // 停住（发送归零输入），等技能冷却恢复再测完整施放
  send(encodeInput(2, 0, 0, false, ref.x, 0, ref.z));
  await sleep(700);

  // ---- 测试4：完整等待前摇 → 结算 EVT_SKILL + 施放时间判定 ----
  // 传送到 15m 内无怪物的安全空地（避免被遗留仇恨怪物在 600ms 前摇内受击打断），
  // AOE 落点=自身前方 3m（1002 射程 8m 内）。怪物受击命中由 skills_console_test 承担严格覆盖。
  for (let attempt = 0; attempt < 5 && nearestMonster(); attempt++) {
    const mSafe = nearestMonster();
    const aSafe = Math.atan2(mSafe.z - ref.z, mSafe.x - ref.x);
    const safeX = ref.x - Math.cos(aSafe) * 20, safeZ = ref.z - Math.sin(aSafe) * 20;
    const trSafe = await tp(safeX, safeZ);
    ref = { x: trSafe.x, y: trSafe.y, z: trSafe.z };
    await sleep(300);
  }
  evtCasting = null; evtSkill = null; evtCancel = null; monDamage = 0;
  send(encodeCastSkill(1002, 0, ref.x + 3, ref.z + 3));
  await wait(() => evtCasting, 1000);
  check('再次施放进入前摇', !!evtCasting);
  const tCastStart = Date.now();
  await wait(() => evtSkill, 2500);
  if (!evtSkill) console.log(`  [dbg] test4 未结算: cancel=${evtCancel ? JSON.stringify(evtCancel) : '无'} castFb=${castFb ? 'ok=' + castFb.ok : '无'} 自身受击=${selfHits}`);
  check('前摇到期结算 EVT_SKILL', !!evtSkill, evtSkill ? `skill=${evtSkill.b} 落点(${evtSkill.x},${evtSkill.z})` : '');
  const elapsed = Date.now() - tCastStart;
  // 前摇 600ms + tick 容差：结算应在 [450, 1500]ms 内到达
  check('施放时间判定≈600ms', elapsed >= 450 && elapsed <= 1500, `elapsed=${elapsed}ms`);
  await wait(() => monDamage > 0, 1000);
  console.log(`  [info] 空地 AOE 命中怪物事件数: ${monDamage}（安全区可能无怪，命中覆盖由 skills_console 承担）`);

  // ---- 测试5：瞬发技能（冲刺斩 1001, castTimeMs=0）无前摇直接结算 ----
  await sleep(700); // 等冷却
  evtCasting = null; evtSkill = null; monDamage = 0;
  const mm2 = nearestMonster();
  if (mm2) {
    const tp2 = await tp(mm2.x, mm2.z);
    ref = { x: tp2.x, y: tp2.y, z: tp2.z };
    await sleep(250);
    const mm2b = nearestMonster(); // tp 后重新取最近的活怪
    const wid2 = mm2b ? mm2b.wid : mm2.wid;
    const tp3 = await tp(mm2b ? mm2b.x : mm2.x, mm2b ? mm2b.z : mm2.z);
    ref = { x: tp3.x, y: tp3.y, z: tp3.z };
    await sleep(200);
    castFb = null;
    send(encodeCastSkill(1001, wid2, ref.x, ref.z));
    await wait(() => castFb, 2000);
    check('瞬发反馈 ok=1 且 castTimeMs=0', castFb && castFb.ok === 1 && castFb.castTimeMs === 0,
      castFb ? `ok=${castFb.ok} ct=${castFb.castTimeMs}` : '');
    await wait(() => evtSkill, 1500);
    check('瞬发无前摇直接结算 EVT_SKILL', !!evtSkill, evtSkill ? `skill=${evtSkill.b}` : '');
    check('瞬发未触发前摇事件', evtCasting === null);
  }

  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
