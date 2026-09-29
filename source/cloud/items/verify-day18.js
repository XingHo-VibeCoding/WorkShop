// Day 18 验证脚本：本地用 Node 原生 fetch 发真实 POST 到 CloudBase items 云函数
// 解决 Windows 命令行中文编码坑（curl -d 中文会被 GBK 编码搞乱）。
//
// 用法：
//   1) 把下面 BASE 里的 <<DOMAIN>> 换成你的 /api/items 完整地址
//      （Day 17 验证 GET 时用过的同一个地址；形如 https://xxx.apigw.tencentcs.com/release/api/items）
//   2) 运行： D:\javescript\node.exe verify-day18.js
//      （若 node 已在 PATH，直接 node verify-day18.js）
//
// 脚本会依次跑：① 成功写入(中文) ② 读回 ③ 拒内容重复 ④ 拒缺字段 ⑤ 拒 key 重复(B)
// 把终端输出整段发我即可（图1=①的 ok:true JSON，图2=②读回的新行）。

const BASE = 'https://workshop-d4g02a7z81ff51a63-1496602788.ap-shanghai.app.tcloudbase.com/api/items';

if (BASE.includes('<<DOMAIN>>')) {
  console.error('⚠️ 请先把本文件第 12 行的 BASE 改成你的真实 /api/items 地址，再运行。');
  process.exit(2);
}

async function post(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = await res.text(); }
  return { status: res.status, json };
}

async function get(table) {
  const res = await fetch(`${BASE}?table=${table}`, { method: 'GET' });
  let json;
  try { json = await res.json(); } catch { json = await res.text(); }
  return { status: res.status, json };
}

function show(label, r) {
  console.log(`\n--- ${label} | HTTP ${r.status} ---`);
  console.log(typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2));
}

async function run() {
  console.log('BASE =', BASE);

  console.log('\n=== ① 成功写入（中文，验证编码）===');
  const r1 = await post({
    table: 'work', type: 'meeting', title: '临时碰头',
    startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00',
    attendees: '李工', venue: '线上', note: '', ownerKey: 'self',
  });
  show('① 成功写入', r1);

  console.log('\n=== ② 读回（确认数据库多一行）===');
  const r2 = await get('work');
  show('② 读回 table=work', r2);

  console.log('\n=== ③ 拒内容重复（原样再发一次）===');
  const r3 = await post({
    table: 'work', type: 'meeting', title: '临时碰头',
    startTime: '2026-09-30 15:00', endTime: '2026-09-30 16:00',
    attendees: '李工', venue: '线上', note: '', ownerKey: 'self',
  });
  show('③ 内容重复', r3);

  console.log('\n=== ④ 拒缺字段（只传 table）===');
  const r4 = await post({ table: 'work' });
  show('④ 缺字段', r4);

  console.log('\n=== ⑤ 拒 key 重复（B 方案，幂等键）===');
  const key = 'day18-b-verify-001';
  const r5a = await post({
    table: 'work', type: 'meeting', title: 'key测试会',
    startTime: '2026-10-01 10:00', endTime: '2026-10-01 11:00',
    ownerKey: 'self', idempotencyKey: key,
  });
  show('⑤a 首次(带key)', r5a);
  const r5b = await post({
    table: 'work', type: 'meeting', title: 'key测试会',
    startTime: '2026-10-01 10:00', endTime: '2026-10-01 11:00',
    ownerKey: 'self', idempotencyKey: key,
  });
  show('⑤b 重复同key', r5b);

  console.log('\n=== 验证完毕 ===');
}

run().catch((e) => { console.error('脚本错误:', e); process.exit(1); });
