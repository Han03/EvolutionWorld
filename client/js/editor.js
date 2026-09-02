/**
 * editor.js - EvolutionWorld 地形编辑器
 * 俯视 2D 画刷编辑器：浅灰=可通行 / 白色=空洞（不可通行）。
 * 画刷：抬高 / 降低 / 铺平 / 平滑 / 删除地区(挖空) / 增加地区(恢复)
 * 参数：大小(半径,米) / 力度(米/次) / 强度曲线(硬边/平滑边) / 铺平目标高度
 * 交互：左键拖动 = 应用画刷；右键拖动 = 平移；滚轮 = 缩放。
 * 编辑数据与服务端 terrain.cpp / 游戏客户端 terrain.js **同源**（同一 edit layer + 同一程序化地形），
 * 保存后立即对服务端运行时地形生效。
 */
import {
  terrainHeight, terrainBlocked, setEditCell, clearEdit, loadEditCells,
  getEditCells, editCellCount, WATER_LEVEL,
} from './terrain.js';

const $ = (id) => document.getElementById(id);
const BASE = '';
const WORLD = 128;      // 编辑世界范围 [-128,128] 米（覆盖可到达走廊 + 空洞）
const GRID = 256;       // 俯视渲染格子数（每格 1 米，整格 = floor 坐标）

let token = '';
let username = '';
let editing = false;

// ---- 视图（世界坐标中心 + 缩放） ----
const view = { cx: 0, cz: 0, scale: 3 }; // scale = 像素/米
let panning = false, lastPan = { x: 0, y: 0 };

// ---- 画刷 ----
const brush = {
  type: 'raise',
  radius: 4,
  strength: 1.2,
  falloff: 'soft',
  targetH: 8,
};
let showHeight = false;
let hoverWorld = { x: 0, z: 0, in: false };

// ---- 撤销/重做 ----
let undoStack = [];
let redoStack = [];
function snapshot() { return JSON.stringify(getEditCells()); }
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  refreshButtons();
}
function restore(snap) {
  const cells = snap ? JSON.parse(snap).cells : null;
  loadEditCells(cells);
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  refreshButtons(); redraw();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  refreshButtons(); redraw();
}
function refreshButtons() {
  $('btn-undo').disabled = undoStack.length === 0;
  $('btn-redo').disabled = redoStack.length === 0;
}

