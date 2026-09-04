/**
 * EvolutionWorld 客户端入口
 * 流程：登录（HTTP）→ 建立 WebSocket → 进入 2D 世界 → 主循环
 */
// 客户端版本号 —— 每次部署前递增，用于确认线上版本
export const CLIENT_VERSION = '2026.0904.1';

import { NetworkClient } from './network.js';
import { InputState } from './input.js';
import { WebGLRenderer } from './canvas-renderer.js';
import { EntityViewManager } from './entities.js';
import { Predictor, PHYS, circleBlocked, escapeBlocked } from './predict.js';
import { ITEM_DEFS, itemDef, itemName, itemIcon, typeName, itemDesc, SLOT_NAME, skillDef, skillName, applyGameData, rarityColor, rarityName, itemRarity, enhanceConfig, enhanceLevelDef, enhanceMultiplier, decomposeConfig, decomposeRule, craftConfig, craftRecipes, craftRecipe, warehouseConfig, warehouseExpandCost } from './items.js';
import { EVT, NPC_TAG } from './protocol.js';
import { Reader } from './protocol.js';
import { loadEditCells, loadWalkMask, terrainHeight, terrainBlocked, terrainColor, terrainBlockedExact } from './terrain.js';
import { Minimap } from './minimap.js';
import { initQuestUI, decodeQuestList, decodeQuestProgress, decodeQuestResult, decodeQuestNotify, decodeQuestComplete, decodeQuestChain, toggleQuestPanel, sendQuestList, sendTalkNpc, sendQuestAccept, sendQuestTurnIn, getQuestList, getQuestProgress, setNpcFilter } from './quests.js';
import { initSocialUI, toggleFriendPanel, toggleGuildPanel, toggleChatFocus, isChatFocused,
  handleFriendRequest, handleFriendList, handleFriendStatus, handleFriendResult,
  handleGuildInfo, handleGuildResult, handleGuildNotify, handleGuildList, handleGuildApplyN,
  handleChatMsg, handleChatHistory, handleChatResult, addChatMessage } from './social.js';
// 登录态持久化：与世界编辑器（editor.js）共用同一份 localStorage 会话
import { clearSession } from './session.js';
import { initLogin, hideLogin, showLogin, showLoading, setLoadingText } from './login.js';

const $ = (id) => document.getElementById(id);
const hud = $('hud');
const net = new NetworkClient();

// 全局错误展示（便于排查与用户反馈）
window.addEventListener('error', (e) => {
  setLoadingText('客户端错误：' + (e.message || 'unknown'));
  try {
    const st = (e.error && e.error.stack || '').split('\n');
    protocolLog('ERR', { msg: e.message || 'unknown', at: st[1] ? st[1].trim() : '' });
  } catch (_) {}
  console.error(e.error || e);
});
window.addEventListener('unhandledrejection', (e) => {
  setLoadingText('客户端错误：' + (e.reason?.message || e.reason));
  console.error(e.reason);
});

