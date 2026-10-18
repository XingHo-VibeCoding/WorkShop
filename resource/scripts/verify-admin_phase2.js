#!/usr/bin/env node
// WorkShop · 阶段二 管理员 UI + 在线人数 · 验收脚本（2026-10-18）
// ---------------------------------------------------------------------------
// 两部分：
//   A 离线单测（总是跑、不联网）：
//      A1 ACL admin 全矩阵（decideWrite，seam C 第 2 项「管理员可改他人日程」）
//      A2 db.js 三函数 mock-fetch 测试（touchMember / countOnline / updateMemberRole）
//         —— 重点盯「PATCH 必须带 id=eq.」：不带条件 = 整表更新/整表改角色（Day 22 同款灾难）
//   B 线上行为校验（仅 --live 时跑，需联网 + 凭据）：
//      setRole 四类越权（401/403×2/400/404）+ admin 正常改 + 心跳有/无令牌
//
// 用法：
//   node resource/scripts/verify-admin_phase2.js            # 只跑离线单测
//   node resource/scripts/verify-admin_phase2.js --live     # 再加线上校验
//
// 线上校验所需环境变量（--live 时）：
//   WORKSHOP_ADMIN_NAME/PASS   一名 role=admin 的成员（库中已有，口令用户掌握）
//   WORKSHOP_TEST_MEMBER/PASS  一名 role=member 的测试成员（验 403 越权用）
//   WORKSHOP_RO_MEMBER/PASS    一名 role=readonly 的测试成员（验 403 越权用）
//
// 退出码：0 全部通过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const path = require('path');

