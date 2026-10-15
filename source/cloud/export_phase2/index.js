'use strict';
// WorkShop · 阶段二 P10 · 腾讯文档导出云函数（A8 骨架预留）
//
// 设计（TECH_DESIGN_phase2 §9.2）：
//   ★ 独立云函数，不与 items 混——Token 这类凭据相关代码不进主链路，
//     即便本函数挂了也不影响 items 的增删改查。
//   ★ Token 只走环境变量 TENCENT_DOC_TOKEN，前端绝不持有（防泄漏）。
//   ★ 当前状态：用户暂无 TENCENT_DOC_TOKEN、也无可用 MCP 端点，故：
//       - 未配 Token → 503 中文「未配置腾讯文档凭据，请联系管理员」（Day 23 auth 类文案风格）
//       - 配了 Token → 暂返回 501 占位「腾讯文档导出暂未开通（MCP 未接入）」，留 TODO 接 MCP
//     P10 风险表第 5 条明确：A8 这次不做真调，A7（CSV/JSON）兜底。

// —— CORS（白名单同 items，禁止 *）——
const ALLOWED_ORIGINS = [
  'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function corsHeaders(event = {}, extra = {}) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin', ...extra };
  if (ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// 统一包 HTTP 形态（从 error.code 推导状态码，契约 §一）
function http(event, payload, statusCode) {
  if (statusCode == null) {
    const c = payload && payload.error && Number(payload.error.code);
    statusCode = (payload && payload.ok === false && c >= 400 && c < 600) ? c : 200;
  }
  return { statusCode, headers: corsHeaders(event), body: JSON.stringify(payload) };
}

// —— event 解析（兼容 CloudBase 不同版本形态，与 items 函数一致）——
function getQuery(event = {}) {
  let qs = event.queryString || event.queryStringParameters || event.httpQuery;
  if (!qs) return {};
  if (typeof qs === 'string') {
    const out = {};
    new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (typeof qs === 'object') return qs;
  return {};
}
function getMethod(event = {}) {
  const raw = (
    event.httpMethod ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.method || 'GET'
  ).toUpperCase();
  if (raw === 'POST') {
    const q = getQuery(event);
    const b = getBody(event);
    const override = String(q._method || b._method || '').trim().toUpperCase();
    if (override) return override;
  }
  return raw;
}
function getBody(event = {}) {
  let raw = event.body;
  if (raw == null) raw = event.httpBody;
  if (raw == null) raw = event.payload;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function reqPath(event) {
  return (event.path || (event.requestContext && event.requestContext.http && event.requestContext.http.path) || '').toString();
}

// —— 业务：导出到腾讯文档 ——
async function exportDoc() {
  const token = process.env.TENCENT_DOC_TOKEN;
  if (!token) {
    // 凭据缺失：归 auth 类，503 中文（英文只进日志，不回前端）
    console.error('[export/doc] TENCENT_DOC_TOKEN 未配置');
    return { ok: false, data: null, error: { code: 503, message: '未配置腾讯文档凭据，请联系管理员' } };
  }
  // TODO(P10)：持 token 调腾讯文档 MCP 端点（建智能文档/在线表格）→ 返回 url。
  // 当前未接入 MCP（用户无可用端点），先占位 501，不污染主链路。
  console.error('[export/doc] TENCENT_DOC_TOKEN 已配置，但 MCP 端点未接入（P10 占位）');
  return { ok: false, data: null, error: { code: 501, message: '腾讯文档导出暂未开通（MCP 未接入）' } };
}

async function handle(event = {}) {
  const method = getMethod(event);
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(event, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Member-Token',
        'Access-Control-Max-Age': '86400',
      }),
      body: '',
    };
  }
  // 【阶段二】P10 收尾（2026-10-15）：本函数仅承接「腾讯文档导出」一个出口。
  // CloudBase HTTP 访问服务按挂载路径转发会剥前缀，函数收到的 path 未必是 /api/export/doc，
  // 故不再依赖 path 正则匹配，直接以 method===POST 判定（单动作函数，POST 即导出）。
  if (method === 'POST') {
    try { return http(event, await exportDoc(event)); }
    catch (err) {
      console.error('[export/doc] 异常', err && err.message);
      return http(event, { ok: false, data: null, error: { code: 500, message: '服务暂时不可用，请稍后重试' } }, 500);
    }
  }
  return http(event, { ok: false, data: null, error: { code: 404, message: '未找到该接口' } }, 404);
}

// —— 入口：记请求日志（Day 23 铁律）——
function main(event, context) {
  const t = Date.now();
  const method = getMethod(event);
  const path = reqPath(event) || '/api/export/doc';
  console.log(`[请求日志] ${new Date().toISOString()} ${method} ${path} → start`);
  return Promise.resolve(handle(event)).then((res) => {
    console.log(`[请求日志] ${new Date().toISOString()} ${method} ${path} → ${res.statusCode} (${Date.now() - t}ms)`);
    return res;
  }).catch((err) => {
    console.error('[export] 未捕获异常', err && err.message);
    return http(event, { ok: false, data: null, error: { code: 500, message: '服务暂时不可用，请稍后重试' } }, 500);
  });
}

exports.main = main;
