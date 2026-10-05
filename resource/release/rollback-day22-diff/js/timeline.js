/* WorkShop MVP — 周时间线 + 双表(工作/日常) + 三模式 + 重叠提醒 + 四状态机
   默认渲染（不引入 PreText）。已预留 renderItemText() 接缝，后续可无缝替换 PreText。
   记号渲染走统一 markOf()，支持「头像图片优先、符号兜底」，满足「标记可自定义」。 */

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// [Day 14] 重叠分栏布局：时间纵向定位 + 横向分栏（lane/stacking）常量与工具
const DAY_START_HOUR = 7, DAY_END_HOUR = 22, HOUR_PX = 52; // 列高 = (22-7)*52 = 780px
const DAY_START_MIN = DAY_START_HOUR * 60;
const MIN_ITEM_PX = 52; // 卡片最小高度：标记+标题+时间 三行（备注已移入 hover/focus 浮窗，不挤占卡片）
function toMin(hhmm) { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
/* 贪心分配 lane：按 start 顺序给每个事项找第一个空闲 lane（结束时间≤当前 start），
   否则新开 lane。返回 id→laneIndex 与总 lane 数；并发 N 个重叠项即 N 列。 */
function assignLanes(sorted) {
  const laneEnds = []; const map = new Map(); let laneCount = 0;
  sorted.forEach(it => {
    const s = toMin(it.startTime), e = toMin(it.endTime);
    let placed = -1;
    for (let i = 0; i < laneEnds.length; i++) { if (laneEnds[i] <= s) { placed = i; break; } }
    if (placed < 0) { placed = laneEnds.length; laneEnds.push(e); } else { laneEnds[placed] = e; }
    laneCount = Math.max(laneCount, placed + 1);
    map.set(it.id, placed);
  });
  return { map, laneCount };
}

/* 记号 = 部门 / 人物（是否私人）。颜色 = 日程类型。
   用户 2026-09-20：记号只做部门与人物区分（私人），不表示类型；类型用颜色区分。
   后续多用户：每人各自记号；avatarUrl 可来自导入图片或腾讯文档/会议默认头像。 */
/* [Day 9] 自定义部门：由设置弹窗增删改驱动；默认两项（我部门/我私人）受保护不可删。
   持久化：暂存内存，刷新重置；接入腾讯文档后改为云端同步（见 PRD §6）。 */
let OWNERS = [
  { key: 'self',   name: '我(部门)', mark: '★', avatarUrl: null },
  { key: 'depta',  name: '综合部',   mark: '△', avatarUrl: null },
  { key: 'deptb',  name: '业务部',   mark: '○', avatarUrl: null },
  { key: 'deptc',  name: '技术部',   mark: '□', avatarUrl: null },
  { key: 'deptd',  name: '外联部',   mark: '☆', avatarUrl: null },
  { key: 'me',     name: '我(私人)', mark: '我', avatarUrl: null },
];
const PROTECTED_OWNER_KEYS = ['self', 'me'];
// [Day 9] 默认启动视图（设置可改，暂存内存）
let defaultStartMode = 'work';
// [Day 9] 类型色键值对照（设置可改，实时写入 CSS 变量）
const TYPE_COLOR_DEFS = [
  ['meeting', '会议'], ['trip', '行程'], ['pending', '待安排'],
  ['class', '课表'], ['sport', '运动'], ['life', '生活'],
];
const ownerOf = key => OWNERS.find(o => o.key === key) || OWNERS[OWNERS.length - 1];

/* 三模式：工作事项表 / 日常事项表 / 总表 */
const MODES = [
  { key: 'work',  label: '工作事项表' },
  { key: 'daily', label: '日常事项表' },
  { key: 'all',   label: '总表' },
];

// 统一记号出口：头像图片优先（avatarUrl），缺省用符号兜底。后续可改为 <img> 徽章/印章
function markOf(it) {
  const o = ownerOf(it.ownerKey);
  return { symbol: o.mark, name: o.name, avatar: it.avatarUrl || o.avatarUrl || null };
}

function typeLabelOf(it) {
  if (it.table === 'daily') {
    return ({ class: '课表', sport: '运动', life: '生活', other: '其他' })[it.type] || '日常';
  }
  return ({ meeting: '会议', trip: '行程', pending: '待安排' })[it.type] || '事项';
}

// 取得「某周周一」的 Date；offset=0 本周，±1 上/下周
function mondayOf(offsetWeeks = 0) {
  const d = new Date();
  const jsDay = d.getDay();
  const mondayIndex = (jsDay + 6) % 7;
  d.setDate(d.getDate() - mondayIndex + offsetWeeks * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtMD(date) { return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 四状态机（全局，覆盖三视图）----
const appState = { value: 'loading', error: null };
let currentView = 'timeline';   // [Day 13] 当前视图：timeline | overview（设置仍是弹窗，不走路由）

function showGlobalState(which) {
  const gs = document.getElementById('global-state');
  if (!gs) return;
  gs.hidden = !which;
  gs.querySelectorAll('.state-panel').forEach(p => { p.hidden = (p.dataset.state !== which); });
}
function showViews() {
  document.getElementById('view-timeline').hidden = currentView !== 'timeline';
  document.getElementById('view-overview').hidden = currentView !== 'overview';
}
function setState(s, msg) {
  appState.value = s;
  const hideAll = () => {
    document.getElementById('view-timeline').hidden = true;
    document.getElementById('view-overview').hidden = true;
  };
  if (s === 'loading' || s === 'error') {
    hideAll();
    showGlobalState(s);
    if (s === 'error') { const em = document.getElementById('error-msg'); if (em) em.textContent = msg || '日程数据加载出错，请重试。'; }
  } else if (s === 'empty') {
    if (currentView === 'timeline') { hideAll(); showGlobalState('empty'); }
    else { showGlobalState(null); showViews(); renderCurrentView(); }
  } else { // success
    showGlobalState(null); showViews(); renderCurrentView();
  }
  const sync = document.getElementById('stat-sync');
  if (sync) { sync.textContent = '同步状态：公网接口已连接（CloudBase items 表）'; sync.dataset.state = s; }
}

// ---- [Day 20] 真实 API 接线：loadItems 从 mock 切换为调用公网接口 ----
/* API 地址 = CloudBase HTTP 网关默认域名（Day 15 部署，路由 /api/items 在 Day 17 配置）。
   此地址为公开免鉴权路由，不含任何密钥；密钥（CB_API_KEY）只存在于云函数环境变量中。
   接口契约见 api-contract.md §2：GET /api/items?start=&end= → { ok, data, error }。 */
const API_BASE = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';

// Date → "YYYY-MM-DD HH:mm"（本地时区，东八区）
function fmtAPITime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// API 事项 → 前端内部结构：后端 startTime/endTime 是全量时间字符串，
// 前端内部用 start(Date) + startTime/endTime(HH:mm) 分离，此处负责拆分（契约 §二）。
// ⚠️ start 必须归一到当天 00:00:00——mock 时代 render() 按 start 与「当天零点」
// 全等匹配分列（timeline.js 渲染处的隐含约定），带时刻会导致一条都匹配不上。
// API 类型词表 → 前端 CSS 词表。数据库存的是 API 词（course/travel/...），
// 前端色板/图例/筛选按 mock 词表（class/trip/...）定义；未知词兜底为 other（灰）。
const API_TYPE_MAP = { meeting: 'meeting', course: 'class', travel: 'trip', sport: 'sport', life: 'life', pending: 'pending' };
const apiTypeToLocal = t => API_TYPE_MAP[t] || 'other';

function apiItemToLocal(a) {
  const t = s => String(s || '').slice(11, 16);            // "YYYY-MM-DD HH:mm" → "HH:mm"
  const datePart = String(a.startTime || '').slice(0, 10); // "YYYY-MM-DD"
  return {
    id: String(a.id),
    table: a.table,
    type: apiTypeToLocal(a.type),
    title: a.title,
    start: new Date(`${datePart}T00:00:00`),
    startTime: t(a.startTime),
    endTime: t(a.endTime),
    attendees: a.attendees || '',
    venue: a.venue || '',
    note: a.note || '',
    ownerKey: a.ownerKey,
  };
}

function loadItems(weekOffset = 0) {
  const debug = new URLSearchParams(location.search).get('debug');
  if (debug === 'empty') return Promise.resolve([]);                              // 演示「空」状态
  if (debug === 'error') return Promise.reject(new Error('模拟：接口读取失败（调试参数触发）'));
  const monday = mondayOf(weekOffset);
  const sundayEnd = addDays(monday, 6);
  sundayEnd.setHours(23, 59, 0, 0);
  const url = `${API_BASE}/api/items?start=${encodeURIComponent(fmtAPITime(monday))}&end=${encodeURIComponent(fmtAPITime(sundayEnd))}`;
  return fetch(url)
    .then(async res => {
      let j = null;
      try { j = await res.json(); } catch (e) { /* 非 JSON 响应，走下方统一报错 */ }
      if (!res.ok || !j || !j.ok) {
        const msg = (j && j.error && j.error.message) || `接口异常（HTTP ${res.status}）`;
        throw new Error(msg);
      }
      return j.data.map(apiItemToLocal).filter(it => !deletedIds.has(it.id)); // 剔除本页已删项
    });
}

// ---- [Day 22] 写链路接线：新建(POST) / 编辑(PATCH) / 删除(DELETE) ----
/* 读链路 Day 20 已接云端（loadItems）；今天把写链路也接上，UI 上的增删改才真的落到库里。
   三条原则：
     1) 云端项（id 为纯数字，库里 SERIAL 主键）走接口；本地临时项（'u...' / 种子 's1' 等）只改内存并如实提示，
        不拿假 id 去打接口（后端会 400 挡回，但前端先判掉更省一次往返）。
     2) 失败一律可见：网络异常 / 400 / 404 / 409 / 422 都把后端的中文 message 原样显示，不静默吞掉。
     3) 成功才改内存：先落库成功，再用接口返回的最新记录回写界面，避免"界面显示成功、库里没有"。 */

// 前端色板词 → 库存词（库里既有数据是 course/travel，前端按 class/trip 定义样式）
const LOCAL_TYPE_TO_API = { class: 'course', trip: 'travel' };
const localTypeToApi = t => LOCAL_TYPE_TO_API[t] || t;

// 是否为云端真实记录：库里 id 是 SERIAL 整数；本地临时 id 形如 'u1718…'、种子形如 's1'/'d1'
const isCloudId = id => /^\d+$/.test(String(id || ''));

// 前端内部项（start(Date) + startTime/endTime(HH:mm)）→ API 请求体（YYYY-MM-DD HH:mm 全量）
function localItemToPayload(d) {
  const p = n => String(n).padStart(2, '0');
  const dateStr = `${d.start.getFullYear()}-${p(d.start.getMonth() + 1)}-${p(d.start.getDate())}`;
  return {
    table: d.table,
    type: localTypeToApi(d.type),
    title: d.title,
    startTime: `${dateStr} ${d.startTime}`,
    endTime: `${dateStr} ${d.endTime}`,
    attendees: d.attendees || '',
    venue: d.venue || '',
    note: d.note || '',
    ownerKey: d.ownerKey,
  };
}

// 统一发写请求并解包 { ok, data, error }：失败抛 Error，把后端中文提示带出来（err.code 便于分支处理）
async function apiMutate(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('网络异常：连不上服务器' + (e && e.message ? `（${e.message}）` : ''));
  }
  let j = null;
  try { j = await res.json(); }
  catch (e) { throw new Error(`接口返回异常（HTTP ${res.status}）`); }
  if (!res.ok || !j || !j.ok) {
    const msg = (j && j.error && j.error.message) || `接口异常（HTTP ${res.status}）`;
    const err = new Error(msg);
    err.code = (j && j.error && j.error.code) || res.status;
    throw err;
  }
  return j.data;
}

// ---- 内存态数据（seed；步骤4 再落腾讯文档）----
function seedItems(monday) {
  return [
    // 工作事项表
    { id: 's1', table: 'work', type: 'meeting', title: '部门周例会', start: addDays(monday, 0), startTime: '10:00', endTime: '11:00', attendees: '全体', venue: '302会议室', note: '本周要点同步', ownerKey: 'self' },
    { id: 's2', table: 'work', type: 'meeting', title: '项目评审会', start: addDays(monday, 2), startTime: '14:00', endTime: '15:30', attendees: '张工、李工', venue: '线上', note: '阶段一验收', ownerKey: 'deptb' },
    { id: 's3', table: 'work', type: 'trip', title: '外出调研', start: addDays(monday, 4), startTime: '09:00', endTime: '18:00', attendees: '—', venue: '城东片区', note: '实地走访', ownerKey: 'deptd' },
    { id: 's4', table: 'work', type: 'meeting', title: '临时碰头', start: addDays(monday, 2), startTime: '15:00', endTime: '16:00', attendees: '李工', venue: '线上', note: '顺带对一下评审', ownerKey: 'self' }, // 与 s2 重叠→冲突
    // 日常事项表（私人项，统一归「我(私人)」；类型用颜色区分）
    { id: 'd1', table: 'daily', type: 'class', title: '高等数学', start: addDays(monday, 0), startTime: '08:00', endTime: '09:40', attendees: '—', venue: '一教', note: '', ownerKey: 'me' },
    { id: 'd2', table: 'daily', type: 'class', title: '专业英语', start: addDays(monday, 2), startTime: '14:00', endTime: '15:40', attendees: '—', venue: '二教', note: '', ownerKey: 'me' },
    { id: 'd3', table: 'daily', type: 'life', title: '社团例会', start: addDays(monday, 2), startTime: '15:00', endTime: '16:30', attendees: '—', venue: '活动中心', note: '与课表重叠但允许', ownerKey: 'me' }, // 与 d2 重叠→提醒
    { id: 'd4', table: 'daily', type: 'sport', title: '夜跑', start: addDays(monday, 4), startTime: '19:00', endTime: '20:30', attendees: '—', venue: '操场', note: '', ownerKey: 'me' },
  ];
}

let items = [];
// [Day 11] 已删除项 id 集合：种子数据每次切周会被 loadItems 重灌，靠此集合让删除跨周持久（仅内存态，刷新重置）
const deletedIds = new Set();

// =================== [Day 12] 筛选状态：类型 + 关键词（纯前端过滤，不依赖后端）===================
// frontend-guidelines §2: 筛选不改变类型色语义；§7: 控件 aria-label 由 HTML 提供、键盘可达
let filterState = { type: 'all', keyword: '' };

// 在三模式 view 之上再叠加筛选（类型 + 关键词）；无条件时原样返回，不破坏现有渲染
function applyFilter(list) {
  const { type, keyword } = filterState;
  const kw = keyword.trim().toLowerCase();
  if (type === 'all' && !kw) return list;
  return list.filter(it => {
    const typeOk = type === 'all' || it.type === type;
    const kwOk = !kw || String(it.title || '').toLowerCase().includes(kw);
    return typeOk && kwOk;
  });
}

// 筛选条件描述（用于无结果空状态提示）
function filterDesc() {
  const parts = [];
  if (filterState.type !== 'all') {
    const def = TYPE_COLOR_DEFS.find(([k]) => k === filterState.type);
    parts.push(def ? def[1] : filterState.type);
  }
  if (filterState.keyword.trim()) parts.push(`含“${filterState.keyword.trim()}”`);
  return parts.join('、') || '全部';
}
let currentOffset = 0;
// [Day 10] 周切换可浏览范围：以本周(offset=0)为原点，前后各 4 周，防无限翻页、也便于演示到边界
const WEEK_MIN = -4, WEEK_MAX = 4;
let currentMode = defaultStartMode;
let currentItem = null;  // [Day 9] 跟踪当前详情项，便于设置变更后实时刷新

// ---- 渲染接缝：默认纯文本；后续接 PreText 时在此切换排版后端 ----
/* 后续方向（用户 2026-09-21 定，选 B 推迟）：做 PreText 与纯 CSS 两套渲染后端对照——
   同一 renderItemCard 组件通过 renderItemText() 接缝切换引擎（PreText 走真实字形测量、CSS 走默认，
   CDN 不可达自动降级），用于验证排版效果差异。当前仅纯 CSS 实现。 */
function renderItemText(item) { return item.title; }

/* ============ 可复用卡片组件（余力加练 Day 8）============
   renderItemCard：单一事项卡片，时间线 / 详情共用同一渲染源，消除重复拼接。
   后续 PreText 对照组件将复用此组件 + renderItemText 接缝。 */
function renderItemCard(item, opts = {}) {
  const { showMark = false, warn = null, onClick = null } = opts;
  const m = markOf(item);
  const el = document.createElement('div');
  el.className = `item type-${item.type}`;
  el.dataset.id = item.id;
  el.tabIndex = 0; // 可聚焦：键盘 Tab 到卡片即显示备注浮窗（聚焦即生效）
  // 排版：标记+标题 同行 → 时间 一行（备注移入 hover/focus 浮窗，不再挤占最矮卡片高度）
  el.innerHTML =
    (showMark ? `<span class="item-mark" title="${esc(m.name)}">${esc(m.symbol)}</span>` : '') +
    `<span class="item-title">${esc(renderItemText(item))}</span>` +
    `<span class="item-time">${item.startTime}–${item.endTime}</span>` +
    (warn ? `<span class="item-warn" title="${esc(warn.title)}">⚠</span>` : '');
  el.addEventListener('click', onClick || (() => showDetail(item)));
  // 备注浮窗：桌面端 hover/聚焦即显示完整备注；移动端触摸无 hover，改为「点卡片→底部抽屉看备注」，故内部判 isMobile 屏蔽浮窗
  el.addEventListener('mouseenter', () => { if (!isMobile()) showNote(item, el); });
  el.addEventListener('mouseleave', () => { if (!isMobile()) scheduleNoteHide(); });
  el.addEventListener('focusin', () => { if (!isMobile()) showNote(item, el); });
  el.addEventListener('focusout', () => { if (!isMobile()) scheduleNoteHide(); });
  return el;
}

// ============ [Day 14] 备注浮窗：hover/focus 即生效，尺寸随字数自动调节 ============
// 宽度：按字数自适应（width = clamp(BASE_W + n*PER_CHAR, MIN_W, MAX_W)），不改变。
// 高度：下限 = 2 × 时间表最小单元高度(MIN_ITEM_PX)；内容超过上限时显示滚动条，不随字数无限增高。
let _notePop = null;
let _noteHideTimer = null;
let _noteCurrent = null;
function ensureNotePop() {
  if (_notePop) return _notePop;
  const el = document.createElement('div');
  el.id = 'note-pop';
  el.hidden = true;
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  // 鼠标移入浮窗：保持显示（便于滚动看完整备注），移出才延迟隐藏
  el.addEventListener('mouseenter', cancelNoteHide);
  el.addEventListener('mouseleave', scheduleNoteHide);
  _notePop = el;
  return _notePop;
}
function notePopMetrics(text) {
  const n = (text || '').trim().length;
  const MIN_W = 160, BASE_W = 200, MAX_W = 360, PER_CHAR = 7;
  const width = Math.min(MAX_W, Math.max(MIN_W, BASE_W + n * PER_CHAR));
  // 高度：下限 = 2 × 时间表最小单元高度(MIN_ITEM_PX)，超出上限则滚动条；宽度保持按字数自适应不变
  const CHAR_W = 13, LINE_H = 18, PAD = 16;
  const NOTE_FLOOR = 2 * MIN_ITEM_PX;   // 下限：2 × 时间表最小单元高度（=104px）
  const NOTE_CAP = NOTE_FLOOR + 176;    // 上限，超出则滚动
  const charsPerLine = Math.max(1, Math.floor((width - 16) / CHAR_W));
  const rows = Math.max(1, Math.ceil(n / charsPerLine));
  const height = Math.min(NOTE_CAP, Math.max(NOTE_FLOOR, rows * LINE_H + PAD));
  return { width, height };
}
// 浮窗尽量贴在卡片旁边：优先右侧，放不下则左侧，再不行上下；长备注滚动条也贴着卡片，便于看完整
function showNote(item, cardEl) {
  const note = (item.note || '').trim();
  if (!note) return;
  ensureNotePop();
  _noteCurrent = { item, cardEl };
  const pop = _notePop;
  const m = notePopMetrics(note);
  pop.textContent = note;
  pop.style.width = m.width + 'px';        // 宽度：按字数自适应，不改
  pop.style.height = m.height + 'px';      // 高度：下限=2×单元高，超出上限滚动
  pop.style.overflowY = 'auto';
  pop.hidden = false;
  cancelNoteHide();
  positionNoteBeside(cardEl, m);
}
function positionNoteBeside(cardEl, m) {
  const pop = _notePop;
  const r = cardEl.getBoundingClientRect();
  const gap = 8, vw = window.innerWidth, vh = window.innerHeight;
  let left = r.right + gap;                       // 优先右侧
  if (left + m.width > vw - 8) left = r.left - m.width - gap;  // 放不下则左侧
  if (left < 8) left = Math.max(8, Math.min(vw - m.width - 8, r.left)); // 都没有则居中收边
  let top = r.top;                               // 与卡片顶对齐
  top = Math.max(8, Math.min(vh - m.height - 8, top));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
function cancelNoteHide() { if (_noteHideTimer) { clearTimeout(_noteHideTimer); _noteHideTimer = null; } }
function scheduleNoteHide() { cancelNoteHide(); _noteHideTimer = setTimeout(hideNote, 200); }
function hideNote() {
  if (_noteHideTimer) { clearTimeout(_noteHideTimer); _noteHideTimer = null; }
  if (_notePop) _notePop.hidden = true;
  _noteCurrent = null;
}

// ============ [Day 14] 保存成功提示（toast）============
let _toast = null;
function showToast(msg) {
  if (!_toast) {
    const el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    _toast = el;
  }
  _toast.textContent = msg;
  _toast.hidden = false;
  _toast.classList.remove('show');
  void _toast.offsetWidth; // 重播动画
  _toast.classList.add('show');
  clearTimeout(_toast._t);
  _toast._t = setTimeout(() => _toast.classList.remove('show'), 1800);
}

/* 重叠检测：按天分组，时间点相交即重叠（"HH:mm" 同格式可字典序比较） */
function findOverlaps(list) {
  const byDay = {};
  list.forEach(it => { const k = it.start.getTime(); (byDay[k] = byDay[k] || []).push(it); });
  const overlap = new Set();
  Object.values(byDay).forEach(arr => {
    arr.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j].startTime < arr[i].endTime) { overlap.add(arr[i].id); overlap.add(arr[j].id); }
        else break;
      }
    }
  });
  return overlap;
}

