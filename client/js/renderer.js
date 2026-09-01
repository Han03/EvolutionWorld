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
  // 技能简易效果（前摇进度圈 / AOE 范围圈 / 打断闪红）：
  //   {kind:'cast'|'aoe'|'cancel', wid, x, z, radius, color, startMs, durMs}
  const effects = [];
  /** 添加技能效果（boot.js 由 EVT_SKILL_CASTING/EVT_SKILL/EVT_SKILL_CANCEL 与本地施放触发） */
  function addSkillEffect(eff) {
    // 同一施法者的前摇圈去重（重复施放刷新）
    if (eff.kind === 'cast') {
      for (let i = effects.length - 1; i >= 0; i--) {
        if (effects[i].kind === 'cast' && effects[i].wid === eff.wid) effects.splice(i, 1);
      }
    }
    effects.push(Object.assign({ startMs: performance.now(), durMs: 800, color: '#ffd166', radius: 0 }, eff));
    // 上限保护
    if (effects.length > 64) effects.splice(0, effects.length - 64);
  }
  /** 移除某施法者的前摇圈（打断时由 boot.js 调用） */
  function clearCasting(wid) {
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i].kind === 'cast' && effects[i].wid === wid) effects.splice(i, 1);
    }
  }
  /** 本地 AOE 落点预览（按技能键即显示，不等服务器往返） */
  function showAoePreview(x, z, radius, color) {
    effects.push({
      kind: 'aoe', wid: -1, x, z, radius,
      color: color || '#ff6b35', startMs: performance.now(), durMs: 1200,
    });
  }
  // 世界 Boss 共享状态（来自 S2C_BOSS，血量/阶段/状态；位置走 AOI 实体插值）
  const bossHp = new Map(); // wid -> {hp,maxHp,state,phase,name}

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

    // 1.5) 技能效果：AOE 范围圈（地面层，画在实体之下）
    drawAoeEffects(performance.now());
    // 2) 实体（俯视投影圆球）
    for (const e of state.entities) drawEntity(e);
    // 2.5) 技能效果：前摇进度圈 + 打断闪红（画在实体之上，叠在施法者身上）
    drawCastEffects(performance.now());

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

  // ---- 技能效果绘制 ----
  // AOE 范围圈：半透明填充 + 高亮边缘，随剩余时间淡出
  function drawAoeEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind !== 'aoe') continue;
      const life = (now - ef.startMs) / ef.durMs;
      if (life >= 1) { effects.splice(i, 1); continue; }
      const x = sx(ef.x), y = sy(ef.z);
      const R = Math.max(4, ef.radius * CAM_SCALE);
      const alpha = Math.max(0, 1 - life) * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(ef.color, 0.16 * alpha);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(ef.color, 0.85 * alpha);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      // 半径标注（米）
      if (ef.radius >= 2) {
        ctx.fillStyle = hexToRgba(ef.color, 0.9 * alpha);
        ctx.font = '10px "PingFang SC",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${ef.radius}m`, x, y + 3.5);
      }
    }
  }
  // 前摇进度圈：围绕施法者，弧线随时间填充（0→360°，代表释放时间进度）
  function drawCastEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind === 'cast') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const x = sx(ef.x), y = sy(ef.z);
        const R = Math.max(16, 1.6 * CAM_SCALE);
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 4;
        ctx.stroke();
        // 进度弧（顺时针填充）
        ctx.beginPath();
        ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, life));
        ctx.strokeStyle = ef.color || '#ffd166';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        // 中心小点（施法者正在吟唱）
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(ef.color || '#ffd166', 0.9);
        ctx.fill();
      } else if (ef.kind === 'cancel') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const x = sx(ef.x), y = sy(ef.z);
        const R = Math.max(16, 1.6 * CAM_SCALE);
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248,113,113,${0.9 * (1 - life)})`;
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    }
  }
  // 简易 hex -> rgba（含透明度）
  function hexToRgba(hex, a) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // 物品名映射（由 boot.js 填充，来自商店/背包/掉落的 itemId）
  const ITEM_NAMES = (typeof window !== 'undefined' && window.__itemNames) || {};
  function drawEntity(e) {
    const x = sx(e.x), y = sy(e.z);
    const boss = bossHp.get(e.wid);
    let color, r = 7;
    if (e.kind === 'npc' && e.name && e.name.indexOf('商店') !== -1) {
      // 商店 NPC：紫色描边 + 钱袋角标
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (boss) { color = '#7f1d1d'; r = 14; }                 // 世界 Boss：暗红大圆
    else if (e.kind === 'player') { color = '#34d399'; r = 7; }   // 绿色
    else if (e.kind === 'npc') { color = '#60a5fa'; r = 6; } // 蓝色
    else if (e.kind === 'item') {                            // 掉落物：物品=金色菱形 / 金币=黄色圆点
      color = e.itemId ? '#fbbf24' : '#fde047';
      r = 5;
    }
    else { color = '#f87171'; r = 6; }                        // 红色（怪物）
    // 影子（俯视投影）
    ctx.beginPath();
    ctx.arc(x + 1.5, y + 1.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (boss) {
      // Boss：死亡置灰 + 头顶血条（全区共享）
      const dead = boss.state === 2;
      if (dead) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#444'; ctx.fill();
        ctx.globalAlpha = 1;
      }
      const barW = 40, barH = 5;
      const bx = x - barW / 2, by = y - r - 12;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
      ctx.fillStyle = '#e11d48';
      ctx.fillRect(bx, by, barW, barH);
      const pct = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(bx, by, barW * pct, barH);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${boss.name || 'Boss'} Lv.${boss.phase} ${Math.round(boss.hp)}/${Math.round(boss.maxHp)}`, x, by - 4);
    } else if (e.kind === 'item') {
      // 掉落物：显示物品名/金币数量（闪烁提示）
      const label = e.itemId ? (ITEM_NAMES[e.itemId] || '物品') : `${e.gold} 金币`;
      ctx.fillStyle = 'rgba(253,224,71,0.95)';
      ctx.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - 12);
    } else if (e.name) {
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
  /** 同步世界 Boss 共享状态（S2C_BOSS；wid→血量/阶段） */
  function setBossState(b) {
    if (!b || !b.wid) return;
    bossHp.set(b.wid, { hp: b.hp, maxHp: b.maxHp, state: b.state, phase: b.phase, name: b.name });
  }

  // 调试/测试钩子：返回当前效果快照（供浏览器 E2E 断言）
  function fxSnapshot() {
    return effects.map((e) => ({ kind: e.kind, x: +e.x.toFixed(1), z: +e.z.toFixed(1), radius: e.radius, color: e.color, durMs: e.durMs }));
  }
  return {
    canvas, ctx, updateTerrain, setSelf, setEntities, setBossState, draw, resize,
    addSkillEffect, clearCasting, showAoePreview, fxSnapshot,
  };
}
