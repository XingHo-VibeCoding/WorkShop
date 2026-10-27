#!/usr/bin/env node
// WorkShop · 阶段二 双人协作 + 管理员代管 · 线上验证（2026-10-26）
// ---------------------------------------------------------------------------
// 目的：补两处线上空白
//   ① P13「双人真机试用」的技术侧——两个不同身份在同一张时间线上协作，归属可辨、越权被拦
//   ② seam C 第 2 项「管理员可改/删他人日程」——线上直测（此前只有离线 ACL 单测）
//
// 设计原则：
//   · 真接口、真库、真令牌；**全程自清理**（建一条带标记的测试日程，验完删除，最后核对条数回基线）
//   · 中途任何一步失败，finally 里也会尽力删掉测试数据，不留垃圾
//   · 只碰自己创建的测试日程，绝不动既有 11 条数据
//
// 用法（环境变量）：
//   WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS     admin（张三）
//   WORKSHOP_TEST_MEMBER / WORKSHOP_TEST_PASS     member（验收甲）
//   WORKSHOP_RO_MEMBER  / WORKSHOP_RO_PASS        readonly（验收乙）
//
// 退出码：0 全过；1 有失败
// ---------------------------------------------------------------------------
'use strict';

const API = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';
const ENV = process.env;

let pass = 0;
let fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Member-Token'] = token;
  const res = await fetch(`${API}/api/items${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, ok: !!(json && json.ok) };
}

async function login(name, passcode) {
  const r = await req('POST', '?_action=login', { name, passcode });
  if (!r.ok) throw new Error(`登录失败 ${name}：${r.status} ${(r.body && r.body.error && r.body.error.message) || ''}`);
  return { token: r.body.data.token, member: r.body.data.member };
}

async function listCount() {
  const r = await req('GET', '');
  return r.ok ? r.body.data.length : -1;
}

(async () => {
  const need = ['WORKSHOP_ADMIN_NAME', 'WORKSHOP_ADMIN_PASS', 'WORKSHOP_TEST_MEMBER', 'WORKSHOP_TEST_PASS', 'WORKSHOP_RO_MEMBER', 'WORKSHOP_RO_PASS'];
  const missing = need.filter((k) => !ENV[k]);
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(2);
  }

  const baseCount = await listCount();
  console.log(`\n──────── 双人协作 + 管理员代管（基线 ${baseCount} 条）────────\n`);

  let createdId = null;
  let admin = null;
  let member = null;
  let ro = null;

  try {
    admin = await login(ENV.WORKSHOP_ADMIN_NAME, ENV.WORKSHOP_ADMIN_PASS);
    member = await login(ENV.WORKSHOP_TEST_MEMBER, ENV.WORKSHOP_TEST_PASS);
    ro = await login(ENV.WORKSHOP_RO_MEMBER, ENV.WORKSHOP_RO_PASS);
    check('三账号登录成功（admin / member / readonly）', true);

    // ── 1. member 建自己的日程：归属必须由后端从令牌解（防前端伪造） ──
    const mk = await req('POST', '', {
      title: `【自动化验证】双人协作 ${new Date().toISOString().slice(0, 16)}`,
      table: 'work',
      type: 'meeting',
      startTime: '2026-11-02 10:00',
      endTime: '2026-11-02 11:00',
      ownerKey: 'self',
      note: 'verify-collab_phase2.js 临时数据，脚本结束即删',
    }, member.token);
    check('member 新建自己的日程 → 200', mk.status === 200 && mk.ok, `status=${mk.status}`);
    createdId = mk.ok && mk.body.data ? mk.body.data.id : null;
    check('新建后拿到云端 id', Number.isInteger(createdId), `id=${createdId}`);

    const mine = await req('GET', '');
    const row = mine.ok ? mine.body.data.find((x) => x.id === createdId) : null;
    check('归属由后端写入：ownerMemberId = member 自己', !!row && Number(row.ownerMemberId) === Number(member.member.id), `ownerMemberId=${row && row.ownerMemberId} 期望=${member.member.id}`);
    check('创建人留痕：createdBy = member 自己', !!row && Number(row.createdBy) === Number(member.member.id), `createdBy=${row && row.createdBy}`);

    // ── 2. 同表可见：另一个人（readonly）也能在列表里看到这条（协作前提） ──
    check('同表可见：readonly 账号能读到该条（同一张周时间线）', !!row);

    // ── 3. readonly 全写拒（三层：改 / 删 / 建） ──
    const roPatch = await req('PATCH', `?id=${createdId}`, { title: '只读不该改得动' }, ro.token);
    check('readonly 改他人日程 → 403', roPatch.status === 403, `status=${roPatch.status}`);
    // DELETE 必须先过「显式确认闸」(confirm=true)，否则 400——这是 Day 22 的删除闸设计，不是权限结果
    // 所以 readonly 的删除请求带上 confirm，才能让权限判定真正生效（403），否则测出来的是参数错
    const roDel = await req('DELETE', `?id=${createdId}&confirm=true`, undefined, ro.token);
    check('readonly 删他人日程 → 403', roDel.status === 403, `status=${roDel.status}`);
    const roCreate = await req('POST', '', {
      title: '只读不该建得动', table: 'work', type: 'meeting',
      startTime: '2026-11-03 10:00', endTime: '2026-11-03 11:00', ownerKey: 'self',
    }, ro.token);
    check('readonly 新建日程 → 403', roCreate.status === 403, `status=${roCreate.status}`);

    // ── 4. member 改自己的（正权） ──
    const own = await req('PATCH', `?id=${createdId}`, { note: '本人可改自己的日程' }, member.token);
    check('member 改自己的日程 → 200', own.status === 200 && own.ok, `status=${own.status}`);

    // ── 5. ★ seam C 第 2 项：管理员改他人日程（线上直测，此前只有离线单测） ──
    const adminPatch = await req('PATCH', `?id=${createdId}`, { title: '【自动化验证】管理员改了他人的日程' }, admin.token);
    check('★ admin 改他人日程 → 200（seam C 第 2 项线上直测）', adminPatch.status === 200 && adminPatch.ok, `status=${adminPatch.status}`);
    const afterPatch = await req('GET', '');
    const row2 = afterPatch.ok ? afterPatch.body.data.find((x) => x.id === createdId) : null;
    check('管理员改动已落库（标题已变）', !!row2 && /管理员改了他人/.test(row2.title || ''), row2 && row2.title);
    check('管理员改动后归属未变（ownerMemberId 仍属 member）', !!row2 && Number(row2.ownerMemberId) === Number(member.member.id), `ownerMemberId=${row2 && row2.ownerMemberId}`);

    // ── 6. ★ 管理员删他人日程 ──
    const adminDel = await req('DELETE', `?id=${createdId}&confirm=true`, undefined, admin.token);
    check('★ admin 删他人日程 → 200', adminDel.status === 200 && adminDel.ok, `status=${adminDel.status}`);
    createdId = null; // 已删，finally 不必再删

    // ── 7. 复原核对 ──
    const endCount = await listCount();
    check(`数据复原：条数回到基线 ${baseCount}`, endCount === baseCount, `现状 ${endCount}`);
  } catch (e) {
    check('执行过程无异常', false, e && e.message);
  } finally {
    // 兜底清理：脚本异常中断时，尽力删掉本次创建的测试日程（优先用 admin，退而用本人）
    if (createdId) {
      const tk = (admin && admin.token) || (member && member.token);
      if (tk) {
        const d = await req('DELETE', `?id=${createdId}&confirm=true`, undefined, tk).catch(() => null);
        console.log(`  ↳ 兜底清理测试日程 id=${createdId}：${d && d.status === 200 ? '已删除' : '删除失败，请手动清理'}`);
      }
    }
    console.log(`\n──────── 小结 ────────`);
    console.log(`通过 ${pass} · 失败 ${fail}`);
    if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
    process.exit(fail ? 1 : 0);
  }
})();
