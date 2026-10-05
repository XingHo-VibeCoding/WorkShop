# Day 24｜WorkShop 核心流程测试清单

> 用途：这份清单**前后要跑两遍**——修复前一遍（`day24-before.log`）、修复后一遍（`day24-after.log`），
> 两遍用完全相同的步骤与判定标准，才能证明"Bug 真的被修掉了"，而不是"这次碰巧没复现"。
> 创建：2026-10-04（Day 24）　项目：WorkShop 会议工作台　环境：CloudBase `workshop-d4g02a7z81ff51a63`

---

## 0. 术语映射（清单里的 `plan_days / checkins` → 本项目真实实体）

清单原文用的是通用模板词，本项目**不存在** `plan_days` / `checkins` 这两张表（全仓 grep 0 命中）。
按 Day 24 拍板方案 **B（映射 + 检查台补区块）**，把这两个词映射到项目真实实体上：

| 清单术语 | 本项目真实对象 | 说明 |
|---|---|---|
| `plan_days`（计划日） | `items` 表的**周视图**：`GET /api/items?start=…&end=…` | 周时间线上的计划事项，`table_kind` 区分 `work`/`daily` |
| `checkins`（打卡记录） | `items` 表的**记录视图**：`POST /api/items` 写入 + `GET` 读回 | 一次"打卡"= 写入一条事项并读回确认 |
| 打卡写入 | `POST /api/items`（含 `idempotencyKey`） | 幂等键防重复提交 |
| 打卡修改 | `PATCH /api/items/:id` | 部分更新 |
| 打卡删除 | `DELETE /api/items/:id?confirm=true` | 硬删除 + 强制确认 |

### 0.1 映射函数（清单通用记录 → items 写入体）

检查台 `source/check.html` 与脚本 `resource/scripts/day24-flow.js` **共用同一套映射**，保证两边行为一致：

```js
// 通用记录 → items 写入体（camelCase；云函数侧再映射为 snake_case）
function toItemPayload(rec) {
  return {
    table:           rec.kind === 'daily' ? 'daily' : 'work',
    type:            TYPE_MAP[rec.type] || 'other',   // meeting/class/trip/sport/life/other
    title:           String(rec.title || ''),
    startTime:       rec.start,        // 'YYYY-MM-DD HH:mm'，东八区
    endTime:         rec.end,          // 须 >= startTime
    attendees:       rec.people || '',
    venue:           rec.place || '',
    note:            rec.note || '',
    ownerKey:        rec.owner || 'self',
    idempotencyKey:  rec.reqId || ('day24-' + Date.now()),
  };
}
```

> 字段取值域、必填与错误码以 `api-contract.md` §三 为准；本函数只做"命名与形状"的映射，不做校验。

---

## 1. 前置条件（跑之前先确认，否则失败不算 Bug）

| # | 条件 | 怎么确认 |
|---|---|---|
| P1 | 本地静态服务跑在 **8080 端口** | CORS 白名单只放行线上域名 + `localhost:8080`/`127.0.0.1:8080`（`api-contract.md` §一）。用 8000 会被跨域挡掉，那是环境问题不是 Bug |
| P2 | 接口基址正确 | `https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com` |
| P3 | Node 可用 | `node -v`（本机 24.21.0，自带 `fetch`，脚本不需要装依赖） |

启动命令（PowerShell / bash 均可）：

```bash
cd D:/ima/VibeCoding/source && python -m http.server 8080
# 或：npx http-server -p 8080
```

---

## 2. 六步完整链路（核心流程）

> **判定符号**：✅ 通过　❌ 失败（记入 Bug）　⚠️ 通过但与预期不符（记入观察项）
> 每一步都要留下**可复制的原文**（HTTP 状态 + 响应体关键行），不写"好像正常"。

