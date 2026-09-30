// WorkShop · 事项接口控制器（Day 19 · 重构后）
// 本文件只负责"收请求 → 校验 → 调数据访问层"，不直接碰数据库。
// 真正查数据库的代码已拆到同目录 db.js（数据访问层 / DAL）。
// 暴露 GET /api/items（列表读取）+ POST /api/items（新建事项），读写核心表 items。
// 响应统一 { ok, data, error }（契约 api-contract.md §一，Day 17 拍板）。
//
// 分层：
//   控制器（本文件 index.js）：解析 CloudBase 触发事件、做必填/取值/时间校验、把请求翻成 DB 行、dispatch
//   数据访问层（db.js）：建连接、拼查询、发 PostgREST 请求、行→前端字段映射
//   数据库（CloudBase 共享集群 PostgreSQL，经 PostgREST 暴露）

'use strict';

const db = require('./db.js');

// —— HTTP 方法 / 请求体 / 查询参数解析（兼容 CloudBase 不同版本 event 形态）——
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

// —— 新建事项（POST /api/items，Day 18 逻辑，Day 19 改为调 DAL）——
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

  // 3) 防重复提交：内容去重（调 DAL）
  const isDup = await db.findDuplicate({ title, table, type, start, end, ownerKey });
  if (isDup) {
    console.log('[POST /api/items] 命中重复，拒绝写入');
    return { ok: false, data: null, error: { code: 409, message: '请勿重复提交：该事项已存在' } };
  }

  // 4) 写入（调 DAL）
  const result = await db.insertItem(row);
  if (result.error) return { ok: false, data: null, error: result.error };
  console.log('[POST /api/items] 写入成功 id=', result.item.id, '耗时', Date.now() - t0, 'ms');
  return { ok: true, data: result.item, error: null };
}

exports.main = async (event = {}) => {
  const method = getMethod(event);
  if (method === 'POST') {
    try { return await createItem(event); }
    catch (err) {
      return { ok: false, data: null, error: { code: 500, message: err && err.message ? err.message : String(err) } };
    }
  }
  // 默认 GET：列表读取（调 DAL）
  const q = getQuery(event);
  try {
    const data = await db.queryItems(q);
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
