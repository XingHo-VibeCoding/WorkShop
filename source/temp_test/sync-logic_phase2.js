// 自动同步行为测试（2026-10-27 实时协作）
// ---------------------------------------------------------------------------
// 目的：用户实测反馈「A 新建日程后，B 必须刷新才看得到」。
//   本测试用 vm + 可控 DOM 桩 直接驱动 syncTick，验证：
//     ① 服务端新增 → 自动重绘 + 提示
//     ② 服务端无变化 → 一个 DOM 都不碰（不闪屏、不丢选中）
//     ③ 页面隐藏 → 不发请求（省配额）
//     ④ 用户填表中 → 挂起不打断，表单关闭后补应用
//     ⑤ 正在看的事项被他人删除 → 退出详情并说明
//     ⑥ 正在看的事项被他人修改 → 详情静默换成新版
//   另测 dataSig 与返回顺序无关（防"顺序抖动"假变更）。
// 本文件不进 git（source/temp_test/ 惯例）。用法：node source/temp_test/sync-logic_phase2.js
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
let formOpen = false;          // 用户是否正在填表（决定 getElementById('item-form') 是否命中）
let docHidden = false;         // 页面是否隐藏
let serverItems = [];          // "服务端"当前数据
let fetchUrls = [];            // 请求记录
let renderCalls = 0;           // render() 调用次数
let toastMsgs = [];            // showToast 文案
let showDetailCalls = [];      // showDetail 入参（null = 退出详情）
let timeouts = [];             // 被挂起的 setTimeout 回调（flushPendingSync 用）

// ===== DOM 桩 =====
function elStub(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false,
    dataset: {}, children: [], files: [], scrollTop: 0,
    // 2026-10-28：类型主题靠 documentElement.style.setProperty 注入 CSS 变量，桩必须支持
    style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    get nextElementSibling() { return null; },
    get parentNode() { return null; },
  };
}
const elements = {};
const documentStub = {
  // 关键：只对 item-form 做真实判定，其余一律给可复用桩（真实浏览器里这些元素都存在）
  getElementById(id) {
    if (id === 'item-form') return formOpen ? (elements['item-form'] || (elements['item-form'] = elStub('item-form'))) : null;
    if (!elements[id]) elements[id] = elStub(id);
    return elements[id];
  },
  createElement(tag) { return elStub('dyn-' + tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: elStub('html'),
  get hidden() { return docHidden; },
};

function jsonRes(j) {
  return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) };
}

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() {} },
  navigator: { userAgent: 'sync-logic-test' },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  fetch: async (url) => {
    const u = String(url);
    fetchUrls.push(u);
    if (u.includes('_action=heartbeat')) return jsonRes({ ok: true, data: { online: 1 } });
    if (u.includes('_action=members')) return jsonRes({ ok: true, data: [] });
    if (u.includes('/api/items')) return jsonRes({ ok: true, data: serverItems });
    return jsonRes({ ok: true, data: [] });
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0,                                      // 不真跑定时器（本测试手动驱动 syncTick）
  clearInterval: () => {},
  setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 必须按 index.html 的真实顺序加载全部脚本：renderCurrentView 定义在 router.js，
// 少加载一个会让 setState() 抛 TypeError 并被 syncTick 的静默 catch 吞掉（测试假阴性）。
const SCRIPTS = ['timepicker.js', 'login_phase2.js', 'export_phase2.js', 'timeline.js', 'router.js', 'animations.js'];
const loadJs = (name) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'source', 'js', name), 'utf8'), sandbox, { filename: name });

// timeline.js 之前的三兄弟先加载（timeline 依赖它们的全局）
for (const s of SCRIPTS.slice(0, 3)) loadJs(s);

// ===== 载入 timeline.js（并追加探针：暴露脚本作用域的 let 变量）=====
let timelineSrc = fs.readFileSync(path.join(ROOT, 'source', 'js', 'timeline.js'), 'utf8');
// 调试开关：syncTick 有意静默吞异常（线上不打扰用户），测试时要把被吞的异常挖出来
if (process.env.DEBUG_SYNC) {
  timelineSrc = timelineSrc.replace(
    /\} catch \(_\) \{\s*\/\* 静默[^*]*\*\//,
    "} catch (e) { console.error('[syncTick 捕获的异常]', e && (e.stack || e.message));"
  );
}
timelineSrc += `
;globalThis.__probe = {
  get items() { return items; },
  get sig() { return _syncSig; },
  get inited() { return _syncInited; },
  get pending() { return _syncPending; },
  get currentItem() { return currentItem; },
  syncTick, dataSig, flushPendingSync, isFormOpen,
};`;

