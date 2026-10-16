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

// —— 【Day 23】错误提示统一层 ——
// 任何意外异常在离开云函数前，都先过这里：翻成一句中文人话给用户，英文原文只写进日志。
// 分类规则与文案都在 errors.js 里，本文件只负责"接上"。
const { toUserError, logError } = require('./errors.js');

// —— 【阶段二 P6-②】身份与令牌模块 ——
// 登录（名字 + 口令 → 令牌）与身份校验都靠它。本文件只做「接线」和「入参校验」：
// 口令哈希、令牌签名这类密码学的事全在 identity_phase2.js 里，碰库的仍归 db.js。
// ★ 分层理由：身份模块要被多处复用（登录、后续写操作的权限判定），独立成文件才能单独测。
// ★ 微信路线已放弃（P6-① 探针①实测：启用必须填公众号 AppID + AppSecret，个人主体拿不到），
//   本期身份 = 口令方案（方案 2），登录需「显示名 + 口令」两项（用户 2026-10-07 拍板方案 B，
//   理由：后续要通用化，按名字定位比全表逐一比对更容易扩展）。
const identity = require('./identity_phase2.js');

// —— 【阶段二 P9】应用层权限判定（决策表：TECH_DESIGN_phase2 §6.2 + PRD A5）——
const acl = require('./acl_phase2.js');

// —— 【Day 20 · CORS 配置】——
// 浏览器跨域调用本接口时，响应必须带 Access-Control-Allow-Origin，否则被浏览器拦截。
// 白名单只放行：生产静态托管域名 + 本地调试端口，禁止 * 通配符（Day 20 清单硬性要求）。
// 返回形态从「裸对象」改为 { statusCode, headers, body }（自定义头必须用完整形态才会输出）。
const ALLOWED_ORIGINS = [
  'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com', // 生产：静态网站托管
  'http://localhost:8080',  // 本地接线调试（Day 20，仅开发用）
  'http://127.0.0.1:8080',  // 本地接线调试（Day 20，仅开发用）
];

