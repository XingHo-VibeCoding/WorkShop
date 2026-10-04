// WorkShop · items 云函数本地纯逻辑测试（Day 22 · PATCH 部分）
// 不连真实库：用 mock 的 global.fetch 模拟 PostgREST 的「按 id 查单条」与「按 id 更新」，
// 校验 patchItem 的 id 解析 / 取值校验 / 时间区间补齐 / week 重算 / 404 / 409 / 方法兼容 全流程。
//
// 运行：node test-local-day22.js   （Node 18+）
'use strict';

// 1) 【Day 23】测试用的"密钥"不再写死在代码里：优先读环境变量，读不到就用本地占位值。
//    占位值只是为了让 getBearer() 短路、不发匿名登录请求，本身不是密钥（也不含任何密钥特征）。
//    真实密钥永远只放环境变量 CB_API_KEY，键名清单见仓库根目录 .env.example。
process.env.CB_API_KEY = process.env.CB_API_KEY || 'local';

// 2) mock PostgREST
let SHOULD_NOT_FOUND = false;   // 控制「按 id 查单条」是否查不到
let SHOULD_DUP = false;         // 控制更新时是否撞唯一约束（PostgREST 对 23505 返回 409）

// 库里那条"原记录"（snake_case，模拟 PostgREST 返回形态）
const OLD_ROW = {
  id: 12, title: '临时碰头', type: 'meeting', table_kind: 'work',
  start_time: '2026-09-30 15:00:00', end_time: '2026-09-30 16:00:00',
  week: '2026-W40', attendees: '李工', venue: '线上', equipment: null,
  note: '', source: 'manual', status: 'scheduled', owner_key: 'self',
  idempotency_key: null,
  created_at: '2026-09-29 09:00:00', updated_at: '2026-09-29 09:00:00',
};
let LAST_PATCH_BODY = null;     // 记录最后一次 PATCH 发给库的字段，便于断言"只改了传了的字段"
const DELETED_IDS = new Set();  // 记录已被删掉的 id，用来模拟"删完之后再查/再删都找不到"

global.fetch = async (url, opts = {}) => {
  const mk = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const isItems = url.includes('/v1/rdb/rest/items');
  const isById = url.includes('id=eq.');

  // 从 URL 里取出 id=eq.X 的 X，供"已删除"判定用
  const idFromUrl = (isById && /id=eq\.(\d+)/.exec(url)) ? /id=eq\.(\d+)/.exec(url)[1] : null;

  // 「按 id 查单条」：GET 且带 id 过滤
  // 库里只有 id=12 这一条；别的 id（如 9999）应当查不到，否则"删不存在的 id 应回 404"就测不出来
  if (isItems && isById && (opts.method === 'GET' || opts.method === undefined)) {
    if (SHOULD_NOT_FOUND) return mk([]);
    if (idFromUrl && idFromUrl !== '12') return mk([]);
    if (idFromUrl && DELETED_IDS.has(idFromUrl)) return mk([]);   // 删掉的就查不到了
    return mk([OLD_ROW]);
  }
  // 「按 id 删除」：DELETE
  if (isItems && isById && opts.method === 'DELETE') {
    if (SHOULD_NOT_FOUND || (idFromUrl && DELETED_IDS.has(idFromUrl))) return mk([]);  // 影响 0 行
    if (idFromUrl) DELETED_IDS.add(idFromUrl);
    return mk([OLD_ROW]);   // return=representation：把被删的那行回传
  }
  // 「按 id 更新」：PATCH
  if (isItems && isById && opts.method === 'PATCH') {
    LAST_PATCH_BODY = JSON.parse(opts.body);
    if (SHOULD_DUP) {
      const body = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' });
      return { ok: false, status: 409, json: async () => JSON.parse(body), text: async () => body };
    }
    if (SHOULD_NOT_FOUND) return mk([]);   // 影响 0 行
    return mk([{ ...OLD_ROW, ...LAST_PATCH_BODY, updated_at: '2026-10-02 20:00:00' }]);
  }
  // 「写入」：POST（Day 18 老逻辑，本轮只做回归）—— 返回新行，形态与 OLD_ROW 一致
  if (isItems && opts.method === 'POST') {
    const row = JSON.parse(opts.body)[0] || {};
    return mk([{ ...OLD_ROW, ...row, id: 11 }]);
  }
  // 其余（如列表查询、去重查询）统一给空数组
  if (isItems) return mk([]);
  return { ok: false, status: 500, json: async () => ({}), text: async () => '{}' };
};

