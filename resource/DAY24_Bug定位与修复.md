# Day 24｜Bug 定位与修复记录（WorkShop）

> 复现 → 定位 → 修复 → 验证，四步证据齐全。修复前证据：`resource/day24-before.log`；修复后：`resource/day24-after.log`。
> 测试脚本：`resource/scripts/day24-flow.js`（线上打接口）／`resource/scripts/verify-day24.js`（本地直调云函数，不经网关）。

---

## 一、Bug 摘要

| ID | 现象 | 优先级 | 今日处理 |
|---|---|---|---|
| **B1** | 接口**所有错误响应的 HTTP 状态码都是 200**，错误码只藏在响应体 `error.code` 里（应为 4xx/5xx） | **高**（违反契约 §一，影响 GET/POST/PATCH/DELETE 全部接口） | ✅ 已修 **+ 已部署上线**（线上复验 13/14） |
| **B2** | `PATCH` 时间区间比较时**格式不一致**：新值带秒、库里原值只到分钟，导致边界值被错判 | 低 | ✅ 已修（**契约变更后不再可观测**，见 §七） |

> **§七 契约变更：禁止零时长** —— 用户 Day 24 拍板：`endTime` 由「≥ `startTime`」改为「**> `startTime`**」，
> 即**不允许零时长事项**（排会语义下既不是区间也不是待排）。POST / PATCH 两侧同步收紧，见 §七详述。

---

## 二、现象 / 复现步骤 / 报错原文 / 已尝试动作

### B1

- **现象**：任何校验失败（空标题、非法 id、缺 confirm、重复删除、时间区间非法……）浏览器 Network 里看到的都是 `200 OK`，只有展开响应体才看得到 `"ok":false,"error":{"code":400}`。
- **复现步骤**：`node resource/scripts/day24-flow.js before`（或浏览器检查台 ③ 区块填空标题提交）。
- **报错原文**（摘自 `day24-before.log`）：
```
E1 空标题   → HTTP 200 / body code 400 · 缺少必填字段：标题
E4 非法区间 → HTTP 200 / body code 422 · 结束时间须不早于开始时间
E5 非法 id  → HTTP 200 / body code 400 · id 无效：u1718abc（应为正整数…）
E6 缺确认   → HTTP 200 / body code 400 · 删除需要显式确认：请带 confirm=true
E7 重复删   → HTTP 200 / body code 404 · 找不到该事项：id=26（可能已被删除）
❌ [B1] ★错误响应 HTTP 状态应为 4xx（契约 §一），实际 HTTP 200
```
- **已尝试动作**：
  1. 重跑脚本确认不是偶发（两次都是 200）；
  2. 换不同接口（POST / PATCH / DELETE）、不同错误类型（400/404/422）→ **全部 200**，排除"某个分支写漏"；
  3. 本地直调云函数（不经网关）复验 → 见 §三 V1。

### B2（余力加练，已修）

- **现象**：把 14:43–15:13 的会议只改开始时间为 15:13（即改成 0 分钟、开始=结束），接口拒绝。
- **原文**：`HTTP 200 / code 422 · 结束时间须不早于开始时间（改后：开始 2026-10-04 14:49 / 结束 2026-10-04 14:49）`
- **已尝试动作**：核对契约——`endTime` 只要求「须 ≥ `startTime`」，相等是允许的。
- **定位**：比较时两边**格式不一致** —— 本次新值经 `normalizeTime()` 是 `HH:mm:ss`（带秒），库里原值经 `db.js` 的 `fmtTime()` 只到 `HH:mm`（无秒）；字符串比较下 `'15:13' < '15:13:00'` 成立 → 误判成倒挂。
- **修复**：比较前两边统一截到分钟再比（顺带把提示文案也用同一口径）：
  ```js
  const minute = (t) => String(t).slice(0, 16);
  if (minute(newEnd) < minute(newStart)) { …422… }
  ```
- **验证**（`resource/scripts/verify-day24-b2.js`，用 mock 顶掉数据层，本地不连库即可复现）：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| ① 零时长 `startTime=原endTime` | ❌ 422（误判） | ✅ 200 |
| ② 真倒挂（开始晚于结束） | ✅ 422 | ✅ 422（仍拦，无回归） |
| ③ 结束早于开始 | ✅ 422 | ✅ 422（仍拦，无回归） |
| ④ 只改标题（基线） | ✅ 200 | ✅ 200 |

  证据：`resource/day24-b2-before.log`（3 通过/1 失败）→ `day24-b2-after.log`（4 通过/0 失败）。

