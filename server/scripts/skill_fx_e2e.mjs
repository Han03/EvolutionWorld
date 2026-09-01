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
  await page.fill('#username', uname);
  await page.fill('#password', 'pass1234');
  await page.click('#btn-register');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
  await page.waitForFunction(() => window.__ewFrames > 2, null, { timeout: 30000 });
  await page.waitForTimeout(1200); // 视野加载

  const entCount = await page.evaluate(() => window.__ewEntities ? window.__ewEntities.views.size : 0);
  console.log('视野实体数:', entCount);

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
  await page.keyboard.down('KeyA'); // 向左移动 → 打断
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(150);
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
