/**
 * 鉴权服务
 * 注册 / 登录 / 会话令牌管理。
 * 空壳阶段令牌为随机字符串 + 内存会话表（可替换为 JWT / Redis 会话）。
 */
import crypto from 'node:crypto';
import { UserStore } from './user-store.js';

export class AuthService {
  constructor(config) {
    this.config = config;
    this.store = new UserStore(config.USER_DB_FILE);
    /** token -> { userId, username, expiresAt } */
    this.sessions = new Map();
    // 定期清理过期会话
    setInterval(() => this._cleanSessions(), 60 * 60 * 1000).unref();
  }

  async register(username, password) {
    const r = await this.store.register(username, password);
    if (!r.ok) return r;
    return { ok: true, user: r.user };
  }

  async login(username, password) {
    const r = await this.store.verifyLogin(username, password);
    if (!r.ok) return r;
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, {
      userId: r.user.username,
      username: r.user.username,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.SESSION_TTL_MS,
    });
    return { ok: true, token, user: { username: r.user.username } };
  }

  /** 校验令牌，返回会话或 null */
  verifyToken(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  logout(token) {
    return this.sessions.delete(token);
  }

  _cleanSessions() {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (v.expiresAt < now) this.sessions.delete(k);
    }
  }
}
