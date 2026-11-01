// ตัวช่วยที่ใช้ร่วมกันในหน้าแอดมิน: ไอคอน, ป้ายกำกับ, ตัวแบ่งหน้า, store สถานะระบบ,
// การโหลดเบื้องหลัง (ไม่นับเป็นการใช้งาน), ยืนยันตัวตนซ้ำ, ยืนยันการเปลี่ยนผู้ให้บริการ, จำนวนเงินเป็นตัวอักษร
import {
  html, raw, api, ApiError, session, baht, numFmt, navigate, qs, on, modal, confirmDialog, toast, toastError, withLoading,
  showFieldError, clearFieldErrors,
} from '../lib.js';

// ───────────── ไอคอน (SVG เส้น 24×24 วาดเอง) ─────────────
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  orders: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  review: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/><path d="M6 6V5a2 2 0 0 1 2-2h8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  catalog: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  logs: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M4 12.5 9 17.5 20 6.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7"/>',
  play: '<path d="M7 4v16l13-8L7 4z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  store: '<path d="M4 9h16l-1.5-5h-13L4 9z"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
};

export const icon = (name, cls = 'ico') =>
  raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

// ───────────── ป้ายกำกับ ─────────────
export const SOURCE_LABELS = { web: 'หน้าเว็บ', bulk: 'เติมหลายรายการ', api: 'API ร้านค้า' };
export const TYPE_LABELS = { topup: 'เติมเงิน', package: 'แพ็กเกจ' };
export const LEDGER_LABELS = { deposit: 'เติมเงินเข้ากระเป๋า', order: 'ชำระค่ารายการ', refund: 'คืนเงิน', reversal: 'ยกเลิกการคืนเงิน', adjust: 'ปรับยอดโดยแอดมิน' };
export const DEPOSIT_STATUS = {
  pending: ['warning', 'รอตรวจสอบ'],
  approved: ['success', 'อนุมัติแล้ว'],
  rejected: ['danger', 'ไม่อนุมัติ'],
  cancelled: ['', 'ยกเลิก'],
};
export const PLOG_ACTIONS = { submit: 'ส่งรายการ', status: 'เช็กสถานะ', balance: 'เช็กเครดิต', products: 'ดึงรายการสินค้า', callback: 'Callback ขาเข้า' };
// รหัสการกระทำทั้งหมดที่เซิร์ฟเวอร์บันทึก (audit.log ใน src/) → ชื่อภาษาไทยที่อ่านเข้าใจ
export const ACTION_LABELS = {
  'user.register': 'สมัครสมาชิก',
  'user.login': 'เข้าสู่ระบบ',
  'user.locked': 'ล็อกบัญชี (รหัสผ่านผิดเกินกำหนด)',
  'user.locked_ip': 'ล็อกการเข้าสู่ระบบจาก IP (รหัสผ่านผิดเกินกำหนด)',
  'user.unlock': 'ปลดล็อกการใส่รหัสผ่านผิด',
  'user.mfa_failed': 'ใส่รหัสยืนยัน 2 ชั้นผิดตอนเข้าสู่ระบบ',
  'user.reauth_locked': 'ออกจากระบบอัตโนมัติ (ใส่รหัสผ่านยืนยันตัวตนผิดหลายครั้ง)',
  'user.password_change': 'เปลี่ยนรหัสผ่าน',
  'user.password_reset': 'แอดมินตั้งรหัสผ่านใหม่ให้ผู้ใช้',
  'user.2fa_enable': 'เปิดยืนยันตัวตน 2 ชั้น',
  'user.2fa_disable': 'ปิดยืนยันตัวตน 2 ชั้น',
  'user.2fa_reset': 'แอดมินรีเซ็ตการยืนยันตัวตน 2 ชั้นของผู้ใช้',
  'user.suspend': 'ระงับบัญชี',
  'user.activate': 'เปิดใช้งาน / ปลดล็อกบัญชี',
  'user.role': 'เปลี่ยนสิทธิ์ผู้ใช้ (ลูกค้า ↔ แอดมิน)',
  'user.daily_limit': 'ตั้งวงเงินต่อวัน',
  'user.create': 'แอดมินสร้างผู้ใช้',
  'user.admin_bootstrap': 'สร้างแอดมินคนแรก',
  'wallet.adjust': 'ปรับยอดเงินในกระเป๋า',
  'deposit.approve': 'อนุมัติเติมเงินเข้ากระเป๋า',
  'deposit.reject': 'ไม่อนุมัติเติมเงินเข้ากระเป๋า',
  'order.recheck': 'เช็กสถานะรายการ',
  'order.mark_success': 'ยืนยันว่ารายการสำเร็จ',
  'order.mark_failed': 'ยืนยันไม่สำเร็จ / คืนเงิน',
  'order.clear_review': 'ปิดการแจ้งตรวจสอบ',
  'network.update': 'แก้ไขการตั้งค่าเครือข่าย',
  'product.create': 'เพิ่มแพ็กเกจ',
  'product.update': 'แก้ไขแพ็กเกจ',
  'product.delete': 'ลบแพ็กเกจ',
  'product.delete_demo': 'ลบแพ็กเกจตัวอย่าง',
  'product.sync': 'ดึงรายการแพ็กเกจจากผู้ให้บริการ',
  'provider.sync': 'ดึงรายการบริการจากผู้ให้บริการ (จับคู่บริการ)',
  'provider.map': 'บันทึกการจับคู่บริการ',
  'provider.map_enable': 'เปิดใช้การจับคู่บริการ',
  'provider.map_disable': 'ปิดการจับคู่บริการ',
  'provider.map_delete': 'ลบการจับคู่บริการ',
  'provider.create_product': 'สร้างแพ็กเกจจากบริการของผู้ให้บริการ',
  'provider.reset_breaker': 'เปิดรับรายการทันที (รีเซ็ตตัวหยุดอัตโนมัติ)',
  'shop.update': 'แก้ไขชื่อร้าน / ส่วนลดของร้าน',
  'settings.update': 'แก้ไขการตั้งค่าระบบ',
  'apikey.create': 'สร้าง API key',
  'apikey.update': 'แก้ไข API key',
  'apikey.revoke': 'ยกเลิก API key',
  'system.alert': 'แจ้งเตือนจากระบบ',
  'system.backup': 'สำรองข้อมูล',
  'system.backup_download': 'ดาวน์โหลดไฟล์สำรองข้อมูล',
  'system.notify_test': 'ทดสอบการแจ้งเตือน (LINE / Telegram)',
};

