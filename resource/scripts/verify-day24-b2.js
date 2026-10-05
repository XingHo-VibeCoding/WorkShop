// Day 24｜PATCH 时间区间校验验证（含 B2 与"零时长禁止"契约变更）
// ------------------------------------------------------------------
// 校验环节不碰数据库 —— 所以用 mock 顶掉数据访问层 db.js，让 findItemById 返回一条固定的
// 原记录、updateItem 直接回成功，就能在本地完整验证"哪些改动该放行、哪些该拒绝"。
//
// 【Day 24 契约变更】零时长（end == start）由"允许"改为"拒绝"（POST/PATCH 都要拦）。
// 结果：B2 那个"格式不一致导致零时长被误判"的修复，在禁止零时长后**不再产生可观测的行为差异**
// （两版都会拒绝零时长）。B2 修复保留，因为它保证的是"比较口径一致"，避免将来再出边界 Bug。
// 所以本脚本现在的职责是：① 零时长必须拒绝 ② 正常改动（含 +30 分钟）不得被误伤。
//
// 用法：
//   git show HEAD:source/cloud/items/index.js > source/cloud/items/index.__before_day24.js
//   node resource/scripts/verify-day24-b2.js before
//   node resource/scripts/verify-day24-b2.js after
//
// 原记录（mock）：startTime='2026-10-04 14:43'  endTime='2026-10-04 15:13'
// ------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const MODE = (process.argv[2] || 'after').toLowerCase();
const REPO = path.resolve(__dirname, '../..');
const ITEMS_DIR = path.join(REPO, 'source', 'cloud', 'items');

const LOG = [];
function out(s = '') { LOG.push(s); console.log(s); }

let fnPath = path.join(ITEMS_DIR, 'index.js');
let tmpFile = null;
if (MODE === 'before') {
  tmpFile = path.join(ITEMS_DIR, 'index.__before_day24.js');
  if (!fs.existsSync(tmpFile)) {
    console.error('缺少修复前版本，请先执行：git show HEAD:source/cloud/items/index.js > source/cloud/items/index.__before_day24.js');
    process.exit(1);
  }
  fnPath = tmpFile;
}

// —— 用 mock 顶掉数据访问层（必须在 require index.js 之前替换 cache）——
const dbPath = require.resolve(path.join(ITEMS_DIR, 'db.js'));
require(dbPath);
const OLD_START = '2026-10-04 14:43';
const OLD_END = '2026-10-04 15:13';
require.cache[dbPath].exports = {
  queryItems: async () => [],
  findDuplicate: async () => false,
  insertItem: async () => ({ item: {} }),
  findItemById: async (id) => ({
    id: Number(id), title: '原标题', type: 'meeting', table: 'work',
    startTime: OLD_START, endTime: OLD_END, week: '2026-W40',
    ownerKey: 'self', status: 'scheduled', createdAt: OLD_START, updatedAt: OLD_START,
  }),
  updateItem: async (id, patch) => ({
    item: {
      id: Number(id), title: patch.title || '原标题', type: 'meeting', table: 'work',
      startTime: patch.start_time ? String(patch.start_time).slice(0, 16) : OLD_START,
      endTime: patch.end_time ? String(patch.end_time).slice(0, 16) : OLD_END,
      week: patch.week || '2026-W40', ownerKey: 'self', status: 'scheduled',
    },
  }),
  deleteItem: async () => ({ deleted: {} }),
};

const fn = require(fnPath);

async function call(method, query = {}, body = null) {
  const res = await fn.main({
    httpMethod: method,
    queryStringParameters: query,
    body: body == null ? null : JSON.stringify(body),
    headers: { origin: 'http://localhost:8080', 'Content-Type': 'application/json' },
    path: '/api/items',
  });
  let b = null;
  try { b = JSON.parse(res.body); } catch (e) { b = null; }
  return { statusCode: res.statusCode, body: b };
}

let pass = 0, fail = 0;
async function case_run(name, body, expectOk) {
  const r = await call('PATCH', { id: '12' }, body);
  const ok = !!(r.body && r.body.ok);
  const code = r.body && r.body.error ? r.body.error.code : (ok ? 200 : '-');
  const good = ok === expectOk;
  good ? pass++ : fail++;
  out(`${good ? '✅' : '❌'} [${name}] 期望 ${expectOk ? '成功' : '拒绝'} → 实际 HTTP ${r.statusCode} / code ${code}`);
  out(`         ${JSON.stringify(r.body).slice(0, 160)}`);
}

(async () => {
  out(`# Day 24 · B2 余力加练验证 · 轮次=${MODE}`);
  out(`# 原记录（mock）：${OLD_START} ~ ${OLD_END}`);
  out(`# 契约：endTime 须 **晚于** startTime（Day 24 变更，零时长一律拒绝）\n`);

  // ① 零时长：把开始时间改成与结束时间同一分钟 —— 契约变更后必须拒绝
  await case_run('① 零时长 startTime=原endTime', { startTime: OLD_END }, false);
  // ② 真倒挂：开始时间晚于结束时间 —— 必须拦住
  await case_run('② 真倒挂 startTime 晚于 end', { startTime: '2026-10-04 16:00' }, false);
  // ③ 改结束时间早于开始 —— 必须拦住
  await case_run('③ endTime 早于 start', { endTime: '2026-10-04 14:00' }, false);
  // ④ 基线：只改标题 —— 必须放行
  await case_run('④ 只改标题（基线）', { title: '新标题' }, true);
  // ⑤ 防误伤：把结束时间往后推 30 分钟（正常改动）—— 必须放行
  await case_run('⑤ endTime 后推 30 分钟', { endTime: '2026-10-04 15:43' }, true);

  out('');
  out(`# 汇总（${MODE}）：通过 ${pass} / 失败 ${fail}`);
  out('# 预期：① ②③ 拒绝（零时长/倒挂），④⑤ 放行（正常改动不被误伤）');
  out('# 注：契约变更前 ① 的期望是"放行"，变更后改为"拒绝"，故本脚本判定已同步反转。');

  const outPath = path.resolve(__dirname, '..', `day24-b2-${MODE}.log`);
  fs.writeFileSync(outPath, LOG.join('\n') + '\n', 'utf8');
  console.log(`\n>> 证据已写入：${outPath}`);
  if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ } }
})().catch((e) => { console.error('验证异常：', e.message); process.exit(1); });
