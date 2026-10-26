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
// 【阶段二 P6-②】末尾 6 列为 P5 迁移新增（db/schema_phase2.sql），必须同步登记 ——
// ★ 不改这里会出现「库里有值、接口读不到」的幽灵问题（TECH_DESIGN R3）。
//   兼容性：只追加、不删旧列 ⇒ 老字段一个不少，v1.0 前端不受影响。
const COLUMNS =
  'id,title,type,table_kind,start_time,end_time,week,attendees,venue,equipment,note,source,status,owner_key,idempotency_key,created_at,updated_at,' +
  'owner_member_id,created_by,updated_by,border_color,meeting_no,meeting_url';

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
    // 【阶段二 P9】并发用原始时间戳（与 PostgREST 返回逐字一致，避免时区/精度错位导致条件更新误判）
    updatedAtRaw: r.updated_at != null ? String(r.updated_at) : null,
    // 【阶段二 P6-②】新增字段（P5 迁移已建列）。缺省一律 null，老数据不受影响。
    // ★ 颜色分工：fill 由 type（日程类型）决定，borderColor 只管【人】的外框，二者不冲突。
    ownerMemberId: r.owner_member_id != null ? r.owner_member_id : null,
    createdBy: r.created_by != null ? r.created_by : null,
    updatedBy: r.updated_by != null ? r.updated_by : null,
    borderColor: r.border_color || null,
    meetingNo: r.meeting_no || null,
    meetingUrl: r.meeting_url || null,
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

// —— 【Day 22】PATCH /api/items/:id 第 1 步 —— 按 id 查单条 ——
// 用途有二：① 判断这条记录存不存在（不存在要回 404，不能稀里糊涂返回 ok）；
//          ② PATCH 是"部分更新"，只改开始时间时要拿库里的结束时间来校验区间，否则会改出 end < start。
async function findItemById(id) {
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', COLUMNS);
  p.set('id', `eq.${id}`);
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/items?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`查询单条返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`查询 items id=${id} 失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.length ? toItem(rows[0]) : null;   // 查不到返回 null（由控制器翻成 404）
}

