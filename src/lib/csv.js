'use strict';
// สร้างไฟล์ CSV ที่เปิดใน Excel แล้วภาษาไทยไม่เพี้ยน (มี BOM)

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // กันสูตร Excel อันตราย (CSV injection) — ยกเว้นตัวเลขล้วน เช่น -3.50 (ให้ Excel รวมยอดได้)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows, { note } = {}) {
  const lines = [headers.map((h) => cell(h.label)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => cell(typeof h.value === 'function' ? h.value(r) : r[h.key])).join(','));
  if (note) lines.push(cell(note)); // เช่น แจ้งว่าแสดงไม่ครบทุกรายการ
  return `﻿${lines.join('\r\n')}\r\n`;
}

function sendCsv(res, filename, headers, rows, opts = {}) {
  // ชื่อไฟล์ใช้ได้เฉพาะอักขระปลอดภัย (กัน header เสีย/ถูกแทรกค่า)
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'export.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  if (opts.note) res.setHeader('X-Export-Truncated', '1');
  res.send(toCsv(headers, rows, opts));
}

module.exports = { toCsv, sendCsv };
