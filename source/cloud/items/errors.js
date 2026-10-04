'use strict';

// WorkShop · 错误提示统一层（Day 23）
//
// 它干什么，三句话：
//   ① 分类：把抛上来的异常分成「输入错 / 网络错 / 服务端错」三类；
//   ② 翻译：每类换一句人话（中文），用的人看得懂、知道下一步该干嘛；
//   ③ 留痕：原始英文报错只写进服务端日志，绝不回给前端 —— 日志给排查的人看，响应给用的人看。
//
// 为什么要有这一层（改之前的样子）：
//   index.js 的 4 处 catch 直接把 err.message 丢了出去。网络一抖，前端收到的就是
//   "fetch failed" / "getaddrinfo ENOTFOUND xxx" 这类英文——使用者看不懂，等于没有提示；
//   但原文又不能扔，扔了出问题无从查起。所以分工：人话出站，原文入日志。
//
// 契约不变（Day 23 方案 A）：对外仍是 { ok:false, data:null, error:{ code, message } }，不新增字段。
// 输入错那部分（400/404/409/422）本来已是中文，由控制器直接 return，不走这一层；
// 这一层只接管"意外"——网络断了、服务挂了、鉴权没配上。

// —— 网络类错误的特征 ——
// Node 18+ 的 fetch 失败会抛 TypeError: fetch failed，真正原因藏在 err.cause.code 里
// （DNS 解析失败 / 端口没人听 / 连接被重置 / 超时）。这些码就是"网络错"的身份证。
const NETWORK_ERR_CODES = [
  'ENOTFOUND',    // 域名解析不到
  'EAI_AGAIN',    // DNS 临时故障
  'ECONNREFUSED', // 端口没人听
  'ECONNRESET',   // 连接被对端重置
  'ECONNABORTED',
  'ETIMEDOUT',    // 连接超时
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
];

// 兜底：拿不到 cause.code 时（不同 Node 版本形态不一样），从报错文本本身认
const NETWORK_TEXT = /fetch failed|network|getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|timeout|timed out|ETIMEDOUT/i;

// 鉴权失败：这不是用户输错了，是服务端密钥/权限没配对，归"数据服务不可用"，
// 但提示得让人知道该找谁处理，所以单独一句。
const AUTH_TEXT = /\b(401|403)\b|unauthorized|forbidden|invalid jwt|jwt expired|permission denied|RLS|鉴权|权限失败/i;

function rawMessage(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

// 分类：'network' | 'auth' | 'server'
function classify(err) {
  const code = err && err.cause && err.cause.code;
  if (code && NETWORK_ERR_CODES.includes(code)) return 'network';
  const msg = rawMessage(err);
  if (NETWORK_TEXT.test(msg)) return 'network';
  if (AUTH_TEXT.test(msg)) return 'auth';
  return 'server';
}

// 三类错误的人话 —— 这就是今天「把哪句裸报错改成了人话」的答案
const USER_MESSAGES = {
  network: { code: 503, message: '网络连接失败，请检查网络后重试（若频繁出现请联系管理员）' },
  auth:    { code: 503, message: '数据服务鉴权未通过，请联系管理员检查服务配置' },
  server:  { code: 500, message: '服务暂时不可用，请稍后重试' },
};

// 出站：把任何异常翻成契约里的 { code, message }（固定两字段，不多不少）
function toUserError(err) {
  return Object.assign({}, USER_MESSAGES[classify(err)]);
}

// 入日志：原始英文 + 分类 + 上下文，只留在服务端
function logError(tag, err, extra) {
  const cause = err && err.cause ? ` cause=${err.cause.code || err.cause.message || err.cause}` : '';
  console.error(
    `[${tag}] 原始报错(分类=${classify(err)}): ${rawMessage(err)}${cause}`,
    extra != null ? JSON.stringify(extra) : ''
  );
}

module.exports = { classify, toUserError, logError, USER_MESSAGES };
