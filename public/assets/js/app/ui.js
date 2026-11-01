// ชิ้นส่วน UI ที่ใช้ซ้ำหลายหน้า
import { html, raw, baht, phoneFmt, timeAgo, STATUS } from '../lib.js';
import { networkOf, netVars, shopNote, getDraft, state } from './state.js';
import { icon } from './icons.js';

/** ราคาหลังส่วนลด (สูตรเดียวกับฝั่งเซิร์ฟเวอร์: ปัดเศษส่วนลดลง) */
export const priceAfter = (satang, bp) => satang - Math.floor((satang * Math.max(0, Number(bp) || 0)) / 10000);

export const typeLabel = (t) => (t === 'package' ? 'แพ็กเกจ' : 'เติมเงิน');

export function netTag(code) {
  const n = networkOf(code);
  return html`<span class="net-badge" style="${netVars(n?.color)}">${n?.name || code}</span>`;
}

/** ป้ายสถานะแบบสั้น (ใช้ในรายการ/การ์ดบนจอเล็ก ไม่ให้เบียดเบอร์จนถูกตัด) — ข้อความเต็มอยู่ใน title */
const SHORT_STATUS = { pending: 'รอคิว', success: 'สำเร็จ', failed: 'ไม่สำเร็จ', refunded: 'คืนเงินแล้ว' };
export function statusChip(o) {
  const s = STATUS[o.status] || { label: o.status, cls: '' };
  const short = o.status === 'processing' ? (o.type === 'package' ? 'กำลังสมัคร' : 'กำลังเติม') : SHORT_STATUS[o.status] || s.label;
  return html`<span class="badge ${s.cls}" title="${s.label}">${short}</span>`;
}

const sdfDay = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
const sdfYear = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' });
const bkkYear = (d) => new Date(d.getTime() + 7 * 3600000).getUTCFullYear();
/** วันที่สั้นๆ เช่น "3 พ.ย." (ปีอื่นแสดงปีด้วย เช่น "3 พ.ย. 68") */
export function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (bkkYear(d) === bkkYear(new Date()) ? sdfDay : sdfYear).format(d);
}

/**
 * ชี้ให้เห็นขั้นตอนที่ยังไม่ครบ: เลื่อนไปที่ส่วนนั้น + ไฮไลต์สั้นๆ (แทนการปิดปุ่มเงียบๆ จนลูกค้าไม่รู้ว่าขาดอะไร)
 */
export function nudge(el, { focus } = {}) {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('attention');
  void el.offsetWidth; // เริ่มแอนิเมชันใหม่ทุกครั้งที่กด
  el.classList.add('attention');
  clearTimeout(el._attnTimer);
  el._attnTimer = setTimeout(() => el.classList.remove('attention'), 1800);
  if (focus) setTimeout(() => { try { focus.focus({ preventScroll: true }); } catch { /* ignore */ } }, 250);
}

/**
 * กันปิด/รีเฟรชหน้าเว็บระหว่างกำลังส่งรายการ (ยังไม่รู้ผล) — คืนฟังก์ชันสำหรับเลิกกัน
 * (เบราว์เซอร์จะถามยืนยันก่อนออกจากหน้า)
 */
let busyCount = 0;
const onBeforeUnload = (e) => {
  e.preventDefault();
  e.returnValue = ''; // เบราว์เซอร์รุ่นเก่าต้องตั้งค่านี้
  return '';
};
export function busyGuard() {
  if (busyCount++ === 0) window.addEventListener('beforeunload', onBeforeUnload);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--busyCount === 0) window.removeEventListener('beforeunload', onBeforeUnload);
  };
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

/**
 * การ์ดรายการ (ใช้ในหน้าแรก / ประวัติบนมือถือ)
 * reorder = แสดงปุ่ม "เติมซ้ำ" สำหรับรายการที่จบแล้ว (รายการที่ยังไม่รู้ผลไม่มีปุ่มนี้ — กันเติมซ้ำโดยไม่ตั้งใจ)
 */
export function orderItem(o, { reorder = false } = {}) {
  const again = reorder ? reorderPath(o) : null;
  return html`<div class="order-item${again ? ' has-action' : ''}">
    <span class="oi-icon" style="${netVars(networkOf(o.network)?.color)}">${icon(o.type === 'package' ? 'wifi' : 'bolt', 18)}</span>
    <span class="oi-main">
      <a class="oi-title oi-link" href="#/order/${o.ref}">${o.product_name}</a>
      <span class="oi-sub"><span class="num">${phoneFmt(o.phone)}</span> · ${timeAgo(o.created_at)}${shopNote(o) ? ` · ร้าน ${shopNote(o)}` : ''}</span>
    </span>
    <span class="oi-side"><span class="oi-price num">฿${baht(o.price)}</span>${statusChip(o)}</span>
    ${again ? html`<a class="btn sm soft oi-again" href="#${again}" title="${o.status === 'success' ? 'ทำรายการเดิมอีกครั้ง' : 'ลองอีกครั้ง (เลือกเครือข่ายใหม่)'}">${icon('repeat', 15)} ${o.status === 'success' ? 'เติมซ้ำ' : 'ลองใหม่'}</a>` : ''}
  </div>`;
}

