/* ============================================================
 * WorkShop 数据库 Schema（Day 16｜第 3 周·建表）
 * ------------------------------------------------------------
 * 环境   : 腾讯云 CloudBase 关系库 —— PostgreSQL 模式
 *           （控制台实测：执行器为 PostgreSQL，不支持 MySQL 方言）
 * 方言   : PostgreSQL（utf8，库级默认编码）
 * 目标   : Day 17 读接口只依赖核心表 `items`
 *
 * 三张表（提案A）
 *   1) items            核心表·周时间线上的所有事项（工作+日常同表）
 *   2) meeting_requests 会议安排要求表（F3 会议要求窗口录入）
 *   3) owners           归属/部门表（Day9 自定义部门/人物设置）
 *
 * 关联方式（显式 key，无数据库外键约束 → 便于迁移/同步到腾讯文档）
 *   items.owner_key           → owners.owner_key          （应用层 join）
 *   items.meeting_request_id  → meeting_requests.id       （可空，普通事项为空）
 *
 * 预留·转腾讯文档兼容（Day 16 仅预留，不实现同步接口）
 *   - 关联用文本 key，不建 FK  → 腾讯文档无外键，原样复制即迁移
 *   - 字段只用腾讯文档可映射标量（VARCHAR/TEXT/INT/TIMESTAMP），不碰 JSON/数组
 *   - 多值（参与人）用 TEXT 逗号分隔（腾讯文档无数组）
 *   - 每张表预留 external_id（腾讯文档记录ID）/ created_at / updated_at
 *   - 同步层接口契约见文末「预留接口说明」，本文件只建表、不写代码
 *
 * 预留·腾讯会议接口（Day 16 仅预留字段，不实现调用）
 *   - meeting_requests 预留 tencent_meeting_id / tencent_meeting_code / tencent_join_url
 *     三个回填字段：将来调用腾讯会议「创建会议」API 成功后回填，事项表即可直带入会信息
 *   - 调用层接口契约见文末「预留接口说明」，本文件只建表、不写代码
 *
 * 幂等   : 重复执行 DROP TABLE IF EXISTS + CREATE TABLE 不报错
 *          序列重置由 seed.sql 的 setval 同步，重复执行种子不报错、不重复插行
 * ============================================================ */

SET client_encoding = 'UTF8';

/* ----------------------------------------------------------
 * 表 1：owners（归属/部门表）—— 被 items 关联，先建
 * 业务主键 owner_key（如 self / depta），文本 key 便于腾讯文档迁移
 * ---------------------------------------------------------- */
DROP TABLE IF EXISTS owners CASCADE;
CREATE TABLE owners (
  owner_key   VARCHAR(32)  NOT NULL,
  name        VARCHAR(60)  NOT NULL DEFAULT '',
  mark        VARCHAR(4),
  avatar_url  VARCHAR(255),
  color       VARCHAR(7),
  kind        VARCHAR(10)  NOT NULL DEFAULT 'person',
  external_id VARCHAR(64),
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key)
);

/* ----------------------------------------------------------
 * 表 2：meeting_requests（会议安排要求表）—— F3 录入，生成待排会议
 * id 用 SERIAL（PostgreSQL 自增）；腾讯会议预留字段见 tencent_meeting_*
 * ---------------------------------------------------------- */
