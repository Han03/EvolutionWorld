/**
 * autobot.js - 自动化测试插件（任务主导，数据驱动）
 *
 * 设计原则：
 *  1. 任务主导：按「每日 → 支线 → 主线」优先级自动完成全部任务；
 *  2. 每次开始 / 刷新页面后重新检查任务完成情况（服务端存档为权威），从断点继续；
 *  3. 角色自动维护：更强装备购买 / 强化 / 合成，消耗品购买 / 合成；
 *  4. 无可执行任务时：刷怪升级 + 强化装备提升属性；
 *  5. 全程只走正常游戏协议（移动 / 对话 / 接交任务 / 商店 / 强化 / 合成 / 拾取 / 攻击 / 技能），
 *     不调用任何控制台命令（不做弊）；
 *  6. 数据驱动：全部配置（任务 / 物品 / 怪物 / 商店 / 配方 / 强化表）运行时从
 *     GET /api/gamedata 读取，游戏数据被动态修改后无需改动插件。
 *
 * 状态持久化：localStorage['ew_autobot'] —— 保存运行开关与统计；
 * 刷新页面后由 boot.js 检测 enabled 自动恢复运行，任务进度以服务端为准。
 */

// 确定性物理/地形（与服务端逐位一致，用于空洞绕行与走位）
import { circleBlocked } from './predict.js';
import { terrainBlocked } from './terrain.js';

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------
const S_ = {
  // 注入的依赖（configure 时填充）
  S: null,          // boot-state.js 的共享状态 S
  net: null,        // NetworkClient 实例

  // 运行控制
  running: false,
  paused: false,

  // 数据（运行时拉取，全量数据驱动）
  gamedata: null,       // GET /api/gamedata 的完整结果
  dataLoading: false,

  // 任务运行时视图
  questList: [],        // 可接任务（含配置：objectives 的 type/targetKey/x/z）
  questProgress: [],    // 活跃任务进度（服务端权威）
  questRefreshedAt: 0,  // 上次刷新任务数据的时间戳
  questDirty: true,     // 需要刷新（接受/提交/目标推进后置位）
  skippedQuests: new Set(), // 本轮会话中尝试过但不可做（前置/等级/冷却）的任务

  // 当前子目标
  goal: null,           // {type, ...}
  goalAt: 0,            // 目标建立时间
  goalTries: 0,

  // 战斗
  attackWid: 0,         // 当前攻击目标
  lastAttackAt: 0,
  lastSkillAt: 0,
  _combatHpAt: 0,       // 目标 hp 快照（无伤害检测）
  _combatNoDmg: 0,      // 连续无伤害攻击次数
  _skipWids: new Map(), // wid -> 跳过截止时间（幽灵怪/异常目标容错）
  _pickupTries: new Map(), // 掉落物 wid -> 连续拾取次数（拾取无响应容错）

  // 低血逃生 / 恢复
  _lastFleePotAt: 0,    // 残血喝血瓶节流时间戳
  _lastFleeLogAt: 0,    // 残血无法补给时的日志限频时间戳
  _fleeSafeCount: 0,    // 已判定安全的连续轮数（避免抖动）

  // 走位攻击 / 空洞绕行
  _kiteUntil: 0,        // 攻击后走位窗口截止时间（期间横向移动躲避怪物攻击）
  _kiteSide: 1,         // 走位绕圈方向（交替）
  _moveSnap: null,      // 卡住检测：上次位置快照 {x,z,at}
  _moveCtx: '',         // 卡住检测：当前移动上下文（区分目标）

  // 阶段统计
  stats: {
    questsDone: 0,      // 本轮会话提交成功数
    monstersKilled: 0,
    itemsBought: 0,
    itemsCrafted: 0,
    enhanceOk: 0,
    goldEarned: 0,
    flees: 0,           // 残血逃跑次数
    startedAt: 0,
  },

  // UI 回调（boot.js 注入，用于更新面板状态文本）
  onStatus: null,
  onLog: null,

  _lastDecisionAt: 0,
  _lastManualInputAt: 0,
  _lastSupplyAt: 0,
  _logBuf: [],
};

const CFG = {
  DECISION_MS: 220,        // 决策节流
  QUEST_REFRESH_MS: 2500,  // 任务数据刷新间隔
  MOVE_REACH: 0.9,         // 到达判定距离
  ATK_RANGE: 2.9,          // 普攻距离（服务端判定 3.2m，留余量）
  ATK_CD_MS: 700,          // 普攻节流（服务端冷却 0.5s）
  NPC_RANGE: 3.2,          // 对话 / 商店 / 强化 / 合成 操作距离
  PICKUP_RANGE: 2.4,       // 主动拾取距离
  GOAL_TIMEOUT_MS: 45000,  // 子目标超时
  GRIND_EXPLORE_M: 40,     // 无怪时探索距离
  HP_POTION_KEEP: 6,       // 血瓶保有量
  MP_POTION_KEEP: 4,       // 蓝瓶保有量
  HP_USE_AT: 0.6,          // 血量低于 60% 时喝血瓶
  HP_FLEE_AT: 0.35,        // 血量低于 35% 判定残血：停止战斗，先逃跑后恢复
  HP_SAFE_AT: 0.75,        // 恢复到 75% 以上视为安全，结束逃生状态
  FLEE_SAFE_DIST: 14,      // 距最近威胁怪物超过该距离视为安全（可安心恢复）
  FLEE_DIST: 16,           // 逃跑落点距离（远离威胁的径向距离）
  FLEE_USE_POT_CD: 900,    // 残血喝血瓶节流（服务端用物品冷却余量）
  GOLD_RESERVE: 300,       // 补给/强化预留金币
  ENHANCE_MIN_LV: 3,       // 达到该等级后开始强化装备
  GRIND_MIN_EXP: 0.5,      // 经验条过半才优先刷怪（否则先做任务）
};

// ---------------------------------------------------------------------------
// 对外控制 API
// ---------------------------------------------------------------------------
export function configure(deps) {
  S_.S = deps.S || null;
  S_.net = deps.net || null;
  S_.onStatus = deps.onStatus || null;
  S_.onLog = deps.onLog || null;
  // 任务模块函数（boot.js 传入，避免循环依赖）
  S_.sendQuestList = deps.sendQuestList || null;
  S_.sendQuestTrack = deps.sendQuestTrack || null;
  S_.sendQuestAccept = deps.sendQuestAccept || null;
  S_.sendQuestTurnIn = deps.sendQuestTurnIn || null;
  S_.sendTalkNpc = deps.sendTalkNpc || null;
  S_.getQuestList = deps.getQuestList || null;
  S_.getQuestProgress = deps.getQuestProgress || null;
  // 面板模块函数（商店/强化/合成）
  S_.openEnhancePanel = deps.openEnhancePanel || null;
  S_.openCraftPanel = deps.openCraftPanel || null;
  S_.openShopPanel = deps.openShopPanel || null;
  S_.closeAllNpcPanels = deps.closeAllNpcPanels || null;
}

