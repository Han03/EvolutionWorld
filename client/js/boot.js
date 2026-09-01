/**
 * EvolutionWorld 客户端入口
 * 流程：登录（HTTP）→ 建立 WebSocket → 进入 3D 世界 → 主循环
 */
import { NetworkClient } from './network.js';
import { InputState } from './input.js';
import { createRenderer } from './renderer.js';
import { EntityViewManager } from './entities.js';
import { Predictor } from './predict.js';

const $ = (id) => document.getElementById(id);
const overlay = $('login-overlay');
const loading = $('loading');
const hud = $('hud');
const net = new NetworkClient();

// 全局错误展示（便于排查与用户反馈）
window.addEventListener('error', (e) => {
  $('loading-text').textContent = '客户端错误：' + (e.message || 'unknown');
  console.error(e.error || e);
});
window.addEventListener('unhandledrejection', (e) => {
  $('loading-text').textContent = '客户端错误：' + (e.reason?.message || e.reason);
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

// ---------------- 登录 UI ----------------

function showMsg(text, ok) {
  const el = $('login-msg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}

async function doLogin(username, password) {
  showMsg('登录中…', false);
  try {
    const data = await net.login(username, password);
    await enterWorld(data.token, data.user.username, data.world);
  } catch (e) {
    showMsg(e.message);
  }
}

async function doRegister(username, password) {
  showMsg('注册中…', false);
  try {
    await net.register(username, password);
    await doLogin(username, password);
  } catch (e) {
    showMsg(e.message);
  }
}

$('btn-login').addEventListener('click', () =>
  doLogin($('username').value.trim(), $('password').value)
);
$('btn-register').addEventListener('click', () =>
  doRegister($('username').value.trim(), $('password').value)
);
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  doLogin($('username').value.trim(), $('password').value);
});

// ---------------- 进入世界 ----------------

async function enterWorld(token, username, worldMeta) {
  overlay.classList.add('hidden');
  loading.classList.remove('hidden');
  $('loading-text').textContent = '连接世界中…';

  try {
    // 先挂回调，再建立连接（welcome 可能立刻到达）
    net.onHello = (msg) => {
      hud.classList.remove('hidden');
      $('hud-user').textContent = net.selfName;
      $('hud-conn').textContent = '已连接';
      $('hud-conn').className = 'hud-chip on';
    };
    net.onDisconnect = () => {
      $('hud-conn').textContent = '连接断开';
      $('hud-conn').className = 'hud-chip off';
    };
    await net.connect(token);
  } catch (e) {
    loading.classList.add('hidden');
    overlay.classList.remove('hidden');
    showMsg('连接失败：' + e.message);
    return;
  }

  // 等待 hello（拿到 selfWid 与世界参数）
  if (!net.hello) {
    await new Promise((resolve) => {
      const old = net.onHello;
      net.onHello = (msg) => {
        old && old(msg);
        resolve();
      };
    });
  }
  $('loading-text').textContent = '初始化渲染器…';

  // 初始化 3D
  try {
    renderer = createRenderer($('app'));
  } catch (e) {
    $('loading-text').textContent = '渲染器错误：' + (e && e.message ? e.message : e);
    console.error(e);
    throw e;
  }
  $('loading-text').textContent = '创建实体管理器…';
  try {
    entities = new EntityViewManager(net.selfWid);
  } catch (e) {
    $('loading-text').textContent = '实体管理器错误：' + (e && e.message ? e.message : e);
    console.error(e);
    throw e;
  }
  window.__ewEntities = entities; // 测试/调试钩子
  input = new InputState(renderer.canvas);
  window.__ewInput = input;
  // 本地预测器：从 hello 位置起步
  predictor = new Predictor();
  if (net.hello && net.hello.self) {
    predictor.setPosition(net.hello.self.x, net.hello.self.y, net.hello.self.z);
    entities.setSelf(net.hello.self.x, net.hello.self.y, net.hello.self.z);
  }
  window.__ewPredictor = predictor; // 测试/调试钩子
  $('loading-text').textContent = '接收世界数据…';

  // 二进制协议：AOI 进出 + 增量 + 校准快照 + 预测回退
  net.onEnter = (ents) => entities.applyEnter(ents);
  net.onLeave = (wids) => entities.applyLeave(wids);
  net.onUpdate = (ups) => entities.applyUpdate(ups);
  net.onSnapshot = (snap) => entities.applySnapshot(snap.entities);

  net.onSelf = (msg) => {
    // 服务端后校验不通过 → 回退到权威位置
    predictor.correction(msg.x, msg.y, msg.z);
    entities.setSelf(msg.x, msg.y, msg.z);
    console.warn('[prediction] 服务端回退:', msg.reason, msg.x.toFixed(2), msg.y.toFixed(2), msg.z.toFixed(2));
  };

  net.onKick = (msg) => {
    $('hud-conn').textContent = '已断开（' + (msg.reason || '违规') + '）';
    $('hud-conn').className = 'hud-chip off';
    running = false;
    net.close();
  };
  // 协议透传转换：把每次二进制帧解码结果实时投递到监控面板
  net.onProtocol = (dir, msg) => protocolLog(dir, msg);
  net.onBytes = (n) => {
    window.__ewBytes = (window.__ewBytes || 0) + n;
  };

  $('loading-text').textContent = '进入世界…';
  loading.classList.add('hidden');
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
    case 'INPUT': detail = `seq=${msg.seq} mv=(${msg.moveX},${msg.moveZ}) jump=${msg.jump}`; break;
    default: detail = JSON.stringify(msg).slice(0, 80); break;
  }
  line.textContent = `[${dir === 's2c' ? '↓S2C' : '↑C2S'}] ${t} ${detail}`;
  box.appendChild(line);
  while (box.childNodes.length > 40) box.removeChild(box.firstChild);
}
// 供测试/调试挂载协议监控（渲染启动后设置）
window.__ewProtocolLog = protocolLog;

// ---------------- 主循环 ----------------

function loop(now) {
  if (!running) return;
  const rawDt = (now - lastT) / 1000;         // 真实墙钟 dt（预测器用，保证实时推进）
  const dt = Math.min(0.1, rawDt);            // 插值/HUD 用 dt（防止爆炸）
  lastT = now;

  // 1) 读取输入 → 本地预测即时生效
  const mv = input.moveVector();
  inputAcc += dt;
  // 与服务端同频（20Hz）发送并推进预测
  if (inputAcc >= 0.05) {
    inputAcc -= 0.05;
    const jump = input.takeJump();
    predictor.applyInput(mv.x, mv.z, jump);
    const pred = predictor.predicted();
    net.sendInput(mv.x, mv.z, jump, pred);
  }

  // 2) 推进预测（内部按 50ms 步进；用真实 dt 保持与服务端实时同步），插值位置驱动自身渲染
  const selfPos = predictor.step(rawDt);
  net.setRef(selfPos.x, selfPos.y, selfPos.z); // 二进制相对坐标解码基准
  entities.setSelf(selfPos.x, selfPos.y, selfPos.z);

  // 3) 其他实体插值
  entities.update(dt);
  // 地形流式加载（俯视 MMO：仅加载玩家可见范围内区块，超出卸载）+ 绘制
  renderer.updateTerrain(selfPos.x, selfPos.z);
  renderer.setSelf(selfPos.x, selfPos.y, selfPos.z, net.selfName);
  renderer.setEntities(entities.forRender());
  renderer.draw();

  // 4) HUD
  fpsAcc += dt;
  fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    $('hud-fps').textContent = `fps:${fps}`;
    $('hud-pos').textContent = `x:${selfPos.x.toFixed(1)} y:${selfPos.y.toFixed(1)} z:${selfPos.z.toFixed(1)}`;
    const b = $('proto-bps');
    if (b && window.__ewBytes) b.textContent = (window.__ewBytes / 1024).toFixed(1) + 'KB';
    fpsAcc = 0;
    fpsCount = 0;
  }

  window.__ewFrames = (window.__ewFrames || 0) + 1;
  requestAnimationFrame(loop);
}

// 供自动化测试暂停/恢复渲染（不影响正常用户）
window.__ewPause = () => {
  running = false;
};
window.__ewResume = () => {
  if (running) return;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
};
