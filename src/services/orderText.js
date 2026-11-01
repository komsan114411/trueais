'use strict';
/**
 * ข้อความของรายการที่ลูกค้า / ร้านค้า (API, webhook, CSV) เห็น
 * — ไม่เปิดเผยชื่อผู้ให้บริการ รหัสภายใน หรือข้อความผิดพลาดของระบบ
 *   (ข้อความเต็มจากผู้ให้บริการยังเก็บไว้ให้แอดมินดูในหน้ารายละเอียดรายการ)
 * ข้อความที่เป็นประโยชน์กับลูกค้า เช่น "หมายเลขปลายทางไม่ถูกต้อง" ยังแสดงได้ตามเดิม
 */
const INTERNAL = /hubzell|wondd|\bmock2?\b|trace|http[_\s]?\d{3}|internal_error|econn|socket|timeout|หมดเวลารอ|เครดิต|ผู้ให้บริการทุกเจ้า|ร้านทุกร้าน|ข้อผิดพลาดระหว่างส่ง|ไม่มีผู้ให้บริการ|ส่งต่อ|พักการส่ง|ไม่ได้ส่งคำขอ|ตั้งค่า|จับคู่|no_mapping|not_configured|ภายในเวลาที่กำหนด/i;

const looksInternal = (msg) => INTERNAL.test(String(msg || ''));

/** ข้อความสรุปผลของรายการ (null = ยังรอผล) */
function customerMessage(o) {
  if (!o) return null;
  if (o.status === 'success') return o.type === 'package' ? 'สมัครแพ็กเกจสำเร็จ' : 'เติมเงินสำเร็จ';
  if (o.status === 'refunded') return 'คืนเงินรายการนี้แล้ว';
  if (o.status !== 'failed') return null;
  const raw = String(o.provider_message || '').trim();
  if (raw && raw.length <= 200 && !looksInternal(raw)) return raw;
  return 'ทำรายการไม่สำเร็จ — คืนเงินเข้ากระเป๋าแล้ว';
}

/** ข้อความในไทม์ไลน์ของรายการที่ลูกค้าเห็น */
function customerEventMessage(e) {
  const msg = String(e?.message || '');
  if (!looksInternal(msg)) return msg;
  if (e.status === 'failed') return 'ไม่สำเร็จ — คืนเงินเข้ากระเป๋าแล้ว';
  if (e.status === 'success') return 'สำเร็จ';
  if (e.status === 'refunded') return 'คืนเงินแล้ว';
  return 'กำลังดำเนินการ';
}

module.exports = { customerMessage, customerEventMessage, looksInternal };
