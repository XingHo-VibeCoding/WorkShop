// 类型与颜色体系测试（2026-10-28，用户拍板 ②B + ③A）
// ---------------------------------------------------------------------------
// 背景：把「硬编码 6 个类型」改成「服务端下发的类型清单」，涉及三层映射
//   （库词 course/travel ↔ 前端词 class/trip ↔ CSS 变量 --c-class/--c-trip），
// 任何一层错位都会表现为「颜色不对 / 下拉少一项 / 总览格子无色」这类难查的问题。
//
// 本测试钉住：
//   ① 库词 → 前端词映射只在一处发生，且自定义类型不被映射污染
//   ② 主题注入：每个类型都拿到 --c-<前端词> 变量
//   ③ 下拉按表归属：工作表只有会议/行程/待安排，日常表只有课表/运动/生活/其他，
//      自定义类型两表都有；历史遗留值不会让下拉变空白
//   ④ 筛选下拉重建后不会偷偷把用户的已选项打回「全部」
//   ⑤ 未知类型词不再一律被兜底成 other（否则新建的类型全显示成灰色"其他"）
//   ⑥ 前后端对比度算法一致（同一颜色不能"前端说行、后端说太浅"）
//   ⑦ SQL 种子类型与后端兜底清单一致（防两边各改各的）
// 用法：node source/temp_test/types-logic_phase2.js
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

// ===== DOM / 环境桩 =====
const cssVars = {};          // 记录被注入的 CSS 变量（模拟 documentElement.style）
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
  documentElement: { style: { setProperty(k, v) { cssVars[k] = v; }, removeProperty(k) { delete cssVars[k]; } } },
  hidden: false,
};