// ---- 画布 ----
const canvas = $('editor-canvas');
const ctx = canvas.getContext('2d');
let img = null, imgData = null;

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.max(2, Math.floor(w * dpr));
  canvas.height = Math.max(2, Math.floor(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  img = ctx.createImageData(canvas.width, canvas.height);
  imgData = img.data;
}

// 世界格 -> 屏幕像素
function w2s(wx, wz) {
  return {
    x: (wx - view.cx) * view.scale + canvas.width / 2 / Math.min(window.devicePixelRatio || 1, 2) * (1) + 0,
    y: (wz - view.cz) * view.scale + canvas.height / 2 / Math.min(window.devicePixelRatio || 1, 2),
  };
}
// 屏幕像素 -> 世界坐标
function s2w(px, py) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return {
    x: (px - canvas.width / dpr / 2) / view.scale + view.cx,
    z: (py - canvas.height / dpr / 2) / view.scale + view.cz,
  };
}
// 高度 -> 浅灰明暗（可选色带辅助编辑）
function grayFor(h) {
  let g = 196;
  if (showHeight) {
    const u = Math.max(0, Math.min(1, (h + 2) / 36)); // -2..34
    g = Math.round(150 + u * 70);
  }
  return g;
}
function drawCellPx(px, py, r, g, b) {
  const idx = (py * canvas.width + px) * 4;
  imgData[idx] = r; imgData[idx + 1] = g; imgData[idx + 2] = b; imgData[idx + 3] = 255;
}
function redraw() {
  if (!img) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.width, h = canvas.height;
  const halfW = w / 2, halfH = h / 2;
  // 背景白色（空洞区）
  imgData.fill(255);
  for (let py = 0; py < h; py += dpr) {
    const wz = (py / dpr - halfH / dpr) / view.scale + view.cz;
    const gz = Math.floor(wz);
    if (gz < -WORLD || gz >= WORLD) continue;
    for (let px = 0; px < w; px += dpr) {
      const wx = (px / dpr - halfW / dpr) / view.scale + view.cx;
      const gx = Math.floor(wx);
      if (gx < -WORLD || gx >= WORLD) continue;
      if (terrainBlocked(gx + 0.5, gz + 0.5)) continue; // 空洞/河流/悬崖：白色
      const g = grayFor(terrainHeight(gx + 0.5, gz + 0.5));
      drawCellPx(px, py, g, g, g);
    }
  }
  ctx.putImageData(img, 0, 0);
  // 网格线（大格 10m）
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 10 / view.scale;
  if (step >= 6) {
    for (let gx = Math.floor(view.cx - halfW / dpr / view.scale / 10) * 10; gx <= view.cx + halfW / dpr / view.scale; gx += 10) {
      const sx = (gx - view.cx) * view.scale + halfW / dpr;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, h / dpr);
    }
    for (let gz = Math.floor(view.cz - halfH / dpr / view.scale / 10) * 10; gz <= view.cz + halfH / dpr / view.scale; gz += 10) {
      const sy = (gz - view.cz) * view.scale + halfH / dpr;
      ctx.moveTo(0, sy); ctx.lineTo(w / dpr, sy);
    }
  }
  ctx.stroke();
  // 坐标轴
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ox = (0 - view.cx) * view.scale + halfW / dpr;
  const oy = (0 - view.cz) * view.scale + halfH / dpr;
  if (ox >= 0 && ox <= w / dpr) { ctx.moveTo(ox, 0); ctx.lineTo(ox, h / dpr); }
  if (oy >= 0 && oy <= h / dpr) { ctx.moveTo(0, oy); ctx.lineTo(w / dpr, oy); }
  ctx.stroke();
  // 主城标记
  const tw = w2s(0, 0);
  ctx.fillStyle = '#2f6fed';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('主城', tw.x, tw.y - 4);
  ctx.strokeStyle = '#2f6fed';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(tw.x, tw.y, 5, 0, Math.PI * 2);
  ctx.stroke();
  // 画刷预览（光标处）
  if (hoverWorld.in) {
    const s = w2s(hoverWorld.x, hoverWorld.z);
    const R = brush.radius * view.scale;
    ctx.strokeStyle = 'rgba(255,45,45,0.9)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(2, R), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,45,45,0.15)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(2, R), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- 画刷应用 ----
function applyBrushAt(wx, wz, push = false) {
  if (push) pushHistory();
  const r = brush.radius;
  const x0 = Math.floor(wx - r), x1 = Math.floor(wx + r);
  const z0 = Math.floor(wz - r), z1 = Math.floor(wz + r);
  const falloffHard = brush.falloff === 'hard';
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const d = Math.hypot(gx + 0.5 - wx, gz + 0.5 - wz);
      if (d > r) continue;
      let fo = 1;
      if (!falloffHard && r > 0.01) fo = Math.max(0, Math.min(1, 1 - d / r));
      fo *= fo * (3 - 2 * fo); // smoothstep
      const cx = gx + 0.5, cz = gz + 0.5;
      switch (brush.type) {
        case 'raise':
          setEditCell(cx, cz, { h: terrainHeight(cx, cz) + brush.strength * fo });
          break;
        case 'lower':
          setEditCell(cx, cz, { h: terrainHeight(cx, cz) - brush.strength * fo });
          break;
        case 'flatten':
          setEditCell(cx, cz, { h: brush.targetH });
          break;
        case 'smooth': {
          // 8 邻域平均（当前有效高度）
          let sum = 0, n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              sum += terrainHeight(cx + dx, cz + dz); n++;
            }
          }
          setEditCell(cx, cz, { h: sum / n });
          break;
        }
        case 'void':
          setEditCell(cx, cz, { v: 1 });
          break;
        case 'fill': {
          const cur = terrainHeight(cx, cz);
          const h = Math.max(cur, WATER_LEVEL + 1.5); // 保证可站立（填河造陆自动抬到水面以上）
          setEditCell(cx, cz, { h, v: 0 });
          break;
        }
      }
    }
  }
}

