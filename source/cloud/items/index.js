// WorkShop · 事项读取云函数（Day 17 · Step 3 终版）
// 暴露 GET /api/items（列表读取，Day 17）+ POST /api/items（新建事项，Day 18）：
// 均读写核心表 items 的真实数据。POST 复用同一条 PostgREST 通道（零依赖、service_role 密钥）。
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
  'id,title,type,table_kind,start_time,end_time,week,attendees,venue,equipment,note,source,status,owner_key,idempotency_key,created_at,updated_at';

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

// —— HTTP 方法 / 请求体解析（兼容 CloudBase 不同版本 event 形态）——
function getMethod(event = {}) {
  return (
    event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.method ||
    'GET'
  ).toUpperCase();
}

function getBody(event = {}) {
  let raw = event.body;
  if (raw == null) raw = event.httpBody;
  if (raw == null) raw = event.payload;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw; // 已是对象
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  try { return JSON.parse(raw); }
  catch (e) { return {}; }
}

// 契约字段 → 中文名（用于缺字段报错）
const FIELD_CN = {
  title: '标题', table: '所属表', type: '事项类型',
  startTime: '开始时间', endTime: '结束时间', ownerKey: '归属标签',
};

const TABLE_KINDS = ['work', 'daily'];
const ITEM_TYPES = ['meeting', 'trip', 'travel', 'course', 'class', 'sport', 'life', 'other', 'pending'];
const OWNER_KEYS = ['self', 'depta', 'deptb', 'deptc', 'deptd', 'me'];

// 时间规整：YYYY-MM-DD HH:mm(:ss) → YYYY-MM-DD HH:mm:ss（补秒，便于与库内值精确比对去重）
function normalizeTime(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const y = m[1], mo = m[2], d = m[3], h = m[4], mi = m[5], se = m[6] || '00';
  return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
}

