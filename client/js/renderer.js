// renderer.js - 固定俯视角大型 MMO 渲染器（Canvas 2D，无需 WebGL）
// 世界地图：区块化高度场网格地形（离屏预渲染 + 可见范围流式加载）+ 水面 + 实体圆球投影
// 已移除原 SDF 体积地形（光线步进）与 Three.js 依赖。
import { terrainHeight, terrainColor, WATER_LEVEL, TERRAIN_CHUNK, TERRAIN_RES } from './terrain.js';

// 缩放：像素/米（固定俯视角，无自由镜头）
export const CAM_SCALE = 16;
const VIEW_RANGE_M = 100; // 可见范围（与服务端 viewRange 一致，超出卸载）
const CELL = TERRAIN_RES;  // 地形绘制采样粒度（米）

export function createRenderer(container) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  container.appendChild(canvas);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // 运行时状态（每帧由 boot 同步）
  const state = { selfX: 0, selfZ: 0, self: null, entities: [] };

  // ---- 区块离屏画布（流式加载，仅玩家可见范围） ----
  const chunkCanvases = new Map(); // "cx,cz" -> {canvas, cx, cz}
  const chunkPx = Math.round(TERRAIN_CHUNK * CAM_SCALE);

  function buildChunkCanvas(cx, cz) {
    const off = document.createElement('canvas');
    off.width = chunkPx;
    off.height = chunkPx;
    const o = off.getContext('2d');
    const x0 = cx * TERRAIN_CHUNK;
    const z0 = cz * TERRAIN_CHUNK;
    const px = CAM_SCALE * CELL; // 每个采样格像素
    for (let iz = 0; iz < TERRAIN_CHUNK / CELL; iz++) {
      for (let ix = 0; ix < TERRAIN_CHUNK / CELL; ix++) {
        const wx = x0 + ix * CELL + CELL / 2;
        const wz = z0 + iz * CELL + CELL / 2;
        const h = terrainHeight(wx, wz);
        const c = terrainColor(wx, wz);
        o.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
        o.fillRect(ix * px, iz * px, px + 0.5, px + 0.5);
        if (h < WATER_LEVEL) {
          // 水下：叠加半透明水面（形成湖泊）
          o.fillStyle = 'rgba(47,127,208,0.55)';
          o.fillRect(ix * px, iz * px, px + 0.5, px + 0.5);
        }
      }
    }
    return { canvas: off, cx, cz };
  }

  function updateTerrain(selfX, selfZ) {
    state.selfX = selfX;
    state.selfZ = selfZ;
    const ccx = Math.floor(selfX / TERRAIN_CHUNK);
    const ccz = Math.floor(selfZ / TERRAIN_CHUNK);
    const radius = Math.ceil(VIEW_RANGE_M / TERRAIN_CHUNK) + 1;
    const need = new Set();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const kx = ccx + dx, kz = ccz + dz;
        const wxc = (kx + 0.5) * TERRAIN_CHUNK;
        const wzc = (kz + 0.5) * TERRAIN_CHUNK;
        if (Math.hypot(wxc - selfX, wzc - selfZ) <= VIEW_RANGE_M + TERRAIN_CHUNK * 0.8) {
          need.add(kx + ',' + kz);
        }
      }
    }
    for (const key of [...chunkCanvases.keys()]) {
      if (!need.has(key)) chunkCanvases.delete(key);
    }
    for (const key of need) {
      if (chunkCanvases.has(key)) continue;
      const [kx, kz] = key.split(',').map(Number);
      chunkCanvases.set(key, buildChunkCanvas(kx, kz));
    }
  }

  // 世界坐标 -> 屏幕坐标（固定俯视角，玩家居中）
  function sx(wx) { return (wx - state.selfX) * CAM_SCALE + window.innerWidth / 2; }
  function sy(wz) { return (wz - state.selfZ) * CAM_SCALE + window.innerHeight / 2; }

  function draw() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    // 背景（水面以外的远景色）
    ctx.fillStyle = '#7fb2d8';
    ctx.fillRect(0, 0, w, h);

    // 1) 地形区块（离屏画布 blit）
    for (const c of chunkCanvases.values()) {
      const px = sx(c.cx * TERRAIN_CHUNK);
      const py = sy(c.cz * TERRAIN_CHUNK);
      ctx.drawImage(c.canvas, px, py, chunkPx, chunkPx);
    }

    // 2) 实体（俯视投影圆球）
    for (const e of state.entities) drawEntity(e);

    // 3) 自身（橙色 + 半透明白色描边）
    if (state.self) {
      const x = sx(state.self.x), y = sy(state.self.z);
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ff8c1a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 自身名字
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(state.self.name || '你', x, y - 14);
    }

    // 4) 视野范围圈（100m）
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, VIEW_RANGE_M * CAM_SCALE, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawEntity(e) {
    const x = sx(e.x), y = sy(e.z);
    let color, r = 7;
    if (e.kind === 'player') { color = '#34d399'; r = 7; }   // 绿色
    else if (e.kind === 'npc') { color = '#60a5fa'; r = 6; } // 蓝色
    else { color = '#f87171'; r = 6; }                        // 红色（怪物）
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (e.name) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.name, x, y - 12);
    }
  }

  /** 同步自身（用于相机跟随/中心绘制） */
  function setSelf(x, y, z, name) {
    state.self = { x, y, z, name };
  }
  /** 同步可见实体列表（boot 每帧提供插值后数据） */
  function setEntities(list) {
    state.entities = list;
  }

  return { canvas, ctx, updateTerrain, setSelf, setEntities, draw, resize };
}
