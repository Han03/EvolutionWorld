/**
 * boot.js - EvolutionWorld 客户端入口（主编排文件）
 * 导入子模块并注入依赖，保留进入世界、网络回调、登录与初始化。
 *
 * 子模块：
 *  - boot-state.js   共享状态 + 核心工具函数
 *  - boot-panels.js  UI 面板（背包/装备/商店/强化/分解/合成/仓库）
 *  - boot-game.js    技能施放 + NPC 交互 + 精英 HUD + 主循环 + 调试
 */

// ---- 底层模块 ----
import { NetworkClient } from './network.js';
import { InputState } from './input.js';
import { WebGLRenderer } from './canvas-renderer.js';
import { EntityViewManager } from './entities.js';
import { Predictor, PHYS, circleBlocked, escapeBlocked } from './predict.js';
import { itemDef, skillDef, skillName, applyGameData, rarityColor } from './items.js';
import { EVT, NPC_TAG, Reader } from './protocol.js';
import { loadEditCells, loadWalkMask, terrainHeight, terrainBlockedExact } from './terrain.js';
import { Minimap } from './minimap.js';

// ---- 功能模块 ----
import { initQuestUI, decodeQuestList, decodeQuestProgress, decodeQuestResult, decodeQuestNotify, decodeQuestComplete, decodeQuestChain, toggleQuestPanel, closeQuestPanel, sendQuestList, sendQuestTrack, sendTalkNpc, sendQuestAccept, sendQuestTurnIn, getQuestList, getQuestProgress, setNpcFilter, setQuestNavigator, updateQuestTracker } from './quests.js';
import { QuestNavigator } from './quest-nav.js';
import { initSocialUI, toggleFriendPanel, toggleGuildPanel, closeFriendPanel, closeGuildPanel, toggleChatFocus, isChatFocused,
  handleFriendRequest, handleFriendList, handleFriendStatus, handleFriendResult,
  handleGuildInfo, handleGuildResult, handleGuildNotify, handleGuildList, handleGuildApplyN,
  handleChatMsg, handleChatHistory, handleChatResult, addChatMessage } from './social.js';
import { initConsole, appendConsoleOutput } from './console.js';
import { clearSession } from './session.js';
import { initLogin, hideLogin, showLogin, showLoading, setLoadingText } from './login.js';
import * as autobot from './autobot.js';

// ---- 共享状态 + 工具函数 ----
import { S, CLIENT_VERSION, toast, renderHud, protocolLog } from './boot-state.js';

// ---- 面板子模块 ----
import {
  configure as configurePanels,
  toggleInventoryPanel, closeInventoryPanel, closeShopPanel,
  renderInventory, renderEquip, closeInvMenu,
  openShopPanel,
  openEnhancePanel, closeEnhancePanel, switchSmithTab,
  renderEnhanceList, renderEnhanceDetail, handleEnhanceResult,
  renderDecomposeList, renderDecomposeDetail, handleDecomposeResult,
  openCraftPanel, closeCraftPanel, handleCraftList, renderCraftList, renderCraftDetail, handleCraftResult,
  openWarehousePanel, closeWarehousePanel, handleWarehouse, handleWarehouseResult,
  renderWarehouse, renderWarehouseBag, renderWarehouseGold,
} from './boot-panels.js';

// ---- 游戏子模块 ----
import {
  configure as configureGame,
  findNearbyNpc, pickupNearbyDrops, openNpcDialog, closeNpcDialog, refreshNpcDialog,
  interactWithNearestNpc,
  renderSkillBar, renderBuffBar, isSkillLearned, castSkillNow, findEntityByWid,
  loop, debugPrint, closeAllNpcPanels,
} from './boot-game.js';

// ============================================================================
// 本地工具 / 实例
// ============================================================================
const $ = (id) => document.getElementById(id);
const hud = $('hud');
const net = new NetworkClient();
S.net = net;  // 注入网络客户端到共享状态

