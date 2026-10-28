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

// —— 【阶段二 Step5】随机口令生成用（管理员重置/添加成员；零依赖铁律，用 Node 内置 crypto）——
const crypto = require('crypto');

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
// 【2026-10-28】类型白名单从「硬编码数组」改成「读 item_types_phase2 表」，
// 支持 core 管理员在线增删类型。这里的常量退化为**兜底**：读不到表时仍按这 7 个走，
// 站点不会因为"SQL 还没跑"就全站 500（部署顺序错一步不该让整个站点挂掉）。
// ⚠️ 刻意收紧：原来白名单里还有 'trip' / 'class'（前端历史词），现在去掉了。
//    写入只接受库词 —— 前端两处（表单提交、导入）都已经过 localTypeToApi 转换，
//    留着这两个词只会让库里混进两种词表，将来做统计/迁移时更麻烦。
//    读取侧不受影响：老数据若真有 trip/class，apiTypeToLocal 原样保留，照样能显示。
const ITEM_TYPES_FALLBACK = ['meeting', 'course', 'travel', 'sport', 'life', 'pending', 'other'];
const OWNER_KEYS = ['self', 'depta', 'deptb', 'deptc', 'deptd', 'me'];
// 【阶段二 管理员 UI】可指派的角色白名单（与 db/schema_phase2.sql 的 chk_members_role 一致）
// 【2026-10-28】新增 core（全局核心管理员）。★ 刻意**不放进 setRole 的白名单**：
//   任命 core 只能走控制台 SQL —— 否则任一团队管理员都能把自己升成跨团队超管，等于没有边界。
const MEMBER_ROLES = ['member', 'readonly', 'admin'];
// 【阶段二 Step5】添加成员的 UI 只给这两档；admin 任命刻意不走 UI（初期只此一条通道＝控制台 SQL，用户 10-22 拍板）
const ADD_MEMBER_ROLES = ['member', 'readonly'];

/* ---- 类型清单：带 30s 缓存 + 失败回退 ----
   为什么缓存：createItem / patchItem 每次都要校验 type，一次日程写入不该多打一次类型表查询。
   为什么失败回退：见上面 ITEM_TYPES_FALLBACK 的注释。回退时打 console.error，排查时能看到。 */
let _typeCodesCache = null;
let _typeCodesAt = 0;
const TYPE_CACHE_MS = 30000;

async function loadItemTypeCodes(force) {
  if (!force && _typeCodesCache && Date.now() - _typeCodesAt < TYPE_CACHE_MS) return _typeCodesCache;
  try {
    const rows = await db.listItemTypes();
    if (!Array.isArray(rows) || !rows.length) throw new Error('类型表为空');
    _typeCodesCache = rows.map(r => r.code);
    _typeCodesAt = Date.now();
    return _typeCodesCache;
  } catch (e) {
    // 表不存在 / 查询失败 → 回退内置白名单（宁可少支持自定义类型，也不能让写入全挂）
    console.error('[类型清单降级] 读取 item_types_phase2 失败，回退内置类型：', e && e.message);
    return ITEM_TYPES_FALLBACK;
  }
}
function invalidateTypeCache() { _typeCodesCache = null; _typeCodesAt = 0; }

// 【2026-10-27 多团队隔离】默认团队码：现有数据全部归入它，匿名只读也落在它上面。
// 与 db/schema_phase2.sql 里 INSERT 的 join_code 必须逐字一致（含大小写）。
const DEFAULT_TEAM_CODE = 'WS-DEFAULT';

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
    return identity.verifyToken(t); // { mid, name, role, tid, exp }
  } catch (_) {
    return null;
  }
}

/* ============ 【2026-10-27 多团队隔离】身份 → 团队 的解析 ============
   两条硬规则：
     1) 团队归属以【库里的 team_id】为准，不完全信任令牌里的 tid。
        （令牌只是加速提示；角色/团队都是服务端状态，改了就应立刻生效）
     2) 解析不出团队 → 视为未登录（fail-closed）。绝不允许"拿不到团队就查全库"。 */

// 默认团队 id 缓存（匿名只读用）。查不到时返回 null，由调用方拒绝。
let _defaultTeamId = null;
async function resolveDefaultTeamId() {
  if (_defaultTeamId) return _defaultTeamId;
  const t = await db.findTeamByJoinCode(DEFAULT_TEAM_CODE);
  _defaultTeamId = t ? t.id : null;
  return _defaultTeamId;
}

// 解出当前操作者（含团队）。无令牌/坏令牌/查不到团队 → null。
async function resolveActor(event) {
  const t = resolveLogin(event);
  if (!t) return null;
  let teamId = t.tid;
  if (!teamId) {
    // 老令牌（2026-10-27 之前签发，payload 里没有 tid）→ 按 mid 回查库补齐。
    // 这样上线时不用逼全员重新登录。
    try {
      const m = await db.findMemberById(t.mid);
      teamId = m && m.teamId ? m.teamId : null;
    } catch (_) { teamId = null; }
  }
  if (!teamId) return null;   // 查不到团队 = 身份不完整 → 当未登录处理
  return { mid: t.mid, name: t.name, role: t.role, teamId };
}

// 读操作（列表/成员/心跳）：登录了就用自己的团队，未登录用默认团队。
async function resolveReadScope(event) {
  const actor = await resolveActor(event);
  if (actor) return { actor, teamId: actor.teamId, anonymous: false };
  const tid = await resolveDefaultTeamId();
  return { actor: null, teamId: tid, anonymous: true };
}