/* 跨表冲突：工作表事项 与 日常表事项 在同一天时间重叠（你不能在两处） */
function findCrossOverlaps(workList, dailyList) {
  const wByDay = {}, dByDay = {};
  workList.forEach(it => { const k = it.start.getTime(); (wByDay[k] = wByDay[k] || []).push(it); });
  dailyList.forEach(it => { const k = it.start.getTime(); (dByDay[k] = dByDay[k] || []).push(it); });
  const overlap = new Set();
  Object.keys(wByDay).forEach(k => {
    const ws = wByDay[k], ds = dByDay[k] || [];
    ws.forEach(w => ds.forEach(d => {
      if (w.startTime < d.endTime && d.startTime < w.endTime) { overlap.add(w.id); overlap.add(d.id); }
    }));
  });
  return overlap;
}

function markHTML(m, withName) {
  const inner = m.avatar
    ? `<img class="item-avatar" src="${esc(m.avatar)}" alt="${esc(m.name)}">`
    : `<span class="item-mark" title="${esc(m.name)}">${m.symbol}</span>`;
  return inner + (withName ? `<span class="owner-name">${esc(m.name)}</span>` : '');
}

function legendHTML() {
  const TYPE_C = {
    meeting: 'var(--c-meeting)', trip: 'var(--c-trip)', pending: 'var(--c-pending)',
    class: 'var(--c-class)', sport: 'var(--c-sport)', life: 'var(--c-life)', other: 'var(--c-pending)',
  };
  const TYPE_L = { meeting: '会议', trip: '行程', pending: '待安排', class: '课表', sport: '运动', life: '生活', other: '其他' };
  const typeLegend = Object.keys(TYPE_L)
    .map(k => `<span class="legend-item"><span class="chip" style="background:${TYPE_C[k]}"></span>${TYPE_L[k]}</span>`).join('');
  const markList = OWNERS.map(o => {
    const m = markOf({ ownerKey: o.key });
    return `<span class="legend-item">${markHTML(m)} ${esc(o.name)}</span>`;
  }).join('');
  const markSection = currentMode === 'all'
    ? `<div class="legend-title">记号（仅总表显示，区分部门/人物）</div><div class="legend-row">${markList}</div>`
    : '';
  return `<div class="legend">
    <div class="legend-title">类型颜色</div><div class="legend-row">${typeLegend}</div>
    ${markSection}
  </div>`;
}

