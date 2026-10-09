// WorkShop · 阶段二 P6 · 身份与令牌模块（identity_phase2.js）
// ---------------------------------------------------------------------------
// 本模块只做三件事，且**不碰数据库**（查成员表由 db.js 负责，保持分层清晰）：
//   1) 口令校验：scrypt 哈希 + 常量时间比较（防时序侧信道）
//   2) 令牌签发：HMAC-SHA256 签名，密钥来自环境变量 WORKSHOP_AUTH_SECRET
//   3) 令牌校验：先验签名再验过期；从请求头或请求体里取令牌（两条路都留）
//
// ★ 为什么单独拆一个文件（而不是塞进 index.js）：
//   身份逻辑要被多处复用（登录接口、所有写操作的权限判定、verify 接口），
//   且它是阶段二新增能力 —— 独立文件才能做到「不动现有文件就上线」（AGENTS_phase2 §五）。
//
// ★ 零依赖铁律（TECH_DESIGN R4）：只用 Node 内置 crypto。云函数当前不打包 node_modules，
//   引入任何 npm 包都要改部署形态，代价陡增。
//
// ★ 凭据纪律（AGENTS_phase2 §四）：
//   - 签名密钥只在环境变量里，**不进代码、不进仓库、不回给前端**
//   - 库里只存 salt + scrypt 哈希，明文口令从不落盘
//   - 英文技术细节只进 console.error，对外一律中文（Day 23 铁律）
//
// ★ 与生成脚本的一致性契约（改这里必须同步改 resource/scripts/gen_member_phase2.js）：
//   crypto.scryptSync(passcode, Buffer.from(saltHex, 'hex'), 64).toString('hex')
//   库里 salt 是 32 字符 hex 文本，必须先 Buffer.from(salt,'hex') 还原成 16 字节。
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

// ———————————————— 常量 ————————————————

const SECRET = process.env.WORKSHOP_AUTH_SECRET || '';
const HASH_BYTES = 64;              // scrypt 输出 64 字节 → hex 128 字符（对应 members_phase2.identity_key VARCHAR(128)）
const TOKEN_TTL_DAYS = 7;           // 令牌有效期

// 对外的中文错误（code 同时用作 HTTP 状态码：Day 24 起错误响应必须是 4xx/5xx）
const MSG = {
  NOT_CONFIGURED: '服务未配置身份密钥，请联系管理员',
  INVALID: '口令无效，请联系管理员',       // ★ 不区分"口令不存在"与"口令错误"，避免账号枚举
  TOKEN_INVALID: '身份已失效，请重新登录',
  TOKEN_EXPIRED: '身份已过期，请重新登录',
};

function authError(code, message, logDetail) {
  const e = new Error(message);
  e.code = code;                     // HTTP 状态码，index.js 的 http() 会据此推导
  e.userMessage = message;           // 对外文案（中文）
  if (logDetail) console.error('[identity_phase2]', logDetail); // 英文细节只进日志
  return e;
}

// ———————————————— 1) 口令哈希 ————————————————

/**
 * 计算口令的 scrypt 哈希。
 * @param {string} passcode 明文口令
 * @param {string} saltHex  盐（库里存的是 32 字符 hex 文本）
 * @returns {string} 128 字符 hex
 */
function hashPasscode(passcode, saltHex) {
  // ★ 必须用 Buffer.from(saltHex,'hex')：salt 在库里是 hex 文本，不是原始字节。
  //   写成 crypto.scryptSync(passcode, saltHex, 64) 会得到完全不同的哈希 → 登录永远失败。
  return crypto.scryptSync(String(passcode), Buffer.from(String(saltHex || ''), 'hex'), HASH_BYTES).toString('hex');
}

/**
 * 校验口令（常量时间比较，防时序侧信道）。
 * @returns {boolean}
 */
function verifyPasscode(passcode, saltHex, expectedHex) {
  if (!saltHex || !expectedHex) return false;           // 该成员未设置凭据，一律拒绝
  let actual;
  try {
    actual = hashPasscode(passcode, saltHex);
  } catch (e) {
    console.error('[identity_phase2] scrypt failed:', e && e.message);
    return false;
  }
  return safeEqual(actual, String(expectedHex));
}

// ———————————————— 2) 令牌签发与校验 ————————————————

function hmac(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
}