/** ผู้กระทำใน log: ไม่มีผู้ใช้ + detail.via = 'cli' → คำสั่งในเครื่อง (สคริปต์ npm run admin) · ไม่มีผู้ใช้อื่นๆ → ระบบ */
export const isCliEntry = (a) => !a?.actor_id && a?.detail && typeof a.detail === 'object' && a.detail.via === 'cli';

/** หมวดของการกระทำ (ค้นแบบขึ้นต้นด้วย — เลือกหมวด = เห็นทุกการกระทำในหมวด) */
export const ACTION_GROUPS = [
  ['order.', 'รายการเติมเงิน / แพ็กเกจ'],
  ['deposit.', 'เติมเงินเข้ากระเป๋า'],
  ['wallet.', 'กระเป๋าเงิน'],
  ['user.', 'ผู้ใช้ / การเข้าสู่ระบบ'],
  ['network.', 'เครือข่าย'],
  ['product.', 'แพ็กเกจ'],
  ['provider.', 'ผู้ให้บริการ / จับคู่บริการ'],
  ['shop.', 'ร้าน (ชื่อ / ส่วนลด)'],
  ['settings.', 'ตั้งค่าระบบ'],
  ['apikey.', 'API ร้านค้า'],
  ['system.', 'ระบบ / แจ้งเตือน / สำรองข้อมูล'],
];

/** ชื่อการกระทำ — รหัสใหม่ที่ยังไม่มีชื่อ แสดงตามหมวดแทนรหัสดิบ */
export function actionLabel(code) {
  if (ACTION_LABELS[code]) return ACTION_LABELS[code];
  const g = ACTION_GROUPS.find(([p]) => String(code || '').startsWith(p));
  return g ? `${g[1]} (อื่นๆ)` : String(code || '-');
}

