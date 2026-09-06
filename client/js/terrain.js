// terrain.js - 高度场地形数据（确定性噪声，与 C++ 服务端 terrain.cpp 逐位一致）
// 供客户端预测（predict.js）、地形网格渲染、水面/河流对齐使用。
// 地形要素：基础丘陵
//         + 路径地图空洞（可到达区域收缩为走廊+空地）+ 地形编辑器编辑层（覆盖）。
// 原 SDF 体积地形（光线步进）已移除，本模块即世界地图的数据源。
// ---- 地形种子偏移：使噪声地形随 seed 变化（与服务端 terrain.cpp 一致） ----
let _seedOff = 0;
/** 设置地形种子偏移（客户端加载 mask 时随 seedOffset 字段调用） */
export function setTerrainSeedOffset(v) { _seedOff = v | 0; }
function _imul32(a, b) {
  // Math.imul 语义
  return Math.imul(a, b);
}
/** 整数坐标哈希 -> [0,1) */
export function hash2i(x, z) {
  const sx = (_seedOff ^ 0xa5a5a5a5) | 0;
  let hx = _imul32(((x + sx) ^ 0x9e3779b9) | 0, 0x85ebca6b) >>> 0;
  let hz = _imul32(((z + sx) ^ 0xc2b2ae3d) | 0, 0x27d4eb2f) >>> 0;
  let h = (hx ^ hz) >>> 0;
  h = _imul32((h ^ (h >>> 16)) >>> 0, 0x45d9f3b) >>> 0;
  h = _imul32((h ^ (h >>> 16)) >>> 0, 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
/** 2D value noise */
export function noise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2i(ix, iz);
  const b = hash2i(ix + 1, iz);
  const c = hash2i(ix, iz + 1);
  const d = hash2i(ix + 1, iz + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
/** fbm 分形叠加 */
export function fbm2(x, z, octaves = 5) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}
// ==================== 地形缓存（0.1m 量化，仅供视觉/诊断路径） ====================
// 缓存键量化到 0.1m，但存入的是「首个落进该桶的精确点」的结果：桶边界在 n±0.05，
// 而 terrainVoid 的判据 Math.floor(x) 边界正好落在整数 n 上（即桶的正中央），
// 于是每条 mask 边界两侧都存在一条 ±0.05m 的粘性误差带，且缓存从不逐帧清理 →
// 误差永久固化。因此：
//   · 视觉/诊断路径（小地图、编辑器、渲染层贴地）用缓存版，0.05m 误差不可见，性能优先；
//   · 玩家物理/碰撞路径必须用下方 *Exact 全精度版，与服务端 double 计算逐位一致，
//     否则地形边界处「客户端放行、服务端拒绝」→ terrain_blocked 回退。
let _tCache = new Map();
let _bCache = new Map();
const CACHE_MAX = 131072;   // 桶数上限：超限整体清空，防无界增长（缓存永不逐帧清理）
function _tKey(x, z) { return ((Math.round(x * 10)) * 10007 + Math.round(z * 10)); }
/** 清除地形缓存（编辑操作/mask 重载后调用） */
export function invalidateTerrainCache() { _tCache.clear(); _bCache.clear(); }

// ==================== 可通行 mask（数据驱动：服务端下发，不再程序化生成） ====================
// 服务端世界初始化执行器生成连通可通行 mask（1=可通行/0=空洞），通过 /api/terrain/mask 下发。
// 客户端下载后安装，保证预测/碰撞/渲染与服务端同源一致；未加载时一律视为空洞（阻挡）。
let MASK_N = 0;
let MASK_OFF = 0;
let g_walk = null; // Uint8Array 1=可通行
/** 安装服务端下发的可通行 mask：{n, off, b64}（b64 为 n*n 字节 mask 的 base64） */
export function loadWalkMask({ n, off, b64, seedOffset } = {}) {
  if (!b64 || !n) return false;
  let bin;
  try { bin = atob(b64); } catch (_) { return false; }
  if (bin.length !== n * n) return false;
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  g_walk = arr;
  MASK_N = n;
  MASK_OFF = off | 0;
  // 种子偏移：使地形高度场随 seed 变化（与服务端 terrain.cpp 一致）
  if (seedOffset !== undefined) setTerrainSeedOffset(seedOffset);
  invalidateTerrainCache();
  invalidateIslands();
  return true;
}
/** mask 是否已加载就绪 */
export function walkMaskReady() { return !!g_walk; }
/** mask 边长（格） */
export function walkMaskN() { return MASK_N; }
/** mask 原点偏移（世界坐标从 -off 开始） */
export function walkMaskOff() { return MASK_OFF; }
/** 该点是否可通行 mask 空洞（服务端下发数据；未加载时一律视为空洞/阻挡） */
export function terrainVoid(x, z) {
  if (!g_walk) return true;
  const gx = Math.floor(x) + MASK_OFF;
  const gz = Math.floor(z) + MASK_OFF;
  if (gx < 0 || gx >= MASK_N || gz < 0 || gz >= MASK_N) return true;
  return g_walk[gz * MASK_N + gx] === 0;
}

// ==================== 岛屿识别（连通分量 + 纪念碑谷配色） ====================
let _islandMap = null;   // Uint8Array: mask 索引 -> 岛屿 ID (1-based, 0=空洞)
let _islandCount = 0;

/** 重建岛屿映射：对 walkable mask 做 4-连通 flood fill */
function _rebuildIslands() {
  if (!g_walk || MASK_N <= 0) { _islandMap = null; _islandCount = 0; return; }
  const n = MASK_N;
  const map = new Uint8Array(n * n);
  let id = 0;
  for (let i = 0; i < n * n; i++) {
    if (g_walk[i] === 0 || map[i] !== 0) continue;
    id++;
    const stack = [i];
    map[i] = id;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % n, cz = (cur / n) | 0;
      if (cx > 0)        { const ni = cur - 1;     if (g_walk[ni] && !map[ni]) { map[ni] = id; stack.push(ni); } }
      if (cx < n - 1)    { const ni = cur + 1;     if (g_walk[ni] && !map[ni]) { map[ni] = id; stack.push(ni); } }
      if (cz > 0)        { const ni = cur - n;     if (g_walk[ni] && !map[ni]) { map[ni] = id; stack.push(ni); } }
      if (cz < n - 1)    { const ni = cur + n;     if (g_walk[ni] && !map[ni]) { map[ni] = id; stack.push(ni); } }
    }
  }
  _islandMap = map;
  _islandCount = id;
}

/** 确保岛屿映射已计算（懒初始化） */
function _ensureIslands() { if (!_islandMap && g_walk) _rebuildIslands(); }

/** 世界坐标 -> 岛屿 ID（0 = 空洞/未加载） */
export function getIslandId(wx, wz) {
  _ensureIslands();
  if (!_islandMap) return 0;
  const gx = Math.floor(wx) + MASK_OFF;
  const gz = Math.floor(wz) + MASK_OFF;
  if (gx < 0 || gx >= MASK_N || gz < 0 || gz >= MASK_N) return 0;
  return _islandMap[gz * MASK_N + gx];
}

/** 岛屿总数（含 flood fill 后的连通分量） */
export function islandCount() { _ensureIslands(); return _islandCount; }

/** 失效岛屿映射（mask/编辑层变更时调用） */
export function invalidateIslands() { _islandMap = null; }

// 暗色 MMORPG 风格配色：深沉温暖，每座岛屿一种颜色
export const ISLAND_COLORS = [
  { r: 0.55, g: 0.35, b: 0.28 },  // 赤陶土
  { r: 0.38, g: 0.50, b: 0.35 },  // 苔藓绿
  { r: 0.40, g: 0.45, b: 0.55 },  // 岩灰蓝
  { r: 0.60, g: 0.48, b: 0.28 },  // 琥珀金
  { r: 0.50, g: 0.35, b: 0.48 },  // 暮光紫
  { r: 0.52, g: 0.52, b: 0.35 },  // 橄榄黄
  { r: 0.32, g: 0.50, b: 0.50 },  // 深湖青
  { r: 0.58, g: 0.40, b: 0.30 },  // 焦茶橙
  { r: 0.42, g: 0.52, b: 0.38 },  // 灰苔绿
  { r: 0.48, g: 0.38, b: 0.52 },  // 石楠紫
  { r: 0.38, g: 0.48, b: 0.45 },  // 松石绿
  { r: 0.55, g: 0.42, b: 0.32 },  // 暖棕褐
];

/** 岛屿 ID -> 配色（循环复用） */
export function getIslandColor(id) {
  if (id <= 0) return { r: 0.8, g: 0.8, b: 0.8 };
  return ISLAND_COLORS[(id - 1) % ISLAND_COLORS.length];
}

// ==================== 地形编辑器编辑层（稀疏格子覆盖，与服务端一致） ====================
// key："x,z" 字符串；cell: {h?, v?}（h=绝对高度覆盖，v=可通行覆盖 1=空洞 0=强制可通行）
const editMap = new Map();
function editKey(x, z) { return Math.floor(x) + ',' + Math.floor(z); }
/** 编辑器/运行时：设置或擦除（传空对象即擦除）某格编辑 */
export function setEditCell(x, z, { h, v } = {}) {
  const k = editKey(x, z);
  const hasH = h !== undefined, hasV = v !== undefined;
  if (!hasH && !hasV) { editMap.delete(k); invalidateTerrainCache(); invalidateIslands(); return; }
  const c = {};
  if (hasH) c.h = h;
  if (hasV) c.v = v;
  editMap.set(k, c);
  invalidateTerrainCache();
  invalidateIslands();
}
export function eraseEditCell(x, z) { editMap.delete(editKey(x, z)); invalidateTerrainCache(); invalidateIslands(); }
export function clearEdit() { editMap.clear(); invalidateTerrainCache(); invalidateIslands(); }
export function editCellCount() { return editMap.size; }
/** 序列化为服务端一致格式 {cells: {"x,z": {h?, v?}}} */
export function getEditCells() {
  const cells = {};
  for (const [k, c] of editMap) cells[k] = c;
  return cells;
}
/** 从服务端/编辑器数据加载 {cells: {...}} */
export function loadEditCells(cells) {
  editMap.clear();
  if (!cells) return;
  for (const [k, c] of Object.entries(cells)) {
    const cell = {};
    if (c && c.h !== undefined) cell.h = c.h;
    if (c && c.v !== undefined) cell.v = c.v;
    if (cell.h !== undefined || cell.v !== undefined) editMap.set(k, cell);
  }
  invalidateTerrainCache();
  invalidateIslands();
}

/** 地形高度（世界坐标 xz -> y），带 0.1m 缓存 —— 仅供渲染/诊断路径使用 */
export function terrainHeight(x, z) {
  const k = _tKey(x, z);
  if (_tCache.has(k)) return _tCache.get(k);
  const h = terrainHeightExact(x, z);
  if (_tCache.size >= CACHE_MAX) _tCache.clear();
  _tCache.set(k, h);
  return h;
}
/** 地形高度（全精度、无缓存），与服务端 terrainHeight 逐位一致（含编辑层覆盖）。
 *  物理/碰撞路径专用：Y 轴坡度是 terrainBlocked 的判据之一，缓存量化会让悬崖判定漂移。 */
export function terrainHeightExact(x, z) {
  // 编辑器编辑层优先：绝对高度覆盖
  const ec = editMap.get(editKey(x, z));
  if (ec && ec.h !== undefined) return ec.h;
  const base = fbm2(x * 0.006, z * 0.006, 5);
  const detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5;
  let h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  return Math.max(-12.0, Math.min(34.0, h));
}
/** 水面高度（与服务端 kWaterLevel 一致，地表低于该值形成湖泊） */
export const WATER_LEVEL = -2.0;
/** 悬崖判定坡度（与服务端 kCliffSlope 一致） */
export const CLIFF_SLOPE = 1.30;
/** 该点最大局部坡度（Δh/Δd），带 0.1m 缓存 —— 仅供渲染/诊断路径使用 */
export function terrainSlope(x, z) {
  const e = 0.5;
  const hx = terrainHeight(x + e, z);
  const hxm = terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e);
  const hzm = terrainHeight(x, z - e);
  return Math.max(Math.abs(hx - hxm) / (2 * e), Math.abs(hz - hzm) / (2 * e));
}
/** 该点最大局部坡度（全精度、无缓存），与服务端 terrainSlope 逐位一致 */
export function terrainSlopeExact(x, z) {
  const e = 0.5;
  const hx = terrainHeightExact(x + e, z);
  const hxm = terrainHeightExact(x - e, z);
  const hz = terrainHeightExact(x, z + e);
  const hzm = terrainHeightExact(x, z - e);
  return Math.max(Math.abs(hx - hxm) / (2 * e), Math.abs(hz - hzm) / (2 * e));
}
/** 该点是否不可通行（带 0.1m 缓存）：空洞 / 深水 / 悬崖陡坡 —— 仅供视觉/诊断路径使用 */
export function terrainBlocked(x, z) {
  const k = _tKey(x, z);
  if (_bCache.has(k)) return _bCache.get(k);
  const r = terrainBlockedExact(x, z);
  if (_bCache.size >= CACHE_MAX) _bCache.clear();
  _bCache.set(k, r);
  return r;
}
/** 该点是否不可通行（全精度、无缓存），与服务端 terrainBlocked 逐位一致。
 *  玩家物理碰撞路径（predict.js circleBlocked）必须用本版本。
 *  可通行性完全由 mask + 编辑层决定，不再叠加水深/坡度判定。 */
