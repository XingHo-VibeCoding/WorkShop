/* ============================================================
 * WorkShop 种子数据（Day 16｜第 3 周·建表+种子）
 * ------------------------------------------------------------
 * 配套 db/schema.sql 使用，目标库为 CloudBase PostgreSQL（workshop 环境）
 *
 * 幂等设计：PostgreSQL 用「ON CONFLICT (主键) DO UPDATE」对应 MySQL 的
 *           INSERT … ON DUPLICATE KEY UPDATE
 *   - owners           主键 owner_key（文本 key），命中即 UPDATE
 *   - meeting_requests 显式 id 1..6（SERIAL 允许显式值），命中即 UPDATE
 *   - items            显式 id 1..10，命中即 UPDATE
 *   ⇒ 重复执行本文件：已存在行走 UPDATE 分支，不会报错、不会重复插行
 *   ⇒ 显式 id 插入后调用 setval 同步序列，避免后续自动插入主键冲突
 *
 * 关联一致性：items.owner_key 必须对应 owners.owner_key；
 *             items.meeting_request_id 对应 meeting_requests.id（普通事项为空）
 *
 * 注意：external_id / tencent_meeting_* 等预留字段在种子中留 NULL（=未同步/未创建会议）
 * ============================================================ */

SET client_encoding = 'UTF8';

/* ----------------------------------------------------------
 * owners（5 行）—— 被 items 关联
 * ---------------------------------------------------------- */
INSERT INTO owners (owner_key, name, mark, avatar_url, color, kind) VALUES
  ('self',  '我(综合部)', '★', NULL,       '#C9A227', 'person'),
  ('depta', '综合部',     '○', NULL,       '#3A6EA5', 'dept'),
  ('deptb', '业务部',     '△', NULL,       '#C0504D', 'dept'),
  ('deptc', '技术部',     '□', NULL,       '#4F8A4F', 'dept'),
  ('deptd', '外联部',     '☆', NULL,       '#8064A2', 'dept')
ON CONFLICT (owner_key) DO UPDATE SET
  name=EXCLUDED.name, mark=EXCLUDED.mark, avatar_url=EXCLUDED.avatar_url,
  color=EXCLUDED.color, kind=EXCLUDED.kind;

/* ----------------------------------------------------------
 * meeting_requests（6 行）—— F3 会议要求窗口录入示例
 * status: converted 表示已转为事项；pending 表示还在待排
 * ---------------------------------------------------------- */
INSERT INTO meeting_requests
  (id, title, expected_start, expected_end, duration_min, attendee_count, attendee_list, venue_req, equipment_req, note, status)
VALUES
  (1, '周例会',     '2026-09-28', '2026-10-04', 60, 12, '张三,李四,王五,赵六', '大会议室', '投影,白板',        NULL,            'converted'),
  (2, '项目评审会', '2026-09-29', '2026-09-29', 90,  8,  '李四,王五,钱七',     '评审室',   '投影,投屏',        '需提前发材料',   'converted'),
  (3, '客户洽谈',   '2026-09-30', '2026-09-30', 45,  4,  '赵六,孙八',         '洽谈室',   '电视,电话会议',    NULL,            'pending'),
  (4, '部门周会',   '2026-10-01', '2026-10-01', 30,  6,  '综合部全员',         '小会议室', '白板',            NULL,            'pending'),
  (5, '新人培训',   '2026-10-02', '2026-10-02', 120, 20, '全体新人,HR',        '培训室',   '投影,麦克风',      '准备签到表',     'converted'),
  (6, '季度总结',   '2026-10-03', '2026-10-03', 180, 30, '全公司',            '多功能厅', '投影,音响,话筒',   '需PPT汇总',     'pending')
ON CONFLICT (id) DO UPDATE SET
  title=EXCLUDED.title, expected_start=EXCLUDED.expected_start, expected_end=EXCLUDED.expected_end,
  duration_min=EXCLUDED.duration_min, attendee_count=EXCLUDED.attendee_count, attendee_list=EXCLUDED.attendee_list,
  venue_req=EXCLUDED.venue_req, equipment_req=EXCLUDED.equipment_req, note=EXCLUDED.note, status=EXCLUDED.status;

