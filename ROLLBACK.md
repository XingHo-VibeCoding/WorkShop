# WorkShop 回滚手册（ROLLBACK.md）

> 什么时候翻这份手册：**线上出事了，你要决定"回滚还是硬修"，以及"怎么回滚"**。
> 建立日：Day 26（2026-10-05），内容基于当天**真实演练实测**，不是推测。
> 环境：`workshop-d4g02a7z81ff51a63`（体验版，到期 2027-03-27）｜前端域名 `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/`

---

## 0. 三十秒速查

> **2026-10-28 起：回滚只需要记一条命令。**
> ```bash
> node resource/scripts/rollback.js --to=<版本名>
> # 例：node resource/scripts/rollback.js --to=v1.0
> # 不知道有哪些版本：直接跑 node resource/scripts/rollback.js
> # 只想看会执行什么，不真上传：加 --dry-run
> ```
> 它会自动完成「选版本 → 装进固定目录 → 上传 → 轮询验证线上哈希真的变了 → 打耗时」，
> 并**只动静态托管**（多团队版禁止回云函数，原因见 §10）。
> 唯一的用户侧动作：先用 `node resource/scripts/rollback.js` 确认线上当前版本，回滚后人工核对 §10.5 那几项。

| 你要做什么 | 用哪条 | 命令 |
|---|---|---|
| **前端回滚**（推荐） | 一键脚本 | `node resource/scripts/rollback.js --to=v1.0` |
| 一键脚本跑不通（tcb 未登录 / TLS 掐断） | CLI 手工（P2） | `tcb hosting deploy resource/release/workshop workshop -e workshop-d4g02a7z81ff51a63 --verify` |
| 连 CLI 都没有 | 控制台（P1） | 静态网站托管 → 文件管理 → 上传 `resource/release/workshop` |
| 云函数出问题 | **多团队版禁止回函数** | 见 §10.3 的替代处置（不是 P3） |
| 数据被误删 | P4（备查，未实操） | 见 §6 |
| 拿不准要不要回滚 | 判断表 | 见 §7 |
| **v1.1 阶段二回滚**（回滚顺序 / 数据要不要回 / 哪些 FAIL 属预期） | 增量说明 | 见 §9 |
| **多团队（v1.2）回滚**（为什么只能回前端 / NULL 陷阱） | 增量说明 | 见 §10 |

**先确认线上现在跑的是哪一版**（脚本会把 `resource/release/` 下所有包的哈希跟线上比对）：
```bash
node resource/scripts/rollback.js
# 输出：线上当前 v1.1-tenancy（60cc15ca…）+ 可用版本清单 + 哪个正跑在线上
```

| 版本 | 线上 index.html（去 CR 后 MD5） | 回滚包 |
|---|---|---|
| `v1.0` | `645d88d8eb6fa38dc112fe3bc7f45438` | ✅ 已入库 |
| `rollback-day22` | `eb736fffd5e7649e8b1921b028099265` | ✅ 已入库 |
| `v1.1-tenancy`（当前线上：阶段二 + 多团队） | `60cc15ca782e3691ebc04afbbf473a00` | ✅ 已入库（2026-10-28 从 HEAD 打出） |

> 打新包：`node resource/scripts/rollback.js --snapshot=<版本名>`，把当前 `source/` 前端固化成可回滚的版本。
> **每次改动上线前都该先打一个包**，否则出问题时没有"回到刚才那版"的落点。

---

## 1. 关键事实（踩过才知道）

| 事实 | 影响 |
|---|---|
| **对外根路径 = 云端 `workshop/`** | CLI 传 `cloudPath=/` 的文件**对外访问不到**；必须传 `workshop`（§2 有实测证据） |
| **`workshop/` 是环境名前缀，不是你上传的目录名** | 控制台上传文件夹不会把你的目录名带进路径（Day 26 实测确认） |
| **静态托管没有版本管理** | 没有"一键回到上一版"的按钮，回滚 = 把旧文件重新传一遍 |
| **回滚期间线上会短暂 404** | 实测发布时中断 **77 秒**（覆盖上传期间旧文件已摘、新文件未挂） |
| **`--prune` 是红线** | 它会删除"不属于本次发布的远端文件"，包括平台系统目录 `__auth/`、`cloud-admin/` |
| **自定义域名根目录直接映射云端 `workshop/`**（2026-10-18 实测） | 验线上文件用 `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/index.html`（**不带** `/workshop`）；带前缀反而 404。只有默认域名 `<envid>-1496602788.tcloudbaseapp.com` 才要前缀。**别把路径判断错误当成"没上线"** |
| **云函数上传必须带全部依赖**（踩过 3 次） | `items` 回滚要 6 个文件一起传（`index.js` `db.js` `acl_phase2.js` `identity_phase2.js` `errors.js` `package.json`），漏一个 = 加载即崩 `FUNCTIONS_INVOCATION_FAILED` |

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