// —— 【Day 22 / 阶段二 P9】PATCH /api/items/:id 第 2 步 —— 按 id 更新（部分更新）——
// ★ 必须带 `?id=eq.<具体值>` 过滤：PostgREST 的 PATCH 不带过滤条件会**整表更新**。
// 【阶段二 P9 并发】baseUpdatedAt 非空时，把 `updated_at=eq.<旧值>` 也作为过滤条件，
//   让"版本比对"发生在数据库内部（原子），彻底堵住「读后比对」的竞态窗口——
//   别人在我们读取之后、写入之前改了同一行，本条件命中 0 行 → 控制器返回 409 冲突。
// 返回：{ item } 成功 / { notFound: true } id 不存在 / { concurrent: true } 版本不符（被他人抢先改） / { error }
async function updateItem(id, patch, baseUpdatedAt) {
  const token = await getBearer();
  const q = new URLSearchParams();
  q.set('id', `eq.${encodeURIComponent(id)}`);
  if (baseUpdatedAt) q.set('updated_at', `eq.${String(baseUpdatedAt)}`);   // ★ P9 并发条件（原子）
  const updRes = await fetch(`${GATEWAY}/v1/rdb/rest/items?${q.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation',   // 要求网关把更新后的行回传，省一次读
    },
    body: JSON.stringify(patch),
  });
  const updText = await updRes.text();
  let updJson;
  try { updJson = JSON.parse(updText); }
  catch (e) {
    return { error: { code: 500, message: `更新返回非 JSON（HTTP ${updRes.status}）：${updText.slice(0, 200)}` } };
  }
  if (!updRes.ok) {
    const msg = (updJson && (updJson.message || updJson.error || updJson.error_description || updJson.hint)) || `HTTP ${updRes.status}`;
    // 唯一约束冲突（改成了和别人重复的内容 / 幂等键撞车）
    const isDup = updRes.status === 409 || (updJson && (updJson.code === '23505' || /duplicate key/i.test(msg)));
    if (isDup) return { error: { code: 409, message: '该修改与已有事项冲突（重复内容或重复幂等键），未保存' } };
    return { error: { code: updRes.status, message: `更新 items id=${id} 失败：${msg}` } };
  }
  const rows = Array.isArray(updJson) ? updJson : (updJson && updJson.data) || [];
  if (!rows.length) {
    // 本函数调用前控制器已用 findItemById 确认 id 存在，故此处 0 行只可能是：
    //   ① 带了 baseUpdatedAt 且被他人抢先改（updated_at 已变）→ 并发冲突；
    //   ② 否则视为不存在。
    return baseUpdatedAt ? { concurrent: true } : { notFound: true };
  }
  return { item: toItem(rows[0]) };
}

// —— 【Day 22】DELETE /api/items/:id —— 按 id 删除（硬删除）——
// ★★ 删除比新增容易出事，根子在这一行：PostgREST 的 DELETE 如果不带过滤条件，会**清空整张表**。
//    所以这里把 `id=eq.<具体值>` 拼进 URL，且控制器侧强制 id 必填、必须是单个正整数，
//    绝不允许出现「没有条件」或「条件是客户端随意给的批量范围」的删除。
// ★ 带 `Prefer: return=representation` 让网关把被删的那行回传 —— 删完能留下"刚才删的是什么"的快照，
//    这是硬删除唯一的一点可追溯性（真要能找回，得靠软删除 is_deleted，属今天的余力加练）。
// 返回：{ deleted } 成功 / { notFound: true } 该 id 不存在 / { error } 失败
async function deleteItem(id) {
  const token = await getBearer();
  const delRes = await fetch(`${GATEWAY}/v1/rdb/rest/items?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation',
    },
  });
  const delText = await delRes.text();
  let delJson;
  try { delJson = JSON.parse(delText); }
  catch (e) {
    return { error: { code: 500, message: `删除返回非 JSON（HTTP ${delRes.status}）：${delText.slice(0, 200)}` } };
  }
  if (!delRes.ok) {
    const msg = (delJson && (delJson.message || delJson.error || delJson.error_description || delJson.hint)) || `HTTP ${delRes.status}`;
    return { error: { code: delRes.status, message: `删除 items id=${id} 失败：${msg}` } };
  }
  const rows = Array.isArray(delJson) ? delJson : (delJson && delJson.data) || [];
  if (!rows.length) return { notFound: true };   // 影响 0 行 = 这个 id 本来就不存在
  return { deleted: toItem(rows[0]) };
}

// —— 【阶段二 P6-②】成员查询：口令登录（方案 B = 显示名 + 口令，用户拍板）——
// 本函数只负责"把这一行的 salt 和哈希取回来"，**不做任何比对**（比对在 identity_phase2 里），
// 保持分层：数据访问层碰库、身份模块碰密码学，两边都能单独测。
// ⚠️ 安全：identity_key / salt 是凭据，**绝不能出现在任何对外响应里**，只在本进程内流转。
async function findMemberByName(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return null;
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', 'id,display_name,identity_key,auth_kind,role,border_color,meeting_no,meeting_url,salt,note');
  p.set('display_name', `eq.${name}`);
  p.set('auth_kind', 'eq.passcode');     // 只认口令成员；微信/匿名身份本期不启用
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
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
    throw new Error(`查询成员返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`查询成员失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.length ? rows[0] : null;   // 查不到返回 null，由调用方统一按"口令无效"处理（不泄露是否存在该成员）
}

// —— 【阶段二 P9】成员列表（供前端"归属给谁"下拉；不含任何凭据）——
async function listMembers() {
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', 'id,display_name,role,border_color,meeting_no,meeting_url');
  p.set('auth_kind', 'eq.passcode');
  p.set('order', 'id.asc');
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`查询成员列表返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`查询成员列表失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name || '',
    role: r.role || 'member',
    borderColor: r.border_color || null,
    meetingNo: r.meeting_no || null,
    meetingUrl: r.meeting_url || null,
  }));
}

