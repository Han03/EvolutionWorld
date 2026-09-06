/**
 * protocol.js - 客户端二进制协议编解码（与服务端 C++ protocol.cpp 逐位对应）
 * 帧头：magic(2) + version(1) + type(1) + flags(1) + seq(2) + len(2) + payload
 * 小端编码；位置 0.01m 量化；AOI 内实体相对自身位置 int16 编码
 */
export const MSG = {
  // C2S
  C2S_INPUT: 0x01, C2S_EVENT: 0x02, C2S_PONG: 0x03, C2S_ATTACK: 0x04,
  C2S_SHOP_OPEN: 0x05, C2S_SHOP_BUY: 0x06, C2S_PICKUP: 0x07,
  C2S_EQUIP: 0x08, C2S_USE_ITEM: 0x09,
  C2S_CAST_SKILL: 0x0A, C2S_CONSOLE: 0x0B,
  // 任务系统 C2S
  C2S_QUEST_ACCEPT: 0x0C, C2S_QUEST_ABANDON: 0x0D, C2S_QUEST_TURNIN: 0x0E,
  C2S_QUEST_LIST: 0x0F, C2S_QUEST_TRACK: 0x17, C2S_TALK_NPC: 0x18,
  // 社交系统 C2S
  C2S_FRIEND_ADD: 0x10, C2S_FRIEND_ACCEPT: 0x11, C2S_FRIEND_REJECT: 0x12,
  C2S_FRIEND_REMOVE: 0x13, C2S_FRIEND_BLOCK: 0x14, C2S_FRIEND_UNBLOCK: 0x15,
  C2S_FRIEND_LIST: 0x16,
  C2S_GUILD_CREATE: 0x20, C2S_GUILD_DISBAND: 0x21, C2S_GUILD_APPLY: 0x22,
  C2S_GUILD_APPROVE: 0x23, C2S_GUILD_KICK: 0x24, C2S_GUILD_PROMOTE: 0x25,
  C2S_GUILD_DEMOTE: 0x26, C2S_GUILD_LEAVE: 0x27, C2S_GUILD_TRANSFER: 0x28,
  C2S_GUILD_NOTICE: 0x29, C2S_GUILD_INFO: 0x2A, C2S_GUILD_LIST: 0x2B,
  C2S_CHAT_SEND: 0x30,
  // 经济系统 C2S（0x40-0x4F）
  C2S_SHOP_SELL: 0x40, C2S_ENHANCE: 0x41, C2S_DECOMPOSE: 0x42,
  C2S_CRAFT_LIST: 0x43, C2S_CRAFT: 0x44,
  C2S_WAREHOUSE_OPEN: 0x45, C2S_WAREHOUSE_DEPOSIT: 0x46,
  C2S_WAREHOUSE_WITHDRAW: 0x47, C2S_WAREHOUSE_EXPAND: 0x48,
  // S2C
  S2C_HELLO: 0x81, S2C_SNAPSHOT: 0x82, S2C_ENTER: 0x83,
  S2C_LEAVE: 0x84, S2C_UPDATE: 0x85, S2C_SELF: 0x86,
  S2C_EVENT: 0x87, S2C_PING: 0x88, S2C_KICK: 0x89, S2C_ERROR: 0x8A,
  S2C_ELITE: 0x8B,
  S2C_SHOP: 0x8C, S2C_INVENTORY: 0x8D, S2C_LOOT: 0x8E, S2C_STATS: 0x8F,
  S2C_SKILLS: 0x90, S2C_SKILL_CAST: 0x91, S2C_BUFFS: 0x92, S2C_CONSOLE: 0x93,
  // 地形数据已变更（零 payload）：服务端保存编辑层或重执行世界初始化后广播，
  // 收到方需重拉 /api/terrain/mask 与 /api/terrain/edit（详见 boot.js reloadTerrain）。
  S2C_TERRAIN_DIRTY: 0x94,
  // 任务系统 S2C
  S2C_QUEST_LIST: 0xD0, S2C_QUEST_PROGRESS: 0xD1, S2C_QUEST_RESULT: 0xD2,
  S2C_QUEST_COMPLETE: 0xD3, S2C_QUEST_NOTIFY: 0xD4, S2C_QUEST_CHAIN: 0xD5,
  S2C_NPC_DIALOGUE: 0xD6, // NPC 对话文本 (str: dialogue)
  // 社交系统 S2C
  S2C_FRIEND_REQUEST: 0xA0, S2C_FRIEND_LIST: 0xA1, S2C_FRIEND_STATUS: 0xA2,
  S2C_FRIEND_RESULT: 0xA3,
  S2C_GUILD_INFO: 0xB0, S2C_GUILD_RESULT: 0xB1, S2C_GUILD_NOTIFY: 0xB2,
  S2C_GUILD_LIST: 0xB3, S2C_GUILD_APPLY_N: 0xB4,
  S2C_CHAT_MSG: 0xC0, S2C_CHAT_HISTORY: 0xC1, S2C_CHAT_RESULT: 0xC2,
  // 经济系统 S2C（0xE0-0xEF）
  S2C_ENHANCE: 0xE0, S2C_DECOMPOSE: 0xE1, S2C_CRAFT_LIST: 0xE2, S2C_CRAFT: 0xE3,
  S2C_WAREHOUSE: 0xE4, S2C_WAREHOUSE_RESULT: 0xE5, S2C_SELL_RESULT: 0xE6,
};
// 世界共享事件类型（S2C_EVENT 首字节）
export const EVT = { DAMAGE: 1, DEATH: 2, RESPAWN: 3, SKILL: 4, DROP: 5, SKILL_CASTING: 6, SKILL_CANCEL: 7, HEAL: 8 };
// 精英状态（S2C_ELITE.state）
export const ELITE_STATE = { IDLE: 0, ENGAGE: 1, DEAD: 2 };
export const MASK = { POS: 0x01, VEL: 0x02, STATE: 0x04, INTENT: 0x08 };
export const KIND = { PLAYER: 1, MONSTER: 2, NPC: 3, ITEM: 4 };
export const ST = { MOVING: 0x01, GROUNDED: 0x02 };
// NPC 标签位标志（与服务端 npc.h NpcTag 对齐；可组合，客户端据此决定交互菜单）
export const NPC_TAG = {
  BASIC: 1, QUEST: 2, SHOP: 4, BLACKSMITH: 8,
  TELEPORT: 16, CRAFT: 64, BANK: 128,
};
// 聊天频道
export const CHAT = { PRIVATE: 0, FRIEND: 1, GUILD: 2, WORLD: 3, TEAM: 4, SYSTEM: 5 };
export const CHAT_NAMES = { 0: '私聊', 1: '好友', 2: '公会', 3: '世界', 4: '队伍', 5: '系统' };
// 好友操作码
export const FRIEND_OP = { ADD: 0, ACCEPT: 1, REJECT: 2, REMOVE: 3, BLOCK: 4, UNBLOCK: 5 };
// 好友结果码
export const FRIEND_RESULT = {
  0: '成功', 1: '玩家不存在', 2: '不能加自己', 3: '已经是好友',
  4: '好友列表已满', 5: '被对方拉黑', 6: '请求队列已满', 7: '没有找到请求', 8: '不能拉黑自己',
};
// 公会角色
export const GUILD_ROLE = { 0: '会长', 1: '副会长', 2: '成员', 3: '新成员' };
// 公会结果码
export const GUILD_RESULT = {
  0: '成功', 1: '公会不存在', 2: '已在公会中', 3: '不在公会中',
  4: '无权限', 5: '名称已存在', 6: '公会已满', 7: '金币不足',
  8: '没有申请', 9: '目标不在公会中', 10: '不能踢会长', 11: '目标等级更高',
};
// 公会事件通知
export const GUILD_NOTIFY = {
  0: '新成员加入', 1: '成员离开', 2: '被踢出', 3: '公告变更',
  4: '晋升', 5: '降级', 6: '公会解散', 7: '会长转让',
};
// 聊天结果码
export const CHAT_RESULT = {
  0: '成功', 1: '目标离线（已存入信箱）', 2: '目标不存在', 3: '不能私聊自己',
  4: '被对方拉黑', 5: '不在公会', 6: '发言频率限制', 7: '消息过长', 8: '消息为空', 9: '无效频道',
};