function corsHeaders(event = {}, extra = {}) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin', ...extra };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// 统一包成 HTTP 完整返回形态（业务逻辑仍返回裸 { ok, data, error }，在此处包壳）
function http(event, payload, statusCode) {
  // —— 【Day 24 修复】错误响应的 HTTP 状态码 ——
  // 改前：statusCode 默认 200，而业务错误分支只返回裸 {ok:false,error:{code}}、不传第三参，
  //       于是"缺字段/非法id/缺confirm/重复删除"这些错误在 HTTP 层全是 200，只有展开 body
  //       才看得到 code —— 违反契约 §一（错误响应应为 HTTP 4xx/5xx），也让 Network 面板看不出失败。
  // 改后：没显式给状态码时，从 error.code 推导；正常响应一律 200；catch 分支已传 e.code 的不受影响。
  if (statusCode == null) {
    const c = payload && payload.error && Number(payload.error.code);
    statusCode = (payload && payload.ok === false && c >= 400 && c < 600) ? c : 200;
  }
  return { statusCode, headers: corsHeaders(event), body: JSON.stringify(payload) };
}

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
  const raw = (
    event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.method ||
    'GET'
  ).toUpperCase();
  // 【Day 22】兜底：有些 HTTP 网关只放行 GET/POST，PATCH/DELETE 会被挡在网关层返回 405。
  // 真遇到这种情况，客户端可以退而用 POST + `?_method=PATCH`（或请求体里带 _method）表达真实意图，
  // 业务逻辑完全一样，只是进门的方式不同。能直连 PATCH 时这段不会生效。
  if (raw === 'POST') {
    const q = getQuery(event);
    const b = getBody(event);
    const override = String(q._method || b._method || '').trim().toUpperCase();
    if (override) return override;
  }
  return raw;
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
// 【Day 24】解析放宽（契约同步）：前端已改成拨轮选时间、不再手打，但脚本 / 将来的导入接口仍会送各种写法，
//   所以这里接受：日期用 - 或 / 分隔、日期与时间之间空格或 T、月/日/时/分可不补前导零。
//   归一后一律输出规范串 YYYY-MM-DD HH:mm:ss，下游（去重、周计算、校验）看到的永远是同一种形状。
function normalizeTime(s) {
  if (!s) return null;
  const m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const p2 = (x) => String(x).padStart(2, '0');
  const y = m[1], mo = p2(m[2]), d = p2(m[3]), h = p2(m[4]), mi = m[5], se = m[6] || '00';
  // 顺带挡掉不存在的月/日/时/分，避免 '2026-13-40 99:99' 这种被当成合法时间写进库
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  if (Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return null;
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

// 【阶段二 P8】从请求解登录成员：读 X-Member-Token → verifyToken；无令牌/坏令牌返回 null（不强制登录）。
// 仅用于写路径归属标记（owner_member_id / created_by / updated_by）。未登录时这些列保持 NULL，与 v1.0 一致。
function resolveLogin(event) {
  try {
    const t = identity.readTokenFrom(event);
    if (!t) return null;
    return identity.verifyToken(t); // { mid, name, role, exp }
  } catch (_) {
    return null;
  }
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
  // 【Day 24 契约变更】零时长（end === start）不再允许：排会语义下既不是区间也不是待排事项，
  // 原「≥」改为严格「>」。前端拨轮选完结束时会自动 +30 分钟，正常路径不会踩到这条。
  if (end <= start) return { ok: false, data: null, error: { code: 422, message: '结束时间须晚于开始时间' } };

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
  // 【阶段二 P11】会议入会信息（单条覆盖，方案①）：可选，写入前校验链接域名
  if (body.meetingUrl != null && String(body.meetingUrl).trim() !== '') {
    const ve = validateMeetingUrl(body.meetingUrl);
    if (ve) return { ok: false, data: null, error: ve };
    row.meeting_url = String(body.meetingUrl).trim();
  }
  if (body.meetingNo != null && String(body.meetingNo).trim() !== '') {
    row.meeting_no = String(body.meetingNo).trim();
  }
  // 【阶段二 P9】权限判定 + 归属写入。
  // owner_member_id / created_by 必须由后端从令牌解（不可信前端，防伪造归属）。
  const _lm = resolveLogin(event);
  let _placeForTarget = null;   // 给他人放时的目标成员 id（用于写留痕）
  let _placeForName = '';
  if (_lm) {
    const targetOwnerId = body.ownerMemberId != null && String(body.ownerMemberId).trim() !== ''
      ? Number(body.ownerMemberId) : null;
    const dec = acl.decideWrite(_lm, { op: 'create', targetOwnerId });
    if (!dec.ok) {
      return { ok: false, data: null, error: { code: dec.code, message: dec.message } };
    }
    row.owner_member_id = dec.ownerMemberId;
    row.created_by = _lm.mid;
    if (dec.placeFor) {
      // ② 给他人放：校验目标成员真实存在，并取【库里】的外框色（防前端冒充颜色），随后写留痕
      const target = await db.findMemberById(dec.ownerMemberId);
      if (!target) {
        return { ok: false, data: null, error: { code: 400, message: '目标成员不存在，无法代为放置' } };
      }
      row.border_color = target.borderColor || null;
      _placeForTarget = target.id;
      _placeForName = target.displayName;
    } else if (body.borderColor != null && String(body.borderColor).trim() !== '') {
      row.border_color = String(body.borderColor).trim();
    }
  }
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
  // 【阶段二 P9】留痕：登录用户的所有创建都记一笔；代他人放置记为 place_for（A5②）
  if (_lm) {
    await db.insertAudit({
      itemId: result.item.id, actorId: _lm.mid,
      action: _placeForTarget != null ? 'place_for' : 'create',
      targetId: _placeForTarget,
      detail: _placeForTarget != null ? `代 ${_placeForName} 放置：${title}` : `创建：${title}`,
    });
  }
  console.log('[POST /api/items] 写入成功 id=', result.item.id, '耗时', Date.now() - t0, 'ms');
  return { ok: true, data: result.item, error: null };
}

// —— 【Day 22】解析要操作的那条记录的 id ——
// 三种来源都支持，因为不确定 CloudBase 的 HTTP 触发是否会把 /api/items/12 这种带路径参数的请求
// 路由到 items 函数：① URL 路径末尾的数字 ② ?id=12 ③ 请求体里的 id。哪个先命中用哪个。
function getItemId(event = {}) {
  const q = getQuery(event);
  const body = getBody(event);
  let raw = (q.id != null && String(q.id).trim() !== '') ? q.id : null;
  if (raw == null) raw = (body.id != null && String(body.id).trim() !== '') ? body.id : null;
  if (raw == null) {
    const p = event.path || event.httpPath || (event.requestContext && event.requestContext.path) || '';
    const m = /\/(\d+)\s*$/.exec(String(p));
    if (m) raw = m[1];
  }
  if (raw == null) {
    return { error: { code: 400, message: '缺少 id：请用 /api/items/12、?id=12 或在请求体里带 id' } };
  }
  const s = String(raw).trim();
  // 库里 id 是 SERIAL 整数；前端内存里的临时 id 形如 'u1718...'，必须挡在门外，
  // 否则会把字符串拼进 id=eq. 过滤条件，既查不到也污染日志。
  if (!/^\d+$/.test(s)) {
    return { error: { code: 400, message: `id 无效：${s}（应为正整数；本地未保存的临时事项没有云端 id）` } };
  }
  return { id: s };
}

// —— 【Day 22】PATCH /api/items/:id —— 编辑事项（部分更新）——
// 契约里的字段名（camelCase）→ 数据库列名（snake_case）；只列允许被改的字段，
// 不在表里的字段一律忽略（防止客户端塞进 id / createdAt 之类只读字段）。
const PATCHABLE = {
  title: 'title',
  table: 'table_kind',
  type: 'type',
  startTime: 'start_time',
  endTime: 'end_time',
  ownerKey: 'owner_key',
  attendees: 'attendees',
  venue: 'venue',
  note: 'note',
  status: 'status',
  meetingNo: 'meeting_no',
  meetingUrl: 'meeting_url',
};
const ITEM_STATUS = ['scheduled', 'done', 'cancelled'];

// —— 【阶段二 P11】腾讯会议入会链接域名白名单（方案①，防钓鱼）——
// 写入 meeting_url 时必须落在腾讯会议官方域名族；空串/未传允许（表示清空或不带链接）。
const MEETING_URL_WHITELIST = ['meeting.tencent.com', 'voovmeeting.com', 'tencentmeeting.cn'];
function validateMeetingUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return null; // 允许清空
  let host;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch (e) {
    return { code: 400, message: '入会链接格式不正确，请输入完整链接' };
  }
  const ok = MEETING_URL_WHITELIST.some((d) => host === d || host.endsWith('.' + d));
  if (!ok) return { code: 400, message: '入会链接必须是腾讯会议链接' };
  return null;
}

async function patchItem(event) {
  const t0 = Date.now();
  const body = getBody(event);
  console.log('[PATCH /api/items] 收到请求:', JSON.stringify({ ...body, attendees: body.attendees ? '***' : body.attendees }));

  // 1) id
  const parsed = getItemId(event);
  if (parsed.error) return { ok: false, data: null, error: parsed.error };
  const id = parsed.id;

  // 2) 挑出本次真正要改的字段（至少有一个，否则就是空请求）
  const keys = Object.keys(PATCHABLE).filter((k) => body[k] !== undefined && body[k] !== null);
  if (!keys.length) {
    return { ok: false, data: null, error: { code: 400, message: '没有要更新的字段：请至少传一个可改字段（title/table/type/startTime/endTime/ownerKey/attendees/venue/note/status/meetingNo/meetingUrl）' } };
  }

  // 3) 取值校验（只校验本次传了的字段；没传的保持原样）
  const patch = {};
  for (const k of keys) {
    let v = body[k];
    if (k === 'title') {
      v = String(v).trim();
      if (!v) return { ok: false, data: null, error: { code: 400, message: '标题不能为空' } };
      if (v.length > 100) return { ok: false, data: null, error: { code: 400, message: '标题超长：最多 100 字' } };
    }
    if (k === 'table') {
      v = String(v).trim();
      if (!TABLE_KINDS.includes(v)) return { ok: false, data: null, error: { code: 400, message: '所属表取值无效：应为 work 或 daily' } };
    }
    if (k === 'type') {
      v = String(v).trim();
      if (!ITEM_TYPES.includes(v)) return { ok: false, data: null, error: { code: 400, message: `事项类型取值无效：${v}` } };
    }
    if (k === 'ownerKey') {
      v = String(v).trim();
      if (!OWNER_KEYS.includes(v)) return { ok: false, data: null, error: { code: 400, message: `归属标签取值无效：${v}` } };
    }
    if (k === 'status') {
      v = String(v).trim();
      if (!ITEM_STATUS.includes(v)) return { ok: false, data: null, error: { code: 400, message: `状态取值无效：${v}（应为 scheduled/done/cancelled）` } };
    }
    if (k === 'startTime' || k === 'endTime') {
      const norm = normalizeTime(v);
      if (!norm) return { ok: false, data: null, error: { code: 400, message: `${k === 'startTime' ? '开始' : '结束'}时间格式应为 YYYY-MM-DD HH:mm` } };
      v = norm;
    }
    if (k === 'meetingUrl') {
      const s = String(v).trim();
      if (s === '') { v = null; } // 允许清空入会链接
      else {
        const ve = validateMeetingUrl(s);
        if (ve) return { ok: false, data: null, error: ve };
        v = s;
      }
    }
    if (k === 'meetingNo') {
      const s = String(v).trim();
      v = s === '' ? null : s; // 允许清空会议号
    }
    patch[PATCHABLE[k]] = v;
  }

  // 4) 取原记录：① 判断存在与否 ② 只改一头时间时，要用库里另一头来校验区间
  const old = await db.findItemById(id);
  if (!old) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}` } };

  // 【阶段二 P9】权限判定：patch（已登录才判定；未登录放行 = 兼容 v1.0）
  const _lm2 = resolveLogin(event);
  if (_lm2) {
    const dec = acl.decideWrite(_lm2, { op: 'patch', item: old });
    if (!dec.ok) return { ok: false, data: null, error: { code: dec.code, message: dec.message } };
  }

  const newStart = patch.start_time || old.startTime;   // old.startTime 形如 '2026-09-30 15:00'
  const newEnd = patch.end_time || old.endTime;
  // 【Day 24 修复 B2】比较前两边都截到分钟：
  // 库里原值走 fmtTime() 只到 'HH:mm'，本次新值走 normalizeTime() 带 ':ss'，
  // 直接字符串比会让 '15:13' < '15:13:00' 成立 → 把「开始=结束」的零时长误判成 422，
  // 而契约只要求「结束 ≥ 开始」，相等是允许的。统一口径后零时长放行、真正的倒挂照样拦。
  const minute = (t) => String(t).slice(0, 16);
  if (minute(newEnd) <= minute(newStart)) {
    return { ok: false, data: null, error: { code: 422, message: `结束时间须晚于开始时间（改后：开始 ${minute(newStart)} / 结束 ${minute(newEnd)}）` } };
  }
  // 开始时间变了 → ISO 周要跟着重算，否则这条事项会从它所属那一周里"消失"
  if (patch.start_time) patch.week = getISOWeek(patch.start_time) || old.week;
  // 【阶段二 P8】最后修改人：令牌存在时记 updated_by；缺省 NULL（兼容 v1.0）
  if (_lm2) patch.updated_by = _lm2.mid;

  // 【阶段二 P9】乐观并发：客户端带它加载时的 updatedAtRaw 作为版本号；
  // updateItem 会把它拼成 updated_at=eq.<旧值> 做「原子」条件更新 —— 被他人抢先改则 0 行命中 → 409。
  const baseUpdatedAt = body.baseUpdatedAt != null ? String(body.baseUpdatedAt) : null;

  // 5) 写入（调 DAL）
  const result = await db.updateItem(id, patch, baseUpdatedAt);
  if (result.concurrent) return { ok: false, data: null, error: { code: 409, message: '数据已被他人修改，请刷新后再试（冲突）' } };
  if (result.notFound) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}` } };
  if (result.error) return { ok: false, data: null, error: result.error };
  // 【阶段二 P9】留痕：登录用户的修改记一笔
  if (_lm2) {
    await db.insertAudit({ itemId: Number(id), actorId: _lm2.mid, action: 'update', detail: `修改字段：${Object.keys(patch).join(',')}` });
  }
  console.log('[PATCH /api/items] 更新成功 id=', id, '改动字段', Object.keys(patch).join(','), '耗时', Date.now() - t0, 'ms');
  return { ok: true, data: result.item, error: null };
}

