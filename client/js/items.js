/**
 * items.js - 客户端物品元数据（镜像服务端 GameData 默认值；仅用于展示名称/图标/类型）
 * 权威数据始终在服务端（物品/价格/属性），本表仅提供可读展示。
 */
export const SLOT_KEY = { 1: 'helm', 2: 'chest', 3: 'pants', 4: 'gloves', 5: 'boots', 6: 'weapon' };
export const SLOT_NAME = { 1: '头盔', 2: '上衣', 3: '裤子', 4: '手套', 5: '鞋子', 6: '武器' };
// 槽位字符串 → 数字（服务端 items.json 用字符串键，客户端展示用数字槽位）
export const SLOT_FROM_KEY = { helm: 1, chest: 2, pants: 3, gloves: 4, boots: 5, weapon: 6 };

// 品质/稀有度（0普通 1优秀 2稀有 3史诗 4传说），与服务端 ItemDef.rarity 对齐
export const RARITY_NAME = ['普通', '优秀', '稀有', '史诗', '传说'];
export const RARITY_COLOR = ['#9e9e9e', '#4caf50', '#2196f3', '#a855f7', '#ff9800'];

// 服务端 icon 字符串键 → emoji（客户端展示）；未命中的键若本身是 emoji 则原样使用
export const ICON_MAP = {
  helm1: '⛑', helm2: '🪖',
  chest1: '👕', chest2: '🛡',
  pants1: '👖', pants2: '👖',
  gloves1: '🧤', gloves2: '🧤',
  boots1: '🥾', boots2: '🥾',
  weapon1: '⚔', weapon2: '🗡', weapon3: '🔥',
  hp1: '🧪', hp2: '🧪', mp1: '🔵', mp2: '🔵',
  fang: '🦷', badge: '🎖', bone: '🦴', core: '💎',
};

/** 运行时游戏数据（启动时从 /api/gamedata 拉取，覆盖静态镜像 ITEM_DEFS） */
export let RUNTIME_ITEMS = {};    // id -> itemDef（已转换 slot/icon）
export let RUNTIME_MONSTERS = {}; // type -> monsterDef

/** itemId -> { name, type, slot, icon, price, hpBonus, mpBonus, attackBonus, defenseBonus, restoreHp, restoreMp } */
export let ITEM_DEFS = {
  1001: { name: '皮帽', type: 'equip', slot: 1, icon: '⛑', price: 8, defenseBonus: 1 },
  1002: { name: '铁盔', type: 'equip', slot: 1, icon: '⛑', price: 30, defenseBonus: 3, hpBonus: 10 },
  1101: { name: '布衣', type: 'equip', slot: 2, icon: '👕', price: 10, defenseBonus: 1 },
  1102: { name: '锁子甲', type: 'equip', slot: 2, icon: '🛡', price: 35, defenseBonus: 3, hpBonus: 15 },
  1201: { name: '皮裤', type: 'equip', slot: 3, icon: '👖', price: 9, defenseBonus: 1 },
  1202: { name: '钢裤', type: 'equip', slot: 3, icon: '👖', price: 28, defenseBonus: 2, hpBonus: 5 },
  1301: { name: '皮手套', type: 'equip', slot: 4, icon: '🧤', price: 9, attackBonus: 1 },
  1302: { name: '钢手套', type: 'equip', slot: 4, icon: '🧤', price: 28, attackBonus: 2, hpBonus: 5 },
  1401: { name: '皮靴', type: 'equip', slot: 5, icon: '🥾', price: 8, defenseBonus: 1 },
  1402: { name: '钢靴', type: 'equip', slot: 5, icon: '🥾', price: 26, defenseBonus: 2, hpBonus: 5 },
  1501: { name: '青铜剑', type: 'equip', slot: 6, icon: '⚔', price: 12, attackBonus: 2 },
  1502: { name: '铁剑', type: 'equip', slot: 6, icon: '⚔', price: 40, attackBonus: 5 },
  1503: { name: '烈焰剑', type: 'equip', slot: 6, icon: '🔥', price: 120, attackBonus: 9, hpBonus: 10 },
  2001: { name: '小血瓶', type: 'consumable', icon: '🧪', price: 5, restoreHp: 30 },
  2002: { name: '大血瓶', type: 'consumable', icon: '🧪', price: 15, restoreHp: 80 },
  2101: { name: '小蓝瓶', type: 'consumable', icon: '🔵', price: 5, restoreMp: 30 },
  2102: { name: '大蓝瓶', type: 'consumable', icon: '🔵', price: 15, restoreMp: 80 },
  3001: { name: '狼牙', type: 'quest', icon: '🦷', price: 4 },
  3002: { name: '哥布林徽记', type: 'quest', icon: '🎖', price: 8 },
  3003: { name: '骷髅碎片', type: 'quest', icon: '🦴', price: 12 },
  3004: { name: '石像鬼之核', type: 'quest', icon: '💎', price: 25 },
};

