# WorkShop 第 3 周验收表（Day 16–20）

> 项目：WorkShop（会议工作台）
> 验收日期：2026-10-01　验收人：周国玮（AI 北辰 协助取证）
> 环境：腾讯云 CloudBase `workshop-d4g02a7z81ff51a63`（上海，体验版，到期 2027-03-27）
> **取证原则**：结论只有三种 —— `PASS` / `FAIL` / `未执行`。凡本次未亲手跑过的，一律标「未执行」，不拿历史结论冒充。
> **取证时间戳**：下列 curl 实测均发生于 **2026-10-01 10:34（东八区）**，从本机直连公网。

---

## 零、本次实测的一手证据（3 条命令，任何人可复跑）

```bash
# E1 健康检查
curl -s -m 25 -w "\n[HTTP %{http_code}]\n" \
  https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/health
# → HTTP 200 ; {"ok":true,"service":"workshop"} ; 0.74s

# E2 items 只读列表
curl -s -m 25 -w "\n[HTTP %{http_code}]\n" \
  https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items
# → HTTP 200 ; {"ok":true,"data":[ …14 条… ],"error":null} ; 1.36s

# E3 公网检查台页面
curl -s -m 25 -o /dev/null -w "HTTP=%{http_code} size=%{size_download}\n" \
  https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/check.html
# → HTTP=200 size=10454
```

---

## 一、验收项 ①　schema / seed 脚本（Day 16）

| # | 子项 | 验证方法（可复现） | 结论 | 证据 |
|---|---|---|---|---|
| 1.1 | 建表脚本方言正确（PostgreSQL） | 读 `db/schema.sql`，确认全篇 PG 语法 | **PASS** | 文件 41–131 行：`SERIAL PRIMARY KEY`、`TIMESTAMP`、`CHECK (… >= 0)`、`COMMENT ON`、`CREATE OR REPLACE FUNCTION … LANGUAGE plpgsql`、`CREATE TRIGGER`；无 `UNSIGNED`/`AUTO_INCREMENT`/反引号（控制台 PG 执行器拒收的 MySQL 方言） |
| 1.2 | 三张表齐全且关系正确 | 读 schema；核对关联字段 | **PASS** | `owners`(owner_key 业务主键) / `meeting_requests`(SERIAL) / `items`(核心)；`items.owner_key → owners.owner_key`、`items.meeting_request_id → meeting_requests.id`，全部**应用层 key 关联、无 FK**（为迁腾讯文档预留） |
| 1.3 | 建表已真实生效 | 云端能否查到表数据 | **PASS** | E2 实测返回 14 行 items 数据 → `items` 表在云端真实存在且有数据 |
| 1.4 | 种子数据已落库 | 比对 seed.sql 与云端数据 | **PASS** | E2 返回含 `id 1–10` 共 10 条种子记录，标题与 `db/seed.sql` 一致：「周例会_已验证」(id1) /「项目评审会」(id2) /「新人培训」(id3) /「出差-北京」(id4) /「高等数学(二)」(id5) /「篮球训练」(id6) /「晚餐-家人聚会」(id7) /「客户洽谈」(id8) /「季度总结筹备」(id9) /「健身」(id10) |
| 1.5 | 幂等：重复执行不报错、不重复插行 | 在控制台 SQL 编辑器**再跑一遍** schema + seed，看是否报错、行数是否不变 | **未执行** | 本次验收未复跑。代码层面已具备幂等设计（`DROP TABLE IF EXISTS` / `ON CONFLICT (owner_key) DO UPDATE` / `ON CONFLICT (id) DO UPDATE` / `SELECT setval(...)`，见 seed.sql 6–12 行与 54 行），但**设计存在 ≠ 跑过**，故不做 PASS 断言 |
| 1.6 | 归属表 owners / 会议要求表 meeting_requests 有数据 | 直查这两张表 | **未执行** | 无对应公网接口，本次未连控制台库直查。仅有**间接证据**：E2 返回事项的 `ownerKey` 取值 `self`/`depta`/`deptb`/`deptd` 全部命中 seed 的 owners 5 行，说明插入时外键语义一致 |

---

## 二、验收项 ②　GET / POST 公网接口（Day 17 / Day 18）

