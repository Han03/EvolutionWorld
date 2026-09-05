#!/usr/bin/env node
/**
 * skill_fx_e2e.mjs - 浏览器端到端验证「技能前摇/释放/范围」客户端简易效果
 * 验证点：
 *  1) 按 2（烈焰冲击，前摇600ms + AOE 4m）→ 施法者身上出现前摇进度圈、落点出现 AOE 范围圈
 *  2) 渲染器 effects 队列出现 cast/aoe 效果
 *  3) 移动打断 → 前摇圈被清除（EVT_SKILL_CANCEL）
 *  4) 截图记录
 * 用法: node scripts/skill_fx_e2e.mjs <outdir>
 */
import { chromium } from '/opt/vm/preinstall/npm-global/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';

const OUT = process.argv[2] || './artifacts';
mkdirSync(OUT, { recursive: true });
const FLAGS = [
  '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
  '--use-angle=swiftshader-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
];

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome',
    args: FLAGS,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  const base = 'http://localhost:3000';
  const uname = 'fx' + Date.now() % 100000000;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.fill('#ew-login-user', uname);
  await page.fill('#ew-login-pass', 'pass1234');
  await page.click('#ew-btn-register');
  await page.waitForTimeout(300);
  await page.click('#ew-btn-login');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
  await page.waitForFunction(() => window.__ewFrames > 2, null, { timeout: 30000 });
  // 等待视野实体加载（而非固定超时）
  await page.waitForFunction(() => window.__ewEntities && window.__ewEntities.views && window.__ewEntities.views.size > 1, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const entCount = await page.evaluate(() => window.__ewEntities ? window.__ewEntities.views.size : 0);
  console.log('视野实体数:', entCount);

  // 出生点安全区无怪，需传送到怪物附近才能施放技能（1002 射程 3.5m）
  const token = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ew_session') || '{}').token || ''; } catch(_) { return ''; }
  });
  if (token) {
    // 获取视野内一只怪物的位置
    const monsterPos = await page.evaluate(() => {
      if (!window.__ewEntities) return null;
      for (const [, e] of window.__ewEntities.views) {
        if (e.kind === 1) return { x: e.x, z: e.z };  // kind=1 = Monster
      }
      return null;
    });
    if (monsterPos) {
      console.log('传送到怪物附近:', JSON.stringify(monsterPos));
      const tpRes = await fetch(base + '/api/debug/teleport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, x: monsterPos.x, z: monsterPos.z }),
      });
      const tpJson = await tpRes.json();
      console.log('传送结果:', tpJson.ok ? '成功' : JSON.stringify(tpJson));
      await page.waitForTimeout(1500);  // 等待新视野加载
    } else {
      console.log('视野内无怪物，尝试在原地施放（可能超出距离）');
    }
  }

  // 1002（烈焰冲击，前摇600ms + AOE 4m）是起始技能，直接按 2 施放
  await page.keyboard.press("Digit2"); // 施放 1002
  await page.waitForTimeout(150);   // 前摇中：截图（应有金色前摇圈 + 橙色 AOE 圈）
  await page.screenshot({ path: OUT + '/fx-01-casting.png' });

  const mid = await page.evaluate(() => {
    const fx = window.__ewFx ? window.__ewFx() : null;
    return fx;
  });
  console.log('施放中 effects:', JSON.stringify(mid));

  // 等待前摇结束（>600ms）→ AOE 结算圈仍在淡出
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT + '/fx-02-resolve.png' });

  // 再次施放（用 1003 治疗之光，前摇500ms，避免 1002 冷却）并立即移动 → 打断（前摇圈应被清除）
  await page.keyboard.press("Digit3");
  await page.waitForTimeout(120);
  const castSeen = await page.evaluate(() => {
    const fx = window.__ewFx ? window.__ewFx() : null;
    return fx ? fx.some((e) => e.kind === 'cast') : false;
  });
  console.log('移动前有前摇圈:', castSeen);
  console.log('Digit3 后 fx:', JSON.stringify(await page.evaluate(() => window.__ewFx ? window.__ewFx() : null)));
  const protoText = await page.evaluate(() => {
    const box = document.getElementById('proto-log');
    return box ? box.textContent.slice(-600) : '';
  });
  console.log('协议日志尾部:', protoText.replace(/\n/g, ' | ').slice(-500));
  // 移动打断：用点击移动代替键盘（新版移动系统已移除 WASD）
  const canvasBox2 = await page.$('canvas');
  if (canvasBox2) {
    const box = await canvasBox2.boundingBox();
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/fx-03-cancel.png' });
  const afterCancel = await page.evaluate(() => {
    const fx = window.__ewFx ? window.__ewFx() : null;
    return fx ? fx.filter((e) => e.kind === 'cast').length : -1;
  });
  console.log('打断后前摇圈数量(0=已清除):', afterCancel);

  console.log('页面JS错误数:', errors.length);
  if (errors.length) console.log(errors.join('\n'));
  await browser.close();
  console.log('done');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