/** icon 解析：字符串键 → emoji；未命中且本身非空则原样（兼容直接填 emoji） */
export function resolveIcon(icon) {
  if (!icon) return '❔';
  return ICON_MAP[icon] || icon;
}
/** 物品定义：优先运行时表（/api/gamedata），回退静态镜像，再回退占位 */
export function itemDef(id) {
  return RUNTIME_ITEMS[id] || ITEM_DEFS[id] || { name: `物品#${id}`, type: 'unknown', icon: '❔', price: 0 };
}
export function itemName(id) {
  return itemDef(id).name;
}
export function itemIcon(id) {
  return itemDef(id).icon;
}
export function typeName(t) {
  return { equip: '装备', consumable: '消耗品', quest: '任务道具' }[t] || t;
}
/** 品质（按物品 rarity）：名称/颜色 */
export function itemRarity(id) {
  return itemDef(id).rarity || 0;
}
export function rarityName(id) {
  return RARITY_NAME[itemRarity(id)] || '普通';
}
export function rarityColor(id) {
  return RARITY_COLOR[itemRarity(id)] || RARITY_COLOR[0];
}
/** 属性描述（装备/消耗品） */
export function itemDesc(id) {
  const d = itemDef(id);
  const parts = [];
  if (d.hpBonus) parts.push(`生命+${d.hpBonus}`);
  if (d.mpBonus) parts.push(`法力+${d.mpBonus}`);
  if (d.attackBonus) parts.push(`攻击+${d.attackBonus}`);
  if (d.defenseBonus) parts.push(`防御+${d.defenseBonus}`);
  if (d.restoreHp) parts.push(`恢复${d.restoreHp}生命`);
  if (d.restoreMp) parts.push(`恢复${d.restoreMp}法力`);
  return parts.length ? parts.join(' ') : '任务道具';
}
/** 生物定义（type 键，如 wolf/goblin；来自 /api/gamedata） */
export function monsterDef(type) {
  return RUNTIME_MONSTERS[type] || { name: type || '未知生物', type };
}
export function monsterName(type) {
  return monsterDef(type).name;
}
/**
 * 应用服务端游戏数据（启动时 fetch('/api/gamedata') 后调用）。
 * data = { items: [...], monsters: {type: {...}} }
 * 物品：slot 字符串→数字、icon 键→emoji；生物：原样保留 + 名称/描述/掉落。
 */
