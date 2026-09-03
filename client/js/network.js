/**
 * 网络客户端：HTTP 登录 + WebSocket（二进制协议）游戏连接
 * 数据传输方案：二进制帧 + 量化坐标 + AOI 进出 + 增量更新 + 校准快照
 * 扩展：输入上报携带预测位置 px/py/pz（防作弊校验），处理 SELF（回退）与 KICK。
 */
import { encodeInput, encodeAttack, encodeShopOpen, encodeShopBuy, encodePickup, encodeEquip, encodeUseItem, encodeCastSkill, encodeConsole, parseS2C, makeFrame, MSG, Writer } from './protocol.js';
export class NetworkClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.selfWid = 0;
    this.selfName = '';
    this.world = null;
    this.seq = 0;
    // 回调
    this.onHello = null;
    this.onEnter = null;
    this.onLeave = null;
    this.onUpdate = null;
    this.onSnapshot = null;
    this.onSelf = null;      // 服务端后校验回退
    this.onKick = null;
    this.onDisconnect = null;
    this.onBoss = null;      // 世界 Boss 全局共享状态（S2C_BOSS）
    this.onEvent = null;     // 战斗/世界共享事件（S2C_EVENT）
    this.onShop = null;      // 商店列表（S2C_SHOP）
    this.onInventory = null; // 背包/装备/金币（S2C_INVENTORY）
    this.onLoot = null;      // 拾取反馈（S2C_LOOT）
    this.onStats = null;     // 自身属性（S2C_STATS）
    this.onSkills = null;    // 已学技能 + 冷却（S2C_SKILLS）
    this.onSkillCast = null; // 技能施放反馈（S2C_SKILL_CAST）
    this.onBuffs = null;     // 自身 Buff（S2C_BUFFS）
    this.onConsole = null;   // 控制台结果（S2C_CONSOLE）
    // 任务系统回调（S2C_QUEST_*，payload 为原始 Uint8Array，由 quests.js 解码）
    this.onQuestList = null;
    this.onQuestProgress = null;
    this.onQuestResult = null;
    this.onQuestComplete = null;
    this.onQuestNotify = null;
    // 社交系统回调（S2C_FRIEND/GUILD/CHAT_*，已由 parseS2C 解码为对象）
    this.onFriendRequest = null;
    this.onFriendList = null;
    this.onFriendStatus = null;
    this.onFriendResult = null;
    this.onGuildInfo = null;
    this.onGuildResult = null;
    this.onGuildNotify = null;
    this.onGuildList = null;
    this.onGuildApplyN = null;
    this.onChatMsg = null;
    this.onChatHistory = null;
    this.onChatResult = null;
    // 协议透传转换监控：每次二进制帧解码为可读对象后触发（dir: 's2c' | 'c2s'，obj 为解码结果）
    this.onProtocol = null;
    // 自身预测位置（解码相对坐标用参考）
    this.refX = 0; this.refY = 0; this.refZ = 0;
  }
  async _post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `请求失败(${res.status})`);
    }
    return data;
  }
  async register(username, password) {
    await this._post('/api/register', { username, password });
  }
  async login(username, password) {
    return this._post('/api/login', { username, password });
  }
  /** 建立 WebSocket 游戏连接（二进制协议） */
  connect(token) {
    // 立即关闭旧连接并复位状态，避免新 socket 仍在 CONNECTING 时旧 connected=true
    // 导致 send 被误放行（"Failed to execute 'send' ... Still in CONNECTING state"）
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.close(); } catch (_) {}
    }
    this.connected = false;
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      ws.onclose = () => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      };
      ws.onmessage = (ev) => this._onBinary(ev.data);
    });
  }
  /** 安全的二进制发送：仅当 socket 已 OPEN 才发送（CONNECTING/CLOSING 一律静默丢弃，不抛异常） */
  _send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(frame);
    return true;
  }
  /** 设置自身预测位置（相对坐标解码参考） */
  setRef(x, y, z) {
    this.refX = x; this.refY = y; this.refZ = z;
  }
  _onBinary(data) {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.bytesRx = (this.bytesRx || 0) + buf.length;
    if (this.onBytes) this.onBytes(buf.length);
    let off = 0;
    while (off + 9 <= buf.length) {
      const m0 = buf[off], m1 = buf[off + 1];
      if (m0 !== 0x45 || m1 !== 0x57) break;
      const type = buf[off + 3];
      const len = buf[off + 7] | (buf[off + 8] << 8);
      if (off + 9 + len > buf.length) break;
      const payload = buf.slice(off + 9, off + 9 + len);
      off += 9 + len;
      this._dispatch(type, payload);
    }
  }
  _dispatch(type, payload) {
    try {
      const msg = parseS2C(type, payload, this.refX, this.refY, this.refZ);
      if (this.onProtocol) this.onProtocol('s2c', msg); // 透传转换：二进制 → 可读对象
      switch (msg.type) {
        case MSG.S2C_HELLO:
          this.selfWid = msg.self.wid;
          this.selfName = msg.self.name;
          this.world = { seed: msg.seed, viewRange: msg.viewRange, chunkSize: msg.chunkSize, tickRate: msg.tickRate };
          this.hello = msg;
          if (this.onHello) this.onHello(msg);
          break;
        case MSG.S2C_ENTER:
          if (this.onEnter) this.onEnter(msg.entities);
          break;
        case MSG.S2C_LEAVE:
          if (this.onLeave) this.onLeave(msg.wids);
          break;
        case MSG.S2C_UPDATE:
          if (this.onUpdate) this.onUpdate(msg.updates);
          break;
        case MSG.S2C_SNAPSHOT:
          if (this.onSnapshot) this.onSnapshot(msg);
          break;
        case MSG.S2C_SELF:
          if (this.onSelf) this.onSelf(msg);
          break;
        case MSG.S2C_KICK:
          if (this.onKick) this.onKick(msg);
          break;
        case MSG.S2C_PING:
          break;
        case MSG.S2C_BOSS:
          if (this.onBoss) this.onBoss(msg);
          break;
        case MSG.S2C_EVENT:
          if (this.onEvent) this.onEvent(msg);
          break;
        case MSG.S2C_SHOP:
          if (this.onShop) this.onShop(msg);
          break;
        case MSG.S2C_INVENTORY:
          if (this.onInventory) this.onInventory(msg);
          break;
        case MSG.S2C_LOOT:
          if (this.onLoot) this.onLoot(msg);
          break;
        case MSG.S2C_STATS:
          if (this.onStats) this.onStats(msg);
          break;
        case MSG.S2C_SKILLS:
          if (this.onSkills) this.onSkills(msg);
          break;
        case MSG.S2C_SKILL_CAST:
          if (this.onSkillCast) this.onSkillCast(msg);
          break;
        case MSG.S2C_BUFFS:
          if (this.onBuffs) this.onBuffs(msg);
          break;
        case MSG.S2C_CONSOLE:
          if (this.onConsole) this.onConsole(msg);
          break;
        case MSG.S2C_QUEST_LIST:
          if (this.onQuestList) this.onQuestList(payload);
          break;
        case MSG.S2C_QUEST_PROGRESS:
          if (this.onQuestProgress) this.onQuestProgress(payload);
          break;
        case MSG.S2C_QUEST_RESULT:
          if (this.onQuestResult) this.onQuestResult(payload);
          break;
        case MSG.S2C_QUEST_COMPLETE:
          if (this.onQuestComplete) this.onQuestComplete(payload);
          break;
        case MSG.S2C_QUEST_NOTIFY:
          if (this.onQuestNotify) this.onQuestNotify(payload);
          break;
        // ---- 社交系统 S2C 分发 ----
        case MSG.S2C_FRIEND_REQUEST:
          if (this.onFriendRequest) this.onFriendRequest(msg);
          break;
        case MSG.S2C_FRIEND_LIST:
          if (this.onFriendList) this.onFriendList(msg);
          break;
        case MSG.S2C_FRIEND_STATUS:
          if (this.onFriendStatus) this.onFriendStatus(msg);
          break;
        case MSG.S2C_FRIEND_RESULT:
          if (this.onFriendResult) this.onFriendResult(msg);
          break;
        case MSG.S2C_GUILD_INFO:
          if (this.onGuildInfo) this.onGuildInfo(msg);
          break;
        case MSG.S2C_GUILD_RESULT:
          if (this.onGuildResult) this.onGuildResult(msg);
          break;
        case MSG.S2C_GUILD_NOTIFY:
          if (this.onGuildNotify) this.onGuildNotify(msg);
          break;
        case MSG.S2C_GUILD_LIST:
          if (this.onGuildList) this.onGuildList(msg);
          break;
        case MSG.S2C_GUILD_APPLY_N:
          if (this.onGuildApplyN) this.onGuildApplyN(msg);
          break;
        case MSG.S2C_CHAT_MSG:
          if (this.onChatMsg) this.onChatMsg(msg);
          break;
        case MSG.S2C_CHAT_HISTORY:
          if (this.onChatHistory) this.onChatHistory(msg);
          break;
        case MSG.S2C_CHAT_RESULT:
          if (this.onChatResult) this.onChatResult(msg);
          break;
        case MSG.S2C_ERROR:
          console.error('[net]', msg.code, msg.msg);
          break;
      }
    } catch (e) {
      console.error('[net] 解码错误', e);
    }
  }
  /**
   * 发送输入（移动 + 跳跃 + 预测位置），二进制编码
   */
  sendInput(moveX, moveZ, jump, pred) {
    if (!this.connected) return;
    const frame = encodeInput(++this.seq, moveX, moveZ, jump, pred.x, pred.y, pred.z);
    if (!this._send(frame)) return;
    if (this.onProtocol) {
      this.onProtocol('c2s', { type: 'INPUT', seq: this.seq, moveX, moveZ, jump, x: pred.x, y: pred.y, z: pred.z });
    }
  }
  /** 攻击世界实体（世界怪物/Boss） */
  sendAttack(targetWid, slot = 0) {
    if (!this.connected || !targetWid) return;
    this._send(encodeAttack(targetWid, slot));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'ATTACK', targetWid, slot });
  }
  /** 打开商店（target 为商店 NPC wid） */
  sendShopOpen(npcWid) {
    if (!this.connected || !npcWid) return;
    this._send(encodeShopOpen(npcWid));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'SHOP_OPEN', npcWid });
  }
  /** 购买物品 */
  sendShopBuy(itemId, count = 1) {
    if (!this.connected || !itemId) return;
    this._send(encodeShopBuy(itemId, count));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'SHOP_BUY', itemId, count });
  }
  /** 拾取地面掉落物 */
  sendPickup(dropWid) {
    if (!this.connected || !dropWid) return;
    this._send(encodePickup(dropWid));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'PICKUP', dropWid });
  }
  /** 穿戴/卸下装备 */
  sendEquip(slot, itemId) {
    if (!this.connected) return;
    this._send(encodeEquip(slot, itemId));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'EQUIP', slot, itemId });
  }
  /** 使用消耗品 */
  sendUseItem(itemId, count = 1) {
    if (!this.connected || !itemId) return;
    this._send(encodeUseItem(itemId, count));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'USE_ITEM', itemId, count });
  }
  /** 施放技能（技能系统） */
  sendCastSkill(skillId, targetWid = 0, tx = 0, tz = 0) {
    if (!this.connected || !skillId) return;
    this._send(encodeCastSkill(skillId, targetWid, tx, tz));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'CAST_SKILL', skillId, targetWid, tx, tz });
  }
  /** 控制台命令（功能测试） */
  sendConsole(cmd) {
    if (!this.connected) return;
    this._send(encodeConsole(cmd));
    if (this.onProtocol) this.onProtocol('c2s', { type: 'CONSOLE', cmd });
  }
  // ---- 社交系统发送方法 ----
  /** 发送好友请求 */
  sendFriendAdd(targetName, message = '') {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName); w.str(message);
    this._send(makeFrame(MSG.C2S_FRIEND_ADD, w.finish()));
  }
  /** 接受好友请求 */
  sendFriendAccept(fromUser) {
    if (!this.connected) return;
    const w = new Writer(); w.str(fromUser);
    this._send(makeFrame(MSG.C2S_FRIEND_ACCEPT, w.finish()));
  }
  /** 拒绝好友请求 */
  sendFriendReject(fromUser) {
    if (!this.connected) return;
    const w = new Writer(); w.str(fromUser);
    this._send(makeFrame(MSG.C2S_FRIEND_REJECT, w.finish()));
  }
  /** 删除好友 */
  sendFriendRemove(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_FRIEND_REMOVE, w.finish()));
  }
  /** 拉黑 */
  sendFriendBlock(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_FRIEND_BLOCK, w.finish()));
  }
  /** 取消拉黑 */
  sendFriendUnblock(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_FRIEND_UNBLOCK, w.finish()));
  }
  /** 请求好友列表 */
  sendFriendList() {
    if (!this.connected) return;
    this._send(makeFrame(MSG.C2S_FRIEND_LIST, new Uint8Array(0)));
  }
  /** 创建公会 */
  sendGuildCreate(name) {
    if (!this.connected) return;
    const w = new Writer(); w.str(name);
    this._send(makeFrame(MSG.C2S_GUILD_CREATE, w.finish()));
  }
  /** 解散公会 */
  sendGuildDisband() {
    if (!this.connected) return;
    this._send(makeFrame(MSG.C2S_GUILD_DISBAND, new Uint8Array(0)));
  }
  /** 申请入会 */
  sendGuildApply(guildId) {
    if (!this.connected) return;
    const w = new Writer(); w.u32(guildId);
    this._send(makeFrame(MSG.C2S_GUILD_APPLY, w.finish()));
  }
  /** 审批入会 */
  sendGuildApprove(applicantName, approve) {
    if (!this.connected) return;
    const w = new Writer(); w.str(applicantName); w.u8(approve ? 1 : 0);
    this._send(makeFrame(MSG.C2S_GUILD_APPROVE, w.finish()));
  }
  /** 踢出成员 */
  sendGuildKick(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_GUILD_KICK, w.finish()));
  }
  /** 晋升 */
  sendGuildPromote(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_GUILD_PROMOTE, w.finish()));
  }
  /** 降级 */
  sendGuildDemote(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_GUILD_DEMOTE, w.finish()));
  }
  /** 退出公会 */
  sendGuildLeave() {
    if (!this.connected) return;
    this._send(makeFrame(MSG.C2S_GUILD_LEAVE, new Uint8Array(0)));
  }
  /** 转让会长 */
  sendGuildTransfer(targetName) {
    if (!this.connected) return;
    const w = new Writer(); w.str(targetName);
    this._send(makeFrame(MSG.C2S_GUILD_TRANSFER, w.finish()));
  }
  /** 编辑公告 */
  sendGuildNotice(notice) {
    if (!this.connected) return;
    const w = new Writer(); w.str(notice);
    this._send(makeFrame(MSG.C2S_GUILD_NOTICE, w.finish()));
  }
  /** 请求公会信息 */
  sendGuildInfo() {
    if (!this.connected) return;
    this._send(makeFrame(MSG.C2S_GUILD_INFO, new Uint8Array(0)));
  }
  /** 请求公会列表 */
  sendGuildList(keyword = '') {
    if (!this.connected) return;
    const w = new Writer(); w.str(keyword);
    this._send(makeFrame(MSG.C2S_GUILD_LIST, w.finish()));
  }
  /** 发送聊天消息 */
  sendChat(channel, target, content) {
    if (!this.connected) return;
    const w = new Writer(); w.u8(channel); w.str(target); w.str(content);
    this._send(makeFrame(MSG.C2S_CHAT_SEND, w.finish()));
  }
  /** 通用二进制发送：type + payload（ArrayBuffer） */
  send(type, payload) {
    if (!this.connected) return;
    this._send(makeFrame(type, payload));
  }
  close() {
    this.connected = false;
    if (this.ws) this.ws.close();
  }
}
