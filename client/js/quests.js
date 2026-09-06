/**
 * quests.js - 任务系统客户端 UI（任务面板 + 追踪 HUD + 协议解析）
 *
 * 数据流：服务端 S2C_QUEST_* → 解析 → 更新 UI
 *         用户操作 → C2S_QUEST_* → 服务端
 */
import { MSG, Reader, Writer } from './protocol.js';

// 任务分类名称
const CATEGORY_NAMES = { 1: '主线', 2: '支线', 3: '日常', 4: '可重复' };
const CATEGORY_COLORS = { 1: '#ffd700', 2: '#88bbff', 3: '#88ff88', 4: '#cc88ff' };
// 目标类型名称
const OBJ_TYPE_NAMES = { 1: '击杀', 2: '收集', 3: '到达', 4: '对话', 5: '护送' };
// 操作码
const QUEST_OP = { ACCEPT: 0, ABANDON: 1, TURNIN: 2, LIST: 3 };
// 结果码
const QUEST_RESULT_CODE = {
  0: '成功', 1: '任务不存在', 2: '已在进行中', 3: '前置任务未完成',
  4: '等级不足', 5: '任务栏已满', 6: '任务不在进行中', 7: '目标未完成',
  8: '不在 NPC 范围', 9: '冷却中', 10: '不可重复', 11: '不在发布者 NPC 范围',
};

// ---------- 状态 ----------
let questList = [];      // 可接任务列表 [{questId, category, name, desc, levelReq, giverNpcWid, objectives, rewards, nextQuestIds}]
let questProgress = [];  // 活跃任务 [{questId, status, objectives: [{current, required}]}]
let questCompleted = []; // 已完成任务 [{questId, category, name, desc}]
let questPanelOpen = false;
let questTab = 'active'; // available / active / completed
let currentNpcFilter = 0; // NPC 过滤模式：0=全部，>0=指定 NPC wid
let _questNav = null;      // QuestNavigator 实例（由 boot.js 注入）

/** 注入任务导航器（boot.js 初始化后调用） */
export function setQuestNavigator(nav) { _questNav = nav; }

// ---------- 协议解析 ----------

/** 解析 S2C_QUEST_LIST（含 giverNpcWid + nextQuestIds） */
export function decodeQuestList(r) {
  const count = r.u16();
  const list = [];
  for (let i = 0; i < count; i++) {
    const q = {
      questId: r.u32(),
      category: r.u8(),
      name: r.str(),
      desc: r.str(),
      levelReq: r.i32(),
      giverNpcWid: r.u32(), // 发布者 NPC wid
      objectives: [],
      rewards: { gold: 0, items: [], skills: [] },
      nextQuestIds: [],
    };
    const objCount = r.u16();
    for (let j = 0; j < objCount; j++) {
      q.objectives.push({
        type: r.u8(),
        targetId: r.u32(),
        required: r.u32(),
        desc: r.str(),
      });
    }
    q.rewards.gold = r.u32();
    const itemCount = r.u16();
    for (let j = 0; j < itemCount; j++) {
      q.rewards.items.push({ itemId: r.u32(), count: r.u16() });
    }
    const skillCount = r.u16();
    for (let j = 0; j < skillCount; j++) {
      q.rewards.skills.push(r.u32());
    }
    // 链式后续任务 ID
    const nextCount = r.u16();
    for (let j = 0; j < nextCount; j++) {
      q.nextQuestIds.push(r.u32());
    }
    list.push(q);
  }
  questList = list;
  if (questPanelOpen) renderQuestPanel();
  return list;
}

