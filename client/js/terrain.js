// terrain.js - 高度场地形数据（确定性噪声，与 C++ 服务端 terrain.cpp 逐位一致）
// 供客户端预测（predict.js）、地形网格渲染、水面对齐使用。
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
/** 地形高度（世界坐标 xz -> y），与服务端 terrainHeight 一致 */
export function terrainHeight(x, z) {
  const base = fbm2(x * 0.006, z * 0.006, 5);
  const detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5;
  const h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  return Math.max(-12.0, Math.min(34.0, h));
}
/** 水面高度（与服务端 kWaterLevel 一致，地表低于该值形成湖泊） */
export const WATER_LEVEL = -2.0;
/** 网格地形分块参数（客户端渲染用，与服务端 AOI 无关） */
export const TERRAIN_CHUNK = 25;      // 渲染区块边长（米）
export const TERRAIN_RES = 1.0;       // 网格采样间距（米）-> 每块 25×25 格
/** 地表着色（按高度分层，俯视 MMO 风格） */
export function terrainColor(x, z) {
  const h = terrainHeight(x, z);
  // 水下 → 沙/泥；草地 → 丘陵土；高处 → 岩/雪
  if (h < WATER_LEVEL) return { r: 0.62, g: 0.56, b: 0.38 };
  if (h < 6) return { r: 0.30, g: 0.55, b: 0.26 };      // 草地
  if (h < 18) return { r: 0.44, g: 0.38, b: 0.24 };     // 土坡
  if (h < 26) return { r: 0.52, g: 0.47, b: 0.45 };     // 岩石
  return { r: 0.90, g: 0.95, b: 0.98 };                 // 雪顶
}
/** 某点的地表朝向（用于明暗），返回 {n: THREE.Vector3} 由调用方构造 */
export function terrainNormal(x, z) {
  const e = 0.5;
  const h = terrainHeight(x, z);
  const hx = terrainHeight(x + e, z);
  const hz = terrainHeight(x, z + e);
  const nx = (h - hx) / e;
  const nz = (h - hz) / e;
  return { x: nx, y: 1.0, z: nz };
}
