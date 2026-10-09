# TECH_DESIGN_phase2.md — WorkShop 阶段二技术设计

> 日期：2026-10-06（阶段二 P3）｜上游：`PRD_phase2.md`（P2）、`research_phase2.md`（P1）、`PLAN_phase2.md`
> 定位：把阶段二需求翻成**可落地的结构与接口**，不含最终代码（代码在 P5–P12 逐日产出）
> 依据来源：现网代码实测（`source/cloud/items/`、`db/schema.sql`、`api-contract.md`）

---

## 1. 现状盘点（先看清楚现在是什么，再谈改）

| 层 | 现状（实测） | 出处 |
|---|---|---|
| 前端 | 纯静态托管，2 页面（工作台 `index.html` / 检查台 `check.html`）；JS 4 个（`timeline.js` 1640 行主逻辑、`timepicker.js`、`router.js`、`animations.js`） | Day 28 验收取证 |
| 云函数 | **2 个**：`health`（35 行）、`items`（450 行）。`items` 内再分三层：`index.js`（控制器）/ `db.js`（DAL，311 行）/ `errors.js`（错误层，82 行） | `source/cloud/` |
| 数据通道 | **零依赖直打 PostgREST**：`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/items`，显式 `Accept-Profile: public`；不用 SDK 的 `app.rdb()`（老环境取不到 schema）、不用 `pg`（共享集群不暴露 IP:Port） | `db.js` 头部注释 |
| 鉴权 | `Authorization: Bearer <CB_API_KEY>`（**service_role，绕过 RLS**）；未设则兜底匿名登录 | `db.js:44 getBearer()` |
| 数据库 | CloudBase 共享集群 **PostgreSQL**。三表：`owners` / `meeting_requests` / `items` | `db/schema.sql` |
| 字段读取 | `db.js:37` 有常量 `COLUMNS`，**写死了 items 的 17 个列名**，`select` 只取这些 | `db.js` |
| CORS | 白名单在云函数响应头；预检 OPTIONS 当前只放行 `GET/POST/OPTIONS` + `Content-Type` | `index.js:25` |
| 线上数据 | **11 条**真实数据（Day 28 快照） | 验收日志 |

### 1.1 三条会决定设计的硬事实

1. **云函数是零依赖的** —— 当前不打包 `node_modules`。⇒ 阶段二**只能用 Node 内置模块**（`crypto` 足够做口令哈希与令牌签名），引入 npm 包就要改部署方式（打包上传），代价陡增。
2. **`COLUMNS` 常量写死** —— 新增列若不同步改这个常量，**接口读不到新字段**，会出现"库里有值、前端看不到"的幽灵问题。
3. **Bearer 是 service_role（绕过 RLS）** —— 这意味着**数据库层的 RLS 对当前链路无效**。要做 RLS 必须换成用户态 token 访问，等于改整个数据通道。⇒ **权限判定放应用层（云函数），RLS 列 v1.2**（见 §6.3）。

---

## 2. 设计约束与红线（违反即翻车）

| # | 约束 | 为什么 |
|---|---|---|
| **R1** | 阶段二**不得重跑** `db/schema.sql`（它是 `DROP TABLE IF EXISTS` + `CREATE`），只能 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | 重跑 = **清空线上 11 条数据** |
| **R2** | 只加表、只加列；**不改现有列语义、不改现有接口行为** | 保 v1.0 线上不退化为硬要求（PRD_phase2 决策 F） |
| **R3** | 新增列必须同步改 `db.js` 的 `COLUMNS` 常量 + 映射函数 | 否则读不到（§1.1 事实 2） |
| **R4** | 云函数保持零依赖，只用 Node 内置模块 | 否则部署形态改变、风险陡增 |
| **R5** | 任何凭据（口令哈希、签名密钥、腾讯文档 Token）**只走环境变量**，不进代码、不进仓库 | 阶段一 Day 23 安全基线 |
| **R6** | 部署云函数时**主文件与依赖文件一并上传**（`index.js` + `db.js` + `errors.js` + 新增模块） | 历史踩过 3 次的坑（漏传 → `FUNCTIONS_INVOCATION_FAILED`，加载阶段就崩） |
| **R7** | 错误：中文对外、英文原文只进 `console.error`；业务错误 HTTP 状态码 ≥ 400 | Day 23/24 铁律 |
| **R8** | 部署前跑 `resource/scripts/verify-project.js`，**不得新增 FAIL** | 阶段一 22 PASS 基线 |