// ---- 输入事件 ----
function onMouseMove(ev) {
  const rect = canvas.getBoundingClientRect();
  const wx = s2w(ev.clientX - rect.left, ev.clientY - rect.top).x;
  const wz = s2w(ev.clientX - rect.left, ev.clientY - rect.top).z;
  hoverWorld.x = wx; hoverWorld.z = wz; hoverWorld.in = true;
  $('editor-coord').textContent =
    `x:${Math.floor(wx)} z:${Math.floor(wz)} h:${terrainHeight(wx, wz).toFixed(1)} ${terrainBlocked(wx, wz) ? '■空洞' : '·可通行'} 编辑格:${editCellCount()}`;
  if (panning) {
    view.cx -= (ev.clientX - lastPan.x) / view.scale;
    view.cz -= (ev.clientY - lastPan.y) / view.scale;
    lastPan = { x: ev.clientX, y: ev.clientY };
    redraw();
    return;
  }
  if (editing) {
    applyBrushAt(wx, wz, false);
    redraw();
  }
  redraw();
}
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mousedown', (ev) => {
  if (ev.button === 2) { panning = true; lastPan = { x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const { x, z } = s2w(ev.clientX - rect.left, ev.clientY - rect.top);
  applyBrushAt(x, z, true);
  editing = true;
  redraw();
});
window.addEventListener('mouseup', (ev) => { editing = false; panning = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('mouseleave', () => { hoverWorld.in = false; redraw(); });
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const { x, z } = s2w(ev.clientX - rect.left, ev.clientY - rect.top);
  const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.scale = Math.max(0.4, Math.min(12, view.scale * k));
  // 以光标为中心缩放
  view.cx = x - (x - view.cx) / k;
  view.cz = z - (z - view.cz) / k;
  redraw();
}, { passive: false });

// ---- 工具栏绑定 ----
function bindTools() {
  document.querySelectorAll('input[name="brush"]').forEach((el) => {
    el.addEventListener('change', () => { brush.type = el.value; redraw(); });
  });
  const radius = $('brush-radius'), strength = $('brush-strength');
  radius.addEventListener('input', () => { brush.radius = parseFloat(radius.value); $('brush-radius-v').textContent = brush.radius + 'm'; redraw(); });
  strength.addEventListener('input', () => { brush.strength = parseFloat(strength.value); $('brush-strength-v').textContent = brush.strength; });
  $('brush-falloff').addEventListener('change', (e) => { brush.falloff = e.target.value; });
  $('brush-target').addEventListener('input', (e) => { brush.targetH = parseFloat(e.target.value) || 0; });
  $('show-height').addEventListener('change', (e) => { showHeight = e.target.checked; redraw(); });
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('清除全部编辑，还原为程序化地形？此操作会覆盖服务器上的编辑层。')) return;
    clearEdit();
    await saveToServer();
    redraw();
  });
  $('btn-save').addEventListener('click', async () => {
    setStatus('保存中…');
    const ok = await saveToServer();
    setStatus(ok ? `已保存 ${editCellCount()} 个编辑格，运行时地形已更新` : '保存失败（见上方）');
  });
}
function setStatus(text) { $('editor-status').textContent = text; }

async function saveToServer() {
  try {
    const r = await fetch(BASE + '/api/terrain/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, cells: getEditCells() }),
    });
    const j = await r.json();
    return !!j.ok;
  } catch (e) { return false; }
}

// ---- 登录 ----
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
async function enterEditor(j) {
  token = j.token;
  username = j.user.username;
  $('editor-login').classList.add('hidden');
  $('editor-app').classList.remove('hidden');
  $('editor-user-name').textContent = username;
  // 编辑器主体此前是 display:none（clientWidth=0），显示后必须重设画布尺寸与像素缓冲
  resizeCanvas();
  // 加载服务器上的既有编辑层
  try {
    const r = await fetch(BASE + '/api/terrain/edit');
    const jd = await r.json();
    if (jd && jd.ok) { loadEditCells(jd.cells); }
  } catch (e) {}
  $('editor-conn').textContent = `已连接 · 编辑格 ${editCellCount()}`;
  setStatus(`已加载服务器编辑层（${editCellCount()} 格）。左键拖动应用画刷，右键平移，滚轮缩放。`);
  refreshButtons();
  redraw();
}
function loginMsg(text, ok) {
  const el = $('editor-login-msg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}
async function doLogin() {
  loginMsg('登录中…', false);
  const username = $('editor-user').value.trim();
  const password = $('editor-pass').value;
  if (!username || !password) { loginMsg('请输入账号密码', false); return; }
  try {
    const j = await post('/api/login', { username, password });
    if (j.ok) { await enterEditor(j); }
    else loginMsg(j.error || '登录失败', false);
  } catch (e) { loginMsg('网络错误', false); }
}
$('editor-login-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
$('editor-login-btn').addEventListener('click', doLogin);
$('editor-register').addEventListener('click', async () => {
  const username = $('editor-user').value.trim();
  const password = $('editor-pass').value;
  if (!username || !password) { loginMsg('请输入账号密码', false); return; }
  const j = await post('/api/register', { username, password }).catch(() => ({ ok: false, error: '网络错误' }));
  loginMsg(j.ok ? '注册成功，请登录' : (j.error || '注册失败'), !!j.ok);
});

// ---- 初始化 ----
window.addEventListener('resize', () => { resizeCanvas(); redraw(); });
resizeCanvas();
bindTools();
refreshButtons();