try {
  vm.runInContext(timelineSrc, sandbox, { filename: 'timeline.js+probe' });
  check('timeline.js 整份执行（含自动同步模块）', true);
} catch (e) {
  check('timeline.js 整份执行（含自动同步模块）', false, e.name + ': ' + e.message);
  console.log('\n通过 ' + pass + ' · 失败 ' + fail);
  process.exit(1);
}

const probe = sandbox.__probe;

// timeline 之后的两个脚本（router 提供 renderCurrentView，setState 依赖它）
for (const s of SCRIPTS.slice(4)) {
  try { loadJs(s); } catch (e) { check(s + ' 加载无异常', false, e.name + ': ' + e.message); }
}

// ===== 打桩观测点：包住 render / showToast / showDetail =====
const realRender = sandbox.render;
sandbox.render = function (...a) { renderCalls++; return realRender.apply(this, a); };
const realToast = sandbox.showToast;
// ⚠️ 用 call 不是 apply：apply 第二参必须是数组，传对象会被当成"无参数"
sandbox.showToast = function (msg) { toastMsgs.push(msg); return realToast.call(this, msg); };
const realDetail = sandbox.showDetail;
sandbox.showDetail = function (it) { showDetailCalls.push(it); return realDetail.call(this, it); };

const flush = () => new Promise(r => setImmediate(r));
function resetCounters() { renderCalls = 0; toastMsgs = []; showDetailCalls = []; fetchUrls = []; }

