'use strict';
// สร้าง QR พร้อมเพย์ (มาตรฐาน EMVCo / Thai QR Payment) สำหรับรับเงินเข้ากระเป๋า
const QRCode = require('qrcode');

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/**
 * @param {string} target เบอร์มือถือ 10 หลัก / เลขบัตรประชาชน-เลขผู้เสียภาษี 13 หลัก / e-Wallet 15 หลัก
 * @param {number} [amountSatang] จำนวนเงิน (สตางค์) — ถ้าไม่ระบุเป็น QR แบบไม่กำหนดยอด
 */
function promptPayPayload(target, amountSatang) {
  const id = String(target || '').replace(/\D/g, '');
  if (!/^(\d{10}|\d{13}|\d{15})$/.test(id)) throw new Error('หมายเลขพร้อมเพย์ไม่ถูกต้อง');
  let account;
  if (id.length === 15) account = tlv('03', id);
  else if (id.length === 13) account = tlv('02', id);
  else account = tlv('01', `0000000000000${id.replace(/^0/, '66')}`.slice(-13));
  const parts = [
    tlv('00', '01'),
    tlv('01', amountSatang ? '12' : '11'),
    tlv('29', tlv('00', 'A000000677010111') + account),
    tlv('58', 'TH'),
    tlv('53', '764'),
  ];
  if (amountSatang) parts.push(tlv('54', (amountSatang / 100).toFixed(2)));
  const data = `${parts.join('')}6304`;
  return data + crc16(data);
}

async function promptPaySvg(target, amountSatang) {
  const payload = promptPayPayload(target, amountSatang);
  const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 280 });
  return { payload, svg };
}

/**
 * แปลงหมายเลขพร้อมเพย์ที่แอดมินกรอก ให้เป็นตัวเลขล้วนที่สร้าง QR ได้จริง (ไม่ได้ = throw พร้อมเหตุผล)
 *   เบอร์มือถือ 10 หลักขึ้นต้นด้วย 0 (รับ +66 / 66 ได้) · เลขบัตรประชาชน/ผู้เสียภาษี 13 หลัก · e-Wallet 15 หลัก
 */
function normalizePromptPayId(value) {
  let s = String(value ?? '').trim().replace(/[\s-]/g, '');
  if (!s) return '';
  if (s.startsWith('+66')) s = `0${s.slice(3)}`;
  else if (/^66\d{9}$/.test(s)) s = `0${s.slice(2)}`;
  if (!/^\d+$/.test(s)) throw new Error('หมายเลขพร้อมเพย์ต้องเป็นตัวเลขเท่านั้น');
  if (s.length === 10) {
    if (!s.startsWith('0')) throw new Error('เบอร์มือถือพร้อมเพย์ต้องขึ้นต้นด้วย 0 (10 หลัก)');
    return s;
  }
  if (s.length === 13 || s.length === 15) return s;
  throw new Error(`หมายเลขพร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก เลขบัตร 13 หลัก หรือ e-Wallet 15 หลัก (ตอนนี้ ${s.length} หลัก)`);
}

/** แสดงหมายเลขพร้อมเพย์ให้อ่านง่าย (081-234-5678 / 1-2345-67890-12-3) */
function formatPromptPayId(id) {
  const s = String(id || '');
  if (/^\d{10}$/.test(s)) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  if (/^\d{13}$/.test(s)) return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
  return s;
}

module.exports = { promptPayPayload, promptPaySvg, crc16, normalizePromptPayId, formatPromptPayId };
