#!/usr/bin/env node
// WorkShop · 阶段二 P9 · 验收脚本（离线 ACL 单测 + 线上行为校验）
// ---------------------------------------------------------------------------
// 两部分：
//   A 离线 ACL 单测（总是跑、不联网）：直接 require acl_phase2.js，覆盖决策表
//      TECH_DESIGN_phase2 §6.2 + PRD A5 的四类放置权限与并发无关判定。
//   B 线上行为校验（仅 --live 时跑，需联网 + 凭据）：照着前端契约打接口，
//      验证 ① 张三(member) 正常建/改 ② readonly 建/改被 403 挡 ③ 并发 PATCH 触发 409
//      ④ 代他人放置 ownerMemberId 落到目标（留痕在后端审计表，代码层已覆盖）。
//
// 用法：
//   node resource/scripts/verify-p9_phase2.js                  # 只跑离线单测
//   node resource/scripts/verify-p9_phase2.js --live           # 再加线上校验
//
// 线上校验所需环境变量（--live 时）：
//   WORKSHOP_API_BASE      默认 https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com
//   WORKSHOP_TEST_MEMBER   一名 role=member 的成员显示名（如 张三）
//   WORKSHOP_TEST_PASS     该成员口令
//   WORKSHOP_RO_MEMBER     一名 role=readonly 的成员显示名（P9 验收用，先用 add_member_phase2.js 建）
//   WORKSHOP_RO_PASS       该只读成员口令
//   WORKSHOP_TARGET_MEMBER 代他人放置的目标成员（role=member，非测试成员自己）
//   WORKSHOP_TARGET_PASS   该目标成员口令（用于清理 place_for 测试项）
//
// 退出码：0 全部通过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const path = require('path');
const acl = require(path.join(__dirname, '..', '..', 'source', 'cloud', 'items', 'acl_phase2.js'));