let renderer = null;
let entities = null;
let input = null;
let predictor = null;
let running = false;
let lastT = 0;
let fpsAcc = 0;
let fpsCount = 0;
let inputAcc = 0;
let bossStates = new Map(); // wid -> 世界Boss共享状态（S2C_BOSS 最新）
let bossDisplay = null;     // HUD 顶栏展示的 Boss
let minimap = null;         // 右上角小地图罗盘
// 物品系统状态（服务端权威，S2C_INVENTORY/S2C_STATS 刷新）
let playerStats = { maxHp: 100, maxMp: 50, attack: 12, defense: 3, hp: 100, mp: 50, level: 1, exp: 0, expToNext: 100 };
let inventory = {};   // itemId -> 数量（堆叠物品：消耗品/材料/任务道具）
let equip = {};       // 槽位值 -> {instId, itemId, enhance}（已穿戴装备实例）
let equipBag = [];    // [{instId, itemId, enhance, locked}]（背包装备实例）
let gold = 0;
let shopData = null;  // {shopId, name, desc, shopType, currencyItemId, entries[]}
let shopCategory = 0; // 商店当前分类页签（0=全部 1装备 2消耗品 3材料 4特殊）
let toastTimer = null;
// 技能系统状态（服务端权威，S2C_SKILLS/S2C_BUFFS 刷新）
let learnedSkills = [];   // [{id, cdMs}] 已学技能 + 剩余冷却（ms）
let myBuffs = [];         // [{skillId, type, value, remainSec}]
let skillCastFeedback = null; // 最近一次技能施放反馈（用于日志/提示）
let _skillDirty = true;  // 技能栏 DOM 重建脏标记
let _buffDirty = true;   // Buff 栏 DOM 重建脏标记
let _lastCdTick = 0;     // 上次冷却文本轻量刷新时间
// 玩家死亡/复活状态（服务端权威，EVT_DEATH/EVT_RESPAWN 驱动）
let selfDead = false;
let deathAtMs = 0;
const PLAYER_RESPAWN_SEC = 8; // 与服务端 config.h playerRespawnSec 一致
// 技能栏展示映射：slot(1-8) -> skillId（按技能 ID 升序填槽）
let skillBar = [];        // skillId 数组（与技能栏 UI 顺序一致）
// NPC 交互状态
let currentNpcWid = 0;
let currentNpcName = '';
let currentNpcTag = 0;   // 当前交互 NPC 的标签位标志（据此决定对话选项：商店/铁匠/仓库…）
let npcDialogOpen = false;
// 强化面板状态（阶段2）：当前选中装备实例 + 保护符勾选
let enhanceTargetInstId = 0;   // 选中待强化的装备实例 ID（0=未选）
let enhanceUseProtect = false; // 是否使用保护符（失败防降级）
let smithTab = 'enhance';      // 铁匠面板当前页签：'enhance' 强化 / 'decompose' 分解
let decomposeTargetInstId = 0; // 选中待分解的装备实例 ID（0=未选）
// 合成面板状态（阶段4）：服务端按 NPC 标签+等级过滤后的可用配方 ID 列表 + 选中配方 + 批量数
let craftListIds = [];         // 可用配方 recipeId 列表（S2C_CRAFT_LIST）
let craftTargetRecipeId = 0;   // 选中待合成的配方 ID（0=未选）
let craftCount = 1;            // 批量合成数量（仅堆叠产出可批量；装备恒为 1）
let craftNpcWid = 0;           // 当前合成 NPC 的 wid（请求配方列表用）
// 仓库面板状态（阶段5）：服务端全量仓库数据 + 当前页 + NPC wid
let warehouseData = null;      // {gold, unlocked, slots:[{isInstance, instId, itemId, enhance, locked, count}]}
let warehousePage = 0;         // 当前页（0-based；页大小=slotsPerPage）
let warehouseNpcWid = 0;       // 当前仓库 NPC 的 wid（打开/操作用）
// 技能槽位 → 热键标签（与 input.js 的 16 槽映射一致）
function SKILL_KEY_LABEL(slot) {
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
// 渲染器物品名映射（canvas-renderer.js 读取）
window.__itemNames = {};
for (const [id, d] of Object.entries(ITEM_DEFS)) window.__itemNames[id] = d.name;

// ---------------- 地形数据同步 ----------------

// 重拉进行中标记：防止并发 fetch 交错安装（mask 与编辑层来自不同时刻的响应会互相不一致）
let _terrainReloading = false;

/**
 * 重新拉取并安装服务端地形数据（可通行 mask + 编辑层）。
 * 两处调用：① 连接建立后首次加载；② 收到 S2C_TERRAIN_DIRTY（服务端保存编辑层或重执行
 * 世界初始化后广播）。后者必不可少 —— 客户端 terrainBlockedExact 与服务端同源，地形变更
 * 而客户端不同步就会出现「客户端放行、服务端拒绝」→ terrain_blocked 软失败 → 橡皮筋，
 * 或玩家站在新挖空的格子里被反复校正。
 */
async function reloadTerrain() {
  if (_terrainReloading) return;
  _terrainReloading = true;
  let changed = false;
  try {
    // 可通行 mask（世界初始化执行器产物；客户端不程序化生成，与服务端同源）。
    // 必须在任何 terrainBlocked/预测/渲染前安装，否则未加载时全图视为空洞。
    try {
      const mr = await fetch('/api/terrain/mask');
      const mj = await mr.json();
      console.log('[Terrain] mask response:', mj ? `ok=${mj.ok}, n=${mj.n}, off=${mj.off}, b64len=${mj.b64 ? mj.b64.length : 0}` : 'null');
      if (mj && mj.ok && loadWalkMask(mj)) { changed = true; console.log('[Terrain] mask loaded successfully'); }
      else console.warn('[Terrain] mask load failed or invalid');
    } catch (e) { console.warn('[Terrain] mask fetch error:', e.message); }
    // 地形编辑层（地形编辑器产物；客户端/服务端同源，保证预测与碰撞一致）
    try {
      const r = await fetch('/api/terrain/edit');
      const j = await r.json();
      if (j && j.ok) { loadEditCells(j.cells); changed = true; }
    } catch (_) {}
    if (!changed) return;
    // 视觉失效：小地图重绘 + 地形网格重建。
    //（loadWalkMask/loadEditCells 内部已清 terrain.js 的高度/阻挡缓存）
    if (minimap) minimap.invalidate();
    if (renderer) renderer.invalidateTerrain();
    // 自身可能已落在新的阻挡区（编辑器把脚下的格子挖空了）：主动脱困，而不是等服务端
    // correction —— 后者要先累积若干次 terrain_blocked 软失败才把人拉出来。
    // escapeBlocked 与服务端 Collision::escapeBlocked 同构（8 向 × 5 环 × 0.2m，最大 1.0m），
    // 位移远在 teleportToleranceM(5m) 之内，下一次上报会被服务端正常采纳为权威位置。
    // 注：不必手动同步 entities/net.setRef —— 主循环每帧从 predictor 重算二者。
    if (predictor) {
      const p = predictor.predicted();
      if (circleBlocked(p.x, p.z, PHYS.RADIUS, true)) {
        const esc = escapeBlocked(p.x, p.z, PHYS.RADIUS, true);
        if (esc) {
          const y = terrainHeight(esc.x, esc.z) + PHYS.RADIUS;
          predictor.correction(esc.x, y, esc.z);
          console.warn('[terrain] 地形变更后自身处于阻挡区，已脱困至',
            esc.x.toFixed(2), esc.z.toFixed(2));
        } else {
          console.warn('[terrain] 地形变更后自身处于阻挡区，1m 内无可通行落点，等待服务端校正');
        }
      }
    }
  } finally {
    _terrainReloading = false;
  }
}

// ---------------- 登录 UI ----------------

// 初始化共享登录模态框（动态创建 DOM + 会话检查）
// 登录/注册由 login.js 统一处理，成功后调用 onLoggedIn 进入世界
initLogin({
  subtitle: '无缝世界 · 固定俯视角大型MMO · 空壳网络游戏服务端',
  hint: '登录后将以 <b>橙色球体</b> 进入无缝世界（固定俯视角）<br/>绿色=其他玩家 · 红色=怪物 · 蓝色=NPC<br/><a href="./editor.html" target="_blank">🛠 地形编辑器（画刷调整地图）</a>',
  showRegister: true,
  onLoggedIn: async (token, username) => {
    try {
      await enterWorld(token, username, null);
    } catch (e) {
      clearSession();
      showLogin('会话已过期，请重新登录');
    }
  },
});

// ---------------- 进入世界 ----------------

async function enterWorld(token, username, worldMeta) {
  console.log(`%c[EvolutionWorld] client v${CLIENT_VERSION}`, 'color:#c9a84c;font-weight:bold;font-size:14px');
  showLoading('连接世界中…');

  try {
    // 先挂回调，再建立连接（welcome 可能立刻到达）
    net.onHello = (msg) => {
      hud.classList.remove('hidden');
      const verEl = $('hud-version');
      if (verEl) verEl.textContent = 'v' + CLIENT_VERSION;
      $('hud-user').textContent = net.selfName;
      $('hud-conn').textContent = '已连接';
      $('hud-conn').className = 'hud-status-chip on';
    };
    net.onDisconnect = () => {
      $('hud-conn').textContent = '连接断开';
      $('hud-conn').className = 'hud-status-chip off';
    };
    // 服务端地形变更通知：重拉 mask + 编辑层（不 await，函数内部已全路径容错）
    net.onTerrainDirty = () => {
      reloadTerrain().catch((e) => console.warn('[terrain] 重拉失败:', e));
    };
    await net.connect(token);
    // 加载服务器地形数据（可通行 mask + 编辑层）；运行时变更由上方 onTerrainDirty 触发重拉
    await reloadTerrain();
    // 加载服务器游戏数据（物品/生物配置；替换静态镜像，支持编辑器热更新）
    try {
      const gr = await fetch('/api/gamedata');
      const gj = await gr.json();
      if (gj && gj.ok) applyGameData(gj);
    } catch (_) {}
  } catch (e) {
    showLogin('连接失败：' + e.message);
    return;
  }

  // 等待 hello（拿到 selfWid 与世界参数），超时 5 秒视为 token 无效
  if (!net.hello) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        net.onHello = null;
        reject(new Error('服务器未响应'));
      }, 5000);
      const old = net.onHello;
      net.onHello = (msg) => {
        clearTimeout(timer);
        old && old(msg);
        resolve();
      };
    });
  }
  setLoadingText('初始化渲染器…');

  // 初始化 3D
  try {
    renderer = new WebGLRenderer($('app'));
  } catch (e) {
    setLoadingText('渲染器错误：' + (e && e.message ? e.message : e));
    console.error(e);
    throw e;
  }
  // 初始化小地图（右上角罗盘）
  try {
    minimap = new Minimap('minimap');
  } catch (e) {
    console.warn('小地图初始化失败:', e);
  }
  setLoadingText('创建实体管理器…');
  try {
    entities = new EntityViewManager(net.selfWid);
  } catch (e) {
    setLoadingText('实体管理器错误：' + (e && e.message ? e.message : e));
    console.error(e);
    throw e;
  }
  window.__ewEntities = entities; // 测试/调试钩子
  window.__ewMinimap = minimap;   // 小地图调试钩子
  input = new InputState(renderer.canvas);
  input.setRenderer(renderer);
  window.__ewInput = input;
  // 本地预测器：从 hello 位置起步
  predictor = new Predictor();
  if (net.hello && net.hello.self) {
    predictor.setPosition(net.hello.self.x, net.hello.self.y, net.hello.self.z);
    entities.setSelf(net.hello.self.x, net.hello.self.y, net.hello.self.z);
  }
  window.__ewPredictor = predictor; // 测试/调试钩子
  window.__ewFx = () => renderer.fxSnapshot(); // 测试/调试钩子：技能效果快照
  setLoadingText('接收世界数据…');

  // 二进制协议：AOI 进出 + 增量 + 校准快照 + 预测回退
  net.onEnter = (ents) => entities.applyEnter(ents);
  net.onLeave = (wids) => entities.applyLeave(wids);
  net.onUpdate = (ups) => entities.applyUpdate(ups);
  net.onSnapshot = (snap) => entities.applySnapshot(snap.entities);

  // 世界 Boss 全局共享状态（S2C_BOSS）：更新渲染 + HUD 顶栏；位置作为另一路权威校正（走确定性外推）
  net.onBoss = (b) => {
    bossStates.set(b.wid, b);
    updateBossHud();
    entities.applyBossPos(b.wid, b.x, b.y, b.z);
  };
  // 世界共享事件（S2C_EVENT）：伤害/死亡/复活/技能
  net.onEvent = (ev) => {
    // 死亡：自身 → 死亡遮罩 + 输入门控；其他实体 → 死亡动画（淡出+下沉）
    if (ev.evtType === EVT.DEATH) {
      if (ev.wid === net.selfWid) {
        selfDead = true;
        deathAtMs = performance.now();
        const de = $('death-overlay');
        if (de) de.classList.remove('hidden');
        $('hud-conn').textContent = '你被击倒了';
        $('hud-conn').className = 'hud-status-chip warn';
      } else if (entities) {
        entities.applyDeath(ev.wid);
      }
    } else if (ev.evtType === EVT.RESPAWN) {
      if (ev.wid === net.selfWid) {
        selfDead = false;
        deathAtMs = 0;
        const de = $('death-overlay');
        if (de) de.classList.add('hidden');
        $('hud-conn').textContent = '已连接';
        $('hud-conn').className = 'hud-status-chip on';
        toast('你已复活', 'ok');
      } else if (entities) {
        entities.applyRespawn(ev.wid);
      }
    }
    // 技能简易效果（前摇圈 / AOE 范围圈 / 打断闪红）
    if (ev.evtType === EVT.SKILL_CASTING) {
      const sd = skillDef(ev.b);
      // 按释放者类型决定颜色：怪物红色、当前玩家橙色、其他玩家绿色
      const casterEnt = findEntityByWid(ev.wid);
      let casterColor = sd.color;
      if (ev.wid === net.selfWid) casterColor = '#ff8c1a';
      else if (casterEnt && casterEnt.kind === 'monster') casterColor = '#f87171';
      else if (casterEnt && casterEnt.kind === 'player') casterColor = '#34d399';
      renderer.addSkillEffect({
        kind: 'cast', wid: ev.wid, casterWid: ev.wid,
        x: ev.x, z: ev.z,
        color: casterColor, radius: sd.radius || 0,
        durMs: Math.max(200, sd.castMs),
      });
    } else if (ev.evtType === EVT.SKILL_CANCEL) {
      renderer.clearCasting(ev.wid);
      // 打断闪红（定位施法者当前位置）
      const ent = findEntityByWid(ev.wid);
      if (ent) {
        renderer.addSkillEffect({ kind: 'cancel', wid: ev.wid, x: ent.x, z: ent.z, durMs: 260 });
      }
    } else if (ev.evtType === EVT.SKILL) {
      const sd = skillDef(ev.b);
      if (sd.radius > 0) { // 仅 AOE 画范围圈（结算落点）
        renderer.addSkillEffect({ kind: 'aoe', x: ev.x, z: ev.z, radius: sd.radius, color: sd.color, durMs: 900 });
      }
    }
  };

  // 物品系统：背包/装备/金币（服务端权威全量）
  net.onInventory = (msg) => {
    inventory = msg.inventory;
    equip = msg.equip;
    equipBag = msg.equipBag || [];
    gold = msg.gold;
    renderInventory();
    renderEquip();
    renderHud();
    // 铁匠面板开启时同步刷新（强化/分解后等级/消耗/金币/背包随之变化）
    const ep = $('enhance-panel');
    if (ep && !ep.classList.contains('hidden')) {
      if (smithTab === 'decompose') { renderDecomposeList(); renderDecomposeDetail(); }
      else { renderEnhanceList(); renderEnhanceDetail(); }
    }
    // 合成面板开启时同步刷新（材料/金币/产出随之变化）
    const cp = $('craft-panel');
    if (cp && !cp.classList.contains('hidden')) { renderCraftList(); renderCraftDetail(); }
    // 仓库面板开启时同步刷新（存入/取出/存金后背包与金币随之变化）
    const wp = $('warehouse-panel');
    if (wp && !wp.classList.contains('hidden')) { renderWarehouseBag(); renderWarehouseGold(); renderWarehouseFooter(); }
  };
  // 自身属性：血量/蓝量/攻击/防御
  net.onStats = (msg) => {
    playerStats = msg;
    renderHud();
  };
  // 商店列表（首次打开显示面板；购买回执重发时保持当前分类/滚动）
  net.onShop = (msg) => {
    if (!shopData || shopData.shopId !== msg.shopId) shopCategory = 0;  // 切换商店时重置分类页签
    shopData = msg;
    openShopPanel();
  };
  // 拾取反馈
  net.onLoot = (msg) => {
    if (msg.ok) toast('拾取成功', 'ok');
    else toast('拾取失败');
  };
  // 出售回收反馈（S2C_SELL_RESULT）
  net.onSellResult = (msg) => {
    if (msg.ok) toast(`出售成功 +${msg.goldGain}💰`, 'ok');
    else toast('无法出售（需在商店且有回收价）');
  };
  // 装备强化结果（S2C_ENHANCE）
  net.onEnhance = (msg) => handleEnhanceResult(msg);
  // 装备分解结果（S2C_DECOMPOSE）
  net.onDecompose = (msg) => handleDecomposeResult(msg);
  // 合成配方列表（S2C_CRAFT_LIST）+ 合成结果（S2C_CRAFT）
  net.onCraftList = (msg) => handleCraftList(msg);
  net.onCraft = (msg) => handleCraftResult(msg);
  // 仓库全量数据（S2C_WAREHOUSE）+ 仓库操作结果（S2C_WAREHOUSE_RESULT）
  net.onWarehouse = (msg) => handleWarehouse(msg);
  net.onWarehouseResult = (msg) => handleWarehouseResult(msg);

  // 技能系统：已学技能 + 冷却（服务端权威）
  net.onSkills = (msg) => {
    learnedSkills = msg.skills;
    skillBar = msg.skills.map((s) => s.id).sort((a, b) => a - b);
    _skillDirty = true;
  };
  // 技能施放反馈
  net.onSkillCast = (msg) => {
    skillCastFeedback = msg;
    const sd = skillDef(msg.skillId);
    if (msg.ok) {
      toast(`释放【${sd.name}】`, 'ok');
      // 有前摇：本地立即画自身前摇圈（服务器 EVT_SKILL_CASTING 随后到达，同 wid 去重）
      if (msg.castTimeMs > 0) {
        renderer.addSkillEffect({
          kind: 'cast', wid: net.selfWid, casterWid: net.selfWid,
          x: msg.x, z: msg.z,
          color: '#ff8c1a', radius: sd.radius || 0,
          durMs: msg.castTimeMs,
        });
      }
    } else {
      toast(`【${sd.name}】施放失败（冷却/蓝量/距离）`);
    }
    renderSkillBar(); _skillDirty = false;
  };
  // 自身 Buff 列表
  net.onBuffs = (msg) => {
    myBuffs = msg.buffs;
    _buffDirty = true;
  };
  // 控制台结果（S2C_CONSOLE）：展示到右下角日志区
  net.onConsole = (msg) => {
    protocolLog('s2c', { type: 'CONSOLE', text: msg.text });
  };

  // 任务系统：S2C_QUEST_* 回调（payload 为原始 Uint8Array，由 quests.js 解码）
  net.onQuestList = (payload) => { decodeQuestList(new Reader(payload)); if (npcDialogOpen) refreshNpcDialog(); };
  net.onQuestProgress = (payload) => { decodeQuestProgress(new Reader(payload)); if (npcDialogOpen) refreshNpcDialog(); };
  net.onQuestResult = (payload) => decodeQuestResult(new Reader(payload));
  net.onQuestComplete = (payload) => decodeQuestComplete(new Reader(payload));
  net.onQuestNotify = (payload) => decodeQuestNotify(new Reader(payload));
  net.onQuestChain = (payload) => {
    decodeQuestChain(new Reader(payload));
    // 链式解锁后刷新 NPC 对话框（可能有新任务可接）
    if (npcDialogOpen) {
      sendQuestList(net, currentNpcWid);
      setTimeout(refreshNpcDialog, 200);
    }
  };
  // 初始化任务 UI（tab 切换 + 关闭按钮 + 全局回调）
  initQuestUI(net);

  // ---- 社交系统回调接入 ----
  net.onFriendRequest = (msg) => handleFriendRequest(msg);
  net.onFriendList = (msg) => handleFriendList(msg);
  net.onFriendStatus = (msg) => handleFriendStatus(msg);
  net.onFriendResult = (msg) => handleFriendResult(msg);
  net.onGuildInfo = (msg) => handleGuildInfo(msg);
  net.onGuildResult = (msg) => handleGuildResult(msg);
  net.onGuildNotify = (msg) => handleGuildNotify(msg);
  net.onGuildList = (msg) => handleGuildList(msg);
  net.onGuildApplyN = (msg) => handleGuildApplyN(msg);
  net.onChatMsg = (msg) => handleChatMsg(msg);
  net.onChatHistory = (msg) => handleChatHistory(msg);
  net.onChatResult = (msg) => handleChatResult(msg);
  // 初始化社交 UI（聊天栏 + 好友/公会面板事件绑定）
  initSocialUI(net);

  net.onSelf = (msg) => {
    // 服务端后校验不通过 → 回退到权威位置
    predictor.correction(msg.x, msg.y, msg.z);
    entities.setSelf(msg.x, msg.y, msg.z);
    console.warn('[prediction] 服务端回退:', msg.reason, msg.x.toFixed(2), msg.y.toFixed(2), msg.z.toFixed(2));
  };

  net.onKick = (msg) => {
    $('hud-conn').textContent = '已断开（' + (msg.reason || '违规') + '）';
    $('hud-conn').className = 'hud-status-chip off';
    running = false;
    net.close();
  };
  // 协议透传转换：把每次二进制帧解码结果实时投递到监控面板
  net.onProtocol = (dir, msg) => protocolLog(dir, msg);
  net.onBytes = (n) => {
    window.__ewBytes = (window.__ewBytes || 0) + n;
  };

  setLoadingText('进入世界…');
  hideLogin();
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
}
// ---------------- 协议透传转换监控（二进制 ↔ 可读对象 实时解码展示） ----------------
function protocolLog(dir, msg) {
  const box = $('proto-log');
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
    case 'BOSS': detail = `wid=${msg.wid} ${msg.name} hp=${Math.round(msg.hp)}/${Math.round(msg.maxHp)} state=${msg.state} phase=${msg.phase} target=${msg.target}`; break;
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
    // 社交系统
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
// 供测试/调试挂载协议监控（渲染启动后设置）
window.__ewProtocolLog = protocolLog;

// ---------------- 物品系统 UI（背包/装备/商店/属性） ----------------
function toast(text, cls) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 1800);
}
function renderHud() {
  const hpPct = playerStats.maxHp ? Math.max(0, Math.min(100, (playerStats.hp / playerStats.maxHp) * 100)) : 0;
  const mpPct = playerStats.maxMp ? Math.max(0, Math.min(100, (playerStats.mp / playerStats.maxMp) * 100)) : 0;
  const hf = $('hp-fill'), mf = $('mp-fill');
  if (hf) { hf.style.width = hpPct + '%'; $('hp-text').textContent = `${Math.round(playerStats.hp)}/${Math.round(playerStats.maxHp)}`; }
  if (mf) { mf.style.width = mpPct + '%'; $('mp-text').textContent = `${Math.round(playerStats.mp)}/${Math.round(playerStats.maxMp)}`; }
  const g = $('hud-gold');
  if (g) g.textContent = gold;
  const sa = $('stat-attack'), sd = $('stat-defense');
  if (sa) sa.textContent = Math.round(playerStats.attack);
  if (sd) sd.textContent = Math.round(playerStats.defense);
  // 等级 + 经验条（S2C_STATS 携带 level/exp/expToNext）
  const lv = $('hud-level');
  if (lv) lv.textContent = playerStats.level || 1;
  const ef = $('exp-fill');
  if (ef) {
    const need = playerStats.expToNext || 0;
    const pct = need > 0 ? Math.max(0, Math.min(100, ((playerStats.exp || 0) / need) * 100)) : 0;
    ef.style.width = pct + '%';
    const et = $('exp-text');
    if (et) et.textContent = `${Math.round(playerStats.exp || 0)}/${Math.round(need)}`;
  }
}
function isShopNpc(e) { return e.kind === 'npc' && ((e.npcTag || 0) & NPC_TAG.SHOP) !== 0; }
function findNearbyNpc(px, pz, range) {
  let best = null, bestD = range;
  for (const e of entities.forRender()) {
    if (e.kind !== 'npc') continue;
    const d = Math.hypot(e.x - px, e.z - pz);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
function nearbyDrops(px, pz, range) {
  const out = [];
  for (const e of entities.forRender()) {
    if (e.kind !== 'item') continue;
    if (Math.hypot(e.x - px, e.z - pz) <= range) out.push(e);
  }
  return out;
}
function autoPickup(px, pz, range) {
  if (!entities || !net) return;
  for (const e of nearbyDrops(px, pz, range)) net.sendPickup(e.wid);
}
function pickupNearbyDrops(px, pz, range) {
  const drops = nearbyDrops(px, pz, range);
  if (!drops.length) { toast('附近没有可拾取的掉落物'); return; }
  for (const e of drops) net.sendPickup(e.wid);
}
function toggleInventoryPanel() {
  const p = $('inventory-panel');
  if (!p) return;
  const hidden = p.classList.contains('hidden');
  p.classList.toggle('hidden', !hidden);
  if (!hidden) { closeShopPanel(); }
  if (p.classList.contains('hidden') === false) renderInventory();
}
// 商店分类：0自动(按物品类型) 1装备 2消耗品 3材料 4特殊
const SHOP_CAT_NAME = { 1: '装备', 2: '消耗品', 3: '材料', 4: '特殊' };
// 计算条目的有效分类：显式 category>0 优先，否则按物品类型自动归类
function entryCat(e) {
  if (e.category > 0) return e.category;
  const t = itemDef(e.itemId).type;
  if (t === 'equip') return 1;
  if (t === 'consumable') return 2;
  if (t === 'material') return 3;
  return 4;
}
function openShopPanel() {
  if (!shopData) return;
  const p = $('shop-panel');
  if (!p) return;
  closeInventoryPanel();
  p.classList.remove('hidden');
  $('shop-title').textContent = shopData.name || '商店';
  renderShopTabs();
  renderShopList();
}
// 分类页签：全部 + 有商品的分类（切换时重渲染列表）
function renderShopTabs() {
  const bar = $('shop-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const counts = {};
  for (const e of shopData.entries) { const c = entryCat(e); counts[c] = (counts[c] || 0) + 1; }
  if (shopCategory !== 0 && !counts[shopCategory]) shopCategory = 0;  // 选中分类已空则回退全部
  const cats = [0, 1, 2, 3, 4].filter((c) => c === 0 || counts[c]);
  for (const c of cats) {
    const btn = document.createElement('button');
    btn.className = 'shop-tab' + (c === shopCategory ? ' active' : '');
    const n = c === 0 ? shopData.entries.length : counts[c];
    btn.textContent = `${c === 0 ? '全部' : SHOP_CAT_NAME[c]} ${n}`;
    btn.addEventListener('click', () => { shopCategory = c; renderShopTabs(); renderShopList(); });
    bar.appendChild(btn);
  }
}
// 商品列表：折扣划线 + 限购进度 + 有效价购买（保留滚动位置，供购买回执重渲染）
function renderShopList() {
  const list = $('shop-list');
  if (!list) return;
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  let shown = 0;
  for (const e of shopData.entries) {
    if (shopCategory !== 0 && entryCat(e) !== shopCategory) continue;
    shown++;
    const d = itemDef(e.itemId);
    const rc = rarityColor(e.itemId);
    // 折扣：discountPrice>0 且 <price 时划线原价，结算用折扣价
    const hasDiscount = e.discountPrice > 0 && e.discountPrice < e.price;
    const unit = hasDiscount ? e.discountPrice : e.price;
    const priceHtml = hasDiscount
      ? `<span class="price-old">${e.price}💰</span><span class="price-new">${e.discountPrice}💰</span>`
      : `<span class="price-new">${e.price}💰</span>`;
    // 限购：buyLimit>0 显示“已购/上限” + 刷新周期；达上限置灰禁买
    const soldOut = e.buyLimit > 0 && (e.bought || 0) >= e.buyLimit;
    let limitHtml = '';
    if (e.buyLimit > 0) {
      const rf = e.refreshType === 1 ? '/日' : e.refreshType === 2 ? '/周' : '';
      limitHtml = `<span class="limit-badge${soldOut ? ' limit-max' : ''}">限购 ${e.bought || 0}/${e.buyLimit}${rf}</span>`;
    }
    const row = document.createElement('div');
    row.className = 'shop-item';
    row.innerHTML =
      `<span class="item-icon">${d.icon}</span>
       <span class="item-name" style="color:${rc}">${d.name}</span>
       <span class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}</span>
       <span class="item-desc">${itemDesc(e.itemId)}${limitHtml}</span>
       <span class="item-buy">${priceHtml}<button class="buy-btn"${soldOut ? ' disabled' : ''}>${soldOut ? '已达上限' : '购买'}</button></span>`;
    const btn = row.querySelector('.buy-btn');
    if (btn && !soldOut) {
      btn.addEventListener('click', () => {
        if (gold < unit) { toast('金币不足'); return; }
        net.sendShopBuy(e.itemId, 1);
      });
    }
    list.appendChild(row);
  }
  if (!shown) list.innerHTML = '<div class="shop-empty">该分类暂无商品</div>';
  list.scrollTop = keepScroll;
}
function closeShopPanel() { const p = $('shop-panel'); if (p) p.classList.add('hidden'); }
function closeInventoryPanel() { const p = $('inventory-panel'); if (p) p.classList.add('hidden'); }

// ---------------- 装备强化面板（阶段2） ----------------
// 强化失败码 → 文案（与服务端 world.cpp/enhance.cpp failCode 对齐；6=不在铁匠附近）
const ENHANCE_FAIL_TEXT = {
  1: '已达最高强化等级',
  2: '金币不足',
  3: '强化石不足',
  4: '保护符不足',
  6: '需在铁匠附近才能强化',
  7: '装备无效或不存在',
};
// 汇总所有可强化装备：已穿戴（equip 槽位）+ 背包（equipBag）
function collectEnhanceItems() {
  const out = [];
  for (let slot = 1; slot <= 6; slot++) {
    const ins = equip[slot];
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, where: '已穿戴' });
  }
  for (const ins of equipBag) {
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, where: '背包' });
  }
  return out;
}
// 按实例 ID 查找装备（跨已穿戴 + 背包）
function findEnhanceInstance(instId) {
  if (!instId) return null;
  for (let slot = 1; slot <= 6; slot++) {
    const ins = equip[slot];
    if (ins && ins.instId === instId) return ins;
  }
  for (const ins of equipBag) {
    if (ins && ins.instId === instId) return ins;
  }
  return null;
}
function openEnhancePanel() {
  const p = $('enhance-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeCraftPanel();
  closeWarehousePanel();
  p.classList.remove('hidden');
  smithTab = 'enhance';   // 铁匠面板默认打开「强化」页签
  // 默认选中第一件可强化装备（原选中已失效时）
  if (!findEnhanceInstance(enhanceTargetInstId)) {
    const items = collectEnhanceItems();
    enhanceTargetInstId = items.length ? items[0].instId : 0;
    enhanceUseProtect = false;
  }
  applySmithTab();
  renderEnhanceList();
  renderEnhanceDetail();
}
function closeEnhancePanel() { const p = $('enhance-panel'); if (p) p.classList.add('hidden'); }
// 铁匠面板页签切换（强化 / 分解）：切换视觉 + 初始化该页签选中项 + 渲染
function switchSmithTab(tab) {
  smithTab = tab;
  applySmithTab();
  if (tab === 'decompose') {
    if (!findDecomposeInstance(decomposeTargetInstId)) {
      const items = collectDecomposeItems();
      decomposeTargetInstId = items.length ? items[0].instId : 0;
    }
    renderDecomposeList();
    renderDecomposeDetail();
  } else {
    if (!findEnhanceInstance(enhanceTargetInstId)) {
      const items = collectEnhanceItems();
      enhanceTargetInstId = items.length ? items[0].instId : 0;
      enhanceUseProtect = false;
    }
    renderEnhanceList();
    renderEnhanceDetail();
  }
}
// 应用页签视觉状态（active 类 + 对应 body 显隐）
function applySmithTab() {
  const te = $('smith-tab-enhance'), td = $('smith-tab-decompose');
  const be = $('enhance-body'), bd = $('decompose-body');
  if (te) te.classList.toggle('active', smithTab === 'enhance');
  if (td) td.classList.toggle('active', smithTab === 'decompose');
  if (be) be.classList.toggle('hidden', smithTab !== 'enhance');
  if (bd) bd.classList.toggle('hidden', smithTab !== 'decompose');
}
function selectEnhanceTarget(instId) {
  enhanceTargetInstId = instId;
  enhanceUseProtect = false; // 切换目标重置保护符勾选
  renderEnhanceList();
  renderEnhanceDetail();
}
// 左侧：可强化装备列表（点击选中）
function renderEnhanceList() {
  const list = $('enhance-list');
  if (!list) return;
  list.innerHTML = '';
  const items = collectEnhanceItems();
  if (!items.length) {
    list.innerHTML = '<div class="enhance-hint">没有可强化的装备<br>（击败怪物或商店购买获取）</div>';
    return;
  }
  for (const it of items) {
    const d = itemDef(it.itemId);
    const rc = rarityColor(it.itemId);
    const enh = it.enhance > 0 ? ` +${it.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'enh-item' + (it.instId === enhanceTargetInstId ? ' selected' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${enh}</span>
      <span class="enh-item-where">${it.where}</span>`;
    cell.addEventListener('click', () => selectEnhanceTarget(it.instId));
    list.appendChild(cell);
  }
}
// 右侧：选中装备的强化详情（成功率/消耗/属性预览/保护符/强化按钮）
function renderEnhanceDetail() {
  const box = $('enhance-detail');
  if (!box) return;
  const ins = findEnhanceInstance(enhanceTargetInstId);
  if (!ins) {
    box.innerHTML = '<div class="enhance-hint">← 选择一件装备进行强化</div>';
    return;
  }
  const cfg = enhanceConfig();
  const d = itemDef(ins.itemId);
  const rc = rarityColor(ins.itemId);
  const cur = ins.enhance || 0;
  const maxLevel = cfg ? cfg.maxLevel : 15;
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${cur > 0 ? ' +' + cur : ''}</span>
    </div>`;
  if (!cfg) { box.innerHTML = head + '<div class="enhance-hint">强化配置未加载</div>'; return; }
  if (cur >= maxLevel) {
    box.innerHTML = head + `<div class="enh-maxed">✦ 已达最高强化等级 +${maxLevel}</div>`;
    return;
  }
  const target = cur + 1;
  const def = enhanceLevelDef(target);
  if (!def) { box.innerHTML = head + '<div class="enhance-hint">该等级强化数据缺失</div>'; return; }
  const rate = Math.round((def.successRate || 0) * 100);
  const stoneId = cfg.stoneItemId || 4006;
  const protectId = cfg.protectStoneItemId || 4007;
  const stoneHave = inventory[stoneId] || 0;
  const stoneNeed = def.stoneCount || 0;
  const goldNeed = def.goldCost || 0;
  const protectHave = inventory[protectId] || 0;
  const canAfford = gold >= goldNeed && stoneHave >= stoneNeed;
  // 属性预览：当前 → 下一级（atk/def/hp 参与强化，mp 不参与）
  const attrRows = [];
  if (d.attackBonus) attrRows.push(attrPreviewRow('攻击', d.attackBonus, cur, target, 'atk'));
  if (d.defenseBonus) attrRows.push(attrPreviewRow('防御', d.defenseBonus, cur, target, 'def'));
  if (d.hpBonus) attrRows.push(attrPreviewRow('生命', d.hpBonus, cur, target, 'hp'));
  const attrHtml = attrRows.length ? `<div class="enh-attrs">${attrRows.join('')}</div>` : '';
  // 失败降级提示
  const degradeHtml = def.failDegrade < 0
    ? `<div class="enh-warn">⚠ 失败将降级 ${def.failDegrade} 级${def.canProtect ? '（保护符可防止）' : ''}</div>`
    : `<div class="enh-safe">✓ 失败不降级</div>`;
  // 保护符勾选（仅 canProtect 等级可用）
  let protectHtml = '';
  if (def.canProtect) {
    const dis = protectHave < 1 ? ' disabled' : '';
    protectHtml = `<label class="enh-protect"><input type="checkbox" id="enh-protect-chk"${enhanceUseProtect ? ' checked' : ''}${dis}> 使用保护符（持有 ${protectHave}）</label>`;
  }
  box.innerHTML = head + `
    <div class="enh-level">强化等级 <b>+${cur}</b> <span class="enh-arrow">→</span> <b class="enh-target">+${target}</b></div>
    <div class="enh-row"><span>成功率</span><b class="enh-rate${rate < 50 ? ' low' : ''}">${rate}%</b></div>
    <div class="enh-row"><span>金币</span><b class="${gold >= goldNeed ? '' : 'enh-lack'}">${goldNeed}💰 / 持有 ${gold}</b></div>
    <div class="enh-row"><span>强化石</span><b class="${stoneHave >= stoneNeed ? '' : 'enh-lack'}">${stoneNeed}🔩 / 持有 ${stoneHave}</b></div>
    ${attrHtml}
    ${degradeHtml}
    ${protectHtml}
    <button id="enh-do-btn" class="enh-do-btn"${canAfford ? '' : ' disabled'}>强化</button>`;
  const chk = $('enh-protect-chk');
  if (chk) chk.addEventListener('change', (e) => { enhanceUseProtect = e.target.checked; });
  const btn = $('enh-do-btn');
  if (btn) btn.addEventListener('click', () => {
    if (!canAfford) return;
    net.sendEnhance(enhanceTargetInstId, enhanceUseProtect);
  });
}
// 单条属性预览：base ×(1+enhance×系数)，展示 当前 → 下一级 + 增量
function attrPreviewRow(label, base, cur, target, attr) {
  const c = Math.round(base * enhanceMultiplier(cur, attr));
  const n = Math.round(base * enhanceMultiplier(target, attr));
  const up = n > c ? `<span class="enh-up">+${n - c}</span>` : '';
  return `<div class="enh-attr"><span>${label}</span><span>${c} → <b>${n}</b> ${up}</span></div>`;
}
// 强化结果处理：Toast 反馈 + 金币即时更新（等级/背包由随后的 S2C_INVENTORY 刷新）
function handleEnhanceResult(msg) {
  if (msg.ok) {
    if (msg.success) toast(`强化成功！装备升至 +${msg.newLevel} ✨`, 'ok');
    else toast(`强化失败，装备降为 +${msg.newLevel}`, 'bad');
    gold = msg.goldLeft;
    renderHud();
  } else {
    toast(ENHANCE_FAIL_TEXT[msg.failCode] || '强化失败', 'bad');
  }
}

// ---------------- 装备分解面板（阶段3） ----------------
// 分解失败码 → 文案（与服务端 decomposeEquip / doDecompose failCode 对齐）
const DECOMPOSE_FAIL_TEXT = {
  1: '装备已锁定，无法分解',
  2: '装备无效或不存在',
  3: '该装备无法分解',
  4: '已穿戴的装备需先卸下',
  6: '需在铁匠附近才能分解',
};
// 可分解装备：仅背包（equipBag）；已穿戴需先卸下（服务端 failCode=4）
function collectDecomposeItems() {
  const out = [];
  for (const ins of equipBag) {
    if (ins && ins.instId) out.push({ instId: ins.instId, itemId: ins.itemId, enhance: ins.enhance || 0, locked: !!ins.locked });
  }
  return out;
}
// 按实例 ID 在背包中查找（分解仅作用于背包装备）
function findDecomposeInstance(instId) {
  if (!instId) return null;
  for (const ins of equipBag) {
    if (ins && ins.instId === instId) return ins;
  }
  return null;
}
function selectDecomposeTarget(instId) {
  decomposeTargetInstId = instId;
  renderDecomposeList();
  renderDecomposeDetail();
}
// 左侧：可分解装备列表（背包装备；锁定标记）
function renderDecomposeList() {
  const list = $('decompose-list');
  if (!list) return;
  list.innerHTML = '';
  const items = collectDecomposeItems();
  if (!items.length) {
    list.innerHTML = '<div class="enhance-hint">背包中没有可分解的装备<br>（已穿戴的装备需先卸下）</div>';
    return;
  }
  for (const it of items) {
    const d = itemDef(it.itemId);
    const rc = rarityColor(it.itemId);
    const enh = it.enhance > 0 ? ` +${it.enhance}` : '';
    const lock = it.locked ? ' 🔒' : '';
    const cell = document.createElement('div');
    cell.className = 'enh-item' + (it.instId === decomposeTargetInstId ? ' selected' : '') + (it.locked ? ' locked' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${enh}${lock}</span>
      <span class="enh-item-where">${rarityName(it.itemId)}</span>`;
    cell.addEventListener('click', () => selectDecomposeTarget(it.instId));
    list.appendChild(cell);
  }
}
// 右侧：选中装备的分解产出预览（材料区间 + 金币 + 强化石返还）
function renderDecomposeDetail() {
  const box = $('decompose-detail');
  if (!box) return;
  const ins = findDecomposeInstance(decomposeTargetInstId);
  if (!ins) {
    box.innerHTML = '<div class="enhance-hint">← 选择一件装备进行分解</div>';
    return;
  }
  const d = itemDef(ins.itemId);
  const rc = rarityColor(ins.itemId);
  const cur = ins.enhance || 0;
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${cur > 0 ? ' +' + cur : ''}</span>
    </div>`;
  if (ins.locked) {
    box.innerHTML = head + '<div class="enh-warn">🔒 装备已锁定，无法分解<br>（在背包中解锁后再试）</div>';
    return;
  }
  const cfg = decomposeConfig();
  const rule = decomposeRule(itemRarity(ins.itemId));
  if (!rule) { box.innerHTML = head + '<div class="enhance-hint">分解配置未加载</div>'; return; }
  // 金币返还 = floor(price × goldReturnRate)；强化石返还 = floor(enhanceStoneRate × enhance)
  const goldGain = Math.floor((d.price || 0) * (rule.goldReturnRate || 0));
  const stoneId = (cfg && cfg.stoneItemId) || 4006;
  const stoneGain = Math.floor((rule.enhanceStoneRate || 0) * cur);
  const stoneRow = stoneGain > 0
    ? `<div class="dec-mat"><span class="item-icon">${itemDef(stoneId).icon}</span><span class="dec-mat-name">${itemDef(stoneId).name}</span><b>×${stoneGain}</b></div>`
    : '';
  // 材料产出预览（数量区间 + 概率）
  const matRows = (rule.results || []).map((res) => {
    const md = itemDef(res.itemId);
    const cnt = res.minCount === res.maxCount ? `${res.minCount}` : `${res.minCount}~${res.maxCount}`;
    const prob = res.prob >= 1 ? '' : ` <span class="dec-prob">${Math.round(res.prob * 100)}%</span>`;
    return `<div class="dec-mat"><span class="item-icon">${md.icon}</span><span class="dec-mat-name">${md.name}</span><b>×${cnt}</b>${prob}</div>`;
  }).join('');
  box.innerHTML = head + `
    <div class="dec-section">分解产出</div>
    <div class="dec-gold">💰 金币 <b>+${goldGain}</b></div>
    <div class="dec-mats">${stoneRow}${matRows || '<div class="enhance-hint">无材料产出</div>'}</div>
    <div class="enh-warn">⚠ 分解后装备将被销毁，不可恢复</div>
    <button id="dec-do-btn" class="enh-do-btn">确认分解</button>`;
  const btn = $('dec-do-btn');
  if (btn) btn.addEventListener('click', () => { net.sendDecompose(decomposeTargetInstId); });
}
// 分解结果处理：Toast 反馈 + 金币即时更新（背包/材料由随后的 S2C_INVENTORY 刷新）
function handleDecomposeResult(msg) {
  if (msg.ok) {
    const parts = [];
    if (msg.goldGain) parts.push(`+${msg.goldGain}💰`);
    for (const it of (msg.items || [])) parts.push(`${itemName(it.itemId)}×${it.count}`);
    toast(`分解成功！获得 ${parts.length ? parts.join('、') : '材料'}`, 'ok');
    gold += (msg.goldGain || 0);   // 即时反馈；随后的 S2C_INVENTORY 会以服务端权威值纠正
    renderHud();
    // 原目标已销毁，重新选中背包首件
    const items = collectDecomposeItems();
    decomposeTargetInstId = items.length ? items[0].instId : 0;
    renderDecomposeList();
    renderDecomposeDetail();
  } else {
    toast(DECOMPOSE_FAIL_TEXT[msg.failCode] || '分解失败', 'bad');
  }
}

// ---------------- 物品合成面板（阶段4） ----------------
// 合成失败码 → 文案（与服务端 craftItem / doCraft failCode 对齐）
const CRAFT_FAIL_TEXT = {
  1: '配方不存在',
  2: '等级不足，无法合成',
  3: '材料不足',
  4: '金币不足',
  6: '需在合成 NPC 附近',
  7: '该 NPC 无法合成此配方',
};
// 打开合成面板：记录 NPC + 请求该 NPC 的可用配方列表（服务端按标签+等级过滤，隐藏/等级不足不返回）
function openCraftPanel() {
  const p = $('craft-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeEnhancePanel();
  closeWarehousePanel();
  p.classList.remove('hidden');
  craftNpcWid = currentNpcWid;
  craftTargetRecipeId = 0;
  craftCount = 1;
  craftListIds = [];
  renderCraftList();
  renderCraftDetail();
  net.sendCraftList(craftNpcWid);   // 服务端回 S2C_CRAFT_LIST → handleCraftList 渲染
}
function closeCraftPanel() { const p = $('craft-panel'); if (p) p.classList.add('hidden'); }
// 收到可用配方列表：存储 + 默认选中首个 + 渲染
function handleCraftList(msg) {
  craftListIds = (msg && msg.recipeIds) ? msg.recipeIds.slice() : [];
  if (!craftListIds.some((id) => id === craftTargetRecipeId)) {
    craftTargetRecipeId = craftListIds.length ? craftListIds[0] : 0;
    craftCount = 1;
  }
  renderCraftList();
  renderCraftDetail();
}
function selectCraftTarget(recipeId) {
  craftTargetRecipeId = recipeId;
  craftCount = 1;
  renderCraftList();
  renderCraftDetail();
}
// 左侧：可用配方列表（服务端已按 NPC 标签 + 等级过滤；点击选中）
function renderCraftList() {
  const list = $('craft-list');
  if (!list) return;
  list.innerHTML = '';
  const recipes = craftListIds.map((id) => craftRecipe(id)).filter((r) => !!r);
  if (!recipes.length) {
    list.innerHTML = '<div class="enhance-hint">暂无可合成的配方<br>（提升等级或寻找其他合成 NPC）</div>';
    return;
  }
  for (const r of recipes) {
    const d = itemDef(r.resultItemId);
    const rc = rarityColor(r.resultItemId);
    const cell = document.createElement('div');
    cell.className = 'enh-item' + ((r.recipeId | 0) === (craftTargetRecipeId | 0) ? ' selected' : '');
    cell.innerHTML = `<span class="item-icon">${d.icon}</span>
      <span class="enh-item-name" style="color:${rc}">${d.name}${r.resultCount > 1 ? '×' + r.resultCount : ''}</span>
      <span class="enh-item-where">Lv.${r.levelReq || 1}</span>`;
    cell.addEventListener('click', () => selectCraftTarget(r.recipeId));
    list.appendChild(cell);
  }
}
// 右侧：选中配方的合成详情（材料需求高亮缺失 + 金币 + 产出预览 + 批量 + 合成按钮）
function renderCraftDetail() {
  const box = $('craft-detail');
  if (!box) return;
  const r = craftRecipe(craftTargetRecipeId);
  if (!r) {
    box.innerHTML = '<div class="enhance-hint">← 选择一个配方进行合成</div>';
    return;
  }
  const d = itemDef(r.resultItemId);
  const rc = rarityColor(r.resultItemId);
  const isEquip = (d.type === 'equip');
  const head = `<div class="enh-detail-head">
      <span class="item-icon">${d.icon}</span>
      <span class="enh-name" style="color:${rc}">${d.name}${r.resultCount > 1 ? '×' + r.resultCount : ''}</span>
    </div>`;
  // 材料需求（have/need；不足标红）
  const matRows = (r.materials || []).map((m) => {
    const md = itemDef(m.itemId);
    const need = (m.count || 0) * craftCount;
    const have = inventory[m.itemId] || 0;
    const lack = have < need ? ' craft-lack' : '';
    return `<div class="dec-mat${lack}"><span class="item-icon">${md.icon}</span><span class="dec-mat-name">${md.name}</span><b>${have}/${need}</b></div>`;
  }).join('');
  // 金币 / 等级需求
  const goldNeed = (r.goldCost || 0) * craftCount;
  const goldLack = gold < goldNeed ? 'craft-lack' : '';
  const pl = playerStats.level || 1;
  const levelLack = pl < (r.levelReq || 1) ? 'craft-lack' : '';
  // 可合成判定（材料 + 金币齐全）
  const matsOk = (r.materials || []).every((m) => (inventory[m.itemId] || 0) >= (m.count || 0) * craftCount);
  const canCraft = matsOk && gold >= goldNeed;
  // 批量选择（仅堆叠产出可批量；装备恒为 1）
  const countHtml = isEquip ? '' : `<div class="craft-count">
      <span>数量</span>
      <button id="craft-dec" class="craft-step">−</button>
      <b id="craft-count-val">${craftCount}</b>
      <button id="craft-inc" class="craft-step">＋</button>
    </div>`;
  box.innerHTML = head + `
    <div class="dec-section">产出</div>
    <div class="dec-gold"><span class="item-icon">${d.icon}</span> ${d.name} <b>×${(r.resultCount || 1) * craftCount}</b>${isEquip ? ' <span class="dec-prob">装备实例</span>' : ''}</div>
    <div class="dec-section">材料需求</div>
    <div class="dec-mats">${matRows || '<div class="enhance-hint">无需材料</div>'}</div>
    <div class="enh-row"><span>金币</span><b class="${goldLack}">${goldNeed}💰 / 持有 ${gold}</b></div>
    <div class="enh-row"><span>需求等级</span><b class="${levelLack}">Lv.${r.levelReq || 1}</b></div>
    ${countHtml}
    <button id="craft-do-btn" class="enh-do-btn"${canCraft ? '' : ' disabled'}>合成</button>`;
  const dec = $('craft-dec'), inc = $('craft-inc');
  if (dec) dec.addEventListener('click', () => { if (craftCount > 1) { craftCount--; renderCraftDetail(); } });
  if (inc) inc.addEventListener('click', () => { if (craftCount < 99) { craftCount++; renderCraftDetail(); } });
  const btn = $('craft-do-btn');
  if (btn) btn.addEventListener('click', () => { if (canCraft) net.sendCraft(craftTargetRecipeId, craftCount); });
}
// 合成结果处理：Toast 反馈 + 金币即时扣减（背包/产出由随后的 S2C_INVENTORY 刷新）
function handleCraftResult(msg) {
  if (msg.ok) {
    const d = itemDef(msg.resultItemId);
    toast(`合成成功！获得 ${d.name}×${msg.resultCount}${msg.isInstance ? '（装备）' : ''}`, 'ok');
    // 金币即时反馈（随后的 S2C_INVENTORY 以服务端权威值纠正）
    const r = craftRecipe(msg.recipeId);
    if (r) { gold -= (r.goldCost || 0) * (msg.isInstance ? 1 : craftCount); renderHud(); }
    renderCraftDetail();   // 材料已消耗，刷新详情（列表不变）
  } else {
    toast(CRAFT_FAIL_TEXT[msg.failCode] || '合成失败', 'bad');
  }
}

// ---------------- 银行仓库面板（阶段5） ----------------
// 仓库操作码/结果码（与服务端 warehouse.h WarehouseOp/WarehouseCode 对齐）
const WH_OP = { OPEN: 0, DEPOSIT: 1, WITHDRAW: 2, EXPAND: 3, LOCK: 4 };
const WH_FAIL_TEXT = {
  1: '仓库已满，请先扩展',
  2: '物品不存在',
  3: '金币不足',
  4: '仓库已达最大容量',
  5: '需在银行职员附近',
  6: '数量无效',
  7: '物品已锁定',
  8: '超过存金上限',
};
// 打开仓库面板：记录 NPC + 请求服务端全量仓库数据（S2C_WAREHOUSE → handleWarehouse 渲染）
function openWarehousePanel() {
  const p = $('warehouse-panel');
  if (!p) return;
  closeInventoryPanel();
  closeShopPanel();
  closeEnhancePanel();
  closeCraftPanel();
  p.classList.remove('hidden');
  warehouseNpcWid = currentNpcWid;
  warehousePage = 0;
  net.sendWarehouseOpen(warehouseNpcWid);   // 服务端回 S2C_WAREHOUSE → handleWarehouse 渲染
}
function closeWarehousePanel() { const p = $('warehouse-panel'); if (p) p.classList.add('hidden'); }
// 收到仓库全量数据：存储 + 页码钳制 + 渲染
function handleWarehouse(msg) {
  warehouseData = {
    gold: (msg.gold || 0) >>> 0,
    unlocked: (msg.unlocked || 0) >>> 0,
    slots: Array.isArray(msg.slots) ? msg.slots : [],
  };
  const maxPage = Math.max(0, Math.ceil(warehouseData.unlocked / whPerPage()) - 1);
  if (warehousePage > maxPage) warehousePage = maxPage;
  renderWarehouse();
}
// 仓库操作结果：失败 Toast；扩展成功 Toast（存取成功由随后的 S2C_WAREHOUSE 刷新）
function handleWarehouseResult(msg) {
  if ((msg.code | 0) === 0) {
    if ((msg.op | 0) === WH_OP.EXPAND) toast('仓库扩展成功！', 'ok');
    return;
  }
  toast(WH_FAIL_TEXT[msg.code | 0] || '仓库操作失败', 'bad');
}
// 页大小/最大格数/页数（读运行时仓库配置，未加载回退默认 30/150）
function whPerPage() { const c = warehouseConfig(); return (c && (c.slotsPerPage | 0)) || 30; }
function whMaxSlots() { const c = warehouseConfig(); return (c && (c.maxSlots | 0)) || 150; }
function whPageCount() {
  if (!warehouseData || !warehouseData.unlocked) return 1;
  return Math.max(1, Math.ceil(warehouseData.unlocked / whPerPage()));
}
// 金币数量输入（协议 count 为 u16，单次上限 65535）
function promptGold(action, cap, cb) {
  const limit = Math.max(1, Math.min(65535, cap | 0));
  const raw = window.prompt(`请输入要${action}的金币数量（1-${limit}）：`, String(limit));
  if (raw == null) return;
  let amt = parseInt(raw, 10);
  if (!isFinite(amt) || amt <= 0) { toast('数量无效', 'bad'); return; }
  if (amt > limit) amt = limit;
  cb(amt);
}
// 渲染整个仓库面板（金币栏 + 页签 + 背包列 + 仓库列 + 扩展栏）
function renderWarehouse() {
  renderWarehouseGold();
  renderWarehousePages();
  renderWarehouseBag();
  renderWarehouseSlots();
  renderWarehouseFooter();
}
// 金币栏：身上/仓库存金 + 存金/取金按钮（itemId=0 约定为金币）
function renderWarehouseGold() {
  const bar = $('warehouse-goldbar');
  if (!bar) return;
  const wg = warehouseData ? warehouseData.gold : 0;
  bar.innerHTML = `
    <div class="wh-gold-item"><span class="wh-gold-label">身上</span><b>${gold}💰</b></div>
    <div class="wh-gold-item"><span class="wh-gold-label">仓库存金</span><b>${wg}💰</b></div>
    <div class="wh-gold-btns">
      <button id="wh-deposit-gold" class="wh-gold-btn">存金</button>
      <button id="wh-withdraw-gold" class="wh-gold-btn">取金</button>
    </div>`;
  const dg = $('wh-deposit-gold');
  if (dg) dg.addEventListener('click', () => promptGold('存入', gold, (amt) => net.sendWarehouseDeposit(false, 0, 0, amt)));
  const wb = $('wh-withdraw-gold');
  if (wb) wb.addEventListener('click', () => promptGold('取出', wg, (amt) => net.sendWarehouseWithdraw(false, 0, 0, amt)));
}
// 页签：按 unlocked/slotsPerPage 生成多页 + 使用量信息
function renderWarehousePages() {
  const box = $('warehouse-pages');
  if (!box) return;
  box.innerHTML = '';
  const n = whPageCount();
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.className = 'wh-page-btn' + (i === warehousePage ? ' active' : '');
    b.textContent = `第${i + 1}页`;
    b.addEventListener('click', () => { warehousePage = i; renderWarehousePages(); renderWarehouseSlots(); });
    box.appendChild(b);
  }
  const info = document.createElement('span');
  info.className = 'wh-page-info';
  const used = warehouseData ? warehouseData.slots.length : 0;
  const cap = warehouseData ? warehouseData.unlocked : 0;
  info.textContent = `${used}/${cap} 格`;
  box.appendChild(info);
}
// 背包列（左）：可存入物品 = 背包装备实例（已穿戴需先卸下）+ 堆叠物品；点击存入
function renderWarehouseBag() {
  const box = $('warehouse-bag');
  if (!box) return;
  box.innerHTML = '';
  let any = false;
  for (const ins of equipBag) {
    if (!ins || !ins.instId) continue;
    any = true;
    const d = itemDef(ins.itemId);
    const rc = rarityColor(ins.itemId);
    const enh = ins.enhance > 0 ? `+${ins.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'wh-cell filled';
    cell.style.borderColor = rc;
    cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span>${enh ? `<span class="wh-cell-badge wh-enh">${enh}</span>` : ''}${ins.locked ? '<span class="wh-cell-badge wh-lock">🔒</span>' : ''}`;
    cell.title = `${d.name}${enh}（点击存入）`;
    cell.addEventListener('click', () => net.sendWarehouseDeposit(true, ins.instId, ins.itemId, 1));
    box.appendChild(cell);
  }
  for (const key of Object.keys(inventory)) {
    const itemId = key | 0;
    const cnt = inventory[key] | 0;
    if (!itemId || cnt <= 0) continue;
    any = true;
    const d = itemDef(itemId);
    const cell = document.createElement('div');
    cell.className = 'wh-cell filled';
    cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span><span class="wh-cell-badge wh-count">${cnt}</span>`;
    cell.title = `${d.name} ×${cnt}（点击存入全部）`;
    cell.addEventListener('click', () => net.sendWarehouseDeposit(false, 0, itemId, cnt));
    box.appendChild(cell);
  }
  if (!any) box.innerHTML = '<div class="enhance-hint">背包空空如也</div>';
}
// 仓库列（右）：当前页格子网格（空格补齐到页容量）；点击 filled 格取出
function renderWarehouseSlots() {
  const box = $('warehouse-slots');
  if (!box) return;
  box.innerHTML = '';
  if (!warehouseData) return;
  const perPage = whPerPage();
  const start = warehousePage * perPage;
  const end = Math.min(start + perPage, warehouseData.unlocked);
  for (let gi = start; gi < end; gi++) {
    const s = warehouseData.slots[gi];
    const cell = document.createElement('div');
    if (s && (s.isInstance ? s.instId : s.itemId)) {
      const d = itemDef(s.itemId);
      const rc = rarityColor(s.itemId);
      cell.className = 'wh-cell filled';
      cell.style.borderColor = rc;
      if (s.isInstance) {
        const enh = s.enhance > 0 ? `+${s.enhance}` : '';
        cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span>${enh ? `<span class="wh-cell-badge wh-enh">${enh}</span>` : ''}${s.locked ? '<span class="wh-cell-badge wh-lock">🔒</span>' : ''}`;
        cell.title = `${d.name}${enh}（点击取出）`;
        cell.addEventListener('click', () => net.sendWarehouseWithdraw(true, s.instId, s.itemId, 1));
      } else {
        const cnt = Math.min(s.count | 0, 65535);
        cell.innerHTML = `<span class="wh-cell-icon">${d.icon}</span><span class="wh-cell-badge wh-count">${s.count}</span>`;
        cell.title = `${d.name} ×${s.count}（点击取出全部）`;
        cell.addEventListener('click', () => net.sendWarehouseWithdraw(false, 0, s.itemId, cnt));
      }
    } else {
      cell.className = 'wh-cell empty';
    }
    box.appendChild(cell);
  }
}
// 扩展栏：未满显示扩展按钮（费用 1000×1.5^n）+ 目标格数；已满显示提示
function renderWarehouseFooter() {
  const box = $('warehouse-footer');
  if (!box) return;
  if (!warehouseData) { box.innerHTML = ''; return; }
  const unlocked = warehouseData.unlocked;
  const maxSlots = whMaxSlots();
  if (unlocked >= maxSlots) {
    box.innerHTML = `<div class="wh-expand-info">仓库已达最大容量 ${maxSlots} 格</div>`;
    return;
  }
  const cost = warehouseExpandCost(unlocked);
  const afford = gold >= cost;
  const nextSlots = Math.min(maxSlots, unlocked + whPerPage());
  box.innerHTML = `<button id="wh-expand-btn" class="wh-expand-btn"${afford ? '' : ' disabled'}>扩展仓库 → ${nextSlots} 格（${cost}💰）</button>
    <div class="wh-expand-info">身上金币 ${gold}💰</div>`;
  const btn = $('wh-expand-btn');
  if (btn) btn.addEventListener('click', () => { if (afford) net.sendWarehouseExpand(); });
}

// ---------------- NPC 交互系统 ----------------
function openNpcDialog(npc) {
  currentNpcWid = npc.wid;
  currentNpcName = npc.name || 'NPC';
  currentNpcTag = npc.npcTag || 0;
  npcDialogOpen = true;
  const dlg = $('npc-dialog');
  if (!dlg) return;
  dlg.classList.remove('hidden');
  $('npc-dialog-name').textContent = currentNpcName;
  $('npc-dialog-text').textContent = `你好，旅行者！我是${currentNpcName}。`;
  // 商店 NPC 自动打开商店
  if (isShopNpc(npc)) net.sendShopOpen(npc.wid);
  // 设置 NPC 过滤模式，请求该 NPC 发布的可接任务
  setNpcFilter(npc.wid);
  sendTalkNpc(net, npc.wid);
  // 延迟刷新以等待服务端响应
  setTimeout(refreshNpcDialog, 300);
}
function closeNpcDialog() {
  npcDialogOpen = false;
  currentNpcWid = 0;
  currentNpcName = '';
  setNpcFilter(0); // 重置 NPC 过滤
  const dlg = $('npc-dialog');
  if (dlg) dlg.classList.add('hidden');
}
function refreshNpcDialog() {
  if (!npcDialogOpen) return;
  const opts = $('npc-dialog-options');
  if (!opts) return;
  opts.innerHTML = '';
  const available = getQuestList();
  const active = getQuestProgress();
  // 商店 NPC 选项（按 npcTag 判定，不依赖名称）
  if ((currentNpcTag & NPC_TAG.SHOP) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">🏪</span><span class="npc-opt-text">浏览商品</span><span class="npc-opt-tag tag-shop">商店</span>';
    btn.addEventListener('click', () => { if (shopData) openShopPanel(); });
    opts.appendChild(btn);
  }
  // 铁匠 NPC 选项：装备强化/分解（按 npcTag 判定，不依赖名称；面板内页签切换）
  if ((currentNpcTag & NPC_TAG.BLACKSMITH) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">⚒️</span><span class="npc-opt-text">装备强化 / 分解</span><span class="npc-opt-tag tag-smith">铁匠</span>';
    btn.addEventListener('click', () => openEnhancePanel());
    opts.appendChild(btn);
  }
  // 合成 NPC 选项：物品合成（按 npcTag 判定；面板打开后请求服务端过滤的配方列表）
  if ((currentNpcTag & NPC_TAG.CRAFT) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">⚗️</span><span class="npc-opt-text">物品合成</span><span class="npc-opt-tag tag-craft">合成</span>';
    btn.addEventListener('click', () => openCraftPanel());
    opts.appendChild(btn);
  }
  // 银行 NPC 选项：仓库（按 npcTag 判定；面板打开后请求服务端全量仓库数据）
  if ((currentNpcTag & NPC_TAG.BANK) !== 0) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = '<span class="npc-opt-icon">🏦</span><span class="npc-opt-text">打开仓库</span><span class="npc-opt-tag tag-bank">银行</span>';
    btn.addEventListener('click', () => openWarehousePanel());
    opts.appendChild(btn);
  }
  // 可接任务
  for (const q of available) {
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    const catName = { 1: '主线', 2: '支线', 3: '日常', 4: '重复' }[q.category] || '任务';
    const chainTag = q.nextQuestIds && q.nextQuestIds.length > 0 ? ' 🔗' : '';
    btn.innerHTML = `<span class="npc-opt-icon">❗</span><span class="npc-opt-text">${q.name}${chainTag}</span><span class="npc-opt-tag tag-accept">${catName}·接取</span>`;
    btn.addEventListener('click', () => {
      sendQuestAccept(net, q.questId, currentNpcWid);
      toast(`接受任务【${q.name}】`, 'ok');
      // 接受后刷新对话框（任务可能从可接变为进行中）
      sendTalkNpc(net, currentNpcWid);
      setTimeout(refreshNpcDialog, 200);
    });
    opts.appendChild(btn);
  }
  // 可提交任务（status=1 表示目标已完成可提交）
  for (const q of active) {
    if (q.status !== 1) continue; // status=1 目标已完成可提交
    const listQ = getQuestList().find(lq => lq.questId === q.questId);
    const qName = listQ ? listQ.name : `任务#${q.questId}`;
    const btn = document.createElement('button');
    btn.className = 'npc-opt-btn';
    btn.innerHTML = `<span class="npc-opt-icon">✅</span><span class="npc-opt-text">${qName} 已完成</span><span class="npc-opt-tag tag-turnin">提交</span>`;
    btn.addEventListener('click', () => {
      sendQuestTurnIn(net, q.questId, currentNpcWid);
      toast(`提交任务【${qName}】`, 'ok');
      // 提交后刷新对话框（可能有链式任务解锁）
      setTimeout(() => {
        sendTalkNpc(net, currentNpcWid);
        setTimeout(refreshNpcDialog, 200);
      }, 100);
    });
    opts.appendChild(btn);
  }
  // 通用对话选项
  const talkBtn = document.createElement('button');
  talkBtn.className = 'npc-opt-btn';
  talkBtn.innerHTML = '<span class="npc-opt-icon">💬</span><span class="npc-opt-text">随便聊聊</span><span class="npc-opt-tag tag-talk">对话</span>';
  talkBtn.addEventListener('click', () => {
    $('npc-dialog-text').textContent = '“这片大陆充满了机遇与危险，勇者，祝你一路顺风！”';
  });
  opts.appendChild(talkBtn);
  if (!available.length && active.filter(q => q.status === 1).length === 0 && (currentNpcTag & NPC_TAG.SHOP) === 0 && (currentNpcTag & NPC_TAG.BLACKSMITH) === 0 && (currentNpcTag & NPC_TAG.CRAFT) === 0 && (currentNpcTag & NPC_TAG.BANK) === 0) {
    const empty = document.createElement('div');
    empty.className = 'npc-opt-empty';
    empty.textContent = '（暂无可接或可完成的任务）';
    opts.appendChild(empty);
  }
}
function interactWithNearestNpc() {
  if (!entities || !predictor) return;
  const selfPos = predictor.predicted();
  const npc = findNearbyNpc(selfPos.x, selfPos.z, 4);
  if (!npc) {
    toast('附近没有可交互的 NPC');
    return;
  }
  openNpcDialog(npc);
}
// ---------------- 背包右键上下文菜单（阶段6） ----------------
// 浮动菜单：装备=穿戴/出售/分解/存仓库；堆叠=使用/出售/存仓库（动作由服务端校验 NPC 邻近）
let invMenuEl = null;
function closeInvMenu() { if (invMenuEl) { invMenuEl.remove(); invMenuEl = null; } }
function openInvMenu(x, y, actions) {
  closeInvMenu();
  const list = actions.filter((a) => !!a);
  if (!list.length) return;
  const m = document.createElement('div');
  m.className = 'inv-ctx-menu';
  for (const a of list) {
    const b = document.createElement('button');
    b.className = 'inv-ctx-item' + (a.danger ? ' danger' : '');
    b.innerHTML = `<span class="inv-ctx-icon">${a.icon || ''}</span><span>${a.label}</span>`;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); closeInvMenu(); a.fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = x, top = y;
  if (left + mw > window.innerWidth) left = Math.max(4, window.innerWidth - mw - 4);
  if (top + mh > window.innerHeight) top = Math.max(4, window.innerHeight - mh - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  invMenuEl = m;
}
// 分解背包装备实例（需在铁匠附近；锁定/已穿戴由服务端拒绝并 Toast）
function decomposeEquipInstance(ins) {
  if (ins.locked) { toast('已锁定，无法分解', 'bad'); return; }
  net.sendDecompose(ins.instId);
}
// 存入仓库：装备实例（需在银行职员附近；服务端校验并回执）
function depositEquipToWarehouse(ins) {
  net.sendWarehouseDeposit(true, ins.instId, ins.itemId, 1);
}
// 存入仓库：堆叠物品（全部存入）
function depositStackToWarehouse(itemId, count) {
  net.sendWarehouseDeposit(false, 0, itemId, count || 1);
}

function renderInventory() {
  const grid = $('inv-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const ids = Object.keys(inventory).map(Number).sort((a, b) => a - b);
  if (!equipBag.length && !ids.length) {
    grid.innerHTML = '<div class="inv-empty">背包空空如也（击杀怪物拾取掉落物）</div>';
  }
  // 1) 背包装备实例（不可堆叠，每件独立，携带强化等级）
  for (const ins of equipBag) {
    const d = itemDef(ins.itemId);
    const rc = rarityColor(ins.itemId);
    const enh = ins.enhance > 0 ? ` +${ins.enhance}` : '';
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.style.borderColor = rc;
    cell.innerHTML = `
      ${ins.locked ? '<div class="item-lock" title="已锁定">🔒</div>' : ''}
      <div class="item-icon">${d.icon}</div>
      <div class="item-name" style="color:${rc}">${d.name}${enh}</div>
      <div class="item-sub">${typeName(d.type)}${d.slot ? '·' + (SLOT_NAME[d.slot] || '') : ''}${d.levelReq > 1 ? '·Lv' + d.levelReq : ''}</div>
      <div class="item-actions">
        <button class="act-btn" data-act="equip" data-slot="${d.slot}" data-inst="${ins.instId}">穿戴</button>
        <button class="act-btn act-sell" data-act="sell">出售</button>
      </div>`;
    cell.title = '右键：穿戴/出售/分解/存仓库';
    cell.querySelector('[data-act="equip"]').addEventListener('click', (ev) => {
      const b = ev.currentTarget;
      net.sendEquip(Number(b.dataset.slot), Number(b.dataset.inst));
      toast('装备中…');
    });
    cell.querySelector('[data-act="sell"]').addEventListener('click', () => sellEquipInstance(ins));
    cell.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openInvMenu(ev.clientX, ev.clientY, [
        { icon: '🛡', label: '穿戴', fn: () => { net.sendEquip(d.slot, ins.instId); toast('装备中…'); } },
        { icon: '💰', label: '出售', fn: () => sellEquipInstance(ins) },
        { icon: '⚒', label: '分解', danger: true, fn: () => decomposeEquipInstance(ins) },
        { icon: '🏦', label: '存仓库', fn: () => depositEquipToWarehouse(ins) },
      ]);
    });
    grid.appendChild(cell);
  }
  // 2) 堆叠物品（消耗品/材料/任务道具）
  for (const id of ids) {
    const cnt = inventory[id];
    const d = itemDef(id);
    const rc = rarityColor(id);
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.style.borderColor = rc;
    const sellable = d.type !== 'quest';   // 任务道具不可出售
    cell.innerHTML = `
      <div class="item-icon">${d.icon}</div>
      <div class="item-cnt">×${cnt}</div>
      <div class="item-name" style="color:${rc}">${d.name}</div>
      <div class="item-sub">${typeName(d.type)}${d.levelReq > 1 ? '·Lv' + d.levelReq : ''}</div>
      <div class="item-actions">
        ${d.type === 'consumable' ? `<button class="act-btn" data-act="use" data-id="${id}">使用</button>` : ''}
        ${sellable ? `<button class="act-btn act-sell" data-act="sell" data-id="${id}">出售</button>` : ''}
      </div>`;
    const useBtn = cell.querySelector('[data-act="use"]');
    if (useBtn) useBtn.addEventListener('click', () => { net.sendUseItem(Number(useBtn.dataset.id), 1); toast('使用中…'); });
    const sellBtn = cell.querySelector('[data-act="sell"]');
    if (sellBtn) sellBtn.addEventListener('click', () => sellStackItem(id, 1));
    cell.title = '右键：使用/出售/存仓库';
    cell.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openInvMenu(ev.clientX, ev.clientY, [
        d.type === 'consumable' ? { icon: '🧪', label: '使用', fn: () => { net.sendUseItem(id, 1); toast('使用中…'); } } : null,
        sellable ? { icon: '💰', label: '出售', fn: () => sellStackItem(id, 1) } : null,
        { icon: '🏦', label: '存仓库', fn: () => depositStackToWarehouse(id, cnt) },
      ]);
    });
    grid.appendChild(cell);
  }
}
// 出售背包装备实例（需在商店；锁定不可卖；服务端按 sellPrice×强化系数回收）
function sellEquipInstance(ins) {
  if (!shopData) { toast('需在商店才能出售'); return; }
  if (ins.locked) { toast('已锁定，无法出售'); return; }
  net.sendShopSell(true, ins.instId, ins.itemId, 1);
}
// 出售堆叠物品（需在商店；服务端按 sellPrice 或 ItemDef.price×回收率结算）
function sellStackItem(itemId, count) {
  if (!shopData) { toast('需在商店才能出售'); return; }
  net.sendShopSell(false, 0, itemId, count || 1);
}
function renderEquip() {
  const list = $('equip-list');
  if (!list) return;
  list.innerHTML = '';
  for (let slot = 1; slot <= 6; slot++) {
    const ins = equip[slot];                 // {instId, itemId, enhance} 或 undefined
    const itemId = ins ? ins.itemId : 0;
    const enhance = ins ? ins.enhance : 0;
    const d = itemDef(itemId);
    const rc = itemId ? rarityColor(itemId) : '';
    const enh = enhance > 0 ? ` +${enhance}` : '';
    const row = document.createElement('div');
    row.className = 'equip-row' + (itemId ? ' filled' : '');
    row.innerHTML = `
      <span class="equip-slot">${SLOT_NAME[slot] || slot}</span>
      <span class="item-icon">${itemId ? d.icon : '—'}</span>
      <span class="equip-name"${rc ? ` style="color:${rc}"` : ''}>${itemId ? d.name + enh : '（空）'}</span>
      ${itemId ? `<button class="act-btn" data-slot="${slot}">卸下</button>` : ''}`;
    const btn = row.querySelector('.act-btn');
    if (btn) {
      btn.addEventListener('click', () => { net.sendEquip(slot, 0); toast('已卸下'); });
    }
    list.appendChild(row);
  }
}

