/**
 * social.js - 社交系统客户端 UI（聊天栏 + 好友面板 + 公会面板）
 *
 * 数据流：服务端 S2C_FRIEND/GUILD/CHAT_* → network.js 回调 → 更新 UI
 *         用户操作 → network.js send 方法 → 服务端
 */
import { CHAT, CHAT_NAMES, FRIEND_OP, FRIEND_RESULT, GUILD_ROLE, GUILD_RESULT, GUILD_NOTIFY, CHAT_RESULT } from './protocol.js';

// ===================== 状态 =====================
let net = null;
let selfName = '';

// 聊天状态
let chatChannel = CHAT.WORLD; // 当前频道
let chatMessages = [];         // 本地消息缓冲 [{channel, sender, content, timestamp, target}]
const MAX_CHAT_LINES = 100;

// 好友状态
let friendList = [];           // [{name, online, remark}]
let friendRequests = [];       // [{from, message, timestamp}]（本地缓存收到的请求）
let friendTab = 'list';       // list / requests / block
let blockList = [];            // 本地维护（从好友列表中标记）

// 公会状态
let myGuildInfo = null;        // S2C_GUILD_INFO 解码结果
let guildSearchResults = [];   // S2C_GUILD_LIST 解码结果
let guildTab = 'my';          // my / search / create

// 面板开关
let friendPanelOpen = false;
let guildPanelOpen = false;
let chatFocused = false;       // 聊天输入框是否聚焦

// ===================== Toast 提示 =====================
function showToast(text, cls) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ===================== 聊天系统 =====================

/** 添加一条本地消息并渲染 */
export function addChatMessage(channel, sender, content, target = '') {
  chatMessages.push({ channel, sender, content, target, timestamp: Date.now() });
  if (chatMessages.length > MAX_CHAT_LINES) chatMessages.shift();
  renderChatMessages();
}

/** 渲染聊天消息列表 */
function renderChatMessages() {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  // 按当前频道过滤（世界=全部，其他只显示对应频道 + 系统消息）
  const filtered = chatMessages.filter(m => {
    if (m.channel === CHAT.SYSTEM) return true;
    if (chatChannel === CHAT.WORLD) return true;
    return m.channel === chatChannel;
  });
  const recent = filtered.slice(-60);
  let html = '';
  for (const m of recent) {
    const chClass = ['ch-private', 'ch-friend', 'ch-guild', 'ch-world', 'ch-team', 'ch-system'][m.channel] || '';
    const chName = CHAT_NAMES[m.channel] || '';
    const time = new Date(m.timestamp);
    const ts = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
    if (m.channel === CHAT.SYSTEM) {
      html += `<div class="chat-msg-line ch-system">[系统] ${escHtml(m.content)}</div>`;
    } else {
      const targetTag = m.target ? ` → ${escHtml(m.target)}` : '';
      html += `<div class="chat-msg-line ${chClass}">
        <span class="chat-channel">[${chName}]</span>
        <span class="chat-sender">${escHtml(m.sender)}${targetTag}:</span>
        ${escHtml(m.content)}
        <span style="opacity:0.4;font-size:9px;margin-left:4px">${ts}</span>
      </div>`;
    }
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

/** 发送聊天消息 */
function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const targetInput = document.getElementById('chat-target');
  if (!input || !net) return;
  const content = input.value.trim();
  if (!content) return;
  let target = '';
  if (chatChannel === CHAT.PRIVATE) {
    target = targetInput ? targetInput.value.trim() : '';
    if (!target) { showToast('私聊需要输入目标玩家名'); return; }
  }
  net.sendChat(chatChannel, target, content);
  // 本地先显示（服务端会回发确认）
  addChatMessage(chatChannel, selfName || '我', content, target);
  input.value = '';
}

/** 切换聊天频道 */
function setChatChannel(ch) {
  chatChannel = ch;
  document.querySelectorAll('.chat-tab').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.channel) === ch);
  });
  // 私聊频道显示目标输入框
  const targetInput = document.getElementById('chat-target');
  if (targetInput) targetInput.classList.toggle('hidden', ch !== CHAT.PRIVATE);
  renderChatMessages();
}

// ===================== 好友系统 =====================

