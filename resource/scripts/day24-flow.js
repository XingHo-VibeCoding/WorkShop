// Day 24｜WorkShop 核心流程测试脚本
// ------------------------------------------------------------------
// 用途：把「resource/DAY24_核心流程测试清单.md」里的六步链路 + 刁钻用例跑一遍，
//       输出可复制的证据，落盘 resource/day24-before.log（修复前）/ day24-after.log（修复后）。
// 两遍用完全相同的代码与判定标准，只有命令行参数不同，保证前后可比。
//
// 用法：
//   node resource/scripts/day24-flow.js before    // 修复前
//   node resource/scripts/day24-flow.js after     // 修复后
//
// 说明：脚本直打线上接口（Node 18+ 自带 fetch，无需装依赖）；会真实写入/修改/删除数据，
//       但只操作本脚本自己建的标题带「Day24-」前缀的临时记录。
// ------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');

const MODE = (process.argv[2] || 'before').toLowerCase();
const API_BASE = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';

const LINES = [];
function log(s = '') { LINES.push(s); console.log(s); }
function nowStr() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 清单 §0.1 的映射函数（与 source/check.html 的 toItemPayload 同形状）
const TYPE_MAP = { meeting: 'meeting', class: 'class', course: 'class', trip: 'trip', travel: 'trip', sport: 'sport', life: 'life', other: 'other', pending: 'pending' };
function toItemPayload(rec) {
  return {
    table: rec.kind === 'daily' ? 'daily' : 'work',
    type: TYPE_MAP[rec.type] || 'other',
    title: String(rec.title || ''),
    startTime: rec.start,
    endTime: rec.end,
    attendees: rec.people || '',
    venue: rec.place || '',
    note: rec.note || '',
    ownerKey: rec.owner || 'self',
    idempotencyKey: rec.reqId || ('day24-' + Date.now()),
  };
}

async function api(method, urlPath, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const t0 = Date.now();
  const r = await fetch(API_BASE + urlPath, opt);
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { json = null; }
  return { status: r.status, json, raw, ms: Date.now() - t0 };
}
const msg = (r) => (r.json && r.json.error && r.json.error.message) || (r.json && r.json.message) || String(r.raw || '').slice(0, 200);
const data = (r) => (r.json && r.json.data) || null;
// 契约语义错误码：错误响应的 code 在 body 的 error.code 里（契约 §一 同时要求 HTTP 也是 4xx/5xx）
const ecode = (r) => (r.json && r.json.error && r.json.error.code) || null;

let pass = 0, fail = 0;
function judge(step, ok, detail) {
  log(`${ok ? '✅' : '❌'} [${step}] ${detail}`);
  ok ? pass++ : fail++;
  return ok;
}
function note(step, detail) { log(`ℹ️  [${step}] ${detail}`); }

