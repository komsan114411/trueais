// ตัวช่วยที่ใช้ร่วมกันในหน้าแอดมิน: ไอคอน, ป้ายกำกับ, ตัวแบ่งหน้า, store สถานะระบบ
import { html, raw, api, baht, numFmt, navigate, qs, on } from '../lib.js';

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
export const ACTION_LABELS = {
  'user.register': 'สมัครสมาชิก',
  'user.login': 'เข้าสู่ระบบ',
  'user.locked': 'ล็อกบัญชี (รหัสผ่านผิดเกินกำหนด)',
  'user.password_change': 'เปลี่ยนรหัสผ่าน',
  'user.password_reset': 'แอดมินตั้งรหัสผ่านใหม่',
  'user.suspend': 'ระงับบัญชี',
  'user.activate': 'เปิดใช้งานบัญชี',
  'user.role': 'เปลี่ยนสิทธิ์ผู้ใช้',
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
  'settings.update': 'แก้ไขการตั้งค่าระบบ',
  'provider.reset_breaker': 'เปิดรับรายการทันที (รีเซ็ตตัวหยุดอัตโนมัติ)',
  'apikey.create': 'สร้าง API key',
  'apikey.update': 'แก้ไข API key',
  'apikey.revoke': 'ยกเลิก API key',
  'system.alert': 'แจ้งเตือนจากระบบ',
};

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
  return JSON.stringify(detail);
}

/** ฟังก์ชันเปิดหน้าต่างข้ามโมดูล (กัน import วน): registry.openUser(id), registry.openOrder(ref) */
export const registry = {};

// ───────────── store สถานะระบบ (โหลดทุก 30 วินาที) ─────────────
export const store = {
  dash: null,
  catalog: null,
  listeners: new Set(),
  loading: null,
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const [dash, catalog] = await Promise.all([api.get('/api/admin/dashboard'), api.get('/api/catalog').catch(() => null)]);
        this.dash = dash;
        if (catalog) this.catalog = catalog;
        this.listeners.forEach((fn) => {
          try { fn(dash, catalog); } catch (e) { console.error(e); }
        });
        return dash;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  },
};

export const networkOptions = (selected, { all = true } = {}) => html`
  ${all ? html`<option value="">ทุกเครือข่าย</option>` : ''}
  ${['AIS', 'TRUE', 'DTAC'].map((c) => html`<option value="${c}" ${selected === c ? raw('selected') : ''}>${c === 'TRUE' ? 'True' : c === 'DTAC' ? 'dtac' : 'AIS'}</option>`)}`;

export const opt = (value, label, selected) => html`<option value="${value}" ${String(selected ?? '') === String(value) ? raw('selected') : ''}>${label}</option>`;
