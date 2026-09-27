// WorkShop · 健康检查云函数（Day 15）
// 只处理 GET /api/health：不连数据库、不写业务逻辑。
// 通过 CloudBase「HTTP 访问」暴露；HTTP 返回时，return 的对象会被自动序列化为 JSON 响应体。

exports.main = async (event = {}) => {
  return {
    ok: true,
    service: "workshop",
  };
};
