'use strict';
// เงินในระบบเป็น "สตางค์" (จำนวนเต็ม) เสมอ — 1 บาท = 100 สตางค์
const { E } = require('./errors');

/** แปลงค่าที่ผู้ใช้กรอก (บาท) เป็นสตางค์ ตรวจสอบรูปแบบเข้มงวด */
function parseBaht(value, field = 'amount') {
  if (value === null || value === undefined || value === '') throw E.validation('กรุณาระบุจำนวนเงิน', { field });
  if (typeof value !== 'string' && typeof value !== 'number') throw E.validation('จำนวนเงินไม่ถูกต้อง', { field });
  // คั่นหลักพันได้เฉพาะตำแหน่งที่ถูกต้อง (1,000 / 10,000.50) — "10,0" ไม่ผ่าน (กันพิมพ์ผิดแล้วกลายเป็นยอดอื่น)
  const raw = String(value).trim();
  if (!/^(\d{1,7}|\d{1,3}(,\d{3}){1,2})(\.\d{1,2})?$/.test(raw)) throw E.validation('จำนวนเงินไม่ถูกต้อง', { field });
  const s = raw.replace(/,/g, '');
  const [whole, frac = ''] = s.split('.');
  const satang = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(satang) || satang <= 0) throw E.validation('จำนวนเงินต้องมากกว่า 0', { field });
  return satang;
}

/** ส่วนลดเป็น basis point (100 bp = 1%) — ปัดเศษส่วนลดลง */
const discountAmount = (satang, bp) => Math.floor((satang * Math.max(0, bp)) / 10000);
const afterDiscount = (satang, bp) => satang - discountAmount(satang, bp);

const toBaht = (satang) => Math.round(satang) / 100;
const fmt = (satang) =>
  (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** แปลง % (เช่น 3.25) เป็น basis point (325) */
function percentToBp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw E.validation('เปอร์เซ็นต์ต้องอยู่ระหว่าง 0 - 100');
  return Math.round(n * 100);
}

module.exports = { parseBaht, discountAmount, afterDiscount, toBaht, fmt, percentToBp };