---

## 三、候选原因排序 + 每个原因的验证方法（B1）

按"可能性 × 影响面"从高到低排：

| 排序 | 候选原因 | 验证方法 | 验证结果 |
|---|---|---|---|
| **①** | **云函数代码**：控制器把业务返回值包成 HTTP 响应时，**没传 statusCode**，默认 200。`index.js` 里 5 处调用形如 `http(event, await createItem(event))`，只有 `catch` 分支传了 `e.code` | **V1 本地直调**：`node resource/scripts/verify-day24.js`，直接 `require` 云函数 `exports.main` 喂 event，看函数**自己**返回的 `statusCode` | ✅ **成立**。本地返回 `statusCode=200 / body.error.code=400`（POST 空标题、PATCH 非法 id、DELETE 缺 confirm 三条一致） |
| ② | HTTP 网关改写状态码（CloudBase 网关把函数给的 4xx 改成 200） | 同 V1：若本地返回 400 而线上看到 200 ⇒ 锅在网关 | ❌ 排除。本地直调也是 200，网关没机会背锅 |
| ③ | 云函数返回形态不支持自定义 `statusCode`（裸对象返回会被平台包成 200） | 看 `GET /api/items` 的 `catch` 分支：它**显式**传了 `e.code`，线上该分支（本次未触发）若也是 200 才成立；另看现有代码已用 `{statusCode, headers, body}` 完整形态（Day 20 为了 CORS 改过） | ❌ 排除。代码已是完整形态，只是业务错误分支没给值 |

**定位结论**：`index.js` 的 `http(event, payload, statusCode = 200)` ——业务错误分支返回裸 `{ok:false,error:{code}}` 时**没有第三参**，于是全部套用默认 200。**一处根因，影响全部接口的 4xx/5xx。**

---

## 四、修复方案（B1）

在 `source/cloud/items/index.js` 的 `http()` 里补上状态码推导（一处改动覆盖所有分支）：

```js
function http(event, payload, statusCode) {
  // 【Day 24 修复】此前业务错误分支只返回裸 {ok:false,error:{code}}，没传 statusCode，
  // 于是全被套上默认 200 —— HTTP 语义上说"成功"，错误只藏在 body 里（违反契约 §一）。
  // 现在：没显式给状态码时，从 error.code 推导；正常响应一律 200。
  if (statusCode == null) {
    const c = payload && payload.error && Number(payload.error.code);
    statusCode = (payload && payload.ok === false && c >= 400 && c < 600) ? c : 200;
  }
  return { statusCode, headers: corsHeaders(event), body: JSON.stringify(payload) };
}
```

**兼容性检查**：前端 `source/js/timeline.js` 判断的是 `if (!res.ok || !j.ok)` —— 修复后 4xx 让 `res.ok=false`，与原先靠 `!j.ok` 走进的是同一个错误分支，**前端行为不变**（错误提示文案不变）。检查台 `check.html` 一律以 `j.ok` 判定，同样不受影响。

---

## 五、回归验证清单（修复后重跑，逐条对照）

> 用**同一个脚本、同一套判定标准**再跑一遍：`node resource/scripts/day24-flow.js after`

| 项 | 修复前 | 修复后应为 |
|---|---|---|
| T2 读取 | ✅ 200 / 11 条 | ✅ 不变 |
| T3 写入 | ✅ id=26 | ✅ 不变（id 换新） |
| T4 刷新确认 | ✅ 找到 | ✅ 不变 |
| T5 修改 | ✅ 标题已改 | ✅ 不变 |
| T6 删除 | ✅ 已消失 | ✅ 不变 |
| **B1 错误响应 HTTP 状态** | ❌ HTTP 200 | ✅ **HTTP 400** |
| E1 空标题 | ✅ code 400 | ✅ code 400 + HTTP 400 |
| E2 超长标题 | ✅ code 400（提示为英文原文，见"今日不做"） | ✅ 不变 |
| E3 连点三次 | ✅ 200/409/409 | ✅ 不变 |
| E4 非法区间 | ✅ code 422 | ✅ code 422 + HTTP 422 |
| E5 非法 id | ✅ code 400 | ✅ code 400 + HTTP 400 |
| E6 缺 confirm | ✅ code 400 | ✅ code 400 + HTTP 400 |
| E7 重复删 | ✅ code 404 | ✅ code 404 + HTTP 404 |
| **E8 零时长** | ❌ 422 | ✅ **成功（B2 余力加练已修）** |