// 本周周一（保证构造的数据落在 currentOffset=0 的范围内，setState 判断才有意义）
const now = new Date();
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const p2 = n => String(n).padStart(2, '0');
const D = (d, hhmm) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hhmm}`;
const itemA = (ver) => ({
  id: 101, table: 'work', type: 'meeting', title: 'A 新建的会',
  startTime: D(monday, '09:00'), endTime: D(monday, '10:00'),
  attendees: '', venue: '', note: '', ownerKey: 'depta', ownerMemberId: 7,
  borderColor: '#c0392b', meetingNo: null, meetingUrl: null, updatedAtRaw: ver || '2026-10-27T01:00:00Z',
});

(async () => {
  // 等首屏落定：直接 await bootstrap()（它内部 await loadItems + Auth.members），
  // 不用猜微任务轮数——之前靠 flush 次数猜测，导致 bootstrap 晚到把测试数据"吃掉"。
  await sandbox.bootstrap();
  for (let i = 0; i < 3; i++) await flush();
  check('启动后已建立同步基线（首轮只记基线）', probe.inited === true, 'inited=' + probe.inited);
  // 首屏渲染次数：bootstrap 自身是 setState(内部 render) + render() 各一次 = 2，
  // 属既有行为（Day 20 起），不是自动同步引入的。这里只守"不会更多"。
  check('首屏渲染次数 ≤ 2（无额外刷屏）', renderCalls <= 2, 'renderCalls=' + renderCalls);

  console.log('\n──────── ① 服务端新增 → 自动重绘 + 提示 ────────');
  serverItems = [itemA()];
  resetCounters();
  await probe.syncTick();
  check('检测到新增 → render 被调用', renderCalls === 1, 'renderCalls=' + renderCalls);
  check('提示「已同步他人的最新改动」', toastMsgs.some(m => /已同步他人的最新改动/.test(m)), JSON.stringify(toastMsgs));
  check('本地 items 已包含新事项', probe.items.length === 1 && probe.items[0].title === 'A 新建的会', JSON.stringify(probe.items.map(i => i.title)));

  console.log('\n──────── ② 服务端无变化 → 一个 DOM 都不碰 ────────');
  resetCounters();
  await probe.syncTick();
  check('无变化 → render 不被调用（不闪屏/不丢选中）', renderCalls === 0, 'renderCalls=' + renderCalls);
  check('无变化 → 不弹提示', toastMsgs.length === 0, JSON.stringify(toastMsgs));
  check('无变化 → 仍然发了 1 次轻量查询（说明轮询在工作）', fetchUrls.filter(u => u.includes('/api/items')).length === 1, JSON.stringify(fetchUrls));

  console.log('\n──────── ③ 页面隐藏 → 暂停拉取（省配额）────────');
  docHidden = true;
  resetCounters();
  await probe.syncTick();
  check('页面隐藏 → 完全不发请求', fetchUrls.length === 0, JSON.stringify(fetchUrls));
  docHidden = false;

  console.log('\n──────── ④ 用户填表中 → 挂起不打断，关闭后补应用 ────────');
  formOpen = true;
  probe.items.push; // noop 占位
  serverItems = [itemA(), { ...itemA(), id: 102, title: 'A 又加了一条', startTime: D(monday, '14:00'), endTime: D(monday, '15:00'), updatedAtRaw: '2026-10-27T02:00:00Z' }];
  resetCounters();
  await probe.syncTick();
  check('填表中 → 不重绘（不冲掉用户输入）', renderCalls === 0, 'renderCalls=' + renderCalls);
  check('填表中 → 挂起标记 pending=true', probe.pending === true, 'pending=' + probe.pending);
  check('填表中 → 不弹提示', toastMsgs.length === 0, JSON.stringify(toastMsgs));

  formOpen = false;                 // 用户保存/取消 → 表单关闭
  resetCounters();
  probe.flushPendingSync();         // afterMutation/showDetail 会调用它
  check('表单关闭 → flushPendingSync 安排了补偿同步', timeouts.length > 0, 'timeouts=' + timeouts.length);
  while (timeouts.length) { const fn = timeouts.shift(); fn(); await flush(); }
  for (let i = 0; i < 4; i++) await flush();
  check('补偿同步真的应用了挂起的变更（items 变 2 条）', probe.items.length === 2, 'items=' + probe.items.length);
  check('补偿同步时给出提示', toastMsgs.some(m => /已同步他人的最新改动/.test(m)), JSON.stringify(toastMsgs));

  console.log('\n──────── ⑤ 正在看的事项被他人删除 → 退出详情并说明 ────────');
  sandbox.showDetail(probe.items[0]);          // 模拟用户点开第一条看详情
  resetCounters();
  serverItems = [serverItems[1]];              // A 把 101 删了，102 仍在（保证签名变化）
  await probe.syncTick();
  check('被删 → showDetail(null) 退出详情', showDetailCalls.some(x => x === null), 'calls=' + showDetailCalls.length);
  check('被删 → 提示「你正在看的事项已被他人删除」', toastMsgs.some(m => /已被他人删除/.test(m)), JSON.stringify(toastMsgs));

  console.log('\n──────── ⑥ 正在看的事项被他人修改 → 详情静默换新版 ────────');
  sandbox.showDetail(probe.items[0]);          // 只看 102
  resetCounters();
  serverItems = [{ ...serverItems[0], title: 'A 改了标题', updatedAtRaw: '2026-10-27T03:00:00Z' }];
  await probe.syncTick();
  const refreshed = showDetailCalls.filter(x => x && x.title === 'A 改了标题');
  check('被改 → 详情自动换成新版（标题已更新）', refreshed.length === 1, JSON.stringify(showDetailCalls.map(x => x && x.title)));
  check('被改 → 提示已同步', toastMsgs.some(m => /已同步他人的最新改动/.test(m)), JSON.stringify(toastMsgs));

  console.log('\n──────── ⑦ 签名与返回顺序无关（防假变更）────────');
  const x = { id: '1', updatedAtRaw: 'a' }, y = { id: '2', updatedAtRaw: 'b' };
  check('dataSig([x,y]) === dataSig([y,x])', probe.dataSig([x, y]) === probe.dataSig([y, x]), probe.dataSig([x, y]) + ' vs ' + probe.dataSig([y, x]));
  check('版本号变化 → 签名变化（能检出"改"）', probe.dataSig([{ id: '1', updatedAtRaw: 'a' }]) !== probe.dataSig([{ id: '1', updatedAtRaw: 'b' }]));

  console.log('\n──────── 小结 ────────');
  console.log('通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
