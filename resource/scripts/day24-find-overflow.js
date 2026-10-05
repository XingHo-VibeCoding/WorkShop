/* [Day 24] 横向溢出扫描：跨视口检查 scrollWidth 是否超出，并列出越界元素 */
const { chromium } = require('playwright');
const URL = process.env.TP_URL || 'http://127.0.0.1:8081/index.html';

(async () => {
  const browser = await chromium.launch();
  const viewports = [1440, 1280, 1200, 1024, 900, 768, 560, 400];
  console.log('视口宽度扫描（溢出 = scrollWidth - 视口宽）：');
  let bad = 0;
  for (const w of viewports) {
    const page = await browser.newPage({ viewport: { width: w, height: 800 } });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const sw = document.documentElement.scrollWidth;
      const over = [];
      if (sw > vw + 0.5) {
        document.querySelectorAll('*').forEach(el => {
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return;
          if (b.right > vw + 0.5) {
            over.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '(right=' + Math.round(b.right) + ')');
          }
        });
      }
      const tl = document.querySelector('#timeline');
      return {
        vw, sw, over: over.slice(0, 6),
        tlW: tl ? Math.round(tl.getBoundingClientRect().width) : 0,
        tlSW: tl ? tl.scrollWidth : 0
      };
    });
    const over = r.sw - r.vw;
    if (over > 0) bad++;
    console.log('  ' + String(w).padStart(5) + ' → scrollWidth=' + String(r.sw).padStart(5) +
      ' 溢出=' + String(over).padStart(3) + 'px ' + (over > 0 ? '❌ ' + r.over.join(' | ') : '✅') +
      '  [时间线 可视' + r.tlW + ' / 内容' + r.tlSW + ']');
    await page.close();
  }
  await browser.close();
  console.log('\n结论：' + (bad === 0 ? '✅ 所有视口均无横向溢出' : '❌ 仍有 ' + bad + ' 个视口溢出'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
