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

  // 【2026-10-27 多团队】teamCode 可选：不填则后端全局按名字找，唯一命中即登录；
  // 只有跨团队重名时后端才回 409 要求补团队码。
  async function login(name, passcode, teamCode) {
    const payload = { name, passcode };
    if (teamCode && String(teamCode).trim()) payload.teamCode = String(teamCode).trim().toUpperCase();
    const r = await fetch(`${API_BASE}/api/items?_action=login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error && j.error.message) || '登录失败，请检查成员名称与口令');
    }
    setToken(j.data.token);
    applyLoginData(j.data);
    renderIdentity();
    return j.data.member;
  }

  // 登录/注册成功后统一落库：成员信息 + 团队名（团队名只做展示，不参与权限判断）
  function applyLoginData(data) {
    const info = Object.assign({}, data.member || {});
    if (data.team && data.team.name) info.teamName = data.team.name;
    if (data.team && data.team.id) info.teamId = data.team.id;
    setInfo(info);
  }

  // 【2026-10-27 多团队】用团队邀请码自助加入（注册即登录）
  async function register(joinCode, name, passcode) {
    const r = await fetch(`${API_BASE}/api/items?_action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinCode: String(joinCode || '').trim().toUpperCase(), name, passcode }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error && j.error.message) || '加入失败，请检查邀请码');
    }
    setToken(j.data.token);
    applyLoginData(j.data);
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
      applyLoginData(j.data);
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
      const teamName = info.teamName || '';
      zone.innerHTML =
        '<span class="id-chip" title="当前登录身份：' + escapeHtml(name) + (teamName ? '（' + escapeHtml(teamName) + '）' : '') + '">'
        + '<span class="id-dot" style="background:' + (info.borderColor || '#999') + '"></span>'
        + escapeHtml(name)
        + (teamName ? '<span class="id-team">' + escapeHtml(teamName) + '</span>' : '')
        + '</span>'
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
    // 【2026-10-28】身份一变就刷新底栏团队名（登录 / 登出 / 恢复会话都会走到这里）
    if (typeof window.updateTeamBadge === 'function') window.updateTeamBadge();
  }

  function openLoginModal() {
    const m = document.getElementById('login-modal');
    if (!m) return;
    m.hidden = false;
    bindCloseOnce();
    const nameEl = document.getElementById('login-name');
    const passEl = document.getElementById('login-pass');
    const teamEl = document.getElementById('login-team');
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.textContent = '';
    if (nameEl) nameEl.focus();
    const gotoReg = document.getElementById('btn-goto-register');
    if (gotoReg && !gotoReg.dataset.bound) {
      gotoReg.dataset.bound = '1';
      gotoReg.addEventListener('click', openRegisterModal);
    }
    const form = document.getElementById('login-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = (nameEl && nameEl.value || '').trim();
        const pass = (passEl && passEl.value) || '';
        const teamCode = (teamEl && teamEl.value || '').trim();   // 团队码可选
        if (!name || !pass) { if (errEl) errEl.textContent = '请输入成员名称和口令'; return; }
        const submitBtn = document.getElementById('login-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '登录中…'; }
        try {
          const member = await login(name, pass, teamCode);
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

  // ============ 【2026-10-27 多团队】加入团队（邀请码注册）弹窗 ============
  function openRegisterModal() {
    const m = document.getElementById('register-modal');
    if (!m) return;
    closeLoginModal();               // 两个弹窗不叠加
    m.hidden = false;
    const errEl = document.getElementById('register-error');
    if (errEl) errEl.textContent = '';
    const codeEl = document.getElementById('reg-code');
    if (codeEl) codeEl.focus();
    bindRegisterOnce();
  }

  function closeRegisterModal() {
    const m = document.getElementById('register-modal');
    if (m) m.hidden = true;
  }

  function bindRegisterOnce() {
    const m = document.getElementById('register-modal');
    if (!m || m.dataset.bound) return;
    m.dataset.bound = '1';

    const close = () => closeRegisterModal();
    const x = document.getElementById('register-close');
    const cancel = document.getElementById('register-cancel');
    if (x) x.addEventListener('click', close);
    if (cancel) cancel.addEventListener('click', close);
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    const back = document.getElementById('btn-goto-login');
    if (back) back.addEventListener('click', () => { closeRegisterModal(); openLoginModal(); });

    const form = document.getElementById('register-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = document.getElementById('register-error');
        const code = (document.getElementById('reg-code') || {}).value || '';
        const name = ((document.getElementById('reg-name') || {}).value || '').trim();
        const pass = (document.getElementById('reg-pass') || {}).value || '';
        const pass2 = (document.getElementById('reg-pass2') || {}).value || '';
        const fail = (msg) => { if (errEl) errEl.textContent = msg; };
        if (!code.trim()) return fail('请填写团队邀请码');
        if (!name) return fail('请填写你的名字');
        if (pass.length < 6) return fail('口令至少 6 位');
        if (pass !== pass2) return fail('两次输入的口令不一致');

        const btn = document.getElementById('register-submit');
        if (btn) { btn.disabled = true; btn.textContent = '加入中…'; }
        try {
          const member = await register(code, name, pass);
          closeRegisterModal();
          if (typeof window.bootstrap === 'function') window.bootstrap();
          const info = getInfo() || {};
          const tips = info.role === 'admin'
            ? '你是这个团队的第一个成员，已自动成为管理员'
            : '已加入团队';
          if (typeof window.showToast === 'function') window.showToast(tips + '：' + (member.displayName || name));
        } catch (err) {
          fail((err && err.message) || '加入失败');
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '加入'; }
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
    register,
    verifyRestore,
    logout,
    members: listMembers,
    renderIdentity,
    openLoginModal,
    closeLoginModal,
    openRegisterModal,
    closeRegisterModal,
  };

  // 初始化：页面加载即尝试用本地令牌恢复身份
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { renderIdentity(); verifyRestore(); });
  } else {
    renderIdentity();
    verifyRestore();
  }
})();
