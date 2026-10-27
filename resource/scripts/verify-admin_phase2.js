#!/usr/bin/env node
// WorkShop · 阶段二 管理员 UI + 在线人数 + 口令体系 · 验收脚本（2026-10-18 建，2026-10-23 扩军）
// ---------------------------------------------------------------------------
// 两部分：
//   A 离线单测（总是跑、不联网）：
//      A1 ACL admin 全矩阵（decideWrite，seam C 第 2 项「管理员可改他人日程」）
//      A2 db.js mock-fetch 测试（touchMember / countOnline / updateMemberRole /
//         findMemberCredentialsById / updateMemberPasscode / insertMemberWithAuth）
//         —— 重点盯「PATCH 必须带 id=eq.」：不带条件 = 整表更新/整表改口令（Day 22 同款灾难）
//      A3 index.js 控制流测试（setRole / heartbeat / resetPasscode / changePasscode / addMember）
//   B 线上行为校验（仅 --live 时跑，需联网 + 凭据）
//
// 用法：
//   node resource/scripts/verify-admin_phase2.js            # 只跑离线单测
//   node resource/scripts/verify-admin_phase2.js --live     # 再加线上校验
//
// 线上校验所需环境变量（--live 时）：
//   WORKSHOP_ADMIN_NAME/PASS   一名 role=admin 的成员（库中已有，口令用户掌握）
//   WORKSHOP_TEST_MEMBER/PASS  一名 role=member 的测试成员（验 403 越权用）
//                                 ★ 注意变量名是 TEST_PASS，不是 TEST_MEMBER_PASS
//   WORKSHOP_RO_MEMBER/PASS    一名 role=readonly 的测试成员（验 403 越权用）
//                                 ★ 变量名是 RO_PASS
//
// 退出码：0 全部通过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const path = require('path');

