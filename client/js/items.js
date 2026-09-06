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
  // 物品图标
  helm1: '⛑', helm2: '🪖',
  chest1: '👕', chest2: '🛡',
  pants1: '👖', pants2: '👖',
  gloves1: '🧤', gloves2: '🧤',
  boots1: '🥾', boots2: '🥾',
  weapon1: '⚔', weapon2: '🗡', weapon3: '🔥',
  hp1: '🧪', hp2: '🧪', mp1: '🔵', mp2: '🔵',
  fang: '🦷', badge: '🎖', bone: '🦴', core: '💎',
  estone: '🔩', protect: '🧿',
  iron: '🪨', steel: '⚙️', crystal: '🔮', scale: '🐉', starcore: '🌟',
  // 玩家技能图标
  atk: '⚔️', s1: '⚔️', s2: '🔥', s3: '✨', s4: '❄️', s5: '📢',
  s6: '⚡', s7: '🩸', s8: '🌵', s10: '🛡️', s11: '🩸', s12: '⛏️',
  s13: '💀', s14: '🌀', s15: '💨', s16: '🔨', s17: '💚',
  // 怪物技能图标
  m_atk1: '🦷', m_atk2: '🐾', m_atk3: '🦴', m_atk4: '🗿',
  // Boss 技能图标
  b_s1: '💥', b_s2: '🌑',
};

/** 运行时游戏数据（启动时从 /api/gamedata 拉取，权威数据在服务端 JSON） */
export let RUNTIME_ITEMS = {};    // id -> itemDef（已转换 slot/icon）
export let RUNTIME_MONSTERS = {}; // type -> monsterDef
export let RUNTIME_ENHANCE = null; // 强化配置（maxLevel/stoneItemId/protectStoneItemId/attrPerLevel*/levels[]）
export let RUNTIME_DECOMPOSE = null; // 分解配置（stoneItemId/rules[{rarity,goldReturnRate,enhanceStoneRate,results[]}]）
export let RUNTIME_CRAFT = null;   // 合成配方表（recipes[{recipeId,name,npcTag,resultItemId,resultCount,goldCost,levelReq,hidden,materials[]}]）
export let RUNTIME_WAREHOUSE = null; // 仓库配置（initialSlots/slotsPerPage/maxSlots/expandBaseCost/expandCostMul/maxGold）
export let RUNTIME_SKILLS = {};      // 技能表（启动时从 /api/gamedata 拉取，权威数据在服务端 skills.json）