---

## 3. 总体结构（增量，不重构）

```
前端（静态托管，不变）
  ├─ 新增：身份入口 / 身份显示 / 按人筛选 / 导出按钮 / 会议设置
  └─ 新增：请求统一带成员令牌（X-Member-Token）
                │
云函数 items（现有，扩展）
  ├─ index.js   控制器：+ 身份解析中间件 + 权限判定 + 导出分支
  ├─ db.js      DAL：+ COLUMNS 新列 + 成员表读写
  ├─ errors.js  错误层：+ 权限/身份类中文文案
  └─ identity_phase2.js  【新增】口令校验 / 令牌签发与校验（Node 内置 crypto）
                │
PostgreSQL
  ├─ items（现有，加列）
  ├─ members_phase2（新增）
  └─ audit_phase2（新增，留痕）
```

> **不新建第二个云函数**（除导出腾讯文档那一支，见 §9.2）。理由：现有 `items` 已管 GET/POST/PATCH/DELETE，再开函数会重复 CORS、鉴权、错误处理三套代码。

---

## 4. 数据层设计

### 4.1 迁移脚本策略（P5 产出 `db/schema_phase2.sql`）

```sql
-- 只做增量，绝不 DROP / CREATE
ALTER TABLE items ADD COLUMN IF NOT EXISTS owner_member_id INT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by      INT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by      INT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS border_color    VARCHAR(7);
ALTER TABLE items ADD COLUMN IF NOT EXISTS meeting_url     VARCHAR(512);
ALTER TABLE items ADD COLUMN IF NOT EXISTS meeting_no      VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_items_member ON items(owner_member_id);

CREATE TABLE IF NOT EXISTS members_phase2 (...);
CREATE TABLE IF NOT EXISTS audit_phase2   (...);
```

- **幂等**：全部 `IF NOT EXISTS`，可重复执行。
- **旧数据**：`owner_member_id` 一律 NULL = **未标注**，不猜测、不删除（PRD_phase2 §5）。
- **回滚**：加列不破坏 v1.0，前端不读新列即可；最坏情况 `ALTER TABLE ... DROP COLUMN`（不删数据行）。

### 4.2 `members_phase2`（成员 / 身份表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | SERIAL PK | |
| `display_name` | VARCHAR(60) | 显示名（如「张三」） |
| `identity_key` | VARCHAR(**128**) UNIQUE，**可空默认 NULL** | 身份键：口令方案下 = **口令的 scrypt 哈希**（不存明文）；微信方案下 = `uid`。<br>⚠️ 原稿写 `VARCHAR(64)` 会**直接报错**（见 §15 修订 2026-10-07） |
| `auth_kind` | VARCHAR(16) | `passcode` / `wechat`（预留） / `anon` |
| `role` | VARCHAR(16) | `member` / `readonly` / `admin`（admin 本期不用，留字段） |
| `border_color` | VARCHAR(7) | 协作外框色，如 `#2F6FED` |
| `meeting_no` | VARCHAR(32) | 该成员的个人腾讯会议号（A6） |
| `meeting_url` | VARCHAR(512) | 个人入会链接（A6） |
| `salt` | VARCHAR(32) | 口令哈希盐（仅 `passcode` 用） |
| `created_at` / `updated_at` | TIMESTAMP | 沿用触发器 |

> **为什么不复用 `owners` 表**：`owners` 是**前端设置弹窗维护的部门/人物标签**（`owner_key` → 记号 ★△○□☆），没有凭据、不鉴权，语义是"这是哪个部门"，不是"这是哪个登录的人"。合并会破坏 v1.0 的 `markOf()` 渲染链，也会让"部门"和"人"两个维度互相污染。**两个维度分开存**（见 §5.2）。

### 4.3 `audit_phase2`（操作留痕表）

`id` / `item_id` / `actor_id`（谁操作）/ `action`（create | update | delete | **place_for**）/ `target_id`（代排时：日程归属给谁）/ `at`。
用途只有一个：满足 PRD_phase2 A5 ②「给他人放置必须留痕」。

### 4.4 `items` 新增列

| 列 | 语义 |
|---|---|
| `owner_member_id` | 归属人（**谁的日程**） |
| `created_by` | 创建人 |
| `updated_by` | 最后修改人 |
| `border_color` | 冗余自成员（避免每次联表；成员改色时可批量同步，也可不回填——**P8 时定，默认冗余以简化前端**） |
| `meeting_url` / `meeting_no` | **单条覆盖**（PRD A6 优先级：单条 > 成员默认） |

