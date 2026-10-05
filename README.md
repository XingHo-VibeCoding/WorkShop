# WorkShop 会议工作台

> 排会议、理行程、管日程的工作台。当前进度：**Day 26**（**v1.0 已发布** + 完成一次真实回滚演练）。
> 完整文档：产品需求见 [`PRD.md`](PRD.md)、接口契约见 [`api-contract.md`](api-contract.md)、
> 本地运行见 [`RUN.md`](RUN.md)、部署见 [`DEPLOY.md`](DEPLOY.md)、**出事要回滚见 [`ROLLBACK.md`](ROLLBACK.md)**、
> 云端资产见 [`CLOUD_ASSETS.md`](CLOUD_ASSETS.md)。

---

## 快速开始

```bash
# 1. 本地起静态服务（前端 + 检查台）
cd source && python -m http.server 8080
#   浏览器打开 http://localhost:8080/          → 周时间线工作台
#   浏览器打开 http://localhost:8080/check.html → 接口检查台（一屏验完所有接口）

# 2. 环境变量（仅本地/部署需要，密钥不进仓库）
cp .env.example .env      # 再把真实值填进去，键名含义见 .env.example 注释
```

> ⚠️ 本地调试端口必须是 **8080**：云函数 CORS 白名单只放行生产域名 + `localhost:8080` / `127.0.0.1:8080`。

## 目录结构

| 目录 / 文件 | 放什么 |
|---|---|
| `source/` | 前端代码（`index.html` / `check.html` / `css/` / `js/`） |
| `source/cloud/` | 云函数（`health/` 健康检查、`items/` 事项增删改查），**不是前端，别上传到静态托管** |
| `db/` | 数据库脚本（`schema.sql` / `seed.sql`，PostgreSQL 方言） |
| `resource/` | 资源与产物：脚本、日志、技能、测试清单 |
| `resource/skills/` | 项目自用 Skill |
| `resource/scripts/` | 验证 / 回归脚本 |
| `resource/logs/` | 每次检查的落盘证据 |

---

## 🔍 发布前检查（verify-project Skill）

**任何改动准备提交 / 部署之前，先跑一遍这个。** 它专门拦截本项目历史上真实踩过的坑
（跨域 CORS、错误响应 HTTP 恒为 200、云函数漏传依赖文件、静态资源漏传、密钥进仓库、删除不设防）。

```bash
# 发布前总检查（打线上接口；会写 1 条带 [verify-project] 前缀的测试数据并在末尾删除）
node resource/scripts/verify-project.js

# 只做本地静态检查，不碰线上（改前端样式、写文档时用）
node resource/scripts/verify-project.js --offline

# 本地直调模式：不走网关，直接 require 本地云函数
#   用途：改了云函数代码但还没部署，先验本地代码对不对
node resource/scripts/verify-project.js --local

# 只跑某几项
node resource/scripts/verify-project.js --only=V3,V5
```

**输出**：逐项 `PASS` / `FAIL` + 证据行，末尾给汇总与未通过项清单。
**退出码**：`0` = 全 PASS，`1` = 有 FAIL。
**证据**：每次运行自动落盘 `resource/logs/verify-project-<时间戳>.log`。

### 检查项一览

| 组 | 项 | 查什么 |
|---|---|---|
| ① 公网与跨域 | V1 / V2a / V2b | 健康检查可达、CORS 白名单命中且非白名单不回 ACAO |
| ② 契约与错误 | V3 | 错误响应 HTTP 状态码 ≥400（Day 24 那个"全是 200"的坑） |
| | V4a/b/c | 写入返回 id、幂等键 409、零时长 422 |
| | V5a–e | 删除须确认、缺确认不误删、正常删除、重复删 404、删后不可见 |
| ③ 安全与配置 | V6a–d | 无硬编码密钥、`.env` 被忽略、不在仓库、示例文件值全空 |
| ④ 代码与资源 | V7 | 云函数本地 `require` 的依赖文件齐全（漏传会崩） |
| | V8 | HTML 引用的 css/js 都存在（漏传会白屏） |
| | V9 | `timeline.js` 与 `check.html` 的 `API_BASE` 一致 |

完整说明（含"为什么查这几项"与发现 FAIL 后怎么办）见
[`resource/skills/verify-project/SKILL.md`](resource/skills/verify-project/SKILL.md)。

### 其他专项脚本

| 脚本 | 管什么 |
|---|---|
| `source/cloud/items/test-local.js` | 写入类校验 8 用例 |
| `source/cloud/items/test-local-day22.js` | 删除类 28 用例 |
| `source/cloud/items/verify-day23.js` | 三类错误提示是否中文 |
| `resource/scripts/day24-flow.js` | 核心流程六步端到端回归 |

---

## 线上入口

| 项 | 地址 |
|---|---|
| 前端页面 | https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/ |
| 接口基址 | https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com |

> **页面左上角有 `v1.0` 标签**（Day 26 加），一眼能确认线上跑的是哪一版。
> 真出事要回滚：**先看 [`ROLLBACK.md`](ROLLBACK.md) §7 判断表**，别凭直觉回滚 —— 回滚的代价是约 1 分钟全站中断。
> 推荐路径是 CLI 一条命令（实测 5.6 秒），控制台手动上传约 1.5–4 分钟。

## 开发约定

- 改 `source/` 既有文件前，先按 `AGENTS.md §十.1` 复制带日期的备份到 `source/backups/YYYY-MM-DD-dayN/`。
- 时间统一 `YYYY-MM-DD HH:mm`（东八区）。
- 密钥、`.env`、连接串永不进仓库、不进提交（`.gitignore` 已覆盖 `.env` 及变体）。
- 云函数改动后**必须连依赖文件一起上传**，否则线上报 `FUNCTIONS_INVOCATION_FAILED`。
