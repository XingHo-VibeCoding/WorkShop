# WorkShop 回滚手册（ROLLBACK.md）

> 什么时候翻这份手册：**线上出事了，你要决定"回滚还是硬修"，以及"怎么回滚"**。
> 建立日：Day 26（2026-10-05），内容基于当天**真实演练实测**，不是推测。
> 环境：`workshop-d4g02a7z81ff51a63`（体验版，到期 2027-03-27）｜前端域名 `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/`

---

## 0. 三十秒速查

| 你要做什么 | 用哪条 | 命令 |
|---|---|---|
| **前端回滚到上一版**（推荐） | CLI（P2） | `tcb hosting deploy <本地目录> workshop -e workshop-d4g02a7z81ff51a63 --verify` |
| 没有 CLI 时 | 控制台（P1） | 静态网站托管 → 文件管理 → 上传 `resource/release/workshop` |
| 云函数出问题 | P3（备查，未实操） | 见 §5 |
| 数据被误删 | P4（备查，未实操） | 见 §6 |
| 拿不准要不要回滚 | 判断表 | 见 §7 |

**先跑一条命令确认线上现在跑的是哪一版**：
```bash
node resource/scripts/rollback-watch.js --once
# 输出：线上 index.html MD5 + 判定（v1.0 / day22 / head / 未知版本）
```

---

## 1. 关键事实（踩过才知道）

| 事实 | 影响 |
|---|---|
| **对外根路径 = 云端 `workshop/`** | CLI 传 `cloudPath=/` 的文件**对外访问不到**；必须传 `workshop`（§2 有实测证据） |
| **`workshop/` 是环境名前缀，不是你上传的目录名** | 控制台上传文件夹不会把你的目录名带进路径（Day 26 实测确认） |
| **静态托管没有版本管理** | 没有"一键回到上一版"的按钮，回滚 = 把旧文件重新传一遍 |
| **回滚期间线上会短暂 404** | 实测发布时中断 **77 秒**（覆盖上传期间旧文件已摘、新文件未挂） |
| **`--prune` 是红线** | 它会删除"不属于本次发布的远端文件"，包括平台系统目录 `__auth/`、`cloud-admin/` |

---

## 2. P1：控制台手动回滚（实测路径）

**适用**：没装 CLI、或 CLI 登录失效时的兜底。

### 步骤

1. 本地准备要回滚到的版本：
   ```bash
   node resource/scripts/prepare-release.js --version=rollback-day22
   # 生成固定目录 resource/release/workshop/（同名重建，内容只有目标版本）
   ```
   内置版本：`v1.0` / `rollback-day22` / `rollback-day22-diff`（只含 4 个差异文件）
   也可以用任意目录：`--from=<目录>`
2. 控制台 → 环境 `workshop-d4g02a7z81ff51a63` → **静态网站托管** → **文件管理**
3. **上传文件夹** → 选 `D:\ima\VibeCoding\resource\release\workshop` → 同名文件选**覆盖**
4. 打开前端域名，`Ctrl+F5` 强制刷新

### 实测耗时（Day 26）

| 动作 | 端到端耗时 | 中断窗口 |
|---|---|---|
| 发布 v1.0（第一次走流程） | 6 分 10 秒 | 77 秒 404 |
| 回退到 Day 22 | 3 分 56 秒 | 5 秒轮询粒度下未观测到 |
| 恢复 v1.0（同一动作第三次） | **1 分 36 秒** | 未观测到 |

> **读法**：差异主要来自操作熟练度。真出事、流程走过一遍的情况下，**约 1.5–4 分钟**。

---

## 3. P2：CLI 一条命令回滚（推荐 · 实测 5.6 秒）

### 安装与登录（只需一次）

```bash
# 装在隔离 workspace，不污染全局（已装好）
cd C:\Users\周国玮\.workbuddy\binaries\node\workspace
npm install @cloudbase/cli

# 登录：会打开浏览器，用腾讯云账号授权（凭据存本机用户目录，不进项目、不进 git）
node_modules\.bin\tcb.cmd login
node_modules\.bin\tcb.cmd env list     # 应能看到 workshop-d4g02a7z81ff51a63
```

### 发布 / 回滚（同一条命令，只换本地目录内容）

```powershell
# 1. 把目标版本装进固定目录
node resource/scripts/prepare-release.js --version=rollback-day22

# 2. 一条命令推上去（cloudPath 必须是 workshop，不能是 /）
cd C:\Users\周国玮\.workbuddy\binaries\node\workspace
.\node_modules\.bin\tcb.cmd hosting deploy "D:\ima\VibeCoding\resource\release\workshop" workshop -e workshop-d4g02a7z81ff51a63 --verify
```

**实测：5.6 秒完成（含 `--verify` 远端校验）。**

### 有用的开关

| 开关 | 作用 |
|---|---|
| `--verify` | 发布后校验远端文件与本地一致（**建议常开**） |
| `--safe` | 发布前自动备份，上传或校验失败时**自动回滚**（高风险发布建议开） |
| `--prune` | ⛔ **禁用**：会删掉本次发布之外的远端文件，包括 `__auth/`、`cloud-admin/` |

> CLI 提示：`Need version management? Use tcb app deploy for cloud builds, rollbacks, and service name management`
> —— 若要真正的"版本管理 + 平台级回滚"，下一步可评估 `tcb app deploy`（Day 26 未做）。

---

## 4. ⚠️ 三个坑（今天全踩了一遍）

### 坑 1：CRLF 让哈希永远对不上

本机 `core.autocrlf=true` —— git 里存 LF，工作树检出成 CRLF。
比对文件前**必须去掉 CR**，否则 `git show HEAD:file` 和工作树文件哈希永远不同，会误判"线上版本落后"。

