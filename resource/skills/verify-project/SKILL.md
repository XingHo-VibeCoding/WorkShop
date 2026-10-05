---
name: verify-project
description: WorkShop 会议工作台的「发布前检查」Skill。任何改动准备提交/部署前，先跑 resource/scripts/verify-project.js，逐项拿到 PASS/FAIL + 证据，专门拦截本项目 Day 15–24 真实踩过的坑（跨域 CORS、错误响应 HTTP 恒为 200、云函数漏传依赖文件、静态资源漏传、密钥进仓库、删除不设防）。当用户说「发布前检查」「上线前跑一遍」「verify」「检查一下有没有踩老坑」「部署前自检」时使用。
---

# verify-project · WorkShop 发布前检查

> **一句话**：把项目真实踩过的坑，从「文档里的字」变成「一条命令能跑出来的 PASS/FAIL」。
>
> **依据**：检查项全部来自项目真实踩坑记录 —— `DEPLOY.md`（Day 15/20 部署与跨域）、
> `resource/DAY24_Bug定位与修复.md`（Day 24 B1 错误状态码）、`SECURITY_CHECKLIST.md`（Day 23 密钥审计）、
> `AGENTS.md §十`（目录约定），不是通用套话清单。

---

## 1. 什么时候用

- 改动 `source/` 下任何文件、准备提交或部署**之前**；
- 每次在 CloudBase 控制台**重新部署云函数之后**（尤其新增/改动了依赖文件）；
- 用户说「发布前检查」「上线前跑一遍」「检查有没有踩老坑」时。

## 2. 怎么跑

```bash
# 全量检查（会真实调用线上接口，V3/V4/V5 会写 1 条测试数据并删除）
node resource/scripts/verify-project.js

# 只做本地静态检查，不碰线上（改前端样式、写文档时用）
node resource/scripts/verify-project.js --offline

# 本地直调模式：不走网关，直接 require 本地云函数喂 event
#   用途：验证「本地改动的代码」是否符合契约，不必先部署到线上
#   覆盖：V3（错误分支状态码）+ 全部静态项；V1/V2/V4/V5 自动跳过
node resource/scripts/verify-project.js --local

# 只跑某几项（逗号分隔）
node resource/scripts/verify-project.js --only=V3,V5
```

**三种模式怎么选**：

| 模式 | 打线上？ | 适合场景 |
|---|---|---|
| 默认（无参数） | ✅ 打线上 | 发布前总检查、部署后复验 |
| `--offline` | ❌ | 改前端/写文档时，只想快速查配置与资源完整性 |
| `--local` | ❌ | 改了云函数代码但**还没部署**，想先验本地代码对不对 |

> `--local` 的 V3 判定对「重复删」这条放宽为"≥400 且非 200"：本地无库凭据会抛 500 而非精确 404，属环境限制。

- 退出码：`0` = 全部 PASS；`1` = 有 FAIL（将来可直接接 CI，今天不接）。
- 每次运行都会把完整输出落盘到 `resource/logs/verify-project-<时间戳>.log`，作为可复查的证据。

## 3. 检查项与通过标准

