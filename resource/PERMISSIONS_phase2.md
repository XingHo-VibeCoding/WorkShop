# WorkShop 阶段二 · 权限模型与角色说明（PERMISSIONS_phase2）

> 建档日期：2026-10-16
> 背景：阶段二引入多人协作，按 `members_phase2.role` 区分权限。本文档是权限相关的**权威说明 + 后续改造台账**，
> 凡涉及「谁能做什么」的改动，先读此处再动手（对应阶段一 `acl_phase2.js` 的代码级判定）。

## 一、四种角色

| 角色 `role` | 取值 | 含义 | 来源 |
| --- | --- | --- | --- |
| 普通成员 | `member` | 默认角色，可读写自己名下的日程，可读写自己的会议资料 | 新建成员默认 |
| 只读成员 | `readonly` | 只能看，不能新建/修改/删除日程，也不能改自己的会议资料 | 管理员设定 |
| 管理员 | `admin` | 完全权限（当前为占位，后续接管理 UI） | **库中已存在该角色账号** |
| 匿名 | `actor = null` | 未登录，凭令牌缺失走 v1.0 兼容路径 | 未登录 |

- 字段约束见 `db/schema_phase2.sql`：`role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('member','readonly','admin'))`。
- 令牌 `X-Member-Token` 由 `identity_phase2.js` 签发，payload 含 `{ mid, name, role, exp }`，7 天有效期。

## 二、当前各操作的判定落点（已实现）

### 前端（source/js/timeline.js · applyRoleUI / isReadOnly）
- 只读 → 隐藏「+ 新建」按钮（`btn-new.hidden`）。
- 只读 → 禁用「保存我的会议信息」（`btn-save-meeting.disabled`），并在设置里提示「当前为只读身份，无法修改会议信息」。
- 只读身份**仍可打开设置弹窗查看**自己的会议资料（GET 不受限），仅不能保存。

### 后端（最终审防线）
| 操作 | 函数 | 只读 | 普通/管理员 | 匿名 |
| --- | --- | --- | --- | --- |
| 日程 增/改/删 | `acl_phase2.js` · `decideWrite` | 403「当前身份为只读，无法修改日程」 | 放行（改/删仅限自己名下） | 放行（v1.0 兼容，见 seam A） |
| 读自己会议资料 | `profile_phase2` · `getProfile` | 放行 | 放行 | 401「请先登录」 |
| 改自己会议资料 | `profile_phase2` · `updateProfile` | **403「当前身份为只读，无法修改个人会议信息」** | 放行 | 401「请先登录」 |
| 导出腾讯文档 | `export_phase2` · `exportDoc`（**暂缓**：当前为占位，未配置凭据返 503，功能未落地，待后续讨论） | 同普通（与登录无关） | 同普通 | 同普通 |

> 注意：后端判定是「最终审防线」。前端隐藏/禁用按钮只是体验层，越权请求依旧会被后端 403 挡回，不会污染数据。

## 三、三个待办接缝（seam）台账

### seam A — 匿名可写（暂不处理，仅备注）
- 现状：`actor = null`（未登录）时，`acl_phase2.js` 对日程增改删**放行**，走 v1.0 兼容路径。
- 决策（2026-10-16 用户）：**暂不改动**。多人场景成熟、需要强制登录时再收口（改为 401）。
- 风险：任何人未登录即可写公共日程。当前体验版、数据量小，可接受；上线前必须 revisit。

### seam B — 只读不严（✅ 已修复，2026-10-16）
- 修复前：前端只隐藏「新建」，但设置弹窗仍可打开、仍可保存会议资料；后端 `updateProfile` 未校验 role。
- 修复后：前端禁用保存按钮 + 提示；后端 `updateProfile` 对 `role==='readonly'` 返回 403。
- 关联改动：`source/js/timeline.js`（`applyRoleUI` / `renderMeetingSettings`）+ `source/cloud/profile_phase2/index.js`（`updateProfile`）。

### seam C — 管理员角色（本文档即「建档」，无专属 UI）
- 现状：**库中已存在 `admin` 角色账号**，但当前没有任何「管理员专属」界面或操作。
- `acl_phase2.js` 对 `admin` 的处理是「全放行」占位（`role==='admin' → allow`），与普通成员在日程操作上无差异。
- 后续改造方向（待用户排期）：
  1. 管理后台入口（仅 `admin` 可见）：成员列表、改他人 role、重置口令、查看操作日志。
  2. 管理员可改他人日程（当前「改/删仅限自己名下」对 admin 也应放开，需在 `decideWrite` 明示）。
  3. 系统级设置（如全局默认视图、类型颜色模板）与普通成员的个人设置分离。
- ⚠️ 上线前务必：给 admin 账号配强口令；明确 admin 凭据的托管/找回流程（目前仅库里一个 role 标记，无对应管理动作）。

## 四、给后续开发的硬性约定
1. **任何写操作**都必须经过后端 `acl_phase2.js` / `profile_phase2` 的 role 判定，前端禁用按钮不可替代后端校验。
2. 新增角色前，先同步改三处：`db/schema_phase2.sql` 的 CHECK、本文件的角色表、`identity_phase2.js` 的 `signToken` payload（role 透传）。
3. 越权类错误对外统一中文（403/401），英文细节只进 `console.error`（Day 23 铁律）。
4. seam A 收口、seam C 落地前，本文件须同步更新「已实现」列。
