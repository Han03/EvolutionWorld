/**
 * 浏览器游戏控制台（功能测试用）
 * - 按 “~”(Backquote) 或 Esc 开关面板
 * - 输入命令回车 → net.sendConsole() 发送到服务端（与 stdin/HTTP 共用 consoleExecute）
 * - 服务端返回 S2C_CONSOLE 文本 → appendOutput() 打印到日志区
 * - 支持上/下方向键回溯历史命令
 *
 * 说明：面板输入框为 <input>，聚焦时 KeybindManager 会自动忽略游戏热键，
 *       因此打字不会误触发技能/交互。
 */

const MAX_LINES = 500;      // 日志区最多保留行数（超出裁剪头部）
const MAX_HISTORY = 100;    // 命令历史上限

let net = null;
let panel = null;
let logEl = null;
let inputEl = null;
let open = false;
let history = [];           // 已执行命令（旧→新）
let histIdx = -1;           // 当前回溯位置（-1=未在回溯）
let histDraft = '';         // 回溯前输入框草稿
let pendingPartial = '';    // 服务端分帧的半行续接缓冲（长文本按 255B 切帧）
let initialized = false;

/** 追加一行（不拆分换行）；kind: cmd|out|err|sys */
function pushLine(text, kind) {
  if (!logEl) return;
  const div = document.createElement('div');
  div.className = 'console-line ' + (kind || 'out');
  div.textContent = text;
  logEl.appendChild(div);
  // 裁剪过量行
  while (logEl.childElementCount > MAX_LINES) logEl.removeChild(logEl.firstElementChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/** 追加文本（按 '\n' 拆行） */
function addLine(text, kind) {
  for (const p of String(text).split('\n')) pushLine(p, kind);
}

/**
 * 供 boot.js 的 net.onConsole 调用：打印服务端返回文本。
 * 服务端将长文本按 <=250 字节切为多帧（S2C_CONSOLE 走 u8 长度前缀，单帧上限 255），
 * 此处流式重组：拼接半行、以 '\n' 切完整行输出，末尾未换行部分留待下一帧续接。
 */
export function appendConsoleOutput(text) {
  const s = pendingPartial + String(text);
  const parts = s.split('\n');
  pendingPartial = parts.pop();   // 以 '\n' 结尾时为 ''，否则为半行
  for (const p of parts) pushLine(p, 'out');
}

function setOpen(v) {
  if (!panel) return;
  open = v;
  panel.classList.toggle('hidden', !open);
  if (open) {
    if (inputEl) { inputEl.focus(); inputEl.select(); }
  } else if (inputEl) {
    inputEl.blur();
  }
}

export function toggleConsole(force) {
  setOpen(typeof force === 'boolean' ? force : !open);
}

export function isConsoleOpen() { return open; }

function execCommand(raw) {
  const cmd = String(raw || '').trim();
  if (!cmd) return;
  addLine(cmd, 'cmd');
  history.push(cmd);
  if (history.length > MAX_HISTORY) history.shift();
  histIdx = -1;
  histDraft = '';
  if (inputEl) inputEl.value = '';
  if (net && net.connected) {
    net.sendConsole(cmd);
  } else {
    addLine('未连接到服务端，命令未发送', 'err');
  }
}

function historyPrev() {
  if (history.length === 0) return;
  if (histIdx === -1) { histDraft = inputEl.value; histIdx = history.length - 1; }
  else if (histIdx > 0) histIdx--;
  inputEl.value = history[histIdx];
}

function historyNext() {
  if (histIdx === -1) return;
  if (histIdx < history.length - 1) { histIdx++; inputEl.value = history[histIdx]; }
  else { histIdx = -1; inputEl.value = histDraft; }
}

function onKeyDown(e) {
  const ae = document.activeElement;
  const inConsoleInput = ae === inputEl;
  const inOtherField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !inConsoleInput;

  // “~”(Backquote) 开关：在其它输入框打字时不拦截，避免吞掉字符
  if (e.code === 'Backquote') {
    if (inOtherField) return;
    e.preventDefault();
    setOpen(inConsoleInput ? false : !open);
    return;
  }
  // Esc 关闭
  if (e.code === 'Escape' && open) {
    e.preventDefault();
    setOpen(false);
    return;
  }
}

function onInputKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    execCommand(inputEl.value);
  } else if (e.code === 'ArrowUp') {
    e.preventDefault();
    historyPrev();
  } else if (e.code === 'ArrowDown') {
    e.preventDefault();
    historyNext();
  }
  // 阻止方向键/回车冒泡到游戏逻辑
  e.stopPropagation();
}

/** 初始化控制台 UI（登录进入世界后调用一次） */
export function initConsole(networkClient) {
  if (initialized) return;
  net = networkClient;
  panel = document.getElementById('console-panel');
  logEl = document.getElementById('console-log');
  inputEl = document.getElementById('console-input');
  if (!panel || !logEl || !inputEl) return;

  const closeBtn = document.getElementById('console-close');
  const clearBtn = document.getElementById('console-clear');
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
  if (clearBtn) clearBtn.addEventListener('click', () => { logEl.innerHTML = ''; pendingPartial = ''; });

  // 全局捕获：即使输入框聚焦也能响应 ~ / Esc
  window.addEventListener('keydown', onKeyDown, true);
  inputEl.addEventListener('keydown', onInputKeyDown);

  addLine('控制台已就绪，输入 help 查看可用命令。', 'sys');
  initialized = true;
}