let pass = 0, fail = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` → ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ===================== A1. 离线 ACL 单测（admin 全矩阵） =====================
function runAclOffline() {
  console.log('\n──────── A1. 离线 ACL 单测（admin 矩阵，seam C 第 2 项） ────────');
  const acl = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'acl_phase2.js'));
  const admin = { mid: 3, role: 'admin' };
  const member = { mid: 1, role: 'member' };
  const readonly = { mid: 2, role: 'readonly' };

  // admin 全放行：create（自己/代他人）
  let d = acl.decideWrite(admin, { op: 'create', targetOwnerId: null });
  check('admin create 自己 → 放行', d.ok && d.ownerMemberId === 3, JSON.stringify(d));
  d = acl.decideWrite(admin, { op: 'create', targetOwnerId: 99 });
  check('admin create 代他人 → 放行且 placeFor', d.ok && d.ownerMemberId === 99 && d.placeFor === true, JSON.stringify(d));

  // admin 全放行：patch/delete（自己/他人/legacy 无归属）
  d = acl.decideWrite(admin, { op: 'patch', item: { ownerMemberId: 3 } });
  check('admin 改自己的项 → 放行', d.ok, JSON.stringify(d));
  d = acl.decideWrite(admin, { op: 'patch', item: { ownerMemberId: 1 } });
  check('admin 改他人的项 → 放行（seam C 第 2 项已明示）', d.ok, JSON.stringify(d));
  d = acl.decideWrite(admin, { op: 'delete', item: { ownerMemberId: 1 } });
  check('admin 删他人的项 → 放行（seam C 第 2 项已明示）', d.ok, JSON.stringify(d));
  d = acl.decideWrite(admin, { op: 'patch', item: { ownerMemberId: null } });
  check('admin 改 legacy 无归属项 → 放行(兼容)', d.ok, JSON.stringify(d));

  // 回归：member/readonly 行为不能被 admin 明示改动破坏（P9 已验收口径）
  d = acl.decideWrite(member, { op: 'patch', item: { ownerMemberId: 5 } });
  check('回归：member 改他人项仍 403', !d.ok && d.code === 403, JSON.stringify(d));
  d = acl.decideWrite(readonly, { op: 'create', targetOwnerId: null });
  check('回归：readonly 任何写仍 403', !d.ok && d.code === 403, JSON.stringify(d));
}

// ===================== A2. db.js 三函数 mock-fetch 测试 =====================
function runDbOffline() {
  console.log('\n──────── A2. db.js 三函数 mock 测试（心跳 / 在线数 / 改角色） ────────');
  process.env.CB_API_KEY = 'test-key-not-real';   // 让 getBearer 直接返回它，不走匿名登录
  const db = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'db.js'));

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const prefer = (opts && opts.headers && opts.headers.Prefer) || '';
    calls.push({ u, method, body, prefer });
    // members_phase2 PATCH + body 只有 last_seen_at → touchMember
    if (u.includes('members_phase2') && method === 'PATCH' && body && body.last_seen_at && !body.role) {
      return { ok: true, status: 200, text: async () => '' };
    }
    // members_phase2 PATCH + body.role → updateMemberRole（回传代表行）
    if (u.includes('members_phase2') && method === 'PATCH' && body && body.role) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 7, display_name: '测试乙', role: body.role }]) };
    }
    // members_phase2 GET → countOnline / listMembers 类
    if (u.includes('members_phase2') && method === 'GET') {
      const rows = u.includes('last_seen_at') ? [{ id: 1 }, { id: 2 }, { id: 3 }] : [];
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }
    return { ok: false, status: 500, text: async () => 'mock: 未覆盖的请求 ' + method + ' ' + u };
  };

  return (async () => {
    try {
      // —— touchMember ——
      calls.length = 0;
      await db.touchMember(7);
      const tc = calls[0];
      check('touchMember 命中 members_phase2', !!tc && tc.u.includes('members_phase2'), tc && tc.u);
      check('touchMember 用 PATCH', !!tc && tc.method === 'PATCH', tc && tc.method);
      check('touchMember ★带 id=eq. 过滤（防整表更新）', !!tc && tc.u.includes('id=eq.7'), tc && tc.u);
      check('touchMember body 是 ISO 时间戳', !!tc && tc.body && /^\d{4}-\d{2}-\d{2}T/.test(tc.body.last_seen_at), tc && JSON.stringify(tc.body));

      // —— countOnline ——
      calls.length = 0;
      const n = await db.countOnline(2);
      const cc = calls[0];
      check('countOnline 返回行数 3', n === 3, String(n));
      check('countOnline 带 last_seen_at=gte. 窗口', !!cc && cc.u.includes('last_seen_at=gte.'), cc && cc.u);
      check('countOnline select 只取 id', !!cc && cc.u.includes('select=id'), cc && cc.u);
      // 窗口换算：gte 的时间戳应约等于 now-120s（容差 5s）
      const m = /last_seen_at=gte\.([^&]+)/.exec(cc.u || '');
      const since = m ? decodeURIComponent(m[1]) : '';
      const expect = Date.now() - 120 * 1000;
      const actual = Date.parse(since);
      check('countOnline 窗口换算正确（now-2min，容差5s）', Math.abs(actual - expect) < 5000, `since=${since}`);

      // —— updateMemberRole ——
      calls.length = 0;
      const r = await db.updateMemberRole(7, 'readonly');
      const uc = calls[0];
      check('updateMemberRole 返回 member 映射', !!r.member && r.member.id === 7 && r.member.role === 'readonly' && r.member.displayName === '测试乙', JSON.stringify(r));
      check('updateMemberRole ★带 id=eq. 过滤（防整表改角色）', !!uc && uc.u.includes('id=eq.7'), uc && uc.u);
      check('updateMemberRole body.role 正确', !!uc && uc.body && uc.body.role === 'readonly', uc && JSON.stringify(uc.body));

      // —— updateMemberRole：0 行命中 → notFound ——
      global.fetch = async (url, opts) => {
        if (String(url).includes('members_phase2') && (opts && opts.method) === 'PATCH') {
          return { ok: true, status: 200, text: async () => '[]' };   // 影响 0 行
        }
        return { ok: false, status: 500, text: async () => 'mock: unexpected' };
      };
      const r2 = await db.updateMemberRole(999, 'admin');
      check('updateMemberRole 0 行命中 → notFound', r2.notFound === true, JSON.stringify(r2));

      // —— updateMemberRole：非法 mid 不发起请求（短路） ——
      calls.length = 0;
      global.fetch = async () => { throw new Error('不该被调用'); };
      const r3 = await db.updateMemberRole(-1, 'admin');
      check('updateMemberRole 非法 mid 短路不发请求', r3.notFound === true && calls.length === 0, JSON.stringify(r3));
    } catch (e) {
      check('A2 执行过程无异常', false, e && e.message);
    } finally {
      global.fetch = realFetch;
    }
  })();
}

// ===================== A3. index.js 控制流测试（setRole / heartbeat 越权分支） =====================
// 直打 exports.main(event)：db 层方法打桩（CommonJS 模块对象共享，覆盖即生效），
// 令牌用 identity.signToken 真签（WORKSHOP_AUTH_SECRET 设为测试值）。
// 覆盖：401/403×2/400/404 越权分支 + admin 正常改 + audit 留痕 + 心跳三种令牌态。
function runFlowOffline() {
  console.log('\n──────── A3. index.js 控制流测试（setRole / heartbeat） ────────');
  process.env.WORKSHOP_AUTH_SECRET = 'offline-test-secret-not-real'; // 必须先于 require identity/index
  process.env.CB_API_KEY = 'test-key-not-real';
  const identity = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'identity_phase2.js'));
  const idx = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'index.js'));
  const db = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'db.js'));

  const token = (role, id) => identity.signToken({ id, display_name: '测试-' + role, role });
  const evt = (action, body, tok) => ({
    httpMethod: 'POST',
    queryString: { _action: action },
    headers: tok ? { 'X-Member-Token': tok } : {},
    body: JSON.stringify(body || {}),
  });
  const bodyOf = (r) => { try { return JSON.parse(r.body || '{}'); } catch (_) { return {}; } };

  // —— db 打桩 ——
  let auditCalls = [];
  let touched = [];
  db.findMemberById = async (id) => (Number(id) === 7 ? { id: 7, displayName: '测试乙', role: 'member' } : null);
  db.updateMemberRole = async (id, role) => ({ member: { id, displayName: '测试乙', role } });
  db.insertAudit = async (row) => { auditCalls.push(row); };
  db.touchMember = async (mid) => { touched.push(mid); };
  db.countOnline = async () => 5;

  return (async () => {
    const adminTok = token('admin', 3);
    const memberTok = token('member', 1);

    // —— setRole 越权分支 ——
    let r = await idx.main(evt('setrole', { memberId: 7, role: 'readonly' }));
    check('setRole 无令牌 → 401', r.statusCode === 401, `status=${r.statusCode}`);

    r = await idx.main(evt('setrole', { memberId: 3, role: 'readonly' }, memberTok));
    check('setRole member 令牌 → 403', r.statusCode === 403, `status=${r.statusCode}`);

    r = await idx.main(evt('setrole', { memberId: 3, role: 'readonly' }, adminTok));
    check('setRole admin 改自己 → 403', r.statusCode === 403, `status=${r.statusCode}`);

    r = await idx.main(evt('setrole', { memberId: 7, role: 'boss' }, adminTok));
    check('setRole 非法角色 → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('setrole', { memberId: 'abc', role: 'member' }, adminTok));
    check('setRole 非法 memberId → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('setrole', { memberId: 999, role: 'member' }, adminTok));
    check('setRole 不存在成员 → 404', r.statusCode === 404, `status=${r.statusCode}`);

    // —— admin 正常改 + 留痕 ——
    auditCalls = [];
    r = await idx.main(evt('setrole', { memberId: 7, role: 'readonly' }, adminTok));
    let b = bodyOf(r);
    check('setRole admin 正常改 → 200 且 role=readonly', r.statusCode === 200 && b.ok && b.data && b.data.role === 'readonly', `status=${r.statusCode}`);
    check('setRole 留痕 set_role（actor/target/detail from→to）',
      auditCalls.length === 1 && auditCalls[0].action === 'set_role' && auditCalls[0].actorId === 3
      && auditCalls[0].targetId === 7 && /member → readonly/.test(auditCalls[0].detail || ''),
      JSON.stringify(auditCalls));

    // —— 心跳三种令牌态 ——
    touched = [];
    r = await idx.main(evt('heartbeat', {}));
    b = bodyOf(r);
    check('heartbeat 无令牌 → 200 + online 数字', r.statusCode === 200 && typeof b.data.online === 'number', `status=${r.statusCode}`);
    check('heartbeat 无令牌不记心跳（匿名不计入）', touched.length === 0, JSON.stringify(touched));

    touched = [];
    r = await idx.main(evt('heartbeat', {}, memberTok));
    b = bodyOf(r);
    check('heartbeat 带令牌 → 200 + touch(mid)', r.statusCode === 200 && touched.length === 1 && touched[0] === 1, JSON.stringify(touched));

    touched = [];
    r = await idx.main(evt('heartbeat', {}, 'bad.token.sig'));
    check('heartbeat 坏令牌 → 200 且不 touch（不误判登录失效）', r.statusCode === 200 && touched.length === 0, `status=${r.statusCode}`);
  })();
}

// ===================== B. 线上行为校验 =====================
async function runLive() {
  console.log('\n──────── B. 线上行为校验（--live） ────────');
  const BASE = process.env.WORKSHOP_API_BASE ||
    'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';
  const adminName = process.env.WORKSHOP_ADMIN_NAME;
  const adminPass = process.env.WORKSHOP_ADMIN_PASS;
  const testMember = process.env.WORKSHOP_TEST_MEMBER;
  const testPass = process.env.WORKSHOP_TEST_PASS;
  const roMember = process.env.WORKSHOP_RO_MEMBER;
  const roPass = process.env.WORKSHOP_RO_PASS;

  if (!adminName || !adminPass) {
    console.log('  ⚠️ 跳过线上校验：缺少 WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS');
    console.log(`\n通过 ${pass} · 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
    return;
  }

  async function req(method, action, body, token) {
    const url = new URL(`${BASE}/api/items`);
    if (action) url.searchParams.set('_action', action);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Member-Token'] = token;
    const r = await fetch(url.toString(), {
      method,
      headers,
      body: (method !== 'GET' && method !== 'DELETE') ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, j };
  }
  async function login(name, passcode) {
    const { status, j } = await req('POST', 'login', { name, passcode });
    if (status !== 200 || !j || !j.ok) throw new Error(`登录失败 ${name}：${status} ${j && j.error && j.error.message}`);
    return { token: j.data.token, member: j.data.member };
  }

  try {
    const admin = await login(adminName, adminPass);
    check('admin 登录成功', !!admin.token);

    // —— 心跳：无令牌也 200 且带回 online ——
    const hb0 = await req('POST', 'heartbeat', {});
    check('心跳（无令牌）→ 200 且 online 是数字', hb0.status === 200 && hb0.j && typeof hb0.j.data.online === 'number', `status=${hb0.status}`);
    // —— 心跳：带令牌（刷新自己 + 回在线数） ——
    const hb1 = await req('POST', 'heartbeat', {}, admin.token);
    check('心跳（带令牌）→ 200 且 online 是数字', hb1.status === 200 && hb1.j && typeof hb1.j.data.online === 'number', `status=${hb1.status}`);

    // —— setRole 四类越权 ——
    const noTok = await req('POST', 'setrole', { memberId: 1, role: 'readonly' });
    check('setRole 无令牌 → 401', noTok.status === 401, `status=${noTok.status} msg=${(noTok.j && noTok.j.error && noTok.j.error.message) || ''}`);

    const self = await req('POST', 'setrole', { memberId: admin.member.id, role: 'readonly' }, admin.token);
    check('setRole 改自己 → 403', self.status === 403, `status=${self.status} msg=${(self.j && self.j.error && self.j.error.message) || ''}`);

    const bad = await req('POST', 'setrole', { memberId: 1, role: 'superuser' }, admin.token);
    check('setRole 非法角色 → 400', bad.status === 400, `status=${bad.status} msg=${(bad.j && bad.j.error && bad.j.error.message) || ''}`);

    const ghost = await req('POST', 'setrole', { memberId: 999999, role: 'readonly' }, admin.token);
    check('setRole 不存在成员 → 404', ghost.status === 404, `status=${ghost.status} msg=${(ghost.j && ghost.j.error && ghost.j.error.message) || ''}`);

    if (testMember && testPass) {
      const m = await login(testMember, testPass);
      const mTry = await req('POST', 'setrole', { memberId: admin.member.id, role: 'readonly' }, m.token);
      check('setRole member（非 admin）→ 403', mTry.status === 403, `status=${mTry.status} msg=${(mTry.j && mTry.j.error && mTry.j.error.message) || ''}`);

      // —— admin 正常改：把测试成员改 readonly 再改回 member（自清理） ——
      const toRo = await req('POST', 'setrole', { memberId: m.member.id, role: 'readonly' }, admin.token);
      check('admin 改测试成员为 readonly → 200 且 role=readonly', toRo.status === 200 && toRo.j && toRo.j.data.role === 'readonly', `status=${toRo.status} role=${(toRo.j && toRo.j.data && toRo.j.data.role)}`);
      const back = await req('POST', 'setrole', { memberId: m.member.id, role: 'member' }, admin.token);
      check('admin 改回 member → 200（自清理）', back.status === 200 && back.j && back.j.data.role === 'member', `status=${back.status}`);
    } else {
      console.log('  ⚠️ 跳过 member 越权/正常改校验：缺少 WORKSHOP_TEST_MEMBER / WORKSHOP_TEST_PASS');
    }

    if (roMember && roPass) {
      const ro = await login(roMember, roPass);
      const roTry = await req('POST', 'setrole', { memberId: admin.member.id, role: 'member' }, ro.token);
      check('setRole readonly → 403', roTry.status === 403, `status=${roTry.status}`);
    } else {
      console.log('  ⚠️ 跳过 readonly 越权校验：缺少 WORKSHOP_RO_MEMBER / WORKSHOP_RO_PASS');
    }
  } catch (e) {
    console.log('\n❌ 线上校验异常：', e.message); fail++;
  }

  console.log(`\n──────── 总结 ────────`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
}

(async () => {
  runAclOffline();
  await runDbOffline();
  await runFlowOffline();
  console.log(`\n──────── 总结 ────────`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  if (process.argv.includes('--live')) { await runLive(); }
  else process.exit(fail ? 1 : 0);
})();
