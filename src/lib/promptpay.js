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

module.exports = { promptPayPayload, promptPaySvg, crc16 };
