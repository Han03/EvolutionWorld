/**
 * SDF 体积地形着色器（GLSL）
 *
 * 关键约束：本文件中的 hash2i / noise2 / fbm2 / terrainHeight
 * 必须与服务端 server/src/world/terrain.js 中的实现**逐位一致**，
 * 否则客户端渲染的地形与服务端物理（高度采样）会不一致，导致球体陷入地面或悬空。
 *
 * 渲染方式：全屏光线步进（raymarching）
 *  - 对每个像素构造观察射线，对地表高度场 SDF 做球面追踪（sphere tracing）
 *  - 命中地表：有限差分求法线 → 高度分层着色 + 日光 → 指数距离雾（体积感）
 *  - 未命中：绘制天空（垂直渐变 + 太阳 + 体积云层）
 *  - 通过 gl_FragDepth 写入真实深度，使实体球体能被地形正确遮挡
 */

export const TERRAIN_VERT = /* glsl */ `
precision highp float;
void main() {
  // 全屏三角形：z=1（远平面）
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const TERRAIN_FRAG = /* glsl */ `
precision highp float;
precision highp int;

uniform vec3  uCamPos;
uniform vec2  uRes;
uniform float uTime;
uniform mat4  uInvProj;
uniform mat4  uInvView;
uniform mat4  uProj;

// ==================== 确定性噪声（与服务端 JS 一致） ====================

float hash2i(float fx, float fz) {
  int x = int(fx);
  int z = int(fz);
  uint hx = (uint(x) ^ 0x9e3779b9u) * 0x85ebca6bu;
  uint hz = (uint(z) ^ 0xc2b2ae3du) * 0x27d4eb2fu;
  uint h = hx ^ hz;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}

float noise2(vec2 p) {
  float ix = floor(p.x);
  float iz = floor(p.y);
  float fx = p.x - ix;
  float fz = p.y - iz;
  float a = hash2i(ix, iz);
  float b = hash2i(ix + 1.0, iz);
  float c = hash2i(ix, iz + 1.0);
  float d = hash2i(ix + 1.0, iz + 1.0);
  float ux = fx * fx * (3.0 - 2.0 * fx);
  float uz = fz * fz * (3.0 - 2.0 * fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

float fbm2(vec2 p, int oct) {
  float amp = 0.5;
  float freq = 1.0;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * noise2(p * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

// 地表高度（世界坐标 xz -> y），与服务端 terrainHeight 一致
float terrainHeight(vec2 xz) {
  float base = fbm2(xz * 0.006, 5);
  float detail = fbm2(xz * 0.03 + vec2(100.0), 4) * 0.5;
  float h = (base - 0.5) * 46.0 + (detail - 0.25) * 10.0;
  return clamp(h, -12.0, 34.0);
}

// ==================== 主流程 ====================

void main() {
  // 观察射线（近平面重构，保证大步长时方向精度）
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(ndc, -1.0, 1.0);
  vp.xyz /= vp.w;
  vec3 rd = normalize(mat3(uInvView) * vp.xyz);
  vec3 ro = uCamPos;

  vec3 sunDir = normalize(vec3(0.62, 0.42, 0.30));
  vec3 skyTop      = vec3(0.29, 0.53, 0.84);
  vec3 skyHorizon  = vec3(0.72, 0.84, 0.95);
  vec3 sunColor    = vec3(1.00, 0.96, 0.86);

  // ---- 天空 ----
  vec3 sky = mix(skyHorizon, skyTop, pow(clamp(rd.y, 0.0, 1.0), 0.45));
  float sunAmt = pow(max(dot(rd, sunDir), 0.0), 180.0);
  sky += sunColor * sunAmt * 2.2;
  // 太阳光晕
  float halo = pow(max(dot(rd, sunDir), 0.0), 8.0);
  sky += sunColor * halo * 0.18;

  // 体积云（低层大气噪声密度）
  if (rd.y > 0.001) {
    float cloudH = 58.0 + fbm2(vec2(7.7), 2) * 10.0;
    float tC = (cloudH - ro.y) / rd.y;
    if (tC > 0.0) {
      vec3 cp = ro + rd * tC;
      float cn = fbm2(cp.xz * 0.0022 + uTime * 0.0018, 5);
      float den = smoothstep(0.52, 0.78, cn);
      sky = mix(sky, vec3(1.0, 1.0, 1.0), den * 0.92);
      // 云朵阴影（光照方向调暗）
      float sh = smoothstep(0.60, 0.80, fbm2(cp.xz * 0.0022 + 40.0, 4));
      sky *= 1.0 - den * sh * 0.25;
    }
  }

  // ---- 地表光线步进（SDF 球面追踪） ----
  float t = 0.0;
  const float maxDist = 900.0;
  const int STEPS = 100;
  float hit = 0.0;
  vec3 hitP = ro;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - terrainHeight(p.xz);
    if (d < 0.02) {
      hit = 1.0;
      hitP = p;
      break;
    }
    t += max(0.5, d * 0.6);
    if (t > maxDist) break;
  }

  vec3 col = sky;

  if (hit > 0.5) {
    // 地表法线（有限差分）
    float eps = 0.6;
    float hx  = terrainHeight(hitP.xz + vec2(eps, 0.0));
    float hxm = terrainHeight(hitP.xz - vec2(eps, 0.0));
    float hz  = terrainHeight(hitP.xz + vec2(0.0, eps));
    float hzm = terrainHeight(hitP.xz - vec2(0.0, eps));
    vec3 n = normalize(vec3((hxm - hx) / (2.0 * eps), 1.0, (hzm - hz) / (2.0 * eps)));

    // 高度分层着色：草地 → 土壤 → 雪
    vec3 grass = vec3(0.30, 0.52, 0.24);
    vec3 soil  = vec3(0.46, 0.35, 0.25);
    vec3 snow  = vec3(0.90, 0.95, 0.98);
    vec3 base = mix(grass, soil, smoothstep(-6.0, 18.0, hitP.y) * 0.55);
    base = mix(base, snow, smoothstep(22.0, 29.0, hitP.y));
    // 微细节纹理（避免过于光滑）
    float tex = fbm2(hitP.xz * 0.18, 3);
    base *= 0.92 + tex * 0.16;

    // 日光 + 环境光
    float dif = max(dot(n, sunDir), 0.0);
    vec3 lit = base * (0.48 + 0.62 * dif);
    // 地表大气透视
    lit = mix(lit, skyHorizon, pow(1.0 - clamp(rd.y, 0.0, 1.0), 2.0) * 0.35);
    // 指数距离雾（体积感）
    float fogF = 1.0 - exp(-t * 0.0016);
    col = mix(lit, sky, fogF);
  }

  gl_FragColor = vec4(col, 1.0);

  // 写入真实深度，让实体球体能被地形正确遮挡
  if (hit > 0.5) {
    vec4 clip = uProj * vec4(hitP, 1.0);
    float ndcZ = clip.z / clip.w;
    gl_FragDepth = clamp(ndcZ * 0.5 + 0.5, 0.0, 1.0);
  } else {
    gl_FragDepth = 1.0;
  }
}
`;

// ==================== JS 版地形高度（供客户端预测/物理使用） ====================
// 必须与上方 GLSL 中的 hash2i / noise2 / fbm2 / terrainHeight **逐位一致**，
// 同时与服务端 server/src/game/terrain.cpp 一致，否则预测位置与服务端权威位置漂移。

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
  return Math.max(-12, Math.min(34, h));
}
