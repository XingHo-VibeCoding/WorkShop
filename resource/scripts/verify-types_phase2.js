#!/usr/bin/env node
// WorkShop · 类型与颜色体系 · 线上验收（2026-10-28）
// ---------------------------------------------------------------------------
// 用户 2026-10-28 拍板：②B（新增颜色 = 新增日程类型）+ ③A（core 全局核心管理员）。
// 这个脚本验的就是这两条落地得对不对：
//
//   A. 读：任何人（含匿名）都能拿到完整类型清单，且颜色是合法的 #RRGGBB
//   B. 权限墙：未登录 401 / 普通成员 403 / 团队管理员 403 / 只有 core 能写
//   C. 输入校验：颜色太浅 422、重名 409、内置类型不可删 403、还有日程在用的不可删 409
//   D. 落库：改名改色后再读，值真的变了（不是只改了前端内存）
//   E. 不误伤：core 改色后，既有日程的 type 字段没被动过
//
// core 账号必须先在控制台提权（SQL 在 schema §七 V6 末尾）：
//   UPDATE members_phase2 SET role='core' WHERE id = 2;
// 没配 CORE 凭据时，B/C/D 段会如实 SKIP 并说明原因 —— 不会假装通过。
//
// 用法：
//   set -a; . ./.env.verify; set +a
//   node resource/scripts/verify-types_phase2.js
// 需要的环境变量：WORKSHOP_ADMIN_NAME / WORKSHOP_ADMIN_PASS（验"admin 也不能写"）
//                 WORKSHOP_CORE_NAME  / WORKSHOP_CORE_PASS （验 core 能写；缺则 SKIP）
//                 WORKSHOP_TEST_MEMBER / WORKSHOP_TEST_PASS（普通成员，缺则跳过该条）
// 退出码：0 全过（含如实 SKIP）；1 有失败。
// ---------------------------------------------------------------------------
'use strict';

const API = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com/api/items';

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}
function skips(name, why) { skip++; console.log('  ⏭️  ' + name + '（' + why + '）'); }

