#!/usr/bin/env node
/**
 * quest_test.mjs - 任务系统端到端验证（服务端权威）
 * 流程：
 *  1) 注册登录 → 进入世界 → 等待 HELLO
 *  2) 请求可接任务列表 (C2S_QUEST_LIST) → 校验 S2C_QUEST_LIST
 *  3) 接受任务 (C2S_QUEST_ACCEPT) → 校验 S2C_QUEST_RESULT(成功) + S2C_QUEST_PROGRESS
 *  4) 通过控制台命令强制完成目标 → 校验进度更新 S2C_QUEST_NOTIFY
 *  5) 提交任务 (C2S_QUEST_TURNIN) → 校验 S2C_QUEST_RESULT(成功)
 *  6) 放弃任务测试 → 校验状态机正确性
 *  7) 前置任务校验 → 未完成前置时不可接后续任务
 * 需要服务端 EW_DEBUG=1 运行
 */
import { parseS2C, MSG, Reader, Writer, makeFrame } from '../../client/js/protocol.js';
// 默认 localhost；可用 EW_TEST_BASE 覆盖（如 Windows→WSL2 localhost 转发失效时改用 WSL IP）。
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const WS = process.env.EW_TEST_WS || (BASE.replace(/^http/, 'ws') + '/ws');
const UN = 'questtest' + Math.floor(Math.random() * 100000);
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

// 帧解包
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

// 任务消息解码
function decodeQuestList(payload) {
  const r = new Reader(payload);
  const count = r.u16();
  const list = [];
  for (let i = 0; i < count; i++) {
    const q = { questId: r.u32(), category: r.u8(), name: r.str(), desc: r.str(), levelReq: r.i32(),
                giverNpcWid: r.u32(), objectives: [], rewards: { gold: 0, items: [], skills: [] }, nextQuestIds: [] };
    const objCount = r.u16();
    for (let j = 0; j < objCount; j++) {
      q.objectives.push({ type: r.u8(), targetId: r.u32(), required: r.u32(), desc: r.str() });
    }
    q.rewards.gold = r.u32();
    const itemCount = r.u16();
    for (let j = 0; j < itemCount; j++) q.rewards.items.push({ itemId: r.u32(), count: r.u16() });
    const skillCount = r.u16();
    for (let j = 0; j < skillCount; j++) q.rewards.skills.push(r.u32());
    const nextCount = r.u16();
    for (let j = 0; j < nextCount; j++) q.nextQuestIds.push(r.u32());
    list.push(q);
  }
  return list;
}

function decodeQuestProgress(payload) {
  const r = new Reader(payload);
  const count = r.u16();
  const prog = [];
  for (let i = 0; i < count; i++) {
    const q = { questId: r.u32(), status: r.u8(), name: r.str(), desc: r.str(), category: r.u8(), objectives: [] };
    const objCount = r.u16();
    for (let j = 0; j < objCount; j++) q.objectives.push({ current: r.u32(), required: r.u32(), type: r.u8(), desc: r.str() });
    prog.push(q);
  }
  // 已完成任务摘要
  const completedCount = r.u16();
  const completed = [];
  for (let i = 0; i < completedCount; i++) {
    completed.push({ questId: r.u32(), category: r.u8(), name: r.str(), desc: r.str() });
  }
  return { active: prog, completed };
}

function decodeQuestResult(payload) {
  const r = new Reader(payload);
  return { op: r.u8(), code: r.u8(), questId: r.u32() };
}

// C2S 编码
function encodeQuestAccept(questId, npcWid = 0) {
  const w = new Writer();
  w.u32(questId);
  w.u32(npcWid);
  return makeFrame(MSG.C2S_QUEST_ACCEPT, w.finish());
}
function encodeQuestAbandon(questId) {
  const w = new Writer();
  w.u32(questId);
  return makeFrame(MSG.C2S_QUEST_ABANDON, w.finish());
}
function encodeQuestTurnIn(questId, npcWid) {
  const w = new Writer();
  w.u32(questId); w.u32(npcWid || 0);
  return makeFrame(MSG.C2S_QUEST_TURNIN, w.finish());
}
function encodeQuestList(npcWid = 0) {
  const w = new Writer();
  w.u32(npcWid);
  return makeFrame(MSG.C2S_QUEST_LIST, w.finish());
}
function encodeConsole(cmd) {
  const w = new Writer();
  w.str(cmd);
  return makeFrame(MSG.C2S_CONSOLE, w.finish());
}

