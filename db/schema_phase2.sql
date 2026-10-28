/* ============================================================
 * WorkShop 阶段二 · 数据层增量迁移（P5）
 * ------------------------------------------------------------
 * 环境   : 腾讯云 CloudBase 关系库 —— PostgreSQL 模式（与 db/schema.sql 同源）
 * 上游   : PLAN_phase2.md P5 / PRD_phase2.md / TECH_DESIGN_phase2.md §4 / AGENTS_phase2.md §三
 *
 * ★★★ 数据安全红线（AGENTS_phase2 §三，违反即丢数据）★★★
 *   D1  本文件**绝不重跑** db/schema.sql —— 它是 DROP TABLE + CREATE，重跑 = 清空线上 11 条数据
 *   D2  本文件只做增量：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 *   D3  不删、不改旧数据；owner_member_id 为空的旧日程保持 NULL（= 未标注），不猜测性指派归属
 *   D4  **本文件不含任何 UPDATE / DELETE / DROP 语句**（可用下面的 grep 自检）
 *   D5  跑本文件之前必须先导出线上全量快照（已做：resource/logs/items-snapshot-P5-*.json）
 *
 * 幂等性 : 全部 IF NOT EXISTS，可重复执行、不报错、不新增重复行、不改动已有行
 * 兼容性 : 只加表、只加列；不改现有列语义 → 前端不读新列时，v1.0 线上行为完全不变
 * 回滚   : 最坏情况 ALTER TABLE ... DROP COLUMN（不删数据行）；绝大多数情况不需要回滚数据库
 *
 * 执行方式: CloudBase 控制台 → 数据库 → SQL 编辑器 → 粘贴全文执行
 * 执行后验证：见文末「验证 SQL」三句，逐句单独执行核对
 * ============================================================ */

SET client_encoding = 'UTF8';

/* ============================================================
 * 一、items 表新增列（只加，不改）
 * ------------------------------------------------------------
 * 语义分工（TECH_DESIGN_phase2 §6.1）——两个维度必须分开：
 *   owner_key        = 部门/人物标签（既有，v1.0 语义不变）→ 决定【记号 ★△○□☆】
 *   owner_member_id  = 真实身份（新增）                    → 决定【外框色 + 权限 + 留痕】
 * 颜色铁律：填充色 = 日程类型（会议蓝/行程橙…）；外框色 = 人（border_color）。二者并存不冲突。
 * ============================================================ */

-- 归属人：这条日程是【谁的】。NULL = 未标注（旧数据一律保持 NULL，不猜）
ALTER TABLE items ADD COLUMN IF NOT EXISTS owner_member_id INT;
-- 创建人 / 最后修改人：留痕用，回答"谁动的"
ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by INT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by INT;
-- 协作外框色：冗余自 members_phase2.border_color（避免前端每次联表；成员改色时可批量同步）
ALTER TABLE items ADD COLUMN IF NOT EXISTS border_color VARCHAR(7);
-- 腾讯会议入会信息（方案①固定个人会议号）：单条覆盖 > 成员默认（TECH_DESIGN §8.1）
ALTER TABLE items ADD COLUMN IF NOT EXISTS meeting_no  VARCHAR(32);
ALTER TABLE items ADD COLUMN IF NOT EXISTS meeting_url VARCHAR(512);

CREATE INDEX IF NOT EXISTS idx_items_member ON items(owner_member_id);

/* ============================================================
 * 二、members_phase2（成员 / 身份表）
 * ------------------------------------------------------------
 * 为什么不复用 owners 表（TECH_DESIGN §4.2 已论证）：
 *   owners = 前端设置弹窗维护的【部门/人物标签】（owner_key → 记号），没有凭据、不鉴权；
 *   本表   = 【真实登录的人】，带凭据与角色。合并会破坏 v1.0 的 markOf() 渲染链，
 *            也会让"部门"与"人"两个维度互相污染。→ 两个维度分开存。
 *
 * auth_kind: passcode 口令（默认落地方案） / wechat 微信（P6 探针，预留） / anon 匿名（预留）
 * role     : member 可编辑 / readonly 只读 / admin 管理员（本期不用，仅留字段）
 * ============================================================ */
