/**
 * 玩家实体
 * 每个登录用户对应一个 Player 实体。
 */
import { Entity } from './entity.js';

export class Player extends Entity {
  /**
   * @param {string} id     实体 id（p_xxx）
   * @param {string} userId 账号 id
   * @param {string} username
   */
  constructor(id, userId, username) {
    super(id, 'player');
    this.userId = userId;
    this.username = username;
    this.radius = 0.55;
    /** 输入状态：由输入系统写入 */
    this.input = { moveX: 0, moveZ: 0, jump: false };
    /** 网络会话（由 net 层注入） */
    this.session = null;
    /** 最近一次输入序号，用于去重/ACK */
    this.lastSeq = 0;
  }

  serializeExtra() {
    return { username: this.username };
  }
}