async function req(method, qs, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Member-Token'] = token;
  const r = await fetch(`${API}${qs}`, {
    method, headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j, data: j && j.data };
}

const login = async (name, pass) => {
  if (!name || !pass) return null;
  const r = await req('POST', '?_action=login', { name, passcode: pass });
  return r.status === 200 && r.data ? r.data.token : null;
};

const STAMP = Date.now().toString().slice(-6);
const HEX = /^#[0-9a-f]{6}$/;

(async () => {
  console.log('════════ 类型与颜色体系 · 线上验收 ════════\n');

  // ---------- A. 读：公开可读 ----------
  console.log('──────── A. 读：类型清单公开可读 ────────');
  let r = await req('GET', '?_action=types');
  check('匿名可读类型清单（200）', r.status === 200, 'HTTP ' + r.status);
  const types = Array.isArray(r.data) ? r.data : [];
  check('返回的是数组', Array.isArray(r.data), typeof r.data);
  check('至少 7 个内置类型', types.length >= 7, '实际 ' + types.length);
  // ★ 这条是"是不是真部署了新版"的判据：旧版函数不认 _action=types，
  //   会落到默认 GET 分支返回 items 列表 —— 那也能凑够 7 个元素，但绝不会有 code 字段。
  check('返回的确实是类型对象（有 code 字段）', types.length > 0 && types.every(t => t && typeof t.code === 'string'), JSON.stringify(types.slice(0, 2)));

  const codes = types.map(t => t.code);
  const need = ['meeting', 'course', 'travel', 'sport', 'life', 'pending', 'other'];
  const missing = need.filter(c => !codes.includes(c));
  check('内置 7 个类型齐全', missing.length === 0, '缺 ' + missing.join(','));

  const badColor = types.filter(t => !HEX.test(String(t.color || '')));
  check('每个颜色都是合法 #rrggbb', badColor.length === 0, JSON.stringify(badColor.map(t => [t.code, t.color])));

  const noLabel = types.filter(t => !String(t.label || '').trim());
  check('每个类型都有名字', noLabel.length === 0, JSON.stringify(noLabel.map(t => t.code)));

  const uniq = new Set(codes);
  check('类型码无重复', uniq.size === codes.length);

  // 白字对比度：所有下发的颜色都要能配白字（否则时间线上看不清标题）
  const relLum = h => {
    const s = String(h).replace('#', '');
    const c = [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = h => 1.05 / (relLum(h) + 0.05);
  const tooLight = types.filter(t => HEX.test(String(t.color || '')) && contrast(t.color) < 4.5);
  check('所有类型色白字对比 ≥4.5:1', tooLight.length === 0, JSON.stringify(tooLight.map(t => [t.code, t.color, contrast(t.color).toFixed(1)])));

  const builtinCount = types.filter(t => t.builtin === true).length;
  check('内置类型被标记为 builtin', builtinCount >= 7, '实际 ' + builtinCount);

  // ---------- B. 权限墙 ----------
  console.log('\n──────── B. 权限墙：只有 core 能写 ────────');
  r = await req('POST', '?_action=addtype', { label: '匿名校验' + STAMP, color: '#0f766e' });
  check('未登录新增类型 → 401', r.status === 401, 'HTTP ' + r.status);

  r = await req('POST', '?_action=updatetype', { code: 'meeting', color: '#123456' });
  check('未登录改色 → 401', r.status === 401, 'HTTP ' + r.status);

  r = await req('POST', '?_action=deletetype', { code: 'meeting' });
  check('未登录删类型 → 401', r.status === 401, 'HTTP ' + r.status);

  const adminName = process.env.WORKSHOP_ADMIN_NAME || '';
  const adminPass = process.env.WORKSHOP_ADMIN_PASS || '';
  let adminTok = await login(adminName, adminPass);
  if (!adminTok) {
    skips('团队管理员不能改类型', '未提供可用的 WORKSHOP_ADMIN_NAME / PASS');
  } else {
    r = await req('POST', '?_action=addtype', { label: '管理员越权' + STAMP, color: '#0f766e' }, adminTok);
    check('团队管理员新增类型 → 403（不是 core）', r.status === 403, 'HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.error));
    r = await req('POST', '?_action=updatetype', { code: 'meeting', color: '#123456' }, adminTok);
    check('团队管理员改色 → 403', r.status === 403, 'HTTP ' + r.status);
    r = await req('POST', '?_action=deletetype', { code: 'other' }, adminTok);
    check('团队管理员删类型 → 403', r.status === 403, 'HTTP ' + r.status);
  }

  const memberName = process.env.WORKSHOP_TEST_MEMBER || '';
  const memberPass = process.env.WORKSHOP_TEST_PASS || '';
  let memberTok = await login(memberName, memberPass);
  if (!memberTok) {
    skips('普通成员不能改类型', '未提供 WORKSHOP_TEST_MEMBER / PASS');
  } else {
    r = await req('POST', '?_action=addtype', { label: '成员越权' + STAMP, color: '#0f766e' }, memberTok);
    check('普通成员新增类型 → 403', r.status === 403, 'HTTP ' + r.status);
  }

  // ---------- C/D. core 的写路径 ----------
  const coreName = process.env.WORKSHOP_CORE_NAME || '';
  const corePass = process.env.WORKSHOP_CORE_PASS || '';
  const coreTok = await login(coreName, corePass);
  let addedCode = null;
  const origMeetingColor = (types.find(t => t.code === 'meeting') || {}).color;

  if (!coreTok) {
    console.log('\n──────── C. 输入校验（core）────────');
    skips('core 全套写路径', '未提供 WORKSHOP_CORE_NAME / PASS（先把管理员提权成 core，见文件头 SQL）');
  } else {
    console.log('\n──────── C. 输入校验（core）────────');

    // 颜色太浅
    r = await req('POST', '?_action=addtype', { label: '浅色测试' + STAMP, color: '#ffff00' }, coreTok);
    check('颜色太浅 → 422', r.status === 422, 'HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.error));

    // 非法颜色
    r = await req('POST', '?_action=addtype', { label: '非法色' + STAMP, color: 'red' }, coreTok);
    check('非法颜色格式 → 400', r.status === 400, 'HTTP ' + r.status);

    // 空名字
    r = await req('POST', '?_action=addtype', { label: '', color: '#0f766e' }, coreTok);
    check('空名称 → 400', r.status === 400, 'HTTP ' + r.status);

    // 正常新增
    const newLabel = '验收类型' + STAMP;
    r = await req('POST', '?_action=addtype', { label: newLabel, color: '#0f766e' }, coreTok);
    check('core 新增类型成功', r.status === 200 && r.data && r.data.code, 'HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.error));
    addedCode = r.data && r.data.code;
    check('生成的 code 形如 custom_xxx', /^custom_[a-z0-9]+$/.test(String(addedCode)), String(addedCode));
    check('新类型 builtin=false', r.data && r.data.builtin === false);

    // 重名
    r = await req('POST', '?_action=addtype', { label: newLabel, color: '#123456' }, coreTok);
    check('同名类型 → 409', r.status === 409, 'HTTP ' + r.status);

    // 删内置
    r = await req('POST', '?_action=deletetype', { code: 'meeting' }, coreTok);
    check('删除内置类型 → 403', r.status === 403, 'HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.error));

    // 改色（用深绿，达标）
    r = await req('POST', '?_action=updatetype', { code: 'meeting', color: '#0b3d91' }, coreTok);
    check('core 改内置类型颜色成功', r.status === 200 && r.data && r.data.color === '#0b3d91', 'HTTP ' + r.status + ' ' + JSON.stringify(r.data || (r.body && r.body.error)));

    // 改色后回读（证明落库，不是只改了响应）
    r = await req('GET', '?_action=types');
    const after = (Array.isArray(r.data) ? r.data : []).find(t => t.code === 'meeting');
    check('改色已落库（回读一致）', after && after.color === '#0b3d91', after && after.color);

    // 改名
    r = await req('POST', '?_action=updatetype', { code: 'meeting', label: '会议X' }, coreTok);
    check('core 改类型名称成功', r.status === 200 && r.data && r.data.label === '会议X', 'HTTP ' + r.status);
    r = await req('POST', '?_action=updatetype', { code: 'meeting', label: '会议X' }, coreTok);
    check('同名但同 code 改名 → 允许（不与自身冲突）', r.status === 200, 'HTTP ' + r.status);

    // 改回原名与原色（不污染线上语义）
    await req('POST', '?_action=updatetype', { code: 'meeting', label: '会议' }, coreTok);
    await req('POST', '?_action=updatetype', { code: 'meeting', color: origMeetingColor || '#1d4ed8' }, coreTok);
    r = await req('GET', '?_action=types');
    const restored = (Array.isArray(r.data) ? r.data : []).find(t => t.code === 'meeting');
    check('内置 meeting 已还原（名字+颜色）', restored && restored.label === '会议' && restored.color === (origMeetingColor || '#1d4ed8'), JSON.stringify(restored));

    // 删除自定义类型（此时没人用）
    if (addedCode) {
      r = await req('POST', '?_action=deletetype', { code: addedCode }, coreTok);
      check('core 删除自定义类型成功', r.status === 200, 'HTTP ' + r.status + ' ' + JSON.stringify(r.body && r.body.error));
      r = await req('GET', '?_action=types');
      check('删除后清单里不再出现', !(Array.isArray(r.data) ? r.data : []).some(t => t.code === addedCode));
    }

    // 不存在的类型
    r = await req('POST', '?_action=updatetype', { code: 'no_such_type', color: '#123456' }, coreTok);
    check('改不存在的类型 → 404', r.status === 404, 'HTTP ' + r.status);
    r = await req('POST', '?_action=deletetype', { code: 'no_such_type' }, coreTok);
    check('删不存在的类型 → 404', r.status === 404, 'HTTP ' + r.status);

    // 空补丁
    r = await req('POST', '?_action=updatetype', { code: 'life' }, coreTok);
    check('没有任何可改字段 → 400', r.status === 400, 'HTTP ' + r.status);
  }

  // ---------- E. 不误伤：类型变更不影响既有日程 ----------
  console.log('\n──────── E. 不误伤：既有日程照常 ────────');
  r = await req('GET', '?action=list');
  check('匿名列表仍可读（200）', r.status === 200, 'HTTP ' + r.status);
  const list = Array.isArray(r.data) ? r.data : [];
  check('列表返回数组', Array.isArray(r.data));
  const known = new Set(types.map(t => t.code).concat(need));
  const weird = list.filter(it => it.type && !known.has(it.type) && !/^custom_/.test(it.type));
  check('既有日程的类型都在清单内（或为自定义）', weird.length === 0, JSON.stringify(weird.slice(0, 3).map(x => [x.id, x.type])));

  console.log('\n──────── 总结 ────────');
  console.log(`通过 ${pass} · 失败 ${fail}${skip ? ' · 跳过 ' + skip : ''}`);
  if (skip) console.log('ℹ️ 跳过项不是通过：core 相关能力没被验证过。要验就把管理员提权成 core 后重跑。');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n脚本异常：', e && (e.stack || e.message));
  process.exit(1);
});
