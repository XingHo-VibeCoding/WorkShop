#!/usr/bin/env node
// WorkShop · 阶段二 P9 · 新建成员（一次性本地小工具）
// ---------------------------------------------------------------------------
// 干什么：在库里新增一名口令成员（members_phase2），用于多人协作联调 / 只读账号测试。
//         本地算好 salt + scrypt 哈希，打印一条 INSERT 语句；你粘到 CloudBase 控制台
//         SQL 编辑器执行即可。**不连数据库、不写任何文件**（沿用 reset_member_phase2.js 的安全约定）。
//
// 用法（建议环境变量传口令，不留 shell 历史）：
//   WORKSHOP_MEMBER_PASS=只读口令 node resource/scripts/add_member_phase2.js --name 只读测试 --role readonly
//   WORKSHOP_MEMBER_PASS=abc123 node resource/scripts/add_member_phase2.js --name 李四 --role member --border '#C0392B'
//   WORKSHOP_MEMBER_PASS=abc123 node resource/scripts/add_member_phase2.js --name-b64 5p2h5pa5 --role member
//
// 参数：
//   --name       显示名（中文）；与 --name-b64 二选一
//   --name-b64   显示名 base64(utf8)，绕开中文 argv 乱码
//   --pass       明文口令（也可走环境变量 WORKSHOP_MEMBER_PASS，推荐）
//   --role       member | readonly | admin（默认 member；本期 admin 不分配，仅占位）
//   --border     外框色 hex（如 #C0392B），组织标签用；可空 → NULL
//
// ★ 一致性契约（必须与 identity_phase2.js / gen_member_phase2.js / reset_member_phase2.js 完全一致）：
//     crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex')
//
// 安全：明文口令只在屏幕回显一次；脚本不连库。
// 退出码：0 正常；1 参数错误。
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log('用法：WORKSHOP_MEMBER_PASS=口令 node resource/scripts/add_member_phase2.js --name 只读测试 --role readonly');
  console.log('      --name-b64 <base64> 可代替 --name；--role member|readonly|admin（默认 member）；--border <hex> 可选外框色');
  process.exit(0);
}

// —— 成员名 ——
let displayName = '';
if (args['name-b64']) {
  displayName = Buffer.from(args['name-b64'], 'base64').toString('utf8');
} else if (args.name) {
  displayName = args.name;
} else {
  console.error('❌ 缺少 --name（或 --name-b64）');
  process.exit(1);
}

// —— 口令 ——
const password = args.pass || process.env.WORKSHOP_MEMBER_PASS || '';
if (!password) {
  console.error('❌ 缺少口令：用 --pass <口令>，或先 export WORKSHOP_MEMBER_PASS=<口令>（推荐，不留 shell 历史）');
  process.exit(1);
}
if (password.length < 4) {
  console.error('❌ 口令至少 4 位（太短容易被试出来）');
  process.exit(1);
}

// —— 角色 ——
const ROLES = ['member', 'readonly', 'admin'];
const role = (args.role || 'member').toLowerCase();
if (!ROLES.includes(role)) {
  console.error(`❌ --role 非法：${role}（应为 ${ROLES.join(' / ')}）`);
  process.exit(1);
}

// —— 外框色（组织标签用，可空）——
const border = args.border || '';
if (border && !/^#[0-9a-fA-F]{3,8}$/.test(border)) {
  console.error(`❌ --border 非法：${border}（应为 hex，如 #C0392B）`);
  process.exit(1);
}

// —— 生成 salt + scrypt 哈希（与 reset_member_phase2.js 完全一致）——
const SALT_BYTES = 16;   // → hex 32 字符
const HASH_BYTES = 64;   // → hex 128 字符
const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
const hashHex = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), HASH_BYTES).toString('hex');

// PG 单引号转义（翻倍）
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const cols = [
  'display_name', 'role', 'auth_kind', 'identity_key', 'salt',
  'created_at', 'updated_at',
];
const vals = [
  q(displayName), q(role), q('passcode'), q(hashHex), q(saltHex), 'now()', 'now()',
];
if (border) { cols.push('border_color'); vals.push(q(border)); }

const sql =
  `INSERT INTO members_phase2 (${cols.join(', ')})\n` +
  `VALUES (${vals.join(', ')});`;

// —— 输出 ——
console.log('');
console.log('──────── 新建成员（INSERT） ────────');
console.log(`显示名     : ${displayName}`);
console.log(`角色       : ${role}`);
console.log(`外框色     : ${border || '(空 → NULL)'}`);
console.log(`明文口令   : ${password}   ← 只在屏幕上出现这一次，请自己记好`);
console.log(`salt(32)   : ${saltHex}`);
console.log(`哈希(128)  : ${hashHex.slice(0, 32)}…（共 128 字符）`);
console.log('');
console.log('复制下面这条 SQL，到 CloudBase 控制台 → 数据库 → SQL 编辑器 执行：');
console.log('');
console.log(sql);
console.log('');
console.log('⚠️ 执行后回读核对（应返回 1 行，role 正确、identity_key 是哈希不是明文）：');
console.log(`   SELECT id, display_name, role, border_color, length(identity_key) AS 哈希长度 FROM members_phase2 WHERE display_name = ${q(displayName)};`);
console.log('');
console.log('★ 重复执行会报错（主键/唯一约束），确认 display_name 不重名即可。');
console.log('');
