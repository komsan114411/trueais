'use strict';
/**
 * เติมเงินเข้ากระเป๋า: ลูกค้าสร้างรายการ → สแกน QR พร้อมเพย์/โอนเข้าบัญชี → แนบสลิป → แอดมินอนุมัติ → เงินเข้ากระเป๋า
 * - เพิ่มเศษสตางค์สุ่มให้ยอดโอนไม่ซ้ำกัน ช่วยให้แอดมินจับคู่สลิปกับรายการได้ง่าย
 * - อนุมัติได้ครั้งเดียว (unique index ในสมุดบัญชี + เช็กสถานะแบบมีเงื่อนไข)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { parseBaht, fmt } = require('../lib/money');
const { promptPaySvg, formatPromptPayId } = require('../lib/promptpay');
const { alertAdmin } = require('../lib/notify');
const settings = require('./settings');
const wallet = require('./wallet');
const audit = require('./audit');

const STATUS_LABELS = { pending: 'รอตรวจสอบ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' };
const MAX_SLIP_BYTES = 3 * 1024 * 1024;
const MAX_OPEN_DEPOSITS = 3;
const slipDir = () => path.join(config.uploadDir, 'slips');

function publicDeposit(d) {
  return {
    id: d.id,
    amount: d.amount,
    method: d.method,
    status: d.status,
    status_label: STATUS_LABELS[d.status],
    has_slip: Boolean(d.slip_file),
    transfer_at: d.transfer_at,
    note: d.note,
    admin_note: d.admin_note,
    credited_amount: d.credited_amount,
    created_at: d.created_at,
    reviewed_at: d.reviewed_at,
  };
}

/** ข้อมูลบัญชีรับเงินของร้าน (ให้ลูกค้าโอนเองได้ / คัดลอกเลขได้) */
function payTo() {
  const s = settings.all();
  return { promptpay_id: s.promptpay_id ? formatPromptPayId(s.promptpay_id) : null, promptpay_name: s.promptpay_name || null, bank_accounts: s.bank_accounts || null };
}

/** ข้อความเมื่อทำอะไรกับรายการที่ปิดไปแล้วไม่ได้ (บอกเหตุผลตามสถานะจริง) */
function closedMessage(d, who = 'customer') {
  if (d.status === 'approved') return 'รายการนี้อนุมัติแล้ว';
  if (d.status === 'rejected') return who === 'admin' ? 'รายการนี้ถูกปฏิเสธไปแล้ว' : 'รายการนี้ไม่ได้รับการอนุมัติ — ถ้าโอนเงินแล้ว กรุณาติดต่อร้านพร้อมสลิป';
  if (d.expired_at) return who === 'admin' ? 'รายการนี้หมดเวลาแล้ว (ไม่ได้แนบสลิปภายใน 48 ชั่วโมง)' : 'รายการนี้หมดเวลาแล้ว (ไม่ได้แนบสลิปภายใน 48 ชั่วโมง) — ถ้าโอนเงินแล้ว กรุณาติดต่อร้านพร้อมสลิป';
  return who === 'admin' ? 'ลูกค้ายกเลิกรายการนี้แล้ว' : 'รายการนี้ถูกยกเลิกแล้ว — กรุณาสร้างรายการเติมเงินใหม่';
}

async function qrFor(amount) {
  const id = settings.get('promptpay_id');
  if (!id) return null;
  try {
    const { svg, payload } = await promptPaySvg(id, amount);
    return { svg, payload, name: settings.get('promptpay_name') || null };
  } catch {
    return null;
  }
}

