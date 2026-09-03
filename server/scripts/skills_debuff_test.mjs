#!/usr/bin/env node
/**
 * skills_debuff_test.mjs - 大型网游技能扩展端到端验证（服务端权威）
 * 覆盖：
 *  1) 取消目标检测：无目标（targetWid=0）所有新技能均可施放
 *  2) 范围命中：AOE 落点按 radius 判定命中范围内怪物
 *  3) 流血 DoT：撕裂后怪物 HP 持续下降（无需再次攻击）
 *  4) 眩晕：震荡波后怪物位置静止（STUN 期间无法移动）
 *  5) 击退：猛击后怪物被位移 >3m
 *  6) 霸体：SUPER_ARMOR 免疫眩晕（挂 stun 无效且仍可施放）
 *  7) 不可打断：铁壁守护前摇期间移动不打断，仍结算
 *  8) 减防：破甲斩后怪物防御下降（entities 显示 def 变化）
 *  9) 减攻：虚弱咒印后怪物攻击下降（entities 显示 atk 变化）
 * 依赖：EW_DEBUG=1 运行；控制台 heal/spawn/buff/buffmon 命令
 */
import { encodeCastSkill, encodeInput, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'deb' + Math.floor(Math.random() * 100000);
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
async function consoleCmd(token, cmd) {
  const j = await post('/api/console', { token, command: cmd });
  return (j.output || j.text || '').replace(/\n/g, ' ');
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
async function main() {
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';
  let ref = { x: 0, y: 0, z: 0 };
  let castFb = null, evtSkill = null, evtCasting = null, evtCancel = null;
  let monDamaged = 0;
  const known = new Map();
  let gotHello = false, skills = null;
  function handle(msg) {
    if (msg.type === MSG.S2C_HELLO) {
      ref = { x: msg.self.x, y: msg.self.y, z: msg.self.z }; gotHello = true;
    } else if (msg.type === MSG.S2C_SNAPSHOT || msg.type === MSG.S2C_ENTER) {
      for (const e of msg.entities) known.set(e.wid, e);
    } else if (msg.type === MSG.S2C_LEAVE) { for (const w of msg.wids) known.delete(w); }
    else if (msg.type === MSG.S2C_SKILLS) skills = msg;
    else if (msg.type === MSG.S2C_SKILL_CAST) castFb = msg;
    else if (msg.type === MSG.S2C_EVENT) {
      if (msg.evtType === EVT.SKILL_CASTING) evtCasting = msg;
      else if (msg.evtType === EVT.SKILL_CANCEL) evtCancel = msg;
      else if (msg.evtType === EVT.SKILL) evtSkill = msg;
      else if (msg.evtType === EVT.DAMAGE && msg.wid !== undefined && !known.get(msg.wid)?.name?.includes('玩家')) monDamaged++;
    }
  }
  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      try { handle(parseS2C(f.type, f.payload, ref.x, ref.y, ref.z)); } catch (e) {}
    }
  };
  const wait = (fn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return res(true); await sleep(50); }
    res(fn());
  });
  const send = (b) => ws.send(b);
  const tp = async (x, z) => {
    const r = await post('/api/debug/teleport', { token, x, z });
    ref = { x: r.x, y: r.y, z: r.z }; return r;
  };
  const monsterByWid = async (wid) => {
    const t = await consoleCmd(token, 'entities 250');
    const m = t.match(new RegExp(`\\[\\d+\\]\\S+\\(wid=${wid}\\) hp=(\\d+)/(\\d+) atk=(-?\\d+) def=(-?\\d+) @\\((-?[\\d.]+),(-?[\\d.]+)\\)`));
    return m ? { wid, hp: +m[1], maxHp: +m[2], atk: +m[3], def: +m[4], x: +m[5], z: +m[6] } : null;
  };
  // 生成一只新怪（未仇恨），站到 4.5m 外（>1.6m 近战安全；<1016 射程 6m），返回该怪信息
  const spawnFresh = async (type = 'wolf') => {
    // 清理全图非 Boss 怪物，杜绝上一测试遗留仇恨怪物打断施法前摇
    await consoleCmd(token, 'kill monsters');
    await sleep(200);
    const sp = await consoleCmd(token, `spawn ${type} ${ref.x.toFixed(0)} ${ref.z.toFixed(0)}`);
    const m = sp.match(/wid=(\d+) @(-?\d+),(-?\d+)/);
    if (!m) return null;
    const wid = +m[1];
    let sx = +m[2], sz = +m[3];
    await sleep(400);
    let info = await monsterByWid(wid);
    const ex = info ? info.x : sx, ez = info ? info.z : sz;
    const ang = Math.atan2(ez - ref.z, ex - ref.x);
    const tr = await tp(ex - Math.cos(ang) * 4.5, ez - Math.sin(ang) * 4.5);
    ref = { x: tr.x, y: tr.y, z: tr.z };
    await sleep(300);
    info = await monsterByWid(wid);
    return { wid, x: info ? info.x : ex, z: info ? info.z : ez };
  };
  const castNoTarget = async (skillId, wid, timeout = 2500) => {
    let tx = ref.x, tz = ref.z;
    if (wid) { const cur = await monsterByWid(wid); if (cur) { tx = cur.x; tz = cur.z; } }
    castFb = null; evtSkill = null; evtCasting = null;
    send(encodeCastSkill(skillId, 0, tx, tz));
    await wait(() => castFb, timeout);
    return { fb: castFb };
  };
  const heal = () => consoleCmd(token, 'heal');
  // 施放技能并重试直到目标掉血（撕裂等技能可能因目标游走 miss；重试前清 CD/回蓝）
  // 命中判定：成功施放后目标 HP 下降，或目标直接被击杀（高伤 AOE 秒杀低血怪时 monsterByWid 读不到尸体）。
  const castUntilHit = async (skillId, wid, attempts = 3) => {
    for (let a = 0; a < attempts; a++) {
      await heal();
      await consoleCmd(token, 'cdreset');
      const before = await monsterByWid(wid);
      const r = await castNoTarget(skillId, wid);
      await wait(() => evtSkill, 1800);
      await sleep(300);
      const after = await monsterByWid(wid);
      if (r.fb && r.fb.ok === 1 && before) {
        if (!after) return { hit: true, killed: true, fb: r.fb, before, after: { hp: 0, maxHp: before.maxHp } };
        if (after.hp < before.hp) return { hit: true, killed: false, fb: r.fb, before, after };
      }
      await sleep(200);
    }
    return { hit: false, killed: false, fb: null, before: null, after: null };
  };

  await wait(() => gotHello && skills, 3000);
  await wait(() => known.size > 0, 2000);
  await consoleCmd(token, 'stat mp 500');
  for (const id of [1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017]) {
    await consoleCmd(token, `skill ${id}`);
  }
  await heal();

  // ---- 测试环境确定性化 ----
  // monsterpause on: 冻结怪物游走，保证 AOE/减益技能落点命中（前摇+飞行期间目标不移出半径）。
  //   仅验证位移语义的步骤（4 眩晕静止 / 5 击退位移）需怪物活跃，那里临时 off。
  await consoleCmd(token, 'monsterpause on');
  {
    const r1 = await castNoTarget(1015);
    check('无目标施放 SELF(疾风步)', r1.fb && r1.fb.ok === 1, r1.fb ? `ok=${r1.fb.ok}` : '');
    await heal();
    const r2 = await castNoTarget(1010);
    check('无目标施放 不可打断/霸体(铁壁守护)', r2.fb && r2.fb.ok === 1, r2.fb ? `ok=${r2.fb.ok}` : '');
    await heal();
    const r3 = await castNoTarget(1011);
    check('无目标施放 AOE(撕裂)', r3.fb && r3.fb.ok === 1, r3.fb ? `ok=${r3.fb.ok}` : '');
    await heal();
  }

  // ---- 2) 范围命中：撕裂(1011, radius 4) 落点命中范围内怪物 ----
  {
    const f = await spawnFresh('wolf');
    if (f) {
      const h = await castUntilHit(1011, f.wid);
      check('范围命中：撕裂 AOE 命中落点内怪物', h.hit,
        h.killed ? `秒杀(before hp=${h.before ? h.before.hp : '?'})` : (h.after ? `hp=${h.after.hp}` : '未命中'));
    } else check('范围命中：生成测试怪物', false);
  }

  // ---- 3) 流血 DoT：撕裂后怪物 HP 持续下降 ----
  {
    const f = await spawnFresh('skeleton');
    if (f) {
      const h = await castUntilHit(1011, f.wid);
      const infoA = h.after;
      await sleep(1500);
      const infoB = await monsterByWid(f.wid);
      check('流血 DoT：怪物 HP 持续下降', h.hit && infoA && infoB && infoB.hp < infoA.hp - 5,
        h.hit && infoA && infoB ? `结算后${infoA.hp} -> 1.5s后${infoB.hp}` : `hit=${h.hit} A=${JSON.stringify(infoA)} B=${JSON.stringify(infoB)}`);
    } else check('流血 DoT：生成测试怪物', false);
  }

  // ---- 4) 眩晕：震荡波(1014, stun 2s)后怪物位置静止 ----
  {
    await consoleCmd(token, 'monsterpause off'); // 本步验证 stun 使追击中的怪物停下，需怪物活跃
    const f = await spawnFresh('wolf');
    if (f) {
      const r = await castNoTarget(1014, f.wid);
      await wait(() => evtSkill, 1500);
      await sleep(200);
      const p1 = await monsterByWid(f.wid);
      await sleep(1000);
      const p2 = await monsterByWid(f.wid);
      const dist = (p1 && p2) ? Math.hypot(p2.x - p1.x, p2.z - p1.z) : 999;
      check('眩晕：震荡波后怪物位置静止(<0.4m)', r.fb && r.fb.ok === 1 && dist < 0.4,
        `移动=${dist.toFixed(2)}m fb=${r.fb ? r.fb.ok : 'null'}`);
    } else check('眩晕：生成测试怪物', false);
    await consoleCmd(token, 'monsterpause on');
  }

  // ---- 5) 击退：猛击(1016, knockback 6m)后怪物位移>3m ----
  {
    await consoleCmd(token, 'monsterpause off'); // 本步验证击退位移，需怪物可被推动
    const f = await spawnFresh('wolf');
    if (f) {
      const posA = { x: f.x, z: f.z };
      const r = await castNoTarget(1016, f.wid);
      await wait(() => evtSkill, 1500);
      await sleep(600);
      const f2 = await monsterByWid(f.wid);
      const dist = f2 ? Math.hypot(f2.x - posA.x, f2.z - posA.z) : 999;
      check('击退：猛击后怪物位移>3m', r.fb && r.fb.ok === 1 && dist > 3.0,
        `位移=${dist.toFixed(2)}m fb=${r.fb ? r.fb.ok : 'null'}`);
    } else check('击退：生成测试怪物', false);
    await consoleCmd(token, 'monsterpause on');
  }

  // ---- 6) 霸体：SUPER_ARMOR 免疫眩晕 + 期间仍可施放 ----
  {
    await heal();
    await consoleCmd(token, 'buff super_armor 1 5');
    const rStun = await consoleCmd(token, 'buff stun 1 3');
    const st = await consoleCmd(token, 'status');
    check('霸体：挂 stun 被免疫(status 无眩晕)', !st.includes('眩晕'), rStun.slice(0, 40));
    const rc = await castNoTarget(1015);
    check('霸体：免疫眩晕期间仍可施放技能', rc.fb && rc.fb.ok === 1, rc.fb ? `ok=${rc.fb.ok}` : '');
    await consoleCmd(token, 'buff clear');
    await consoleCmd(token, 'buff stun 1 3');
    const st2 = await consoleCmd(token, 'status');
    check('对照：无霸体时眩晕生效(status 含眩晕)', st2.includes('眩晕'), st2.slice(0, 50));
    await consoleCmd(token, 'buff clear');
  }

  // ---- 7) 不可打断：铁壁守护(1010, cancelOnMove=false)前摇期间移动仍结算 ----
  {
    await heal();
    evtCasting = null; evtSkill = null; evtCancel = null;
    send(encodeCastSkill(1010, 0, ref.x, ref.z));
    await wait(() => evtCasting, 2000);
    check('铁壁守护进入前摇', !!evtCasting);
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) { send(encodeInput(1, 1, 0, false, ref.x, 0, ref.z)); await sleep(100); }
    await wait(() => evtSkill || evtCancel, 2500);
    check('不可打断：移动不打断(无 EVT_SKILL_CANCEL)', evtCancel === null, evtCancel ? `cancel=${evtCancel.x}` : '');
    check('不可打断：前摇仍结算(EVT_SKILL)', !!evtSkill, evtSkill ? `skill=${evtSkill.b}` : '');
    send(encodeInput(2, 0, 0, false, ref.x, 0, ref.z));
    await sleep(300);
  }

  // ---- 8) 减防：破甲斩(1012, def -12)后怪物防御下降 ----
  {
    await heal();
    const f = await spawnFresh('skeleton');
    if (f) {
      const d0 = await monsterByWid(f.wid);
      const r = await castNoTarget(1012, f.wid);
      await wait(() => evtSkill, 1500);
      await sleep(300);
      const d1 = await monsterByWid(f.wid);
      check('减防：破甲斩后怪物防御下降', r.fb && r.fb.ok === 1 && d0 && d1 && d1.def < d0.def,
        r.fb && d0 && d1 ? `def ${d0.def} -> ${d1.def}` : `fb=${r.fb ? r.fb.ok : 'null'} d0=${JSON.stringify(d0)} d1=${JSON.stringify(d1)}`);
    } else check('减防：生成测试怪物', false);
  }

  // ---- 9) 减攻：虚弱咒印(1013, atk -8)后怪物攻击下降 ----
  {
    await heal();
    const f = await spawnFresh('wolf');
    if (f) {
      const a0 = await monsterByWid(f.wid);
      const r = await castNoTarget(1013, f.wid);
      await wait(() => evtSkill, 1500);
      await sleep(300);
      const a1 = await monsterByWid(f.wid);
      check('减攻：虚弱咒印后怪物攻击下降', r.fb && r.fb.ok === 1 && a0 && a1 && a1.atk < a0.atk,
        r.fb && a0 && a1 ? `atk ${a0.atk} -> ${a1.atk}` : `fb=${r.fb ? r.fb.ok : 'null'} a0=${JSON.stringify(a0)} a1=${JSON.stringify(a1)}`);
    } else check('减攻：生成测试怪物', false);
  }

  // ---- 复位测试标志（把服务端恢复为正常玩法，避免污染在线世界）----
  await consoleCmd(token, 'monsterpause off');
  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
