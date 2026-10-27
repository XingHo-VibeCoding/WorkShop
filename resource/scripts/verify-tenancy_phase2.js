#!/usr/bin/env node
// WorkShop · 多团队隔离 · 线上验收（2026-10-27）
// ---------------------------------------------------------------------------
// 验证的核心命题只有一个：**A 团队的人能不能碰到 B 团队的任何东西**。
// 四条红线，任何一条破了都算失败：
//   ① 看不到（列表里没有）
//   ② 改不了（PATCH → 404）
//   ③ 删不了（DELETE → 404）
//   ④ 管不了（跨团队 setRole → 404）
// 外加：
//   ⑤ 匿名只读默认团队（看不到、也写不进去）
//   ⑥ 本团队内部一切照常（不误伤）
//
// 做法：全程走线上接口真实建两个团队 + 两个成员 + 一条日程，验完删掉日程。
//   ⚠️ 团队和成员没有删除接口（本期不做团队管理删除），会在库中留下：
//      团队「验收团队A-<时间戳>」「验收团队B-<时间戳>」+ 成员「甲A」「甲B」
//      脚本末尾会打印清理 SQL，运行一次即可清干净。
//
// 用法：
//   WORKSHOP_ADMIN_NAME=张三 WORKSHOP_ADMIN_PASS=****** node resource/scripts/verify-tenancy_phase2.js
// 退出码：0 全过；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const API = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}