/**
 * 签发成员令牌。格式：base64url(payload).hex(hmac)
 * payload = { mid, name, role, exp }（★ 未加密，别放敏感信息；前端只是原样带回）
 */
function signToken(member) {
  // ★ Fail-closed：没配密钥就拒绝签发，绝不允许"没配置 = 人人可登录"
  if (!SECRET) throw authError(503, MSG.NOT_CONFIGURED, 'WORKSHOP_AUTH_SECRET is not set');
  const id = Number(member && (member.id != null ? member.id : member.member_id));
  if (!Number.isInteger(id) || id <= 0) throw authError(500, MSG.TOKEN_INVALID, 'signToken: bad member id');

  const payload = {
    mid: id,
    name: String((member && (member.display_name || member.displayName || member.name)) || ''),
    role: String((member && member.role) || 'member'),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 24 * 3600,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/**
 * 校验令牌。通过返回 payload { mid, name, role, exp }；失败抛错（带中文文案 + HTTP 码）。
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') throw authError(401, MSG.TOKEN_INVALID, 'verifyToken: empty token');
  if (!SECRET) throw authError(503, MSG.NOT_CONFIGURED, 'WORKSHOP_AUTH_SECRET is not set');

  const idx = token.lastIndexOf('.');
  if (idx <= 0) throw authError(401, MSG.TOKEN_INVALID, 'verifyToken: malformed token');

  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  // 先验签名（常量时间），签名不对就不必再解析 payload
  if (!safeEqual(sig, hmac(payloadB64))) {
    throw authError(401, MSG.TOKEN_INVALID, 'verifyToken: signature mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    throw authError(401, MSG.TOKEN_INVALID, `verifyToken: bad payload ${e && e.message}`);
  }

  if (!payload || !Number.isInteger(payload.mid) || payload.mid <= 0) {
    throw authError(401, MSG.TOKEN_INVALID, 'verifyToken: bad mid');
  }
  if (!payload.exp || payload.exp * 1000 <= Date.now()) {
    throw authError(401, MSG.TOKEN_EXPIRED, 'verifyToken: expired');
  }
  return payload;
}

/**
 * 从请求里取成员令牌。两条路都留（TECH_DESIGN §5.3）：
 *   ① 请求头 X-Member-Token（首选）
 *   ② 请求体 / 查询串 memberToken（万一网关吃掉自定义头的兜底）
 * @param {{headers?:object, body?:object, query?:object}} event
 */
function readTokenFrom(event) {
  const e = event || {};
  const h = e.headers || {};
  const get = (o, k) => (o && o[k] != null ? o[k] : undefined);
  // CloudBase 传进来的头名大小写不定，统一转小写再找
  let v;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'x-member-token') { v = h[k]; break; }
  }
  if (v) return String(v);

  // ★ 请求体在云函数里通常是 JSON **字符串**（event.body 原文），不是对象。
  //   直接 e.body.memberToken 取到的是 undefined —— 会静默退回"没带令牌"，
  //   表现为"明明传了却说我未登录"，而且很难查（头那条路走得通，体这条永远走不通）。
  let b = e.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (err) { b = null; }
  }
  // 查询串同理：不同触发形态下叫 query / queryStringParameters / queryString，都试一遍
  const q = e.query || e.queryStringParameters || e.queryString;
  return get(b, 'memberToken') || get(q, 'memberToken') || null;
}

/**
 * 解析出当前操作者。★ 取不到令牌时返回 null，**不抛错** ——
 * 这是向后兼容铁律：不带令牌 = v1.0 行为，接口必须照旧工作（AGENTS_phase2 §五）。
 */
function actorFrom(event) {
  const token = readTokenFrom(event);
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch (err) {
    // 令牌坏了只记日志，由调用方决定要不要拒绝（登录/verify 接口要拒绝，只读接口可放行）
    console.error('[identity_phase2] actorFrom failed:', err && err.code, err && err.userMessage);
    return null;
  }
}

// ———————————————— 内部：常量时间比较 ————————————————

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;      // 长度不同直接否（timingSafeEqual 会抛错）
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

module.exports = {
  MSG,
  TOKEN_TTL_DAYS,
  HASH_BYTES,
  hashPasscode,
  verifyPasscode,
  signToken,
  verifyToken,
  readTokenFrom,
  actorFrom,
  isConfigured: () => !!SECRET,
};
