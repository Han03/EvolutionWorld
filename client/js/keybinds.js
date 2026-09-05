/**
 * 按键绑定系统：集中管理所有游戏动作的按键映射
 * 纯边沿触发：keydown/mousedown 写入 pending，poll() 消费
 */

// 技能栏按键映射
const SKILL_KEYS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'Minus', 'Equal', 'KeyQ', 'KeyR', 'KeyT', 'KeyY'
];

// 动作注册表（技能栏动态生成）
const ACTIONS = {
  INTERACT:   { key: 'KeyG' },
  PICKUP:     { key: 'KeyE' },
  SHOP:       { key: 'KeyB' },
  INVENTORY:  { key: 'KeyI' },
  QUEST:      { key: 'KeyL' },
  GRID:       { key: 'KeyH' },
  FRIENDS:    { key: 'KeyF' },
  CHAT:       { key: 'Enter' },
  MOUSE_LEFT: { key: 'Mouse0' },
};
SKILL_KEYS.forEach((key, i) => {
  ACTIONS['SKILL_' + (i + 1)] = { key };
});

// 需要 preventDefault 的按键
const PREVENT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);

// 鼠标动作映射（button → actionId）
const MOUSE_ACTIONS = { 0: 'MOUSE_LEFT' };

export class KeybindManager {
  constructor() {
    this._keyToAction = new Map();
    this._pending = new Set();

    for (const [action, def] of Object.entries(ACTIONS)) {
      this._keyToAction.set(def.key, action);
    }
    window.addEventListener('keydown', (e) => this._onKey(e));
    window.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 消费动作信号 */
  poll(actionId) {
    return this._pending.delete(actionId);
  }

  _onKey(e) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const action = this._keyToAction.get(e.code);
    if (!action) return;
    this._pending.add(action);
    if (PREVENT_KEYS.has(e.code)) e.preventDefault();
  }

  _onMouseDown(e) {
    const action = MOUSE_ACTIONS[e.button];
    if (action) this._pending.add(action);
  }
}