const storage = {};
const toasts = [];
const sandbox = {
  console,
  document: documentStub,
  location: { hash: '#/timeline', href: 'https://example.com/', search: '', reload() {} },
  navigator: { userAgent: 'types-logic-test' },
  localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }) }),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
  URL, URLSearchParams, Buffer, process, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
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
  get TYPE_LIST() { return TYPE_LIST; },
  get TYPE_COLOR_DEFS() { return TYPE_COLOR_DEFS; },
  get TYPE_COLOR_VARS() { return TYPE_COLOR_VARS; },
  get filterState() { return filterState; },
  applyTypeTheme, localTypeCode, apiTypeToLocal, typeOptionsHTML, typeLabelOf, typeLabel,
  renderTypeFilter, TYPE_FALLBACK, isSafeBg, whiteContrast, typeMetaOf, typeSig,
};`;
vm.runInContext(src, sandbox, { filename: 'timeline.js+probe' });
for (const s of SCRIPTS.slice(4)) loadJs(s);
const P = sandbox.__probe;

// ============ ① 库词 → 前端词 ============
console.log('──────── ① 词表映射 ────────');
check('course → class', P.localTypeCode('course') === 'class');
check('travel → trip', P.localTypeCode('travel') === 'trip');
check('meeting 原样', P.localTypeCode('meeting') === 'meeting');
check('自定义类型不被映射污染', P.localTypeCode('custom_abc123') === 'custom_abc123');
check('apiTypeToLocal: course → class', P.apiTypeToLocal('course') === 'class');
check('apiTypeToLocal: 未知词保留（不兜底 other）', P.apiTypeToLocal('custom_abc123') === 'custom_abc123', P.apiTypeToLocal('custom_abc123'));
check('apiTypeToLocal: 空值兜底 other', P.apiTypeToLocal('') === 'other');
check('apiTypeToLocal: undefined 兜底 other', P.apiTypeToLocal(undefined) === 'other');

// ============ ② 主题注入 ============
console.log('──────── ② 主题注入 ────────');
Object.keys(cssVars).forEach(k => delete cssVars[k]);
P.applyTypeTheme([
  { code: 'meeting', label: '会议', color: '#1d4ed8', builtin: true, sortOrder: 10 },
  { code: 'course', label: '课表', color: '#15803d', builtin: true, sortOrder: 20 },
  { code: 'travel', label: '行程', color: '#b45309', builtin: true, sortOrder: 30 },
  { code: 'custom_x1', label: '值班', color: '#0f766e', builtin: false, sortOrder: 100 },
]);
check('每个类型都注入 --c-<前端词>', !!cssVars['--c-meeting'] && !!cssVars['--c-class'] && !!cssVars['--c-trip'] && !!cssVars['--c-custom_x1'], JSON.stringify(Object.keys(cssVars)));
check('库里 course 的颜色落到 --c-class', cssVars['--c-class'] === '#15803d', cssVars['--c-class']);
check('自定义类型有自己的变量', cssVars['--c-custom_x1'] === '#0f766e');
check('TYPE_COLOR_VARS 用前端词做 key', P.TYPE_COLOR_VARS.class === '--c-class' && P.TYPE_COLOR_VARS.trip === '--c-trip');
check('TYPE_COLOR_DEFS 投影为 [[前端词, 标签]]', JSON.stringify(P.TYPE_COLOR_DEFS.find(([c]) => c === 'class')) === JSON.stringify(['class', '课表']));

// ============ ③ 下拉按表归属 ============
console.log('──────── ③ 新建下拉 ────────');
// 恢复成完整的 7 个内置类型（② 只注入了 3 个内置 + 1 个自定义，那是不够做下拉断言的）
P.applyTypeTheme(P.TYPE_FALLBACK.concat([{ code: 'custom_x1', label: '值班', color: '#0f766e', builtin: false, sortOrder: 100 }]));
const workOpts = P.typeOptionsHTML('work', 'meeting');
const dailyOpts = P.typeOptionsHTML('daily', 'class');
check('工作表含会议/行程/待安排', workOpts.includes('value="meeting"') && workOpts.includes('value="trip"') && workOpts.includes('value="pending"'));
check('工作表不含课表', !workOpts.includes('value="class"'));
check('日常表含课表/运动/生活/其他', dailyOpts.includes('value="class"') && dailyOpts.includes('value="sport"') && dailyOpts.includes('value="life"') && dailyOpts.includes('value="other"'));
check('日常表不含会议', !dailyOpts.includes('value="meeting"'));
check('自定义类型两张表都有', workOpts.includes('value="custom_x1"') && dailyOpts.includes('value="custom_x1"'));
check('当前选中项被标 selected', P.typeOptionsHTML('work', 'trip').includes('value="trip" selected'));
// 历史遗留值：类型清单里没有它，也要能显示出来（否则下拉显示空白、编辑保存会悄悄改类型）
const legacy = P.typeOptionsHTML('work', 'archived_type');
check('历史遗留值补一条（不丢当前值）', legacy.includes('value="archived_type" selected'), legacy.slice(0, 80));

// ============ ④ 筛选下拉重建 ============
console.log('──────── ④ 筛选下拉重建 ────────');
P.filterState.type = 'class';
const sel = documentStub.getElementById('filter-type');
sel.value = 'class';
P.renderTypeFilter();
check('重建后保住用户已选类型', sel.value === 'class', sel.value);
check('filterState 同步', P.filterState.type === 'class');
check('下拉列出了自定义类型', sel.innerHTML.includes('value="custom_x1"'));
// 已选类型被删除 → 回「全部」而不是留个空值
P.filterState.type = 'ghost';
sel.value = 'ghost';
P.renderTypeFilter();
check('已选类型不存在 → 回全部', sel.value === 'all', sel.value);

// ============ ⑤ 标签解析 ============
console.log('──────── ⑤ 标签解析 ────────');
check('自定义类型显示自己的名字', P.typeLabelOf({ type: 'custom_x1', table: 'work' }) === '值班');
check('库词 course 的类型显示课表', P.typeLabelOf({ type: 'class', table: 'daily' }) === '课表');
check('未知类型 + 工作表 → 事项', P.typeLabelOf({ type: 'zzz', table: 'work' }) === '事项');
check('未知类型 + 日常表 → 日常', P.typeLabelOf({ type: 'zzz', table: 'daily' }) === '日常');

// ============ ⑥ 前后端对比度算法一致 ============
console.log('──────── ⑥ 对比度算法 ────────');
const idxSrc = fs.readFileSync(path.join(ROOT, 'source', 'cloud', 'items', 'index.js'), 'utf8');
const fnRel = idxSrc.match(/function relLuminance\(hex\)[\s\S]*?\n}/)[0];
const fnCon = idxSrc.match(/function whiteContrast\(hex\) \{[^}]*\}/)[0];
const fnHex = idxSrc.match(/function normalizeHex\(v\)[\s\S]*?\n}/)[0];
const be = new Function(fnRel + fnCon + fnHex + 'return { whiteContrast, normalizeHex };')();

const samples = ['#1d4ed8', '#15803d', '#b45309', '#0e7490', '#6d28d9', '#5b6472', '#ffffff', '#f0a020', '#0f766e', '#7c3aed'];
let mismatch = [];
for (const c of samples) {
  const f = P.whiteContrast(c).toFixed(4);
  const b = be.whiteContrast(c).toFixed(4);
  if (f !== b) mismatch.push(`${c}: 前端 ${f} vs 后端 ${b}`);
  // 前端 isSafeBg 与后端 4.5 阈值必须同结论
  if ((P.whiteContrast(c) >= 4.5) !== (be.whiteContrast(c) >= 4.5)) mismatch.push(`${c}: 阈值结论不一致`);
}
check('前后端对比度逐色一致', mismatch.length === 0, mismatch.join('; '));
check('纯白必然不达标（4.5:1 门槛）', be.whiteContrast('#ffffff') < 1.1);
check('内置 6 色全部达标', ['#1d4ed8', '#15803d', '#b45309', '#0e7490', '#6d28d9', '#5b6472'].every(c => P.isSafeBg(c)));
check('浅橙 #f0a020 不达标（历史踩过的坑）', !P.isSafeBg('#f0a020'), 'contrast=' + P.whiteContrast('#f0a020').toFixed(2));
check('normalizeHex 拒绝非 #RRGGBB', be.normalizeHex('red') === null && be.normalizeHex('#abc') === null);
check('normalizeHex 统一转小写', be.normalizeHex('#1D4ED8') === '#1d4ed8');

// ============ ⑦ SQL 种子 vs 后端兜底 ============
console.log('──────── ⑦ 清单一致性 ────────');
const sql = fs.readFileSync(path.join(ROOT, 'db', 'schema_phase2.sql'), 'utf8');
const seedBlock = (sql.match(/INSERT INTO item_types_phase2[\s\S]*?ON CONFLICT \(code\) DO NOTHING;/) || [''])[0];
const seedCodes = [...seedBlock.matchAll(/\('([a-z_]+)',\s*'([^']+)',\s*'(#[0-9a-f]{6})'/g)].map(m => m[1]);
const seedColors = {};
[...seedBlock.matchAll(/\('([a-z_]+)',\s*'([^']+)',\s*'(#[0-9a-f]{6})'/g)].forEach(m => { seedColors[m[1]] = m[3]; });
check('SQL 种子读到 7 条', seedCodes.length === 7, '实际 ' + seedCodes.length);

const fbBlock = (idxSrc.match(/const ITEM_TYPES_FALLBACK = \[[^\]]*\]/) || [''])[0];
const fbCodes = [...fbBlock.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
check('后端兜底清单与 SQL 种子一致', JSON.stringify([...seedCodes].sort()) === JSON.stringify([...fbCodes].sort()), `SQL=${seedCodes.join(',')} / 后端=${fbCodes.join(',')}`);

// 前端兜底（TYPE_FALLBACK）也要同色，否则"服务端没连上"时颜色会变
const colorMismatch = P.TYPE_FALLBACK
  .filter(t => seedColors[t.code] && seedColors[t.code] !== t.color)
  .map(t => `${t.code}: 前端 ${t.color} vs SQL ${seedColors[t.code]}`);
check('前端兜底色与 SQL 种子一致', colorMismatch.length === 0, colorMismatch.join('; '));

// ============ ⑧ 权限：只有 core 能进类型写路径 ============
console.log('──────── ⑧ 权限识别 ────────');
sandbox.localStorage.removeItem('workshop_member_info');
check('未登录 isCore=false', sandbox.isCore() === false);
for (const role of ['member', 'readonly', 'admin']) {
  sandbox.localStorage.setItem('workshop_member_info', JSON.stringify({ id: 5, role }));
  check(`${role} isCore=false`, sandbox.isCore() === false);
}
sandbox.localStorage.setItem('workshop_member_info', JSON.stringify({ id: 2, role: 'core' }));
check('core isCore=true', sandbox.isCore() === true);
check('core 不算 isAdmin（体系级权限 ≠ 团队管理权）', sandbox.isAdmin() === false);

console.log('\n通过 ' + pass + ' · 失败 ' + fail);
process.exit(fail ? 1 : 0);
