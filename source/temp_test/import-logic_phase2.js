// 日程导入行为测试（2026-10-28 修复）
// ---------------------------------------------------------------------------
// 目的：查代码发现旧版 importData 有三处硬伤，本测试锁死修复后的契约：
//     ① 旧版只改内存不落库 → 刷新即丢、被 15s 自动同步覆盖掉
//     ② 旧版读 it.start，而导出给的是 startTime 全量串 → Invalid Date，一条都渲染不出
//     ③ 旧版整表替换内存，不是合并
//   验证点：
//     A. 解析层 normalizeImportItem
//        A1 本项目导出格式（startTime 全量串）→ start 归一到当天零点 + HH:mm 拆分
//        A2 前端类型词 class/trip → 库存词 course/travel
//        A3 早期手写格式（start 给日期 + startTime 给 HH:mm）
//        A4 结束时间缺失 → 兜底 +30 分钟
//        A5 结束不晚于开始 → 抛错（后端 422 的前置拦截）
//        A6 缺 title → 抛错（不静默丢条目）
//        A7 未知类型/未知归属 → 兜底 pending/self
//     B. 行为层 importData
//        B1 未登录 → 一条请求都不发，明确提示"需要先登录"
//        B2 已登录 → 逐条 POST 到 /api/items（真正落库）
//        B3 全程不出现 DELETE（合并语义，绝不清空已有日程）
//        B4 409 重复 → 计入"已存在跳过"，不算失败
//        B5 单条非法 → 计入失败，不影响其余条目继续导入
//        B6 非 JSON 文件 → 明确提示，不发请求
//        B7 缺 items 数组 → 明确提示，不发请求
//        B8 超过单次上限 → 拒绝，不发请求
// 用法：node source/temp_test/import-logic_phase2.js
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
let writes = [];        // 写请求记录 [{method,url,body}]
let deletes = 0;        // DELETE 次数（合并语义：必须为 0）
let fileText = '';      // 下一次"读文件"的内容
let dupTitles = [];     // 这些 title 的 POST 返回 409（模拟后端团队内判重）
let alerts = [];        // alert 文案
let toasts = [];

// ===== DOM 桩（与 sync-logic_phase2.js 同款，够 render 跑通）=====
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
    if (!elements[id]) elements[id] = elStub(id);
    return elements[id];
  },
  createElement(tag) { return elStub('dyn-' + tag); },
  querySelectorAll() { return []; },
  querySelector(sel) { if (!elements['qs:' + sel]) elements['qs:' + sel] = elStub('qs:' + sel); return elements['qs:' + sel]; },
  addEventListener() {}, removeEventListener() {},
  body: elStub('body'),
  documentElement: elStub('html'),
  hidden: false,
};

function jsonRes(j, status) {
  return {
    ok: (status || 200) < 400, status: status || 200,
    json: async () => j, text: async () => JSON.stringify(j),
  };
}

const storage = {};
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() {} },
  navigator: { userAgent: 'import-logic-test' },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  // 文件读取桩：同步回调 onload，内容取 fileText
  FileReader: class {
    readAsText() { this.onload && this.onload({ target: { result: fileText } }); }
  },
  alert: (m) => { alerts.push(String(m)); },
  fetch: async (url, opt) => {
    const u = String(url);
    const method = (opt && opt.method) || 'GET';
    if (method === 'DELETE') { deletes++; return jsonRes({ ok: true, data: null }); }
    if (method === 'POST' && u.includes('/api/items')) {
      const body = JSON.parse((opt && opt.body) || '{}');
      writes.push({ url: u, body });
      if (dupTitles.indexOf(body.title) >= 0) {
        return jsonRes({ ok: false, data: null, error: { code: 409, message: '请勿重复提交：该事项已存在' } }, 409);
      }
      return jsonRes({ ok: true, data: { id: 900 + writes.length } });
    }
    if (u.includes('_action=heartbeat')) return jsonRes({ ok: true, data: { online: 1 } });
    if (u.includes('_action=members')) return jsonRes({ ok: true, data: [] });
    if (u.includes('/api/items')) return jsonRes({ ok: true, data: [] });
    return jsonRes({ ok: true, data: [] });
  },
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

