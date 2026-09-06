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
  _castLockUntil: 0,    // 技能前摇走位锁定截止时间（期间静止等前摇结算）
  _skillAt: {},         // 技能 id -> 上次施放时间（per-skill 本地节流）
  _lastBuffAt: 0,       // 自身增益技能上次施放时间（刷新节流）
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
  _supplyFailAt: 0,     // 补给失败冷却截止时间（金币不足时避免反复跑商店）
  _collectGotoX: 0,     // 收集任务：前往掉落怪区的探索点（复用至到达/超时）
  _collectGotoZ: 0,
  _collectGotoAt: 0,
  _spawns: null,        // 生物投放数据（GET /api/spawns，数据驱动：怪/城坐标）
  _spawnsAt: 0,         // 最近一次成功拉取时间
  _spawnsLoading: false,
  _spawnSkip: new Map(),// 投放点 -> 跳过截止时间（goto 失败后 60s 内不再前往）
  _logBuf: [],
};

const CFG = {
  DECISION_MS: 220,        // 决策节流
  QUEST_REFRESH_MS: 2500,  // 任务数据刷新间隔
  MOVE_REACH: 0.9,         // 到达判定距离
  ATK_RANGE: 2.9,          // 普攻距离（服务端判定 3.2m，留余量）
  ATK_CD_MS: 700,          // 普攻节流（服务端冷却 0.5s）
  NPC_RANGE: 3.2,          // 对话 / 商店 / 强化 / 合成 操作距离
  PICKUP_RANGE: 1.6,       // 主动拾取距离（服务端判定 2.0m，留网络偏差余量稳定命中；原 2.4 超服务端判定被拒）
  PICKUP_GOTO_RANGE: 16,   // 空闲时前往拾取的掉落物最大距离（更远不值得跑）
  CAST_LOCK_MS: 400,       // 技能前摇走位锁定（前摇 200ms + 余量，防 cancelOnMove 打断）
  HEAL_SKILL_AT: 0.55,      // 血量低于 55% 时优先使用治疗/回血技能（免费，先于血瓶）
  BUFF_REFRESH_MS: 20000,   // 自身增益技能（攻击/防御/移速等）刷新间隔
  COMBAT_SAFE_MIN: 2.2,     // 与目标距离低于该值立即径向拉开（避免贴身受伤）
  COMBAT_KEEP_DIST: 2.6,    // 战斗走位保持的目标距离（服务端普攻射程 3.2m，留网络偏差余量稳定命中；怪近战 1.6m 打不到）
  STUCK_MS: 1200,           // 想动但位移≈0 持续该时长 → 判定卡住并脱困
  SKILL_CD_TOL_MS: 150,     // 技能冷却就绪判定容忍（服务端 cdMs 精确到秒的余量）
  GOAL_TIMEOUT_MS: 45000,  // 子目标超时
  GRIND_EXPLORE_M: 40,     // 无怪时探索距离
  MONSTER_FREE_R: 90,      // 主城免怪半径（与服务端 config.worldMonsterFreeRadius 一致）
  MONSTER_BAND_M: 30,      // 怪物等级→距离带（每级 +30m，近弱远强：Lv1≈90~120m）
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

  // ── 0.5 卡住脱困：有移动意图但位移≈0 持续超阈值 → 换向/放弃目标，避免原地挨打 ──
  if (S.input && S.input.clickTarget) {
    const dp = S_._lastSelfPos ? Math.hypot(self.x - S_._lastSelfPos.x, self.z - S_._lastSelfPos.z) : 1;
    S_._lastSelfPos = { x: self.x, z: self.z };
    if (dp < 0.04) {
      if (!S_._stuckSince) S_._stuckSince = now;
      else if (now - S_._stuckSince > CFG.STUCK_MS) {
        S_._stuckSince = 0;
        log('⚠️ 检测到卡住，强制脱困');
        if (S_.attackWid) {
          // 战斗中：强拉脱离威胁 + 放弃该目标（换目标继续打）
          const v = S.entities.views.get(S_.attackWid);
          if (v) fleeFrom(v, 8);
          S_._skipWids.set(S_.attackWid, performance.now() + 30000);
          stopCombat();
          S_.questDirty = true;
        } else {
          // 行走中：8 方向大距离扫描找可走点（脱窄缝/障碍），仍无则停下等下一次规划
          const p = findEscapePoint(self, 1, 0, 4);
          S.input.clickTarget = p || null;
        }
        return;
      }
    } else S_._stuckSince = 0;
  }

  // ── 0.5b 顺手拾取：范围内掉落物（任意状态不 goto，不中断当前目标） ──
  if (tryPickupNearby(self, false)) return;

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
        // 太远：低血先拉开（喝血瓶回血），否则追上去；追击同时放远程技能
        if (lowHp) kiteStep(v, true);
        else {
          castCombatSkills(v); // 远程技能（狙击 20m 等）边追边消耗，不必贴脸才放
          const r = goto(v.x, v.z, 'chase');
          if (!r.ok) { // 目标不可达/无路（空洞隔开）→ 放弃换目标
            log(`⚠️ 目标 wid=${S_.attackWid} 不可达（${r.reason}），放弃`);
            S_._skipWids.set(S_.attackWid, performance.now() + 30000);
            stopCombat();
            S_.questDirty = true;
            return;
          }
        }
      } else if (d < CFG.COMBAT_SAFE_MIN) {
        // 贴身保护：过近立即径向拉开，维持安全距离（避免站着被怪贴身打）
        kiteStep(v, true);
        if (!S.input.clickTarget) {
          // 贴身且无路可退（被地形夹住）→ 强制大距离逃跑并放弃该目标，避免原地挨打
          fleeFrom(v, 10);
          S_._skipWids.set(S_.attackWid, performance.now() + 30000);
          stopCombat();
          S_.questDirty = true;
          return;
        }
      } else if (now < S_.kiteUntil) {
        if (now < S_._castLockUntil) {
          // 移动打断技能的前摇锁定：原地等前摇结算
          S.input.clickTarget = null;
        } else {
          // 攻击冷却中：持续走位躲避（绕圈；低血/贴身径向拉开）
          kiteStep(v, lowHp);
        }
        // 移动施法：走位窗口内同步放技能（服务端支持移动中施法，边走边放）
        castCombatSkills(v);
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
      // 子目标执行中周期性刷新任务进度（权威数据）：
      // 进度达成后完成检测立即生效并去提交，避免拖到超时才重规划
      if (now - S_.questRefreshedAt > CFG.QUEST_REFRESH_MS) {
        refreshQuests();
        return;
      }
      advanceGoal(now);
      return;
    }
  }

  // ── 2.5 空闲拾取：附近掉落物优先前往拾取（攒材料/金币，任务与维护之前） ──
  if (tryPickupNearby(self, true)) return;

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

  // a0) 自动穿戴：背包中更强的装备立即穿上（购买/拾取后生效，确定性替代 setTimeout）
  autoEquipBest();

  // a) 血量偏低且血瓶不足 → 补给（补给失败冷却期内跳过，避免反复跑商店）
  const hpPots = invCount(potionOf('hp'));
  if (hpPots < CFG.HP_POTION_KEEP && now >= S_._supplyFailAt) {
    if (now - S_._lastSupplyAt > 2000) {
      const buy = findShopEntryFor('hp');
      if (buy) return { type: 'buyConsumable', itemId: buy.itemId, count: CFG.HP_POTION_KEEP - hpPots };
      const craft = findCraftFor('hp');
      if (craft) return { type: 'craftConsumable', recipeId: craft.recipeId, count: 1, npcTag: craft.npcTag || NPC_TAG_CRAFT };
    }
  }
  const mpPots = invCount(potionOf('mp'));
  if (mpPots < CFG.MP_POTION_KEEP && now >= S_._supplyFailAt) {
    if (now - S_._lastSupplyAt > 2000) {
      const buy = findShopEntryFor('mp');
      if (buy) return { type: 'buyConsumable', itemId: buy.itemId, count: CFG.MP_POTION_KEEP - mpPots };
      const craft = findCraftFor('mp');
      if (craft) return { type: 'craftConsumable', recipeId: craft.recipeId, count: 1, npcTag: craft.npcTag || NPC_TAG_CRAFT };
    }
  }

  // b1) 装备更新：有更强可买装备（等级足够且买得起）→ 购买并穿戴
  const buyGear = findBetterBuyableGear(lv);
  if (buyGear) return { type: 'buyEquip', itemId: buyGear.itemId, slot: buyGear.slot };

  // b2) 装备更新：材料/金币足够时合成最强装备（严格强于当前穿戴，元数据驱动）
  const craftGear = bestCraftableGear(lv);
  if (craftGear) return { type: 'craftConsumable', recipeId: craftGear.recipe.recipeId, count: 1, npcTag: craftGear.recipe.npcTag || NPC_TAG_CRAFT };

  // c) 强化：等级足够 + 有可强化装备 + 金币/材料充足 → 强化一次
  if (lv >= CFG.ENHANCE_MIN_LV) {
    const enh = pickEnhanceCandidate();
    if (enh) return { type: 'enhance', instId: enh.instId, itemId: enh.itemId, level: enh.enhance };
    // 有可强化装备但缺强化石（商店不售，只能合成）→ 优先合成强化石
    if (hasEnhanceableGear() && invCount(enhanceStoneId()) < 1 && S.gold > CFG.GOLD_RESERVE) {
      const stoneRecipe = craftRecipes().find(r => r.resultItemId === enhanceStoneId());
      if (stoneRecipe && craftableNow(stoneRecipe)) {
        return { type: 'craftConsumable', recipeId: stoneRecipe.recipeId, count: 1, npcTag: stoneRecipe.npcTag || NPC_TAG_CRAFT };
      }
    }
  }

  // d) 材料富余时合成消耗品/强化石（数据驱动：找成本最低且材料够的配方）
  const craftAny = findAnyCraftable();
  if (craftAny && S.gold > CFG.GOLD_RESERVE) {
    return { type: 'craftConsumable', recipeId: craftAny.recipeId, count: 1, npcTag: craftAny.npcTag || NPC_TAG_CRAFT };
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
      // 服务端提交/接取判定：任务绑定 NPC（giverNpc）才需要走到 NPC 旁；
      // 无绑定 NPC 的任务可原地提交/接取（npcWid=0，服务端跳过 NPC 校验），
      // 避免"视野内无 NPC"时无限探索卡死提交流程
      const qdef = questDef(g.questId);
      const needNpc = g.type === 'talk' || !!(qdef && qdef.giverNpc);
      let npc = null;
      if (needNpc) {
        npc = nearestNpc(g.npcWid);
        if (!npc) { log('⚠️ 视野内无 NPC，先探索寻找'); failGoal(); return; }
        const d = Math.hypot(npc.x - self.x, npc.z - self.z);
        if (d > CFG.NPC_RANGE) {
          const r = goto(npc.x, npc.z, 'npc');
          if (!r.ok) { log('⚠️ 任务 NPC 不可达，放弃该子目标'); failGoal(); }
          return;
        }
      }
      S.input.clickTarget = null;
      // 已到 NPC 旁（或无绑定 NPC 原地）：执行操作
      if (g.type === 'accept') {
        if (npc) net.sendTalkNpc ? net.sendTalkNpc(npc.wid) : (S_.sendTalkNpc && S_.sendTalkNpc(net, npc.wid));
        S_.sendQuestAccept(net, g.questId, npc ? npc.wid : 0);
        log(`📋 尝试接取任务 #${g.questId}`);
      } else if (g.type === 'turnin') {
        S_.sendQuestTurnIn(net, g.questId, npc ? npc.wid : 0);
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
      closeNpcPanels(); // 接/交/对话完成后关闭 NPC 面板
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
      // 完成检测：目标进度已满 → 立即结束子目标（下轮去提交），不等超时
      if (goalComplete(g)) { finishGoal(); return; }
      const target = pickKillTarget(g.key);
      if (!target) {
        // 目标怪不在视野：优先按投放数据坐标前往（数据驱动）；无则打最近任意怪
        if (ensureSpawns()) {
          const pt = nearestSpawnPoint(g.key);
          if (pt) {
            const d2 = Math.hypot(self.x - pt.x, self.z - pt.z);
            if (d2 > CFG.MOVE_REACH) {
              const r = goto(pt.x, pt.z, 'kill');
              if (!r.ok) {
                S_._spawnSkip.set(pt.x + ',' + pt.z, performance.now() + 60000);
                const any2 = nearestMonster();
                if (any2) { const r2 = goto(any2.x, any2.z, 'hunt'); if (!r2.ok) finishGoal(); }
                return;
              }
              return;
            }
          }
        }
        // 投放数据未就绪/无投放点 → 打最近任意怪
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
        // 追击途中先放远程技能（狙击 range 20m 等），边追边消耗
        castCombatSkills(target);
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
      // 完成检测：目标进度已满 → 立即结束子目标（下轮去提交），不等超时
      if (goalComplete(g)) { finishGoal(); return; }
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
        S_.questDirty = true; // 拾取可能推进任务进度：刷新后立即检测完成
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
      // 3) 视野无掉落怪：优先按投放数据坐标前往（数据驱动）；否则按等级带探索
      const dropInfo = dropMonsterInfo(g.itemId);
      if (dropInfo) {
        // 3a) 投放数据坐标优先（精准）：前往最近未跳过的掉落怪投放点
        if (ensureSpawns()) {
          const pt = nearestSpawnPoint(dropInfo.key || '*');
          const now = performance.now();
          if (pt) {
            if (S_._collectGotoAt && now < S_._collectGotoAt &&
                Math.hypot(self.x - S_._collectGotoX, self.z - S_._collectGotoZ) > 6) {
              const r2 = goto(S_._collectGotoX, S_._collectGotoZ, 'collect');
              if (!r2.ok) { S_._collectGotoAt = 0; }
              return;
            }
            S_._collectGotoX = pt.x; S_._collectGotoZ = pt.z;
            S_._collectGotoAt = now + 25000;
            log(`🔍 前往投放点 (${pt.x.toFixed(0)},${pt.z.toFixed(0)}) 寻找掉落怪 ${dropInfo.key || dropInfo.name || ''}`);
            const r = goto(pt.x, pt.z, 'collect');
            if (!r.ok) {
              S_._spawnSkip.set(pt.x + ',' + pt.z, now + 60000);
              S_._collectGotoAt = 0;
            }
            return;
          }
        }
        // 3b) 投放数据未就绪/无该怪投放 → 等级带探索（免怪半径 + 等级×带宽 ± 随机）
        const base = CFG.MONSTER_FREE_R + dropInfo.level * CFG.MONSTER_BAND_M;
        if (S_._collectGotoAt && performance.now() < S_._collectGotoAt &&
            Math.hypot(self.x - S_._collectGotoX, self.z - S_._collectGotoZ) > 6) {
          const r2 = goto(S_._collectGotoX, S_._collectGotoZ, 'collect');
          if (!r2.ok) { S_._collectGotoAt = 0; }
          return;
        }
        const ang = Math.random() * Math.PI * 2;
        const dist = base + Math.random() * 80;
        S_._collectGotoX = Math.cos(ang) * dist;
        S_._collectGotoZ = Math.sin(ang) * dist;
        S_._collectGotoAt = performance.now() + 25000;
        log(`🔍 无投放数据，按等级带探索 ${dist.toFixed(0)}m（Lv${dropInfo.level} 掉落区）`);
        const r = goto(S_._collectGotoX, S_._collectGotoZ, 'collect');
        if (!r.ok) { S_._collectGotoAt = 0; }
        return;
      }
      // 4) 掉落表无该物品（数据缺失）→ 兜底打最近怪（预期无收益，待数据补齐）
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
      // 按目标物品匹配售卖商店对应的 NPC（元数据 shopId 驱动），避免找错商店
      const npc = nearestShopNpc(g.itemId) || nearestNpcByTag(NPC_TAG_SHOP);
      if (!npc) {
        // NPC 不在视野（玩家在野外做任务离城远）：先回主城（城市中心）再找，
        // 避免"视野内无 NPC"无限重试卡死；回城仍失败则节流 15s
        const r = goto(0, 0, 'city');
        if (!r.ok) {
          log('⚠️ 主城不可达，放弃购买');
          S_._supplyFailAt = performance.now() + 15000;
          closeNpcPanels();
          failGoal();
        }
        return;
      }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 商店 NPC 不可达，放弃购买'); S_._supplyFailAt = performance.now() + 15000; closeNpcPanels(); failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      if (!S.shopData) { net.sendShopOpen(npc.wid); return; }
      const price = shopPrice(g.itemId);
      if (price === null || S.gold < price) {
        log(`⚠️ 金币不足或商品下架：${g.itemId}`);
        S_._supplyFailAt = performance.now() + 15000; // 15s 内不再尝试补给，避免反复跑商店
        closeNpcPanels();
        failGoal();
        return;
      }
      net.sendShopBuy(g.itemId, g.count || 1);
      S_._lastSupplyAt = performance.now();
      S_.stats.itemsBought++;
      emitStatus();
      log(`🛒 购买 ${itemName(g.itemId)} ×${g.count || 1}（-${price}💰）`);
      closeNpcPanels(); // 购买完成后关闭商店面板
      finishGoal();
      S_.questDirty = true;
      return; // 新装备穿戴由维护期的 autoEquipBest() 统一处理（避免 setTimeout 竞态）
    }

    case 'enhance': {
      const npc = nearestNpcByTag(NPC_TAG_BLACKSMITH);
      if (!npc) {
        const r = goto(0, 0, 'city');
        if (!r.ok) { log('⚠️ 主城不可达，放弃强化'); S_._supplyFailAt = performance.now() + 15000; failGoal(); }
        return;
      }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 铁匠 NPC 不可达，放弃强化'); S_._supplyFailAt = performance.now() + 15000; failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      net.sendEnhance(g.instId, false);
      log(`🔨 强化装备 ${itemName(g.itemId)} +${g.level}`);
      S_.stats.enhanceOk++;
      emitStatus();
      closeNpcPanels(); // 强化完成后关闭强化面板
      finishGoal();
      S_.questDirty = true;
      return;
    }

    case 'craftConsumable': {
      // 合成 NPC：优先目标配方自带 npcTag（元数据驱动），退化为任意合成 NPC
      const npc = nearestNpcByTag(g.npcTag || NPC_TAG_CRAFT);
      if (!npc) {
        const r = goto(0, 0, 'city');
        if (!r.ok) { log('⚠️ 主城不可达，放弃合成'); S_._supplyFailAt = performance.now() + 15000; failGoal(); }
        return;
      }
      const d = Math.hypot(npc.x - self.x, npc.z - self.z);
      if (d > CFG.NPC_RANGE) {
        const r = goto(npc.x, npc.z, 'npc');
        if (!r.ok) { log('⚠️ 合成 NPC 不可达，放弃合成'); S_._supplyFailAt = performance.now() + 15000; failGoal(); }
        return;
      }
      S.input.clickTarget = null;
      net.sendCraft(g.recipeId, g.count || 1);
      S_._lastSupplyAt = performance.now();
      const rec = craftRecipes().find(r => r.recipeId === g.recipeId);
      S_.stats.itemsCrafted++;
      emitStatus();
      log(`⚗️ 合成 ${rec ? rec.name : '#' + g.recipeId}`);
      closeNpcPanels(); // 合成完成后关闭合成面板
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
  // 2a') 免费治疗技能优先（冷却就绪直接用，省血瓶；残血中也能放，self 技能无需靠近）
  const hs = readyHealSkill(st.mp !== undefined ? st.mp : 0);
  if (hs) {
    const self = S.predictor.predicted();
    castSkill(hs, 0, self.x, self.z);
    log(`💚 残血恢复：使用回复技能 ${hs.name}`);
    return true;
  }
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
  // 2b) 无血瓶 → 前往商店补给 / 合成血瓶（交给 goal 流程执行；补给失败冷却期内原地警戒）
  if (!S_.goal || (S_.goal.type !== 'buyConsumable' && S_.goal.type !== 'craftConsumable')) {
    const buy = now >= S_._supplyFailAt ? findShopEntryFor('hp') : null;
    const craft = findCraftFor('hp');
    if (buy) {
      setGoal({ type: 'buyConsumable', itemId: buy.itemId, count: CFG.HP_POTION_KEEP });
      log('⚠️ 残血且无血瓶，前往商店补给');
    } else if (craft) {
      setGoal({ type: 'craftConsumable', recipeId: craft.recipeId, count: 1, npcTag: craft.npcTag || NPC_TAG_CRAFT });
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
/** 从自身出发按方向向量扫描 8 个角度（45° 步进，径向优先）找可走落点 */
function findEscapePoint(self, ux, uz, dist) {
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const cos = Math.cos(a), sin = Math.sin(a);
    const ex = ux * cos - uz * sin;
    const ez = ux * sin + uz * cos;
    const tx = self.x + ex * dist, tz = self.z + ez * dist;
    if (!circleBlocked(tx, tz, 0.5)) return { x: tx, z: tz };
  }
  return null;
}

function kiteStep(v, radial) {
  const S = S_.S;
  const self = S.predictor.predicted();
  const dx = v.x - self.x, dz = v.z - self.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ux = dx / dist, uz = dz / dist;
  let tx, tz;
  if (radial) {
    // 低血/贴身：径向远离怪物（方向=怪物反方向）；落点被挡则旋转角度绕行（避免卡墙/卡怪原地挨打）
    const p = findEscapePoint(self, -ux, -uz, 3.2);
    if (!p) { S.input.clickTarget = null; return; }
    tx = p.x; tz = p.z;
  } else {
    // 风筝走位：始终往怪物反方向移动，维持 COMBAT_KEEP_DIST 安全距离
    // 怪逼近 → 径向退到目标距离；拉开太远 → 微进保持射程；合适 → 小幅横移
    const keep = CFG.COMBAT_KEEP_DIST;
    if (dist < keep - 0.3) {
      // 怪过近 → 往怪物反方向退（退到 keep 距离）
      const p = findEscapePoint(self, -ux, -uz, Math.min(keep - dist + 0.6, 3.0));
      if (!p) { S.input.clickTarget = null; return; }
      tx = p.x; tz = p.z;
    } else if (dist > keep + 0.8) {
      // 拉开太远 → 朝怪微进（保持普攻/技能射程）
      const p = findEscapePoint(self, ux, uz, 1.2);
      if (!p) { S.input.clickTarget = null; return; }
      tx = p.x; tz = p.z;
    } else {
      // 距离合适 → 小幅横移（不贴近也不远离，保持环形走位）
      S_._kiteSide = -S_._kiteSide;
      tx = self.x - uz * 1.0 * S_._kiteSide;
      tz = self.z + ux * 1.0 * S_._kiteSide;
      if (circleBlocked(tx, tz, 0.5)) {
        tx = self.x + uz * 1.0 * S_._kiteSide;
        tz = self.z - ux * 1.0 * S_._kiteSide;
      }
    }
  }
  if (circleBlocked(tx, tz, 0.5)) {
    // 兜底：角度扫描（远离怪方向优先）找可走点，仍无 → 原地
    const p = findEscapePoint(self, -ux, -uz, 2.2);
    if (!p) { S.input.clickTarget = null; return; }
    tx = p.x; tz = p.z;
  }
  S.input.clickTarget = { x: tx, z: tz };
}

// ---------------------------------------------------------------------------
// 战斗辅助（移动施法模式：走位与放技能并行，避免站桩挨打）
// ---------------------------------------------------------------------------
function combatAttack(v) {
  const now = performance.now();
  const net = S_.net;
  const S = S_.S;

  // 普攻为主（稳定命中、即时伤害；服务端权威判定）
  if (now - S_.lastAttackAt >= CFG.ATK_CD_MS) {
    // 按技能方式释放普通攻击（skill 1000）：与其他技能同协议，
    // 触发技能栏冷却与施法特效（原 sendAttack 独立协议无冷却/特效表现）
    const atkSkill = skillDefById(1000);
    if (atkSkill) {
      castSkill(atkSkill, v.wid, v.x, v.z);
      if (now - (S_._lastAtkLogAt || 0) > 3000) {
        S_._lastAtkLogAt = now;
        log('⚔️ 普攻（技能协议）');
      }
    } else {
      net.sendAttack(v.wid, 0); // 兜底：元数据缺失时走旧协议
    }
    S_.lastAttackAt = now;
    // 攻击后进入走位窗口：冷却期间持续走位躲避怪物攻击，不站着对打
    S_.kiteUntil = now + Math.max(CFG.ATK_CD_MS - 150, 420);
  }
  // 移动施法：走位与技能施放并行（服务端已支持移动中施法，不站桩）
  castCombatSkills(v);
}

/** 施放战斗技能（回复/进攻/增益）：按元数据冷却/距离/蓝量判定，移动中可施放 */
function castCombatSkills(v, mp) {
  const now = performance.now();
  const S = S_.S;
  const st = S.playerStats || {};
  if (mp === undefined) mp = st.mp !== undefined ? st.mp : 0;
  const self = S.predictor.predicted();
  const distToTarget = v ? Math.hypot(v.x - self.x, v.z - self.z) : Infinity;

  // 血量偏低（未到残血逃跑线）→ 优先免费回复技能，血瓶兜底
  if (st.hp !== undefined && st.maxHp && st.hp / st.maxHp < CFG.HP_USE_AT) {
    const hs = readyHealSkill(mp);
    if (hs) {
      castSkill(hs, 0, self.x, self.z);
      log(`💚 战斗中使用回复技能 ${hs.name}`);
    } else {
      const pot = potionOf('hp');
      if (pot && invCount(pot) > 0) {
        S_.net.sendUseItem(pot.id, 1);
        log('❤️ 使用血瓶');
      }
    }
  }

  // 进攻技能：冷却就绪 + 目标在施法距离内 + 蓝量够
  const skill = bestOffensiveSkill(mp, distToTarget);
  if (skill) {
    castSkill(skill, v ? v.wid : 0, v ? v.x : self.x, v ? v.z : self.z);
    log(`🔥 施放技能 ${skill.name}（伤害/减益，距离 ${Math.round(distToTarget)}m）`);
  }
  // 自身增益技能：冷却好了顺手补（战斗属性提升，减少受伤）
  const buff = readySelfBuffSkill(mp);
  if (buff && now - (S_._lastBuffAt || -1e9) > CFG.BUFF_REFRESH_MS) {
    castSkill(buff, 0, self.x, self.z);
    S_._lastBuffAt = now;
    log(`✨ 施放增益技能 ${buff.name}`);
  }
}

function stopCombat() {
  if (S_.attackWid) S_.stats.monstersKilled++;
  S_.attackWid = 0;
  S_._combatNoDmg = 0;
  S_._combatHpAt = 0;
  // 击杀后任务进度可能达成：置脏标记，下一轮刷新后立即检测完成并去提交
  S_.questDirty = true;
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

/** 子目标完成检测：任务目标进度已满（服务端 questProgress 权威），完成即结束子目标去提交 */
function goalComplete(g) {
  if (!g || g.questId === undefined || g.objIndex === undefined) return false;
  const gid = String(g.questId); // questId 数字/字符串归一化，防元数据与协议类型不一致
  const q = (S_.questProgress || []).find(x => String(x.questId ?? x.id) === gid);
  if (!q) return false;
  if (q.objectives && q.objectives[g.objIndex]) {
    const o = q.objectives[g.objIndex];
    return (o.current || 0) >= (o.required || 1);
  }
  // 兼容 {obj:["3/3"]} 字符串进度结构
  const s = q.obj && q.obj[g.objIndex];
  if (typeof s === 'string') {
    const [cur, req] = s.split('/').map(Number);
    return cur >= req;
  }
  return false;
}

/** 击杀目标怪：targetKey 匹配怪物类型（gamedata.monsters 的 key 与实体 name 关联） */
function pickKillTarget(key) {  const nameSet = new Set();
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

/** 掉落指定物品的怪物信息（数据驱动）：返回最低等级掉落怪的 { level, keys }；无掉落怪返回 null
 *  用途：collect 目标视野内无掉落怪时，按等级带估算怪区位置，主动前往而非乱打无收益怪 */
function dropMonsterInfo(itemId) {
  const mons = gamedataMonsters();
  let best = null;
  for (const m of mons) {
    if ((m.drops || []).some(d => Number(d.item) === Number(itemId))) {
      const lv = (m.level || 1) | 0;
      if (!best || lv < best.level) {
        best = { level: lv, key: m.key || '', name: m.name || '', keys: new Set([m.key, m.name].filter(Boolean)) };
      }
    }
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

/** 任意物品掉落（含任务物品/材料/金币袋，不再局限于当前任务目标） */
function nearestDropAny() {
  return nearestDrop(0);
}

/**
 * 全局拾取：范围内的掉落物直接拾取（任意状态顺手捡）；空闲且距离合适时前往拾取。
 * - allowGoto=false：仅捡脚边（PICKUP_RANGE 内），不 goto、不中断当前目标
 * - allowGoto=true ：允许走位前往拾取（仅限非战斗/非任务轮调用）
 * 返回 true 表示本决策轮已被拾取占用。
 */
function tryPickupNearby(self, allowGoto) {
  const S = S_.S;
  const drop = nearestDropAny();
  if (!drop) return false;
  const d = Math.hypot(drop.x - self.x, drop.z - self.z);
  const tries = S_._pickupTries.get(drop.wid) || 0;
  if (d <= CFG.PICKUP_RANGE) {
    S.input.clickTarget = null;
    S.net.sendPickup(drop.wid);
    S_._pickupTries.set(drop.wid, tries + 1);
    if (tries + 1 >= 6) {
      S.entities.views.delete(drop.wid); // 服务端无响应 → 本地剔除防死循环
      log(`⚠️ 掉落 wid=${drop.wid} 拾取无响应，本地剔除`);
    } else {
      log(`🎒 拾取 ${drop.name || '掉落'} wid=${drop.wid}`);
    }
    return true;
  }
  if (allowGoto && d <= CFG.PICKUP_GOTO_RANGE) {
    const r = goto(drop.x, drop.z, 'pick');
    if (!r.ok) {
      S.entities.views.delete(drop.wid); // 不可达（空洞隔开）→ 本地剔除
      S_._pickupTries.set(drop.wid, 99);
      log(`⚠️ 掉落 wid=${drop.wid} 不可达，本地剔除`);
    }
    return true;
  }
  return false;
}

/** 自动穿戴：背包中每个槽位评分更高的装备立即穿上（替代购买后异步 setTimeout 竞态） */
function autoEquipBest() {
  const S = S_.S;
  const bag = S.equipBag || [];
  if (!bag.length || !S.equip) return;
  for (let slot = 1; slot <= 6; slot++) {
    const cur = S.equip[slot];
    const curScore = cur && cur.itemId ? equipScore(itemDefById(cur.itemId)) * (1 + (cur.enhance || 0) * 0.15) : 0;
    let best = null, bestScore = -1;
    for (const ins of bag) {
      const d = itemDefById(ins.itemId);
      if (!d || slotNumber(d.slot) !== slot) continue;
      const sc = equipScore(d);
      if (sc > bestScore) { bestScore = sc; best = ins; }
    }
    if (best && bestScore > curScore + 0.5) {
      S.net.sendEquip(slot, best.instId);
      log(`⚔️ 自动穿戴 ${itemName(best.itemId)}（槽位 ${slot}）`);
    }
  }
}

/** 背包中是否有可继续强化的装备（未满级、未锁定） */
function hasEnhanceableGear() {
  const S = S_.S;
  const bag = S.equipBag || [];
  const enhCfg = S_.gamedata && S_.gamedata.enhance;
  if (!enhCfg || !enhCfg.levels || !enhCfg.levels.length) return false;
  for (const ins of bag) {
    if (ins.locked) continue;
    const lvl = ins.enhance || 0;
    if (enhCfg.levels[lvl]) return true;
  }
  return false;
}

/** 关闭 NPC 交互面板（商店/强化/合成/背包等，操作完成后调用，避免面板常驻遮挡） */
function closeNpcPanels() {
  if (S_.closeAllNpcPanels) {
    try { S_.closeAllNpcPanels(); } catch (_) { /* 面板已关闭/不存在时忽略 */ }
  }
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

// ---------------------------------------------------------------------------
// 生物投放数据查询（GET /api/spawns，数据驱动：视野内无目标时按投放坐标主动前往）
// ---------------------------------------------------------------------------
/** 确保投放数据可用（非阻塞拉取；120s 缓存）。返回是否已有可用数据 */
function ensureSpawns() {
  if (S_._spawnsLoading) return false;
  if (S_._spawns && performance.now() - S_._spawnsAt < 120000) return true;
  S_._spawnsLoading = true;
  fetch('/api/spawns').then(r => r.json()).then(d => {
    S_._spawns = Array.isArray(d && d.spawns) ? d.spawns : [];
    S_._spawnsAt = performance.now();
  }).catch(() => { S_._spawnsAt = 0; }).finally(() => { S_._spawnsLoading = false; });
  return !!(S_._spawns && performance.now() - S_._spawnsAt < 120000);
}

/** 指定怪物类型（key，'*'=全部）的投放坐标列表 */
function spawnPositions(typeKey) {
  if (!S_._spawns) return [];
  return S_._spawns
    .filter(s => s.kind === 'monster' && (typeKey === '*' || s.type === typeKey))
    .map(s => ({ x: s.x, z: s.z }));
}

/** 视野无目标时：查投放数据取最近可用投放点；无则返回 null
 *  typeKey：怪物 key 或 '*'（任意怪） */
function nearestSpawnPoint(typeKey) {
  const self = S_.S && S_.S.predictor ? S_.S.predictor.predicted() : null;
  const pts = spawnPositions(typeKey);
  if (!pts.length) return null;
  const now = performance.now();
  let best = null, bd = 1e9;
  for (const p of pts) {
    const key = p.x + ',' + p.z;
    if (S_._spawnSkip.has(key) && S_._spawnSkip.get(key) > now) continue;
    const d = self ? Math.hypot(self.x - p.x, self.z - p.z) : 0;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
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
  if (S.shopData && S.shopData.entries) {
    // S2C 实时条目补 shopId（当前商店 ID），供按商店匹配 NPC 使用
    const liveShopId = S.shopData.shopId || 0;
    return S.shopData.entries.map(e => ({ ...e, itemId: e.itemId !== undefined ? e.itemId : e.item, shopId: liveShopId }));
  }
  const d = S_.gamedata;
  if (!d || !d.shops) return [];
  const isArr = Array.isArray(d.shops);
  const shops = isArr ? d.shops : Object.values(d.shops);
  // shopId 来源：dict 场景 key 即 shopId（value 无 shopId 字段），数组场景取 sh.shopId
  const shopIds = isArr ? d.shops.map(s => (s.shopId || 0)) : Object.keys(d.shops).map(k => (parseInt(k, 10) || 0));
  const entries = [];
  shops.forEach((sh, idx) => {
    const shopId = sh.shopId || shopIds[idx] || 0;
    for (const e of (sh.entries || [])) {
      entries.push({ ...e, itemId: e.itemId !== undefined ? e.itemId : e.item, shopId });
    }
  });
  return entries;
}
/** 售卖某物品的商店 ID（实时 S2C 优先，静态表兜底；0=未关联商店） */
function shopIdForItem(itemId) {
  const e = shopEntries().find(x => x.itemId === itemId);
  return e ? (e.shopId || 0) : 0;
}
/** 找售卖指定物品的商店 NPC：优先 shopId 精确匹配，退化到任意商店 NPC（元数据驱动） */
function nearestShopNpc(itemId) {
  const S = S_.S;
  if (!S.predictor) return null;
  const self = S.predictor.predicted();
  const wantShopId = shopIdForItem(itemId);
  let best = null, bd = 1e9;
  for (const v of views().values()) {
    if (v.kind !== 'npc' || v.dying) continue;
    if (!v.npcTag || (v.npcTag & NPC_TAG_SHOP) === 0) continue;
    if (wantShopId && v.shopId && v.shopId !== wantShopId) continue; // shopId 明确不匹配则跳过
    const d = Math.hypot(v.x - self.x, v.z - self.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
/** 强化石物品 ID：优先取元数据 enhance.levels[0].stoneItemId，避免硬编码（兜底 4006 与默认配置一致） */
function enhanceStoneId() {
  const enh = S_.gamedata && S_.gamedata.enhance;
  if (enh && enh.levels && enh.levels.length && enh.levels[0].stoneItemId) return enh.levels[0].stoneItemId;
  return 4006;
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

/** 找可购买且更强的装备（等级满足、买得起、优于当前穿戴，选评分最高=当前能获取的最强） */
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

/** 可合成的最强装备：材料/金币/等级满足，且严格强于当前穿戴（元数据驱动，与购买互补） */
function bestCraftableGear(lv) {
  const S = S_.S;
  let best = null;
  for (const r of craftRecipes()) {
    const d = itemDefById(r.resultItemId);
    if (!d || d.type !== 'equip') continue;
    if (!craftableNow(r)) continue; // 材料 + 金币 + 等级 全部满足
    const slot = slotNumber(d.slot);
    if (!slot) continue;
    const cur = S.equip && S.equip[slot];
    const curScore = cur && cur.itemId ? equipScore(itemDefById(cur.itemId)) * (1 + (cur.enhance || 0) * 0.15) : 0;
    const newScore = equipScore(d);
    if (newScore > curScore + 0.5) {
      if (!best || newScore > best.score) best = { recipe: r, itemId: r.resultItemId, slot, score: newScore };
    }
  }
  return best;
}

/** 强化候选：优先当前已穿戴装备（提升实际战力），其次背包装备；强化石/金币足够 */
function pickEnhanceCandidate() {
  const S = S_.S;
  const enhCfg = S_.gamedata && S_.gamedata.enhance;
  if (!enhCfg || !enhCfg.levels || !enhCfg.levels.length) return null;
  // 已穿戴装备（6 槽）：优先强化当前战力，按评分降序（先强化最强装备）
  const worn = [];
  for (const slot of [1, 2, 3, 4, 5, 6]) {
    const e = S.equip && S.equip[slot];
    if (e && e.itemId && !e.locked) worn.push(e);
  }
  worn.sort((a, b) => (equipScore(itemDefById(b.itemId)) - equipScore(itemDefById(a.itemId))));
  // 背包装备：作为已穿戴的后备
  const bag = S.equipBag || [];
  const candidates = worn.concat(bag.filter(x => !x.locked));
  for (const ins of candidates) {
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
// 技能系统（数据驱动：已学技能 × gamedata 技能属性 → 冷却/距离/效果类型判定）
// ---------------------------------------------------------------------------
function skillDefById(id) {
  const skills = S_.gamedata && S_.gamedata.skills;
  if (!skills) return null;
  // /api/gamedata 的 skills 是 {skills:[...], starterSkills:[...]} 嵌套对象，本地 json 为数组，兼容两者
  const arr = Array.isArray(skills) ? skills : (Array.isArray(skills.skills) ? skills.skills : Object.values(skills));
  if (!Array.isArray(arr)) return null;
  return arr.find(s => s && s.id === id) || null;
}
/** 已学会的技能定义列表（learnedSkills 是服务端权威的已学技能 + 冷却） */
function learnedSkillDefs() {
  const learned = S_.S.learnedSkills || [];
  const out = [];
  for (const l of learned) {
    const d = skillDefById(l.id);
    if (d) out.push({ def: d, cdMs: l.cdMs || 0 });
  }
  return out;
}
/** 减益类型（与服务端 skills.h SkillDef::isDebuff 一致，元数据 buffType 判定） */
function isDebuffType(t) {
  return t === 'move_slow' || t === 'bleed' || t === 'def_down' || t === 'atk_down' || t === 'stun';
}
/** 技能功能效果分类：damage 伤害 / heal 回复 / debuff 减益 / buff 增益 / none */
function skillKind(s) {
  if (!s) return 'none';
  if ((s.heal || 0) > 0 || s.buffType === 'regen') return 'heal';          // 回复（瞬间治疗/持续回血）
  if ((s.dmgMul || 0) > 0 || (s.flatDmg || 0) > 0) return 'damage';        // 伤害
  if (s.buffType && s.buffType !== 'none' && (s.buffDur || s.buffDurSec || 0) > 0) {
    return isDebuffType(s.buffType) ? 'debuff' : 'buff';                   // 减益 / 增益
  }
  return 'none';
}
/** 技能冷却是否就绪：读服务端权威 cdMs（learnedSkills），并做 per-skill 本地节流 */
function skillReady(s) {
  const S = S_.S;
  const l = (S.learnedSkills || []).find(x => x.id === s.id);
  if (l && (l.cdMs || 0) > CFG.SKILL_CD_TOL_MS) return false;
  const lastAt = S_._skillAt[s.id] || -1e9; // 首次施放视为就绪
  const minGap = Math.max(s.cooldownMs || 3000, 2000);
  return performance.now() - lastAt >= minGap;
}
/** 施放技能并登记：本地节流；仅"移动打断"技能（cancelOnMove>0）锁走位等前摇，移动施法技能不站桩 */
function castSkill(s, targetWid, x, z) {
  const S = S_.S;
  S_.net.sendCastSkill(s.id, targetWid, x, z);
  S_._skillAt[s.id] = performance.now();
  if (s.cancelOnMove > 0) S_._castLockUntil = performance.now() + CFG.CAST_LOCK_MS;
}
/** 战斗技能候选评分：伤害口径（dmgMul×100+flatDmg，兼容旧 damage）+ 减益价值加权 */
function skillOffenseScore(s) {
  const dmg = s.damage !== undefined ? s.damage : (s.dmgMul || 0) * 100 + (s.flatDmg || 0);
  let score = dmg;
  if (isDebuffType(s.buffType)) score += (s.buffValue || 0) * 10; // 撕裂/迟缓等持续减益的价值
  return score;
}
/** 选最佳进攻技能（伤害/减益）：蓝量够、冷却就绪、目标在施法距离内（元数据 range 判定） */
function bestOffensiveSkill(mp, dist) {
  const S = S_.S;
  const learned = S.learnedSkills || [];
  if (!learned.length) return null;
  let best = null, bestScore = 0;
  for (const l of learned) {
    const s = skillDefById(l.id);
    if (!s) continue;
    if (s.id === 1000 || s.id >= 2000) continue; // 排除普攻与怪物技能
    const kind = skillKind(s);
    if (kind !== 'damage' && kind !== 'debuff') continue; // 只要伤害/减益
    const score = skillOffenseScore(s);
    if (score <= 0) continue;
    if ((s.mana || 0) > 0 && s.mana > mp) continue;                  // 蓝量不足不用（蓝耗 0 的技能不耗蓝可用）
    if (!skillReady(s)) continue;                                      // 冷却未就绪
    if (dist !== undefined) {
      const reach = Math.max(s.range || 5, CFG.ATK_RANGE);             // 施法距离元数据
      if (dist > reach) continue;                                      // 超施法距离不施放
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
/** 回复技能（瞬间治疗/持续回血）：冷却就绪且蓝够的第一个 */
function readyHealSkill(mp) {
  for (const l of (S_.S.learnedSkills || [])) {
    const s = skillDefById(l.id);
    if (!s) continue;
    if (skillKind(s) !== 'heal') continue;
    if ((s.mana || 0) > mp) continue;
    if (!skillReady(s)) continue;
    return s;
  }
  return null;
}
/** 自身增益技能（攻击/防御/移速等，非回复非减益）：冷却就绪的第一个 */
function readySelfBuffSkill(mp) {
  for (const l of (S_.S.learnedSkills || [])) {
    const s = skillDefById(l.id);
    if (!s) continue;
    if (skillKind(s) !== 'buff') continue;
    if ((s.mana || 0) > mp) continue;
    if (!skillReady(s)) continue;
    return s;
  }
  return null;
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
export function __testSetGamedata(gd) { S_.gamedata = gd || null; return !!S_.gamedata; }
export function __testDropMonsterInfo(itemId) { return dropMonsterInfo(itemId); }
export function __testSetSpawns(sp) { S_._spawns = sp || null; S_._spawnsAt = performance.now(); return !!S_._spawns; }
export function __testSpawnPositions(typeKey) { return spawnPositions(typeKey); }
export function __testNearestSpawnPoint(typeKey) { return nearestSpawnPoint(typeKey); }
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
