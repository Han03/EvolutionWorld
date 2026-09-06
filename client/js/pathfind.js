/**
 * pathfind.js — A* 自动寻路 + 路径跟随
 * 基于 terrain.js 的 terrainVoid()（服务端下发的可通行 mask）做 1m 网格 A*，
 * 路径经视线法平滑后由 PathFinder 逐航点跟随输出移动方向。
 */
import { terrainVoid, walkMaskReady } from './terrain.js';

// ── 8 方向偏移 [dx, dz, cost] ──
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414],
];

// ── 网格坐标哈希（偏移防负，astar / findNearestWalkable 共享） ──
const key = (x, z) => (z + 512) * 1024 + (x + 512);

// ── 可通行判定（直接用 terrain.js 的 terrainVoid，自动处理 mask offset） ──
// 网格坐标 = Math.floor(世界坐标)，terrainVoid 接受世界坐标（内部 floor 等价于整数输入直传）
function blocked(gx, gz) { return terrainVoid(gx, gz); }

// ── 二叉堆优先队列（小顶堆，按 f 排序） ──
// A* 每迭代取最小 f。线性扫描在远距离搜索（数万次扩展）下是 O(n²) 灾难，
// 二叉堆保证 push/pop 均为 O(log n)，支持全图范围寻路。
function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].f <= h[i].f) break;
    const tmp = h[p]; h[p] = h[i]; h[i] = tmp;
    i = p;
  }
}
function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l].f < h[m].f) m = l;
      if (r < h.length && h[r].f < h[m].f) m = r;
      if (m === i) break;
      const tmp = h[m]; h[m] = h[i]; h[i] = tmp;
      i = m;
    }
  }
  return top;
}

// ════════════════════════════════════════════════
// A* 寻路（整数网格坐标 = Math.floor(世界坐标)）
// ════════════════════════════════════════════════

/**
 * A* 寻路
 * @param {boolean} softTarget 目标格被阻挡时启用：搜索耗尽后返回"离目标最近的可达格"路径
 * @returns 网格坐标数组 [{gx, gz}] 或 null（不可达 / mask 未加载）
 */
function astar(sx, sz, ex, ez, softTarget = false) {
  if (!walkMaskReady()) return null;
  if (blocked(sx, sz)) return null;
  if (!softTarget && blocked(ex, ez)) return null;
  if (sx === ex && sz === ez) return [{ gx: sx, gz: sz }];

  // 搜索迭代上限：645×645 全图（约 41 万格）。二叉堆后每次扩展 O(log n)，
  // 障碍地图 A* 扩展量受路径影响（通常数万）；开阔地有视线直达优化兜底，无需全图搜索。
  const MAX_ITER = 500000;

  const heap = [];
  const hVal = (x, z) => {
    const dx = Math.abs(x - ex), dz = Math.abs(z - ez);
    return Math.max(dx, dz) + (1.414 - 2) * Math.min(dx, dz); // 八方向一致启发
  };

  const gScore = new Map();
  const parent = new Map();
  const sk = key(sx, sz);
  const endK = key(ex, ez);

  gScore.set(sk, 0);
  heapPush(heap, { x: sx, z: sz, f: hVal(sx, sz), g: 0 });

  let iters = 0;
  let bestNode = null, bestH = Infinity; // 软目标：离目标最近的可达扩展点
  while (heap.length > 0 && iters++ < MAX_ITER) {
    // 取最小 f（跳过因改进 g 而过时的重复条目）
    let cur = heapPop(heap);
    const ck = key(cur.x, cur.z);
    const curG = gScore.get(ck);
    if (curG === undefined || cur.g !== curG) continue;

    // 记录离目标最近的可达点（软目标 / 不可达时回退终点）
    const hc = hVal(cur.x, cur.z);
    if (hc < bestH) { bestH = hc; bestNode = cur; }

    if (ck === endK) {
      // 回溯路径
      const path = [];
      let k = endK;
      while (k !== undefined && k !== sk) {
        const x = (k & 1023) - 512, z = ((k >> 10) & 1023) - 512;
        path.push({ gx: x, gz: z });
        k = parent.get(k);
      }
      path.reverse();
      return path;
    }

    const cg = curG;
    for (const [dx, dz, cost] of DIRS) {
      const nx = cur.x + dx, nz = cur.z + dz;
      if (blocked(nx, nz)) continue;
      // 对角移动：两相邻格均需可通行（防穿墙缝）
      if (dx !== 0 && dz !== 0) {
        if (blocked(cur.x + dx, cur.z) || blocked(cur.x, cur.z + dz)) continue;
      }
      const nk = key(nx, nz);
      const ng = cg + cost;
      if (!gScore.has(nk) || ng < gScore.get(nk)) {
        gScore.set(nk, ng);
        parent.set(nk, ck);
        heapPush(heap, { x: nx, z: nz, f: ng + hVal(nx, nz), g: ng });
      }
    }
  }
  // 搜索耗尽：软目标模式下返回离目标最近的可达格路径（替代 BFS+逐格 A* 验证）
  if (softTarget && bestNode && !(bestNode.x === sx && bestNode.z === sz)) {
    const path = [];
    let k = key(bestNode.x, bestNode.z);
    while (k !== undefined && k !== sk) {
      const x = (k & 1023) - 512, z = ((k >> 10) & 1023) - 512;
      path.push({ gx: x, gz: z });
      k = parent.get(k);
    }
    path.reverse();
    return path;
  }
  return null; // 不可达或搜索超限
}

