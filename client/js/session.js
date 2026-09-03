/**
 * session.js - 登录态持久化（localStorage）共享模块
 *
 * 游戏客户端（boot.js）与世界编辑器（editor.js）同源部署、共用同一份会话：
 * 任一侧登录成功后，另一侧刷新页面即可自动恢复，无需重复输入账号密码。
 * 令牌由服务端 Auth 签发，有效期见 server/src/config.h sessionTtlSec（默认 24 小时）。
 */
const SESSION_KEY = 'ew_session';

/** 保存会话（token + 用户名） */
export function saveSession(token, username) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, username })); } catch (_) {}
}

/** 读取会话；不存在或已损坏返回 null */
export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return (s && s.token) ? s : null;
  } catch (_) { return null; }
}

/** 清除本地会话（登出 / 令牌失效） */
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/**
 * 只读校验令牌是否仍然有效：GET /api/me?token=...
 * @returns {Promise<boolean|null>} true=有效 / false=已失效 / null=无法判定
 *   无法判定的两种情况：服务端为旧版本（无 /api/me 路由，SPA 回退返回 HTML）、网络异常。
 *   此时调用方应「乐观恢复」会话，并由后续写请求的 401 兜底处理。
 */
export async function verifySession(token) {
  if (!token) return false;
  try {
    const r = await fetch('/api/me?token=' + encodeURIComponent(token));
    if (r.status === 401) return false;
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct.indexOf('json') < 0) return null; // 旧二进制回退到 index.html → 无法判定
    const j = await r.json();
    return !!(j && j.ok && j.username);
  } catch (_) { return null; }
}

/** 登出：先清本地会话（避免竞态残留），再通知服务端销毁令牌 */
export async function logoutSession(token) {
  clearSession();
  if (!token) return;
  try {
    await fetch('/api/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (_) {}
}
