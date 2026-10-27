// 自动同步 · 线上端到端验收（2026-10-27，v1.1 后续项）
// ---------------------------------------------------------------------------
// 与 source/temp_test/sync-logic_phase2.js 的分工：
//   · sync-logic  = 假数据 + 假 fetch，只测逻辑分支（离线、秒级、不进生产）
//   · 本脚本      = **真实前端代码 + 真实线上接口**，验证"别人真的新建一条，轮询能不能检测到"
// 做法：载入 timeline.js（vm + DOM 桩，fetch 用 Node 原生）→ bootstrap 建基线
//      → 用登录令牌建一条本周日程（模拟另一端写入）→ syncTick() 应检测到并重绘 → 删掉 → 应再检测到
//      → 核对数据复原到基线条数。
// 安全：全程 try/finally，无论成败都尝试删掉临时项；跑完打印最终条数供人工核对。
// 前置：本机可访问线上接口 + WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS（匿名写入已于 2026-10-27 关闭）。
// 用法：node resource/scripts/verify-sync_phase2.js
// 退出码：0 全部通过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const API = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}

let renderCalls = 0, toastMsgs = [];

function elStub(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false,
    dataset: {}, style: {}, children: [], files: [], scrollTop: 0,
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
  getElementById(id) {
    if (id === 'item-form') return null;          // 探针场景：用户没在填表
    if (!elements[id]) elements[id] = elStub(id);
    return elements[id];
  },
  createElement(tag) { return elStub('dyn-' + tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: elStub('html'),
  hidden: false,                                   // 页面可见：允许轮询
};

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() {} },
  navigator: { userAgent: 'sync-live-probe' },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  // ★ 真实网络：线上接口
  fetch: (...a) => globalThis.fetch(...a),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: () => 0, clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const loadJs = (n) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'source', 'js', n), 'utf8'), sandbox, { filename: n });
for (const s of ['timepicker.js', 'login_phase2.js', 'export_phase2.js']) loadJs(s);

let src = fs.readFileSync(path.join(ROOT, 'source', 'js', 'timeline.js'), 'utf8');
src += `
;globalThis.__probe = {
  get items() { return items; },
  get sig() { return _syncSig; },
  get inited() { return _syncInited; },
  syncTick, dataSig,
};`;
try { vm.runInContext(src, sandbox, { filename: 'timeline.js+probe' }); }
catch (e) { console.log('❌ timeline.js 加载失败：' + e.message); process.exit(1); }
for (const s of ['router.js', 'animations.js']) loadJs(s);

const probe = sandbox.__probe;
const realRender = sandbox.render;
const renderStacks = [];
sandbox.render = function (...a) {
  renderCalls++;
  renderStacks.push((new Error().stack || '').split('\n').slice(2, 5).join(' | '));
  return realRender.apply(this, a);
};
const realToast = sandbox.showToast;
sandbox.showToast = function (m) { toastMsgs.push(m); return realToast.call(this, m); };

