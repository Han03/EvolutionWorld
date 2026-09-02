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
  // S2C
  S2C_HELLO: 0x81, S2C_SNAPSHOT: 0x82, S2C_ENTER: 0x83,
  S2C_LEAVE: 0x84, S2C_UPDATE: 0x85, S2C_SELF: 0x86,
  S2C_EVENT: 0x87, S2C_PING: 0x88, S2C_KICK: 0x89, S2C_ERROR: 0x8A,
  S2C_BOSS: 0x8B,
  S2C_SHOP: 0x8C, S2C_INVENTORY: 0x8D, S2C_LOOT: 0x8E, S2C_STATS: 0x8F,
  S2C_SKILLS: 0x90, S2C_SKILL_CAST: 0x91, S2C_BUFFS: 0x92, S2C_CONSOLE: 0x93,
};
// 世界共享事件类型（S2C_EVENT 首字节）
export const EVT = { DAMAGE: 1, DEATH: 2, RESPAWN: 3, SKILL: 4, DROP: 5, SKILL_CASTING: 6, SKILL_CANCEL: 7 };
// Boss 状态（S2C_BOSS.state）
export const BOSS_STATE = { IDLE: 0, ENGAGE: 1, DEAD: 2 };
export const MASK = { POS: 0x01, VEL: 0x02, STATE: 0x04, INTENT: 0x08 };
export const KIND = { PLAYER: 1, MONSTER: 2, NPC: 3, ITEM: 4 };
export const ST = { MOVING: 0x01, GROUNDED: 0x02 };

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
/** 输入消息：seq + 移动 + 跳跃 + 预测位置（绝对量化） */
export function encodeInput(seq, moveX, moveZ, jump, px, py, pz) {
  const w = new Writer();
  w.u32(seq >>> 0)
    .i16(qMove(moveX)).i16(qMove(moveZ)).u8(jump ? 1 : 0)
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
/** 拾取地面掉落物：drop wid */
export function encodePickup(dropWid) {
  const w = new Writer();
  w.u32(dropWid >>> 0);
  return makeFrame(MSG.C2S_PICKUP, w.finish());
}
/** 穿戴/卸下装备：槽位值(1..6) + itemId（0=卸下） */
export function encodeEquip(slot, itemId) {
  const w = new Writer();
  w.u8(slot & 0xFF).u32(itemId >>> 0);
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
  if (kind === KIND.ITEM) {
    itemId = r.u32();
    gold = r.u32();
    name = '';
  } else {
    name = r.str();
  }
  // AI 意图块（怪物/NPC/Boss，与服务端 writeEntityFull 对应）：半径 + aiState + 目标速度 + 速度倍率
  let radius = 0, aiState = 0, tx = 0, tz = 0, speedMult = 100;
  if (kind === KIND.MONSTER || kind === KIND.NPC) {
    radius = dq(r.u16());
    aiState = r.u8();
    tx = dq(r.i16());
    tz = dq(r.i16());
    speedMult = r.u8();
  }
  return {
    wid, kind, state,
    x: dq(dx) + refX, y: dq(dy) + refY, z: dq(dz) + refZ,
    vx: dq(vx), vz: dq(vz),
    name, itemId, gold,
    radius, aiState, tx, tz, speedMult,
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
      const count = r.u16();
      const entities = [];
      for (let i = 0; i < count; i++) entities.push(decodeEntityFull(r, refX, refY, refZ));
      return { type, tick, entities };
    }
    case MSG.S2C_ENTER: {
      const count = r.u16();
      const entities = [];
      for (let i = 0; i < count; i++) entities.push(decodeEntityFull(r, refX, refY, refZ));
      return { type, entities };
    }
    case MSG.S2C_LEAVE: {
      const count = r.u16();
      const wids = [];
      for (let i = 0; i < count; i++) wids.push(r.u32());
      return { type, wids };
    }
    case MSG.S2C_UPDATE: {
      const count = r.u16();
      const updates = [];
      for (let i = 0; i < count; i++) {
        const wid = r.u32();
        const mask = r.u8();
        const u = { wid, mask };
        if (mask & MASK.POS) {
          // 绝对坐标（相对量 + 自身 ref），与 ENTER/SNAPSHOT 的 decodeEntityFull 一致
          u.x = dq(r.i16()) + refX;
          u.y = dq(r.i16()) + refY;
          u.z = dq(r.i16()) + refZ;
        }
        if (mask & MASK.VEL) { u.vx = dq(r.i16()); u.vz = dq(r.i16()); }
        if (mask & MASK.STATE) u.state = r.u8();
        if (mask & MASK.INTENT) {
          u.aiState = r.u8();
          u.tx = dq(r.i16());
          u.tz = dq(r.i16());
          u.speedMult = r.u8();
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
    case MSG.S2C_BOSS: {
      const wid = r.u32();
      const state = r.u8();
      const phase = r.u8();
      const hp = r.f32();
      const maxHp = r.f32();
      const target = r.i32();
      const x = dq(r.i32());
      const y = dq(r.i16());
      const z = dq(r.i32());
      const name = r.str();
      return { type, wid, state, phase, hp, maxHp, target, x, y, z, name };
    }
    case MSG.S2C_SHOP: {
      const shopId = r.u32();
      const name = r.str();
      const count = r.u16();
      const entries = [];
      for (let i = 0; i < count; i++) {
        entries.push({ itemId: r.u32(), price: r.u32(), stock: r.u16() });
      }
      return { type, shopId, name, entries };
    }
    case MSG.S2C_INVENTORY: {
      const gold = r.u32();
      const equipCount = r.u8();
      const equip = {};
      for (let i = 0; i < equipCount; i++) {
        const slot = r.u8();
        const itemId = r.u32();
        if (itemId) equip[slot] = itemId;
      }
      const invCount = r.u16();
      const inventory = {};
      for (let i = 0; i < invCount; i++) {
        const itemId = r.u32();
        const cnt = r.u16();
        inventory[itemId] = cnt;
      }
      return { type, gold, equip, inventory };
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
      return { type, maxHp, maxMp, attack, defense, hp, mp };
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