/** 解析 S2C_QUEST_PROGRESS（含任务名称/描述/目标详情 + 已完成任务摘要） */
export function decodeQuestProgress(r) {
  const count = r.u16();
  const prog = [];
  for (let i = 0; i < count; i++) {
    const q = {
      questId: r.u32(),
      status: r.u8(),
      name: r.str(),
      desc: r.str(),
      category: r.u8(),
      objectives: [],
    };
    const objCount = r.u16();
    for (let j = 0; j < objCount; j++) {
      q.objectives.push({
        current: r.u32(),
        required: r.u32(),
        type: r.u8(),
        desc: r.str(),
      });
    }
    prog.push(q);
  }
  questProgress = prog;
  // 已完成任务摘要（追加在活跃任务之后）
  const compCount = r.u16();
  const comp = [];
  for (let i = 0; i < compCount; i++) {
    comp.push({
      questId: r.u32(),
      category: r.u8(),
      name: r.str(),
      desc: r.str(),
    });
  }
  questCompleted = comp;
  updateQuestTracker();
  if (questPanelOpen) renderQuestPanel();
  return prog;
}

/** 解析 S2C_QUEST_RESULT */
export function decodeQuestResult(r) {
  const op = r.u8();
  const code = r.u8();
  const questId = r.u32();
  const opName = ['接受', '放弃', '提交', '列表'][op] || '操作';
  const msg = QUEST_RESULT_CODE[code] || '未知';
  if (code === 0) {
    showToast(`任务${opName}成功`);
  } else {
    showToast(`任务${opName}失败: ${msg}`);
  }
  return { op, code, questId };
}

/** 解析 S2C_QUEST_NOTIFY */
export function decodeQuestNotify(r) {
  const questId = r.u32();
  const objIndex = r.u8();
  const current = r.u32();
  const required = r.u32();
  const allComplete = r.u8() !== 0;
  // 进度更新提示
  showToast(`任务进度: ${current}/${required}${allComplete ? ' ✓ 可提交' : ''}`);
  return { questId, objIndex, current, required, allComplete };
}

/** 解析 S2C_QUEST_COMPLETE */
export function decodeQuestComplete(r) {
  const questId = r.u32();
  showToast('任务目标全部完成！可找 NPC 提交');
  return { questId };
}

/** 解析 S2C_QUEST_CHAIN（链式任务解锁通知） */
export function decodeQuestChain(r) {
  const completedId = r.u32();
  const count = r.u16();
  const nextIds = [];
  for (let i = 0; i < count; i++) nextIds.push(r.u32());
  // 显示链式解锁提示
  const names = nextIds.map(id => {
    const q = questList.find(lq => lq.questId === id);
    return q ? q.name : `任务#${id}`;
  });
  showToast(`🔗 新任务解锁: ${names.join('、')}`);
  return { completedId, nextIds };
}

// ---------- C2S 发送 ----------

export function sendQuestAccept(net, questId, npcWid = 0) {
  const w = new Writer();
  w.u32(questId);
  w.u32(npcWid);
  net.send(MSG.C2S_QUEST_ACCEPT, w.finish());
}

export function sendQuestAbandon(net, questId) {
  const w = new Writer();
  w.u32(questId);
  net.send(MSG.C2S_QUEST_ABANDON, w.finish());
}

export function sendQuestTurnIn(net, questId, npcWid) {
  const w = new Writer();
  w.u32(questId);
  w.u32(npcWid || 0);
  net.send(MSG.C2S_QUEST_TURNIN, w.finish());
}

export function sendQuestList(net, npcWid = 0) {
  const w = new Writer();
  w.u32(npcWid);
  net.send(MSG.C2S_QUEST_LIST, w.finish());
}

export function sendQuestTrack(net) {
  net.send(MSG.C2S_QUEST_TRACK, new Uint8Array(0));
}

export function sendTalkNpc(net, npcWid) {
  const w = new Writer();
  w.u32(npcWid);
  net.send(MSG.C2S_TALK_NPC, w.finish());
}

// ---------- UI 渲染 ----------

export function toggleQuestPanel() {
  questPanelOpen = !questPanelOpen;
  const panel = document.getElementById('quest-panel');
  if (panel) panel.classList.toggle('hidden', !questPanelOpen);
  if (questPanelOpen) {
    // 请求最新数据
    renderQuestPanel();
  }
}

export function closeQuestPanel() {
  questPanelOpen = false;
  const panel = document.getElementById('quest-panel');
  if (panel) panel.classList.add('hidden');
}