**回归判定（B1）**：唯一应从 ❌ 变 ✅ 的是 **B1**；T2–T7 结果必须与修复前一致（不得引入回归）。
**线上复验结果（B1 部署后）**：13 通过 / 1 失败 —— B1 ✅，T2–T7 与修复前完全一致，E8 当时仍 ❌（B2 尚未修）。
**B2 修完并部署后**应达到：**14 通过 / 0 失败**（E8 转 ✅）。

---

## 七、契约变更：禁止零时长（用户拍板）

**改了什么**：`api-contract.md` §二 —— `endTime` 由「须 ≥ `startTime`」改为「**须晚于 `startTime`**」；§三 POST / PATCH 的错误文案统一为「结束时间须晚于开始时间」，仍 422。

**为什么**：零时长（开始=结束）在排会语义下既不是区间、也不是待排事项，留着只会让时间线出现没有意义的点；前端改拨轮后，结束时间默认自动 = 开始 +30 分钟，正常路径不会踩到。

**代码改动**（`source/cloud/items/index.js` 三处）：
1. POST 校验：`if (end < start)` → `if (end <= start)`
2. PATCH 校验：`minute(newEnd) < minute(newStart)` → `<=`（`minute()` 统一截到分钟的比较口径保留）
3. `normalizeTime()` **解析放宽**：接受 `/` 分隔日期、`T` 分隔日期与时间、月/日/时/分不补前导零，并挡掉 `2026-13-40 99:99` 这类非法值；归一后仍输出 `YYYY-MM-DD HH:mm:ss`。
   （对拨轮 UI 无影响 —— UI 本来就产规范串；放宽是给脚本与将来的导入接口兜底。）

**诚实说明（重要）**：零时长禁止后，**B2 修复不再产生可观测的行为差异** —— 旧代码（格式 bug）和新代码（口径一致）在"开始=结束"时都返回 422。B2 修复保留，因为它保证的是比较口径正确、避免将来再出边界 Bug，但**它现在无法用"放行/拒绝"来证明**。所以要证明的是另一件事：**正常改动不得被误伤** → 用例 ⑤（endTime 后推 30 分钟）与 E10。

**验证**（`resource/scripts/verify-day24-b2.js`，mock 数据层）：

| 用例 | 期望 | before（HEAD 原始版） | after（当前版） |
|---|---|---|---|
| ① 零时长 `startTime=原endTime` | 拒绝 422 | ✅ 422 | ✅ 422 |
| ② 真倒挂 | 拒绝 422 | ✅ 422 | ✅ 422 |
| ③ endTime 早于 start | 拒绝 422 | ✅ 422 | ✅ 422 |
| ④ 只改标题 | 放行 200 | ✅ 200 | ✅ 200 |
| ⑤ endTime 后推 30 分钟 | 放行 200 | ✅ 200 | ✅ 200 |

两版均 **5 通过 / 0 失败** —— 结论：零时长两侧都拦住，正常改动没有被区间校验误伤。

---

## 六、今日不做（发现但不动手，只记录）

| # | 发现 | 为什么今天不做 |
|---|---|---|
| 1 | **E2 提示语是英文原文**：超长标题的报错是数据库原文 `value too long for type character varying(200)`，POST 侧**没有像 PATCH 那样做 ≤100 字前置校验**（契约 §二 要求 ≤100 字） | 已修两个 Bug，余力加练额度用完；记录待办，未动代码 |
| 3 | 本地匿名登录失败：`请在请求头添加设备id`（`db.js` 已带 `X-CloudBase-DeviceId` 仍被拒）→ 本地直调只能验证"不连库"的校验分支 | 环境问题，非产品 Bug；线上走 `CB_API_KEY` 正常 |