/** 渲染好友面板内容 */
function renderFriendPanel() {
  const content = document.getElementById('friend-content');
  if (!content) return;
  document.querySelectorAll('.friend-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === friendTab);
  });
  let html = '';
  if (friendTab === 'list') {
    if (friendList.length === 0) {
      html = '<div class="social-empty">暂无好友，输入玩家名添加好友</div>';
    } else {
      const online = friendList.filter(f => f.online);
      const offline = friendList.filter(f => !f.online);
      if (online.length) {
        html += '<div style="color:#81c784;font-size:10px;margin-bottom:4px;font-weight:600">在线 (' + online.length + ')</div>';
        for (const f of online) html += friendItemHtml(f);
      }
      if (offline.length) {
        html += '<div style="color:var(--text-dim);font-size:10px;margin:6px 0 4px;font-weight:600">离线 (' + offline.length + ')</div>';
        for (const f of offline) html += friendItemHtml(f);
      }
    }
  } else if (friendTab === 'requests') {
    if (friendRequests.length === 0) {
      html = '<div class="social-empty">暂无好友请求</div>';
    } else {
      for (const r of friendRequests) {
        html += `<div class="request-item">
          <span class="request-from">${escHtml(r.from)}</span>
          <span class="request-msg">${r.message ? escHtml(r.message) : ''}</span>
          <button class="social-btn success" onclick="window.__friendAccept('${escAttr(r.from)}')">接受</button>
          <button class="social-btn danger" onclick="window.__friendReject('${escAttr(r.from)}')">拒绝</button>
        </div>`;
      }
    }
  } else if (friendTab === 'block') {
    const blocked = friendList.filter(f => f.blocked);
    if (blocked.length === 0) {
      html = '<div class="social-empty">暂无黑名单用户</div>';
    } else {
      for (const f of blocked) {
        html += `<div class="friend-item">
          <span class="friend-name">${escHtml(f.name)}</span>
          <div class="friend-actions">
            <button class="social-btn" onclick="window.__friendUnblock('${escAttr(f.name)}')">取消拉黑</button>
          </div>
        </div>`;
      }
    }
  }
  content.innerHTML = html;
}

function friendItemHtml(f) {
  return `<div class="friend-item">
    <span class="friend-status-dot ${f.online ? 'online' : 'offline'}"></span>
    <span class="friend-name">${escHtml(f.name)}</span>
    ${f.remark ? `<span class="friend-remark">${escHtml(f.remark)}</span>` : ''}
    <div class="friend-actions">
      <button class="social-btn" onclick="window.__chatPrivate('${escAttr(f.name)}')">私聊</button>
      <button class="social-btn danger" onclick="window.__friendRemove('${escAttr(f.name)}')">删除</button>
      <button class="social-btn danger" onclick="window.__friendBlock('${escAttr(f.name)}')">拉黑</button>
    </div>
  </div>`;
}

// ===================== 公会系统 =====================

