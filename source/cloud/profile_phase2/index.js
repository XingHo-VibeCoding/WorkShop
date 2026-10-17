// WorkShop · 阶段二 P11 · 成员个人资料接口（profile_phase2）
// 职责：读写「当前登录成员」自己的个人资料——本期只动腾讯会议入会信息（方案①：固定个人会议号/链接）。
// 为什么独立成函数（TECH_DESIGN §8 + PLAN P11 方案 A）：与 items 职责干净分离，好维护、好独立部署。
//
// 路由约定（吸取 P10 教训：CloudBase HTTP 访问服务会按挂载前缀剥 path，函数看到的 path 不可靠）：
//   ★ 单动作函数，按 HTTP method 分发，不依赖 path 正则：
//     GET    → 读取自己的资料（含会议号/链接）
//     POST / PATCH → 更新自己的会议号/链接（仅自己，凭令牌里的 mid，不能改他人）
//   OPTIONS → 预检 204
// 响应统一 { ok, data, error }（契约 api-contract.md §一）；错误响应 HTTP 状态码从 error.code 推导（Day 24）。
'use strict';

const identity = require('./identity_phase2.js');

// —— 网关 / 鉴权（与 items/db.js 同口径，零依赖直打 PostgREST）——
const ENV_ID = process.env.CB_ENV_ID || 'workshop-d4g02a7z81ff51a63';
const SCHEMA = process.env.CB_SCHEMA || 'public';
const API_KEY = process.env.CB_API_KEY || '';
const GATEWAY = `https://${ENV_ID}.api.tcloudbasegateway.com`;
const DEVICE_ID = 'workshop-profile-' + Math.random().toString(36).slice(2, 10);

async function getBearer() {
  if (API_KEY) return API_KEY; // 服务端 API Key 直接当 Bearer（service_role，绕过 RLS）
  const now = Date.now();
  if (_token && now < _tokenExpire) return _token;
  const res = await fetch(`${GATEWAY}/auth/v1/signin/anonymously`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CloudBase-DeviceId': DEVICE_ID },
    body: '{}',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`匿名登录失败 HTTP ${res.status}: ${t.slice(0, 200)}（建议设 CB_API_KEY 服务端密钥）`);
  }
  const j = await res.json().catch(() => ({}));
  _token = j.access_token || j.token || '';
  _tokenExpire = now + (j.expires_in ? Number(j.expires_in) * 1000 : 3600 * 1000);
  return _token;
}
let _token = '', _tokenExpire = 0;

// —— CORS（与 items 同白名单）——
const ALLOWED_ORIGINS = [
  'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
function corsHeaders(event = {}, extra = {}) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin', ...extra };
  if (ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
function http(event, payload, statusCode) {
  if (statusCode == null) {
    const c = payload && payload.error && Number(payload.error.code);
    statusCode = (payload && payload.ok === false && c >= 400 && c < 600) ? c : 200;
  }
  return { statusCode, headers: corsHeaders(event), body: JSON.stringify(payload) };
}

// —— 请求解析（兼容 CloudBase 不同 event 形态）——
function getQuery(event = {}) {
  let qs = event.queryString || event.queryStringParameters || event.httpQuery;
  if (!qs) return {};
  if (typeof qs === 'string') {
    const out = {};
    new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    return out;
  }
  return typeof qs === 'object' ? qs : {};
}
function getBody(event = {}) {
  let raw = event.body || event.httpBody || event.payload;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function getMethod(event = {}) {
  const raw = (
    event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.method || 'GET'
  ).toUpperCase();
  if (raw === 'POST') {
    const q = getQuery(event);
    const b = getBody(event);
    const override = String(q._method || b._method || '').trim().toUpperCase();
    if (override) return override;
  }
  return raw;
}

// —— 腾讯会议链接域名白名单（方案①，防钓鱼，TECH_DESIGN §8.2）——
const MEETING_URL_WHITELIST = ['meeting.tencent.com', 'voovmeeting.com', 'tencentmeeting.cn'];
function validateMeetingUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return null; // 允许清空
  let host;
  try { host = new URL(s).hostname.toLowerCase(); }
  catch (e) { return { code: 400, message: '入会链接格式不正确，请输入完整链接' }; }
  const ok = MEETING_URL_WHITELIST.some((d) => host === d || host.endsWith('.' + d));
  if (!ok) return { code: 400, message: '入会链接必须是腾讯会议链接' };
  return null;
}

// 从 X-Member-Token 解登录成员（无/坏令牌 → null，强制登录）
function resolveLogin(event) {
  try {
    const t = identity.readTokenFrom(event);
    if (!t) return null;
    return identity.verifyToken(t); // { mid, name, role, exp }
  } catch (_) { return null; }
}

// 【阶段二 诊断加固 2026-10-16】云函数环境变量 WORKSHOP_AUTH_SECRET 未注入时，
// verifyToken 必抛「未配置身份密钥」，但 resolveLogin 会把所有异常静默吞成 null → 表现为
// "明明登录了却说未登录"（401）。此处提前自检，明确返回 503 + 中文，避免误导成登录问题。
function ensureConfigured() {
  if (identity.isConfigured && identity.isConfigured()) return null;
  console.error('[profile] WORKSHOP_AUTH_SECRET 未配置 → 无法校验身份令牌');
  return { ok: false, data: null, error: { code: 503, message: '服务未配置身份密钥，请联系管理员（云函数环境变量 WORKSHOP_AUTH_SECRET 缺失）' } };
}

const MEMBER_SELECT = 'id,display_name,role,border_color,meeting_no,meeting_url';
function toMember(r) {
  if (!r) return null;
  return {
    id: r.id,
    displayName: r.display_name || '',
    role: r.role || 'member',
    borderColor: r.border_color || null,
    meetingNo: r.meeting_no || null,
    meetingUrl: r.meeting_url || null,
  };
}

// —— GET /api/members：读取自己的资料 ——
async function getProfile(event) {
  const cfg = ensureConfigured(); if (cfg) return cfg;
  const me = resolveLogin(event);
  if (!me || !me.mid) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再查看个人会议信息' } };
  }
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', MEMBER_SELECT);
  p.set('id', `eq.${me.mid}`);
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, data: null, error: { code: 500, message: '读取成员资料失败（返回非 JSON）' } }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    console.error('[profile] getProfile DB error:', msg);
    return { ok: false, data: null, error: { code: 500, message: '读取成员资料失败，请稍后重试' } };
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return { ok: true, data: toMember(rows[0] || null), error: null };
}

