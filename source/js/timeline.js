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

/* ============ 【2026-10-28】类型与颜色：从「硬编码 6 个」改为「服务端下发」 ============
   用户 2026-10-28 拍板 ②B：新增颜色 = 新增日程类型（不是只换色值，也不是另开标签维度）。
   于是类型清单必须来自数据库 —— 类型码、名字、颜色、是否内置都存 item_types_phase2。

   ⚠️ 绕的地方：库里存的是 meeting/course/travel/sport/life/pending，
      而前端历史代码用 meeting/class/trip/sport/life/pending（class↔course、trip↔travel）。
      CSS 类名、筛选值、色板 key 全是前端词。为不动这套已成型的样式，
      这里保留「库词 → 前端词」的单向映射，只在渲染与请求边界转换：
        · 拉到库词 course → 本地词 class → CSS 变量 --c-class
        · 提交时本地词 class → 库词 course（走已有的 localTypeToApi）
      自定义类型没有历史包袱，本地词 = 库词。

   TYPE_FALLBACK 是"服务端没连上"时的兜底：页面照样能渲染色板和图例，
   只是不能增删类型（写操作需要服务端）。 */
const TYPE_LOCAL_OF = { course: 'class', travel: 'trip' };   // 库词 → 前端词
const localTypeCode = c => TYPE_LOCAL_OF[c] || c;

const TYPE_FALLBACK = [
  { code: 'meeting', label: '会议',   color: '#1d4ed8', builtin: true, sortOrder: 10 },
  { code: 'course',  label: '课表',   color: '#15803d', builtin: true, sortOrder: 20 },
  { code: 'travel',  label: '行程',   color: '#b45309', builtin: true, sortOrder: 30 },
  { code: 'sport',   label: '运动',   color: '#0e7490', builtin: true, sortOrder: 40 },
  { code: 'life',    label: '生活',   color: '#6d28d9', builtin: true, sortOrder: 50 },
  { code: 'pending', label: '待安排', color: '#5b6472', builtin: true, sortOrder: 60 },
  { code: 'other',   label: '其他',   color: '#5b6472', builtin: true, sortOrder: 70 },
];

// 类型清单（库词）与其前端投影
let TYPE_LIST = TYPE_FALLBACK.slice();
// [Day 9] 兼容旧代码的形状：[[前端词, 标签], ...]（筛选、图例、描述都在用）
let TYPE_COLOR_DEFS = TYPE_LIST.map(t => [localTypeCode(t.code), t.label]);
let TYPE_COLOR_VARS = {};   // 前端词 → CSS 变量名

// 哪些内置类型属于哪张表（自定义类型两张表都出现 —— 用户建它就是为了通用）
const WORK_BASE_TYPES = ['meeting', 'trip', 'pending'];
const DAILY_BASE_TYPES = ['class', 'sport', 'life', 'other'];

/* 把类型清单应用成「主题」：注入 CSS 变量 + 重建投影。
   这是颜色体系的唯一入口 —— 无论是启动拉取、core 新增、还是改色，都走这里，
   保证图例/色板/下拉/总览格子永远同源。 */
function applyTypeTheme(list) {
  if (!Array.isArray(list) || !list.length) return;
  TYPE_LIST = list.slice().sort((a, b) => (a.sortOrder || 100) - (b.sortOrder || 100));
  TYPE_COLOR_DEFS = TYPE_LIST.map(t => [localTypeCode(t.code), t.label]);
  TYPE_COLOR_VARS = {};
  TYPE_LIST.forEach(t => {
    const lc = localTypeCode(t.code);
    const v = '--c-' + lc;
    TYPE_COLOR_VARS[lc] = v;
    document.documentElement.style.setProperty(v, t.color);
  });
  // 未知类型的兜底色：把 other 的颜色也挂到 pending 上（两者历史同色）
  if (TYPE_COLOR_VARS.other) {
    document.documentElement.style.setProperty('--c-pending', (TYPE_LIST.find(t => localTypeCode(t.code) === 'other') || {}).color || '#5b6472');
  }
}

function typeMetaOf(localCode) {
  const lc = String(localCode || '');
  return TYPE_LIST.find(t => localTypeCode(t.code) === lc) || null;
}
function typeLabel(localCode) {
  const m = typeMetaOf(localCode);
  return m ? m.label : '事项';
}

// 拉取类型清单：失败不阻断页面（用兜底继续），但要如实报一次
let _typesLoaded = false;
const typeSig = () => JSON.stringify(TYPE_LIST.map(t => [t.code, t.label, t.color]));
async function loadTypeList() {
  const before = typeSig();
  try {
    const res = await fetch(`${API_BASE}/api/items?_action=types`, {
      headers: (window.Auth ? window.Auth.withHeaders({}) : {}),
    });
    const j = await res.json();
    if (!res.ok || !j || !j.ok || !Array.isArray(j.data) || !j.data.length) {
      throw new Error((j && j.error && j.error.message) || `HTTP ${res.status}`);
    }
    applyTypeTheme(j.data);
    _typesLoaded = true;
    // changed 让调用方决定要不要重绘：启动时若服务端清单与内置兜底一致（绝大多数情况），
    // 就不该再刷一次屏 —— 首屏多一次重绘在弱网手机上肉眼可见地闪。
    return { ok: true, list: j.data, changed: before !== typeSig() };
  } catch (e) {
    applyTypeTheme(TYPE_FALLBACK);
    console.error('[类型清单] 拉取失败，使用内置兜底：', e.message);
    return { ok: false, error: e.message, changed: before !== typeSig() };
  }
}

/* 筛选下拉按类型清单重建。
   ⚠️ 要保住用户当前选的值：重绘下拉很容易把「已选课表」悄悄打回「全部」，
      用户会以为筛选失效了。所以先记 cur，重建后若该值还在就选回去。 */
function renderTypeFilter() {
  const sel = document.getElementById('filter-type');
  if (!sel) return;
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">全部</option>' +
    TYPE_COLOR_DEFS.map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
  const stillOk = cur === 'all' || TYPE_COLOR_DEFS.some(([c]) => c === cur);
  sel.value = stillOk ? cur : 'all';
  if (typeof filterState !== 'undefined') filterState.type = sel.value;
}
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
  // 【2026-10-28】改为查类型清单：自定义类型也能显示自己的名字（原来只会落到"事项/日常"）
  const known = typeMetaOf(it.type);
  if (known) return known.label;
  if (it.table === 'daily') return '日常';
  return '事项';
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
  // 【实时协作 2026-10-27】如实标注自动同步节奏：用户看底栏就知道"别人改了多久会自动出现"
  if (sync) { sync.textContent = '同步状态：公网接口已连接（CloudBase）· 自动同步 15s'; sync.dataset.state = s; }
}

// 【阶段二 P9】只读身份：隐藏新建按钮（后端仍是最终审防线）；isReadOnly 供保存/删除多处复用
function isReadOnly() {
  const m = window.Auth && window.Auth.currentMember();
  return !!(m && m.role === 'readonly');
}
// 【阶段二 管理员 UI 2026-10-18】管理员身份：控制「成员管理」区块显隐。
// ⚠️ 前端显隐只是体验层，越权请求由后端 setRole（仅 admin）403 兜底（PERMISSIONS_phase2 §四）。
function isAdmin() {
  const m = window.Auth && window.Auth.currentMember();
  return !!(m && m.role === 'admin');
}
// 【2026-10-28】核心管理员（core）：全局唯一层级，管类型与颜色体系。
// ★ 刻意不把 core 算作 isAdmin 的"超集"：core 拿到的是**体系级**权限（类型/颜色），
//   它不是"更厉害的团队管理员"，也不获得跨团队日程读写权（那会破多团队隔离四红线）。
//   两边都有的能力（如看团队码）在各自位置单独判。
function isCore() {
  const m = window.Auth && window.Auth.currentMember();
  return !!(m && m.role === 'core');
}
function applyRoleUI() {
  const ro = isReadOnly();
  const me = (window.Auth && typeof window.Auth.currentMember === 'function') ? window.Auth.currentMember() : null;
  const btnNew = document.getElementById('btn-new');
  if (btnNew) btnNew.hidden = ro;
  // [2026-10-28] 只读身份：批量删除入口一并隐藏（后端仍会 403，这里只是别让人白点）
  const btnBatch = document.getElementById('btn-batch');
  if (btnBatch) btnBatch.hidden = ro;
  // 【阶段二 权限收敛 seam B】只读身份：禁用「保存我的会议信息」（后端 updateProfile 同步 403 兜底，见 profile_phase2）
  const btnSaveMeeting = document.getElementById('btn-save-meeting');
  if (btnSaveMeeting) btnSaveMeeting.disabled = ro;
  // 【阶段二 管理员 UI】仅 admin 显示「成员管理」区块
  const memberAdmin = document.getElementById('member-admin');
  if (memberAdmin) memberAdmin.hidden = !isAdmin();
  // 【阶段二 Step5 口令体系】任意登录成员显示「修改我的口令」（自助改，管理员不可见）
  const pcSettings = document.getElementById('passcode-settings');
  if (pcSettings) pcSettings.hidden = !me;
  // 【2026-10-28】type：新增类型表单只对核心管理员显示（服务端 requireCore 兜底）
  const typeAdd = document.getElementById('type-add');
  if (typeAdd) typeAdd.hidden = !isCore();
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
// 【2026-10-28】未知类型词不再一律兜底成 other —— 自定义类型本来就是新词，
// 兜底会把它显示成灰色"其他"，等于新类型白建。只有空值才兜底。
const apiTypeToLocal = t => {
  const v = String(t || '').trim();
  if (!v) return 'other';
  return API_TYPE_MAP[v] || v;
};

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
    // 【阶段二 P8·修复】必须映射后端已返回的归属/外框色：漏接会导致
    // 「只看 X 的」过滤恒为 undefined===owner（全部过滤掉）且卡片外框色不渲染。
    ownerMemberId: a.ownerMemberId != null ? Number(a.ownerMemberId) : null,
    borderColor: a.borderColor || '',
    meetingNo: a.meetingNo || null,   // 【阶段二 P11】单条会议入会信息（方案①，覆盖成员默认）
    meetingUrl: a.meetingUrl || null,
    updatedAtRaw: a.updatedAtRaw != null ? String(a.updatedAtRaw) : null,  // 【阶段二 P9】并发版本号（与后端逐字一致）
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
  return fetch(url, { headers: (window.Auth ? window.Auth.withHeaders({}) : {}) })
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
    // 【阶段二 P8】冗余展示色：建日程时把当前登录成员的外框色带给后端写 items.border_color（安全非敏感）
    borderColor: (window.Auth && window.Auth.currentMember() && window.Auth.currentMember().borderColor) || '',
    // 【阶段二 P9】代他人放置：归属给谁（空=自己，由后端按令牌定）；编辑时带版本号做并发条件更新
    ownerMemberId: (d.ownerMemberId != null && d.ownerMemberId !== '') ? Number(d.ownerMemberId) : undefined,
    meetingNo: d.meetingNo || undefined,   // 【阶段二 P11】单条覆盖个人默认
    meetingUrl: d.meetingUrl || undefined,
    baseUpdatedAt: d.baseUpdatedAt || undefined,
  };
}