// ISO 周（周一为一周起点）→ "YYYY-Www"（本地时区解析，与东八区一致）
function getISOWeek(timeStr) {
  const norm = normalizeTime(timeStr);
  if (!norm) return null;
  const dt = new Date(norm.replace(' ', 'T')); // norm 已带秒，如 2026-09-30T15:00:00
  if (isNaN(dt.getTime())) return null;
  const target = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;        // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // 本周周四
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  const year = target.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// —— 新建事项（POST /api/items，Day 18）——
async function createItem(event) {
  const t0 = Date.now();
  const body = getBody(event);
  const logBody = { ...body, attendees: body.attendees ? '***' : body.attendees };
  console.log('[POST /api/items] 收到请求(脱敏):', JSON.stringify(logBody));

  // 1) 必填校验
  const required = ['title', 'table', 'type', 'startTime', 'endTime', 'ownerKey'];
  for (const f of required) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      return { ok: false, data: null, error: { code: 400, message: `缺少必填字段：${FIELD_CN[f] || f}` } };
    }
  }

  // 2) 取值校验
  const table = String(body.table).trim();
  const type = String(body.type).trim();
  const ownerKey = String(body.ownerKey).trim();
  if (!TABLE_KINDS.includes(table)) {
    return { ok: false, data: null, error: { code: 400, message: '所属表取值无效：应为 work 或 daily' } };
  }
  if (!ITEM_TYPES.includes(type)) {
    return { ok: false, data: null, error: { code: 400, message: `事项类型取值无效：${type}` } };
  }
  if (!OWNER_KEYS.includes(ownerKey)) {
    return { ok: false, data: null, error: { code: 400, message: `归属标签取值无效：${ownerKey}（应为 self/depta/deptb/deptc/deptd/me）` } };
  }
  const start = normalizeTime(body.startTime);
  const end = normalizeTime(body.endTime);
  if (!start) return { ok: false, data: null, error: { code: 400, message: '开始时间格式应为 YYYY-MM-DD HH:mm' } };
  if (!end) return { ok: false, data: null, error: { code: 400, message: '结束时间格式应为 YYYY-MM-DD HH:mm' } };
  if (end < start) return { ok: false, data: null, error: { code: 422, message: '结束时间须不早于开始时间' } };

  const title = String(body.title).trim();
  const week = getISOWeek(start) || '';
  const row = {
    title,
    type,
    table_kind: table,
    start_time: start,
    end_time: end,
    week,
    owner_key: ownerKey,
    idempotency_key: body.idempotencyKey != null ? String(body.idempotencyKey).trim() : null, // B 方案：幂等键，可空
    attendees: body.attendees != null ? String(body.attendees) : null,
    venue: body.venue != null && String(body.venue).trim() !== '' ? String(body.venue) : null,
    note: body.note != null && String(body.note).trim() !== '' ? String(body.note) : null,
    source: 'manual',
    status: 'scheduled',
  };
  console.log('[POST /api/items] 校验通过，准备写入 row(脱敏):', JSON.stringify({ ...row, attendees: row.attendees ? '***' : row.attendees }));

  const token = await getBearer();

  // 3) 防重复提交：内容去重（同 标题+时间+归属+表+类型 视为重复）
  const dupQ = new URLSearchParams();
  dupQ.set('select', 'id');
  dupQ.set('title', `eq.${title}`);
  dupQ.set('table_kind', `eq.${table}`);
  dupQ.set('type', `eq.${type}`);
  dupQ.set('start_time', `eq.${start}`);
  dupQ.set('end_time', `eq.${end}`);
  dupQ.set('owner_key', `eq.${ownerKey}`);
  const dupRes = await fetch(`${GATEWAY}/v1/rdb/rest/items?${dupQ.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA },
  });
  if (dupRes.ok) {
    const dupRows = await dupRes.json();
    if (Array.isArray(dupRows) && dupRows.length > 0) {
      console.log('[POST /api/items] 命中重复，拒绝写入');
      return { ok: false, data: null, error: { code: 409, message: '请勿重复提交：该事项已存在' } };
    }
  }

  // 4) 写入
  const insRes = await fetch(`${GATEWAY}/v1/rdb/rest/items`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify([row]),
  });
  const insText = await insRes.text();
  let insJson;
  try { insJson = JSON.parse(insText); }
  catch (e) {
    return { ok: false, data: null, error: { code: 500, message: `写入返回非 JSON（HTTP ${insRes.status}）：${insText.slice(0, 200)}` } };
  }
  if (!insRes.ok) {
    const msg = (insJson && (insJson.message || insJson.error || insJson.error_description || insJson.hint)) || `HTTP ${insRes.status}`;
    // ★ A+B 方案：捕获数据库唯一约束冲突（PostgREST 对 23505 返回 409）★
    const isDup = insRes.status === 409 || (insJson && (insJson.code === '23505' || /duplicate key/i.test(msg)));
    if (isDup) {
      return { ok: false, data: null, error: { code: 409, message: '请勿重复提交：该请求已处理（idempotencyKey 重复）' } };
    }
    return { ok: false, data: null, error: { code: insRes.status, message: `写入 items 失败：${msg}` } };
  }
  const inserted = Array.isArray(insJson) ? insJson[0] : insJson;
  if (!inserted) return { ok: false, data: null, error: { code: 500, message: '写入成功但未返回记录' } };
  console.log('[POST /api/items] 写入成功 id=', inserted.id, '耗时', Date.now() - t0, 'ms');
  return { ok: true, data: toItem(inserted), error: null };
}

exports.main = async (event = {}) => {
  const method = getMethod(event);
  if (method === 'POST') {
    try { return await createItem(event); }
    catch (err) {
      return { ok: false, data: null, error: { code: 500, message: err && err.message ? err.message : String(err) } };
    }
  }
  // 默认 GET：列表读取（Day 17 既有逻辑）
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