// ════════════════════════════════════════════════
// 视线检测（Bresenham，用于路径平滑）
// ════════════════════════════════════════════════

function lineOfSight(x0, z0, x1, z1) {
  let dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  let sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  let err = dx - dz, x = x0, z = z0;
  while (true) {
    if (x === x1 && z === z1) return true;
    if (blocked(x, z)) return false;
    const e2 = err * 2;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
  }
}

// ════════════════════════════════════════════════
// 路径平滑（视线法：跳过多余中间航点）
// ════════════════════════════════════════════════

function smoothPath(path) {
  if (!path || path.length <= 2) return path;
  const result = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let farthest = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      if (lineOfSight(path[i].gx, path[i].gz, path[j].gx, path[j].gz)) {
        farthest = j; break;
      }
    }
    result.push(path[farthest]);
    i = farthest;
  }
  return result;
}

// ════════════════════════════════════════════════
// PathFinder — 对外接口
// ════════════════════════════════════════════════

export class PathFinder {
  constructor() {
    this._waypoints = [];   // 世界坐标航点 [{x, z}]
    this._idx = 0;          // 当前目标航点索引
    this._dest = null;      // 最终目标 {x, z} | null
    this._arrival = 0.8;    // 航点到达阈值（米）
  }

  /** 是否有活跃路径 */
  hasPath() { return this._waypoints.length > 0; }

  /** 获取最终目标（渲染指示器用） */
  getDestination() { return this._dest; }

  /**
   * 设定移动目标：从 (cx,cz) 寻路到 (tx,tz)
   * 目标格被阻挡（空洞等）时自动启用软目标模式，一次 A* 即回到离目标最近的可达格。
   */
  moveTo(cx, cz, tx, tz) {
    if (!walkMaskReady()) { this.clear(); return; }
    const sgx = Math.floor(cx), sgz = Math.floor(cz);
    const egx = Math.floor(tx), egz = Math.floor(tz);

    // 直达优先：目标可通行且视线无遮挡 → 直接直线（远距离开阔地免全图 A*，O(1)）
    if (!blocked(egx, egz) && lineOfSight(sgx, sgz, egx, egz)) {
      this._waypoints = [{ x: tx, z: tz }];
      this._idx = 0;
      this._dest = { x: tx, z: tz };
      return;
    }

    const raw = astar(sgx, sgz, egx, egz, blocked(egx, egz));
    if (!raw || raw.length === 0) { this.clear(); return; }

    const smoothed = smoothPath(raw);
    // 网格坐标 → 世界坐标（格子中心）
    this._waypoints = smoothed.map(p => ({ x: p.gx + 0.5, z: p.gz + 0.5 }));
    this._idx = 0;
    this._dest = { x: tx, z: tz };

    // 跳过过近的首航点，让起步方向更直（阈值放大到 1.2m）
    while (this._waypoints.length > 1 && this._idx < this._waypoints.length - 1) {
      const wp = this._waypoints[this._idx];
      const d = Math.hypot(wp.x - cx, wp.z - cz);
      if (d < 1.2) {
        this._idx++;
      } else {
        break;
      }
    }
  }

  /**
   * 每帧调用：返回当前航点方向的归一化移动向量 {x, z}
   * 到达所有航点后返回 {0,0} 并清空路径
   */
  getMoveVector(px, pz) {
    if (this._waypoints.length === 0) return { x: 0, z: 0 };
    const wp = this._waypoints[this._idx];
    const dx = wp.x - px, dz = wp.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < this._arrival) {
      this._idx++;
      if (this._idx >= this._waypoints.length) {
        this._waypoints = [];
        this._dest = null;
        return { x: 0, z: 0 };
      }
      return this.getMoveVector(px, pz);
    }
    return { x: dx / dist, z: dz / dist };
  }

  /** 清空路径 */
  clear() {
    this._waypoints = [];
    this._idx = 0;
    this._dest = null;
  }
}