let pass = 0, fail = 0;
// 【多团队】测试用团队 id（db 层已强制要求，缺了就抛错）
const TEAM = 1;
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
      const n = await db.countOnline(2, TEAM);
      const cc = calls[0];
      check('countOnline 返回行数 3', n === 3, String(n));
      check('countOnline 带 last_seen_at=gte. 窗口', !!cc && cc.u.includes('last_seen_at=gte.'), cc && cc.u);
      check('countOnline select 只取 id', !!cc && cc.u.includes('select=id'), cc && cc.u);
      check('countOnline ★带 team_id 过滤（在线数按团队统计）', !!cc && cc.u.includes('team_id=eq.' + TEAM), cc && cc.u);
      // 窗口换算：gte 的时间戳应约等于 now-120s（容差 5s）
      const m = /last_seen_at=gte\.([^&]+)/.exec(cc.u || '');
      const since = m ? decodeURIComponent(m[1]) : '';
      const expect = Date.now() - 120 * 1000;
      const actual = Date.parse(since);
      check('countOnline 窗口换算正确（now-2min，容差5s）', Math.abs(actual - expect) < 5000, `since=${since}`);

      // —— updateMemberRole ——
      calls.length = 0;
      const r = await db.updateMemberRole(7, 'readonly', TEAM);
      const uc = calls[0];
      check('updateMemberRole 返回 member 映射', !!r.member && r.member.id === 7 && r.member.role === 'readonly' && r.member.displayName === '测试乙', JSON.stringify(r));
      check('updateMemberRole ★带 id=eq. 过滤（防整表改角色）', !!uc && uc.u.includes('id=eq.7'), uc && uc.u);
      check('updateMemberRole body.role 正确', !!uc && uc.body && uc.body.role === 'readonly', uc && JSON.stringify(uc.body));
      check('updateMemberRole ★带 team_id 过滤（管理员只能改本团队）', !!uc && uc.u.includes('team_id=eq.' + TEAM), uc && uc.u);

      // —— updateMemberRole：0 行命中 → notFound ——
      global.fetch = async (url, opts) => {
        if (String(url).includes('members_phase2') && (opts && opts.method) === 'PATCH') {
          return { ok: true, status: 200, text: async () => '[]' };   // 影响 0 行
        }
        return { ok: false, status: 500, text: async () => 'mock: unexpected' };
      };
      const r2 = await db.updateMemberRole(999, 'admin', TEAM);
      check('updateMemberRole 0 行命中 → notFound', r2.notFound === true, JSON.stringify(r2));

      // —— updateMemberRole：非法 mid 不发起请求（短路） ——
      calls.length = 0;
      global.fetch = async () => { throw new Error('不该被调用'); };
      const r3 = await db.updateMemberRole(-1, 'admin');
      check('updateMemberRole 非法 mid 短路不发请求', r3.notFound === true && calls.length === 0, JSON.stringify(r3));

      // ============ 【2026-10-27 多团队】隔离硬约束：缺 teamId 必须抛错 ============
      // 这是本次改动最重要的一条不变量：漏传团队时宁可 500，也绝不能静默返回全库。
      {
        const cases = [
          ['queryItems 缺 teamId', () => db.queryItems({})],
          ['findItemById 缺 teamId', () => db.findItemById(1)],
          ['updateItem 缺 teamId', () => db.updateItem(1, { title: 'x' }, null)],
          ['deleteItem 缺 teamId', () => db.deleteItem(1)],
          ['listMembers 缺 teamId', () => db.listMembers()],
          ['countOnline 缺 teamId', () => db.countOnline(2)],
          ['updateMemberRole 缺 teamId', () => db.updateMemberRole(7, 'admin')],
          ['findDuplicate 缺 teamId', () => db.findDuplicate({ title: 't', table: 'work', type: 'meeting', start: 'a', end: 'b', ownerKey: 'self' })],
          ['insertMemberWithAuth 缺 teamId', () => db.insertMemberWithAuth({ displayName: 'x', role: 'member', identityKey: 'k', salt: 's' })],
        ];
        global.fetch = async () => { throw new Error('缺 teamId 时不该发起任何请求'); };
        for (const [label, fn] of cases) {
          let threw = null;
          try { await fn(); } catch (e) { threw = e; }
          check(label + ' → 抛错（不静默查全库）', !!threw && /teamId/.test(String(threw.message)), threw ? threw.message : '未抛错');
        }
        // 非法值同样拒绝
        let bad = null;
        try { await db.queryItems({}, 0); } catch (e) { bad = e; }
        check('teamId=0 → 抛错', !!bad, bad ? bad.message : '未抛错');
        bad = null;
        try { await db.listMembers('abc'); } catch (e) { bad = e; }
        check('teamId 非数字 → 抛错', !!bad, bad ? bad.message : '未抛错');
      }

      // ===================== Step5 口令体系：db 三新函数 =====================
      // 换一版更精细的 mock（按 URL 特征分流，避免与上面的场景串味）
      global.fetch = async (url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || 'GET';
        let parsed = null;
        if (opts && opts.body) {
          parsed = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
        }
        const body = Array.isArray(parsed) ? parsed[0] : parsed;   // 插入类 body 是 [row] 数组
        calls.push({ u, method, body });
        // ① 查凭据：GET + select 含 salt,identity_key
        if (u.includes('members_phase2') && method === 'GET' && u.includes('identity_key')) {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1, display_name: '测试-member', role: 'member', salt: 'a'.repeat(32), identity_key: 'b'.repeat(128), auth_kind: 'passcode' }]) };
        }
        // ② 改口令：PATCH + body 有 identity_key（没有 role / last_seen_at）
        if (u.includes('members_phase2') && method === 'PATCH' && body && body.identity_key) {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1, display_name: '测试-member', role: 'member' }]) };
        }
        // ③ 添加成员：POST + body 是数组
        if (u.includes('members_phase2') && method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 9, display_name: body.display_name, role: body.role }]) };
        }
        return { ok: false, status: 500, text: async () => 'mock: 未覆盖的请求 ' + method + ' ' + u };
      };

      // —— findMemberCredentialsById ——
      calls.length = 0;
      const cred = await db.findMemberCredentialsById(1);
      const gc = calls[0];
      check('findMemberCredentialsById 返回盐+哈希', !!cred && cred.salt === 'a'.repeat(32) && cred.identity_key === 'b'.repeat(128), JSON.stringify(cred));
      check('findMemberCredentialsById ★带 id=eq. 过滤', !!gc && gc.u.includes('id=eq.1'), gc && gc.u);
      check('findMemberCredentialsById 限定 auth_kind=passcode', !!gc && gc.u.includes('auth_kind=eq.passcode'), gc && gc.u);
      const cred0 = await db.findMemberCredentialsById(0);
      check('findMemberCredentialsById 非法 id 返回 null 不发请求', cred0 === null, JSON.stringify(cred0));

      // —— updateMemberPasscode ——
      calls.length = 0;
      const up = await db.updateMemberPasscode(1, 'c'.repeat(128), 'd'.repeat(32));
      const pc = calls[0];
      check('updateMemberPasscode 返回 member 映射', !!up.member && up.member.id === 1, JSON.stringify(up));
      check('updateMemberPasscode ★带 id=eq. 过滤（防全库统一口令）', !!pc && pc.u.includes('id=eq.1'), pc && pc.u);
      check('updateMemberPasscode body 含新盐+新哈希', !!pc && pc.body && pc.body.identity_key === 'c'.repeat(128) && pc.body.salt === 'd'.repeat(32), pc && JSON.stringify(pc.body));

      global.fetch = async (url, opts) => {
        if (String(url).includes('members_phase2') && (opts && opts.method) === 'PATCH') {
          return { ok: true, status: 200, text: async () => '[]' };   // 影响 0 行
        }
        return { ok: false, status: 500, text: async () => 'mock: unexpected' };
      };
      const up0 = await db.updateMemberPasscode(999, 'c'.repeat(128), 'd'.repeat(32));
      check('updateMemberPasscode 0 行命中 → notFound', up0.notFound === true, JSON.stringify(up0));

      // —— insertMemberWithAuth ——
      global.fetch = async (url, opts) => {
        calls.push({ u: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) ? JSON.parse(opts.body)[0] : null });
        if (String(url).includes('members_phase2') && (opts && opts.method) === 'POST') {
          const row = JSON.parse(opts.body)[0];
          return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 9, display_name: row.display_name, role: row.role }]) };
        }
        return { ok: false, status: 500, text: async () => 'mock: unexpected' };
      };
      calls.length = 0;
      const ins = await db.insertMemberWithAuth({ displayName: '新成员', role: 'readonly', identityKey: 'e'.repeat(128), salt: 'f'.repeat(32), teamId: TEAM });
      const ic = calls[0];
      check('insertMemberWithAuth 返回新成员映射', !!ins.member && ins.member.id === 9 && ins.member.role === 'readonly', JSON.stringify(ins));
      check('insertMemberWithAuth 用 POST + auth_kind=passcode', !!ic && ic.method === 'POST' && ic.body && ic.body.auth_kind === 'passcode', ic && JSON.stringify(ic.body));
      check('insertMemberWithAuth 空名字直接 error 不发请求', (await (async () => {
        calls.length = 0;
        const bad = await db.insertMemberWithAuth({ displayName: '  ', role: 'member', identityKey: 'x', salt: 'y', teamId: TEAM });
        return bad.error && calls.length === 0;
      })()) === true);
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

  // 【多团队】令牌带 team_id：这样 resolveActor 无需回查库补齐团队
  const token = (role, id) => identity.signToken({ id, display_name: '测试-' + role, role, team_id: TEAM });
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
  db.findMemberById = async (id) => (Number(id) === 7 ? { id: 7, displayName: '测试乙', role: 'member', teamId: TEAM } : null);
  db.updateMemberRole = async (id, role) => ({ member: { id, displayName: '测试乙', role } });
  db.insertAudit = async (row) => { auditCalls.push(row); };
  db.touchMember = async (mid) => { touched.push(mid); };
  db.countOnline = async () => 5;
  // 【多团队】团队表打桩：默认团队解析、注册、建团队都靠它
  db.findTeamByJoinCode = async (code) => (String(code).toUpperCase() === 'WS-DEFAULT'
    ? { id: TEAM, name: '默认团队', joinCode: 'WS-DEFAULT' }
    : (String(code).toUpperCase() === 'WS-NEW1' ? { id: 2, name: '新团队', joinCode: 'WS-NEW1' } : null));
  db.findTeamById = async (id) => (Number(id) === TEAM ? { id: TEAM, name: '默认团队', joinCode: 'WS-DEFAULT' } : null);
  db.countTeamMembers = async () => 3;
  db.createTeam = async ({ name, joinCode }) => ({ team: { id: 9, name, joinCode } });

  // —— Step5 打桩（口令体系三端点）——
  const SALT_OLD = 'ab'.repeat(16);                    // 32 字符 hex
  const HASH_OLD = identity.hashPasscode('oldpass123', SALT_OLD);   // 真哈希，让旧口令校验真跑
  db.findMemberCredentialsById = async (id) => (Number(id) === 1
    ? { id: 1, display_name: '测试-member', role: 'member', salt: SALT_OLD, identity_key: HASH_OLD, auth_kind: 'passcode' }
    : null);
  db.updateMemberPasscode = async (id, key, salt) => ({ member: { id, displayName: '测试-member', role: 'member' } });
  db.insertMemberWithAuth = async (row) => ({ member: { id: 9, displayName: row.displayName, role: row.role } });
  // 【多团队】新契约：返回【数组】（可能 0/1/多行，多行 = 跨团队重名）
  db.findMemberByName = async (name) => (String(name) === '已存在' ? [{ id: 5, display_name: '已存在', team_id: TEAM }] : []);

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

    // ===================== Step5：resetPasscode =====================
    console.log('\n──────── A3b. 控制流测试（resetPasscode / changePasscode / addMember） ────────');
    r = await idx.main(evt('resetpasscode', { memberId: 7 }));
    check('resetPasscode 无令牌 → 401', r.statusCode === 401, `status=${r.statusCode}`);

    r = await idx.main(evt('resetpasscode', { memberId: 7 }, memberTok));
    check('resetPasscode member 令牌 → 403', r.statusCode === 403, `status=${r.statusCode}`);

    r = await idx.main(evt('resetpasscode', { memberId: 'abc' }, adminTok));
    check('resetPasscode 非法 memberId → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('resetpasscode', { memberId: 999 }, adminTok));
    check('resetPasscode 不存在成员 → 404', r.statusCode === 404, `status=${r.statusCode}`);

    auditCalls = [];
    r = await idx.main(evt('resetpasscode', { memberId: 7 }, adminTok));
    b = bodyOf(r);
    check('resetPasscode admin 正常 → 200 且回 8 位口令', r.statusCode === 200 && b.ok && b.data && /^[A-HJ-NP-Z2-9]{8}$/.test(b.data.passcode || ''), `status=${r.statusCode} pass=${b.data && b.data.passcode}`);
    check('resetPasscode 留痕 reset_passcode（actor/target 对，且 detail 不含口令明文）',
      auditCalls.length === 1 && auditCalls[0].action === 'reset_passcode' && auditCalls[0].actorId === 3 && auditCalls[0].targetId === 7
      && !(auditCalls[0].detail || '').includes(b.data && b.data.passcode),
      JSON.stringify(auditCalls));

    // ===================== Step5：changePasscode =====================
    r = await idx.main(evt('changepasscode', { oldPasscode: 'oldpass123', newPasscode: 'newpass123' }));
    check('changePasscode 无令牌 → 401', r.statusCode === 401, `status=${r.statusCode}`);

    r = await idx.main(evt('changepasscode', { newPasscode: 'newpass123' }, memberTok));
    check('changePasscode 缺旧口令 → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('changepasscode', { oldPasscode: 'oldpass123', newPasscode: '123' }, memberTok));
    check('changePasscode 新口令太短 → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('changepasscode', { oldPasscode: 'oldpass123', newPasscode: 'oldpass123' }, memberTok));
    check('changePasscode 新旧相同 → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('changepasscode', { oldPasscode: 'wrongone', newPasscode: 'newpass123' }, memberTok));
    check('changePasscode 旧口令错 → 401', r.statusCode === 401, `status=${r.statusCode}`);

    auditCalls = [];
    r = await idx.main(evt('changepasscode', { oldPasscode: 'oldpass123', newPasscode: 'newpass123' }, memberTok));
    b = bodyOf(r);
    check('changePasscode 正常 → 200 且 changed=true', r.statusCode === 200 && b.ok && b.data && b.data.changed === true, `status=${r.statusCode}`);
    check('changePasscode 留痕 change_passcode（actor=target=自己，无口令明文）',
      auditCalls.length === 1 && auditCalls[0].action === 'change_passcode' && auditCalls[0].actorId === 1 && auditCalls[0].targetId === 1,
      JSON.stringify(auditCalls));

    // ===================== Step5：addMember =====================
    r = await idx.main(evt('addmember', { displayName: '新成员' }));
    check('addMember 无令牌 → 401', r.statusCode === 401, `status=${r.statusCode}`);

    r = await idx.main(evt('addmember', { displayName: '新成员' }, memberTok));
    check('addMember member 令牌 → 403', r.statusCode === 403, `status=${r.statusCode}`);

    r = await idx.main(evt('addmember', { displayName: '  ' }, adminTok));
    check('addMember 空名字 → 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('addmember', { displayName: 'x'.repeat(61) }, adminTok));
    check('addMember 超长名字（>60）→ 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('addmember', { displayName: '新管理员', role: 'admin' }, adminTok));
    check('addMember admin 角色被拒（UI 通道刻意不给）→ 400', r.statusCode === 400, `status=${r.statusCode}`);

    r = await idx.main(evt('addmember', { displayName: '已存在' }, adminTok));
    check('addMember 重名 → 409', r.statusCode === 409, `status=${r.statusCode}`);

    auditCalls = [];
    r = await idx.main(evt('addmember', { displayName: '新成员', role: 'readonly' }, adminTok));
    b = bodyOf(r);
    check('addMember 正常 → 200 且回 8 位初始口令', r.statusCode === 200 && b.ok && b.data && /^[A-HJ-NP-Z2-9]{8}$/.test(b.data.passcode || ''), `status=${r.statusCode}`);
    check('addMember 留痕 add_member（actor/target 对，detail 不含口令明文）',
      auditCalls.length === 1 && auditCalls[0].action === 'add_member' && auditCalls[0].actorId === 3 && auditCalls[0].targetId === 9
      && !(auditCalls[0].detail || '').includes(b.data && b.data.passcode),
      JSON.stringify(auditCalls));
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

    // ===================== Step5 口令体系：线上链路 =====================
    console.log('\n  —— Step5 口令体系（addMember → resetPasscode → changePasscode 全链路） ——');
    // ① admin 添加成员 → 拿初始口令
    const add1 = await req('POST', 'addmember', { displayName: '验收丙-L', role: 'member' }, admin.token);
    check('addMember admin 正常 → 200 且回 8 位初始口令',
      add1.status === 200 && add1.j && add1.j.ok && /^[A-HJ-NP-Z2-9]{8}$/.test(add1.j.data.passcode || ''),
      `status=${add1.status}`);
    const newbie = add1.j && add1.j.data && add1.j.data.member;
    const initialPass = add1.j && add1.j.data && add1.j.data.passcode;
    if (!newbie || !initialPass) {
      check('addMember 返回新成员与口令（后续链路的前置）', false, JSON.stringify(add1.j));
    } else {
      // ② 新成员用初始口令登录（证明初始口令链路通）
      let li;
      try { li = await login('验收丙-L', initialPass); } catch (e) { li = null; }
      check('新成员初始口令可登录', !!li && !!li.token, li ? 'ok' : '登录失败');

      // ③ admin 重置该成员口令 → 拿新口令
      const rs = await req('POST', 'resetpasscode', { memberId: newbie.id }, admin.token);
      const resetPass = rs.j && rs.j.ok && rs.j.data && rs.j.data.passcode;
      check('resetPasscode admin 正常 → 200 且回新口令',
        rs.status === 200 && /^[A-HJ-NP-Z2-9]{8}$/.test(resetPass || ''), `status=${rs.status}`);
      // ④ 新口令可登录（证明重置链路通）
      let li2;
      try { li2 = await login('验收丙-L', resetPass); } catch (e) { li2 = null; }
      check('重置后新口令可登录', !!li2 && !!li2.token, li2 ? 'ok' : '登录失败');

      // ⑤ 自助改口令（旧=重置来的新口令，新=固定值）
      const ch = await req('POST', 'changepasscode', { oldPasscode: resetPass, newPasscode: 'SelfChange2026' }, li2 && li2.token);
      check('changePasscode 正常 → 200', ch.status === 200 && ch.j && ch.j.ok && ch.j.data && ch.j.data.changed === true, `status=${ch.status}`);
      // ⑥ 自助改后的口令可登录（证明自助改链路通；且证明 resetPass 已失效是预期内的）
      let li3;
      try { li3 = await login('验收丙-L', 'SelfChange2026'); } catch (e) { li3 = null; }
      check('自助改后新口令可登录', !!li3 && !!li3.token, li3 ? 'ok' : '登录失败');

      // ⑦ 旧口令应已失效（resetPass 再登录应失败）
      let li4err = null;
      try { await login('验收丙-L', resetPass); } catch (e) { li4err = e; }
      check('旧口令（重置前那把）已失效', !!li4err, li4err ? '已失效' : '仍可登录（预期外）');
    }

    // ⑧ addMember 越权与参数分支
    const addDup = await req('POST', 'addmember', { displayName: '验收丙-L', role: 'member' }, admin.token);
    check('addMember 重名 → 409', addDup.status === 409, `status=${addDup.status}`);
    const addBadRole = await req('POST', 'addmember', { displayName: '越权角色', role: 'admin' }, admin.token);
    check('addMember admin 角色 → 400（UI 通道刻意不给）', addBadRole.status === 400, `status=${addBadRole.status}`);
    const addNoTok = await req('POST', 'addmember', { displayName: '无令牌' });
    check('addMember 无令牌 → 401', addNoTok.status === 401, `status=${addNoTok.status}`);
    if (testMember && testPass) {
      const m2 = await login(testMember, testPass);
      const addByM = await req('POST', 'addmember', { displayName: 'member 建的号', role: 'member' }, m2.token);
      check('addMember member 令牌 → 403', addByM.status === 403, `status=${addByM.status}`);
      const rsNoTok = await req('POST', 'resetpasscode', { memberId: admin.member.id });
      check('resetPasscode 无令牌 → 401', rsNoTok.status === 401, `status=${rsNoTok.status}`);
      const rsByM = await req('POST', 'resetpasscode', { memberId: admin.member.id }, m2.token);
      check('resetPasscode member 令牌 → 403', rsByM.status === 403, `status=${rsByM.status}`);
    }
    const chNoTok = await req('POST', 'changepasscode', { oldPasscode: 'x', newPasscode: 'y' });
    check('changePasscode 无令牌 → 401', chNoTok.status === 401, `status=${chNoTok.status}`);
    const chBadOld = await req('POST', 'changepasscode', { oldPasscode: 'wrong', newPasscode: 'newpass123' }, admin.token);
    check('changePasscode 旧口令错 → 401', chBadOld.status === 401, `status=${chBadOld.status}`);
    console.log('  ℹ️ 线上验收产生的「验收丙-L」为一次性测试账号；如想清理：');
    console.log("     DELETE FROM members_phase2 WHERE display_name = '验收丙-L';（控制台执行，可选）");
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
