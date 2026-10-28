// 批量删除 + 限时撤销 行为测试（2026-10-28）
// ---------------------------------------------------------------------------
// 目的：批量删除是本项目第一个「一次动多条」的功能，误删代价最高。
//   本测试用 vm + 可控 DOM 桩直接驱动真实代码，验证：
//     ① 身份门槛：未登录 / 只读 不能进批量模式，也不发任何删除请求
//     ② 选择语义：计数正确、上限生效、全选只选「当前筛选可见的」
//     ③ 快照完整：撤销需要的字段一个都不能少（尤其 ownerMemberId / borderColor）
//     ④ 删除隔离：404 当已删（不进撤销栈）、单条失败不连累其余
//     ⑤ 撤销还原：归属人原样传回、类型词转回 API 词、并发不超上限
//     ⑥ 撤销是新建：id 一定变（这是设计，不是缺陷；测试把它钉住防有人"优化"成复用 id）
// 用法：node source/temp_test/batch-logic_phase2.js
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
let serverItems = [];       // "服务端"当前数据
const requests = [];        // { method, url, body }
let failIds = new Set();    // 这些 id 的删除请求返回 500
let goneIds = new Set();    // 这些 id 的删除请求返回 404（云端已无）
const toasts = [];

function elStub(id) {
  const el = {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    dataset: {}, style: { setProperty() {} }, children: [], files: [], scrollTop: 0, offsetWidth: 1,
    classList: {
      _s: new Set(),
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
    focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    get nextElementSibling() { return null; }, get parentNode() { return null; },
  };
  return el;
}
const elements = {};
const documentStub = {
  getElementById(id) { if (!elements[id]) elements[id] = elStub(id); return elements[id]; },
  createElement(tag) { return elStub('dyn-' + tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: elStub('html'),
  hidden: false,
};

function jsonRes(j, status) {
  const st = status || 200;
  return { ok: st < 400, status: st, json: async () => j, text: async () => JSON.stringify(j) };
}

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() {} },
  navigator: { userAgent: 'batch-logic-test' },
  localStorage: {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
  },
  fetch: async (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || 'GET';
    let body = null;
    if (opt && opt.body) { try { body = JSON.parse(opt.body); } catch (_) {} }
    requests.push({ method, url: u, body });

    if (u.includes('_action=heartbeat')) return jsonRes({ ok: true, data: { online: 1 } });
    if (u.includes('_action=members')) return jsonRes({ ok: true, data: [] });

    if (method === 'DELETE') {
      const id = (u.match(/id=(\d+)/) || [])[1];
      if (failIds.has(id)) return jsonRes({ ok: false, error: { code: 500, message: '模拟服务器错误' } }, 500);
      if (goneIds.has(id)) return jsonRes({ ok: false, error: { code: 404, message: '事项不存在' } }, 404);
      serverItems = serverItems.filter(x => String(x.id) !== id);
      return jsonRes({ ok: true, data: { id: Number(id) } });
    }
    if (method === 'POST') {
      const id = 9000 + serverItems.length;
      const it = Object.assign({ id, createdAt: '2026-10-28 10:00', ownerMemberId: null }, body);
      serverItems.push(it);
      return jsonRes({ ok: true, data: it });
    }
    if (u.includes('/api/items')) return jsonRes({ ok: true, data: serverItems });
    return jsonRes({ ok: true, data: [] });
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const SCRIPTS = ['timepicker.js', 'login_phase2.js', 'export_phase2.js', 'timeline.js', 'router.js', 'animations.js'];
const loadJs = name => vm.runInContext(fs.readFileSync(path.join(ROOT, 'source', 'js', name), 'utf8'), sandbox, { filename: name });
for (const s of SCRIPTS.slice(0, 3)) loadJs(s);

let timelineSrc = fs.readFileSync(path.join(ROOT, 'source', 'js', 'timeline.js'), 'utf8');
timelineSrc += `
;globalThis.__probe = {
  get items() { return items; },
  set items(v) { items = v; },
  get selectMode() { return selectMode; },
  get selectedIds() { return selectedIds; },
  get undoState() { return undoState; },
  get filterState() { return filterState; },
  canWrite, enterSelectMode, exitSelectMode, toggleSelect, selectAllVisible, clearSelect,
  snapshotOf, runBatchDelete, doUndo, pushUndo, clearUndo, applyFilter,
  SELECT_LIMIT, UNDO_MS,
};`;

try {
  vm.runInContext(timelineSrc, sandbox, { filename: 'timeline.js+probe' });
  check('timeline.js 整份执行（含批量删除模块）', true);
} catch (e) {
  check('timeline.js 整份执行（含批量删除模块）', false, e.name + ': ' + e.message);
  console.log('\n通过 ' + pass + ' · 失败 ' + fail);
  process.exit(1);
}
for (const s of SCRIPTS.slice(4)) loadJs(s);

const P = sandbox.__probe;
// 记录 toast，便于断言"有没有如实报错"
sandbox.showToast = msg => { toasts.push(String(msg)); };

function mkLocal(id, over) {
  return Object.assign({
    id: String(id), table: 'work', type: 'meeting', title: 'T' + id,
    start: new Date('2026-10-28T00:00:00'), startTime: '09:00', endTime: '09:30',
    attendees: '', venue: '', note: '', ownerKey: 'self',
    ownerMemberId: 2, borderColor: '#1d4ed8', meetingNo: null, meetingUrl: null,
  }, over || {});
}

// ============ ① 身份门槛 ============
console.log('──────── ① 身份门槛 ────────');
sandbox.localStorage.removeItem('workshop_member_info');
check('未登录 canWrite=false', P.canWrite() === false);
P.enterSelectMode();
check('未登录点批量 → 不进模式', P.selectMode === false);
check('未登录 → 提示需要登录', toasts.some(t => t.includes('登录')), toasts[toasts.length - 1]);

sandbox.localStorage.setItem('workshop_member_info', JSON.stringify({ id: 9, name: '只读', role: 'readonly' }));
check('只读 canWrite=false', P.canWrite() === false);
P.enterSelectMode();
check('只读点批量 → 不进模式', P.selectMode === false);

sandbox.localStorage.setItem('workshop_member_info', JSON.stringify({ id: 3, name: '普通成员', role: 'member' }));
check('成员 canWrite=true', P.canWrite() === true);

// ============ ② 选择语义 ============
console.log('──────── ② 选择语义 ────────');
P.items = [mkLocal(1), mkLocal(2, { type: 'life' }), mkLocal(3, { ownerKey: 'deptb' })];
P.enterSelectMode();
check('成员点批量 → 进模式', P.selectMode === true);
check('进入时清空选择', P.selectedIds.size === 0);

P.toggleSelect('1');
P.toggleSelect('2');
check('点两次 → 选 2 条', P.selectedIds.size === 2);
P.toggleSelect('1');
check('再点已选的 → 取消（剩 1 条）', P.selectedIds.size === 1);
P.clearSelect();
check('清空选择', P.selectedIds.size === 0);

// 上限：造 SELECT_LIMIT+n 条，确认不越界
const many = [];
for (let i = 0; i < P.SELECT_LIMIT + 10; i++) many.push(mkLocal(1000 + i));
P.items = many;
P.selectAllVisible();
check(`全选受上限约束（≤${P.SELECT_LIMIT}）`, P.selectedIds.size === P.SELECT_LIMIT, '实际 ' + P.selectedIds.size);

// 全选只看筛选内：用关键词筛掉大部分
P.clearSelect();
P.items = [mkLocal(1, { title: '周会' }), mkLocal(2, { title: '评审' }), mkLocal(3, { title: '周会复盘' })];
P.filterState.keyword = '周会';
P.selectAllVisible();
check('全选遵守关键词筛选（只选 2 条）', P.selectedIds.size === 2, '实际 ' + P.selectedIds.size);
P.filterState.keyword = '';
P.clearSelect();

// ============ ③ 快照完整性 ============
console.log('──────── ③ 快照完整性 ────────');
const snap = P.snapshotOf(mkLocal(7, { note: '备注X', venue: '3楼', meetingNo: '559 1', attendeeCount: 3, updatedAtRaw: '123' }));
const need = ['table', 'type', 'title', 'dateStr', 'startTime', 'endTime', 'attendees', 'venue', 'note', 'ownerKey', 'ownerMemberId', 'borderColor', 'meetingNo', 'meetingUrl'];
const missing = need.filter(k => !(k in snap));
check('快照字段齐全', missing.length === 0, '缺 ' + missing.join(','));
check('快照保留归属人 ownerMemberId', snap.ownerMemberId === 2);
check('快照保留外框色 borderColor', snap.borderColor === '#1d4ed8');
check('快照日期拆出 dateStr', snap.dateStr === '2026-10-28');
check('快照不带 id（恢复必是新行）', !('id' in snap));

// ============ ④ 删除隔离 ============
console.log('──────── ④ 删除隔离 ────────');
requests.length = 0; toasts.length = 0;
serverItems = [
  { id: 1, title: 'A', type: 'meeting', table: 'work', startTime: '2026-10-28 09:00', endTime: '2026-10-28 09:30', ownerMemberId: 2 },
  { id: 2, title: 'B', type: 'meeting', table: 'work', startTime: '2026-10-28 10:00', endTime: '2026-10-28 10:30', ownerMemberId: 2 },
  { id: 3, title: 'C', type: 'meeting', table: 'work', startTime: '2026-10-28 11:00', endTime: '2026-10-28 11:30', ownerMemberId: 2 },
  { id: 4, title: 'D', type: 'meeting', table: 'work', startTime: '2026-10-28 12:00', endTime: '2026-10-28 12:30', ownerMemberId: 2 },
];
P.items = serverItems.map(a => mkLocal(a.id, { title: a.title }));
failIds = new Set(['2']);
goneIds = new Set(['4']);

(async () => {
  // ⚠️ 必须先等启动期的异步落定：timeline.js 末尾的 bootstrap()/startAutoSync() 各自发了一个
  //    请求，它们晚到的 `items = data` 会覆盖测试刚设的数据 → 断言全成假阴性。
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
  P.items = serverItems.map(a => mkLocal(a.id, { title: a.title }));
  P.enterSelectMode();
  ['1', '2', '3', '4'].forEach(id => P.toggleSelect(id));

  await P.runBatchDelete(P.items.filter(x => P.selectedIds.has(x.id)));

  const dels = requests.filter(r => r.method === 'DELETE');
  check('4 条各发一次 DELETE', dels.length === 4, '实际 ' + dels.length);
  check('DELETE 都带 confirm=true', dels.every(r => r.url.includes('confirm=true')));
  check('失败的 1 条（500）留在内存里', P.items.some(x => x.id === '2'), '当前 items: ' + JSON.stringify(P.items.map(x => x.id)));
  check('成功的 2 条已移出内存', !P.items.some(x => x.id === '1') && !P.items.some(x => x.id === '3'));
  check('404 的也移出内存（云端已无）', !P.items.some(x => x.id === '4'));
  check('404 不进撤销栈（无内容可重建）', P.undoState && P.undoState.snapshots.length === 2, '撤销栈 ' + (P.undoState ? P.undoState.snapshots.length : 'null'));
  check('失败如实抛出（toast 含失败条数）', toasts.some(t => t.includes('失败')), toasts[toasts.length - 1]);
  check('撤销窗口已启动', !!P.undoState);
  check('清空选择', P.selectedIds.size === 0);

  // ============ ⑤ 撤销还原 ============
  console.log('──────── ⑤ 撤销还原 ────────');
  requests.length = 0; toasts.length = 0;
  const beforeIds = serverItems.map(x => String(x.id));
  // 让快照里的类型用前端词，验证是否会转回 API 词
  P.undoState.snapshots[0].type = 'class';
  P.undoState.snapshots[0].ownerMemberId = 5;
  await P.doUndo();

  const posts = requests.filter(r => r.method === 'POST');
  check('按快照逐条 POST 重建', posts.length === 2, '实际 ' + posts.length);
  check('前端词 class 转回 API 词 course', posts.some(r => r.body && r.body.type === 'course'));
  check('归属人原样传回（ownerMemberId=5）', posts.some(r => r.body && r.body.ownerMemberId === 5));
  check('外框色原样传回', posts.some(r => r.body && r.body.borderColor === '#1d4ed8'));
  check('时间拼回完整字符串', posts.every(r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.body.startTime)));
  check('撤销后窗口关闭', P.undoState === null);
  check('撤销后有成功提示', toasts.some(t => t.includes('恢复')), toasts[toasts.length - 1]);
  const afterIds = serverItems.map(x => String(x.id));
  const newOnes = afterIds.filter(id => !beforeIds.includes(id));
  check('恢复出来的是新 id（设计如此，非缺陷）', newOnes.length === 2, '新 id ' + JSON.stringify(newOnes));

  // ============ ⑥ 并发上限 ============
  console.log('──────── ⑥ 并发上限 ────────');
  let inflight = 0, peak = 0;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, opt) => {
    if (opt && opt.method === 'DELETE') {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise(r => process.nextTick(r));
      inflight--;
    }
    return origFetch(url, opt);
  };
  serverItems = [];
  for (let i = 1; i <= 12; i++) serverItems.push({ id: i, title: 'P' + i, type: 'meeting', table: 'work', startTime: '2026-10-29 09:00', endTime: '2026-10-29 09:30' });
  failIds = new Set(); goneIds = new Set();
  P.items = serverItems.map(a => mkLocal(a.id, { title: a.title }));
  P.enterSelectMode();
  P.selectAllVisible();
  await P.runBatchDelete(P.items.filter(x => P.selectedIds.has(x.id)));
  check('并发不超过 4', peak <= 4, '实测峰值 ' + peak);
  check('12 条全部删除成功', P.undoState && P.undoState.snapshots.length === 12, '撤销栈 ' + (P.undoState ? P.undoState.snapshots.length : 'null'));
  sandbox.fetch = origFetch;

  console.log('\n通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
