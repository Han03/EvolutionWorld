/**
 * boot-state.js — 游戏客户端共享状态 + 核心工具函数
 * 所有 boot 子模块和 boot.js 共同导入此模块，读写同一份状态。
 */
import { skillName } from './items.js';

// 客户端版本号
export const CLIENT_VERSION = '2026.0904.1';

// ---- 共享可变状态 ----
export const S = {
  // 核心实例
  renderer: null,
  entities: null,
  input: null,
  predictor: null,
  minimap: null,
  net: null,              // NetworkClient 实例（由 boot.js 创建后注入）
  hud: null,              // HUD 元素引用

  // 运行状态
  running: false,
  lastT: 0,
  fpsAcc: 0,
  fpsCount: 0,
  inputAcc: 0,

  // 精英


  // 玩家属性
  playerStats: { maxHp: 100, maxMp: 50, attack: 12, defense: 3, hp: 100, mp: 50, level: 1, exp: 0, expToNext: 100 },
  inventory: {},
  equip: {},
  equipBag: [],
  gold: 0,

  // 商店
  shopData: null,
  shopCategory: 0,

  // Toast
  toastTimer: null,

  // 技能系统
  learnedSkills: [],
  myBuffs: [],
  skillBar: [],
  skillCastFeedback: null,
  _skillDirty: true,
  _buffDirty: true,
  _lastCdTick: 0,
  _cdRefMs: 0,
  _mouseWorldX: null,
  _mouseWorldZ: null,

  // 死亡/复活
  selfDead: false,
  deathAtMs: 0,

  // NPC 交互
  currentNpcWid: 0,
  currentNpcName: '',
  currentNpcTag: 0,
  currentNpcDialogue: '',
  npcDialogOpen: false,

  // 强化面板
  enhanceTargetInstId: 0,
  enhanceUseProtect: false,
  smithTab: 'enhance',
  decomposeTargetInstId: 0,

  // 合成面板
  craftListIds: [],
  craftTargetRecipeId: 0,
  craftCount: 1,
  craftNpcWid: 0,

  // 仓库面板
  warehouseData: null,
  warehousePage: 0,
  warehouseNpcWid: 0,

  // 背包右键菜单
  invMenuEl: null,

  // 地形重拉锁
  _terrainReloading: false,
};

// ---- 常量 ----
export const PLAYER_RESPAWN_SEC = 3;

export const ENHANCE_FAIL_TEXT = {
  1: '已达最高强化等级',
  2: '金币不足',
  3: '强化石不足',
  4: '保护符不足',
  6: '需在铁匠附近才能强化',
  7: '装备无效或不存在',
};

export const DECOMPOSE_FAIL_TEXT = {
  1: '装备已锁定，无法分解',
  2: '装备无效或不存在',
  3: '该装备无法分解',
  4: '已穿戴的装备需先卸下',
  6: '需在铁匠附近才能分解',
};

export const CRAFT_FAIL_TEXT = {
  1: '配方不存在',
  2: '等级不足，无法合成',
  3: '材料不足',
  4: '金币不足',
  6: '需在合成 NPC 附近',
  7: '该 NPC 无法合成此配方',
};

export const WH_OP = { OPEN: 0, DEPOSIT: 1, WITHDRAW: 2, EXPAND: 3, LOCK: 4 };
export const WH_FAIL_TEXT = {
  1: '仓库已满，请先扩展',
  2: '物品不存在',
  3: '金币不足',
  4: '仓库已达最大容量',
  5: '需在银行职员附近',
  6: '数量无效',
  7: '物品已锁定',
  8: '超过存金上限',
};

export const SHOP_CAT_NAME = { 1: '装备', 2: '消耗品', 3: '材料', 4: '特殊' };

// 技能槽位 → 热键标签
export function SKILL_KEY_LABEL(slot) {
  if (slot >= 1 && slot <= 9) return String(slot);
  if (slot === 10) return '0';
  if (slot === 11) return '-';
  if (slot === 12) return '=';
  if (slot === 13) return 'Q';
  if (slot === 14) return 'R';
  if (slot === 15) return 'T';
  if (slot === 16) return 'Y';
  return String(slot);
}