export function isRunning() { return S_.running && !S_.paused; }
export function isPaused() { return S_.paused; }
export function getPhase() {
  if (!S_.running) return 'stop';
  if (S_.paused) return 'paused';
  if (S_.goal) return goalPhaseName(S_.goal);
  return 'thinking';
}
export function getStats() { return { ...S_.stats }; }

/** 开始 / 恢复：拉取数据与任务状态后进入决策循环 */
export async function start() {
  S_.running = true;
  S_.paused = false;
  if (!S_.stats.startedAt) S_.stats.startedAt = Date.now();
  S_.questDirty = true;
  log('🤖 自动化测试启动（每日→支线→主线 → 装备/补给 → 刷怪升级）');
  if (!S_.gamedata && !S_.dataLoading) {
    S_.dataLoading = true;
    try {
      const r = await fetch('/api/gamedata');
      S_.gamedata = await r.json();
      log(`数据加载完成：物品 ${itemCount()}、怪物 ${monsterCount()}、任务 ${questCount()}、配方 ${craftRecipes().length}`);
    } catch (e) {
      log('⚠️ 数据加载失败：' + e.message);
    }
    S_.dataLoading = false;
  }
  emitStatus();
  saveState();
}

/** 暂停：停止一切自动行为（移动/攻击/技能/对话/购买），等手动恢复 */
export function pause() {
  if (!S_.running) return;
  S_.paused = true;
  clearGoal();
  stopCombat();
  // 彻底停止移动：清目标点 + A* 路径 + 长按跟随（仅清 clickTarget 会残留寻路路径继续走）
  if (S_.S && S_.S.input) S_.S.input.clearMovement();
  log('⏸️ 自动化测试已暂停（已停止移动与施放技能）');
  emitStatus();
  saveState();
}

/** 重置：停止 + 清空本地统计与跳过缓存 */
export function reset() {
  S_.running = false;
  S_.paused = false;
  clearGoal();
  stopCombat();
  if (S_.S && S_.S.input) S_.S.input.clearMovement();
  S_.skippedQuests.clear();
  S_.stats = { questsDone: 0, monstersKilled: 0, itemsBought: 0, itemsCrafted: 0, enhanceOk: 0, goldEarned: 0, flees: 0, startedAt: 0 };
  try { localStorage.removeItem('ew_autobot'); } catch (e) {}
  log('♻️ 自动化测试已重置');
  emitStatus();
}

/** 刷新后恢复：读本地状态，若之前 enabled 则自动 start */
export function restore() {
  try {
    const raw = localStorage.getItem('ew_autobot');
    if (!raw) return;
    const st = JSON.parse(raw);
    if (st.enabled) {
      // 延迟到数据就绪（boot 注入后）再启动
      setTimeout(() => { if (!S_.running) start(); }, 800);
    }
  } catch (e) { /* 忽略损坏状态 */ }
}

// ---------------------------------------------------------------------------
// 主决策循环（由 boot.js 的定时器驱动，每 ~220ms 一次）
// ---------------------------------------------------------------------------
export function tick(now) {
  if (!S_.running || S_.paused) return;
  const S = S_.S;
  if (!S || !S.net || !S.entities || !S.predictor) return;
  const net = S.net;
  if (now - S_._lastDecisionAt < CFG.DECISION_MS) return;
  S_._lastDecisionAt = now;

  // 死亡：等待复活，不做任何操作
  if (S.selfDead) {
    clearGoal();
    stopCombat();
    return;
  }

  // 数据未就绪：等待（start 异步拉取）
  if (!S_.gamedata) {
    if (!S_.dataLoading) start();
    return;
  }

  // 玩家手动操作检测：持续人为输入超过阈值则暂停（避免互相干扰）
  if (detectManualInput()) {
    const nowMs = performance.now();
    if (S_._lastManualInputAt && nowMs - S_._lastManualInputAt > 5000) {
      log('👀 检测到持续手动操作，自动化暂停（可在面板重新开始）');
      pause();
    }
    S_._lastManualInputAt = nowMs;
    return;
  } else {
    S_._lastManualInputAt = 0;
  }

  // ── 0. 残血检测：血量低于阈值 → 停止战斗，先逃跑脱离威胁，再恢复（喝血瓶/商店补给） ──
  // 逃生期间占用本决策轮，不推进任何其他目标；恢复安全后自动回到正常流程
  if (handleLowHp(performance.now())) return;

  const selfPos = S.predictor.predicted();
  const self = { x: selfPos.x, z: selfPos.z };

  // ── 1. 战斗中：攻击循环（走位攻击：攻击 → 冷却期横向绕圈，低血拉开） ──
  if (S_.attackWid) {
    const v = S.entities.views.get(S_.attackWid);
    if (!v || v.dying || (v.hp !== undefined && v.hp <= 0)) {
      stopCombat(); // 目标死亡/消失
    } else {
      const now = performance.now();
      const d = Math.hypot(v.x - self.x, v.z - self.z);
      const lowHp = lowHpNow();
      if (d > CFG.ATK_RANGE + 0.8) {
        // 太远：低血先拉开（喝血瓶回血），否则追上去
        if (lowHp) kiteStep(v, true);
        else {
          const r = goto(v.x, v.z, 'chase');
          if (!r.ok) { // 目标不可达/无路（空洞隔开）→ 放弃换目标
            log(`⚠️ 目标 wid=${S_.attackWid} 不可达（${r.reason}），放弃`);
            S_._skipWids.set(S_.attackWid, performance.now() + 30000);
            stopCombat();
            S_.questDirty = true;
            return;
          }
        }
      } else if (now < S_.kiteUntil) {
        // 攻击冷却中：走位躲避（绕圈；低血径向拉开）
        kiteStep(v, lowHp);
      } else {
        S.input.clickTarget = null;
        // 幽灵容错：hp 长时间无变化（服务端已失活但视图残留）→ 放弃换目标
        const hpNow = v.hp !== undefined ? v.hp : 0;
        if (hpNow > 0 && hpNow !== S_._combatHpAt) { S_._combatHpAt = hpNow; S_._combatNoDmg = 0; }
        else if (hpNow > 0) {
          S_._combatNoDmg++;
          if (S_._combatNoDmg >= 10) {
            log(`👻 目标 wid=${S_.attackWid} 疑似已失活（无伤害反馈），放弃并暂时跳过`);
            S_._skipWids.set(S_.attackWid, performance.now() + 45000);
            stopCombat();
            S_.questDirty = true;
            return;
          }
        }
        combatAttack(v);
      }
      return;
    }
  }

  // ── 2. 有进行中的子目标：推进 ──
  if (S_.goal) {
    if (now - S_.goalAt > CFG.GOAL_TIMEOUT_MS) {
      log('⏱️ 子目标超时，放弃重规划：' + goalPhaseName(S_.goal));
      S_.goalTries++;
      clearGoal();
      if (S_.goalTries > 3) { stopCombat(); S_.goalTries = 0; }
    } else {
      advanceGoal(now);
      return;
    }
  }

  // ── 3. 刷新任务视图（周期性 + 脏标记） ──
  if (S_.questDirty || now - S_.questRefreshedAt > CFG.QUEST_REFRESH_MS) {
    refreshQuests();
    return;
  }

  // ── 4. 任务阶段：提交 → 接取 → 做目标（按 每日→支线→主线 优先级） ──
  const q = pickQuestAction();
  if (q) { setGoal(q); return; }

  // ── 5. 无可执行任务 → 装备 / 补给 / 刷怪维护 ──
  const m = pickMaintenanceAction(performance.now());
  if (m) { setGoal(m); return; }

  // ── 6. 兜底：刷怪升级 ──
  const grind = pickGrindAction();
  if (grind) setGoal(grind);
}