/* 同步 SERIAL 序列，避免后续自动插入 id 与已用显式值冲突 */
SELECT setval(pg_get_serial_sequence('meeting_requests','id'), (SELECT MAX(id) FROM meeting_requests));

/* ----------------------------------------------------------
 * items（核心表，10 行）—— 周时间线事项，工作/日常同表
 * table_kind: work 工作 / daily 日常
 * type: meeting 会议 / travel 行程 / course 课表 / sport 运动 / life 生活 / pending 待安排
 * meeting_request_id: 由会议要求生成的事项填对应 id，普通事项为 NULL
 * ---------------------------------------------------------- */
INSERT INTO items
  (id, title, type, table_kind, start_time, end_time, week, attendees, venue, equipment, note, source, status, owner_key, meeting_request_id)
VALUES
  (1,  '周例会',           'meeting', 'work',  '2026-09-28 09:00:00', '2026-09-28 10:00:00', '2026-W39', '张三,李四,王五,赵六', '大会议室',  '投影',      NULL,            'manual', 'scheduled', 'depta', 1),
  (2,  '项目评审会',       'meeting', 'work',  '2026-09-29 14:00:00', '2026-09-29 15:30:00', '2026-W39', '李四,王五,钱七',     '评审室',    '投影',      '需提前发材料',   'manual', 'scheduled', 'deptb', 2),
  (3,  '新人培训',         'meeting', 'work',  '2026-10-02 10:00:00', '2026-10-02 12:00:00', '2026-W40', '全体新人,HR',         '培训室',    '麦克风',    '准备签到表',     'manual', 'scheduled', 'deptd', 5),
  (4,  '出差-北京',        'travel',  'work',  '2026-09-30 07:30:00', '2026-09-30 19:00:00', '2026-W39', '赵六',               '高铁站',    NULL,        '带合同',         'manual', 'scheduled', 'deptb', NULL),
  (5,  '高等数学(二)',     'course',  'work',  '2026-09-28 08:00:00', '2026-09-28 09:40:00', '2026-W39', '物电院23级',          '东楼201',   NULL,        NULL,            'manual', 'scheduled', 'self',  NULL),
  (6,  '篮球训练',         'sport',   'daily', '2026-09-28 17:30:00', '2026-09-28 19:00:00', '2026-W39', '院队',               '体育馆',    '篮球',      NULL,            'manual', 'scheduled', 'self',  NULL),
  (7,  '晚餐-家人聚会',    'life',    'daily', '2026-09-28 19:30:00', '2026-09-28 21:00:00', '2026-W39', '家人',               '老家',      NULL,        NULL,            'manual', 'scheduled', 'self',  NULL),
  (8,  '客户洽谈',         'meeting', 'work',  '2026-09-30 15:00:00', '2026-09-30 15:45:00', '2026-W39', '赵六,孙八',          '洽谈室',    '电话会议',  NULL,            'manual', 'pending',   'deptd', 3),
  (9,  '季度总结筹备',     'meeting', 'work',  '2026-10-03 09:00:00', '2026-10-03 12:00:00', '2026-W40', '全公司',             '多功能厅',  '音响',      '需PPT汇总',     'manual', 'pending',   'depta', 6),
  (10, '健身',             'sport',   'daily', '2026-09-29 07:00:00', '2026-09-29 07:45:00', '2026-W39', 'self',               '健身房',    NULL,        NULL,            'manual', 'scheduled', 'self',  NULL)
ON CONFLICT (id) DO UPDATE SET
  title=EXCLUDED.title, type=EXCLUDED.type, table_kind=EXCLUDED.table_kind,
  start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, week=EXCLUDED.week,
  attendees=EXCLUDED.attendees, venue=EXCLUDED.venue, equipment=EXCLUDED.equipment,
  note=EXCLUDED.note, source=EXCLUDED.source, status=EXCLUDED.status,
  owner_key=EXCLUDED.owner_key, meeting_request_id=EXCLUDED.meeting_request_id;

/* 同步 SERIAL 序列 */
SELECT setval(pg_get_serial_sequence('items','id'), (SELECT MAX(id) FROM items));
