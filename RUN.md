# RUN.md — WorkShop 本地运行说明

> 适用版本：Day 24（前端静态页 + CloudBase 云函数真实后端；仍无构建步骤）
> 最后更新：2026-10-04
> ⚠️ 版本说明：§1–§4 是 **Day 7 MVP 时期**的本地运行说明（对纯前端 mock 页面依然成立）；
> 自 Day 15 起项目已接真实后端（CloudBase 云函数 + PostgreSQL），**接口与线上入口见 §5**，以 `api-contract.md` 为唯一契约依据。

## 1. 本地启动

MVP 是纯静态网页，用任意静态服务器托管 `source/` 目录即可。推荐用 Python 自带服务器：

```bash
# 进入项目前端目录
cd source

# 启动静态服务（端口 8000，可换）
python -m http.server 8000
```

启动后浏览器打开：

```
http://localhost:8000/
```

> 用 Node 也行：`npx serve source` 或 `npx http-server source -p 8000`。

## 2. 目录结构

```
D:\ima\VibeCoding\
├── source/                 # 前端代码（Day 6 约定：代码放 source/，纳入 git）
│   ├── index.html          # MVP 入口：上栏(标题/周范围/操作) + 左时间线 + 右详情 + 下栏状态 + 底部表签
│   ├── check.html          # 【Day 20 起】检查台：健康检查 / items 真实数据 / 写入测试（Day 24 补 ④修改 ⑤删除）
│   ├── css/
│   │   └── base.css        # 浅色主题、时间线、色块类型色、重叠警告、表签样式
│   ├── js/
│   │   └── timeline.js     # 周时间线渲染 + 双表/三模式 + 内存态增删改 + 重叠检测
│   └── cloud/              # 云函数（Day 15+，不是前端，别上传到静态托管）
│       ├── health/         # GET /api/health
│       └── items/          # GET/POST/PATCH/DELETE /api/items（Day 17/18/22）
├── db/                     # 数据库脚本（Day 16）：schema.sql / seed.sql（PostgreSQL 方言）
├── resource/               # 资源与产物（Day 6 约定，纳入 git）
├── PRD.md                  # 产品需求文档（含 Day 7 双表设计、后续需求）
├── TECH_DESIGN.md          # 技术设计（Day 5 稿，Day 15+ 落地更正见其修订记录）
├── api-contract.md         # 【Day 16+】接口契约：建表与写接口的唯一依据
├── DEPLOY.md               # 【Day 15】部署指南（含 CloudBase 公网排查实测）
├── CLOUD_ASSETS.md         # 【Day 15】云端资产登记表（环境 ID / 到期 / 地址）
├── research.md             # 需求研究（Day 3 过程记录，MVP 以 PRD 为准）
├── AGENTS.md               # 项目规则
└── RUN.md                  # 本文件
```

## 3. 验证步骤（肉眼可确认）

1. 浏览器地址栏显示 `localhost` 开头（如 `http://localhost:8000/`）。
2. 页面出现 **WorkShop 会议工作台**，下方是本周一~周日 7 天时间线。
3. 色块按**类型上色**：会议(蓝) / 行程(橙) / 课表(绿) / 运动(青) / 生活(紫) / 待安排(灰)。
4. 点任一色块 → 右栏出详情卡，可「编辑 / 删除」（删除有二次确认）。
5. 点顶部「+ 新建」→ 选所属表（仅 工作事项表 / 日常事项表）→ 填表创建，新色块出现在对应星期。
6. 底部表签切换 **工作事项表 / 日常事项表 / 总表**：
   - 分表内**不显示记号**；
   - **总表**显示部门/人物记号（★我/部门、△综合部、○业务部、□技术部、☆外联部、我(私人)）。
7. 重叠提示：工作表内冲突=红框⚠；日常表内重叠=橙虚框⚠（允许）；跨表(工作↔日常)冲突=紫框⚠。状态栏显示「重叠：工作⚠ / 日常⚠ / 跨表⚠」。
8. 点顶部「‹ 上周 / 下周 ›」切换周，事项按日期归属显示，每天内按开始时间升序。

## 4. 当前功能边界（MVP 范围）

- ✅ 周时间线、**双表（工作/日常）+ 三模式（工作/日常/总表）**、增删改、重叠检测（含跨表）。
- ✅ **Day 17 起前端已接真实接口**：`source/js/timeline.js` 直连 CloudBase `/api/items`，数据落 PostgreSQL，**刷新不丢**（见 §5）。
- ❌ 未接入 OCR / 腾讯会议 / PreText 界面 / 移动端完整适配（均列为后续）。
- ❌ 无账号体系、无多人实时协作（阶段二愿景）。
- ⚠️ 「数据存腾讯文档」已由 Day 15–16 决策调整为 **CloudBase PostgreSQL 为主存储**，腾讯文档降为**预留同步层**（仅 `external_id` 等字段预留，未实现同步）。
- ✅ Day 9 已实装「设置」：自定义部门 / 标记 / 类型色 / 默认视图；部门配置与日程支持 **JSON 导入 / 导出**（顶部「导入」按钮当前即走 JSON 日程导入，非 OCR）。
- ✅ Day 10 已实装周切换浏览边界（±4 周禁用上 / 下周按钮 + 状态栏提示）。

## 5. 线上接口与检查台（Day 15+ 真实后端）

| 项 | 值 |
|---|---|
| 接口基址（API_BASE） | `https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com` |
| `GET /api/health` | 健康检查，返回 `{"ok":true,"service":"workshop"}` |
| `GET /api/items` | 列表读取（支持 `start`/`end`/`table`/`type`/`ownerKey`/`keyword`） |
| `POST /api/items` | 新建事项（含内容去重 + `idempotencyKey` 幂等） |
| `PATCH /api/items/:id` | 编辑事项（部分更新；网关不放行时走 `POST + ?_method=PATCH`） |
| `DELETE /api/items/:id` | 删除事项（**必须带 `confirm=true`**；同理有 `_method` 兜底） |
| 前端公网地址 | `https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/` |

**检查台（本地起服务后打开 `http://localhost:8000/check.html`）**：一屏验完上面所有接口，区块依次为
① 健康检查 → ② items 本周真实数据 → ③ 写入测试（POST→GET 读回）→ ④ 修改（PATCH）→ ⑤ 删除（DELETE）。

> 完整字段、错误码、幂等与防误删规则以 **`api-contract.md`** 为准。

## 6. 停止服务

在启动服务器的终端按 `Ctrl + C` 结束进程即可。
