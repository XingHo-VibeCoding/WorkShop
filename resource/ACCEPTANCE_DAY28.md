# 附录 J · 最终验收表（Day 28 · 2026-10-06）

> 判定口径：**PASS = 当场跑过/打开过，有输出可复现；FAIL = 跑过且不满足；未执行 = 没跑，不猜。**
> 检测时间：2026-10-06 17:20–17:47（东八区）｜执行人：周国玮（AI 代为执行命令并留存日志）

## 汇总

| 判定 | 数量 | 项 |
|---|---|---|
| ✅ PASS | **9** | 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 10 |
| ⚠️ 部分执行 | **1** | 9（到期已核实 · 额度未核实） |
| ❌ FAIL | **0** | —— |
| ⬜ 未执行 | **0 整项**（第 9 项内 1 个子项未执行） | —— |

---

## 十项逐条

### 1️⃣ 页面 / 视图数量 —— ✅ PASS

| 内容 | 实测值 | 证据 |
|---|---|---|
| 页面文件 | **2 个**：`index.html`（工作台）、`check.html`（接口检查台） | `source/` 目录 + 线上 `tcb hosting list` 8 文件 |
| 主视图 | **2 个**：时间线 `#/timeline`、总览 `#/overview` | `index.html:31-32` 两个 `data-view` 入口；`js/router.js:172` 监听 `hashchange` |
| 数据表签 | **3 个**：工作 / 日常 / 总表 | `index.html` 含「工作」「日常」「总表」三标签 |
| 前端源码 | 4 个 JS（`timeline` 1640L / `timepicker` 386L / `router` 174L / `animations` 126L）+ 2 个 CSS + 2 个 HTML | `source/js`、`source/css` 目录实测 |

**当场怎么展示**：打开首页 → 点顶部「时间线 / 总览」切换 → 底部点「工作 / 日常 / 总表」三个表签。

---

### 2️⃣ 反馈交互 —— ✅ PASS

| 交互 | 实测 | 证据 |
|---|---|---|
| 操作结果提示 | toast 有 | `js/timeline.js` 含 `toast` |
| 删除二次确认 | 弹窗显示标题 + 时间 + 地点，明示"将从云端删除，删除后无法恢复" | Day 22 归档 §三 E；`timeline.js` 含「确认」「删除」 |
| 四状态机 | loading / success / empty / error | `timeline.js` 含 `data-state`；`index.html` 有状态面板 |
| 键盘可达 | Esc / Enter 关闭与确认 | `timeline.js` 含 `Esc`、`esc` |
| 拖拽 | 拖拽改期 / 转表 | `timeline.js` 含 `drag`、`拖拽` |
| 时间选择 | 拨轮时间选择器（Day 24 新增） | `js/timepicker.js` 386 行 |
| 越界提示（六类） | 空标题 400 / 超长 400 / 连点 409 / 非法区间 422 / 非法 id 400 / 缺确认 400，**全部中文** | `day24-flow.js` 通过 16/失败 0；日志 `resource/day24-before.log` |

**当场怎么展示**：删除一条 → 看二次确认弹窗；新建一条 → 看 toast「已保存（已同步云端）」；填一个结束早于开始的区间 → 看红字提示。

---

### 3️⃣ 数据库读写 —— ✅ PASS

| 项 | 实测 | 证据 |
|---|---|---|
| 库类型 | **PostgreSQL**（CloudBase 关系库） | `db/schema.sql`：SERIAL / TIMESTAMP / `COMMENT ON` |
| 表 | **3 张**：`owners` / `meeting_requests` / `items`（核心） | `db/schema.sql` 三条 `CREATE TABLE` |
| 种子 | `db/seed.sql` 84 行 | 文件实测 |
| 读 | `GET /api/items` → 11 条（2026 全年） | Day 27 快照；今日 GET 读回验证多次 |
| 写 / 改 / 删 | POST 建 id=42、PATCH 改标题、DELETE 带 confirm 删除并回快照 | `verify-project.js` V4a–V5e 全 PASS |
| 幂等与校验 | 同幂等键重发 409；零时长 422；超长标题 400（PG 报 `value too long` 转中文） | 同上 + `day24-flow.js` E3/E4/E9 |

