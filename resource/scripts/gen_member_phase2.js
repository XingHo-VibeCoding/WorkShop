#!/usr/bin/env node
// WorkShop · 阶段二 P5 · 成员口令哈希生成（一次性本地小工具）
// ---------------------------------------------------------------------------
// 干什么：把「显示名 + 明文口令」变成一条可以直接粘贴进 CloudBase 控制台的
//         INSERT 语句。库里只存 salt 与 scrypt 哈希，**明文口令不入库、不落盘**。
// 为什么需要它：P7 里程碑要建两个身份，手算 scrypt 不现实；但口令哈希又必须
//         与 P6 的 identity_phase2.js 完全一致，否则永远登录失败 → 所以放脚本里固定死。
//
// 用法（在 PowerShell / Git Bash 里跑，建议在 Git Bash）：
//   node resource/scripts/gen_member_phase2.js --name 张三 --pass abc123
//   node resource/scripts/gen_member_phase2.js --name 李四 --pass xyz789 --role readonly --color #E8734A
//   node resource/scripts/gen_member_phase2.js --name-b64 5byg5LiJ --pass abc123   # 中文 argv 乱码时的兜底
//
// 参数：
//   --name      显示名（中文）
//   --name-b64  显示名的 base64（utf8），与 --name 二选一，用于绕开中文 argv 编码问题
//   --pass      明文口令。只在屏幕回显一次，不写任何文件
//               推荐改用环境变量：WORKSHOP_MEMBER_PASS=<口令> node ...（口令不进 shell 历史）
//   --role      member(默认) / readonly / admin
//   --color     协作外框色 hex，如 #2F6FED（可选）
//   --note      备注（可选，默认写生成来源）
//   --help     看说明
//
// ★ 与服务端的一致性契约（P6 的 identity_phase2.js 必须照抄这段）：
//     const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
//   即：salt 在库里存的是 32 字符 hex 文本，计算哈希时要 Buffer.from(salt,'hex') 还原成 16 字节。
//   两端任一侧写错（比如直接把 hex 字符串当 salt 传），哈希就对不上 → 登录永远失败。
//
// 退出码：0 = 正常输出；1 = 参数错误。
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

// ———————————————— 参数解析 ————————————————

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
  console.log('用法：node resource/scripts/gen_member_phase2.js --name 张三 --pass abc123 [--role member] [--color #2F6FED] [--note 备注]');
  console.log('      --name-b64 <base64> 可代替 --name（中文 argv 乱码兜底）');
  process.exit(0);
}

// ———————————————— 校验 ————————————————

let displayName = '';
if (args['name-b64']) {
  displayName = Buffer.from(args['name-b64'], 'base64').toString('utf8');
} else if (args.name) {
  displayName = args.name;
} else {
  console.error('❌ 缺少 --name（或 --name-b64）');
  process.exit(1);
}

// 明文口令两路来源：--pass 参数，或环境变量 WORKSHOP_MEMBER_PASS。
// ★ 推荐用环境变量：口令不会留在 shell 历史里，也不会被同机其他进程从 ps 看到。
const password = args.pass || process.env.WORKSHOP_MEMBER_PASS || '';
if (!password) {
  console.error('❌ 缺少口令：用 --pass <口令>，或先 export WORKSHOP_MEMBER_PASS=<口令>（推荐，不留 shell 历史）');
  process.exit(1);
}
if (password.length < 4) {
  console.error('❌ 口令至少 4 位（太短容易被试出来）');
  process.exit(1);
}

const role = args.role || 'member';
if (!['member', 'readonly', 'admin'].includes(role)) {
  console.error(`❌ --role 只能是 member / readonly / admin，收到：${role}`);
  process.exit(1);
}

const borderColor = args.color || '';
if (borderColor && !/^#[0-9A-Fa-f]{6}$/.test(borderColor)) {
  console.error(`❌ --color 必须是 6 位 hex，如 #2F6FED，收到：${borderColor}`);
  process.exit(1);
}

const note = args.note || `P5 由 gen_member_phase2.js 生成（${new Date().toISOString().slice(0, 10)}）`;

// ———————————————— 生成 salt + scrypt 哈希 ————————————————

const SALT_BYTES = 16;                                        // → hex 32 字符，对应 VARCHAR(32)
const HASH_BYTES = 64;                                        // → hex 128 字符，对应 VARCHAR(128)

const saltHex = crypto.randomBytes(SALT_BYTES).toString('hex');
const hashHex = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), HASH_BYTES).toString('hex');

// ———————————————— SQL 转义（单引号翻倍，PG 标准） ————————————————

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const cols = ['display_name', 'identity_key', 'auth_kind', 'role', 'salt', 'note'];
const vals = [q(displayName), q(hashHex), q('passcode'), q(role), q(saltHex), q(note)];
if (borderColor) {
  cols.push('border_color');
  vals.push(q(borderColor));
}

const sql = `INSERT INTO members_phase2 (${cols.join(', ')}) VALUES (${vals.join(', ')});`;

// ———————————————— 输出 ————————————————

console.log('');
console.log('──────── 成员口令生成结果（P5） ────────');
console.log(`显示名       : ${displayName}`);
console.log(`角色         : ${role}`);
console.log(`外框色       : ${borderColor || '(未设，前端取默认)'} `);
console.log(`明文口令     : ${password}   ← 只在屏幕上出现这一次，请自己记好`);
console.log(`salt(32 hex) : ${saltHex}`);
console.log(`哈希(128 hex): ${hashHex.slice(0, 32)}…（共 128 字符）`);
console.log('');
console.log('复制下面这条 SQL，到 CloudBase 控制台 → 数据库 → SQL 编辑器 执行：');
console.log('');
console.log(sql);
console.log('');
console.log('⚠️ 执行后请用这句回读核对（应返回 1 行，且 identity_key 不以明文出现）：');
console.log(`   SELECT id, display_name, auth_kind, role, border_color, length(identity_key) AS 哈希长度, length(salt) AS 盐长度 FROM members_phase2 WHERE display_name = ${q(displayName)};`);
console.log('');
console.log('★ 一致性提醒（P6 必看）：identity_phase2.js 里必须写成');
console.log("   crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex')");
console.log('   —— salt 是 hex 文本，要先 from(\'hex\') 还原字节，两端不一致则永远登录失败。');
console.log('');
