// [Day 13] 视图切换：Hash 路由 + 周总览视图
// 与 timeline.js 同为经典脚本，共享全局作用域（currentView / items / mondayOf 等均可直接用）。
// 设置仍为弹窗（不进路由）；视图仅两个：时间线(#/timeline) 与 总览(#/overview)。
(function () {
  'use strict';

  const WEEK_WIN = { start: 7, end: 23 };            // 总览时间窗 07:00–23:00
  const SLOTS = (WEEK_WIN.end - WEEK_WIN.start) * 2; // 半小时粒度 → 32 格
  const HEAD_H = 30;   // 日期表头 / 时间轴表头高
  const HEAD_GAP = 2;  // 表头与首格之间的间距
  const SLOT_PITCH = 11; // 单格行距（9 高 + 2 间隙）
  const HOUR_PITCH = SLOT_PITCH * 2; // 1 小时 = 2 格 = 22px
  const typeName = t => (TYPE_COLOR_DEFS.find(([k]) => k === t) || [, '事项'])[1];
  const VIEW_ORDER = ['timeline', 'overview'];
  let prevView = null;                               // 用于判断视图切换方向

  // 解析地址栏 #/timeline | #/overview，缺省时间线
  function parseHashView() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    return h === 'overview' ? 'overview' : 'timeline';
  }

  // 供 timeline.js 的 setState 调用：按 currentView 渲染对应视图
  window.renderCurrentView = function () {
    if (currentView === 'overview') renderOverviewView();
    else render();
  };

  // 入场上添加方向滑动（首屏不打动画）
  function animateEnter(el, dir) {
    el.classList.remove('view-enter-fwd', 'view-enter-back');
    void el.offsetWidth; // 强制 reflow，确保动画可重放
    el.classList.add(dir > 0 ? 'view-enter-fwd' : 'view-enter-back');
    el.addEventListener('animationend', () =>
      el.classList.remove('view-enter-fwd', 'view-enter-back'), { once: true });
  }

  // 按地址栏切换视图：显隐两视图 + 导航高亮 + 重渲染（四状态层仍由 setState 控制）
  function applyView() {
    currentView = parseHashView();
    const t = document.getElementById('view-timeline');
    const o = document.getElementById('view-overview');
    const dir = prevView === null ? 0
      : (VIEW_ORDER.indexOf(currentView) >= VIEW_ORDER.indexOf(prevView) ? 1 : -1);
    prevView = currentView;
    if (t) {
      const show = currentView === 'timeline';
      t.hidden = !show;
      if (show && dir !== 0) animateEnter(t, dir);
    }
    if (o) {
      const show = currentView === 'overview';
      o.hidden = !show;
      if (show && dir !== 0) animateEnter(o, dir);
    }
    document.querySelectorAll('#view-nav a').forEach(a =>
      a.classList.toggle('active', a.dataset.view === currentView));
    window.renderCurrentView();
  }

  // 总览：三表各出一张 7 天 × 32 格空闲网格，占用格按类型着色，空白即空闲
  // [Day 13 调整] 三个格点图水平并排（.ov-tables 横向 flex；窄屏自动换行）
  // [Day 13 调整] 每个网格左侧加时间轴（整点标注，横向滚动时固定），便于按真实时段判断空闲/轻安排
  // [Day 13 调整] 总表密度着色：单表占用=轻（半透明），工作+日常重叠=重（红框）
  // [Day 13 调整] 整点辅助线改为跨整行的连续横线（.ov-hr），与时刻标签严格对齐
  function renderOverviewView() {
    const body = document.getElementById('overview-body');
    if (!body) return;
    const monday = mondayOf(currentOffset);
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const tables = [
      { key: 'work',  label: '工作事项表' },
      { key: 'daily', label: '日常事项表' },
      { key: 'all',   label: '总表' },
    ];
    const legend = '<div class="ov-legend">'
      + '<span><i class="lg-empty"></i>空闲/未安排</span>'
      + '<span><i class="lg-light"></i>单表占用·轻</span>'
      + '<span><i class="lg-heavy"></i>工作+日常重叠·重</span>'
      + '<span><i class="lg-line"></i>整点辅助线</span>'
      + '</div>';
    let html = '<h2 class="ov-title">周空闲时间总览</h2>'
      + '<p class="ov-sub">' + fmtMD(days[0]) + ' – ' + fmtMD(days[6])
      + ' · 半小时粒度（左侧整点为起始时间）· 色块=已占用，空白=空闲/安排轻</p>'
      + legend;
    html += '<div class="ov-tables">' + tables.map(t => {
      const grid = gridFor(t.key, days);
      const isAll = t.key === 'all';
      const cols = days.map((d, di) => '<div class="ov-day">'
        + '<div class="ov-day-head">' + labels[di] + '<br>' + fmtMD(d) + '</div>'
        + grid[di].map((s, si) => ovCell(s, isAll, si)).join('')
        + '</div>').join('');
      return '<div class="ov-table"><h3>' + t.label + '</h3><div class="ov-grid">'
        + ovAxis() + cols + ovLines() + '</div></div>';
    }).join('') + '</div>';
    body.innerHTML = html;
    // 让整行线覆盖整个可滚动宽度（含横向滚动后露出的列）
    body.querySelectorAll('.ov-grid').forEach(g => {
      const w = g.scrollWidth + 'px';
      g.querySelectorAll('.ov-hr').forEach(l => { l.style.left = '0'; l.style.width = w; });
    });
  }

  // 时间轴：与每 2 格（1 小时）对齐的整点标注；轴内无竖向间隙，使其与 2 格组严格对齐
  function ovAxis() {
    let cells = '';
    for (let h = WEEK_WIN.start; h < WEEK_WIN.end; h++) {
      cells += '<div class="ov-axis-cell">' + h + ':00</div>';
    }
    return '<div class="ov-axis"><div class="ov-axis-head"></div>' + cells + '</div>';
  }

  // 整行辅助线：在每个整点起始高度画一条贯穿整行的连续横线
  // 轴线整点标签顶 = 表头高 HEAD_H(30px)（轴内已清零竖向间隙）；之后每小时推进 HOUR_PITCH(22px)
  function ovLines() {
    let s = '';
    for (let h = 0; h <= 15; h++) { // 07:00(0) … 22:00(15)
      const top = HEAD_H + h * HOUR_PITCH;
      s += '<div class="ov-hr" style="top:' + top + 'px"></div>';
    }
    return s;
  }

  // 单格渲染：空闲=空白；占用按类型着色；总表额外区分轻(半透明)/重(红框)
  function ovCell(s, isAll) {
    if (!s.type) return '<div class="ov-slot"></div>';
    if (isAll && s.count >= 2) {
      return '<div class="ov-slot filled heavy" style="background:var('
        + TYPE_COLOR_VARS[s.type] + ')" title="' + esc(typeName(s.type))
        + ' ×' + s.count + '（工作+日常重叠，安排重）"></div>';
    }
    if (isAll && s.count === 1) {
      return '<div class="ov-slot filled light" style="background:var('
        + TYPE_COLOR_VARS[s.type] + ')" title="' + esc(typeName(s.type))
        + '（单表占用，安排轻）"></div>';
    }
    return '<div class="ov-slot filled" style="background:var('
      + TYPE_COLOR_VARS[s.type] + ')" title="' + esc(typeName(s.type)) + '"></div>';
  }

  // 把 items 映射到 7×SLOTS 占用网格；总表统计 work/daily 重叠数（count）用于轻/重着色
  function gridFor(tableKey, days) {
    const grid = days.map(() => Array.from({ length: SLOTS }, () => ({ type: null, count: 0 })));
    const toSlot = (h, m) => (h - WEEK_WIN.start) * 2 + (m >= 30 ? 1 : 0);
    items.forEach(it => {
      if (tableKey !== 'all' && it.table !== tableKey) return;
      if (tableKey === 'all' && it.table !== 'work' && it.table !== 'daily') return;
      const di = days.findIndex(d => d.toDateString() === new Date(it.start).toDateString());
      if (di < 0) return;
      const [sh, sm] = String(it.startTime || '').split(':').map(Number);
      const [eh, em] = String(it.endTime || '').split(':').map(Number);
      if ([sh, sm, eh, em].some(v => Number.isNaN(v))) return;
      let s = toSlot(sh, sm);
      let e = toSlot(eh, em);              // 半开区间：e 为结束边界，不占位
      s = Math.max(0, s); e = Math.min(SLOTS, e);
      for (let i = s; i < e && i < SLOTS; i++) {
        if (grid[di][i].count === 0) grid[di][i].type = it.type;
        grid[di][i].count++;
      }
    });
    return grid;
  }

  // 启动：按地址栏定位视图 + 监听 hash 变化（点导航 / 手改 # 都能切视图）
  applyView();
  window.addEventListener('hashchange', applyView);
})();