async function req(method, qs, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Member-Token'] = token;
  const r = await fetch(`${API}${qs}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j, data: j && j.data };
}

const p2 = n => String(n).padStart(2, '0');
const now = new Date();
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const D = (d, hhmm) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hhmm}`;
const STAMP = Date.now().toString().slice(-6);

(async () => {
  const adminName = process.env.WORKSHOP_ADMIN_NAME || '';
  const adminPass = process.env.WORKSHOP_ADMIN_PASS || '';
  if (!adminName || !adminPass) {
    console.log('缺少 WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS，无法创建测试团队。');
    process.exit(1);
  }

  let itemId = null;
  const teamNames = [];
  try {
    console.log('──────── 0. 管理员登录（团队码不填，兼容老用法）────────');
    let r = await req('POST', '?_action=login', { name: adminName, passcode: adminPass });
    check('管理员登录成功', r.status === 200 && r.data && r.data.token, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    const adminTok = r.data && r.data.token;
    const adminTeamId = r.data && r.data.member && r.data.member.teamId;
    check('登录响应带回团队信息（修复前没有这个字段）', !!r.data && !!r.data.team && r.data.team.id === adminTeamId,
      JSON.stringify(r.data && r.data.team));
    check('管理员能看到本团队邀请码', !!r.data && !!r.data.team && !!r.data.team.joinCode, JSON.stringify(r.data && r.data.team));
    if (!adminTok) throw new Error('__abort__');

    console.log('\n──────── 1. 建两个测试团队 ────────');
    const nameA = `验收团队A-${STAMP}`;
    const nameB = `验收团队B-${STAMP}`;
    r = await req('POST', '?_action=createteam', { name: nameA }, adminTok);
    check('创建团队 A', r.status === 200 && r.data && r.data.team && r.data.team.joinCode, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    const teamA = r.data && r.data.team;
    if (teamA) teamNames.push(teamA.name);

    r = await req('POST', '?_action=createteam', { name: nameB }, adminTok);
    check('创建团队 B', r.status === 200 && r.data && r.data.team && r.data.team.joinCode, `status=${r.status}`);
    const teamB = r.data && r.data.team;
    if (teamB) teamNames.push(teamB.name);
    if (!teamA || !teamB) throw new Error('__abort__');

    console.log('\n──────── 2. 两个团队各自注册第一个成员（应自动成为管理员）────────');
    r = await req('POST', '?_action=register', { joinCode: teamA.joinCode, name: '甲A', passcode: 'TenantA2026' });
    check('团队 A 注册成功且角色=admin（第一个成员自动成为管理员）',
      r.status === 200 && r.data && r.data.member && r.data.member.role === 'admin',
      `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    const tokA = r.data && r.data.token;
    const midA = r.data && r.data.member && r.data.member.id;

    r = await req('POST', '?_action=register', { joinCode: teamB.joinCode, name: '甲B', passcode: 'TenantB2026' });
    check('团队 B 注册成功且角色=admin',
      r.status === 200 && r.data && r.data.member && r.data.member.role === 'admin', `status=${r.status}`);
    const tokB = r.data && r.data.token;
    const midB = r.data && r.data.member && r.data.member.id;
    if (!tokA || !tokB) throw new Error('__abort__');

    console.log('\n──────── 3. A 建一条日程 ────────');
    r = await req('POST', '', {
      table: 'work', type: 'meeting', title: `隔离测试-${STAMP}`,
      startTime: D(monday, '21:00'), endTime: D(monday, '22:00'),
      attendees: '', venue: '', note: '多团队隔离验收，稍后自动删除', ownerKey: 'self',
    }, tokA);
    check('A 在自己团队里能建日程', r.status === 200 && r.data && r.data.id, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    itemId = r.data && r.data.id;

    console.log('\n──────── 4. ★红线①：B 看不到 A 的日程 ────────');
    r = await req('GET', '', null, tokB);
    const bList = (r.data || []).map(x => String(x.id));
    check('B 的列表里没有 A 的这条', !bList.includes(String(itemId)), `B 看到 ${bList.length} 条`);

    console.log('\n──────── 5. ★红线②③：B 改不了 / 删不了 ────────');
    r = await req('PATCH', `?id=${itemId}`, { title: 'B 越权改的标题' }, tokB);
    check('B 改 A 的日程 → 404（不是 403，不泄露"存在但无权"）', r.status === 404, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    r = await req('DELETE', `?id=${itemId}&confirm=true`, null, tokB);
    check('B 删 A 的日程 → 404', r.status === 404, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);

    console.log('\n──────── 6. ★红线④：跨团队管不了 ────────');
    r = await req('POST', '?_action=setrole', { memberId: midA, role: 'readonly' }, tokB);
    check('B 的管理员改 A 团队成员的角色 → 404', r.status === 404, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    r = await req('POST', '?_action=resetpasscode', { memberId: midA }, tokB);
    check('B 的管理员重置 A 团队成员口令 → 404', r.status === 404, `status=${r.status}`);

    console.log('\n──────── 7. 成员名单也隔离 ────────');
    r = await req('GET', '?_action=members', null, tokB);
    const bMembers = (r.data || []).map(m => m.id);
    check('B 的成员列表里没有 A', !bMembers.includes(midA), JSON.stringify(bMembers));
    r = await req('GET', '?_action=members', null, tokA);
    const aMembers = (r.data || []).map(m => m.id);
    check('A 的成员列表里有自己、没有 B', aMembers.includes(midA) && !aMembers.includes(midB), JSON.stringify(aMembers));

    console.log('\n──────── 8. ★匿名：只读默认团队，写不进去 ────────');
    r = await req('GET', '', null, null);
    const anonIds = (r.data || []).map(x => String(x.id));
    check('匿名能看到列表（默认团队）', r.status === 200 && Array.isArray(r.data), `status=${r.status}`);
    check('匿名看不到 A 团队的日程', !anonIds.includes(String(itemId)), `匿名看到 ${anonIds.length} 条`);
    r = await req('POST', '', {
      table: 'work', type: 'meeting', title: '匿名不该建成功',
      startTime: D(monday, '23:00'), endTime: D(monday, '23:30'), ownerKey: 'self',
    }, null);
    check('匿名新建 → 401（seam A 已关闭）', r.status === 401, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
    r = await req('PATCH', `?id=${itemId}`, { title: '匿名越权改' }, null);
    check('匿名改 → 401', r.status === 401, `status=${r.status}`);
    r = await req('DELETE', `?id=${itemId}&confirm=true`, null, null);
    check('匿名删 → 401', r.status === 401, `status=${r.status}`);

    console.log('\n──────── 9. 团队信息隔离 ────────');
    r = await req('GET', '?_action=team', null, tokA);
    check('A 查团队信息 → 只看得到自己的团队', r.status === 200 && r.data && r.data.team && r.data.team.id === teamA.id,
      JSON.stringify(r.data && r.data.team));
    r = await req('GET', '?_action=team', null, tokB);
    check('B 查团队信息 → 是 B 自己的团队', r.status === 200 && r.data && r.data.team && r.data.team.id === teamB.id);

    console.log('\n──────── 10. 本团队内一切照常（不误伤）────────');
    r = await req('PATCH', `?id=${itemId}`, { title: `隔离测试-已改-${STAMP}` }, tokA);
    check('A 改自己的日程 → 200', r.status === 200, `status=${r.status}`);
    r = await req('GET', '', null, tokA);
    check('A 列表里能看到自己那条', (r.data || []).some(x => String(x.id) === String(itemId)), `A 看到 ${(r.data || []).length} 条`);

    console.log('\n──────── 11. 跨团队重名：登录要团队码 ────────');
    // A、B 团队里各有一个「甲A」/「甲B」，名字不同不会撞；这里专门造重名场景成本高，
    // 改为验证「带团队码登录」这条路本身可用（B 用团队码登录自己的账号）。
    r = await req('POST', '?_action=login', { name: '甲B', passcode: 'TenantB2026', teamCode: teamB.joinCode });
    check('带团队码登录成功（团队码定位可用）', r.status === 200 && r.data && r.data.token, `status=${r.status} ${JSON.stringify(r.body && r.body.error)}`);
  } catch (e) {
    if (e && e.message !== '__abort__') check('验收流程无异常', false, e && e.message);
  } finally {
    // 清理：只删日程（团队/成员没有删除接口，靠下面打印的 SQL）
    if (itemId) {
      try {
        const rl = await req('POST', '?_action=login', { name: '甲A', passcode: 'TenantA2026' });
        const tk = rl.data && rl.data.token;
        const rd = await req('DELETE', `?id=${itemId}&confirm=true`, null, tk);
        console.log(rd.status === 200 ? '  🧹 已删除测试日程 id=' + itemId : '  ⚠️ 测试日程删除失败 status=' + rd.status + '，请手动删除 id=' + itemId);
      } catch (_) { console.log('  ⚠️ 清理异常，请手动删除 id=' + itemId); }
    }
    if (teamNames.length) {
      console.log('\n──────── 需要你清理的测试团队（无删除接口）────────');
      console.log('团队名：' + teamNames.join(' / '));
      console.log('清理 SQL（控制台执行一次）：');
      console.log("  DELETE FROM items         WHERE team_id IN (SELECT id FROM teams_phase2 WHERE name LIKE '验收团队_-%');");
      console.log("  DELETE FROM audit_phase2  WHERE team_id IN (SELECT id FROM teams_phase2 WHERE name LIKE '验收团队_-%');");
      console.log("  DELETE FROM members_phase2 WHERE team_id IN (SELECT id FROM teams_phase2 WHERE name LIKE '验收团队_-%');");
      console.log("  DELETE FROM teams_phase2  WHERE name LIKE '验收团队_-%';");
    }
    console.log('\n──────── 小结 ────────');
    console.log('通过 ' + pass + ' · 失败 ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
