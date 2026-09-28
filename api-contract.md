# API 接口契约（api-contract.md）

> **定位**：本文档是第 3 周（Day 16–20）「建表 + 写接口」的**唯一依据**。
> **当前状态**：除 `/api/health` 已在 Day 15 实现外，其余接口今日**只登记占位、不实现**。
> **约定**：所有时间一律 `YYYY-MM-DD HH:mm`（24 小时制、东八区）；**成功/错误统一返回 `{ ok, data, error }`**（见 §一）；**`GET /api/items` 已在 Day 17 实现并产出真实数据**，其余接口今日仍只登记占位、不实现；今日不处理跨域（CORS 在 Day 16+ 接真实接口时再配）。
> **⚠️ 数据源决策（待 Day 16 拍板）**：本契约目前假设后端用 **CloudBase 文档型数据库（NoSQL）** 承载 `items` 表；但 PRD 的 MVP 写明「数据字段存**腾讯文档**」。两者指向不同数据源，**Day 16 前必须拍板**：
> - 选**腾讯文档**：云函数改为读写腾讯文档表格/多维表，`items` 表映射到腾讯文档的一个表；需腾讯文档 OpenAPI 凭证（SecretId/Token），按 AGENTS §五 **凭证与文档 ID 绝不入仓、走环境变量/密钥管理**。
> - 选 **CloudBase 数据库**：维持本契约现状，PRD 的「存腾讯文档」降为阶段二可选。
> 无论哪种，前端 `items` 字段结构不变，仅数据读写通道不同。

---

## 一、通用约定

| 项 | 规则 |
|---|---|
| Base URL | CloudBase HTTP 触发域名（Day 15 部署后确定，形如 `https://xxx.apigw.tencentcs.com/release` 或云开发默认域名）。前端静态托管与云函数可共用同一环境。 |
| 请求体 | `application/json`（POST/PUT）。 |
| 日期时间 | `YYYY-MM-DD HH:mm`，字符串，东八区。 |
| 成功响应 | 统一返回 `{ "ok": true, "data": <业务数据>, "error": null }`，HTTP 状态 `200`。（Day 17 起全站统一此形状；此前 `GET /api/health` 已是 `{ok:true}` 风格，现一并纳入。） |
| 错误响应 | `HTTP 4xx/5xx`，正文：`{ "ok": false, "data": null, "error": { "code": 整数, "message": "可读说明" } }`。 |
| 鉴权 | Day 15 暂不鉴权（开发期）。Day 16+ 确定（匿名登录 / 自定义登录）。**密钥与连接串不进仓库**（AGENTS.md §五）。 |
| 跨域 | 暂不配置。前端 mock 版不请求后端，无跨域问题；接真实接口时再在云函数/网关配 CORS。 |

---

## 二、数据模型：事项记录表（items）

从前端第 2 周页面需求推导。前端 mock 字段已对齐到下表；其中 `start`(日期) + `startTime/endTime`(时分) 在后端统一合并为 `startTime/endTime` 全量时间字符串，前端读取时再拆分展示（映射由前端负责）。

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `id` | string | 事项唯一 ID | 后端生成（UUID），创建后不可改 |
| `table` | enum | 所属表 | `work`（工作周表）/ `daily`（日常表）；对应 PRD 双表结构 |
| `type` | string | 事项类型 | `work`: `meeting`/`trip`/`pending`；`daily`: `class`/`sport`/`life`/`other` |
| `title` | string | 标题 | 必填，≤100 字 |
| `startTime` | string | 开始时间 | `YYYY-MM-DD HH:mm` |
| `endTime` | string | 结束时间 | `YYYY-MM-DD HH:mm`，须 ≥ `startTime` |
| `attendees` | string | 参与人 | 可空，文本或逗号分隔 |
| `venue` | string | 地点 | 可空 |
| `note` | string | 备注 | 可空 |
| `ownerKey` | string | 归属标签 | `self`/`depta`/`deptb`/`deptc`/`deptd`/`me`；驱动颜色与标记（阶段二「个人/组织颜色区分」） |
| `createdAt` | string | 创建时间 | 后端写入，只读 |
| `updatedAt` | string | 更新时间 | 后端写入，只读 |

> 前端现有 mock 用 `ownerKey` + 配置表推导 `mark`（★/△/○/□/☆/我）与颜色；后端只存 `ownerKey`，展示由前端完成。

---

## 三、接口清单

### 1. `GET /api/health`　【✅ 已实现 · Day 15】
健康检查。无任何参数，不连数据库、无业务逻辑。

- **响应 200**：
```json
{ "ok": true, "service": "workshop" }
```
- **错误**：无（除非服务不可用，网关层返回 5xx）。
- **部署位置**：云函数 `health`（见 `source/cloud/health/`），HTTP 触发路径 `/api/health`。

---

### 2. `GET /api/items`　【✅ 已实现 · Day 17】　★ 列表读取接口（记录表读取）
前端周时间线、总览、筛选都要靠它拉取事项列表。读取**组织内多归属共享**的 `items` 表（WorkShop 面向组织，数据来自多人经共享库/腾讯文档录入）。

- **查询参数**（全部可选）：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `table` | string | `work` / `daily` / `all`（默认 `all`） |
  | `week` | string | ISO 周，如 `2026-W40`；或传 `start`+`end` 日期范围 |
  | `start` | string | 范围起 `YYYY-MM-DD HH:mm` |
  | `end` | string | 范围止 `YYYY-MM-DD HH:mm` |
  | `type` | string | 按类型过滤 |
  | `ownerKey` | string | 按归属标签过滤 |
  | `keyword` | string | 标题模糊搜索 |
  | `limit` | integer | 返回条数上限（余力加练；默认不限制） |