/**
 * ลิงก์สำหรับ "ทำรายการซ้ำ"
 *  - สำเร็จ → เปิดหน้าเดิมพร้อมเครือข่าย/เบอร์/ยอด/ร้านเดิม (ยังต้องยืนยันตามปกติ)
 *  - ไม่สำเร็จ → เปิดหน้าเดิมพร้อมเบอร์/ยอด แต่ "ไม่เลือกเครือข่ายให้" (retry=) ให้ลูกค้าตรวจเครือข่ายใหม่ (อาจเลือกผิด/ย้ายค่าย)
 *  - ยังไม่รู้ผล → null (ห้ามเสนอให้ทำซ้ำ)
 */
export function reorderPath(o) {
  if (!o || !o.final) return null;
  const p = new URLSearchParams();
  const ok = o.status === 'success';
  if (ok) p.set('network', o.network);
  else p.set('retry', o.network);
  p.set('phone', o.phone);
  if (o.type === 'package') {
    if (ok && o.product_id) p.set('product', String(o.product_id)); // แพ็กเกจผูกกับเครือข่าย → ลองใหม่ให้เลือกเครือข่ายก่อน
  } else {
    p.set('amount', String(Math.round(o.face_value / 100)));
  }
  if (o.shop) p.set('shop', o.shop); // ร้านเดิมที่ลูกค้าเลือก (ถ้ายังเปิดอยู่)
  return `/${o.type === 'package' ? 'packages' : 'topup'}?${p.toString()}`;
}

/**
 * แถบเตือน "เติมเงินเข้ากระเป๋าที่ยังไม่เสร็จ" (ยังไม่ได้แนบสลิป / รอตรวจสลิป) — กดเพื่อทำต่อ
 */
export function depositBanner(list) {
  if (!list?.length) return '';
  const unpaid = list.filter((d) => !d.has_slip);
  const waiting = list.filter((d) => d.has_slip);
  const items = [];
  if (unpaid.length) {
    const d = unpaid[0];
    items.push(html`<div class="alert warning dep-banner">
      <span class="alert-icon">${icon('wallet', 18)}</span>
      <div class="grow alert-body"><div class="bold">เติมเงินเข้ากระเป๋า ฿${baht(d.amount)} ยังไม่ได้แนบสลิป</div>
        <div class="small">โอนแล้วอย่าลืมแนบสลิป เงินจึงจะเข้ากระเป๋า${unpaid.length > 1 ? ` (ค้างอยู่ ${unpaid.length} รายการ)` : ''}</div></div>
      <a class="btn sm primary" href="#/deposit/${d.id}">ทำต่อ ${icon('chevronRight', 16)}</a>
    </div>`);
  }
  if (waiting.length) {
    const d = waiting[0];
    items.push(html`<div class="alert info dep-banner">
      <span class="alert-icon">${icon('clock', 18)}</span>
      <div class="grow alert-body"><div class="bold">สลิป ฿${baht(d.amount)} กำลังรอเจ้าหน้าที่ตรวจสอบ</div>
        <div class="small">อนุมัติแล้วเงินจะเข้ากระเป๋าอัตโนมัติ${waiting.length > 1 ? ` (รอตรวจ ${waiting.length} รายการ)` : ''}</div></div>
      <a class="btn sm" href="#/deposit/${d.id}">ดูสถานะ</a>
    </div>`);
  }
  return html`<div class="stack" style="--gap:8px">${items}</div>`;
}

/**
 * แถบ "รายการที่ค้างไว้" — ลูกค้าไปเติมเงินเข้ากระเป๋าเพราะเงินไม่พอ แล้วกลับมาทำต่อได้ทันทีโดยไม่ต้องกรอกใหม่
 * (กด "ทำรายการต่อ" = เปิดหน้าเดิมพร้อมข้อมูลเดิม แล้วยืนยันตามปกติ — ไม่ได้สั่งรายการให้เอง)
 */
export function draftBanner() {
  const d = getDraft();
  if (!d) return '';
  return html`<div class="alert info draft-banner" data-draft>
    <span class="alert-icon">${icon('bolt', 18)}</span>
    <div class="grow alert-body"><div class="bold">รายการที่ค้างไว้ — ทำต่อได้เลย</div><div class="small">${d.label}</div></div>
    <div class="row wrap draft-actions" style="--gap:6px"><a class="btn sm primary" href="#${d.path}">ทำรายการต่อ</a><button type="button" class="btn sm ghost" data-draft-dismiss>ไม่ทำแล้ว</button></div>
  </div>`;
}

/** ลิงก์ติดต่อผู้ดูแล (กดแล้วเปิด LINE / โทรออกได้ทันที) */
export function supportLinks(s = state.catalog?.settings || {}, { sep = ' · ' } = {}) {
  const line = String(s.support_line || '').trim();
  const phone = String(s.support_phone || '').trim();
  const parts = [];
  if (line) {
    // LINE ID ส่วนตัว = ~id, บัญชีทางการ = @id
    const id = line.startsWith('@') ? `@${encodeURIComponent(line.slice(1))}` : `~${encodeURIComponent(line)}`;
    parts.push(html`<a href="https://line.me/R/ti/p/${id}" target="_blank" rel="noopener">LINE: ${line}</a>`);
  }
  if (phone) parts.push(html`<a href="tel:${phone.replace(/[^\d+]/g, '')}">โทร: ${phone}</a>`);
  return parts.length ? html`${parts.map((p, i) => html`${i ? sep : ''}${p}`)}` : '';
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