// —— 【阶段二 P9】按 id 查单个成员（校验"给他人放"目标真实存在，并取库里的外框色，防前端冒充）——
async function findMemberById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', 'id,display_name,role,border_color');
  p.set('id', `eq.${n}`);
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`查询成员返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`查询成员失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.length
    ? { id: rows[0].id, displayName: rows[0].display_name || '', role: rows[0].role || 'member', borderColor: rows[0].border_color || null }
    : null;
}

// —— 【阶段二 P9】写操作留痕（audit_phase2，只追加）——
// 失败只记日志、不阻断主流程（留痕是辅助，不能因为留痕挂了就让建/改/删也失败）。
async function insertAudit({ itemId, actorId, action, targetId, detail }) {
  const token = await getBearer();
  const row = {
    item_id: itemId != null ? Number(itemId) : null,
    actor_id: actorId != null ? Number(actorId) : null,
    action: String(action || 'create'),
    target_id: targetId != null ? Number(targetId) : null,
    detail: detail != null ? String(detail) : null,
  };
  try {
    const res = await fetch(`${GATEWAY}/v1/rdb/rest/audit_phase2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Profile': SCHEMA,
        'Content-Profile': SCHEMA,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify([row]),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('[audit] 留痕写入失败 HTTP', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.error('[audit] 留痕写入异常：', e && e.message);
  }
}

// —— 【阶段二 在线人数】心跳：刷新自己的 last_seen_at（在线判定用，2026-10-18）——
// 前端每 30s 上报一次；2 分钟窗口内有心跳视为在线。失败抛错由调用方兜
// （心跳是保活信号，失败不该让前端误判成登录失效）。
// ★ PATCH 必须带 `id=eq.<具体值>`：PostgREST 的 PATCH 不带过滤条件会【整表更新】（Day 22 同款教训）。
async function touchMember(mid) {
  const n = Number(mid);
  if (!Number.isInteger(n) || n <= 0) throw new Error('touchMember: mid 无效');
  const token = await getBearer();
  const q = new URLSearchParams();
  q.set('id', `eq.${n}`);
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${q.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=minimal',
    },
    // 时钟用函数容器本地时间（与 countOnline 同一时钟，自洽；窗口 2 分钟远大于时钟偏差）
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`心跳更新失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
}

// —— 【阶段二 在线人数】统计窗口内心跳过的成员数（2026-10-18）——
// 只有登录成员会记心跳（匿名无令牌不记）→ 统计口径 = 登录成员中的在线数。
// minutes: 判定窗口（分钟），默认 2。成员量小（个位数），直接数行，不引入 count 聚合头。
async function countOnline(minutes = 2) {
  const win = Math.max(1, Number(minutes) || 2);
  const since = new Date(Date.now() - win * 60 * 1000).toISOString();
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', 'id');
  p.set('last_seen_at', `gte.${since}`);
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
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
    throw new Error(`在线人数查询返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`在线人数查询失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.length;
}

// —— 【阶段二 管理员 UI】改他人角色（2026-10-18，seam C 落地）——
// ★ 权限校验（仅 admin、禁改自己）在 index.js 的 setRole 内，本函数只做数据写入。
// 返回：{ member: {id, displayName, role} } 成功 / { notFound: true } id 不存在 / { error } 失败
async function updateMemberRole(mid, role) {
  const n = Number(mid);
  if (!Number.isInteger(n) || n <= 0) return { notFound: true };
  const token = await getBearer();
  const q = new URLSearchParams();
  q.set('id', `eq.${n}`);   // ★ 同 Day 22 教训：不带条件 = 整表改角色，灾难
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${q.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ role: String(role) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    return { error: { code: 500, message: `改角色返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } };
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    return { error: { code: res.status, message: `更新成员角色失败：${msg}` } };
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  if (!rows.length) return { notFound: true };
  return {
    member: {
      id: rows[0].id,
      displayName: rows[0].display_name || '',
      role: rows[0].role || 'member',
    },
  };
}

// —— 【阶段二 Step5】按 id 查成员凭据（salt + identity_key；仅供服务端验口令/改口令内部使用）——
// ★ 与 findMemberById 的分工：那个对外（不含凭据，防泄露离线可破）；这个对内（验旧口令必须拿到盐和哈希）。
//   返回值绝不直接出站到任何接口响应。
async function findMemberCredentialsById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const token = await getBearer();
  const p = new URLSearchParams();
  p.set('select', 'id,display_name,role,salt,identity_key,auth_kind');
  p.set('id', `eq.${n}`);
  p.set('auth_kind', 'eq.passcode');   // 只认口令成员
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${p.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`查询成员凭据返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    throw new Error(`查询成员凭据失败：${msg}`);
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  return rows.length ? rows[0] : null;
}

// —— 【阶段二 Step5】重置/修改口令：换新盐 + 写新哈希（2026-10-23）——
// 重置与自助改都走这里：一律换新盐（防旧盐已泄露的边际风险，成本为零）。
// ★ PATCH 必须带 `id=eq.<具体值>`：PostgREST 的 PATCH 不带过滤条件会【整表更新】（Day 22 同款教训）。
// 返回：{ member: {id, displayName, role} } 成功 / { notFound: true } id 不存在 / { error } 失败
async function updateMemberPasscode(mid, identityKey, salt) {
  const n = Number(mid);
  if (!Number.isInteger(n) || n <= 0) return { notFound: true };
  if (!identityKey || !salt) return { error: { code: 500, message: '更新口令缺少盐或哈希（内部错误）' } };
  const token = await getBearer();
  const q = new URLSearchParams();
  q.set('id', `eq.${n}`);   // ★ 同 Day 22 教训：不带条件 = 全库统一口令，灾难
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2?${q.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ identity_key: String(identityKey), salt: String(salt) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    return { error: { code: 500, message: `改口令返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } };
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    return { error: { code: res.status, message: `更新成员口令失败：${msg}` } };
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  if (!rows.length) return { notFound: true };
  return {
    member: {
      id: rows[0].id,
      displayName: rows[0].display_name || '',
      role: rows[0].role || 'member',
    },
  };
}

// —— 【阶段二 Step5】管理员添加成员（带初始口令，2026-10-23）——
// display_name 无唯一约束（重名检查在 index.js 的 addMember 层做，返 409）；
// identity_key 有唯一索引 —— 每次新盐 → 新哈希，不会撞。
// 返回：{ member: {id, displayName, role} } 成功 / { error } 失败
async function insertMemberWithAuth({ displayName, role, identityKey, salt }) {
  const name = String(displayName || '').trim();
  if (!name) return { error: { code: 400, message: '成员名称不能为空' } };
  const token = await getBearer();
  const row = {
    display_name: name,
    role: String(role || 'member'),
    auth_kind: 'passcode',
    identity_key: String(identityKey),
    salt: String(salt),
  };
  const res = await fetch(`${GATEWAY}/v1/rdb/rest/members_phase2`, {
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
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    return { error: { code: 500, message: `添加成员返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` } };
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.error_description || json.hint)) || `HTTP ${res.status}`;
    return { error: { code: res.status, message: `添加成员失败：${msg}` } };
  }
  const rows = Array.isArray(json) ? json : (json && json.data) || [];
  if (!rows.length) return { error: { code: 500, message: '添加成员未返回创建结果' } };
  return {
    member: {
      id: rows[0].id,
      displayName: rows[0].display_name || '',
      role: rows[0].role || 'member',
    },
  };
}

module.exports = {
  queryItems,
  findDuplicate,
  insertItem,
  findItemById,
  updateItem,
  deleteItem,
  // 【阶段二 P6-②】
  findMemberByName,
  // 【阶段二 P9】
  listMembers,
  findMemberById,
  insertAudit,
  // 【阶段二 管理员 UI + 在线人数 2026-10-18】
  touchMember,
  countOnline,
  updateMemberRole,
  // 【阶段二 Step5 口令体系 2026-10-23】
  findMemberCredentialsById,
  updateMemberPasscode,
  insertMemberWithAuth,
};
