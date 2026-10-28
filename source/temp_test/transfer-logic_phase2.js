// 换团队 / 解散团队 行为测试（2026-10-28）
// ---------------------------------------------------------------------------
// 用户拍板的语义：「换团队＝自己导出 → 到新团队导入」「解散＝成员各自留底，团队直接删」。
// 这条链路最容易出的错，恰恰是 10-28 之前踩过的那个：**导出的文件喂不进导入**
// （导出给 startTime 全量串，旧导入读 it.start → Invalid Date，界面上一条都看不到）。
// 所以本测试的核心是一条往返：
//
//   导出「我的日程」→ 把导出的 JSON 原样喂给导入的解析层 → 每条都应成功解析
//
// 其余钉住：
//   ① 只导自己的（别人的日程导出来在新团队里只是一堆重复脏数据）
//   ② 一条都没有时不产生空文件，而是如实说明
//   ③ 导出格式带 version/exportedAt（将来改格式时靠它做兼容分支）
//   ④ 解散必须"名字完全一致"才发请求（不是勾个复选框）
//   ⑤ 解散只有 admin/core 能触发；成功后清掉本地令牌（否则界面停在"已登录"的假象）
// 用法：node source/temp_test/transfer-logic_phase2.js
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}

// ===== 可控外部状态 =====
let serverItems = [];
const requests = [];
const toasts = [];
const downloads = [];
const confirms = [];        // window.confirm 的**返回值**队列（测试预置 true/false）
const confirmMessages = []; // window.confirm 的**文案**记录（两个队列分开，否则会互相污染）

