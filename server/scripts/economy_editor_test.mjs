#!/usr/bin/env node
/**
 * economy_editor_test.mjs - 阶段7 编辑器经济配置 HTTP 接口端到端验证
 * 覆盖验收标准：编辑 → 保存 → 服务端热重载 → 回读一致
 *  1) GET /api/gamedata：含 enhance/decompose/craft/shops 四类配置
 *  2) 鉴权：无效 token 对 4 个 edit 端点均被拒(401)
 *  3) POST /api/enhance/edit：改 maxLevel + 某级 successRate/goldCost → 回读一致
 *  4) POST /api/decompose/edit：改某档 goldReturnRate + 新增产出材料 → 回读一致
 *  5) POST /api/craft/edit：改某配方 goldCost/levelReq + 新增材料 → 回读一致
 *  6) POST /api/shop/edit：改某商品 price/discountPrice/buyLimit + 新增商店 → 回读一致
 *  7) 还原全部原始配置（避免污染运行时内存/落库）
 * 服务端需在 localhost:3000 运行（register/login 公开；edit 接口需登录 token）
 */
const BASE = process.env.EW_TEST_BASE || 'http://localhost:3000';
const UN = 'ecedit' + Math.floor(Math.random() * 100000);
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name} ${extra}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}
async function req(path, method, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  let j = null;
  try { j = await r.json(); } catch (_) { /* 忽略非 JSON */ }
  return { status: r.status, j };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

async function main() {
  // 1) GET /api/gamedata：四类经济配置齐备
  console.log('[1] GET /api/gamedata 经济配置齐备');
  const g0 = await req('/api/gamedata', 'GET');
  check('GET /api/gamedata ok', g0.status === 200 && g0.j && g0.j.ok === true, `status=${g0.status}`);
  const enh0 = g0.j && g0.j.enhance;
  const dec0 = g0.j && g0.j.decompose;
  const craft0 = g0.j && g0.j.craft;
  const shops0 = g0.j && g0.j.shops;
  check('enhance 含 levels 数组', enh0 && Array.isArray(enh0.levels) && enh0.levels.length > 0, `levels=${enh0 && enh0.levels.length}`);
  check('decompose 含 rules 数组', dec0 && Array.isArray(dec0.rules) && dec0.rules.length > 0, `rules=${dec0 && dec0.rules.length}`);
  check('craft 含 recipes 数组', craft0 && Array.isArray(craft0.recipes) && craft0.recipes.length > 0, `recipes=${craft0 && craft0.recipes.length}`);
  check('shops 为非空对象', shops0 && typeof shops0 === 'object' && Object.keys(shops0).length > 0, `shops=${shops0 && Object.keys(shops0).length}`);

  // 2) 登录取 token；无效 token 对 4 端点均被拒
  console.log('[2] 鉴权');
  await req('/api/register', 'POST', { username: UN, password: 'pass1234' }).catch(() => {});
  const lg = await req('/api/login', 'POST', { username: UN, password: 'pass1234' });
  const token = lg.j && lg.j.token;
  check('登录取得 token', !!token);
  const bad = 'invalid-token-xxx';
  const a1 = await req('/api/enhance/edit', 'POST', { token: bad, enhance: enh0 });
  const a2 = await req('/api/decompose/edit', 'POST', { token: bad, decompose: dec0 });
  const a3 = await req('/api/craft/edit', 'POST', { token: bad, craft: craft0 });
  const a4 = await req('/api/shop/edit', 'POST', { token: bad, shops: shops0 });
  check('enhance/edit 无效 token 被拒(401)', a1.status === 401 && a1.j && a1.j.ok === false, `status=${a1.status}`);
  check('decompose/edit 无效 token 被拒(401)', a2.status === 401 && a2.j && a2.j.ok === false, `status=${a2.status}`);
  check('craft/edit 无效 token 被拒(401)', a3.status === 401 && a3.j && a3.j.ok === false, `status=${a3.status}`);
  check('shop/edit 无效 token 被拒(401)', a4.status === 401 && a4.j && a4.j.ok === false, `status=${a4.status}`);

  // 3) 强化：改 maxLevel + 首级 successRate/goldCost → 回读一致
  console.log('[3] POST /api/enhance/edit + 回读');
  const enhMod = clone(enh0);
  enhMod.maxLevel = 12;
  enhMod.attrPerLevelAtk = 0.1;
  enhMod.levels[0].successRate = 0.75;
  enhMod.levels[0].goldCost = 4321;
  const pe = await req('/api/enhance/edit', 'POST', { token, enhance: enhMod });
  check('enhance/edit ok', pe.status === 200 && pe.j && pe.j.ok === true, `status=${pe.status} count=${pe.j && pe.j.count}`);
  const gE = await req('/api/gamedata', 'GET');
  const enhB = gE.j && gE.j.enhance;
  check('强化 maxLevel 回读=12', enhB && enhB.maxLevel === 12, `maxLevel=${enhB && enhB.maxLevel}`);
  check('强化 attrPerLevelAtk 回读=0.1', enhB && Math.abs(enhB.attrPerLevelAtk - 0.1) < 1e-9, `atk=${enhB && enhB.attrPerLevelAtk}`);
  check('强化 Lv1 successRate 回读=0.75', enhB && Math.abs(enhB.levels[0].successRate - 0.75) < 1e-9, `rate=${enhB && enhB.levels[0].successRate}`);
  check('强化 Lv1 goldCost 回读=4321', enhB && enhB.levels[0].goldCost === 4321, `gold=${enhB && enhB.levels[0].goldCost}`);

  // 4) 分解：改首档 goldReturnRate + 新增产出材料 → 回读一致
  console.log('[4] POST /api/decompose/edit + 回读');
  const decMod = clone(dec0);
  decMod.rules[0].goldReturnRate = 0.66;
  decMod.rules[0].enhanceStoneRate = 0.88;
  decMod.rules[0].results.push({ itemId: 4001, minCount: 2, maxCount: 5, prob: 0.5 });
  const pd = await req('/api/decompose/edit', 'POST', { token, decompose: decMod });
  check('decompose/edit ok', pd.status === 200 && pd.j && pd.j.ok === true, `status=${pd.status} count=${pd.j && pd.j.count}`);
  const gD = await req('/api/gamedata', 'GET');
  const decB = gD.j && gD.j.decompose;
  check('分解 首档 goldReturnRate 回读=0.66', decB && Math.abs(decB.rules[0].goldReturnRate - 0.66) < 1e-9, `rate=${decB && decB.rules[0].goldReturnRate}`);
  check('分解 首档 enhanceStoneRate 回读=0.88', decB && Math.abs(decB.rules[0].enhanceStoneRate - 0.88) < 1e-9, `stone=${decB && decB.rules[0].enhanceStoneRate}`);
  const addedRes = decB && decB.rules[0].results.find((x) => x.itemId === 4001 && x.minCount === 2 && x.maxCount === 5);
  check('分解 首档新增材料(4001,2-5)回读一致', !!addedRes && Math.abs(addedRes.prob - 0.5) < 1e-9, addedRes ? `prob=${addedRes.prob}` : 'missing');

  // 5) 合成：改首配方 goldCost/levelReq + 新增材料 → 回读一致
  console.log('[5] POST /api/craft/edit + 回读');
  const craftMod = clone(craft0);
  const r0 = craftMod.recipes[0];
  r0.goldCost = 777;
  r0.levelReq = 9;
  r0.hidden = true;
  r0.materials.push({ itemId: 4002, count: 3 });
  const pc = await req('/api/craft/edit', 'POST', { token, craft: craftMod });
  check('craft/edit ok', pc.status === 200 && pc.j && pc.j.ok === true, `status=${pc.status} count=${pc.j && pc.j.count}`);
  const gC = await req('/api/gamedata', 'GET');
  const craftB = gC.j && gC.j.craft;
  const rb = craftB && craftB.recipes.find((x) => x.recipeId === r0.recipeId);
  check('合成 首配方 goldCost 回读=777', rb && rb.goldCost === 777, `gold=${rb && rb.goldCost}`);
  check('合成 首配方 levelReq 回读=9', rb && rb.levelReq === 9, `lv=${rb && rb.levelReq}`);
  check('合成 首配方 hidden 回读=true', rb && rb.hidden === true, `hidden=${rb && rb.hidden}`);
  const addedMat = rb && rb.materials.find((x) => x.itemId === 4002 && x.count === 3);
  check('合成 首配方新增材料(4002×3)回读一致', !!addedMat);

  // 6) 商店：改某商品 price/discount/buyLimit + 新增商店 → 回读一致
  console.log('[6] POST /api/shop/edit + 回读');
  const shopsMod = clone(shops0);
  const firstSid = Object.keys(shopsMod)[0];
  const firstShop = shopsMod[firstSid];
  if (firstShop.entries && firstShop.entries.length) {
    firstShop.entries[0].price = 5555;
    firstShop.entries[0].discountPrice = 4444;
    firstShop.entries[0].buyLimit = 6;
    firstShop.entries[0].sellPrice = 2222;
  }
  // 新增一个测试商店（键=99901）
  shopsMod['99901'] = { name: '测试商店EC', desc: '阶段7验证', shopType: 1, currencyItemId: 0, entries: [{ item: 2001, price: 100, discountPrice: 80, stock: 10, buyLimit: 2, category: 2, refreshType: 1, sellPrice: 50 }] };
  const ps = await req('/api/shop/edit', 'POST', { token, shops: shopsMod });
  check('shop/edit ok', ps.status === 200 && ps.j && ps.j.ok === true, `status=${ps.status} count=${ps.j && ps.j.count}`);
  const gS = await req('/api/gamedata', 'GET');
  const shopsB = gS.j && gS.j.shops;
  const fb = shopsB && shopsB[firstSid];
  if (fb && fb.entries && fb.entries.length) {
    const e0 = fb.entries[0];
    check('商店 首商品 price 回读=5555', e0.price === 5555, `price=${e0.price}`);
    check('商店 首商品 discountPrice 回读=4444', e0.discountPrice === 4444, `disc=${e0.discountPrice}`);
    check('商店 首商品 buyLimit 回读=6', e0.buyLimit === 6, `limit=${e0.buyLimit}`);
    check('商店 首商品 sellPrice 回读=2222', e0.sellPrice === 2222, `sell=${e0.sellPrice}`);
  } else {
    check('商店 首商品字段回读', false, '首商店无条目');
  }
  const newShop = shopsB && shopsB['99901'];
  check('商店 新增(99901)回读存在', !!newShop && newShop.name === '测试商店EC', newShop ? newShop.name : 'missing');
  check('商店 新增(99901)shopType=1', newShop && newShop.shopType === 1, `type=${newShop && newShop.shopType}`);
  check('商店 新增(99901)条目字段一致', newShop && newShop.entries && newShop.entries[0] && newShop.entries[0].item === 2001 && newShop.entries[0].stock === 10 && newShop.entries[0].refreshType === 1);

  // 7) 还原全部原始配置
  console.log('[7] 还原原始配置');
  await req('/api/enhance/edit', 'POST', { token, enhance: enh0 });
  await req('/api/decompose/edit', 'POST', { token, decompose: dec0 });
  await req('/api/craft/edit', 'POST', { token, craft: craft0 });
  await req('/api/shop/edit', 'POST', { token, shops: shops0 });
  const gR = await req('/api/gamedata', 'GET');
  const enhR = gR.j && gR.j.enhance;
  const decR = gR.j && gR.j.decompose;
  const craftR = gR.j && gR.j.craft;
  const shopsR = gR.j && gR.j.shops;
  check('还原后 enhance.maxLevel 复原', enhR && enhR.maxLevel === enh0.maxLevel, `maxLevel=${enhR && enhR.maxLevel}`);
  check('还原后 enhance.Lv1.goldCost 复原', enhR && enhR.levels[0].goldCost === enh0.levels[0].goldCost, `gold=${enhR && enhR.levels[0].goldCost}`);
  check('还原后 decompose 首档 goldReturnRate 复原', decR && Math.abs(decR.rules[0].goldReturnRate - dec0.rules[0].goldReturnRate) < 1e-9, `rate=${decR && decR.rules[0].goldReturnRate}`);
  check('还原后 decompose 首档材料数复原', decR && decR.rules[0].results.length === dec0.rules[0].results.length, `n=${decR && decR.rules[0].results.length}`);
  const rr = craftR && craftR.recipes.find((x) => x.recipeId === r0.recipeId);
  check('还原后 craft 首配方 goldCost 复原', rr && rr.goldCost === craft0.recipes[0].goldCost, `gold=${rr && rr.goldCost}`);
  check('还原后 craft 首配方材料数复原', rr && rr.materials.length === craft0.recipes[0].materials.length, `n=${rr && rr.materials.length}`);
  check('还原后 shops 不含测试商店(99901)', shopsR && !shopsR['99901']);
  const fr = shopsR && shopsR[firstSid];
  check('还原后 商店首商品 price 复原', fr && fr.entries && fr.entries[0] && fr.entries[0].price === shops0[firstSid].entries[0].price, `price=${fr && fr.entries && fr.entries[0] && fr.entries[0].price}`);

  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
