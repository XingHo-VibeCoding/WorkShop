// WorkShop · 阶段二 P9 · 应用层权限判定（acl_phase2.js）
// ---------------------------------------------------------------------------
// 纯函数，无副作用、不碰数据库，便于单测。
// 决策表来源：TECH_DESIGN_phase2.md §6.2 + PRD_phase2.md A5（四类放置权限）。
//
// 角色（members_phase2.role）：
//   member   可编辑（默认）
//   readonly 只读 —— 任何写操作都被拒（本期激活）
//   admin    管理员 —— 库中已实配；patch/delete 对他人项全放行（seam C 落地，
//            配套管理 UI + 单测 + 线上验收见 verify-admin_phase2.js，2026-10-18）
//
// ★ 为什么放应用层（不是 PG RLS）：当前 Bearer 是 service_role，天生绕过 RLS
//   （TECH_DESIGN §6.3 已定调）；要在接口层挡住越权，必须在这里判定。
// ---------------------------------------------------------------------------
'use strict';

const MSG = {
  READONLY: '当前身份为只读，无法修改日程',   // ③ 只读身份任何写操作
  NOT_OWN: '只能修改或删除自己名下的日程',   // member 改/删他人项
};

/**
 * 判定一次写操作是否被允许。
 * @param {object|null} actor 登录成员 { mid, role }；null = 未登录（向后兼容，放行）
 * @param {object} opts
 *   op: 'create' | 'patch' | 'delete'
 *   item: 被改/删的现有事项（patch/delete 必填），含 ownerMemberId
 *   targetOwnerId: create 时指定的归属人 id（给他人放）；不指定 = 自己
 * @returns {{ok:boolean, code?:number, message?:string, ownerMemberId?:number|null, placeFor?:boolean}}
 */
function decideWrite(actor, opts) {
  const op = (opts && opts.op) || 'create';
  const item = opts && opts.item;
  const targetOwnerId = opts && opts.targetOwnerId != null ? Number(opts.targetOwnerId) : null;

  // 未登录：保持 v1.0 行为，放行（只读拦截只在「已登录」时生效，场景自洽）
  if (!actor || actor.mid == null) {
    return { ok: true, ownerMemberId: null, placeFor: false };
  }

  const role = String(actor.role || 'member');
  const mid = Number(actor.mid);

  // ③ 只读：任何写操作一律拒绝（最先判，优先级最高）
  if (role === 'readonly') {
    return { ok: false, code: 403, message: MSG.READONLY };
  }

  if (op === 'create') {
    // ① 给自己放：默认（target 为空或就是自己）
    if (targetOwnerId == null || targetOwnerId === mid) {
      return { ok: true, ownerMemberId: mid, placeFor: false };
    }
    // ② 给他人放：member 允许，调用方必须写 audit（action=place_for）
    return { ok: true, ownerMemberId: targetOwnerId, placeFor: true };
  }

  // patch / delete：必须拥有该事项（或 legacy 无归属），别人的项不可动
  const owner = item && item.ownerMemberId != null ? Number(item.ownerMemberId) : null;
  if (owner == null) {
    return { ok: true };                 // 旧数据（v1.0 匿名写入）无可保护归属人 → 放行
  }
  if (owner === mid) {
    return { ok: true };                 // 自己的项 → 放行
  }
  if (role === 'admin') {
    return { ok: true };                 // admin 全放行（seam C 已落地：库中已实配 admin 账号）
  }
  return { ok: false, code: 403, message: MSG.NOT_OWN };
}

module.exports = { MSG, decideWrite };
