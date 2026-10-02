// Day 22 验证脚本：对**公网真实接口**跑一遍「增 → 查 → 改 → 删」四类操作闭环。
// Windows 命令行 curl -d 中文会被 GBK 编码搞乱，所以用 Node 原生 fetch 发请求（同 Day 18 的做法）。
//
// 用法：
//   1) 先确保 CloudBase 控制台里的 items 云函数已经换成 Day 22 的新代码（index.js + db.js）并部署成功
//   2) 运行：node verify-day22.js
//
// 脚本会自己新建一条测试事项来改、来删（不动已有的种子数据），跑完这条测试数据就被删掉了。
// 输出里会有两张截图要的块：
//   图1 —— 【改之前】 vs 【改之后】 字段对比表
//   图2 —— 删除后 GET 返回里该条已消失
//
// 若 HTTP 网关不放行 PATCH / DELETE（返回 405），脚本会自动降级为 POST + ?_method=XXX，
// 并在开头打印实际使用的方式。

const BASE = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items';

// 想强制走兜底方式，运行时加环境变量：FORCE_OVERRIDE=1 node verify-day22.js
const FORCE_OVERRIDE = process.env.FORCE_OVERRIDE === '1';

let METHOD_MODE = '直发 PATCH/DELETE';   // 实际采用的方式，跑完会打印

// —— 底层请求：带自动降级 ——
async function send(method, { query = '', body = null } = {}) {
  const url = query ? `${BASE}?${query}` : BASE;
  const doFetch = (m, q, b) =>
    fetch(q ? `${BASE}?${q}` : BASE, {
      method: m,
      headers: b ? { 'Content-Type': 'application/json' } : {},
      body: b ? JSON.stringify(b) : undefined,
    });

  // 需要降级的场景：网关不放行 PATCH/DELETE（405 / 501），或用户强制
  if (method === 'PATCH' || method === 'DELETE') {
    if (!FORCE_OVERRIDE) {
      const probe = await doFetch(method, query, body);
      if (probe.status !== 405 && probe.status !== 501) return readJson(probe);
      // 405/501 → 降级：POST + ?_method=XXX
      METHOD_MODE = '降级：POST + ?_method=XXX（网关不放行 PATCH/DELETE）';
    } else {
      METHOD_MODE = '降级：POST + ?_method=XXX（环境变量 FORCE_OVERRIDE=1 强制）';
    }
    const q2 = (query ? query + '&' : '') + `_method=${method}`;
    // 降级时 id/confirm 等参数已在 query 或 body 里，直接带上
    const res = await doFetch('POST', q2, body);
    return readJson(res);
  }
  return readJson(await doFetch(method, query, body));
}

async function readJson(res) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

function show(label, r) {
  console.log(`\n--- ${label} | HTTP ${r.status} ---`);
  console.log(JSON.stringify(r.json, null, 2));
}

