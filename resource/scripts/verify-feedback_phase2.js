// 线上验收：2026-10-28 晚间九条反馈的修复（部署 items 函数后运行）
// ---------------------------------------------------------------------------
// 覆盖点（全部自建自删，不碰真实数据——10-27 误改 id=5 的教训）：
//   A. 历史词兜底：type=class/trip 的 POST 不再 400，服务端归一化为 course/travel（反馈③的另一半）
//   B. 匿名 ?_action=team → 200 且返回默认团队名（反馈⑨：匿名底栏也有团队名）
//   C. teams 端点权限墙：匿名 401 / member 403 / core 200（反馈⑧的前置）
//   D. 最后团队保护：core 对默认团队发解散 → 400"最后一个团队"（反馈⑥；保护在级联删除之前，安全）
//   E. 解散自动导出：建一个一次性团队，core 解散 → 响应带 export（filename/content/items）
//   F. 反馈⑦自动码唯一：随机码撞库由重试兜底，属低概率事件，线上不硬造（如实 SKIP）
// 用法：set -a; . ./.env.verify; set +a; node resource/scripts/verify-feedback_phase2.js
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const API = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? ' → ' + d : '')); } };
const skip = n => console.log('  ⏭️ SKIP ' + n);

async function req(method, qs, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['X-Member-Token'] = token;
  const r = await fetch(`${API}${qs}`, { method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j, data: j && j.data };
}

(async () => {
  console.log('══ A. 历史词归一化（class/trip → course/travel）══');
  const env = Object.fromEntries(fs.readFileSync('.env.verify', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const login = await req('POST', '?_action=login', { name: env.WORKSHOP_ADMIN_NAME, passcode: env.WORKSHOP_ADMIN_PASS });
  check('core 管理员登录', login.status === 200, 'HTTP ' + login.status);
  const tok = login.data && login.data.token;
  const stamp = Date.now().toString().slice(-5);
  const created = [];
  for (const [word, expect] of [['class', 'course'], ['trip', 'travel']]) {
    const r = await req('POST', '', { table: 'work', type: word, title: `__词检${word}${stamp}__`, startTime: '2026-11-05 10:00', endTime: '2026-11-05 11:00', ownerKey: 'self' }, tok);
    check(`POST type=${word} → 200（不再 400）`, r.status === 200, JSON.stringify(r.body && r.body.error));
    if (r.data && r.data.id) {
      created.push(r.data.id);
      check(`  落库为 ${expect}`, r.data.type === expect, '实际 ' + r.data.type);
    }
  }

  console.log('══ B. 匿名 team 端点（底栏团队名）══');
  const anon = await req('GET', '?_action=team');
  check('匿名 ?_action=team → 200', anon.status === 200, 'HTTP ' + anon.status);
  check('返回默认团队名', !!(anon.data && anon.data.team && anon.data.team.name), JSON.stringify(anon.data));
  check('匿名拿不到邀请码（joinCode 为空）', anon.data && anon.data.team && anon.data.team.joinCode == null, JSON.stringify(anon.data && anon.data.team));

  console.log('══ C. teams 端点权限墙（core 体系级）══');
  const c1 = await req('GET', '?_action=teams');
  check('匿名 → 401', c1.status === 401, 'HTTP ' + c1.status);
  const c2 = await req('GET', '?_action=teams', null, tok);
  check('core → 200 且是数组', c2.status === 200 && Array.isArray(c2.data), JSON.stringify(c2.body).slice(0, 120));
  if (Array.isArray(c2.data)) check('含默认团队（id=1）', c2.data.some(t => t.id === 1), JSON.stringify(c2.data.map(t => t.id)));

  console.log('══ D. 最后团队保护 ══');
  // 依赖：当前全站只剩默认团队 1 个（验收团队应已清理）。若还有别的团队，此判定自动降级为 SKIP——
  // 因为删的不是最后一个，会真的往下走级联（confirmName 是默认团队名也不行——我们故意不给 confirmName，
  // 走到"最后一个团队"判定时直接 400；若团队数 >1 则会要 confirmName → 400 但原因不同）。
  const teamCount = Array.isArray(c2.data) ? c2.data.length : -1;
  if (teamCount === 1) {
    const d = await req('POST', '?_action=deleteteam', { teamId: 1 }, tok);
    check('对唯一的团队发解散 → 400 且不删任何数据', d.status === 400 && /最后一个团队/.test(d.body && d.body.error && d.body.error.message || ''), JSON.stringify(d.body && d.body.error));
  } else {
    skip(`D（当前共 ${teamCount} 个团队，不是"只剩一个"的场景；先清掉测试团队再跑才能验全）`);
  }

  console.log('══ E. 解散自动导出（一次性团队）══');
  const mk = await req('POST', '?_action=createteam', { name: `验收解散${stamp}` }, tok);
  if (mk.status !== 200) {
    check('E 前置：core 建一次性团队', false, JSON.stringify(mk.body && mk.body.error));
  } else {
    const nt = mk.data.team;
    // 给这个团队塞两条日程（注册一个临时成员写进去），再解散，看备份是否完整
    const reg = await req('POST', '?_action=register', { name: `解散检${stamp}`, joinCode: nt.joinCode, passcode: 'zz9988' });
    if (reg.status === 200) {
      const rt = reg.data.token;
      for (let i = 0; i < 2; i++) {
        await req('POST', '', { table: 'work', type: 'meeting', title: `__解散备份${i}${stamp}__`, startTime: `2026-11-06 1${i}:00`, endTime: `2026-11-06 1${i}:30`, ownerKey: 'self' }, rt);
      }
    } else {
      check('E 前置：临时成员注册', false, JSON.stringify(reg.body && reg.body.error));
    }
    // core 跨团队解散：body.teamId 指向别人团队 + 原样输入团队名
    const del = await req('POST', '?_action=deleteteam', { teamId: nt.id, confirmName: nt.name }, tok);
    check('core 跨团队解散 → 200', del.status === 200, JSON.stringify(del.body && del.body.error));
    const ex = del.data && del.data.export;
    check('响应带 export.filename', !!(ex && ex.filename), JSON.stringify(ex && ex.filename));
    check('响应带 export.content 且含 2 条日程', !!(ex && ex.content && (ex.content.match(/__解散备份/g) || []).length === 2), ex ? '条数不符' : '无 content');
    check('文件名注明交给管理员', !!(ex && /交给管理员/.test(ex.filename || '')), ex && ex.filename);
    check('团队已真删（team 端点 404）', (await req('GET', `?_action=teams`, null, tok)).data.every(t => t.id !== nt.id), '');
  }

  console.log('══ 清理探针日程 ══');
  for (const id of created) {
    const d = await req('DELETE', `?action=delete&id=${id}&confirm=true`, null, tok);
    process.stdout.write(`  id=${id} → ${d.status}  `);
  }
  if (created.length) console.log('');

  console.log('══ F. 自动码唯一性 ══');
  skip('F（随机码撞库重试属低概率路径，无法稳定在线上复现；逻辑由代码评审保证：手输码 409、自动码重试 5 次）');

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
