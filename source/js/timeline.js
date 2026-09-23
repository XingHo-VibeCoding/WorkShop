/* WorkShop MVP — 周时间线 + 双表(工作/日常) + 三模式 + 重叠提醒 + 四状态机
   默认渲染（不引入 PreText）。已预留 renderItemText() 接缝，后续可无缝替换 PreText。
   记号渲染走统一 markOf()，支持「头像图片优先、符号兜底」，满足「标记可自定义」。 */

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

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

// ---- 四状态机 ----
const appState = { value: 'loading', error: null };

function setMainVisible(v) {
  document.getElementById('timeline').hidden = !v;
  document.getElementById('detail').hidden = !v;
}
function showStateLayer(which) {
  const layer = document.getElementById('state-layer');
  layer.hidden = !which;
  layer.querySelectorAll('.state-panel').forEach(p => { p.hidden = (p.dataset.state !== which); });
}
function setState(s, msg) {
  appState.value = s;
  if (s === 'loading' || s === 'error') {
    setMainVisible(false);
    showStateLayer(s);
    if (s === 'error') document.getElementById('error-msg').textContent = msg || '日程数据加载出错，请重试。';
  } else { // success | empty
    setMainVisible(true);
    showStateLayer(null);
  }
  document.getElementById('stat-sync').textContent = '同步状态：本地内存（未接入腾讯文档）';
  document.getElementById('stat-sync').dataset.state = s;
}

// ---- 数据层：异步加载（mock 返回 Promise，预留真实 API 接缝）----
/* 真实接口实装后，loadItems 改为 fetch('/api/schedule?week=...') 等；
   当前用本地 mock + setTimeout 模拟网络延迟，并支持 URL 调试参数 ?debug=empty|error 触发各状态。 */
function loadItems(weekOffset = 0) {
  const debug = new URLSearchParams(location.search).get('debug');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (debug === 'empty') return resolve([]);                       // 演示「空」状态
      if (debug === 'error') return reject(new Error('模拟：腾讯文档读取失败（401 未授权）')); // 演示「错误」状态
      resolve(seedItems(mondayOf(weekOffset)).filter(it => !deletedIds.has(it.id))); // 正常：返回 mock 数据，并剔除已删除项（跨周持久）
    }, 600);
  });
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
  const { showMark = false, warn = null } = opts;
  const m = markOf(item);
  const el = document.createElement('div');
  el.className = `item type-${item.type}`;
  el.dataset.id = item.id;
  // [预留] 拖动式删除/转移：后续给 el 加 draggable + drop 事件即可，调用方无需改动
  el.innerHTML =
    (showMark ? markHTML(m) : '') +
    `<span class="item-time">${item.startTime}–${item.endTime}</span>` +
    `<span class="item-title">${esc(renderItemText(item))}</span>` +
    (warn ? `<span class="item-warn" title="${esc(warn.title)}">⚠</span>` : '');
  el.addEventListener('click', () => showDetail(item));
  return el;
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
    filtered.filter(it => it.start.getTime() === dayDate.getTime())
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
      .forEach(it => {
        const ovCross = crossOverlap.has(it.id);
        const ovWork = workOverlap.has(it.id);
        const ovDaily = dailyOverlap.has(it.id);
        let ovClass = '', ovTitle = '';
        if (ovCross) { ovClass = 'overlap-cross'; ovTitle = '跨表冲突：工作与日常时间重叠'; }
        else if (ovWork) { ovClass = 'overlap-work'; ovTitle = '工作冲突：时间重叠'; }
        else if (ovDaily) { ovClass = 'overlap-daily'; ovTitle = '日常提醒：时间重叠（允许重叠）'; }
        const hasOv = ovClass !== '';
        // 复用可复用卡片组件 renderItemCard（余力加练 Day 8）
        const card = renderItemCard(it, {
          showMark: currentMode === 'all',
          warn: hasOv ? { title: ovTitle } : null,
        });
        if (hasOv) card.classList.add(ovClass);
        body.appendChild(card);
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

function showDetail(item) {
  currentItem = item || null;
  const d = document.getElementById('detail');
  if (!item) {
    d.innerHTML = `<p class="detail-empty">点击时间线上的事项查看详情，或点「+ 新建」添加。底部可切换工作/日常/总表。</p>${legendHTML()}`;
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
      <p class="row"><b>备注</b>${esc(item.note)}</p>
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

  const fTable = document.getElementById('f-table');
  const fType = document.getElementById('f-type');
  const syncCond = () => {
    const t = fTable.value;
    document.getElementById('f-owner').style.display = t === 'work' ? '' : 'none';
    fType.innerHTML = typeOptionsHTML(t, fType.value);
  };
  fTable.addEventListener('change', syncCond);
  syncCond();

  document.getElementById('item-form').addEventListener('submit', e => { e.preventDefault(); saveItem(existing); });
  document.getElementById('btn-cancel').addEventListener('click', () => showDetail(existing || null));
}

function typeOptionsHTML(table, selected) {
  const map = table === 'daily'
    ? [['class', '课表'], ['sport', '运动'], ['life', '生活'], ['other', '其他']]
    : [['meeting', '会议'], ['trip', '行程'], ['pending', '待安排']];
  return map.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}

function saveItem(existing) {
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
  if (existing) Object.assign(existing, data);
  else items.push(Object.assign({ id: 'u' + Date.now() }, data));
  afterMutation();
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
  body.innerHTML =
    `<p class="del-msg">确定要删除「<b>${esc(item.title)}</b>」吗？</p>` +
    `<p class="del-sub">此操作仅从本地内存移除（尚未接入腾讯文档，不会同步删除云端）。</p>` +
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

function runDelete(item) {
  const overlay = document.getElementById('delete-modal');
  const body = document.getElementById('delete-body');
  if (!body) return;
  _delUserCloseLocked = true; // loading 中锁定用户关闭
  // 处理中：spinner + 禁用按钮（用户最明确知道“操作在生效”的信号）
  body.innerHTML = `<p class="del-loading"><span class="spinner"></span>正在删除「${esc(item.title)}」…</p>`;
  // 失败分支：?debug=delfail 模拟后端错误
  const fail = new URLSearchParams(location.search).get('debug') === 'delfail';
  setTimeout(() => {
    if (fail) {
      _delUserCloseLocked = false; // 失败态解锁，可取消
      body.innerHTML =
        `<p class="del-error del-error-shake">删除失败：网络异常，请稍后重试。</p>` +
        `<div class="del-actions">` +
          `<button id="del-cancel">取消</button>` +
          `<button class="btn-danger" id="del-confirm">重试</button>` +
        `</div>`;
      document.getElementById('del-cancel').onclick = () => closeDeleteModal();
      document.getElementById('del-confirm').onclick = () => runDelete(item);
    } else {
      // 成功：移除数据 → 刷新 → 关闭弹窗（卡片可见消失 = 第二个生效信号）
      deletedIds.add(item.id); // 标记已删，切周重灌种子后也不复活
      items = items.filter(x => x.id !== item.id);
      afterMutation(true);
      _delUserCloseLocked = false;
      closeDeleteModal();
    }
  }, 700);
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