- **响应 200**（统一 `{ ok, data, error }` 形状，`data` 为事项数组）：
```json
{
  "ok": true,
  "data": [
    {
      "id": "s1", "table": "work", "type": "meeting", "title": "部门周例会",
      "startTime": "2026-09-28 10:00", "endTime": "2026-09-28 11:00",
      "attendees": "全体", "venue": "302会议室", "note": "本周要点同步",
      "ownerKey": "self", "createdAt": "2026-09-27 11:00", "updatedAt": "2026-09-27 11:00"
    }
  ],
  "error": null
}
```
- **错误**：`400 { "ok": false, "data": null, "error": { "code": 400, "message": "invalid week param" } }`；`500` 服务端错误（如数据库连接失败）。
- **部署位置**：云函数 `items`（见 `source/cloud/items/`），HTTP 触发路径 `/api/items`。共享集群 PG 不暴露 IP:Port、且 `@cloudbase/node-sdk` 的 `app.rdb()` 在「老环境+后挂共享集群」下会因 `Accept-Profile` 头取不到 schema 而报错；故本函数**零依赖直打 CloudBase PostgREST HTTP API**（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/items`），显式设置 `Accept-Profile`/`Content-Profile` 头；过滤条件由 PostgREST 参数化（无字符串拼接 SQL），函数内做 snake_case → camelCase 字段映射。详见 `source/cloud/items/index.js` 头部注释。
- **鉴权（已对照官方文档核实）**：PostgREST 统一用 `Authorization: Bearer <token>`。云函数读「组织共享 items」属服务端管理读，**首选设环境变量 `CB_API_KEY` = 服务端 API Key（service_role，绕过 RLS，无需登录）**；不设则兜底走匿名登录（需 `X-CloudBase-DeviceId` 头，且若表开 RLS 未对 anon 开放 SELECT 会读不到）。若在控制台「ApiKey 管理页」创建密钥，请选**服务端**类型，切勿把密钥写进代码/仓库或暴露到浏览器。

---

### 3. `POST /api/items`　【📋 占位 · Day 16–20】　新建事项
- **请求体**（不含 `id`/`createdAt`/`updatedAt`，后端生成）：
```json
{
  "table": "work", "type": "meeting", "title": "临时碰头",
  "startTime": "2026-09-30 15:00", "endTime": "2026-09-30 16:00",
  "attendees": "李工", "venue": "线上", "note": "", "ownerKey": "self"
}
```
- **响应 201**：返回新建项（含 `id`/`createdAt`/`updatedAt`）。
- **错误**：`400 { "error": { "code": 400, "message": "missing required field: title" } }`；`422` 时间区间非法。

---

### 4. `GET /api/items/:id`　【📋 占位 · Day 16–20】　读取单条
- **响应 200**：单个 item 对象（同 §2 数组元素）。
- **错误**：`404 { "error": { "code": 404, "message": "item not found" } }`。

---

### 5. `PUT /api/items/:id`　【📋 占位 · Day 16–20】　编辑事项
- **请求体**：与 POST 相同结构，但只传要改的字段（部分更新）。
- **响应 200**：更新后的 item 对象。
- **错误**：`404` 不存在；`400` 字段非法；`409` 并发冲突（可选）。

---

### 6. `DELETE /api/items/:id`　【📋 占位 · Day 16–20】　删除事项
- **响应 200**：`{ "ok": true, "deleted": "<id>" }`。
- **错误**：`404 { "error": { "code": 404, "message": "item not found" } }`。

---

### 7. `POST /api/import`　【📋 占位 · Day 16–20】　图片/表格识别导入
MVP 三大功能之一（PRD §4）。接收图片或表格文件，调用外部免费 AI 接口识别为事项，写回 `items`。

- **请求体**：`multipart/form-data`，字段 `file`（图片/表格）。
- **响应 200**：
```json
{
  "imported": [
    { "table": "work", "type": "meeting", "title": "识别出的会议", "startTime": "2026-10-01 14:00", "endTime": "2026-10-01 15:00", "ownerKey": "self" }
  ],
  "count": 1
}
```
- **错误**：`400 { "error": { "code": 400, "message": "unsupported file type" } }`；`502` 外部识别服务不可用。

---

## 四、实现状态总览

| 接口 | 方法 | 状态 | 计划 |
|---|---|---|---|
| `/api/health` | GET | ✅ 已实现 | Day 15 |
| `/api/items` | GET | ✅ 已实现 | Day 17 |
| `/api/items` | POST | 📋 占位 | Day 16–20 |
| `/api/items/:id` | GET | 📋 占位 | Day 16–20 |
| `/api/items/:id` | PUT | 📋 占位 | Day 16–20 |
| `/api/items/:id` | DELETE | 📋 占位 | Day 16–20 |
| `/api/import` | POST | 📋 占位 | Day 16–20 |

> Day 15 只登记以上契约，**不写任何业务接口代码、不建表、不配跨域**（依清单「今日不做」）。
> **⚠️ 响应形状变更（Day 17）**：自 `GET /api/items` 起，全站成功/错误统一为 `{ ok, data, error }`（见 §一）。其余仍未实现的接口，其示例中的"直接返回业务字段 / `{ok:true,deleted}`"等旧写法，待实现时**一律按此统一形状包裹**（`data` 承载原业务载荷，`error` 承载原 `{error:{...}}`），不再保留裸字段返回。
