/**
 * 实体渲染管理
 * 负责把服务端快照中的实体渲染为悬浮球体：
 *  - 当前角色：橙色圆球 + 半透明白色描边
 *  - 其他玩家：绿色圆球 + 名字标签
 *  - 怪物：红色圆球
 *  - NPC：蓝色圆球
 * 使用指数平滑在快照之间插值，保证移动流畅。
 */
import * as THREE from 'three';

const STYLE = {
  player: { color: 0x34d399 },   // 绿色
  monster: { color: 0xf87171 },  // 红色
  npc: { color: 0x60a5fa },      // 蓝色
};
const SELF_COLOR = 0xff8c1a;     // 橙色

export class EntityViewManager {
  constructor(scene, selfId) {
    this.scene = scene;
    this.selfId = selfId;
    this.views = new Map(); // id -> view
    this._sphereGeo = new THREE.SphereGeometry(1, 24, 18);
    this._matCache = new Map(); // styleKey -> material
    this._labelTexCache = new Map();
  }

  _getMat(key, color) {
    if (!this._matCache.has(key)) {
      this._matCache.set(
        key,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.55,
          metalness: 0.05,
          emissive: color,
          emissiveIntensity: 0.12,
        })
      );
    }
    return this._matCache.get(key);
  }

  _makeLabel(text) {
    const w = 256, h = 72;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 30px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 半透明底
    ctx.fillStyle = 'rgba(6,18,32,0.55)';
    const tw = ctx.measureText(text).width;
    ctx.beginPath();
    ctx.roundRect((w - tw) / 2 - 12, 20, tw + 24, 32, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, w / 2, 37);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false })
    );
    sp.scale.set(3.4, 1.0, 1.0);
    sp.renderOrder = 3;
    return sp;
  }

  /** 应用一份快照（实体列表） */
  applySnapshot(entities) {
    const seen = new Set();
    for (const e of entities) {
      seen.add(e.id);
      let view = this.views.get(e.id);
      if (!view) {
        view = this._createView(e);
        this.views.set(e.id, view);
      }
      view.target.set(e.x, e.y, e.z);
    }
    // 移除已消失的实体
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        view.label && this.scene.remove(view.label);
        this.views.delete(id);
      }
    }
  }

  _createView(e) {
    const isSelf = e.id === this.selfId;
    const group = new THREE.Group();

    let mat;
    let outline = null;
    let label = null;

    if (isSelf) {
      mat = this._getMat('self', SELF_COLOR);
      // 半透明白色描边（略大的透明白球壳）
      outline = new THREE.Mesh(
        this._sphereGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.16,
          side: THREE.BackSide,
          depthWrite: false,
        })
      );
      outline.scale.setScalar(1.45);
      outline.renderOrder = 2;
      group.add(outline);
    } else {
      const style = STYLE[e.kind] || STYLE.monster;
      mat = this._getMat(`${e.kind}`, style.color);
      if (e.kind === 'player') {
        label = this._makeLabel(e.username || e.id);
        label.position.y = 1.7;
      } else if (e.name) {
        label = this._makeLabel(e.name);
        label.position.y = 1.7;
      }
    }

    const sphere = new THREE.Mesh(this._sphereGeo, mat);
    sphere.scale.setScalar(e.kind === 'player' ? 0.55 : 0.5);
    group.add(sphere);
    if (label) this.scene.add(label);

    const view = {
      group,
      sphere,
      outline,
      label,
      target: new THREE.Vector3(e.x, e.y, e.z),
      cur: new THREE.Vector3(e.x, e.y, e.z),
      isSelf,
      kind: e.kind,
    };
    this.scene.add(group);
    return view;
  }

  /** 每帧插值并更新位置 */
  update(dt) {
    for (const view of this.views.values()) {
      // 自身由客户端预测驱动（setSelf 已直接放置），不再向服务端快照插值
      if (view.isSelf) continue;
      const k = 9;
      const f = Math.min(1, dt * k);
      view.cur.lerp(view.target, f);
      view.group.position.copy(view.cur);
      if (view.label) {
        view.label.position.set(view.cur.x, view.cur.y + 1.7, view.cur.z);
      }
    }
  }
  /** 直接把自身实体放到预测位置（零延迟渲染 + 回退） */
  setSelf(x, y, z) {
    const view = this.views.get(this.selfId);
    if (!view) return;
    view.cur.set(x, y, z);
    view.target.set(x, y, z);
    view.group.position.copy(view.cur);
  }

  /** 获取当前角色位置（用于相机跟随） */
  selfPosition(out) {
    const view = this.views.get(this.selfId);
    if (view) return out.copy(view.cur);
    return out.set(0, 5, 0);
  }

  dispose() {
    for (const [, v] of this.views) {
      this.scene.remove(v.group);
      v.label && this.scene.remove(v.label);
    }
    this.views.clear();
  }
}