// ---------------- 技能系统 UI（技能栏 + Buff 栏） ----------------
function renderSkillBar() {
  const bar = $('skill-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const now = performance.now();
  // 从服务端冷却（cdMs 剩余毫秒）倒计时展示
  const cdMap = {};
  for (const s of learnedSkills) cdMap[s.id] = s.cdMs || 0;
  skillBar.forEach((id, idx) => {
    const sd = skillDef(id);
    const cell = document.createElement('div');
    const cdLeft = cdMap[id] || 0;
    const onCd = cdLeft > 0;
    cell.className = 'skill-cell' + (onCd ? ' cd' : '');
    cell.innerHTML = `
      <div class="skill-icon">${sd.icon}</div>
      <div class="skill-key">${id === 1000 ? 'J' : SKILL_KEY_LABEL(idx + 1)}</div>
      <div class="skill-name">${sd.name}</div>
      <div class="skill-cd">${onCd ? (cdLeft / 1000).toFixed(1) + 's' : ''}</div>`;
    cell.addEventListener('click', () => {
      const sid = skillBar[idx];
      if (sid) castSkillNow(sid);
    });
    bar.appendChild(cell);
  });
  if (!skillBar.length) {
    bar.innerHTML = '<div class="skill-cell empty">未习得技能</div>';
  }
}
function renderBuffBar() {
  const bar = $('buff-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const buffNameMap = {
    1: '攻击↑', 2: '防御↑', 3: '减速', 4: '回血', 5: '反伤',
    6: '流血', 7: '减防', 8: '减攻', 9: '眩晕', 10: '霸体', 11: '加速',
  };
  for (const b of myBuffs) {
    const cell = document.createElement('div');
    cell.className = 'buff-cell';
    cell.innerHTML = `<span>${buffNameMap[b.type] || '#' + b.type}</span><span class="buff-t">${b.remainSec.toFixed(0)}s</span>`;
    bar.appendChild(cell);
  }
}
/** 施放技能：自动选取目标（单目标 → 最近怪物；AOE/自身 → 落点在自身位置） */
function castSkillNow(skillId) {
  if (!net || !predictor) return;
  const selfPos = predictor.predicted();
  const sd = skillDef(skillId);
  // 取消目标检测：无目标（targetWid=0）即可施放，命中全部由服务端按「落点 + 命中半径」范围判定。
  // 落点默认取自身位置；AOE/范围技能若有最近怪物则对准怪物（便于命中演示）。
  let ax = selfPos.x, az = selfPos.z;
  let best = null, bestD = (sd.radius > 0 ? sd.radius + 1 : 6);
  for (const e of entities.forRender()) {
    if (e.kind !== 'monster') continue;
    const d = Math.hypot(e.x - selfPos.x, e.z - selfPos.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best) { ax = best.x; az = best.z; }
  // AOE 范围技能：本地预览落点范围圈
  if (sd.radius > 0) renderer.showAoePreview(ax, az, sd.radius, sd.color);
  net.sendCastSkill(skillId, 0, ax, az);
}
// 按 wid 查找可见实体（技能效果定位用）
function findEntityByWid(wid) {
  for (const e of entities.forRender()) {
    if (e.wid === wid) return e;
  }
  return null;
}
// ---------------- 世界Boss HUD（全区共享血量条） ----------------
function updateBossHud() {
  const bar = $('boss-bar');
  if (!bar) return;
  // 展示：优先正在仇恨本玩家的 Boss，否则存活 Boss
  let pick = null;
  for (const b of bossStates.values()) {
    if (b.state === 1 && b.target === net.selfWid) { pick = b; break; }
  }
  if (!pick) {
    for (const b of bossStates.values()) {
      if (b.state !== 2 && (pick === null || b.hp / b.maxHp < pick.hp / pick.maxHp)) pick = b;
    }
  }
  if (!pick) { bar.style.display = 'none'; return; }
  bossDisplay = pick;
  bar.style.display = 'block';
  $('boss-name').textContent = `${pick.name || '世界Boss'} Lv.${pick.phase} ${pick.state === 2 ? '· 已阵亡' : ''}`;
  const pct = Math.max(0, Math.min(100, (pick.hp / pick.maxHp) * 100));
  $('boss-fill').style.width = pct + '%';
  $('boss-hp').textContent = `${Math.round(pick.hp)} / ${Math.round(pick.maxHp)}`;
}

// ---------------- 主循环 ----------------

function loop(now) {
  if (!running) return;
  const rawDt = (now - lastT) / 1000;         // 真实墙钟 dt（预测器用，保证实时推进）
  const dt = Math.min(0.1, rawDt);            // 插值/HUD 用 dt（防止爆炸）
  lastT = now;

  // 1) 读取输入 → 本地预测即时生效（死亡时门控：不移动/不发送/不施放）
  //    传入当前相机位置（renderer.cam 是上一帧 setCameraFollow 的结果，即当前相机位置）
  //    moveVector 内部会用相机位置补偿长按时的移动目标
  const mv = input.moveVector(predictor.predicted(), renderer.cam.cx, renderer.cam.cz);
  inputAcc += dt;
  // 与服务端同频（20Hz）发送并推进预测
  if (inputAcc >= 0.05) {
    inputAcc -= 0.05;
    if (selfDead) {
      // 死亡：丢弃待处理输入（避免复活后残留触发）
      input.takeAttack(); input.takeSkillSlot();
      input.takeInvToggle(); input.takeShop(); input.takePickup();
      input.takeQuestToggle(); input.takeSocialToggle(); input.takeInteract();
    } else {
      predictor.applyInput(mv.x, mv.z);
      const pred = predictor.predicted(); // 纯物理位置（上报服务端）
      net.sendInput(pred);
    }
  }

  // 2) 其他实体插值（提前到预测之前，提供最新实体位置）
  entities.update(dt);

  // 2.5) 将实体位置喂给预测器（用于实体推挤预测）
  predictor.setNearbyEntities(entities.forRender());

  // 3) 推进预测（内部按 50ms 步进；碰撞推挤仅影响渲染偏移），纯物理位置驱动上报/参考
  const selfPos = predictor.step(rawDt);
  const renderPos = predictor.renderPos(); // 渲染位置（物理 + 碰撞推挤偏移）
  net.setRef(selfPos.x, selfPos.y, selfPos.z); // 二进制相对坐标解码基准（纯物理）
  entities.setSelf(renderPos.x, renderPos.y, renderPos.z); // 实体渲染用渲染位置
  // 相机/渲染使用插值后的渲染位置（60fps 平滑，含碰撞推挤偏移）
  const camPos = renderPos;
  // 死亡遮罩倒计时（与服务端复活计时对齐）
  if (selfDead) {
    const remain = Math.max(0, PLAYER_RESPAWN_SEC - (performance.now() - deathAtMs) / 1000);
    const de = $('death-count');
    if (de) de.textContent = remain.toFixed(1) + 's';
  }
  if (!selfDead) {
  // 攻击：J 键 → 普通攻击（技能 ID=1000，通过技能系统施放，显示前摇/范围）
  if (input.takeAttack()) {
    castSkillNow(1000);
  }
  // 技能系统：数字键 1-8 → 技能栏对应技能（服务端权威校验）
  const slot = input.takeSkillSlot();
  if (slot >= 1 && slot <= skillBar.length) {
    castSkillNow(skillBar[slot - 1]);
  }
  // 冷却倒计时/Buff 展示刷新（脏标记 + 1s 轻量冷却文本更新，避免每帧重建 DOM）
  if (_skillDirty) { renderSkillBar(); _skillDirty = false; _lastCdTick = now; }
  if (_buffDirty) { renderBuffBar(); _buffDirty = false; }
  if (now - _lastCdTick >= 1000) {
    _lastCdTick = now;
    const cdEls = document.querySelectorAll('#skill-bar .skill-cd');
    const cdMap = {};
    for (const s of learnedSkills) cdMap[s.id] = s.cdMs || 0;
    skillBar.forEach((id, idx) => {
      if (cdEls[idx]) {
        const cd = cdMap[id] || 0;
        cdEls[idx].textContent = cd > 0 ? (cd / 1000).toFixed(1) + 's' : '';
      }
    });
  }
  // 物品系统交互（selfPos 已就绪）
  if (input.takeInvToggle()) toggleInventoryPanel();
  if (input.takeQuestToggle()) toggleQuestPanel();
  // 社交系统快捷键
  const socialToggle = input.takeSocialToggle();
  if (socialToggle === 1) toggleFriendPanel();
  else if (socialToggle === 2) toggleGuildPanel();
  else if (socialToggle === 3) toggleChatFocus();
  if (input.takeShop()) {
    // B 键已废弃，统一走 G 交互
    interactWithNearestNpc();
  }
  // G 键：NPC/可交互对象交互
  if (input.takeInteract()) {
    interactWithNearestNpc();
  }
  if (input.takePickup()) pickupNearbyDrops(selfPos.x, selfPos.z, 2.2);
  // H 键：切换参考网格
  if (input.takeGridToggle() && renderer) {
    renderer.setGridVisible(!renderer._gridVisible);
  }
  // 自动拾取：走到掉落物上自动捡起（服务端校验距离）
  autoPickup(selfPos.x, selfPos.z, 1.9);
  }

  // 4) 相机跟随 + 渲染
  renderer.setCameraFollow(camPos.x, camPos.z);
  renderer.setSelf(camPos.x, camPos.y, camPos.z, net.selfName, selfDead);
  renderer.setEntities(entities.forRender());
  renderer.render();

  // 3.5) 小地图更新（右上角罗盘）
  if (minimap) {
    minimap.update(selfPos.x, selfPos.z, entities.forRender());
  }

  // 4) HUD
  fpsAcc += dt;
  fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    $('hud-fps').textContent = `fps:${fps}`;
    $('hud-pos').textContent = `x:${selfPos.x.toFixed(1)} z:${selfPos.z.toFixed(1)}`;
    const b = $('proto-bps');
    if (b && window.__ewBytes) b.textContent = (window.__ewBytes / 1024).toFixed(1) + 'KB';
    fpsAcc = 0;
    fpsCount = 0;
  }

  window.__ewFrames = (window.__ewFrames || 0) + 1;
  requestAnimationFrame(loop);
}

// ---------------- 调试数据打印（输出到浏览器控制台） ----------------
function debugPrint(type) {
  if (!renderer || !predictor) { console.warn('[debug] 渲染器/预测器未初始化'); return; }
  const pos = predictor.predicted();
  const ts = new Date().toISOString().slice(11, 23);
  console.group(`%c[调试数据] ${type} @ ${ts}`, 'color:#c9a84c;font-weight:bold');

  try {
    switch (type) {
      case 'terrain': debugTerrain(pos); break;
      case 'self':    debugSelf(pos);   break;
      case 'npc':     debugEntities('npc'); break;
      case 'monster': debugEntities('monster'); break;
      default: console.warn('未知类型:', type);
    }
  } catch (e) {
    console.error('[debug] 打印失败:', e);
  }
  console.groupEnd();
}

// ── 地形数据 (10m内) ──
function debugTerrain(pos) {
  const RANGE = 10, STEP = 2;
  const raw = [], rendered = [];
  for (let dz = -RANGE; dz <= RANGE; dz += STEP) {
    for (let dx = -RANGE; dx <= RANGE; dx += STEP) {
      const wx = pos.x + dx, wz = pos.z + dz;
      const h = terrainHeight(wx, wz);
      const blocked = terrainBlockedExact(wx, wz);
      const c = terrainColor(wx, wz);
      raw.push({
        x: +wx.toFixed(2), z: +wz.toFixed(2),
        height: +h.toFixed(3), blocked, color: `rgb(${(c.r*255)|0},${(c.g*255)|0},${(c.b*255)|0})`,
      });
    }
  }
  console.log(`%c原始数据 (${raw.length} 采样点, STEP=${STEP}m):`, 'color:#81c784');
  console.table(raw);
}

// ── 自身实体球数据 ──
function debugSelf(pos) {
  const renderPos = predictor.renderPos();
  // w2s 投影
  const screen = renderer.w2s(renderPos.x, renderPos.z);
  // 相机参数
  const cam = renderer.cam;
  console.log('%c物理位置 (predictor.predicted):', 'color:#81c784');
  console.table({ x: +pos.x.toFixed(3), z: +pos.z.toFixed(3) });
  console.log('%c渲染位置 (predictor.renderPos):', 'color:#64b5f6');
  console.table({ x: +renderPos.x.toFixed(3), z: +renderPos.z.toFixed(3) });
  console.log('%c屏幕投影 (renderer.w2s):', 'color:#ffb74d');
  console.table({ screenX: +screen.x.toFixed(1), screenY: +screen.y.toFixed(1) });
  console.log('%c相机参数:', 'color:#ce93d8');
  console.table({ cx: +cam.cx.toFixed(3), cz: +cam.cz.toFixed(3), zoom: cam.zoom });
  console.log('%c地形信息:', 'color:#a89878');
  console.table({
    terrainHeight: +terrainHeight(pos.x, pos.z).toFixed(3),
    blocked: terrainBlockedExact(pos.x, pos.z),
  });
}

// ── 可见实体数据 (NPC/怪物) ──
function debugEntities(kind) {
  if (!entities) { console.warn('[debug] 实体管理器未初始化'); return; }
  const pos = predictor.predicted();
  const list = [];
  for (const e of entities.forRender()) {
    if (e.kind !== kind) continue;
    const dist = Math.hypot(e.x - pos.x, e.z - pos.z);
    const scr = renderer.w2s(e.x, e.y, e.z);
    list.push({
      wid: e.wid, name: e.name || '-',
      x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2),
      dist: +dist.toFixed(1),
      screenX: +scr.x.toFixed(0), screenY: +scr.y.toFixed(0),
      state: e.state, radius: +e.radius.toFixed(2),
      dying: e.dying || false,
    });
  }
  const label = kind === 'npc' ? 'NPC' : '怪物';
  if (list.length === 0) {
    console.log(`%c当前视野内没有${label}`, 'color:#ffb74d');
  } else {
    console.log(`%c可见${label} (${list.length}个):`, 'color:#81c784');
    console.table(list);
  }
}