// —— 【Day 22】DELETE /api/items/:id —— 删除事项（硬删除 + 强制确认）——
// 清单问「删除为什么比新增更容易出事？你在哪加了确认？」——答：四个地方，逐条对应一种事故：
//   事故1「误删/连点/脚本重放」→ 闸门A：必须显式带 confirm=true，否则 400 拒绝（新增不需要这种闸门）。
//   事故2「删错范围」→ 闸门B：id 必填且必须是单个正整数，库侧查询强制 id=eq.X，绝不出现无条件删除。
//   事故3「删了才发现删错」→ 闸门C：返回被删那一行的快照（title/时间/归属），至少知道删了什么。
//   事故4「删了不存在的、或重复删」→ 闸门D：一律 404（幂等语义），不报 500、不装作成功。
// UI 侧还有闸门E：二次确认弹窗（第 ④ 步接线时做）。
async function removeItem(event) {
  const t0 = Date.now();
  const q = getQuery(event);
  const body = getBody(event);
  console.log('[DELETE /api/items] 收到请求:', JSON.stringify({ id: q.id || body.id || '(from path)', confirm: q.confirm != null ? q.confirm : body.confirm }));

  // 闸门A：显式确认。缺省 / 传 false / 传别的字符串，一律拒绝。
  const confirmRaw = q.confirm != null ? q.confirm : body.confirm;
  const confirmed = confirmRaw === true || String(confirmRaw).trim().toLowerCase() === 'true';
  if (!confirmed) {
    return { ok: false, data: null, error: { code: 400, message: '删除需要显式确认：请带 confirm=true（?id=12&confirm=true 或请求体 {"id":12,"confirm":true}）' } };
  }

  // 闸门B：id 必填且为单个正整数（复用 PATCH 那套解析，本地临时 id 也会被挡）
  const parsed = getItemId(event);
  if (parsed.error) return { ok: false, data: null, error: parsed.error };
  const id = parsed.id;

  // 闸门D：先确认存在，不存在直接 404（顺带拿到快照，供闸门C 用）
  const old = await db.findItemById(id);
  if (!old) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}（可能已被删除）` } };

  // 【阶段二 P9】权限判定：delete（已登录才判定；未登录放行 = 兼容 v1.0）
  const _lmD = resolveLogin(event);
  if (_lmD) {
    const dec = acl.decideWrite(_lmD, { op: 'delete', item: old });
    if (!dec.ok) return { ok: false, data: null, error: { code: dec.code, message: dec.message } };
  }

  const result = await db.deleteItem(id);
  if (result.notFound) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}（可能已被删除）` } };
  if (result.error) return { ok: false, data: null, error: result.error };

  // 【阶段二 P9】留痕：登录用户的删除记一笔（硬删除下，审计表是唯一的删除线索）
  if (_lmD) {
    await db.insertAudit({ itemId: Number(id), actorId: _lmD.mid, action: 'delete', detail: `删除：${old.title}` });
  }
  console.log('[DELETE /api/items] 删除成功 id=', id, '原标题:', old.title, '耗时', Date.now() - t0, 'ms');
  // 闸门C：把被删掉的内容原样带回（硬删除下这是唯一的"后悔药线索"）
  return { ok: true, data: { id: Number(id), deleted: true, item: old }, error: null };
}

