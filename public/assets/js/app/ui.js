// ชิ้นส่วน UI ที่ใช้ซ้ำหลายหน้า
import { html, raw, baht, phoneFmt, timeAgo, statusBadge } from '../lib.js';
import { networkOf, safeColor, shopNote } from './state.js';
import { icon } from './icons.js';

/** ราคาหลังส่วนลด (สูตรเดียวกับฝั่งเซิร์ฟเวอร์: ปัดเศษส่วนลดลง) */
export const priceAfter = (satang, bp) => satang - Math.floor((satang * Math.max(0, Number(bp) || 0)) / 10000);

export const typeLabel = (t) => (t === 'package' ? 'แพ็กเกจ' : 'เติมเงิน');

export function netTag(code) {
  const n = networkOf(code);
  return html`<span class="net-badge" style="--net:${raw(safeColor(n?.color))}">${n?.name || code}</span>`;
}

export function pageHead(title, sub = '', actions = '') {
  return html`<div class="page-head">
    <div class="grow"><h1>${title}</h1>${sub ? html`<p class="muted mb-0">${sub}</p>` : ''}</div>
    ${actions ? html`<div class="row wrap page-actions">${actions}</div>` : ''}
  </div>`;
}

export function alertBox(type, content) {
  const ic = type === 'danger' || type === 'warning' ? 'alert' : type === 'success' ? 'check' : 'info';
  return html`<div class="alert ${type}"><span class="alert-icon">${icon(ic, 18)}</span><div class="grow alert-body">${content}</div></div>`;
}

export function emptyState(iconName, title, sub = '', action = '') {
  return html`<div class="empty">
    <div class="empty-icon">${icon(iconName, 38)}</div>
    <div class="bold text-2">${title}</div>
    ${sub ? html`<div class="small mt-1">${sub}</div>` : ''}
    ${action ? html`<div class="mt-2">${action}</div>` : ''}
  </div>`;
}

export function pager({ page, pages, total }) {
  if (!total) return '';
  return html`<div class="pager">
    <span>${pages > 1 ? html`หน้า ${page}/${pages} · ` : ''}ทั้งหมด ${total.toLocaleString('th-TH')} รายการ</span>
    ${pages > 1 ? html`<div class="row" style="--gap:6px">
      <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>ก่อนหน้า</button>
      <button class="btn sm" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>ถัดไป</button>
    </div>` : ''}
  </div>`;
}

/** การ์ดรายการ (ใช้ในหน้าแรก / ประวัติบนมือถือ) */
export function orderItem(o) {
  return html`<a class="order-item" href="#/order/${o.ref}">
    <span class="oi-icon" style="--net:${raw(safeColor(networkOf(o.network)?.color))}">${icon(o.type === 'package' ? 'wifi' : 'bolt', 18)}</span>
    <span class="oi-main">
      <span class="oi-title">${o.product_name}</span>
      <span class="oi-sub"><span class="num">${phoneFmt(o.phone)}</span> · ${timeAgo(o.created_at)}${shopNote(o) ? ` · ร้าน ${shopNote(o)}` : ''}</span>
    </span>
    <span class="oi-side"><span class="oi-price num">฿${baht(o.price)}</span>${statusBadge(o.status)}</span>
  </a>`;
}

/** ลิงก์สำหรับ "ทำรายการซ้ำ" (เติมเดิมอีกครั้ง) */
export function reorderPath(o) {
  const shop = o.shop ? `&shop=${encodeURIComponent(o.shop)}` : ''; // ร้านเดิมที่ลูกค้าเลือก (ถ้ายังเปิดอยู่)
  if (o.type === 'package') {
    return `/packages?network=${encodeURIComponent(o.network)}&phone=${encodeURIComponent(o.phone)}${o.product_id ? `&product=${o.product_id}` : ''}${shop}`;
  }
  return `/topup?network=${encodeURIComponent(o.network)}&phone=${encodeURIComponent(o.phone)}&amount=${Math.round(o.face_value / 100)}${shop}`;
}

export function skeletonPage() {
  return html`<div class="sk-page">
    <div class="skeleton sk-title"></div>
    <div class="skeleton sk-line"></div>
    <div class="skeleton sk-card"></div>
    <div class="skeleton sk-card"></div>
  </div>`;
}

export function errorView(err) {
  return emptyState('alert', 'เกิดข้อผิดพลาด', err?.message || 'โหลดข้อมูลไม่สำเร็จ', html`<button class="btn primary" data-reload>${icon('refresh', 18)} ลองใหม่</button>`);
}

// เบอร์ทดสอบของโหมดจำลอง (ดูจาก 4 หลักท้าย)
export const MOCK_NUMBERS = [
  { phone: '0812340000', label: 'ผู้ให้บริการปฏิเสธ → ไม่สำเร็จ + คืนเงินอัตโนมัติ', cls: 'danger' },
  { phone: '0812341111', label: 'Timeout → ระบบตรวจสถานะเองแล้วพบว่าสำเร็จ (ไม่ส่งซ้ำ)', cls: 'warning' },
  { phone: '0812342222', label: 'ค้างสถานะ → ส่งให้แอดมินตรวจสอบ', cls: 'warning' },
  { phone: '0812343333', label: 'รับเรื่องแล้ว ภายหลังแจ้งไม่สำเร็จ → คืนเงิน', cls: 'danger' },
  { phone: '0812344444', label: 'เชื่อมต่อไม่ได้ → คืนเงินทันที', cls: 'danger' },
  { phone: '0812345555', label: 'รับเรื่องแล้ว ภายหลังแจ้งสำเร็จ (callback)', cls: 'success' },
];

export function mockTips({ fill = true } = {}) {
  return html`<details class="mock-tip">
    <summary>${icon('flask', 18)} โหมดทดสอบ: เบอร์พิเศษสำหรับทดลองกรณีต่างๆ <span class="mock-caret">${icon('chevronRight', 16)}</span></summary>
    <p class="small text-2 mt-1 mb-1">ระบบยังไม่ได้เชื่อม WonDD จริง ทุกรายการเป็นการจำลอง${fill ? ' แตะเบอร์เพื่อใส่ในช่องกรอก' : ''} (เบอร์อื่นๆ จะสุ่มผลตามที่แอดมินตั้งไว้)</p>
    <div class="mock-list">
      ${MOCK_NUMBERS.map((m) => html`<button type="button" class="mock-num" ${fill ? raw(`data-fill-phone="${m.phone}"`) : ''}>
        <code class="num">${phoneFmt(m.phone)}</code><span class="badge ${m.cls} plain">…${m.phone.slice(-4)}</span><span class="small text-2">${m.label}</span>
      </button>`)}
    </div>
  </details>`;
}

export const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';

/** แสดงจำนวนเงินแบบเน้นเศษสตางค์ เช่น ฿100.<b>37</b> */
export function bahtEmphasis(satang) {
  const whole = Math.floor(satang / 100).toLocaleString('th-TH');
  const frac = String(satang % 100).padStart(2, '0');
  return html`<span class="num">฿${whole}<span class="satang">.${frac}</span></span>`;
}