const loadJs = (name) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'source', 'js', name), 'utf8'), sandbox, { filename: name });

// 按 index.html 真实顺序加载（少加载 router 会让 setState 静默失败）
const SCRIPTS = ['timepicker.js', 'login_phase2.js', 'export_phase2.js', 'timeline.js', 'router.js', 'animations.js'];
for (const s of SCRIPTS) {
  try { loadJs(s); }
  catch (e) {
    check('加载 ' + s, false, e.name + ': ' + e.message);
    console.log('\n通过 ' + pass + ' · 失败 ' + fail);
    process.exit(1);
  }
}
check('六个脚本整份执行（index.html 真实顺序）', true);

// 把内部函数暴露出来（顶层 function 声明在 vm 里本身就是全局，这里只做断言）
const hasFns = vm.runInContext(
  "typeof normalizeImportItem === 'function' && typeof importData === 'function' && typeof importPlus30 === 'function'",
  sandbox
);
check('normalizeImportItem / importPlus30 / importData 均可用', hasFns);

const norm = (o) => vm.runInContext('normalizeImportItem', sandbox)(o);
const runImport = (text) => { fileText = text; return vm.runInContext('importData', sandbox)({}); };
const setLogged = (yes) => {
  vm.runInContext(
    yes
      ? "window.Auth.currentMember = () => ({ id: 1, name: '测试甲' }); window.Auth.withHeaders = (h) => Object.assign({ 'X-Member-Token': 'T' }, h || {});"
      : "window.Auth.currentMember = () => null; window.Auth.withHeaders = (h) => Object.assign({}, h || {});",
    sandbox
  );
};
function reset() { writes = []; deletes = 0; alerts = []; toasts = []; dupTitles = []; }

// ===== A. 解析层 =====
console.log('\n──────── A. 解析层 normalizeImportItem ────────');

const a1 = norm({ title: '部门周例会', table: 'work', type: 'meeting', startTime: '2026-10-28 10:00', endTime: '2026-10-28 11:00', ownerKey: 'self' });
check('A1 导出格式：start 归一到当天零点', a1.start instanceof Date && a1.start.getHours() === 0 && a1.start.getDate() === 28,
  a1.start instanceof Date ? a1.start.toString() : String(a1.start));
check('A1 导出格式：startTime 拆成 HH:mm', a1.startTime === '10:00' && a1.endTime === '11:00', a1.startTime + '/' + a1.endTime);

const a2 = norm({ title: '高数', table: 'daily', type: 'class', startTime: '2026-10-28 08:00', endTime: '2026-10-28 09:40', ownerKey: 'me' });
check('A2 class → course（库存词）', a2.type === 'course', a2.type);
const a2b = norm({ title: '外出', table: 'work', type: 'trip', startTime: '2026-10-28 08:00', endTime: '2026-10-28 09:40', ownerKey: 'self' });
check('A2 trip → travel（库存词）', a2b.type === 'travel', a2b.type);

const a3 = norm({ title: '旧格式项', table: 'work', type: 'meeting', start: '2026-10-29', startTime: '14:00', endTime: '15:30', ownerKey: 'self' });
check('A3 旧格式（start+HH:mm）日期正确', a3.start.getDate() === 29 && a3.startTime === '14:00', a3.start.toString() + ' ' + a3.startTime);

const a4 = norm({ title: '无结束', table: 'work', type: 'meeting', startTime: '2026-10-28 09:00', ownerKey: 'self' });
check('A4 缺结束时间 → +30 分钟', a4.endTime === '09:30', a4.endTime);

let a5 = '';
try { norm({ title: 'x', startTime: '2026-10-28 10:00', endTime: '2026-10-28 09:00' }); }
catch (e) { a5 = e.message; }
check('A5 结束早于开始 → 抛错', /结束时间须晚于开始/.test(a5), a5 || '未抛错');

let a6 = '';
try { norm({ startTime: '2026-10-28 10:00' }); }
catch (e) { a6 = e.message; }
check('A6 缺 title → 抛错', /缺少 title/.test(a6), a6 || '未抛错');

const a7 = norm({ title: '怪类型', type: 'whatever', ownerKey: 'nonexistent', startTime: '2026-10-28 10:00', endTime: '2026-10-28 11:00' });
check('A7 未知类型 → pending，未知归属 → self', a7.type === 'pending' && a7.ownerKey === 'self', a7.type + '/' + a7.ownerKey);