/** ตัวเลือกสำหรับกรองการกระทำ (จัดเป็นหมวด + "ทั้งหมดในหมวด") */
export function actionOptions(selected) {
  const sel = String(selected ?? '');
  const known = sel === '' || ACTION_GROUPS.some(([p]) => p === sel) || Object.hasOwn(ACTION_LABELS, sel);
  return html`${opt('', 'ทั้งหมด', sel)}${known ? '' : opt(sel, `${actionLabel(sel)} — ${sel}`, sel)}
    ${ACTION_GROUPS.map(([prefix, label]) => html`<optgroup label="${label}">
      ${opt(prefix, `ทั้งหมดในหมวด "${label}"`, sel)}
      ${Object.entries(ACTION_LABELS).filter(([k]) => k.startsWith(prefix)).map(([k, l]) => opt(k, l, sel))}
    </optgroup>`)}`;
}

export function outcomeBadge(outcome) {
  const map = { success: ['success', 'สำเร็จ'], failed: ['danger', 'ไม่สำเร็จ'], processing: ['warning', 'กำลังดำเนินการ'], unknown: ['warning', 'ไม่ทราบผล'] };
  const m = map[outcome];
  return m ? html`<span class="badge ${m[0]}">${m[1]}</span>` : html`<span class="muted">-</span>`;
}

export const roleBadge = (role) => (role === 'admin' ? html`<span class="badge primary plain">แอดมิน</span>` : html`<span class="badge plain">ลูกค้า</span>`);

export function userStatusBadge(u) {
  if (u.status === 'suspended') return html`<span class="badge danger">ระงับ</span>`;
  if (u.locked_until && Date.parse(u.locked_until) > Date.now()) return html`<span class="badge warning">ล็อกชั่วคราว</span>`;
  return html`<span class="badge success">ใช้งาน</span>`;
}

export function depositBadge(status, label) {
  const m = DEPOSIT_STATUS[status] || ['', status];
  return html`<span class="badge ${m[0]}">${label || m[1]}</span>`;
}

/** จำนวนเงินมีเครื่องหมาย +/- (สตางค์) */
export function signedBaht(satang) {
  const n = Number(satang) || 0;
  return html`<span class="${n >= 0 ? 'amount-pos' : 'amount-neg'} num">${n >= 0 ? '+' : '−'}${baht(Math.abs(n))}</span>`;
}

export const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toLocaleString('th-TH', { maximumFractionDigits: 1 })}%` : '-');
export const successRate = (s) => pct(s.success || 0, (s.success || 0) + (s.failed || 0));

// ───────────── แบ่งหน้า ─────────────
export function pagerHtml(res) {
  if (!res || res.total === undefined) return '';
  return html`<div class="pager">
    <span>ทั้งหมด <b class="num">${numFmt(res.total)}</b> รายการ · หน้า ${res.page} / ${res.pages}</span>
    <span class="row">
      <button class="btn sm" data-page="${res.page - 1}" ${res.page <= 1 ? raw('disabled') : ''}>‹ ก่อนหน้า</button>
      <button class="btn sm" data-page="${res.page + 1}" ${res.page >= res.pages ? raw('disabled') : ''}>ถัดไป ›</button>
    </span>
  </div>`;
}

export function bindPager(root, onPage) {
  on(root, 'click', '[data-page]', (e, el) => {
    const p = Number(el.dataset.page);
    if (p >= 1) onPage(p);
  });
}

/** เปลี่ยน query ของหน้าปัจจุบัน (เก็บตัวกรองไว้ใน URL ให้กดย้อนกลับ/รีเฟรชได้) */
export const setQuery = (path, params) => navigate(path + qs(params));

export const emptyRow = (cols, text = 'ไม่มีข้อมูล') => html`<tr class="table-empty"><td colspan="${cols}">${text}</td></tr>`;

/** แสดง JSON สวยๆ ถ้าแปลงได้ (คืนเป็นข้อความธรรมดา — ต้องแสดงผ่าน html`` เท่านั้น) */
export function prettyText(text) {
  if (text === null || text === undefined || text === '') return '';
  if (typeof text !== 'string') return JSON.stringify(text, null, 2);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
export const codeBlock = (text) => html`<pre class="code">${prettyText(text) || '-'}</pre>`;

export function detailText(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  if (detail.text) return detail.text;
  if (typeof detail !== 'object' || Array.isArray(detail)) return JSON.stringify(detail);
  // อ่านง่ายกว่า JSON: บรรทัดละ 1 ค่า (ไม่แสดง via ซึ่งบอกที่มาของคำสั่ง — แสดงในช่องผู้กระทำแล้ว)
  return Object.entries(detail)
    .filter(([k]) => k !== 'via')
    .map(([k, v]) => `${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
}