// —— 【阶段二 P6-②】成员身份：登录 ——
// 入参：{ name, passcode }（请求体或查询串都收；口令走请求体更安全，查询串会被网关日志记下）
// 出参：{ token, expiresInDays, member }
//
// 三条安全纪律（写死在代码里，别在后续迭代中丢掉）：
//   ① 不区分「没有这个成员」和「口令错了」——统一 401「口令无效，请联系管理员」，
//      否则别人拿一个名字去试，光看错误差异就能枚举出组织里有哪些人。
//   ② 成员不存在时也要算一次哈希（DUMMY_SALT），让"查不到"和"口令错"耗时接近，
//      堵掉时序侧信道（不看错误信息、改看响应时间也能猜）。
//   ③ 明文口令只出现在这一次调用的栈里：不写日志、不入库、不回给前端。
const DUMMY_SALT = '00000000000000000000000000000000'; // 32 字符 hex，仅用于"空跑一次"对齐耗时

// 只回传可以公开的字段。salt / identity_key 绝不出站 —— 它们一旦泄露，口令就离线可破。
function publicMember(row) {
  return {
    id: row.id,
    displayName: row.display_name || '',
    role: row.role || 'member',
    borderColor: row.border_color || null,
    meetingNo: row.meeting_no || null,
    meetingUrl: row.meeting_url || null,
    note: row.note || null,
  };
}