/** 渲染公会面板内容 */
function renderGuildPanel() {
  const content = document.getElementById('guild-content');
  if (!content) return;
  document.querySelectorAll('.guild-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === guildTab);
  });
  let html = '';
  if (guildTab === 'my') {
    if (!myGuildInfo) {
      html = '<div class="social-empty">你尚未加入公会<br/><span style="font-size:10px;color:var(--text-dim)">按 G 切换到搜索/创建公会</span></div>';
    } else {
      const g = myGuildInfo;
      const roleNames = GUILD_ROLE;
      html += `<div class="guild-info-card">
        <div class="guild-info-header">
          <div class="guild-emblem">🏰</div>
          <div>
            <div class="guild-info-name">${escHtml(g.name)}</div>
            <div class="guild-info-level">Lv.${g.level} · ${g.memberCount}/${g.maxMembers} 人</div>
          </div>
        </div>
        <div class="guild-info-stats">
          <span>会长: <b>${escHtml(g.leaderUsername)}</b></span>
          <span>经验: <b>${g.exp}</b></span>
        </div>
      </div>`;
      if (g.notice) {
        html += `<div class="guild-notice"><span class="guild-notice-label">公告:</span>${escHtml(g.notice)}</div>`;
      }
      // 操作按钮（根据角色显示不同按钮）
      const myRole = getMyGuildRole();
      html += '<div class="guild-actions">';
      if (myRole === 0 || myRole === 1) { // 会长/副会长
        html += `<button class="social-btn" onclick="window.__guildEditNotice()">编辑公告</button>`;
      }
      if (myRole === 0) { // 会长
        html += `<button class="social-btn danger" onclick="window.__guildDisband()">解散公会</button>`;
      }
      html += `<button class="social-btn danger" onclick="window.__guildLeave()">退出公会</button>`;
      html += '</div>';
      // 成员列表
      html += '<div class="guild-member-list">';
      html += `<div class="guild-member-header"><span>成员 (${g.memberCount}/${g.maxMembers})</span></div>`;
      // 按角色排序：会长 → 副会长 → 成员 → 新成员
      const sorted = [...g.members].sort((a, b) => a.role - b.role);
      for (const m of sorted) {
        const roleClass = ['leader', 'officer', 'member', 'recruit'][m.role] || 'recruit';
        const isMe = m.username === selfName;
        const canManage = (myRole <= 1) && m.role > myRole && !isMe; // 只能管理比自己低的
        html += `<div class="guild-member-item">
          <span class="friend-status-dot ${m.online ? 'online' : 'offline'}"></span>
          <span class="guild-member-role ${roleClass}">${roleNames[m.role] || '新成员'}</span>
          <span class="guild-member-name ${m.online ? '' : 'offline'}">${escHtml(m.username)}${isMe ? ' (我)' : ''}</span>
          ${m.title ? `<span class="guild-member-title">${escHtml(m.title)}</span>` : ''}
          <div class="guild-member-actions">
            ${canManage ? `<button class="social-btn" onclick="window.__guildPromote('${escAttr(m.username)}')">晋升</button>` : ''}
            ${canManage ? `<button class="social-btn" onclick="window.__guildDemote('${escAttr(m.username)}')">降级</button>` : ''}
            ${canManage ? `<button class="social-btn danger" onclick="window.__guildKick('${escAttr(m.username)}')">踢出</button>` : ''}
            ${myRole === 0 && m.role === 1 ? `<button class="social-btn" onclick="window.__guildTransfer('${escAttr(m.username)}')">转让</button>` : ''}
            <button class="social-btn" onclick="window.__chatPrivate('${escAttr(m.username)}')">私聊</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }
  } else if (guildTab === 'search') {
    html += `<div class="guild-search-row">
      <input id="guild-search-input" type="text" placeholder="搜索公会名…" maxlength="20" />
      <button class="social-btn" onclick="window.__guildSearch()">搜索</button>
    </div>`;
    if (guildSearchResults.length === 0) {
      html += '<div class="social-empty">输入关键词搜索公会</div>';
    } else {
      for (const g of guildSearchResults) {
        html += `<div class="guild-search-item">
          <div class="guild-emblem" style="width:32px;height:32px;font-size:16px">🏰</div>
          <span class="guild-search-name">${escHtml(g.name)}</span>
          <span class="guild-search-info">Lv.${g.level} · ${g.memberCount}人</span>
          <button class="social-btn success" onclick="window.__guildApply(${g.guildId})">申请</button>
        </div>`;
      }
    }
  } else if (guildTab === 'create') {
    html += `<div class="guild-create-form">
      <label>公会名称</label>
      <input id="guild-create-name" type="text" placeholder="2-16 个字符" maxlength="16" />
      <div class="guild-create-hint">创建公会需要消耗 1000 金币</div>
      <button class="social-btn success" onclick="window.__guildCreate()" style="width:100%">创建公会</button>
    </div>`;
  }
  content.innerHTML = html;
}

function getMyGuildRole() {
  if (!myGuildInfo) return -1;
  for (const m of myGuildInfo.members) {
    if (m.username === selfName) return m.role;
  }
  return -1;
}

// ===================== 面板开关 =====================

export function toggleFriendPanel() {
  friendPanelOpen = !friendPanelOpen;
  const panel = document.getElementById('friend-panel');
  if (panel) panel.classList.toggle('hidden', !friendPanelOpen);
  if (friendPanelOpen) {
    // 关闭其他面板
    closeGuildPanel();
    net.sendFriendList();
    renderFriendPanel();
  }
}

export function toggleGuildPanel() {
  guildPanelOpen = !guildPanelOpen;
  const panel = document.getElementById('guild-panel');
  if (panel) panel.classList.toggle('hidden', !guildPanelOpen);
  if (guildPanelOpen) {
    closeFriendPanel();
    net.sendGuildInfo();
    renderGuildPanel();
  }
}

export function toggleChatFocus() {
  const input = document.getElementById('chat-input');
  if (input) {
    input.focus();
    chatFocused = true;
  }
}

function closeFriendPanel() {
  friendPanelOpen = false;
  const panel = document.getElementById('friend-panel');
  if (panel) panel.classList.add('hidden');
}

function closeGuildPanel() {
  guildPanelOpen = false;
  const panel = document.getElementById('guild-panel');
  if (panel) panel.classList.add('hidden');
}

export function isFriendPanelOpen() { return friendPanelOpen; }
export function isGuildPanelOpen() { return guildPanelOpen; }
export function isChatFocused() { return chatFocused; }

// ===================== S2C 消息处理（由 boot.js 调用） =====================

export function handleFriendRequest(msg) {
  friendRequests.push({ from: msg.from, message: msg.message, timestamp: Date.now() });
  showToast(`好友请求: ${msg.from}${msg.message ? ' - ' + msg.message : ''}`);
  if (friendPanelOpen && friendTab === 'requests') renderFriendPanel();
}

export function handleFriendList(msg) {
  friendList = msg.friends.map(f => ({ ...f, blocked: false }));
  if (friendPanelOpen) renderFriendPanel();
}

export function handleFriendStatus(msg) {
  for (const f of friendList) {
    if (f.name === msg.name) {
      f.online = msg.online;
      break;
    }
  }
  showToast(`${msg.name} ${msg.online ? '上线了' : '离线了'}`);
  if (friendPanelOpen) renderFriendPanel();
}

export function handleFriendResult(msg) {
  const opName = ['添加', '接受', '拒绝', '删除', '拉黑', '取消拉黑'][msg.opCode] || '操作';
  const resultMsg = FRIEND_RESULT[msg.resultCode] || '未知';
  if (msg.resultCode === 0) {
    showToast(`好友${opName}成功`, 'ok');
    // 刷新列表
    net.sendFriendList();
  } else {
    showToast(`好友${opName}失败: ${resultMsg}`);
  }
}

export function handleGuildInfo(msg) {
  myGuildInfo = msg;
  if (guildPanelOpen) renderGuildPanel();
}

export function handleGuildResult(msg) {
  const opNames = ['创建', '解散', '申请', '审批', '踢出', '晋升', '降级', '退出', '转让', '编辑公告', '查询信息', '查询列表'];
  const opName = opNames[msg.opCode] || '操作';
  const resultMsg = GUILD_RESULT[msg.code] || '未知';
  if (msg.code === 0) {
    showToast(`公会${opName}成功`, 'ok');
    net.sendGuildInfo(); // 刷新
  } else {
    showToast(`公会${opName}失败: ${resultMsg}${msg.extra ? ' - ' + msg.extra : ''}`);
  }
}

export function handleGuildNotify(msg) {
  const notifyMsg = GUILD_NOTIFY[msg.eventType] || '公会事件';
  showToast(`[公会] ${notifyMsg}${msg.data ? ': ' + msg.data : ''}`);
  net.sendGuildInfo(); // 刷新公会信息
}

export function handleGuildList(msg) {
  guildSearchResults = msg.guilds;
  if (guildPanelOpen && guildTab === 'search') renderGuildPanel();
}

export function handleGuildApplyN(msg) {
  showToast(`[公会] 新入会申请: ${msg.applicant}`);
}

export function handleChatMsg(msg) {
  addChatMessage(msg.channel, msg.sender, msg.content, '');
}

export function handleChatHistory(msg) {
  for (const m of msg.messages) {
    chatMessages.push({
      channel: m.channel, sender: m.sender, content: m.content,
      target: m.target, timestamp: m.timestamp || Date.now(),
    });
  }
  if (chatMessages.length > MAX_CHAT_LINES) {
    chatMessages = chatMessages.slice(-MAX_CHAT_LINES);
  }
  renderChatMessages();
}

export function handleChatResult(msg) {
  if (msg.code !== 0) {
    const errMsg = CHAT_RESULT[msg.code] || '发送失败';
    showToast(`聊天: ${errMsg}${msg.errorMsg ? ' - ' + msg.errorMsg : ''}`);
  }
}

// ===================== 全局回调（HTML onclick 调用） =====================

function installGlobalCallbacks(network) {
  net = network;
  selfName = net.selfName || '';

  // 好友操作
  window.__friendAccept = (from) => { net.sendFriendAccept(from); };
  window.__friendReject = (from) => { net.sendFriendReject(from); };
  window.__friendRemove = (name) => { net.sendFriendRemove(name); };
  window.__friendBlock = (name) => { net.sendFriendBlock(name); };
  window.__friendUnblock = (name) => { net.sendFriendUnblock(name); };
  window.__chatPrivate = (name) => {
    setChatChannel(CHAT.PRIVATE);
    const targetInput = document.getElementById('chat-target');
    if (targetInput) targetInput.value = name;
    const input = document.getElementById('chat-input');
    if (input) input.focus();
  };

  // 公会操作
  window.__guildCreate = () => {
    const nameInput = document.getElementById('guild-create-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { showToast('请输入公会名称'); return; }
    net.sendGuildCreate(name);
  };
  window.__guildDisband = () => {
    if (confirm('确定要解散公会吗？此操作不可撤销')) net.sendGuildDisband();
  };
  window.__guildLeave = () => {
    if (confirm('确定要退出公会吗？')) net.sendGuildLeave();
  };
  window.__guildApply = (guildId) => { net.sendGuildApply(guildId); };
  window.__guildKick = (name) => { net.sendGuildKick(name); };
  window.__guildPromote = (name) => { net.sendGuildPromote(name); };
  window.__guildDemote = (name) => { net.sendGuildDemote(name); };
  window.__guildTransfer = (name) => {
    if (confirm(`确定要将会长转让给 ${name} 吗？`)) net.sendGuildTransfer(name);
  };
  window.__guildEditNotice = () => {
    const notice = prompt('输入新公告内容:');
    if (notice !== null) net.sendGuildNotice(notice);
  };
  window.__guildSearch = () => {
    const input = document.getElementById('guild-search-input');
    const keyword = input ? input.value.trim() : '';
    net.sendGuildList(keyword);
  };
}

// ===================== 初始化 =====================

export function initSocialUI(network) {
  installGlobalCallbacks(network);
  selfName = network.selfName || '';

  // 监听 HELLO 后更新 selfName（可能 initSocialUI 在 selfName 设置前调用）
  const origOnHello = network.onHello;
  network.onHello = (msg) => {
    selfName = network.selfName || msg.self.name || '';
    if (origOnHello) origOnHello(msg);
  };

  // 聊天频道切换
  document.querySelectorAll('.chat-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setChatChannel(Number(btn.dataset.channel));
    });
  });
  // 聊天发送
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        sendChatMessage();
        chatInput.blur();
        chatFocused = false;
      }
      e.stopPropagation(); // 阻止聊天输入触发游戏快捷键
    });
    chatInput.addEventListener('focus', () => { chatFocused = true; });
    chatInput.addEventListener('blur', () => { chatFocused = false; });
  }
  const chatSendBtn = document.getElementById('chat-send');
  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', () => {
      sendChatMessage();
      chatFocused = false;
    });
  }

  // 好友面板
  document.querySelectorAll('.friend-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      friendTab = btn.dataset.tab;
      renderFriendPanel();
    });
  });
  const friendClose = document.getElementById('friend-close');
  if (friendClose) friendClose.addEventListener('click', () => closeFriendPanel());
  const friendAddBtn = document.getElementById('friend-add-btn');
  if (friendAddBtn) {
    friendAddBtn.addEventListener('click', () => {
      const nameInput = document.getElementById('friend-add-name');
      const name = nameInput ? nameInput.value.trim() : '';
      if (!name) { showToast('请输入玩家名'); return; }
      net.sendFriendAdd(name);
      nameInput.value = '';
    });
  }
  const friendAddInput = document.getElementById('friend-add-name');
  if (friendAddInput) {
    friendAddInput.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        friendAddBtn && friendAddBtn.click();
      }
      e.stopPropagation();
    });
  }

  // 公会面板
  document.querySelectorAll('.guild-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      guildTab = btn.dataset.tab;
      if (guildTab === 'search') net.sendGuildList('');
      renderGuildPanel();
    });
  });
  const guildClose = document.getElementById('guild-close');
  if (guildClose) guildClose.addEventListener('click', () => closeGuildPanel());

  // 初始渲染
  renderChatMessages();
}

// ===================== 工具函数 =====================

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  if (!s) return '';
  return s.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
