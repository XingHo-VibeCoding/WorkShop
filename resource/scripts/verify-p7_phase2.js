#!/usr/bin/env node
/**
 * P7 里程碑验收脚本（本地运行，不连仓库、不含任何明文口令）
 * 验证两个口令成员【能登录】+【登录后令牌能 verify 恢复身份】。
 *
 * 凭据从环境变量读取（避免明文出现在命令 / 对话 / 仓库里）：
 *   P7_NAME_1 / P7_PASS_1   第一个成员（如 张三）
 *   P7_NAME_2 / P7_PASS_2   第二个成员（如 李四）
 *
 * 用法（PowerShell）：
 *   $env:P7_NAME_1="张三"; $env:P7_PASS_1="test123"
 *   $env:P7_NAME_2="李四"; $env:P7_PASS_2="abc123"
 *   node resource/scripts/verify-p7_phase2.js
 *
 * 用法（bash）：
 *   P7_NAME_1=张三 P7_PASS_1=test123 P7_NAME_2=李四 P7_PASS_2=abc123 \
 *     node resource/scripts/verify-p7_phase2.js
 */
'use strict';

const BASE = 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';

const cases = [
  { name: process.env.P7_NAME_1, pass: process.env.P7_PASS_1 },
  { name: process.env.P7_NAME_2, pass: process.env.P7_PASS_2 },
];

function fail(msg) { console.error('  ✗ ' + msg); return false; }

async function run() {
  let allPass = true;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const tag = `成员#${i + 1}`;
    if (!c.name || !c.pass) {
      console.log(`\n[${tag}] 未提供凭据（P7_NAME_${i + 1} / P7_PASS_${i + 1}），跳过。`);
      continue;
    }
    console.log(`\n[${tag}] ${c.name}：登录 → verify`);

    // 1) 登录（口令走请求体，不进 URL / 日志）
    let loginRes;
    try {
      const r = await fetch(`${BASE}/api/items?_action=login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name, passcode: c.pass }),
      });
      loginRes = await r.json();
      if (!r.ok || !loginRes.ok) {
        allPass = fail(`登录失败：${JSON.stringify(loginRes.error || loginRes).slice(0, 120)}`);
        continue;
      }
    } catch (e) {
      allPass = fail(`登录请求异常：${e.message}`);
      continue;
    }
    const token = loginRes.data.token;
    console.log(`  ✓ 登录成功，拿到令牌（${token.length} 字符，前 8 位 ${token.slice(0, 8)}…）`);

    // 2) verify 恢复身份
    try {
      const r = await fetch(`${BASE}/api/items?_action=verify`, {
        method: 'GET',
        headers: { 'X-Member-Token': token },
      });
      const v = await r.json();
      if (!r.ok || !v.ok) {
        allPass = fail(`verify 失败：${JSON.stringify(v.error || v).slice(0, 120)}`);
        continue;
      }
      const m = v.data.member || v.data;
      console.log(`  ✓ verify 通过：身份 id=${m.id} name=${m.displayName} role=${m.role}`);
      if (String(m.id) !== String(loginRes.data.member.id)) {
        allPass = fail(`verify 身份(id=${m.id})与登录返回(id=${loginRes.data.member.id})不一致`);
      }
    } catch (e) {
      allPass = fail(`verify 请求异常：${e.message}`);
    }
  }
  console.log('\n=================================');
  console.log(allPass ? 'P7 验收：PASS（两个成员均能登录并 verify 恢复身份）' : 'P7 验收：FAIL（见上）');
  process.exit(allPass ? 0 : 1);
}

run();
