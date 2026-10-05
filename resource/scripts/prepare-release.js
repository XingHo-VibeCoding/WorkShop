#!/usr/bin/env node
/**
 * prepare-release.js —— 静态托管发布包准备器（Day 26 · 方案 B）
 *
 * 干什么：把指定版本的前端文件，拷进一个**固定名字**的目录 resource/release/workshop/，
 *         然后你去控制台上传这个 workshop 目录。
 *
 * 为什么：控制台上传文件夹时，目录名会进路径（不会自动解包）。
 *         目录名一变（v1.0 / rollback-day22），线上就出现 /v1.0/index.html 这种错位，
 *         还得手动搬文件 → 回退时间白白变长。
 *         固定成 workshop 后，每次上传的路径结构永远一致，不可能错位。
 *
 * 用法：
 *   node resource/scripts/prepare-release.js --version=rollback-day22
 *   node resource/scripts/prepare-release.js --version=v1.0
 *   node resource/scripts/prepare-release.js --from=resource/release/rollback-day22-diff
 *
 * 内置版本名：v1.0 / rollback-day22 / rollback-day22-diff
 *             也可 --from=<任意目录>
 *
 * 做完打印：文件清单、各文件体积、index.html 的去 CR MD5（给 rollback-watch.js 判定用）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const TARGET = path.join(RELEASE_DIR, 'workshop'); // 固定目录名，绝不改

const argv = process.argv.slice(2);
const arg = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) arg[m[1]] = m[2]; else arg[a.replace(/^--/, '')] = true;
}

const src = arg.from
  ? path.resolve(process.cwd(), arg.from)
  : path.join(RELEASE_DIR, arg.version || '');

if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`源目录不存在：${src}`);
  console.error(`可用的内置版本：v1.0 / rollback-day22 / rollback-day22-diff`);
  console.error(`或直接用 --from=<目录>`);
  process.exit(2);
}

// 清空重建：保证 workshop 里只有本次目标版本的文件，不留上一版残留
if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
fs.cpSync(src, TARGET, { recursive: true });

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

const files = walk(TARGET);
const md5NoCR = (f) =>
  crypto.createHash('md5')
    .update(fs.readFileSync(f, 'utf8').replace(/\r/g, ''))
    .digest('hex');

console.log('========================================');
console.log(`发布包已就绪：resource/release/workshop/`);
console.log(`来源版本：${path.relative(process.cwd(), src).split(path.sep).join('/')}`);
console.log('========================================');
let total = 0;
for (const f of files) {
  const size = fs.statSync(path.join(TARGET, f)).size;
  total += size;
  console.log(`  ${f}  (${size} bytes)`);
}
console.log('----------------------------------------');
console.log(`共 ${files.length} 个文件，${total} bytes`);
console.log(`判定哈希 index.html（去 CR）= ${md5NoCR(path.join(TARGET, 'index.html'))}`);
console.log('----------------------------------------');
console.log('下一步：控制台 → 静态网站托管 → 文件管理 → 上传这个目录');
console.log('        D:\\ima\\VibeCoding\\resource\\release\\workshop');
console.log('        目录名固定为 workshop，路径不会错位；旧文件选「覆盖」');
console.log('========================================');
