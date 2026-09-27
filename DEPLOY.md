# Day 15 部署指南（DEPLOY.md · 逐点击版）

> 目标：把 `/api/health` 云函数与前端 mock 版部署到公网，达到 Day 15 完成标准。
> 环境：`workshop-d4g02a7z81ff51a63`（体验版，上海，到期 2027-03-27）。
> 降级：无论如何先保 `/api/health` 公网可访问；前端受阻只记报错，Day 20 前补齐。

本文档有两种执行方式，选一种：

- **方式一 · 我（AI）自己动手**：需你先在会话里**安装并授权「腾讯云 CloudBase」连接器**，然后说"已连接"。我走云端通道替你建函数、传前端，并交付一份**操作台账**（见文末模板）。
- **方式二 · 你手动控制台**：照下面 A/B 逐屏点。适用于不想接连接器、或我自操作时账号级初始化（首开托管/服务角色授权）仍需你点一次的情况。

两种方式最终都按 **C 截图清单** 验收，按 **D 收尾** 提交。

---

## 控制台入口（两种方式的共同起点）

- 浏览器打开 **云开发控制台**：`https://tcb.cloud.tencent.com/dev?envId=workshop-d4g02a7z81ff51a63`
  （或直接 `https://console.cloud.tencent.com/tcb`，登录后选环境 `workshop`）
- 登录你的腾讯云账号（需已实名）。
- 进入后左侧是一列菜单：**概览 / 云函数 / 数据库 / 云存储 / 静态网站托管 / …**
- 顶部能看到当前环境名 `workshop` 与环境 ID `workshop-d4g02a7z81ff51a63`。

---

## A. 部署 `/api/health` 云函数（逐屏）

> 代码已备好：`source/cloud/health/index.js`（返回 `{ ok: true, service: "workshop" }`，零依赖）。

| 步 | 位置（左侧菜单 / 页面） | 操作 | 填什么 / 点什么 | 你会看到 / 注意 |
|---|---|---|---|---|
| A1 | 左侧 **云函数** | 点进云函数列表 | —— | 空列表（首次）或已有函数列表 |
| A2 | 云函数列表页右上 | 点 **新建云函数** | 弹出"新建云函数"抽屉 | 抽屉出现 |
| A3 | 抽屉内 | 填函数信息 | **函数名称**：`health`<br>**运行环境**：选 **Node.js 18.15**（列表里有 16.13 / 18.15 / 20.15，选 18）<br>**创建方式**：选「空白函数」 | 名称下方可能有提示 |
| A4 | 抽屉底部 | 点 **新建** | —— | 列表出现 `health`，自动进入函数详情 |
| A5 | 函数详情 → **函数代码** 标签页 | 在线编辑 | 默认有示例代码（`exports.main = ...`）；**全选删掉**，把 `source/cloud/health/index.js` 的全部内容粘进去 | 编辑器显示 `exports.main = async (event, context) => { return { ok: true, service: "workshop" }; };` |
| A6 | 编辑器上方 | 点 **保存** | —— | 提示"保存成功"；可点"测试"验证（测试返回 `{ "ok": true, "service": "workshop" }`） |
| A7 | 函数详情 → **触发管理** 标签页 | 点 **新建触发** | 弹出"新建触发"抽屉 | 抽屉出现 |
| A8 | 抽屉内 | 填触发 | **触发类型**：选 **HTTP 请求触发**<br>**路径**：`/api/health`<br>**请求方法**：留 GET（HTTP 触发默认 GET/POST 都收，无需特别选）<br>**鉴权方式**：选 **免鉴权**（否则浏览器直接打开要登录，验收过不了） | 路径框显示 `/api/health` |
| A9 | 抽屉底部 | 点 **新建** | —— | 触发列表出现一条 HTTP 触发，带**访问路径** |
| A10 | 触发管理列表 | 复制 **访问路径** | 形如 `https://workshop-d4g02a7z81ff51a63.api.tcloudbasegateway.com/api/health`（以控制台实际显示为准） | 这就是公网地址，**记下来** |

**验证（截图 1）**：浏览器地址栏粘贴该访问路径并打开 → 页面显示：
```json
{ "ok": true, "service": "workshop" }
```
截图要含 **地址栏（公网地址）+ 返回的 JSON** 同框。

> ⚠️ 若浏览器显示的是被包了一层的对象（如 `{ "body": "...", "statusCode": 200 }` 或带了 `isBase64Encoded`），说明 HTTP 触发返回格式需要调整——到时把 `index.js` 改成下面这样再保存（A6）即可，**先实测、别提前改**：
> ```js
> exports.main = async (event, context) => {
>   return {
>     statusCode: 200,
>     headers: { "Content-Type": "application/json" },
>     body: JSON.stringify({ ok: true, service: "workshop" })
>   };
> };
> ```

---

## B. 部署前端 mock 版（静态网站托管 · 路线 A，逐屏）

> 前端即现有 `source/` 下的 `index.html` + `css/` + `js/`（本身就是 mock 数据版，不请求后端）。**不要上传 `source/cloud/`**（那是云函数代码，不是前端）。