// ============ [Day 14] 重叠折叠 + 展开弹窗 ============
// 把一组按开始时间排序的事项，按「时间互相交叠」聚成连通分量（冲突组）。
// 锚点 = 组内时长最长者（并列取最早开始），代表该组在周时间线上渲染的那一张卡。
function buildGroups(items) {
  const sorted = [...items].sort((a, b) =>
    a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
  const used = new Set();
  const groups = [];
  sorted.forEach(it => {
    if (used.has(it.id)) return;
    const group = [it]; used.add(it.id);
    let maxEnd = it.endTime, minStart = it.startTime, changed = true;
    while (changed) {
      changed = false;
      for (const o of sorted) {
        if (used.has(o.id)) continue;
        const oS = toMin(o.startTime), oE = toMin(o.endTime);
        const gS = toMin(minStart), gE = toMin(maxEnd);
        if (oS < gE && oE > gS) { // 与该组整体时间窗相交
          group.push(o); used.add(o.id);
          if (oE > toMin(maxEnd)) maxEnd = o.endTime;
          if (oS < toMin(minStart)) minStart = o.startTime;
          changed = true;
        }
      }
    }
    // 锚点 = 时长最长（并列取最早开始）
    group.sort((a, b) =>
      (toMin(b.endTime) - toMin(b.startTime)) - (toMin(a.endTime) - toMin(a.startTime))
      || a.startTime.localeCompare(b.startTime));
    groups.push({ items: group, anchor: group[0], startMin: toMin(minStart), endMin: toMin(maxEnd) });
  });
  return groups;
}

// 重叠展开弹窗：覆盖时间线可视区（右侧栏保持可点），组内各日程按时间水平铺开（lane 分行）。
let _overlapPop = null;     // { root, backdrop, panel, track, title }
let _overlapCurrent = null; // 当前打开的 group

function ensureOverlapPop() {
  if (_overlapPop) return _overlapPop;
  const root = document.createElement('div');
  root.id = 'overlap-pop';
  root.hidden = true;
  root.innerHTML =
    `<div class="overlap-backdrop" id="overlap-backdrop"></div>` +
    `<div class="overlap-panel" role="dialog" aria-label="重叠日程展开">` +
      `<div class="overlap-head">` +
        `<span class="overlap-title" id="overlap-title"></span>` +
        `<button class="overlap-close" id="overlap-close" aria-label="关闭">×</button>` +
      `</div>` +
      `<div class="overlap-track" id="overlap-track"></div>` +
      `<p class="overlap-hint">按时间在此铺开（重叠项左右分栏）· 新增/删除后本界面自动刷新 · 点卡片看右侧详情</p>` +
    `</div>`;
  document.body.appendChild(root);
  const backdrop = root.querySelector('#overlap-backdrop');
  const track = root.querySelector('#overlap-track');
  const title = root.querySelector('#overlap-title');
  backdrop.addEventListener('click', closeOverlapModal);
  root.querySelector('#overlap-close').addEventListener('click', closeOverlapModal);
  root._keyHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeOverlapModal(); } };
  document.addEventListener('keydown', root._keyHandler);
  _overlapPop = { root, backdrop, panel: root.querySelector('.overlap-panel'), track, title };
  return _overlapPop;
}

