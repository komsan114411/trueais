'use strict';
// บันทึกการกระทำสำคัญ (ใครทำอะไร เมื่อไหร่) — ตรวจย้อนหลังได้ในหน้าแอดมิน
const db = require('../db');

function log(actorId, action, targetType = null, targetId = null, detail = null, ip = null) {
  try {
    db.run(
      'INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      actorId ?? null, action, targetType, targetId === null ? null : String(targetId),
      detail === null ? null : JSON.stringify(detail).slice(0, 4000), ip, db.nowIso(),
    );
  } catch {
    // ห้ามทำให้งานหลักล้ม
  }
}

function list({ page, pageSize, action, actorId } = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('a.action LIKE ?'); params.push(`${String(action).replace(/[%_]/g, '')}%`); }
  if (actorId) { where.push('a.actor_id = ?'); params.push(Number(actorId)); }
  const res = db.paged({
    select: 'a.*, u.name AS actor_name, u.email AS actor_email',
    from: 'audit_logs a LEFT JOIN users u ON u.id = a.actor_id',
    where, params, order: 'a.id DESC', page, pageSize,
  });
  res.rows = res.rows.map((r) => ({ ...r, detail: r.detail ? safeParse(r.detail) : null }));
  return res;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = { log, list };
