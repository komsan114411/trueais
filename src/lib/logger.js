'use strict';
// log แบบอ่านง่าย พร้อมเวลาไทย
const config = require('../config');

function stamp() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, msg, extra) {
  if (config.isTest && level !== 'error') return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra instanceof Error ? extra.stack || extra.message : extra);
  else out(line);
}

module.exports = {
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