function openOverlapModal(group, ovSets) {
  const pop = ensureOverlapPop();
  _overlapCurrent = group;
  // 仅覆盖时间线可视区：固定定位到 .timeline 的屏幕矩形，右侧栏(兄弟节点)保持可点
  const tl = document.getElementById('timeline');
  const r = tl.getBoundingClientRect();
  pop.root.style.left = r.left + 'px';
  pop.root.style.top = r.top + 'px';
  pop.root.style.width = r.width + 'px';
  pop.root.style.height = r.height + 'px';
  pop.title.textContent = `${group.items.length} 个日程重叠`;
  renderOverlapTrack(group, pop.track, ovSets);
  pop.root.hidden = false;
  pop.root.classList.remove('is-open');
  void pop.root.offsetWidth; // 强制 reflow，重播入场动画
  pop.root.classList.add('is-open');
  fitOverlapText(pop.track);
  fitOverlapHeight(pop.track); // [Day14] PreText 真实测量卡片内容，校正弹窗高度与滚动阈值
}

// 弹窗内：迷你时间轴——按起止时间纵向定位、重叠项左右分栏(lane)，每张卡仍是竖排三行，与主表一致
function renderOverlapTrack(group, track, ovSets) {
  const { items, startMin, endMin } = group;
  const span = Math.max(1, endMin - startMin);
  const sorted = [...items].sort((a, b) =>
    a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
  const { map: laneMap, laneCount } = assignLanes(sorted);
  const laneW = laneCount > 0 ? 100 / laneCount : 100;
  const trackH = Math.max(5 * MIN_ITEM_PX, (span / 60) * HOUR_PX); // 下限=5×最小单元高(260px)；自然高度按跨距纵向铺开，容纳全部重叠事项
  // 时间刻度：每小时一条线 + 标签
  const h0 = Math.floor(startMin / 60), h1 = Math.ceil(endMin / 60);
  let axis = '';
  for (let h = h0; h <= h1; h++) {
    const y = ((h * 60 - startMin) / span) * trackH;
    axis += `<div class="ot-hour" style="top:${y}px"><span>${String(h).padStart(2, '0')}:00</span></div>`;
  }
  track.style.position = 'relative';
  track.style.height = trackH + 'px';
  track.style.maxHeight = (6 * MIN_ITEM_PX) + 'px'; // ≈312px：超过约6个时间表最小单元高度才启用滚动条
  track.style.overflowY = 'auto';
  track.innerHTML = `<div class="ot-axis">${axis}</div>`;
  sorted.forEach(it => {
    const lane = laneMap.has(it.id) ? laneMap.get(it.id) : 0;
    const s = toMin(it.startTime), e = toMin(it.endTime);
    const top = ((s - startMin) / span) * trackH;
    const h = Math.max((e - s) / 60 * HOUR_PX, MIN_ITEM_PX);
    let ovClass = '';
    if (ovSets) {
      if (ovSets.crossOverlap.has(it.id)) ovClass = 'overlap-cross';
      else if (ovSets.workOverlap.has(it.id)) ovClass = 'overlap-work';
      else if (ovSets.dailyOverlap.has(it.id)) ovClass = 'overlap-daily';
    }
    const warnTitle = ovClass === 'overlap-cross' ? '跨表冲突：工作与日常时间重叠'
      : ovClass === 'overlap-work' ? '工作冲突：时间重叠'
      : ovClass === 'overlap-daily' ? '日常提醒：时间重叠（允许重叠）' : null;
    const card = renderItemCard(it, {
      showMark: currentMode === 'all',
      warn: ovClass ? { title: warnTitle } : null,
      onClick: () => {
        showDetail(it);
        track.querySelectorAll('.ot-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      }
    });
    card.classList.add('ot-card');
    if (ovClass) card.classList.add(ovClass);
    card.style.position = 'absolute';
    card.style.top = top + 'px';
    card.style.height = h + 'px';
    card.style.left = `calc(${lane * laneW}% + 2px)`;
    card.style.width = `calc(${laneW}% - 4px)`;
    track.appendChild(card);
  });
}

function closeOverlapModal() {
  if (!_overlapPop || _overlapPop.root.hidden) return;
  _overlapPop.root.classList.remove('is-open');
  _overlapPop.root.hidden = true;
  _overlapCurrent = null;
}

// 实时刷新：数据变更（增/删/改）后，若重叠弹窗开着，按当前数据重建弹窗内容
function currentViewModel() {
  const monday = mondayOf(currentOffset), sunday = addDays(monday, 6);
  const candidates = items.filter(it => it.start >= monday && it.start <= sunday);
  const view = currentMode === 'all' ? candidates : candidates.filter(it => it.table === currentMode);
  const filtered = applyFilter(view);
  const workItems = candidates.filter(it => it.table === 'work');
  const dailyItems = candidates.filter(it => it.table === 'daily');
  const workOverlap = findOverlaps(workItems);
  const dailyOverlap = findOverlaps(dailyItems);
  const crossOverlap = findCrossOverlaps(workItems, dailyItems);
  return { candidates, filtered, workOverlap, dailyOverlap, crossOverlap };
}
function refreshOverlapModal() {
  if (!_overlapPop || _overlapPop.root.hidden || !_overlapCurrent) return;
  const { filtered, workOverlap, dailyOverlap, crossOverlap } = currentViewModel();
  const anchorId = _overlapCurrent.anchor.id;
  const dayTime = _overlapCurrent.anchor.start.getTime();
  const dayItems = filtered.filter(it => it.start.getTime() === dayTime);
  const groups = buildGroups(dayItems);
  const same = groups.find(g => g.items.some(it => it.id === anchorId));
  if (!same || same.items.length <= 1) { closeOverlapModal(); return; } // 重叠已消解
  _overlapCurrent = same;
  _overlapPop.title.textContent = `${same.items.length} 个日程重叠`;
  renderOverlapTrack(same, _overlapPop.track, { workOverlap, dailyOverlap, crossOverlap });
  fitOverlapText(_overlapPop.track);
}

// PreText 适配弹窗内卡片标题：超宽则缩字号（真实字形测量、零 reflow），不可达自动降级 CSS
async function fitOverlapText(track) {
  const mod = await ensurePretext();
  if (!mod) return;
  const w = Math.max(80, track.clientWidth - 40);
  track.querySelectorAll('.item-title').forEach(el => {
    const text = el.textContent;
    let size = 13;
    try {
      const font = '600 13px "PingFang SC","Microsoft YaHei",sans-serif';
      const prep = mod.prepare(text, font, { whiteSpace: 'normal', wordBreak: 'break-word' });
      while (size > 10) {
        const laid = mod.layout(prep, w, size + 5);
        if (laid.lineCount <= 1) break;
        size -= 1;
      }
      el.style.fontSize = size + 'px';
      el.style.lineHeight = (size + 5) + 'px';
    } catch (e) { /* 保持 CSS 默认 */ }
  });
}

function render() {
  const monday = mondayOf(currentOffset);
  const sunday = addDays(monday, 6);

  const candidates = items.filter(it => it.start >= monday && it.start <= sunday);
  const view = currentMode === 'all' ? candidates : candidates.filter(it => it.table === currentMode);
  // [Day 12] 在三模式 view 之上叠加筛选（类型+关键词）；重叠检测仍用 candidates 不变
  // frontend-guidelines §2: 筛选不改类型色；§6: 筛后点击详情等交互不失效
  const hasFilter = filterState.type !== 'all' || filterState.keyword.trim() !== '';
  const filtered = applyFilter(view);

  const workItems = candidates.filter(it => it.table === 'work');
  const dailyItems = candidates.filter(it => it.table === 'daily');
  const workOverlap = findOverlaps(workItems);
  const dailyOverlap = findOverlaps(dailyItems);
  const crossOverlap = findCrossOverlaps(workItems, dailyItems);

  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const col = document.createElement('div');
    col.className = 'day-col';
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `<div class="day-name">${WEEKDAYS[i]}</div><div class="day-date">${fmtMD(dayDate)}</div>`;
    col.appendChild(head);

    const body = document.createElement('div');
    body.className = 'day-body';
    const dayItems = filtered.filter(it => it.start.getTime() === dayDate.getTime())
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
    // [Day 14] 重叠折叠：同天事项按时间交叠聚成冲突组，每组只渲染最长那张作锚点卡，
    // 其余成员在周时间线隐藏；组内有多个日程时，锚点卡上方贴半透明角标（重叠数 + 各成员记号）。
    // 点击锚点卡或角标 → 弹窗水平铺开（详见 buildGroups / openOverlapModal）。
    const groups = buildGroups(dayItems);
    groups.forEach(group => {
      const it = group.anchor;
      const s = toMin(it.startTime), e = toMin(it.endTime);
      const top = (s - DAY_START_MIN) / 60 * HOUR_PX;
      const h = Math.max((e - s) / 60 * HOUR_PX, MIN_ITEM_PX);
      const ovCross = crossOverlap.has(it.id);
      const ovWork = workOverlap.has(it.id);
      const ovDaily = dailyOverlap.has(it.id);
      let ovClass = '', ovTitle = '';
      if (ovCross) { ovClass = 'overlap-cross'; ovTitle = '跨表冲突：工作与日常时间重叠'; }
      else if (ovWork) { ovClass = 'overlap-work'; ovTitle = '工作冲突：时间重叠'; }
      else if (ovDaily) { ovClass = 'overlap-daily'; ovTitle = '日常提醒：时间重叠（允许重叠）'; }
      const hasOv = ovClass !== '';
      // 锚点卡占满整列宽度（其余成员已折叠进弹窗）
      const card = renderItemCard(it, {
        showMark: currentMode === 'all',
        warn: hasOv ? { title: ovTitle } : null,
        onClick: group.items.length > 1 ? () => openOverlapModal(group, { workOverlap, dailyOverlap, crossOverlap }) : null,
      });
      if (hasOv) card.classList.add(ovClass);
      card.style.position = 'absolute';
      card.style.top = top + 'px';
      card.style.height = h + 'px';
      card.style.left = '4px';
      card.style.right = '4px';
      card.style.width = 'auto';
      body.appendChild(card);

      // 角标：组内有多个日程才显示（紧贴锚点卡上方）
      if (group.items.length > 1) {
        const badge = document.createElement('div');
        badge.className = 'overlap-badge' + (hasOv ? ' ' + ovClass : '');
        const labels = group.items.map(g => {
          const gm = markOf(g);
          return `<span class="ob-label" title="${esc(gm.name)}">${esc(gm.symbol)}</span>`;
        }).join('');
        badge.innerHTML = `<span class="ob-count">${group.items.length} 个日程重叠</span><span class="ob-labels">${labels}</span>`;
        const badgeTop = Math.max(top - 24, 0);
        badge.style.top = badgeTop + 'px';
        badge.addEventListener('click', (ev) => { ev.stopPropagation(); openOverlapModal(group, { workOverlap, dailyOverlap, crossOverlap }); });
        body.appendChild(badge);
      }
    });
    col.appendChild(body);
    timeline.appendChild(col);
  }

  // [Day 12] 筛选无结果：覆盖 7 列空壳，改为友好提示（区别于"本周无事项"空状态）
  // frontend-guidelines §1: 空提示在时间线区内、不另起状态层；§6: 清空后此处自动恢复 7 列
  if (hasFilter && filtered.length === 0) {
    timeline.innerHTML = `<div class="filter-empty">
      <p class="filter-empty-title">未找到匹配${esc(filterDesc())}的事项</p>
      <p class="filter-empty-hint">试试调整条件，或点「清空筛选」恢复全部事项。</p>
    </div>`;
  }

  const weekLabel = currentOffset === 0 ? '本周' : (currentOffset > 0 ? '下' + currentOffset + '周' : '上' + (-currentOffset) + '周');
  document.getElementById('week-range').textContent = `${fmtMD(monday)} ~ ${fmtMD(sunday)} · ${weekLabel}`;
  const modeLabel = (MODES.find(x => x.key === currentMode) || {}).label || '';
  document.getElementById('stat-week').textContent = `当前周：${weekLabel}`;
  // [Day 12] 计数反映筛后数；有筛选时标注"筛选中"让用户知道当前是过滤态
  document.getElementById('stat-count').textContent = `事项（${modeLabel}）：${filtered.length}${hasFilter ? ' · 筛选中' : ''}`;
  const wn = [...workOverlap].filter(id => filtered.some(v => v.id === id)).length;
  const dn = [...dailyOverlap].filter(id => filtered.some(v => v.id === id)).length;
  const cn = [...crossOverlap].filter(id => filtered.some(v => v.id === id)).length;
  const ovParts = [];
  if (wn) ovParts.push(`工作⚠${wn}`);
  if (dn) ovParts.push(`日常⚠${dn}`);
  if (cn) ovParts.push(`跨表⚠${cn}`);
  document.getElementById('stat-overlap').textContent = ovParts.length ? `重叠：${ovParts.join(' / ')}` : '重叠：无';

  // [Day 10] 周切换边界反馈：到达最早/最晚可查看周时禁用对应按钮并给出状态栏提示
  const prevBtn = document.getElementById('btn-prev-week');
  const nextBtn = document.getElementById('btn-next-week');
  const weekHint = document.getElementById('stat-week-hint');
  const atMin = currentOffset <= WEEK_MIN, atMax = currentOffset >= WEEK_MAX;
  prevBtn.disabled = atMin;
  nextBtn.disabled = atMax;
  prevBtn.title = atMin ? `已到最早可查看周（往前最多 ${Math.abs(WEEK_MIN)} 周）` : '上一周';
  nextBtn.title = atMax ? `已到最晚可查看周（往后最多 ${WEEK_MAX} 周）` : '下一周';
  weekHint.textContent = atMin ? `⚠ 已到最早可查看周（往前最多 ${Math.abs(WEEK_MIN)} 周）`
    : atMax ? `⚠ 已到最晚可查看周（往后最多 ${WEEK_MAX} 周）` : '';
}

// ---- [Day 20 修复] 关闭移动端详情抽屉 ----
/* closeDetailDrawer 在 Day 14 就被 showDetail(null) 引用，但函数体一直没写（潜伏 bug）：
   mock 时代每周都有种子数据，此分支永远跑不到；Day 20 接真实数据库后空周必触发，
   ReferenceError 被 bootstrap 的 catch 接住 → 整页误报「加载失败」。
   行为按 base.css 的移动端抽屉契约实现：移除 .open 收起底部抽屉与遮罩；桌面端无该类，安全空操作。 */
function closeDetailDrawer() {
  const d = document.getElementById('detail');
  if (d) d.classList.remove('open');
  const scrim = document.querySelector('.detail-scrim');
  if (scrim) scrim.classList.remove('open');
}

function showDetail(item) {
  currentItem = item || null;
  const d = document.getElementById('detail');
  if (!item) {
    d.innerHTML = `<p class="detail-empty">点击时间线上的事项查看详情，或点「+ 新建」添加。底部可切换工作/日常/总表。</p>${legendHTML()}`;
    closeDetailDrawer();
    return;
  }
  const m = markOf(item);
  const tableLabel = item.table === 'daily' ? '日常事项表' : '工作事项表';
  const ownerHTML = currentMode === 'all'
    ? `<span class="owner-mark">${markHTML(m)} ${esc(m.name)}</span>`
    : `<span class="owner-mark">${markHTML(m)} ${esc(m.name)}</span>`;
  d.innerHTML = `
    <div class="detail-card">
      <h3>${esc(item.title)}</h3>
      <p class="row">
        <span class="badge table-${item.table}">${tableLabel}</span>
        <span class="badge type-${item.type}">${typeLabelOf(item)}</span>
        ${ownerHTML}
      </p>
      <p class="row"><b>时间</b>${fmtMD(item.start)} ${item.startTime}–${item.endTime}</p>
      <p class="row"><b>参与人</b>${esc(item.attendees)}</p>
      <p class="row"><b>场地</b>${esc(item.venue)}</p>
      <p class="row"><b>备注</b>${item.note ? esc(item.note) : '<span style="color:var(--ink-soft)">—</span>'}</p>
      <div class="form-actions">
        <button class="btn-edit" id="btn-edit">编辑</button>
        <button class="btn-delete" id="btn-delete">删除此事项</button>
      </div>
    </div>
    ${legendHTML()}`;
  document.getElementById('btn-edit').addEventListener('click', () => renderForm(item));
  document.getElementById('btn-delete').addEventListener('click', () => deleteItem(item.id));
}

function renderForm(existing) {
  const isEdit = !!existing;
  const tbl = existing ? existing.table : 'work';
  const monday = mondayOf(currentOffset);

  const dayOpts = WEEKDAYS.map((nm, i) => {
    const dd = addDays(monday, i);
    const sel = existing && existing.start && existing.start.getTime() === dd.getTime() ? 'selected' : '';
    return `<option value="${i}" ${sel}>${nm} ${fmtMD(dd)}</option>`;
  }).join('');
  const formModes = MODES.filter(m => m.key !== 'all');
  const modeOpts = formModes.map(m => `<option value="${m.key}" ${m.key === tbl ? 'selected' : ''}>${m.label}</option>`).join('');
  const ownerOpts = OWNERS.filter(o => o.key !== 'me').map(o => `<option value="${o.key}" ${existing && existing.ownerKey === o.key ? 'selected' : ''}>${o.mark} ${esc(o.name)}</option>`).join('');

  const d = document.getElementById('detail');
  d.innerHTML = `
    <div class="detail-card">
      <h3>${isEdit ? '编辑事项' : '新建事项'}</h3>
      <form id="item-form">
        <label>所属表<select name="table" id="f-table">${modeOpts}</select></label>
        <div id="f-owner" class="cond-field"><label>部门 / 成员<select name="ownerKey">${ownerOpts}</select></label></div>
        <label>标题<input name="title" value="${isEdit ? esc(existing.title) : ''}" required maxlength="40"></label>
        <label>类型<select name="type" id="f-type">${typeOptionsHTML(tbl, isEdit ? existing.type : 'meeting')}</select></label>
        <label>日期（本周）<select name="day">${dayOpts}</select></label>
        <div id="f-range" class="cond-field" ${isEdit ? 'hidden' : ''}>
          <label>重复规则<select name="repeat" id="f-repeat">
            <option value="none">不重复（单次）</option>
            <option value="daily">每日</option>
            <option value="weekday">每工作日（周一至周五）</option>
            <option value="mon">每周一</option>
            <option value="tue">每周二</option>
            <option value="wed">每周三</option>
            <option value="thu">每周四</option>
            <option value="fri">每周五</option>
            <option value="sat">每周六</option>
            <option value="sun">每周日</option>
          </select></label>
          <label>区间结束日（可选）<input type="date" name="endDate" id="f-enddate"></label>
          <p class="range-preview" id="range-preview"></p>
        </div>
        <div class="row2">
          <label>开始<input name="startTime" value="${isEdit ? existing.startTime : '09:00'}" placeholder="HH:mm"></label>
          <label>结束<input name="endTime" value="${isEdit ? existing.endTime : '10:00'}" placeholder="HH:mm"></label>
        </div>
        <label>参与人<input name="attendees" value="${isEdit ? esc(existing.attendees) : ''}"></label>
        <label>场地<input name="venue" value="${isEdit ? esc(existing.venue) : ''}"></label>
        <label>备注<textarea name="note" rows="2">${isEdit ? esc(existing.note) : ''}</textarea></label>
        <div class="form-actions">
          <button type="submit" class="btn-save primary">${isEdit ? '保存修改' : '创建'}</button>
          <button type="button" class="btn-cancel" id="btn-cancel">取消</button>
        </div>
      </form>
    </div>
    ${legendHTML()}`;

  // [Day 22 修复] f 此前在本函数内从未定义，901 行 f.querySelector 会抛 ReferenceError，
  // 导致下方 submit 绑定整段不执行 —— 点「创建」走的是浏览器原生表单提交（整页刷新、数据丢失）。
  const f = document.getElementById('item-form');
  const fTable = document.getElementById('f-table');
  const fType = document.getElementById('f-type');
  const syncCond = () => {
    const t = fTable.value;
    document.getElementById('f-owner').style.display = t === 'work' ? '' : 'none';
    fType.innerHTML = typeOptionsHTML(t, fType.value);
  };
  fTable.addEventListener('change', syncCond);
  syncCond();

  // [板块B] 区间插入预览：选重复规则 + 结束日时，实时算出将生成多少条
  const fRepeat = document.getElementById('f-repeat');
  const fEnd = document.getElementById('f-enddate');
  const fDay = f.querySelector('[name="day"]');
  const previewEl = document.getElementById('range-preview');
  const updateRangePreview = () => {
    if (!previewEl || !fRepeat || !fEnd || !fDay) return;
    const rep = fRepeat.value;
    const es = fEnd.value;
    if (rep === 'none' || !es) { previewEl.textContent = ''; return; }
    const startD = addDays(mondayOf(currentOffset), parseInt(fDay.value, 10));
    const endD = new Date(es + 'T00:00:00');
    if (isNaN(endD.getTime()) || endD < startD) { previewEl.textContent = '结束日需不早于起始日'; return; }
    let n = 0; const d = new Date(startD);
    while (d <= endD) { if (matchRule(d, rep)) n++; d = addDays(d, 1); }
    previewEl.textContent = `将生成约 ${n} 条（${fmtMD(startD)} 起，至 ${es}）`;
  };
  if (fRepeat) fRepeat.addEventListener('change', updateRangePreview);
  if (fEnd) fEnd.addEventListener('input', updateRangePreview);
  if (fDay) fDay.addEventListener('change', updateRangePreview);

  document.getElementById('item-form').addEventListener('submit', e => { e.preventDefault(); saveItem(existing); });
  document.getElementById('btn-cancel').addEventListener('click', () => showDetail(existing || null));
}

function typeOptionsHTML(table, selected) {
  const map = table === 'daily'
    ? [['class', '课表'], ['sport', '运动'], ['life', '生活'], ['other', '其他']]
    : [['meeting', '会议'], ['trip', '行程'], ['pending', '待安排']];
  return map.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}

// [板块B] 重复规则匹配：判断某天 d 是否落在规则内（dw: 0=周日）
function matchRule(d, rule) {
  const dw = d.getDay();
  if (rule === 'daily') return true;
  if (rule === 'weekday') return dw >= 1 && dw <= 5;
  const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
  return map[rule] !== undefined && dw === map[rule];
}

async function saveItem(existing) {
  const f = document.getElementById('item-form');
  const fd = new FormData(f);
  const table = fd.get('table');
  const dayIndex = parseInt(fd.get('day'), 10);
  const start = addDays(mondayOf(currentOffset), dayIndex);
  const data = {
    table,
    type: fd.get('type'),
    title: fd.get('title').trim(),
    startTime: fd.get('startTime'),
    endTime: fd.get('endTime'),
    attendees: fd.get('attendees').trim(),
    venue: fd.get('venue').trim(),
    note: fd.get('note').trim(),
    start,
    ownerKey: table === 'work' ? fd.get('ownerKey') : 'me',
  };

  // ---- 越界①/②：前端先挡一道，后端还有 400/422 兜底（双保险，省一次往返）----
  if (!data.title) { showToast('请填写标题'); return; }
  if (data.startTime && data.endTime && data.endTime < data.startTime) {
    showToast('结束时间不能早于开始时间'); return;
  }

  // [板块B] 区间批量插入（仅新建、且选了重复规则 + 结束日）：把长期日程展开成多条
  // 批量写库属「今日不做」，故仍只进内存，但文案如实告知未同步，避免误以为已落库
  const repeat = fd.get('repeat') || 'none';
  const endDateStr = fd.get('endDate') || '';
  if (!existing && repeat !== 'none' && endDateStr) {
    const endD = new Date(endDateStr + 'T00:00:00');
    if (!isNaN(endD.getTime()) && endD >= start) {
      const generated = [];
      let d = new Date(start), i = 0;
      while (d <= endD) {
        if (matchRule(d, repeat)) {
          generated.push(Object.assign({ id: 'u' + Date.now() + '-' + i }, data, { start: new Date(d) }));
          i++;
        }
        d = addDays(d, 1);
      }
      if (generated.length) {
        generated.forEach(g => items.push(g));
        showDetail(generated[0]);
        afterMutation();
        showToast(`已生成 ${generated.length} 条日程（批量生成仅在本页，未同步云端）`);
        return;
      }
    }
  }

  const payload = localItemToPayload(data);

  // ---- 编辑已有项 ----
  if (existing) {
    if (!isCloudId(existing.id)) {
      // 本地临时项 / 种子项：没有云端 id，改不了库，如实提示
      Object.assign(existing, data);
      showDetail(existing);
      afterMutation();
      showToast('已保存（此项没有云端 id，仅修改本页显示）');
      return;
    }
    try {
      const updated = await apiMutate('PATCH', `${API_BASE}/api/items?id=${existing.id}`, payload);
      Object.assign(existing, apiItemToLocal(updated));  // 用库里返回的最新值回写（含 week 重算、updatedAt）
      showDetail(existing);
      afterMutation();
      showToast('已保存（已同步云端）');
    } catch (e) {
      // 越界③：保存失败不动内存、不关表单，让用户改完再试（避免"界面说成功、库里没改"）
      showToast('保存失败：' + e.message);
    }
    return;
  }

  // ---- 新建 → POST 落库，用云端返回的真实 id 替换本地临时 id ----
  try {
    const created = await apiMutate('POST', `${API_BASE}/api/items`, payload);
    const saved = apiItemToLocal(created);
    items.push(saved);
    showDetail(saved);   // 保存后右侧栏立即回显最新内容（修复表单残留）
    afterMutation();
    showToast('已新建（已写入云端，id=' + saved.id + '）');
  } catch (e) {
    // 越界④：409 重复提交 / 422 时间非法 / 400 缺字段 / 网络异常，都把后端中文提示原样显示
    showToast('新建失败：' + e.message);
  }
}

// ---- 删除确认弹窗（Day 11）：页面内状态机，替代原生 confirm() ----
/* 状态机：confirm(确认弹窗) → loading(处理中) → success(移除+刷新) / fail(红字+重试)
   最明确的“生效”反馈 = 点击删除后按钮立即进入 loading 禁用态(spinner) + 成功后卡片可见消失。 */
function deleteItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  openDeleteModal(it);
}

// loading 期间锁定用户关闭（遮罩/Esc），防止“以为取消实则已删”的歧义
let _delUserCloseLocked = false;

function openDeleteModal(item) {
  const overlay = document.getElementById('delete-modal');
  const body = document.getElementById('delete-body');
  if (!overlay || !body) return;
  _delUserCloseLocked = false; // 确认态可关闭
  // 注入「确认」状态
  // [Day 22] 副提示按"有没有云端 id"分流：云端项会真删库，必须把时间和不可恢复说清楚（后端闸门 E）
  const _cloud = isCloudId(item.id);
  const _subText = _cloud
    ? `将从云端删除，删除后无法恢复（${esc(item.startTime || '')}–${esc(item.endTime || '')}${item.venue ? ' · ' + esc(item.venue) : ''}）`
    : '此操作仅从本地内存移除（该项没有云端 id，不会删除云端数据）。';
  body.innerHTML =
    `<p class="del-msg">确定要删除「<b>${esc(item.title)}</b>」吗？</p>` +
    `<p class="del-sub">${_subText}</p>` +
    `<div class="del-actions">` +
      `<button id="del-cancel">取消</button>` +
      `<button class="btn-danger" id="del-confirm">删除</button>` +
    `</div>`;
  // PreText 探索版（?debug=pretext / window.USE_PRETEXT）：先加 3D 分层 class（a），测量延后到弹窗显示后做以保证宽度准确
  const pretextOn = window.USE_PRETEXT || new URLSearchParams(location.search).get('debug') === 'pretext';
  if (pretextOn) overlay.classList.add('modal--pretext');
  // 打开：先去 hidden 再触发淡入动画（避开 [hidden]{display:none!important}）
  overlay.hidden = false;
  overlay.classList.remove('is-open');
  void overlay.offsetWidth; // 强制 reflow，确保每次打开重播动画
  overlay.classList.add('is-open');
  // 弹窗显示后再做 PreText 真实字形测量（此时 body.clientWidth 为真实宽度，测量才准）；纯 CSS 下此调用直接 return
  renderModalText(body, item);
  // 焦点落「取消」防误删；随后可 Tab 到「删除」
  document.getElementById('del-cancel').focus();
  // 绑定：取消 / 关闭按钮 / 遮罩点击 / 确认删除
  document.getElementById('del-cancel').onclick = () => closeDeleteModal();
  document.getElementById('delete-close').onclick = () => closeDeleteModal();
  overlay.onclick = (e) => { if (e.target === overlay) closeDeleteModal(); };
  document.getElementById('del-confirm').onclick = () => runDelete(item);
  // 键盘：Esc 取消 / Enter 触发主操作（确认态=删除，失败态=重试；loading 态忽略）
  overlay._keyHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDeleteModal(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const confirm = overlay.querySelector('#del-confirm');
      if (confirm && !confirm.disabled) confirm.click();
    }
  };
  overlay.addEventListener('keydown', overlay._keyHandler);
}

