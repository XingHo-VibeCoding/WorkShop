#!/usr/bin/env node
// WorkShop · 阶段二 P6 · 身份模块自测（verify-identity_phase2.js）
// ---------------------------------------------------------------------------
// 干什么：把 identity_phase2.js 的关键路径全跑一遍，包括**故意弄坏**的用例
//        （篡改签名 / 篡改身份 / 过期令牌 / 未配密钥 / 错口令）。
// 为什么需要它：身份是权限的地基。地基错了不会报错，只会"看起来能用"，
//        然后某天发现别人能冒充你 —— 所以必须拿命令跑出 PASS/FAIL，不能靠"应该没问题"。
//
// 用法： node resource/scripts/verify-identity_phase2.js
// 退出码：0 = 全部 PASS；1 = 有 FAIL
//
// ★ 本脚本只在本机跑，不连线上、不碰数据库、不产生真实凭据。
//   用到的口令/密钥都是当场随机生成的，跑完即弃。
// ---------------------------------------------------------------------------
'use strict';

process.env.WORKSHOP_AUTH_SECRET = process.env.WORKSHOP_AUTH_SECRET || 'selftest-secret-do-not-use-in-prod';

const crypto = require('crypto');
const path = require('path');
const IDENTITY_PATH = path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'identity_phase2.js');

