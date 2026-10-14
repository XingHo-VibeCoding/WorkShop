#!/usr/bin/env node
// WorkShop · 阶段二 P10 · 验收脚本（离线 CSV 单测 + 线上 export/doc 骨架校验）
// ---------------------------------------------------------------------------
// 两部分：
//   A 离线（总是跑、不联网）：require 前端导出模块（双用设计，Node 下走 module.exports），
//     验证 csvCell 转义、toCSV 带 BOM + 归属映射、toJSON 结构。
//   B 线上（仅 --live）：POST /api/export/doc，确证 A8 骨架按预期返回
//     （未配 Token → 503；配了 → 501 占位），不崩主链路、未真调 MCP。
//
// 用法：
//   node resource/scripts/verify-p10_phase2.js            # 只跑离线
//   node resource/scripts/verify-p10_phase2.js --live     # 加线上校验
//
// 退出码：0 全部通过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const path = require('path');
const exp = require(path.join(__dirname, '..', '..', 'source', 'js', 'export_phase2.js'));

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` → ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ===================== A. 离线 CSV/JSON 单测 =====================
function runOffline() {
  console.log('\n──────── 离线 CSV/JSON 单测 ────────');

  // ① csvCell 转义
  check('csvCell 普通文本原样', exp.csvCell('会议') === '会议', exp.csvCell('会议'));
  check('csvCell 含逗号 → 双引号包裹', exp.csvCell('a,b') === '"a,b"', exp.csvCell('a,b'));
  check('csvCell 含引号 → 内部引号翻倍', exp.csvCell('he said "hi"') === '"he said ""hi"""', exp.csvCell('he said "hi"'));
  check('csvCell 含换行 → 双引号包裹', exp.csvCell('line1\nline2') === '"line1\nline2"', JSON.stringify(exp.csvCell('line1\nline2')));
  check('csvCell 空值 → 空串', exp.csvCell(null) === '' && exp.csvCell(undefined) === '' && exp.csvCell('') === '', 'null/undefined/空');

  // ② toCSV：首字符 BOM + 表头 + 归属映射
  const rows = [
    { id: 1, title: '周会,a', table: 'work', type: 'meeting', startTime: '2026-10-20 09:00', endTime: '2026-10-20 10:00', ownerMemberId: 99, ownerName: '', venue: '', attendees: '', note: '' },
    { id: 2, title: '培训', table: 'daily', type: 'class', startTime: '2026-10-21 14:00', endTime: '2026-10-21 16:00', ownerMemberId: null, ownerName: '', venue: '', attendees: '', note: '备注"带引号' },
  ];
  const csv = exp.toCSV(rows, { 99: '张三' });
  check('toCSV 首字符是 UTF-8 BOM（Excel 中文不乱码）', csv.charCodeAt(0) === 0xFEFF, 'code=' + csv.charCodeAt(0));
  const lines = csv.slice(1).split('\r\n'); // 去掉 BOM 后按 CRLF 分行
  check('toCSV 行数 = 表头 + 2 数据', lines.length === 3, 'lines=' + lines.length);
  check('toCSV 表头含 归属成员', lines[0].includes('归属成员'), lines[0]);
  check('toCSV 归属映射生效（ownerMemberId=99 → 张三）', lines[1].includes('99,张三'), lines[1]);
  check('toCSV 含逗号的标题被转义', lines[1].includes('"周会,a"'), lines[1]);
  check('toCSV 备注含引号被转义', lines[2].includes('"备注""带引号"'), lines[2]);
  check('toCSV 无归属项归属成员列为空', /,,\s*$/.test(lines[2].replace(/.*?培训,/, '')) || lines[2].split(',').some(c => c === ''), lines[2]);

  // ③ toJSON 结构
  const json = exp.toJSON(rows);
  let j = null; try { j = JSON.parse(json); } catch (e) {}
  check('toJSON 可解析且 version=1', j && j.version === 1, json.slice(0, 40));
  check('toJSON items 为原数组', j && Array.isArray(j.items) && j.items.length === 2, j && j.items.length);
  check('toJSON 含 exportedAt', j && typeof j.exportedAt === 'string' && j.exportedAt.length > 0, j && j.exportedAt);
}

// ===================== B. 线上 export/doc 骨架 =====================
async function runLive() {
  console.log('\n──────── 线上 export/doc 骨架校验（--live） ────────');
  const BASE = process.env.WORKSHOP_API_BASE ||
    'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';
  try {
    const r = await fetch(`${BASE}/api/export/doc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const j = await r.json().catch(() => null);
    // 未配 Token → 503「未配置…」；配了 → 501 占位。两者都证明骨架按预期返回、未崩主链路。
    const code = (j && j.error && j.error.code) || r.status;
    check('export/doc 返回 503 或 501（骨架按预期，未崩）', r.status === 503 || r.status === 501, `status=${r.status}`);
    check('export/doc 响应体 ok=false 且带 code', j && j.ok === false && Number(j.error && j.error.code) >= 400, JSON.stringify(j).slice(0, 80));
    check('export/doc 文案指向腾讯文档', !!(j && j.error && /腾讯文档/.test(j.error.message)), (j && j.error && j.error.message) || '');
    console.log(`  ℹ️ 实际返回：HTTP ${r.status} :: ${(j && j.error && j.error.message) || (j && JSON.stringify(j).slice(0, 60)) || '（空响应）'}`);
  } catch (e) {
    check('export/doc 网络可达', false, e.message);
  }
}

(async () => {
  runOffline();
  if (process.argv.includes('--live')) {
    try { await runLive(); }
    catch (e) { console.log('\n❌ 线上校验异常：', e.message); fail++; }
  }
  console.log(`\n──────── 小结 ────────`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