/** ฟังก์ชันเปิดหน้าต่างข้ามโมดูล (กัน import วน): registry.openUser(id), registry.openOrder(ref) */
export const registry = {};

// ───────────── โหลดข้อมูลเบื้องหลัง (ไม่นับเป็นการใช้งาน) ─────────────
/**
 * GET แบบเบื้องหลัง: ส่ง X-Background: 1 ให้เซิร์ฟเวอร์รู้ว่าเป็นการรีเฟรชอัตโนมัติ (ไม่ต่ออายุเซสชันตอนไม่มีคนใช้งาน)
 * api() ใน lib.js ยังรับ header เพิ่มไม่ได้ จึงเรียก fetch เอง (GET ไม่ต้องใช้ CSRF) และจัดการ error แบบเดียวกัน
 */
export async function apiBackground(path, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  let json = null;
  try {
    try {
      res = await fetch(path, { method: 'GET', headers: { Accept: 'application/json', 'X-Background': '1' }, credentials: 'same-origin', signal: ctrl.signal });
    } catch {
      throw new ApiError('NETWORK', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต');
    }
    try { json = await res.json(); } catch { /* ไม่ใช่ JSON */ }
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !json || json.ok === false) {
    const err = json?.error;
    // เซสชันหมด (เช่น ไม่มีการใช้งานนานเกินกำหนด) → กลับหน้าเข้าสู่ระบบ
    if (res.status === 401 && session.user) {
      session.user = null;
      session.csrf = null;
      window.dispatchEvent(new CustomEvent('session-expired', { detail: { message: err?.message || '' } }));
    }
    throw new ApiError(err?.code || `HTTP_${res.status}`, err?.message || `เกิดข้อผิดพลาด (HTTP ${res.status})`, res.status, err?.details);
  }
  return json.data;
}

/** เลือกวิธีโหลด: เบื้องหลัง (รีเฟรชอัตโนมัติ) หรือปกติ (ผู้ใช้กดเอง) */
export const getData = (path, { background = false } = {}) => (background ? apiBackground(path) : api.get(path));

// ───────────── store สถานะระบบ (โหลดทุก 30 วินาที) ─────────────
export const store = {
  dash: null,
  catalog: null,
  listeners: new Set(),
  loading: null,
  lastAt: 0,
  /** fn(dash, catalog, { background }) — background = true เมื่อเป็นการรีเฟรชอัตโนมัติ (ผู้ฟังควรโหลดแบบเบื้องหลังด้วย) */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  async refresh({ background = false } = {}) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const [dash, catalog] = await Promise.all([getData('/api/admin/dashboard', { background }), getData('/api/catalog', { background }).catch(() => null)]);
        this.dash = dash;
        this.lastAt = Date.now();
        if (catalog) this.catalog = catalog;
        this.listeners.forEach((fn) => {
          try { fn(dash, catalog, { background }); } catch (e) { console.error(e); }
        });
        return dash;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  },
};