export function terrainBlockedExact(x, z) {
  // 编辑器编辑层优先：可通行性覆盖
  const ec = editMap.get(editKey(x, z));
  if (ec && ec.v !== undefined) return ec.v === 1;
  // 路径地图空洞：mask 是唯一阻挡源
  return terrainVoid(x, z);
}
/** 网格地形分块参数（客户端渲染用，与服务端 AOI 无关） */
export const TERRAIN_CHUNK = 25;      // 渲染区块边长（米）
export const TERRAIN_RES = 1.0;       // 网格采样间距（米）-> 每块 25×25 格
/** 地表着色（动漫风格：鲜艳饱和、明亮色调） */
export function terrainColor(x, z) {
  const h = terrainHeight(x, z);
  if (h < WATER_LEVEL) return { r: 0.76, g: 0.70, b: 0.50 };      // 湖床 → 暖沙色
  if (h < 6) return { r: 0.35, g: 0.72, b: 0.30 };                // 草地 → 鲜艳绿
  if (h < 18) return { r: 0.58, g: 0.48, b: 0.30 };               // 土坡 → 暖棕
  if (h < 26) return { r: 0.62, g: 0.58, b: 0.55 };               // 岩石 → 浅灰
  return { r: 0.95, g: 0.97, b: 1.0 };                             // 雪顶 → 亮白
}
/** 某点的地表朝向（用于明暗），返回 {x,y,z} 由调用方构造 */
export function terrainNormal(x, z) {
  const e = 0.5;
  const h = terrainHeight(x, z);
  const hx = terrainHeight(x + e, z);
  const hz = terrainHeight(x, z + e);
  const nx = (h - hx) / e;
  const nz = (h - hz) / e;
  return { x: nx, y: 1.0, z: nz };
}
