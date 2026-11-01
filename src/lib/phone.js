'use strict';
// ตรวจสอบและจัดรูปแบบเบอร์มือถือไทย

/** คืนเบอร์รูปแบบ 0XXXXXXXXX หรือ null ถ้าไม่ถูกต้อง (รองรับ +66 / 66 / มีขีด / เว้นวรรค) */
function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let s = String(input).replace(/[\s\-().]/g, '');
  if (s.startsWith('+66')) s = '0' + s.slice(3).replace(/^0(?=\d{9}$)/, '');
  else if (s.startsWith('660') && s.length === 12) s = '0' + s.slice(3);
  else if (s.startsWith('66') && s.length === 11) s = '0' + s.slice(2);
  if (!/^0[689]\d{8}$/.test(s)) return null;
  return s;
}

const formatPhone = (p) => String(p).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
const maskPhone = (p) => String(p).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-xxx-$3');

module.exports = { normalizePhone, formatPhone, maskPhone };
