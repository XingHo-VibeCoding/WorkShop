// WorkShop · 健康检查云函数（Day 15 部署；Day 20 加 CORS 配置）
// 只处理 GET /api/health：不连数据库、不写业务逻辑。
//
// 【Day 20 · CORS 配置】
// - 浏览器跨域调用时，响应必须带 Access-Control-Allow-Origin，否则被浏览器拦截。
// - 白名单只放行：生产静态托管域名 + 本地调试端口（localhost:8080 / 127.0.0.1:8080），
//   禁止使用 * 通配符（Day 20 清单硬性要求）。
// - 返回形态从「裸对象」改为 { statusCode, headers, body }：平台只有收到这个完整
//   形态才会把 headers 写进 HTTP 响应；裸对象返回时自定义头会被丢弃。

const ALLOWED_ORIGINS = [
  'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com', // 生产：静态网站托管
  'http://localhost:8080',  // 本地接线调试（Day 20，仅开发用）
  'http://127.0.0.1:8080',  // 本地接线调试（Day 20，仅开发用）
];

// 从请求头取 Origin（兼容不同大小写形态），命中白名单才回 ACAO 头
function corsHeaders(event = {}) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

exports.main = async (event = {}) => {
  return {
    statusCode: 200,
    headers: corsHeaders(event),
    body: JSON.stringify({ ok: true, service: 'workshop' }),
  };
};
