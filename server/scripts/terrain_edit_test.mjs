#!/usr/bin/env node
/**
 * terrain_edit_test.mjs - 地形编辑器（路径地图空洞 + 编辑层）端到端验证
 * 覆盖：
 *  1) 路径地图空洞：确定性 mask（主城/主干道可通行，远处空洞），JS 端多次一致
 *  2) 编辑层 JS 侧：setEditCell 后 terrainHeight/terrainBlocked 生效；序列化往返一致
 *  3) HTTP API：GET /api/terrain/edit 读取；POST 保存后回读一致（服务端持久化）
 *  4) 清理：POST 空编辑还原（不影响其他测试）
 * 需要服务端运行（无需 EW_DEBUG）。
 */
import {
  terrainHeight, terrainBlocked, terrainVoid, setEditCell, clearEdit,
  getEditCells, loadEditCells, editCellCount, WATER_LEVEL,
} from '../../client/js/terrain.js';
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
async function get(path) { const r = await fetch(BASE + path); return r.json(); }

async function main() {
  // ---- 1) 路径地图空洞（确定性 + 连通性） ----
  console.log('[1] 路径地图空洞 mask（确定性 / 主城+主干道可通行 / 远处空洞）');
  clearEdit();
  const pts = [
    [0, 0, false], [6, 6, false], [10, 40, true], [50, 50, true], [70, 0, true],
    [15, 0, false], [-30, 0, false], [90, -90, true],
  ];
  let determinOk = true;
  for (const [x, z, expectVoid] of pts) {
    const v = terrainVoid(x, z);
    if (v !== expectVoid) determinOk = false;
    if (terrainVoid(x, z) !== terrainVoid(x, z)) determinOk = false; // 两次一致
  }
  check('空洞 mask 确定性且符合预期（主城/干道可通行，远处空洞）', determinOk);
  // 主干道从主城出发均连通
  let roadOk = true;
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = Math.cos(a) * 6, z = Math.sin(a) * 6;
    if (terrainVoid(x, z)) roadOk = false;
  }
  check('6 条主干道从主城出发可通行（连通）', roadOk);

  // ---- 2) 编辑层 JS 侧 ----
  console.log('[2] 编辑层（JS 侧：高度/可通行覆盖 + 序列化往返）');
  clearEdit();
  const cx = 5, cz = 5;
  const hBase = terrainHeight(cx, cz);
  setEditCell(cx, cz, { h: hBase + 3 });
  check('抬高覆盖生效', Math.abs(terrainHeight(cx, cz) - (hBase + 3)) < 1e-9,
    `h ${hBase.toFixed(1)} -> ${terrainHeight(cx, cz).toFixed(1)}`);
  setEditCell(cx, cz, { v: 1 });
  check('挖空(void)覆盖生效', terrainBlocked(cx, cz) === true);
  setEditCell(cx, cz, { v: 0, h: Math.max(WATER_LEVEL + 1.5, hBase) });
  check('增加地区(fill)强制可通行', terrainBlocked(cx, cz) === false);
  // 序列化往返
  const cells1 = getEditCells();
  clearEdit();
  loadEditCells(cells1);
  check('序列化→加载往返一致', editCellCount() === 1 && terrainBlocked(cx, cz) === false);

  // ---- 3) HTTP API：保存 → 回读 ----
  console.log('[3] HTTP API：POST 保存 → GET 回读一致');
  const un = 'tred' + Date.now() % 100000;
  await post('/api/register', { username: un, password: 'pass1234' }).catch(() => {});
  const j = await post('/api/login', { username: un, password: 'pass1234' });
  check('登录成功', !!j.token);
  // 构造编辑层（在远郊安全坐标，避免影响出生点）：覆盖 4 个格
  const testCells = {};
  for (let i = 0; i < 4; i++) {
    const gx = -40 - i, gz = -40;
    testCells[`${gx},${gz}`] = { h: 6.5, v: 0 };
  }
  const save = await post('/api/terrain/edit', { token: j.token, cells: testCells });
  check('POST 保存编辑层', save.ok === true, `count=${save.count}`);
  const rd = await get('/api/terrain/edit');
  check('GET 回读编辑层', rd.ok === true && rd.count === 4, `count=${rd && rd.count}`);
  let backConsistent = rd.ok && rd.cells && rd.cells['-40,-40'] && rd.cells['-40,-40'].h === 6.5;
  check('回读内容一致（-40,-40 h=6.5 v=0）', backConsistent,
    JSON.stringify(rd.cells && rd.cells['-40,-40']));
  // 清理：还原（POST 空编辑）
  const reset = await post('/api/terrain/edit', { token: j.token, cells: {} });
  check('清理：POST 空编辑还原', reset.ok === true && reset.count === 0, `count=${reset && reset.count}`);

  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