// 统一发写请求并解包 { ok, data, error }：失败抛 Error，把后端中文提示带出来（err.code 便于分支处理）
async function apiMutate(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
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
let MEMBERS_CACHE = [];  // 【阶段二 P11】成员列表缓存（含 meetingNo/meetingUrl），供卡片解析归属成员的默认会议号
// [Day 11] 已删除项 id 集合：种子数据每次切周会被 loadItems 重灌，靠此集合让删除跨周持久（仅内存态，刷新重置）
const deletedIds = new Set();

// ===== 【阶段二 实时协作 2026-10-27】自动同步状态 =====
// 背景：此前数据只在「初次加载 / 切周 / 手动点刷新」时拉取，A 新建后 B 必须刷新才看得到。
// 方案：15s 静默轮询 + 签名比对，只有服务端真的变了才重绘（详见文件后部 syncTick）。
let _syncSig = '';         // 上次已应用的数据签名（id + 版本号）
let _syncInited = false;   // 是否已建立基线（首轮只记基线，不重绘）
let _syncPending = false;  // 用户填表期间检测到变更 → 待补应用
let _syncing = false;      // 防叠加：上一轮未结束不发起下一轮
let _syncTimer = 0;
let _syncSuppressToast = false;  // 一次性抑制：已提示"事项被删除"就不再补"已同步"
const SYNC_INTERVAL = 15000;     // 自动同步间隔（用户 2026-10-27 拍板 15s）

// =================== [Day 12] 筛选状态：类型 + 关键词（纯前端过滤，不依赖后端）===================
// frontend-guidelines §2: 筛选不改变类型色语义；§7: 控件 aria-label 由 HTML 提供、键盘可达
let filterState = { type: 'all', keyword: '', owner: null };
// 【阶段二 P8】归属视图：顶栏"只看我的"切换 → 设/清 filterState.owner；render 即时过滤
function setOwnerFilter(id) { filterState.owner = id; render(); }
window.setOwnerFilter = setOwnerFilter;

// 在三模式 view 之上再叠加筛选（类型 + 关键词）；无条件时原样返回，不破坏现有渲染
function applyFilter(list) {
  const { type, keyword, owner } = filterState;
  const kw = keyword.trim().toLowerCase();
  if (type === 'all' && !kw && owner == null) return list;
  return list.filter(it => {
    const typeOk = type === 'all' || it.type === type;
    const kwOk = !kw || String(it.title || '').toLowerCase().includes(kw);
    // 【阶段二 P8】归属视图：owner = 当前登录 member id 时只留"我的"（归一化防类型不符）
    const ownerOk = owner == null || Number(it.ownerMemberId) === Number(owner);
    return typeOk && kwOk && ownerOk;
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
  // 【2026-10-28】自定义类型没有对应的 CSS 类，靠内联变量上色；内置类型这行与 CSS 等价，
  // 统一走内联的好处是「颜色只有一个来源（类型清单）」，改色立刻全站生效。
  el.style.background = `var(${TYPE_COLOR_VARS[item.type] || '--c-' + item.type}, var(--c-pending))`;
  // 【阶段二 P8】协作外框色：用成员 borderColor 标"谁的项"；填充色仍是类型色（颜色铁律，不变）
  if (item.borderColor) el.style.borderColor = item.borderColor;
  el.dataset.id = item.id;
  el.tabIndex = 0; // 可聚焦：键盘 Tab 到卡片即显示备注浮窗（聚焦即生效）
  // 排版：标记+标题 同行 → 时间 一行（备注移入 hover/focus 浮窗，不再挤占最矮卡片高度）
  el.innerHTML =
    (selectMode ? `<span class="item-check" aria-hidden="true">${selectedIds.has(item.id) ? '✓' : ''}</span>` : '') +
    (showMark ? `<span class="item-mark" title="${esc(m.name)}">${esc(m.symbol)}</span>` : '') +
    `<span class="item-title">${esc(renderItemText(item))}</span>` +
    `<span class="item-time">${item.startTime}–${item.endTime}</span>` +
    (warn ? `<span class="item-warn" title="${esc(warn.title)}">⚠</span>` : '') + meetEntryHtml(item);
  // [2026-10-28] 批量模式：点卡片＝勾选（不进详情、不弹重叠窗），可键盘 Space 切换
  el.addEventListener('click', (ev) => {
    if (selectMode) { ev.stopPropagation(); toggleSelect(item.id); return; }
    (onClick || (() => showDetail(item)))();
  });
  if (selectMode) {
    el.classList.add('is-selectable');
    if (selectedIds.has(item.id)) el.classList.add('is-selected');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', selectedIds.has(item.id) ? 'true' : 'false');
    el.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleSelect(item.id); }
    });
  }
  // 备注浮窗：桌面端 hover/聚焦即显示完整备注；移动端触摸无 hover，改为「点卡片→底部抽屉看备注」，故内部判 isMobile 屏蔽浮窗
  el.addEventListener('mouseenter', () => { if (!isMobile()) showNote(item, el); });
  el.addEventListener('mouseleave', () => { if (!isMobile()) scheduleNoteHide(); });
  el.addEventListener('focusin', () => { if (!isMobile()) showNote(item, el); });
  el.addEventListener('focusout', () => { if (!isMobile()) scheduleNoteHide(); });
  return el;
}

