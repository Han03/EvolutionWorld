/**
 * 用户存储
 * 空壳阶段使用本地 JSON 文件持久化（可无痛替换为 MySQL/Mongo/Redis 等）。
 * 密码使用 Node 内置 crypto.scrypt 加盐哈希存储，绝不存明文。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = new Map(); // username -> { username, salt, hash, createdAt }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const u of raw.users || []) this.users.set(u.username, u);
      }
    } catch (e) {
      console.warn('[UserStore] 读取用户数据失败（将重新初始化）:', e.message);
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = { version: 1, users: [...this.users.values()] };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  _hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 32).toString('hex');
  }

  /**
   * 注册新用户
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async register(username, password) {
    username = (username || '').trim();
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(username)) {
      return { ok: false, error: '用户名需为 2-16 位字母/数字/下划线/中文' };
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
      return { ok: false, error: '密码长度需为 6-64 位' };
    }
    if (this.users.has(username)) {
      return { ok: false, error: '用户名已存在' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      username,
      salt,
      hash: this._hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    this.users.set(username, user);
    this._save();
    return { ok: true, user };
  }

  /**
   * 校验登录
   * @returns {Promise<{ok:boolean, error?:string, user?:object}>}
   */
  async verifyLogin(username, password) {
    username = (username || '').trim();
    const user = this.users.get(username);
    if (!user) return { ok: false, error: '用户名或密码错误' };
    const hash = this._hashPassword(password, user.salt);
    if (hash !== user.hash) return { ok: false, error: '用户名或密码错误' };
    return { ok: true, user };
  }
}