// ---- 工具函数 ----
export function toast(text, cls) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { el.className = 'toast'; }, 1800);
}

export function renderHud() {
  const ps = S.playerStats;
  const hpPct = ps.maxHp ? Math.max(0, Math.min(100, (ps.hp / ps.maxHp) * 100)) : 0;
  const mpPct = ps.maxMp ? Math.max(0, Math.min(100, (ps.mp / ps.maxMp) * 100)) : 0;
  const hf = document.getElementById('hp-fill'), mf = document.getElementById('mp-fill');
  if (hf) { hf.style.width = hpPct + '%'; document.getElementById('hp-text').textContent = `${Math.round(ps.hp)}/${Math.round(ps.maxHp)}`; }
  if (mf) { mf.style.width = mpPct + '%'; document.getElementById('mp-text').textContent = `${Math.round(ps.mp)}/${Math.round(ps.maxMp)}`; }
  const g = document.getElementById('hud-gold');
  if (g) g.textContent = S.gold;
  const sa = document.getElementById('stat-attack'), sd = document.getElementById('stat-defense');
  if (sa) sa.textContent = Math.round(ps.attack);
  if (sd) sd.textContent = Math.round(ps.defense);
  const lv = document.getElementById('hud-level');
  if (lv) lv.textContent = ps.level || 1;
  const ef = document.getElementById('exp-fill');
  if (ef) {
    const need = ps.expToNext || 0;
    const pct = need > 0 ? Math.max(0, Math.min(100, ((ps.exp || 0) / need) * 100)) : 0;
    ef.style.width = pct + '%';
    const et = document.getElementById('exp-text');
    if (et) et.textContent = `${Math.round(ps.exp || 0)}/${Math.round(need)}`;
  }
}

