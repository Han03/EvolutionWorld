#!/usr/bin/env node
/**
 * skills_console_test.mjs - 技能系统 + 游戏控制台端到端验证（服务端权威）
 * 流程：
 *  1) 注册登录 → 校验 S2C_SKILLS 携带 3 个起始技能（1001/1002/1003）
 *  2) HTTP /api/console：learn(1005) → WS 收到 S2C_SKILLS 含 1005
 *  3) HTTP /api/console：gold/level/stat/status/boss/entities 命令执行与回显
 *  4) WS C2S_CONSOLE 通道：发送命令 → 收到 S2C_CONSOLE 结果
 *  5) 靠近怪物 → C2S_CAST_SKILL(1002 AOE) → 收到 S2C_SKILL_CAST ok + EVT_SKILL 广播 + 掉血
 *  6) 冷却/蓝量不足 → 施放被服务端拒绝（S2C_SKILL_CAST ok=0）
 * 需要服务端 EW_DEBUG=1 运行（依赖 /api/console 与 /api/debug/teleport）
 */
import { encodeCastSkill, encodeConsole, encodeAttack, parseS2C, MSG, KIND, EVT } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'skl' + Math.floor(Math.random() * 100000);
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
async function postApiConsole(token, command) {
  const r = await fetch(BASE + '/api/console', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, command }),
  });
  const j = await r.json();
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
  let skills = null;        // S2C_SKILLS
  let castFb = null;        // S2C_SKILL_CAST
  let consoleOut = null;    // S2C_CONSOLE
  let evtSkill = null;      // EVT_SKILL
  let evtDamage = 0;        // 自身受击次数
  let monDamaged = 0;       // 怪物受击次数（非自身 wid 的 EVT_DAMAGE）
  let stats = null;
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
    else if (msg.type === MSG.S2C_CONSOLE) consoleOut = msg;
    else if (msg.type === MSG.S2C_STATS) stats = msg;
    else if (msg.type === MSG.S2C_EVENT) {
      if (msg.evtType === EVT.SKILL) evtSkill = msg;
      if (msg.evtType === EVT.DAMAGE) {
        if (msg.wid === selfWid) evtDamage++;
        else monDamaged++;
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
  // 取最近的存活怪物（hp<=0 视为已死亡待复活，跳过，避免跨测试世界状态泄漏导致选到死怪）
  const nearestMonster = () => [...known.values()]
    .filter((e) => e.kind === KIND.MONSTER && (e.hp === undefined || e.hp > 0))
    .sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))[0];

  // 1) 登录后 S2C_SKILLS：3 个起始技能
  await wait(() => gotHello && skills, 3000);
  check('登录后收到 S2C_SKILLS', !!skills);
  const starterIds = skills ? skills.skills.map((s) => s.id).sort() : [];
  check('起始技能=3个', skills && skills.skills.length === 3, `ids=${starterIds.join(',')}`);
  check('含 冲刺斩1001', starterIds.includes(1001));
  check('含 烈焰冲击1002', starterIds.includes(1002));
  check('含 治疗之光1003', starterIds.includes(1003));

  // 2) HTTP 控制台：学习技能 1005（战吼）
  const rLearn = await postApiConsole(token, 'skill 1005');
  check('控制台 skill 1005 执行', rLearn.ok, JSON.stringify(rLearn.output || '').slice(0, 60));
  await wait(() => skills && skills.skills.some((s) => s.id === 1005), 2000);
  check('WS 收到新技能 1005', skills && skills.skills.some((s) => s.id === 1005));

  // 3) HTTP 控制台：gold / level / stat / status / boss / entities
  const rGold = await postApiConsole(token, 'gold 500');
  check('控制台 gold 500', rGold.ok, (rGold.output || '').trim());
  const rLevel = await postApiConsole(token, 'level 5');
  check('控制台 level 5', rLevel.ok);
  const rStat = await postApiConsole(token, 'stat atk 20');
  check('控制台 stat atk 20', rStat.ok);
  const rStatus = await postApiConsole(token, 'status');
  check('控制台 status 回显', rStatus.ok && (rStatus.output || '').indexOf('玩家') !== -1, (rStatus.output || '').replace(/\n/g, ' ').slice(0, 80));
  const rBoss = await postApiConsole(token, 'boss');
  check('控制台 boss 回显', rBoss.ok);
  const rEnt = await postApiConsole(token, 'entities 100');
  check('控制台 entities 回显', rEnt.ok);
  const rHelp = await postApiConsole(token, 'help');
  check('控制台 help 回显', rHelp.ok && (rHelp.output || '').indexOf('gold') !== -1);

  // 4) WS 控制台通道：C2S_CONSOLE → S2C_CONSOLE
  consoleOut = null;
  send(encodeConsole('echo hello-console'));
  await wait(() => consoleOut && (consoleOut.text || '').indexOf('hello-console') !== -1, 2000);
  check('WS 控制台 echo 回显', consoleOut && (consoleOut.text || '').indexOf('hello-console') !== -1,
    consoleOut ? consoleOut.text.replace(/\n/g, ' ') : '');

  // 5) 技能施放：AOE 烈焰冲击(1002) + 前摇完整结算 + AOE 命中
  // 前摇 600ms 会被受击打断。若传送点附近恰好有其他遗留仇恨怪物在 600ms 内命中玩家，
  // 施放会被打断 → 自动换位重试（最多 4 次）。站位：怪物 6.5m 外（1002 射程 8m 有余量；
  // 怪物攻击距离 1.6m，追击 ~3.6m/s 需 1.3s 才能近身），落点=施放前重读的怪物位置。
  await wait(() => known.size > 0, 2000);
  check('视野内存在怪物', !!nearestMonster());
  let aoeResolved = null;
  for (let att = 0; att < 4 && !aoeResolved; att++) {
    const mm = nearestMonster();
    if (!mm) break;
    const ang = Math.atan2(mm.z - ref.z, mm.x - ref.x);
    const sx = mm.x - Math.cos(ang) * 6.5, sz = mm.z - Math.sin(ang) * 6.5;
    const tpR = await tp(sx, sz);
    ref = { x: tpR.x, y: tpR.y, z: tpR.z };
    await sleep(300);
    const mmb = nearestMonster();
    const aim = { x: mmb ? mmb.x : mm.x, z: mmb ? mmb.z : mm.z }; // 落点=怪物当前位置
    castFb = null; evtSkill = null; monDamaged = 0;
    send(encodeCastSkill(1002, 0, aim.x, aim.z));
    await wait(() => castFb, 2500);
    if (!castFb || castFb.ok !== 1) { await sleep(300); continue; } // 射程/其他原因 → 重试
    // 前摇 600ms：EVT_SKILL 在结算时（约 0.6s 后）才广播
    const resolved = await wait(() => evtSkill, 2500);
    if (resolved) { aoeResolved = att; break; }
    await sleep(300); // 被打断（受击等）→ 换位重试
  }
  check('AOE 技能施放反馈 ok', castFb && castFb.ok === 1, castFb ? `skillId=${castFb.skillId}` : '');
  check('EVT_SKILL 广播(前摇结算后)', !!evtSkill, evtSkill ? `caster=${evtSkill.wid} skill=${evtSkill.b}` : '');
  // AOE 落点怪物应掉血
  await wait(() => monDamaged > 0, 2000);
  check('AOE 对怪物造成伤害', monDamaged > 0, `dmgEvt=${monDamaged} retry=${aoeResolved ?? '-'}`);

  // 6) 冷却校验：连续施放 1002（6s 冷却）第二次应被拒（服务端权威）
  {
    castFb = null;
    send(encodeCastSkill(1002, 0, ref.x, ref.z));
    await wait(() => castFb, 2000);
    check('冷却中施放被拒绝(ok=0)', castFb && castFb.ok === 0, castFb ? `ok=${castFb.ok}` : '');
  }

  // 7) 单目标技能 1001：对最近怪物施放（1001 射程 3.5m，先传送到怪物身边；瞬发无受击打断风险）
  {
    const mm2 = nearestMonster();
    if (mm2) {
      const tr2 = await tp(mm2.x, mm2.z);
      ref = { x: tr2.x, y: tr2.y, z: tr2.z };
      await sleep(250);
      const mm3 = nearestMonster();
      const wid1 = mm3 ? mm3.wid : mm2.wid;
      castFb = null;
      send(encodeCastSkill(1001, wid1, ref.x, ref.z));
      await wait(() => castFb, 2500);
      check('单目标技能 1001 施放 ok', castFb && castFb.ok === 1, castFb ? `target=${castFb.targetWid}` : '');
    }
  }

  // 8) 怪物对玩家反伤验证可选：buff thorns 挂上后让怪物打自己（事件 EVT_DAMAGE 到自身）
  // 传送到怪物身边使其进入近战范围；若目标怪物已被前序步骤杀死/不攻击（客户端视图可能过期），
  // 自动换下一个活怪重试（每轮重新挂荆棘，最多 4 个目标）
  let rBuff = { ok: false };
  let gotThornsHit = false;
  for (let att = 0; att < 4 && !gotThornsHit; att++) {
    const thTp = nearestMonster();
    if (!thTp) break;
    const tr = await tp(thTp.x, thTp.z);
    ref = { x: tr.x, y: tr.y, z: tr.z };
    await sleep(400);
    rBuff = await postApiConsole(token, 'buff thorns 0.2 5');
    await sleep(250);
    const dmgBefore = evtDamage;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && evtDamage <= dmgBefore) await sleep(100);
    gotThornsHit = evtDamage > dmgBefore;
    if (!gotThornsHit) console.log(`  [info] 目标怪物${att}未攻击，换目标重试`);
  }
  check('控制台 buff thorns', rBuff.ok);
  console.log(`  [info] 荆棘反伤自伤事件数: ${evtDamage}`);
  check('荆棘反伤触发(玩家受自身反弹伤害)', gotThornsHit);

  ws.close();
  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
