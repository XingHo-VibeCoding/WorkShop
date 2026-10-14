'use strict';
// WorkShop · 阶段二 P10 · 导出模块（A7 CSV/JSON + A8 腾讯文档占位）
//
// 设计要点：
//   ① 本文件同时能在浏览器与 Node 里跑——纯函数（toCSV / toJSON / csvCell）不碰 DOM，
//      用 `(function(global){...})(typeof window!=='undefined'?window:globalThis)` 包裹，
//      window 不存在时挂到 module.exports，便于 verify-p10_phase2.js 离线单测。
//   ② DOM 相关（download / fetch）只在浏览器执行，Node require 时不触发。
//   ③ A7（CSV/JSON）纯前端生成，无接口、无凭据、不耗云函数额度（TECH_DESIGN §9.1）。
//   ④ A8（腾讯文档）必须走服务端：exportToTencentDoc 只发 POST /api/export/doc，
//      Token 在服务端环境变量，前端绝不持有（TECH_DESIGN §9.2）。

const API_BASE = (typeof window !== 'undefined' && window.Auth && window.Auth.apiBase)
  || 'https://workshop-d4g02a7z81ff51a63-1d496602788.ap-shanghai.app.tcloudbase.com';

// —— CSV 单元格转义（TECH_DESIGN §9.1：含逗号/引号/换行 → 双引号包裹 + 内部引号翻倍）——
function csvCell(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// —— 时间格式化：Date 或字符串 → 'YYYY-MM-DD HH:mm'，空值返回 '' ——
function fmtTime(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// CSV 列定义（基于 API 返回形态：startTime/endTime/ownerMemberId 等）
const CSV_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: '标题' },
  { key: 'table', label: '表' },
  { key: 'type', label: '类型' },
  { key: 'startTime', label: '开始' },
  { key: 'endTime', label: '结束' },
  { key: 'ownerMemberId', label: '归属成员ID' },
  { key: 'ownerName', label: '归属成员' },
  { key: 'venue', label: '地点' },
  { key: 'attendees', label: '参与人' },
  { key: 'note', label: '备注' },
];

// rows: API 形态数组；membersMap: { 成员id: 显示名 }
function toCSV(rows, membersMap) {
  const map = membersMap || {};
  const lines = [];
  lines.push(CSV_COLUMNS.map((c) => csvCell(c.label)).join(','));
  for (const it of rows) {
    lines.push(CSV_COLUMNS.map((c) => {
      let v = it[c.key];
      if (c.key === 'ownerName') v = (it.ownerMemberId != null && map[it.ownerMemberId]) ? map[it.ownerMemberId] : '';
      return csvCell(v);
    }).join(','));
  }
  // UTF-8 BOM：否则 Excel 打开中文乱码（TECH_DESIGN §9.1）
  return '﻿' + lines.join('\r\n');
}

function toJSON(rows) {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: rows }, null, 2);
}

// —— 浏览器：触发文件下载 ——
function download(filename, content, mime) {
  if (typeof document === 'undefined') return; // Node 下不执行
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function dateStamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function reqHeaders(extra) {
  if (typeof window !== 'undefined' && window.Auth && typeof window.Auth.withHeaders === 'function') {
    return window.Auth.withHeaders(extra || {});
  }
  return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
}

// —— 拉全量 items（宽范围，不依赖"无参数默认全量"的实现细节）——
async function fetchAllItems() {
  const url = API_BASE + '/api/items?start=2000-01-01 00:00&end=2100-12-31 23:59';
  const r = await fetch(url, { headers: reqHeaders({}) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) {
    throw new Error((j && j.error && j.error.message) || ('拉取全量日程失败（HTTP ' + r.status + '）'));
  }
  return j.data || [];
}

// 导出 CSV / JSON（浏览器，返回 {ok,count}）
async function exportItems(format) {
  const rows = await fetchAllItems();
  const members = (typeof window !== 'undefined' && window.Auth && typeof window.Auth.members === 'function')
    ? await window.Auth.members() : [];
  const map = {};
  (members || []).forEach((m) => { map[m.id] = m.displayName || ('成员#' + m.id); });
  if (format === 'csv') {
    download('workshop-' + dateStamp() + '.csv', toCSV(rows, map), 'text/csv');
  } else {
    download('workshop-' + dateStamp() + '.json', toJSON(rows), 'application/json');
  }
  return { ok: true, count: rows.length };
}

// —— A8 腾讯文档导出：只发请求，凭证在服务端 ——
async function exportToTencentDoc() {
  const r = await fetch(API_BASE + '/api/export/doc', {
    method: 'POST',
    headers: reqHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  const j = await r.json().catch(() => null);
  if (r.ok && j && j.ok) return { ok: true, url: (j.data && j.data.url) || '' };
  const code = (j && j.error && j.error.code) || r.status;
  const message = (j && j.error && j.error.message) || ('腾讯文档导出失败（HTTP ' + r.status + '）');
  return { ok: false, code, message };
}

const api = { csvCell, fmtTime, toCSV, toJSON, download, exportItems, exportToTencentDoc, CSV_COLUMNS };

if (typeof window !== 'undefined') window.Export2 = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