// 【阶段二 P11】腾讯会议入会入口：单条 meetingUrl 优先，否则归属成员的固定会议号（方案①）
function resolveMeeting(item) {
  if (item.meetingUrl) return { url: item.meetingUrl, no: item.meetingNo };
  const me = window.Auth && typeof window.Auth.currentMember === 'function' ? window.Auth.currentMember() : null;
  const ownerId = (item.ownerMemberId != null && item.ownerMemberId !== '') ? Number(item.ownerMemberId) : (me ? Number(me.id) : null);
  if (ownerId == null) return null;
  const m = MEMBERS_CACHE.find(x => Number(x.id) === ownerId);
  if (m && m.meetingUrl) return { url: m.meetingUrl, no: m.meetingNo };
  return null;
}
function meetEntryHtml(item) {
  const mt = resolveMeeting(item);
  if (!mt || !mt.url) return '';
  const no = mt.no ? ` · ${esc(mt.no)}` : '';
  return `<a class="item-meet" href="${esc(mt.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="加入腾讯会议（个人会议室，注意别撞会）">入会${no}</a>`;
}
function meetDetailHtml(item) {
  const mt = resolveMeeting(item);
  if (!mt || !mt.url) return '';
  const no = mt.no ? esc(mt.no) : '（未填会议号）';
  return `<p class="row detail-meeting"><b>入会</b><a href="${esc(mt.url)}" target="_blank" rel="noopener" class="meet-btn">加入腾讯会议</a> <span class="meet-no">${no}</span><br><span class="meet-note">个人会议室，注意别撞会</span></p>`;
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
  // 【2026-10-28】图例改为按类型清单生成：自定义类型自动出现在这里，不用改代码
  const typeLegend = TYPE_COLOR_DEFS
    .map(([k, label]) => `<span class="legend-item"><span class="chip" style="background:var(${TYPE_COLOR_VARS[k] || '--c-pending'})"></span>${esc(label)}</span>`)
    .join('');
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

      // 角标：组内有多个日程才显示（紧贴锚点卡上方）；移动端为避免压住上方卡片标题，
      // 改用「卡片描边 + ⚠ 标记 + 点按展开弹窗」表达重叠，隐藏浮动角标（角标逻辑见下方，仅桌面端渲染）
      if (!isMobile() && group.items.length > 1) {
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

// 移动端判定：与 base.css 的 @media (max-width: 768px) 断点保持一致
function isMobile() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
}

// ---- [Day 25 重写] 移动端副栏可拖动底部抽屉：class 驱动三态，根除 isMobile 守卫导致的全屏卡死 ----
/* 三态由 CSS class 定义（.sheet-open=半屏 / .sheet-expanded=全屏 / .sheet-collapsed=仅手柄条），
   JS 只切 class，不读 offsetHeight 算像素；拖拽时临时用内联 transform 跟手，松手吸附回 class。
   打开无条件以半屏(peek)落地 → 主栏始终可见；桌面端这些 class 在媒体查询外无意义，安全空操作。 */
let _scrimBound = false;
let sheetState = 'closed';   // 'closed' | 'peek' | 'expanded' | 'collapsed'
const SHEET_HANDLE_H = 44;

function sheetEl() { return document.getElementById('detail'); }
function scrimEl() { return document.querySelector('.detail-scrim'); }

function setSheetState(state) {
  const d = sheetEl();
  if (!d) return;
  sheetState = state;
  d.style.transition = 'transform .25s ease';
  d.style.transform = '';                                  // 清除拖拽残留的内联像素，交还 CSS class 控制
  d.classList.remove('sheet-open', 'sheet-expanded', 'sheet-collapsed');
  const s = scrimEl();
  if (state === 'closed') { if (s) s.classList.remove('open'); return; }
  // peek→sheet-open，expanded→sheet-expanded，collapsed→sheet-collapsed
  d.classList.add(state === 'peek' ? 'sheet-open' : 'sheet-' + state);
  if (s) { if (state === 'expanded') s.classList.add('open'); else s.classList.remove('open'); }
}

function closeDetailDrawer() { setSheetState('closed'); }

function openDetailDrawer() {
  const s = scrimEl();
  if (s && !_scrimBound) {
    s.addEventListener('click', () => closeDetailDrawer());  // expanded 态遮罩可点收起
    _scrimBound = true;
  }
  // 无条件以半屏(peek)打开：不依赖 isMobile() 判定，绝不卡在全屏
  const d = sheetEl();
  if (d) setSheetState('peek');
}

// [Day 25] 拖动交互：在 .sheet-handle 上 pointerdown 起拖，move/up 挂到 window（手指离开手柄也跟手）；
// 松手吸附到最近态；下拖过 collapsed 阈值 → 完全关闭。点按手柄在 collapsed→peek→expanded→peek 间循环切换。
function initSheetDrag() {
  const handle = document.getElementById('sheet-handle');
  const d = sheetEl();
  if (!handle || !d) return;

  // 三态像素基准（基于当前渲染高度；expanded=0 顶, peek=45vh 露出, collapsed=仅手柄条）
  const bounds = () => {
    const h = Math.round(d.getBoundingClientRect().height) || window.innerHeight;
    const peekY = Math.max(0, h - Math.round(window.innerHeight * 0.45));
    return { expanded: 0, peek: peekY, collapsed: h - SHEET_HANDLE_H, max: h + 60 };
  };
  const currentT = () => {
    const m = /translateY\(([-0-9.]+)px\)/.exec(d.style.transform || '');
    if (m) return parseFloat(m[1]);
    if (sheetState === 'expanded') return 0;
    return bounds()[sheetState] || 0;
  };

  let dragging = false, startY = 0, startT = 0, moved = false;

  const onDown = (e) => {
    if (!isMobile()) return;
    dragging = true; moved = false;
    startY = e.clientY; startT = currentT();
    d.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const b = bounds();
    const t = Math.max(b.expanded, Math.min(startT + dy, b.max)); // 上不超 expanded，下允许略过 collapsed 触发关闭
    d.style.transform = `translateY(${t}px)`;
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    const b = bounds(); const t = currentT();
    if (t > b.collapsed + 40) { setSheetState('closed'); return; }  // 下拉过手柄阈值 → 关闭
    const dist = { expanded: Math.abs(t - b.expanded), peek: Math.abs(t - b.peek), collapsed: Math.abs(t - b.collapsed) };
    let best = 'expanded', bv = Infinity;
    for (const k in dist) if (dist[k] < bv) { bv = dist[k]; best = k; }
    setSheetState(best);
  };
  const onClick = () => {
    if (!isMobile() || moved) return;
    if (sheetState === 'collapsed') setSheetState('peek');
    else if (sheetState === 'peek') setSheetState('expanded');
    else setSheetState('peek');
  };
  const onKey = (e) => {
    if (!isMobile()) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };

  handle.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  handle.addEventListener('click', onClick);
  handle.addEventListener('keydown', onKey);
  // 转屏/尺寸变化时重新吸附到当前态，避免位置错乱
  window.addEventListener('resize', () => { if (sheetState !== 'closed' && isMobile()) setSheetState(sheetState); });

  // [无关闭叉方案] 点时间线空白区（非日程卡）收起副栏，作为「点空地取消」的退路
  const tl = document.getElementById('timeline');
  if (tl) tl.addEventListener('click', (e) => {
    if (!isMobile() || sheetState === 'expanded') return; // 全屏态靠遮罩关闭；点卡片=切换详情不关闭
    if (e.target.closest('.item')) return;
    closeDetailDrawer();
  });
}

function showDetail(item) {
  currentItem = item || null;
  const body = document.getElementById('detail-body');
  if (!item) {
    body.innerHTML = `<p class="detail-empty">点击时间线上的事项查看详情，或点「+ 新建」添加。底部可切换工作/日常/总表。</p>${legendHTML()}`;
    closeDetailDrawer();
    flushPendingSync();   // 【实时协作】表单可能刚被取消/关闭 → 把挂起的变更补上
    return;
  }
  const m = markOf(item);
  const tableLabel = item.table === 'daily' ? '日常事项表' : '工作事项表';
  const ownerHTML = currentMode === 'all'
    ? `<span class="owner-mark">${markHTML(m)} ${esc(m.name)}</span>`
    : `<span class="owner-mark">${markHTML(m)} ${esc(m.name)}</span>`;
  body.innerHTML = `
    <div class="detail-card" style="border:2px solid ${item.borderColor || 'transparent'}">
      <h3>${esc(item.title)}</h3>
      <p class="row">
        <span class="badge table-${item.table}">${tableLabel}</span>
        <span class="badge type-${item.type}" style="background:var(${TYPE_COLOR_VARS[item.type] || '--c-' + item.type}, var(--c-pending))">${typeLabelOf(item)}</span>
        ${ownerHTML}
      </p>
      <p class="row"><b>时间</b>${fmtMD(item.start)} ${item.startTime}–${item.endTime}</p>
      <p class="row"><b>归属</b>${item.ownerMemberId ? ('成员 #' + item.ownerMemberId + (item.borderColor ? ' <span class="owner-swatch" style="background:' + item.borderColor + '"></span>' : '')) : '<span style="color:var(--ink-soft)">未标注</span>'}</p>
      <p class="row"><b>参与人</b>${esc(item.attendees)}</p>
      <p class="row"><b>场地</b>${esc(item.venue)}</p>
      <p class="row"><b>备注</b>${item.note ? esc(item.note) : '<span style="color:var(--ink-soft)">—</span>'}</p>
      ${meetDetailHtml(item)}
      <div class="form-actions">
        <button class="btn-edit" id="btn-edit">编辑</button>
        <button class="btn-delete" id="btn-delete">删除此事项</button>
      </div>
    </div>
    ${legendHTML()}`;
  document.getElementById('btn-edit').addEventListener('click', () => renderForm(item));
  document.getElementById('btn-delete').addEventListener('click', () => deleteItem(item.id));
  if (isReadOnly()) {  // 【阶段二 P9】只读身份：详情里不显示编辑/删除按钮（后端仍是最终审防线）
    const eb = document.getElementById('btn-edit'); if (eb) eb.hidden = true;
    const db = document.getElementById('btn-delete'); if (db) db.hidden = true;
  }
  openDetailDrawer(); // 移动端滑出底部抽屉（桌面端 .open 为空操作）
  flushPendingSync(); // 【实时协作】从表单切到详情 = 表单已关闭，补应用挂起的变更
}

async function renderForm(existing) {
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

  const d = document.getElementById('detail-body');
  d.innerHTML = `
    <div class="detail-card">
      <h3>${isEdit ? '编辑事项' : '新建事项'}</h3>
      <form id="item-form">
        <label>所属表<select name="table" id="f-table">${modeOpts}</select></label>
        <div id="f-owner" class="cond-field"><label>部门 / 成员<select name="ownerKey">${ownerOpts}</select></label></div>
        ${isEdit ? '' : `<div id="f-forowner" class="cond-field"><label>归属给（代他人放置）<select name="ownerMemberId" id="f-forowner-sel"><option value="">自己</option></select></label></div>`}
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
        <!-- [Day 24] 时间改为拨轮选择：只读输入框 + 点击弹出双列拨轮（时/分，5 分钟一档），
             不再手打 HH:mm，格式由 timepicker.js 保证；结束时间跟随开始自动平移 -->
        <div class="row2">
          <label>开始<span class="tp-field"><input name="startTime" value="${isEdit ? existing.startTime : '09:00'}" aria-label="开始时间"><span class="tp-caret" aria-hidden="true">▾</span></span></label>
          <label>结束<span class="tp-field"><input name="endTime" value="${isEdit ? existing.endTime : '09:30'}" aria-label="结束时间"><span class="tp-caret" aria-hidden="true">▾</span></span></label>
        </div>
        <label>参与人<input name="attendees" value="${isEdit ? esc(existing.attendees) : ''}"></label>
        <label>场地<input name="venue" value="${isEdit ? esc(existing.venue) : ''}"></label>
        <label>备注<textarea name="note" rows="2">${isEdit ? esc(existing.note) : ''}</textarea></label>
        <div id="f-meeting" class="cond-field">
          <p class="set-hint">会议入会信息（可选）：留空则使用「设置 → 我的腾讯会议」里的个人默认。</p>
          <label>会议号<input name="meetingNo" value="${isEdit ? esc(existing.meetingNo || '') : ''}" maxlength="60"></label>
          <label>入会链接<input name="meetingUrl" type="url" value="${isEdit ? esc(existing.meetingUrl || '') : ''}" placeholder="https://meeting.tencent.com/dm/..."></label>
        </div>
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
    // 【阶段二 P11】会议类型才显示入会信息字段
    const fm = document.getElementById('f-meeting');
    if (fm) fm.style.display = fType.value === 'meeting' ? '' : 'none';
  };
  fTable.addEventListener('change', syncCond);
  syncCond();

  // 【阶段二 P9】新建时拉成员列表填"归属给谁"下拉（代他人放置）；失败不阻塞（默认自己）
  if (!isEdit) {
    const sel = document.getElementById('f-forowner-sel');
    if (sel) {
      try {
        const members = (window.Auth && typeof window.Auth.members === 'function') ? await window.Auth.members() : [];
        const me = window.Auth && window.Auth.currentMember();
        members.forEach(m => {
          if (me && m.id === me.id) return; // 跳过自己（"自己"选项已存在）
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = (m.displayName || ('成员#' + m.id)) + (m.role === 'readonly' ? '（只读）' : '');
          sel.appendChild(o);
        });
      } catch (_) { /* 忽略，默认自己 */ }
    }
  }

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

  // [Day 24] 时间拨轮接线：两个只读输入框成对绑定，点谁弹谁
  if (window.TimePicker) {
    TimePicker.bindPair(f.querySelector('[name="startTime"]'), f.querySelector('[name="endTime"]'));
  }

  document.getElementById('item-form').addEventListener('submit', e => { e.preventDefault(); saveItem(existing); });
  document.getElementById('btn-cancel').addEventListener('click', () => showDetail(existing || null));
  openDetailDrawer(); // 移动端滑出底部抽屉（新建/编辑表单同样需要）
}

function typeOptionsHTML(table, selected) {
  // 【2026-10-28】按类型清单生成：内置类型按表归属（工作表只出会议/行程/待安排，
  // 日常表只出课表/运动/生活/其他），自定义类型两张表都出 —— 用户建它就是为了哪儿都能用。
  const base = table === 'daily' ? DAILY_BASE_TYPES : WORK_BASE_TYPES;
  const opts = [];
  TYPE_COLOR_DEFS.forEach(([code, label]) => { if (base.includes(code)) opts.push({ code, label }); });
  TYPE_LIST.forEach(t => {
    const lc = localTypeCode(t.code);
    if (!t.builtin && !opts.some(o => o.code === lc)) opts.push({ code: lc, label: t.label });
  });
  // 历史数据可能挂在某个当前清单里没有的类型上：补一条，避免下拉显示空白
  if (selected && !opts.some(o => o.code === selected)) opts.push({ code: selected, label: typeLabel(selected) });
  return opts.map(({ code, label }) => `<option value="${code}" ${code === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
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
  if (isReadOnly()) { showToast('当前身份为只读，无法修改日程'); return; }
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
    ownerMemberId: fd.get('ownerMemberId') || '',  // 【阶段二 P9】代他人放置的目标成员 id（空=自己）
    meetingNo: (fd.get('meetingNo') || '').trim(),   // 【阶段二 P11】单条会议入会信息（方案①）
    meetingUrl: (fd.get('meetingUrl') || '').trim(),
  };

  // ---- 越界①/②：前端先挡一道，后端还有 400/422 兜底（双保险，省一次往返）----
  if (!data.title) { showToast('请填写标题'); return; }
  // [Day 24 契约变更] 禁止零时长：结束须「晚于」开始，等于也不行（与后端 422 同一口径）
  if (data.startTime && data.endTime && data.endTime <= data.startTime) {
    showToast('结束时间须晚于开始时间（不允许零时长）'); return;
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
    data.baseUpdatedAt = existing.updatedAtRaw; // 【阶段二 P9】带加载时的版本号，被他人抢先改则 409
    const payload = localItemToPayload(data);
    try {
      const updated = await apiMutate('PATCH', `${API_BASE}/api/items?id=${existing.id}`, payload);
      Object.assign(existing, apiItemToLocal(updated));  // 用库里返回的最新值回写（含 week 重算、updatedAt）
      showDetail(existing);
      afterMutation();
      showToast('已保存（已同步云端）');
    } catch (e) {
      // 【阶段二 P9】并发冲突：已有人改过，刷新本页并重新打开该条，让用户基于最新值再改
      if (e.code === 409) {
        showToast('数据已被他人修改，已为你刷新，请基于最新内容再保存');
        await bootstrap();
        const fresh = items.find(x => x.id === existing.id);
        if (fresh) showDetail(fresh);
        return;
      }
      // 越界③：其他保存失败不动内存、不关表单，让用户改完再试（避免"界面说成功、库里没改"）
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
/* ============ 【2026-10-28】批量选择 + 批量删除 + 限时撤销 ============
   为什么要撤销：删除是不可恢复的（后端闸门 A 要求 confirm=true 才删），误删一条要重新录入
   全部字段。这里给一个 8 秒窗口，删错了能立刻拉回来。

   ⚠️ 撤销的真相（必须如实理解）：
     恢复靠「按快照重新创建」，所以恢复出来的是**新 id、新更新时间**，不是同一个数据库行。
     业务字段（类型/标题/时间/地点/备注/归属人/会议号）原样还原；create 端点支持
     ownerMemberId=代他人放置，所以连「这条是别人的」也保得住。
     但这条记录的历史（谁在什么时候改过）不随撤销回来——审计流水不会重写。

   为什么用「批量模式」而不是常驻勾选框：
     卡片最矮只有 20px，常驻勾选框会挤压标题；而且没有选择意图时点卡片应当直接看详情
     （主路径），不能被勾选打断。所以点「批量」才进入，退出即清空。
   ========================================================================== */
const SELECT_LIMIT = 200;        // 单次最多选多少条：防一次误选整月、也防请求打爆
const UNDO_MS = 8000;            // 撤销窗口：够看清"删错了"，又不至于久到忘记
const BATCH_CONCURRENCY = 4;     // 并发上限：一次最多 4 个删除请求在飞

let selectMode = false;
const selectedIds = new Set();
let undoState = null;            // { snapshots:[…], timer, count }
let isUndoing = false;

// 可写身份：已登录且不是只读（后端仍是最终审防线，这里只是不发无效请求）
function canWrite() {
  const m = window.Auth && typeof window.Auth.currentMember === 'function' ? window.Auth.currentMember() : null;
  return !!m && m.role !== 'readonly';
}

function enterSelectMode() {
  if (!canWrite()) { showToast('需要登录且非只读身份才能批量删除'); return; }
  selectMode = true;
  selectedIds.clear();
  if (typeof closeDetailDrawer === 'function') closeDetailDrawer();
  render();
  renderSelectBar();
}

function exitSelectMode() {
  if (!selectMode) return;
  selectMode = false;
  selectedIds.clear();
  document.body.classList.remove('is-selecting');
  render();
  renderSelectBar();
  // 批量期间自动同步是挂起的，退出时补一次（否则别人这几分钟的改动要等下一个 15s）
  if (typeof flushPendingSync === 'function') flushPendingSync();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else {
    if (selectedIds.size >= SELECT_LIMIT) { showToast(`单次最多选 ${SELECT_LIMIT} 条`); return; }
    selectedIds.add(id);
  }
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (el) el.classList.toggle('is-selected', selectedIds.has(id));
  renderSelectBar();
}

// 全选「当前筛选下真正看得见的」——不选被筛掉的内容，避免"以为只删这几条，实际删了一批"
function selectAllVisible() {
  const visible = applyFilter(items);
  const before = selectedIds.size;
  for (const it of visible) {
    if (selectedIds.size >= SELECT_LIMIT) break;
    selectedIds.add(it.id);
  }
  render();
  renderSelectBar();
  if (selectedIds.size === before) showToast('当前筛选下没有可新增的选中项');
}

function clearSelect() {
  selectedIds.clear();
  render();
  renderSelectBar();
}

function renderSelectBar() {
  const bar = document.getElementById('batch-bar');
  const cnt = document.getElementById('batch-count');
  const btnBatch = document.getElementById('btn-batch');
  if (btnBatch) btnBatch.classList.toggle('is-active', selectMode);
  if (!bar) return;
  bar.hidden = !selectMode;
  document.body.classList.toggle('is-selecting', selectMode);
  if (!selectMode) return;
  if (cnt) cnt.textContent = `已选 ${selectedIds.size} 条`;
  const del = document.getElementById('btn-batch-delete');
  if (del) del.disabled = selectedIds.size === 0;
}

// 删前快照：只留重建必需的业务字段（不留 id——恢复一定是新行）
function snapshotOf(it) {
  return {
    table: it.table,
    type: it.type,
    title: it.title,
    dateStr: `${it.start.getFullYear()}-${String(it.start.getMonth() + 1).padStart(2, '0')}-${String(it.start.getDate()).padStart(2, '0')}`,
    startTime: it.startTime,
    endTime: it.endTime,
    attendees: it.attendees || '',
    venue: it.venue || '',
    note: it.note || '',
    ownerKey: it.ownerKey,
    ownerMemberId: it.ownerMemberId != null ? Number(it.ownerMemberId) : null,
    borderColor: it.borderColor || '',
    meetingNo: it.meetingNo || null,
    meetingUrl: it.meetingUrl || null,
  };
}

function openBatchDeleteModal() {
  const list = items.filter(x => selectedIds.has(x.id));
  if (!list.length) { showToast('还没有选中任何日程'); return; }
  const overlay = document.getElementById('delete-modal');
  const body = document.getElementById('delete-body');
  if (!overlay || !body) return;
  _delUserCloseLocked = false;

  const cloud = list.filter(x => isCloudId(x.id));
  const local = list.filter(x => !isCloudId(x.id));
  const secs = Math.round(UNDO_MS / 1000);
  const preview = list.slice(0, 3).map(x => `「${esc(x.title)}」`).join('、') + (list.length > 3 ? ` 等 ${list.length} 条` : '');

  body.innerHTML =
    `<p class="del-msg">确定要删除选中的 <b>${list.length}</b> 条日程吗？</p>` +
    `<p class="del-sub">${preview}</p>` +
    `<p class="del-sub">其中 ${cloud.length} 条会从云端删除${local.length ? `；${local.length} 条只在本页移除（本来就没落库）` : ''}。</p>` +
    `<p class="del-sub">删除后 ${secs} 秒内可以点「撤销」恢复（恢复为新的记录编号，内容与归属人不变）。</p>` +
    `<div class="del-actions">` +
      `<button id="del-cancel">取消</button>` +
      `<button class="btn-danger" id="del-confirm">删除 ${list.length} 条</button>` +
    `</div>`;

  overlay.classList.remove('modal--pretext');
  overlay.hidden = false;
  overlay.classList.remove('is-open');
  void overlay.offsetWidth;
  overlay.classList.add('is-open');
  document.getElementById('del-cancel').focus();
  document.getElementById('del-cancel').onclick = () => closeDeleteModal();
  document.getElementById('delete-close').onclick = () => closeDeleteModal();
  overlay.onclick = (e) => { if (e.target === overlay) closeDeleteModal(); };
  document.getElementById('del-confirm').onclick = () => runBatchDelete(list);
  overlay._keyHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDeleteModal(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = overlay.querySelector('#del-confirm');
      if (c && !c.disabled) c.click();
    }
  };
  overlay.addEventListener('keydown', overlay._keyHandler);
}

async function runBatchDelete(list) {
  const overlay = document.getElementById('delete-modal');
  const body = document.getElementById('delete-body');
  if (!body) return;
  _delUserCloseLocked = true;
  body.innerHTML = `<p class="del-loading"><span class="spinner"></span>正在删除 ${list.length} 条…</p>`;

  const cloud = list.filter(x => isCloudId(x.id));
  const local = list.filter(x => !isCloudId(x.id));
  const removed = [];   // 成功移除的（云端 + 本页）
  const restorable = []; // 其中可撤销的（只有云端项能重建）
  const fails = [];

  // 本页项：直接内存移除，无需请求
  local.forEach(it => { removed.push(it.id); deletedIds.add(it.id); });

  // 云端项：并发池，最多 BATCH_CONCURRENCY 条在飞
  let cursor = 0;
  async function worker() {
    while (cursor < cloud.length) {
      const it = cloud[cursor++];
      try {
        await apiMutate('DELETE', `${API_BASE}/api/items?id=${it.id}&confirm=true`);
        restorable.push(snapshotOf(it));
        removed.push(it.id);
        deletedIds.add(it.id);
      } catch (e) {
        if (e.code === 404) {
          // 云端已经没有了（可能别处删过）：当作已删，但**不进撤销栈**——没东西可重建
          removed.push(it.id);
          deletedIds.add(it.id);
        } else {
          fails.push(`${it.title}：${e.message}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, cloud.length) }, worker));

  // 内存同步：成功的移除；失败的原样留着（并如实报出来）
  items = items.filter(x => !removed.includes(x.id));
  selectedIds.clear();
  _delUserCloseLocked = false;
  closeDeleteModal();
  afterMutation(true);
  renderSelectBar();

  if (restorable.length) pushUndo(restorable);
  if (fails.length) {
    showToast(`已删除 ${removed.length} 条，${fails.length} 条失败：${fails[0]}`);
  } else if (removed.length) {
    showToast(`已删除 ${removed.length} 条`);
  }
  // 全部失败：别静默（否则用户以为删了）
  if (!removed.length && fails.length) {
    openBatchDeleteModalFail(fails);
  }
}

// 全失败：给一个能看清原因的弹窗（批量场景下 toast 只会闪过第一条）
function openBatchDeleteModalFail(fails) {
  const body = document.getElementById('delete-body');
  const overlay = document.getElementById('delete-modal');
  if (!body || !overlay) return;
  body.innerHTML =
    `<p class="del-error del-error-shake">一条都没删掉</p>` +
    `<p class="del-sub">${fails.slice(0, 5).map(f => esc(f)).join('；')}${fails.length > 5 ? ` …共 ${fails.length} 条` : ''}</p>` +
    `<div class="del-actions"><button id="del-cancel">知道了</button></div>`;
  overlay.hidden = false;
  overlay.classList.add('is-open');
  document.getElementById('del-cancel').onclick = () => closeDeleteModal();
}

/* ---- 限时撤销 ---- */
function pushUndo(snapshots) {
  clearUndo();
  undoState = { snapshots, timer: null, count: snapshots.length };
  const bar = document.getElementById('undo-bar');
  const txt = document.getElementById('undo-text');
  if (txt) txt.textContent = `已删除 ${snapshots.length} 条日程`;
  if (bar) {
    bar.hidden = false;
    bar.classList.remove('show');
    void bar.offsetWidth;
    bar.classList.add('show');
  }
  undoState.timer = setTimeout(() => {
    clearUndo();
    showToast('撤销窗口已过，日程已永久删除');
  }, UNDO_MS);
}

function clearUndo() {
  if (undoState && undoState.timer) clearTimeout(undoState.timer);
  undoState = null;
  const bar = document.getElementById('undo-bar');
  if (bar) { bar.classList.remove('show'); bar.hidden = true; }
}

async function doUndo() {
  if (!undoState || isUndoing) return;
  const snaps = undoState.snapshots;
  isUndoing = true;
  if (undoState.timer) clearTimeout(undoState.timer);
  const bar = document.getElementById('undo-bar');
  const txt = document.getElementById('undo-text');
  if (txt) txt.textContent = `正在恢复 ${snaps.length} 条…`;
  const btn = document.getElementById('btn-undo');
  if (btn) btn.disabled = true;

  let ok = 0;
  const errs = [];
  let cursor = 0;
  async function worker() {
    while (cursor < snaps.length) {
      const s = snaps[cursor++];
      const payload = {
        table: s.table,
        type: localTypeToApi(s.type),
        title: s.title,
        startTime: `${s.dateStr} ${s.startTime}`,
        endTime: `${s.dateStr} ${s.endTime}`,
        attendees: s.attendees,
        venue: s.venue,
        note: s.note,
        ownerKey: s.ownerKey,
        borderColor: s.borderColor || undefined,
        // 归属人原样带回：create 端点支持 ownerMemberId → 代他人放置（ACL 放行、留痕 place_for）
        ownerMemberId: s.ownerMemberId != null ? s.ownerMemberId : undefined,
        meetingNo: s.meetingNo || undefined,
        meetingUrl: s.meetingUrl || undefined,
      };
      try {
        await apiMutate('POST', `${API_BASE}/api/items`, payload);
        ok++;
      } catch (e) {
        errs.push(`${s.title}：${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, snaps.length) }, worker));

  isUndoing = false;
  if (btn) btn.disabled = false;
  clearUndo();
  try {
    items = await loadItems(currentOffset);
    if (window.setState) setState('ready');
  } catch (e) {
    afterMutation(false);
  }
  if (errs.length) {
    showToast(`已恢复 ${ok} 条，${errs.length} 条失败：${errs[0]}`);
  } else {
    showToast(`已恢复 ${ok} 条（新编号，内容与归属人不变）`);
  }
  if (bar) bar.hidden = true;
}

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
  // 【实时协作】自己刚写入 → 用本地最新态刷新基线，否则下一轮会把自己的改动
  // 误判成"他人的改动"而弹错提示。有挂起变更时不覆盖基线（留给 flush 去发现并提示）。
  if (!_syncPending) { _syncSig = dataSig(items); _syncInited = true; }
  flushPendingSync(); // 自己的写入已落库 → 把填表期间他人攒下的变更补上
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
document.getElementById('btn-new').addEventListener('click', () => {
  if (isReadOnly()) { showToast('当前身份为只读，无法修改日程'); return; }
  renderForm(null);
});
// 空状态「新建」
document.getElementById('btn-empty-new').addEventListener('click', () => { setState('success'); renderForm(null); });

// [2026-10-28] 批量管理：进入/退出 + 全选/清空 + 删除 + 撤销
document.getElementById('btn-batch').addEventListener('click', () => {
  if (selectMode) exitSelectMode(); else enterSelectMode();
});
document.getElementById('btn-batch-all').addEventListener('click', () => selectAllVisible());
document.getElementById('btn-batch-none').addEventListener('click', () => clearSelect());
document.getElementById('btn-batch-delete').addEventListener('click', () => openBatchDeleteModal());
document.getElementById('btn-batch-exit').addEventListener('click', () => exitSelectMode());
// 【2026-10-28】新增日程类型（仅核心管理员；服务端 requireCore 兜底）
document.getElementById('btn-add-type').addEventListener('click', () => submitAddType());
document.getElementById('btn-undo').addEventListener('click', () => doUndo());
document.getElementById('btn-undo-close').addEventListener('click', () => clearUndo());
// Esc 退出批量模式（未删任何东西，纯退出，不需要确认）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectMode && !document.querySelector('.modal-overlay:not([hidden])')) {
    exitSelectMode();
  }
});
// 错误状态「重试」
document.getElementById('btn-retry').addEventListener('click', () => bootstrap());
// [Day 27] 顶栏「↻ 刷新」手动兜底：bootstrap() 内部已兜住异常并切到 error 态，不会抛出，
// 故这里靠 error 面板是否可见来判断成败，再决定播报文案（不能无条件说"已刷新"）。
document.getElementById('btn-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh');
  const errPanel = document.querySelector('.state-panel[data-state="error"]');
  btn.disabled = true;
  await bootstrap();
  btn.disabled = false;
  const failed = errPanel && !errPanel.hidden;
  showToast(failed ? '刷新失败，请重试' : '已刷新');
});
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
    // 【实时协作】每次权威加载（首屏/切周/手动刷新）都重置同步基线，
    // 否则若轮询先于 bootstrap 落库，会把较新的签名当基线 → 后续改动被误判为"没变"
    _syncSig = dataSig(data);
    _syncInited = true;
    _syncPending = false;
    setState(data.length ? 'success' : 'empty');
    // 【阶段二 P11】缓存成员列表（含 meetingNo/meetingUrl），供卡片解析归属成员的默认会议号
    try { MEMBERS_CACHE = (window.Auth && typeof window.Auth.members === 'function') ? await window.Auth.members() : []; } catch (_) { MEMBERS_CACHE = []; }
    render();
    applyRoleUI();   // 【阶段二 P9】只读身份时隐藏新建按钮
    if (!data.length) showDetail(null);
  } catch (e) {
    setState('error', e.message || '日程数据加载出错，请重试。');
  }
}

