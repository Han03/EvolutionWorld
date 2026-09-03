#!/usr/bin/env node
/**
 * gamedata_edit_test.mjs - 物品/生物配置系统 HTTP 接口 + 经验字段端到端验证
 * 覆盖本次新增能力（对应计划 t4/t6/t7）：
 *  1) GET /api/gamedata（公开只读）：ok + items(数组) + monsters(对象)，且含新 MMO 字段
 *     - 物品：rarity / levelReq
 *     - 生物：desc / expReward / moveSpeed
 *  2) POST /api/items/edit（鉴权）：无 token 被拒；改物品字段 → 回读一致
 *  3) POST /api/monsters/edit（鉴权）：改生物字段 → 回读一致（服务端内部热重载世界生物）
 *  4) 还原原始配置（避免把测试标记值留在 server/data/items.json、monsters.json）
 *  5) WS：新玩家初始 STATS 含 level=1 / exp=0 / expToNext=100（升级系统接线 + 协议扩展）
 * 服务端需在 localhost:3000 运行（register/login 公开；edit 接口需登录 token）
 */
import { parseS2C, MSG } from '../../client/js/protocol.js';
const BASE = 'http://localhost:3000';
const WS = 'ws://localhost:3000/ws';
const UN = 'gdtest' + Math.floor(Math.random() * 100000);
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, method, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  let j = null;
  try { j = await r.json(); } catch (_) { /* 忽略非 JSON */ }
  return { status: r.status, j };
}
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
  // 1) GET /api/gamedata（公开只读）+ 新 MMO 字段
  console.log('[1] GET /api/gamedata + 新字段校验');
  const g0 = await req('/api/gamedata', 'GET');
  check('GET /api/gamedata ok', g0.status === 200 && g0.j && g0.j.ok === true, `status=${g0.status}`);
  const items0 = (g0.j && g0.j.items) || [];
  const mons0 = (g0.j && g0.j.monsters) || {};
  check('items 为非空数组', Array.isArray(items0) && items0.length > 0, `n=${items0.length}`);
  check('monsters 为非空对象', mons0 && typeof mons0 === 'object' && !Array.isArray(mons0) && Object.keys(mons0).length > 0, `n=${Object.keys(mons0).length}`);

  const it1001 = items0.find((x) => x.id === 1001);
  const origName = it1001 ? it1001.name : '';
  check('物品含 rarity(数值)', it1001 && typeof it1001.rarity === 'number', it1001 ? `rarity=${it1001.rarity}` : 'no 1001');
  check('物品含 levelReq(数值)', it1001 && typeof it1001.levelReq === 'number', it1001 ? `levelReq=${it1001.levelReq}` : '');
  const wolf0 = mons0['wolf'];
  check('生物含 desc(字符串)', wolf0 && typeof wolf0.desc === 'string', wolf0 ? wolf0.desc : 'no wolf');
  check('生物含 expReward(数值)', wolf0 && typeof wolf0.expReward === 'number', wolf0 ? `expReward=${wolf0.expReward}` : '');
  check('生物含 moveSpeed(数值)', wolf0 && typeof wolf0.moveSpeed === 'number', wolf0 ? `moveSpeed=${wolf0.moveSpeed}` : '');
  const origExp = wolf0 ? wolf0.expReward : 0;

  // 2) 登录取 token；未鉴权应被拒
  console.log('[2] 鉴权');
  await req('/api/register', 'POST', { username: UN, password: 'pass1234' }).catch(() => {});
  const lg = await req('/api/login', 'POST', { username: UN, password: 'pass1234' });
  const token = lg.j && lg.j.token;
  check('登录取得 token', !!token);
  const noauth = await req('/api/items/edit', 'POST', { token: 'invalid-token-xxx', items: items0 });
  check('items/edit 无效 token 被拒(401)', noauth.status === 401 && noauth.j && noauth.j.ok === false, `status=${noauth.status}`);

  // 3) 改物品 → POST → 回读一致
  console.log('[3] POST /api/items/edit + 回读');
  const MARK = 'GDTEST_' + Date.now();
  const itemsMod = items0.map((x) => (x.id === 1001 ? { ...x, name: MARK, rarity: 3, levelReq: 7 } : x));
  const pe = await req('/api/items/edit', 'POST', { token, items: itemsMod });
  check('items/edit ok', pe.status === 200 && pe.j && pe.j.ok === true, `status=${pe.status} count=${pe.j && pe.j.count}`);
  const g1 = await req('/api/gamedata', 'GET');
  const it1001b = ((g1.j && g1.j.items) || []).find((x) => x.id === 1001);
  check('物品改动回读一致(name)', it1001b && it1001b.name === MARK, it1001b ? it1001b.name : '');
  check('物品改动回读一致(rarity=3)', it1001b && it1001b.rarity === 3, it1001b ? `rarity=${it1001b.rarity}` : '');
  check('物品改动回读一致(levelReq=7)', it1001b && it1001b.levelReq === 7, it1001b ? `levelReq=${it1001b.levelReq}` : '');

  // 4) 改生物 → POST → 回读一致（触发热重载）
  console.log('[4] POST /api/monsters/edit + 回读');
  const monsMod = { ...mons0 };
  monsMod['wolf'] = { ...mons0['wolf'], expReward: 999, moveSpeed: 2.5, desc: MARK };
  const pm = await req('/api/monsters/edit', 'POST', { token, monsters: monsMod });
  check('monsters/edit ok', pm.status === 200 && pm.j && pm.j.ok === true, `status=${pm.status} count=${pm.j && pm.j.count}`);
  const g2 = await req('/api/gamedata', 'GET');
  const wolfb = ((g2.j && g2.j.monsters) || {})['wolf'];
  check('生物改动回读一致(expReward=999)', wolfb && wolfb.expReward === 999, wolfb ? `expReward=${wolfb.expReward}` : '');
  check('生物改动回读一致(moveSpeed=2.5)', wolfb && Math.abs(wolfb.moveSpeed - 2.5) < 1e-6, wolfb ? `moveSpeed=${wolfb.moveSpeed}` : '');
  check('生物改动回读一致(desc)', wolfb && wolfb.desc === MARK, wolfb ? wolfb.desc : '');

  // 5) 还原原始配置（避免污染 data 目录）
  console.log('[5] 还原原始配置');
  await req('/api/items/edit', 'POST', { token, items: items0 });
  await req('/api/monsters/edit', 'POST', { token, monsters: mons0 });
  const g3 = await req('/api/gamedata', 'GET');
  const it1001c = ((g3.j && g3.j.items) || []).find((x) => x.id === 1001);
  const wolfc = ((g3.j && g3.j.monsters) || {})['wolf'];
  check('还原后物品名复原', it1001c && it1001c.name === origName, it1001c ? it1001c.name : '');
  check('还原后生物 expReward 复原', wolfc && wolfc.expReward === origExp, wolfc ? `expReward=${wolfc.expReward}` : '');

  // 6) WS：新玩家初始 STATS 含 level/exp/expToNext（协议扩展 + 升级系统接线）
  console.log('[6] WS 初始 STATS 经验字段');
  if (token) {
    const ws = new WebSocket(WS + '?token=' + token);
    ws.binaryType = 'arraybuffer';
    let stats = null;
    await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
    ws.onmessage = (ev) => {
      for (const f of decodeFrames(new Uint8Array(ev.data))) {
        try {
          const m = parseS2C(f.type, f.payload, 0, 0, 0);
          if (f.type === MSG.S2C_STATS) stats = m;
        } catch (_) { /* 忽略解码异常 */ }
      }
    };
    const t0 = Date.now();
    while (!stats && Date.now() - t0 < 4000) await sleep(80);
    check('收到 STATS 帧', !!stats);
    check('初始 level=1', stats && stats.level === 1, stats ? `level=${stats.level}` : '');
    check('初始 exp=0', stats && stats.exp === 0, stats ? `exp=${stats.exp}` : '');
    check('初始 expToNext=100', stats && stats.expToNext === 100, stats ? `expToNext=${stats.expToNext}` : '');
    try { ws.close(); } catch (_) { /* 忽略 */ }
  } else {
    check('收到 STATS 帧', false, '无 token，跳过 WS 校验');
  }

  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
