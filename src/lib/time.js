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

/** แปลงวันที่ YYYY-MM-DD (เวลาไทย) เป็นช่วง ISO UTC [start, end) */
function bangkokDateRange(from, to) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const out = {};
  if (from && re.test(from)) out.start = new Date(Date.parse(`${from}T00:00:00Z`) - BKK_OFFSET_MS).toISOString();
  if (to && re.test(to)) out.end = new Date(Date.parse(`${to}T00:00:00Z`) - BKK_OFFSET_MS + 86400000).toISOString();
  return out;
}

/** วันที่ (เวลาไทย) ในรูปแบบ YYYY-MM-DD */
const bangkokDate = (date = new Date()) => new Date(new Date(date).getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10);

const addSeconds = (sec, from = Date.now()) => new Date(from + sec * 1000).toISOString();

module.exports = { bangkokDayStart, bangkokMonthStart, bangkokDateRange, bangkokDate, addSeconds, BKK_OFFSET_MS };