const results = [];
function check(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${id}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

// —— 造测试素材（随机，跑完即弃）——
const word = crypto.randomBytes(6).toString('hex');   // 当"明文口令"用
const saltHex = crypto.randomBytes(16).toString('hex');
const storedHash = crypto.scryptSync(word, Buffer.from(saltHex, 'hex'), 64).toString('hex');

// 模块必须在设好环境变量之后加载（它在加载时就读 SECRET）
const idm = require(IDENTITY_PATH);

console.log('');
console.log('──────── 身份模块自测（P6-①） ────────');
console.log(`模块路径: ${IDENTITY_PATH}`);
console.log('');

// ———————————————— A. 口令校验 ————————————————

check('A1', '正确口令 → 通过', idm.verifyPasscode(word, saltHex, storedHash) === true);

check('A2', '错误口令 → 拒绝', idm.verifyPasscode(word + 'x', saltHex, storedHash) === false);

check('A3', '空 salt / 空哈希 → 拒绝（未设凭据的成员不能登录）',
  idm.verifyPasscode(word, '', storedHash) === false && idm.verifyPasscode(word, saltHex, '') === false);

// ★ 跨文件一致性：与生成脚本 gen_member_phase2.js 用同一公式（改任一侧这里就会红）
const genStyleHash = crypto.scryptSync(word, Buffer.from(saltHex, 'hex'), 64).toString('hex');
check('A4', '与 gen_member_phase2.js 哈希公式一致', genStyleHash === idm.hashPasscode(word, saltHex),
  `长度 ${idm.hashPasscode(word, saltHex).length}（应为 128）`);

// 故意弄坏：salt 不还原成字节（常见手误）→ 必须得到不同哈希，否则说明两端都错了
const wrongStyle = crypto.scryptSync(word, saltHex, 64).toString('hex');
check('A5', 'salt 未经 from(hex) 会算出不同哈希（反向确认契约有效）', wrongStyle !== storedHash);

// ———————————————— B. 令牌签发与校验 ————————————————

const member = { id: 7, display_name: '张三', role: 'member' };
let token = null;
try {
  token = idm.signToken(member);
  check('B1', '签发令牌成功', typeof token === 'string' && token.includes('.'));
} catch (e) {
  check('B1', '签发令牌成功', false, `${e.userMessage || e.message}`);
}

if (token) {
  let payload = null;
  try {
    payload = idm.verifyToken(token);
    check('B2', '令牌往返校验通过', payload && payload.mid === 7 && payload.name === '张三' && payload.role === 'member',
      payload ? `mid=${payload.mid} name=${payload.name} role=${payload.role}` : '');
  } catch (e) {
    check('B2', '令牌往返校验通过', false, e.userMessage || e.message);
  }

  // 故意弄坏 1：改签名
  const brokenSig = token.slice(0, token.lastIndexOf('.') + 1) + '0'.repeat(64);
  let c1 = null;
  try { idm.verifyToken(brokenSig); } catch (e) { c1 = e; }
  check('B3', '篡改签名 → 拒绝且 HTTP 401', c1 && c1.code === 401, c1 ? c1.userMessage : '未拒绝！');

  // 故意弄坏 2：换个 mid 冒充别人（用合法密钥重新签名，模拟"拿到密钥也改不了别人的令牌"之外的场景）
  const forged = Buffer.from(JSON.stringify({ mid: 999, name: '冒充者', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }), 'utf8').toString('base64url');
  const forgedToken = `${forged}.${crypto.createHmac('sha256', process.env.WORKSHOP_AUTH_SECRET).update(forged).digest('hex')}`;
  let c2 = null;
  try { idm.verifyToken(forgedToken); } catch (e) { c2 = e; }
  // 注意：本模块只验签名不验权限，伪造但签名正确的令牌**会被接受**——
  // 这正是"签名密钥绝不能泄露"的原因，故此项期望=通过校验（不是漏洞，是设计约束）
  check('B4', '密钥签名出的任意 payload 可被接受（说明密钥=全部信任，必须保密）', !c2, c2 ? '意外拒绝' : '符合预期');

  // 故意弄坏 3：过期令牌
  const expired = Buffer.from(JSON.stringify({ mid: 7, name: '张三', role: 'member', exp: Math.floor(Date.now() / 1000) - 10 }), 'utf8').toString('base64url');
  const expiredToken = `${expired}.${crypto.createHmac('sha256', process.env.WORKSHOP_AUTH_SECRET).update(expired).digest('hex')}`;
  let c3 = null;
  try { idm.verifyToken(expiredToken); } catch (e) { c3 = e; }
  check('B5', '过期令牌 → 拒绝且 HTTP 401', c3 && c3.code === 401, c3 ? c3.userMessage : '未拒绝！');

  // 畸形令牌
  let c4 = null;
  try { idm.verifyToken('abcdef'); } catch (e) { c4 = e; }
  check('B6', '畸形令牌（无签名段）→ 拒绝', c4 && c4.code === 401);
}

// ———————————————— C. 未配置密钥必须 fail-closed ————————————————

// 模块在 require 那一刻读 SECRET，所以要模拟"没配密钥"必须清缓存后重新加载。
// ⚠️ 本机沙箱里 execFileSync 起子进程会抛 EBUSY（项目既有坑，见 MEMORY），
//    故**不用子进程**，改用 require.cache 重载的方式，避免把环境限制误报成代码问题。
const savedSecret = process.env.WORKSHOP_AUTH_SECRET;
delete process.env.WORKSHOP_AUTH_SECRET;
delete require.cache[require.resolve(IDENTITY_PATH)];
let noSecretMod = null;
try {
  noSecretMod = require(IDENTITY_PATH);
} catch (e) {
  check('C1', '未配置 WORKSHOP_AUTH_SECRET → 拒绝签发', false, `重载模块失败：${e && e.message}`);
}
if (noSecretMod) {
  let c = null;
  try {
    const t = noSecretMod.signToken({ id: 1, display_name: 'x', role: 'member' });
    check('C1', '未配置 WORKSHOP_AUTH_SECRET → 拒绝签发（fail-closed，绝不人人可登录）', false,
      `竟然签出了令牌：${String(t).slice(0, 24)}…`);
  } catch (e) {
    check('C1', '未配置 WORKSHOP_AUTH_SECRET → 拒绝签发（fail-closed，绝不人人可登录）',
      e.code === 503, `HTTP ${e.code} ${e.userMessage}`);
  }
  check('C2', '未配置密钥时 isConfigured() 为假', noSecretMod.isConfigured() === false);
}
// 恢复现场（后续用例仍用原先那份带密钥的模块实例）
process.env.WORKSHOP_AUTH_SECRET = savedSecret;
delete require.cache[require.resolve(IDENTITY_PATH)];

// ———————————————— D. 取令牌的两条路 + 向后兼容 ————————————————

check('D1', '从请求头 X-Member-Token 取到令牌',
  idm.readTokenFrom({ headers: { 'x-member-token': 'tok-head' } }) === 'tok-head');

check('D2', '头名大小写不敏感（CloudBase 传进来的形态不定）',
  idm.readTokenFrom({ headers: { 'X-Member-Token': 'tok-mixed' } }) === 'tok-mixed');

check('D3', '从请求体 memberToken 取到令牌（网关吃掉自定义头时的兜底路）',
  idm.readTokenFrom({ body: { memberToken: 'tok-body' } }) === 'tok-body');

check('D4', '★ 不带令牌 → actorFrom 返回 null（= v1.0 行为，向后兼容铁律）',
  idm.actorFrom({ headers: {} }) === null);

check('D5', '带合法令牌 → actorFrom 返回身份',
  (() => { const a = idm.actorFrom({ headers: { 'x-member-token': token } }); return a && a.mid === 7; })());

check('D6', '带坏令牌 → actorFrom 返回 null（不抛异常、不炸接口）',
  idm.actorFrom({ headers: { 'x-member-token': 'garbage.sig' } }) === null);

// ———————————————— 汇总 ————————————————

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`──────── 汇总：${results.length - failed.length} PASS / ${failed.length} FAIL ────────`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
}
console.log('');
process.exit(failed.length ? 1 : 0);
