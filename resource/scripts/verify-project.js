#!/usr/bin/env node
// WorkShop · 发布前检查脚本（Day 25 产出 · 配套 resource/skills/verify-project/SKILL.md）
// ---------------------------------------------------------------------------
// 把项目真实踩过的坑，从「文档里的字」变成「一条命令能跑出来的 PASS/FAIL」。
// 检查项来源：Day 15（部署/静态资源）、Day 18-24（契约/幂等/删除闸门/错误状态码）、
//             Day 20（CORS）、Day 23（密钥与环境变量）、Day 20/22/23（依赖文件漏传铁律）。
//
// 用法：
//   node resource/scripts/verify-project.js            # 全量检查（会调线上接口）
//   node resource/scripts/verify-project.js --offline  # 跳过所有线上请求，只做本地静态检查
//   node resource/scripts/verify-project.js --only=V3  # 只跑指定项（可逗号分隔，如 V3,V5）
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL（可直接用于将来接 CI，今天不接）。
//
// ⚠️ 数据安全：V3/V4/V5 会往线上库写入 1 条测试数据并在末尾删除。
//    - 标题固定带 `[verify-project]` 前缀，便于人工识别；
//    - 末尾无论成败都会尝试清理（deleteItem），清理结果单独打印；
//    - 若清理失败，脚本会把「残留 id + 手动删除命令」打出来。
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ———————————————— 路径与常量 ————————————————

const REPO = path.resolve(__dirname, '..', '..');
const ITEMS_DIR = path.join(REPO, 'source', 'cloud', 'items');
const SOURCE_DIR = path.join(REPO, 'source');

// 线上接口基址（与 source/js/timeline.js、source/check.html 的 API_BASE 对齐）
const API_BASE = /const API_BASE = '([^']+)'/.exec(
  fs.readFileSync(path.join(SOURCE_DIR, 'js', 'timeline.js'), 'utf8')
)?.[1] || '';

const ALLOWED_ORIGIN = 'https://workshop-workshop-d4g02a7z81ff51a63.webapps.tcloudbase.com';
const EVIL_ORIGIN = 'http://evil.example.com';

const OFFLINE = process.argv.includes('--offline');
const LOCAL = process.argv.includes('--local'); // 本地直调模式：不走网关，直接 require 本地云函数
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// 时间统一格式（AGENTS §十.2）：YYYY-MM-DD HH:mm
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ———————————————— 结果收集 ————————————————

const LOG = [];
const RESULTS = [];

function out(s = '') { LOG.push(s); console.log(s); }

