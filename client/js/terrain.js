// terrain.js - 高度场地形数据（确定性噪声，与 C++ 服务端 terrain.cpp 逐位一致）
// 供客户端预测（predict.js）、地形网格渲染、水面/河流对齐使用。
// 地形要素：基础丘陵 + 河流下切（湖泊/河流）+ 山脊抬升（悬崖/不可通行）
//         + 路径地图空洞（可到达区域收缩为走廊+空地）+ 地形编辑器编辑层（覆盖）。
// 原 SDF 体积地形（光线步进）已移除，本模块即世界地图的数据源。
function _imul32(a, b) {
  // Math.imul 语义
  return Math.imul(a, b);
}
/** 整数坐标哈希 -> [0,1) */
export function hash2i(x, z) {
  let hx = _imul32((x ^ 0x9e3779b9) | 0, 0x85ebca6b) >>> 0;
  let hz = _imul32((z ^ 0xc2b2ae3d) | 0, 0x27d4eb2f) >>> 0;
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
/** 平滑阶跃（与服务端 sstep 一致）：0→1 平滑过渡 */
function sstep(t, a, b) {
  if (t <= a) return 0;
  if (t >= b) return 1;
  const x = (t - a) / (b - a);
  return x * x * (3 - 2 * x);
}
function sstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
/** 中央高原抬升（城镇/安全区/出生点）：中心半径 ~24m，最高 +16，平滑衰减（与服务端一致） */
export function centralPlateau(x, z) {
  const d = Math.hypot(x, z);
  const u = d / 24.0;
  if (u >= 1) return 0;
  return 16.0 * (1.0 - sstep01(u));
}
/** 河流通道值 [0,1]：两条蜿蜒主河（东西向沿 z≈-28、南北向沿 x≈32），取较大者（与服务端一致） */
export function riverBand(x, z) {
  const RIVER_HALF = 7.0;
  // 东西向河：中心 z 随 x 蜿蜒（地图南部）
  const zc = -28.0 + 60.0 * (fbm2(x * 0.0025 + 13.7, 0.0, 3) - 0.5);
  const b1 = 1.0 - Math.abs(z - zc) / RIVER_HALF;
  // 南北向河：中心 x 随 z 蜿蜒（地图东部）
  const xc = 32.0 + 55.0 * (fbm2(0.0, z * 0.0025 + 7.9, 3) - 0.5);
  const b2 = 1.0 - Math.abs(x - xc) / RIVER_HALF;
  return Math.max(0.0, Math.max(b1, b2));
}
// ==================== 路径地图空洞 mask（确定性，与服务端 terrainVoid 逐位一致） ====================
const MASK_N = 256;
const MASK_OFF = 128;
let g_walk = null; // Uint8Array 1=可通行（懒生成缓存）
function ensureMask() {
  if (g_walk) return;
  g_walk = new Uint8Array(MASK_N * MASK_N);
  const markCircle = (cx, cz, r) => {
    const x0 = Math.max(0, Math.floor(cx - r) + MASK_OFF);
    const x1 = Math.min(MASK_N - 1, Math.floor(cx + r) + MASK_OFF);
    const z0 = Math.max(0, Math.floor(cz - r) + MASK_OFF);
    const z1 = Math.min(MASK_N - 1, Math.floor(cz + r) + MASK_OFF);
    const r2 = r * r;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx - MASK_OFF) + 0.5 - cx;
        const dz = (gz - MASK_OFF) + 0.5 - cz;
        if (dx * dx + dz * dz <= r2) g_walk[gz * MASK_N + gx] = 1;
      }
    }
  };
  const TWO_PI = 6.283185307179586;
  // 主城（出生地 / 商店 / 城镇）：中心圆盘
  markCircle(0, 0, 9.0);
  // 主干道：6 条，从中心向外随机游走（确定性）
  const ROADS = 6;
  for (let i = 0; i < ROADS; i++) {
    const baseAng = i * (TWO_PI / ROADS) + (hash2i(i * 7 + 1, 13) - 0.5) * 0.5;
    let px = 0, pz = 0;
    let dir = baseAng;
    const steps = 30 + Math.floor(hash2i(i * 3 + 5, 29) * 8); // 30..37
    const stepLen = 2.0;
    for (let s = 0; s < steps; s++) {
      const wob = (hash2i(i * 101 + s * 13 + 3, s * 7 + 11) - 0.5) * 0.9;
      dir += wob;
      let da = baseAng - dir;
      while (da > Math.PI) da -= TWO_PI;
      while (da < -Math.PI) da += TWO_PI;
      dir += da * 0.10;
      px += Math.cos(dir) * stepLen;
      pz += Math.sin(dir) * stepLen;
      markCircle(px, pz, 3.6);
      if (s % 7 === 4) {
        let bdir = dir + (hash2i(i * 17 + s, s * 3 + 2) - 0.5) * 2.2;
        let bx = px, bz = pz;
        for (let bs = 0; bs < 12; bs++) {
          bdir += (hash2i(i * 31 + bs, s + bs * 5) - 0.5) * 0.7;
          bx += Math.cos(bdir) * 1.8;
          bz += Math.sin(bdir) * 1.8;
          markCircle(bx, bz, 2.8);
        }
      }
    }
  }
  // 随机空地（偶尔保留的开阔区）
  const G = 16;
  for (let i = 0; i < G; i++) {
    const ax = (hash2i(i * 131 + 7, 71) - 0.5) * 220.0;
    const az = (hash2i(i * 211 + 3, 97) - 0.5) * 220.0;
    const r = 5.5 + hash2i(i * 37, i * 19 + 5) * 6.5; // 5.5..12
    markCircle(ax, az, r);
  }
}
/** 该点是否路径地图空洞（可到达区域外；服务端/客户端逐位一致） */
export function terrainVoid(x, z) {
  ensureMask();
  const gx = Math.floor(x) + MASK_OFF;
  const gz = Math.floor(z) + MASK_OFF;
  if (gx < 0 || gx >= MASK_N || gz < 0 || gz >= MASK_N) return true;
  return g_walk[gz * MASK_N + gx] === 0;
}

