/**
 * 确定性噪声 + SDF 地形
 *
 * 该模块的算法必须与客户端着色器（client/js/terrain.js 中的 GLSL）**完全一致**，
 * 以保证服务端物理（高度采样）与客户端渲染（地形绘制）落在同一张地形上。
 *
 * 实现要点：
 *  - 基于 32 位整数哈希的 value noise（JS 用 Math.imul / >>>，GLSL 用 uint 溢出乘法），两端结果一致。
 *  - fbm 多倍频叠加，得到无缝、连续、可漫步的丘陵地形。
 */

/** mulberry32 伪随机数生成器（确定性，用于出生点等） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数坐标哈希 -> [0,1)。与 GLSL hash2i 一致。 */
export function hash2i(x, z) {
  let hx = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  let hz = Math.imul(z ^ 0xc2b2ae3d, 0x27d4eb2f) >>> 0;
  let h = (hx ^ hz) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** 平滑插值 */
function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** 2D value noise（整数格子 + 双线性平滑插值），与 GLSL noise2 一致 */
export function noise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2i(ix, iz);
  const b = hash2i(ix + 1, iz);
  const c = hash2i(ix, iz + 1);
  const d = hash2i(ix + 1, iz + 1);
  const ux = smooth(fx);
  const uz = smooth(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** fbm 分形叠加（octaves 层），与 GLSL fbm2 一致 */
export function fbm2(x, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm; // [0,1]
}

/**
 * 地形高度函数：世界坐标 (x,z) -> 地表高度 y
 * 与客户端 GLSL terrainHeight 一致。地势平缓、可漫步，最高约 +30m。
 */
export function terrainHeight(x, z) {
  // 大尺度起伏（低频） + 中尺度细节
  const base = fbm2(x * 0.006, z * 0.006, 5);       // 0~1
  const detail = fbm2(x * 0.03 + 100.0, z * 0.03 + 100.0, 4) * 0.5; // 0~0.5 细节扰动
  let h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  // 限制在可玩范围内，避免极端陡峭
  return Math.max(-12, Math.min(34, h));
}

/** SDF 有符号距离函数：点 p 到地表的有符号距离（>0 在地表上方，<0 在地下） */
export function sdfGround(p) {
  return p.y - terrainHeight(p.x, p.z);
}

/** 地表法线（有限差分），供渲染/物理使用 */
export function terrainNormal(x, z, eps = 0.6) {
  const h = terrainHeight(x, z);
  const dx = (terrainHeight(x + eps, z) - terrainHeight(x - eps, z)) / (2 * eps);
  const dz = (terrainHeight(x, z + eps) - terrainHeight(x, z - eps)) / (2 * eps);
  const len = Math.hypot(dx, dz, 1);
  return { x: -dx / len, y: 1 / len, z: -dz / len };
}

/** 生成出生点（在世界内随机找一个安全地表点） */
export function randomSpawn(rng) {
  const angle = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * 60;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  return { x, y: terrainHeight(x, z) + 1.5, z };
}

/** 地形模块统一出口（供世界/物理/实体引用） */
export const terrain = {
  seed: 0,
  terrainHeight,
  sdfGround,
  terrainNormal,
  randomSpawn,
  mulberry32,
};