// 首次启动按默认视图定位表签
currentMode = defaultStartMode;
activateModeTab(currentMode);
initSheetDrag();   // [Day 25] 绑定移动端副栏拖动手柄（桌面端内部 isMobile 守卫，空操作）
// 【2026-10-28】类型清单先拉一次：首屏的图例/色板/筛选下拉就带上自定义类型与最新颜色。
// 不 await —— 拉不到也不能耽误看日程（loadTypeList 内部已兜底成内置 7 个）。
loadTypeList().then(r => {
  renderTypeFilter();
  if (typeof renderColorList === 'function') renderColorList();
  if (r.changed) render();   // 清单与兜底一致时不重绘（避免首屏多刷一次）
});
bootstrap();
// 【阶段二 在线人数 2026-10-18】启动心跳（匿名也跑：只上报可见性，不记心跳）
startHeartbeat();
// 【阶段二 实时协作 2026-10-27】启动自动同步（15s 静默轮询，有人改动自动出现在你屏幕上）
startAutoSync();

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
  renderMeetingSettings();  // 【阶段二 P11】加载并接线「我的腾讯会议」
  if (isAdmin()) {
    renderMemberAdmin();  // 【阶段二 管理员 UI】仅 admin 加载成员管理列表
    // 【阶段二 Step5】添加成员按钮（admin 专属；重置口令按钮在 renderMemberAdmin 内部逐行绑）
    const btnAdd = document.getElementById('btn-add-member');
    if (btnAdd) btnAdd.onclick = submitAddMember;
    // 【2026-10-27 多团队】团队信息 + 建团队（admin 专属）
    renderTeamBox();
    const btnTeam = document.getElementById('btn-create-team');
    if (btnTeam) btnTeam.onclick = submitCreateTeam;
    const btnCopy = document.getElementById('btn-copy-team-code');
    if (btnCopy) btnCopy.onclick = () => {
      const code = (document.getElementById('team-code') || {}).textContent || '';
      if (!code || code.indexOf('仅管理员') >= 0) { showToast('暂无可复制的团队码'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => showToast('团队码已复制')).catch(() => showToast('复制失败，请手动选中复制'));
      } else { showToast('当前浏览器不支持自动复制，请手动选中复制'); }
    };
  }
  renderPasscodeSettings();  // 【阶段二 Step5】任意登录成员可改自己的口令（匿名时区块隐藏，绑了也无害）
  document.getElementById('set-default-view').value = defaultStartMode;
}