// ==================== 地形编辑器编辑层（稀疏格子覆盖，与服务端一致） ====================
// key："x,z" 字符串；cell: {h?, v?}（h=绝对高度覆盖，v=可通行覆盖 1=空洞 0=强制可通行）
const editMap = new Map();
function editKey(x, z) { return Math.floor(x) + ',' + Math.floor(z); }
/** 编辑器/运行时：设置或擦除（传空对象即擦除）某格编辑 */
export function setEditCell(x, z, { h, v } = {}) {
  const k = editKey(x, z);
  const hasH = h !== undefined, hasV = v !== undefined;
  if (!hasH && !hasV) { editMap.delete(k); return; }
  const c = {};
  if (hasH) c.h = h;
  if (hasV) c.v = v;
  editMap.set(k, c);
}
export function eraseEditCell(x, z) { editMap.delete(editKey(x, z)); }
export function clearEdit() { editMap.clear(); }
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
}

/** 地形高度（世界坐标 xz -> y），与服务端 terrainHeight 逐位一致（含编辑层覆盖） */
export function terrainHeight(x, z) {
  // 编辑器编辑层优先：绝对高度覆盖
  const ec = editMap.get(editKey(x, z));
  if (ec && ec.h !== undefined) return ec.h;
  const base = fbm2(x * 0.006, z * 0.006, 5);
  const detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5;
  let h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  // 山脊抬升：山脉区域 + 山脊噪声 → 陡峭山脊（悬崖）
  const mountain = sstep(fbm2(x * 0.004 + 31.7, z * 0.004 + 8.2, 3), 0.58, 0.78);
  const ridged = 1.0 - Math.abs(2.0 * fbm2(x * 0.012 + 5.1, z * 0.012 + 9.3, 4) - 1.0);
  h += mountain * ridged * 26.0;
  // 中央高原抬升（城镇/安全区干地）
  h += centralPlateau(x, z);
  // 河流下切：河床压到水面以下 → 形成河流/湖泊（水不可通行）
  const rv = riverBand(x, z);
  if (rv > 0.0) h = Math.min(h, WATER_LEVEL - 2.5 * rv);
  return Math.max(-12.0, Math.min(34.0, h));
}
/** 水面高度（与服务端 kWaterLevel 一致，地表低于该值形成湖泊/河流） */
export const WATER_LEVEL = -2.0;
/** 悬崖判定坡度（与服务端 kCliffSlope 一致） */
export const CLIFF_SLOPE = 1.30;
/** 该点最大局部坡度（Δh/Δd，与服务端 terrainSlope 一致） */
export function terrainSlope(x, z) {
  const e = 0.5;
  const hx = terrainHeight(x + e, z);
  const hxm = terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e);
  const hzm = terrainHeight(x, z - e);
  return Math.max(Math.abs(hx - hxm) / (2 * e), Math.abs(hz - hzm) / (2 * e));
}
/** 该点是否不可通行：空洞（路径地图）/ 深水（湖泊/河流床）/ 悬崖/陡坡。与服务端 terrainBlocked 逐位一致 */
export function terrainBlocked(x, z) {
  // 编辑器编辑层优先：可通行性覆盖
  const ec = editMap.get(editKey(x, z));
  if (ec && ec.v !== undefined) return ec.v === 1;
  if (terrainVoid(x, z)) return true;
  if (terrainHeight(x, z) < WATER_LEVEL) return true;
  if (terrainSlope(x, z) > CLIFF_SLOPE) return true;
  return false;
}
/** 网格地形分块参数（客户端渲染用，与服务端 AOI 无关） */
export const TERRAIN_CHUNK = 25;      // 渲染区块边长（米）
export const TERRAIN_RES = 1.0;       // 网格采样间距（米）-> 每块 25×25 格
/** 地表着色（按高度分层 + 河流/山脊，俯视 MMO 风格） */
export function terrainColor(x, z) {
  const h = terrainHeight(x, z);
  if (h < WATER_LEVEL) return { r: 0.62, g: 0.56, b: 0.38 };      // 河床/湖床 → 沙泥
  const rv = riverBand(x, z);
  if (rv > 0.35) return { r: 0.20, g: 0.42, b: 0.52 };            // 河岸湿土
  if (h < 6) return { r: 0.30, g: 0.55, b: 0.26 };                // 草地
  if (h < 18) return { r: 0.44, g: 0.38, b: 0.24 };               // 土坡
  if (h < 26) return { r: 0.52, g: 0.47, b: 0.45 };               // 岩石
  return { r: 0.90, g: 0.95, b: 0.98 };                           // 雪顶
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
