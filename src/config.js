'use strict';
// โหลดค่าตั้งจาก .env และ environment variables ไว้ที่เดียว
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** ค่าตั้งผิด — บอกชื่อตัวแปรใน .env ที่ต้องแก้ (server.js แสดงเป็นข้อความบรรทัดเดียว ไม่มี stack) */
class ConfigError extends Error {
  constructor(envVar, message, cause) {
    super(envVar ? `${envVar} ใน .env: ${message}` : message, cause ? { cause } : undefined);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
    this.envVar = envVar || null;
  }
}

// ───────────── อ่านไฟล์ .env ─────────────
//   KEY=value                 ตัดช่องว่างหัวท้าย (เว้นวรรครอบ = ได้)
//   KEY=value   # หมายเหตุ      ตัดหมายเหตุท้ายบรรทัด — ต้องเว้นวรรคก่อน # (abc#123 ยังเป็นค่าเดิมทั้งหมด)
//   KEY="a #1" หรือ 'a #1'    ใช้ข้อความในเครื่องหมายคำพูดตามนั้น (ข้อความหลังเครื่องหมายปิดถูกตัดทิ้ง)
//   บรรทัดว่าง / บรรทัดที่ขึ้นต้นด้วย #  ข้าม

/** ค่าหลังเครื่องหมาย = ของบรรทัดเดียว */
function parseEnvValue(raw) {
  const s = String(raw ?? '');
  const v = s.trimStart();
  if (v[0] === '"' || v[0] === "'") {
    const end = v.indexOf(v[0], 1);
    if (end > 0) return v.slice(1, end);
    // ไม่มีเครื่องหมายปิด → ถือเป็นค่าธรรมดา
  }
  return s.replace(/\s#.*$/, '').trim();
}

/** แยกข้อความไฟล์ .env ทีละบรรทัด → [{ line, key, value }] (บรรทัดที่ไม่มี = ได้ { line, invalid: true }) */
function parseEnvLines(text) {
  const out = [];
  String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) out.push({ line: i + 1, invalid: true });
    else out.push({ line: i + 1, key: line.slice(0, eq).trim(), value: parseEnvValue(line.slice(eq + 1)) });
  });
  return out;
}

/** { KEY: value } — ตั้งชื่อเดียวกันซ้ำหลายบรรทัด ใช้บรรทัดล่างสุด (เหมือน docker compose) */
const parseEnvText = (text) => Object.fromEntries(parseEnvLines(text).filter((e) => !e.invalid).map((e) => [e.key, e.value]));