// ---------------------------------------------------------------------------
// 任务阶段
// ---------------------------------------------------------------------------
function refreshQuests() {
  const net = S_.net;
  if (S_.sendQuestList) S_.sendQuestList(net, 0);   // 可接列表（含配置）
  if (S_.sendQuestTrack) S_.sendQuestTrack(net);     // 活跃进度
  S_.questRefreshedAt = performance.now();
  S_.questDirty = false;
}

function pullQuestViews() {
  if (S_.getQuestList) S_.questList = S_.getQuestList() || [];
  if (S_.getQuestProgress) S_.questProgress = S_.getQuestProgress() || [];
}

/** 任务优先级：每日(3) > 支线(2) > 主线(1) > 可重复(4) */
function questPriority(cat) {
  const order = { 3: 0, 2: 1, 1: 2, 4: 3 };
  return order[cat] !== undefined ? order[cat] : 9;
}

/** 决策：返回一个任务相关子目标，或 null */
function pickQuestAction() {
  pullQuestViews();
  const prog = S_.questProgress;

  // a) 可提交任务（status==1）优先，按优先级排序
  const ready = prog.filter(q => q.status === 1).sort((a, b) => questPriority(catOf(a.questId)) - questPriority(catOf(b.questId)));
  if (ready.length) {
    const q = ready[0];
    return { type: 'turnin', questId: q.questId };
  }

  // b) 进行中任务（未完成目标）→ 执行第一个未完成目标
  const active = prog.filter(q => q.status === 0).sort((a, b) => questPriority(catOf(a.questId)) - questPriority(catOf(b.questId)));
  for (const aq of active) {
    const def = questDef(aq.questId);
    if (!def) continue;
    for (let i = 0; i < aq.objectives.length; i++) {
      const cur = aq.objectives[i] || { current: 0, required: 1 };
      if (cur.current < cur.required) {
        const obj = def.objectives[i];
        if (!obj) continue;
        const g = objectiveGoal(def, aq, i, obj);
        if (g) return g;
      }
    }
  }

  // c) 可接任务（未被跳过），按 每日→支线→主线 优先级取第一个
  const avail = S_.questList
    .filter(q => !S_.skippedQuests.has(q.questId))
    .sort((a, b) => questPriority(a.category) - questPriority(b.category));
  if (avail.length) {
    return { type: 'accept', questId: avail[0].questId };
  }
  return null;
}

/** 目标 → 子目标（数据驱动：目标类型/坐标/怪物/物品全部来自 gamedata）
 *  注意：gamedata.quests 的 objective.type 为字符串（"kill"/"collect"/"reach"/"talk"），
 *        协议 S2C_QUEST_LIST 的 type 为数字（1/2/3/4），此处两者兼容。 */
