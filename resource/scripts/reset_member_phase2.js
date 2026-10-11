#!/usr/bin/env node
// WorkShop · 阶段二 P5/P8 · 成员口令重置（一次性本地小工具）
// ---------------------------------------------------------------------------
// 干什么：成员（含管理员自己）忘了口令时，本地算好新的 salt + scrypt 哈希，
//         打印一条 UPDATE 语句；你粘到 CloudBase 控制台 SQL 编辑器执行即可。
//         **不需要知道旧口令**——你作为项目主能直接改库。
// 为什么单独一个脚本：gen_member_phase2.js 只生成 INSERT（新建），重置要 UPDATE，
//         且语义不同（按名称定位、只改两列），故单列，避免改动新建脚本。
//
// 用法（建议用环境变量传口令，不留 shell 历史）：
//   WORKSHOP_MEMBER_PASS=新口令 node resource/scripts/reset_member_phase2.js --name 张三
//   WORKSHOP_MEMBER_PASS=newpass node resource/scripts/reset_member_phase2.js --name-b64 5byg5LiJ
//
// 参数：
//   --name      要重置的成员显示名（中文）
//   --name-b64  显示名 base64(utf8)，与 --name 二选一，绕开中文 argv 乱码
//   --pass      明文新口令（也可走环境变量 WORKSHOP_MEMBER_PASS，推荐）
//
// ★ 一致性契约（必须与 identity_phase2.js / gen_member_phase2.js 完全一致）：
//     crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex')
//   salt 在库里是 32 字符 hex 文本，算哈希时要 Buffer.from(salt,'hex') 还原 16 字节。
//
// 安全：明文口令只在屏幕回显一次，不写任何文件；脚本不连数据库。
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
  console.log('用法：WORKSHOP_MEMBER_PASS=新口令 node resource/scripts/reset_member_phase2.js --name 张三');
  console.log('      --name-b64 <base64> 可代替 --name（中文 argv 乱码兜底）');
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

// —— 新口令 ——
const password = args.pass || process.env.WORKSHOP_MEMBER_PASS || '';
if (!password) {
  console.error('❌ 缺少新口令：用 --pass <口令>，或先 export WORKSHOP_MEMBER_PASS=<口令>（推荐，不留 shell 历史）');
  process.exit(1);
}
if (password.length < 4) {
  console.error('❌ 口令至少 4 位（太短容易被试出来）');
  process.exit(1);
}

// —— 生成新 salt + scrypt 哈希（与 gen_member_phase2.js 完全一致） ——
const SALT_BYTES = 16;   // → hex 32 字符
const HASH_BYTES = 64;   // → hex 128 字符
const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
const hashHex = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), HASH_BYTES).toString('hex');

// PG 单引号转义（翻倍）
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const sql =
  `UPDATE members_phase2\n` +
  `SET identity_key = ${q(hashHex)},\n` +
  `    salt = ${q(saltHex)},\n` +
  `    updated_at = now()\n` +
  `WHERE display_name = ${q(displayName)};`;

// —— 输出 ——
console.log('');
console.log('──────── 成员口令重置（UPDATE） ────────');
console.log(`成员显示名   : ${displayName}`);
console.log(`新明文口令   : ${password}   ← 只在屏幕上出现这一次，请自己记好`);
console.log(`新 salt(32)  : ${saltHex}`);
console.log(`新 哈希(128) : ${hashHex.slice(0, 32)}…（共 128 字符）`);
console.log('');
console.log('复制下面这条 SQL，到 CloudBase 控制台 → 数据库 → SQL 编辑器 执行：');
console.log('');
console.log(sql);
console.log('');
console.log('⚠️ 执行后回读核对（应返回 1 行，identity_key 不再是明文）：');
console.log(`   SELECT id, display_name, role, length(identity_key) AS 哈希长度, length(salt) AS 盐长度 FROM members_phase2 WHERE display_name = ${q(displayName)};`);
console.log('');
console.log('★ 若 UPDATE 返回 0 行：说明库里没有叫这个名字的成员，先 SELECT 确认 display_name 拼写（中文尤其注意）。');
console.log('');