// —— POST/PATCH /api/members：更新自己的会议号/链接 ——
async function updateProfile(event) {
  const cfg = ensureConfigured(); if (cfg) return cfg;
  const me = resolveLogin(event);
  if (!me || !me.mid) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再保存个人会议信息' } };
  }
  // 【阶段二 权限收敛 seam B】只读身份一律拒绝修改（前端 applyRoleUI 已禁用保存按钮，此处为最终审防线）
  if (me.role === 'readonly') {
    return { ok: false, data: null, error: { code: 403, message: '当前身份为只读，无法修改个人会议信息' } };
  }
  const body = getBody(event);
  const patch = {};
  if (body.meetingUrl !== undefined && body.meetingUrl !== null) {
    const s = String(body.meetingUrl).trim();
    if (s === '') patch.meeting_url = null; // 清空
    else {
      const ve = validateMeetingUrl(s);
      if (ve) return { ok: false, data: null, error: ve };
      patch.meeting_url = s;
    }
  }
  if (body.meetingNo !== undefined && body.meetingNo !== null) {
    const s = String(body.meetingNo).trim();
    patch.meeting_no = s === '' ? null : s.slice(0, 60); // 清空或截断
  }
  if (!Object.keys(patch).length) {
    return { ok: false, data: null, error: { code: 400, message: '没有要更新的字段：请至少传 meetingNo 或 meetingUrl' } };
  }

  const token = await getBearer();
  const q = new URLSearchParams();
  q.set('id', `eq.${me.mid}`); // ★ 只能改自己：mid 来自令牌，前端无法冒充他人
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${q.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    console.error('[profile] updateProfile non-JSON:', text.slice(0, 200));
    return { ok: false, data: null, error: { code: 500, message: '保存失败，请稍后重试' } };
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    console.error('[profile] updateProfile DB error:', msg);
    return { ok: false, data: null, error: { code: res.status >= 400 && res.status < 600 ? res.status : 500, message: '保存个人会议信息失败，请稍后重试' } };
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  console.log('[profile] 更新成功 mid=', me.mid, '改动', Object.keys(patch).join(','));
  return { ok: true, data: toMember(rows[0] || null), error: null };
}

// —— 入口 ——
exports.main = async (event = {}) => {
  const t0 = Date.now();
  try {
    const method = getMethod(event);
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders(event, {
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-Member-Token',
      }), body: '' };
    }
    if (method === 'GET') {
      const r = await getProfile(event);
      return http(event, r);
    }
    if (method === 'POST' || method === 'PATCH') {
      const r = await updateProfile(event);
      return http(event, r);
    }
    return http(event, { ok: false, data: null, error: { code: 405, message: '不支持的请求方法' } });
  } catch (e) {
    console.error('[profile_phase2] 未捕获异常:', e && e.stack ? e.stack : String(e));
    return http(event, { ok: false, data: null, error: { code: 500, message: '服务暂时不可用，请稍后重试' } });
  } finally {
    console.log('[请求日志]', new Date().toISOString(), (event.httpMethod || ''), '/api/members →', '耗时', Date.now() - t0, 'ms');
  }
};