| # | 子项 | 验证方法 | 结论 | 证据 |
|---|---|---|---|---|
| 2.1 | `GET /api/items` 公网可读 | E2 | **PASS** | HTTP 200，1.36s，返回 14 条 |
| 2.2 | 响应统一 `{ ok, data, error }` | 看返回体形状 | **PASS** | 返回体开头 `{"ok":true,"data":[…],"error":null}`，与 `api-contract.md` §一 一致 |
| 2.3 | snake_case → camelCase 映射正确 | 比对返回字段与契约 §二 | **PASS** | 返回字段 `id/table/type/title/startTime/endTime/week/attendees/venue/equipment/note/source/status/ownerKey/createdAt/updatedAt`；其中 `table_kind → table` 映射生效（返回 `"table":"work"`） |
| 2.4 | 时间格式 `YYYY-MM-DD HH:mm` | 看字段值 | **PASS** | `"startTime":"2026-09-28 08:00"`、`"createdAt":"2026-09-27 23:10"`，24 小时制、无歧义写法 |
| 2.5 | `POST /api/items` 真实写入 | 库里是否存在非种子数据 | **PASS**（历史证据） | E2 读到 4 条非种子记录：`id 11`「临时碰头」/ `id 12`「key测试会」createdAt `2026-09-29 20:18`（Day 18）；`id 13/14`「写入测试-201731-1hu7」「写入测试-201744-hy43」attendees=检查台、note=「Day 20 检查台写入测试」、createdAt `2026-09-30 19:47` |
| 2.6 | 写入结果持久化 | 隔天再读，数据是否还在 | **PASS** | 上列 4 条写入于 09-29 / 09-30，在 **10-01 10:34** 仍被完整读回 → 写入确已落库、非内存态 |
| 2.7 | 本次当场发起一次 POST 写入 | 现场 POST 一条并读回 | **未执行** | 本次验收授权范围不含写库（避免污染用户数据）。该动作改由 Day 21 演示环节（检查台区块③「写入测试」按钮）当场完成，见 `DEMO_OUTLINE.md` |
| 2.8 | 重复提交返回 409 | 同内容 / 同幂等键连发两次 | **未执行（真实库）** | 仅有本地 mock 测试 `source/cloud/items/test-local.js`（模拟 PostgREST 23505 → 409），**mock 结果不能代表真实库**。真实库侧唯一约束 `items.idempotency_key VARCHAR(64) UNIQUE` 已在 schema 101 行建立，但未在公网实测 409 |

---

## 三、验收项 ③　分层重构（Day 19）

| # | 子项 | 验证方法 | 结论 | 证据 |
|---|---|---|---|---|
| 3.1 | 控制器不再直接碰数据库 | 在 `source/cloud/items/index.js` 中搜索 `fetch(` / PostgREST 地址 | **PASS** | 全文仅 1 处 `https://`（第 21 行，CORS 白名单常量，非请求），**无任何 fetch 调用**；头部注释 1–10 行自述「控制器只管收请求、校验、dispatch」 |
| 3.2 | 数据访问集中在 `db.js` | 检查 db.js 是否承载建连/查询/映射 | **PASS** | `db.js` 第 31 行 `const GATEWAY = …api.tcloudbasegateway.com`；第 123 / 163 / 181 行为三处 `fetch`（列表查询 / 去重查询 / 写入）；第 93 行做时间格式归一；第 146 行做返回体兼容 |
| 3.3 | 重构后线上仍在跑新版本 | 公网实测 | **PASS** | E2 于重构次日（10-01）实测 HTTP 200 且返回 `table`/`ownerKey` 等经 db.js 映射的字段 → 线上跑的是重构后的版本，不是旧包 |
| 3.4 | 重构未引入回归（校验/去重逻辑仍在） | 逐条比对重构前后行为 | **部分完成** | 已确认读链路正常（3.3）；写链路的必填校验 / 取值校验 / 409 去重**未在公网复测**（同 2.8），故不整体标 PASS |

---

## 四、验收项 ④　公网检查台 URL（Day 20）

| # | 子项 | 验证方法 | 结论 | 证据 |
|---|---|---|---|---|
| 4.1 | 检查台公网 URL 可打开 | E3 | **PASS** | `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/check.html` → HTTP 200，10454 字节 |
| 4.2 | 前端主页同步在公网 | 同域 `/` | **PASS** | HTTP 200，8669 字节 |
| 4.3 | 页面含三区块（健康检查 / items 真实数据 / 写入测试） | 读 `source/check.html` | **PASS** | 第 41 行「① 健康检查」、第 48 行「② items 表真实数据（本周）」、第 57 行「③ 写入测试（POST → GET 读回）」 |
| 4.4 | CORS 白名单配置到位 | 读控制器白名单 | **PASS** | `index.js` 20–24 行：仅放行生产托管域名 + `localhost:8080` / `127.0.0.1:8080`，**无 `*` 通配符**；26–34 行按 Origin 动态回显；37–39 行统一包 `{statusCode, headers, body}` |
| 4.5 | 公网页面上三个按钮真能点出结果 | 浏览器打开 URL 逐一点 | **未执行** | 需真人浏览器操作（GET 已被 E2/E3 覆盖，但「点按钮 → 页面出结果」这条链路本次未由人眼确认）。留给 Day 21 演示（见提纲第 2 段） |
| 4.6 | OPTIONS 预检返回 204 | `curl -X OPTIONS` | **未执行** | 本次未发预检请求 |