async function authLogin(event) {
  const body = getBody(event);
  const q = getQuery(event);
  const pick = (k) => (body[k] != null ? body[k] : q[k]);
  const name = String(pick('name') || '').trim();
  const passcode = String(pick('passcode') || '');

  // ★ 只记名字，绝不记口令（哪怕脱敏也不行，口令没有"部分可看"这回事）
  console.log('[POST /api/auth/login] 收到请求: name=', name || '(空)');

  if (!name) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员名称' } };
  if (!passcode) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：口令' } };

  // 1) 按名字定位成员（db.js 只认 auth_kind='passcode' 的口令成员，查不到返回 null）
  const member = await db.findMemberByName(name);

  // 2) 校验口令；查不到时也空跑一次 scrypt，对齐耗时（纪律②）
  const ok = member
    ? identity.verifyPasscode(passcode, member.salt, member.identity_key)
    : (identity.hashPasscode(passcode, DUMMY_SALT), false);
  if (!ok) {
    console.log('[POST /api/auth/login] 口令校验失败（不区分成员是否存在）');
    return { ok: false, data: null, error: { code: 401, message: identity.MSG.INVALID } };
  }

  // 3) 签发令牌（没配 WORKSHOP_AUTH_SECRET 时这里抛 503 —— 设计好的 fail-closed）
  const token = identity.signToken(member);
  console.log('[POST /api/auth/login] 登录成功 id=', member.id, ' name=', member.display_name);
  return {
    ok: true,
    data: { token, expiresInDays: identity.TOKEN_TTL_DAYS, member: publicMember(member) },
    error: null,
  };
}