async function runDelete(item) {
  const overlay = document.getElementById('delete-modal');
  const body = document.getElementById('delete-body');
  if (!body) return;
  _delUserCloseLocked = true; // loading 中锁定用户关闭
  // 处理中：spinner + 禁用按钮（用户最明确知道“操作在生效”的信号）
  body.innerHTML = `<p class="del-loading"><span class="spinner"></span>正在删除「${esc(item.title)}」…</p>`;
  // 失败分支：?debug=delfail 模拟后端错误
  const fail = new URLSearchParams(location.search).get('debug') === 'delfail';

  // 失败态：真实失败与模拟失败共用同一块 UI，都给「重试」入口（不静默吞错）
  const showFail = (msg) => {
    if (!body) return;
    _delUserCloseLocked = false; // 失败态解锁，可取消
    body.innerHTML =
      `<p class="del-error del-error-shake">删除失败：${esc(msg)}</p>` +
      `<div class="del-actions">` +
        `<button id="del-cancel">取消</button>` +
        `<button class="btn-danger" id="del-confirm">重试</button>` +
      `</div>`;
    document.getElementById('del-cancel').onclick = () => closeDeleteModal();
    document.getElementById('del-confirm').onclick = () => runDelete(item);
  };

  if (fail) { setTimeout(() => showFail('网络异常，请稍后重试。'), 700); return; }

  // 越界⑤：本地临时项 / 种子项没有云端 id，只从本页移除，不打接口
  if (!isCloudId(item.id)) {
    setTimeout(() => {
      deletedIds.add(item.id);
      items = items.filter(x => x.id !== item.id);
      afterMutation(true);
      _delUserCloseLocked = false;
      closeDeleteModal();
      showToast('已删除（仅本页，云端无此记录）');
    }, 300);
    return;
  }

  // 云端项 → DELETE（必须带 confirm=true，对应后端闸门 A：没确认不许删）
  try {
    await apiMutate('DELETE', `${API_BASE}/api/items?id=${item.id}&confirm=true`);
    // 成功：移除数据 → 刷新 → 关闭弹窗（卡片可见消失 = 第二个生效信号）
    deletedIds.add(item.id); // 标记已删，切周重灌种子后也不复活
    items = items.filter(x => x.id !== item.id);
    afterMutation(true);
    _delUserCloseLocked = false;
    closeDeleteModal();
    showToast('已删除（已从云端移除）');
  } catch (e) {
    // 越界⑥：404 = 云端已经没有了（可能别处删过），这不算失败——同步本页即可
    if (e.code === 404) {
      deletedIds.add(item.id);
      items = items.filter(x => x.id !== item.id);
      afterMutation(true);
      _delUserCloseLocked = false;
      closeDeleteModal();
      showToast('该事项在云端已不存在，已从本页移除');
      return;
    }
    // 其余（网络异常 / 400 / 500）：留在弹窗里给重试
    showFail(e.message);
  }
}

