'use strict';

// WorkShop · 阶段二 P6-② · 登录 / 校验接口 本地自测
// ---------------------------------------------------------------------------
// 目的：在部署之前，把「登录 / 校验」这两条新路径在本地跑一遍，含**故意弄坏**的用例
//       （错口令、篡改签名、过期令牌、没配密钥）—— 上线前先证明它是按设计拒绝的。
//
// 为什么能本地跑：db.findMemberByName 被替换成一张内存假表（见下方 FAKE），
//   不动真实数据库；其余代码（校验、签名、错误翻译、HTTP 状态推导）全是线上同一份。
//   这是 Day 25「故意弄坏验证法」的延续：证明检查项真的会 FAIL，而不是恒真。
//
// 用法：node resource/scripts/verify-auth-endpoints_phase2.js
// 退出码：0 = 全通过，1 = 有 FAIL
// ---------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'source', 'cloud', 'items', 'db.js');
const IDENTITY_PATH = path.join(ROOT, 'source', 'cloud', 'items', 'identity_phase2.js');
const ERRORS_PATH = path.join(ROOT, 'source', 'cloud', 'items', 'errors.js');
const INDEX_PATH = path.join(ROOT, 'source', 'cloud', 'items', 'index.js');

// ★ 必须在 require 之前设好：identity_phase2.js 在加载时就读这个环境变量
const SECRET = 'local-test-secret-do-not-use-in-prod';
process.env.WORKSHOP_AUTH_SECRET = SECRET;

const identity = require(IDENTITY_PATH);

// ————— 内存假成员表 —————
const SALT_A = crypto.randomBytes(16).toString('hex');
const SALT_B = crypto.randomBytes(16).toString('hex');
const PASS_A = 'correct horse battery';
const FAKE = {
  张三: {
    id: 1,
    display_name: '张三',
    role: 'admin',
    border_color: '#2F6FED',
    meeting_no: '123456789',
    meeting_url: 'https://example.com/m/1',
    note: '测试成员',
    salt: SALT_A,
    identity_key: identity.hashPasscode(PASS_A, SALT_A),
  },
  // 未设置凭据的成员：salt/identity_key 为空 → 任何口令都必须被拒
  未激活: { id: 2, display_name: '未激活', role: 'member', salt: '', identity_key: null },
};

const db = require(DB_PATH);
db.findMemberByName = async (name) => FAKE[String(name || '').trim()] || null;

const index = require(INDEX_PATH);