/** 根据实体 wid 返回施法者阵营颜色（用于技能圈敌我区分） */
function casterColor(wid) {
  if (wid === net.selfWid) return '#ff8c1a';
  const e = findEntityByWid(wid);
  if (e && e.kind === 'monster') return '#f87171';
  if (e && e.kind === 'player') return '#34d399';
  return '#ffd166';
}

// 全局错误展示
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

// 渲染器物品名映射（canvas-renderer.js 读取）——由 applyGameData 加载后填充
window.__itemNames = {};

// ============================================================================
// 地形数据同步
// ============================================================================
async function reloadTerrain() {
  if (S._terrainReloading) return;
  S._terrainReloading = true;
  let changed = false;
  try {
    try {
      const mr = await fetch('/api/terrain/mask');
      const mj = await mr.json();
      console.log('[Terrain] mask response:', mj ? `ok=${mj.ok}, n=${mj.n}, off=${mj.off}, b64len=${mj.b64 ? mj.b64.length : 0}` : 'null');
      if (mj && mj.ok && loadWalkMask(mj)) { changed = true; console.log('[Terrain] mask loaded successfully'); }
      else console.warn('[Terrain] mask load failed or invalid');
    } catch (e) { console.warn('[Terrain] mask fetch error:', e.message); }
    try {
      const r = await fetch('/api/terrain/edit');
      const j = await r.json();
      if (j && j.ok) { loadEditCells(j.cells); changed = true; }
    } catch (_) {}
    if (!changed) return;
    if (S.minimap) S.minimap.invalidate();
    if (S.renderer) S.renderer.invalidateTerrain();
    if (S.predictor) {
      const p = S.predictor.predicted();
      if (circleBlocked(p.x, p.z, PHYS.RADIUS, true)) {
        const esc = escapeBlocked(p.x, p.z, PHYS.RADIUS, true);
        if (esc) {
          const y = terrainHeight(esc.x, esc.z) + PHYS.RADIUS;
          S.predictor.correction(esc.x, y, esc.z);
          console.warn('[terrain] 地形变更后自身处于阻挡区，已脱困至', esc.x.toFixed(2), esc.z.toFixed(2));
        } else {
          console.warn('[terrain] 地形变更后自身处于阻挡区，1m 内无可通行落点，等待服务端校正');
        }
      }
    }
  } finally {
    S._terrainReloading = false;
  }
}

// ============================================================================
// 配置子模块（注入依赖）
// ============================================================================
// 面板模块仅需 $ 和 net（同模块函数直接通过闭包引用）
configurePanels({ $, net });

// 游戏模块需要面板模块的函数
configureGame({
  $, net,
  toggleInventoryPanel, closeInventoryPanel, closeShopPanel, openShopPanel,
  renderInventory, renderEquip,
  closeEnhancePanel, openEnhancePanel, closeCraftPanel, openCraftPanel, closeWarehousePanel, openWarehousePanel,
  renderEnhanceList, renderEnhanceDetail,
  renderDecomposeList, renderDecomposeDetail,
  renderCraftList, renderCraftDetail,
  renderWarehouseBag, renderWarehouseGold,
  renderWarehouseFooter: null,
});

// ============================================================================
// 登录 UI
// ============================================================================
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