const handler = require('./index.js');

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; }
  else { console.log('✅ PASS:', msg); }
}

// Day 20 起，云函数返回的是 HTTP 完整形态 { statusCode, headers, body }（自定义 CORS 头必须用这种形态才会输出），
// 所以断言前要把 body 里的 JSON 解出来，不能直接读 r.ok。
async function call(evt) {
  const res = await handler.main(evt);
  if (res && typeof res.body === 'string') return JSON.parse(res.body);
  return res;
}

const patch = (body, extra = {}) =>
  call({ httpMethod: 'PATCH', body: JSON.stringify(body), ...extra });

(async () => {
  console.log('=== Day 22 · PATCH 本地纯逻辑测试（mock，不连真库）===\n');

  // 用例1：三种 id 来源 —— ?id=12
  let r = await patch({ title: '改个名' }, { queryString: 'id=12' });
  assert(r.ok === true && r.data.id === 12, 'id 走 ?id=12 → ok:true: ' + JSON.stringify(r.data && r.data.title));

  // 用例2：id 走请求体
  r = await patch({ id: 12, title: '改个名2' });
  assert(r.ok === true && r.data.id === 12, 'id 走请求体 → ok:true: ' + JSON.stringify(r.data && r.data.title));

  // 用例3：id 走 URL 路径末尾
  r = await patch({ title: '改个名3' }, { path: '/api/items/12' });
  assert(r.ok === true && r.data.id === 12, 'id 走 /api/items/12 → ok:true: ' + JSON.stringify(r.data && r.data.title));

  // 用例4：缺 id → 400 中文
  r = await patch({ title: '没带id' });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('缺少 id'), '缺 id → 400 含「缺少 id」: ' + JSON.stringify(r.error));

  // 用例5：id 是本地临时 id（u 开头）→ 400，不能拿去查库
  r = await patch({ id: 'u1718000000000', title: '本地临时项' });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('id 无效'), '本地临时 id → 400 含「id 无效」: ' + JSON.stringify(r.error));

  // 用例6：一个可改字段都不传 → 400
  r = await patch({ id: 12, idempotencyKey: 'x' });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('没有要更新的字段'), '空更新 → 400 含「没有要更新的字段」: ' + JSON.stringify(r.error));

  // 用例7：取值非法（type）→ 400
  r = await patch({ id: 12, type: '不存在的类型' });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('事项类型'), 'type 非法 → 400 含「事项类型」: ' + JSON.stringify(r.error));

  // 用例8：时间格式错 → 400
  r = await patch({ id: 12, startTime: '2026/10/02 9点' });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('开始时间格式'), '时间格式错 → 400: ' + JSON.stringify(r.error));

  // 用例9：★ 只改结束时间，且早于库里的开始时间 → 422（证明"拿库里另一头补齐"生效）
  r = await patch({ id: 12, endTime: '2026-09-30 14:00' });
  assert(r.ok === false && r.error.code === 422 && r.error.message.includes('结束时间须不早于开始时间'), '只改结束时间且早于库里开始时间 → 422: ' + JSON.stringify(r.error));

  // 用例10：只改结束时间且合法 → ok（结束 17:00 > 库里开始 15:00）
  LAST_PATCH_BODY = null;
  r = await patch({ id: 12, endTime: '2026-09-30 17:00' });
  assert(r.ok === true && LAST_PATCH_BODY && LAST_PATCH_BODY.end_time === '2026-09-30 17:00:00', '只改结束时间（合法）→ ok:true 且只发该字段: ' + JSON.stringify(LAST_PATCH_BODY));
  assert(LAST_PATCH_BODY && LAST_PATCH_BODY.week === undefined, '未改开始时间 → 不重算 week（week 不在更新字段里）: ' + JSON.stringify(LAST_PATCH_BODY));

  // 用例11：改开始时间 → 连带重算 week（否则这条会从所属周里消失）
  // 注意：整体挪到 10-05（周一），开始结束一起改，否则会被"结束早于开始"的 422 拦下
  LAST_PATCH_BODY = null;
  r = await patch({ id: 12, startTime: '2026-10-05 09:00', endTime: '2026-10-05 10:00' });
  assert(r.ok === true && LAST_PATCH_BODY && LAST_PATCH_BODY.week === '2026-W41', '改开始时间 → week 重算为 2026-W41: ' + JSON.stringify(LAST_PATCH_BODY));

  // 用例12：正常改标题 → ok:true 且返回 camelCase 字段
  r = await patch({ id: 12, title: '改后的标题' });
  assert(r.ok === true && r.data.title === '改后的标题' && r.data.table === 'work' && r.data.ownerKey === 'self' && r.data.startTime === '2026-09-30 15:00', '改标题 → ok:true + camelCase 映射正确: ' + JSON.stringify(r.data));

  // 用例13：id 不存在 → 404
  SHOULD_NOT_FOUND = true;
  r = await patch({ id: 9999, title: '改不存在的' });
  assert(r.ok === false && r.error.code === 404 && r.error.message.includes('找不到该事项'), 'id 不存在 → 404 含「找不到该事项」: ' + JSON.stringify(r.error));
  SHOULD_NOT_FOUND = false;

  // 用例14：唯一约束冲突 → 409
  SHOULD_DUP = true;
  r = await patch({ id: 12, title: '撞车标题' });
  assert(r.ok === false && r.error.code === 409 && r.error.message.includes('冲突'), '更新撞唯一约束 → 409 含「冲突」: ' + JSON.stringify(r.error));
  SHOULD_DUP = false;

  // 用例15：PUT 走同一套逻辑（契约登记为 PATCH，PUT 兼容旧写法）
  r = await call({ httpMethod: 'PUT', body: JSON.stringify({ id: 12, title: 'PUT 也该能改' }) });
  assert(r.ok === true && r.data.title === 'PUT 也该能改', 'PUT → 复用 PATCH 逻辑 ok:true: ' + JSON.stringify(r.data && r.data.title));

  // 用例16：网关不放行 PATCH 时的兜底 —— POST + _method=PATCH
  r = await call({ httpMethod: 'POST', queryString: '_method=PATCH', body: JSON.stringify({ id: 12, title: '兜底改' }) });
  assert(r.ok === true && r.data.title === '兜底改', 'POST + ?_method=PATCH → 走 PATCH 逻辑 ok:true: ' + JSON.stringify(r.data && r.data.title));

  // 用例17：回归 —— GET 列表不受影响
  r = await call({ httpMethod: 'GET', queryString: 'table=work' });
  assert(r.ok === true && Array.isArray(r.data), '回归 GET /api/items → ok:true 且 data 为数组: ' + JSON.stringify(r).slice(0, 120));

  // 用例18：回归 —— POST 新建不受影响
  r = await call({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', title: '新建回归', startTime: '2026-10-03 10:00', endTime: '2026-10-03 11:00', ownerKey: 'self' }) });
  assert(r.ok === true && r.data && r.data.id === 11, '回归 POST /api/items → ok:true: ' + JSON.stringify(r.data && r.data.id));

  console.log('\n=== PATCH 本地逻辑测试完毕（18 用例）===');

  // ============ Day 22 · DELETE 部分 ============
  console.log('\n=== DELETE 本地纯逻辑测试（mock，不连真库）===\n');
  DELETED_IDS.clear();

  const del = (body, extra = {}) => call({ httpMethod: 'DELETE', body: JSON.stringify(body), ...extra });

  // 用例19：★ 不带 confirm → 400（删除比新增危险的第一道闸：没确认不许删）
  r = await del({ id: 12 });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('显式确认'), '不带 confirm → 400 含「显式确认」: ' + JSON.stringify(r.error));

  // 用例20：confirm=false → 400（传了但不为真，同样拒绝）
  r = await del({ id: 12, confirm: false });
  assert(r.ok === false && r.error.code === 400, 'confirm=false → 400: ' + JSON.stringify(r.error));
  r = await del({ id: 12 }, { queryString: 'id=12&confirm=no' });
  assert(r.ok === false && r.error.code === 400, 'confirm=no（非真值）→ 400: ' + JSON.stringify(r.error));

  // 用例21：确认了但缺 id → 400（不能因为确认过就放行无条件删除）
  r = await del({ confirm: true });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('缺少 id'), '已确认但缺 id → 400 含「缺少 id」: ' + JSON.stringify(r.error));

  // 用例22：临时本地 id → 400
  r = await del({ id: 'u1718000000000', confirm: true });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('id 无效'), '临时 id + confirm → 400 含「id 无效」: ' + JSON.stringify(r.error));

  // 用例23：★ 删不存在的 id（已确认）→ 404，不是 500、也不装成功
  r = await del({ id: 9999, confirm: true });
  assert(r.ok === false && r.error.code === 404 && r.error.message.includes('找不到该事项'), '删不存在 id → 404: ' + JSON.stringify(r.error));

  // 用例24：★ 正常删除 → ok:true，且带回被删内容快照（硬删除下唯一的后悔药线索）
  r = await del({ id: 12, confirm: true });
  assert(r.ok === true && r.data.deleted === true && r.data.id === 12 && r.data.item && r.data.item.title === '临时碰头',
    '正常删除 → ok:true + 快照含原标题: ' + JSON.stringify(r.data && { id: r.data.id, deleted: r.data.deleted, title: r.data.item && r.data.item.title }));

  // 用例25：★ 重复删除同一 id → 404（幂等语义：删过了就说找不到，不报服务端错误）
  r = await del({ id: 12, confirm: true });
  assert(r.ok === false && r.error.code === 404 && r.error.message.includes('可能已被删除'), '重复删除 → 404 含「可能已被删除」: ' + JSON.stringify(r.error));

  // 用例26：confirm 走 query 也认（?id=12&confirm=true）
  DELETED_IDS.clear();
  r = await del({}, { queryString: 'id=12&confirm=true' });
  assert(r.ok === true && r.data.deleted === true, 'confirm 走 query → ok:true: ' + JSON.stringify(r.data && r.data.id));

  // 用例27：网关不放行 DELETE 时的兜底 —— POST + ?_method=DELETE
  DELETED_IDS.clear();
  r = await call({ httpMethod: 'POST', queryString: '_method=DELETE', body: JSON.stringify({ id: 12, confirm: true }) });
  assert(r.ok === true && r.data.deleted === true, 'POST + ?_method=DELETE → 走删除逻辑 ok:true: ' + JSON.stringify(r.data && r.data.id));

  // 用例28：回归 —— 删除没影响 GET / POST / PATCH
  DELETED_IDS.clear();
  r = await call({ httpMethod: 'GET', queryString: 'table=work' });
  assert(r.ok === true && Array.isArray(r.data), '回归 GET → ok:true: ' + JSON.stringify(r).slice(0, 80));
  r = await patch({ id: 12, title: '删完还能改' });
  assert(r.ok === true && r.data.title === '删完还能改', '回归 PATCH → ok:true: ' + JSON.stringify(r.data && r.data.title));

  console.log('\n=== DELETE 本地逻辑测试完毕（10 用例）===');
  console.log('\n=== Day 22 合计 28 用例 ===');
})();