| 步 | 位置 | 操作 | 填什么 / 点什么 | 你会看到 / 注意 |
|---|---|---|---|---|
| B1 | 左侧 **静态网站托管** | 点进 | —— | 若未开通，页面显示"立即开通" |
| B2 | 静态网站托管页 | 若未开通，点 **开通** | 按提示选默认配置（免费版即可） | 进入**资源初始化**，等 1–2 分钟 |
| B3 | 静态网站托管 → **文件管理** | 点 **上传文件**（或"上传文件夹"） | 只选前端三件套：`source/index.html`、`source/css/`、`source/js/`，**排除 `source/cloud/`** | 上传进度条 |
| B4 | 上传时 | 注意目录结构 | 目标：**托管根 `/` 直接是 `index.html`**，`css/`、`js/` 为其子目录。若控制台按文件夹上传会带上层目录名（如 `source/index.html`），先本地把 `index.html + css/ + js/` 拷进一个空文件夹再上传，确保根即 `index.html` | `index.html` 里的相对路径 `css/base.css`、`js/timeline.js` 才能正确加载 |
| B5 | 文件管理列表 | 确认结构 | 根目录应有 `index.html`、`css/`、`js/` | 结构正确 |
| B6 | 静态网站托管 → **基础设置**（或概览） | 复制 **默认域名** | 形如 `https://workshop-d4g02a7z81ff51a63-xxxxxx.tcloudbase.com` | 这就是前端公网地址，**记下来** |

**验证（截图 2）**：手机或浏览器打开该域名 → 看到 WorkShop 周时间线页面（顶部周标题 + 时间轴 + 事项卡片）。
- 手机验证：把域名发给同伴，同伴手机能打开即达标（清单要求"同伴手机能打开"）。

**跨域**：mock 版不请求后端，**无需配置 CORS**。Day 16+ 接真实接口时再在云函数/网关配。

> ⚠️ 若页面打开是空白/样式错乱：99% 是 B4 目录结构错（index.html 没在根，或 css/js 路径不对）。回 B3 重新上传，确保根即 `index.html`。

---

## C. 截图交付清单（Day 15 要求三张）

| 截图 | 内容要求 |
|---|---|
| 1. 云函数返回 | 地址栏（公网地址）+ 返回的 JSON `{"ok":true,"service":"workshop"}` |
| 2. 前端页面 | 手机/浏览器打开前端公网地址，看到 WorkShop 页面 |
| 3. 控制台环境信息 | 环境 ID（`workshop-d4g02a7z81ff51a63`）+ 剩余额度 + 到期日期（2027-03-27）同框，含地址栏 |

> 截图 3 的字段已部分录入 `CLOUD_ASSETS.md`；额度请点控制台「概览 / 查看用量」页截图后补。

---

## D. 收尾（今天做完后由 AI 执行）

- 列改动文件清单（标注 Day 14 / Day 15 归属）。
- 提交：`Day 15｜一句话`；说明两行（改了什么 / 加了什么）。
- 推送需你本机终端：`cd D:\ima\VibeCoding && git push origin main`（环境网络可能阻断，失败就你本机推）。
- 停下等你确认。

---

## E. 卡住降级

- 前端部署若报错：把报错原文记下来，先保证 **A 步 `/api/health` 公网可访问**，前端 Day 20 前补齐即可。
- 云函数若返回异常：先按 A 末尾备注改返回格式再试，仍不行截图报错给我。

---

## F. 我（AI）自操作台账模板（方式一交付物）

当你连接 CloudBase 连接器并说"已连接"后，我执行部署，并交付如下**逐条操作台账**（每条含：在哪里 / 做了什么 / 参数 / 结果 / 证据），便于你复核我在你账号里到底动了什么：

```
[操作 1] 创建云函数 health
- 位置：CloudBase 环境 workshop-d4g02a7z81ff51a63 → 云函数 → 新建
- 动作：运行环境 Node 18.15；入口 index.js；内容 = source/cloud/health/index.js
- 触发：HTTP 触发 /api/health / 免鉴权
- 结果：部署成功；公网地址 = https://.../api/health
- 证据：附截图 1 / 返回 JSON

[操作 2] 开通静态网站托管
- 位置：环境 → 静态网站托管
- 动作：开通（免费版）；上传 index.html + css/ + js/（排除 cloud/）
- 结果：默认域名 = https://...tcloudbase.com
- 证据：附截图 2

[操作 3] （若需）账号级初始化
- 说明：首开托管 / 服务角色授权若连接器未覆盖，此步需你控制台点一次
- 状态：由用户完成 / 已代完成
```

