/**
 * 实体数据管理（二进制协议版，Canvas 2D 俯视渲染）
 *  - 当前角色：橙色圆球 + 半透明白色描边
 *  - 其他玩家：绿色圆球 / 怪物：红色圆球 / NPC：蓝色圆球
 * 实体以数字 wid 为键；ENTER 创建、LEAVE 删除、UPDATE 增量更新、SNAPSHOT 校准重建。
 * 仅管理数据 + 位置插值，渲染由 renderer（Canvas2D）完成。
 */
import { KIND } from './protocol.js';
const KIND_NAME = { [KIND.PLAYER]: 'player', [KIND.MONSTER]: 'monster', [KIND.NPC]: 'npc' };
export class EntityViewManager {
  constructor(selfWid) {
    this.selfWid = selfWid;
    this.views = new Map(); // wid -> {wid,kind,name,x,y,z,tx,ty,tz,state}
  }
  _kindName(kind) { return KIND_NAME[kind] || 'monster'; }
  /** ENTER：实体进入视野 */
  applyEnter(entities) {
    for (const e of entities) {
      if (e.wid === this.selfWid) continue;
      if (this.views.has(e.wid)) {
        this._setTarget(e.wid, e.x, e.y, e.z);
      } else {
        this._create(e);
      }
    }
  }
  /** LEAVE：实体离开视野 */
  applyLeave(wids) {
    for (const wid of wids) this.views.delete(wid);
  }
  /** UPDATE：增量更新（相对坐标已在协议层解码为绝对） */
  applyUpdate(updates) {
    for (const u of updates) {
      const v = this.views.get(u.wid);
      if (!v) continue;
      if (u.mask & 0x01) {
        v.tx = u.dx / 100; v.ty = u.dy / 100; v.tz = u.dz / 100;
      }
      if (u.state !== undefined) v.state = u.state;
    }
  }
  /** SNAPSHOT：校准重建（丢包/失步自愈） */
  applySnapshot(entities) {
    const seen = new Set();
    for (const e of entities) {
      if (e.wid === this.selfWid) continue;
      seen.add(e.wid);
      if (this.views.has(e.wid)) {
        this._setTarget(e.wid, e.x, e.y, e.z);
      } else {
        this._create(e);
      }
    }
    for (const wid of this.views.keys()) {
      if (!seen.has(wid)) this.views.delete(wid);
    }
  }
  _setTarget(wid, x, y, z) {
    const v = this.views.get(wid);
    if (!v) return;
    v.tx = x; v.ty = y; v.tz = z;
  }
  _create(e) {
    this.views.set(e.wid, {
      wid: e.wid,
      kind: this._kindName(e.kind),
      name: e.name || (e.kind === KIND.PLAYER ? `玩家${e.wid}` : ''),
      x: e.x, y: e.y, z: e.z,
      tx: e.x, ty: e.y, tz: e.z,
      state: e.state,
    });
  }
  /** 每帧插值（简单 lerp，朝向目标平滑） */
  update(dt) {
    const k = 9;
    const f = Math.min(1, dt * k);
    for (const v of this.views.values()) {
      v.x += (v.tx - v.x) * f;
      v.y += (v.ty - v.y) * f;
      v.z += (v.tz - v.z) * f;
    }
  }
  /** 直接把自身实体放到预测位置（零延迟渲染 + 回退） */
  setSelf(x, y, z) {
    let v = this.views.get(this.selfWid);
    if (!v) {
      v = { wid: this.selfWid, kind: 'player', name: '', x, y, z, tx: x, ty: y, tz: z, state: 0 };
      this.views.set(this.selfWid, v);
    }
    v.x = x; v.y = y; v.z = z;
    v.tx = x; v.ty = y; v.tz = z;
  }
  /** 供渲染器每帧读取（返回普通对象数组） */
  forRender() {
    const out = [];
    for (const v of this.views.values()) {
      if (v.wid === this.selfWid) continue;
      out.push({ wid: v.wid, kind: v.kind, name: v.name, x: v.x, y: v.y, z: v.z, state: v.state });
    }
    return out;
  }
  /** 当前角色位置（相机跟随） */
  selfPosition() {
    const v = this.views.get(this.selfWid);
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 5, z: 0 };
  }
  dispose() { this.views.clear(); }
}
