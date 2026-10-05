// [Day 13] 动效与拖拽：周切换方向滑动 + 拖拽改期/转表（视觉 + 真实改数据 + 跨周持久）
// 经典脚本，共享 timeline.js 的全局作用域；不修改 timeline.js 本体，只在外部接管交互与 loadItems。
(function () {
  'use strict';

  // 拖拽产生的改期 / 转表覆盖，跨周切换时由 loadItems 重新套用（会话内持久，刷新重置，同现有 deletedIds 策略）
  const itemOverrides = new Map(); // id -> { start?: ISOString, table?: 'work'|'daily' }

  // ---- 拦截 loadItems：在 seed 基础上套用拖拽覆盖（不改动 timeline.js 源码）----
  const _origLoad = window.loadItems;
  window.loadItems = async function (off) {
    const data = await _origLoad(off);
    return data.map(it => {
      const o = itemOverrides.get(it.id);
      if (o) {
        if (o.start) it.start = new Date(o.start);
        if (o.table) it.table = o.table;
      }
      return it;
    });
  };

  // ---- 改期 / 转表：改内存 + 记覆盖 + 重渲染 ----
  function rescheduleItem(id, newStart, newTable) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    if (newStart) it.start = newStart;
    if (newTable) it.table = newTable;
    const o = itemOverrides.get(id) || {};
    if (newStart) o.start = newStart.toISOString();
    if (newTable) o.table = newTable;
    itemOverrides.set(id, o);
    afterMutation(true); // timeline.js 全局函数：重渲染 + 按本周是否还有事项切 success/empty
  }

  // =================== 周切换方向滑动 ===================
  const tl = document.getElementById('timeline');
  let weekAnim = null; // { dir: 1 前进 / -1 后退 }

  function playWeekEnter(dir) {
    tl.classList.remove('wk-enter-fwd', 'wk-enter-back');
    void tl.offsetWidth;
    tl.classList.add(dir > 0 ? 'wk-enter-fwd' : 'wk-enter-back');
    tl.addEventListener('animationend', () =>
      tl.classList.remove('wk-enter-fwd', 'wk-enter-back'), { once: true });
  }

  // 每次 #timeline 重渲染：① 让卡片可拖 ② 若刚切周则播放方向滑入
  const obs = new MutationObserver(() => {
    tl.querySelectorAll('.item').forEach(c => { c.draggable = true; });
    if (weekAnim) { playWeekEnter(weekAnim.dir); weekAnim = null; }
  });
  obs.observe(tl, { childList: true });

  document.getElementById('btn-next-week')
    .addEventListener('click', () => { weekAnim = { dir: 1 }; });
  document.getElementById('btn-prev-week')
    .addEventListener('click', () => { weekAnim = { dir: -1 }; });

  // =================== 拖拽改期 / 转表 ===================
  let dragId = null;

  tl.addEventListener('dragstart', e => {
    const card = e.target.closest('.item');
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  tl.addEventListener('dragend', () => {
    tl.querySelectorAll('.dragging').forEach(c => c.classList.remove('dragging'));
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    dragId = null;
  });
  // 落到某一列 → 改到那一天（保留起止时间）
  tl.addEventListener('dragover', e => {
    const col = e.target.closest('.day-col');
    if (!col || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('drop-target');
  });
  tl.addEventListener('dragleave', e => {
    const col = e.target.closest('.day-col');
    if (col) col.classList.remove('drop-target');
  });
  tl.addEventListener('drop', e => {
    const col = e.target.closest('.day-col');
    if (!col || !dragId) return;
    e.preventDefault();
    const cols = Array.from(tl.querySelectorAll('.day-col'));
    const idx = cols.indexOf(col);
    if (idx >= 0) {
      const newDate = addDays(mondayOf(currentOffset), idx);
      rescheduleItem(dragId, newDate, null);
    }
    col.classList.remove('drop-target');
  });

  // 落到表签（工作/日常，非总表）→ 转表
  const sheetTabs = document.getElementById('sheet-tabs');
  sheetTabs.addEventListener('dragover', e => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || !dragId) return;
    const mode = btn.dataset.mode;
    if (mode === 'all') return; // 总表不是真实表，不接受
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    btn.classList.add('drop-target');
  });
  sheetTabs.addEventListener('dragleave', e => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) btn.classList.remove('drop-target');
  });
  sheetTabs.addEventListener('drop', e => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || !dragId) return;
    const mode = btn.dataset.mode;
    if (mode === 'all') return;
    e.preventDefault();
    rescheduleItem(dragId, null, mode);
    btn.classList.remove('drop-target');
  });
})();