## 9. v1.1（阶段二）回滚增量（2026-10-27）

阶段二把产品从"单人日程"推到"多人协作 + 口令体系 + 管理员"，回滚时**多了一层数据和端点的耦合**，先看这四条：

### 9.1 核心结论：回滚代码，不回滚数据

v1.1 新增的数据库变动是**向后兼容**的，不必跟着回退：

| 变动 | 旧代码遇到它会怎样 | 结论 |
|---|---|---|
| `members_phase2.last_seen_at` 列 | 旧代码不写不读，多一列无害 | ✅ 保留 |
| `chk_audit_action` 白名单扩到 8 个动作 | 旧代码只写 create/update/delete/place_for，仍在白名单内 | ✅ 保留 |
| `audit_phase2` 新增行 | 纯增量记录 | ✅ 保留 |

**但反过来不行**：如果手工删掉 `last_seen_at` 列或缩回约束，再上 v1.1 代码 → 心跳/改角色直接 500。所以 **`schema_phase2.sql` 永远只向前跑，不写"回滚 DDL"**。

### 9.2 分批回滚顺序（前端 / 函数 / 数据）

1. **前端**（静态托管）：`tcb hosting deploy <旧版目录> workshop -e workshop-d4g02a7z81ff51a63 --verify`，见 §3
2. **云函数**（控制台，本机传不上去）：覆盖上传 §1 表中那 6 个文件
3. **数据**：不动

只回前端不回函数，会出现"旧界面 + 新接口"——旧界面不调新端点，**能正常工作**；
只回函数不回前端，会出现"新按钮打旧接口"——点「重置口令」会 404/400，**不坏数据但报错**。

> ⚠️ **上面这条「前端和函数一起回」只适用于 v1.1（还没有多团队的时候）。**
> **多团队上线后（2026-10-27 起）已作废**：那时回函数会让所有团队的日程互相可见。
> 现在的规矩是 **只回前端、绝不回函数**，见 §10.1。

### 9.3 回滚后哪些验收会"预期内 FAIL"

回滚到 v1.1 之前的包后，跑验收脚本会有红灯，那是**功能不存在**而非**故障**，别慌：

| 命令 | 回滚后表现 | 解读 |
|---|---|---|
| `verify-project.js`（打线上） | 基本仍应全绿（只查通用基线） | 若红 → 真问题 |
| `verify-admin_phase2.js --live` | setRole/心跳/口令三端点 404 → 多项 FAIL | **预期内**，说明回滚成功 |
| `verify-collab_phase2.js` | DELETE 需 `confirm=true` 仍成立（Day22 就有） | 权限项可能仍绿 |

### 9.4 回滚后必须做的核对

- [ ] 用真实账号登录一次，确认 `role` 显示正常（回滚到 P9 之前的包，readonly/admin 会退化为旧行为）
- [ ] 建一条日程再删掉（确认写链路 200 + 删除闸 400→confirm→200 仍工作）
- [ ] 看一眼底栏：v1.1 之前没有「在线：N」，消失属正常
- [ ] 若线上有 v1.1 期间建的数据（含 `owner_member_id` 标注），确认仍能正常显示——**数据不会因回滚丢失**

---

## 10. 多团队（v1.2）回滚增量（2026-10-28）

多团队隔离把「数据边界」写进了**云函数**，于是回滚这件事的性质变了：
**回前端是安全的，回函数会直接造成跨团队数据互见。**

### 10.1 一条铁律：只能回前端，不能回云函数

| 回滚动作 | 数据隔离 | 结论 |
|---|---|---|
| **只回前端**（函数保持多团队版） | ✅ **仍在**。旧前端虽然不传 `teamId`，但服务端用令牌里的 `tid` 决定作用域（`resolveActor` / `resolveReadScope`） | ✅ **唯一允许的回滚方式** |
| 前端 + 函数一起回 | ❌ 所有团队的日程合成一张表，互相可见 | ❌ 禁止 |
| 只回函数（前端保持新版） | ❌ 同上，而且新版前端调 `team` / `register` 端点会落到旧函数的未知分支，界面同时报错 | ❌ 最糟 |

**代码依据**（不是推测，`git show b8f5094^:source/cloud/items/db.js` 可复核）：

| 旧版实现 | 多团队版 | 回滚后果 |
|---|---|---|
| `queryItems(q)` 只有 `buildQueryString(q)`，没有 team 条件 | `requireTeamId()` 缺参数直接抛错 | 旧函数**全表返回** → 跨团队互见 |
| `findMemberByName` 末尾 `return rows.length ? rows[0] : null`（无排序） | 按 `(team_id, display_name)` 查 | 唯一索引已改成复合索引 → 两团队同名时登录会**串到别人团队的成员** |
| 无 `teams_phase2` 表访问 | `findTeamByJoinCode` / `createTeam` | 团队码登录、邀请码注册全部失效 |

