/**
 * editor-state.js — 世界编辑器共享状态 + 工具函数
 * 所有 editor 子模块和 editor.js 共同导入此模块，读写同一份状态。
 */

// ---- 共享可变状态 ----
export const S = {
  // 会话
  token: '',
  username: '',

  // 模式
  mode: 'terrain',        // 'terrain' | 'spawn' | 'item' | 'creature' | 'npc' | 'quest' | 'enhance' | 'decompose' | 'craft' | 'shop' | 'skill'
  showHeight: false,

  // WebGL 渲染器
  tr: null,               // WebGLRenderer 实例
  running: false,

  // 画刷
  brush: { type: 'select', radius: 4, strength: 1.2, falloff: 'soft', targetH: 8 },
  hoverWorld: { x: 0, z: 0, in: false },
  editing: false,
  panning: false,
  lastPan: { x: 0, y: 0 },
  keys: {},

  // 出生点
  spawns: [],             // {kind,type,name,shopId,x,z,count}
  selectedSpawn: -1,
  dragSpawn: null,        // {index, offX, offZ}
  spawnsDirty: false,
  spawnSearchText: '',

  // 物品/生物/NPC/任务
  gameItems: [],
  gameCreatures: {},
  gameNpcs: {},
  selectedItem: -1,
  selectedCreature: '',
  selectedNpc: '',
  gameQuests: [],
  selectedQuest: -1,

  // 经济配置
  gameEnhance: null,
  gameDecompose: null,
  gameCraft: [],
  selectedCraft: -1,
  gameShops: {},
  selectedShop: '',

  // 技能配置
  gameSkills: [],          // SkillDef 数组
  gameStarterSkills: [],   // 起始技能 ID 数组
  selectedSkill: -1,

  // 视图平移
  panSpeed: 5,
  lastPanTs: 0,

  // 列表搜索
  itemSearchText: '',
  creatureSearchText: '',
  npcSearchText: '',
  questSearchText: '',
  craftSearchText: '',
  shopSearchText: '',
  skillSearchText: '',

  // 收起/展开（默认全部收起）
  collapsedEnhanceLevels: new Set(),
  collapsedDecompRules: new Set(),
  collapsedShopEntries: new Set(),

  // 撤销/重做（仅地形）
  undoStack: [],
  redoStack: [],
};

// ---- 常量 ----
export const BASE = '';
export const WORLD = 128;

export const SPAWN_STYLE = {
  monster: { color: '#e5484d', label: 'M' },
  npc: { color: '#3b82f6', label: 'N' },
  elite: { color: '#a855f7', label: 'E' },
};

export const ICON_PRESETS = ['⛑','🪖','👕','🛡','👖','🧤','🥾','⚔','🗡','🔥','🧪','🔵','🦷','🎖','🦴','💎','🍖','📜','💰','🏹','🔮','⚗'];

export const QUEST_CAT_NAMES = { main: '主线', side: '支线', daily: '日常', repeatable: '可重复' };
export const QUEST_OBJ_TYPES = [
  { v: 'kill', n: '击杀' }, { v: 'collect', n: '收集' },
  { v: 'reach', n: '到达' }, { v: 'talk', n: '对话' }, { v: 'escort', n: '护送' },
];

export const RARITY_NAMES = ['普通', '优秀', '稀有', '史诗', '传说'];
export const SHOP_CATS = ['自动', '装备', '消耗品', '材料', '特殊'];
export const SHOP_REFRESH = ['不刷新', '每日', '每周'];

export const MODE_TIP = {
  terrain: '画刷编辑地形 · 选择画刷=点击/拖动出生点 · 放置画刷=点击放置出生点 · Del=删除',
  item: '配置物品：名称/描述/属性/品质/需求等级；保存后热重载',
  creature: '配置生物：属性/经验/移速/掉落；保存后世界生物热重载',
  npc: '配置 NPC 类型：名称/标签/商店；保存后热重载',
  quest: '配置任务：目标/奖励/链式；保存后热重载',
  enhance: '配置强化：等级表/成功率/消耗/属性系数；保存后热重载',
  decompose: '配置分解：按品质返还金币/材料/强化石；保存后热重载',
  craft: '配置合成：配方材料/产物/等级需求；保存后热重载',
  shop: '配置商店：商品/价格/折扣/限购/回收；保存后热重载',
  skill: '配置技能：伤害/治疗/Buff/冷却/范围/前摇；保存后热重载',
};

// ---- 工具函数 ----
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function saveFailText() {
  return '会话已过期：请重新登录后再保存（未提交的修改已保留）';
}

export function openNewModal($, title, fields, onOk) {
  const mask = $('editor-modal-mask');
  $('editor-modal-title').textContent = title;
  const body = $('editor-modal-body');
  body.innerHTML = '';
  const inputs = {};
  fields.forEach(f => {
    const lbl = document.createElement('label');
    const sp = document.createElement('span');
    sp.textContent = f.label;
    lbl.appendChild(sp);
    let inp;
    if (f.type === 'select') {
      inp = document.createElement('select');
      (f.options || []).forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.text;
        if (o.selected) opt.selected = true;
        inp.appendChild(opt);
      });
    } else {
      inp = document.createElement('input');
      inp.type = f.type || 'text';
      if (f.value !== undefined) inp.value = f.value;
      if (f.min !== undefined) inp.min = f.min;
      if (f.step !== undefined) inp.step = f.step;
    }
    inp.id = 'modal-' + f.key;
    inputs[f.key] = inp;
    lbl.appendChild(inp);
    body.appendChild(lbl);
  });
  mask.classList.remove('hidden');
  const first = body.querySelector('input,select');
  if (first) setTimeout(() => first.focus(), 50);
  const close = () => { mask.classList.add('hidden'); };
  $('editor-modal-ok').onclick = () => {
    const vals = {};
    fields.forEach(f => {
      const v = inputs[f.key].value;
      vals[f.key] = f.type === 'number' ? (parseFloat(v) || 0) : v;
    });
    close();
    onOk(vals);
  };
  $('editor-modal-cancel').onclick = close;
  const escKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escKey); } };
  document.addEventListener('keydown', escKey);
}

// ---- 收起集合辅助 ----
export function reindexCollapsedSet(set, removedIdx) {
  const sorted = [...set].sort((a, b) => a - b);
  set.clear();
  for (const idx of sorted) {
    if (idx < removedIdx) set.add(idx);
    else if (idx > removedIdx) set.add(idx - 1);
  }
}

export function initCollapsedAll(set, count) {
  set.clear();
  for (let i = 0; i < count; i++) set.add(i);
}
