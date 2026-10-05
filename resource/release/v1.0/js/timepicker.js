/* ==========================================================================
 * [Day 24] 时间拨轮 TimePicker
 * --------------------------------------------------------------------------
 * 解决痛点：时间原为自由文本输入，格式要求太严（必须 HH:mm），手打容易报错。
 * 改为「拨轮选择」，用户不再需要手动输入，格式由组件保证。
 *
 * 设计定档（用户 2026-10-04 拍板）：
 *   Q1 = A 纯双列拨轮（时 / 分），无表盘
 *   Q2 = 分钟 5 分钟一档
 *   Q4 = 结束时间自动 = 开始 + 30 分钟
 *        ⚠️ 实现细化为「跟随开始平移、保持原时长；无有效时长时按 +30 分钟」，
 *           理由见 bindPair 内 openStart 注释（避免静默吃掉既有会议的时长）。
 *
 * 弹出方式：锚定输入框的浮层（不是全屏模态）
 *   - 下方空间不足 → 自动上翻，且缩放原点跟着翻到触发框那侧
 *   - 窄屏（≤560px）→ 降级为底部抽屉
 *   - 关闭：Esc / 点浮层外 / 取消 / 确定；关闭后焦点回到输入框
 *
 * 零依赖，全局暴露 window.TimePicker = { bindPair, open, close }
 * ========================================================================== */