// ===== B. 行为层 =====
console.log('\n──────── B. 行为层 importData ────────');
const oneItem = JSON.stringify({ version: 1, items: [{ title: '导入A', table: 'work', type: 'meeting', startTime: '2026-10-28 10:00', endTime: '2026-10-28 11:00', ownerKey: 'self' }] });

(async () => {
  // B1 未登录
  reset(); setLogged(false);
  await runImport(oneItem);
  check('B1 未登录：一条写请求都不发', writes.length === 0, '实际 ' + writes.length + ' 条');
  check('B1 未登录：提示"需要先登录"', alerts.some(a => /需要先登录/.test(a)), alerts[0] || '无提示');

  // B2/B3 已登录 → 逐条 POST、无 DELETE
  reset(); setLogged(true);
  await runImport(JSON.stringify({ version: 1, items: [
    { title: '导入B1', table: 'work', type: 'meeting', startTime: '2026-10-28 10:00', endTime: '2026-10-28 11:00', ownerKey: 'self' },
    { title: '导入B2', table: 'daily', type: 'class', startTime: '2026-10-29 08:00', endTime: '2026-10-29 09:40', ownerKey: 'me' },
  ] }));
  check('B2 已登录：逐条 POST 落库（2 条）', writes.length === 2 && writes.every(w => w.url.includes('/api/items')), 'POST ' + writes.length + ' 次');
  check('B2 落库字段为 API 契约（startTime 全量串）', writes[0] && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(writes[0].body.startTime), writes[0] ? writes[0].body.startTime : '无');
  check('B3 合并语义：全程无 DELETE', deletes === 0, 'DELETE ' + deletes + ' 次');
  check('B3 提示里报告新增条数', alerts.some(a => /新增 2 条/.test(a)), alerts[alerts.length - 1] || '无提示');

  // B4 409 重复
  reset(); setLogged(true); dupTitles = ['导入B1'];
  await runImport(oneItem.replace(/导入A/g, '导入B1'));
  check('B4 409 重复 → 计入"已存在跳过"', alerts.some(a => /已存在跳过 1 条/.test(a)), alerts[alerts.length - 1] || '无提示');
  check('B4 重复不算失败', !alerts.some(a => /失败 1 条/.test(a)), alerts[alerts.length - 1] || '无提示');

  // B5 单条非法不影响其余
  reset(); setLogged(true);
  await runImport(JSON.stringify({ items: [
    { title: '合法项', table: 'work', type: 'meeting', startTime: '2026-10-30 10:00', endTime: '2026-10-30 11:00', ownerKey: 'self' },
    { startTime: '2026-10-30 12:00' },
  ] }));
  check('B5 非法条目跳过、合法条目仍写入', writes.length === 1, 'POST ' + writes.length + ' 次');
  check('B5 提示里报告失败 1 条并给位置', alerts.some(a => /失败 1 条/.test(a) && /第 2 条/.test(a)), alerts[alerts.length - 1] || '无提示');

  // B6 非 JSON
  reset(); setLogged(true);
  await runImport('这不是 JSON');
  check('B6 非 JSON → 提示且不发请求', writes.length === 0 && alerts.some(a => /不是合法的 JSON/.test(a)), alerts[0] || '无提示');

  // B7 缺 items
  reset(); setLogged(true);
  await runImport(JSON.stringify({ rows: [] }));
  check('B7 缺 items 数组 → 提示且不发请求', writes.length === 0 && alerts.some(a => /缺少 items 数组/.test(a)), alerts[0] || '无提示');

  // B8 超上限
  reset(); setLogged(true);
  const many = { items: Array.from({ length: 501 }, (_, i) => ({ title: 'x' + i, table: 'work', type: 'meeting', startTime: '2026-10-28 10:00', endTime: '2026-10-28 11:00', ownerKey: 'self' })) };
  await runImport(JSON.stringify(many));
  check('B8 超过 500 条上限 → 拒绝且不发请求', writes.length === 0 && alerts.some(a => /最多导入 500 条/.test(a)), alerts[0] || '无提示');

  console.log('\n通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
