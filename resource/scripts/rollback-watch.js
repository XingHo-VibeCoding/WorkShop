#!/usr/bin/env node
/**
 * rollback-watch.js —— 回滚演练计时器（Day 26）
 *
 * 干什么：轮询线上静态托管的 index.html，算出去掉 CR 后的 MD5，
 *         与已知版本哈希比对，判定"线上现在跑的是哪一版"。
 *         检测到目标版本时打印起止时间戳与耗时，作为回滚演练的客观证据。
 *
 * 为什么这么做：人工报时不准确，也不可复核。用线上文件哈希判定，
 *         每次探测都有时间戳 + 哈希落盘，耗时覆盖「人工操作 + 上传 + CDN 生效」全链路。
 *
 * 注意（Day 26 实测坑）：本机 core.autocrlf=true，git 里存 LF、工作树是 CRLF，
 *         所以比对前必须 tr -d '\r'，否则全文件永远对不上。
 *
 * 用法：
 *   node resource/scripts/rollback-watch.js --once
 *      只探测一次，输出当前线上跑的是哪一版（不改任何东西）
 *   node resource/scripts/rollback-watch.js --target=<md5 或版本名> --label=回退 [--timeout=900] [--interval=5]
 *      开始计时轮询；检测到目标版本即结束并打印耗时
 *
 * 版本名可用：v1.0 / day22 / head
 * 退出码：0 = 检测到目标版本；1 = 超时；2 = 参数错
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const URL_ONLINE = 'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com/index.html';

// 已知版本哈希（去 CR 后 MD5），由 resource/release/ 下两个包实测得出
const VERSIONS = {
  'v1.0':  '645d88d8eb6fa38dc112fe3bc7f45438', // resource/release/v1.0/index.html（含 v1.0 标识）
  'day22': 'eb736fffd5e7649e8b1921b028099265', // resource/release/rollback-day22/index.html
  'head':  'b5d5998e2e6c6332ebd809588ce597cf', // Day 25 时点、无版本标识
};

function now() { return new Date(); }
function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function humanSec(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function fetchMd5() {
  return new Promise((resolve, reject) => {
    const req = https.get(URL_ONLINE, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 关键：去掉 CR 再算哈希，绕开 CRLF/LF 差异
        const md5 = crypto.createHash('md5').update(buf.toString('utf8').replace(/\r/g, '')).digest('hex');
        resolve(md5);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

function nameOf(md5) {
  for (const [name, h] of Object.entries(VERSIONS)) if (h === md5) return name;
  return '未知版本';
}

const argv = process.argv.slice(2);
const arg = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) arg[m[1]] = m[2]; else arg[a.replace(/^--/, '')] = true;
}

function logDir() {
  const d = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

(async function main() {
  if (arg.once) {
    const md5 = await fetchMd5();
    console.log(`探测时间：${fmt(now())}`);
    console.log(`线上 index.html MD5（去 CR）= ${md5}`);
    console.log(`判定：当前线上跑的是【${nameOf(md5)}】`);
    process.exit(0);
  }

  if (!arg.target) {
    console.error('缺少 --target。用法见文件头注释。');
    process.exit(2);
  }
  const targetMd5 = VERSIONS[arg.target] || arg.target;
  const targetName = Object.entries(VERSIONS).find(([, h]) => h === targetMd5)?.[0] || '自定义哈希';
  const timeoutSec = Number(arg.timeout || 900);
  const intervalSec = Number(arg.interval || 5);
  const label = arg.label || '演练';

  const t0 = now();
  const logPath = path.join(logDir(), `rollback-watch-${label.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}-${t0.getTime()}.log`);
  const lines = [];
  const out = (s) => { console.log(s); lines.push(s.replace(/\u001b\[\d+m/g, '')); };

  out('========================================');
  out(`回滚演练计时 · ${label}`);
  out(`目标版本：${targetName}（${targetMd5}）`);
  out(`起算时刻 T0：${fmt(t0)}`);
  out(`轮询间隔：${intervalSec}s ｜ 超时：${timeoutSec}s`);
  out('说明：T0 = 计时器启动（即"请开始上传"发出的时刻）；T1 = 线上文件首次变为目标版本的时刻');
  out('      耗时含：人工操作 + 上传 + CDN 生效，是真实回滚所需的端到端时间');
  out('========================================');

  let hits = 0;
  const deadline = t0.getTime() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    let md5;
    try {
      md5 = await fetchMd5();
    } catch (e) {
      out(`[${fmt(now())}] 探测失败：${e.message}（继续重试）`);
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
      continue;
    }
    const name = nameOf(md5);
    const ok = md5 === targetMd5;
    out(`[${fmt(now())}] ${ok ? '★' : '·'} ${md5} → ${name}${ok ? ' （命中目标）' : ''}`);
    if (ok) {
      hits += 1;
      if (hits >= 2) { // 连续 2 次命中才算稳定，避免 CDN 抖动
        const t1 = now();
        const cost = t1.getTime() - t0.getTime();
        out('----------------------------------------');
        out(`生效时刻 T1：${fmt(t1)}`);
        out(`耗时 T1 - T0 = ${cost} ms = ${humanSec(cost)}`);
        out(`结论：【${label}】完成，线上已稳定跑【${targetName}】`);
        out('----------------------------------------');
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
        console.log(`\n>> 证据已写入：${logPath}`);
        process.exit(0);
      }
    } else {
      hits = 0;
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }

  out(`【超时】${timeoutSec}s 内未检测到目标版本，演练未完成。`);
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\n>> 证据已写入：${logPath}`);
  process.exit(1);
})().catch((e) => { console.error('脚本异常：', e.message); process.exit(2); });
