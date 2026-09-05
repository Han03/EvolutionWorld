#!/usr/bin/env node
/**
 * browser_e2e.mjs - 浏览器端到端验证（Playwright + SwiftShader 软渲染）
 * 验证：登录 → 进入 3D 世界 → 预测移动 → 截图
 * 用法: node browser_e2e.mjs <outdir>
 */
import { chromium } from '/opt/vm/preinstall/npm-global/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'fs';

const OUT = process.argv[2] || './artifacts';
mkdirSync(OUT, { recursive: true });

const FLAGS = [
  '--no-sandbox',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader-webgl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
];

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome',
    args: FLAGS,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  const base = 'http://localhost:3000';
  const uname = 'bw' + Date.now() % 100000000;

  // 注册 + 登录
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.fill('#ew-login-user', uname);
  await page.fill('#ew-login-pass', 'pass1234');
  await page.click('#ew-btn-register');
  // 注册后需点击登录按钮
  await page.waitForTimeout(300);
  await page.click('#ew-btn-login');
  // 等待进入世界
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
  await page.waitForFunction(() => window.__ewFrames > 2, null, { timeout: 30000 });
  await page.waitForTimeout(1500); // 等几帧渲染
  await page.evaluate(() => window.__ewPause && window.__ewPause());

  const info1 = await page.evaluate(() => ({
    conn: document.getElementById('hud-conn')?.textContent,
    pos: document.getElementById('hud-pos')?.textContent,
    frames: window.__ewFrames,
    predictor: !!(window.__ewPredictor),
    entities: window.__ewEntities ? [...window.__ewEntities.views.keys()].length : 0,
  }));
  console.log('enter-world:', JSON.stringify(info1));
  await page.evaluate(() => window.__ewPause && window.__ewPause());
  await page.screenshot({ path: OUT + '/cpp-01-world.png' });

  // 模拟点击移动（新版鼠标点击 + A* 寻路）
  await page.evaluate(() => window.__ewResume && window.__ewResume());
  // 点击画布右侧远处位置触发点击移动
  const canvasBox = await page.$('canvas');
  if (canvasBox) {
    const box = await canvasBox.boundingBox();
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await page.waitForTimeout(2500);
  }
  await page.evaluate(() => window.__ewPause && window.__ewPause());
  const info2 = await page.evaluate(() => ({
    pos: document.getElementById('hud-pos')?.textContent,
    pred: window.__ewPredictor ? {
      z: window.__ewPredictor.pos.z.toFixed(1),
    } : null,
  }));
  console.log('after-move:', JSON.stringify(info2));
  await page.screenshot({ path: OUT + '/cpp-02-moved.png' });

  // 再次点击移动验证（确认寻路系统持续工作）
  await page.evaluate(() => window.__ewResume && window.__ewResume());
  if (canvasBox) {
    const box = await canvasBox.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => window.__ewPause && window.__ewPause());
  const info3 = await page.evaluate(() => ({
    pos: document.getElementById('hud-pos')?.textContent,
  }));
  console.log('after-second-move:', JSON.stringify(info3));
  await page.screenshot({ path: OUT + '/cpp-03-second-move.png' });

  await browser.close();
  console.log('done');
}

main().catch((e) => { console.error('E2E FAIL:', e); process.exit(1); });
