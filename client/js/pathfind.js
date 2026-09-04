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

// ════════════════════════════════════════════════
// A* 寻路（整数网格坐标 = Math.floor(世界坐标)）
// ════════════════════════════════════════════════

/**
 * A* 寻路
 * @returns 网格坐标数组 [{gx, gz}] 或 null（不可达 / mask 未加载）
 */
function astar(sx, sz, ex, ez) {
  if (!walkMaskReady()) return null;
  if (blocked(sx, sz) || blocked(ex, ez)) return null;
  if (sx === ex && sz === ez) return [{ gx: sx, gz: sz }];

  // 估算搜索半径上限（防止在空旷地图上搜索过久）
  const MAX_ITER = 8000;

  // 二叉堆优先队列（小顶堆，按 f 排序）
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
  heap.push({ x: sx, z: sz, f: hVal(sx, sz) });
  const inOpen = new Set([sk]);

  let iters = 0;
  while (heap.length > 0 && iters++ < MAX_ITER) {
    // 取最小 f
    let mi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i].f < heap[mi].f) mi = i;
    const cur = heap[mi];
    heap[mi] = heap[heap.length - 1]; heap.pop();
    const ck = key(cur.x, cur.z);
    inOpen.delete(ck);

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

    const cg = gScore.get(ck);
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
        if (!inOpen.has(nk)) {
          heap.push({ x: nx, z: nz, f: ng + hVal(nx, nz) });
          inOpen.add(nk);
        }
      }
    }
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
// 最近可达点搜索（BFS 螺旋 + A* 可达性验证）
// ════════════════════════════════════════════════

/**
 * 从被阻挡的目标位置向外 BFS 搜索，找到离目标最近且从起点可达的可通行格子
 * @returns {gx, gz} 或 null
 */
function findNearestWalkable(sgx, sgz, egx, egz) {
  const RADIUS = 30;
  const visited = new Set();
  const queue = [{ gx: egx, gz: egz }];
  visited.add(key(egx, egz));

  while (queue.length > 0) {
    const cur = queue.shift();
    const dx = cur.gx - egx, dz = cur.gz - egz;
    const distToTarget = Math.max(Math.abs(dx), Math.abs(dz));
    if (distToTarget > RADIUS) continue;

    if (!blocked(cur.gx, cur.gz)) {
      // 可通行——用 A* 验证从起点是否可达
      const path = astar(sgx, sgz, cur.gx, cur.gz);
      if (path && path.length > 0) {
        // 离目标最近的可达点（BFS 按距离递增，首个即最近）
        return cur;
      }
    }

    // 扩展 8 方向邻居
    for (const [ddx, ddz] of DIRS) {
      const nx = cur.gx + ddx, nz = cur.gz + ddz;
      const nk = key(nx, nz);
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push({ gx: nx, gz: nz });
      }
    }
  }
  return null;
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
   */
  moveTo(cx, cz, tx, tz) {
    if (!walkMaskReady()) { this.clear(); return; }
    const sgx = Math.floor(cx), sgz = Math.floor(cz);
    let egx = Math.floor(tx), egz = Math.floor(tz);
    if (blocked(egx, egz)) {
      // 目标被阻挡（空洞等）——寻找离目标最近且从起点可达的可通行格子
      const alt = findNearestWalkable(sgx, sgz, egx, egz);
      if (!alt) { this.clear(); return; }
      egx = alt.gx;
      egz = alt.gz;
    }

    const raw = astar(sgx, sgz, egx, egz);
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