/** icon 解析：字符串键 → emoji；未命中且本身非空则原样（兼容直接填 emoji） */
export function resolveIcon(icon) {
  if (!icon) return '❔';
  return ICON_MAP[icon] || icon;
}
/** 物品定义：运行时表（/api/gamedata）→ 占位 */
export function itemDef(id) {
  return RUNTIME_ITEMS[id] || { name: `物品#${id}`, type: 'unknown', icon: '❔', price: 0 };
}
export function itemName(id) {
  return itemDef(id).name;
}
export function itemIcon(id) {
  return itemDef(id).icon;
}
export function typeName(t) {
  return { equip: '装备', consumable: '消耗品', quest: '任务道具', material: '材料' }[t] || t;
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
/** 强化配置（来自 /api/gamedata 的 enhance 字段；未加载时返回 null） */
export function enhanceConfig() { return RUNTIME_ENHANCE; }
/** 目标等级(当前+1)的强化定义；越界/未加载返回 null */
export function enhanceLevelDef(targetLevel) {
  if (!RUNTIME_ENHANCE || !Array.isArray(RUNTIME_ENHANCE.levels)) return null;
  return RUNTIME_ENHANCE.levels[targetLevel - 1] || null;
}
/** 强化属性倍率：base ×(1 + enhance × 每级系数)；attr='atk'|'def'|'hp'（与服务端 recomputeStats 对齐） */
export function enhanceMultiplier(enhance, attr) {
  if (!RUNTIME_ENHANCE || !enhance) return 1;
  const k = attr === 'atk' ? RUNTIME_ENHANCE.attrPerLevelAtk
          : attr === 'def' ? RUNTIME_ENHANCE.attrPerLevelDef
          : attr === 'hp' ? RUNTIME_ENHANCE.attrPerLevelHp : 0;
  return 1 + enhance * (k || 0);
}
/** 分解配置（来自 /api/gamedata 的 decompose 字段；未加载返回 null） */
export function decomposeConfig() { return RUNTIME_DECOMPOSE; }
/** 品质 → 分解规则（越界钳制到有效档；未加载/无规则返回 null） */
export function decomposeRule(rarity) {
  if (!RUNTIME_DECOMPOSE || !Array.isArray(RUNTIME_DECOMPOSE.rules) || !RUNTIME_DECOMPOSE.rules.length) return null;
  const rules = RUNTIME_DECOMPOSE.rules;
  let r = rarity | 0;
  if (r < 0) r = 0;
  if (r >= rules.length) r = rules.length - 1;
  return rules[r] || null;
}
/** 合成配方表（来自 /api/gamedata 的 craft 字段；未加载返回 null） */
export function craftConfig() { return RUNTIME_CRAFT; }
/** 全部配方数组（未加载返回空数组） */
export function craftRecipes() {
  return (RUNTIME_CRAFT && Array.isArray(RUNTIME_CRAFT.recipes)) ? RUNTIME_CRAFT.recipes : [];
}
/** recipeId → 配方（未加载/不存在返回 null） */
export function craftRecipe(recipeId) {
  return craftRecipes().find((r) => (r.recipeId | 0) === (recipeId | 0)) || null;
}
/** 仓库配置（来自 /api/gamedata 的 warehouse 字段；未加载返回 null） */
export function warehouseConfig() { return RUNTIME_WAREHOUSE; }
/** 扩展费用（1000×1.5^n，n=已扩展页数）；已满 maxSlots 返回 0（与服务端 expandCost 对齐） */
export function warehouseExpandCost(unlocked) {
  const c = RUNTIME_WAREHOUSE;
  if (!c) return 0;
  const maxSlots = c.maxSlots | 0, initial = c.initialSlots | 0, perPage = c.slotsPerPage | 0;
  if (!initial || !perPage || unlocked >= maxSlots) return 0;
  const u = unlocked > 0 ? unlocked : initial;
  const n = u > initial ? Math.floor((u - initial) / perPage) : 0;
  return Math.floor((c.expandBaseCost | 0) * Math.pow(c.expandCostMul || 1.5, n));
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
    // 填充渲染器物品名映射
    if (typeof window !== 'undefined') {
      window.__itemNames = {};
      for (const [id, d] of Object.entries(RUNTIME_ITEMS)) window.__itemNames[id] = d.name;
    }
  }
  if (data.monsters && typeof data.monsters === 'object') {
    const nm = {};
    for (const type of Object.keys(data.monsters)) {
      nm[type] = Object.assign({ type }, data.monsters[type]);
    }
    RUNTIME_MONSTERS = nm;
  }
  // 强化配置（阶段2）：15 级消耗/成功率表 + 属性系数，供强化面板展示与本地属性预估
  if (data.enhance && typeof data.enhance === 'object' && Array.isArray(data.enhance.levels)) {
    RUNTIME_ENHANCE = data.enhance;
  }
  // 分解配置（阶段3）：按品质 5 档规则，供分解面板预览产出（材料/金币/强化石）
  if (data.decompose && typeof data.decompose === 'object' && Array.isArray(data.decompose.rules)) {
    RUNTIME_DECOMPOSE = data.decompose;
  }
  // 合成配方（阶段4）：配方表（材料/产出/等级/隐藏），供合成面板展示与材料需求预览
  if (data.craft && typeof data.craft === 'object' && Array.isArray(data.craft.recipes)) {
    RUNTIME_CRAFT = data.craft;
  }
  // 仓库配置（阶段5）：页数/格子/扩展费用/存金上限，供仓库面板展示扩展按钮与费用预估
  if (data.warehouse && typeof data.warehouse === 'object' && (data.warehouse.initialSlots | 0) > 0) {
    RUNTIME_WAREHOUSE = data.warehouse;
  }
  // 技能表（权威数据服务端 skills.json）：target 字符串→数字，合并客户端专属字段（key/color/fxType）
  if (data.skills && typeof data.skills === 'object') {
    const skillArr = Array.isArray(data.skills) ? data.skills
      : (data.skills.skills && Array.isArray(data.skills.skills)) ? data.skills.skills : null;
    if (skillArr) {
      const TARGET_MAP = { self: 1, enemy: 2, aoe: 3 };
      const next = {};
      for (const s of skillArr) {
        const id = s.id | 0;
        if (!id) continue;
        const cl = SKILL_FX_TYPE[id];
        next[id] = {
          name: s.name || `技能#${id}`,
          desc: s.desc || '',
          icon: resolveIcon(s.icon),
          target: TARGET_MAP[s.target] || 1,
          castMs: s.castTimeMs | 0,
          radius: s.radius || 0,
          mana: s.mana || 0,
          range: s.range || 0,
          cooldownMs: s.cooldownMs || 0,
          dmgMul: s.dmgMul || 0,
          flatDmg: s.flatDmg || 0,
          heal: s.heal || 0,
          lifesteal: s.lifesteal || 0,
          knockback: s.knockback || 0,
          dashDist: s.dashDist || 0,
          fxType: cl || 'physical',
        };
      }
      RUNTIME_SKILLS = next;
    }
  }
}
/** 客户端专属特效类型——服务端 skills.json 不存在此数据，仅客户端需要 */
const SKILL_FX_TYPE = {
  1000: 'slash', 1001: 'snipe', 1002: 'inferno', 1003: 'heal',
  1004: 'frost', 1005: 'physical', 1006: 'thunder', 1007: 'lifesteal',
  1008: 'holy', 1010: 'physical', 1011: 'physical', 1012: 'physical',
  1013: 'shadow', 1014: 'physical', 1015: 'physical', 1016: 'physical',
  1017: 'holy',
};
/** 技能定义：运行时表（/api/gamedata）→ 占位 */
export function skillDef(id) {
  return RUNTIME_SKILLS[id] || { name: `技能#${id}`, icon: '❔', desc: '', cooldownMs: 0 };
}
export function skillName(id) {
  return skillDef(id).name;
}