export function isQuestPanelOpen() { return questPanelOpen; }
export function getQuestList() { return questList; }
export function getQuestProgress() { return questProgress; }
export function getQuestCompleted() { return questCompleted; }
export function setNpcFilter(npcWid) { currentNpcFilter = npcWid; }

function renderQuestPanel() {
  const content = document.getElementById('quest-content');
  if (!content) return;
  // 更新 tab 样式
  document.querySelectorAll('.quest-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === questTab);
  });
  let html = '';
  if (questTab === 'available') {
    // 请求可接任务列表（按 NPC 过滤）
    if (questList.length === 0 && currentNpcFilter === 0) {
      html = '<div class="quest-empty">当前无可接任务</div>';
    } else if (questList.length === 0) {
      html = '<div class="quest-empty">该 NPC 当前无可接任务</div>';
    } else {
      for (const q of questList) {
        const catColor = CATEGORY_COLORS[q.category] || '#fff';
        const catName = CATEGORY_NAMES[q.category] || '未知';
        const giverText = q.giverNpcWid > 0 ? `<span class="quest-giver">发布: NPC#${q.giverNpcWid}</span>` : '';
        const chainText = q.nextQuestIds && q.nextQuestIds.length > 0
          ? `<span class="quest-chain">🔗 后续任务: ${q.nextQuestIds.length} 个</span>` : '';
        html += `<div class="quest-card" data-quest-id="${q.questId}">
          <div class="quest-card-header">
            <span class="quest-cat" style="color:${catColor}">[${catName}]</span>
            <span class="quest-name">${q.name}</span>
            <span class="quest-level">Lv${q.levelReq}</span>
          </div>
          <div class="quest-desc">${q.desc}</div>
          ${giverText ? `<div class="quest-meta">${giverText}</div>` : ''}
          ${chainText ? `<div class="quest-meta">${chainText}</div>` : ''}
          <div class="quest-objectives">`;
        for (const obj of q.objectives) {
          html += `<div class="quest-obj">${OBJ_TYPE_NAMES[obj.type] || '?'} ${obj.desc} (0/${obj.required})</div>`;
        }
        html += `</div><div class="quest-rewards">`;
        if (q.rewards.gold > 0) html += `<span class="quest-reward">💰 ${q.rewards.gold}</span>`;
        for (const item of q.rewards.items) {
          html += `<span class="quest-reward">🎁 ${item.itemId} x${item.count}</span>`;
        }
        for (const sid of q.rewards.skills) {
          html += `<span class="quest-reward">📖 技能#${sid}</span>`;
        }
        html += `</div>
          <button class="quest-btn quest-btn-accept" onclick="window.__questAccept(${q.questId})">接受</button>
        </div>`;
      }
    }
  } else if (questTab === 'active') {
    if (questProgress.length === 0) {
      html = '<div class="quest-empty">当前无进行中任务</div>';
    } else {
      for (const q of questProgress) {
        const name = q.name || `任务#${q.questId}`;
        const desc = q.desc || '';
        const catColor = CATEGORY_COLORS[q.category] || '#fff';
        const statusText = q.status === 1 ? '✅ 可提交' : '进行中';
        const statusClass = q.status === 1 ? 'quest-completable' : '';
        html += `<div class="quest-card ${statusClass}" data-quest-id="${q.questId}">
          <div class="quest-card-header">
            <span class="quest-cat" style="color:${catColor}">[${CATEGORY_NAMES[q.category] || '未知'}]</span>
            <span class="quest-name">${name}</span>
            <span class="quest-status">${statusText}</span>
          </div>
          <div class="quest-desc">${desc}</div>
          <div class="quest-objectives">`;
        for (const obj of q.objectives) {
          const done = obj.current >= obj.required;
          html += `<div class="quest-obj ${done ? 'quest-obj-done' : ''}">
            ${OBJ_TYPE_NAMES[obj.type] || '?'} ${obj.desc} (${obj.current}/${obj.required})
            <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${Math.min(100, obj.current / obj.required * 100)}%"></div></div>
          </div>`;
        }
        html += `</div>
          <div class="quest-btns">
            ${q.status === 1 ? `<button class="quest-btn quest-btn-turnin" onclick="window.__questTurnIn(${q.questId})">提交</button>` : ''}
            <button class="quest-btn quest-btn-abandon" onclick="window.__questAbandon(${q.questId})">放弃</button>
          </div>
        </div>`;
      }
    }
  } else {
    // completed tab
    if (questCompleted.length === 0) {
      html = '<div class="quest-empty">暂无已完成任务</div>';
    } else {
      for (const q of questCompleted) {
        const name = q.name || `任务#${q.questId}`;
        const desc = q.desc || '';
        const catColor = CATEGORY_COLORS[q.category] || '#fff';
        const catName = CATEGORY_NAMES[q.category] || '未知';
        html += `<div class="quest-card quest-card-completed" data-quest-id="${q.questId}">
          <div class="quest-card-header">
            <span class="quest-cat" style="color:${catColor}">[${catName}]</span>
            <span class="quest-name">${name}</span>
            <span class="quest-status quest-completed">✔ 已完成</span>
          </div>
          ${desc ? `<div class="quest-desc">${desc}</div>` : ''}
        </div>`;
      }
    }
  }
  content.innerHTML = html;
}

