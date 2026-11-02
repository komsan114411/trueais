'use strict';
// แจ้งเตือนแอดมินผ่าน LINE Messaging API / Telegram (ตั้งในหลังบ้าน หรือ .env) และบันทึกไว้ในระบบเสมอ
const config = require('../config');
const logger = require('./logger');
const audit = require('../services/audit');
require('../services/credentials'); // token ที่แอดมินใส่ในหลังบ้าน (ติดตั้งให้ config.notify อ่านได้)

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

async function postResult(url, headers, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true };
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return { ok: false, error: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
  } catch (e) {
    // เช่น ENOTFOUND (หาเซิร์ฟเวอร์ไม่เจอ / ไม่มีอินเทอร์เน็ต), ETIMEDOUT, CERT_... — บอกสาเหตุจริงแทน "fetch failed"
    const code = e.cause?.code || e.code;
    return { ok: false, error: code ? `${e.message} (${code})` : e.message };
  }
}

/** ส่งข้อความทดสอบไปทุกช่องทางที่ตั้งไว้ แล้วบอกผลทีละช่องทาง (ใช้ตรวจว่าตั้งค่า LINE/Telegram ถูกต้อง) */
async function sendTest(text = 'ทดสอบการแจ้งเตือนจากระบบเติมเงิน ✅') {
  const ch = channels();
  const out = [];
  const n = config.notify;
  if (config.isTest) return { configured: ch.line || ch.telegram, channels: [] };
  if (ch.line) out.push({ name: 'LINE', ...(await postResult('https://api.line.me/v2/bot/message/push', { Authorization: `Bearer ${n.lineToken}` }, { to: n.lineTo, messages: [{ type: 'text', text }] })) });
  if (ch.telegram) out.push({ name: 'Telegram', ...(await postResult(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {}, { chat_id: n.telegramChatId, text })) });
  return { configured: ch.line || ch.telegram, channels: out };
}

module.exports = { alertAdmin, channels, sendTest };