> ⚠️ **更正 P2 的一处表述**：`PRD_phase2.md` §5.3 写「阶段一已预留 `tencent_meeting_*` 三字段」——经查 `db/schema.sql` 实测，那三列在 **`meeting_requests`** 表上，`items` 表**只有 `external_id`**。⇒ `items` 的会议字段属**新增**，不是复用。已同步修订 PRD。

---

## 5. 身份与鉴权设计（A1）

### 5.1 首选路径 vs 落地路径

| 路径 | 状态 | 说明 |
|---|---|---|
| **微信 / CloudBase auth** | ❌ 本期不做（P6 探针失败，归档 v1.2） | 须填 AppID+AppSecret，个人主体无法获取（服务号须微信认证 / 开放平台网站应用须认证）；且改变数据通道牵动面大 → 本期走口令方案 |
| **口令 / 邀请码** | **默认落地方案** | 零依赖、零外部服务，用 Node 内置 `crypto` 即可 |

> 探针不通过 → 直接走口令，**不阻塞 P7 里程碑**。

### 5.2 口令方案（零依赖实现）

**注册/入库**：管理员（你）在控制台手工 `INSERT` 成员行，或用一个一次性的本地脚本生成 `salt` + `scrypt` 哈希后写入。**明文口令只在生成时出现一次**。

**登录流程**：
1. 前端提交 `{ passcode }`（HTTPS 传输）。
2. 云函数：`identity_phase2.js` 按 `auth_kind='passcode'` 取成员行 → `crypto.scryptSync(passcode, salt, 64)` → 与 `identity_key` 做**定长常量时间比较**（`crypto.timingSafeEqual`，防时序侧信道）。
3. 校验通过 → 签发**成员令牌**：`base64url(payload).hmac`，payload = `{ mid, role, exp }`，HMAC-SHA256 密钥来自环境变量 `WORKSHOP_AUTH_SECRET`（**不进代码、不进仓库**）。有效期默认 7 天。
4. 前端存 localStorage，之后每个请求带 `X-Member-Token`。

**失败处理**：一律返回中文「口令无效，请联系管理员」，**不区分"口令不存在"与"口令错误"**（避免账号枚举）；英文细节只进日志。

### 5.3 ⚠️ 一个必须提前处理的坑：CORS 自定义头

前端带 `X-Member-Token` 属**非简单请求**，浏览器会先发 `OPTIONS` 预检；当前预检只放行 `GET/POST/OPTIONS` + `Content-Type` ⇒ **不改就会全部被拦**。

改动清单（P6 一并做）：
- `Access-Control-Allow-Headers` 增加 `X-Member-Token, Content-Type`
- `Access-Control-Allow-Methods` 增加 `PATCH, DELETE`
- 预检返回 204 且带同样的 `Allow-Origin`（白名单机制不变，**禁止 `*`**）

**兜底**：万一网关吃掉自定义头，令牌也可放请求体 `memberToken` 字段（与现有 `id` 走 body 的做法一致）。**两条路都留**。

> ✅ **P6-① 探针②实测结论（2026-10-07）：本节担心的「不改就被全部拦掉」不成立，但原因和预想的不同。**
> 三组对照（白名单 Origin + `X-Member-Token`／白名单 Origin + 随手编的 `X-Foo-Bar`／非白名单 Origin）：
> Origin 在白名单时，**CloudBase 网关自己接管了 OPTIONS 预检并原样回显请求里的头与方法**
> （请求 `X-Foo-Bar` 就回 `X-Foo-Bar`，请求 `DELETE` 就回 `DELETE`），云函数里那段 OPTIONS 代码根本没被调用；
> 非白名单 Origin 时才透传进云函数，且拿不到 `allow-origin`。
> ⇒ 结论：① `X-Member-Token` 可以直接用，不会被拦；② 白名单安全性未丢；
> ③ 云函数里的 `Allow-Headers` **仍然加上**（成本为零，防网关改行为）。§14 风险表该行降级为"低"。
>
> ⚠️ **实现层另一个坑（本地自测发现，E2 用例）**：`readTokenFrom()` 读请求体时，
> `event.body` 是 **JSON 字符串**不是对象，直接 `event.body.memberToken` 恒为 `undefined`，
> 会静默退回"没带令牌"——头那条路走得通、体这条永远走不通，且极难排查。已改为先 `JSON.parse` 再取值；
> 查询串同理兼容 `query` / `queryStringParameters` / `queryString` 三种形态。

