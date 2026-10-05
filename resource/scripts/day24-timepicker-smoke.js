/* [Day 24] 时间拨轮冒烟测试
 * 用 Playwright 真点一遍：弹窗能不能开 / 拨轮能不能选 / 结束是否跟随 / 零时长是否拦住 / Esc 是否关闭
 * 用法：NODE_PATH=<node_modules> node resource/scripts/day24-timepicker-smoke.js
 * 前置：source/ 目录已起静态服务（默认 http://127.0.0.1:8081/index.html）
 */
const { chromium } = require('playwright');

const URL = process.env.TP_URL || 'http://127.0.0.1:8081/index.html';
const OUT = 'D:/ima/VibeCoding/resource';
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  // ---- 1. 打开新建表单 ----
  await page.click('#btn-new');
  await page.waitForSelector('#item-form');
  const startSel = 'input[name="startTime"]';
  const endSel = 'input[name="endTime"]';
  check('新建表单渲染', true, '表单已出现');
  check('时间框为只读（禁止手打）', await page.getAttribute(startSel, 'readonly') !== null,
    'readonly=' + await page.getAttribute(startSel, 'readonly'));

  // ---- 2. 点开始时间 → 浮层弹出 ----
  await page.click(startSel);
  await page.waitForSelector('.tp-overlay:not([hidden])', { timeout: 2000 });
  const title = await page.textContent('#tp-title');
  check('点开始弹出拨轮', true, '标题=' + title);

  await page.waitForTimeout(300);
  const ih0 = await page.$eval('.tp-col[data-key="hour"] .tp-scroll', el => el.scrollTop);
  const selH = await page.$eval('.tp-col[data-key="hour"] .tp-item.is-sel', el => el.textContent);
  check('初始定位到输入框当前值（09 时）', ih0 === 9 * 34 && selH === '09',
    'hour scrollTop=' + ih0 + '（期望 306）/ 选中档=' + selH);

  await page.waitForTimeout(300);          // 等 120ms 弹出动画走完再量，否则量到的是动画起始帧
  const box = await page.locator('.tp').boundingBox();
  const anchor = await page.locator(startSel).boundingBox();
  const vp = await page.evaluate(() => ({ ih: window.innerHeight, iw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  const below = box.y >= anchor.y + anchor.height - 2 && box.y - (anchor.y + anchor.height) <= 20;
  const above = Math.abs((anchor.y - 6) - (box.y + box.height)) <= 20;
  check('浮层紧贴触发框（下方或上方翻转）', below || above,
    '浮层 y=' + Math.round(box.y) + ' h=' + Math.round(box.height) +
    ' / 输入框 bottom=' + Math.round(anchor.y + anchor.height) +
    ' / ' + (below ? '在下方' : above ? '已上翻' : '位置异常') +
    ' / 视口 innerHeight=' + vp.ih + ' scrollWidth=' + vp.sw);
  check('浮层未超视口', box.x >= 0 && box.x + box.width <= 1200 && box.y + box.height <= 800,
    JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }));

  await page.screenshot({ path: OUT + '/day24-timepicker-open.png' });

  // ---- 3. 拨到 14 时 ----
  await page.click('.tp-col[data-key="hour"] .tp-item[data-idx="14"]');
  await page.waitForTimeout(350);   // 等 smooth scroll + snap 落位
  const preview = await page.textContent('#tp-preview');
  const hint = await page.textContent('#tp-hint');
  check('拨轮选中 14 时，预览与提示同步', /14:00/.test(preview) && /结束将同步为/.test(hint),
    '预览=' + preview + ' / 提示=' + hint);
  const scrollTop = await page.$eval('.tp-col[data-key="hour"] .tp-scroll', el => el.scrollTop);
  check('拨轮滚动对齐（scrollTop = 档位×34）', scrollTop === 14 * 34, 'scrollTop=' + scrollTop);

  // ---- 4. 确定 → 结束自动跟随 ----
  await page.click('#tp-ok');
  await page.waitForTimeout(200);
  const v1s = await page.inputValue(startSel);
  const v1e = await page.inputValue(endSel);
  check('确定后开始=结束写入输入框', v1s === '14:00', '开始=' + v1s + ' / 结束=' + v1e);
  check('结束自动 = 开始 +30 分钟', v1e === '14:30', '结束=' + v1e);
  check('关闭后浮层隐藏', await page.locator('.tp-overlay').getAttribute('hidden') !== null, 'overlay[hidden]');

  // ---- 5. 结束拨到早于开始 → 应拦住 ----
  await page.click(endSel);
  await page.waitForSelector('.tp-overlay:not([hidden])', { timeout: 2000 });
  await page.click('.tp-col[data-key="hour"] .tp-item[data-idx="13"]');
  await page.waitForTimeout(350);
  const okDisabled = await page.isDisabled('#tp-ok');
  const hintErr = await page.textContent('#tp-hint');
  const isErr = await page.locator('#tp-hint').evaluate(el => el.classList.contains('is-error'));
  check('结束 ≤ 开始时确定被禁用', okDisabled, 'disabled=' + okDisabled);
  check('结束 ≤ 开始时给出红字提示', isErr && /不允许零时长/.test(hintErr), '提示=' + hintErr);
  await page.screenshot({ path: OUT + '/day24-timepicker-invalid.png' });

  // ---- 6. Esc 关闭且不落值 ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const v2e = await page.inputValue(endSel);
  check('Esc 关闭且不写入无效值', v2e === '14:30', '结束仍为 ' + v2e);

  // ---- 7. 键盘：方向键可调档 ----
  await page.click(startSel);
  await page.waitForSelector('.tp-overlay:not([hidden])', { timeout: 2000 });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const kbPreview = await page.textContent('#tp-preview');
  check('方向键可调档', /15:00/.test(kbPreview), '预览=' + kbPreview);
  await page.keyboard.press('Escape');

  // ---- 8. 窄屏降级为底部抽屉 ----
  await page.setViewportSize({ width: 400, height: 720 });
  await page.click(startSel);
  await page.waitForSelector('.tp-overlay:not([hidden])', { timeout: 2000 });
  await page.waitForTimeout(300);          // 等抽屉上滑动画结束
  const isSheet = await page.locator('.tp').evaluate(el => el.classList.contains('tp--sheet'));
  const sbox = await page.locator('.tp').boundingBox();
  check('窄屏降级为底部抽屉', isSheet && Math.abs(sbox.y + sbox.height - 720) < 2,
    'is-sheet=' + isSheet + ' / bottom=' + Math.round(sbox.y + sbox.height));
  await page.screenshot({ path: OUT + '/day24-timepicker-sheet.png' });

  check('页面无 JS 报错', errs.length === 0, errs.join(' | ') || '无');

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log('\n==== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('脚本异常：', e); process.exit(2); });