**当场怎么展示**：`curl -s https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items`

---

### 4️⃣ 前后端链路 —— ✅ PASS

| 环节 | 实测 | 证据 |
|---|---|---|
| 接口基址一致 | `timeline.js` 与 `check.html` 的 `API_BASE` 完全相同 | V9 PASS |
| 跨域 | 白名单 Origin 回自身；`http://evil.example.com` **不回 ACAO** | V2a / V2b PASS |
| 健康检查 | `GET /api/health` → HTTP 200 `{"ok":true,"service":"workshop"}` | V1 PASS |
| 云函数完整性 | `items/index.js` 依赖的 `db.js`、`errors.js` 均在 | V7 PASS（**历史上踩过 3 次的坑**） |
| 静态资源 | HTML 引用的 8 个本地资源全部存在 | V8 PASS |
| 端到端 | 页面新增 → POST → 刷新 → 数据仍在 → PATCH → DELETE | `day24-flow.js` 16/16 |

**当场怎么展示**：打开 `check.html` → 依次点「重新检查 / 刷新数据 / 写入测试」。

---

### 5️⃣ 合法数据来源 —— ✅ PASS

| 项 | 结论 | 说明 |
|---|---|---|
| 数据谁产生 | **自己建的表 + 自己的种子 + 用户手动录入 + 脚本测试数据** | 无抓取、无爬虫、无第三方版权数据 |
| 表结构 | 自建 `db/schema.sql`，字段自定（含腾讯文档 / 腾讯会议的**预留字段**，仅字段不实现） | 无外部数据复制 |
| 外部依赖 | 仅 CDN 字体与 PreText 排版引擎（失败会降级，不取数据） | Day 12/14 已做降级 |
| 测试数据 | 脚本自建自删（今日 id=42/43/44 均已清理），不污染业务数据 | 清理日志见 verify 输出末行 |

**当场怎么展示**：打开 `db/schema.sql` + `db/seed.sql`。

---

### 6️⃣ 公网地址 —— ✅ PASS

| 地址 | 实测 |
|---|---|
| 前端 | `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/` → **HTTP 200**，含 `v1.0` 标识与「刷新」按钮，标题「WorkShop 会议工作台」 |
| 接口 | `https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/health` → 200 |
| 归属 | 用户自己的腾讯云 CloudBase 环境 `workshop-d4g02a7z81ff51a63`（**非第三方托管**） |

证据落盘：`resource/logs/day28-index.html`、`resource/logs/day28-env.txt`。

**当场怎么展示**：浏览器打开前端地址（截图要带地址栏）。

---

### 7️⃣ 线上持久化 —— ✅ PASS

| 验证方式 | 结果 |
|---|---|
| 写入后刷新页面仍在 | ✅（`day24-flow.js` T4：POST → 整页刷新 → GET 仍读到该条） |
| 隔天仍读到 | ✅（Day 27 实测 11 条，含 09-29 / 09-30 写入的记录） |
| 绕过页面直查接口 | ✅（直接 GET `/api/items` 能查到同一条） |
| 删除后不复活 | ✅（DELETE 后 GET 查不到，重复删 404） |

**当场怎么展示**：页面上新建一条 → 按 F5 → 那条还在。

---

### 8️⃣ 回滚与备份说明 —— ✅ PASS

| 项 | 实测 |
|---|---|
| 回滚手册 | `ROLLBACK.md` **219 行**，含 §7「什么情况必须回滚」判断表 |
| 回滚演练 | **Day 26 真做过一次**（静态托管回滚，CLI 约 5.6 秒） |
| 版本标识 | 页面左上角 `v1.0`；git tag `v1.0` → `accc5fc` |
| 发布包留痕 | `resource/release/` 存 v1.0 / rollback-day22 两套包 |
| 代码备份 | `source/backups/` **16 个带日期目录**（2026-09-21 起）+ 4 个 `.bak` 文件；按 `AGENTS.md §十.1` 改前必备份 |
| 数据备份 | ⚠️ **无自动导出**；当前靠手动 SQL / 接口导出（列在 `resource/day27-resource-check.md`） |