function objectiveGoal(def, aq, objIndex, obj) {
  const t = String(obj.type);
  switch (t) {
    case '1':
    case 'kill': { // kill
      const key = obj.targetKey || '*';
      return { type: 'kill', questId: def.id, objIndex, key };
    }
    case '2':
    case 'collect': { // collect（击杀掉落对应物品的怪 + 拾取）
      const itemId = obj.targetId;
      return { type: 'collect', questId: def.id, objIndex, itemId };
    }
    case '3':
    case 'reach': { // reach（坐标来自任务配置，服务端判定同源）
      const x = obj.x || 0, z = obj.z || 0;
      return { type: 'reach', questId: def.id, objIndex, x, z };
    }
    case '4':
    case 'talk': { // talk（任意 NPC 对话即可，目标为 0 表示任意）
      return { type: 'talk', questId: def.id, objIndex, npcWid: obj.targetId || 0 };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 维护阶段（装备 / 补给）
// ---------------------------------------------------------------------------
function pickMaintenanceAction(now) {
  const S = S_.S;
  const stats = S.playerStats || {};
  const lv = stats.level || 1;

  // a) 血量偏低且血瓶不足 → 补给
  const hpPots = invCount(potionOf('hp'));
  if (hpPots < CFG.HP_POTION_KEEP) {
    if (now - S_._lastSupplyAt > 2000) {
      const buy = findShopEntryFor('hp');
      if (buy) return { type: 'buyConsumable', itemId: buy.itemId, count: CFG.HP_POTION_KEEP - hpPots };
      const craft = findCraftFor('hp');
      if (craft) return { type: 'craftConsumable', recipeId: craft.recipeId, count: 1 };
    }
  }
  const mpPots = invCount(potionOf('mp'));
  if (mpPots < CFG.MP_POTION_KEEP) {
    if (now - S_._lastSupplyAt > 2000) {
      const buy = findShopEntryFor('mp');
      if (buy) return { type: 'buyConsumable', itemId: buy.itemId, count: CFG.MP_POTION_KEEP - mpPots };
      const craft = findCraftFor('mp');
      if (craft) return { type: 'craftConsumable', recipeId: craft.recipeId, count: 1 };
    }
  }

  // b) 装备更新：有更强可买装备（等级足够且买得起）→ 购买并穿戴
  const buyGear = findBetterBuyableGear(lv);
  if (buyGear) return { type: 'buyEquip', itemId: buyGear.itemId, slot: buyGear.slot };

  // c) 强化：等级足够 + 有可强化装备 + 金币/材料充足 → 强化一次
  if (lv >= CFG.ENHANCE_MIN_LV) {
    const enh = pickEnhanceCandidate();
    if (enh) return { type: 'enhance', instId: enh.instId, itemId: enh.itemId, level: enh.enhance };
  }

  // d) 材料富余时合成消耗品/强化石（数据驱动：找成本最低且材料够的配方）
  const craftAny = findAnyCraftable();
  if (craftAny && S.gold > CFG.GOLD_RESERVE) {
    return { type: 'craftConsumable', recipeId: craftAny.recipeId, count: 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 刷怪升级
// ---------------------------------------------------------------------------
function pickGrindAction() {
  // 经验条：任务优先策略——经验接近升级时更倾向刷怪（需求：无可执行任务则刷怪升级）
  const m = findMonsterForGrind();
  if (m) return { type: 'kill', key: '*', grind: true };
  // 视野无怪：向随机方向探索一段距离，寻找怪物刷新区
  const S = S_.S;
  const self = S.predictor.predicted();
  const ang = Math.random() * Math.PI * 2;
  return {
    type: 'explore', x: self.x + Math.cos(ang) * CFG.GRIND_EXPLORE_M,
    z: self.z + Math.sin(ang) * CFG.GRIND_EXPLORE_M,
  };
}

// ---------------------------------------------------------------------------
// 子目标执行
// ---------------------------------------------------------------------------
function advanceGoal(now) {
  const g = S_.goal;
  const S = S_.S;
  const net = S.net;
  const selfPos = S.predictor.predicted();
  const self = { x: selfPos.x, z: selfPos.z };

  switch (g.type) {
    // ---------- 移动类 ----------
    case 'accept':
    case 'turnin':
    case 'talk': {
      const npc = nearestNpc(g.npcWid);
      if (!npc) { log('⚠️ 视野内无 NPC，先探索寻找'); failGoal(); return; }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 任务 NPC 不可达，放弃该子目标'); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      // 已到 NPC 旁：执行操作
      if (g.type === 'accept') {
        net.sendTalkNpc ? net.sendTalkNpc(npc.wid) : (S_.sendTalkNpc && S_.sendTalkNpc(net, npc.wid));
        S_.sendQuestAccept(net, g.questId, npc.wid);
        log(`📋 尝试接取任务 #${g.questId}`);
      } else if (g.type === 'turnin') {
        S_.sendQuestTurnIn(net, g.questId, npc.wid);
        log(`✅ 提交任务 #${g.questId}`);
        S_.stats.questsDone++;
        emitStatus();
      } else {
        // talk 目标：对话任意/指定 NPC
        S_.sendTalkNpc(net, npc.wid);
        log(`💬 与 ${npc.name || 'NPC'} 对话（任务目标）`);
      }
      finishGoal();
      S_.questDirty = true;
      return;
    }

    case 'reach': {
      const d = Math.hypot(g.x - self.x, g.z - self.z);
      if (d > CFG.MOVE_REACH) {
        const r = goto(g.x, g.z, 'reach');
        if (!r.ok) { log(`⚠️ 目标区域 (${g.x.toFixed(0)},${g.z.toFixed(0)}) 不可达，放弃该子目标`); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      log(`📍 到达目标区域 (${g.x.toFixed(0)},${g.z.toFixed(0)})，等待任务判定`);
      finishGoal();
      S_.questDirty = true;
      return;
    }

    case 'explore': {
      const d = Math.hypot(g.x - self.x, g.z - self.z);
      if (d > CFG.MOVE_REACH) {
        const r = goto(g.x, g.z, 'explore');
        if (!r.ok) { finishGoal(); return; } // 探索点不可达 → 换方向
        return;
      }
      S.input.clickTarget = null;
      finishGoal();
      return;
    }

    // ---------- 战斗类 ----------
    case 'kill': {
      const target = pickKillTarget(g.key);
      if (!target) {
        // 目标怪不在视野：去最近可能的区域（杀任意怪/探索）
        const any = nearestMonster();
        if (any) {
          const r = goto(any.x, any.z, 'hunt');
          if (!r.ok) { finishGoal(); }
          return;
        }
        finishGoal(); // 无怪，交给刷怪探索
        return;
      }
      const d = Math.hypot(target.x - self.x, target.z - self.z);
      if (d > CFG.ATK_RANGE + 0.8) {
        const r = goto(target.x, target.z, 'kill');
        if (!r.ok) {
          log(`⚠️ 目标怪不可达（${r.reason}），换目标`);
          S_._skipWids.set(target.wid, performance.now() + 30000);
          S_.questDirty = true;
          return;
        }
        return;
      }
      S.input.clickTarget = null;
      beginCombat(target.wid);
      combatAttack(target);
      return;
    }

    case 'collect': {
      // 1) 若附近有目标物品掉落 → 拾取
      const drop = nearestDrop(g.itemId);
      if (drop) {
        const d = Math.hypot(drop.x - self.x, drop.z - self.z);
        if (d > CFG.PICKUP_RANGE) {
          const r = goto(drop.x, drop.z, 'pick');
          if (!r.ok) {
            S.entities.views.delete(drop.wid); // 掉落物不可达（空洞隔开）→ 本地剔除
            S_._pickupTries.set(drop.wid, 99);
            return;
          }
          return;
        }
        S.input.clickTarget = null;
        net.sendPickup(drop.wid);
        S_._pickupTries.set(drop.wid, (S_._pickupTries.get(drop.wid) || 0) + 1);
        if (S_._pickupTries.get(drop.wid) >= 6) {
          S.entities.views.delete(drop.wid); // 服务端无响应（移除事件丢失），本地剔除防死循环
          log(`⚠️ 掉落 wid=${drop.wid} 拾取无响应，本地剔除`);
        } else {
          log(`🎒 拾取掉落 wid=${drop.wid}`);
        }
        return;
      }
      // 2) 否则击杀掉落该物品的怪
      const target = pickDropMonster(g.itemId);
      if (target) {
        const d = Math.hypot(target.x - self.x, target.z - self.z);
        if (d > CFG.ATK_RANGE + 0.8) {
          const r = goto(target.x, target.z, 'kill');
          if (!r.ok) { S_._skipWids.set(target.wid, performance.now() + 30000); return; }
          return;
        }
        S.input.clickTarget = null;
        beginCombat(target.wid);
        combatAttack(target);
        return;
      }
      // 3) 无对应怪 → 兜底刷怪
      const any = nearestMonster();
      if (any) {
        const r = goto(any.x, any.z, 'hunt');
        if (!r.ok) { finishGoal(); }
        return;
      }
      finishGoal();
      return;
    }

    // ---------- 商店 / 强化 / 合成 ----------
    case 'buyEquip':
    case 'buyConsumable': {
      const npc = nearestNpcByTag(NPC_TAG_SHOP);
      if (!npc) { log('⚠️ 未找到商店 NPC'); failGoal(); return; }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 商店 NPC 不可达，放弃购买'); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      if (!S.shopData) { net.sendShopOpen(npc.wid); return; }
      const price = shopPrice(g.itemId);
      if (price === null || S.gold < price) { log(`⚠️ 金币不足或商品下架：${g.itemId}`); failGoal(); return; }
      net.sendShopBuy(g.itemId, g.count || 1);
      S_._lastSupplyAt = performance.now();
      S_.stats.itemsBought++;
      emitStatus();
      log(`🛒 购买 ${itemName(g.itemId)} ×${g.count || 1}（-${price}💰）`);
      if (g.type === 'buyEquip') {
        // 购买成功后等待背包更新，再穿戴（下一轮决策处理）
        const slotNum = g.slot;
        setTimeout(() => { equipBestInSlot(slotNum); }, 600);
      }
      finishGoal();
      S_.questDirty = true;
      return;
    }

    case 'enhance': {
      const npc = nearestNpcByTag(NPC_TAG_BLACKSMITH);
      if (!npc) { log('⚠️ 未找到铁匠 NPC'); failGoal(); return; }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 铁匠 NPC 不可达，放弃强化'); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      net.sendEnhance(g.instId, false);
      log(`🔨 强化装备 ${itemName(g.itemId)} +${g.level}`);
      finishGoal();
      return;
    }

    case 'craftConsumable': {
      const npc = nearestNpcByTag(NPC_TAG_CRAFT);
      if (!npc) { log('⚠️ 未找到合成 NPC'); failGoal(); return; }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 合成 NPC 不可达，放弃合成'); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      net.sendCraft(g.recipeId, g.count || 1);
      S_._lastSupplyAt = performance.now();
      const rec = craftRecipes().find(r => r.recipeId === g.recipeId);
      S_.stats.itemsCrafted++;
      emitStatus();
      log(`⚗️ 合成 ${rec ? rec.name : '#' + g.recipeId}`);
      finishGoal();
      S_.questDirty = true;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 移动辅助（空洞绕行 + 卡住检测）
// 游戏为路径地图（大量空洞/不可达区）：直线点击寻路会卡在空洞边缘，
// 这里统一封装：目标可达性校验 → 前方探点 → 左右扫描绕障 → 卡住兜底。
// ---------------------------------------------------------------------------
function goto(tx, tz, ctx = 'move') {
  const S = S_.S;
  const self = S.predictor.predicted();
  const now = performance.now();

  // 1) 目标点本身不可达（空洞/深水/悬崖）→ 放弃，调用方换目标
  if (terrainBlocked(tx, tz)) return { ok: false, reason: 'target-blocked' };

  const d = Math.hypot(tx - self.x, tz - self.z);
  if (d < 0.6) { S.input.clickTarget = null; return { ok: true, done: true }; }

  const ux = (tx - self.x) / d, uz = (tz - self.z) / d;

  // 2) 卡住检测：3.5s 内位移 < 0.4m → 尝试绕障，绕不动则判定卡死
  if (!S_._moveSnap || S_._moveCtx !== ctx) {
    S_._moveSnap = { x: self.x, z: self.z, at: now }; S_._moveCtx = ctx;
  } else {
    const moved = Math.hypot(self.x - S_._moveSnap.x, self.z - S_._moveSnap.z);
    if (moved > 0.4) { S_._moveSnap = { x: self.x, z: self.z, at: now }; }
    else if (now - S_._moveSnap.at > 3500) {
      S_._moveSnap = { x: self.x, z: self.z, at: now };
      const off = findClearOffset(self.x, self.z, ux, uz);
      if (off) { S.input.clickTarget = { x: self.x + off.x * 4, z: self.z + off.z * 4 }; return { ok: true, detour: true }; }
      return { ok: false, reason: 'stuck' };
    }
  }

  // 3) 前方 2.2m 探点被挡（空洞/悬崖）→ 左右扫描绕障
  if (circleBlocked(self.x + ux * 2.2, self.z + uz * 2.2, 0.5)) {
    const off = findClearOffset(self.x, self.z, ux, uz);
    if (off) { S.input.clickTarget = { x: self.x + off.x * 4, z: self.z + off.z * 4 }; return { ok: true, detour: true }; }
    return { ok: false, reason: 'no-route' };
  }

  // 4) 通畅 → 直线前往
  S.input.clickTarget = { x: tx, z: tz };
  return { ok: true };
}

/** 左右扫描（15°~90°）找第一个前方 2.2m 不被挡的方向向量 */
function findClearOffset(x, z, ux, uz) {
  for (const deg of [15, 30, 45, 60, 75, 90]) {
    const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    for (const s of [1, -1]) {
      const rx = ux * ca - s * uz * sa;
      const rz = s * ux * sa + uz * ca;
      if (!circleBlocked(x + rx * 2.2, z + rz * 2.2, 0.5)) return { x: rx, z: rz };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 残血逃生与恢复（handleLowHp 由 tick 顶层调用）
// 流程：残血 → 停止战斗 → 有威胁先径向逃跑 → 脱离威胁后喝血瓶恢复 /
//       无血瓶则前往商店补给 → 血量回到安全线后结束逃生，恢复原决策。
// ---------------------------------------------------------------------------
function lowHpNow() {
  const S = S_.S, st = S.playerStats || {};
  return !!(st.maxHp && st.hp / st.maxHp < 0.35);
}

/**
 * 残血处理。返回 true 表示本决策轮已被逃生/恢复占用。
 */
function handleLowHp(now) {
  const S = S_.S;
  const st = S.playerStats || {};
  if (!st.maxHp || st.hp === undefined) return false;
  const ratio = st.hp / st.maxHp;
  if (ratio >= CFG.HP_FLEE_AT) { S_._fleeSafeCount = 0; return false; } // 血量健康，正常决策

  // 残血：立即停止战斗（不再普攻/放技能）
  if (S_.attackWid) {
    stopCombat();
    log('🚨 残血，停止战斗');
  }

  // 1) 附近有威胁怪物且未脱离 → 径向逃跑（远离最近威胁）
  const threat = nearestMonster();
  if (threat) {
    const self = S.predictor.predicted();
    const d = Math.hypot(threat.x - self.x, threat.z - self.z);
    if (d < CFG.FLEE_SAFE_DIST) {
      fleeFrom(threat, d);
      return true;
    }
  }

  // 2) 已脱离威胁（安全区）→ 恢复
  S_._fleeSafeCount++;
  // 2a) 有血瓶 → 喝血瓶恢复（带节流，等待生效）
  const pot = potionOf('hp');
  if (pot && invCount(pot.id) > 0) {
    if (now - S_._lastFleePotAt > CFG.FLEE_USE_POT_CD) {
      S_.net.sendUseItem(pot.id, 1);
      S_._lastFleePotAt = now;
      log('❤️ 残血恢复：使用血瓶');
    }
    return true; // 恢复中：本轮不做其他事，等血量回升
  }
  // 2b) 无血瓶 → 前往商店补给 / 合成血瓶（交给 goal 流程执行）
  if (!S_.goal || (S_.goal.type !== 'buyConsumable' && S_.goal.type !== 'craftConsumable')) {
    const buy = findShopEntryFor('hp');
    const craft = findCraftFor('hp');
    if (buy) {
      setGoal({ type: 'buyConsumable', itemId: buy.itemId, count: CFG.HP_POTION_KEEP });
      log('⚠️ 残血且无血瓶，前往商店补给');
    } else if (craft) {
      setGoal({ type: 'craftConsumable', recipeId: craft.recipeId, count: 1 });
      log('⚠️ 残血且无血瓶，前往合成补给');
    } else {
      // 商店与合成均无血瓶：限频提示，保持"恢复中"状态等待转机（捡药/刷新商店）
      if (now - S_._lastFleeLogAt > 5000) {
        S_._lastFleeLogAt = now;
        log('⚠️ 残血且暂无血瓶补给途径，原地警戒待命');
      }
      return true;
    }
  }

  // 3) 恢复达标 → 结束逃生状态，放行正常决策
  if (ratio >= CFG.HP_SAFE_AT) {
    log('💚 血量已恢复安全，继续行动');
    return false;
  }
  return false; // 交给 goal 流程（buyConsumable）去商店
}

/** 残血逃跑：向远离威胁怪物的方向移动一段距离（落点不可达时扫描绕行） */
function fleeFrom(threat, dist) {
  const S = S_.S;
  const self = S.predictor.predicted();
  const dx = self.x - threat.x, dz = self.z - threat.z;
  const d = Math.hypot(dx, dz) || 1;
  const ux = dx / d, uz = dz / d;
  let tx = self.x + ux * CFG.FLEE_DIST;
  let tz = self.z + uz * CFG.FLEE_DIST;
  if (terrainBlocked(tx, tz)) {
    const off = findClearOffset(self.x, self.z, ux, uz);
    if (off) { tx = self.x + off.x * CFG.FLEE_DIST; tz = self.z + off.z * CFG.FLEE_DIST; }
    else {
      // 全向被挡 → 就近后退（不超过 8m），仍挡则原地
      tx = self.x - ux * 8; tz = self.z - uz * 8;
      if (terrainBlocked(tx, tz)) { S.input.clickTarget = null; return; }
    }
  }
  S.input.clickTarget = { x: tx, z: tz };
  S_.stats.flees++;
  S_._fleeSafeCount = 0;
  emitStatus();
  log(`🚨 残血逃跑：远离 ${threat.name || '威胁'}（${Math.round(dist)}m）`);
}

// ---------------------------------------------------------------------------
// 战斗走位（kiting）：攻击后横向绕圈移动，避免站着被怪打死
// ---------------------------------------------------------------------------
function kiteStep(v, radial) {
  const S = S_.S;
  const self = S.predictor.predicted();
  const dx = v.x - self.x, dz = v.z - self.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ux = dx / dist, uz = dz / dist;
  let tx, tz;
  if (radial) {
    // 低血：径向远离怪物（逃跑拉开）
    tx = self.x + ux * 3.2; tz = self.z + uz * 3.2;
  } else {
    // 绕圈：垂直攻击方向横移（保持可攻击距离附近打转）
    S_._kiteSide = -S_._kiteSide;
    tx = self.x - uz * 1.7 * S_._kiteSide;
    tz = self.z + ux * 1.7 * S_._kiteSide;
    if (circleBlocked(tx, tz, 0.5)) {
      tx = self.x + uz * 1.7 * S_._kiteSide;
      tz = self.z - ux * 1.7 * S_._kiteSide;
    }
  }
  if (circleBlocked(tx, tz, 0.5)) {
    // 双向都挡 → 径向退，仍挡则原地
    tx = self.x - ux * 2.2; tz = self.z - uz * 2.2;
    if (circleBlocked(tx, tz, 0.5)) { S.input.clickTarget = null; return; }
  }
  S.input.clickTarget = { x: tx, z: tz };
}

// ---------------------------------------------------------------------------
// 战斗辅助
// ---------------------------------------------------------------------------
function combatAttack(v) {
  const now = performance.now();
  const net = S_.net;
  const S = S_.S;

  // 用消耗品补血
  const stats = S.playerStats || {};
  if (stats.hp !== undefined && stats.maxHp && stats.hp / stats.maxHp < CFG.HP_USE_AT) {
    const pot = potionOf('hp');
    if (pot && invCount(pot) > 0) {
      net.sendUseItem(pot.id, 1);
      log('❤️ 使用血瓶');
    }
  }

  // 普攻为主（稳定命中、即时伤害；服务端权威判定）
  if (now - S_.lastAttackAt >= CFG.ATK_CD_MS) {
    net.sendAttack(v.wid, 0);
    S_.lastAttackAt = now;
    // 攻击后进入走位窗口：冷却期间横向绕圈躲避怪物攻击，不站着对打
    S_.kiteUntil = now + Math.max(CFG.ATK_CD_MS - 150, 420);
  }
  // 技能为辅（仅在目标血量较高、冷却好时补充，不阻塞普攻）
  const skill = bestOffensiveSkill();
  if (skill && now - S_.lastSkillAt > Math.max(skill.cdMs || 3000, 6000) && v.maxHp && v.maxHp > 60) {
    net.sendCastSkill(skill.id, v.wid, v.x, v.z);
    S_.lastSkillAt = now;
  }
}

function stopCombat() {
  if (S_.attackWid) S_.stats.monstersKilled++;
  S_.attackWid = 0;
  S_._combatNoDmg = 0;
  S_._combatHpAt = 0;
}

function beginCombat(wid) {
  S_.attackWid = wid;
  S_._combatNoDmg = 0;
  S_._combatHpAt = 0;
}

// ---------------------------------------------------------------------------
// 目标生命周期
// ---------------------------------------------------------------------------
function setGoal(g) {
  S_.goal = g;
  S_.goalAt = performance.now();
  emitStatus();
}

function finishGoal() {
  S_.goal = null;
  S_.goalTries = 0;
  emitStatus();
}

function failGoal() {
  // 失败任务标记跳过（本会话不再尝试），避免死循环
  const g = S_.goal;
  if (g && (g.type === 'accept' || g.type === 'turnin')) S_.skippedQuests.add(g.questId);
  S_.goal = null;
  S_.questDirty = true;
  emitStatus();
}

function clearGoal() {
  S_.goal = null;
  emitStatus();
}

// ---------------------------------------------------------------------------
// 实体查找（全部基于客户端可见视图，视野内驱动）
// ---------------------------------------------------------------------------
function views() {
  const S = S_.S;
  return S && S.entities ? S.entities.views : new Map();
}

function nearestNpc(npcWid) {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'npc' || v.dying) continue;
    if (npcWid && v.wid !== npcWid) continue;
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function nearestNpcByTag(tag) {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'npc' || v.dying) continue;
    if (!v.npcTag || (v.npcTag & tag) === 0) continue;
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function nearestMonster() {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'monster' || v.dying) continue;
    if (v.hp !== undefined && v.hp <= 0) continue;
    if (S_._skipWids.has(v.wid) && S_._skipWids.get(v.wid) > performance.now()) continue;
    if (terrainBlocked(v.x, v.z)) continue; // 不可达（空洞隔开）→ 不选
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/** 击杀目标怪：targetKey 匹配怪物类型（gamedata.monsters 的 key 与实体 name 关联） */
function pickKillTarget(key) {
  const nameSet = new Set();
  if (key && key !== '*') {
    const m = gamedataMonster(key);
    if (m && m.name) nameSet.add(m.name);
    // 若 key 本身像中文名也直接匹配
    nameSet.add(key);
  }
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'monster' || v.dying) continue;
    if (v.hp !== undefined && v.hp <= 0) continue;
    if (S_._skipWids.has(v.wid) && S_._skipWids.get(v.wid) > performance.now()) continue;
    if (nameSet.size && !nameSet.has(v.name)) continue; // 指定类型才打
    if (terrainBlocked(v.x, v.z)) continue; // 目标站在空洞/不可达区（路径隔开）→ 不选
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/** 击杀会掉落指定物品的怪物（从怪物掉落表数据驱动） */
function pickDropMonster(itemId) {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  const mons = gamedataMonsters();
  const dropKeys = new Set();
  for (const m of mons) {
    if ((m.drops || []).some(d => d.item === itemId)) {
      // gamedata 以 key（'goblin'）为主键，但视野实体名是 name（'哥布林'）——
      // 只加 key 会导致永不匹配、永远找不到掉落怪（collect 卡死根因之一）
      dropKeys.add(m.key || m.name);
      if (m.name) dropKeys.add(m.name);
    }
  }
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'monster' || v.dying) continue;
    if (v.hp !== undefined && v.hp <= 0) continue;
    if (S_._skipWids.has(v.wid) && S_._skipWids.get(v.wid) > performance.now()) continue;
    const isDrop = dropKeys.has(v.name);
    if (!isDrop) continue;
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function findMonsterForGrind() {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  const stats = S.playerStats || {};
  const expRatio = stats.expToNext ? (stats.exp || 0) / stats.expToNext : 0;
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'monster' || v.dying) continue;
    if (v.hp !== undefined && v.hp <= 0) continue;
    if (S_._skipWids.has(v.wid) && S_._skipWids.get(v.wid) > performance.now()) continue;
    // 不找明显打不过的（hp 远高于自身攻击力*18 的跳过，避免刮痧）
    const atk = stats.attack || 12;
    if (v.maxHp && v.maxHp > atk * 18 && v.hp > 0) continue;
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) return null;
  return best;
}

function nearestDrop(itemId) {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'item' || v.dying) continue;
    if (itemId && v.itemId !== itemId) continue;
    if ((S_._pickupTries.get(v.wid) || 0) >= 6) continue; // 拾取无响应容错：本地剔除
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 数据驱动查询（gamedata）
// ---------------------------------------------------------------------------
function gamedataItems() { const d = S_.gamedata; if (!d) return []; return Array.isArray(d.items) ? d.items : Object.values(d.items || {}); }
function gamedataMonsters() {
  const d = S_.gamedata;
  if (!d) return [];
  const m = d.monsters;
  if (!m) return [];
  if (Array.isArray(m)) return m;
  // dict：{key: def} → 保留 key 字段（击杀目标/掉落匹配需要）
  return Object.entries(m).map(([key, v]) => ({ ...v, key }));
}
function gamedataMonster(key) { return gamedataMonsters().find(x => x.key === key || x.name === key); }
function gamedataNpcs() { const d = S_.gamedata; if (!d) return []; const n = d.npcs; return Array.isArray(n) ? n : Object.values(n || {}); }
function craftRecipes() { const d = S_.gamedata; if (!d || !d.craft) return []; return d.craft.recipes || d.craft; }
function itemDefById(id) { return gamedataItems().find(x => x.id === id); }
function itemCount() { return gamedataItems().length; }
function monsterCount() { return gamedataMonsters().length; }
function questCount() { const d = S_.gamedata; return d && d.quests ? d.quests.length : 0; }

function questDef(questId) {
  const d = S_.gamedata;
  if (!d || !d.quests) return null;
  return d.quests.find(x => x.id === questId) || null;
}
function catOf(questId) {
  const def = questDef(questId);
  return def ? ({ main: 1, side: 2, daily: 3, repeat: 4 }[def.category] || 1) : 1;
}

/** 消耗品查找：restoreHp>0 → hp 类，restoreMp>0 → mp 类 */
function potionOf(kind) {
  const items = gamedataItems();
  return items.find(x => x.type === 'consumable' && (kind === 'hp' ? (x.restoreHp || 0) > 0 : (x.restoreMp || 0) > 0));
}

function invCount(itemId) {
  const S = S_.S;
  if (!itemId || !S.inventory) return 0;
  return S.inventory[itemId] || 0;
}

/** 商店条目（shop.json 或 S2C_SHOP 帧），优先 S2C 实时数据。
 *  注意：gamedata 商店条目字段为 item（如 {"item":2001}），S2C_SHOP 帧为 itemId，
 *        此处统一映射为 itemId，避免静态表与实时帧匹配不一致。 */
function shopEntries() {
  const S = S_.S;
  if (S.shopData && S.shopData.entries) return S.shopData.entries;
  const d = S_.gamedata;
  if (!d || !d.shops) return [];
  const shops = Array.isArray(d.shops) ? d.shops : Object.values(d.shops);
  const entries = [];
  for (const sh of shops) for (const e of (sh.entries || [])) {
    entries.push({ ...e, itemId: e.itemId !== undefined ? e.itemId : e.item, shopId: sh.shopId || 0 });
  }
  return entries;
}
function shopPrice(itemId) {
  const e = shopEntries().find(x => x.itemId === itemId);
  if (!e) return null;
  return e.discountPrice > 0 ? e.discountPrice : e.price;
}

function findShopEntryFor(kind) {
  const pot = potionOf(kind);
  if (!pot) return null;
  const e = shopEntries().find(x => x.itemId === pot.id);
  return e || null;
}
function findCraftFor(kind) {
  const pot = potionOf(kind);
  if (!pot) return null;
  return craftRecipes().find(r => r.resultItemId === pot.id && craftableNow(r)) || null;
}
/** 材料/金币/等级是否满足 */
function craftableNow(r) {
  const S = S_.S;
  if (!r) return false;
  if (r.levelReq && S.playerStats && (S.playerStats.level || 1) < r.levelReq) return false;
  if (r.goldCost && S.gold < r.goldCost) return false;
  return (r.materials || []).every(m => invCount(m.itemId) >= m.count);
}
function findAnyCraftable() {
  const recipes = craftRecipes();
  if (!recipes.length) return null;
  for (const r of recipes) {
    if (craftableNow(r)) return r;
  }
  return null;
}

/** 装备评分：攻击权重 2、防御 1、生命 0.2（与属性系统一致的可比口径） */
function equipScore(d) {
  return (d.attackBonus || 0) * 2 + (d.defenseBonus || 0) + (d.hpBonus || 0) * 0.2;
}
function slotNumber(slotKey) {
  return { helm: 1, chest: 2, pants: 3, gloves: 4, boots: 5, weapon: 6 }[slotKey] || 0;
}

/** 找可购买且更强的装备（等级满足、买得起、优于当前穿戴） */
function findBetterBuyableGear(lv) {
  const S = S_.S;
  const entries = shopEntries();
  let best = null;
  for (const e of entries) {
    const d = itemDefById(e.itemId);
    if (!d || d.type !== 'equip') continue;
    if (d.levelReq && lv < d.levelReq) continue;
    if (e.price > S.gold - CFG.GOLD_RESERVE) continue;
    const slot = slotNumber(d.slot);
    if (!slot) continue;
    const cur = S.equip && S.equip[slot];
    const curScore = cur && cur.itemId ? equipScore(itemDefById(cur.itemId)) * (1 + (cur.enhance || 0) * 0.15) : 0;
    const newScore = equipScore(d);
    if (newScore > curScore + 0.5) {
      if (!best || newScore > best.score) best = { itemId: e.itemId, slot, score: newScore };
    }
  }
  return best;
}

/** 强化候选：背包中可强化装备 + 强化石数量满足最低档 + 金币足够 */
function pickEnhanceCandidate() {
  const S = S_.S;
  const bag = S.equipBag || [];
  const enhCfg = S_.gamedata && S_.gamedata.enhance;
  if (!enhCfg || !enhCfg.levels || !enhCfg.levels.length) return null;
  const lv0 = enhCfg.levels[0];
  for (const ins of bag) {
    if (ins.locked) continue;
    const lvl = ins.enhance || 0;
    const nextLv = enhCfg.levels[lvl];
    if (!nextLv) continue; // 已满级
    if (nextLv.goldCost > S.gold - CFG.GOLD_RESERVE) continue;
    if (invCount(nextLv.stoneItemId) < (nextLv.stoneCount || 1)) continue;
    return { instId: ins.instId, itemId: ins.itemId, enhance: lvl };
  }
  return null;
}

/** 穿戴最佳装备（同槽位多件时选评分最高） */
function equipBestInSlot(slotNum) {
  const S = S_.S;
  const bag = S.equipBag || [];
  const d = itemDefById;
  let best = null, bestScore = -1;
  for (const ins of bag) {
    if (slotNumber((d(ins.itemId) || {}).slot) !== slotNum) continue;
    const sc = equipScore(d(ins.itemId));
    if (sc > bestScore) { bestScore = sc; best = ins; }
  }
  if (best) {
    S.net.sendEquip(slotNum, best.instId);
    log(`⚔️ 穿戴 ${itemName(best.itemId)}（槽位 ${slotNum}）`);
  }
}

// ---------------------------------------------------------------------------
// 技能选择（数据驱动：挑伤害最高、已学习的技能）
// ---------------------------------------------------------------------------
function bestOffensiveSkill() {
  const S = S_.S;
  const learned = S.learnedSkills || [];
  if (!learned.length) return null;
  const skills = S_.gamedata && S_.gamedata.skills;
  if (!skills) return null;
  const arr = Array.isArray(skills) ? skills : Object.values(skills);
  let best = null, bestDmg = 0;
  for (const s of arr) {
    if (!learned.find(l => l.id === s.id)) continue;
    if (s.damage === undefined || s.damage <= 0) continue;
    const dmg = s.damage || 0;
    if (dmg > bestDmg) { bestDmg = dmg; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const NPC_TAG_SHOP = 4;
const NPC_TAG_BLACKSMITH = 8;
const NPC_TAG_CRAFT = 64;

function itemName(itemId) {
  const d = itemDefById(itemId);
  return d ? d.name : '#' + itemId;
}
function shopIdOf(npcWid) {
  const d = S_.gamedata;
  if (!d || !d.shops) return 0;
  if (Array.isArray(d.shops)) return d.shops.length ? (d.shops[0].shopId || 0) : 0;
  const keys = Object.keys(d.shops);
  return keys.length ? (parseInt(keys[0], 10) || 0) : 0;
}

function goalPhaseName(g) {
  if (!g) return 'idle';
  return {
    accept: '接任务', turnin: '交任务', talk: '对话', reach: '到达',
    kill: '战斗', collect: '收集', explore: '探索',
    buyEquip: '购装备', buyConsumable: '购补给', enhance: '强化', craftConsumable: '合成',
  }[g.type] || g.type;
}

function detectManualInput() {
  // 键盘/鼠标最近输入由 boot.js 的监听器写入 S_.S._lastManualInput
  const S = S_.S;
  return !!(S && S._lastManualInput && performance.now() - S._lastManualInput < 6000);
}

function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  S_._logBuf.push(`[${t}] ${msg}`);
  if (S_._logBuf.length > 60) S_._logBuf.shift();
  if (S_.onLog) S_.onLog(msg);
}

export function getLog() { return S_._logBuf; }

function emitStatus() {
  if (S_.onStatus) S_.onStatus({ running: S_.running, paused: S_.paused, phase: getPhase(), stats: { ...S_.stats } });
}

function saveState() {
  try {
    localStorage.setItem('ew_autobot', JSON.stringify({
      enabled: S_.running && !S_.paused,
      stats: S_.stats,
      savedAt: Date.now(),
    }));
  } catch (e) { /* 忽略 */ }
}

// 暴露调试钩子
export function __testAttack(wid, slot = 0) {
  if (!S_.net) return 'no-net';
  if (!wid) return 'no-wid';
  S_.net.sendAttack(wid, slot);
  return 'sent:' + wid;
}
export function __testSkill(skillId, wid, x, z) {
  if (!S_.net) return 'no-net';
  S_.net.sendCastSkill(skillId, wid || 0, x || 0, z || 0);
  return 'sent';
}
export function __autobotDebug() {
  pullQuestViews();
  return {
    state: { running: S_.running, paused: S_.paused, goal: S_.goal, attackWid: S_.attackWid, lastAtk: S_.lastAttackAt, lastSkill: S_.lastSkillAt, combatNoDmg: S_._combatNoDmg, netOk: !!(S_.net && S_.net.connected) },
    stats: S_.stats,
    questList: S_.questList.map(q => q.questId),
    questProgress: S_.questProgress.map(q => ({ id: q.questId, status: q.status, obj: (q.objectives || []).map(o => o.current + '/' + o.required) })),
    gamedata: S_.gamedata ? Object.keys(S_.gamedata) : null,
  };
}