| # | 检查项 | 通过标准 | 来源 |
|---|---|---|---|
| **V1** | 公网健康检查 | `GET /api/health` → HTTP 200 且 `{"ok":true,"service":"workshop"}` | Day 15 部署 |
| **V2a** | CORS 白名单命中 | 带白名单 Origin 请求 → 回该 `Access-Control-Allow-Origin` | Day 20 跨域 |
| **V2b** | CORS 非白名单 | 带非白名单 Origin → **不回** ACAO 头（不得用 `*`） | Day 20 跨域 |
| **V3** | 错误响应 HTTP 状态 | 4 类错误（空标题/非法 id/缺 confirm/重复删）HTTP 状态**必须 ≥400** 且与 `error.code` 一致 | **Day 24 B1** |
| **V4a** | 写入契约 | `POST /api/items` → 200 且 `data.id` 是数字 | Day 18 |
| **V4b** | 幂等键 | 同 `idempotencyKey` 重发 → **409** | Day 18 |
| **V4c** | 禁止零时长 | `POST` 且 `startTime === endTime` → **422** | Day 24 契约变更 |
| **V5a** | 删除须确认 | `DELETE` 不带 `confirm` → **400** | Day 18/22 |
| **V5b** | 缺 confirm 不误删 | 上一步之后数据**仍在** | Day 18/22 |
| **V5c** | 正常删除 | 带 `confirm=true` → 200 且返回被删快照 | Day 18/22 |
| **V5d** | 重复删 | 再删一次 → **404** | Day 18/22 |
| **V5e** | 删后不可见 | 删除后 `GET` 查不到该 id | Day 18/22 |
| **V6a** | 无硬编码密钥 | 全仓扫描（排除 `resource/`、日志）**0 命中** | Day 23 |
| **V6b** | `.env` 被忽略 | `git check-ignore -v .env` 命中 | Day 23 |
| **V6c** | `.env` 不在仓库 | `git ls-files` 无 `.env` | Day 23 |
| **V6d** | 示例文件无值 | `.env.example` 每行等号右侧为空 | Day 23 |
| **V7** | 依赖文件齐全 | `index.js` 里 `require('./x.js')` 的每个文件都真实存在 | **Day 20/22/23 踩三次** |
| **V8** | 静态资源完整 | `source/*.html` 引用的 css/js 都存在 | Day 15 B4 |
| **V9** | 前端地址一致 | `timeline.js` 与 `check.html` 的 `API_BASE` 完全相同 | Day 15/20 |

## 4. 关键坑位讲解（为什么这几项必须查）

- **V3（最值钱的一项）**：Day 24 之前，所有错误响应在 HTTP 层都是 `200`，错误码只藏在响应体里。**静态读代码看不出来**——`index.js` 的 `http()` 只是"没传 statusCode"，看着完全正常。只有跑起来才会发现全都是 200。这个坑正是本 Skill 存在的理由。
- **V7**：同一个错误踩了**三次**（Day 20 漏传 `db.js`、Day 22 漏传 `db.js`、Day 23 漏传 `errors.js`）。漏传的表现是线上报 `FUNCTIONS_INVOCATION_FAILED`——**加载阶段就崩，业务代码根本没执行**，很容易被误判成"业务报错"。V7 用静态 require 分析把这类问题在部署前拦下。
- **V8**：Day 15 B4 的坑——上传前端时目录结构错（`index.html` 没落在托管根）→ 页面白屏。
- **V2**：Day 20 硬性要求禁用 `*` 通配符；白名单只放行生产域名 + `localhost:8080`。

## 5. 数据安全约定

- V3/V4/V5 会真实调用线上接口。**写入的测试数据标题统一带 `[verify-project]` 前缀**，便于人工识别与搜索。
- 脚本在**每次运行末尾都会兜底清理**（无论中途成败）；清理失败会打印残留 id 与手动删除命令。
- 跑 V5 之前脚本会先确认"缺 confirm 的那次没把数据删掉"（V5b），**这条本身就是防误删的检查**。

## 6. 发现 FAIL 怎么办

1. 先看证据行（脚本已把 HTTP 状态、`error.code`、文件路径打在证据里），**不要凭感觉猜**；
2. 对照上表「来源」列，翻对应日期的记录（如 V3 → `resource/DAY24_Bug定位与修复.md`），那里有根因与修法；
3. **人工部署**：本项目的云函数部署是控制台手动操作（见 `DEPLOY.md`），脚本只做检查、**不代你部署**；改完代码需你自己重新上传（记得**连依赖文件一起传**，否则踩 V7 的坑）。

## 7. 能力边界（今天不做）

- ❌ **不接自动化流水线 / CI**（今日清单「今日不做」）。
- ❌ 不自动部署（部署是控制台人工操作）。
- ❌ 不做完整回归（那由 `day24-flow.js` 等专项脚本负责，本 Skill 只查"老坑有没有再犯"）。

## 8. 与项目其他检查工具的分工

| 工具 | 管什么 |
|---|---|
| **本 Skill（verify-project）** | 发布前**老坑专项自检**，聚焦"历史上犯过的错" |
| `source/cloud/items/test-local.js` | 写入类校验 8 用例（必填/白名单/格式/去重） |
| `source/cloud/items/test-local-day22.js` | 删除类 28 用例（四条闸门） |
| `source/cloud/items/verify-day23.js` | 三类错误提示是否中文 |
| `resource/scripts/day24-flow.js` | 核心流程六步 + 刁钻输入的端到端回归 |
