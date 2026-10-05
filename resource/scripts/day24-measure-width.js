/* [Day 24] 量表单里两个时间条的宽度，看是否溢出所在区域 */
const { chromium } = require('playwright');
const URL = process.env.TP_URL || 'http://127.0.0.1:8081/index.html';

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) return null;
  return { x: Math.round(b.x), r: Math.round(b.x + b.width), w: Math.round(b.width) };
}

(async () => {
  const browser = await chromium.launch();
  for (const vp of [{ width: 1200, height: 800 }, { width: 400, height: 720 }]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    // 先量「未打开表单」时的横向溢出，判断 14px 是不是时间框引起的
    const sw0 = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log('打开表单前 scrollWidth =', sw0, sw0 > vp.width ? '（已有溢出 ' + (sw0 - vp.width) + 'px，与时间框无关）' : '（无溢出）');
    await page.click('#btn-new');
    await page.waitForSelector('#item-form');

    console.log('\n===== 视口 ' + vp.width + '×' + vp.height + ' =====');
    const sels = [
      '.detail-card', '#item-form', '.row2',
      '.row2 label:nth-child(1)', '.row2 label:nth-child(2)',
      '.row2 .tp-field', '.row2 input[name="startTime"]', '.row2 input[name="endTime"]'
    ];
    const m = {};
    for (const s of sels) { m[s] = await box(page, s); console.log(s.padEnd(34), JSON.stringify(m[s])); }

    // 表单内容区右边界（detail-card 的内边距之内）
    const cardPad = await page.locator('.detail-card').evaluate(el => {
      const cs = getComputedStyle(el);
      return { pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight) };
    });
    const innerR = m['.detail-card'].r - cardPad.pr;
    const startR = m['.row2 input[name="startTime"]'].r;
    const endR = m['.row2 input[name="endTime"]'].r;
    console.log('detail-card 内容区右边界 =', Math.round(innerR));
    console.log('开始框右边界 =', startR, '→', startR > innerR ? '❌ 超出 ' + (startR - innerR) + 'px' : '✅ 在内');
    console.log('结束框右边界 =', endR, '→', endR > innerR ? '❌ 超出 ' + (endR - innerR) + 'px' : '✅ 在内');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log('页面 scrollWidth =', sw, '(视口 ' + vp.width + ')', sw > vp.width ? '❌ 横向溢出 ' + (sw - vp.width) + 'px' : '✅');
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