/** 更新右侧任务追踪 HUD */
export function updateQuestTracker() {
  const list = document.getElementById('quest-tracker-list');
  if (!list) return;
  if (questProgress.length === 0) {
    list.innerHTML = '<div class="quest-tracker-empty">按 L 打开任务日志</div>';
    return;
  }
  const activeNav = _questNav && _questNav.getActiveObjective();
  let html = '';
  for (const q of questProgress) {
    const name = q.name || `任务#${q.questId}`;
    const catColor = CATEGORY_COLORS[q.category] || '#fff';
    const completable = q.status === 1;
    html += `<div class="quest-track-item ${completable ? 'quest-track-completable' : ''}">
      <div class="quest-track-name" style="border-left-color:${catColor}">${name}${completable ? ' ✅' : ''}</div>`;
    for (let i = 0; i < q.objectives.length; i++) {
      const obj = q.objectives[i];
      const done = obj.current >= obj.required;
      const isNavigating = activeNav && activeNav.questId === q.questId && activeNav.objIndex === i;
      const navBtn = (!done && _questNav)
        ? `<button class="qt-nav-btn ${isNavigating ? 'qt-nav-active' : ''}" onclick="window.__questNavigate(${q.questId},${i})" title="自动寻路">▶</button>`
        : '';
      html += `<div class="quest-track-obj ${done ? 'quest-track-obj-done' : ''} ${isNavigating ? 'qt-nav-row' : ''}">
        ${obj.desc}: ${obj.current}/${obj.required}${done ? ' ✓' : ''}${navBtn}
      </div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

// ---------- Toast 提示 ----------
function showToast(text) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ---------- 初始化 ----------
export function initQuestUI(net) {
  // Tab 切换
  document.querySelectorAll('.quest-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      questTab = btn.dataset.tab;
      if (questTab === 'available') sendQuestList(net, currentNpcFilter);
      if (questTab === 'completed') sendQuestTrack(net);
      renderQuestPanel();
    });
  });
  // 关闭按钮
  const closeBtn = document.getElementById('quest-close');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    toggleQuestPanel();
    currentNpcFilter = 0; // 关闭时重置 NPC 过滤
  });
  // 全局回调（HTML onclick 调用）
  window.__questAccept = (questId) => {
    const q = questList.find(lq => lq.questId === questId);
    const npcWid = q ? q.giverNpcWid : 0;
    sendQuestAccept(net, questId, npcWid);
  };
  window.__questAbandon = (questId) => { sendQuestAbandon(net, questId); };
  window.__questTurnIn = (questId) => { sendQuestTurnIn(net, questId, 0); };
  // 任务导航回调
  window.__questNavigate = (questId, objIndex) => {
    if (!_questNav) return;
    if (_questNav.isNavigating()) {
      _questNav.cancel();
    } else {
      _questNav.navigate(questId, objIndex);
    }
    updateQuestTracker();
  };
  // 初始追踪 HUD
  updateQuestTracker();
}