---

## 6. 归属与权限设计（A2 / A5）

### 6.1 两个维度必须分开

| 维度 | 字段 | 谁维护 | 用来做什么 |
|---|---|---|---|
| **部门 / 人物标签** | `owner_key`（既有） | 前端设置弹窗 | 记号 ★△○□☆、类型色（v1.0 语义，**完全不变**） |
| **真实身份（谁）** | `owner_member_id`（新增） | 服务端成员表 | 外框色、权限判定、留痕 |

> **★ 颜色分工（不得违反）**：**填充色 = 日程类型**（会议蓝 / 行程橙…）；**外框色 = 人**（`border_color`）。二者并存不冲突。

### 6.2 四类放置权限（接口层判定，`identity_phase2.js` 之外新增 `acl_phase2.js`）

解析出 `actor`（当前操作者）后，按表判定：

| 场景 | 规则 | 越权响应 |
|---|---|---|
| ① 给自己放 | `owner_member_id === actor.id` → 允许 | — |
| ② 给他人放 | `role === 'member'` → 允许，但**必须写 `audit_phase2`**（`action='place_for'`, `target_id=归属人`） | — |
| ③ 只读 | `role === 'readonly'` → 任何写操作拒绝 | `403 中文：「当前身份为只读，无法修改日程」` |
| ④ 管理员 | 本期不实现 | — |

- **判定位**：在控制器里、调 DAL **之前**（不在前端隐藏按钮就算了）。
- **旧数据**：`owner_member_id IS NULL` 的项，本期**允许任何 member 编辑**（否则 11 条历史数据谁都改不了）；这条要在 P9 明确写进代码注释，避免日后误判为漏洞。

### 6.3 RLS vs 应用层（决策：**应用层**）

`research_phase2.md` 提到 PG RLS 更可靠，但结合 §1.1 事实 3：当前 Bearer 是 **service_role，天生绕过 RLS**。要启用 RLS 必须把数据通道换成用户态 token（每次请求带用户 JWT 访问 PostgREST），**等于重构 db.js 的鉴权与所有调用**。

⇒ **本期权限用应用层判定**；RLS 作为 v1.2 升级项，届时与微信身份一并切换（两者都依赖用户态 token，一起做才划算）。

### 6.4 并发（A10，P1）

乐观并发：`PATCH` 可选带 `baseUpdatedAt`（前端拿到数据时的 `updatedAt`）。服务端比对库中 `updated_at`：
- 一致 → 放行；
- 不一致 → `409 中文：「该日程已被他人修改，请刷新后重试」`（HTTP 409，不是 200）。
- 不带该字段 → 按现行"后写覆盖"处理（兼容 v1.0 行为，不破坏）。

---

## 7. 同步机制（A3 视图的数据来源）

| 方案 | 判定 | 说明 |
|---|---|---|
| **轮询（默认落地）** | ✅ | 前端每 **15 秒** 拉一次 `GET /api/items`（仅当前周范围）；页面隐藏时暂停（`visibilitychange`）。数据量级 < 1000 条，代价可忽略 |
| **CDC / watch（待探针）** | ⚠️ P6 实测 | 需库侧 `ALTER PUBLICATION` + 授权 + 引入客户端 SDK（**破坏零依赖**，R4 冲突）⇒ 倾向不做 |

> 轮询不做高频：体验版额度有限，15 秒是经过权衡的取值；若实测觉得迟钝再调，但**不低于 10 秒**。

---

## 8. 会议入会信息（A6 · 方案①）

### 8.1 数据落点与优先级

入会信息挂在**成员**上（每人自己的固定会议号），不挂在每条日程上：

```
显示优先级：items.meeting_url（单条覆盖）  >  members_phase2.meeting_url（成员默认）
```

- 未配置（两者都空）→ **不显示**入会入口，不报错、不空链。
- 仅对 `type = 'meeting'` 的日程生效。
- 卡片明确标注「个人会议室，注意别撞会」——**不假装是独立会议**（这是方案①的诚实代价）。

### 8.2 安全校验