/** อ่านไฟล์ข้อความ — รองรับไฟล์ที่ Notepad บันทึกแบบ "Unicode" (UTF-16) ด้วย */
function readTextFile(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

/**
 * โหลด .env เข้า target (ปกติ = process.env) โดยไม่เขียนทับค่าที่ตั้งไว้ใน environment อยู่แล้ว
 * คืน false ถ้าไม่มีไฟล์ — บรรทัดผิดรูปแบบ / ตั้งซ้ำ ใส่ข้อความเตือนไว้ใน warnings
 */
function loadEnvFile(file, target = process.env, warnings = []) {
  if (!fs.existsSync(file)) return false;
  const name = path.basename(file);
  const vars = new Map();
  const lineOf = new Map();
  for (const e of parseEnvLines(readTextFile(file))) {
    if (e.invalid) {
      warnings.push(`${name} บรรทัดที่ ${e.line} ไม่มีเครื่องหมาย = จึงถูกข้าม (รูปแบบที่ถูก: ชื่อ=ค่า)`);
      continue;
    }
    if (lineOf.has(e.key)) {
      warnings.push(`${e.key} ถูกตั้งซ้ำใน ${name} (บรรทัด ${lineOf.get(e.key)} และ ${e.line}) — ระบบใช้ค่าบรรทัดล่าง ควรลบบรรทัดที่ไม่ใช้ออก`);
    }
    lineOf.set(e.key, e.line);
    vars.set(e.key, e.value);
  }
  for (const [key, value] of vars) if (target[key] === undefined) target[key] = value;
  return true;
}

// ───────────── ตรวจค่า ─────────────

/** PORT ต้องเป็นเลขจำนวนเต็ม 1-65535 (ว่าง = ค่าเริ่มต้น) — ผิด = ไม่ยอมเปิดระบบ */
function parsePort(value, def = 3000) {
  const v = String(value ?? '').trim();
  if (!v) return def;
  const n = /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  if (!(n >= 1 && n <= 65535)) {
    throw new ConfigError('PORT', `ต้องเป็นตัวเลข 1-65535 (ตอนนี้ตั้งไว้ "${v.slice(0, 40)}") เช่น PORT=3000`);
  }
  return n;
}

/**
 * สร้างค่าตั้งจากตัวแปร (env) — ไม่แตะ process.env
 *   warnings = ค่าที่ผิดรูปแบบแต่ใช้ค่าเริ่มต้นแทนได้ (server.js แสดงตอนเปิดระบบ)
 *   errors   = ค่าที่ผิดร้ายแรง (server.js ไม่ยอมเปิดระบบ)
 */
function buildConfig(env = process.env) {
  const warnings = [];
  const errors = [];
  const raw = (name) => (env[name] === undefined ? '' : String(env[name]).trim());
  const show = (v) => (v.length > 40 ? `${v.slice(0, 40)}…` : v);
  const str = (v, def = '') => (v === undefined || v === '' ? def : String(v));
  const list = (v) => str(v).split(',').map((s) => s.trim()).filter(Boolean);
  // ตัวเลขจำนวนเต็ม: ว่าง = ค่าเริ่มต้น, ไม่ใช่ตัวเลข = ค่าเริ่มต้น + เตือน, นอกช่วง = ปัดเข้าช่วง + เตือน
  const num = (name, def, { min = -Infinity, max = Infinity } = {}) => {
    const v = raw(name);
    if (!v) return def;
    if (!/^[+-]?\d+$/.test(v)) {
      warnings.push(`${name}=${show(v)} ไม่ใช่ตัวเลขจำนวนเต็ม — ใช้ค่าเริ่มต้น ${def} แทน`);
      return def;
    }
    const n = Number(v);
    if (n >= min && n <= max) return n;
    const fixed = n < min ? min : max;
    const range = max === Infinity ? `ต่ำสุด ${min}` : `${min}-${max}`;
    warnings.push(`${name}=${n} อยู่นอกช่วงที่ใช้ได้ (${range}) — ใช้ ${fixed} แทน`);
    return fixed;
  };
  // รายการ เครือข่าย:ค่า คั่นด้วย , (เช่น AIS:1,DTAC:3) — ใส่เฉพาะเครือข่ายที่ต้องการเปลี่ยน ที่เหลือใช้ค่าเริ่มต้น
  const pairs = (name, defaults, parse, hint) => {
    const out = { ...defaults };
    for (const part of list(env[name])) {
      const m = /^([A-Za-z]+)\s*[:=]\s*(.+)$/.exec(part);
      const net = m ? m[1].toUpperCase() : '';
      const value = m ? parse(m[2].trim().toUpperCase()) : null;
      if (!m || !Object.hasOwn(defaults, net) || value === null) {
        warnings.push(`${name}: "${show(part)}" ไม่ถูกต้อง (ต้องเป็น ${Object.keys(defaults).join('/')}:${hint}) — ข้ามค่านี้`);
        continue;
      }
      out[net] = value;
    }
    return out;
  };
  // เปิด/ปิด: 1/true/yes/on = เปิด, 0/false/no/off = ปิด, ค่าอื่น = ค่าเริ่มต้น + เตือน (กันพิมพ์ผิดแล้วกลายเป็นปิดเงียบๆ)
  const flag = (name, def) => {
    const v = raw(name).toLowerCase();
    if (!v) return def;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    warnings.push(`${name}=${show(v)} ไม่ใช่ค่าเปิด/ปิดที่รู้จัก (ใช้ 1 = เปิด, 0 = ปิด) — ใช้ค่าเริ่มต้น (${def ? 'เปิด' : 'ปิด'}) แทน`);
    return def;
  };

  let port = 3000;
  try {
    port = parsePort(env.PORT);
  } catch (err) {
    errors.push(err);
  }
  const publicUrl = str(env.PUBLIC_URL, `http://localhost:${port}`).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+/i.test(publicUrl)) {
    warnings.push(`PUBLIC_URL=${show(publicUrl)} ต้องขึ้นต้นด้วย http:// หรือ https:// (เช่น https://www.ร้านของคุณ.com) — ไม่อย่างนั้นลิงก์ที่ระบบสร้างจะใช้ไม่ได้`);
  }
  const dataDir = path.resolve(ROOT, str(env.DATA_DIR, 'data'));
  // ฐานข้อมูล: ตั้ง DATABASE_URL = PostgreSQL / เว้นว่าง = SQLite ไฟล์ในเครื่อง (data/topup.db)
  const databaseUrl = str(env.DATABASE_URL).trim();
  if (databaseUrl && !/^postgres(?:ql)?:\/\/\S+$/i.test(databaseUrl)) {
    errors.push(new ConfigError('DATABASE_URL', 'ต้องขึ้นต้นด้วย postgres:// หรือ postgresql:// (เว้นว่าง = ใช้ SQLite ไฟล์ในเครื่อง)'));
  }

  return {
    root: ROOT,
    isTest: env.NODE_ENV === 'test',
    port,
    host: str(env.HOST, '0.0.0.0'),
    publicUrl,
    trustProxy: str(env.TRUST_PROXY),
    dataDir,
    dbFile: path.join(dataDir, str(env.DB_FILE, 'topup.db')),
    databaseUrl,
    uploadDir: path.join(dataDir, 'uploads'),
    isProd: env.NODE_ENV === 'production',
    // DEBUG=1 → แสดงรายละเอียดทางเทคนิค (stack) เมื่อเปิดระบบไม่สำเร็จ
    debug: ['1', 'true', 'yes', 'on'].includes(raw('DEBUG').toLowerCase()),
    sessionDays: num('SESSION_DAYS', 7, { min: 1, max: 365 }),
    // อายุเซสชันสูงสุดนับจากล็อกอิน (ต่ออายุอัตโนมัติไม่ได้เกินนี้) และเวลาที่แอดมินไม่ใช้งานแล้วต้องล็อกอินใหม่
    sessionMaxDays: num('SESSION_MAX_DAYS', 30, { min: 1, max: 365 }),
    adminIdleHours: num('ADMIN_SESSION_IDLE_HOURS', 12, { min: 1, max: 720 }),
    cookieSecure: flag('COOKIE_SECURE', publicUrl.startsWith('https://')),
    // อนุญาตให้ webhook ส่งไป localhost / IP ภายใน (ใช้ตอนทดสอบในเครื่องเท่านั้น)
    webhookAllowPrivate: flag('WEBHOOK_ALLOW_PRIVATE', false),
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
      // ต่ำเกินไป = ทุกรายการ "หมดเวลารอ" (ไม่รู้ผล ต้องให้แอดมินตรวจ) จึงบังคับอย่างน้อย 1 วินาที
      timeoutMs: num('PROVIDER_TIMEOUT_MS', 30000, { min: 1000, max: 300000 }),
      // ส่งพร้อมกันได้กี่รายการ (จำกัดไม่เกิน 10 — ส่งรัวเกินไปผู้ให้บริการอาจบล็อก)
      concurrency: num('PROVIDER_CONCURRENCY', 2, { min: 1, max: 10 }),
      minIntervalMs: num('PROVIDER_MIN_INTERVAL_MS', 300, { min: 0, max: 60000 }),
    },
    hubzell: {
      baseUrl: str(env.HUBZELL_API_URL, 'https://gateway.hubzell.com/api/v1').replace(/\/+$/, ''),
      apiKey: str(env.HUBZELL_API_KEY),
      secret: str(env.HUBZELL_SECRET_KEY),
      // signing secret ของ webhook endpoint (whsec_...) — ใช้เมื่อตั้ง webhook endpoint แทน callback URL
      webhookSecret: str(env.HUBZELL_WEBHOOK_SECRET),
      currency: str(env.HUBZELL_CURRENCY, 'THB').toUpperCase(),
      // HubZell จำกัด 120 ครั้ง/นาที/IP — เราใช้ไม่เกินค่านี้ (เผื่อไว้)
      ratePerMin: num('HUBZELL_RATE_PER_MIN', 100, { min: 1, max: 120 }),
      // ส่งรายการใหม่ไป HubZell พร้อมกันได้สูงสุดกี่รายการ (กันยิงรัวตอนบัญชีมีปัญหา เช่น KYC → HubZell บล็อก IP 24 ชม.)
      maxConcurrent: num('HUBZELL_MAX_CONCURRENT', 2, { min: 1, max: 5 }),
    },
    wondd: {
      baseUrl: str(env.WONDD_API_URL).replace(/\/+$/, ''),
      username: str(env.WONDD_USERNAME),
      apiKey: str(env.WONDD_API_KEY),
      secret: str(env.WONDD_API_SECRET),
      callbackSecret: str(env.WONDD_CALLBACK_SECRET),
      callbackIps: list(env.WONDD_CALLBACK_IPS),
    },
    wepay: {
      apiUrl: str(env.WEPAY_API_URL, 'https://www.wepay.in.th/client_api.json.php').trim(),
      username: str(env.WEPAY_USERNAME).trim(),
      password: str(env.WEPAY_PASSWORD),
      callbackIps: list(env.WEPAY_CALLBACK_IPS),
      // รหัสบริการเติมเงินของ wePAY ต่อเครือข่าย (pay_to_company)
      companies: pairs('WEPAY_COMPANIES', { AIS: '12CALL', DTAC: 'HAPPY', TRUE: 'TRMV' }, (v) => (/^[A-Z0-9-]{2,20}$/.test(v) ? v : null), 'รหัสบริการ (A-Z 0-9 -)'),
      // เงินคืน (%) ที่บัญชี wePAY ได้ต่อเครือข่าย → ต้นทุน = ยอดเติม - เงินคืน (ค่าเริ่มต้นตามหน้า "บริการ" สมาชิกทั่วไป)
      discountBp: pairs('WEPAY_DISCOUNTS', { AIS: 100, DTAC: 300, TRUE: 300 }, (v) => {
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(v)) return null;
        const bp = Math.round(Number(v) * 100);
        return bp <= 3000 ? bp : null;
      }, 'เปอร์เซ็นต์ 0-30 เช่น 3 หรือ 1.5'),
    },
    notify: {
      lineToken: str(env.LINE_CHANNEL_ACCESS_TOKEN),
      lineTo: str(env.LINE_TO),
      telegramToken: str(env.TELEGRAM_BOT_TOKEN),
      telegramChatId: str(env.TELEGRAM_CHAT_ID),
    },
    // 0 = ทุกคำขอถูกปฏิเสธ (เว็บใช้ไม่ได้/ล็อกอินไม่ได้) จึงบังคับอย่างน้อย 1
    limits: {
      registerPerHour: num('REGISTER_LIMIT_PER_HOUR', 10, { min: 1 }),
      loginPerMinute: num('LOGIN_LIMIT_PER_MINUTE', 10, { min: 1 }),
      apiPerMinute: num('API_LIMIT_PER_MINUTE', 600, { min: 1 }),
    },
    // ใช้ในโหมดทดสอบเพื่อให้ worker ทำงานเร็วขึ้น
    workerTickMs: num('WORKER_TICK_MS', 5000, { min: 100, max: 60000 }),
    disableWorker: flag('DISABLE_WORKER', false),
    warnings,
    errors,
  };
}

// ───────────── โหลดจริง ─────────────

const fileWarnings = [];
let fileError = null;
if (process.env.ENV_FILE !== 'none') {
  const file = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env');
  try {
    if (!loadEnvFile(file, process.env, fileWarnings) && process.env.ENV_FILE) {
      fileWarnings.push(`ไม่พบไฟล์ ${file} (ตั้งไว้ใน ENV_FILE) — ใช้ค่าเริ่มต้นทั้งหมด`);
    }
  } catch (err) {
    fileError = new ConfigError(null, `อ่านไฟล์ ${file} ไม่ได้ (${err.code || err.message})`, err);
  }
}

const config = buildConfig(process.env);
config.warnings.unshift(...fileWarnings);
if (fileError) config.errors.unshift(fileError);

// ตัวช่วยสำหรับ server.js / ชุดทดสอบ — ซ่อนไว้ (ไม่ปนกับค่าตั้งเวลาวนดูค่า)
for (const [name, value] of Object.entries({ ConfigError, parseEnvValue, parseEnvLines, parseEnvText, loadEnvFile, parsePort, buildConfig })) {
  Object.defineProperty(config, name, { value });
}

module.exports = config;
