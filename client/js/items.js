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
