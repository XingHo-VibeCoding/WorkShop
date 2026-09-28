// WorkShop · 事项读取云函数（Day 17 · Step 3 终版）
// 暴露 GET /api/items：从核心表 items 读取真实用户日程。
// 数据源：用户产出（组织内多人经共享库/腾讯文档录入），不是外部 API。
// 响应统一 { ok, data, error }（Day 17 拍板：选项 A）。
//
// 为什么不用 @cloudbase/node-sdk 的 app.rdb()：
//   本环境是「老环境 + 后挂的共享集群 PostgreSQL」，node-sdk 的 rdb() 走 PostgREST
//   通道时会自动加 Accept-Profile 头，但拿不到 schema 名 → 写成 undefined → fetch 抛错
//   （即你看到的 "Invalid value undefined for header Accept-Profile"）。
// 本函数改为直打 CloudBase PostgREST HTTP API，自己显式设置 Accept-Profile，绕开该坑。
//
// 为什么不用 node-postgres(pg) 直连：
//   共享集群 PostgreSQL 不暴露 IP:Port，pg 默认回退 127.0.0.1 被拒。
//
// 零依赖：只用 Node 18+ 内置 fetch + Bearer 鉴权。
//
// ★ 认证策略（已对照 CloudBase 官方文档核实，非猜测）★
//   PostgREST 的鉴权头统一是 `Authorization: Bearer <token>`，三种 token 同源：
//     ① 服务端 API Key（service_role）—— 云函数里做「管理/跨用户/批量」读写的
//        正确姿势，绕过 RLS，无需登录，最稳。→ 经 CB_API_KEY 环境变量注入。
//     ② 用户 access_token（authenticated）—— 转发登录用户身份，受 RLS 约束。
//     ③ 匿名 Publishable Key / 匿名登录（anon）—— 仅公开资源，受 RLS 约束。
//   本项目读「组织共享 items」属服务端管理读，首选 ①。
//
//   兜底匿名登录：不设 CB_API_KEY 时走 anon 角色；CloudBase 现强制要求
//   请求头带设备 ID（X-CloudBase-DeviceId），否则匿名登录返回 400
//   「请在请求头添加设备id」。anon 角色若遇 RLS 且未开放 SELECT 会读不到。
//
// 环境变量（均非必填，有默认值）：
//   CB_ENV_ID    环境 ID，默认 workshop-d4g02a7z81ff51a63
//   CB_SCHEMA    PG 模式名，默认 public（items 表所在模式）
//   CB_API_KEY  ★推荐★ 服务端 API Key（service_role，绕过 RLS）。
//               不设则走匿名登录（anon 角色，若表开了 RLS 可能读不到）。

'use strict';

const ENV_ID = process.env.CB_ENV_ID || 'workshop-d4g02a7z81ff51a63';
const SCHEMA = process.env.CB_SCHEMA || 'public';
const API_KEY = process.env.CB_API_KEY || '';
const GATEWAY = `https://${ENV_ID}.api.tcloudbasegateway.com`;

// 设备 ID：匿名登录必须带，生成一次稳定复用（避免每次请求换 ID 被风控）
const DEVICE_ID = 'workshop-items-' + Math.random().toString(36).slice(2, 10);

// items 表的真实列（来自 db/schema.sql）
const COLUMNS =
  'id,title,type,table_kind,start_time,end_time,week,attendees,venue,equipment,note,source,status,owner_key,created_at,updated_at';

// 兼容解析 HTTP 触发事件的查询参数（CloudBase 不同版本键名不同）
function getQuery(event = {}) {
  let qs = event.queryString || event.queryStringParameters || event.httpQuery;
  if (!qs) return {};
  if (typeof qs === 'string') {
    const out = {};
    new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (typeof qs === 'object') return qs;
  return {};
}

// —— Bearer 解析：优先 API Key（service_role），兜底匿名登录并缓存 ——
let _token = null;
let _tokenExpire = 0;

async function getBearer() {
  if (API_KEY) return API_KEY;            // 服务端 API Key 直接当 Bearer（service_role，绕过 RLS）
  const now = Date.now();
  if (_token && now < _tokenExpire) return _token;
  const res = await fetch(`${GATEWAY}/auth/v1/signin/anonymously`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CloudBase-DeviceId': DEVICE_ID,   // CloudBase 匿名登录强制要求设备 ID
    },
    body: '{}',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      `匿名登录失败 HTTP ${res.status}: ${t.slice(0, 200)}` +
      `（建议设环境变量 CB_API_KEY 走服务端 API Key，绕过匿名登录与 RLS）`
    );
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('匿名登录未返回 access_token：' + JSON.stringify(json).slice(0, 200));
  _token = json.access_token;
  _tokenExpire = now + 50 * 60 * 1000;     // 保守按 50 分钟缓存
  return _token;
}

// 把可选过滤参数拼成 PostgREST 查询串（全部由 SDK/网关参数化，无手动拼接 SQL）
function buildQueryString(q) {
  const p = new URLSearchParams();
  p.set('select', COLUMNS);
  if (q.table && q.table !== 'all') p.set('table_kind', `eq.${q.table}`);
  if (q.ownerKey) p.set('owner_key', `eq.${q.ownerKey}`);
  if (q.type) p.set('type', `eq.${q.type}`);
  if (q.week) p.set('week', `eq.${q.week}`);
  if (q.keyword) p.set('title', `ilike.*${q.keyword}*`);
  if (q.start) p.set('start_time', `gte.${q.start}`);
  if (q.end) p.set('end_time', `lte.${q.end}`);
  p.set('order', 'start_time.asc,id.asc');
  if (q.limit) {
    const n = parseInt(q.limit, 10);
    if (Number.isFinite(n) && n > 0) p.set('limit', String(n));
  }
  return p.toString();
}

// 契约要求的时间格式：YYYY-MM-DD HH:mm（24 小时制）
function fmtTime(ts) {
  if (!ts) return null;
  const s = String(ts);
  // PostgREST 返回 ISO 格式 2026-09-28T08:00:00.xxxxx+00；取前 16 位并替换 T
  return s.slice(0, 16).replace('T', ' ');
}

// PG snake_case → 前端 camelCase 短名（与 api-contract.md §2 一致）
function toItem(r) {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    table: r.table_kind,
    startTime: fmtTime(r.start_time),
    endTime: fmtTime(r.end_time),
    week: r.week,
    attendees: r.attendees,
    venue: r.venue,
    equipment: r.equipment,
    note: r.note,
    source: r.source,
    status: r.status,
    ownerKey: r.owner_key,
    createdAt: fmtTime(r.created_at),
    updatedAt: fmtTime(r.updated_at),
  };
}

async function queryItems(q) {
  const token = await getBearer();
  const url = `${GATEWAY}/v1/rdb/rest/items?${buildQueryString(q)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    let msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      msg += '（鉴权/权限失败：若走匿名登录，多半是 items 表开了 RLS 且未对 anon 开放 SELECT → 改用 CB_API_KEY 服务端密钥以 service_role 绕过）';
    }
    throw new Error(`查询 items 失败：${msg}`);
  }
  // PostgREST 成功时直接返回数组；个别网关会把数组包在 {data:[...]}
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.map(toItem);
}

exports.main = async (event = {}) => {
  const q = getQuery(event);
  try {
    const data = await queryItems(q);
    return { ok: true, data, error: null };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: {
        code: 500,
        message: err && err.message ? err.message : String(err),
      },
    };
  }
};