const p2 = n => String(n).padStart(2, '0');
const now = new Date();
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const D = (d, hhmm) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hhmm}`;
const STAMP = '二次检验临时项-' + Date.now();
let createdId = null;
let baseTotal = -1;   // 全库基线（finally 里要用，故提到 try 外）

// 【多团队 2026-10-27】匿名写入已关闭（seam A 修复）→ 写探针必须带登录令牌。
// 从前这里是「匿名遗留可写面」，现在按新契约改成登录写入；拿不到令牌则如实报错，不静默放行。
let AUTH = {};
async function loginProbe() {
  const name = process.env.WORKSHOP_ADMIN_NAME || '';
  const pass = process.env.WORKSHOP_ADMIN_PASS || '';
  if (!name || !pass) throw new Error('缺少 WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS（匿名写入已关闭，写探针需登录）');
  const r = await fetch(API + '?_action=login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, passcode: pass }),
  });
  const j = await r.json();
  if (!j.ok || !j.data || !j.data.token) throw new Error(`探针登录失败 HTTP ${r.status} ${(j.error && j.error.message) || ''}`);
  AUTH = { 'X-Member-Token': j.data.token };
}

async function apiCount() {
  const r = await fetch(API);
  const j = await r.json();
  return j.data.length;
}

(async () => {
  try {
    await loginProbe();
    baseTotal = await apiCount();
    console.log('──────── 0. 首屏加载（真实接口）────────');
    await sandbox.bootstrap();
    const baseCount = probe.items.length;
    const baseSig = probe.sig;
    check('bootstrap 从线上拉到本周数据', Array.isArray(probe.items), 'items=' + baseCount);
    check('已建立同步基线', probe.inited === true && typeof baseSig === 'string');
    console.log(`  ℹ️ 本周 ${baseCount} 条｜全库 ${await apiCount()} 条`);

    console.log('\n──────── 1. 模拟「A 新建一条」→ 轮询应检测到 ────────');
    const body = {
      table: 'work', type: 'meeting', title: STAMP,
      startTime: D(monday, '20:00'), endTime: D(monday, '21:00'),
      attendees: '', venue: '', note: '自动同步探针创建，稍后自动删除', ownerKey: 'depta',
    };
    const cr = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(body) });
    const cj = await cr.json();
    if (!cr.ok || !cj.ok) {
      check('登录成员新建（另一端的写入）', false, `HTTP ${cr.status} ${JSON.stringify(cj).slice(0, 160)}`);
      throw new Error('__abort__');
    }
    createdId = cj.data.id;
    check('登录成员新建成功（拿到 id）', !!createdId, 'id=' + createdId);

    renderCalls = 0; toastMsgs = [];
    await probe.syncTick();
    check('轮询检测到新增 → 重绘', renderCalls > 0, 'renderCalls=' + renderCalls);
    check('提示「已同步他人的最新改动」', toastMsgs.some(m => /已同步他人的最新改动/.test(m)), JSON.stringify(toastMsgs));
    check('新事项已进入本地数据', probe.items.some(it => it.title === STAMP), 'items=' + probe.items.length);

    console.log('\n──────── 2. 无变化时再轮询 → 不应重绘（防闪屏）────────');
    renderCalls = 0; toastMsgs = []; renderStacks.length = 0;
    await probe.syncTick();
    check('无变化 → 零重绘', renderCalls === 0, 'renderCalls=' + renderCalls + ' stacks=' + JSON.stringify(renderStacks));
    check('无变化 → 不弹提示', toastMsgs.length === 0, JSON.stringify(toastMsgs));

    console.log('\n──────── 3. 删掉它 → 轮询应检测到删除 ────────');
    const dr = await fetch(`${API}?id=${createdId}&confirm=true`, { method: 'DELETE', headers: { ...AUTH } });
    const dj = await dr.json();
    check('删除成功（带 confirm 闸）', dr.ok && dj.ok, `HTTP ${dr.status} ${JSON.stringify(dj).slice(0, 160)}`);
    createdId = null;

    renderCalls = 0; toastMsgs = []; renderStacks.length = 0;
    await probe.syncTick();
    // 注意：本周删到 0 条 → setState('empty') 走"空态面板"分支，**本就不重绘时间线**
    // （时间线被 hideAll 隐藏、显示"暂无事项"面板）。所以这里断言数据与提示，不断言 render。
    check('轮询检测到删除（本地数据已移除）', !probe.items.some(it => it.title === STAMP), 'items=' + probe.items.length);
    check('删除后给出同步提示', toastMsgs.some(m => /已同步他人的最新改动/.test(m)), JSON.stringify(toastMsgs));
    check('条数回到基线', probe.items.length === baseCount, `${probe.items.length} vs ${baseCount}`);
  } catch (e) {
    if (e && e.message !== '__abort__') check('端到端流程无异常', false, e && e.message);
  } finally {
    // 兜底清理：无论成败都不留垃圾数据
    if (createdId) {
      try {
        await fetch(`${API}?id=${createdId}&confirm=true`, { method: 'DELETE', headers: { ...AUTH } });
        console.log('  🧹 已兜底清理临时项 id=' + createdId);
      } catch (_) { console.log('  ⚠️ 兜底清理失败，请手动删除 id=' + createdId); }
    }
    const total = await apiCount().catch(() => -1);
    console.log('\n──────── 数据核对 ────────');
    console.log('全库最终条数：' + total + '（应为基线 ' + baseTotal + '）');
    check('全库数据复原（无残留）', total === baseTotal, '实际 ' + total + ' vs 基线 ' + baseTotal);

    console.log('\n──────── 小结 ────────');
    console.log('通过 ' + pass + ' · 失败 ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