function closeDeleteModal() {
  const overlay = document.getElementById('delete-modal');
  if (!overlay || overlay.hidden) return;
  if (_delUserCloseLocked) return; // loading 中锁定用户关闭
  overlay.classList.remove('modal--pretext'); // 清掉 PreText 探索版的 3D 分层 class
  overlay.classList.remove('is-open');
  overlay.hidden = true;
  overlay.onclick = null;
  if (overlay._keyHandler) { overlay.removeEventListener('keydown', overlay._keyHandler); overlay._keyHandler = null; }
  // 焦点返回触发按钮（若存在；删除成功后详情可能被清空则跳过）
  const trigger = document.getElementById('btn-delete');
  if (trigger) trigger.focus();
}

// ---- 弹窗文案排版接缝（PreText 探索版，备后续统一风格替换）----
/* 与 renderItemText 同思路：默认纯 CSS；启用 PreText 时走真实字形测量（CDN 不可达自动降级）。
   当前弹窗文案极短，PreText 主要用于验证“零 reflow 真实测量”在弹窗场景同样可用。 */
let _pretextMod = null;
async function ensurePretext() {
  if (_pretextMod !== null) return _pretextMod;
  const on = window.USE_PRETEXT || new URLSearchParams(location.search).get('debug') === 'pretext';
  if (!on) { _pretextMod = false; return _pretextMod; }
  try {
    _pretextMod = await import('https://esm.sh/@chenglou/pretext@0.0.9');
  } catch (e) {
    console.warn('[PreText] CDN 不可达，降级 CSS 默认排版', e);
    _pretextMod = false;
  }
  return _pretextMod;
}
async function renderModalText(body, item) {
  const mod = await ensurePretext();
  if (!mod) return; // 纯 CSS，无需处理
  const w = Math.max(120, body.clientWidth - 36); // 弹窗已显示，clientWidth 为真实宽度（避免 hidden 期测成 0）
  // (b) 标题：超 2 行则逐档缩字号（真实字形测量，零 reflow）
  const titleEl = body.querySelector('.del-msg b');
  if (titleEl) {
    let size = 15;
    try {
      const font = '600 15px "PingFang SC","Microsoft YaHei",sans-serif';
      const prep = mod.prepare(titleEl.textContent, font, { whiteSpace: 'normal', wordBreak: 'break-word' });
      while (size > 11) {
        const laid = mod.layout(prep, w, size + 6);
        if (laid.lineCount <= 2) break;
        size -= 1;
      }
      titleEl.style.fontSize = size + 'px';
      titleEl.style.lineHeight = (size + 6) + 'px';
    } catch (e) { console.warn('[PreText] 标题测量失败，保持 CSS 默认', e); }
  }
  // (b) 扩到正文：副提示 del-sub 同样按真实字形测量，超 2 行缩字号，使 PreText 版与 CSS 版产生可见差异
  const subEl = body.querySelector('.del-sub');
  if (subEl) {
    let size = 12;
    try {
      const font = '400 12px "PingFang SC","Microsoft YaHei",sans-serif';
      const prep = mod.prepare(subEl.textContent, font, { whiteSpace: 'normal', wordBreak: 'break-word' });
      while (size > 10) {
        const laid = mod.layout(prep, w, size + 4);
        if (laid.lineCount <= 2) break;
        size -= 1;
      }
      subEl.style.fontSize = size + 'px';
      subEl.style.lineHeight = (size + 4) + 'px';
    } catch (e) { console.warn('[PreText] 副文测量失败，保持 CSS 默认', e); }
  }
}

