'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv } = require('./helpers');

setupEnv();
const { normalizePhone, formatPhone } = require('../src/lib/phone');
const { parseBaht, afterDiscount, percentToBp } = require('../src/lib/money');
const { promptPayPayload } = require('../src/lib/promptpay');
const { toCsv } = require('../src/lib/csv');
const { classifyError } = require('../src/providers/base');
const { bangkokDateRange, bangkokDayStart } = require('../src/lib/time');

test('เบอร์มือถือ: รองรับหลายรูปแบบ และปฏิเสธเบอร์ผิด', () => {
  assert.equal(normalizePhone('0812345678'), '0812345678');
  assert.equal(normalizePhone('081-234-5678'), '0812345678');
  assert.equal(normalizePhone('+66 81 234 5678'), '0812345678');
  assert.equal(normalizePhone('66812345678'), '0812345678');
  assert.equal(normalizePhone('0612345678'), '0612345678');
  assert.equal(normalizePhone('0912345678'), '0912345678');
  assert.equal(normalizePhone('0212345678'), null, 'เบอร์บ้านต้องไม่ผ่าน');
  assert.equal(normalizePhone('081234567'), null, '9 หลักต้องไม่ผ่าน');
  assert.equal(normalizePhone('08123456789'), null, '11 หลักต้องไม่ผ่าน');
  assert.equal(normalizePhone('08x2345678'), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(formatPhone('0812345678'), '081-234-5678');
});

test('จำนวนเงิน: แปลงเป็นสตางค์แบบเข้มงวด', () => {
  assert.equal(parseBaht('100'), 10000);
  assert.equal(parseBaht(100), 10000);
  assert.equal(parseBaht('1,000.50'), 100050);
  assert.equal(parseBaht('0.01'), 1);
  assert.equal(parseBaht('19.9'), 1990);
  for (const bad of ['', '-5', '0', 'abc', '1.234', '1e3', '0x10', '100000000']) {
    assert.throws(() => parseBaht(bad), { code: 'VALIDATION_ERROR' }, `ต้องปฏิเสธ "${bad}"`);
  }
});

test('ส่วนลด: ปัดเศษส่วนลดลง และแปลง % เป็น basis point', () => {
  assert.equal(afterDiscount(10000, 325), 9675); // 100 บาท ลด 3.25% = 96.75
  assert.equal(afterDiscount(1000, 325), 968); // 10 บาท ลด 0.325 → ลด 0.32
  assert.equal(afterDiscount(10000, 0), 10000);
  assert.equal(percentToBp('3.25'), 325);
  assert.throws(() => percentToBp(101));
});

test('QR พร้อมเพย์: ตรงกับมาตรฐาน EMVCo (CRC ถูกต้อง)', () => {
  assert.equal(
    promptPayPayload('0000000000', 422),
    '00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469',
  );
  assert.match(promptPayPayload('0812345678'), /^000201010211.*6304[0-9A-F]{4}$/);
  assert.throws(() => promptPayPayload('123'));
});

test('CSV: กันสูตร Excel อันตราย และรองรับภาษาไทย', () => {
  const csv = toCsv([{ label: 'ชื่อ', key: 'a' }], [{ a: '=HYPERLINK("x")' }, { a: 'ปกติ, มีคอมมา' }]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"ปกติ, มีคอมมา"'));
});

test('แยกประเภท error การเชื่อมต่อ: ต่อไม่ติด = ไม่ได้ส่ง, timeout = ไม่รู้ผล', () => {
  assert.equal(classifyError({ cause: { code: 'ECONNREFUSED' } }).notSent, true);
  assert.equal(classifyError({ cause: { code: 'ENOTFOUND' } }).notSent, true);
  assert.equal(classifyError({ name: 'TimeoutError' }).notSent, false);
  assert.equal(classifyError({ cause: { code: 'ECONNRESET' } }).notSent, false);
  assert.equal(classifyError({ cause: { code: 'UND_ERR_SOCKET' } }).notSent, false);
});

test('เวลาไทย: ช่วงวันที่แปลงเป็น UTC ถูกต้อง', () => {
  const r = bangkokDateRange('2026-11-01', '2026-11-01');
  assert.equal(r.start, '2026-10-31T17:00:00.000Z');
  assert.equal(r.end, '2026-11-01T17:00:00.000Z');
  assert.ok(bangkokDayStart().endsWith('T17:00:00.000Z'));
});

test('WonDD adapter: ก่อนยืนยันคู่มือ ต้องไม่ส่งคำขอและไม่ขยับเงินจากผลที่ไม่แน่ใจ', async () => {
  const wondd = require('../src/providers/wondd');
  const status = wondd.configStatus();
  assert.equal(status.ready, false);
  assert.ok(status.missing.some((m) => m.includes('MAPPING_VERIFIED')));
  const r = await wondd.submit({ ref: 'TPTEST', type: 'topup', phone: '0812345678', face_value: 10000 });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.notSent, true, 'ต้องรู้ว่าไม่ได้ส่ง จึงคืนเงินได้ปลอดภัย');
  // แม้ได้คำตอบว่า success แต่ยังไม่ยืนยัน mapping → unknown (ไม่ขยับเงิน)
  const i = wondd._internal.interpret({ ok: true, status: 200, json: { status: 'success' } }, 'submit');
  assert.equal(i.outcome, 'unknown');
  assert.equal(wondd._internal.mapStatus('0'), 'unknown', 'ห้ามเดารหัสตัวเลข');
  assert.equal(wondd._internal.mapStatus('weird'), 'unknown');
  assert.equal(wondd._internal.interpret({ error: 'timeout', notSent: false }, 'submit').outcome, 'unknown');
  assert.equal(wondd._internal.interpret({ ok: false, status: 503 }, 'submit').outcome, 'unknown');
});