### 10.2 为什么"只回前端"能成立（反直觉，但已验）

- 旧前端的每个请求仍带 `X-Member-Token`，令牌里已有 `tid`；
- 服务端 `resolveReadScope`：**登录 → 本团队；匿名 → 默认团队**，与前端版本无关；
- 旧前端不调 `team` 端点 → 顶栏少一行团队名，其余功能完整；
- 旧前端不传 `teamId` 给写接口 → 服务端本来就不接受前端传的 `teamId`（防伪造边界），无影响。

👉 所以**旧前端 + 新函数 = 功能退一点、隔离不少**，这正是回滚想要的。

### 10.3 函数真的出问题时怎么办（不是回退，是降级）

按代价从低到高，**选一条执行，别直接回函数**：

1. **先只回前端**：把用户能踩到的坑先关掉，给自己争取定位时间。
2. **停写**：把非默认团队成员全部改 `readonly`（异常期间谁都不能改数据）：
   ```sql
   UPDATE members_phase2 SET role = 'readonly' WHERE team_id <> 1 AND role <> 'readonly';
   ```
   用完记得按原值改回（改之前先 `SELECT id, display_name, role, team_id` 存一份）。
3. **摘团队**：确认第二个团队要暂停使用时，把他们的数据导出成 JSON 交给对方，再删掉该团队数据（`items` / `members_phase2` / `audit_phase2` / `teams_phase2` 按 `team_id`），此后只剩默认团队，回函数也不会串。
4. **实在必须回函数**：先按第 3 条摘掉其他团队，回完立刻告知所有用户「暂时只支持单团队」。

### 10.4 ⚠️ `team_id = NULL` 陷阱（回函数后才会踩到）

`items.team_id` **没有 DEFAULT**（`db/schema_phase2.sql:161` 只为迁移期加了可空列）。
所以只要函数被回退过，那段时间旧代码写入的行 `team_id` 是 `NULL`；再滚回多团队版时，
查询条件是 `team_id = eq.N`，**NULL 永远不匹配 → 这批数据在界面上"消失"（但没丢）**。

- 只回前端不会踩到（函数没动，仍写 `team_id`）。
- 踩到后的补救（`1` 是默认团队 id，先用 `SELECT id, name FROM teams_phase2` 确认）：
  ```sql
  UPDATE items         SET team_id = 1 WHERE team_id IS NULL;
  UPDATE members_phase2 SET team_id = 1 WHERE team_id IS NULL;
  UPDATE audit_phase2  SET team_id = 1 WHERE team_id IS NULL;
  ```

### 10.5 回滚后必须人工核对（脚本代替不了）

- [ ] 无痕窗口打开线上，登录一次：能看到日程、能新建、**能删除且要先点确认**
- [ ] **只看到本团队的日程**。若出现别的团队的数据 → 立刻停手，说明函数被回滚了（§10.1）
- [ ] 顶栏团队名：回 `v1.0` 会消失，属正常（那时还没有团队概念）
- [ ] 底栏「在线：N」：回 `v1.1` 之前会消失，属正常
- [ ] `node resource/scripts/verify-project.js`（打线上）—— 若大片红，说明**目标包本身有问题**，不是回滚没成功

### 10.6 回滚包清单

| 版本包 | 内容 | 用途 |
|---|---|---|
| `resource/release/v1.1-tenancy/` | `index.html` + `check.html` + `css/animations.css` + `css/base.css` + `js/`（6 个：animations / export_phase2 / login_phase2 / router / timeline / timepicker） | **当前线上的完整前端**，从 `HEAD` 打出（哈希 `60cc15ca…` 与线上逐字一致）。下次改动出问题时回到它 |
| `resource/release/v1.0/` | 阶段一发布版 | 最保守的兜底 |
| `resource/release/rollback-day22/` | Day 22 版本 | 历史演练留痕 |

> 打包命令：`node resource/scripts/rollback.js --snapshot=<版本名>`（**不覆盖同名目录**，防止手滑毁掉旧包）。
> 重新发布：`node resource/scripts/rollback.js --to=<版本名>`。

---

## 11. 相关文件

| 文件 | 作用 |
|---|---|
| **`resource/scripts/rollback.js`** | **一条命令回滚/打快照**（2026-10-28）。自动扫描 `release/` 版本哈希、上传、轮询验证线上真的变了。只动静态托管 |
| `resource/scripts/prepare-release.js` | 把目标版本装进固定目录 `workshop/`（rollback.js 内部会调它） |
| `resource/scripts/rollback-watch.js` | 轮询判定线上版本 + 客观计时（`--once` 单次探测） |
| `resource/scripts/verify-project.js` | 发布/回滚后全量检查（V0–V10） |
| `DEPLOY.md` | 首次部署的逐屏步骤（Day 15） |
| `SECURITY_CHECKLIST.md` | 密钥与错误提示安全基线 |