// 今天 HH:mm 起止（+30 分钟）
function slot(offsetMin = 0) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + offsetMin);
  const p = (n) => String(n).padStart(2, '0');
  const f = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
  const s = new Date(d), e = new Date(d); e.setMinutes(e.getMinutes() + 30);
  return { start: f(s), end: f(e), day: f(s).slice(0, 10) };
}
const rnd = () => Math.random().toString(36).slice(2, 6);
// 'YYYY-MM-DD HH:mm' 加 n 分钟（用例 E10 用：验证"正常改时间"不会被区间校验误伤）
function addMin(t, n) {
  const [d, hm] = String(t).split(' ');
  const [h, m] = hm.split(':').map(Number);
  const dt = new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  dt.setMinutes(dt.getMinutes() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

async function main() {
  log(`# Day 24 核心流程测试 · 轮次=${MODE} · 时间=${nowStr()}`);
  log(`# API_BASE=${API_BASE}`);
  log('');

  // ============ T2 读取 ============
  log('--- T2 读取：GET /api/items（本周范围）---');
  const wk = weekRange();
  const r2 = await api('GET', `/api/items?start=${encodeURIComponent(wk.start)}&end=${encodeURIComponent(wk.end)}`);
  log(`    HTTP ${r2.status}（${r2.ms}ms） ${r2.raw.slice(0, 160)}`);
  judge('T2', r2.status === 200 && r2.json && r2.json.ok === true && Array.isArray(r2.json.data),
    `读取本周数据：HTTP ${r2.status}，data 条数=${Array.isArray(r2.json && r2.json.data) ? r2.json.data.length : 'N/A'}`);

  // ============ T3 写入 ============
  log('');
  log('--- T3 写入：POST /api/items ---');
  const s0 = slot(60);
  const title0 = `Day24-${MODE}-${rnd()}`;
  const reqId0 = `day24-${MODE}-${Date.now()}`;
  const rec0 = { kind: 'work', type: 'meeting', title: title0, start: s0.start, end: s0.end, people: '脚本', place: '线上', note: `Day 24 ${MODE} 测试`, owner: 'self', reqId: reqId0 };
  const p3 = toItemPayload(rec0);
  log(`    请求体=${JSON.stringify(p3)}`);
  const r3 = await api('POST', '/api/items', p3);
  log(`    HTTP ${r3.status}（${r3.ms}ms） ${r3.raw.slice(0, 200)}`);
  const newId = r3.json && r3.json.data && r3.json.data.id;
  judge('T3', r3.status === 200 && r3.json && r3.json.ok === true && newId != null,
    `写入返回 id=${newId}（HTTP ${r3.status}）`);
  if (newId == null) { log('!! 写入失败，后续步骤无法继续'); return finish(); }

  // ============ T4 刷新确认 ============
  log('');
  log('--- T4 刷新确认：GET 同一天，找新 id ---');
  const r4 = await api('GET', `/api/items?start=${encodeURIComponent(s0.day + ' 00:00')}&end=${encodeURIComponent(s0.day + ' 23:59')}`);
  const hit4 = (data(r4) || []).find((it) => String(it.id) === String(newId));
  judge('T4', !!hit4 && hit4.title === title0,
    `读回：${hit4 ? `找到「${hit4.title}」${hit4.startTime}~${hit4.endTime}` : '未找到该 id'}`);

  // ============ T5 修改 ============
  log('');
  log('--- T5 修改：PATCH /api/items?id=<id>（改标题）---');
  const title1 = title0 + '-改';
  const r5 = await api('PATCH', `/api/items?id=${newId}`, { title: title1 });
  log(`    HTTP ${r5.status}（${r5.ms}ms） ${r5.raw.slice(0, 200)}`);
  const hit5 = (data(await api('GET', `/api/items?start=${encodeURIComponent(s0.day + ' 00:00')}&end=${encodeURIComponent(s0.day + ' 23:59')}`)) || [])
    .find((it) => String(it.id) === String(newId));
  judge('T5', r5.status === 200 && !!hit5 && hit5.title === title1,
    `改标题后读回：${hit5 ? `「${hit5.title}」` : '未找到'}（HTTP ${r5.status}）`);

  // ============ E8 刁钻：把开始时间改成与结束时间相同（零时长）============
  // 【Day 24 契约变更】零时长已不允许，此用例判定随之反转：期望 422（此前期望 200）。
  log('');
  log('--- E8 刁钻：PATCH 只改 startTime = 原 endTime（零时长，现应拒绝）---');
  const endMin = hit5 ? hit5.endTime : s0.end;
  const r8 = await api('PATCH', `/api/items?id=${newId}`, { startTime: endMin });
  log(`    HTTP ${r8.status}（${r8.ms}ms） ${r8.raw.slice(0, 300)}`);
  judge('E8', ecode(r8) === 422,
    `零时长修改（开始=结束=${endMin}）：契约改后应 422 拒绝，实际 ${r8.json && r8.json.ok ? '被放行（❌不该）' : 'code ' + ecode(r8) + '｜' + msg(r8)}`);

  // ============ E10 防误伤：把结束时间往后推 30 分钟（正常改动，应放行）============
  log('');
  log('--- E10 防误伤：PATCH 只改 endTime = 原 endTime + 30 分钟 ---');
  const endPlus30 = addMin(endMin, 30);
  const r10 = await api('PATCH', `/api/items?id=${newId}`, { endTime: endPlus30 });
  log(`    HTTP ${r10.status}（${r10.ms}ms） ${r10.raw.slice(0, 200)}`);
  judge('E10', !!(r10.json && r10.json.ok === true),
    `正常改结束时间到 ${endPlus30}：应放行 200，实际 ${r10.json && r10.json.ok ? '成功' : 'code ' + ecode(r10) + '｜' + msg(r10)}`);

  // ============ T6 删除 ============
  log('');
  log('--- T6 删除：DELETE /api/items?id=<id>&confirm=true ---');
  const r6 = await api('DELETE', `/api/items?id=${newId}&confirm=true`);
  log(`    HTTP ${r6.status}（${r6.ms}ms） ${r6.raw.slice(0, 200)}`);
  const after6 = data(await api('GET', `/api/items?start=${encodeURIComponent(s0.day + ' 00:00')}&end=${encodeURIComponent(s0.day + ' 23:59')}`)) || [];
  const gone = !after6.some((it) => String(it.id) === String(newId));
  judge('T6', r6.status === 200 && gone, `删除后读回：${gone ? '已消失' : '仍在列表'}（HTTP ${r6.status}）`);

  // ============ E1 空标题 ============
  log('');
  log('--- E 系列：刁钻输入 ---');
  const s1 = slot(90);
  const rE1 = await api('POST', '/api/items', toItemPayload({ kind: 'work', type: 'meeting', title: '', start: s1.start, end: s1.end, reqId: 'day24-e1-' + Date.now() }));
  log(`    E1 空标题 → HTTP ${rE1.status} / body code ${ecode(rE1)} · ${msg(rE1).slice(0, 80)}`);
  judge('E1', ecode(rE1) === 400, `空标题：body code 应为 400，实际 ${ecode(rE1)}`);
  judge('B1', rE1.status === 400,
    `★错误响应 HTTP 状态应为 4xx（契约 §一：错误响应 HTTP 4xx/5xx），实际 HTTP ${rE1.status}`);

  // ============ E2 超长标题（500 字；契约≤100 字，库 VARCHAR(200)）============
  const longTitle = '超'.repeat(500);
  const rE2 = await api('POST', '/api/items', toItemPayload({ kind: 'work', type: 'meeting', title: longTitle, start: s1.start, end: s1.end, reqId: 'day24-e2-' + Date.now() }));
  log(`    E2 500字标题 → HTTP ${rE2.status} / body code ${ecode(rE2)} · ${msg(rE2).slice(0, 120)}`);
  judge('E2', ecode(rE2) === 400 || ecode(rE2) === 422,
    `超长标题：body code 应为 400/422 且提示中文，实际 ${ecode(rE2)}`);

  // ============ E3 快速连点（同一幂等键连发 3 次）============
  const s2 = slot(120);
  const reqId3 = 'day24-e3-' + Date.now();
  const rec3 = { kind: 'work', type: 'meeting', title: `Day24-${MODE}-dup-${rnd()}`, start: s2.start, end: s2.end, reqId: reqId3 };
  const codes = [];
  let createdId = null;
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/items', toItemPayload(rec3));
    codes.push(r.json && r.json.ok ? 200 : ecode(r));
    if (r.status === 200 && r.json && r.json.data) createdId = r.json.data.id;
    log(`    E3 第 ${i + 1} 次 → HTTP ${r.status} / body code ${codes[i]} · ${msg(r).slice(0, 60)}`);
  }
  judge('E3', codes[0] === 200 && codes[1] === 409 && codes[2] === 409,
    `连点三次 body code ${codes.join('/')}（期望 200/409/409）`);

  // ============ E4 非法时间区间 ============
  const s3 = slot(150);
  const rE4 = await api('POST', '/api/items', toItemPayload({ kind: 'work', type: 'meeting', title: `Day24-${MODE}-bad-${rnd()}`, start: s3.end, end: s3.start, reqId: 'day24-e4-' + Date.now() }));
  log(`    E4 结束早于开始 → HTTP ${rE4.status} / body code ${ecode(rE4)} · ${msg(rE4).slice(0, 80)}`);
  judge('E4', ecode(rE4) === 422, `非法区间：body code 应 422，实际 ${ecode(rE4)}`);

  // ============ E9 零时长：POST start == end（契约变更后应 422）============
  const rE9 = await api('POST', '/api/items', toItemPayload({
    kind: 'work', type: 'meeting', title: `Day24-${MODE}-zero-${rnd()}`,
    start: s3.start, end: s3.start, reqId: 'day24-e9-' + Date.now(),
  }));
  log(`    E9 零时长 POST（start==end） → HTTP ${rE9.status} / body code ${ecode(rE9)} · ${msg(rE9).slice(0, 80)}`);
  judge('E9', ecode(rE9) === 422, `零时长新建：body code 应 422，实际 ${ecode(rE9)}`);

  // ============ E5 非法 id ============
  const rE5 = await api('PATCH', '/api/items?id=u1718abc', { title: 'x' });
  log(`    E5 非法 id → HTTP ${rE5.status} / body code ${ecode(rE5)} · ${msg(rE5).slice(0, 80)}`);
  judge('E5', ecode(rE5) === 400, `非法 id：body code 应 400，实际 ${ecode(rE5)}`);

  // ============ E6 删除不带 confirm ============
  const rE6 = await api('DELETE', createdId ? `/api/items?id=${createdId}` : '/api/items?id=1');
  log(`    E6 不带 confirm → HTTP ${rE6.status} / body code ${ecode(rE6)} · ${msg(rE6).slice(0, 80)}`);
  judge('E6', ecode(rE6) === 400, `缺 confirm：body code 应 400，实际 ${ecode(rE6)}`);

  // ============ E7 重复删除 ============
  const rE7 = await api('DELETE', `/api/items?id=${newId}&confirm=true`);
  log(`    E7 删已删的 id=${newId} → HTTP ${rE7.status} / body code ${ecode(rE7)} · ${msg(rE7).slice(0, 80)}`);
  judge('E7', ecode(rE7) === 404, `重复删：body code 应 404，实际 ${ecode(rE7)}`);

  // ============ 清理：删掉 E3 建的那条 ============
  if (createdId) {
    const rc = await api('DELETE', `/api/items?id=${createdId}&confirm=true`);
    note('清理', `删除 E3 建的记录 id=${createdId} → HTTP ${rc.status}`);
  }

  finish();
}

function weekRange() {
  const d = new Date(); const mon = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mon); d.setHours(0, 0, 0, 0);
  const end = new Date(d); end.setDate(end.getDate() + 6); end.setHours(23, 59, 59);
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
  return { start: f(d), end: f(end) };
}

function finish() {
  log('');
  log(`# 汇总（${MODE}）：通过 ${pass} / 失败 ${fail}`);
  const outPath = path.resolve(__dirname, '..', `day24-${MODE}.log`);
  fs.writeFileSync(outPath, LINES.join('\n') + '\n', 'utf8');
  console.log(`\n>> 证据已写入：${outPath}`);
}

main().catch((e) => { log('!! 脚本异常：' + e.message); finish(); });