// 【阶段二 P11】设置弹窗「我的腾讯会议」：读取当前成员固定会议号/链接，保存到 /api/members（方案①）
async function renderMeetingSettings() {  const noEl = document.getElementById('me-meeting-no');
  const urlEl = document.getElementById('me-meeting-url');
  const errEl = document.getElementById('me-meeting-err');
  const saveBtn = document.getElementById('btn-save-meeting');
  if (!noEl || !urlEl || !saveBtn) return;
  // 读取当前成员已有的会议信息（凭令牌，只能读自己）
  try {
    const r = await fetch(`${API_BASE}/api/members`, { headers: (window.Auth ? window.Auth.withHeaders({}) : {}) });
    const j = await r.json().catch(() => null);
    if (j && j.ok && j.data) {
      noEl.value = j.data.meetingNo || '';
      urlEl.value = j.data.meetingUrl || '';
    }
  } catch (_) { /* 读取失败不阻塞，用户可手动填 */ }
  if (errEl) {
    if (isReadOnly()) { errEl.textContent = '当前为只读身份，无法修改会议信息'; errEl.hidden = false; }
    else { errEl.hidden = true; }
  }
  // 前端域名兜底校验（与后端白名单同一份）
  const WHITELIST = ['meeting.tencent.com', 'voovmeeting.com', 'tencentmeeting.cn'];
  const validate = () => {
    const v = urlEl.value.trim();
    if (!v) { if (errEl) errEl.hidden = true; return true; }
    let host;
    try { host = new URL(v).hostname.toLowerCase(); } catch (_) { if (errEl) { errEl.textContent = '入会链接格式不正确，请输入完整链接'; errEl.hidden = false; } return false; }
    const ok = WHITELIST.some(d => host === d || host.endsWith('.' + d));
    if (!ok) { if (errEl) { errEl.textContent = '入会链接必须是腾讯会议链接'; errEl.hidden = false; } return false; }
    if (errEl) errEl.hidden = true; return true;
  };
  urlEl.oninput = validate;
  saveBtn.onclick = async () => {
    if (!validate()) return;
    const body = { meetingNo: noEl.value.trim(), meetingUrl: urlEl.value.trim() };
    try {
      const res = await fetch(`${API_BASE}/api/members`, {
        method: 'PATCH',
        headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) {
        showToast('保存失败：' + ((j && j.error && j.error.message) || ('HTTP ' + res.status)));
        return;
      }
      // 同步到本地缓存的当前成员，避免详情卡/卡片滞后
      const me = window.Auth && typeof window.Auth.currentMember === 'function' ? window.Auth.currentMember() : null;
      if (me) { me.meetingNo = j.data.meetingNo || null; me.meetingUrl = j.data.meetingUrl || null; }
      showToast('已保存我的会议信息');
      closeSettings();
    } catch (e) { showToast('保存失败：' + e.message); }
  };
}

// 【阶段二 管理员 UI 2026-10-18】设置弹窗「成员管理」（仅 admin 可见，applyRoleUI 控显隐）：
// 拉成员列表 → 每行一个角色下拉（自己那一行禁用）→「保存角色更改」把变更逐个提交 setrole。
// 铁律：前端禁用/双保险只是体验层，越权由后端 setRole（仅 admin）403 兜底。
async function renderMemberAdmin() {
  const listEl = document.getElementById('member-admin-list');
  const errEl = document.getElementById('member-admin-err');
  const saveBtn = document.getElementById('btn-save-roles');
  if (!listEl || !saveBtn) return;
  const me = (window.Auth && typeof window.Auth.currentMember === 'function') ? window.Auth.currentMember() : null;
  const members = (window.Auth && typeof window.Auth.members === 'function') ? await window.Auth.members() : [];
  if (!members.length) {
    listEl.innerHTML = '<p class="set-hint">未能加载成员列表，请稍后重试。</p>';
    return;
  }
  const ROLE_CN = { member: '普通成员', readonly: '只读成员', admin: '管理员' };
  listEl.innerHTML = '';
  members.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const isSelf = !!(me && Number(me.id) === Number(m.id));
    row.innerHTML = `
      <span class="m-name">${esc(m.displayName || ('成员#' + m.id))}${isSelf ? ' <span class="m-self">（你）</span>' : ''}</span>
      <select class="m-role" data-id="${m.id}" aria-label="${esc(m.displayName || '成员')}的角色"${isSelf ? ' disabled' : ''}>
        <option value="member"${m.role === 'member' ? ' selected' : ''}>${ROLE_CN.member}</option>
        <option value="readonly"${m.role === 'readonly' ? ' selected' : ''}>${ROLE_CN.readonly}</option>
        <option value="admin"${m.role === 'admin' ? ' selected' : ''}>${ROLE_CN.admin}</option>
      </select>
      <button class="m-reset" data-id="${m.id}" title="重置该成员口令（新口令将展示一次）">重置口令</button>`;
    listEl.appendChild(row);
  });
  // 「重置口令」逐行绑定（confirm 防误触；弹窗展示新口令，后端明文只回一次）
  listEl.querySelectorAll('.m-reset').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const target = members.find((x) => Number(x.id) === id);
      const tname = target ? (target.displayName || ('成员#' + id)) : ('成员#' + id);
      if (!confirm(`确定重置「${tname}」的口令吗？\n将生成随机新口令，旧口令立即失效。`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/items?_action=resetpasscode`, {
          method: 'POST',
          headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ memberId: id }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j || !j.ok) {
          const msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
          if (errEl) { errEl.textContent = res.status === 401 ? '登录已失效，请重新登录后再试' : ('重置失败：' + msg); errEl.hidden = false; }
          return;
        }
        if (errEl) errEl.hidden = true;
        showPasscodeModal(`「${tname}」的新口令`, '请立即复制并发送给该成员；此口令只展示这一次，刷新后无法再查看。该成员需用新口令重新登录。', j.data.passcode);
      } catch (e) {
        if (errEl) { errEl.textContent = '重置失败：' + e.message; errEl.hidden = false; }
      } finally {
        btn.disabled = false;
      }
    };
  });
  if (errEl) errEl.hidden = true;
  saveBtn.onclick = async () => {
    // 收集与初始列表不同的项（一次只提交变更，不整表重写）
    const changes = [];
    listEl.querySelectorAll('.m-role').forEach((sel) => {
      const id = Number(sel.dataset.id);
      const origin = members.find((x) => Number(x.id) === id);
      if (origin && origin.role !== sel.value) changes.push({ id, role: sel.value });
    });
    if (!changes.length) { showToast('没有需要保存的更改'); return; }
    // 双保险：禁改自己（后端 setRole 同样 403，这里先挡一道并把原因说清）
    if (me && changes.some((c) => c.id === Number(me.id))) {
      if (errEl) { errEl.textContent = '不能修改自己的角色（防止误操作丢失管理权限）'; errEl.hidden = false; }
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      for (const c of changes) {
        const res = await fetch(`${API_BASE}/api/items?_action=setrole`, {
          method: 'POST',
          headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ memberId: c.id, role: c.role }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j || !j.ok) {
          const msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
          if (res.status === 401) {
            if (errEl) { errEl.textContent = '登录已失效，请重新登录后再试'; errEl.hidden = false; }
          } else {
            if (errEl) { errEl.textContent = '保存失败：' + msg; errEl.hidden = false; }
          }
          return;
        }
      }
      if (errEl) errEl.hidden = true;
      showToast(`已保存 ${changes.length} 项角色更改（相关成员重新登录后生效）`);
      renderMemberAdmin();   // 重拉列表，回到与库一致的状态
    } catch (e) {
      if (errEl) { errEl.textContent = '保存失败：' + e.message; errEl.hidden = false; }
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存角色更改';
    }
  };
}

// —— 【阶段二 Step5 口令体系 2026-10-23】 ——
// 一次性口令展示弹窗：resetPasscode / addMember 的新口令明文只展示这一次。
function showPasscodeModal(title, hint, passcode) {
  const modal = document.getElementById('passcode-modal');
  const titleEl = document.getElementById('pc-modal-title');
  const hintEl = document.getElementById('pc-modal-hint');
  const valueEl = document.getElementById('pc-modal-value');
  const copyBtn = document.getElementById('btn-pc-copy');
  const doneBtn = document.getElementById('btn-pc-modal-done');
  const closeBtn = document.getElementById('btn-pc-modal-close');
  if (!modal || !valueEl) return;
  titleEl.textContent = title;
  hintEl.textContent = hint || '';
  valueEl.textContent = passcode;
  modal.hidden = false;
  const close = () => { modal.hidden = true; valueEl.textContent = ''; };
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(passcode);
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制口令'; }, 1500);
    } catch (_) {
      // 降级：选中文本让用户手动复制（非安全上下文等场景 clipboard API 不可用）
      const range = document.createRange();
      range.selectNodeContents(valueEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = '已选中，请手动复制';
      setTimeout(() => { copyBtn.textContent = '复制口令'; }, 1500);
    }
  };
  doneBtn.onclick = close;
  closeBtn.onclick = close;
}

// 设置弹窗「修改我的口令」：任意登录成员可用；新口令仅本人知晓（管理员不可见）。
function renderPasscodeSettings() {
  const btn = document.getElementById('btn-save-passcode');
  const errEl = document.getElementById('pc-err');
  if (!btn) return;
  btn.onclick = async () => {
    const oldPass = document.getElementById('pc-old').value;
    const newPass = document.getElementById('pc-new').value;
    const newPass2 = document.getElementById('pc-new2').value;
    if (errEl) errEl.hidden = true;
    if (!oldPass || !newPass) {
      if (errEl) { errEl.textContent = '请填写当前口令和新口令'; errEl.hidden = false; }
      return;
    }
    if (newPass !== newPass2) {
      if (errEl) { errEl.textContent = '两次输入的新口令不一致'; errEl.hidden = false; }
      return;
    }
    btn.disabled = true;
    btn.textContent = '修改中…';
    try {
      const res = await fetch(`${API_BASE}/api/items?_action=changepasscode`, {
        method: 'POST',
        headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ oldPasscode: oldPass, newPasscode: newPass }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) {
        const msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
        if (errEl) { errEl.textContent = '修改失败：' + msg; errEl.hidden = false; }
        return;
      }
      document.getElementById('pc-old').value = '';
      document.getElementById('pc-new').value = '';
      document.getElementById('pc-new2').value = '';
      showToast('口令已修改，请牢记新口令（建议重新登录）');
    } catch (e) {
      if (errEl) { errEl.textContent = '修改失败：' + e.message; errEl.hidden = false; }
    } finally {
      btn.disabled = false;
      btn.textContent = '修改口令';
    }
  };
}

// 成员管理区「添加成员」：名字 + 角色两档；初始口令随机生成，成功后弹窗一次性展示并刷新列表。
function submitAddMember() {
  const nameEl = document.getElementById('new-member-name');
  const roleEl = document.getElementById('new-member-role');
  const errEl = document.getElementById('member-add-err');
  const btn = document.getElementById('btn-add-member');
  const name = String(nameEl.value || '').trim();
  if (!name) {
    if (errEl) { errEl.textContent = '请填写成员名称'; errEl.hidden = false; }
    return;
  }
  if (errEl) errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = '添加中…';
  fetch(`${API_BASE}/api/items?_action=addmember`, {
    method: 'POST',
    headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ displayName: name, role: roleEl.value }),
  })
    .then(async (res) => {
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok) {
        const msg = (j && j.error && j.error.message) || ('HTTP ' + res.status);
        if (errEl) { errEl.textContent = res.status === 401 ? '登录已失效，请重新登录后再试' : ('添加失败：' + msg); errEl.hidden = false; }
        return null;
      }
      return j;
    })
    .then((j) => {
      if (!j) return;
      nameEl.value = '';
      showPasscodeModal(`「${j.data.member.displayName}」的初始口令`, '请立即复制并发送给该成员；此口令只展示这一次，刷新后无法再查看。', j.data.passcode);
      renderMemberAdmin();   // 刷新成员列表，新成员立即可见
    })
    .catch((e) => {
      if (errEl) { errEl.textContent = '添加失败：' + e.message; errEl.hidden = false; }
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = '+ 添加成员';
    });
}

// 【阶段二 在线人数 2026-10-18】心跳：每 30s 轻量上报一次，底栏显示「在线：N」。
// 口径（用户拍板）：30s 上报 / 2 分钟窗口判在线 / 匿名不记心跳但可见在线数。
// 失败静默（保活失败不打扰用户），保留上次显示，30s 后自然重试。
async function heartbeatTick() {
  try {
    const res = await fetch(`${API_BASE}/api/items?_action=heartbeat`, {
      method: 'POST',
      headers: (window.Auth ? window.Auth.withHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
      body: '{}',
    });
    const j = await res.json().catch(() => null);
    if (res.ok && j && j.ok && j.data && typeof j.data.online === 'number') {
      const el = document.getElementById('stat-online');
      if (el) el.textContent = '在线：' + j.data.online;
    }
  } catch (_) { /* 静默：保留上次显示，下一轮再试 */ }
}
function startHeartbeat() {
  heartbeatTick();                 // 立即来一次，不必等 30s
  setInterval(heartbeatTick, 30000);
}

// ============ 【阶段二 实时协作 2026-10-27】自动同步 ============
/* 解决的问题：A 新建日程后，B 必须手动刷新才能看到（用户实测反馈）。
   做法：15s 拉一次"当前周"数据（周范围与 loadItems 一致，payload 很小），
        用「id + 版本号」拼签名比对，没变就一个 DOM 都不碰。
   三条保护（都是踩过/想过才写的）：
     ① 填表中不打断——新建/编辑表单渲染在 #detail-body 里，重绘详情会冲掉用户输入
     ② 页面隐藏时暂停——切走标签页就停拉取，省云函数配额；切回来立刻补一次
     ③ 正在看的事项被他人删了——主动退出详情并说明，别让用户对着幽灵数据点编辑
   失败静默：网络抖动不弹错误、保留现有数据，下一轮自然恢复（与心跳同一套哲学）。 */

// 签名：id + updatedAtRaw（P9 起的并发版本号）。新增/删除/改任一字段都会变。
// 排序后再拼 → 与返回顺序无关，避免"顺序抖动"造成假变更。
function dataSig(list) {
  return list.map(it => `${it.id}:${it.updatedAtRaw || ''}`).sort().join('|');
}

// 用户此刻是否在填表（表单是动态插入 #detail-body 的，用表单 id 判断最准）
function isFormOpen() {
  return !!document.getElementById('item-form');
}

async function syncTick(opts) {
  const force = !!(opts && opts.force);
  if (_syncing) return;                        // 弱网时防堆积：上一轮没回来就不发新的
  if (document.hidden) return;                 // ② 页面不可见 → 暂停
  if (isFormOpen() && !force) { _syncPending = true; return; }  // ① 填表中 → 挂起，等关闭后补
  // ③ [2026-10-28] 撤销恢复中 → 挂起：恢复是逐条 POST，中途拉列表会把"还没恢复完"的中间态当基线，
  //    导致签名跳变、重绘两遍（被删项闪一下又回来）。撤销结束后 doUndo 会自己重新 loadItems。
  if (isUndoing && !force) { _syncPending = true; return; }
  // ④ [2026-10-28] 批量选择中 → 挂起：重绘会重建卡片、清掉勾选态，中途被同步打断很难受
  if (selectMode && !force) { _syncPending = true; return; }

  _syncing = true;
  try {
    const data = await loadItems(currentOffset);
    const sig = dataSig(data);

    if (!_syncInited) { _syncInited = true; _syncSig = sig; return; }  // 首轮只建基线
    if (sig === _syncSig) return;              // 没变 → 什么都不做（无闪屏、不丢选中）

    _syncSig = sig;
    _syncPending = false;

    // 记录"我正在看哪一条"，用于判断它是否还在、是否被改
    const watchedId = currentItem ? currentItem.id : null;
    // 保住滚动位置：重绘 #timeline 后浏览器可能跳回顶部
    const tl = document.getElementById('timeline');
    const scrolledTop = tl ? tl.scrollTop : 0;

    items = data;
    const monday = mondayOf(currentOffset), sunday = addDays(monday, 6);
    const hasWeek = items.some(it => it.start >= monday && it.start <= sunday);
    // 用 setState 统一驱动重绘（它内部走 renderCurrentView → render）。
    // 别在这里再单独调一次 render()——那样每次同步会重绘两遍（首版就是这么写的，已修正）。
    setState(hasWeek ? 'success' : 'empty');
    applyRoleUI();
    if (tl) tl.scrollTop = scrolledTop;

    if (watchedId != null) {
      const fresh = items.find(it => String(it.id) === String(watchedId));
      if (fresh) {
        // 静默换成最新版（他人可能刚改了标题/时间）；仅当内容确实变了才重绘详情
        const cur = currentItem;
        const changed = !cur || cur.title !== fresh.title || cur.startTime !== fresh.startTime
          || cur.endTime !== fresh.endTime || cur.updatedAtRaw !== fresh.updatedAtRaw;
        if (changed) showDetail(fresh);
      } else if (!isFormOpen()) {
        showDetail(null);
        showToast('你正在看的事项已被他人删除');
        _syncSuppressToast = true;             // 下面那次统一提示就别重复了
      }
    }
    if (!_syncSuppressToast) showToast('已同步他人的最新改动');
    _syncSuppressToast = false;
  } catch (_) {
    /* 静默：不打扰用户，保留现有数据 */
  } finally {
    _syncing = false;
  }
}

// 表单关闭/保存成功后补一次：把填表期间攒下的变更应用掉
// （不加这个，用户一填表就会一直挂起，直到下一次别人改动才恢复）
function flushPendingSync() {
  if (!_syncPending) return;
  setTimeout(() => { syncTick({ force: true }); }, 500);  // 留 500ms 让保存/关闭的 DOM 收尾
}

function startAutoSync() {
  syncTick();                                  // 立即建基线（与 bootstrap 抢跑也无害，bootstrap 会重置）
  _syncTimer = setInterval(() => { syncTick(); }, SYNC_INTERVAL);
  // 切回标签页立刻补一次，不用等下一个 15s
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTick(); });
}

// ============ 【2026-10-27 多团队】团队信息 / 建团队（仅管理员）============
// 团队码 = 邀请码：别人在登录页点「用团队邀请码加入」，填它就能创建账号。
// 注意：建团队【不会】把自己搬过去（一个人只属于一个团队），
//   新团队由第一个用该码加入的人成为管理员（后端 authRegister 里定的）。
async function renderTeamBox() {
  const nameEl = document.getElementById('team-name');
  const codeEl = document.getElementById('team-code');
  const errEl = document.getElementById('team-err');
  if (errEl) errEl.hidden = true;
  try {
    const data = await apiMutate('GET', `${API_BASE}/api/items?_action=team`);
    const t = (data && data.team) || {};
    if (nameEl) nameEl.textContent = t.name || '—';
    if (codeEl) codeEl.textContent = t.joinCode || '（仅管理员可见）';
  } catch (e) {
    if (errEl) { errEl.textContent = '读取团队信息失败：' + e.message; errEl.hidden = false; }
  }
}

async function submitCreateTeam() {
  const input = document.getElementById('new-team-name');
  const errEl = document.getElementById('team-err');
  const btn = document.getElementById('btn-create-team');
  const name = ((input && input.value) || '').trim();
  if (errEl) errEl.hidden = true;
  if (!name) {
    if (errEl) { errEl.textContent = '请先填写新团队名称'; errEl.hidden = false; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
  try {
    const data = await apiMutate('POST', `${API_BASE}/api/items?_action=createteam`, { name });
    const t = (data && data.team) || {};
    if (input) input.value = '';
    // 邀请码复制到剪贴板（失败不影响主流程）
    if (t.joinCode && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t.joinCode).catch(() => {});
    }
    showToast(`团队「${t.name}」已创建，邀请码 ${t.joinCode}（已复制）。把它发给大家，第一个加入的人会成为该团队管理员。`);
  } catch (e) {
    if (errEl) { errEl.textContent = '创建团队失败：' + e.message; errEl.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '+ 创建团队'; }
  }
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

/* ============ 【2026-10-28】类型与颜色管理（core 核心管理员） ============
   和旧实现的三点不同：
     1) 原来改色只 `setProperty` 到 CSS 变量 → **刷新就丢**，而且各人各调一套，谁也看不见谁的。
        现在改色落库（item_types_phase2），全团队/全站同一套。
     2) 原来固定 6 个类型，改不了名字也加不了新的。现在可以新增/改名/删除自定义类型。
     3) 原来任何人（含匿名）都能点。现在只有 core 能改——颜色是跨团队公共语言，
        谁都能改就等于没有公共语言。
   前端仍做对比度校验：不是为了安全（后端也校验），而是为了在用户还在拖色盘时就给反馈。 */
function renderColorList() {
  const wrap = document.getElementById('color-list');
  if (!wrap) return;
  const editable = isCore();
  wrap.innerHTML = '';

  TYPE_LIST.forEach(t => {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML =
      `<input class="c-name" data-code="${t.code}" value="${esc(t.label)}" maxlength="12" ${editable ? '' : 'readonly'} title="${t.builtin ? '内置类型：可改名改色，不可删除' : '自定义类型：可改名、改色、删除'}">` +
      `<input type="color" data-code="${t.code}" value="${t.color}" ${editable ? '' : 'disabled'}>` +
      `<input class="c-hex" readonly value="${t.color}">` +
      `<span class="c-warn" data-code="${t.code}" hidden>白字对比不足</span>` +
      (editable ? `<button class="c-del" data-code="${t.code}" ${t.builtin ? 'disabled' : ''} title="${t.builtin ? '内置类型不能删除（历史日程还在用）' : '删除这个类型'}">删</button>` : '');
    wrap.appendChild(row);
  });

  if (!editable) {
    const note = document.createElement('p');
    note.className = 'set-hint';
    note.textContent = '类型与颜色由核心管理员统一管理（颜色是跨团队的公共语言，不能各团队各调一套）。';
    wrap.appendChild(note);
    return;
  }

  // —— 改色：拖动时本地预览，松手才落库 ——
  wrap.querySelectorAll('input[type=color]').forEach(inp => {
    const code = inp.dataset.code;
    const row = inp.closest('.color-row');
    inp.addEventListener('input', e => {
      const val = e.target.value;
      row.querySelector('.c-hex').value = val;
      const ok = isSafeBg(val);
      row.querySelector('.c-warn').hidden = ok;
      if (ok) { document.documentElement.style.setProperty(TYPE_COLOR_VARS[localTypeCode(code)] || '--c-' + localTypeCode(code), val); render(); }
    });
    inp.addEventListener('change', async e => {
      const val = e.target.value;
      if (!isSafeBg(val)) { showToast('颜色太浅，白字看不清，已放弃这次修改'); await loadTypeList(); renderColorList(); render(); return; }
      try {
        await apiMutate('POST', `${API_BASE}/api/items?_action=updatetype`, { code, color: val });
        await loadTypeList();
        renderColorList();
        render();
        showToast('颜色已更新（全团队生效）');
      } catch (err) {
        showToast('改色失败：' + err.message);
        await loadTypeList();   // 回到服务端真值，别让界面停在假状态
        renderColorList();
        render();
      }
    });
  });

  // —— 改名：失焦时提交（回车也触发失焦） ——
  wrap.querySelectorAll('.c-name').forEach(inp => {
    const code = inp.dataset.code;
    const orig = inp.value;
    inp.addEventListener('blur', async () => {
      const val = inp.value.trim();
      if (!val || val === orig) { inp.value = orig; return; }
      try {
        await apiMutate('POST', `${API_BASE}/api/items?_action=updatetype`, { code, label: val });
        await loadTypeList();
        renderColorList();
        render();
        showToast('类型名称已更新');
      } catch (err) {
        showToast('改名失败：' + err.message);
        inp.value = orig;
      }
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
  });

  // —— 删除：只对自定义类型可用，且服务端还会再查一次"有没有日程在用" ——
  wrap.querySelectorAll('.c-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      const t = TYPE_LIST.find(x => x.code === code);
      if (!t) return;
      if (!window.confirm(`确定删除类型「${t.label}」吗？\n\n只有"没有任何日程在用"时才能删成功。`)) return;
      btn.disabled = true;
      try {
        await apiMutate('POST', `${API_BASE}/api/items?_action=deletetype`, { code });
        await loadTypeList();
        renderColorList();
        render();
        showToast(`已删除类型「${t.label}」`);
      } catch (err) {
        showToast('删除失败：' + err.message);
        btn.disabled = false;
      }
    });
  });
}

// 新增类型：用户只填「名字 + 颜色」，类型码由服务端生成（见 addItemType 注释）
async function submitAddType() {
  const nameEl = document.getElementById('new-type-name');
  const colorEl = document.getElementById('new-type-color');
  if (!isCore()) { showToast('只有核心管理员可以新增类型'); return; }
  const label = (nameEl && nameEl.value || '').trim();
  const color = (colorEl && colorEl.value) || '';
  if (!label) { showToast('请先填类型名称'); if (nameEl) nameEl.focus(); return; }
  if (!isSafeBg(color)) { showToast('这个颜色配白字太浅，请选深一点的'); return; }
  const btn = document.getElementById('btn-add-type');
  if (btn) btn.disabled = true;
  try {
    await apiMutate('POST', `${API_BASE}/api/items?_action=addtype`, { label, color });
    await loadTypeList();
    renderColorList();
    render();
    if (nameEl) nameEl.value = '';
    showToast(`已新增类型「${label}」`);
  } catch (err) {
    showToast('新增失败：' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
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
  // [阶段二 P10] 设置弹窗的「导出全部日程」改为走全量导出模块（云端全量，CSV/JSON 统一）
  window.Export2.exportItems('json')
    .then(r => { if (r.ok) showToast('已导出 ' + r.count + ' 条日程（JSON）'); })
    .catch(e => showToast('导出失败：' + e.message));
}
/* ---- 【2026-10-28 修复】日程导入：兼容导出格式 + 真正落库 + 合并 + 团队内判重 ----
   修前三个问题（2026-10-28 查代码确认，此前的导入实质是「假装导入」）：
     ① 只改内存 items，从不调接口 → 刷新即丢；更糟的是 15s 自动同步会拿云端态覆盖内存，
        导入的内容会自己「消失」。
     ② 字段名对不上：导出给的是 startTime="YYYY-MM-DD HH:mm"（全量串），
        旧代码读 it.start（导出里根本没有这个字段）→ new Date(undefined) = Invalid Date，
        且绕过了 apiItemToLocal 的拆分逻辑，条目一条都渲染不出来。
     ③ items = data.items.map(...) 是整表替换，不是合并。
   现在的行为：
     · 兼容两种来源：本项目导出的 JSON（startTime 全量串）/ 早期手写格式（start + "HH:mm"）
     · 逐条真正 POST 落库；同团队内重复由后端判重返回 409 → 计为「已存在·跳过」
     · 合并，不清空本团队已有日程
     · 未登录直接拦下（2026-10-27 起写操作必须登录），不白发请求 */
const IMPORT_MAX = 500;   // 单次上限：太多会长时间占用页面，也掩盖单条错误
const IMPORT_API_TYPES = ['meeting', 'course', 'travel', 'sport', 'life', 'pending'];

// 开始时间缺结束时间时的兜底：+30 分钟（与拨轮选完自动 +30 的行为一致），跨天则截到 23:59
function importPlus30(hhmm) {
  const parts = String(hhmm).split(':').map(Number);
  const total = parts[0] * 60 + parts[1] + 30;
  if (total > 23 * 60 + 59) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// 把一条外部 JSON 规范成前端内部结构（start:Date + startTime/endTime:"HH:mm"）。
// 无法规范时抛错，由调用方计入失败并给出具体原因（不静默丢弃）。
function normalizeImportItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('条目不是对象');
  const title = String(raw.title == null ? '' : raw.title).trim();
  if (!title) throw new Error('缺少 title');

  const startRaw = String(raw.startTime == null ? '' : raw.startTime).trim();
  const endRaw = String(raw.endTime == null ? '' : raw.endTime).trim();
  const isFullTime = s => /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(s);
  const isHhmm = s => /^\d{1,2}:\d{2}$/.test(s);

  let dateStr = '';
  let st = '';
  let et = '';

  if (isFullTime(startRaw)) {
    // A. 本项目导出格式：startTime / endTime 都是全量串
    dateStr = startRaw.slice(0, 10);
    st = startRaw.slice(11, 16).padStart(5, '0');
    if (isFullTime(endRaw)) et = endRaw.slice(11, 16);
    else if (isHhmm(endRaw)) et = endRaw.padStart(5, '0');
  } else {
    // B. 早期手写格式：start 给日期，startTime 给 HH:mm
    const base = raw.start != null ? new Date(raw.start) : null;
    if (!base || isNaN(base.getTime())) {
      throw new Error('时间无法解析（既没有 startTime 全量串，也没有合法的 start）');
    }
    const p = n => String(n).padStart(2, '0');
    dateStr = `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
    st = isHhmm(startRaw) ? startRaw.padStart(5, '0') : `${p(base.getHours())}:${p(base.getMinutes())}`;
    if (isHhmm(endRaw)) et = endRaw.padStart(5, '0');
  }

  if (!isHhmm(st)) throw new Error('缺少开始时间');
  if (!isHhmm(et)) et = importPlus30(st);                 // 结束时间缺失 → 兜底 +30 分钟
  if (et <= st) throw new Error(`结束时间须晚于开始时间（${st} → ${et}）`);

  let type = String(raw.type == null ? '' : raw.type).trim();
  if (type === 'class' || type === 'trip') type = localTypeToApi(type);   // 前端词 → 库存词
  if (IMPORT_API_TYPES.indexOf(type) < 0) type = 'pending';               // 未知类型兜底为「待安排」

  const ownerKeyRaw = String(raw.ownerKey == null ? '' : raw.ownerKey).trim();
  const ownerKey = OWNERS.some(o => o.key === ownerKeyRaw) ? ownerKeyRaw : 'self';

  return {
    title,
    table: (raw.table === 'daily' || raw.table === 'work') ? raw.table : 'work',
    type,
    start: new Date(`${dateStr}T00:00:00`),
    startTime: st,
    endTime: et,
    attendees: raw.attendees == null ? '' : String(raw.attendees),
    venue: raw.venue == null ? '' : String(raw.venue),
    note: raw.note == null ? '' : String(raw.note),
    ownerKey,
  };
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = ev => resolve(String(ev.target.result || ''));
    r.onerror = () => reject(new Error('读取文件失败（文件可能已被移动或没有读取权限）'));
    r.readAsText(file);
  });
}