// ───────────── จำนวนเงินเป็นตัวอักษร (อ่านทวนก่อนยืนยันยอดสูง) ─────────────
const TH_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const TH_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
function thaiGroup(n, hasHigher) {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const pos = s.length - 1 - i;
    if (d === 0) continue;
    if (pos === 1 && d === 1) out += 'สิบ';
    else if (pos === 1 && d === 2) out += 'ยี่สิบ';
    else if (pos === 0 && d === 1 && (s.length > 1 || hasHigher)) out += 'เอ็ด';
    else out += TH_DIGITS[d] + TH_PLACES[pos];
  }
  return out;
}
function thaiInt(n) {
  if (n === 0) return 'ศูนย์';
  const millions = Math.floor(n / 1e6);
  const rest = n % 1e6;
  return `${millions ? `${thaiInt(millions)}ล้าน` : ''}${rest ? thaiGroup(rest, millions > 0) : ''}`;
}
/** สตางค์ → "หนึ่งหมื่นห้าพันบาทถ้วน" / "หนึ่งร้อยบาทห้าสิบสตางค์" */
export function bahtText(satang) {
  const n = Math.abs(Math.round(Number(satang) || 0));
  const b = Math.floor(n / 100);
  const s = n % 100;
  if (!b && !s) return 'ศูนย์บาทถ้วน';
  return `${b ? `${thaiInt(b)}บาท` : ''}${s ? `${thaiGroup(s, false)}สตางค์` : 'ถ้วน'}`;
}