async function create(user, { amount, method = 'promptpay', note }) {
  const s = settings.all();
  let satang = parseBaht(amount);
  // ระบบเป็นคนเติมเศษสตางค์ให้เอง — ลูกค้ากรอกเศษเองไม่ได้ (กันกรอกยอดซ้ำกับรายการเก่าที่อนุมัติไปแล้ว)
  if (s.deposit_unique_satang && satang % 100 !== 0) {
    throw E.validation('กรุณากรอกเป็นจำนวนเต็มบาท ระบบจะเพิ่มเศษสตางค์ให้อัตโนมัติเพื่อให้ตรวจยอดโอนได้ถูกต้อง', { field: 'amount' });
  }
  if (satang < s.deposit_min_baht * 100) throw E.validation(`เติมเงินขั้นต่ำ ${s.deposit_min_baht} บาท`, { field: 'amount' });
  if (satang > s.deposit_max_baht * 100) throw E.validation(`เติมเงินได้สูงสุด ${s.deposit_max_baht.toLocaleString('th-TH')} บาทต่อครั้ง`, { field: 'amount' });
  if (!['promptpay', 'bank'].includes(method)) throw E.validation('ช่องทางไม่ถูกต้อง');
  if (method === 'promptpay' && !s.promptpay_id) throw E.validation('ร้านยังไม่ได้ตั้งค่าพร้อมเพย์ กรุณาเลือกโอนเข้าบัญชีธนาคาร');
  if (method === 'promptpay' && !(await qrFor(satang))) {
    // หมายเลขพร้อมเพย์ที่ตั้งไว้สร้าง QR ไม่ได้ → ไม่สร้างรายการที่ลูกค้าจ่ายไม่ได้ + แจ้งแอดมิน
    alertAdmin('promptpay-invalid', 'หมายเลขพร้อมเพย์ที่ตั้งไว้สร้าง QR ไม่ได้ — ลูกค้าเติมเงินด้วยพร้อมเพย์ไม่ได้ กรุณาแก้ที่หน้าตั้งค่า', { cooldownSec: 3600 });
    throw new AppError('PROMPTPAY_NOT_READY', 'ร้านตั้งค่าพร้อมเพย์ไม่ถูกต้อง ยังสร้าง QR ไม่ได้ — กรุณาเลือกโอนเข้าบัญชี หรือติดต่อร้าน', 503);
  }

  // ทำใน transaction: กันกดสร้างพร้อมกันหลายแท็บจนเกินจำนวนที่กำหนด และกันเศษสตางค์ชนกัน
  const dep = db.tx(() => {
    const openIds = db.all("SELECT id FROM deposits WHERE user_id = ? AND status = 'pending' ORDER BY id DESC", user.id).map((r) => r.id);
    if (openIds.length >= MAX_OPEN_DEPOSITS) {
      throw new AppError('DEPOSIT_OPEN_LIMIT', `มีรายการเติมเงินที่ยังไม่เสร็จ ${openIds.length} รายการ — ใช้รายการเดิม (ยังโอนได้) หรือรอแอดมินตรวจสอบก่อน`, 409, { open: openIds });
    }
    if (s.deposit_unique_satang) {
      // สุ่มเศษสตางค์ 1-99 ที่ไม่ซ้ำกับรายการที่รอตรวจ และรายการที่อนุมัติไปใน 48 ชม. ล่าสุด
      // (แอดมินจะได้ไม่สับสนว่ายอดโอนในบัญชีเป็นของรายการไหน)
      const base = satang;
      const since = new Date(Date.now() - 48 * 3600000).toISOString();
      const taken = new Set(db.all(
        "SELECT amount FROM deposits WHERE amount > ? AND amount < ? AND (status = 'pending' OR (status = 'approved' AND reviewed_at >= ?))",
        base, base + 100, since,
      ).map((r) => r.amount));
      const free = [];
      for (let c = 1; c <= 99; c++) if (!taken.has(base + c)) free.push(base + c);
      satang = free.length ? free[crypto.randomInt(0, free.length)] : base + crypto.randomInt(1, 100);
    }
    const now = db.nowIso();
    const r = db.run(
      'INSERT INTO deposits (user_id, amount, method, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, satang, method, String(note || '').trim().slice(0, 200) || null, 'pending', now, now,
    );
    return db.get('SELECT * FROM deposits WHERE id = ?', Number(r.lastInsertRowid));
  });
  return { deposit: publicDeposit(dep), qr: method === 'promptpay' ? await qrFor(satang) : null, pay_to: payTo() };
}

function detectImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function attachSlip(user, depositId, { image, transferAt }) {
  const d = db.get('SELECT * FROM deposits WHERE id = ? AND user_id = ?', Number(depositId), user.id);
  if (!d) throw E.notFound('ไม่พบรายการเติมเงิน');
  if (d.status !== 'pending') throw E.validation(closedMessage(d));
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(image || ''));
  if (!m) throw E.validation('กรุณาแนบรูปสลิป (JPG, PNG หรือ WEBP)', { field: 'image' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_SLIP_BYTES) throw E.validation('รูปสลิปต้องมีขนาดไม่เกิน 3 MB', { field: 'image' });
  const ext = detectImage(buf);
  if (!ext) throw E.validation('ไฟล์ไม่ใช่รูปภาพที่รองรับ', { field: 'image' });
  let when = null;
  if (transferAt) {
    const t = Date.parse(transferAt);
    if (!Number.isFinite(t) || t > Date.now() + 5 * 60000 || t < Date.now() - 7 * 86400000) throw E.validation('เวลาโอนไม่ถูกต้อง', { field: 'transferAt' });
    when = new Date(t).toISOString();
  }
  // กันใช้สลิปใบเดียวกับหลายรายการ (ไฟล์เดียวกันทุกไบต์) — ตรวจกับสลิป "ทุกใบที่เคยแนบ" รวมใบที่ถูกเปลี่ยนออกไปแล้ว
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const used = db.get(
    `SELECT d.id, d.status FROM deposit_slips s JOIN deposits d ON d.id = s.deposit_id
     WHERE s.hash = ? AND d.id != ? AND d.status IN ('approved','pending') ORDER BY d.status = 'approved' DESC, d.id DESC LIMIT 1`,
    hash, d.id,
  );
  if (used) {
    throw E.conflict('SLIP_USED', used.status === 'approved'
      ? 'สลิปนี้เคยใช้เติมเงินไปแล้ว ใช้ซ้ำไม่ได้ หากโอนใหม่กรุณาแนบสลิปของการโอนครั้งใหม่'
      : `สลิปนี้แนบกับรายการเติมเงิน #${used.id} อยู่แล้ว`, { field: 'image' });
  }
  // เคยแนบกับรายการที่ถูกปฏิเสธ/ยกเลิก → ยอมให้แนบ แต่แจ้งแอดมินให้ตรวจละเอียด
  const same = db.get('SELECT deposit_id AS id FROM deposit_slips WHERE hash = ? AND deposit_id != ? ORDER BY id DESC LIMIT 1', hash, d.id);
  fs.mkdirSync(slipDir(), { recursive: true });
  const name = `${d.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(slipDir(), name), buf);
  // เก็บสลิปเดิมไว้ (ไม่ลบ) — แอดมินย้อนดูได้ และใบเดิมจะถูกนำไปใช้กับรายการอื่นไม่ได้
  const now = db.nowIso();
  db.tx(() => {
    db.run('INSERT INTO deposit_slips (deposit_id, hash, file, created_at) VALUES (?, ?, ?, ?)', d.id, hash, name, now);
    db.run('UPDATE deposits SET slip_file = ?, slip_hash = ?, slip_dup_of = ?, transfer_at = COALESCE(?, transfer_at), updated_at = ? WHERE id = ?',
      name, hash, same ? same.id : null, when, now, d.id);
  });
  alertAdmin(`deposit-${d.id}`, `มีรายการเติมเงินเข้ากระเป๋ารอตรวจสอบ ${fmt(d.amount)} บาท (รายการ #${d.id})${same ? ` ⚠️ สลิปเหมือนรายการ #${same.id} ที่เคยถูกปฏิเสธ/ยกเลิก` : ''}`, { cooldownSec: 60 });
  return publicDeposit(db.get('SELECT * FROM deposits WHERE id = ?', d.id));
}

function cancel(user, depositId) {
  const d = db.get('SELECT id, status, slip_file FROM deposits WHERE id = ? AND user_id = ?', Number(depositId), user.id);
  if (!d) throw E.notFound('ไม่พบรายการเติมเงิน');
  // แนบสลิปแล้ว = ลูกค้าบอกว่าโอนแล้ว → ห้ามยกเลิกเอง (ไม่อย่างนั้นแอดมินอนุมัติเงินที่โอนมาไม่ได้)
  if (d.slip_file && d.status === 'pending') throw E.validation('แนบสลิปแล้ว ยกเลิกเองไม่ได้ — แอดมินกำลังตรวจสอบ หากแนบผิดกรุณาติดต่อแอดมิน');
  const r = db.run("UPDATE deposits SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND slip_file IS NULL", db.nowIso(), d.id, user.id);
  if (r.changes !== 1) throw E.validation('ยกเลิกไม่ได้ (รายการอาจถูกตรวจสอบไปแล้ว)');
}

async function getForUser(user, depositId) {
  const d = db.get('SELECT * FROM deposits WHERE id = ? AND user_id = ?', Number(depositId), user.id);
  if (!d) throw E.notFound('ไม่พบรายการเติมเงิน');
  return { deposit: publicDeposit(d), qr: d.status === 'pending' && d.method === 'promptpay' ? await qrFor(d.amount) : null, pay_to: d.status === 'pending' ? payTo() : null };
}

function listForUser(user, { page, pageSize } = {}) {
  const res = db.paged({ select: '*', from: 'deposits', where: ['user_id = ?'], params: [user.id], order: 'id DESC', page, pageSize });
  res.rows = res.rows.map(publicDeposit);
  return res;
}

// ───────────── แอดมิน ─────────────

function listAdmin({ status, q, userId, page, pageSize } = {}) {
  const where = [];
  const params = [];
  if (status === 'waiting') where.push("d.status = 'pending' AND d.slip_file IS NOT NULL");
  else if (status) { where.push('d.status = ?'); params.push(status); }
  if (userId) { where.push('d.user_id = ?'); params.push(Number(userId)); }
  if (q) {
    const text = String(q).trim();
    const like = `%${text.replace(/[%_]/g, '')}%`;
    const digits = text.replace(/[^0-9]/g, '');
    const conds = ['u.name LIKE ?', 'u.phone LIKE ?', 'CAST(d.id AS TEXT) = ?'];
    params.push(like, digits.length >= 3 ? `%${digits}%` : like, text.replace(/^#/, ''));
    // ค้นด้วยยอดเงิน: "100.21" = ตรงทุกสตางค์ · "100" = 100.00 - 100.99 (ยอดมีเศษสตางค์สุ่ม)
    if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(text)) {
      const [whole, frac] = text.replace(/,/g, '').split('.');
      const satang = Number(whole) * 100 + (frac !== undefined ? Number((frac + '00').slice(0, 2)) : 0);
      if (frac !== undefined) { conds.push('d.amount = ?'); params.push(satang); } else { conds.push('d.amount BETWEEN ? AND ?'); params.push(satang, satang + 99); }
    }
    where.push(`(${conds.join(' OR ')})`);
  }
  // amount_dup_of: มีรายการอื่นยอดเดียวกันที่รอตรวจ หรืออนุมัติไปใน 7 วัน → เตือนแอดมินให้ตรวจยอดโอนให้ตรงรายการ
  const res = db.paged({
    select: `d.*, u.name AS user_name, u.phone AS user_phone, r.name AS reviewer_name,
             (SELECT d2.id FROM deposits d2 WHERE d2.amount = d.amount AND d2.id != d.id
                AND (d2.status = 'pending' OR (d2.status = 'approved' AND d2.reviewed_at >= ?)) ORDER BY d2.id DESC LIMIT 1) AS amount_dup_of`,
    from: 'deposits d JOIN users u ON u.id = d.user_id LEFT JOIN users r ON r.id = d.reviewed_by',
    where, params, order: "CASE WHEN d.status = 'pending' THEN 0 ELSE 1 END, d.id DESC", page, pageSize,
    selectParams: [new Date(Date.now() - 7 * 86400000).toISOString()],
  });
  res.rows = res.rows.map((d) => ({
    ...publicDeposit(d), user_id: d.user_id, user_name: d.user_name, user_phone: d.user_phone, reviewer_name: d.reviewer_name,
    // รหัสสลิปที่แอดมินเห็น — ต้องส่งกลับมาตอนอนุมัติ (ลูกค้าเปลี่ยนสลิประหว่างนั้น = อนุมัติไม่ได้ ต้องตรวจใหม่)
    slip_ver: d.slip_hash ? d.slip_hash.slice(0, 12) : null,
    slip_count: db.get('SELECT COUNT(*) AS c FROM deposit_slips WHERE deposit_id = ?', d.id).c,
    expired: Boolean(d.expired_at),
    slip_dup_of: d.slip_dup_of || null,
    amount_dup_of: d.status === 'pending' ? d.amount_dup_of || null : null,
  }));
  return res;
}

function slipPath(depositId) {
  const d = db.get('SELECT slip_file FROM deposits WHERE id = ?', Number(depositId));
  if (!d?.slip_file) throw E.notFound('รายการนี้ยังไม่มีสลิป');
  const file = path.join(slipDir(), path.basename(d.slip_file));
  if (!fs.existsSync(file)) throw E.notFound('ไม่พบไฟล์สลิป');
  return file;
}

function approve(depositId, actor, { amount, note, noSlip = false, confirmOver = false, slipVer, reopen = false } = {}, ip) {
  const d0 = db.get('SELECT * FROM deposits WHERE id = ?', Number(depositId));
  if (!d0) throw E.notFound('ไม่พบรายการเติมเงิน');
  // ห้ามอนุมัติรายการเติมเงินของตัวเอง (กันแอดมินเติมเงินให้ตัวเองโดยไม่มีคนตรวจ)
  if (d0.user_id === actor.id) throw new AppError('SELF_ACTION', 'อนุมัติรายการเติมเงินของตัวเองไม่ได้ — ให้แอดมินคนอื่นตรวจ', 403);
  const reason = String(note || '').trim();
  if (d0.status === 'approved') throw E.validation('รายการนี้อนุมัติไปแล้ว');
  if (d0.status !== 'pending') {
    // หมดเวลา / ถูกปฏิเสธ / ยกเลิกไปแล้ว แต่เงินเข้าบัญชีจริง → เปิดอนุมัติได้เมื่อแอดมินยืนยันพร้อมเหตุผล
    if (!reopen) throw new AppError('DEPOSIT_CLOSED', `${closedMessage(d0, 'admin')} — ถ้าตรวจพบเงินเข้าบัญชีจริง ยืนยันอนุมัติได้ (ต้องระบุหมายเหตุ)`, 409, { status: d0.status, expired: Boolean(d0.expired_at) });
    if (reason.length < 3) throw E.validation('อนุมัติรายการที่ปิดไปแล้ว กรุณาระบุหมายเหตุ เช่น เวลาที่เงินเข้าบัญชี', { field: 'note' });
  }
  // ต้องเป็นสลิปเดียวกับที่แอดมินเปิดดู (ลูกค้าเปลี่ยนสลิประหว่างนั้น = ต้องตรวจใบใหม่ก่อน)
  if (d0.slip_hash && slipVer !== d0.slip_hash.slice(0, 12)) {
    throw new AppError('SLIP_CHANGED', 'ลูกค้าเปลี่ยนสลิปหลังจากที่คุณเปิดดู — กรุณาตรวจสลิปล่าสุดอีกครั้งก่อนอนุมัติ', 409, { slip_ver: d0.slip_hash.slice(0, 12) });
  }
  const credited = amount !== undefined && amount !== null && amount !== '' ? parseBaht(amount) : d0.amount;
  // ไม่มีสลิป → อนุมัติได้เมื่อแอดมินยืนยันว่าตรวจยอดเงินเข้าบัญชีแล้ว + ระบุหมายเหตุ (กันอนุมัติจากยอดโอนของรายการอื่น)
  if (!d0.slip_file) {
    if (!noSlip) throw E.conflict('NO_SLIP', 'รายการนี้ยังไม่มีสลิป — อนุมัติได้เฉพาะเมื่อตรวจพบยอดเงินเข้าบัญชีแล้ว (ต้องยืนยันและระบุหมายเหตุ)');
    if (reason.length < 3) throw E.validation('อนุมัติแบบไม่มีสลิป กรุณาระบุหมายเหตุ เช่น เวลาที่เงินเข้าบัญชี', { field: 'note' });
  }
  if (credited !== d0.amount && reason.length < 3) {
    throw E.validation(`ยอดที่จะเติม (${fmt(credited)} บาท) ไม่ตรงกับยอดที่ลูกค้าแจ้ง (${fmt(d0.amount)} บาท) กรุณาระบุเหตุผลในหมายเหตุ`, { field: 'note' });
  }
  const maxSatang = Math.max(settings.get('deposit_max_baht') * 100, d0.amount);
  if (credited > maxSatang) throw E.validation(`ยอดเติมเกินสูงสุดต่อครั้ง (${fmt(maxSatang)} บาท) กรุณาตรวจตัวเลขอีกครั้ง`, { field: 'amount' });
  if (credited > d0.amount && !confirmOver) {
    throw E.conflict('AMOUNT_OVER_REQUESTED', `ยอดที่จะเติม ${fmt(credited)} บาท มากกว่ายอดที่ลูกค้าแจ้ง ${fmt(d0.amount)} บาท (เกิน ${fmt(credited - d0.amount)} บาท) — ยืนยันอีกครั้งถ้าตรวจยอดเงินเข้าบัญชีแล้ว`, { requested: d0.amount, credited });
  }
  const balance = db.tx(() => {
    const now = db.nowIso();
    const r = db.run(
      "UPDATE deposits SET status = 'approved', credited_amount = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = ?",
      credited, String(note || '').trim().slice(0, 300) || null, actor.id, now, now, d0.id, d0.status,
    );
    if (r.changes !== 1) throw E.validation('รายการนี้ถูกตรวจสอบไปแล้ว (มีการเปลี่ยนแปลงระหว่างนั้น) กรุณารีเฟรช');
    return wallet.credit(d0.user_id, credited, { type: 'deposit', refType: 'deposit', refId: d0.id, note: `เติมเงินเข้ากระเป๋า #${d0.id}`, actorId: actor.id });
  });
  audit.log(actor.id, 'deposit.approve', 'deposit', d0.id, { amount: credited, requested: d0.amount, note, ...(d0.status !== 'pending' ? { reopened_from: d0.status } : {}) }, ip);
  return { deposit: publicDeposit(db.get('SELECT * FROM deposits WHERE id = ?', d0.id)), balance };
}

function reject(depositId, actor, { note } = {}, ip) {
  const reason = String(note || '').trim();
  if (reason.length < 3) throw E.validation('กรุณาระบุเหตุผลที่ไม่อนุมัติ (ลูกค้าจะเห็นข้อความนี้)', { field: 'note' });
  const now = db.nowIso();
  const r = db.run(
    "UPDATE deposits SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    reason.slice(0, 300), actor.id, now, now, Number(depositId),
  );
  if (r.changes !== 1) {
    const cur = db.get('SELECT * FROM deposits WHERE id = ?', Number(depositId));
    throw E.validation(cur ? closedMessage(cur, 'admin') : 'ไม่พบรายการเติมเงิน');
  }
  audit.log(actor.id, 'deposit.reject', 'deposit', Number(depositId), { note: reason }, ip);
  return publicDeposit(db.get('SELECT * FROM deposits WHERE id = ?', Number(depositId)));
}

/** ยกเลิกรายการที่ไม่แนบสลิปภายใน 48 ชม. */
function expireStale() {
  const r = db.run(
    "UPDATE deposits SET status = 'cancelled', admin_note = 'หมดเวลา (ไม่ได้แนบสลิปภายใน 48 ชั่วโมง)', expired_at = ?, updated_at = ? WHERE status = 'pending' AND slip_file IS NULL AND created_at < ?",
    db.nowIso(), db.nowIso(), new Date(Date.now() - 48 * 3600000).toISOString(),
  );
  return r.changes;
}

module.exports = { create, attachSlip, cancel, getForUser, listForUser, listAdmin, slipPath, approve, reject, expireStale, publicDeposit, payTo, STATUS_LABELS };
