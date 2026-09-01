/**
 * WebSocket 网关冒烟测试（自包含）
 * 运行：npm run test:api
 * 流程：注册一个临时账号 → HTTP 登录拿 token → WebSocket 连接 → 收到 welcome → 发送移动/跳跃输入 → 收到 snapshot
 */
import WebSocket from 'ws';

const BASE = process.env.EW_BASE || 'http://localhost:3000';
const WS = BASE.replace(/^http/, 'ws');

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const user = 'smoke' + Date.now().toString(36);
const pass = 'smokepass123';

const reg = await post('/api/register', { username: user, password: pass });
console.log('注册:', reg.ok ? 'OK' : reg.error);

const login = await post('/api/login', { username: user, password: pass });
if (!login.ok) {
  console.error('登录失败:', login.error);
  process.exit(1);
}
console.log('登录: OK, world=', JSON.stringify(login.world));

const ws = new WebSocket(`${WS}/ws?token=${login.token}`);
let welcomeOk = false;
let snapOk = false;
let t0 = Date.now();

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'input', seq: 1, moveX: 1, moveZ: 0, jump: false }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'input', seq: 2, moveX: 0, moveZ: 0, jump: true })), 400);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'welcome') {
    welcomeOk = true;
    console.log('welcome: entityId=', m.entityId, 'username=', m.username);
  }
  if (m.type === 'snapshot') {
    snapOk = true;
    console.log(`snapshot: tick=${m.tick} count=${m.count} (可见范围 ${m.viewRange}m)`);
  }
  if (welcomeOk && snapOk) {
    console.log(`通过（${Date.now() - t0}ms）`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('超时: welcome=', welcomeOk, 'snapshot=', snapOk);
  process.exit(1);
}, 8000);