export function applyGameData(data) {
  if (!data) return;
  if (Array.isArray(data.items)) {
    const next = {};
    for (const it of data.items) {
      const id = it.id | 0;
      if (!id) continue;
      next[id] = {
        name: it.name || `物品#${id}`,
        desc: it.desc || '',
        type: it.type || 'equip',
        slot: SLOT_FROM_KEY[it.slot] || 0,
        icon: resolveIcon(it.icon),
        price: it.price || 0,
        hpBonus: it.hpBonus || 0,
        mpBonus: it.mpBonus || 0,
        attackBonus: it.attackBonus || 0,
        defenseBonus: it.defenseBonus || 0,
        restoreHp: it.restoreHp || 0,
        restoreMp: it.restoreMp || 0,
        stackMax: it.stackMax || 99,
        rarity: it.rarity || 0,
        levelReq: it.levelReq || 1,
      };
    }
    RUNTIME_ITEMS = next;
  }
  if (data.monsters && typeof data.monsters === 'object') {
    const nm = {};
    for (const type of Object.keys(data.monsters)) {
      nm[type] = Object.assign({ type }, data.monsters[type]);
    }
    RUNTIME_MONSTERS = nm;
  }
}
/** 技能元数据（镜像服务端 skills.json 默认值；权威数据在服务端，仅用于展示） */
export const SKILL_DEFS = {
  // castMs=前摇毫秒, radius=命中半径(0=近战贴身 1.2m)，与服务端 skills.json 对齐
  1000: { name: '普通攻击', icon: '⚔️', color: '#e0e0e0', desc: '100% 攻击伤害', key: 'J', castMs: 200, radius: 0 },
  // castMs=前摇毫秒, radius=命中半径(0=近战贴身 1.2m)，与服务端 skills.json 对齐
  1001: { name: '冲刺斩', icon: '⚔️', color: '#ff6b35', desc: '220% 攻击伤害', key: '1', castMs: 0, radius: 0 },
  1002: { name: '烈焰冲击', icon: '🔥', color: '#ff3d2e', desc: '150% AOE 伤害', key: '2', castMs: 600, radius: 4 },
  1003: { name: '治疗之光', icon: '✨', color: '#7ef9ff', desc: '恢复 60 生命', key: '3', castMs: 500, radius: 0 },
  1004: { name: '冰霜新星', icon: '❄️', color: '#6dd5ff', desc: '120% AOE + 减速', key: '4', castMs: 800, radius: 4 },
  1005: { name: '战吼', icon: '📢', color: '#ffd166', desc: '攻击 +8（10s）', key: '5', castMs: 400, radius: 0 },
  1006: { name: '雷霆一击', icon: '⚡', color: '#fff35b', desc: '300% 伤害（落点命中）', key: '6', castMs: 1000, radius: 0 },
  1007: { name: '吸血打击', icon: '🩸', color: '#c44dff', desc: '180% + 吸血 35%', key: '7', castMs: 300, radius: 0 },
  1008: { name: '荆棘护体', icon: '🌵', color: '#6bd968', desc: '反弹伤害 20%（8s）', key: '8', castMs: 600, radius: 0 },
  // 大型网游扩展：控制/减益/增益/击退
  1010: { name: '铁壁守护', icon: '🛡️', color: '#8ab4f8', desc: '防御+15 霸体·不可打断 8s', key: '9', castMs: 800, radius: 0 },
  1011: { name: '撕裂', icon: '🩸', color: '#e53935', desc: '130% AOE + 流血 10/s·5s', key: '0', castMs: 700, radius: 4 },
  1012: { name: '破甲斩', icon: '⛏️', color: '#ffb74d', desc: '140% AOE + 减防12·6s', key: '-', castMs: 600, radius: 3 },
  1013: { name: '虚弱咒印', icon: '💀', color: '#9575cd', desc: 'AOE 减攻8·8s', key: '=', castMs: 500, radius: 4 },
  1014: { name: '震荡波', icon: '🌀', color: '#4dd0e1', desc: '100% AOE + 眩晕2s', key: 'q', castMs: 800, radius: 3.5 },
  1015: { name: '疾风步', icon: '💨', color: '#69f0ae', desc: '移速+50%·8s', key: 'R', castMs: 300, radius: 0 },
  1016: { name: '猛击', icon: '🔨', color: '#ffca28', desc: '180% AOE + 击退6m', key: 'T', castMs: 500, radius: 3 },
  1017: { name: '生命涌动', icon: '💚', color: '#81c784', desc: '回血 25/s·8s', key: 'Y', castMs: 400, radius: 0 },
  // ---- 怪物专属技能 ----
  2001: { name: '撕咬', icon: '🦷', color: '#f87171', desc: '100% + 流血', key: '', castMs: 400, radius: 3 },
  2002: { name: '利爪挥击', icon: '🐾', color: '#f87171', desc: '100% + 减速', key: '', castMs: 500, radius: 3 },
  2003: { name: '骨刺投掷', icon: '🦴', color: '#f87171', desc: '90% + 减防', key: '', castMs: 600, radius: 5 },
  2004: { name: '石像冲击', icon: '🗿', color: '#f87171', desc: '120% + 击退', key: '', castMs: 700, radius: 3 },
  // ---- Boss 专属技能 ----
  2100: { name: '地裂冲击', icon: '💥', color: '#f87171', desc: '80% AOE + 击退3m', key: '', castMs: 1500, radius: 6 },
  2101: { name: '暗影波动', icon: '🌑', color: '#f87171', desc: '60% AOE + 减速35%', key: '', castMs: 2000, radius: 8 },
};
export function skillDef(id) {
  return SKILL_DEFS[id] || { name: `技能#${id}`, icon: '❔', color: '#aaa', desc: '', key: '' };
}
export function skillName(id) {
  return skillDef(id).name;
}
