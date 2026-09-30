// WorkShop · 数据访问层（DAL，Day 19）
// 本文件只负责「和数据库打交道」：建立连接、拼接查询、发请求、把数据库行映射成前端字段。
// 控制器 source/cloud/items/index.js 不再写任何 PostgREST/fetch 细节，只管收请求、校验、dispatch，
// 需要读写数据时调用本文件的 queryItems / findDuplicate / insertItem。
//
// —— 为什么要有这一层（DAL 的用处）——
//   1) 职责单一：把"怎么连库、怎么拼查询串、怎么处理 409/23505"全部关在一个文件里。
//      以后换数据源（腾讯文档 / 别的库）、改查询条件、调字段映射，只动这里，控制器一行不用改。
//   2) 易测试：控制器与数据访问解耦后，单测可以只 mock 这一层的返回，不必真连库就能验证业务流程。
//   3) 易读：index.js 只剩"收请求 → 校验 → 调 DAL"的业务流程，一眼看清 POST 一件事做了哪几步，
//      不用在胶水代码里翻找拼接查询的细节。
//
// 数据源：CloudBase 共享集群 PostgreSQL，经 PostgREST HTTP API 访问（零依赖，直打网关）。
//   为什么不用 @cloudbase/node-sdk 的 app.rdb()：老环境 + 后挂共享集群下 rdb() 拿不到 schema 名，
//   会报 "Invalid value undefined for header Accept-Profile"；故这里自己显式设置 Accept-Profile。
//   为什么不用 node-postgres(pg)：共享集群不暴露 IP:Port，pg 回退 127.0.0.1 被拒。
//   只用 Node 18+ 内置 fetch + Bearer 鉴权。
//
// 认证策略（已对照 CloudBase 官方文档核实）：
//   PostgREST 鉴权头统一 `Authorization: Bearer <token>`。本项目读/写组织共享 items 属服务端管理操作，
//   首选服务端 API Key（service_role，绕过 RLS，无需登录）→ 经 CB_API_KEY 环境变量注入。
//   不设则兜底匿名登录（需 X-CloudBase-DeviceId 头，且若表开 RLS 未对 anon 开放 SELECT 会读不到）。
//
// 环境变量：CB_ENV_ID（默认 workshop-d4g02a7z81ff51a63）/ CB_SCHEMA（默认 public）/ CB_API_KEY（★推荐★）

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

// 把可选过滤参数拼成 PostgREST 查询串（全部由网关参数化，无手动拼接 SQL）
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

// GET /api/items —— 列表读取（核心"查数据库"）
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

// POST /api/items 第 3 步 —— 内容去重查（同 标题+时间+归属+表+类型 视为重复）
// 返回 true 表示已存在重复项；去重查询本身失败（非 ok）时降级为 false（放行到写入，由唯一约束兜底）
async function findDuplicate({ title, table, type, start, end, ownerKey }) {
  const token = await getBearer();
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
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  if (!dupRes.ok) return false; // 去重查询异常 → 放行，交给写入唯一约束兜底
  const dupRows = await dupRes.json();
  return Array.isArray(dupRows) && dupRows.length > 0;
}

// POST /api/items 第 4 步 —— 写入一行
// 成功返回 { item: toItem(...) }；失败返回 { error: { code, message } }（含 409/23505 拦截）
async function insertItem(row) {
  const token = await getBearer();
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
    return { error: { code: 500, message: `写入返回非 JSON（HTTP ${insRes.status}）：${insText.slice(0, 200)}` } };
  }
  if (!insRes.ok) {
    const msg = (insJson && (insJson.message || insJson.error || insJson.error_description || insJson.hint)) || `HTTP ${insRes.status}`;
    // ★ A+B 方案：捕获数据库唯一约束冲突（PostgREST 对 23505 返回 409）★
    const isDup = insRes.status === 409 || (insJson && (insJson.code === '23505' || /duplicate key/i.test(msg)));
    if (isDup) {
      return { error: { code: 409, message: '请勿重复提交：该请求已处理（idempotencyKey 重复）' } };
    }
    return { error: { code: insRes.status, message: `写入 items 失败：${msg}` } };
  }
  const inserted = Array.isArray(insJson) ? insJson[0] : insJson;
  if (!inserted) return { error: { code: 500, message: '写入成功但未返回记录' } };
  return { item: toItem(inserted) };
}

module.exports = { queryItems, findDuplicate, insertItem };