// ============================================================================
// 进入世界
// ============================================================================
/** 初始化自动化测试插件（net 就绪后调用） */
function initAutobotUI(net) {
  autobot.configure({
    S,
    net,
    // 任务模块
    sendQuestList, sendQuestTrack, sendQuestAccept, sendQuestTurnIn, sendTalkNpc,
    getQuestList, getQuestProgress,
    // 面板模块
    openEnhancePanel, openCraftPanel, openShopPanel, closeAllNpcPanels,
    // UI 回调
    onStatus: (st) => {
      const el = $('ab-status');
      if (!el) return;
      const phaseMap = { stop: '停止', paused: '已暂停', thinking: '规划中', idle: '空闲',
        accept: '接任务', turnin: '交任务', talk: '对话', reach: '到达', kill: '战斗',
        collect: '收集', explore: '探索', buyEquip: '购装备', buyConsumable: '购补给',
        enhance: '强化', craftConsumable: '合成' };
      const ph = phaseMap[st.phase] || st.phase;
      el.textContent = `${st.running ? (st.paused ? '⏸ ' : '▶ ') : '⏹ '}${ph}`;
      el.className = 'autobot-status ' + (st.running ? (st.paused ? 'ab-paused' : 'ab-running') : 'ab-stop');
      // 合并后的开始/暂停按钮文案：运行→暂停，已暂停→继续，停止→开始
      const tgl = $('ab-toggle');
      if (tgl) tgl.textContent = st.running ? (st.paused ? '继续' : '暂停') : '开始';
      const statEl = $('ab-stat');
      if (statEl && st.stats) {
        statEl.textContent = `任务${st.stats.questsDone} 击杀${st.stats.monstersKilled} 购${st.stats.itemsBought} 合${st.stats.itemsCrafted} 逃${st.stats.flees || 0}`;
      }
    },
    onLog: (msg) => {
      const box = $('ab-log');
      if (!box) return;
      const div = document.createElement('div');
      div.className = 'ab-log-line';
      div.textContent = msg;
      box.appendChild(div);
      while (box.children.length > 80) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    },
  });
  // 手动输入检测：玩家操作时自动暂停插件（避免互相干扰）
  const mark = () => { S._lastManualInput = performance.now(); };
  document.addEventListener('keydown', (e) => { mark(); if (S.questNav) S.questNav.onKeyPressed(); });
  document.addEventListener('mousedown', mark);
  window.__ewAutobot = autobot; // 调试钩子
}