// ───────────── ลิงก์จากเซิร์ฟเวอร์ ─────────────
/** รับเฉพาะลิงก์ภายในเว็บ: "#/..." (หน้าแอดมิน) หรือ "/..." (หน้าเว็บลูกค้า) — กัน javascript: / เว็บอื่น */
export const safeHref = (link) => (typeof link === 'string' && (/^#\//.test(link) || /^\/(?![/\\])/.test(link)) ? link : null);
/** ลิงก์ไปหน้าเว็บลูกค้า (นอกหลังบ้าน) → เปิดแท็บใหม่ */
export const isCustomerLink = (link) => typeof link === 'string' && link.startsWith('/');

/** ชื่อผู้ให้บริการแบบสั้น: "WonDD (ใช้งานจริง)" → "WonDD" */
export const shortLabel = (p) => String(p?.label || p?.name || 'ผู้ให้บริการ').replace(/\s*\([^)]*\)\s*$/, '') || 'ผู้ให้บริการ';

// ───────────── ยืนยันตัวตนซ้ำ (จัดการบัญชีแอดมิน / ให้สิทธิ์แอดมิน) ─────────────
/**
 * ส่งคำขอที่เซิร์ฟเวอร์อาจขอให้ยืนยันตัวตนซ้ำ (403 REAUTH_REQUIRED) — ถามรหัสผ่าน (+ รหัส 6 หลัก) แล้วส่งใหม่
 * send(extra) → Promise · extra = {} ครั้งแรก จากนั้น { actor_password, actor_code? }
 * คืนผลของ send หรือ null ถ้าผู้ใช้กดยกเลิก (error อื่นโยนต่อ)
 */
export async function withReauth(send, { what = '' } = {}) {
  try {
    return await send({});
  } catch (err) {
    if (err?.code !== 'REAUTH_REQUIRED') throw err;
    return reauthDialog(send, { totp: Boolean(err.details?.totp), what });
  }
}

function reauthDialog(send, { totp, what }) {
  const me = session.user || {};
  return modal({
    title: 'ยืนยันตัวตนก่อนทำรายการ',
    body: html`<form class="stack" data-reauth novalidate autocomplete="on">
      <div class="alert warning"><span class="alert-icon">!</span><div>${what ? html`<b>${what}</b><br>` : ''}การกระทำนี้มีผลกับบัญชีแอดมิน จึงต้องยืนยันว่าเป็นคุณจริง —
        ใส่รหัสผ่าน${totp ? 'และรหัส 6 หลักจากแอปยืนยันตัวตน' : ''}ของบัญชีที่คุณใช้อยู่ตอนนี้${me.email || me.name ? html` (<b>${me.email || me.name}</b>)` : ''}</div></div>
      <div class="field"><label for="ra-pw">รหัสผ่านของคุณ</label>
        <input class="input" id="ra-pw" name="actor_password" type="password" autocomplete="current-password" required><div class="error-text"></div></div>
      ${totp ? html`<div class="field"><label for="ra-code">รหัส 6 หลักจากแอปยืนยันตัวตน</label>
        <input class="input lg" id="ra-code" name="actor_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><div class="error-text"></div></div>` : ''}
      <p class="xsmall muted mb-0">ใส่รหัสผ่านผิดหลายครั้ง ระบบจะออกจากระบบเครื่องนี้ให้เพื่อความปลอดภัย</p>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>${icon('shield')}ยืนยันและทำรายการ</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-reauth]');
      const pw = form.querySelector('[name="actor_password"]');
      const code = form.querySelector('[name="actor_code"]');
      const btn = dlg.querySelector('[data-ok]');
      code?.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });
      const submit = (e) => {
        e?.preventDefault();
        clearFieldErrors(form);
        if (!pw.value) { showFieldError(form, { message: 'กรุณาใส่รหัสผ่าน', details: { field: 'actor_password' } }); return; }
        if (code && !/^\d{6}$/.test(code.value)) { showFieldError(form, { message: 'กรุณาใส่รหัส 6 หลัก', details: { field: 'actor_code' } }); return; }
        withLoading(btn, async () => {
          try {
            close({ ok: true, value: await send({ actor_password: pw.value, ...(code ? { actor_code: code.value } : {}) }) });
          } catch (err) {
            if (err?.code === 'REAUTH_REQUIRED' && err.details?.totp && !code) { close({ retryTotp: true }); return; } // ต้องใช้รหัส 6 หลักด้วย
            if (err?.code === 'REAUTH_FAILED' || err?.code === 'REAUTH_REQUIRED') {
              const field = err.details?.field === 'actor_code' && code ? 'actor_code' : 'actor_password';
              if (code) code.value = ''; // รหัส 6 หลักใช้ซ้ำไม่ได้
              showFieldError(form, { message: err.message, details: { field } });
              if (field === 'actor_password') pw.select();
              return;
            }
            close({ ok: false, error: err });
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      pw.focus();
    },
  }).then((r) => {
    if (!r) return null; // ยกเลิก
    if (r.retryTotp) return reauthDialog(send, { totp: true, what });
    if (r.ok) return r.value;
    throw r.error;
  });
}

// ───────────── ยืนยันการเปลี่ยนการเลือกผู้ให้บริการ (ใช้ทั้งหน้าผู้ให้บริการและหน้าตั้งค่า) ─────────────
export const ROUTING_KEYS = ['routing_mode', 'failover_enabled', 'provider_priority', 'providers_disabled'];
const ROUTING_MODE_LABELS = { priority: 'ตามลำดับ (เจ้าแรกก่อน เจ้าถัดไปเป็นสำรอง)', cheapest: 'ต้นทุนต่ำสุดก่อน' };

/**
 * changed = { key: ค่าใหม่ } เฉพาะคีย์ที่เปลี่ยน · values = ค่าเดิม · providers = รายชื่อเจ้า (แสดงชื่อแทนรหัส)
 * คืน true ถ้าไม่มีอะไรต้องยืนยัน หรือผู้ใช้กดยืนยัน
 */
export async function confirmRoutingChange(changed, { values = {}, providers = [] } = {}) {
  const keys = ROUTING_KEYS.filter((k) => k in changed);
  if (!keys.length) return true;
  const nameOf = (n) => { const p = providers.find((x) => x.name === n); return p ? `${shortLabel(p)} (${n})` : n; };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map(nameOf).join(' → ');
  const lines = [];
  let danger = false;
  if ('providers_disabled' in changed) {
    const next = String(changed.providers_disabled || '');
    if (next) danger = true;
    lines.push(html`<li><b>ปิดใช้ผู้ให้บริการชั่วคราว:</b> ${next ? String(next).split(',').filter(Boolean).map(nameOf).join(', ') : 'ไม่มี — เปิดใช้ทุกเจ้า'}
      ${next ? html`<div class="small text-danger">รายการใหม่จะไม่ถูกส่งไปเจ้าที่ปิด (รายการที่ส่งไปแล้วยังติดตามผลตามปกติ)</div>` : ''}</li>`);
  }
  if ('failover_enabled' in changed) {
    if (changed.failover_enabled === false) {
      danger = true;
      lines.push(html`<li><b>ปิดการสลับไปเจ้าสำรองอัตโนมัติ</b><div class="small text-danger">ถ้าเจ้าที่เลือกไม่รับรายการ รายการจะไม่สำเร็จและคืนเงินลูกค้า (ไม่ส่งต่อเจ้าอื่น)</div></li>`);
    } else {
      lines.push(html`<li><b>เปิดการสลับไปเจ้าสำรองอัตโนมัติ</b><div class="small text-2">สลับเฉพาะกรณีมั่นใจว่าเจ้าแรกยังไม่ได้ทำรายการ</div></li>`);
    }
  }
  if ('routing_mode' in changed) {
    lines.push(html`<li><b>วิธีเลือกผู้ให้บริการ:</b> ${ROUTING_MODE_LABELS[values.routing_mode] || values.routing_mode || '-'} → <b>${ROUTING_MODE_LABELS[changed.routing_mode] || changed.routing_mode}</b></li>`);
  }
  if ('provider_priority' in changed) {
    lines.push(html`<li><b>ลำดับผู้ให้บริการ:</b> ${list(values.provider_priority) || '(ตามไฟล์ .env)'} → <b>${list(changed.provider_priority) || '(ตามไฟล์ .env)'}</b>
      <div class="small text-2">เจ้าแรกได้รับรายการใหม่ก่อน</div></li>`);
  }
  return confirmDialog({
    title: 'ยืนยันเปลี่ยนการเลือกผู้ให้บริการ',
    body: html`<ul class="check-list">${lines}</ul><p class="small mb-0 mt-2"><b>มีผลกับรายการใหม่ของลูกค้าทันที</b> — ตรวจให้แน่ใจก่อนบันทึก</p>`,
    confirmText: 'บันทึกการเลือกผู้ให้บริการ',
    danger,
  });
}

// ───────────── ทดสอบการแจ้งเตือน LINE / Telegram ─────────────
export function testNotify(btn) {
  return withLoading(btn, async () => {
    try {
      const r = await api.post('/api/admin/notify/test', {});
      if (!r?.configured) {
        toast('ยังไม่ได้ตั้งค่า LINE หรือ Telegram ในไฟล์ .env — ระบบยังส่งข้อความแจ้งเตือนไม่ได้', 'warning', 8000);
        return;
      }
      const list = Array.isArray(r.channels) ? r.channels : [];
      const okAll = list.length > 0 && list.every((c) => c.ok);
      modal({
        title: 'ผลการส่งข้อความทดสอบ',
        body: html`<div class="stack">
          ${list.length ? html`<ul class="golive-list">${list.map((c) => html`<li class="${c.ok ? 'gl-ok' : 'gl-warn'}"><span class="gl-mark" aria-hidden="true">${c.ok ? '✓' : '✕'}</span>
            <span class="gl-txt"><b>${c.name}</b> — ${c.ok ? 'ส่งแล้ว' : html`<span class="text-danger">ส่งไม่สำเร็จ: ${c.error || '-'}</span>`}</span></li>`)}</ul>`
            : html`<p class="mb-0 muted">ไม่มีช่องทางที่ส่งได้</p>`}
          <p class="small mb-0">${okAll ? 'เปิดแอป LINE / Telegram ในโทรศัพท์ ตรวจว่าได้รับข้อความ "ทดสอบการแจ้งเตือน" — ถ้าไม่ได้รับ ให้ตรวจผู้รับในไฟล์ .env'
            : 'ตรวจค่า token / ผู้รับในไฟล์ .env แล้วรีสตาร์ทระบบ จากนั้นกดทดสอบอีกครั้ง'}</p></div>`,
        foot: html`<button class="btn primary" data-close>ตกลง</button>`,
      });
    } catch (err) { toastError(err); }
  });
}

export const networkOptions = (selected, { all = true } = {}) => html`
  ${all ? html`<option value="">ทุกเครือข่าย</option>` : ''}
  ${['AIS', 'TRUE', 'DTAC'].map((c) => html`<option value="${c}" ${selected === c ? raw('selected') : ''}>${c === 'TRUE' ? 'True' : c === 'DTAC' ? 'dtac' : 'AIS'}</option>`)}`;

export const opt = (value, label, selected) => html`<option value="${value}" ${String(selected ?? '') === String(value) ? raw('selected') : ''}>${label}</option>`;
