// 阶段二 P8：成员登录模块（经典脚本，挂 window.Auth，供 timeline.js 调用）
// 职责：token 管理(localStorage) / 登录 / verify 恢复 / 顶栏身份区渲染 / 登录弹窗。
// 安全：明文口令只走请求体（不进 URL、不写日志）；token 与 member 信息仅存 localStorage（前端持有，
//       绝不持有口令 / 哈希 / 密钥）。调用登录/校验一律走 _action 兜底式（网关未路由 /api/auth/*）。
(function () {
  'use strict';

  const API_BASE = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';
  const TOKEN_KEY = 'workshop_member_token';
  const INFO_KEY = 'workshop_member_info';

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(INFO_KEY); } catch (_) {} }
  function getInfo() { try { return JSON.parse(localStorage.getItem(INFO_KEY) || 'null'); } catch (_) { return null; } }
  function setInfo(m) { try { if (m) localStorage.setItem(INFO_KEY, JSON.stringify(m)); } catch (_) {} }

  // 给请求头注入 X-Member-Token（有令牌时）；无令牌返回原 headers（保持 v1.0 行为）
  function withHeaders(headers) {
    const h = headers || {};
    const t = getToken();
    if (t) h['X-Member-Token'] = t;
    return h;
  }

  async function login(name, passcode) {
    const r = await fetch(`${API_BASE}/api/items?_action=login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, passcode }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error && j.error.message) || '登录失败，请检查成员名称与口令');
    }
    setToken(j.data.token);
    setInfo(j.data.member);
    renderIdentity();
    return j.data.member;
  }

  // 刷新页面时用本地令牌恢复身份（不重新输口令）；令牌失效则清掉
  async function verifyRestore() {
    const t = getToken();
    if (!t) return null;
    try {
      const r = await fetch(`${API_BASE}/api/items?_action=verify`, {
        method: 'GET',
        headers: { 'X-Member-Token': t },
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) { clearToken(); renderIdentity(); return null; }
      setInfo(j.data.member || j.data);
      renderIdentity();
      return j.data.member || j.data;
    } catch (_) {
      return getInfo(); // 网络异常先保留本地身份，不强制登出
    }
  }

  function logout() {
    clearToken();
    renderIdentity();
    if (typeof window.bootstrap === 'function') window.bootstrap();
  }

  // —— 【阶段二 P9】成员列表（供"归属给谁"下拉；只读，不含凭据）——
  async function listMembers() {
    try {
      const r = await fetch(`${API_BASE}/api/items?_action=members`, { method: 'GET', headers: withHeaders({}) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) return [];
      return j.data || [];
    } catch (_) {
      return [];
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- 顶栏身份区渲染 ----
  function renderIdentity() {
    const zone = document.getElementById('identity-zone');
    if (!zone) return;
    const info = getInfo();
    if (info) {
      const name = info.displayName || info.name || '成员';
      zone.innerHTML =
        '<span class="id-chip" title="当前登录身份：' + escapeHtml(name) + '">'
        + '<span class="id-dot" style="background:' + (info.borderColor || '#999') + '"></span>'
        + escapeHtml(name) + '</span>'
        + '<button id="btn-only-mine" class="id-btn" title="只看 ' + escapeHtml(name) + ' 建/改的日程">只看 ' + escapeHtml(name) + ' 的</button>'
        + '<button id="btn-logout" class="id-btn" title="退出登录">退出</button>';
      const onlyMine = document.getElementById('btn-only-mine');
      if (onlyMine) onlyMine.addEventListener('click', () => {
        const on = onlyMine.classList.toggle('active');
        if (typeof window.setOwnerFilter === 'function') window.setOwnerFilter(on ? info.id : null);
      });
      const lo = document.getElementById('btn-logout');
      if (lo) lo.addEventListener('click', logout);
    } else {
      zone.innerHTML = '<button id="btn-login" class="id-btn primary" title="登录以标注归属">登录</button>';
      const lb = document.getElementById('btn-login');
      if (lb) lb.addEventListener('click', openLoginModal);
    }
  }

  function openLoginModal() {
    const m = document.getElementById('login-modal');
    if (!m) return;
    m.hidden = false;
    bindCloseOnce();
    const nameEl = document.getElementById('login-name');
    const passEl = document.getElementById('login-pass');
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.textContent = '';
    if (nameEl) nameEl.focus();
    const form = document.getElementById('login-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = (nameEl && nameEl.value || '').trim();
        const pass = (passEl && passEl.value) || '';
        if (!name || !pass) { if (errEl) errEl.textContent = '请输入成员名称和口令'; return; }
        const submitBtn = document.getElementById('login-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '登录中…'; }
        try {
          const member = await login(name, pass);
          if (errEl) errEl.textContent = '';
          closeLoginModal();
          if (typeof window.bootstrap === 'function') window.bootstrap(); // 重新拉取（带令牌写归属）
          if (typeof window.showToast === 'function') window.showToast('已登录：' + (member.displayName || member.name));
        } catch (err) {
          // 区分「网络/跨域失败」与「口令错误」，避免误以为自己输错了
          const msg = ((err && err.message) || '').toLowerCase();
          if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('cors') || msg.includes('load')) {
            if (errEl) errEl.textContent = '登录请求失败：请通过部署后的网址访问（不要直接双击本地 HTML 文件），或确认后端已部署。';
          } else {
            if (errEl) errEl.textContent = (err && err.message) || '登录失败';
          }
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '登录'; }
        }
      });
    }
  }

  // 关闭相关绑定：× 按钮 / 取消按钮 / 点遮罩 / ESC。只绑一次。
  function bindCloseOnce() {
    const m = document.getElementById('login-modal');
    if (!m || m.dataset.closeBound) return;
    m.dataset.closeBound = '1';

    let onKey = null;
    const close = () => {
      m.hidden = true;
      if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    };
    const closeBtn = document.getElementById('login-close');
    const cancelBtn = document.getElementById('login-cancel');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    // 点遮罩（overlay 本身，非内部卡片）关闭
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    // ESC 关闭，关闭后移除监听避免泄漏
    onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    m._loginKeyHandler = onKey; // 供 closeLoginModal 在别处关闭时清理
  }

  // 暴露给 timeline.js / 外部调用：仅隐藏弹窗并清理 ESC 监听
  function closeLoginModal() {
    const m = document.getElementById('login-modal');
    if (!m) return;
    m.hidden = true;
    if (m._loginKeyHandler) {
      document.removeEventListener('keydown', m._loginKeyHandler);
      m._loginKeyHandler = null;
    }
  }

  // 暴露给 timeline.js（window.Auth）
  window.Auth = {
    token: getToken,
    currentMember: getInfo,
    withHeaders,
    login,
    verifyRestore,
    logout,
    members: listMembers,
    renderIdentity,
    openLoginModal,
    closeLoginModal,
  };

  // 初始化：页面加载即尝试用本地令牌恢复身份
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { renderIdentity(); verifyRestore(); });
  } else {
    renderIdentity();
    verifyRestore();
  }
})();