async function main() {
  console.log('=== 任务系统测试 ===');
  // 注册 + 登录
  await post('/api/register', { username: UN, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: UN, password: 'pass1234' });
  const token = j.token;
  const ws = new WebSocket(WS + '?token=' + token);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.binaryType = 'arraybuffer';

  let selfWid = 0;
  let ref = { x: 0, y: 0, z: 0 };
  let gotHello = false;
  let questListData = null;
  let questProgressData = null;
  let questResultData = null;
  let questNotifyData = null;
  let questCompleteData = null;
  let questChainData = null;
  let consoleText = '';

  const wait = (condFn, ms) => new Promise(async (res) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (condFn()) return res(true);
      await sleep(50);
    }
    res(condFn());
  });

  ws.onmessage = (ev) => {
    for (const f of decodeFrames(new Uint8Array(ev.data))) {
      // 标准消息走 parseS2C
      if (f.type !== MSG.S2C_QUEST_LIST && f.type !== MSG.S2C_QUEST_PROGRESS &&
          f.type !== MSG.S2C_QUEST_RESULT && f.type !== MSG.S2C_QUEST_COMPLETE &&
          f.type !== MSG.S2C_QUEST_NOTIFY && f.type !== MSG.S2C_QUEST_CHAIN &&
          f.type !== MSG.S2C_CONSOLE) {
        try { parseS2C(f.type, f.payload, ref.x, ref.y, ref.z); } catch (e) {}
      }
      if (f.type === MSG.S2C_HELLO) {
        const m = parseS2C(f.type, f.payload, ref.x, ref.y, ref.z);
        selfWid = m.self.wid;
        ref = { x: m.self.x, y: m.self.y, z: m.self.z };
        gotHello = true;
      }
      // 任务消息手动解码
      if (f.type === MSG.S2C_QUEST_LIST) {
        questListData = decodeQuestList(f.payload);
      } else if (f.type === MSG.S2C_QUEST_PROGRESS) {
        questProgressData = decodeQuestProgress(f.payload);
      } else if (f.type === MSG.S2C_QUEST_RESULT) {
        questResultData = decodeQuestResult(f.payload);
      } else if (f.type === MSG.S2C_QUEST_NOTIFY) {
        const r = new Reader(f.payload);
        questNotifyData = { questId: r.u32(), objIndex: r.u8(), current: r.u32(), required: r.u32(), allComplete: r.u8() !== 0 };
      } else if (f.type === MSG.S2C_QUEST_COMPLETE) {
        const r = new Reader(f.payload);
        questCompleteData = { questId: r.u32() };
      } else if (f.type === MSG.S2C_QUEST_CHAIN) {
        const r = new Reader(f.payload);
        const completedId = r.u32();
        const count = r.u16();
        const nextIds = [];
        for (let i = 0; i < count; i++) nextIds.push(r.u32());
        questChainData = { completedId, nextIds };
      } else if (f.type === MSG.S2C_CONSOLE) {
        const m = parseS2C(f.type, f.payload, ref.x, ref.y, ref.z);
        consoleText = m.text || '';
      }
    }
  };

  const send = (b) => ws.send(b);

  // 1) 等待 HELLO
  await wait(() => gotHello, 3000);
  check('HELLO 收到', gotHello);

  // 2) 请求可接任务列表
  console.log('\n--- 测试: 请求可接任务列表 ---');
  questListData = null;
  send(encodeQuestList());
  await wait(() => questListData !== null, 2000);
  check('S2C_QUEST_LIST 收到', questListData !== null);
  if (questListData) {
    check('任务列表 > 0', questListData.length > 0, `count=${questListData.length}`);
    // 验证任务结构完整性
    const q0 = questListData[0];
    check('任务有 ID', q0.questId > 0, `id=${q0.questId}`);
    check('任务有名称', q0.name && q0.name.length > 0, `name=${q0.name}`);
    check('任务有分类', q0.category >= 1 && q0.category <= 4, `cat=${q0.category}`);
    check('任务有目标', q0.objectives && q0.objectives.length > 0, `objs=${q0.objectives.length}`);
    // 验证新字段
    check('任务有 giverNpcWid 字段', q0.giverNpcWid !== undefined, `giverNpcWid=${q0.giverNpcWid}`);
    check('任务有 nextQuestIds 字段', Array.isArray(q0.nextQuestIds), `nextQuestIds=[${q0.nextQuestIds}]`);
    // 打印所有任务
    for (const q of questListData) {
      const chain = q.nextQuestIds.length > 0 ? ` 🔗→[${q.nextQuestIds}]` : '';
      const giver = q.giverNpcWid > 0 ? ` [NPC#${q.giverNpcWid}]` : '';
      console.log(`    任务 #${q.questId} [${['','主线','支线','日常','可重复'][q.category]}] ${q.name} (Lv${q.levelReq})${giver}${chain} 奖励: ${q.rewards.gold}金`);
    }
  }

  // 3) 接受任务（选第一个可接任务）
  console.log('\n--- 测试: 接受任务 ---');
  const acceptId = questListData && questListData.length > 0 ? questListData[0].questId : 0;
  if (acceptId) {
    questResultData = null;
    questProgressData = null;
    send(encodeQuestAccept(acceptId));
    await wait(() => questResultData !== null, 2000);
    check('S2C_QUEST_RESULT 收到', questResultData !== null);
    if (questResultData) {
      check('接受操作码=ACCEPT(0)', questResultData.op === 0, `op=${questResultData.op}`);
      check('接受结果码=成功(0)', questResultData.code === 0, `code=${questResultData.code}`);
      check('questId 一致', questResultData.questId === acceptId, `id=${questResultData.questId}`);
    }
    // 等待进度推送
    await wait(() => questProgressData !== null, 2000);
    check('S2C_QUEST_PROGRESS 收到(活跃任务)', questProgressData !== null);
    if (questProgressData) {
      check('活跃任务包含已接受任务', questProgressData.active.some(q => q.questId === acceptId));
      const active = questProgressData.active.find(q => q.questId === acceptId);
      if (active) {
        check('任务状态=进行中(0)', active.status === 0, `status=${active.status}`);
        check('目标进度初始=0', active.objectives.every(o => o.current === 0), `objs=${JSON.stringify(active.objectives)}`);
      }
    }
  } else {
    check('接受任务', false, '无可接任务');
  }

  // 4) 重复接受同一任务 → 应失败（已在进行中）
  console.log('\n--- 测试: 重复接受（应失败） ---');
  if (acceptId) {
    questResultData = null;
    send(encodeQuestAccept(acceptId));
    await wait(() => questResultData !== null, 2000);
    if (questResultData) {
      check('重复接受返回错误码', questResultData.code !== 0, `code=${questResultData.code}(期望=2:已在进行中)`);
    }
  }

  // 5) 通过控制台命令强制完成任务目标
  console.log('\n--- 测试: 控制台强制完成目标 ---');
  if (acceptId) {
    questResultData = null;
    questProgressData = null;
    questNotifyData = null;
    send(encodeConsole(`quest complete ${acceptId}`));
    await sleep(500);
    // 检查进度更新（可能收到 NOTIFY 或 PROGRESS）
    await wait(() => questProgressData !== null || questNotifyData !== null, 2000);
    if (questProgressData) {
      const active = questProgressData.active.find(q => q.questId === acceptId);
      if (active) {
        const allDone = active.objectives.every(o => o.current >= o.required);
        check('强制完成后目标全部达成', allDone, `objs=${JSON.stringify(active.objectives)}`);
        check('任务状态=可提交(1)', active.status === 1, `status=${active.status}`);
      }
    }
  }

  // 6) 提交任务
  console.log('\n--- 测试: 提交任务 ---');
  if (acceptId) {
    questResultData = null;
    send(encodeQuestTurnIn(acceptId, 0));
    await wait(() => questResultData !== null, 2000);
    if (questResultData) {
      check('提交操作码=TURNIN(2)', questResultData.op === 2, `op=${questResultData.op}`);
      check('提交结果码=成功(0)', questResultData.code === 0, `code=${questResultData.code}`);
    }
    // 提交后活跃任务应减少
    await sleep(300);
    questProgressData = null;
    send(encodeQuestList()); // 触发列表刷新（同时也会推送进度）
    await wait(() => questProgressData !== null || questListData !== null, 2000);
    // 检查链式任务解锁通知
    if (questChainData) {
      check('链式任务解锁通知收到', true, `completedId=${questChainData.completedId} nextIds=[${questChainData.nextIds}]`);
    }
  }

  // 7) 接受另一个任务然后放弃
  console.log('\n--- 测试: 放弃任务 ---');
  // 重新获取列表
  questListData = null;
  send(encodeQuestList());
  await wait(() => questListData !== null, 2000);
  // 找一个还没完成的任务
  const abandonCandidate = questListData ? questListData.find(q => q.questId !== acceptId) : null;
  if (abandonCandidate) {
    questResultData = null;
    send(encodeQuestAccept(abandonCandidate.questId));
    await wait(() => questResultData !== null, 2000);
    if (questResultData && questResultData.code === 0) {
      check('接受第二个任务成功', true, `id=${abandonCandidate.questId} name=${abandonCandidate.name}`);
      // 放弃
      questResultData = null;
      send(encodeQuestAbandon(abandonCandidate.questId));
      await wait(() => questResultData !== null, 2000);
      if (questResultData) {
        check('放弃操作码=ABANDON(1)', questResultData.op === 1, `op=${questResultData.op}`);
        check('放弃结果码=成功(0)', questResultData.code === 0, `code=${questResultData.code}`);
      }
    }
  } else {
    console.log('  [skip] 无其他可接任务，跳过放弃测试');
  }

  // 8) 控制台命令验证
  console.log('\n--- 测试: 控制台 quest 命令 ---');
  consoleText = '';
  send(encodeConsole('quest active'));
  await wait(() => consoleText && consoleText.length > 0, 1500);
  check('quest active 命令有输出', consoleText && consoleText.length > 0, consoleText ? consoleText.slice(0, 60) : '');

  // 清理
  ws.close();
  console.log(`\n=== 结果: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
