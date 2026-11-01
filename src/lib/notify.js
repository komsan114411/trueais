'use strict';
// แจ้งเตือนแอดมินผ่าน LINE Messaging API / Telegram (ตั้งค่าใน .env) และบันทึกไว้ในระบบเสมอ
const config = require('../config');
const logger = require('./logger');
const audit = require('../services/audit');

const lastSent = new Map();

async function post(url, headers, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!res.ok) logger.warn(`ส่งแจ้งเตือนไม่สำเร็จ HTTP ${res.status} (${new URL(url).host})`);
  } catch (e) {
    logger.warn(`ส่งแจ้งเตือนไม่สำเร็จ (${new URL(url).host}): ${e.message}`);
  }
}

/**
 * @param {string} key กันส่งเรื่องเดิมซ้ำถี่ๆ (เช่น 'low-balance')
 * @param {string} text ข้อความ
 */
function alertAdmin(key, text, { cooldownSec = 600, level = 'warn' } = {}) {
  const now = Date.now();
  if (key && lastSent.get(key) > now - cooldownSec * 1000) return;
  if (key) {
    lastSent.delete(key);
    lastSent.set(key, now);
    // ทิ้งรายการเก่า ไม่ให้หน่วยความจำโตไม่จำกัด (key ส่วนใหญ่เป็นรายรายการ เช่น review-123)
    if (lastSent.size > 2000) for (const k of [...lastSent.keys()].slice(0, 500)) lastSent.delete(k);
  }
  audit.log(null, 'system.alert', 'alert', key, { text, level });
  logger.warn(`[แจ้งเตือนแอดมิน] ${text}`);
  if (config.isTest) return;
  const msg = `⚠️ ระบบเติมเงิน\n${text}`;
  const n = config.notify;
  if (n.lineToken && n.lineTo) {
    post('https://api.line.me/v2/bot/message/push', { Authorization: `Bearer ${n.lineToken}` }, { to: n.lineTo, messages: [{ type: 'text', text: msg.slice(0, 4900) }] });
  }
  if (n.telegramToken && n.telegramChatId) {
    post(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {}, { chat_id: n.telegramChatId, text: msg.slice(0, 4000) });
  }
}

const channels = () => ({
  line: Boolean(config.notify.lineToken && config.notify.lineTo),
  telegram: Boolean(config.notify.telegramToken && config.notify.telegramChatId),
});

module.exports = { alertAdmin, channels };