export function protocolLog(dir, msg) {
  const box = document.getElementById('proto-log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'proto-line ' + dir;
  const t = msg.type;
  let detail = '';
  switch (t) {
    case 'HELLO': detail = `wid=${msg.self.wid} pos=(${msg.self.x.toFixed(1)},${msg.self.y.toFixed(1)},${msg.self.z.toFixed(1)}) seed=${msg.seed}`; break;
    case 'ENTER': detail = `count=${msg.entities.length}`; break;
    case 'LEAVE': detail = `wids=[${msg.wids.join(',')}]`; break;
    case 'UPDATE': detail = `count=${msg.updates.length}`; break;
    case 'SNAPSHOT': detail = `tick=${msg.tick} count=${msg.entities.length}`; break;
    case 'SELF': detail = `reason=${msg.reason} pos=(${msg.x.toFixed(1)},${msg.y.toFixed(1)},${msg.z.toFixed(1)})`; break;
    case 'KICK': detail = `reason=${msg.reason}`; break;
    case 'INPUT': detail = `seq=${msg.seq} pos=(${msg.x.toFixed(1)},${msg.y.toFixed(1)},${msg.z.toFixed(1)})`; break;
    case 'ATTACK': detail = `targetWid=${msg.targetWid} slot=${msg.slot}` + (msg.note ? ` ${msg.note}` : ''); break;
    case 'ELITE': detail = `wid=${msg.wid} ${msg.name} hp=${Math.round(msg.hp)}/${Math.round(msg.maxHp)} state=${msg.state} phase=${msg.phase} target=${msg.target}`; break;
    case 'EVENT': {
      const names = { 1: '伤害', 2: '死亡', 3: '复活', 4: '范围技能', 5: '掉落', 6: '技能前摇', 7: '技能打断' };
      detail = `${names[msg.evtType] || msg.evtType} wid=${msg.wid} b=${msg.b}`;
      break;
    }
    case 'SHOP': detail = `shopId=${msg.shopId} ${msg.name} 商品=${msg.entries.length}`; break;
    case 'INVENTORY': detail = `金币=${msg.gold} 已穿=${Object.keys(msg.equip).length} 背包装备=${(msg.equipBag || []).length} 堆叠=${Object.keys(msg.inventory).length}`; break;
    case 'STATS': detail = `hp=${msg.hp}/${msg.maxHp} mp=${msg.mp}/${msg.maxMp} 攻=${msg.attack} 防=${msg.defense}`; break;
    case 'LOOT': detail = `ok=${msg.ok} item=${msg.itemId} count=${msg.count} gold=${msg.gold}`; break;
    case 'SHOP_OPEN': detail = `npcWid=${msg.npcWid}`; break;
    case 'SHOP_BUY': detail = `itemId=${msg.itemId} count=${msg.count}`; break;
    case 'PICKUP': detail = `dropWid=${msg.dropWid}`; break;
    case 'EQUIP': detail = `slot=${msg.slot} instId=${msg.instId}`; break;
    case 'USE_ITEM': detail = `itemId=${msg.itemId} count=${msg.count}`; break;
    case 'CAST_SKILL': detail = `skillId=${msg.skillId} target=${msg.targetWid} at(${msg.tx},${msg.tz})`; break;
    case 'CONSOLE': detail = `cmd=${msg.cmd || ''}${msg.text ? ' → ' + msg.text.replace(/\n/g, ' | ') : ''}`; break;
    case 'SKILLS': detail = `已学=${msg.skills.length} ${msg.skills.map((s) => `${skillName(s.id)}${s.cdMs ? '(cd' + (s.cdMs / 1000).toFixed(0) + 's)' : ''}`).join(' ')}`; break;
    case 'SKILL_CAST': detail = `ok=${msg.ok} skill=${skillName(msg.skillId)} target=${msg.targetWid}`; break;
    case 'BUFFS': detail = `buffs=${msg.buffs.length} ${msg.buffs.map((b) => `#${b.skillId}@${b.value.toFixed(1)}(${b.remainSec.toFixed(1)}s)`).join(' ')}`; break;
    case 'S2C_QUEST_LIST': detail = '可接任务列表'; break;
    case 'S2C_QUEST_PROGRESS': detail = '任务进度更新'; break;
    case 'S2C_QUEST_RESULT': detail = '任务操作结果'; break;
    case 'S2C_QUEST_COMPLETE': detail = '任务目标完成'; break;
    case 'S2C_QUEST_NOTIFY': detail = '任务进度通知'; break;
    case 'S2C_FRIEND_REQUEST': detail = `from=${msg.from} msg=${msg.message}`; break;
    case 'S2C_FRIEND_LIST': detail = `好友数=${msg.friends.length}`; break;
    case 'S2C_FRIEND_STATUS': detail = `${msg.name} ${msg.online ? '上线' : '离线'}`; break;
    case 'S2C_FRIEND_RESULT': detail = `op=${msg.opCode} code=${msg.resultCode}`; break;
    case 'S2C_GUILD_INFO': detail = `${msg.name} Lv${msg.level} ${msg.memberCount}/${msg.maxMembers}`; break;
    case 'S2C_GUILD_RESULT': detail = `op=${msg.opCode} code=${msg.code}`; break;
    case 'S2C_GUILD_NOTIFY': detail = `event=${msg.eventType} ${msg.data}`; break;
    case 'S2C_GUILD_LIST': detail = `搜索结果=${msg.guilds.length}`; break;
    case 'S2C_GUILD_APPLY_N': detail = `applicant=${msg.applicant}`; break;
    case 'S2C_CHAT_MSG': detail = `[${msg.channel}] ${msg.sender}: ${msg.content.slice(0, 30)}`; break;
    case 'S2C_CHAT_HISTORY': detail = `历史消息=${msg.messages.length}`; break;
    case 'S2C_CHAT_RESULT': detail = `code=${msg.code}${msg.errorMsg ? ' ' + msg.errorMsg : ''}`; break;
    case 'CHAT_SEND': detail = `ch=${msg.channel} target=${msg.target} content=${msg.content.slice(0, 30)}`; break;
    case 'FRIEND_ADD': detail = `target=${msg.targetName}`; break;
    case 'GUILD_CREATE': detail = `name=${msg.name}`; break;
    default: detail = JSON.stringify(msg).slice(0, 80); break;
  }
  line.textContent = `[${dir === 's2c' ? '↓S2C' : '↑C2S'}] ${t} ${detail}`;
  box.appendChild(line);
  while (box.childNodes.length > 40) box.removeChild(box.firstChild);
}