```bash
tr -d '\r' < 文件 | md5sum    # 正确姿势
```
`resource/scripts/rollback-watch.js` 内部已处理（`.replace(/\r/g,'')`）。

### 坑 2：Git Bash 会把 `D:/...` 路径转坏

Git Bash（MSYS）自动转换路径后传给 Windows 原生程序 —— Day 26 实测把
`D:/ima/VibeCoding/resource/release/workshop` 转成了
`C:/Users/周国玮/.workbuddy/binaries/PortableGit/versions/1.2.0/`，
导致 8 个文件被传到错误云端路径（**且路径里带本机用户名，属于信息暴露**）。

**修法**：跑 CLI 用 PowerShell / cmd，或在 bash 里先 `export MSYS_NO_PATHCONV=1`。

### 坑 3：cloudPath 写 `/` 传不到对外路径

CLI `hosting deploy <dir> /` 会传到云端根，但**对外访问不到**（对外根 = 云端 `workshop/`）。
Day 26 因此多出 8 个无效文件，已清理。
**cloudPath 必须写 `workshop`。**

---

## 5. P3：云函数回滚（备查 · Day 26 未实操）

**前提**：CloudBase 云函数若控制台提供"版本管理"，优先用平台版本回退（更快、有记录）。
若没有，按下面手工回退。

### 步骤（备查）

1. 从 git 取出要回退到的云函数代码：
   ```bash
   git show <commit>:source/cloud/items/index.js > /tmp/index.js
   ```
2. **连同依赖文件一起上传** —— 这是本项目踩过三次的坑：
   - `items` 函数依赖：`index.js` + **`db.js`** + **`errors.js`**
   - 只传 `index.js` → 线上报 `FUNCTIONS_INVOCATION_FAILED`（加载阶段就崩，业务代码根本没执行）
3. 上传后用检查脚本验证：`node resource/scripts/verify-project.js`（22 项）

> ⚠️ 云函数与前端版本要配套：前端回到 Day 22 时，云函数若仍是新版，可能出现接口字段不匹配。

---

## 6. P4：数据恢复（备查 · Day 26 未实操）

**现状**：`items` 表的 DELETE 是真删除，不是软删（V5 删除后 GET 查不到）。
前端回滚**不能**恢复数据 —— 数据表是独立的。

### 步骤（备查）

1. 先确认损失范围：`source/check.html` 检查台 → GET /api/items 看现存数据
2. 若有导出快照（JSON），用前端「导入」功能恢复
3. 无快照 → 依赖数据库侧备份：
   - 腾讯云控制台 → 云数据库 → 备份/回档（体验版是否提供需自行确认）
   - `db/seed.sql` 只是**种子数据**，不是业务数据备份
4. **后续必须补**：定期导出 `items` 表快照到 `resource/data/`（该目录已被 `.gitignore` 忽略，不会进仓库）

---

## 7. 什么情况必须回滚（判断表）

**回滚的真实代价**：全站中断约 1 分钟 + 操作 1–4 分钟（CLI 路径可压到 6 秒）。
所以判断标准不是"有没有 bug"，而是"**代价是否低于不回滚**"。

| 现象 | 影响面 | 决策 | 理由 |
|---|---|---|---|
| 页面白屏 / 打不开 / 大面积 JS 报错 | 全站不可用 | **立即回滚** | 中断代价远低于持续不可用 |
| 核心功能失效（新建、保存、删除全挂） | 核心不可用 | **立即回滚** | 同上 |
| 接口大面积 5xx，页面仍能打开 | 全站数据异常 | **回滚前端无效**，去修云函数（P3） | 前端版本不是病因 |
| 数据被写错 / 污染 | 数据层 | **前端回滚无效**，走 P4 | 回滚前端不会改数据 |
| 样式错乱但功能正常 | 体验受损 | **不回滚**，下次发版修 | 1 分钟全站中断换"不好看"，不划算 |
| 文案错别字、标签错位 | 极低 | **不回滚** | 同上 |
| 仅移动端异常，桌面端正常 | 部分用户 | **看占比**：移动端为主就回滚 | 按用户分布权衡 |
| 单个边缘功能异常，有替代路径 | 低 | **不回滚** | 有绕过方式时不值得中断 |

**一句话判据**：**全站不可用 or 核心功能不可用 → 回滚；否则记下来下次发版修。**

---

## 8. 演练要留下的三类证据

1. **耗时**：`resource/scripts/rollback-watch.js` 自动落盘 `resource/logs/rollback-watch-*.log`
   （含 T0、每次探测的时间戳+哈希、T1、耗时）
2. **版本判定哈希**（去 CR 后 MD5，写死在 `rollback-watch.js` 的 `VERSIONS` 里）：

   | 版本 | MD5 |
   |---|---|
   | `v1.0` | `645d88d8eb6fa38dc112fe3bc7f45438` |
   | `day22` | `eb736fffd5e7649e8b1921b028099265` |
   | `head`（Day 25 时点，无版本标识） | `b5d5998e2e6c6332ebd809588ce597cf` |

3. **发布包留痕**：`resource/release/v1.0/`、`resource/release/rollback-day22/` 进仓库；
   `resource/release/workshop/` 是临时上传目录，已被 `.gitignore` 忽略。

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `resource/scripts/prepare-release.js` | 把目标版本装进固定目录 `workshop/` |
| `resource/scripts/rollback-watch.js` | 轮询判定线上版本 + 客观计时（`--once` 单次探测） |
| `resource/scripts/verify-project.js` | 发布/回滚后 22 项全量检查 |
| `DEPLOY.md` | 首次部署的逐屏步骤（Day 15） |
| `SECURITY_CHECKLIST.md` | 密钥与错误提示安全基线 |
