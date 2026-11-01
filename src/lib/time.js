'use strict';
// เวลาประเทศไทย (UTC+7 ไม่มี daylight saving)
const BKK_OFFSET_MS = 7 * 3600 * 1000;

/** เวลาเริ่มต้นของวันนี้ (เวลาไทย) เป็น ISO string แบบ UTC */
function bangkokDayStart(date = new Date()) {
  const shifted = new Date(date.getTime() + BKK_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - BKK_OFFSET_MS).toISOString();
}

/** วันแรกของเดือนนี้ (เวลาไทย) เป็น ISO string แบบ UTC */
function bangkokMonthStart(date = new Date()) {
  const shifted = new Date(date.getTime() + BKK_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - BKK_OFFSET_MS).toISOString();
}

/** วันที่รูปแบบ YYYY-MM-DD ที่มีอยู่จริงในปฏิทิน */
function isValidDay(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** แปลงวันที่ YYYY-MM-DD (เวลาไทย) เป็นช่วง ISO UTC [start, end) — วันที่ไม่ถูกต้อง = แจ้งกลับ (ไม่เงียบๆ แสดงทุกรายการ) */
function bangkokDateRange(from, to) {
  const { E } = require('./errors');
  const out = {};
  if (from) {
    if (!isValidDay(from)) throw E.validation('วันที่เริ่มต้นไม่ถูกต้อง (รูปแบบ ปปปป-ดด-วว)', { field: 'from' });
    out.start = new Date(Date.parse(`${from}T00:00:00Z`) - BKK_OFFSET_MS).toISOString();
  }
  if (to) {
    if (!isValidDay(to)) throw E.validation('วันที่สิ้นสุดไม่ถูกต้อง (รูปแบบ ปปปป-ดด-วว)', { field: 'to' });
    out.end = new Date(Date.parse(`${to}T00:00:00Z`) - BKK_OFFSET_MS + 86400000).toISOString();
  }
  return out;
}

/** วันที่ (เวลาไทย) ในรูปแบบ YYYY-MM-DD */
const bangkokDate = (date = new Date()) => new Date(new Date(date).getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10);

const addSeconds = (sec, from = Date.now()) => new Date(from + sec * 1000).toISOString();

/** วันเวลาไทยแบบ 2026-11-02 14:05:09 (Excel อ่านเป็นวันที่ได้ถูกต้อง — ไม่ใช้ปี พ.ศ.) */
const bangkokDateTime = (iso) => new Date(Date.parse(iso) + BKK_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);

module.exports = { bangkokDayStart, bangkokMonthStart, bangkokDateRange, bangkokDate, bangkokDateTime, addSeconds, isValidDay, BKK_OFFSET_MS };