let pass = 0, fail = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` → ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ===================== A. 离线 ACL 单测 =====================
function runOffline() {
  console.log('\n──────── 离线 ACL 单测（decideWrite） ────────');
  const member = { mid: 1, role: 'member' };
  const readonly = { mid: 2, role: 'readonly' };
  const admin = { mid: 3, role: 'admin' };
  const anon = null; // 未登录

  // ① 未登录：向后兼容放行（ownerMemberId=null）
  let d = acl.decideWrite(anon, { op: 'create', targetOwnerId: null });
  check('匿名 create → 放行(ownerMemberId=null)', d.ok && d.ownerMemberId === null && d.placeFor === false, JSON.stringify(d));

  // ② readonly 任何写都拒
  d = acl.decideWrite(readonly, { op: 'create', targetOwnerId: null });
  check('readonly create → 403', !d.ok && d.code === 403, JSON.stringify(d));
  d = acl.decideWrite(readonly, { op: 'patch', item: { ownerMemberId: 2 } });
  check('readonly patch → 403', !d.ok && d.code === 403, JSON.stringify(d));
  d = acl.decideWrite(readonly, { op: 'delete', item: { ownerMemberId: 2 } });
  check('readonly delete → 403', !d.ok && d.code === 403, JSON.stringify(d));

  // ③ member 给自己放
  d = acl.decideWrite(member, { op: 'create', targetOwnerId: null });
  check('member 给自己放(create 无 target) → 放行且 owner=自己', d.ok && d.ownerMemberId === 1 && d.placeFor === false, JSON.stringify(d));
  d = acl.decideWrite(member, { op: 'create', targetOwnerId: 1 });
  check('member 给自己放(create target=自己) → 放行', d.ok && d.ownerMemberId === 1 && d.placeFor === false, JSON.stringify(d));

  // ② 给他人放：member 允许，placeFor=true
  d = acl.decideWrite(member, { op: 'create', targetOwnerId: 99 });
  check('member 代他人放(target=99) → 放行且 placeFor=true', d.ok && d.ownerMemberId === 99 && d.placeFor === true, JSON.stringify(d));

  // ④ member 改/删自己的项 → 放行
  d = acl.decideWrite(member, { op: 'patch', item: { ownerMemberId: 1 } });
  check('member 改自己的项 → 放行', d.ok, JSON.stringify(d));
  d = acl.decideWrite(member, { op: 'delete', item: { ownerMemberId: 1 } });
  check('member 删自己的项 → 放行', d.ok, JSON.stringify(d));

  // ④ member 改/删他人的项 → 403
  d = acl.decideWrite(member, { op: 'patch', item: { ownerMemberId: 5 } });
  check('member 改他人的项 → 403', !d.ok && d.code === 403, JSON.stringify(d));
  d = acl.decideWrite(member, { op: 'delete', item: { ownerMemberId: 5 } });
  check('member 删他人的项 → 403', !d.ok && d.code === 403, JSON.stringify(d));

  // 旧数据（v1.0 匿名写入，无归属）：ownerMemberId=null → 放行（向后兼容）
  d = acl.decideWrite(member, { op: 'patch', item: { ownerMemberId: null } });
  check('member 改 legacy 无归属项 → 放行(兼容)', d.ok, JSON.stringify(d));
  d = acl.decideWrite(member, { op: 'delete', item: { ownerMemberId: null } });
  check('member 删 legacy 无归属项 → 放行(兼容)', d.ok, JSON.stringify(d));

  // admin 占位全放行（含他人项）
  d = acl.decideWrite(admin, { op: 'patch', item: { ownerMemberId: 5 } });
  check('admin 改他人的项 → 放行(占位)', d.ok, JSON.stringify(d));
}

// ===================== B. 线上行为校验 =====================
async function runLive() {
  console.log('\n──────── 线上行为校验（--live） ────────');
  const BASE = process.env.WORKSHOP_API_BASE ||
    'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';
  const testMember = process.env.WORKSHOP_TEST_MEMBER;
  const testPass = process.env.WORKSHOP_TEST_PASS;
  const roMember = process.env.WORKSHOP_RO_MEMBER;
  const roPass = process.env.WORKSHOP_RO_PASS;
  const targetMember = process.env.WORKSHOP_TARGET_MEMBER;
  const targetPass = process.env.WORKSHOP_TARGET_PASS;

  if (!testMember || !testPass) {
    console.log('  ⚠️ 跳过线上校验：缺少 WORKSHOP_TEST_MEMBER / WORKSHOP_TEST_PASS');
    return;
  }

  // —— HTTP 辅助 ——
  async function req(method, action, body, token) {
    const url = new URL(`${BASE}/api/items`);
    if (action) url.searchParams.set('_action', action);
    if (method === 'DELETE' && body && body.id != null) url.searchParams.set('id', String(body.id));
    if (method === 'DELETE' && body && body.confirm != null) url.searchParams.set('confirm', String(body.confirm));
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
  async function members(token) {
    const { status, j } = await req('GET', 'members', null, token);
    if (status !== 200 || !j || !j.ok) throw new Error(`成员列表失败：${status}`);
    return j.data || [];
  }

  const createdIds = []; // 待清理（测试成员自己建的）

  try {
    // —— 1) 张三(member) 正常创建 ——
    const t = await login(testMember, testPass);
    const mintStart = '2026-10-20 09:00';
    const mintEnd = '2026-10-20 10:00';
    const c = await req('POST', null, {
      title: 'P9验收-自建', table: 'work', type: 'meeting',
      startTime: mintStart, endTime: mintEnd, ownerKey: 'self',
    }, t.token);
    const ownOk = c.status === 200 && c.j && c.j.ok && c.j.data && c.j.data.id;
    check('member 自建事项 → 200', ownOk, `status=${c.status}`);
    const ownId = c.j && c.j.data && c.j.data.id;
    const ownRaw = c.j && c.j.data && c.j.data.updatedAtRaw;
    if (ownId) createdIds.push(ownId);
    check('member 自建事项 回带 updatedAtRaw', !!ownRaw, String(ownRaw));

    // —— 2) readonly 创建 → 期望 403 ——
    let roToken = null;
    if (roMember && roPass) {
      const r = await login(roMember, roPass);
      roToken = r.token;
      const rc = await req('POST', null, {
        title: 'P9验收-只读尝试建', table: 'work', type: 'meeting',
        startTime: mintStart, endTime: mintEnd, ownerKey: 'self',
      }, roToken);
      check('readonly 建事项 → 403', rc.status === 403, `status=${rc.status} msg=${(rc.j && rc.j.error && rc.j.error.message) || ''}`);

      // —— 3) readonly 改张三的项 → 期望 403 ——
      if (ownId) {
        const rp = await req('PATCH', null, { id: ownId, title: 'P9验收-只读改', baseUpdatedAt: ownRaw }, roToken);
        check('readonly 改他人项 → 403', rp.status === 403, `status=${rp.status} msg=${(rp.j && rp.j.error && rp.j.error.message) || ''}`);
      }
    } else {
      console.log('  ⚠️ 跳过 readonly 校验：缺少 WORKSHOP_RO_MEMBER / WORKSHOP_RO_PASS（先用 add_member_phase2.js 建一个只读成员）');
    }

    // —— 4) 并发 PATCH：两次用相同 baseUpdatedAt，第二次应 409 ——
    if (ownId && ownRaw) {
      const p1 = await req('PATCH', null, { id: ownId, title: 'P9验收-改1', baseUpdatedAt: ownRaw }, t.token);
      check('第一次 PATCH(基版本正确) → 200', p1.status === 200, `status=${p1.status}`);
      const newRaw = p1.j && p1.j.data && p1.j.data.updatedAtRaw;
      // 第二次用【过期】的 ownRaw（已被 p1 改写），原子条件 updated_at=eq.ownRaw 0 行命中 → 409
      const p2 = await req('PATCH', null, { id: ownId, title: 'P9验收-改2-冲突', baseUpdatedAt: ownRaw }, t.token);
      check('第二次 PATCH(基版本过期) → 409 并发冲突', p2.status === 409, `status=${p2.status} msg=${(p2.j && p2.j.error && p2.j.error.message) || ''}`);
      check('409 文案含「冲突」', !!(p2.j && p2.j.error && /冲突/.test(p2.j.error.message)), (p2.j && p2.j.error && p2.j.error.message) || '');
      // 用新版本再改一次，证明"刷新后可继续"——同时把标题改回便于识别
      if (newRaw) {
        const p3 = await req('PATCH', null, { id: ownId, title: 'P9验收-自建', baseUpdatedAt: newRaw }, t.token);
        check('用新基版本 PATCH → 200（刷新后可继续）', p3.status === 200, `status=${p3.status}`);
      }
    }

    // —— 5) 代他人放置：ownerMemberId=目标，ownerMemberId 应落到目标 ——
    // 目标 id 直接取「显式传入的 targetMember 登录返回的 member.id」，
    // 不再从 members 列表猜（避免误选 readonly 成员导致清理 403）。
    if (targetMember && targetPass) {
      const tgt = await login(targetMember, targetPass);
      const target = { id: tgt.member.id };
      const ml = await members(t.token); // 仅断言目标确实在成员列表
      if (ml.find((m) => m.id === target.id)) {
        const pf = await req('POST', null, {
          title: 'P9验收-代放', table: 'work', type: 'meeting',
          startTime: mintStart, endTime: mintEnd, ownerKey: 'self',
          ownerMemberId: target.id,
        }, t.token);
        const pfOk = pf.status === 200 && pf.j && pf.j.ok && pf.j.data && pf.j.data.ownerMemberId === target.id;
        check('代他人放置 → 200 且 ownerMemberId=目标', pfOk, `status=${pf.status} ownerMemberId=${(pf.j && pf.j.data && pf.j.data.ownerMemberId)}`);
        // 清理：用目标成员令牌删掉（目标自己拥有该事项）
        const del = await req('DELETE', null, { id: pf.j.data.id, confirm: true }, tgt.token);
        check('代放事项可由目标成员删除(清理)', del.status === 200, `status=${del.status}`);
      } else {
        console.log('  ⚠️ 跳过代放校验：成员列表里找不到目标成员');
      }
    } else {
      console.log('  ⚠️ 跳过代放校验：缺少 WORKSHOP_TARGET_MEMBER / WORKSHOP_TARGET_PASS');
    }
  } finally {
    // —— 清理：删掉测试成员自建的测试项 ——
    for (const id of createdIds) {
      try {
        const tk = (await login(testMember, testPass)).token;
        await req('DELETE', null, { id, confirm: true }, tk);
        console.log(`  🧹 已清理测试项 id=${id}`);
      } catch (_) { console.log(`  ⚠️ 清理失败 id=${id}（可能已被删），请手动确认`); }
    }
  }
}

(async () => {
  runOffline();
  if (process.argv.includes('--live')) {
    try { await runLive(); }
    catch (e) { console.log('\n❌ 线上校验异常：', e.message); fail++; }
  }
  console.log(`\n──────── 小结 ────────`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