| 步 | 操作 | 预期结果 | 证据形式 | 判定 |
|---|---|---|---|---|
| **T1 打开检查台** | 浏览器开 `http://localhost:8080/check.html` | ① 健康区块绿点 + `{"ok":true,"service":"workshop"}`；② items 区块出本周表格；**F12 Console 无红色报错** | 控制台截图（含地址栏） | ☐ |
| **T2 读取** | `GET /api/items?start=<本周一 00:00>&end=<本周日 23:59>` | `HTTP 200` + `{ok:true, data:[…]}`，`data` 是数组（空数组也算通过） | 脚本输出 / Network 响应原文 | ☐ |
| **T3 写入打卡** | `POST /api/items`，body = `toItemPayload(测试记录)` | `HTTP 200` + `{ok:true, data:{id:<数字>}}`；重复提交同一 `idempotencyKey` → `409` | 脚本输出（含返回 id） | ☐ |
| **T4 刷新确认** | 用 T3 的 id 重跑 `GET`（同一天范围） | 新 id **出现在列表里**，且 `title/startTime/endTime` 与写入一致 | 脚本输出（`found=true`） | ☐ |
| **T5 修改** | `PATCH /api/items?id=<id>`，body `{"title":"…（改）"}` | `HTTP 200` + 返回**更新后整条**，`title` 已是新值，`updatedAt` 变化 | 脚本输出 / 检查台 ④ 区块 | ☐ |
| **T6 删除** | `DELETE /api/items?id=<id>&confirm=true` | `HTTP 200` + `{ok:true,data:{deleted:true,item:{…快照…}}}`；再 `GET` 一次 → 该 id **不在**列表；重复删 → `404` | 脚本输出 / 检查台 ⑤ 区块 | ☐ |

**链路判定**：T1–T6 全 ✅ 才算"核心流程通"。任一 ❌ 即锁定为一个 Bug（记入 §4）。

---

## 3. 刁钻输入用例（降级项：找不到 Bug 时用这批用例逼出来）

| # | 用例 | 输入 | 预期 |
|---|---|---|---|
| E1 | 空值 | `title: ""` | `400` + 中文"缺少必填字段"；**不应 500** |
| E2 | 超长文本 | `title` = 500 字 | `400` 或按 200 长度截断（`VARCHAR(200)`）；**不能 500 崩库** |
| E3 | 快速连点 | 同一 `idempotencyKey` 连发 3 次 POST | 首次 200，**后两次 409**，库里只 1 条 |
| E4 | 非法时间区间 | `endTime < startTime` | `422` + 中文提示 |
| E5 | 非法 id | `PATCH ?id=u1718abc`（本地临时 id）/ `id=abc` / 不传 id | `400` + 中文；**不能整表更新** |
| E6 | 删除不设防 | `DELETE ?id=<id>` 不带 `confirm` | `400`；**不能删掉数据** |
| E7 | 删后再删 | 同一 id 删第二次 | `404` + "可能已被删除"；**不能报 500** |
| E8 | **零时长（已改判定）** | `PATCH` 只改 `startTime =` 原 `endTime` | **契约变更后 `422`**（原为期望 200，随"禁止零时长"反转） |
| E9 | **零时长新建** | `POST` 时 `startTime === endTime` | `422` + "结束时间须晚于开始时间" |
| E10 | **防误伤** | `PATCH` 只把 `endTime` 后推 30 分钟 | `200` 放行（正常改动不得被区间校验拦住） |

---

## 4. Bug 记录表（复现后填写，格式：现象 / 复现步骤 / 报错原文 / 已尝试动作）

| ID | 现象 | 复现步骤 | 报错原文（复制粘贴） | 已尝试动作 | 状态 |
|---|---|---|---|---|---|
| B1 | | | | | ☐ 待填 |

---

## 5. 两遍证据文件

| 轮次 | 文件 | 说明 |
|---|---|---|
| 修复前 | `resource/day24-before.log` | 由 `node resource/scripts/day24-flow.js before` 生成 |
| 修复后 | `resource/day24-after.log` | 由 `node resource/scripts/day24-flow.js after` 生成 |

两份文件用 `diff` 对照，只有 Bug 相关行应该变化，其余步骤结果必须一致（否则说明改动引入了回归）。

---

## 6. 今日不做（发现但不动手，只记录）

| # | 发现 | 为什么今天不做 |
|---|---|---|
|  | （复现过程中发现的其他 Bug 记在这里） | Day 24 清单「今日不做：顺手修别的 Bug」 |