> **关于"我自操作"通道的重要说明（已实测）**：本会话连上的「cloudbase」连接器，实际是 **WorkBuddy 托管的云服务**（底层即腾讯云 CloudBase，但由 WorkBuddy 接管），**并非你手动在腾讯云控制台开的那个独立环境 `workshop-d4g02a7z81ff51a63`**。工具清单里**没有**任何能直接管理你那个控制台环境的云函数/静态托管接口（`mcp__cloudbase__*` 不存在）。因此：
> - 你手动开的 `workshop-d4g02a7z81ff51a63` 环境**我碰不到**，保持原样、未被改动。
> - 我能自操作的只有 WorkBuddy 部署通道（`workbuddy_sites_deploy`），它给一个**真实公网 URL**，手机能打开、能返回 JSON——满足 Day 15 功能验收标准。
> - 为同时满足"前端公网可访问"和"`/api/health` 返回 JSON"，把 health 接口与前端合并成一个极小 Node 服务（`source/server.js`）一起部署，一个域名同时满足两项验收（而非拆两个独立资源）。

---

## G. 实际部署结果（Day 15 · 2026-09-27 终版）

> **最终结论**：真实对外入口已落在**用户自己的腾讯云控制台环境 `workshop-d4g02a7z81ff51a63`**，由用户在控制台手动完成（tcb CLI 传前端 + 云函数 health）。两项验收用户浏览器实测通过。早期经由 WorkBuddy 托管通道的部署成为绕路产物（见 `CLOUD_ASSETS.md` 三，建议下线）。

| 项 | 结果 |
|---|---|
| 最终部署通道 | **腾讯云控制台环境 `workshop-d4g02a7z81ff51a63`**（用户手动，资产归用户） |
| 前端形态 | 静态网站托管 → webapps 域名 |
| 前端公网地址 | **https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/** ✅（用户实测正常） |
| health 形态 | 云函数 `health` + HTTP 网关路由 `/api/health` |
| 健康检查地址 | **https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/health** ✅（用户实测返回 JSON） |
| 验证（截图 1） | health 返回 `{"ok":true,"service":"workshop"}` ✅（用户浏览器确认） |
| 验证（截图 2） | 前端页面正常加载、同伴手机可打开 ✅（用户浏览器确认） |
| 早期 WorkBuddy 托管通道 | `workshop-meeting-board.app.workbuddy.host`（绕路产物，**建议下线**，避免线上"跑哪份"混淆） |

> **与清单字面要求的对齐**：清单要求"部署到 CloudBase + 同伴手机能打开 + /api/health 公网返回 JSON"——**已全部达成，且正是落在用户指定的 CloudBase 控制台环境**。
>
> **截图 3（控制台环境信息）**：登录 `tcb.cloud.tencent.com` → 环境 `workshop-d4g02a7z81ff51a63` 概览 → 截 **环境 ID + 剩余额度 + 到期 2027-03-27** 同框（信息已录 `CLOUD_ASSETS.md` 一）。

---

## H. 常见报错排查（实测记录）

### H1. CloudBase 函数公网打不开：401 `MISSING_CREDENTIALS` / 404 `INVALID_PATH`（2026-09-27 实测修正）

**现象**：
- 打开 `https://workshop-d4g02a7z81ff51a63.api.tcloudbasegateway.com/<任意路径>` → 401 `MISSING_CREDENTIALS`
- 打开 `https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/health` → 404 `INVALID_PATH`

**原因（两个坑叠在一起）**：
1. **域名混淆**：`*.api.tcloudbasegateway.com` 是 **AI/API 调用网关**（本来就要密钥，401 正常）；HTTP 网关（云接入）的默认域名在 **HTTP 网关 → 域名管理 → 默认域名** 页，形如 `<envid>-<hash>.ap-shanghai.app.tcloudbase.com`。
2. **路由没建**：光部署函数不会自动暴露公网，必须在 HTTP 网关**添加路由**。路由表为空时任何路径都 404 `INVALID_PATH`。

**解法**（控制台手动）：
1. 控制台 → **HTTP 网关 → 域名及路由 → 路由管理 → 添加路由**（或「添加默认域名路由」）
2. 路径填 `/api/health`；资源类型选**云函数**；资源对象选 `health`
3. （注意：HTTP 网关"配置路由信息"对话框**没有「方法」字段**，对所有方法放行；若仍报 405，见 H2 函数自身触发配置）
4. 「身份认证」列（**按路由设置，非全局开关**）选 **关闭 / 免鉴权**——`/api/health` 是公开健康检查
4. 保存后访问 `https://<你的默认域名>/api/health`

**结果判读**：✅ 返回 `{"ok":true,"service":"workshop"}` 即截图 1。

| 报错 | 含义 | 常见原因 | 修法 |
|---|---|---|---|
| 401 `MISSING_CREDENTIALS` | 网关要凭证 | 误开 `api.tcloudbasegateway.com`（AI/API 网关）；或路由开了身份认证 | 用 HTTP 网关默认域名；路由身份认证选关闭/免鉴权 |
| 404 `INVALID_PATH` | 路径未登记 | **没建路由**；路径拼写/多斜杠不一致 | HTTP 网关 → 添加路由 |
| 405 Method Not Allowed | 路径对、方法错 | 建路由时方法没含 GET | 编辑路由，方法改 **GET/ALL** |
| 「风险提醒」中转页 | 测试域名审核机制 | 正常现象，非错误 | 点继续访问；正式上线绑自定义域名 |

> 完整排查过程与原理讲解见打卡区归档：`打卡区/260927_DAY15_CloudBase公网排查.md`。