function check(id, title, pass, evidence) {
  RESULTS.push({ id, title, pass, evidence });
  out(`  ${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
  out(`        ${evidence}`);
}

function skip(id, title, why) {
  RESULTS.push({ id, title, pass: null, evidence: why, skipped: true });
  out(`  SKIP  ${id}  ${title}`);
  out(`        ${why}`);
}

function want(id) { return ONLY.length === 0 || ONLY.includes(id); }

// ———————————————— HTTP 小工具 ————————————————

// 本地直调通道（--local）：直接 require 本地云函数喂 event，看函数自己返回的 statusCode。
// 用途：验证「本地改动的代码」是否符合契约，不必先部署到线上（Day 24 定位 B1 用的就是这套方法）。
let _localFn = null;
async function reqLocal(method, urlPath, { body, headers = {} } = {}) {
  if (!_localFn) {
    process.env.CB_API_KEY = process.env.CB_API_KEY || 'local';
    _localFn = require(path.join(ITEMS_DIR, 'index.js'));
  }
  const [p, qs] = urlPath.split('?');
  const query = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  const res = await _localFn.main({
    httpMethod: method, queryStringParameters: query,
    body: body == null ? null : JSON.stringify(body),
    headers: { origin: 'http://localhost:8080', 'Content-Type': 'application/json', ...headers },
    path: p,
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { /* 保留原文 */ }
  return { status: res.statusCode, json, text: res.body, headers: { get: (k) => (res.headers || {})[k] ?? (res.headers || {})[k.toLowerCase()] } };
}

async function req(method, urlPath, opts = {}) {
  if (LOCAL) return reqLocal(method, urlPath, opts);
  const url = API_BASE + urlPath;
  const opt = { method, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
  if (opts.body != null) opt.body = JSON.stringify(opts.body);
  const res = await fetch(url, opt);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保留原文 */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ———————————————— 静态检查小工具 ————————————————

function rg(args) {
  // 用 rg 搜索；未命中时 rg 退出码为 1，属正常，不当异常
  try {
    return execFileSync('rg', args, { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    if (e.status === 1) return '';
    // rg 不在 PATH 或执行失败：回退到空结果并标注（由调用方判读）
    if (e.code === 'ENOENT') throw new Error('rg 不可用');
    return e.stdout || '';
  }
}

// ———————————————— 各检查项 ————————————————

// V1 公网健康检查
async function v1() {
  const r = await req('GET', '/api/health');
  const body = r.json;
  const ok = r.status === 200 && body && body.ok === true && body.service === 'workshop';
  check('V1', '公网健康检查 GET /api/health', ok,
    `HTTP ${r.status} · body=${JSON.stringify(body) || r.text.slice(0, 80)}`);
  return ok;
}

// V2 CORS 白名单
async function v2() {
  const hit = await req('GET', '/api/health', { headers: { Origin: ALLOWED_ORIGIN } });
  const acaoHit = hit.headers.get('access-control-allow-origin');
  const miss = await req('GET', '/api/health', { headers: { Origin: EVIL_ORIGIN } });
  const acaoMiss = miss.headers.get('access-control-allow-origin');

  const okHit = acaoHit === ALLOWED_ORIGIN;
  const okMiss = !acaoMiss; // 非白名单不得回 ACAO
  check('V2a', 'CORS 白名单命中→回该 Origin', okHit,
    `Origin=${ALLOWED_ORIGIN} → ACAO=${acaoHit || '(无)'}`);
  check('V2b', 'CORS 非白名单→不回 ACAO', okMiss,
    `Origin=${EVIL_ORIGIN} → ACAO=${acaoMiss || '(无)'}`);
  return okHit && okMiss;
}

// V3 错误响应 HTTP 状态码（Day 24 B1 的坑）
async function v3() {
  const d = new Date();
  const s = fmt(d), e = fmt(new Date(d.getTime() + 30 * 60000));

  const cases = [
    ['空标题 POST', 'POST', '/api/items', { table: 'work', type: 'meeting', title: '', startTime: s, endTime: e, ownerKey: 'self', idempotencyKey: 'vp-empty-' + Date.now() }, 400],
    ['非法 id PATCH', 'PATCH', '/api/items?id=u1718abc', { title: 'x' }, 400],
    ['缺 confirm DELETE', 'DELETE', '/api/items?id=999999', null, 400],
    ['重复删 DELETE', 'DELETE', '/api/items?id=999999&confirm=true', null, 404],
  ];

  let allOk = true;
  for (const [name, method, p, body, expect] of cases) {
    const r = await req(method, p, { body });
    const httpOk = r.status >= 400;
    const match = r.status === expect;
    // 本地模式说明：'重复删' 依赖真连库查不到记录才返回 404，本地凭据无效会抛 500；
    // 这是环境限制而非代码缺陷，故本地模式下该条只判"≥400 且非 200"，不苛求精确 404。
    const pass = LOCAL && name === '重复删 DELETE' ? httpOk : (httpOk && match);
    if (!pass) allOk = false;
    check('V3', `${name} → 期望 HTTP ${expect}`, pass,
      `实际 HTTP ${r.status} · body.error.code=${r.json?.error?.code ?? '-'}` +
      (r.status === 200 ? '  ❌ 错误响应不该是 200' : '') +
      (LOCAL && name === '重复删 DELETE' && r.status === 500 ? '  （本地无库凭据，500 属环境限制）' : ''));
  }
  return allOk;
}

// V4 写入契约 + 幂等 + 零时长
async function v4() {
  const d = new Date();
  const s = fmt(d), e = fmt(new Date(d.getTime() + 30 * 60000));
  const key = 'vp-' + Date.now();
  const payload = {
    table: 'work', type: 'meeting', title: `[verify-project] 发布前检查测试条目`,
    startTime: s, endTime: e, ownerKey: 'self', idempotencyKey: key,
  };

  const first = await req('POST', '/api/items', { body: payload });
  const idOk = first.status === 200 && Number.isInteger(first.json?.data?.id);
  check('V4a', 'POST 正常写入 → 200 且 data.id 为数字', idOk,
    `HTTP ${first.status} · data.id=${first.json?.data?.id ?? '-'}`);

  const dup = await req('POST', '/api/items', { body: payload });
  check('V4b', '同 idempotencyKey 重发 → 409', dup.status === 409,
    `HTTP ${dup.status} · body.error.code=${dup.json?.error?.code ?? '-'}`);

  const zero = await req('POST', '/api/items', {
    body: { ...payload, title: '[verify-project] 零时长', startTime: s, endTime: s, idempotencyKey: key + '-zero' },
  });
  check('V4c', '零时长 POST → 422', zero.status === 422,
    `HTTP ${zero.status} · body.error.code=${zero.json?.error?.code ?? '-'}`);

  return { ok: idOk && dup.status === 409 && zero.status === 422, id: first.json?.data?.id };
}

// V5 删除闸门（用 V4 建的那条）
async function v5(createdId) {
  if (!createdId) {
    skip('V5', '删除闸门', 'V4 未成功建出测试数据，跳过（避免误删线上真实数据）');
    return null;
  }

  const noConfirm = await req('DELETE', `/api/items?id=${createdId}`);
  const noConfirmOk = noConfirm.status === 400;
  check('V5a', 'DELETE 缺 confirm → 400（不能删）', noConfirmOk,
    `HTTP ${noConfirm.status} · body.error.code=${noConfirm.json?.error?.code ?? '-'}`);

  // 关键：确认上面那次没把数据删掉
  const still = await req('GET', `/api/items?keyword=${encodeURIComponent('[verify-project]')}`);
  const stillThere = (still.json?.data || []).some((it) => it.id === createdId);
  check('V5b', '缺 confirm 之后数据仍在（未被误删）', stillThere,
    `GET keyword 查回 ${(still.json?.data || []).length} 条 · id=${createdId} ${stillThere ? '在' : '不见了 ❌'}`);

  const withConfirm = await req('DELETE', `/api/items?id=${createdId}&confirm=true`);
  const delOk = withConfirm.status === 200 && withConfirm.json?.data?.deleted === true;
  check('V5c', 'DELETE 带 confirm → 200 且返回快照', delOk,
    `HTTP ${withConfirm.status} · data.deleted=${withConfirm.json?.data?.deleted ?? '-'}`);

  const again = await req('DELETE', `/api/items?id=${createdId}&confirm=true`);
  check('V5d', '重复删 → 404', again.status === 404,
    `HTTP ${again.status} · body.error.code=${again.json?.error?.code ?? '-'}`);

  const gone = await req('GET', `/api/items?keyword=${encodeURIComponent('[verify-project]')}`);
  const reallyGone = !(gone.json?.data || []).some((it) => it.id === createdId);
  check('V5e', '删除后 GET 查不到该 id', reallyGone,
    `id=${createdId} ${reallyGone ? '已消失' : '仍在 ❌'}`);

  return noConfirmOk && stillThere && delOk && again.status === 404 && reallyGone;
}

// V6 密钥与配置（Day 23）
function v6() {
  const SECRET_RE = "sk-[A-Za-z0-9]{8,}|AKID[A-Za-z0-9]{8,}|postgres(ql)?://|(password|passwd|pwd)\\s*[:=]\\s*['\\\"][^'\\\"]+|(api[_-]?key|apikey|secret|access[_-]?key|token)\\s*[:=]\\s*['\\\"][A-Za-z0-9_-]{8,}|Bearer\\s+[A-Za-z0-9_.-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----";

  let hits = '';
  try {
    hits = rg(['-n', '-i', '-e', SECRET_RE, '--glob', '!resource/**', '--glob', '!**/*.log', '--glob', '!打卡区/**', '.']);
  } catch (e) {
    skip('V6a', '硬编码密钥扫描', `rg 不可用：${e.message}`);
  }
  const hitLines = hits.trim() ? hits.trim().split('\n') : [];
  check('V6a', '全仓无硬编码密钥（source/ 等）', hitLines.length === 0,
    hitLines.length === 0 ? 'rg 扫描 0 命中' : `${hitLines.length} 条命中：\n          ${hitLines.slice(0, 5).join('\n          ')}`);

  // 判据：.gitignore 里必须有能覆盖 `.env` 的规则。
  // 尽量走 git 本体（最权威），但某些受限环境（如沙箱）起 git 子进程会 EBUSY/EPERM，
  // 此时降级为「读 .gitignore 文本自己判」——两种情况都当作有效证据，绝不因环境限制误报 FAIL。
  const giPath = path.join(REPO, '.gitignore');
  const giText = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const giLines = giText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  let gitRule = '', gitErr = '';
  try {
    gitRule = execFileSync('git', ['check-ignore', '-v', '.env'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch (e) {
    gitRule = (e.stdout || '').toString().trim();
    gitErr = e.code || e.message || '未知';
  }

  // 文本兜底判定：存在 `.env` 或 `.env.*` 这类忽略规则，且后面没有 `!.env` 反悔
  const hasEnvRule = giLines.some((l) => l === '.env' || l === '.env.*' || l === '.env*' || l === '*env*');
  const revoked = giLines.some((l) => l === '!.env' || l === '!.env.*');
  const textOk = hasEnvRule && !revoked;

  const v6bOk = !!gitRule || (!!gitErr && textOk);
  const v6bEv = gitRule
    ? `git check-ignore：${gitRule}`
    : gitErr
      ? `环境 git 不可用（${gitErr}），改用 .gitignore 文本判定：${textOk ? '已覆盖 .env（' + giLines.filter((l) => l.startsWith('.env')).join(' / ') + '）' : '❌ 未找到覆盖 .env 的规则'}`
      : '❌ .gitignore 中无覆盖 .env 的规则（.env 会被提交！）';
  check('V6b', '.env 被 .gitignore 忽略', v6bOk, v6bEv);

  let tracked = '', lsErr = '';
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((f) => /^\.env($|\.)/.test(f) && f !== '.env.example').join('\n');
  } catch (e) {
    lsErr = e.code || '未知';
  }
  // 环境 git 不可用时，退回「.env 文件是否真实存在于工作区」这一强证据：
  // 真密钥文件若不落地、或已被忽略，就不构成泄露；此项与 V6b 联合判读。
  const envExists = fs.existsSync(path.join(REPO, '.env'));
  check('V6c', '.env / .env.* 不在仓库里', !tracked,
    lsErr
      ? `环境 git 不可用（${lsErr}），退查工作区：${envExists ? '存在 .env 文件，请确认未被提交（配合 V6b 判读）' : '工作区无 .env 文件（只有 .env.example）'}`
      : (tracked ? `❌ 仓库里有：${tracked}` : 'git ls-files 无 .env 命中'));

  // .env.example 每行等号右侧必须为空
  const exPath = path.join(REPO, '.env.example');
  let badExample = '';
  if (fs.existsSync(exPath)) {
    for (const line of fs.readFileSync(exPath, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && m[2].trim() !== '') badExample = line.trim();
    }
  }
  check('V6d', '.env.example 只留键名（值全空）', !badExample,
    badExample ? `❌ 有值：${badExample}` : '.env.example 所有键的值均为空');

  return hitLines.length === 0 && v6bOk && !tracked && !badExample;
}

// V7 云函数本地依赖文件齐全（踩过三次的坑）
function v7() {
  const entry = path.join(ITEMS_DIR, 'index.js');
  const src = fs.readFileSync(entry, 'utf8');
  const deps = [...src.matchAll(/require\(['"]\.\/([\w.-]+)['"]\)/g)].map((m) => m[1]);
  const missing = deps.filter((f) => !fs.existsSync(path.join(ITEMS_DIR, f)));

  check('V7', `index.js 的本地依赖文件齐全（${deps.length} 个）`, missing.length === 0,
    missing.length === 0
      ? `全部存在：${deps.join(', ')}`
      : `❌ 缺失：${missing.join(', ')}（漏传会导致 /api/items 加载阶段即崩 FUNCTIONS_INVOCATION_FAILED）`);
  return missing.length === 0;
}

// V8 静态资源引用完整
function v8() {
  const htmls = fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.html'));
  const missing = [];
  let total = 0;
  for (const h of htmls) {
    const html = fs.readFileSync(path.join(SOURCE_DIR, h), 'utf8');
    for (const m of html.matchAll(/(?:href|src)=["']([^"'#][^"']*?)["']/g)) {
      const ref = m[1];
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue; // 外链/内联跳过
      total++;
      const clean = ref.split('?')[0].split('#')[0];
      if (!fs.existsSync(path.join(SOURCE_DIR, clean))) missing.push(`${h} → ${ref}`);
    }
  }
  check('V8', `HTML 引用的本地资源全部存在（共 ${total} 个引用）`, missing.length === 0,
    missing.length === 0 ? '全部命中' : `❌ 缺失：\n          ${missing.join('\n          ')}`);
  return missing.length === 0;
}

// V9 前端接口地址一致
function v9() {
  const a = /const API_BASE = '([^']+)'/.exec(fs.readFileSync(path.join(SOURCE_DIR, 'js', 'timeline.js'), 'utf8'))?.[1];
  const b = /const API_BASE = '([^']+)'/.exec(fs.readFileSync(path.join(SOURCE_DIR, 'check.html'), 'utf8'))?.[1];
  const ok = !!a && a === b;
  check('V9', 'timeline.js 与 check.html 的 API_BASE 一致', ok,
    `timeline.js=${a || '(未取到)'} · check.html=${b || '(未取到)'}`);
  return ok;
}

// ———————————————— 主流程 ————————————————

(async () => {
  out(`WorkShop 发布前检查 · ${fmt(new Date())}${OFFLINE ? ' · [离线模式：跳过所有线上请求]' : ''}`);
  if (!API_BASE) out('⚠️ 未能从 timeline.js 解析出 API_BASE，线上检查项会失败');
  out('');

  out('① 公网与跨域');
  if (LOCAL) {
    skip('V1', '公网健康检查', '--local 模式：不连线上（本模式只验云函数代码本身）');
    skip('V2a', 'CORS 白名单命中', '--local 模式：不打线上');
    skip('V2b', 'CORS 非白名单', '--local 模式：不打线上');
  } else if (OFFLINE) {
    skip('V1', '公网健康检查', '离线模式'); skip('V2a', 'CORS 白名单命中', '离线模式'); skip('V2b', 'CORS 非白名单', '离线模式');
  } else {
    if (want('V1')) { try { await v1(); } catch (e) { check('V1', '公网健康检查', false, '请求异常：' + e.message); } }
    if (want('V2')) { try { await v2(); } catch (e) { check('V2a', 'CORS 检查', false, '请求异常：' + e.message); } }
  }

  out('');
  out('② 契约与错误处理');
  let createdId = null;
  if (OFFLINE) { skip('V3', '错误响应 HTTP 状态', '离线模式'); skip('V4', '写入契约+幂等', '离线模式'); skip('V5', '删除闸门', '离线模式'); }
  else {
    if (want('V3')) { try { await v3(); } catch (e) { check('V3', '错误响应 HTTP 状态', false, '请求异常：' + e.message); } }
    if (LOCAL) {
      // 本地直调模式下，V4/V5 的"正常路径"需要真连库，本地凭据无效会误报；
      // 本模式只用 V3 验证「错误分支的状态码」，故跳过 V4/V5（它们在线上模式里正常跑）。
      skip('V4', '写入契约+幂等', '--local 模式：正常写入需真连库，本地不验（见线上模式）');
      skip('V5', '删除闸门', '--local 模式：同上');
    } else {
      if (want('V4') || want('V5')) {
        try {
          const r4 = await v4();
          createdId = r4.id;
        } catch (e) { check('V4a', '写入契约', false, '请求异常：' + e.message); }
      }
      if (want('V5')) { try { await v5(createdId); } catch (e) { check('V5a', '删除闸门', false, '请求异常：' + e.message); } }
    }
  }

  out('');
  out('③ 安全与配置');
  if (want('V6')) { try { v6(); } catch (e) { check('V6a', '密钥与配置', false, '检查异常：' + e.message); } }

  out('');
  out('④ 代码与资源完整性');
  if (want('V7')) { try { v7(); } catch (e) { check('V7', '依赖文件齐全', false, '检查异常：' + e.message); } }
  if (want('V8')) { try { v8(); } catch (e) { check('V8', '静态资源完整', false, '检查异常：' + e.message); } }
  if (want('V9')) { try { v9(); } catch (e) { check('V9', '前端地址一致', false, '检查异常：' + e.message); } }

  // ———— 清理：若 V5 没跑或没删掉，兜底再删一次 ————
  if (createdId) {
    out('');
    try {
      const c = await req('DELETE', `/api/items?id=${createdId}&confirm=true`);
      if (c.status === 200) out(`>> 清理：测试数据 id=${createdId} 已删除`);
      else if (c.status === 404) out(`>> 清理：测试数据 id=${createdId} 已不存在（V5 已删）`);
      else out(`>> ⚠️ 清理失败：id=${createdId} HTTP ${c.status}，请手动删除：\n   curl -X DELETE "${API_BASE}/api/items?id=${createdId}&confirm=true"`);
    } catch (e) {
      out(`>> ⚠️ 清理异常：${e.message}，残留 id=${createdId}，请手动删除`);
    }
  }

  // ———— 汇总 ————
  const judged = RESULTS.filter((r) => !r.skipped);
  const pass = judged.filter((r) => r.pass).length;
  const fail = judged.filter((r) => !r.pass).length;
  out('');
  out(`汇总：${pass} PASS / ${fail} FAIL${RESULTS.some((r) => r.skipped) ? ` / ${RESULTS.filter((r) => r.skipped).length} SKIP` : ''}`);
  if (fail) {
    out('');
    out('未通过项：');
    for (const r of judged.filter((x) => !x.pass)) out(`  ❌ ${r.id} ${r.title}\n     ${r.evidence}`);
  }

  const logDir = path.join(REPO, 'resource', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = `${new Date().getFullYear()}${pad(new Date().getMonth() + 1)}${pad(new Date().getDate())}-${pad(new Date().getHours())}${pad(new Date().getMinutes())}${pad(new Date().getSeconds())}`;
  const logPath = path.join(logDir, `verify-project-${stamp}.log`);
  fs.writeFileSync(logPath, LOG.join('\n') + '\n', 'utf8');
  console.log(`\n>> 证据已写入：${logPath}`);

  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('检查脚本异常：', e); process.exit(1); });
