// WorkShop · items 云函数本地纯逻辑测试（Day 18）
// 不连真实库：用 mock 的 global.fetch 模拟 PostgREST 的「去重查询」与「写入」，
// 校验 createItem 的 解析 / 必填校验 / 取值校验 / 防重复提交 / 成功写入 全流程。
//
// 运行：node test-local.js   （Node 18+，自带 fetch；此处会被本脚本覆盖）
'use strict';

// 1) 用测试密钥，让 getBearer() 直接返回，不再发起匿名登录网络请求
process.env.CB_API_KEY = 'test-key';

// 2) mock PostgREST
let SHOULD_DUP = false; // 控制去重查询是否命中
let SHOULD_KEY_DUP = false; // 控制写入时是否模拟 idempotency_key 唯一冲突
global.fetch = async (url, opts = {}) => {
  const mk = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });
  const isItems = url.includes('/v1/rdb/rest/items');
  if (isItems && (opts.method === 'GET' || opts.method === undefined)) {
    // 去重查询：select=id
    if (SHOULD_DUP) return mk([{ id: 999 }]);
    return mk([]);
  }
  if (isItems && opts.method === 'POST') {
    // B 方案：模拟数据库唯一约束冲突（PostgREST 对 23505 返回 JSON body，非纯文本）
    if (SHOULD_KEY_DUP) {
      const body = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "items_idempotency_key_key"' });
      return { ok: false, status: 409, json: async () => JSON.parse(body), text: async () => body };
    }
    // 写入：返回一条新记录（snake_case，PostgREST return=representation）
    return mk([{
      id: 11, title: '临时碰头', type: 'meeting', table_kind: 'work',
      start_time: '2026-09-30 15:00:00', end_time: '2026-09-30 16:00:00',
      week: '2026-W40', attendees: '李工', venue: '线上', equipment: null,
      note: '', source: 'manual', status: 'scheduled', owner_key: 'self',
      idempotency_key: null,
      created_at: '2026-09-29 09:00:00', updated_at: '2026-09-29 09:00:00',
    }]);
  }
  return { ok: false, json: async () => ({}), text: async () => '{}' };
};

const handler = require('./index.js');

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; }
  else { console.log('✅ PASS:', msg); }
}

(async () => {
  // 用例1：缺少必填字段 title → 400 中文
  let r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00', ownerKey: 'self' }) });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('标题'), '缺 title → 400 且提示含「标题」: ' + JSON.stringify(r.error));

  // 用例2：所属表非法 → 400
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'x', table: 'wrong', type: 'meeting', startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00', ownerKey: 'self' }) });
  assert(r.ok === false && r.error.code === 400 && r.error.message.includes('所属表'), 'table 非法 → 400 含「所属表」: ' + JSON.stringify(r.error));

  // 用例3：结束早于开始 → 422 中文
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'x', table: 'work', type: 'meeting', startTime: '2026-09-30 16:00', endTime: '2026-09-30 15:00', ownerKey: 'self' }) });
  assert(r.ok === false && r.error.code === 422, 'end<start → 422: ' + JSON.stringify(r.error));

  // 用例4：正常写入 → ok:true 且 data 含 id/createdAt/updatedAt（camelCase）
  SHOULD_DUP = false;
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', title: '临时碰头', startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00', attendees: '李工', venue: '线上', note: '', ownerKey: 'self' }) });
  assert(r.ok === true && r.data && r.data.id === 11 && r.data.createdAt && r.data.updatedAt && r.data.table === 'work' && r.data.ownerKey === 'self', '正常写入 → ok:true + camelCase 新项: ' + JSON.stringify(r.data));

  // 用例5：内容重复 → 409 中文
  SHOULD_DUP = true;
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', title: '临时碰头', startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00', attendees: '李工', venue: '线上', note: '', ownerKey: 'self' }) });
  assert(r.ok === false && r.error.code === 409 && r.error.message.includes('请勿重复提交'), '重复提交 → 409 含「请勿重复提交」: ' + JSON.stringify(r.error));
  SHOULD_DUP = false;

  // 用例6：idempotencyKey 重复（内容不同，但 key 相同）→ 409 中文
  SHOULD_KEY_DUP = true;
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', title: '另一个会', startTime: '2026-10-01 10:00', endTime: '2026-10-01 11:00', ownerKey: 'self', idempotencyKey: 'same-key-001' }) });
  assert(r.ok === false && r.error.code === 409 && r.error.message.includes('请勿重复提交') && r.error.message.includes('idempotencyKey'), 'idempotencyKey 重复 → 409 含「idempotencyKey 重复」: ' + JSON.stringify(r.error));
  SHOULD_KEY_DUP = false;

  // 用例7：带 idempotencyKey 首次写入 → ok:true（验证 key 被接受、不误拦）
  r = await handler.main({ httpMethod: 'POST', body: JSON.stringify({ table: 'work', type: 'meeting', title: '带key的会', startTime: '2026-10-02 14:00', endTime: '2026-10-02 15:00', ownerKey: 'self', idempotencyKey: 'fresh-key-001' }) });
  assert(r.ok === true && r.data && r.data.id === 11, '带 idempotencyKey 首次写入 → ok:true: ' + JSON.stringify(r.data));

  // 用例8：GET 列表读取 → ok:true 且 data 为数组（验证"查数据库"读路径随 DAL 回归）
  const rg = await handler.main({ httpMethod: 'GET', queryString: 'table=work' });
  assert(rg.ok === true && Array.isArray(rg.data), 'GET /api/items → ok:true 且 data 为数组: ' + JSON.stringify(rg).slice(0, 120));

  console.log('\n本地纯逻辑测试完毕（A+B 双保险 + GET 读路径：8 用例）。');
})();
