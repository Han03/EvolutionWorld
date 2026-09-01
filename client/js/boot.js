/**
 * EvolutionWorld 客户端入口
 * 流程：登录（HTTP）→ 建立 WebSocket → 进入 3D 世界 → 主循环
 */
import { NetworkClient } from './network.js';
import { InputState } from './input.js';
import { createRenderer } from './renderer.js';
import { EntityViewManager } from './entities.js';
import * as THREE from 'three';

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
let running = false;
let lastT = 0;
let fpsAcc = 0;
let fpsCount = 0;
let inputTimer = 0;

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
    net.onWelcome = (msg) => {
      hud.classList.remove('hidden');
      $('hud-user').textContent = msg.username;
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

  // 等待 welcome（拿到 selfId）
  if (!net.welcome) {
    await new Promise((resolve) => {
      const old = net.onWelcome;
      net.onWelcome = (msg) => {
        old && old(msg);
        resolve();
      };
    });
  }
  $('loading-text').textContent = '初始化渲染器…';

  // 初始化 3D
  renderer = createRenderer($('app'));
  $('loading-text').textContent = '创建实体管理器…';
  entities = new EntityViewManager(renderer.scene, net.selfId);
  window.__ewEntities = entities; // 测试/调试钩子
  input = new InputState(renderer.renderer.domElement);
  window.__ewInput = input;
  $('loading-text').textContent = '接收世界数据…';

  net.onSnapshot = (snap) => {
    entities.applySnapshot(snap.entities);
  };

  $('loading-text').textContent = '进入世界…';
  loading.classList.add('hidden');
  running = true;
  lastT = performance.now();
  requestAnimationFrame(loop);
}

// ---------------- 主循环 ----------------

function loop(now) {
  if (!running) return;
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  // 1) 输入 → 服务端（约 20Hz）
  inputTimer -= dt;
  if (inputTimer <= 0) {
    inputTimer = 0.05;
    const mv = input.moveVector();
    net.sendInput(mv.x, mv.z, input.takeJump());
  }

  // 2) 实体插值 + 相机跟随
  entities.update(dt);
  const target = new THREE.Vector3();
  entities.selfPosition(target);
  updateCamera(dt);

  // 3) 渲染
  renderer.updateTerrainUniforms(now / 1000);
  renderer.renderer.render(renderer.scene, renderer.camera);

  // 4) HUD
  fpsAcc += dt;
  fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    $('hud-fps').textContent = `fps:${fps}`;
    $('hud-pos').textContent = `x:${target.x.toFixed(1)} y:${target.y.toFixed(1)} z:${target.z.toFixed(1)}`;
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

function updateCamera() {
  const target = entities.selfPosition(new THREE.Vector3());
  const dist = 13;
  const cosP = Math.cos(input.pitch);
  const off = new THREE.Vector3(
    Math.sin(input.yaw) * dist * cosP,
    dist * Math.sin(input.pitch),
    Math.cos(input.yaw) * dist * cosP
  );
  renderer.camera.position.copy(target).add(off);
  renderer.camera.lookAt(target.x, target.y + 0.6, target.z);
}
