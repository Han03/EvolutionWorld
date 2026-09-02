/**
 * items.js - 客户端物品元数据（镜像服务端 GameData 默认值；仅用于展示名称/图标/类型）
 * 权威数据始终在服务端（物品/价格/属性），本表仅提供可读展示。
 */
export const SLOT_KEY = { 1: 'helm', 2: 'chest', 3: 'pants', 4: 'gloves', 5: 'boots', 6: 'weapon' };
export const SLOT_NAME = { 1: '头盔', 2: '上衣', 3: '裤子', 4: '手套', 5: '鞋子', 6: '武器' };

/** itemId -> { name, type, slot, icon, price, hpBonus, mpBonus, attackBonus, defenseBonus, restoreHp, restoreMp } */
export const ITEM_DEFS = {
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

export function itemDef(id) {
  return ITEM_DEFS[id] || { name: `物品#${id}`, type: 'unknown', icon: '❔', price: 0 };
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
  2001: { name: '撕咬', icon: '🦷', color: '#f87171', desc: '100% + 流血', key: '', castMs: 0, radius: 0 },
  2002: { name: '利爪挥击', icon: '🐾', color: '#f87171', desc: '100% + 减速', key: '', castMs: 0, radius: 0 },
  2003: { name: '骨刺投掷', icon: '🦴', color: '#f87171', desc: '90% + 减防', key: '', castMs: 0, radius: 0 },
  2004: { name: '石像冲击', icon: '🗿', color: '#f87171', desc: '120% + 击退', key: '', castMs: 0, radius: 0 },
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
