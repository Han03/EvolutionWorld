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
  getEditCells, loadEditCells, editCellCount, WATER_LEVEL, loadWalkMask, walkMaskReady,
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
  // ---- 0) 加载服务端下发的数据驱动可通行 mask ----
  const mj = await get('/api/terrain/mask');
  if (!loadWalkMask(mj)) { console.error('FATAL: 无法加载可通行 mask', JSON.stringify(mj)); process.exit(1); }

  // ---- 1) 可通行 mask（数据驱动：确定性 / 主城可通行 / 远角空洞） ----
  console.log('[1] 可通行 mask（数据驱动 / 主城中心可通行 / 远角空洞 / 确定性）');
  clearEdit();
  check('服务端已下发并加载可通行 mask', walkMaskReady() && mj.ok === true,
    `n=${mj.n} off=${mj.off}`);
  // 确定性：同格多次采样一致
  let determinOk = true;
  for (let x = -60; x <= 60; x += 7) for (let z = -60; z <= 60; z += 7) {
    if (terrainVoid(x + 0.5, z + 0.5) !== terrainVoid(x + 0.5, z + 0.5)) determinOk = false;
  }
  check('空洞 mask 确定性（同格多次一致）', determinOk);
  // 主城中心可通行
  check('主城中心 (0,0) 可通行', terrainVoid(0.5, 0.5) === false);
  // 主城圆盘内半径 6 环形采样可通行
  let cityOk = true;
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    if (terrainVoid(Math.cos(a) * 6 + 0.5, Math.sin(a) * 6 + 0.5)) cityOk = false;
  }
  check('主城圆盘内半径 6 环形采样可通行', cityOk);
  // 世界远角为空洞（连通区从主城向外有限生长）
  check('世界远角 (120,120) 为空洞', terrainVoid(120.5, 120.5) === true);

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