async function enterWorld(token, username, worldMeta) {
  console.log(`%c[EvolutionWorld] client v${CLIENT_VERSION}`, 'color:#c9a84c;font-weight:bold;font-size:14px');
  showLoading('连接世界中…');

  try {
    // -- 连接前注册即时回调 --
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
    net.onTerrainDirty = () => { reloadTerrain().catch((e) => console.warn('[terrain] 重拉失败:', e)); };

    // 登录初始数据帧
    net.onSkills = (msg) => {
      S.learnedSkills = msg.skills;
      S._cdRefMs = performance.now();
      S.skillBar = msg.skills.map((s) => s.id).sort((a, b) => a - b);
      S._skillDirty = true;
    };
    net.onInventory = (msg) => {
      S.inventory = msg.inventory;
      S.equip = msg.equip;
      S.equipBag = msg.equipBag || [];
      S.gold = msg.gold;
    };
    net.onStats = (msg) => { S.playerStats = msg; };

    await net.connect(token);
    await reloadTerrain();
    // 加载游戏数据（物品/生物配置）
    try {
      const gr = await fetch('/api/gamedata');
      const gj = await gr.json();
      if (gj && gj.ok) { applyGameData(gj); S._gamedata = gj; }
    } catch (_) {}
  } catch (e) {
    showLogin('连接失败：' + e.message);
    return;
  }

  // 等待 hello（超时 5 秒）
  if (!net.hello) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { net.onHello = null; reject(new Error('服务器未响应')); }, 5000);
      const old = net.onHello;
      net.onHello = (msg) => { clearTimeout(timer); old && old(msg); resolve(); };
    });
  }
  setLoadingText('初始化渲染器…');

  // ---- 初始化 3D 渲染器 ----
  try { S.renderer = new WebGLRenderer($('app')); }
  catch (e) { setLoadingText('渲染器错误：' + (e && e.message ? e.message : e)); console.error(e); throw e; }

  // 小地图
  try { S.minimap = new Minimap('minimap'); }
  catch (e) { console.warn('小地图初始化失败:', e); }

  setLoadingText('创建实体管理器…');
  try { S.entities = new EntityViewManager(net.selfWid); }
  catch (e) { setLoadingText('实体管理器错误：' + (e && e.message ? e.message : e)); console.error(e); throw e; }

  window.__ewEntities = S.entities;
  window.__ewMinimap = S.minimap;

  S.input = new InputState(S.renderer.canvas);
  S.input.setRenderer(S.renderer);
  window.__ewInput = S.input;

  // 鼠标世界坐标追踪
  S.renderer.canvas.addEventListener('mousemove', (e) => {
    const rect = S.renderer.canvas.getBoundingClientRect();
    const w = S.renderer.s2w(e.clientX - rect.left, e.clientY - rect.top);
    S._mouseWorldX = w.x; S._mouseWorldZ = w.z;
  });
  S.renderer.canvas.addEventListener('mouseleave', () => { S._mouseWorldX = null; S._mouseWorldZ = null; });

  // 预测器
  S.predictor = new Predictor();
  if (net.hello && net.hello.self) {
    S.predictor.setPosition(net.hello.self.x, net.hello.self.y, net.hello.self.z);
    S.entities.setSelf(net.hello.self.x, net.hello.self.y, net.hello.self.z);
  }
  window.__ewPredictor = S.predictor;

  // 任务导航器
  S.questNav = new QuestNavigator();
  S.questNav.input = S.input;
  S.questNav.entities = S.entities;
  S.questNav.predictor = S.predictor;
  S.questNav.renderer = S.renderer;
  S.questNav.S = S;
  S.questNav._onChange = () => { if (typeof updateQuestTracker === 'function') updateQuestTracker(); };
  setQuestNavigator(S.questNav);
  window.__ewQuestNav = S.questNav;
  window.__ewFx = () => S.renderer.fxSnapshot();
  setLoadingText('接收世界数据…');

  // ---- AOI 实体回调 ----
  net.onEnter = (ents) => S.entities.applyEnter(ents);
  net.onLeave = (wids) => S.entities.applyLeave(wids);
  net.onUpdate = (ups) => S.entities.applyUpdate(ups);
  net.onSnapshot = (snap) => S.entities.applySnapshot(snap.entities);



  // ---- 世界事件（伤害/死亡/复活/技能效果） ----
  net.onEvent = (ev) => {
    if (ev.evtType === EVT.DEATH) {
      if (ev.wid === net.selfWid) {
        S.selfDead = true; S.deathAtMs = performance.now();
        // 死亡时停止移动/寻路
        if (S.input) S.input.clearMovement();
        // 关闭所有功能面板
        closeAllNpcPanels();
        closeQuestPanel();
        closeFriendPanel();
        closeGuildPanel();
        const de = $('death-overlay'); if (de) de.classList.remove('hidden');
        $('hud-conn').textContent = '你被击倒了'; $('hud-conn').className = 'hud-status-chip warn';
      } else if (S.entities) { S.entities.applyDeath(ev.wid); }
    } else if (ev.evtType === EVT.RESPAWN) {
      if (ev.wid === net.selfWid) {
        S.selfDead = false; S.deathAtMs = 0;
        const de = $('death-overlay'); if (de) de.classList.add('hidden');
        $('hud-conn').textContent = '已连接'; $('hud-conn').className = 'hud-status-chip on';
        toast('你已复活', 'ok');
      } else if (S.entities) { S.entities.applyRespawn(ev.wid); }
    }
    if (ev.evtType === EVT.DAMAGE) {
      // 伤害飘字：服务端权威伤害值（仅当目标实体在视野内时显示）
      const dmgTarget = findEntityByWid(ev.wid);
      if (dmgTarget) {
        const dmgVal = Math.round(ev.b);
        if (dmgVal > 0) {
          S.renderer.addSkillEffect({ kind: 'float', x: dmgTarget.x, z: dmgTarget.z, text: `-${dmgVal}`, color: '#ef4444', durMs: 1000 });
        }
      }
    } else if (ev.evtType === EVT.SKILL_CASTING) {
      const sd = skillDef(ev.b);
      if (sd.target === 2) {
        // ENEMY 单体技能：前摇阶段发射追踪射线（施法者 → 目标，飞行时间 = 前摇时间）
        if (ev.wid !== net.selfWid) { // 玩家自身由 onSkillCast 本地创建，避免重复
          const casterEnt = findEntityByWid(ev.wid);
          const fromX = casterEnt ? casterEnt.x : ev.x;
          const fromZ = casterEnt ? casterEnt.z : ev.z;
          const dist = Math.hypot(ev.x - fromX, ev.z - fromZ);
          if (dist > 0.5) {
            const fxPattern = { fire: 'fire', ice: 'ice', lightning: 'lightning', shadow: 'smoke', holy: 'holy', snipe: 'snipe', lifesteal: 'lifesteal', thunder: 'thunder', slash: 'slash' }[sd.fxType] || 'ring';
            const color = casterColor(ev.wid);
            const initAng = Math.atan2(ev.z - fromZ, ev.x - fromX);
            S.renderer.addSkillEffect({ kind: 'projectile', x1: fromX, z1: fromZ, x2: ev.x, z2: ev.z, initAng, color, pattern: fxPattern, durMs: Math.max(200, sd.castMs) });
          }
        }
      } else {
        const circR = sd.radius;
        if (circR > 0) {
          S.renderer.addSkillEffect({
            kind: 'cast', wid: ev.wid, casterWid: ev.wid,
            x: ev.x, z: ev.z, color: casterColor(ev.wid), radius: circR,
            durMs: Math.max(200, sd.castMs),
          });
        }
      }
    } else if (ev.evtType === EVT.SKILL_CANCEL) {
      S.renderer.clearCasting(ev.wid);
      const ent = findEntityByWid(ev.wid);
      if (ent) S.renderer.addSkillEffect({ kind: 'cancel', wid: ev.wid, x: ent.x, z: ent.z, durMs: 260 });
      // 自己的技能被打断（移动/受击）→ 重置客户端冷却，避免技能卡死
      if (ev.wid === net.selfWid) {
        const cdEntry = S.learnedSkills.find((s) => s.id === ev.b);
        if (cdEntry) { cdEntry.cdMs = 0; S._skillDirty = true; }
        renderSkillBar();
      }
    } else if (ev.evtType === EVT.SKILL) {
      const sd = skillDef(ev.b);
      if (sd.radius > 0) {
        // 溅射/AOE 圈统一画在落点（ev.x/ev.z = 服务端落点坐标）
        S.renderer.addSkillEffect({ kind: 'aoe', x: ev.x, z: ev.z, radius: sd.radius, color: casterColor(ev.wid), durMs: 900 });
      }
      // 位移拖尾效果
      if (sd.dashDist > 0) {
        const casterEnt = findEntityByWid(ev.wid);
        const fromX = casterEnt ? casterEnt.x : ev.x;
        const fromZ = casterEnt ? casterEnt.z : ev.z;
        S.renderer.addSkillEffect({
          kind: 'dash', wid: ev.wid, x1: fromX, z1: fromZ,
          x: ev.x, z: ev.z, color: casterColor(ev.wid), radius: 0.6, durMs: 400,
        });
      }
      // 元素命中特效（burst）
      const fxPattern = { fire: 'fire', ice: 'ice', lightning: 'lightning', shadow: 'smoke', holy: 'holy', snipe: 'snipe', lifesteal: 'lifesteal', thunder: 'thunder', slash: 'slash', inferno: 'inferno', frost: 'frost', heal: 'heal' }[sd.fxType] || 'ring';
      const burstRadius = sd.radius > 0 ? sd.radius : 1.5;
      const color = casterColor(ev.wid);
      // 瞬发 ENEMY 单体技能：无前摇阶段，结算时创建快速射线
      if (sd.target === 2 && sd.castMs <= 0) {
        const casterEnt2 = findEntityByWid(ev.wid);
        const fromX = casterEnt2 ? casterEnt2.x : ev.x;
        const fromZ = casterEnt2 ? casterEnt2.z : ev.z;
        const dist = Math.hypot(ev.x - fromX, ev.z - fromZ);
        if (dist > 0.5) {
          const initAng = Math.atan2(ev.z - fromZ, ev.x - fromX);
          const projDur = Math.max(100, Math.min(250, dist * 30));
          S.renderer.addSkillEffect({ kind: 'projectile', x1: fromX, z1: fromZ, x2: ev.x, z2: ev.z, initAng, color, pattern: fxPattern, durMs: projDur });
          setTimeout(() => {
            S.renderer.addSkillEffect({ kind: 'burst', x: ev.x, z: ev.z, radius: burstRadius, color, pattern: fxPattern, durMs: 700 });
          }, projDur);
          // 治疗飘字（基于 heal 字段推断）
          if (sd.heal > 0) {
            const casterEnt3 = findEntityByWid(ev.wid);
            const hx = casterEnt3 ? casterEnt3.x : ev.x;
            const hz = casterEnt3 ? casterEnt3.z : ev.z;
            S.renderer.addSkillEffect({ kind: 'float', x: hx, z: hz, text: `+${Math.round(sd.heal)}`, color: '#4ade80', durMs: 1000 });
          }
          return;
        }
      }
      S.renderer.addSkillEffect({ kind: 'burst', x: ev.x, z: ev.z, radius: burstRadius, color, pattern: fxPattern, durMs: 700 });
      // 治疗飘字（基于 heal 字段推断）
      if (sd.heal > 0) {
        const casterEnt3 = findEntityByWid(ev.wid);
        const hx = casterEnt3 ? casterEnt3.x : ev.x;
        const hz = casterEnt3 ? casterEnt3.z : ev.z;
        S.renderer.addSkillEffect({ kind: 'float', x: hx, z: hz, text: `+${Math.round(sd.heal)}`, color: '#4ade80', durMs: 1000 });
      }
    }
  };

  // ---- 物品系统回调 ----
  net.onInventory = (msg) => {
    S.inventory = msg.inventory; S.equip = msg.equip;
    S.equipBag = msg.equipBag || []; S.gold = msg.gold;
    renderInventory(); renderEquip(); renderHud();
    const ep = $('enhance-panel');
    if (ep && !ep.classList.contains('hidden')) {
      if (S.smithTab === 'decompose') { renderDecomposeList(); renderDecomposeDetail(); }
      else { renderEnhanceList(); renderEnhanceDetail(); }
    }
    const cp = $('craft-panel');
    if (cp && !cp.classList.contains('hidden')) { renderCraftList(); renderCraftDetail(); }
    const wp = $('warehouse-panel');
    if (wp && !wp.classList.contains('hidden')) { renderWarehouseBag(); renderWarehouseGold(); renderWarehouse(); }
  };
  net.onStats = (msg) => { S.playerStats = msg; renderHud(); };

  // ---- 商店 ----
  net.onShop = (msg) => {
    if (!S.shopData || S.shopData.shopId !== msg.shopId) S.shopCategory = 0;
    S.shopData = msg;
    openShopPanel();
  };
  net.onLoot = (msg) => { if (msg.ok) toast('拾取成功', 'ok'); else toast('拾取失败'); };
  net.onSellResult = (msg) => {
    if (msg.ok) toast(`出售成功 +${msg.goldGain}💰`, 'ok');
    else toast('无法出售（需在商店且有回收价）');
  };

  // ---- 强化/分解/合成/仓库 ----
  net.onEnhance = (msg) => handleEnhanceResult(msg);
  net.onDecompose = (msg) => handleDecomposeResult(msg);
  net.onCraftList = (msg) => handleCraftList(msg);
  net.onCraft = (msg) => handleCraftResult(msg);
  net.onWarehouse = (msg) => handleWarehouse(msg);
  net.onWarehouseResult = (msg) => handleWarehouseResult(msg);

  // ---- 技能系统回调 ----
  net.onSkills = (msg) => {
    S.learnedSkills = msg.skills;
    S._cdRefMs = performance.now();
    S.skillBar = msg.skills.map((s) => s.id).sort((a, b) => a - b);
    S._skillDirty = true;
  };
  net.onSkillCast = (msg) => {
    S.skillCastFeedback = msg;
    const sd = skillDef(msg.skillId);
    if (msg.ok) {
      toast(`释放【${sd.name}】`, 'ok');
      const cdEntry = S.learnedSkills.find((s) => s.id === msg.skillId);
      if (cdEntry && sd.cooldownMs > 0) {
        cdEntry.cdMs = sd.cooldownMs;
        S._cdRefMs = performance.now();
        S._skillDirty = true;
      }
      // 瞬发位移技能：本地预测位移，避免服务端 correction 导致橡皮筋
      if (sd.dashDist > 0 && msg.castTimeMs === 0 && S.predictor) {
        const p = S.predictor.predicted();
        const dx = msg.x - p.x, dz = msg.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          const ux = dx / len, uz = dz / len;
          S.predictor.correction(p.x + ux * sd.dashDist, p.y, p.z + uz * sd.dashDist);
        }
      }
      if (msg.castTimeMs > 0) {
        if (sd.target === 2) {
          // ENEMY 单体技能：前摇阶段发射追踪射线（玩家本地预测）
          const p = S.predictor ? S.predictor.predicted() : null;
          const fromX = p ? p.x : (S._self ? S._self.x : 0);
          const fromZ = p ? p.z : (S._self ? S._self.z : 0);
          const dist = Math.hypot(msg.x - fromX, msg.z - fromZ);
          if (dist > 0.5) {
            const fxPattern = { fire: 'fire', ice: 'ice', lightning: 'lightning', shadow: 'smoke', holy: 'holy', snipe: 'snipe', lifesteal: 'lifesteal', thunder: 'thunder', slash: 'slash' }[sd.fxType] || 'ring';
            const initAng = Math.atan2(msg.z - fromZ, msg.x - fromX);
            S.renderer.addSkillEffect({ kind: 'projectile', x1: fromX, z1: fromZ, x2: msg.x, z2: msg.z, initAng, color: '#ff8c1a', pattern: fxPattern, durMs: msg.castTimeMs });
          }
        } else {
          const circR = sd.radius;
          if (circR > 0) {
            S.renderer.addSkillEffect({
              kind: 'cast', wid: net.selfWid, casterWid: net.selfWid,
              x: msg.x, z: msg.z,
              color: '#ff8c1a', radius: circR,
              durMs: msg.castTimeMs,
            });
          }
        }
      }
      // 注：瞬发 ENEMY 单体技能的射线由 EVT_SKILL 统一创建（此处不处理 castTimeMs===0）
    } else {
      // 施放失败（服务端二次校验未通过：目标移出范围/死亡等）
      // 重置客户端冷却（beginCast 成功时已进入冷却，resolveCast 失败后需回滚）
      const cdEntry = S.learnedSkills.find((s) => s.id === msg.skillId);
      if (cdEntry) { cdEntry.cdMs = 0; S._skillDirty = true; }
      // 清除前摇视觉（蓄力圈）
      if (S.renderer) S.renderer.clearCasting(net.selfWid);
      toast(`【${sd.name}】施放失败（目标超出范围/已死亡）`);
    }
    renderSkillBar(); S._skillDirty = false;
  };
  net.onBuffs = (msg) => { S.myBuffs = msg.buffs; S._buffDirty = true; };

  // ---- 控制台 ----
  net.onConsole = (msg) => {
    protocolLog('s2c', { type: 'CONSOLE', text: msg.text });
    appendConsoleOutput(msg.text);
  };

  // ---- 任务系统回调 ----
  net.onQuestList = (payload) => { decodeQuestList(new Reader(payload)); if (S.npcDialogOpen) refreshNpcDialog(); };
  net.onQuestProgress = (payload) => { decodeQuestProgress(new Reader(payload)); if (S.npcDialogOpen) refreshNpcDialog(); };
  net.onQuestResult = (payload) => {
    const res = decodeQuestResult(new Reader(payload));
    // 接受/放弃/提交成功后刷新可接任务列表
    if (res.code === 0) sendQuestList(net);
  };
  net.onQuestComplete = (payload) => decodeQuestComplete(new Reader(payload));
  net.onQuestNotify = (payload) => decodeQuestNotify(new Reader(payload));
  net.onNpcDialogue = (msg) => {
    S.currentNpcDialogue = msg.dialogue || '';
    if (S.npcDialogOpen && S.currentNpcDialogue) $('npc-dialog-text').textContent = S.currentNpcDialogue;
  };
  net.onQuestChain = (payload) => {
    decodeQuestChain(new Reader(payload));
    if (S.npcDialogOpen) { sendQuestList(net, S.currentNpcWid); setTimeout(refreshNpcDialog, 200); }
  };
  initQuestUI(net);
  initConsole(net);
  initAutobotUI(net);

  // ---- 社交系统回调 ----
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
  initSocialUI(net);

  // ---- 服务端位置校正 / 踢出 / 协议监控 ----
  net.onSelf = (msg) => {
    S.predictor.correction(msg.x, msg.y, msg.z);
    S.entities.setSelf(msg.x, msg.y, msg.z);
    console.warn('[prediction] 服务端回退:', msg.reason, msg.x.toFixed(2), msg.y.toFixed(2), msg.z.toFixed(2));
  };
  net.onKick = (msg) => {
    $('hud-conn').textContent = '已断开（' + (msg.reason || '违规') + '）';
    $('hud-conn').className = 'hud-status-chip off';
    S.running = false;
    net.close();
  };
  net.onProtocol = (dir, msg) => protocolLog(dir, msg);
  net.onBytes = (n) => { window.__ewBytes = (window.__ewBytes || 0) + n; };

  // ---- 启动主循环 ----
  setLoadingText('进入世界…');
  hideLogin();
  S.running = true;
  S.lastT = performance.now();
  requestAnimationFrame(loop);
}

