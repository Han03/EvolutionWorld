/**
 * editor-terrain.js — 地形画刷 + 撤销重做 + 地形保存 + 渲染帧
 * 依赖注入：由 editor.js 调用 configure() 传入共享依赖。
 */
import {
  terrainHeight, terrainBlocked, setEditCell, clearEdit, loadEditCells,
  getEditCells, editCellCount, WATER_LEVEL, loadWalkMask,
} from './terrain.js';
import { S } from './editor-state.js';

// ---- 注入的依赖（由 configure 设置） ----
let $, authedPost, refreshButtons;

export function configure(deps) {
  $ = deps.$;
  authedPost = deps.authedPost;
  refreshButtons = deps.refreshButtons;
}

// ============================================================================
// 撤销/重做（仅地形）
// ============================================================================
function snapshot() { return JSON.stringify(getEditCells()); }

export function pushHistory() {
  S.undoStack.push(snapshot());
  if (S.undoStack.length > 60) S.undoStack.shift();
  S.redoStack = [];
  refreshButtons();
}

function restore(snap) { loadEditCells(snap ? JSON.parse(snap).cells : null); }

export function undo() {
  if (!S.undoStack.length) return;
  S.redoStack.push(snapshot());
  restore(S.undoStack.pop());
  refreshButtons();
  S.tr.invalidateTerrain();
}

export function redo() {
  if (!S.redoStack.length) return;
  S.undoStack.push(snapshot());
  restore(S.redoStack.pop());
  refreshButtons();
  S.tr.invalidateTerrain();
}

export function refreshUndoButtons() {
  $('btn-undo').disabled = S.undoStack.length === 0;
  $('btn-redo').disabled = S.redoStack.length === 0;
}

// ============================================================================
// 高度色带图例
// ============================================================================
export function updateLegend() {
  const legend = $('editor-legend');
  if (!S.showHeight) { legend.classList.add('hidden'); return; }
  legend.classList.remove('hidden');
  if (legend.innerHTML.trim() === '') {
    legend.innerHTML = '高度色带（米）<div class="legend-bar"></div><div class="legend-scale"><span>-2</span><span>10</span><span>22</span><span>34</span></div>';
  }
}

// ============================================================================
// 渲染循环
// ============================================================================
export function frame() {
  if (!S.running || !S.tr) return;
  S.tr.resize();
  S.tr.setSpawnMarkers(S.spawns.map((sp, i) => ({ ...sp, _selected: i === S.selectedSpawn })));
  if (S.mode === 'terrain' && S.hoverWorld.in && !['select', 'place'].includes(S.brush.type)) {
    S.tr.setBrushPreview(S.hoverWorld.x, S.hoverWorld.z, S.brush.radius);
  } else {
    S.tr.setBrushPreview(0, 0, 0);
  }
  S.tr.render();
  // 不再自驱动 rAF：由 editor.js 主循环（editorLoop：panKey + frame）统一驱动，
  // 避免双 rAF 争抢主线程导致 WASD 输入无响应。
}

// ============================================================================
// 画刷应用
// ============================================================================
export function applyBrushAt(wx, wz, pushHist = false) {
  if (pushHist) pushHistory();
  const r = S.brush.radius;
  const x0 = Math.floor(wx - r), x1 = Math.floor(wx + r);
  const z0 = Math.floor(wz - r), z1 = Math.floor(wz + r);
  const falloffHard = S.brush.falloff === 'hard';
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      const d = Math.hypot(gx + 0.5 - wx, gz + 0.5 - wz);
      if (d > r) continue;
      let fo = 1;
      if (!falloffHard && r > 0.01) fo = Math.max(0, Math.min(1, 1 - d / r));
      fo *= fo * (3 - 2 * fo);
      const cx = gx + 0.5, cz = gz + 0.5;
      switch (S.brush.type) {
        case 'raise': setEditCell(cx, cz, { h: terrainHeight(cx, cz) + S.brush.strength * fo }); break;
        case 'lower': setEditCell(cx, cz, { h: terrainHeight(cx, cz) - S.brush.strength * fo }); break;
        case 'flatten': setEditCell(cx, cz, { h: S.brush.targetH }); break;
        case 'smooth': {
          let sum = 0, n = 0;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            sum += terrainHeight(cx + dx, cz + dz); n++;
          }
          setEditCell(cx, cz, { h: sum / n });
          break;
        }
        case 'void': setEditCell(cx, cz, { v: 1 }); break;
        case 'fill': {
          const cur = terrainHeight(cx, cz);
          setEditCell(cx, cz, { h: Math.max(cur, WATER_LEVEL + 1.5), v: 0 });
          break;
        }
      }
    }
  }
  S.tr.invalidateTerrain();
}

// ============================================================================
// 地形保存
// ============================================================================
export async function saveTerrain() {
  try {
    const j = await authedPost('/api/terrain/edit', { token: S.token, cells: getEditCells() });
    return j.ok === true;
  } catch (e) { return false; }
}

// 导出 terrain 相关工具供其他模块使用
export { terrainHeight, terrainBlocked, editCellCount, clearEdit, loadEditCells, loadWalkMask };