// ---------------- 自动重连（刷新页面恢复会话） ----------------
window.addEventListener('DOMContentLoaded', async () => {
  // 面板关闭按钮
  const ic = $('inv-close'); if (ic) ic.addEventListener('click', closeInventoryPanel);
  const sc = $('shop-close'); if (sc) sc.addEventListener('click', closeShopPanel);

  // 协议监控折叠切换
  const pt = $('proto-toggle');
  if (pt) pt.addEventListener('click', () => {
    const panel = $('proto-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    pt.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
  });

  // ── 调试数据打印面板 ──
  const dt = $('debug-toggle');
  if (dt) dt.addEventListener('click', () => {
    const panel = $('debug-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    dt.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
  });
  const dpBtn = $('debug-print');
  if (dpBtn) dpBtn.addEventListener('click', () => {
    const sel = $('debug-type');
    if (!sel) return;
    debugPrint(sel.value);
  });

  // 游戏菜单按钮
  const gm = $('game-menu');
  if (gm) {
    gm.addEventListener('click', (e) => {
      const btn = e.target.closest('.gm-btn');
      if (!btn || btn.classList.contains('gm-disabled')) return;
      const action = btn.dataset.action;
      switch (action) {
        case 'inventory': toggleInventoryPanel(); break;
        case 'quest': toggleQuestPanel(); break;
        case 'friend': toggleFriendPanel(); break;
        case 'guild': toggleGuildPanel(); break;
      }
    });
  }

  // NPC 对话关闭
  const ndc = $('npc-dialog-close');
  if (ndc) ndc.addEventListener('click', closeNpcDialog);

  // 铁匠面板关闭 + 页签切换（强化 / 分解）
  const ec = $('enhance-close');
  if (ec) ec.addEventListener('click', closeEnhancePanel);
  const ste = $('smith-tab-enhance');
  if (ste) ste.addEventListener('click', () => switchSmithTab('enhance'));
  const std = $('smith-tab-decompose');
  if (std) std.addEventListener('click', () => switchSmithTab('decompose'));

  // 合成面板关闭（阶段4）
  const cc = $('craft-close');
  if (cc) cc.addEventListener('click', closeCraftPanel);

  // 仓库面板关闭（阶段5）
  const wc = $('warehouse-close');
  if (wc) wc.addEventListener('click', closeWarehousePanel);

  // 背包右键菜单：全局点击/滚动/Esc 关闭（阶段6）
  document.addEventListener('click', () => closeInvMenu());
  document.addEventListener('contextmenu', (ev) => { if (invMenuEl && !invMenuEl.contains(ev.target)) closeInvMenu(); });
  window.addEventListener('blur', () => closeInvMenu());
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeInvMenu(); });

  // 登录/会话检查已由 login.js 的 initLogin 统一处理
});

window.__ewPause = () => {
  running = false;
};
window.__ewResume = () => {
  if (running) return;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
};