CREATE TABLE IF NOT EXISTS members_phase2 (
  id            SERIAL PRIMARY KEY,
  display_name  VARCHAR(60)  NOT NULL DEFAULT '',
  /* 身份键：passcode 方案 = 口令的 scrypt 哈希（★不存明文）；wechat 方案 = uid
     ⚠️ 长度实测更正：crypto.scryptSync(pw, salt, 64).toString('hex') = 128 字符，
        原设计稿写 VARCHAR(64) 会「value too long」直接报错 → 取 VARCHAR(128)
     ⚠️ 可空且默认 NULL（不是空串）：NULL 不参与唯一约束，故允许多个"尚未设置凭据"
        的成员并存；若用 DEFAULT '' 则第二个空凭据成员会被唯一索引拒绝 */
  identity_key  VARCHAR(128),
  auth_kind     VARCHAR(16)  NOT NULL DEFAULT 'passcode',
  role          VARCHAR(16)  NOT NULL DEFAULT 'member',
  /* 协作外框色（如 #2F6FED）。填充色仍由日程类型决定，本列只管外框 */
  border_color  VARCHAR(7),
  /* 该成员的个人腾讯会议号 / 个人入会链接（方案①，P11 填） */
  meeting_no    VARCHAR(32),
  meeting_url   VARCHAR(512),
  /* 口令哈希盐（16 字节 → hex 32 字符），仅 passcode 方案使用 */
  salt          VARCHAR(32),
  /* 备注：可写"张三 / 综合部"之类便于人工辨认的说明 */
  note          TEXT,
  external_id   VARCHAR(64),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_members_auth_kind CHECK (auth_kind IN ('passcode', 'wechat', 'anon')),
  CONSTRAINT chk_members_role      CHECK (role      IN ('member', 'readonly', 'admin'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_members_identity ON members_phase2(identity_key);
CREATE INDEX IF NOT EXISTS idx_members_role ON members_phase2(role);

-- 【2026-10-18 在线人数】心跳时间戳：前端每 30s 上报一次，2 分钟窗口内有心跳 = 在线。
-- 只统计登录成员（匿名无令牌不记心跳）。TIMESTAMPTZ 带时区，与容器/数据库时钟解耦。
ALTER TABLE members_phase2 ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_members_online ON members_phase2(last_seen_at);

/* ============================================================
 * 三、audit_phase2（操作留痕表）
 * ------------------------------------------------------------
 * 用途只有一个：满足 PRD_phase2 A5 ②「给他人放置必须留痕」。
 *   action    : create 创建 / update 修改 / delete 删除 / place_for 代他人放置
 *   target_id : 代排（place_for）时 = 日程归属给谁；其余动作可空
 * 为什么单独建表而不塞进 items：items 只保留"最后状态"，留痕是要"每次动作"，语义不同。
 * ============================================================ */
CREATE TABLE IF NOT EXISTS audit_phase2 (
  id         SERIAL PRIMARY KEY,
  item_id    INT,
  actor_id   INT,                                   -- 谁操作的（members_phase2.id）
  action     VARCHAR(20) NOT NULL DEFAULT 'create',
  target_id  INT,                                   -- 代排时：归属给谁
  detail     TEXT,                                  -- 人工可读说明，如"把开始时间 09:00 改为 10:00"
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_audit_action CHECK (action IN ('create', 'update', 'delete', 'place_for'))
);

CREATE INDEX IF NOT EXISTS idx_audit_item  ON audit_phase2(item_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_phase2(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_at    ON audit_phase2(created_at);

-- 【2026-10-18 管理员 UI】动作白名单扩展：set_role（管理员改角色）。
-- 【2026-07-17 Step5 口令体系】再扩展三个：change_passcode（本人改）/ reset_passcode（管理员重置）/ add_member（管理员添加）。
-- 【2026-10-27 多团队】再扩展一个：create_team（管理员建团队）。
-- ⚠️ 必须 DROP 后 ADD：audit_phase2 建表时的 CHECK 白名单不含新动作，
--    直接 INSERT 新动作会被约束拒绝（留痕静默丢失）。此处保持幂等可重跑。
ALTER TABLE audit_phase2 DROP CONSTRAINT IF EXISTS chk_audit_action;
ALTER TABLE audit_phase2 ADD CONSTRAINT chk_audit_action
  CHECK (action IN ('create', 'update', 'delete', 'place_for', 'set_role',
                    'change_passcode', 'reset_passcode', 'add_member', 'create_team'));

/* ============================================================
 * 四、多团队隔离（多租户，2026-10-27 用户要求落地）
 * ------------------------------------------------------------
 * 目标：不同团队拥有各自独立的日程表，互不互通。
 *
 * 三条铁律：
 *   1) team_id 是数据访问的硬约束 —— db.js 里每条涉及团队数据的查询都必传 teamId，
 *      缺参数直接抛错（绝不静默退化成"返回全库"）。
 *   2) items / members / audit 三张表都要带 team_id。items 的读/改/删必须按 team_id 过滤，
 *      否则「知道 id 就能改别的团队的日程」。
 *   3) 团队归属以【服务端查库】为准，不单纯信任令牌里的 tid。
 *
 * 迁移策略：现有全部数据归入「默认团队」，老用户与老数据零感知。
 *   登录时 teamCode 可选 —— 不填则全局按名字找，唯一命中即登录（现有用户无感）；
 *   只有重名时才要求填团队码。
 * ============================================================ */

CREATE TABLE IF NOT EXISTS teams_phase2 (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(60) NOT NULL,
  /* 团队码 / 邀请码：既是登录时的团队定位码，也是成员自助加入的凭据。
     做成短横线大写，方便口头传达（如 WS-DEFAULT、WS-8F3K2） */
  join_code   VARCHAR(32) NOT NULL UNIQUE,
  note        TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 默认团队（幂等）：现有 11 条日程与全部成员迁到这里
INSERT INTO teams_phase2 (name, join_code)
VALUES ('默认团队', 'WS-DEFAULT')
ON CONFLICT (join_code) DO NOTHING;

-- 三张表加团队维度。
-- 为什么不设 NOT NULL：迁移期先加可空列 → 回填 → 之后业务层强校验。
-- 直接 NOT NULL 会让存量行迁移瞬间失败。
ALTER TABLE items         ADD COLUMN IF NOT EXISTS team_id INT;
ALTER TABLE members_phase2 ADD COLUMN IF NOT EXISTS team_id INT;
ALTER TABLE audit_phase2  ADD COLUMN IF NOT EXISTS team_id INT;

-- 回填：所有历史数据归入默认团队（幂等：只补 NULL 的）
UPDATE items SET team_id = (SELECT id FROM teams_phase2 WHERE join_code = 'WS-DEFAULT')
 WHERE team_id IS NULL;
UPDATE members_phase2 SET team_id = (SELECT id FROM teams_phase2 WHERE join_code = 'WS-DEFAULT')
 WHERE team_id IS NULL;
UPDATE audit_phase2 SET team_id = (SELECT id FROM teams_phase2 WHERE join_code = 'WS-DEFAULT')
 WHERE team_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_items_team      ON items(team_id);
CREATE INDEX IF NOT EXISTS idx_items_team_time ON items(team_id, start_time);
CREATE INDEX IF NOT EXISTS idx_members_team    ON members_phase2(team_id);
CREATE INDEX IF NOT EXISTS idx_audit_team      ON audit_phase2(team_id);

-- 团队内成员名唯一（同名可以出现在不同团队）；空名不参与唯一约束，
-- 否则两个"尚未命名"的成员会互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS ux_members_team_name
  ON members_phase2(team_id, display_name) WHERE display_name <> '';

/* ============================================================
 * 五、updated_at 自动维护（沿用 db/schema.sql 的既有触发器函数）
 * ------------------------------------------------------------
 * set_updated_at() 已由 db/schema.sql 创建；此处 CREATE OR REPLACE 保证幂等
 * （若函数已存在且体相同，重跑无副作用）。
 * audit_phase2 是只追加的留痕表，**不挂** updated_at 触发器。
 * ============================================================ */
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_members_phase2_updated ON members_phase2;
CREATE TRIGGER trg_members_phase2_updated BEFORE UPDATE ON members_phase2
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ============================================================
 * 六、表 / 字段注释
 * ============================================================ */
COMMENT ON TABLE members_phase2 IS '【阶段二 P5】成员/身份表：真实登录的人（与 owners「部门标签」两个维度分开）。passcode 方案下 identity_key 存 scrypt 哈希，明文口令只出现在生成那一刻。';
COMMENT ON COLUMN members_phase2.id            IS '主键，SERIAL 自增；items.owner_member_id / created_by / updated_by 指向它（应用层关联，无 FK，便于迁移腾讯文档）';
COMMENT ON COLUMN members_phase2.display_name  IS '显示名，如「张三」';
COMMENT ON COLUMN members_phase2.identity_key  IS '身份键：passcode=口令 scrypt 哈希 hex（128 字符，实测长度，勿改小）/ wechat=uid。唯一索引防重复身份；NULL=尚未设置凭据（NULL 不受唯一约束，允许多个未设凭据成员并存）';
COMMENT ON COLUMN members_phase2.auth_kind     IS '认证方式 passcode 口令 / wechat 微信(预留) / anon 匿名(预留)';
COMMENT ON COLUMN members_phase2.role          IS '角色 member 可编辑 / readonly 只读 / admin 管理员（2026-10-18 起已实配：库中有 admin 账号，seam C 管理 UI 落地）';
COMMENT ON COLUMN members_phase2.border_color  IS '协作外框色 hex，如 #2F6FED；★填充色仍由日程类型决定，本列只管外框（颜色铁律）';
COMMENT ON COLUMN members_phase2.meeting_no    IS '该成员的个人腾讯会议号（方案① 固定个人会议号，P11 填）';
COMMENT ON COLUMN members_phase2.meeting_url   IS '该成员的个人入会链接（P11 填）；写入时校验腾讯会议域名白名单';
COMMENT ON COLUMN members_phase2.salt          IS '口令哈希盐，16 字节 → hex 32 字符；仅 passcode 使用';
COMMENT ON COLUMN members_phase2.note          IS '备注，便于人工辨认（如「张三 / 综合部」）';
COMMENT ON COLUMN members_phase2.last_seen_at  IS '【2026-10-18 在线人数】最近一次心跳时间；前端 30s 上报，2 分钟窗口内有心跳视为在线。匿名不记（只统计登录成员）';
COMMENT ON COLUMN members_phase2.external_id   IS '【预留·腾讯文档】记录 ID，未同步为空';
COMMENT ON COLUMN members_phase2.created_at    IS '创建时间';
COMMENT ON COLUMN members_phase2.updated_at    IS '更新时间，触发器自动维护';

COMMENT ON TABLE audit_phase2 IS '【阶段二 P5】操作留痕表：只追加不修改。核心用途 = PRD_phase2 A5②「给他人放置必须留痕」(action=place_for)。';
COMMENT ON COLUMN audit_phase2.item_id    IS '被操作的日程 id（items.id）；日程被删除后本行仍保留，故不建 FK';
COMMENT ON COLUMN audit_phase2.actor_id   IS '操作者 members_phase2.id';
COMMENT ON COLUMN audit_phase2.action     IS '动作 create/update/delete/place_for/set_role';
COMMENT ON COLUMN audit_phase2.target_id  IS '代排(place_for)时：日程归属给谁（members_phase2.id）；set_role 时：被改角色的成员 id；其余动作可空';
COMMENT ON COLUMN audit_phase2.detail     IS '人工可读说明，如「把开始时间 09:00 改为 10:00」';
COMMENT ON COLUMN audit_phase2.created_at IS '发生时间（留痕不设 updated_at：历史不容改写）';

COMMENT ON COLUMN items.owner_member_id IS '【阶段二 P5】归属人 members_phase2.id：这条日程是【谁的】。NULL=未标注（11 条旧数据一律保持 NULL，不猜测指派）。★与 owner_key(部门标签) 是两个维度，不可互换';
COMMENT ON COLUMN items.created_by      IS '【阶段二 P5】创建人 members_phase2.id；匿名/v1.0 写入为 NULL';
COMMENT ON COLUMN items.updated_by      IS '【阶段二 P5】最后修改人 members_phase2.id';
COMMENT ON COLUMN items.border_color    IS '【阶段二 P5】协作外框色，冗余自 members_phase2.border_color（免联表）。★只管外框，填充色 = 日程类型';
COMMENT ON COLUMN items.meeting_no      IS '【阶段二 P5】单条覆盖的会议号；优先级 items > members_phase2（TECH_DESIGN §8.1）';
COMMENT ON COLUMN items.meeting_url     IS '【阶段二 P5】单条覆盖的入会链接；未配置两者都空则不显示入会入口（不报错、不空链）。仅对 type=meeting 生效';

/* —— 2026-10-27 多团队隔离 —— */
COMMENT ON TABLE  teams_phase2 IS '【2026-10-27 多租户】团队表。目标：不同团队独立日程表、互不互通。join_code 既是登录定位码也是自助加入的邀请码。';
COMMENT ON COLUMN teams_phase2.join_code IS '团队码/邀请码（大写短横线，如 WS-DEFAULT）：登录时可填、注册时必须填；唯一';
COMMENT ON COLUMN items.team_id          IS '【2026-10-27】所属团队。★读/改/删都必须带此条件，否则跨团队越权。历史数据回填为默认团队';
COMMENT ON COLUMN members_phase2.team_id IS '【2026-10-27】所属团队；团队内 display_name 唯一（跨团队可同名）。团队归属以库为准，不只信令牌';
COMMENT ON COLUMN audit_phase2.team_id   IS '【2026-10-27】留痕所属团队，便于按团队审计';

/* ============================================================
 * 七、【2026-10-28】日程类型与颜色体系 + 核心管理员（core）
 * ------------------------------------------------------------
 * 用户决策（2026-10-28）：
 *   ② 选 B —— 「新增颜色 = 新增日程类型」（不是只换色值，也不是另开标签维度）
 *      并且允许改已有类型的颜色
 *   ③ 选 A —— 新增一级「核心管理员（core）」，全局统一管所有团队的类型颜色
 *
 * 为什么类型表是**全局**而不是每团队一份：
 *   颜色是跨团队沟通的公共语言（"蓝色=会议"）。若各团队各管一套，A 团队发来的截图
 *   B 团队就看不懂了。所以类型/颜色只有一份，写权限只给 core。
 *
 * 为什么内置类型不可删：
 *   items.type 里已经存着历史数据，删掉类型定义会让那批数据失去标签与颜色（不会丢数据，
 *   但会变成"未知类型"）。内置 6 个 + other 一律 builtin=true，只允许改色改标签。
 *
 * 为什么变更留痕不进 audit_phase2：
 *   audit_phase2 是**团队维度**的表（team_id NOT NULL），而类型变更是全局操作、
 *   不属于任何团队。硬塞进去要么给个假 team_id，要么放宽约束——都是污染。
 *   改为在类型表本身记 updated_by / updated_at，够追溯了。
 * ============================================================ */
CREATE TABLE IF NOT EXISTS item_types_phase2 (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(24)  NOT NULL UNIQUE,
  label        VARCHAR(24)  NOT NULL,
  color        VARCHAR(9)   NOT NULL,
  builtin      BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order   INT          NOT NULL DEFAULT 100,
  updated_by   INT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_item_types_color CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT chk_item_types_code  CHECK (code ~ '^[a-z][a-z0-9_]{1,23}$')
);
CREATE INDEX IF NOT EXISTS idx_item_types_order ON item_types_phase2(sort_order, id);

-- 内置类型种子（颜色与 css/base.css 的 :root 变量逐字一致，避免"库里改了色、页面没变"）
-- ON CONFLICT DO NOTHING：重复执行不会覆盖用户后来调过的颜色（幂等）
INSERT INTO item_types_phase2 (code, label, color, builtin, sort_order) VALUES
  ('meeting', '会议',   '#1d4ed8', TRUE, 10),
  ('course',  '课表',   '#15803d', TRUE, 20),
  ('travel',  '行程',   '#b45309', TRUE, 30),
  ('sport',   '运动',   '#0e7490', TRUE, 40),
  ('life',    '生活',   '#6d28d9', TRUE, 50),
  ('pending', '待安排', '#5b6472', TRUE, 60),
  ('other',   '其他',   '#5b6472', TRUE, 70)
ON CONFLICT (code) DO NOTHING;

-- 角色白名单扩展 core（全局超管：管类型/颜色体系；★不授予跨团队日程读写）
ALTER TABLE members_phase2 DROP CONSTRAINT IF EXISTS chk_members_role;
ALTER TABLE members_phase2 ADD CONSTRAINT chk_members_role
  CHECK (role IN ('member', 'readonly', 'admin', 'core'));

COMMENT ON TABLE  item_types_phase2 IS '【2026-10-28】日程类型与颜色（全局唯一一份）。内置类型不可删只可改；自定义类型由 core 增删。';
COMMENT ON COLUMN item_types_phase2.code       IS '类型码：存进 items.type 的就是它。内置沿用历史词（meeting/course/travel/sport/life/pending/other）；自定义形如 custom_xxx';
COMMENT ON COLUMN item_types_phase2.color      IS '类型色 #RRGGBB。前端启动时注入 --c-<code> CSS 变量；必须满足白字对比 ≥4.5:1（前后端都校验）';
COMMENT ON COLUMN item_types_phase2.builtin    IS '内置类型：不可删除（库里已有历史数据在用），只可改色/改标签';
COMMENT ON COLUMN item_types_phase2.updated_by IS '最后修改人的 members_phase2.id（全局操作不进团队维度的 audit_phase2，这里记一笔够追溯）';
COMMENT ON COLUMN members_phase2.role          IS '角色 member 可编辑 / readonly 只读 / admin 团队管理员 / core 核心管理员（2026-10-28 新增：全局管类型颜色，不授予跨团队日程读写）';

/* ============================================================
 * 八、验证 SQL（在控制台逐句单独执行，不要和业务变更一起跑）
 * ------------------------------------------------------------
 * V1）新列是否存在（应返回 6 行）
 *   SELECT column_name, data_type, character_maximum_length
 *   FROM information_schema.columns
 *   WHERE table_name='items'
 *     AND column_name IN ('owner_member_id','created_by','updated_by',
 *                         'border_color','meeting_no','meeting_url')
 *   ORDER BY column_name;
 *
 * V2）两张新表是否存在（应返回 2 行）
 *   SELECT table_name FROM information_schema.tables
 *   WHERE table_name IN ('members_phase2','audit_phase2');
 *
 * V3）★ 数据无损核对（应仍为 11，且 owner_member_id 全为 NULL）
 *   SELECT COUNT(*) AS total,
 *          COUNT(owner_member_id) AS 已标注归属,
 *          COUNT(*) - COUNT(owner_member_id) AS 未标注
 *   FROM items;
 *
 * V4）【2026-10-18】在线人数列 + set_role 约束（应各返回 1 行 / 约束含 set_role）
 *   SELECT column_name FROM information_schema.columns
 *   WHERE table_name='members_phase2' AND column_name='last_seen_at';
 *   SELECT pg_get_constraintdef(oid) FROM pg_constraint
 *   WHERE conname='chk_audit_action';
 *   -- 应含全部 8 个动作：create/update/delete/place_for/set_role/change_passcode/reset_passcode/add_member
 *
 * V5）【2026-10-27 多团队隔离】团队表 + 三处 team_id + 回填是否干净
 *   -- ① 默认团队存在且只有一条（应 1 行：默认团队 / WS-DEFAULT）
 *   SELECT id, name, join_code FROM teams_phase2;
 *   -- ② 三张表的 team_id 列都在（应 3 行）
 *   SELECT table_name, column_name FROM information_schema.columns
 *   WHERE column_name='team_id'
 *     AND table_name IN ('items','members_phase2','audit_phase2');
 *   -- ③ ★ 回填完整性：三列都应返回 0（有孤儿行说明回填漏了）
 *   SELECT
 *     (SELECT COUNT(*) FROM items         WHERE team_id IS NULL) AS items_无团队,
 *     (SELECT COUNT(*) FROM members_phase2 WHERE team_id IS NULL) AS members_无团队,
 *     (SELECT COUNT(*) FROM audit_phase2  WHERE team_id IS NULL) AS audit_无团队;
 *   -- ④ 数据无损：仍应为 11
 *   SELECT COUNT(*) FROM items;
 *
 * V6）【2026-10-28】类型颜色表 + core 角色
 *   -- ① 内置类型应 7 条（meeting/course/travel/sport/life/pending/other）
 *   SELECT code, label, color, builtin, sort_order FROM item_types_phase2 ORDER BY sort_order, id;
 *   -- ② 角色约束应含 4 个：member / readonly / admin / core
 *   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='chk_members_role';
 *   -- ③ 谁是核心管理员（初始为空 —— 必须手工提权一次，见下方提示）
 *   SELECT id, display_name, role, team_id FROM members_phase2 WHERE role = 'core';
 *   -- ★ 提权一条（把第一个管理员升为 core；id 按上一条查询结果替换）
 *   --   UPDATE members_phase2 SET role='core' WHERE id = 2;
 *
 * 幂等验证：把本文件再执行一遍，应无报错、V1~V6 结果不变。
 * 执行顺序铁律：**先跑本文件的 SQL，再重传 items 云函数**。
 *   反了会怎样：新函数按 team_id 过滤，而列还没加 → 所有查询 500。
 *   反过来（先 SQL 后函数）是安全的：旧函数不写 team_id，新列可空，互不影响。
 *   【2026-10-28 起放宽】类型表缺表**不再**会导致崩：新函数读不到 item_types_phase2 时
 *   会回退到内置 7 个类型的常量并打一条 console.error，站点继续可用（只是自定义类型不生效）。
 *   这是刻意的：部署顺序错一步不该让整个站点 500。
 * ============================================================ */
