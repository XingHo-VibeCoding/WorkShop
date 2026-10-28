#!/usr/bin/env node
/**
 * rollback.js —— 一条命令回滚前端（2026-10-28 多团队版）
 *
 * 为什么要有它：回滚那天人在紧张状态下敲命令，最容易错的是路径与 cloudPath。
 *   本脚本把「选版本 → 装进固定目录 → 上传 → 验证线上真的变成目标版本」串成一步，
 *   并且强制只动静态托管。
 *
 * ⚠️ 多团队（2026-10-27 起）的铁律：**只能回前端，绝不能回云函数。**
 *   原因（已在 ROLLBACK.md §10 记录）：
 *     · 只回前端 = 安全。旧前端不传 teamId，但服务端用令牌里的 tid 决定作用域，隔离仍在。
 *     · 回云函数 = 旧版 queryItems 只有 buildQueryString(q)、没有 team_id 条件 → 全表返回，
 *       所有团队的日程会互相可见；旧版 findMemberByName 取 rows[0]，同名成员还会串团队。
 *   所以本脚本不提供函数回滚开关。函数真出问题时，见 ROLLBACK.md §10.3 的替代处置。
 *
 * 用法：
 *   node resource/scripts/rollback.js
 *       只看：线上当前是哪个版本 + 有哪些版本可回
 *
 *   node resource/scripts/rollback.js --snapshot=v1.1-tenancy
 *       把当前 source/ 前端打成可回滚的版本包（下次就能回滚到它）
 *
 *   node resource/scripts/rollback.js --to=v1.0
 *       一条命令回滚：装包 → 上传 → 轮询验证线上哈希 → 打耗时
 *
 *   node resource/scripts/rollback.js --to=v1.0 --dry-run
 *       只打印将要执行的命令，不真上传
 *
 * 退出码：0 成功 / 1 失败 / 2 参数错
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RELEASE_DIR = path.join(ROOT, 'resource', 'release');
const STAGE_DIR = path.join(RELEASE_DIR, 'workshop');   // 固定目录名，绝不改（cloudPath 依赖它）
const ENV_ID = 'workshop-d4g02a7z81ff51a63';
const ONLINE = 'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/index.html';

// argv
const arg = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) arg[m[1]] = m[2]; else arg[a.replace(/^--/, '')] = true;
}

// 去 CR 后算 MD5：本机 core.autocrlf=true，git 里存 LF、工作树是 CRLF，不去 CR 永远对不上
function md5NoCr(buf) {
  return crypto.createHash('md5').update(buf.toString('binary').replace(/\r/g, ''), 'binary').digest('hex');
}
function localHash(indexPath) {
  try { return md5NoCr(fs.readFileSync(indexPath)); } catch (e) { return null; }
}

function fetchHash(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchHash(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, status: res.statusCode }); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, status: 200, md5: md5NoCr(Buffer.concat(chunks)) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
  });
}

// 扫描 release/ 下的所有版本包 → { 版本名: {md5, mtime} }
function scanVersions() {
  const out = {};
  if (!fs.existsSync(RELEASE_DIR)) return out;
  for (const name of fs.readdirSync(RELEASE_DIR)) {
    const dir = path.join(RELEASE_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idx = path.join(dir, 'index.html');
    if (!fs.existsSync(idx)) continue;
    out[name] = { md5: localHash(idx), mtime: fs.statSync(idx).mtime.toISOString().slice(0, 10) };
  }
  return out;
}

function matchVersion(versions, md5) {
  for (const [name, v] of Object.entries(versions)) if (v.md5 === md5) return name;
  return null;
}

function snapshot(name) {
  const dir = path.join(RELEASE_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, error: `目标已存在，不覆盖：resource/release/${name}` };
  const FILES = ['index.html', 'check.html'];
  const DIRS = ['css', 'js'];
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const f of FILES) {
    const src = path.join(ROOT, 'source', f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); n++; }
  }
  for (const d of DIRS) {
    const srcDir = path.join(ROOT, 'source', d);
    if (!fs.existsSync(srcDir)) continue;
    const outDir = path.join(dir, d);
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, f);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(outDir, f));
      n++;
    }
  }
  return { ok: true, dir, count: n };
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...(opts || {}) });
  return r;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('═══ WorkShop 回滚助手 ═══\n');

  // ---- snapshot ----
  if (arg.snapshot) {
    const name = String(arg.snapshot);
    if (name === 'workshop') { console.error('✗ "workshop" 是上传暂存目录名，请换一个版本名（如 v1.1-tenancy）'); process.exit(2); }
    const r = snapshot(name);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(1); }
    const h = localHash(path.join(r.dir, 'index.html'));
    console.log(`✓ 已快照 ${r.count} 个文件 → resource/release/${name}/`);
    console.log(`  版本哈希（去 CR MD5）：${h}`);
    console.log('\n下次可以直接用：');
    console.log(`  node resource/scripts/rollback.js --to=${name}`);
    process.exit(0);
  }

  // ---- 探测线上 ----
  const versions = scanVersions();
  const online = await fetchHash(ONLINE);
  const onlineName = online.ok ? matchVersion(versions, online.md5) : null;

  console.log('线上当前：' + (online.ok
    ? (onlineName ? `${onlineName}（${online.md5}）` : `未知版本（${online.md5}）—— 本地 release/ 里没有对应的包`)
    : `探测失败（${online.error || 'HTTP ' + online.status}）`));

  if (!arg.to) {
    console.log('\n可用版本（resource/release/）：');
    const names = Object.keys(versions).filter((n) => n !== 'workshop').sort();
    if (!names.length) console.log('  （空）请先 --snapshot=名字 打一个包');
    for (const n of names) {
      const v = versions[n];
      console.log(`  ${n.padEnd(22)} ${v.md5}  ${v.mtime}${v.md5 === (online.md5 || '') ? '   ← 线上正在跑' : ''}`);
    }
    console.log('\n用法：');
    console.log('  node resource/scripts/rollback.js --snapshot=v1.1-tenancy   # 把当前 source/ 打成可回滚的包');
    console.log('  node resource/scripts/rollback.js --to=v1.0                 # 一条命令回滚前端');
    console.log('  node resource/scripts/rollback.js --to=v1.0 --dry-run       # 只看要执行什么');
    console.log('\n⚠️ 多团队版（2026-10-27 起）只能回前端，不能回云函数 —— 回函数会让所有团队日程互相可见。');
    console.log('   原因与替代处置见 ROLLBACK.md §10。');
    process.exit(0);
  }

  // ---- 回滚 ----
  const target = String(arg.to);
  if (!versions[target]) {
    console.error(`\n✗ 没有这个版本包：${target}`);
    console.error('  可用：' + Object.keys(versions).filter((n) => n !== 'workshop').join(' / '));
    process.exit(2);
  }
  if (online.ok && online.md5 === versions[target].md5) {
    console.log(`\n✓ 线上已经是 ${target}，不需要回滚。`);
    process.exit(0);
  }

  const T0 = Date.now();
  console.log(`\n→ 目标版本：${target}（${versions[target].md5}）`);

  // 1) 装包
  console.log('\n[1/3] 装包到固定目录 resource/release/workshop/');
  if (arg['dry-run']) {
    console.log(`  (dry-run) node resource/scripts/prepare-release.js --version=${target}`);
  } else {
    const r = run(process.execPath, [path.join('resource', 'scripts', 'prepare-release.js'), `--version=${target}`], { cwd: ROOT });
    if (r.status !== 0) { console.error('✗ 装包失败（上面的输出为准）'); process.exit(1); }
  }

  // 2) 上传
  const tcbCandidates = [
    'tcb',
    path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', '.bin', 'tcb'),
  ];
  const deployArgs = ['hosting', 'deploy', 'resource/release/workshop', 'workshop', '-e', ENV_ID, '--verify'];

  console.log('\n[2/3] 上传静态托管（cloudPath 固定 workshop，绝不 --prune）');
  if (arg['dry-run']) {
    console.log(`  (dry-run) tcb ${deployArgs.join(' ')}`);
    console.log('\n(dry-run 结束，没有做任何改动)');
    process.exit(0);
  }

  let uploaded = false;
  for (const bin of tcbCandidates) {
    if (!bin) continue;
    console.log(`  尝试：${bin} ${deployArgs.join(' ')}`);
    const r = run(bin, deployArgs, { cwd: ROOT });
    if (r.status === 0) { uploaded = true; break; }
    console.error(`  ✗ 该入口失败（exit ${r.status}）`);
  }
  if (!uploaded) {
    console.error('\n✗ 上传失败。两种常见原因：');
    console.error('  1) tcb 未登录/登录过期 → 浏览器授权后重试：');
    console.error('     tcb login');
    console.error('  2) TLS 被掐断（本机反复出现）→ 改用控制台手动上传目录 resource/release/workshop');
    console.error('     控制台路径：静态网站托管 → 上传文件夹 → 目录名必须保持 workshop');
    process.exit(1);
  }

  // 3) 验证线上真的变了（CDN 有延迟，最多等 180s）
  console.log('\n[3/3] 验证线上哈希（最多等 180 秒，CDN 生效有延迟）');
  const want = versions[target].md5;
  let ok = false;
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const now = await fetchHash(ONLINE);
    const secs = ((Date.now() - T0) / 1000).toFixed(1);
    if (now.ok && now.md5 === want) { ok = true; console.log(`  [${secs}s] ✓ 已生效：${now.md5}`); break; }
    console.log(`  [${secs}s] 还在跑 ${now.ok ? now.md5 : '（探测失败）'}`);
  }

  const total = ((Date.now() - T0) / 1000).toFixed(1);
  if (!ok) {
    console.error(`\n✗ ${total}s 内没检测到目标版本。上传可能已成功但 CDN 未刷新，或上传不完整。`);
    console.error('  手工确认：ctrl+F5 无痕窗口打开 ' + ONLINE);
    console.error('  版本对不上就再跑一次：node resource/scripts/rollback.js --to=' + target);
    process.exit(1);
  }

  console.log(`\n✓ 回滚完成：${onlineName || online.md5} → ${target}，总耗时 ${total}s`);
  console.log('\n接下来必须人工核对三项（脚本无法代替）：');
  console.log('  1) 无痕窗口打开线上，登录一次：能看到日程、能新建、能删除（删除要先点确认）');
  console.log('  2) 底栏「在线：N」如果消失了，属正常（v1.1 之前没有该标签）');
  console.log('  3) 跑一遍 node resource/scripts/verify-project.js（打线上）—— 若有大片红，说明回滚目标本身有问题');
  console.log('\n⚠️ 云函数一律不动。若看到「所有团队日程混在一起」，那是回错了函数，不是前端问题。');
  process.exit(0);
})();