async function importData(file) {
  try {
    // 门 1：写操作必须登录（匿名 2026-10-27 起只读，否则每条都会 401）
    const member = (window.Auth && typeof window.Auth.currentMember === 'function') ? window.Auth.currentMember() : null;
    if (!member) {
      alert('导入日程需要先登录。\n\n导入会写入当前团队的日程表，未登录只能看不能写。\n请先点右上角登录，再回来导入。');
      return;
    }

    // 门 2：文件与格式
    const text = await readFileAsText(file);
    let data = null;
    try { data = JSON.parse(text); }
    catch (e) {
      alert('导入失败：文件不是合法的 JSON。\n\n· 日程请导入 .json 文件（或把 Excel/CSV 先另存为 JSON）\n· 图片 / 表格识别尚未开通');
      return;
    }
    const list = Array.isArray(data) ? data : (data && data.items);
    if (!Array.isArray(list)) {
      alert('导入失败：文件里缺少 items 数组。\n\n正确格式示例：\n{\n  "items": [\n    { "title": "部门周例会", "table": "work", "type": "meeting",\n      "startTime": "2026-10-28 10:00", "endTime": "2026-10-28 11:00",\n      "ownerKey": "self" }\n  ]\n}');
      return;
    }
    if (!list.length) { alert('这个文件的 items 是空数组，没有可导入的日程。'); return; }
    if (list.length > IMPORT_MAX) {
      alert(`一次最多导入 ${IMPORT_MAX} 条，这个文件有 ${list.length} 条。\n请拆分文件后分批导入。`);
      return;
    }

    // 门 3：逐条落库。单条失败不影响其余（失败原因逐条汇总给用户，不静默吞）
    let okCount = 0;
    let dupCount = 0;
    const fails = [];
    for (let i = 0; i < list.length; i++) {
      let local = null;
      try { local = normalizeImportItem(list[i]); }
      catch (e) { fails.push(`第 ${i + 1} 条：${e.message}`); continue; }
      try {
        await apiMutate('POST', `${API_BASE}/api/items`, localItemToPayload(local));
        okCount++;
      } catch (e) {
        // 后端按 title+table+type+start+end+ownerKey 在【本团队内】判重 → 409
        if (e.code === 409) dupCount++;
        else fails.push(`第 ${i + 1} 条「${local.title}」：${e.message}`);
      }
      if ((i + 1) % 10 === 0 && i + 1 < list.length) showToast(`正在导入 ${i + 1}/${list.length}…`);
    }

    // 落库成功后重拉本团队数据（合并语义：只新增，不删已有）
    try { items = await loadItems(currentOffset); afterMutation(true); }
    catch (e) { /* 已落库，只是重拉失败：不误导成"导入失败" */ }

    const lines = [`导入完成：新增 ${okCount} 条`];
    if (dupCount) lines.push(`已存在跳过 ${dupCount} 条`);
    if (fails.length) lines.push(`失败 ${fails.length} 条`);
    let msg = lines.join('，') + '。';
    if (fails.length) msg += '\n\n失败明细（最多显示 5 条）：\n' + fails.slice(0, 5).join('\n');
    alert(msg);
  } catch (err) {
    alert('导入失败：' + (err && err.message ? err.message : String(err)));
  }
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

// [阶段二 P10] 顶栏「导出 ▾」下拉：CSV / JSON / 腾讯文档
const btnExport = document.getElementById('btn-export');
const exportMenu = document.getElementById('export-menu');
if (btnExport && exportMenu) {
  btnExport.addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; });
  document.addEventListener('click', (e) => {
    if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== btnExport) exportMenu.hidden = true;
  });
  const expCsv = document.getElementById('export-csv');
  const expJson = document.getElementById('export-json');
  const expDoc = document.getElementById('export-doc');
  if (expCsv) expCsv.addEventListener('click', async () => {
    exportMenu.hidden = true;
    try { const r = await window.Export2.exportItems('csv'); showToast('已导出 ' + r.count + ' 条日程（CSV）'); }
    catch (e) { showToast('导出失败：' + e.message); }
  });
  if (expJson) expJson.addEventListener('click', async () => {
    exportMenu.hidden = true;
    try { const r = await window.Export2.exportItems('json'); showToast('已导出 ' + r.count + ' 条日程（JSON）'); }
    catch (e) { showToast('导出失败：' + e.message); }
  });
  if (expDoc) expDoc.addEventListener('click', async () => {
    exportMenu.hidden = true;
    const r = await window.Export2.exportToTencentDoc();
    if (r.ok) showToast('已生成腾讯文档：' + r.url);
    else showToast(r.message || '腾讯文档导出失败');
  });
}

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