`meeting_url` 写入时校验域名白名单：`meeting.tencent.com` / `voovmeeting.com` / `tencentmeeting.cn`（腾讯会议官方域名族）。不在白名单 → `400 中文：「入会链接必须是腾讯会议链接」`。防的是把任意 URL 塞进来（钓鱼面）。

---

## 9. 导出设计（A7 / A8）

### 9.1 CSV / JSON 导出（A7，P0）—— **前端生成，不加接口**

理由：导出是**只读**操作，前端已经通过 `GET /api/items` 拿到全量数据，浏览器里 `Blob` + `URL.createObjectURL` 直接下载即可，**不需要新接口、不需要新凭据、不消耗云函数额度**。

- 文件名带日期：`workshop-2026-10-06.csv`
- CSV 需处理转义（字段含逗号/引号/换行 → 双引号包裹 + 内部引号翻倍）、**UTF-8 BOM**（否则 Excel 打开中文乱码）。
- JSON 直接 `JSON.stringify(data, null, 2)`。

### 9.2 腾讯文档导出（A8，P1）—— **必须走服务端**

Token 不能进前端 ⇒ 新增**独立云函数** `export_phase2`（不与 `items` 混在一起，避免把 Token 相关代码塞进主链路）：

- `POST /api/export/doc` → 服务端持 Token（`TENCENT_DOC_TOKEN` 环境变量）调 MCP 端点 → 返回文档链接。
- Token 未配置 → `503 中文：「未配置腾讯文档凭据，请联系管理员」`（沿用 Day 23 的 auth 类文案）。
- **失败不影响主链路**：`items` 函数完全不依赖它。

---

## 10. 接口增量清单（对 `api-contract.md` 的改动，P5–P12 逐步落地）

| 接口 | 变化 | 兼容 |
|---|---|---|
| `POST /api/items` | 请求头/体可选带 `X-Member-Token` / `memberToken`；**不带则不鉴权**（= v1.0 行为，保证旧调用不崩）；带了则写入 `created_by` / `owner_member_id` | ✅ 向后兼容 |
| `GET /api/items` | 新增可选过滤 `member`（按归属人）；返回体增加新字段（**老字段一个不少**） | ✅ |
| `PATCH /api/items/:id` | 增加身份与权限判定、乐观并发 `baseUpdatedAt` | ⚠️ 只读身份会被拒（预期行为） |
| `DELETE /api/items/:id` | 同上的权限判定 | ⚠️ 同上 |
| **新增** `POST /api/auth/login` | 口令登录 → 返回成员令牌 | 新增 |
| **新增** `POST /api/auth/verify` | 校验令牌有效性（前端刷新后恢复身份用） | 新增 |
| **新增** `POST /api/export/doc` | 腾讯文档导出（P1） | 新增 |

> **兼容铁律**：`X-Member-Token` 缺省时，所有接口行为**必须与 v1.0 完全一致**——这样即使前端没跟上，线上也不会退化，`verify-project.js` 的 22 项仍应全绿。

---

## 11. 前端增量（不重构，只加）

| 位置 | 加什么 |
|---|---|
| 顶栏 | 「当前身份：张三」+ 切换身份；「导出」按钮 |
| 筛选区 | 「只看：全部 / 某人」（其余人**变淡不消失**，保上下文） |
| 设置弹窗 | 「我的会议号 / 入会链接」 |
| 卡片渲染 | 外框色 `border-color`；会议类显示入会入口 |
| 详情面板 | 归属 / 创建 / 最后修改；代排留痕 |
| 请求层 | 统一注入 `X-Member-Token`（封装一处，不散落各调用点） |

**不改**：布局（上下栏 + 左右分栏）、类型色映射、`markOf()` 记号链、路由。

---

## 12. 部署与回滚

- **部署顺序**：① 先跑 SQL 加列加表（控制台 SQL 编辑器）→ ② 再传云函数（`index.js` + `db.js` + `errors.js` + `identity_phase2.js` + `acl_phase2.js` **一并上传**，R6）→ ③ 最后传前端静态文件（只传改动文件到云端 `workshop/`，**禁用 `--prune`**）。
- **部署前**：`node resource/scripts/verify-project.js`（打线上）。
- **回滚**：按 `ROLLBACK.md` §7 判断表。加列本身不破坏 v1.0 ⇒ **绝大多数情况不需要回滚数据库**；真出问题回滚前端 + 云函数即可。

---

## 13. 待实测项（不写"应该可以"，跑过才算）