// —— 【阶段二 P6-②】成员身份：校验令牌 ——
// 用途：刷新页面后前端还拿着令牌，用它换回"我是谁"，不必重新输口令。
// ★ 与只读接口的区别：这里取不到令牌就直接拒绝；而 GET /api/items 取不到令牌是放行（向后兼容）。
async function authVerify(event) {
  const token = identity.readTokenFrom(event);
  if (!token) {
    return { ok: false, data: null, error: { code: 401, message: '未提供身份令牌，请先登录' } };
  }
  const payload = identity.verifyToken(token); // 签名错 / 过期都在这里抛 401
  return {
    ok: true,
    data: {
      member: { id: payload.mid, displayName: payload.name, role: payload.role },
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
    error: null,
  };
}

// 真正的业务分发（原 exports.main 的本体）。外面再包一层，只为记一行请求日志。
async function handle(event = {}) {
  const method = getMethod(event);

  // 【Day 20】OPTIONS 预检：POST JSON 会先发预检请求，必须在业务处理前接住
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(event, {
        // 【Day 22】新增 PATCH / DELETE：浏览器发非简单请求前会先看预检结果里允不允许这两个方法
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        // 【阶段二 P6-②】补 X-Member-Token：前端带自定义头属"非简单请求"，浏览器会先发预检。
        // P6-① 探针②实测：Origin 在白名单时 CloudBase 网关会自己接管预检并回显请求头，
        // 我们这段代码其实没被调用；但网关行为可能变，留在这里做兜底，成本为零。
        'Access-Control-Allow-Headers': 'Content-Type, X-Member-Token',
        'Access-Control-Max-Age': '86400',
      }),
      body: '',
    };
  }

  // 【阶段二 P6-②】身份接口分发
  // 怎么找到这两个接口，留了两条路，因为「网关把哪个路径路由给本函数」不由代码决定：
  //   ① 路径：/api/auth/login 、/api/auth/verify（正常形态，前提是 HTTP 访问服务里加了对应路由）
  //   ② _action：POST /api/items?_action=login（★兜底：/api/items 是确定已路由的入口，
  //      万一 ① 那条路由没配上，这条照样能进门，不必为改一次路由再部署一轮）
  // 两条路进的是同一段业务代码，行为完全一致。
  const q0 = getQuery(event);
  const b0 = getBody(event);
  const action = String(q0._action || b0._action || '').trim().toLowerCase();
  const p0 = reqPath(event);
  const wantsLogin = action === 'login' || /\/auth\/login(\/|\?|$)/.test(p0);
  const wantsVerify = action === 'verify' || /\/auth\/verify(\/|\?|$)/.test(p0);

  if (wantsLogin && method === 'POST') {
    try { return http(event, await authLogin(event)); }
    catch (err) {
      logError('POST /api/auth/login', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  // verify 是只读的、且请求体里可能带令牌，所以 GET / POST 都收
  if (wantsVerify && (method === 'GET' || method === 'POST')) {
    try { return http(event, await authVerify(event)); }
    catch (err) {
      logError('GET /api/auth/verify', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 P9】成员列表（供前端"归属给谁"下拉；只读，不含凭据）
  if (action === 'members' && method === 'GET') {
    try {
      const list = await db.listMembers();
      return http(event, { ok: true, data: list, error: null });
    } catch (err) {
      logError('GET /api/members', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【Day 22】编辑事项：PATCH（部分更新）为主，PUT 走同一套逻辑（契约登记为 PATCH，PUT 兼容旧写法）
  if (method === 'PATCH' || method === 'PUT') {
    try { return http(event, await patchItem(event)); }
    catch (err) {
      // 【Day 23】改前：把 err.message 原样丢给前端（英文裸报错）；改后：原文进日志，中文出站
      logError('PATCH /api/items', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【Day 22】删除事项（硬删除 + 强制 confirm）
  if (method === 'DELETE') {
    try { return http(event, await removeItem(event)); }
    catch (err) {
      logError('DELETE /api/items', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  if (method === 'POST') {
    try { return http(event, await createItem(event)); }
    catch (err) {
      logError('POST /api/items', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  // 默认 GET：列表读取（调 DAL）
  const q = getQuery(event);
  try {
    const data = await db.queryItems(q);
    return http(event, { ok: true, data, error: null });
  } catch (err) {
    logError('GET /api/items', err);
    const e = toUserError(err);
    return http(event, { ok: false, data: null, error: e }, e.code);
  }
}

// —— 【Day 23 · 余力加练】请求日志 ——
// 每条请求打一行：时间 / 方法 / 路径 / 结果状态码 / 耗时。
// 为什么要有：前面把英文报错收进日志了，日志里得能看到"谁在什么时间、请求了什么、结果如何"，
// 否则事后排查只剩一堆孤立的错误信息，串不成线。
// 时间格式按项目约定 YYYY-MM-DD HH:mm:ss、东八区（AGENTS.md §十.2），不写 next Mon 之类歧义写法。
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function reqPath(event = {}) {
  return event.path || event.httpPath || (event.requestContext && event.requestContext.path) || '/';
}

exports.main = async (event = {}) => {
  const t0 = Date.now();
  const method = getMethod(event);
  const p = reqPath(event);
  const res = await handle(event);
  console.log(`[请求日志] ${nowStamp()} ${method} ${p} → ${res.statusCode} (${Date.now() - t0}ms)`);
  return res;
};