function elStub(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', disabled: false,
    dataset: {}, children: [], files: [], style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
    focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    get nextElementSibling() { return null; }, get parentNode() { return null; },
  };
}
const elements = {};
const documentStub = {
  getElementById(id) { if (!elements[id]) elements[id] = elStub(id); return elements[id]; },
  createElement(tag) { return elStub('dyn-' + tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  hidden: false,
};

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() { sandbox.__reloaded = true; } },
  navigator: { userAgent: 'transfer-logic-test' },
  localStorage: {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
  },
  confirm: msg => { confirmMessages.push(msg); return confirms.length ? !!confirms.shift() : false; },
  alert() {},
  fetch: async (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || 'GET';
    let body = null;
    if (opt && opt.body) { try { body = JSON.parse(opt.body); } catch (_) {} }
    requests.push({ method, url: u, body });
    if (u.includes('_action=heartbeat')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { online: 1 } }) };
    if (u.includes('_action=members')) return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    if (u.includes('_action=types')) return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    if (u.includes('_action=deleteteam')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { team: { id: 1, name: '测试队' }, deleted: { items: 3, members: 2 } } }) };
    }
    if (u.includes('/api/items')) return { ok: true, status: 200, json: async () => ({ ok: true, data: serverItems }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Blob,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const SCRIPTS = ['timepicker.js', 'login_phase2.js', 'export_phase2.js', 'timeline.js', 'router.js', 'animations.js'];
const loadJs = n => vm.runInContext(fs.readFileSync(path.join(ROOT, 'source', 'js', n), 'utf8'), sandbox, { filename: n });
for (const s of SCRIPTS.slice(0, 3)) loadJs(s);

let src = fs.readFileSync(path.join(ROOT, 'source', 'js', 'timeline.js'), 'utf8');
src += `
;globalThis.__probe = {
  exportMine, disbandTeam, normalizeImportItem, canWrite,
};`;
vm.runInContext(src, sandbox, { filename: 'timeline.js+probe' });
for (const s of SCRIPTS.slice(4)) loadJs(s);
const P = sandbox.__probe;

// 拦截下载：真实实现会 createElement + click，这里只关心内容
sandbox.Export2.download = (filename, content, mime) => { downloads.push({ filename, content, mime }); };
sandbox.showToast = m => { toasts.push(String(m)); };
const auth = { id: 2, name: '张三', role: 'member', teamId: 1 };
const setMe = m => {
  if (m) sandbox.localStorage.setItem('workshop_member_info', JSON.stringify(m));
  else sandbox.localStorage.removeItem('workshop_member_info');
};

// ============ ① 只导自己的 ============
console.log('──────── ① 导出范围 ────────');
serverItems = [
  { id: 1, title: '我的会议', type: 'meeting', table: 'work', startTime: '2026-10-28 09:00', endTime: '2026-10-28 09:30', ownerMemberId: 2, ownerKey: 'self' },
  { id: 2, title: '别人周会', type: 'meeting', table: 'work', startTime: '2026-10-28 10:00', endTime: '2026-10-28 10:30', ownerMemberId: 3, ownerKey: 'depta' },
  { id: 3, title: '无归属老数据', type: 'meeting', table: 'work', startTime: '2026-10-28 11:00', endTime: '2026-10-28 11:30', ownerMemberId: null, ownerKey: 'self' },
  { id: 4, title: '我名下行程', type: 'travel', table: 'work', startTime: '2026-10-29 08:00', endTime: '2026-10-29 09:00', ownerMemberId: 2, ownerKey: 'self' },
];
setMe(auth);
downloads.length = 0; toasts.length = 0;

(async () => {
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));

  await P.exportMine();
  check('触发了下载', downloads.length === 1, '实际 ' + downloads.length);
  const file = downloads[0];
  check('文件名带 my 标记', /我的日程/.test(file.filename), file.filename);
  check('MIME 是 application/json', /application\/json/.test(file.mime));
  let parsed = null;
  try { parsed = JSON.parse(file.content); } catch (e) { /* 下面断言会报 */ }
  check('导出内容是可解析 JSON', !!parsed);
  check('带 version 字段（将来改格式靠它分支）', parsed && parsed.version === 1, parsed && String(parsed.version));
  check('带 exportedAt', parsed && typeof parsed.exportedAt === 'string');
  const items = (parsed && parsed.items) || [];
  check('只导自己名下的（2 条）', items.length === 2, '实际 ' + items.length + '：' + JSON.stringify(items.map(x => x.id)));
  check('不含他人日程', !items.some(x => Number(x.ownerMemberId) === 3));
  check('不含无归属老数据', !items.some(x => x.ownerMemberId == null));

  // ============ ② 往返：导出的东西必须能导回去 ============
  console.log('──────── ② 导出 → 导入 往返 ────────');
  const roundTrip = items.map(it => {
    try { return { ok: true, v: P.normalizeImportItem(it) }; }
    catch (e) { return { ok: false, e: e.message }; }
  });
  const bad = roundTrip.filter(r => !r.ok);
  check('导出格式能直接被导入解析（旧 bug 的回归）', bad.length === 0, bad.map(b => b.e).join('; '));
  const first = roundTrip[0].v;
  check('时间被正确解析成 Date', first && first.start instanceof Date && !isNaN(first.start.getTime()), first && String(first.start));
  check('保留开始/结束时刻', first && first.startTime === '09:00' && first.endTime === '09:30', first && `${first.startTime}-${first.endTime}`);
  check('保留类型', first && first.type === 'meeting', first && first.type);
  const trip = roundTrip.find(r => r.ok && r.v.title === '我名下行程');
  check('库词 travel 往返不变形', trip && trip.v.type === 'travel', trip && trip.v.type);
  check('标题完整', first && first.title === '我的会议', first && first.title);

  // ============ ③ 空数据：不产生空文件 ============
  console.log('──────── ③ 没有日程时 ────────');
  serverItems = [{ id: 9, title: '别人的', type: 'meeting', table: 'work', startTime: '2026-10-28 09:00', endTime: '2026-10-28 09:30', ownerMemberId: 3 }];
  downloads.length = 0; toasts.length = 0;
  await P.exportMine();
  check('一条都没有时不下载空文件', downloads.length === 0, '实际 ' + downloads.length);
  check('如实提示 0 条', toasts.some(t => /无需导出|0 条/.test(t)), toasts[toasts.length - 1]);
  const hintEl = documentStub.getElementById('export-mine-hint');
  check('提示里说明了"可能归属不是你"', /归属/.test(hintEl.textContent), hintEl.textContent);

  // ============ ④ 解散：名字必须完全一致 ============
  console.log('──────── ④ 解散团队 ────────');
  documentStub.getElementById('team-name').textContent = '测试队';
  requests.length = 0; toasts.length = 0;

  setMe(Object.assign({}, auth, { role: 'member' }));
  await P.disbandTeam();
  check('普通成员 → 拒绝', !requests.some(r => r.url.includes('deleteteam')));
  check('普通成员收到权限提示', toasts.some(t => /管理员/.test(t)), toasts[toasts.length - 1]);

  setMe(Object.assign({}, auth, { role: 'admin' }));
  documentStub.getElementById('disband-confirm').value = '测试';
  requests.length = 0;
  await P.disbandTeam();
  check('名字不一致 → 不发请求', !requests.some(r => r.url.includes('deleteteam')));
  check('名字不一致有清晰提示', toasts.some(t => /不一致/.test(t)), toasts[toasts.length - 1]);

  documentStub.getElementById('disband-confirm').value = '测试队';
  confirms.length = 0; confirms.push(false);
  requests.length = 0;
  await P.disbandTeam();
  check('名字对了但二次确认取消 → 不发请求', !requests.some(r => r.url.includes('deleteteam')));
  check('确实弹了二次确认', confirmMessages.some(m => /最后一次确认/.test(m)), JSON.stringify(confirmMessages));

  // ============ ⑤ 解散成功：发请求 + 清令牌 ============
  console.log('──────── ⑤ 解散成功 ────────');
  documentStub.getElementById('disband-confirm').value = '测试队';
  confirms.length = 0; confirms.push(true);
  requests.length = 0; toasts.length = 0;
  await P.disbandTeam();
  const dis = requests.find(r => r.url.includes('deleteteam'));
  check('发出了 deleteteam 请求', !!dis);
  check('请求体带 confirmName', dis && dis.body && dis.body.confirmName === '测试队', dis && JSON.stringify(dis.body));
  check('本地身份已清除（不留"已登录"假象）', !sandbox.localStorage.getItem('workshop_member_info'));
  check('提示里带删除条数', toasts.some(t => /3 条/.test(t) || /解散/.test(t)), toasts[toasts.length - 1]);

  console.log('\n通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