// 写操作统一闸门：必须登录 + 必须有团队（2026-10-27 起匿名写入关闭，即修掉 seam A）
async function requireWriter(event) {
  const actor = await resolveActor(event);
  if (!actor) {
    return { error: { code: 401, message: '请先登录后再修改日程' } };
  }
  return { actor };
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
  if (!(await loadItemTypeCodes()).includes(type)) {
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
  // 【2026-10-27 多团队】写入必须登录：匿名写入已关闭（原 seam A 遗留风险），
  //   团队由服务端解出，不接受前端传 teamId（否则等于让客户端自己选数据边界）。
  const _w = await requireWriter(event);
  if (_w.error) return { ok: false, data: null, error: _w.error };
  const _lm = _w.actor;
  const _teamId = _lm.teamId;
  row.team_id = _teamId;
  let _placeForTarget = null;   // 给他人放时的目标成员 id（用于写留痕）
  let _placeForName = '';
  {
    const targetOwnerId = body.ownerMemberId != null && String(body.ownerMemberId).trim() !== ''
      ? Number(body.ownerMemberId) : null;
    const dec = acl.decideWrite(_lm, { op: 'create', targetOwnerId });
    if (!dec.ok) {
      return { ok: false, data: null, error: { code: dec.code, message: dec.message } };
    }
    row.owner_member_id = dec.ownerMemberId;
    row.created_by = _lm.mid;
    if (dec.placeFor) {
      // ② 给他人放：校验目标成员真实存在【且同团队】，并取库里的外框色（防前端冒充颜色）
      const target = await db.findMemberById(dec.ownerMemberId);
      if (!target || target.teamId !== _teamId) {
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

  // 3) 防重复提交：内容去重（调 DAL）—— 只在【本团队】内判重，别人团队有同名事项互不影响
  const isDup = await db.findDuplicate({ title, table, type, start, end, ownerKey, teamId: _teamId });
  if (isDup) {
    console.log('[POST /api/items] 命中重复，拒绝写入');
    return { ok: false, data: null, error: { code: 409, message: '请勿重复提交：该事项已存在' } };
  }

  // 4) 写入（调 DAL）
  const result = await db.insertItem(row);
  if (result.error) return { ok: false, data: null, error: result.error };
  // 【阶段二 P9】留痕：登录用户的所有创建都记一笔；代他人放置记为 place_for（A5②）
  await db.insertAudit({
    itemId: result.item.id, actorId: _lm.mid,
    action: _placeForTarget != null ? 'place_for' : 'create',
    targetId: _placeForTarget,
    detail: _placeForTarget != null ? `代 ${_placeForName} 放置：${title}` : `创建：${title}`,
    teamId: _teamId,
  });
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
      if (!(await loadItemTypeCodes()).includes(v)) return { ok: false, data: null, error: { code: 400, message: `事项类型取值无效：${v}` } };
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

  // 【2026-10-27 多团队】先解身份（团队是读取前提）：匿名写入关闭，必须先登录。
  // 顺序变了：原来先查 old 再判权限，现在先判身份——因为「查 old」本身就要团队条件。
  const _w2 = await requireWriter(event);
  if (_w2.error) return { ok: false, data: null, error: _w2.error };
  const _lm2 = _w2.actor;
  const _teamId2 = _lm2.teamId;

  // 4) 取原记录：① 判断存在与否 ② 只改一头时间时，要用库里另一头来校验区间
  //    ★ 带 team_id：别的团队的事项一律查不到 → 404（不泄露"存在但无权"）
  const old = await db.findItemById(id, _teamId2);
  if (!old) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}` } };

  // 【阶段二 P9】权限判定
  {
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
  patch.updated_by = _lm2.mid;

  // 【阶段二 P9】乐观并发：客户端带它加载时的 updatedAtRaw 作为版本号；
  // updateItem 会把它拼成 updated_at=eq.<旧值> 做「原子」条件更新 —— 被他人抢先改则 0 行命中 → 409。
  const baseUpdatedAt = body.baseUpdatedAt != null ? String(body.baseUpdatedAt) : null;

  // 5) 写入（调 DAL）—— ★ 带 teamId，跨团队 id 命中 0 行
  const result = await db.updateItem(id, patch, baseUpdatedAt, _teamId2);
  if (result.concurrent) return { ok: false, data: null, error: { code: 409, message: '数据已被他人修改，请刷新后再试（冲突）' } };
  if (result.notFound) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}` } };
  if (result.error) return { ok: false, data: null, error: result.error };
  // 【阶段二 P9】留痕：登录用户的修改记一笔
  await db.insertAudit({ itemId: Number(id), actorId: _lm2.mid, action: 'update', detail: `修改字段：${Object.keys(patch).join(',')}`, teamId: _teamId2 });
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

  // 【2026-10-27 多团队】先解身份（匿名写入关闭），团队是查/删的前提
  const _wD = await requireWriter(event);
  if (_wD.error) return { ok: false, data: null, error: _wD.error };
  const _lmD = _wD.actor;
  const _teamIdD = _lmD.teamId;

  // 闸门D：先确认存在，不存在直接 404（顺带拿到快照，供闸门C 用）
  //    ★ 带 team_id：别的团队的事项查不到 → 404
  const old = await db.findItemById(id, _teamIdD);
  if (!old) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}（可能已被删除）` } };

  // 【阶段二 P9】权限判定
  {
    const dec = acl.decideWrite(_lmD, { op: 'delete', item: old });
    if (!dec.ok) return { ok: false, data: null, error: { code: dec.code, message: dec.message } };
  }

  const result = await db.deleteItem(id, _teamIdD);
  if (result.notFound) return { ok: false, data: null, error: { code: 404, message: `找不到该事项：id=${id}（可能已被删除）` } };
  if (result.error) return { ok: false, data: null, error: result.error };

  // 【阶段二 P9】留痕：登录用户的删除记一笔（硬删除下，审计表是唯一的删除线索）
  await db.insertAudit({ itemId: Number(id), actorId: _lmD.mid, action: 'delete', detail: `删除：${old.title}`, teamId: _teamIdD });
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
    // 【2026-10-27 多团队】前端要知道自己在哪个团队（顶栏显示团队名）
    teamId: row.team_id != null ? Number(row.team_id) : null,
  };
}

// 团队信息的对外形态：join_code 只给本团队管理员看（邀请码等于半个加入凭据，不公开）
async function publicTeam(teamId, role) {
  const t = await db.findTeamById(teamId);
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    joinCode: (role === 'admin' || role === 'core') ? t.joinCode : null,
  };
}

async function authLogin(event) {
  const body = getBody(event);
  const q = getQuery(event);
  const pick = (k) => (body[k] != null ? body[k] : q[k]);
  const name = String(pick('name') || '').trim();
  const passcode = String(pick('passcode') || '');
  const teamCode = String(pick('teamCode') || '').trim();

  // ★ 只记名字，绝不记口令（哪怕脱敏也不行，口令没有"部分可看"这回事）
  console.log('[POST /api/auth/login] 收到请求: name=', name || '(空)', ' teamCode=', teamCode ? '已填' : '(空)');

  if (!name) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员名称' } };
  if (!passcode) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：口令' } };

  // 1) 定位成员。
  // 【2026-10-27 多团队】团队码可选：
  //   填了 → 只在该团队找（推荐，最准）
  //   没填 → 全局找。恰好 1 个就登录（现有用户无感）；多个同名 → 409 让他补团队码。
  let teamScope = null;
  if (teamCode) {
    const team = await db.findTeamByJoinCode(teamCode);
    if (!team) {
      // 团队码不存在也说"无效"，不区分"没这个团队"和"填错"，避免团队枚举
      return { ok: false, data: null, error: { code: 401, message: '团队码或口令无效' } };
    }
    teamScope = team.id;
  }
  const rows = await db.findMemberByName(name, teamScope);
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);

  if (list.length > 1) {
    // 跨团队重名：不猜，让用户补团队码。这里必须给出可操作的提示，否则用户会以为是口令问题。
    console.log('[POST /api/auth/login] 跨团队重名 count=', list.length, ' name=', name);
    return { ok: false, data: null, error: { code: 409, message: '该名字在多个团队中存在，请填写团队码后重试' } };
  }
  const member = list.length === 1 ? list[0] : null;

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
  const team = await publicTeam(Number(member.team_id), member.role).catch(() => null);
  console.log('[POST /api/auth/login] 登录成功 id=', member.id, ' team=', member.team_id);
  return {
    ok: true,
    data: { token, expiresInDays: identity.TOKEN_TTL_DAYS, member: publicMember(member), team },
    error: null,
  };
}

/* —— 【2026-10-27 多团队】自助注册（邀请码加入）——
   入参：{ joinCode, name, passcode }
   设计取舍：
     · 邀请码就是团队码，是唯一的准入凭据 —— 所以必须够随机、可更换（未来 v1.2）；
     · 团队里【第一个】注册的人自动成为 admin（否则新团队没人能管成员）；
     · 名字在团队内唯一（跨团队可同名），撞名返回 409；
     · 口令最短 6 位，与 changePasscode 同口径；
     · 注册成功直接发令牌，省一次登录往返。 */
async function authRegister(event) {
  const body = getBody(event);
  const joinCode = String(body.joinCode || '').trim();
  const name = String(body.name || '').trim();
  const passcode = String(body.passcode || '');

  if (!joinCode) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：团队码' } };
  if (!name) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员名称' } };
  if (name.length > 20) return { ok: false, data: null, error: { code: 400, message: '成员名称最多 20 个字' } };
  if (passcode.length < 6) return { ok: false, data: null, error: { code: 400, message: '口令至少 6 位' } };

  const team = await db.findTeamByJoinCode(joinCode);
  if (!team) return { ok: false, data: null, error: { code: 401, message: '团队码无效，请向团队管理员确认' } };

  // 团队内重名检查
  const exist = await db.findMemberByName(name, team.id);
  if (exist && exist.length) {
    return { ok: false, data: null, error: { code: 409, message: '该团队已存在同名成员，换一个名字' } };
  }

  // 第一个人自动是管理员：新团队必须有人能管人，否则永远只能靠控制台 SQL
  const memberCount = await db.countTeamMembers(team.id);
  const role = memberCount === 0 ? 'admin' : 'member';

  const salt = crypto.randomBytes(16).toString('hex');
  const identityKey = identity.hashPasscode(passcode, salt);
  const ins = await db.insertMemberWithAuth({ displayName: name, role, identityKey, salt, teamId: team.id });
  if (ins.error) {
    // 并发注册同名：唯一索引兜底，翻成人话
    if (ins.error.code === 409) return { ok: false, data: null, error: { code: 409, message: '该团队已存在同名成员，换一个名字' } };
    return { ok: false, data: null, error: ins.error };
  }

  const created = { id: ins.member.id, display_name: name, role, border_color: null, team_id: team.id };
  const token = identity.signToken(created);
  await db.insertAudit({
    actorId: created.id, action: 'add_member', detail: `自助加入团队「${team.name}」，角色 ${role}`,
    teamId: team.id,
  }).catch(() => {});
  console.log('[POST /api/auth/register] 注册成功 mid=', created.id, 'team=', team.id, 'role=', role);
  return {
    ok: true,
    data: {
      token,
      expiresInDays: identity.TOKEN_TTL_DAYS,
      member: publicMember(created),
      team: { id: team.id, name: team.name, joinCode: role === 'admin' ? team.joinCode : null },
    },
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
  // 【2026-10-27 多团队】返回团队信息。老令牌没有 tid → 回查库补齐（前端不必重新登录）
  let teamId = payload.tid;
  if (!teamId) {
    try {
      const m = await db.findMemberById(payload.mid);
      teamId = m && m.teamId ? m.teamId : null;
    } catch (_) { teamId = null; }
  }
  if (!teamId) {
    return { ok: false, data: null, error: { code: 401, message: '身份信息不完整（缺少团队），请重新登录' } };
  }
  const team = await publicTeam(teamId, payload.role).catch(() => null);
  return {
    ok: true,
    data: {
      member: { id: payload.mid, displayName: payload.name, role: payload.role, teamId },
      team,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
    error: null,
  };
}

// —— 【阶段二 在线人数】心跳：有令牌则刷新自己的 last_seen_at，并返回当前在线人数（2026-10-18）——
// 设计口径（用户 2026-10-18 拍板）：
//   ① 匿名（无令牌/坏令牌）不记心跳 → 只统计登录成员；
//   ② 匿名仍可看到在线人数（公开信息，不需要登录）；
//   ③ 心跳刷新失败不阻断：记日志、照常返回在线人数，前端下一轮再试；
//   ④ 前端 30s 一次，2 分钟窗口判在线 → 关页面/断网最多滞留 2 分钟。
async function heartbeat(event) {
  const scope = await resolveReadScope(event);   // 登录用自己的团队；匿名落默认团队
  const actor = scope.actor;
  if (actor) {
    try {
      await db.touchMember(actor.mid);
    } catch (e) {
      console.error('[heartbeat] last_seen_at 刷新失败（不阻断）：', e && e.message);
    }
  }
  // 【2026-10-27】在线人数按团队统计：别人团队的人不该算进你的数
  const online = scope.teamId ? await db.countOnline(2, scope.teamId) : 0;
  return { ok: true, data: { online }, error: null };
}

// —— 【阶段二 管理员 UI】管理员改他人角色（seam C 落地，2026-10-18）——
// ★ 铁律（PERMISSIONS_phase2 §四）：前端隐藏/禁用按钮只是体验层，这里是最终审防线。
//   ① 无令牌/坏令牌 → 401（不拿"没权限"冒充登录问题）；
//   ② 令牌有效但 role≠admin → 403；
//   ③ 不允许改自己（防误操作把自己降级，丢了管理入口）；
//   ④ role 必须落在白名单；目标成员必须存在；
//   ⑤ 改完写 audit_phase2（action=set_role，detail 含 from → to；留痕失败不阻断）。
// ⚠️ 已知限制：令牌 payload 含 role（7 天有效）→ 被改者需【重新登录】新角色才生效，UI 层会提示。
async function setRole(event) {
  const body = getBody(event);
  const actor = await resolveActor(event);   // 【多团队】带团队，管理员只管本团队
  if (!actor) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再修改成员角色' } };
  }
  if (String(actor.role || '') !== 'admin') {
    return { ok: false, data: null, error: { code: 403, message: '只有管理员可以修改成员角色' } };
  }
  const memberId = Number(body.memberId);
  const role = String(body.role || '').trim();
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员 id' } };
  }
  if (!MEMBER_ROLES.includes(role)) {
    return { ok: false, data: null, error: { code: 400, message: `角色取值无效：${role}（应为 ${MEMBER_ROLES.join(' / ')}）` } };
  }
  if (memberId === Number(actor.mid)) {
    return { ok: false, data: null, error: { code: 403, message: '不能修改自己的角色（防止误操作丢失管理权限）' } };
  }
  const target = await db.findMemberById(memberId);
  // 【多团队】跨团队成员一律 404：不告诉管理员"这个 id 存在但不在你团队"
  if (!target || target.teamId !== actor.teamId) {
    return { ok: false, data: null, error: { code: 404, message: '目标成员不存在' } };
  }
  // 【2026-10-28】core（核心管理员）只能由控制台 SQL 调整：
  //   若团队管理员能把 core 降成 member，等于任何人都能摘掉跨团队超管 —— 那 core 就没有
  //   存在的意义了。同理，core 的任命也不开放给 API（见 MEMBER_ROLES 不含 core）。
  if (String(target.role || '') === 'core') {
    return { ok: false, data: null, error: { code: 403, message: '核心管理员的角色只能在控制台调整，站点内不可修改' } };
  }
  const result = await db.updateMemberRole(memberId, role, actor.teamId);
  if (result.error) return { ok: false, data: null, error: result.error };
  if (result.notFound) {
    return { ok: false, data: null, error: { code: 404, message: '目标成员不存在' } };
  }
  await db.insertAudit({
    actorId: actor.mid,
    action: 'set_role',
    targetId: result.member.id,
    detail: `角色变更：${target.role || 'member'} → ${result.member.role}`,
    teamId: actor.teamId,
  });
  console.log('[POST /api/setRole] 管理员', actor.mid, '将成员', memberId, '角色改为', role);
  return { ok: true, data: result.member, error: null };
}

// —— 【阶段二 Step5】随机口令生成（管理员重置/添加成员用，2026-10-23）——
// 字符集去掉 0/O/1/l/I：截图或口头传达时看错一位，成员就登录不上，排查半天。
const PASSCODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genPasscode(len = 8) {
  const n = Math.max(4, Math.min(32, Number(len) || 8));
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += PASSCODE_CHARS[bytes[i] % PASSCODE_CHARS.length];
  return out;
}

// 新口令强度规则（自助改口令用；genPasscode 生成的 8 位必过，无需单独校验）。
// 与 PRD/前端提示口径一致：至少 6 位、最长 64 位。
function passcodeProblem(p) {
  if (typeof p !== 'string' || p.length < 6) return '新口令至少 6 位';
  if (p.length > 64) return '新口令最长 64 位';
  return null;
}

// —— 【阶段二 Step5】管理员重置成员口令（2026-10-23，用户 10-22 拍板）——
// ★ 铁律同 setRole：前端按钮只是体验层，这里是最终审防线。
//   ① 无令牌/坏令牌 → 401；令牌有效但 role≠admin → 403（身份墙先于一切参数校验）；
//   ② 目标成员必须存在；允许重置自己（管理员自己的口令忘了也该能自救）；
//   ③ 新口令随机生成（8 位，去易混字符）+ 换新盐算哈希；
//   ④ 明文口令【只在这一个响应里回给管理员】，前端一次性展示；
//      审计只记动作，绝不记口令明文（audit 表不留口令，谁查日志都摸不到）。
// ⚠️ 已知限制：被重置者的旧令牌 7 天内仍有效（口令与令牌独立签名）→ 前端明示用新口令重新登录。
async function resetPasscode(event) {
  const body = getBody(event);
  const actor = await resolveActor(event);   // 【多团队】带团队
  if (!actor) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再重置成员口令' } };
  }
  if (String(actor.role || '') !== 'admin') {
    return { ok: false, data: null, error: { code: 403, message: '只有管理员可以重置成员口令' } };
  }
  const memberId = Number(body.memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员 id' } };
  }
  const target = await db.findMemberById(memberId);
  // 【多团队】跨团队成员一律 404
  if (!target || target.teamId !== actor.teamId) {
    return { ok: false, data: null, error: { code: 404, message: '目标成员不存在' } };
  }
  const plain = genPasscode(8);
  const salt = crypto.randomBytes(16).toString('hex');   // 16 字节 → 32 字符 hex（与库列宽一致）
  const identityKey = identity.hashPasscode(plain, salt);
  const result = await db.updateMemberPasscode(memberId, identityKey, salt);
  if (result.error) return { ok: false, data: null, error: result.error };
  if (result.notFound) {
    return { ok: false, data: null, error: { code: 404, message: '目标成员不存在' } };
  }
  await db.insertAudit({
    actorId: actor.mid,
    action: 'reset_passcode',
    targetId: memberId,
    detail: '管理员重置成员口令（新口令已一次性展示给管理员，此处不留存）',
    teamId: actor.teamId,
  });
  console.log('[POST /api/resetPasscode] 管理员', actor.mid, '重置成员', memberId, '的口令');
  return { ok: true, data: { member: result.member, passcode: plain }, error: null };
}

// —— 【阶段二 Step5】成员自助修改口令（2026-10-23，用户 10-22 追加）——
// 与 resetPasscode 的分工：这个只改自己（令牌里的 mid 即目标，不存在改他人），
//   **新值管理员不可见**——自助改的口令只有本人知道，这是刻意的边界设计。
//   ① 必须登录（401）；
//   ② 验旧口令（不区分"旧口令错"与别的失败，防试探；错误次数不限——成员量个位数，暂不加限流）；
//   ③ 新口令 ≥6 位且 ≠ 旧口令；
//   ④ 审计记 change_passcode（只记动作，不记任何口令）。
async function changePasscode(event) {
  const body = getBody(event);
  const actor = await resolveActor(event);   // 【多团队】带团队
  if (!actor) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再修改口令' } };
  }
  const oldPass = String(body.oldPasscode || '');
  const newPass = String(body.newPasscode || '');
  if (!oldPass || !newPass) {
    return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：旧口令 / 新口令' } };
  }
  const problem = passcodeProblem(newPass);
  if (problem) {
    return { ok: false, data: null, error: { code: 400, message: problem } };
  }
  if (oldPass === newPass) {
    return { ok: false, data: null, error: { code: 400, message: '新口令不能与旧口令相同' } };
  }
  // 取自己的凭据（salt/identity_key 只在内层流转，绝不出站到响应）
  const me = await db.findMemberCredentialsById(actor.mid);
  if (!me) {
    return { ok: false, data: null, error: { code: 404, message: '成员不存在，请重新登录' } };
  }
  if (!identity.verifyPasscode(oldPass, me.salt, me.identity_key)) {
    console.log('[POST /api/changePasscode] 旧口令校验失败 id=', actor.mid);
    return { ok: false, data: null, error: { code: 401, message: '旧口令不正确' } };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const identityKey = identity.hashPasscode(newPass, salt);
  const result = await db.updateMemberPasscode(actor.mid, identityKey, salt);
  if (result.error) return { ok: false, data: null, error: result.error };
  if (result.notFound) {
    return { ok: false, data: null, error: { code: 404, message: '成员不存在，请重新登录' } };
  }
  await db.insertAudit({
    actorId: actor.mid,
    action: 'change_passcode',
    targetId: actor.mid,
    detail: '本人修改自己的口令',
    teamId: actor.teamId,
  });
  console.log('[POST /api/changePasscode] 成员', actor.mid, '修改了自己的口令');
  return { ok: true, data: { changed: true }, error: null };
}

// —— 【阶段二 Step5】管理员添加成员（2026-10-23，用户 10-22 拍板）——
//   ① 身份墙同 resetPasscode（401/403 先于参数校验）；
//   ② 角色只给 member/readonly 两档（ADD_MEMBER_ROLES）；admin 任命不走 UI（见常量注释）；
//   ③ 重名 409（display_name 无唯一约束，查重在应用层做——先查后插，并发双开的窗口极小，
//      且 Identity 索引在 identity_key 上，重名不会撞库，最坏是插入成功但名字重复，可人工合并）；
//   ④ 初始口令随机生成，明文只回这一次；审计不记口令。
async function addMember(event) {
  const body = getBody(event);
  const actor = await resolveActor(event);   // 【多团队】带团队，只能往自己团队加人
  if (!actor) {
    return { ok: false, data: null, error: { code: 401, message: '请先登录后再添加成员' } };
  }
  if (String(actor.role || '') !== 'admin') {
    return { ok: false, data: null, error: { code: 403, message: '只有管理员可以添加成员' } };
  }
  const name = String(body.displayName || '').trim();
  if (!name) {
    return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：成员名称' } };
  }
  if (name.length > 60) {
    return { ok: false, data: null, error: { code: 400, message: '成员名称最长 60 字符' } };
  }
  const role = String(body.role || 'member').trim();
  if (!ADD_MEMBER_ROLES.includes(role)) {
    return { ok: false, data: null, error: { code: 400, message: `角色取值无效：${role}（应为 ${ADD_MEMBER_ROLES.join(' / ')}）` } };
  }
  // 【多团队】重名只在【本团队】内判：不同团队可以有同名成员
  const dup = await db.findMemberByName(name, actor.teamId);
  if (dup && dup.length) {
    return { ok: false, data: null, error: { code: 409, message: '该成员名称已存在，请换一个名称' } };
  }
  const plain = genPasscode(8);
  const salt = crypto.randomBytes(16).toString('hex');
  const identityKey = identity.hashPasscode(plain, salt);
  const result = await db.insertMemberWithAuth({ displayName: name, role, identityKey, salt, teamId: actor.teamId });
  if (result.error) return { ok: false, data: null, error: result.error };
  await db.insertAudit({
    actorId: actor.mid,
    action: 'add_member',
    targetId: result.member.id,
    detail: `管理员添加成员：${name}（${role}）`,
    teamId: actor.teamId,
  });
  console.log('[POST /api/addMember] 管理员', actor.mid, '添加成员', name, '角色', role);
  return { ok: true, data: { member: result.member, passcode: plain }, error: null };
}

// ============ 【2026-10-27 多团队】团队信息 / 建团队 ============

// 团队码生成：WS-XXXXXX（去掉易混字符，口头传达不易错）
function genTeamCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += PASSCODE_CHARS[bytes[i] % PASSCODE_CHARS.length];
  return 'WS-' + s;
}

/* ============ 【2026-10-28】日程类型与颜色（全局唯一一份，core 核心管理员维护） ============
   权限设计（用户 2026-10-28 拍板 ②B + ③A）：
     - 读：**任何人**（含匿名）。前端启动就要用类型色渲染图例/色板，未登录看到的也应一致。
     - 写（增/删/改色/改名）：仅 role === 'core'。
   为什么不给团队 admin：
     类型色是跨团队公共语言（"蓝色=会议"）。任一团队管理员都能改，等于每个团队都能
     悄悄改掉别人团队看到的颜色语义。要改就得由一个人统一改 —— 这就是 core 存在的理由。
   ★ core 不获得跨团队日程读写权：那会打破多团队隔离（四红线：看不到/改不了/删不了/管不了）。
     它拿到的是"体系级"权限，不是"数据级"权限。 */

// 白字对比度（WCAG 相对亮度公式）。与前端 timeline.js 的 isSafeBg 用同一套算法 —— 双端一致，
// 否则会出现"前端说能存、后端说太浅"的扯皮。
function relLuminance(hex) {
  const h = String(hex).replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function whiteContrast(hex) { return 1.05 / (relLuminance(hex) + 0.05); }

function normalizeHex(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

// 降级用的内置标签与颜色（读不到类型表时，GET /types 仍要能返回一套可用的）
const FALLBACK_TYPE_META = {
  meeting: ['会议', '#1d4ed8'], course: ['课表', '#15803d'], travel: ['行程', '#b45309'],
  sport: ['运动', '#0e7490'], life: ['生活', '#6d28d9'], pending: ['待安排', '#5b6472'],
  other: ['其他', '#5b6472'],
};

async function requireCore(event) {
  const actor = await resolveActor(event);
  if (!actor) return { error: { code: 401, message: '请先登录后再管理类型与颜色' } };
  if (String(actor.role || '') !== 'core') {
    return { error: { code: 403, message: '只有核心管理员可以修改类型与颜色' } };
  }
  return { actor };
}

// GET ?_action=types —— 类型清单（公开读）
async function listTypes(event) {
  try {
    const rows = await db.listItemTypes();
    if (Array.isArray(rows) && rows.length) return { ok: true, data: rows, error: null };
    throw new Error('类型表为空');
  } catch (e) {
    console.error('[类型清单降级] 读取 item_types_phase2 失败，返回内置类型：', e && e.message);
    const rows = ITEM_TYPES_FALLBACK.map((code, i) => {
      const meta = FALLBACK_TYPE_META[code] || [code, '#5b6472'];
      return { code, label: meta[0], color: meta[1], builtin: true, sortOrder: (i + 1) * 10 };
    });
    return { ok: true, data: rows, error: null };
  }
}

// POST ?_action=addtype —— 新增类型（core）。code 由服务端生成，用户只填「名字 + 颜色」。
// 为什么不让用户填 code：code 会进 items.type 且受 ^[a-z][a-z0-9_]{1,23}$ 约束，
//   让人想英文名既费劲又容易踩格式错误；让用户填中文名 + 选色，机器生成 custom_xxx 更稳。
async function addItemType(event) {
  const gate = await requireCore(event);
  if (gate.error) return { ok: false, data: null, error: gate.error };
  const body = getBody(event);

  const label = String(body.label || '').trim();
  if (!label) return { ok: false, data: null, error: { code: 400, message: '请填写类型名称' } };
  if (label.length > 12) return { ok: false, data: null, error: { code: 400, message: '类型名称最长 12 个字' } };

  const color = normalizeHex(body.color);
  if (!color) return { ok: false, data: null, error: { code: 400, message: '颜色格式应为 #RRGGBB（如 #1d4ed8）' } };
  const ratio = whiteContrast(color);
  if (ratio < 4.5) {
    return { ok: false, data: null, error: { code: 422, message: `颜色太浅：白字对比度只有 ${ratio.toFixed(1)}:1，低于 4.5:1 会看不清，请选深一点的色` } };
  }

  const all = await db.listItemTypes().catch(() => []);
  if (all.some(t => t.label === label)) {
    return { ok: false, data: null, error: { code: 409, message: `已有同名类型「${label}」，请换个名字` } };
  }
  if (all.length >= 30) {
    return { ok: false, data: null, error: { code: 422, message: '类型最多 30 个，已经到上限（太多了图例会挤满屏幕）' } };
  }

  // code：custom_ + 6 位 base36。撞车概率极低，但真撞了就重试一次。
  let created = null;
  for (let attempt = 0; attempt < 2 && !created; attempt++) {
    const code = 'custom_' + Date.now().toString(36).slice(-6) + (attempt ? Math.floor(Math.random() * 36).toString(36) : '');
    const r = await db.insertItemType({ code, label, color, sortOrder: 100, updatedBy: gate.actor.mid });
    if (r.error) { if (!r.conflict) return { ok: false, data: null, error: { code: 500, message: `新增类型失败：${r.message || '未知原因'}` } }; }
    else created = r.type;
  }
  if (!created) return { ok: false, data: null, error: { code: 409, message: '类型编号生成冲突，请重试一次' } };

  invalidateTypeCache();
  return { ok: true, data: created, error: null };
}

// POST ?_action=updatetype —— 改名字 / 改颜色（core）。内置类型也能改（它就是"调整语义色"）。
async function updateItemTypeEndpoint(event) {
  const gate = await requireCore(event);
  if (gate.error) return { ok: false, data: null, error: gate.error };
  const body = getBody(event);

  const code = String(body.code || '').trim();
  if (!code) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：类型编号' } };
  const cur = await db.findItemTypeByCode(code);
  if (!cur) return { ok: false, data: null, error: { code: 404, message: '类型不存在' } };

  const patch = {};
  if (body.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return { ok: false, data: null, error: { code: 400, message: '类型名称不能为空' } };
    if (label.length > 12) return { ok: false, data: null, error: { code: 400, message: '类型名称最长 12 个字' } };
    if (label !== cur.label) {
      const all = await db.listItemTypes().catch(() => []);
      if (all.some(t => t.label === label && t.code !== code)) {
        return { ok: false, data: null, error: { code: 409, message: `已有同名类型「${label}」，请换个名字` } };
      }
    }
    patch.label = label;
  }
  if (body.color !== undefined) {
    const color = normalizeHex(body.color);
    if (!color) return { ok: false, data: null, error: { code: 400, message: '颜色格式应为 #RRGGBB（如 #1d4ed8）' } };
    const ratio = whiteContrast(color);
    if (ratio < 4.5) {
      return { ok: false, data: null, error: { code: 422, message: `颜色太浅：白字对比度只有 ${ratio.toFixed(1)}:1，低于 4.5:1 会看不清，请选深一点的色` } };
    }
    patch.color = color;
  }
  if (!Object.keys(patch).length) {
    return { ok: false, data: null, error: { code: 400, message: '没有要修改的字段：请至少传 label 或 color' } };
  }

  const updated = await db.updateItemType(code, { ...patch, updatedBy: gate.actor.mid });
  if (!updated) return { ok: false, data: null, error: { code: 404, message: '类型不存在' } };
  invalidateTypeCache();
  return { ok: true, data: updated, error: null };
}

// POST ?_action=deletetype —— 删除自定义类型（core）。内置不可删；还有日程在用的不可删。
async function deleteItemTypeEndpoint(event) {
  const gate = await requireCore(event);
  if (gate.error) return { ok: false, data: null, error: gate.error };
  const body = getBody(event);

  const code = String(body.code || '').trim();
  if (!code) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：类型编号' } };
  const cur = await db.findItemTypeByCode(code);
  if (!cur) return { ok: false, data: null, error: { code: 404, message: '类型不存在' } };
  if (cur.builtin) {
    return { ok: false, data: null, error: { code: 403, message: '内置类型不能删除（库里已有历史日程在用），可以改颜色或改名称' } };
  }

  // 引用检查跨全部团队：类型是全局的，只查本团队会漏掉别人在用的
  const used = await db.countItemsByType(code);
  if (used < 0) {
    return { ok: false, data: null, error: { code: 500, message: '无法确认还有多少日程在用这个类型，为安全起见暂不允许删除' } };
  }
  if (used > 0) {
    return { ok: false, data: null, error: { code: 409, message: `还有 ${used} 条日程在用「${cur.label}」，请先把它们改成其他类型再删除` } };
  }

  const removed = await db.deleteItemType(code);
  if (!removed) return { ok: false, data: null, error: { code: 404, message: '类型不存在或为内置类型' } };
  invalidateTypeCache();
  return { ok: true, data: { code, removed: true }, error: null };
}

// GET ?_action=team —— 我自己所在的团队（任何登录成员都能看；joinCode 只给 admin）
async function teamInfo(event) {
  const actor = await resolveActor(event);
  if (!actor) return { ok: false, data: null, error: { code: 401, message: '请先登录后查看团队信息' } };
  const t = await publicTeam(actor.teamId, actor.role);
  if (!t) return { ok: false, data: null, error: { code: 404, message: '团队不存在，请联系管理员' } };
  const memberCount = await db.countTeamMembers(actor.teamId);
  return { ok: true, data: { team: { ...t, memberCount } }, error: null };
}

// POST ?_action=createteam —— 管理员建一个新团队，拿到团队码后分享给别人自助加入。
// 语义要点：建团队【不会】把创建者搬过去（一个人只属于一个团队），
//   创建者继续待在自己团队；新团队由第一个用该码注册的人成为 admin。
async function createTeamEndpoint(event) {
  const body = getBody(event);
  const actor = await resolveActor(event);
  if (!actor) return { ok: false, data: null, error: { code: 401, message: '请先登录后再创建团队' } };
  if (String(actor.role || '') !== 'admin') {
    return { ok: false, data: null, error: { code: 403, message: '只有管理员可以创建团队' } };
  }
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, data: null, error: { code: 400, message: '缺少必填字段：团队名称' } };
  if (name.length > 60) return { ok: false, data: null, error: { code: 400, message: '团队名称最长 60 字符' } };
  let code = String(body.joinCode || '').trim().toUpperCase();
  if (code) {
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
      return { ok: false, data: null, error: { code: 400, message: '团队码只能包含大写字母、数字和短横线（4–32 位）' } };
    }
  } else {
    code = genTeamCode();
  }
  const r = await db.createTeam({ name, joinCode: code, note: body.note });
  if (r.conflict) return { ok: false, data: null, error: { code: 409, message: '该团队码已被占用，请换一个' } };
  if (r.error) return { ok: false, data: null, error: r.error };
  await db.insertAudit({
    actorId: actor.mid, action: 'create_team', targetId: r.team.id,
    detail: `创建团队「${name}」（团队码 ${r.team.joinCode}）`, teamId: actor.teamId,
  }).catch(() => {});
  console.log('[POST /api/createTeam] 管理员', actor.mid, '创建团队', r.team.id, r.team.joinCode);
  return { ok: true, data: { team: r.team }, error: null };
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

  // 【2026-10-27 多团队】自助注册（邀请码加入）：路径或 _action 两条路都收
  const wantsRegister = action === 'register' || /\/auth\/register(\/|\?|$)/.test(p0);
  if (wantsRegister && method === 'POST') {
    try { return http(event, await authRegister(event)); }
    catch (err) {
      logError('POST /api/auth/register', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【多团队】团队信息 / 建团队
  if (action === 'team' && method === 'GET') {
    try { return http(event, await teamInfo(event)); }
    catch (err) {
      logError('GET /api/team', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  if (action === 'createteam' && method === 'POST') {
    try { return http(event, await createTeamEndpoint(event)); }
    catch (err) {
      logError('POST /api/createTeam', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 P9】成员列表（供前端"归属给谁"下拉；只读，不含凭据）
  // 【多团队】只列【本团队】成员：登录用自己团队，匿名落默认团队
  if (action === 'members' && method === 'GET') {
    try {
      const scope = await resolveReadScope(event);
      if (!scope.teamId) {
        return http(event, { ok: false, data: null, error: { code: 500, message: '团队未初始化，请联系管理员' } }, 500);
      }
      const list = await db.listMembers(scope.teamId);
      return http(event, { ok: true, data: list, error: null });
    } catch (err) {
      logError('GET /api/members', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 在线人数】心跳：GET/POST 都收（30s 一次的保活信号，少一种失败模式）
  if (action === 'heartbeat' && (method === 'GET' || method === 'POST')) {
    try { return http(event, await heartbeat(event)); }
    catch (err) {
      logError('HEARTBEAT', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 管理员 UI】改他人角色：仅 POST；仅 admin（校验在 setRole 内，见函数头铁律）
  if (action === 'setrole' && method === 'POST') {
    try { return http(event, await setRole(event)); }
    catch (err) {
      logError('POST /api/setRole', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 Step5 口令体系】重置他人口令：仅 POST；仅 admin（校验在 resetPasscode 内）
  if (action === 'resetpasscode' && method === 'POST') {
    try { return http(event, await resetPasscode(event)); }
    catch (err) {
      logError('POST /api/resetPasscode', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 Step5 口令体系】自助改口令：仅 POST；任意登录成员（只改自己，校验在 changePasscode 内）
  if (action === 'changepasscode' && method === 'POST') {
    try { return http(event, await changePasscode(event)); }
    catch (err) {
      logError('POST /api/changePasscode', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【阶段二 Step5 口令体系】添加成员：仅 POST；仅 admin（校验在 addMember 内）
  if (action === 'addmember' && method === 'POST') {
    try { return http(event, await addMember(event)); }
    catch (err) {
      logError('POST /api/addMember', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }

  // 【2026-10-28】类型与颜色：读公开、写限 core
  if (action === 'types' && method === 'GET') {
    try { return http(event, await listTypes(event)); }
    catch (err) {
      logError('GET /api/types', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  if (action === 'addtype' && method === 'POST') {
    try { return http(event, await addItemType(event)); }
    catch (err) {
      logError('POST /api/addType', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  if (action === 'updatetype' && method === 'POST') {
    try { return http(event, await updateItemTypeEndpoint(event)); }
    catch (err) {
      logError('POST /api/updateType', err);
      const e = toUserError(err);
      return http(event, { ok: false, data: null, error: e }, e.code);
    }
  }
  if (action === 'deletetype' && method === 'POST') {
    try { return http(event, await deleteItemTypeEndpoint(event)); }
    catch (err) {
      logError('POST /api/deleteType', err);
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
  // 【2026-10-27 多团队】范围由服务端定：登录看自己团队，匿名看默认团队。
  //   ★ 绝不接受前端传 teamId —— 那等于让客户端自己划数据边界。
  const q = getQuery(event);
  try {
    const scope = await resolveReadScope(event);
    if (!scope.teamId) {
      return http(event, { ok: false, data: null, error: { code: 500, message: '团队未初始化，请联系管理员' } }, 500);
    }
    const data = await db.queryItems(q, scope.teamId);
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