DROP TABLE IF EXISTS meeting_requests CASCADE;
CREATE TABLE meeting_requests (
  id             SERIAL PRIMARY KEY,
  title          VARCHAR(200) NOT NULL DEFAULT '',
  expected_start DATE,
  expected_end   DATE,
  duration_min   INT CHECK (duration_min IS NULL OR duration_min >= 0),
  attendee_count INT CHECK (attendee_count IS NULL OR attendee_count >= 0),
  attendee_list  TEXT,
  venue_req      VARCHAR(120),
  equipment_req  TEXT,
  note           TEXT,
  status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
  /* —— 以下三列为【预留·腾讯会议接口】字段，调用「创建会议」API 成功后回填，本文件不实现调用 —— */
  tencent_meeting_id   VARCHAR(64),
  tencent_meeting_code VARCHAR(32),
  tencent_join_url     VARCHAR(512),
  external_id    VARCHAR(64),
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_status ON meeting_requests(status);

/* ----------------------------------------------------------
 * 表 3：items（核心表）—— 周时间线所有事项，工作/日常同表
 * 字段映射 PRD §5；start/end 因是保留字改作 start_time/end_time
 * ---------------------------------------------------------- */
DROP TABLE IF EXISTS items CASCADE;
CREATE TABLE items (
  id                 SERIAL PRIMARY KEY,
  title              VARCHAR(200) NOT NULL DEFAULT '',
  type               VARCHAR(20)  NOT NULL DEFAULT 'pending',
  table_kind         VARCHAR(10)  NOT NULL DEFAULT 'work',
  start_time         TIMESTAMP,
  end_time           TIMESTAMP,
  week               VARCHAR(10),
  attendees          TEXT,
  venue              VARCHAR(120),
  equipment          VARCHAR(120),
  note               TEXT,
  source             VARCHAR(20)  NOT NULL DEFAULT 'manual',
  status             VARCHAR(20)  NOT NULL DEFAULT 'scheduled',
  owner_key          VARCHAR(32)  NOT NULL DEFAULT 'self',
  meeting_request_id INT,
  external_id        VARCHAR(64),
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_owner ON items(owner_key);
CREATE INDEX idx_table_kind ON items(table_kind);
CREATE INDEX idx_meeting_request ON items(meeting_request_id);

/* ----------------------------------------------------------
 * updated_at 自动维护（PostgreSQL 无列级 ON UPDATE，用触发器实现）
 * ---------------------------------------------------------- */
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owners_updated ON owners;
CREATE TRIGGER trg_owners_updated BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_meeting_requests_updated ON meeting_requests;
CREATE TRIGGER trg_meeting_requests_updated BEFORE UPDATE ON meeting_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_items_updated ON items;
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ----------------------------------------------------------
 * 表/字段注释（PostgreSQL 用 COMMENT ON；含字段类型选择理由）
 * ---------------------------------------------------------- */
COMMENT ON TABLE owners IS '归属/部门表（Day9 自定义部门/人物设置）。owner_key 为业务主键，被 items.owner_key 应用层关联；无数据库外键，利于迁移腾讯文档。';
COMMENT ON COLUMN owners.owner_key   IS '归属 key（业务主键）：self 我 / depta 综合部 … 文本 key 便于腾讯文档关联字段';
COMMENT ON COLUMN owners.name        IS '显示名称；VARCHAR(60) 短文本对应腾讯文档单行文本';
COMMENT ON COLUMN owners.mark        IS '记号符号 ★△○□☆；极短定长 VARCHAR(4)';
COMMENT ON COLUMN owners.avatar_url  IS '头像/徽章图片地址；URL 常见上限 255';
COMMENT ON COLUMN owners.color       IS '记号颜色 hex，如 #C9A227；固定 7 字符故 VARCHAR(7)';
COMMENT ON COLUMN owners.kind        IS '类型 person 人物 / dept 部门；VARCHAR 存语义值，腾讯文档单选可映射';
COMMENT ON COLUMN owners.external_id IS '【预留·腾讯文档】该归属在腾讯文档智能表中的记录 ID，未同步为空';
COMMENT ON COLUMN owners.created_at  IS '创建时间，映射腾讯文档创建时间';
COMMENT ON COLUMN owners.updated_at  IS '更新时间，触发器自动维护，映射腾讯文档修改时间';

COMMENT ON TABLE meeting_requests IS '会议安排要求表（F3 会议要求窗口录入）。提交后生成待排会议；转为事项时回填 items.meeting_request_id 并置 status=converted。腾讯会议预留字段 tencent_meeting_* 待未来创建会议API回填。';
COMMENT ON COLUMN meeting_requests.id             IS '主键，SERIAL 自增；腾讯文档同步时其记录 ID 存回 external_id';
COMMENT ON COLUMN meeting_requests.title          IS '会议主题/名称；VARCHAR(200) 短文本足够且省空间';
COMMENT ON COLUMN meeting_requests.expected_start IS '期望日期范围-起；DATE 仅日期，对应腾讯文档日期列';
COMMENT ON COLUMN meeting_requests.expected_end   IS '期望日期范围-止；DATE';
COMMENT ON COLUMN meeting_requests.duration_min   IS '期望时长（分钟）；INT 数值便于计算，CHECK 非负';
COMMENT ON COLUMN meeting_requests.attendee_count IS '参会人数；INT，CHECK 非负';
COMMENT ON COLUMN meeting_requests.attendee_list  IS '参会名单，逗号分隔；TEXT 不定长，避免腾讯文档无数组问题';
COMMENT ON COLUMN meeting_requests.venue_req      IS '场地要求；短文本定长 VARCHAR(120)';
COMMENT ON COLUMN meeting_requests.equipment_req  IS '设备要求；可能较长用 TEXT';
COMMENT ON COLUMN meeting_requests.note           IS '备注；TEXT';
COMMENT ON COLUMN meeting_requests.status         IS '状态 pending 待排 / converted 已转为事项；VARCHAR 语义值';
COMMENT ON COLUMN meeting_requests.tencent_meeting_id   IS '【预留·腾讯会议】创建会议后回填的会议ID(meeting_id)';
COMMENT ON COLUMN meeting_requests.tencent_meeting_code IS '【预留·腾讯会议】9位会议码（如 123-456-789），入会口令';
COMMENT ON COLUMN meeting_requests.tencent_join_url     IS '【预留·腾讯会议】入会链接(join_url)，可直点入会；URL较长故512';
COMMENT ON COLUMN meeting_requests.external_id    IS '【预留·腾讯文档】记录 ID，未同步为空';
COMMENT ON COLUMN meeting_requests.created_at     IS '创建时间';
COMMENT ON COLUMN meeting_requests.updated_at     IS '更新时间，触发器自动维护';

COMMENT ON TABLE items IS '核心表：周时间线上的所有事项（工作+日常同表，table_kind 区分）。Day17 读接口只依赖此表。关联 owners(owner_key) 与 meeting_requests(id)，均为应用层 key、无数据库外键，便于迁移腾讯文档。';
COMMENT ON COLUMN items.id                 IS '主键，SERIAL 自增；腾讯文档同步时其记录 ID 存回 external_id';
COMMENT ON COLUMN items.title              IS '事项标题';
COMMENT ON COLUMN items.type               IS '日程类型 meeting/travel/course/sport/life/pending；VARCHAR 语义值，腾讯文档单选可映射';
COMMENT ON COLUMN items.table_kind         IS '所属表 work 工作事项表 / daily 日常事项表（对应 PRD 双表三模式）';
COMMENT ON COLUMN items.start_time         IS '开始时间（东八区）；TIMESTAMP 可排序/算时长；NULL 允许待排事项';
COMMENT ON COLUMN items.end_time           IS '结束时间；TIMESTAMP';
COMMENT ON COLUMN items.week               IS '所属周，ISO 周标如 2026-W39；文本直观，腾讯文档文本可存';
COMMENT ON COLUMN items.attendees          IS '参与人，逗号分隔文本；腾讯文档无数组故逗号分隔';
COMMENT ON COLUMN items.venue              IS '场地；VARCHAR(120)';
COMMENT ON COLUMN items.equipment          IS '设备；VARCHAR(120)';
COMMENT ON COLUMN items.note               IS '备注；TEXT';
COMMENT ON COLUMN items.source             IS '来源 manual 手动 / import 导入识别；VARCHAR 语义值';
COMMENT ON COLUMN items.status             IS '状态 scheduled 已排 / pending 待排；VARCHAR 语义值';
COMMENT ON COLUMN items.owner_key          IS '归属记号 key，关联 owners.owner_key（应用层 join，无 FK）';
COMMENT ON COLUMN items.meeting_request_id IS '关联 meeting_requests.id（由会议要求生成的事项填此值，普通事项为空）';
COMMENT ON COLUMN items.external_id        IS '【预留·腾讯文档】记录 ID，未同步为空';
COMMENT ON COLUMN items.created_at         IS '创建时间';
COMMENT ON COLUMN items.updated_at         IS '更新时间，触发器自动维护';

/* ============================================================
 * 预留接口说明（Day 16 仅预留，不实现）
 * ------------------------------------------------------------
 * 未来若切回「腾讯文档当数据库」或做双向同步，建议接口契约：
 *   - 导出:  SELECT * FROM items  →  逐行写入腾讯文档智能表记录，回填 external_id
 *   - 导入:  读腾讯文档记录 → UPSERT 回 PostgreSQL，依据 external_id 幂等
 *   - 字段映射: items.* 单列对应；owner_key 在腾讯文档可作「关联记录」字段或纯文本
 *   - 同步标记: 依据 updated_at > 上次同步时间 增量同步；external_id 为空=待新建
 * 本文件不含以上代码；仅通过 external_id / created_at / updated_at 字段与
 * 「应用层 key 关联（无 FK）」为上述契约预留了结构基础。
 *
 * 腾讯会议接口契约（Day 16 仅预留字段，不实现调用）
 *   - 触发: 当 meeting_requests 的一条约被「转为事项」(status=converted) 时，
 *           若需线上会议，调用腾讯会议 REST API 的「创建会议」(POST /v1/meetings)
 *   - 回填: 接口返回的 meeting_id → tencent_meeting_id；
 *           meeting_code(9位会议码) → tencent_meeting_code；
 *           join_url → tencent_join_url
 *   - 消费: items 展示该会议事项时直带 tencent_join_url 入会链接与 tencent_meeting_code 口令
 *   - 鉴权: 届时需腾讯会议 appId/secret（secret 走环境变量，不进代码、不进提交）
 * 本文件不含以上代码；仅通过 meeting_requests 的 tencent_meeting_* 三列预留了回填落点。
 * ============================================================ */