| # | 项 | 何时 | 不通过怎么办 |
|---|---|---|---|
| 1 | CloudBase 新版 auth SDK 在当前环境能否使用 | P6 探针 | 走口令方案（默认路径） |
| 2 | 自定义头 `X-Member-Token` 是否被网关放行 | P6 | 改走请求体 `memberToken`（已预留） |
| 3 | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 在控制台能否执行 | P5 | 改用控制台表管理界面加列 |
| 4 | PG CDC / 实时订阅 | P6（顺带） | 不做，走 15 秒轮询 |
| 5 | 腾讯文档 MCP Token 能否从云函数侧调通 | P10 | A8 不做，A7 CSV/JSON 兜底 |
| 6 | `crypto.scryptSync` / `timingSafeEqual` 在云函数 Node 版本可用 | P6 | 降级 `crypto.createHash('sha256')`（安全性略降但可用） |

---

## 14. 风险表

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 重跑 `db/schema.sql` 清空数据 | 低（有 R1 红线） | **高** | 脚本只用 `ALTER`，原文件加醒目注释禁止重跑 |
| 漏传云函数依赖文件 | 中（踩过 3 次） | 高（加载即崩） | 部署清单逐项核对（R6） |
| CORS 自定义头被拦 | 中 | 中 | 两条路都留，P6 实测（§5.3） |
| 权限判定漏在前端 | 中 | 中 | 判定位固定在控制器，代码评审逐项对照 §6.2 表 |
| 15 秒轮询消耗额度 | 低 | 低 | 页面隐藏暂停；额度异常则调至 30 秒 |
| 阶段二拖长影响 v1.0 | 中 | 中 | 任何一天出问题，前端可先不发布，线上仍是 v1.0 |

---

## 15. 修订记录

| 日期 | 位置 | 内容 | 依据 |
|---|---|---|---|
| 2026-10-06 | 全文 | 阶段二技术设计首稿（15 节） | 现网代码实测 + `PRD_phase2.md` + `research_phase2.md` |
| 2026-10-06 | §4.4 | 更正：`items` 表**没有** `tencent_meeting_*`（那三列在 `meeting_requests`），`items` 只有 `external_id` | 实测 `db/schema.sql` |
| 2026-10-06 | §6.3 | 权限实现定为**应用层**（因当前 Bearer 是 service_role，绕过 RLS），RLS 列 v1.2 | 实测 `db.js:44` |
| 2026-10-07 | §4.2 | **`identity_key` VARCHAR(64) → VARCHAR(128)`**：`crypto.scryptSync(pw, salt, 64).toString('hex')` 实测 **128 字符**（64 字节 → hex 翻倍）。按 64 写，INSERT 时直接 `value too long` 报错 | 本地 `crypto` 实测 |
| 2026-10-07 | §4.2 | **`identity_key` UNIQUE 改「可空 + 默认 NULL」**：原稿 `NOT NULL DEFAULT ''` 下，多个未设凭据的成员都是空串，第二个人会被唯一索引拒绝。PG 的 UNIQUE **允许多个 NULL**，故改可空 | PG 唯一约束语义 + 迁移脚本实践 |
| 2026-10-07 | §5.1 | **微信路线放弃**（探针①）：CloudBase 身份认证启用微信登录**必须填 AppID + AppSecret**，来源只能是服务号（须微信认证）或开放平台网站应用（须认证）——个人主体拿不到。本期身份定为**口令方案**。微信归档 v1.2 | 官方文档 + 用户控制台实测 |
| 2026-10-07 | §5.2 | 登录入参定为 **「显示名 + 口令」**（方案 B），非「只输口令逐人比对」（方案 A）。理由：后续要通用化，按名字定位比全表遍历更易扩展；代价是多输一项 + 名字可被枚举（已用统一错误文案 + 空跑哈希缓解） | 用户 2026-10-07 拍板 |
| 2026-10-07 | §5.3 | CORS 自定义头**不会被拦**：白名单 Origin 下网关自行接管预检并回显请求头，云函数 OPTIONS 代码未被调用。`X-Member-Token` 可用；云函数侧仍加 `Allow-Headers` 兜底 | 三组 curl 对照实测 |
| 2026-10-07 | §10 | 新增接口 `POST /api/auth/login`、`GET|POST /api/auth/verify`；**双进门路径**（`/api/auth/*` 路径 + `?_action=login|verify` 兜底），避免依赖网关路由配置 | P6-② 实现 |
