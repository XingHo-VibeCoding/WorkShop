/* WorkShop MVP — 周时间线 + 双表(工作/日常) + 三模式 + 重叠提醒 + 四状态机
   默认渲染（不引入 PreText）。已预留 renderItemText() 接缝，后续可无缝替换 PreText。
   记号渲染走统一 markOf()，支持「头像图片优先、符号兜底」，满足「标记可自定义」。 */

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/* 记号 = 部门 / 人物（是否私人）。颜色 = 日程类型。
   用户 2026-09-20：记号只做部门与人物区分（私人），不表示类型；类型用颜色区分。
   后续多用户：每人各自记号；avatarUrl 可来自导入图片或腾讯文档/会议默认头像。 */
const OWNERS = [
  { key: 'self',   name: '我(部门)', mark: '★' },
  { key: 'depta',  name: '综合部',   mark: '△' },
  { key: 'deptb',  name: '业务部',   mark: '○' },
  { key: 'deptc',  name: '技术部',   mark: '□' },
  { key: 'deptd',  name: '外联部',   mark: '☆' },
  { key: 'me',     name: '我(私人)', mark: '我' },
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
      resolve(seedItems(mondayOf(weekOffset)));                        // 正常：返回 mock 数据
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
let currentOffset = 0;
let currentMode = 'work';

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
    view.filter(it => it.start.getTime() === dayDate.getTime())
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

  const weekLabel = currentOffset === 0 ? '本周' : (currentOffset > 0 ? '下' + currentOffset + '周' : '上' + (-currentOffset) + '周');
  document.getElementById('week-range').textContent = `${fmtMD(monday)} ~ ${fmtMD(sunday)} · ${weekLabel}`;
  const modeLabel = (MODES.find(x => x.key === currentMode) || {}).label || '';
  document.getElementById('stat-week').textContent = `当前周：${weekLabel}`;
  document.getElementById('stat-count').textContent = `事项（${modeLabel}）：${view.length}`;
  const wn = [...workOverlap].filter(id => view.some(v => v.id === id)).length;
  const dn = [...dailyOverlap].filter(id => view.some(v => v.id === id)).length;
  const cn = [...crossOverlap].filter(id => view.some(v => v.id === id)).length;
  const ovParts = [];
  if (wn) ovParts.push(`工作⚠${wn}`);
  if (dn) ovParts.push(`日常⚠${dn}`);
  if (cn) ovParts.push(`跨表⚠${cn}`);
  document.getElementById('stat-overlap').textContent = ovParts.length ? `重叠：${ovParts.join(' / ')}` : '重叠：无';
}

function showDetail(item) {
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

function deleteItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  if (!confirm(`确定删除「${it.title}」？\n此操作仅从本地内存移除（尚未接入腾讯文档，不会同步删除云端）。`)) return;
  items = items.filter(x => x.id !== id);
  afterMutation(true);
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
document.getElementById('btn-prev-week').addEventListener('click', () => { currentOffset--; bootstrap(); });
document.getElementById('btn-next-week').addEventListener('click', () => { currentOffset++; bootstrap(); });
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
bootstrap();