// ============================================================================
// 协议监控挂载
// ============================================================================
window.__ewProtocolLog = protocolLog;

// ============================================================================
// 全局暂停 / 恢复
// ============================================================================
window.__ewPause = () => { S.running = false; };
window.__ewResume = () => {
  if (S.running) return;
  S.running = true;
  S.lastT = performance.now();
  requestAnimationFrame(loop);
};

// ============================================================================
// DOMContentLoaded — UI 事件绑定
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  // 面板关闭按钮
  const ic = $('inv-close'); if (ic) ic.addEventListener('click', closeInventoryPanel);
  const sc = $('shop-close'); if (sc) sc.addEventListener('click', closeShopPanel);

  // 协议监控折叠
  const pt = $('proto-toggle');
  if (pt) pt.addEventListener('click', () => {
    const panel = $('proto-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    pt.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
  });

  // 调试面板
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

  // ── 自动化测试插件（autobot.js）：开始/暂停合并为一个切换按钮 ──
  const abToggle = $('ab-toggle');
  if (abToggle) abToggle.addEventListener('click', () => {
    if (autobot.isRunning()) autobot.pause(); // 运行中 → 暂停
    else autobot.start();                      // 停止/已暂停 → 开始/继续
  });
  // 决策循环（主循环外独立节流，不侵入渲染帧）
  setInterval(() => autobot.tick(performance.now()), 200);
  // 刷新页面后若上次运行中 → 自动恢复
  autobot.restore();

  // 游戏菜单
  const gm = $('game-menu');
  if (gm) {
    gm.addEventListener('click', (e) => {
      const btn = e.target.closest('.gm-btn');
      if (!btn || btn.classList.contains('gm-disabled')) return;
      switch (btn.dataset.action) {
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

  // 铁匠面板关闭 + 页签切换
  const ec = $('enhance-close');
  if (ec) ec.addEventListener('click', closeEnhancePanel);
  const ste = $('smith-tab-enhance');
  if (ste) ste.addEventListener('click', () => switchSmithTab('enhance'));
  const std = $('smith-tab-decompose');
  if (std) std.addEventListener('click', () => switchSmithTab('decompose'));

  // 合成面板关闭
  const cc = $('craft-close');
  if (cc) cc.addEventListener('click', closeCraftPanel);

  // 仓库面板关闭
  const wc = $('warehouse-close');
  if (wc) wc.addEventListener('click', closeWarehousePanel);

  // 背包右键菜单：全局关闭
  document.addEventListener('click', () => closeInvMenu());
  document.addEventListener('contextmenu', (ev) => { if (S.invMenuEl && !S.invMenuEl.contains(ev.target)) closeInvMenu(); });
  window.addEventListener('blur', () => closeInvMenu());
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeInvMenu(); });
});
