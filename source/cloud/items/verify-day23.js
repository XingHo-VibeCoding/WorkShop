'use strict';

// WorkShop · Day 23 错误提示验证脚本（mock，不连真库）
//
// 目的：把「输入错 / 网络错 / 服务端错」三类各触发一次，证明一件事——
//       用的人看到的每一条提示都是中文人话，英文裸报错只留在服务端日志里。
//
// 运行：node verify-day23.js   （Node 18+）
// 不连真库：用 global.fetch 打桩，让它按用例抛出不同的异常。

process.env.CB_API_KEY = process.env.CB_API_KEY || 'local';

let THROW = null; // 本用例要让 fetch 抛出的异常

global.fetch = async () => {
  if (THROW) throw THROW;
  return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
};

const handler = require('./index.js');

async function call(evt) {
  const res = await handler.main(evt);
  return res && typeof res.body === 'string' ? JSON.parse(res.body) : res;
}

// 造一个"带 cause 的 fetch 失败"，形态与 Node 内置 fetch 真实失败时一致
function mkFetchError(msg, cause) {
  const e = new TypeError(msg);
  if (cause) e.cause = cause;
  return e;
}

function show(title, beforeText, r) {
  const err = r && r.error;
  console.log(`\n【${title}】`);
  console.log(`  改前 · 用户会看到 : ${beforeText}`);
  console.log(`  改后 · 用户看到   : code=${err ? err.code : '-'}  ${err ? err.message : '(无 error)'}`);
  console.log(`  改后 · 服务端日志 : 见上方 console.error 那一行（英文原文 + 分类）`);
  return err;
}

const HAS_CN = /[一-龥]/;

(async () => {
  console.log('=== Day 23 · 三类错误提示统一验证（mock，不连真库）===');

  // ————— ① 输入错 —————
  // 这类是控制器直接 return 的中文提示，本来就没有裸报错问题，今天只是纳入统一口径核对。
  let r = await call({
    httpMethod: 'POST',
    body: JSON.stringify({
      table: 'work', type: 'meeting',
      startTime: '2026-10-03 10:00', endTime: '2026-10-03 11:00', ownerKey: 'self',
    }),
  });
  let e1 = show('① 输入错：POST 缺少必填字段 title', '缺少必填字段：标题（改前本就是中文，未改动）', r);

  // ————— ② 网络错 —————
  THROW = mkFetchError('fetch failed', { code: 'ENOTFOUND' });
  r = await call({ httpMethod: 'GET', queryString: 'table=work' });
  let e2 = show('② 网络错：DNS 解析不到数据服务', 'fetch failed', r);
  THROW = null;

  // ————— ③ 服务端错 —————
  THROW = new Error('unexpected upstream failure at /v1/rdb/rest/items');
  r = await call({ httpMethod: 'GET', queryString: 'table=work' });
  let e3 = show('③ 服务端错：上游数据服务异常', 'unexpected upstream failure at /v1/rdb/rest/items', r);
  THROW = null;

  // ————— ④ 细分：鉴权失败（归服务端配置问题，但提示指向"找管理员"）—————
  THROW = new Error('query items failed: 401 unauthorized');
  r = await call({ httpMethod: 'GET', queryString: 'table=work' });
  let e4 = show('④ 鉴权错：数据服务密钥/权限没配上', 'query items failed: 401 unauthorized', r);
  THROW = null;

  // ————— 汇总断言：四条提示必须都是中文，且不含英文裸报错原文 —————
  console.log('\n=== 汇总核对 ===');
  const cases = [
    ['① 输入错', e1],
    ['② 网络错', e2],
    ['③ 服务端错', e3],
    ['④ 鉴权错', e4],
  ];
  let bad = 0;
  for (const [name, e] of cases) {
    const ok = e && HAS_CN.test(e.message);
    if (!ok) { bad++; console.error(`❌ FAIL: ${name} 提示不是中文 -> ${JSON.stringify(e)}`); }
    else console.log(`✅ PASS: ${name} → ${e.code} ${e.message}`);
  }
  const leaked = [e1, e2, e3, e4].some((e) => e && /fetch failed|ENOTFOUND|unauthorized|upstream failure/i.test(e.message));
  if (leaked) { bad++; console.error('❌ FAIL: 有英文裸报错漏到了用户提示里'); }
  else console.log('✅ PASS: 用户提示里没有残留任何英文裸报错原文');

  console.log(bad === 0 ? '\n=== 三类错误提示统一验证通过（4 条全中文）===' : `\n=== 有 ${bad} 项未通过 ===`);
  if (bad !== 0) process.exitCode = 1;
})();