(function () {
  'use strict';

  var ITEM_H = 34;              // 单档高度（px），必须与 CSS .tp-item 保持一致
  var VISIBLE = 5;              // 可见档数（奇数，保证正中有选中条）
  var STEP = 5;                 // 分钟粒度：5 分钟一档
  var DEFAULT_DUR = 30;         // 无有效时长时，结束 = 开始 + 30 分钟
  var MAX_MIN = 23 * 60 + 55;   // 当日最晚档 23:55（后端不接受 24:00）

  // ---- 工具 ---------------------------------------------------------------
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function toMin(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function toStr(v) { return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60); }
  // 把任意分钟值落到最近的 5 分钟档（向下取整，避免 58 分被抬到 60）
  function snap(v) { return Math.floor(v / STEP) * STEP; }

  // ---- 两列定义 -----------------------------------------------------------
  function range(n) { var a = [], i; for (i = 0; i < n; i++) a.push(i); return a; }
  var COLS = [
    { key: 'hour', label: '时', values: range(24) },
    { key: 'minute', label: '分', values: (function () { var a = [], i; for (i = 0; i < 60; i += STEP) a.push(i); return a; })() }
  ];
  function colDef(key) {
    for (var i = 0; i < COLS.length; i++) if (COLS[i].key === key) return COLS[i];
    return null;
  }

  // ---- DOM（首次打开时构建，之后复用）-------------------------------------
  var overlay = null, pop = null, refs = {}, built = false;
  var current = null;   // { anchor, title, which, pair, onCommit, hour, minute, focusCol }
  var rafId = 0;

  function colHTML(c) {
    var items = c.values.map(function (v, i) {
      return '<button type="button" class="tp-item" role="option" data-idx="' + i +
        '" tabindex="-1">' + pad2(v) + '</button>';
    }).join('');
    return '<div class="tp-col" data-key="' + c.key + '">' +
      '<div class="tp-col-label">' + c.label + '</div>' +
      '<div class="tp-wheel">' +
        '<div class="tp-band" aria-hidden="true"></div>' +
        '<div class="tp-scroll" role="listbox" aria-label="' + c.label + '">' + items + '</div>' +
      '</div>' +
      '</div>';
  }

  function build() {
    if (built) return;
    built = true;

    overlay = document.createElement('div');
    overlay.className = 'tp-overlay';
    overlay.hidden = true;

    pop = document.createElement('div');
    pop.className = 'tp';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.innerHTML =
      '<div class="tp-head"><span id="tp-title">选择时间</span></div>' +
      '<div class="tp-wheels">' + COLS.map(colHTML).join('') + '</div>' +
      '<div class="tp-preview" id="tp-preview"></div>' +
      '<div class="tp-hint" id="tp-hint" role="status" aria-live="polite"></div>' +
      '<div class="tp-actions">' +
        '<button type="button" class="tp-btn" id="tp-cancel">取消</button>' +
        '<button type="button" class="tp-btn primary" id="tp-ok">确定</button>' +
      '</div>';

    overlay.appendChild(pop);
    document.body.appendChild(overlay);

    refs.title = pop.querySelector('#tp-title');
    refs.preview = pop.querySelector('#tp-preview');
    refs.hint = pop.querySelector('#tp-hint');
    refs.ok = pop.querySelector('#tp-ok');
    refs.cancel = pop.querySelector('#tp-cancel');

    // 列滚动条：padding 上下各 2 档，使首/末档能滚到正中
    COLS.forEach(function (c) {
      var box = pop.querySelector('.tp-col[data-key="' + c.key + '"]');
      var sc = box.querySelector('.tp-scroll');
      sc.style.height = (VISIBLE * ITEM_H) + 'px';
      sc.style.padding = (2 * ITEM_H) + 'px 0';
      c.box = box; c.sc = sc;

      sc.addEventListener('scroll', function () { scheduleSync(c.key); }, { passive: true });
      sc.addEventListener('click', function (e) {
        var it = e.target.closest ? e.target.closest('.tp-item') : null;
        if (!it) return;
        current.focusCol = c.key;
        setIndex(c.key, parseInt(it.getAttribute('data-idx'), 10), true);
      });
    });

    refs.ok.addEventListener('click', function () { close(true); });
    refs.cancel.addEventListener('click', function () { close(false); });
    // 点击浮层之外（即遮罩本身）关闭；点在浮层内部不关闭
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close(false);
    });

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', function () { if (current) place(current.anchor); }, { passive: true });
  }

  function scheduleSync(key) {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (current) syncFromScroll(key);
    });
  }

  // 滚动停止后按 scrollTop 反推当前档位（padding = 2 档，故 idx = scrollTop / ITEM_H）
  function syncFromScroll(key) {
    var c = colDef(key);
    var idx = Math.round(c.sc.scrollTop / ITEM_H);
    idx = Math.max(0, Math.min(c.values.length - 1, idx));
    if (idx !== current[key]) setIndex(key, idx, false);
    else refresh();
  }

  // mode：'jump' = 瞬间定位（打开时用）；true = 平滑滚动（点选/键盘用）；false = 只更新不滚
  function setIndex(key, idx, mode) {
    var c = colDef(key);
    idx = Math.max(0, Math.min(c.values.length - 1, idx));
    current[key] = idx;
    var items = c.sc.querySelectorAll('.tp-item');
    for (var i = 0; i < items.length; i++) {
      var on = (i === idx);
      items[i].classList.toggle('is-sel', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
      items[i].tabIndex = on ? 0 : -1;   // roving tabindex：整列只占一个 Tab 停靠点
    }
    if (mode === 'jump') {
      c.sc.scrollTop = idx * ITEM_H;
    } else if (mode) {
      try { c.sc.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' }); }
      catch (e) { c.sc.scrollTop = idx * ITEM_H; }
    }
    refresh();
  }

  // ---- 值 / 校验 / 反馈 ---------------------------------------------------
  function value() {
    return pad2(colDef('hour').values[current.hour]) + ':' + pad2(colDef('minute').values[current.minute]);
  }
  function valueMin() { return toMin(value()); }

  // 结束时间无效：结束 ≤ 开始（契约已禁止零时长，倒挂同样不允许）
  function invalidMsg() {
    if (current.which !== 'end') return '';
    var e = valueMin(), s = toMin(current.pair && current.pair.value);
    if (s == null) return '';
    if (e <= s) return '结束须晚于开始（不允许零时长）';
    return '';
  }

  // 改开始后，结束会被带到哪里
  function endAfter(startMin) {
    var e = toMin(current.pair && current.pair.value);
    var dur = (e != null && e > startMin) ? e - startMin : DEFAULT_DUR;
    return Math.min(startMin + dur, MAX_MIN);
  }

  function refresh() {
    var v = valueMin();
    var msg = invalidMsg();
    refs.hint.classList.toggle('is-error', !!msg);
    refs.ok.disabled = !!msg;

    if (current.which === 'start') {
      var ne = endAfter(v);
      refs.preview.textContent = '开始 ' + value() + ' → 结束 ' + toStr(ne);
      var e0 = toMin(current.pair && current.pair.value);
      var dur = (e0 != null && e0 > v) ? e0 - v : DEFAULT_DUR;
      refs.hint.textContent = ne <= v
        ? '已是最晚档，当日排不下结束时间'
        : '结束将同步为 ' + toStr(ne) + '（' + (ne - v) + ' 分钟'
          + (dur === DEFAULT_DUR && !(e0 != null && e0 > v) ? '，默认 +30' : '') + '）';
    } else {
      var s = toMin(current.pair && current.pair.value);
      if (msg) {
        refs.preview.textContent = '开始 ' + (current.pair ? current.pair.value : '—') + ' → 结束 ' + value();
        refs.hint.textContent = msg;
      } else {
        refs.preview.textContent = '开始 ' + current.pair.value + ' → 结束 ' + value();
        refs.hint.textContent = '时长 ' + (v - s) + ' 分钟';
      }
    }
  }

  // ---- 定位（锚定浮层）---------------------------------------------------
  function place(anchor) {
    var isSheet = window.matchMedia('(max-width: 560px)').matches;
    pop.classList.toggle('tp--sheet', isSheet);
    if (isSheet) { pop.style.left = ''; pop.style.top = ''; pop.style.transformOrigin = ''; return; }

    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth || 232;
    var ph = pop.offsetHeight || 300;
    var gap = 6, margin = 8;

    // 水平：以触发框为中心，再夹进视口
    var left = r.left + r.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

    // 垂直：默认在下方；下方放不下就上翻
    var top = r.bottom + gap, flipped = false;
    if (top + ph > window.innerHeight - margin) {
      var above = r.top - gap - ph;
      if (above >= margin) { top = above; flipped = true; }
      else { top = Math.max(margin, window.innerHeight - ph - margin); }
    }

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    // 缩放原点指向触发框：看起来是从框里「长」出来的
    var ox = Math.max(12, Math.min(r.left + r.width / 2 - left, pw - 12));
    pop.style.transformOrigin = ox + 'px ' + (flipped ? '100%' : '0');
  }

  // ---- 开关 ---------------------------------------------------------------
  function open(anchor, opts) {
    build();
    close(false);
    opts = opts || {};

    var v = toMin(anchor.value);
    if (v == null) v = opts.fallback != null ? opts.fallback : 9 * 60;
    v = Math.max(0, Math.min(MAX_MIN, v));

    current = {
      anchor: anchor,
      title: opts.title || '选择时间',
      which: opts.which || 'single',
      pair: opts.pair || null,
      onCommit: opts.onCommit || null,
      focusCol: 'hour',
      hour: 0, minute: 0
    };
    refs.title.textContent = current.title;
    pop.setAttribute('aria-label', current.title);

    // 先取消 hidden、再定位拨轮：display:none 期间 scrollTop 赋值会被浏览器丢弃，
    // 弹层就会永远停在 00:00 —— 这是踩过的坑，顺序不能反。
    // place() 必须在 setIndex 之后：setIndex 会填预览/提示文案，改变浮层高度，
    // 先量高度会量矮（提示行还是空的一行），该上翻时不翻。
    overlay.hidden = false;
    setIndex('hour', colDef('hour').values.indexOf(Math.floor(v / 60)), 'jump');
    setIndex('minute', colDef('minute').values.indexOf(snap(v % 60)), 'jump');
    place(anchor);

    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
      pop.classList.add('is-open');
    });

    var sel = colDef('hour').sc.querySelector('.tp-item.is-sel');
    if (sel) sel.focus({ preventScroll: true });
  }

  function close(commit) {
    if (!current) return;
    var c = current, val = value();
    if (commit) {
      if (refs.ok.disabled) return;                 // 无效值不允许确定
      if (c.onCommit) c.onCommit(val); else c.anchor.value = val;
    }
    var anchor = c.anchor;
    current = null;
    overlay.classList.remove('is-open');
    pop.classList.remove('is-open');
    overlay.hidden = true;
    if (anchor && anchor.focus) anchor.focus();     // 焦点回到触发框
  }

  function onKey(e) {
    if (!current) return;
    if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
    if (e.key === 'Enter') {
      if (e.target && e.target.classList && e.target.classList.contains('tp-item')) {
        e.preventDefault(); close(true);
      }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      var key = current.focusCol || 'hour';
      setIndex(key, current[key] + (e.key === 'ArrowDown' ? 1 : -1), true);
      var sel = colDef(key).sc.querySelector('.tp-item.is-sel');
      if (sel) sel.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      current.focusCol = (current.focusCol === 'hour') ? 'minute' : 'hour';
      var it = colDef(current.focusCol).sc.querySelector('.tp-item.is-sel');
      if (it) it.focus({ preventScroll: true });
    }
  }

  // ---- 对外：把「开始 / 结束」两个输入框接成一对 ---------------------------
  function bindPair(startEl, endEl, opts) {
    if (!startEl || !endEl) return;
    opts = opts || {};

    [startEl, endEl].forEach(function (el) {
      el.readOnly = true;                       // 禁止手打，格式由拨轮保证
      el.setAttribute('inputmode', 'none');      // 移动端不弹系统键盘
      el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute('autocomplete', 'off');
      // 注意：不在这里改写输入框的值——既有事项可能是空时间，静默填默认值
      // 等于替用户改数据；无效值只影响拨轮打开时的初始定位（见 open 的 fallback）。
    });

    function openStart() {
      open(startEl, {
        title: '开始时间', which: 'start', pair: endEl, fallback: 9 * 60,
        onCommit: function (val) {
          var s = toMin(val);
          startEl.value = val;
          var e0 = toMin(endEl.value);
          // 保持原时长平移：既有 2 小时会议改开始时间不应被静默砍成 30 分钟；
          // 只有原本没有有效时长（新建 / 零时长 / 倒挂）时才落到默认 +30 分钟。
          var dur = (e0 != null && e0 > s) ? e0 - s : DEFAULT_DUR;
          endEl.value = toStr(Math.min(s + dur, MAX_MIN));
          if (opts.onChange) opts.onChange('start');
        }
      });
    }

    function openEnd() {
      var s = toMin(startEl.value);
      open(endEl, {
        title: '结束时间', which: 'end', pair: startEl,
        fallback: s == null ? 10 * 60 : Math.min(s + DEFAULT_DUR, MAX_MIN),
        onCommit: function (val) {
          endEl.value = val;
          if (opts.onChange) opts.onChange('end');
        }
      });
    }

    var wire = function (el, fn) {
      el.addEventListener('click', fn);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          if (!current) fn();               // 已开着就交给浮层自己的键盘处理
        }
      });
    };
    wire(startEl, openStart);
    wire(endEl, openEnd);
  }

  window.TimePicker = { bindPair: bindPair, open: open, close: close, toMin: toMin };
})();
