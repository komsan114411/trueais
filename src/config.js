'use strict';
// โหลดค่าตั้งจาก .env และ environment variables ไว้ที่เดียว
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ตัวอ่าน .env แบบง่าย: ไม่เขียนทับค่าที่ตั้งไว้ใน environment อยู่แล้ว
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (process.env.ENV_FILE !== 'none') {
  loadEnvFile(process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env'));
}

const env = process.env;
const str = (v, def = '') => (v === undefined || v === '' ? def : String(v));
const int = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const list = (v) => str(v).split(',').map((s) => s.trim()).filter(Boolean);

const port = int(env.PORT, 3000);
const publicUrl = str(env.PUBLIC_URL, `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = path.resolve(ROOT, str(env.DATA_DIR, 'data'));

const config = {
  root: ROOT,
  isTest: env.NODE_ENV === 'test',
  port,
  host: str(env.HOST, '0.0.0.0'),
  publicUrl,
  trustProxy: str(env.TRUST_PROXY),
  dataDir,
  dbFile: path.join(dataDir, str(env.DB_FILE, 'topup.db')),
  uploadDir: path.join(dataDir, 'uploads'),
  isProd: env.NODE_ENV === 'production',
  sessionDays: Math.max(1, int(env.SESSION_DAYS, 7)),
  // อายุเซสชันสูงสุดนับจากล็อกอิน (ต่ออายุอัตโนมัติไม่ได้เกินนี้) และเวลาที่แอดมินไม่ใช้งานแล้วต้องล็อกอินใหม่
  sessionMaxDays: Math.max(1, int(env.SESSION_MAX_DAYS, 30)),
  adminIdleHours: Math.max(1, int(env.ADMIN_SESSION_IDLE_HOURS, 12)),
  cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith('https://')),
  // อนุญาตให้ webhook ส่งไป localhost / IP ภายใน (ใช้ตอนทดสอบในเครื่องเท่านั้น)
  webhookAllowPrivate: bool(env.WEBHOOK_ALLOW_PRIVATE, false),
  // none = ห้ามฝังใน iframe, self = ฝังได้เฉพาะเว็บนี้, หรือระบุโดเมน เช่น https://www.myshop.com
  frameAncestors: (() => {
    const v = str(env.FRAME_ANCESTORS, 'none').trim();
    if (v === 'none' || v === "'none'") return "'none'";
    if (v === 'self' || v === "'self'") return "'self'";
    return v.split(/[\s,]+/).filter((o) => /^https?:\/\/[^\s'";]+$/.test(o)).join(' ') || "'none'";
  })(),
  orderRefPrefix: str(env.ORDER_REF_PREFIX, 'TP').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4) || 'TP',
  admin: {
    email: str(env.ADMIN_EMAIL),
    password: str(env.ADMIN_PASSWORD),
    name: str(env.ADMIN_NAME, 'ผู้ดูแลระบบ'),
  },
  provider: {
    name: str(env.PROVIDER, 'mock').toLowerCase(),
    // ผู้ให้บริการหลายเจ้า เรียงตามลำดับความสำคัญ เช่น PROVIDERS=hubzell,wondd (ไม่ตั้ง = ใช้ PROVIDER เจ้าเดียว)
    list: (env.PROVIDERS ? list(env.PROVIDERS) : [str(env.PROVIDER, 'mock')]).map((s) => s.toLowerCase()),
    timeoutMs: int(env.PROVIDER_TIMEOUT_MS, 30000),
    // ส่งพร้อมกันได้กี่รายการ (จำกัดไม่เกิน 10 — ส่งรัวเกินไปผู้ให้บริการอาจบล็อก)
    concurrency: Math.min(10, Math.max(1, int(env.PROVIDER_CONCURRENCY, 2))),
    minIntervalMs: Math.max(0, int(env.PROVIDER_MIN_INTERVAL_MS, 300)),
  },
  hubzell: {
    baseUrl: str(env.HUBZELL_API_URL, 'https://gateway.hubzell.com/api/v1').replace(/\/+$/, ''),
    apiKey: str(env.HUBZELL_API_KEY),
    secret: str(env.HUBZELL_SECRET_KEY),
    // signing secret ของ webhook endpoint (whsec_...) — ใช้เมื่อตั้ง webhook endpoint แทน callback URL
    webhookSecret: str(env.HUBZELL_WEBHOOK_SECRET),
    currency: str(env.HUBZELL_CURRENCY, 'THB').toUpperCase(),
    // HubZell จำกัด 120 ครั้ง/นาที/IP — เราใช้ไม่เกินค่านี้ (เผื่อไว้)
    ratePerMin: Math.min(120, Math.max(1, int(env.HUBZELL_RATE_PER_MIN, 100))),
    // ส่งรายการใหม่ไป HubZell พร้อมกันได้สูงสุดกี่รายการ (กันยิงรัวตอนบัญชีมีปัญหา เช่น KYC → HubZell บล็อก IP 24 ชม.)
    maxConcurrent: Math.min(5, Math.max(1, int(env.HUBZELL_MAX_CONCURRENT, 2))),
  },
  wondd: {
    baseUrl: str(env.WONDD_API_URL).replace(/\/+$/, ''),
    username: str(env.WONDD_USERNAME),
    apiKey: str(env.WONDD_API_KEY),
    secret: str(env.WONDD_API_SECRET),
    callbackSecret: str(env.WONDD_CALLBACK_SECRET),
    callbackIps: list(env.WONDD_CALLBACK_IPS),
  },
  notify: {
    lineToken: str(env.LINE_CHANNEL_ACCESS_TOKEN),
    lineTo: str(env.LINE_TO),
    telegramToken: str(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: str(env.TELEGRAM_CHAT_ID),
  },
  limits: {
    registerPerHour: int(env.REGISTER_LIMIT_PER_HOUR, 10),
    loginPerMinute: int(env.LOGIN_LIMIT_PER_MINUTE, 10),
    apiPerMinute: int(env.API_LIMIT_PER_MINUTE, 600),
  },
  // ใช้ในโหมดทดสอบเพื่อให้ worker ทำงานเร็วขึ้น
  workerTickMs: int(env.WORKER_TICK_MS, 5000),
  disableWorker: bool(env.DISABLE_WORKER, false),
};

module.exports = config;