// ————— 断言小工具 —————
let pass = 0, fail = 0;
const fails = [];
function check(id, desc, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${id} ${desc}`); }
  else { fail++; fails.push(id); console.log(`  ❌ ${id} ${desc}${detail ? '  → ' + detail : ''}`); }
}

async function call(event) {
  const res = await index.main(event);
  let body = {};
  try { body = JSON.parse(res.body); } catch (e) { /* 空响应 */ }
  return { status: res.statusCode, body, raw: res.body || '' };
}

function mkEvent(over = {}) {
  return {
    httpMethod: 'POST',
    path: '/api/auth/login',
    headers: { origin: 'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com' },
    ...over,
  };
}

function loginBody(name, passcode) {
  return mkEvent({ body: JSON.stringify({ name, passcode }) });
}

(async function main() {
  console.log('\n=== P6-② 登录接口（POST /api/auth/login）===\n');

  // —— A. 入参校验 ——
  let r = await call(loginBody('', PASS_A));
  check('A1', '缺成员名 → 400 + 中文「缺少必填字段：成员名称」',
    r.status === 400 && r.body.error && /缺少必填字段：成员名称/.test(r.body.error.message),
    `${r.status} ${(r.body.error || {}).message}`);

  r = await call(loginBody('张三', ''));
  check('A2', '缺口令 → 400 + 中文「缺少必填字段：口令」',
    r.status === 400 && /缺少必填字段：口令/.test((r.body.error || {}).message || ''),
    `${r.status} ${(r.body.error || {}).message}`);

  // —— B. 拒绝路径（★ 故意弄坏）——
  r = await call(loginBody('查无此人', 'whatever'));
  check('B1', '成员不存在 → 401「口令无效」（★不泄露该成员是否存在）',
    r.status === 401 && r.body.error.message === identity.MSG.INVALID,
    `${r.status} ${(r.body.error || {}).message}`);

  r = await call(loginBody('张三', 'wrong-password'));
  check('B2', '口令错误 → 401「口令无效」',
    r.status === 401 && r.body.error.message === identity.MSG.INVALID,
    `${r.status} ${(r.body.error || {}).message}`);

  r = await call(loginBody('未激活', 'any'));
  check('B3', '成员未设凭据（salt 空）→ 401，不是 500',
    r.status === 401 && r.body.error.message === identity.MSG.INVALID,
    `${r.status} ${(r.body.error || {}).message}`);

  // B1 与 B2 文案必须一模一样，否则就能枚举成员
  const m1 = (await call(loginBody('查无此人', 'x'))).body.error.message;
  const m2 = (await call(loginBody('张三', 'x'))).body.error.message;
  check('B4', '「不存在」与「口令错」文案完全一致（防账号枚举）', m1 === m2, `${m1} vs ${m2}`);

  // —— C. 成功路径 ——
  r = await call(loginBody('张三', PASS_A));
  const token = r.body && r.body.data && r.body.data.token;
  check('C1', '正确口令 → 200 + 拿到令牌', r.status === 200 && typeof token === 'string' && token.includes('.'),
    `${r.status} ${(r.body.error || {}).message || ''}`);

  const mem = (r.body && r.body.data && r.body.data.member) || {};
  check('C2', '返回公开成员信息（id / displayName / role / borderColor）',
    mem.id === 1 && mem.displayName === '张三' && mem.role === 'admin' && mem.borderColor === '#2F6FED',
    JSON.stringify(mem));

  check('C3', '★响应里不含 salt / identity_key / 明文口令（凭据零出站）',
    !/salt/i.test(r.raw) && !/identity_key/i.test(r.raw) && !r.raw.includes(PASS_A) && !r.raw.includes(SALT_A),
    r.raw.slice(0, 120));

  check('C4', '令牌有效期随响应回传（expiresInDays = 7）',
    r.body.data.expiresInDays === identity.TOKEN_TTL_DAYS, String(r.body.data.expiresInDays));

  console.log('\n=== P6-② 校验接口（/api/auth/verify）===\n');

  // —— D. 校验路径 ——
  r = await call(mkEvent({ httpMethod: 'POST', path: '/api/auth/verify', headers: { ...mkEvent().headers, 'X-Member-Token': token } }));
  check('D1', '有效令牌 → 200 + 验回身份（含 id / displayName / role）',
    r.status === 200 && r.body.data.member.id === 1 && r.body.data.member.displayName === '张三',
    `${r.status} ${r.raw.slice(0, 120)}`);

  const badSig = token.slice(0, token.lastIndexOf('.')) + '.' + 'f'.repeat(64);
  r = await call(mkEvent({ httpMethod: 'POST', path: '/api/auth/verify', headers: { ...mkEvent().headers, 'X-Member-Token': badSig } }));
  check('D2', '★篡改签名 → 401「身份已失效」（★不是 500 服务不可用）',
    r.status === 401 && r.body.error.message === identity.MSG.TOKEN_INVALID,
    `${r.status} ${(r.body.error || {}).message}`);

  const payloadB64 = Buffer.from(JSON.stringify({
    mid: 1, name: '张三', role: 'admin', exp: Math.floor(Date.now() / 1000) - 60,
  }), 'utf8').toString('base64url');
  const expired = payloadB64 + '.' + crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
  r = await call(mkEvent({ httpMethod: 'POST', path: '/api/auth/verify', headers: { ...mkEvent().headers, 'X-Member-Token': expired } }));
  check('D3', '★过期令牌 → 401「身份已过期，请重新登录」',
    r.status === 401 && r.body.error.message === identity.MSG.TOKEN_EXPIRED,
    `${r.status} ${(r.body.error || {}).message}`);

  r = await call(mkEvent({ httpMethod: 'POST', path: '/api/auth/verify' }));
  check('D4', '未提供令牌 → 401「未提供身份令牌，请先登录」',
    r.status === 401 && /未提供身份令牌/.test((r.body.error || {}).message || ''),
    `${r.status} ${(r.body.error || {}).message}`);

  console.log('\n=== 兜底路径与降级 ===\n');

  // —— E. 两条进门的路都要通 ——
  const viaPath = await call(loginBody('张三', PASS_A));
  const viaAction = await call(mkEvent({ path: '/api/items', body: JSON.stringify({ _action: 'login', name: '张三', passcode: PASS_A }) }));
  check('E1', '★_action 兜底：POST /api/items?_action=login 与 /api/auth/login 行为一致',
    viaPath.status === 200 && viaAction.status === 200 &&
    typeof viaAction.body.data.token === 'string',
    `path=${viaPath.status} action=${viaAction.status}`);

  // 令牌也能走请求体（万一网关吃掉自定义头）
  r = await call(mkEvent({ httpMethod: 'POST', path: '/api/auth/verify', body: JSON.stringify({ memberToken: token }) }));
  check('E2', '★令牌走请求体（memberToken）同样生效（网关吃头时的后路）',
    r.status === 200 && r.body.data.member.id === 1,
    `${r.status} ${r.raw.slice(0, 120)}`);

  // —— F. 没配密钥 → fail-closed ——
  // 换一个"干净进程"重新加载模块，模拟控制台忘了配 WORKSHOP_AUTH_SECRET 的情况。
  for (const p of [INDEX_PATH, IDENTITY_PATH, ERRORS_PATH]) delete require.cache[require.resolve(p)];
  delete process.env.WORKSHOP_AUTH_SECRET;
  const indexNoSecret = require(INDEX_PATH);
  const resNoSecret = await indexNoSecret.main(loginBody('张三', PASS_A));
  const bodyNoSecret = JSON.parse(resNoSecret.body || '{}');
  check('F1', '★未配 WORKSHOP_AUTH_SECRET → 503，绝不"人人可登录"',
    resNoSecret.statusCode === 503 && /未配置身份密钥/.test((bodyNoSecret.error || {}).message || ''),
    `${resNoSecret.statusCode} ${(bodyNoSecret.error || {}).message}`);
  // 复原，免得影响同进程后续用例
  process.env.WORKSHOP_AUTH_SECRET = SECRET;

  // —— G. 响应头 ——
  const optRes = await index.main(mkEvent({ httpMethod: 'OPTIONS', headers: { ...mkEvent().headers } }));
  const allowHeaders = (optRes.headers && optRes.headers['Access-Control-Allow-Headers']) || '';
  check('G1', '预检响应放行 X-Member-Token（自定义头兜底）',
    /X-Member-Token/i.test(allowHeaders), allowHeaders);

  console.log(`\n———— 结果：${pass} PASS / ${fail} FAIL ————`);
  if (fail) { console.log('失败项：' + fails.join(', ')); process.exit(1); }
  console.log('全部通过。');
})();
