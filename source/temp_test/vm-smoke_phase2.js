// 前端集成 smoke（2026-10-18 管理员 UI + 在线人数）
// ---------------------------------------------------------------------------
// 目的：按 index.html 真实脚本顺序、同一全局作用域执行全部 6 个经典脚本，
//   复现 10-16「跨脚本顶层声明重名 → 整个文件静默不执行」的检测手法
//   （SyntaxError 会立刻现形；并断言新函数确实挂上了全局 = 文件真的跑完了）。
// 本文件不进 git（source/temp_test/ 惯例），可重复跑。
// 用法：node source/temp_test/vm-smoke_phase2.js
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = ['timepicker.js', 'login_phase2.js', 'export_phase2.js', 'timeline.js', 'router.js', 'animations.js'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}

// —— 最小 DOM 桩：getId 元素全缓存复用（跨 querySelector 一致），返回空集合兜底 ——
function elStub(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false,
    dataset: {}, style: {}, children: [], files: [],
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
  getElementById(id) { if (!elements[id]) elements[id] = elStub(id); return elements[id]; },
  createElement(tag) { return elStub('dyn-' + tag); },
  // 宽容桩：querySelector 一律返回可复用元素桩（真实浏览器中这些选择器均命中，
  // 本测试只关心「整份文件是否执行 + 新函数是否挂载」，不测 DOM 行为）
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: elStub('html'),
};

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', reload() {} },
  navigator: { userAgent: 'smoke' },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }), text: async () => '{"ok":true,"data":[]}' }),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0,          // 不真跑心跳/轮询
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
};
sandbox.window = sandbox;        // window 指向全局自身（经典脚本共享全局作用域）
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

console.log('──────── 按 index.html 顺序执行 6 个经典脚本 ────────');
for (const s of SCRIPTS) {
  const code = fs.readFileSync(path.join(ROOT, 'source', 'js', s), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: s });
    check(s + ' 无 SyntaxError（整份执行）', true);
  } catch (e) {
    check(s + ' 无 SyntaxError（整份执行）', false, e.name + ': ' + e.message);
  }
}

console.log('\n──────── 新模块挂载断言（证明文件真的跑完了） ────────');
check('timeline.js 真的执行：heartbeatTick 已挂全局', vm.runInContext('typeof heartbeatTick', sandbox) === 'function');
check('timeline.js 真的执行：startHeartbeat 已挂全局', vm.runInContext('typeof startHeartbeat', sandbox) === 'function');
check('timeline.js 真的执行：renderMemberAdmin 已挂全局', vm.runInContext('typeof renderMemberAdmin', sandbox) === 'function');
check('timeline.js 真的执行：isAdmin 已挂全局', vm.runInContext('typeof isAdmin', sandbox) === 'function');
check('timeline.js 真的执行：renderPasscodeSettings 已挂全局（Step5）', vm.runInContext('typeof renderPasscodeSettings', sandbox) === 'function');
check('timeline.js 真的执行：submitAddMember 已挂全局（Step5）', vm.runInContext('typeof submitAddMember', sandbox) === 'function');
check('timeline.js 真的执行：showPasscodeModal 已挂全局（Step5）', vm.runInContext('typeof showPasscodeModal', sandbox) === 'function');
check('timeline.js 真的执行：syncTick 已挂全局（实时协作）', vm.runInContext('typeof syncTick', sandbox) === 'function');
check('timeline.js 真的执行：startAutoSync 已挂全局（实时协作）', vm.runInContext('typeof startAutoSync', sandbox) === 'function');
check('timeline.js 真的执行：dataSig 已挂全局（实时协作）', vm.runInContext('typeof dataSig', sandbox) === 'function');
check('timeline.js 真的执行：flushPendingSync 已挂全局（实时协作）', vm.runInContext('typeof flushPendingSync', sandbox) === 'function');
check('login_phase2 已挂 window.Auth', vm.runInContext('typeof Auth', sandbox) === 'object');
check('login_phase2 挂载 register（多团队注册）', vm.runInContext('typeof Auth.register', sandbox) === 'function');
check('login_phase2 挂载 openRegisterModal', vm.runInContext('typeof Auth.openRegisterModal', sandbox) === 'function');
check('timeline.js 挂载 renderTeamBox（团队区块）', vm.runInContext('typeof renderTeamBox', sandbox) === 'function');
check('timeline.js 挂载 submitCreateTeam（建团队）', vm.runInContext('typeof submitCreateTeam', sandbox) === 'function');
check('export_phase2 IIFE 后仍挂 window.Export2', vm.runInContext('typeof Export2', sandbox) === 'object');

console.log('\n──────── 小结 ────────');
console.log('通过 ' + pass + ' · 失败 ' + fail);
process.exit(fail ? 1 : 0);