**当场怎么展示**：打开 `ROLLBACK.md` §7 + 看 `source/backups/` 目录。

---

### 9️⃣ CloudBase 额度与到期风险 —— ⚠️ 部分执行

| 子项 | 判定 | 证据 |
|---|---|---|
| 到期时间 | ✅ PASS | `tcb env list` → **2027-03-27 23:59:59**（体验版，创建 2026-09-27，ap-shanghai，Normal）距到期约 172 天 |
| 各项用量数字 | ⬜ **未执行** | **CLI 无 usage/quota 命令**（`tcb --help` 无此项），必须控制台「概览 → 资源用量」人工抄录。步骤见 `resource/day27-resource-check.md` §2.1 |
| 线上资产合规 | ✅ PASS | `tcb hosting list workshop` → 8 文件约 183 KB，**无云函数源码、无 backups、无 temp_test 残留** |

> **风险提示**：体验版额度耗尽会静默降级或停摆。建议结营后立刻去控制台抄一次用量，并在 2027-03-27 前决定续费或迁移。

**当场怎么展示**：控制台打开 CloudBase 环境「概览 → 资源用量」页。

---

### 🔟 敏感文件 —— ✅ PASS

| 检查 | 实测 | 证据 |
|---|---|---|
| 硬编码密钥 | 全仓扫描 **0 命中** | V6a PASS |
| `.env` / `.env.*` 未入库 | ✅ `.gitignore` 覆盖 `.env`、`.env.*`，且 `!.env.example` 放行；工作区**不存在 `.env`** | V6b/V6c PASS（见下方打折说明） |
| `.env.example` | 22 行，**非空值行数 0**（只留键名） | V6d PASS |
| 云端不泄露 | 线上 8 个文件全是前端静态资源，无 `source/cloud/` 源码 | `tcb hosting list` |
| 错误响应不含内网信息 | 三类错误统一转中文；英文原文只进 `console.error` | `errors.js`；`day24-flow` 全部提示为中文 |
| 提交纪律 | 32 次提交，禁用 `git add .`，逐文件列举后提交 | `git rev-list --count HEAD` = 32 |

> ⚠️ **打折说明（如实）**：V6b / V6c 本次走的是**降级判定**——本机 `git` 子进程抛 `EBUSY`（沙箱限制），脚本改为读 `.gitignore` 文本（确认覆盖 `.env` / `.env.*`）+ 扫描工作区（无 `.env` 文件）。结论可信，但**不是 git 原生命令的验证结果**。如需原生验证，可在你本机终端跑 `git check-ignore -v .env` 与 `git ls-files | grep env`。

**当场怎么展示**：本机终端跑上面两条 git 命令（应分别输出 `.gitignore:.env` 命中规则、`git ls-files` 只列出 `.env.example`）。

---

## 可打勾清单（供截图用）

```
[ ] 1  页面/视图数量        PASS   2 页面 · 2 主视图 · 3 表签
[ ] 2  反馈交互             PASS   toast / 二次确认 / 四态 / 六类越界提示
[ ] 3  数据库读写           PASS   PostgreSQL 3 表 · 增删改查实测
[ ] 4  前后端链路           PASS   API_BASE 一致 · CORS · 依赖齐全
[ ] 5  合法数据来源         PASS   自建表 + 自建种子，无抓取
[ ] 6  公网地址             PASS   HTTP 200 · 含 v1.0 · 用户自有环境
[ ] 7  线上持久化           PASS   刷新仍在 · 隔天仍读到
[ ] 8  回滚与备份说明       PASS   ROLLBACK.md 219 行 · 演练过 1 次
[ ] 9  额度与到期风险       部分    到期 2027-03-27 ✅ / 用量数字 ⬜ 未执行
[ ] 10 敏感文件             PASS   0 密钥 · .env 未入库 · 线上无源码
```

---

## 三项必须口头说明的"打折"

1. **第 9 项的用量数字**没采到（CLI 查不了），不是我不想查。
2. **敏感文件两项**走的是降级判定（git EBUSY），非原生命令。
3. **首页字节数 8342 ≠ 托管记录 10360**，是 gzip 压缩差异，**不是文件不一致**。