---

## 五、验收项 ⑤　api-contract.md 完整性（Day 15–20）

| # | 子项 | 验证方法 | 结论 | 证据 |
|---|---|---|---|---|
| 5.1 | 7 个接口全部登记 | 通读契约 | **PASS** | §三.1–7：`/api/health`、`GET|POST /api/items`、`GET|PUT|DELETE /api/items/:id`、`POST /api/import`；§四「实现状态总览」逐条标注 ✅已实现 / 📋占位 |
| 5.2 | 已实现接口的契约与线上行为一致 | 契约示例 vs E2 实测 | **PASS** | 契约 §三.2 的响应示例字段与 E2 返回逐项对得上（`table` / `startTime` / `ownerKey` / `createdAt`） |
| 5.3 | 通用约定明确（响应形状 / 时间格式 / 错误码） | 通读 §一 | **PASS** | §一表格：统一 `{ok,data,error}`；时间 `YYYY-MM-DD HH:mm` 东八区；错误 `{ok:false,error:{code,message}}`；CORS 约定已补 Day 20 结论 |
| 5.4 | **契约内无自相矛盾 / 过期表述** | 逐段检查是否还有未结的「待拍板」 | **FAIL** | 见下方「遗留缺陷」L1 |
| 5.5 | 附带验证脚本地址与线上一致 | 检查脚本内 URL | **FAIL** | 见下方「遗留缺陷」L2 |

### 遗留缺陷（本周不修，登记至下周）

| 编号 | 缺陷 | 位置 | 影响 | 建议处理（下周） |
|---|---|---|---|---|
| **L1** | 契约顶部仍写着「⚠️ 数据源决策（待 Day 16 拍板）」，并把「选腾讯文档 / 选 CloudBase」列为未决项 | `api-contract.md` 第 6–9 行 | 已过时：本周实际已走 CloudBase 关系库，该提示会让后来人误以为数据源未定 | 改为「已拍板：CloudBase PostgreSQL（2026-09-27 Day 16）；腾讯文档降为阶段二同步目标」，并删除二选一分支 |
| **L2** | 验证脚本内接口地址 `workshop-d4g02a7z81ff51a63-1496602788…`，与实测可用域名 `…1d496602788…` 不一致 | `source/cloud/items/verify-day18.js` 第 13 行 | 脚本照跑会得到 404，误导排查 | 核对控制台 HTTP 网关默认域名后修正为 `1d496602788` |
| **L3** | 云端残留 2 条 Day 20 测试脏数据 | items `id 13` / `id 14`（「写入测试-201731/201744」） | 污染演示画面（列表尾部多两条无关会议） | 演示前用 DELETE 清掉，或演示时说明「这两条是昨日写入测试留下的」 |

---

## 六、本周未完成项（如实登记，不带修饰）

| 未做 | 原因 | 归属 |
|---|---|---|
| 4 个占位接口未实现：`GET/PUT/DELETE /api/items/:id`、`POST /api/import` | 本周清单只要求 GET + POST | 下周 / 后续 |
| 幂等复跑验证（1.5） | 未连控制台 SQL 编辑器复跑 | 待补 |
| owners / meeting_requests 表数据直查（1.6） | 无公网接口，需连控制台 | 待补 |
| 公网 409 去重实测（2.8） | 需真实写库，本次授权只读 | 下次写库时一并验 |
| OPTIONS 预检 204（4.6） | 未发预检请求 | 待补 |
| 前端**写链路**未接线（`Day 21 复核更正**）：`index.html` 的「+ 新建 / 编辑 / 删除」仍只改内存数组——`timeline.js` 927 行 `items.push(saved)` 无 POST；953 行删除弹窗文案自述「仅从本地内存移除…不会同步删除云端」 | 本周目标为「后端可用」。**读链路已接线**（`timeline.js` 1136 行 `bootstrap()` → 160 行 `loadItems()` → 167–168 行 `fetch(API_BASE + '/api/items')`），写链路属后续 | 后续 |
| 移动端完整适配 / PreText 渲染 | PRD 明确列为阶段二 | 阶段二 |

---

## 七、一句话结论

**本周五项产出中，四项核心能力（建表+种子、GET 公网读取、分层重构、检查台公网可访问）均有今日一手证据支撑；契约完整性有 2 处文档缺陷（L1/L2）已如实标 FAIL 且本周不修；另有 6 项验证动作本次未执行，全部标「未执行」而非 PASS。**