// 变更后刷新：重渲染并根据本周是否还有事项切换 success / empty
function afterMutation(backToEmpty) {
  render();
  refreshOverlapModal(); // [Day 14] 重叠弹窗开着时同步刷新
  const monday = mondayOf(currentOffset), sunday = addDays(monday, 6);
  const hasWeek = items.some(it => it.start >= monday && it.start <= sunday);
  setState(hasWeek ? 'success' : 'empty');
  if (!hasWeek) showDetail(null);
  else if (backToEmpty) showDetail(null);
}

// ---- 预留接口（今日不实装）----
/* [预留] 导入识别：第 3 周接入 OCR / 外部 AI 接口（如百度智能云 OCR），
   把图片/表格转结构化事项后再 loadItems 合并。当前仅禁用按钮占位。 */
function importSchedule() { /* TODO(周3): 调 OCR API → 解析 → 合并 items → afterMutation() */ }

/* [预留] 拖动式删除/转移：给 .item 加 draggable + dragstart/dragover/drop，
   实现跨日/跨表拖拽改期与转移；今日仅预留，不实现交互。 */
function setupDragTransfer() { /* TODO: 拖拽改期 / 转移到其他表或删除区 */ }

/* [预留] 反馈栏（设想①）：接口实装后挂载 #feedback-bar，反馈数据写腾讯文档；
   空闲时间总览（设想②）：computeFreeTime 返回每表半小时粒度空闲网格，供 #free-time-overview 渲染。 */
function computeFreeTime(view) { /* TODO(设想②): 以半小时为单位统计每日空闲，后续支持导出 + AI 精细化 */ }

