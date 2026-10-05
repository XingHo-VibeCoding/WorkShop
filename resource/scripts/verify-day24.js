// Day 24｜本地直调验证（不经过 HTTP 网关）
// ------------------------------------------------------------------
// 目的：判定「错误响应 HTTP 恒为 200」这个 Bug 究竟出在哪一层——
//   ① 云函数代码（index.js 返回时就写错了 statusCode）
//   ② HTTP 网关（网关把函数给的 statusCode 改写成 200）
// 做法：在本地直接 require 云函数入口 exports.main，喂一个构造好的 event，
//       看函数自己返回的 statusCode 是什么。本地返回 200 ⇒ 锅在代码层，网关无辜。
//
// 用法：
//   node resource/scripts/verify-day24.js after    // 用当前工作区代码（修复后）
//   node resource/scripts/verify-day24.js before   // 用 git HEAD 版本（修复前），跑完自动删临时文件
// 两份输出分别落盘 resource/day24-verify-local-before.log / -after.log，供前后对照。
// ------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MODE = (process.argv[2] || 'after').toLowerCase();
const REPO = path.resolve(__dirname, '../..');
const ITEMS_DIR = path.join(REPO, 'source', 'cloud', 'items');

// 输出同时进日志（落盘用）
const LOG = [];
function out(s = '') { LOG.push(s); console.log(s); }

let fnPath = path.join(ITEMS_DIR, 'index.js');
let tmpFile = null;
if (MODE === 'before') {
  // 修复前版本 = git HEAD 里的那一份。由外部先导出（沙箱内 execSync 起子进程会被拦）：
  //   git show HEAD:source/cloud/items/index.js > source/cloud/items/index.__before_day24.js
  // 存在就直接用；不存在再尝试自己导出；都没有则报错提示，绝不静默拿当前代码冒充 before。
  tmpFile = path.join(ITEMS_DIR, 'index.__before_day24.js');
  if (!fs.existsSync(tmpFile)) {
    try {
      const old = execSync('git show HEAD:source/cloud/items/index.js', { cwd: REPO, encoding: 'utf8' });
      fs.writeFileSync(tmpFile, old, 'utf8');
    } catch (e) {
      console.error('无法取得修复前版本，请先执行：git show HEAD:source/cloud/items/index.js > source/cloud/items/index.__before_day24.js');
      process.exit(1);
    }
  }
  fnPath = tmpFile;
}

const fn = require(fnPath);

async function call(method, query = {}, body = null, path = '/api/items') {
  const event = {
    httpMethod: method,
    queryStringParameters: query,
    body: body == null ? null : JSON.stringify(body),
    headers: { origin: 'http://localhost:8080', 'Content-Type': 'application/json' },
    path,
  };
  const res = await fn.main(event);
  return {
    statusCode: res.statusCode,
    body: (() => { try { return JSON.parse(res.body); } catch (e) { return res.body; } })(),
    hasCors: !!(res.headers && res.headers['Access-Control-Allow-Origin']),
  };
}

function show(name, r) {
  const b = r.body || {};
  const code = b.error ? b.error.code : (b.ok ? 200 : '-');
  out(`[${name}] 函数返回 statusCode=${r.statusCode} | body.error.code=${code} | CORS头=${r.hasCors}`);
  out(`         ${JSON.stringify(b).slice(0, 150)}`);
}

(async () => {
  out(`# Day 24 本地直调验证 · 轮次=${MODE} · ${new Date().toISOString()}`);
  out('（此脚本不经过 HTTP 网关，看到的就是云函数自己返回的 statusCode）\n');

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const f = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
  const s = f(d), e = f(new Date(d.getTime() + 30 * 60000));

  // 1) 正常读取（基线：确认链路通）
  show('GET 正常读取', await call('GET', { start: '2026-01-01 00:00', end: '2026-12-31 23:59' }));

  // 2) 空标题（应 400）
  show('POST 空标题', await call('POST', {}, {
    table: 'work', type: 'meeting', title: '', startTime: s, endTime: e, ownerKey: 'self',
    idempotencyKey: 'day24-verify-empty-' + Date.now(),
  }));

  // 3) 非法 id 的 PATCH（应 400）
  show('PATCH 非法 id', await call('PATCH', { id: 'u1718abc' }, { title: 'x' }));

  // 4) DELETE 不带 confirm（应 400）
  show('DELETE 缺 confirm', await call('DELETE', { id: '999999' }));

  // 5) DELETE 不存在的 id（应 404）
  show('DELETE 不存在 id', await call('DELETE', { id: '999999', confirm: 'true' }));

  out('');
  out('>> 判读：若上面 statusCode 全是 200、而 body.error.code 是 400/404，');
  out('   说明「锅在云函数代码」——函数自己就只给了 200，网关没有改写。');

  const outPath = path.resolve(__dirname, '..', `day24-verify-local-${MODE}.log`);
  fs.writeFileSync(outPath, LOG.join('\n') + '\n', 'utf8');
  console.log(`\n>> 证据已写入：${outPath}`);
  if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ } }
})().catch((e) => { console.error('本地验证异常：', e.message); process.exit(1); });