const pad = (s, n) => {
  // 中文按 2 个宽度算，保证终端里对齐（截图要好看）
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

(async () => {
  console.log('BASE =', BASE);
  console.log('方式 =', METHOD_MODE, '\n');

  // ================= ① 增：新建一条测试事项 =================
  const stamp = Date.now().toString().slice(-6);
  const titleNew = `Day22闭环验证-${stamp}`;
  const rCreate = await send('POST', {
    body: {
      table: 'work', type: 'meeting', title: titleNew,
      startTime: '2026-10-02 21:00', endTime: '2026-10-02 22:00',
      attendees: '验证脚本', venue: '改前地点', note: 'Day22 闭环验证用，跑完即删', ownerKey: 'self',
    },
  });
  show('① POST 新建测试事项', rCreate);
  if (!rCreate.json || !rCreate.json.ok) {
    console.error('\n❌ 新建失败，后续步骤无法进行。请先看上面的错误信息。');
    process.exit(1);
  }
  const id = rCreate.json.data.id;
  console.log('\n>>> 本次验证用的事项 id =', id);

  // ================= ② 查：读回，记录"改之前"的值 =================
  const rGet1 = await send('GET', { query: 'limit=200' });
  const before = (rGet1.json.data || []).find((x) => x.id === id);
  console.log('\n=== ② 改之前（GET 读回）===');
  console.log(JSON.stringify(before, null, 2));

  // ================= ③ 改：PATCH 改标题 / 开始时间 / 地点 =================
  const titleNew2 = `Day22闭环验证-已改-${stamp}`;
  const rPatch = await send('PATCH', {
    query: `id=${id}`,
    body: { title: titleNew2, startTime: '2026-10-02 21:30', venue: '改后地点' },
  });
  show('③ PATCH 修改（标题/开始时间/地点）', rPatch);
  const after = rPatch.json && rPatch.json.ok ? rPatch.json.data : null;

  // ================= ④ 查：再读一次，确认库里真的改了 =================
  const rGet2 = await send('GET', { query: 'limit=200' });
  const persisted = (rGet2.json.data || []).find((x) => x.id === id);

  console.log('\n================ 【图1】改之前 vs 改之后 ================');
  console.log(pad('字段', 12) + pad('改之前', 26) + pad('改之后(PATCH返回)', 26) + '库里现值(GET读回)');
  console.log('-'.repeat(96));
  for (const f of ['title', 'startTime', 'endTime', 'venue']) {
    console.log(
      pad(f, 12) +
      pad(before ? before[f] : '(读不到)', 26) +
      pad(after ? after[f] : '(PATCH失败)', 26) +
      (persisted ? persisted[f] : '(读不到)')
    );
  }
  const patchOK = !!persisted && persisted.title === titleNew2 && persisted.startTime === '2026-10-02 21:30' && persisted.venue === '改后地点';
  console.log('\n>>> 结论：PATCH 修改' + (patchOK ? ' ✅ 已生效（库里读回值与改后一致）' : ' ❌ 未生效'));

  // ================= ⑤ 删：DELETE（带 confirm） =================
  const rDel = await send('DELETE', { query: `id=${id}&confirm=true` });
  show('⑤ DELETE 删除（带 confirm=true）', rDel);

  // ================= ⑥ 查：确认 GET 不再返回这条 =================
  const rGet3 = await send('GET', { query: 'limit=200' });
  const stillThere = (rGet3.json.data || []).filter((x) => x.id === id);
  const total = (rGet3.json.data || []).length;

  console.log('\n================ 【图2】删除后 GET 返回里该条已消失 ================');
  console.log('被删 id            :', id);
  console.log('GET 返回总条数     :', total);
  console.log('该 id 是否还在返回里:', stillThere.length === 0 ? '否 ✅（已消失）' : `是 ❌（还剩 ${stillThere.length} 条）`);
  console.log('匹配到的记录       :', JSON.stringify(stillThere));
  const deleteOK = rDel.json && rDel.json.ok === true && stillThere.length === 0;
  console.log('\n>>> 结论：DELETE 删除' + (deleteOK ? ' ✅ 生效且 GET 不再返回' : ' ❌ 未生效'));

  // ================= ⑦ 越界与边界（新增的三道闸门） =================
  console.log('\n=== ⑦ 越界与边界检查 ===');
  const rNoConfirm = await send('DELETE', { query: `id=${id}` });
  console.log('⑦-1 不带 confirm 删除 → HTTP', rNoConfirm.status, JSON.stringify(rNoConfirm.json));
  const rDelAgain = await send('DELETE', { query: `id=${id}&confirm=true` });
  console.log('⑦-2 删除已删掉的 id   → HTTP', rDelAgain.status, JSON.stringify(rDelAgain.json));
  const rBadPatch = await send('PATCH', { query: `id=${id}`, body: { type: '不存在的类型' } });
  console.log('⑦-3 PATCH 非法 type   → HTTP', rBadPatch.status, JSON.stringify(rBadPatch.json));
  const rPatchNoField = await send('PATCH', { query: `id=${id}`, body: {} });
  console.log('⑦-4 PATCH 空更新      → HTTP', rPatchNoField.status, JSON.stringify(rPatchNoField.json));

  // ================= 汇总 =================
  console.log('\n================ 四类操作闭环汇总 ================');
  console.log(pad('操作', 10) + pad('接口', 26) + '结论');
  console.log('-'.repeat(60));
  console.log(pad('① 增', 10) + pad('POST /api/items', 26) + (rCreate.json.ok ? '✅ 成功，id=' + id : '❌ 失败'));
  console.log(pad('② 查', 10) + pad('GET /api/items', 26) + (rGet1.json.ok ? `✅ 成功，${(rGet1.json.data || []).length} 条` : '❌ 失败'));
  console.log(pad('③ 改', 10) + pad('PATCH /api/items?id', 26) + (patchOK ? '✅ 库里读回已变更' : '❌ 未生效'));
  console.log(pad('④ 删', 10) + pad('DELETE ?id&confirm=true', 26) + (deleteOK ? '✅ 删除后 GET 不再返回' : '❌ 未生效'));
  console.log('\n实际请求方式：', METHOD_MODE);
  console.log('=== 验证完毕 ===');
})().catch((e) => { console.error('脚本错误:', e); process.exit(1); });