const SCALE = 100;    // 位置 0.01m
const REL_CLAMP = 32760;

// ---------------- 读取器（小端） ----------------
export class Reader {
  constructor(buf) {
    if (buf instanceof Uint8Array) {
      this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      this.dv = new DataView(buf);
    }
    this.off = 0;
  }
  get left() { return this.dv.byteLength - this.off; }
  _need(n) { if (this.left < n) throw new Error('protocol: short read'); }
  u8() { this._need(1); return this.dv.getUint8(this.off++); }
  u16() { this._need(2); const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  u32() { this._need(4); const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  // u64 以 Number 表示（lo + hi*2^32），对 < 2^53 精确；instId 为游戏计数器，安全
  u64() {
    this._need(8);
    const lo = this.dv.getUint32(this.off, true);
    const hi = this.dv.getUint32(this.off + 4, true);
    this.off += 8;
    return lo + hi * 4294967296;
  }
  i16() { this._need(2); const v = this.dv.getInt16(this.off, true); this.off += 2; return v; }
  i32() { this._need(4); const v = this.dv.getInt32(this.off, true); this.off += 4; return v; }
  f32() { this._need(4); const v = this.dv.getFloat32(this.off, true); this.off += 4; return v; }
  str() {
    const len = this.u8();
    this._need(len);
    const s = new TextDecoder().decode(new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.off, len));
    this.off += len;
    return s;
  }
}

// ---------------- 写入器（小端） ----------------
export class Writer {
  constructor() { this.buf = new Uint8Array(64); this.len = 0; }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v) { this._ensure(1); this.buf[this.len++] = v & 0xFF; return this; }
  u16(v) { this._ensure(2); new DataView(this.buf.buffer).setUint16(this.len, v, true); this.len += 2; return this; }
  u32(v) { this._ensure(4); new DataView(this.buf.buffer).setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  u64(v) {
    this._ensure(8);
    const dv = new DataView(this.buf.buffer);
    dv.setUint32(this.len, v >>> 0, true);                       // 低 32 位
    dv.setUint32(this.len + 4, Math.floor(v / 4294967296) >>> 0, true); // 高 32 位
    this.len += 8;
    return this;
  }
  i16(v) { this._ensure(2); new DataView(this.buf.buffer).setInt16(this.len, v, true); this.len += 2; return this; }
  i32(v) { this._ensure(4); new DataView(this.buf.buffer).setInt32(this.len, v, true); this.len += 4; return this; }
  bytes(b) { this._ensure(b.length); this.buf.set(b, this.len); this.len += b.length; return this; }
  str(s) {
    const e = new TextEncoder().encode(s);
    this.u8(e.length);
    return this.bytes(e);
  }
  finish() { return this.buf.slice(0, this.len).buffer; }
}

// ---------------- 量化 ----------------
export function qAbs(v) { return Math.round(v * SCALE); }
/** 把世界坐标吸附到协议的 0.01m 量化格，与服务端 dqAbs(qAbs(v)) 逐位相同。
 *  客户端物理步进必须在**碰撞判定之前**调用它：服务端拿到并校验的就是这个吸附值，
 *  若在未吸附的位置上判定可通行，服务端就会去校验一个客户端从未验证过的点
 *  （每轴 ±0.005m，地形边界处足以翻转圆盘判定）→ 走容差夹紧 → correction 往返 → 橡皮筋。 */
export function qSnap(v) { return qAbs(v) / SCALE; }
export function qRel(v, ref) {
  let q = Math.round((v - ref) * SCALE);
  q = Math.max(-REL_CLAMP, Math.min(REL_CLAMP, q));
  return q;
}
export function dq(v) { return v / SCALE; }
export function qMove(v) { return Math.max(-1000, Math.min(1000, Math.round(v * 1000))); }

// ---------------- 帧封装 ----------------
export function makeFrame(type, payload, flags = 0, seq = 0) {
  const w = new Writer();
  w.u8(0x45).u8(0x57).u8(1).u8(type).u8(flags).u16(seq & 0xFFFF).u16(payload.byteLength);
  w.bytes(new Uint8Array(payload));
  return w.finish();
}

// ---------------- C2S 编码 ----------------
/** 输入消息：seq + 预测位置（绝对量化，位置上报模式） */
export function encodeInput(seq, px, py, pz) {
  const w = new Writer();
  w.u32(seq >>> 0)
    .i32(qAbs(px)).i16(qAbs(py)).i32(qAbs(pz));
  return makeFrame(MSG.C2S_INPUT, w.finish());
}

/** 攻击世界实体：目标 wid + 技能槽（0=普攻） */
export function encodeAttack(targetWid, slot = 0) {
  const w = new Writer();
  w.u32(targetWid >>> 0).u8(slot & 0xFF);
  return makeFrame(MSG.C2S_ATTACK, w.finish());
}
/** 打开商店：目标商店 NPC wid */
export function encodeShopOpen(npcWid) {
  const w = new Writer();
  w.u32(npcWid >>> 0);
  return makeFrame(MSG.C2S_SHOP_OPEN, w.finish());
}
/** 购买物品：itemId + 数量 */
export function encodeShopBuy(itemId, count = 1) {
  const w = new Writer();
  w.u32(itemId >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_SHOP_BUY, w.finish());
}
/** 出售回收：isInstance(装备实例) + instId + itemId + count（与服务端 decodeShopSell 逐位对应） */
export function encodeShopSell(isInstance, instId, itemId, count = 1) {
  const w = new Writer();
  w.u8(isInstance ? 1 : 0).u64(instId || 0).u32((itemId || 0) >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_SHOP_SELL, w.finish());
}
/** 装备强化：instId + useProtect（与服务端 decodeEnhance 逐位对应） */
export function encodeEnhance(instId, useProtect = false) {
  const w = new Writer();
  w.u64(instId || 0).u8(useProtect ? 1 : 0);
  return makeFrame(MSG.C2S_ENHANCE, w.finish());
}
/** 装备分解：instId（与服务端 decodeDecompose 逐位对应） */
export function encodeDecompose(instId) {
  const w = new Writer();
  w.u64(instId || 0);
  return makeFrame(MSG.C2S_DECOMPOSE, w.finish());
}
/** 合成配方列表：npcWid（与服务端 decodeCraftList 逐位对应） */
export function encodeCraftList(npcWid) {
  const w = new Writer();
  w.u32((npcWid || 0) >>> 0);
  return makeFrame(MSG.C2S_CRAFT_LIST, w.finish());
}
/** 物品合成：recipeId + count（与服务端 decodeCraft 逐位对应） */
export function encodeCraft(recipeId, count = 1) {
  const w = new Writer();
  w.u32((recipeId || 0) >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_CRAFT, w.finish());
}
/** 打开仓库：npcWid（与服务端 decodeWarehouseOpen 逐位对应） */
export function encodeWarehouseOpen(npcWid) {
  const w = new Writer();
  w.u32((npcWid || 0) >>> 0);
  return makeFrame(MSG.C2S_WAREHOUSE_OPEN, w.finish());
}
/** 存金约定：itemId==0 视为金币（amount=count） */
/** 仓库存入：isInstance + instId + itemId + count（与服务端 decodeWarehouseMove 逐位对应） */
export function encodeWarehouseDeposit(isInstance, instId, itemId, count = 1) {
  const w = new Writer();
  w.u8(isInstance ? 1 : 0).u64(instId || 0).u32((itemId || 0) >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_WAREHOUSE_DEPOSIT, w.finish());
}
/** 仓库取出：isInstance + instId + itemId + count（与服务端 decodeWarehouseMove 逐位对应） */
export function encodeWarehouseWithdraw(isInstance, instId, itemId, count = 1) {
  const w = new Writer();
  w.u8(isInstance ? 1 : 0).u64(instId || 0).u32((itemId || 0) >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_WAREHOUSE_WITHDRAW, w.finish());
}
/** 仓库扩展：无 payload（与服务端一致） */
export function encodeWarehouseExpand() {
  const w = new Writer();
  return makeFrame(MSG.C2S_WAREHOUSE_EXPAND, w.finish());
}
/** 拾取地面掉落物：drop wid */
export function encodePickup(dropWid) {
  const w = new Writer();
  w.u32(dropWid >>> 0);
  return makeFrame(MSG.C2S_PICKUP, w.finish());
}
/** 穿戴/卸下装备：槽位值(1..6) + instId（装备实例 ID，0=卸下） */
export function encodeEquip(slot, instId) {
  const w = new Writer();
  w.u8(slot & 0xFF).u64(instId);
  return makeFrame(MSG.C2S_EQUIP, w.finish());
}
/** 使用消耗品：itemId + 数量 */
export function encodeUseItem(itemId, count = 1) {
  const w = new Writer();
  w.u32(itemId >>> 0).u16(count & 0xFFFF);
  return makeFrame(MSG.C2S_USE_ITEM, w.finish());
}
/** 施放技能：skillId + 目标 wid（0=无）+ 落点 x/z（绝对量化） */
export function encodeCastSkill(skillId, targetWid, tx, tz) {
  const w = new Writer();
  w.u32(skillId >>> 0).u32(targetWid >>> 0).i32(qAbs(tx)).i32(qAbs(tz));
  return makeFrame(MSG.C2S_CAST_SKILL, w.finish());
}
/** 控制台命令（UTF-8 文本，用于功能测试） */
export function encodeConsole(cmd) {
  const w = new Writer();
  w.str(cmd);
  return makeFrame(MSG.C2S_CONSOLE, w.finish());
}
// ---------------- S2C 解码（返回已解实体描述） ----------------
export function decodeEntityFull(r, refX, refY, refZ) {
  const wid = r.u32();
  const kind = r.u8();
  const state = r.u8();
  const dx = r.i16(), dy = r.i16(), dz = r.i16();
  const vx = r.i16(), vz = r.i16();
  let itemId = 0, gold = 0, name = '';
  let dropInstId = 0, dropEnhance = 0;   // 装备实例掉落（instId!=0 为装备，携带强化）
  if (kind === KIND.ITEM) {
    itemId = r.u32();
    gold = r.u32();
    dropInstId = r.u64();
    dropEnhance = r.u8();
    name = '';
  } else {
    name = r.str();
  }
  // AI 意图块（怪物/NPC/精英，与服务端 writeEntityFull 对应）：半径 + aiState + 目标速度 + 速度倍率
  let radius = 0, aiState = 0, tx = 0, tz = 0, speedMult = 100;
  let hp = 0, maxHp = 0, isElite = false, invincible = false;
  let npcId = '', npcTag = 0;
  if (kind === KIND.MONSTER || kind === KIND.NPC) {
    radius = dq(r.u16());
    aiState = r.u8();
    tx = dq(r.i16());
    tz = dq(r.i16());
    speedMult = r.u8();
    // 怪物生命值 + 精英标志 + 无敌标志（服务端 writeEntityFull 对齐）
    if (kind === KIND.MONSTER) {
      hp = r.u16();
      maxHp = r.u16();
      isElite = r.u8() !== 0;
      invincible = r.u8() !== 0;
    }
  }
  // NPC 插件：NPC 实体额外携带 npcId + npcTag（客户端据此渲染交互菜单）
  if (kind === KIND.NPC) {
    npcId = r.str();
    npcTag = r.u32();
  }
  return {
    wid, kind, state,
    x: dq(dx) + refX, y: dq(dy) + refY, z: dq(dz) + refZ,
    vx: dq(vx), vz: dq(vz),
    name, itemId, gold,
    dropInstId, dropEnhance,
    radius, aiState, tx, tz, speedMult,
    hp, maxHp, isElite, invincible,
    npcId, npcTag,
  };
}
/** 解析一个 S2C 消息，返回 {type, ...}；ref = 自身预测位置 */
export function parseS2C(type, payload, refX, refY, refZ) {
  const r = new Reader(payload);
  switch (type) {
    case MSG.S2C_HELLO: {
      const seed = r.i32();
      const viewRange = r.f32();
      const chunkSize = r.f32();
      const tickRate = r.f32();
      // 自身绝对位置（HELLO 额外携带，用于初始化预测器）
      const ax = dq(r.i32());
      const ay = dq(r.i16());
      const az = dq(r.i32());
      const self = decodeEntityFull(r, ax, ay, az);
      self.x = ax; self.y = ay; self.z = az;
      return { type, seed, viewRange, chunkSize, tickRate, self };
    }
    case MSG.S2C_SNAPSHOT: {
      const tick = r.u32();
      // 服务端参考坐标：消除客户端预测与服务端广播之间的 1-tick 偏差
      const sRefX = dq(r.i32()), sRefY = dq(r.i16()), sRefZ = dq(r.i32());
      const count = r.u16();
      const entities = [];
      for (let i = 0; i < count; i++) entities.push(decodeEntityFull(r, sRefX, sRefY, sRefZ));
      return { type, tick, entities };
    }
    case MSG.S2C_ENTER: {
      // 服务端参考坐标
      const sRefX = dq(r.i32()), sRefY = dq(r.i16()), sRefZ = dq(r.i32());
      const count = r.u16();
      const entities = [];
      for (let i = 0; i < count; i++) entities.push(decodeEntityFull(r, sRefX, sRefY, sRefZ));
      return { type, entities };
    }
    case MSG.S2C_LEAVE: {
      const count = r.u16();
      const wids = [];
      for (let i = 0; i < count; i++) wids.push(r.u32());
      return { type, wids };
    }
    case MSG.S2C_UPDATE: {
      // 服务端参考坐标：消除客户端预测与服务端广播之间的 1-tick 偏差
      const sRefX = dq(r.i32()), sRefY = dq(r.i16()), sRefZ = dq(r.i32());
      const count = r.u16();
      const updates = [];
      for (let i = 0; i < count; i++) {
        const wid = r.u32();
        const mask = r.u8();
        const u = { wid, mask };
        if (mask & MASK.POS) {
          // 绝对坐标 = 相对量 + 服务端 ref（而非客户端预测 ref，两者差 1 tick）
          u.x = dq(r.i16()) + sRefX;
          u.y = dq(r.i16()) + sRefY;
          u.z = dq(r.i16()) + sRefZ;
        }
        if (mask & MASK.VEL) { u.vx = dq(r.i16()); u.vz = dq(r.i16()); }
        if (mask & MASK.STATE) u.state = r.u8();
        if (mask & MASK.INTENT) {
          u.aiState = r.u8();
          u.tx = dq(r.i16());
          u.tz = dq(r.i16());
          u.speedMult = r.u8();
          // 怪物生命值（服务端 update INTENT 块对齐）
          u.hp = r.u16();
          u.maxHp = r.u16();
          // 无敌标志（恢复态免疫伤害；NPC 恒 0）
          u.invincible = r.u8() !== 0;
        }
        updates.push(u);
      }
      return { type, updates };
    }
    case MSG.S2C_SELF: {
      const reason = r.str();
      const x = dq(r.i32());
      const y = dq(r.i16());
      const z = dq(r.i32());
      const tick = r.u32();
      return { type, reason, x, y, z, tick };
    }
    case MSG.S2C_KICK: {
      const reason = r.str();
      return { type, reason };
    }
    case MSG.S2C_ERROR: {
      const code = r.u8();
      const msg = r.str();
      return { type, code, msg };
    }
    case MSG.S2C_PING: {
      const ts = r.u32();
      return { type, ts };
    }

    case MSG.S2C_SHOP: {
      const shopId = r.u32();
      const name = r.str();
      const desc = r.str();
      const shopType = r.u8();
      const currencyItemId = r.u32();
      const count = r.u16();
      const entries = [];
      for (let i = 0; i < count; i++) {
        entries.push({
          itemId: r.u32(), price: r.u32(), discountPrice: r.u32(), stock: r.u16(),
          buyLimit: r.u32(), category: r.u8(), refreshType: r.u8(), sellPrice: r.u32(),
          bought: r.u32(),
        });
      }
      return { type, shopId, name, desc, shopType, currencyItemId, entries };
    }
    case MSG.S2C_ENHANCE: {
      const ok = r.u8() !== 0;
      const failCode = r.u8();
      const instId = r.u64();
      const newLevel = r.u8();
      const success = r.u8() !== 0;
      const goldLeft = r.u32();
      return { type, ok, failCode, instId, newLevel, success, goldLeft };
    }
    case MSG.S2C_DECOMPOSE: {
      const ok = r.u8() !== 0;
      const failCode = r.u8();
      const count = r.u16();
      const items = [];
      for (let i = 0; i < count; i++) items.push({ itemId: r.u32(), count: r.u16() });
      const goldGain = r.u32();
      return { type, ok, failCode, items, goldGain };
    }
    case MSG.S2C_CRAFT_LIST: {
      const count = r.u16();
      const recipeIds = [];
      for (let i = 0; i < count; i++) recipeIds.push(r.u32());
      return { type, recipeIds };
    }
    case MSG.S2C_CRAFT: {
      const ok = r.u8() !== 0;
      const failCode = r.u8();
      const recipeId = r.u32();
      const resultItemId = r.u32();
      const resultCount = r.u16();
      const isInstance = r.u8() !== 0;
      const instId = r.u64();
      return { type, ok, failCode, recipeId, resultItemId, resultCount, isInstance, instId };
    }
    case MSG.S2C_WAREHOUSE: {
      const gold = r.u32();
      const unlocked = r.u32();
      const slotCount = r.u16();
      const slots = [];
      for (let i = 0; i < slotCount; i++) {
        slots.push({
          isInstance: r.u8() !== 0, instId: r.u64(), itemId: r.u32(),
          enhance: r.u8(), locked: r.u8() !== 0, count: r.u32(),
        });
      }
      return { type, gold, unlocked, slots };
    }
    case MSG.S2C_WAREHOUSE_RESULT: {
      const op = r.u8();
      const code = r.u8();
      return { type, op, code };
    }
    case MSG.S2C_SELL_RESULT: {
      const ok = r.u8();
      const goldGain = r.u32();
      return { type, ok, goldGain };
    }
    case MSG.S2C_INVENTORY: {
      const gold = r.u32();
      // 已穿戴装备实例：slot -> {instId, itemId, enhance}
      const equipCount = r.u8();
      const equip = {};
      for (let i = 0; i < equipCount; i++) {
        const slot = r.u8();
        const instId = r.u64();
        const itemId = r.u32();
        const enhance = r.u8();
        if (instId) equip[slot] = { instId, itemId, enhance };
      }
      // 背包装备实例：[{instId, itemId, enhance, locked}]
      const bagCount = r.u16();
      const equipBag = [];
      for (let i = 0; i < bagCount; i++) {
        const instId = r.u64();
        const itemId = r.u32();
        const enhance = r.u8();
        const locked = r.u8() !== 0;
        equipBag.push({ instId, itemId, enhance, locked });
      }
      // 堆叠物品：itemId -> 数量
      const invCount = r.u16();
      const inventory = {};
      for (let i = 0; i < invCount; i++) {
        const itemId = r.u32();
        const cnt = r.u16();
        inventory[itemId] = cnt;
      }
      return { type, gold, equip, equipBag, inventory };
    }
    case MSG.S2C_LOOT: {
      const ok = r.u8();
      const itemId = r.u32();
      const count = r.u16();
      const gold = r.u32();
      return { type, ok, itemId, count, gold };
    }
    case MSG.S2C_STATS: {
      const maxHp = r.u32();
      const maxMp = r.u32();
      const attack = r.u32();
      const defense = r.u32();
      const hp = r.u32();
      const mp = r.u32();
      const level = r.u32();
      const exp = r.u32();
      const expToNext = r.u32();
      return { type, maxHp, maxMp, attack, defense, hp, mp, level, exp, expToNext };
    }
    case MSG.S2C_SKILLS: {
      const count = r.u16();
      const skills = [];
      for (let i = 0; i < count; i++) {
        skills.push({ id: r.u32(), cdMs: r.u32() });
      }
      return { type, skills };
    }
    case MSG.S2C_SKILL_CAST: {
      const ok = r.u8();
      const skillId = r.u32();
      const targetWid = r.u32();
      const x = dq(r.i32());
      const z = dq(r.i32());
      const castTimeMs = r.u16();
      return { type, ok, skillId, targetWid, x, z, castTimeMs };
    }
    case MSG.S2C_BUFFS: {
      const count = r.u16();
      const buffs = [];
      for (let i = 0; i < count; i++) {
        buffs.push({ skillId: r.u32(), type: r.u8(), value: r.f32(), remainSec: r.f32() });
      }
      return { type, buffs };
    }
    case MSG.S2C_CONSOLE: {
      const text = r.str();
      return { type, text };
    }
    case MSG.S2C_TERRAIN_DIRTY:
      return { type };   // 零 payload：仅作信号，数据走 HTTP 重拉
    case MSG.S2C_QUEST_LIST:
    case MSG.S2C_QUEST_PROGRESS:
    case MSG.S2C_QUEST_RESULT:
    case MSG.S2C_QUEST_COMPLETE:
    case MSG.S2C_QUEST_NOTIFY:
      // 任务消息由 quests.js 独立解码（需要 Reader 实例），此处返回 type 占位
      return { type };
    case MSG.S2C_NPC_DIALOGUE: {
      const dialogue = r.str();
      return { type, dialogue };
    }
    // ---- 社交系统 S2C 解码 ----
    case MSG.S2C_FRIEND_REQUEST: {
      const from = r.str();
      const message = r.str();
      return { type, from, message };
    }
    case MSG.S2C_FRIEND_LIST: {
      const count = r.u16();
      const friends = [];
      for (let i = 0; i < count; i++) {
        friends.push({ name: r.str(), online: r.u8() !== 0, remark: r.str() });
      }
      return { type, friends };
    }
    case MSG.S2C_FRIEND_STATUS: {
      const name = r.str();
      const online = r.u8() !== 0;
      return { type, name, online };
    }
    case MSG.S2C_FRIEND_RESULT: {
      const opCode = r.u8();
      const resultCode = r.u8();
      return { type, opCode, resultCode };
    }
    case MSG.S2C_GUILD_INFO: {
      const guildId = r.u32();
      const name = r.str();
      const notice = r.str();
      const leaderUsername = r.str();
      const memberCount = r.u32();
      const maxMembers = r.u32();
      const level = r.u32();
      const exp = r.u32();
      const logo = r.u32();
      const createdMs = r.u32();
      const mCount = r.u16();
      const members = [];
      for (let i = 0; i < mCount; i++) {
        members.push({
          username: r.str(), role: r.u8(), joinMs: r.u32(),
          lastActiveMs: r.u32(), contributionPts: r.u32(),
          title: r.str(), online: r.u8() !== 0,
        });
      }
      return { type, guildId, name, notice, leaderUsername, memberCount, maxMembers, level, exp, logo, createdMs, members };
    }
    case MSG.S2C_GUILD_RESULT: {
      const opCode = r.u8();
      const code = r.u8();
      const extra = r.str();
      return { type, opCode, code, extra };
    }
    case MSG.S2C_GUILD_NOTIFY: {
      const eventType = r.u8();
      const data = r.str();
      return { type, eventType, data };
    }
    case MSG.S2C_GUILD_LIST: {
      const count = r.u16();
      const guilds = [];
      for (let i = 0; i < count; i++) {
        guilds.push({ guildId: r.u32(), name: r.str(), memberCount: r.u32(), level: r.u32(), logo: r.u32() });
      }
      return { type, guilds };
    }
    case MSG.S2C_GUILD_APPLY_N: {
      const applicant = r.str();
      const guildId = r.u32();
      return { type, applicant, guildId };
    }
    case MSG.S2C_CHAT_MSG: {
      const channel = r.u8();
      const sender = r.str();
      const senderWid = r.u32();
      const content = r.str();
      const timestamp = r.u32();
      return { type, channel, sender, senderWid, content, timestamp };
    }
    case MSG.S2C_CHAT_HISTORY: {
      const count = r.u16();
      const messages = [];
      for (let i = 0; i < count; i++) {
        messages.push({
          channel: r.u8(), sender: r.str(), senderWid: r.u32(),
          target: r.str(), content: r.str(), timestamp: r.u32(),
        });
      }
      return { type, messages };
    }
    case MSG.S2C_CHAT_RESULT: {
      const code = r.u8();
      const errorMsg = r.str();
      return { type, code, errorMsg };
    }
    case MSG.S2C_EVENT: {
      const evtType = r.u8();
      const wid = r.u32();
      const b = r.u32();
      const x = dq(r.i32());
      const z = dq(r.i32());
      return { type, evtType, wid, b, x, z };
    }
    default:
      return { type };
  }
}
