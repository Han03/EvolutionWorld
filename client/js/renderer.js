// renderer.js - 大型 MMO 2.5D 渲染器（Canvas 2D，无需 WebGL）
// 地形渲染委托给共享 terrain-renderer.js（与编辑器 editor.js 同源同构）。
// 本模块负责：实体 2.5D 投影与深度排序、技能效果、世界 Boss、自身角色绘制。
import { TerrainRenderer } from './terrain-renderer.js';
import { terrainHeight } from './terrain.js';

// ---- 渲染参数 ----
const VIEW_RANGE_M = 100; // 可见范围（与服务端 viewRange 一致，超出卸载）
const ENTITY_PX = 16;     // 实体像素比例（px/米，Sprite 略大于地形格，经典 MMO 表现）
const DEATH_ANIM_MS = 1100; // 死亡动画时长（与服务端实体管理器一致）

export function createRenderer(container) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  container.appendChild(canvas);

  // 共享地形渲染器
  const tr = new TerrainRenderer({ canvas, worldSize: 128 });

  function resize() {
    tr.resize();
  }
  resize();
  window.addEventListener('resize', resize);

  // 运行时状态（每帧由 boot 同步）
  const state = { selfX: 0, selfY: 5, selfZ: 0, self: null, entities: [], clickTarget: null };

  // 技能简易效果（前摇进度圈 / AOE 范围圈 / 打断闪红）：
  //   {kind:'cast'|'aoe'|'cancel', wid, x, z, radius, color, startMs, durMs}
  const effects = [];
  /** 添加技能效果（boot.js 由 EVT_SKILL_CASTING/EVT_SKILL/EVT_SKILL_CANCEL 与本地施放触发） */
  function addSkillEffect(eff) {
    if (eff.kind === 'cast') {
      for (let i = effects.length - 1; i >= 0; i--) {
        if (effects[i].kind === 'cast' && effects[i].wid === eff.wid) effects.splice(i, 1);
      }
    }
    effects.push(Object.assign({ startMs: performance.now(), durMs: 800, color: '#ffd166', radius: 0 }, eff));
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

  // 世界 Boss 共享状态
  const bossHp = new Map(); // wid -> {hp,maxHp,state,phase,name}

  // ---- 相机（通过 TerrainRenderer 管理） ----
  // 世界坐标 -> 屏幕坐标（使用 TerrainRenderer 的投影）
  function sx(wx, wz) {
    const p = tr.w2s(wx, wz);
    return p.x;
  }
  function sy(wx, wy, wz) {
    const h = terrainHeight(wx, wz);
    const p = tr.w2s(wx, wz);
    // w2s 使用的是 terrainHeight(wx,wz)，但实体可能在不同高度
    // 需要校正高度差
    return p.y - (wy - h) * tr.cam.zoom * 5; // HS=5
  }

  // ---- 等距投影辅助 ----
  function ellipsePath(wx, wy, wz, r) {
    const x = sx(wx, wz), y = sy(wx, wy, wz);
    const zr = tr.cam.zoom;
    ctx.beginPath();
    ctx.ellipse(x, y, r * ENTITY_PX * zr, r * ENTITY_PX * 0.5 * zr, 0, 0, Math.PI * 2);
    return [x, y];
  }

  // ---- 地形更新（每帧由 boot 调用） ----
  function updateTerrain(selfX, selfZ) {
    state.selfX = selfX;
    state.selfZ = selfZ;
    // 同步相机到玩家位置
    tr.cam.cx = selfX;
    tr.cam.cz = selfZ;
    // 更新区块
    tr.updateChunks(selfX, selfZ, VIEW_RANGE_M);
  }

  // ---- 主绘制 ----
  function draw() {
    const w = tr.cssWidth, h = tr.cssHeight;
    tr.clear(ctx);
    // 背景（白色打底：空洞区透出白色，形成「路径地图」观感）
    tr.drawBackground(ctx);
    // 1) 地形区块（共享 TerrainRenderer）
    tr.drawChunks(ctx);
    // 1.5) AOE 范围圈（地面层，实体之下）
    drawAoeEffects(performance.now());
    // 1.6) 鼠标点击移动目标标记（地面层）
    drawClickTarget(performance.now());
    // 2) 实体（2.5D 投影 + 深度排序，远→近）
    const ents = [...state.entities];
    ents.sort((a, b) => (a.x + a.z) - (b.x + b.z));
    for (const e of ents) drawEntity(e);
    // 2.5) 前摇进度圈 + 打断闪红（实体之上）
    drawCastEffects(performance.now());
    // 3) 自身（橙色圆球 + 半透明白色描边，始终居中可见）
    if (state.self) {
      const x = w / 2, y = h / 2;
      const zr = tr.cam.zoom;
      // 影子
      const gy0 = terrainHeight(state.self.x, state.self.z);
      const sh = ellipsePath(state.self.x, gy0, state.self.z, state.self.radius || 0.55);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill();
      // 本体（高度投影）
      const bx = sx(state.self.x, state.self.z);
      const by = sy(state.self.x, state.self.y, state.self.z);
      const r = (state.self.radius || 0.55) * ENTITY_PX * zr;
      drawBall(bx, by, r, '#ff8c1a', 'rgba(255,255,255,0.5)', 2);
      // 名字
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `${Math.round(11 * zr)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(state.self.name || '你', x, by - r - 6);
      // 死亡状态
      if (state.self.dead) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = '#666';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---- 技能效果绘制（等距椭圆） ----
  function drawAoeEffects(now) {
    const zr = tr.cam.zoom;
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind !== 'aoe') continue;
      const life = (now - ef.startMs) / ef.durMs;
      if (life >= 1) { effects.splice(i, 1); continue; }
      const gy0 = terrainHeight(ef.x, ef.z);
      const [x, y] = ellipsePath(ef.x, gy0, ef.z, ef.radius);
      const R = Math.max(4, ef.radius * ENTITY_PX * zr);
      const alpha = Math.max(0, 1 - life) * 0.9;
      ctx.beginPath();
      ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(ef.color, 0.16 * alpha);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(ef.color, 0.85 * alpha);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ef.radius >= 2) {
        ctx.fillStyle = hexToRgba(ef.color, 0.9 * alpha);
        ctx.font = `${Math.round(10 * zr)}px "PingFang SC",sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${ef.radius}m`, x, y + 4);
      }
    }
  }
  function drawCastEffects(now) {
    const zr = tr.cam.zoom;
    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      if (ef.kind === 'cast') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const [x, y] = ellipsePath(ef.x, terrainHeight(ef.x, ef.z) + 1.2, ef.z, 1.6);
        const R = Math.max(16 * zr, 1.6 * ENTITY_PX * zr);
        // 范围指示器（技能作用范围边框 + 前摇填充）
        if (ef.radius > 0 && ef.casterWid) {
          let cx = ef.x, cz = ef.z;
          for (const e of state.entities) {
            if (e.wid === ef.casterWid) { cx = e.x; cz = e.z; break; }
          }
          const gy = terrainHeight(cx, cz);
          const [ccx, ccy] = ellipsePath(cx, gy, cz, ef.radius);
          const rr = Math.max(4, ef.radius * ENTITY_PX * zr);
          const col = ef.color || '#f87171';
          // 范围边框（虚线椭圆）
          ctx.beginPath();
          ctx.ellipse(ccx, ccy, rr, rr * 0.5, 0, 0, Math.PI * 2);
          ctx.strokeStyle = hexToRgba(col, 0.5);
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          // 前摇填充（向目标方向逐渐扩展的扇形）
          const dir = Math.atan2(cz - ef.z, cx - ef.x) + Math.PI; // 施法者→目标方向
          const sweep = Math.PI * 2 * Math.min(1, life);
          ctx.beginPath();
          ctx.moveTo(ccx, ccy);
          ctx.ellipse(ccx, ccy, rr, rr * 0.5, 0, dir, dir + sweep);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(col, 0.15 + 0.15 * life);
          ctx.fill();
        }
        // 前摇进度圈（目标位置）
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, life));
        ctx.strokeStyle = ef.color || '#ffd166';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(x, y, 4 * zr, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(ef.color || '#ffd166', 0.9);
        ctx.fill();
      } else if (ef.kind === 'cancel') {
        const life = (now - ef.startMs) / ef.durMs;
        if (life >= 1) { effects.splice(i, 1); continue; }
        const [x, y] = ellipsePath(ef.x, terrainHeight(ef.x, ef.z) + 1.2, ef.z, 1.6);
        const R = Math.max(16 * zr, 1.6 * ENTITY_PX * zr);
        ctx.beginPath();
        ctx.ellipse(x, y, R, R * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248,113,113,${0.9 * (1 - life)})`;
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    }
  }
  /** 鼠标点击移动目标标记（脉冲绿色小圆 + 十字线） */
  function drawClickTarget(now) {
    const t = state.clickTarget;
    if (!t) return;
    const zr = tr.cam.zoom;
    const gy = terrainHeight(t.x, t.z);
    const [px, py] = ellipsePath(t.x, gy, t.z, 0.5);
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.006);
    const R = Math.max(6, 0.5 * ENTITY_PX * zr);
    // 外圆脉冲
    ctx.beginPath();
    ctx.ellipse(px, py, R * pulse, R * 0.5 * pulse, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(74,222,128,${0.7 * pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 十字线
    const cr = R * 0.4;
    ctx.beginPath();
    ctx.moveTo(px - cr, py); ctx.lineTo(px + cr, py);
    ctx.moveTo(px, py - cr * 0.5); ctx.lineTo(px, py + cr * 0.5);
    ctx.strokeStyle = 'rgba(74,222,128,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function hexToRgba(hex, a) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // 物品名映射（由 boot.js 填充）
  const ITEM_NAMES = (typeof window !== 'undefined' && window.__itemNames) || {};

  // 立体圆球（径向渐变，伪 3D）
  function drawBall(x, y, r, color, outline, lw) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, lightenHex(color, 0.35));
    g.addColorStop(0.6, color);
    g.addColorStop(1, lightenHex(color, -0.45));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = lw || 1.4;
      ctx.stroke();
    }
  }
  function lightenHex(hex, k) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    let n = parseInt(h, 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + Math.round(255 * k)));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + Math.round(255 * k)));
    const b = Math.max(0, Math.min(255, (n & 255) + Math.round(255 * k)));
    return `rgb(${r},${g},${b})`;
  }

  function drawEntity(e) {
    const boss = bossHp.get(e.wid);
    const zr = tr.cam.zoom;
    let color, r;
    if (boss) { color = '#7f1d1d'; r = 1.4; }
    else if (e.kind === 'player') { color = '#34d399'; r = 0.55; }
    else if (e.kind === 'npc') { color = '#60a5fa'; r = 0.5; }
    else if (e.kind === 'item') { color = e.itemId ? '#fbbf24' : '#fde047'; r = 0.4; }
    else { color = '#f87171'; r = 0.5; }

    // 商店 NPC：紫色描边
    if (e.kind === 'npc' && e.name && e.name.indexOf('商店') !== -1) {
      const rp = r * ENTITY_PX * zr;
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(sx(e.x, e.z), sy(e.x, e.y + 1.2, e.z), rp + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 死亡动画进度（淡出 + 下沉）
    let alpha = 1;
    let bodyY = e.y;
    if (e.dying) {
      const t = Math.max(0, Math.min(1, (performance.now() - (e.dyingAt || 0)) / DEATH_ANIM_MS));
      alpha = 1 - t * t;
      bodyY = (e.dieY || e.y) - t * 1.4;
      color = '#777';
    }
    if (alpha <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    // 影子（地面投影）
    const gy0 = terrainHeight(e.x, e.z);
    const shR = r * ENTITY_PX * zr;
    ctx.beginPath();
    ctx.ellipse(sx(e.x, e.z), sy(e.x, gy0, e.z), shR, shR * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fill();
    // 本体（高度投影，2.5D）
    const x = sx(e.x, e.z);
    const y = sy(e.x, bodyY, e.z);
    const pr = r * ENTITY_PX * zr;
    if (e.kind === 'item') {
      // 掉落物：菱形
      ctx.beginPath();
      ctx.moveTo(x, y - pr);
      ctx.lineTo(x + pr * 0.6, y);
      ctx.lineTo(x, y + pr);
      ctx.lineTo(x - pr * 0.6, y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const label = e.itemId ? (ITEM_NAMES[e.itemId] || '物品') : `${e.gold} 金币`;
      ctx.fillStyle = 'rgba(253,224,71,0.95)';
      ctx.font = `bold ${Math.round(10 * zr)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - pr - 4);
    } else {
      drawBall(x, y, pr, color, e.kind === 'player' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.4)', 1.4);
      if (boss) {
        const dead = boss.state === 2 || e.dying;
        if (dead) {
          ctx.globalAlpha = alpha * 0.35;
          ctx.beginPath();
          ctx.arc(x, y, pr, 0, Math.PI * 2);
          ctx.fillStyle = '#444';
          ctx.fill();
          ctx.globalAlpha = alpha;
        }
        const barW = 40 * zr, barH = 5 * zr;
        const bx = x - barW / 2, by = y - pr - 12 * zr;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = '#e11d48';
        ctx.fillRect(bx, by, barW, barH);
        const pct = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
        ctx.fillStyle = '#4ade80';
        ctx.fillRect(bx, by, barW * pct, barH);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(10 * zr)}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${boss.name || 'Boss'} Lv.${boss.phase} ${Math.round(boss.hp)}/${Math.round(boss.maxHp)}`, x, by - 4);
      } else if (e.name && !e.dying) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = `${Math.round(10 * zr)}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(e.name, x, y - pr - 4);
      }
    }
    ctx.restore();
  }

  /** 同步自身（相机跟随/中心绘制） */
  function setSelf(x, y, z, name, dead) {
    state.selfX = x; state.selfY = y; state.selfZ = z;
    state.self = { x, y, z, name, radius: 0.55, dead: !!dead };
  }
  /** 同步可见实体列表 */
  function setEntities(list) {
    state.entities = list;
  }
  /** 同步鼠标点击移动目标（渲染目标标记） */
  function setClickTarget(target) {
    state.clickTarget = target;
  }
  /** 同步世界 Boss 共享状态 */
  function setBossState(b) {
    if (!b || !b.wid) return;
    bossHp.set(b.wid, { hp: b.hp, maxHp: b.maxHp, state: b.state, phase: b.phase, name: b.name });
  }
  // 调试/测试钩子
  function fxSnapshot() {
    return effects.map((e) => ({ kind: e.kind, x: +e.x.toFixed(1), z: +e.z.toFixed(1), radius: e.radius, color: e.color, durMs: e.durMs }));
  }

  return {
    canvas, ctx, updateTerrain, setSelf, setEntities, setClickTarget, setBossState, draw, resize,
    addSkillEffect, clearCasting, showAoePreview, fxSnapshot,
    /** 暴露共享地形渲染器（供外部高级用法） */
    terrainRenderer: tr,
  };
}