// 周切换
document.getElementById('btn-prev-week').addEventListener('click', () => { currentOffset = Math.max(WEEK_MIN, currentOffset - 1); bootstrap(); });
document.getElementById('btn-next-week').addEventListener('click', () => { currentOffset = Math.min(WEEK_MAX, currentOffset + 1); bootstrap(); });
// 新建
document.getElementById('btn-new').addEventListener('click', () => renderForm(null));
// 空状态「新建」
document.getElementById('btn-empty-new').addEventListener('click', () => { setState('success'); renderForm(null); });
// 错误状态「重试」
document.getElementById('btn-retry').addEventListener('click', () => bootstrap());
// 底部表签切换
document.getElementById('sheet-tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  currentMode = btn.dataset.mode;
  document.querySelectorAll('#sheet-tabs button').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

// [Day 9] 初始/设置中切换默认视图：定位当前表签的 active 态并刷新
function activateModeTab(mode) {
  currentMode = mode;
  document.querySelectorAll('#sheet-tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  render();
}

// ---- 启动：进入加载态 → 异步取数 → 成功/空/错误 ----
async function bootstrap() {
  setState('loading');
  try {
    const data = await loadItems(currentOffset);
    items = data;
    setState(data.length ? 'success' : 'empty');
    render();
    if (!data.length) showDetail(null);
  } catch (e) {
    setState('error', e.message || '日程数据加载出错，请重试。');
  }
}

// 首次启动按默认视图定位表签
currentMode = defaultStartMode;
activateModeTab(currentMode);
bootstrap();

// =================== [Day 9] 设置系统（实装） ===================
// 白字对比校验：WCAG AA 要求白字 on 背景 ≥4.5:1，防止把类型色调回不达标浅色
function relLuminance(hex) {
  const c = (hex || '#000').replace('#', '');
  const ch = h => parseInt(h, 16) / 255;
  const r = ch(c.substr(0, 2)), g = ch(c.substr(2, 2)), b = ch(c.substr(4, 2));
  const f = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function whiteContrast(hex) { return 1.05 / (relLuminance(hex) + 0.05); }
function isSafeBg(hex) { return whiteContrast(hex) >= 4.5; }

let resetDrag = () => {};
function openSettings() { renderSettings(); const m = document.getElementById('settings-modal'); m.hidden = false; resetDrag(); }
function closeSettings() { document.getElementById('settings-modal').hidden = true; }

function renderSettings() {
  renderOwnerList();
  renderColorList();
  document.getElementById('set-default-view').value = defaultStartMode;
}

// 部门/标记变更后：实时刷新时间线 + 当前详情
function afterOwnerChange() {
  render();
  if (currentItem) showDetail(currentItem);
}

function renderOwnerList() {
  const ul = document.getElementById('owner-list');
  ul.innerHTML = '';
  OWNERS.forEach(o => {
    const prot = PROTECTED_OWNER_KEYS.includes(o.key);
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="owner-mark">${o.avatarUrl ? `<img src="${o.avatarUrl}" alt="">` : esc(o.mark)}</span>
      <input class="o-name" type="text" value="${esc(o.name)}" data-key="${o.key}" aria-label="部门名称">
      <input type="text" value="${esc(o.mark)}" maxlength="2" data-key="${o.key}" ${prot ? 'disabled' : ''} aria-label="记号" style="width:46px">
      <button data-key="${o.key}" title="设置图片徽章">图</button>
      <input type="file" accept="image/*" hidden data-key="${o.key}">
      ${prot ? '' : `<button data-key="${o.key}" class="owner-del" title="删除">删</button>`}
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.o-name').forEach(inp => inp.addEventListener('input', e => {
    const o = OWNERS.find(x => x.key === e.target.dataset.key);
    if (o) { o.name = e.target.value; afterOwnerChange(); }
  }));
  ul.querySelectorAll('input[type=text][maxlength="2"]').forEach(inp => inp.addEventListener('input', e => {
    const o = OWNERS.find(x => x.key === e.target.dataset.key);
    if (o) { o.mark = e.target.value; afterOwnerChange(); }
  }));
  ul.querySelectorAll('button:not(.owner-del)').forEach(btn => btn.addEventListener('click', () => btn.nextElementSibling.click()));
  ul.querySelectorAll('input[type=file]').forEach(f => f.addEventListener('change', e => {
    const o = OWNERS.find(x => x.key === e.target.dataset.key);
    const file = e.target.files[0]; if (!o || !file) return;
    const r = new FileReader();
    r.onload = ev => { o.avatarUrl = ev.target.result; afterOwnerChange(); renderOwnerList(); };
    r.readAsDataURL(file);
  }));
  ul.querySelectorAll('.owner-del').forEach(btn => btn.addEventListener('click', () => {
    OWNERS = OWNERS.filter(x => x.key !== btn.dataset.key);
    afterOwnerChange(); renderOwnerList();
  }));
}

function addOwner() {
  const n = document.getElementById('new-owner-name');
  const mk = document.getElementById('new-owner-mark');
  const name = n.value.trim();
  if (!name) { alert('请填写部门名称'); return; }
  OWNERS.push({ key: 'dept' + Date.now(), name, mark: mk.value.trim() || '●', avatarUrl: null });
  n.value = ''; mk.value = '';
  afterOwnerChange(); renderOwnerList();
}

const TYPE_COLOR_VARS = {
  meeting: '--c-meeting', trip: '--c-trip', pending: '--c-pending',
  class: '--c-class', sport: '--c-sport', life: '--c-life'
};
function renderColorList() {
  const wrap = document.getElementById('color-list');
  wrap.innerHTML = '';
  TYPE_COLOR_DEFS.forEach(([key, label]) => {
    const cur = getComputedStyle(document.documentElement).getPropertyValue(TYPE_COLOR_VARS[key]).trim() || '#2f6fed';
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `
      <span class="c-label">${label}</span>
      <input type="color" data-key="${key}" value="${cur}">
      <input class="c-hex" readonly value="${cur}">
      <span class="c-warn" data-key="${key}" hidden>白字对比不足</span>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=color]').forEach(inp => inp.addEventListener('input', e => {
    const key = e.target.dataset.key, val = e.target.value;
    const row = e.target.closest('.color-row');
    row.querySelector('.c-hex').value = val;
    if (isSafeBg(val)) {
      row.querySelector('.c-warn').hidden = true;
      document.documentElement.style.setProperty(TYPE_COLOR_VARS[key], val); // 达标才应用
    } else {
      row.querySelector('.c-warn').hidden = false; // 低于 4.5:1 不应用，防调回不达标浅色
    }
    render();
  }));
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
function exportOwners() { downloadJSON({ version: 1, owners: OWNERS }, 'workshop-owners.json'); }
function importOwners(file) {
  const r = new FileReader();
  r.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.owners || !Array.isArray(data.owners)) throw new Error('缺少 owners 数组');
      const prot = OWNERS.filter(o => PROTECTED_OWNER_KEYS.includes(o.key));
      const incoming = data.owners.filter(o => !PROTECTED_OWNER_KEYS.includes(o.key))
        .map(o => ({ key: o.key || ('dept' + Date.now() + Math.floor(Math.random() * 1e4)), name: o.name || '未命名', mark: o.mark || '●', avatarUrl: o.avatarUrl || null }));
      OWNERS = [...prot, ...incoming];
      afterOwnerChange(); renderOwnerList();
      alert('部门配置已导入');
    } catch (err) { alert('导入失败：' + err.message); }
  };
  r.readAsText(file);
}
function exportData() {
  downloadJSON({ version: 1, items: items.map(it => ({ ...it, start: it.start.toISOString() })) }, 'workshop-schedule.json');
}
function importData(file) {
  const r = new FileReader();
  r.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.items || !Array.isArray(data.items)) throw new Error('缺少 items 数组');
      items = data.items.map(it => ({ ...it, start: new Date(it.start) }));
      currentOffset = 0;
      afterMutation(true);
      alert('日程已导入');
    } catch (err) { alert('导入失败：' + err.message); }
  };
  r.readAsText(file);
}

// ---- 设置相关事件绑定（Day 9 实装）----
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') closeSettings(); });
document.getElementById('set-default-view').addEventListener('change', e => { defaultStartMode = e.target.value; }); // 下次刷新生效
document.getElementById('btn-add-owner').addEventListener('click', addOwner);
document.getElementById('btn-export-owners').addEventListener('click', exportOwners);
document.getElementById('btn-import-owners').addEventListener('click', () => document.getElementById('file-import-owners').click());
document.getElementById('file-import-owners').addEventListener('change', e => { if (e.target.files[0]) importOwners(e.target.files[0]); e.target.value = ''; });
document.getElementById('btn-export-data').addEventListener('click', exportData);
document.getElementById('btn-import-data').addEventListener('click', () => document.getElementById('file-import-data').click());
document.getElementById('file-import-data').addEventListener('change', e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
// 顶部「导入」按钮：同样走 JSON 导入（图片/Excel 识别待第 3 周 OCR 接入）
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import-data').click());

// ---- 弹窗可拖动（标题栏为手柄，鼠标/触摸通用，边界防拖出屏幕）----
function makeDraggable(panel, handle) {
  let dragging = false, lastX = 0, lastY = 0, dx = 0, dy = 0;
  handle.style.cursor = 'grab';
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('.modal-close')) return; // 不拦截关闭按钮
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    handle.style.cursor = 'grabbing';
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx += e.clientX - lastX; dy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(0, (window.innerWidth - rect.width) / 2);
    const maxY = Math.max(0, (window.innerHeight - rect.height) / 2);
    dx = Math.max(-maxX, Math.min(maxX, dx));
    dy = Math.max(-maxY, Math.min(maxY, dy));
    panel.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  return () => { dx = 0; dy = 0; panel.style.transform = ''; };
}
resetDrag = makeDraggable(
  document.querySelector('#settings-modal .modal'),
  document.querySelector('#settings-modal .modal-head')
);

// =================== [Day 12] 筛选交互（类型 + 关键词，纯前端）===================
// frontend-guidelines §7: 控件键盘可达(Tab/Enter)、:focus-visible 由全局样式覆盖；
// §3: 清空按钮三态；§6: 切换条件实时重渲染、清空恢复全部、交互不失效
const filterTypeEl = document.getElementById('filter-type');
const filterKeywordEl = document.getElementById('filter-keyword');
const filterClearEl = document.getElementById('filter-clear');
filterTypeEl.addEventListener('change', () => { filterState.type = filterTypeEl.value; render(); });
filterKeywordEl.addEventListener('input', () => { filterState.keyword = filterKeywordEl.value; render(); });
filterClearEl.addEventListener('click', () => {
  filterState = { type: 'all', keyword: '' };
  filterTypeEl.value = 'all';
  filterKeywordEl.value = '';
  render();
});
