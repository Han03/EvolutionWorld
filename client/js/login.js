/**
 * login.js - 共享登录模态框（游戏客户端 + 世界编辑器）
 *
 * 流程：页面加载 → 立即显示加载遮罩 → 检查 localStorage 会话 →
 *   有效 → 隐藏遮罩，进入实际页面
 *   无效 → 显示登录模态框
 * 避免页面闪烁：body 初始带 ew-loading 类（visibility:hidden），
 * 会话检查完成后移除，保证用户只看到加载遮罩或登录界面，不会看到页面内容闪烁。
 */
import { loadSession, saveSession, clearSession, verifySession } from './session.js';

let overlay = null;
let loadingOverlay = null;
let config = {};

/** 动态创建登录遮罩 + 加载遮罩 DOM */
function createDOM(cfg) {
  // ── 登录遮罩 ──
  overlay = document.createElement('div');
  overlay.id = 'ew-login-overlay';
  overlay.className = 'ew-overlay hidden';
  overlay.innerHTML = `
    <div class="ew-login-bg-particles"></div>
    <div class="ew-login-card">
      <div class="ew-login-crest">
        <div class="ew-crest-glow"></div>
        <div class="ew-crest-icon">⚔</div>
      </div>
      <h1 class="ew-login-title">EVOLUTION<span>WORLD</span></h1>
      <div class="ew-title-divider"><span class="ew-divider-gem">◆</span></div>
      <p class="ew-login-subtitle">${esc(cfg.subtitle || '无缝世界 · 固定俯视角大型MMO')}</p>
      <form class="ew-login-form" autocomplete="off">
        <label>账号</label>
        <input id="ew-login-user" type="text" placeholder="2-16 位字母/数字/中文" maxlength="16" />
        <label>密码</label>
        <input id="ew-login-pass" type="password" placeholder="6-64 位" maxlength="64" />
        <div id="ew-login-msg" class="ew-login-msg"></div>
        <div class="ew-btn-row">
          ${cfg.showRegister !== false
            ? '<button type="button" id="ew-btn-register" class="ew-btn ew-btn-ghost">注 册</button>'
            : ''}
          <button type="submit" id="ew-btn-login" class="ew-btn ew-btn-primary">登 录</button>
        </div>
      </form>
      <div class="ew-login-hint">${cfg.hint || '登录后将进入无缝世界'}</div>
      <div class="ew-login-footer">v1.0 · EvolutionWorld</div>
    </div>
  `;

  // ── 加载遮罩 ──
  loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'ew-loading-overlay';
  loadingOverlay.className = 'ew-loading-overlay';
  loadingOverlay.innerHTML = `
    <div class="ew-loading-ring"><div class="ew-loading-ring-inner"></div></div>
    <span id="ew-loading-text">正在检查登录状态…</span>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(loadingOverlay);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 绑定登录 / 注册表单事件 */
function bindEvents() {
  const form = overlay.querySelector('.ew-login-form');
  const loginBtn = overlay.querySelector('#ew-btn-login');
  const registerBtn = overlay.querySelector('#ew-btn-register');

  if (loginBtn) loginBtn.addEventListener('click', () => doLogin());
  if (registerBtn) registerBtn.addEventListener('click', () => doRegister());
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
}

function showMsg(text, ok) {
  const el = document.getElementById('ew-login-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ew-login-msg' + (ok ? ' ok' : '');
}

async function authReq(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

let loggingIn = false;
async function doLogin() {
  if (loggingIn) return;
  const userEl = document.getElementById('ew-login-user');
  const passEl = document.getElementById('ew-login-pass');
  const username = (userEl?.value || '').trim();
  const password = passEl?.value || '';
  if (!username || !password) { showMsg('请输入账号密码', false); return; }
  loggingIn = true;
  showMsg('登录中…', false);
  try {
    const j = await authReq('/api/login', { username, password });
    if (j.ok) {
      saveSession(j.token, j.user.username);
      hideLogin();
      if (config.onLoggedIn) config.onLoggedIn(j.token, j.user.username, j);
    } else {
      showMsg(j.error || '登录失败', false);
    }
  } catch (e) {
    showMsg('网络错误', false);
  } finally {
    loggingIn = false;
  }
}

async function doRegister() {
  const userEl = document.getElementById('ew-login-user');
  const passEl = document.getElementById('ew-login-pass');
  const username = (userEl?.value || '').trim();
  const password = passEl?.value || '';
  if (!username || !password) { showMsg('请输入账号密码', false); return; }
  showMsg('注册中…', false);
  try {
    const j = await authReq('/api/register', { username, password });
    if (j.ok) {
      showMsg('注册成功，请登录', true);
      await doLogin();
    } else {
      showMsg(j.error || '注册失败', false);
    }
  } catch (e) {
    showMsg('网络错误', false);
  }
}

/**
 * 初始化共享登录模块
 * @param {Object} cfg
 * @param {Function} cfg.onLoggedIn  - (token, username, data) => void  登录 / 会话恢复成功
 * @param {string}   [cfg.subtitle]  - 登录卡片副标题文案
 * @param {string}   [cfg.hint]      - 登录卡片底部提示（支持 HTML）
 * @param {boolean}  [cfg.showRegister=true] - 是否显示注册按钮
 */
export function initLogin(cfg) {
  config = cfg;
  createDOM(cfg);
  bindEvents();
  beginSessionCheck();
}

/** 页面加载时检查已有会话，决定显示登录还是直接进入 */
async function beginSessionCheck() {
  const s = loadSession();
  if (!s || !s.token) {
    showLogin();
    return;
  }
  // 填充用户名到输入框（方便失败后重新登录）
  const userEl = document.getElementById('ew-login-user');
  if (userEl) userEl.value = s.username || '';

  // verifySession: true=有效 → 直接进入 / false=失效 → 显示登录 / null=无法判定 → 乐观进入
  const valid = await verifySession(s.token);
  if (valid === false) {
    clearSession();
    showLogin('会话已过期，请重新登录');
    return;
  }
  // true 或 null（无法判定）→ 乐观恢复
  hideLogin();
  try {
    if (config.onLoggedIn) config.onLoggedIn(s.token, s.username || '', null);
  } catch (e) {
    clearSession();
    showLogin('恢复会话失败，请重新登录');
  }
}

// ── 公共 API ──

/** 隐藏加载遮罩 + 登录遮罩，显示实际页面 */
export function hideLogin() {
  if (overlay) overlay.classList.add('hidden');
  if (loadingOverlay) loadingOverlay.classList.add('hidden');
  document.body.classList.remove('ew-loading');
}

/** 显示登录遮罩（隐藏加载遮罩） */
export function showLogin(msg) {
  if (loadingOverlay) loadingOverlay.classList.add('hidden');
  if (overlay) overlay.classList.remove('hidden');
  if (msg) showMsg(msg, false);
  document.body.classList.remove('ew-loading');
}

/** 显示加载遮罩（隐藏登录遮罩） */
export function showLoading(text) {
  if (overlay) overlay.classList.add('hidden');
  if (loadingOverlay) loadingOverlay.classList.remove('hidden');
  if (text) setLoadingText(text);
  document.body.classList.remove('ew-loading');
}

/** 更新加载遮罩文案 */
export function setLoadingText(text) {
  const el = document.getElementById('ew-loading-text');
  if (el) el.textContent = text;
}
