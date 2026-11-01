// ขั้นตอนยืนยันก่อนตัดเงิน (ใช้กับเติมเงิน / แพ็กเกจ / ทำรายการซ้ำ)
// กันความผิดพลาด: แสดงเบอร์ตัวใหญ่ + ต้องติ๊กยืนยัน + idempotency key กันตัดเงินซ้ำ + กันปิดหน้าต่างระหว่างส่ง
import { html, raw, api, baht, phoneFmt, uuid, withLoading, modal, toast, toastError, navigate, setHTML, showFieldError } from '../lib.js';
import { state, refreshUser, networkOf, orderBlockReason, safeColor, loadCatalog, rememberShop } from './state.js';
import { netTag, alertBox } from './ui.js';
import { icon } from './icons.js';

/** เวลารอคำตอบตอนสั่งรายการ — เกินนี้ถือว่า "ไม่รู้ผล" ให้กดส่งซ้ำด้วยคีย์เดิมได้ */
export const ORDER_TIMEOUT_MS = 30000;

/** ไม่รู้ว่ารายการถึงระบบหรือไม่ (เน็ตหลุด / หมดเวลา / ระบบขัดข้อง / คำตอบอ่านไม่ได้) */
export const uncertainError = (err) => err?.code === 'NETWORK' || err?.code === 'INTERNAL_ERROR' || /^HTTP_\d+$/.test(err?.code || '');

/**
 * idempotency key ของรายการที่ "ยังไม่รู้ผล" แยกตามข้อมูลรายการ (บัญชี/ประเภท/เครือข่าย/เบอร์/ยอด/แพ็กเกจ)
 * ทำรายการเดิมอีกครั้ง (แม้ปิดหน้าต่างแล้วเปิดใหม่) → ใช้คีย์เดิม ระบบคืนรายการเดิมแทนการตัดเงินซ้ำ
 * ล้างคีย์เมื่อได้คำตอบว่าสร้างรายการแล้วเท่านั้น (ครั้งต่อไปจึงนับเป็นรายการใหม่) · เปลี่ยนข้อมูลใดๆ = คีย์ใหม่
 */
const pendingKeys = new Map();
const orderSig = (input) => JSON.stringify([
  state.user?.id, input.type, String(input.network || '').toUpperCase(), input.phone, input.amount ?? null, input.productId ?? null, input.shop || null,
]);

/** ร้าน/ยอด/แพ็กเกจที่เลือกไม่พร้อมแล้ว (ยังไม่ตัดเงิน) → โหลดข้อมูลร้านใหม่ ให้ลูกค้าเลือกใหม่ */
const SHOP_ERRORS = new Set(['SHOP_UNAVAILABLE', 'AMOUNT_NOT_AT_SHOP', 'PRODUCT_NOT_AT_SHOP', 'NO_PROVIDER']);
export const isShopError = (err) => SHOP_ERRORS.has(err?.code);
export function refreshShops() {
  loadCatalog(true).catch(() => { /* ออฟไลน์ → ใช้ข้อมูลเดิม */ });
}
let confirmOpen = false; // เปิดหน้าต่างยืนยันได้ทีละอัน (กันกดปุ่มซ้ำแล้วได้ 2 หน้าต่าง/2 คีย์)

export function loginRedirect(nextPath) {
  toast('กรุณาเข้าสู่ระบบก่อนทำรายการ', 'warning');
  navigate(`/login?next=${encodeURIComponent(nextPath || '/')}`);
}

/** ยอดแนะนำให้เติมเข้ากระเป๋า (บาท) เมื่อเงินไม่พอ */
export function depositSuggestion(missingSatang) {
  const min = state.catalog?.settings.deposit_min_baht || 1;
  return Math.max(Math.ceil(missingSatang / 100), min);
}

/** กล่องข้อความ error ของการสั่งรายการ พร้อมปุ่มที่เกี่ยวข้อง */
export function orderErrorHtml(err) {
  if (uncertainError(err)) {
    return alertBox('warning', html`<div class="bold">การเชื่อมต่อขัดข้อง — ยังไม่ทราบผล</div>
      <div class="small">ไม่แน่ใจว่ารายการถึงระบบหรือไม่ — กด "ยืนยัน" อีกครั้งได้อย่างปลอดภัย ระบบจะไม่ตัดเงินซ้ำ (ใช้เลขอ้างอิงเดิม) หรือตรวจสอบในหน้าประวัติก่อน</div>
      ${err.code !== 'NETWORK' ? html`<div class="xsmall muted mt-1">${err.message}</div>` : ''}`);
  }
  switch (err?.code) {
    case 'INSUFFICIENT_BALANCE': {
      const missing = Math.max(0, (err.details?.need || 0) - (err.details?.have || 0));
      return alertBox('danger', html`<div class="bold">ยอดเงินในกระเป๋าไม่พอ</div>
        <div class="small">ขาดอีก ฿${baht(missing)} — เติมเงินเข้ากระเป๋าก่อนแล้วกลับมาทำรายการ</div>
        <a class="btn sm primary mt-1" href="#/wallet?amount=${depositSuggestion(missing)}" data-close>${icon('plus', 16)} เติมเงินเข้ากระเป๋า</a>`);
    }
    case 'DAILY_LIMIT':
      return alertBox('warning', html`<div class="bold">เกินวงเงินต่อวัน</div><div class="small">${err.message}</div>`);
    case 'RATE_LIMITED':
      return alertBox('warning', html`<div class="bold">ทำรายการถี่เกินไป</div><div class="small">${err.message}</div>`);
    case 'MAINTENANCE':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_NOT_READY':
    case 'NETWORK_CLOSED':
      return alertBox('warning', html`<div class="bold">ยังทำรายการไม่ได้ในขณะนี้</div><div class="small">${err.message}</div>
        <div class="xsmall muted mt-1">ระบบยังไม่ได้ตัดเงินของคุณ</div>`);
    case 'SHOP_UNAVAILABLE':
    case 'AMOUNT_NOT_AT_SHOP':
    case 'PRODUCT_NOT_AT_SHOP':
    case 'NO_PROVIDER':
      return alertBox('warning', html`<div class="bold">ร้าน/รายการที่เลือกยังทำไม่ได้ในขณะนี้</div><div class="small">${err.message}</div>
        <div class="xsmall muted mt-1">ระบบยังไม่ได้ตัดเงินของคุณ — โหลดข้อมูลร้านล่าสุดแล้ว กรุณาเลือกร้านหรือยอดใหม่</div>`);
    case 'PRICE_CHANGED':
      return alertBox('warning', html`<div class="bold">ราคาเปลี่ยนแปลง — ยังไม่ได้ตัดเงิน</div><div class="small">${err.message}</div>
        <div class="xsmall muted mt-1">กรุณาปิดหน้าต่างแล้วกดทำรายการอีกครั้ง เพื่อดูและยืนยันราคาล่าสุด</div>`);
    case 'IDEMPOTENCY_MISMATCH':
      // มีรายการที่สร้างด้วยคีย์นี้อยู่แล้ว (เช่น ครั้งก่อนที่ไม่รู้ผล) → ให้ตรวจรายการนั้นก่อน ไม่ทำซ้ำเอง
      return alertBox('danger', html`<div class="small">${err.message}${err.details?.ref
        ? html` (เลขที่ <a href="#/order/${err.details.ref}" data-close>${err.details.ref}</a>)` : ''} — กรุณาตรวจสอบรายการนี้ในประวัติก่อน แล้วปิดหน้าต่างเพื่อทำรายการใหม่</div>`);
    default:
      return alertBox('danger', html`<div class="small">${err?.message || 'เกิดข้อผิดพลาด'}</div>`);
  }
}

/**
 * เปิดหน้าต่างยืนยัน แล้วส่งรายการ
 * @param {{type:'topup'|'package', network:string, phone:string, amount?:number, productId?:number}} input
 * @returns {Promise<object|null>} order ที่สร้าง หรือ null ถ้ายกเลิก
 */
export async function confirmAndOrder(input, opts = {}) {
  if (confirmOpen) return null;
  confirmOpen = true;
  try {
    return await confirmFlow(input, opts);
  } finally {
    confirmOpen = false;
  }
}

async function confirmFlow(input, { returnPath, form, onFieldError } = {}) {
  if (!state.user) {
    loginRedirect(returnPath || location.hash.slice(1) || '/');
    return null;
  }
  const block = orderBlockReason();
  if (block) {
    toast(block, 'error', 5000);
    return null;
  }

  let quote;
  try {
    quote = await api.post('/api/orders/quote', input, { timeout: ORDER_TIMEOUT_MS });
  } catch (err) {
    if (isShopError(err)) refreshShops(); // ร้าน/ยอดนี้ไม่พร้อม → โหลดข้อมูลร้านใหม่ให้เลือกใหม่
    if (err.details?.field && onFieldError) onFieldError(err);
    else if (err.details?.field && form) showFieldError(form, err);
    toast(err.message, 'error', 5200);
    return null;
  }

  const net = networkOf(quote.network);
  const isTopup = input.type === 'topup';
  const after = quote.balance - quote.price;
  const uid = state.user?.id;
  const sig = orderSig(input);
  // คีย์เดียวต่อ "รายการนี้" — ส่งซ้ำ (เน็ตหลุด/หมดเวลา/ยืนยันรายการซ้ำ) ใช้คีย์เดิมเสมอ = ไม่ตัดเงินซ้ำ
  const key = pendingKeys.get(sig) || uuid();
  let dupRequired = false;
  let priceChanged = false;
  let busy = false;

  // ได้คำตอบว่าสร้างรายการแล้ว (แม้หน้าต่างถูกปิดไประหว่างรอ) → แจ้งผล + ไปหน้าสถานะรายการ
  const finish = (r) => {
    refreshUser();
    if (input.shop) rememberShop(input.shop); // ครั้งหน้าเลือกร้านนี้ไว้ให้ก่อน
    if (r.existing) toast('รายการนี้ถูกส่งไปแล้ว — ระบบไม่ตัดเงินซ้ำ', 'warning', 5000);
    else toast(isTopup ? 'ส่งรายการเติมเงินแล้ว' : 'ส่งรายการสมัครแพ็กเกจแล้ว', 'success');
    navigate(`/order/${r.order.ref}`);
    return r.order;
  };

  const result = await modal({
    title: isTopup ? 'ยืนยันการเติมเงิน' : 'ยืนยันการสมัครแพ็กเกจ',
    body: html`
      <div class="confirm-box" style="--net:${raw(safeColor(net?.color))}">
        <div class="row between">
          <div class="row" style="--gap:8px">${netTag(quote.network)}<span class="bold">${net?.full_name || quote.network_name}</span></div>
          <span class="badge primary plain">${isTopup ? 'เติมเงิน' : 'แพ็กเกจ'}</span>
        </div>
        <div class="confirm-label">เบอร์ปลายทาง</div>
        <div class="confirm-phone">${phoneFmt(quote.phone)}</div>
        <div class="confirm-product">${quote.product_name}</div>
        <div class="sum-lines">
          ${quote.shop_name ? html`<div class="sum-line"><span class="muted">ร้าน</span><span class="bold">${quote.shop_name}</span></div>` : ''}
          <div class="sum-line"><span class="muted">${isTopup ? 'ยอดเติม' : 'ราคาแพ็กเกจ'}</span><span class="num">฿${baht(quote.face_value)}</span></div>
          ${quote.discount > 0 ? html`<div class="sum-line text-success"><span>ส่วนลด</span><span class="num">-฿${baht(quote.discount)}</span></div>` : ''}
          <div class="sum-line total"><span>ชำระจริง</span><span class="num">฿${baht(quote.price)}</span></div>
          <div class="sum-line small"><span class="muted">ยอดในกระเป๋า</span>
            <span class="num">฿${baht(quote.balance)} → ${quote.enough_balance ? html`฿${baht(after)}` : html`<span class="text-danger bold">ไม่พอ</span>`}</span></div>
        </div>
      </div>
      ${quote.enough_balance ? '' : html`<div class="mt-2">${orderErrorHtml({ code: 'INSUFFICIENT_BALANCE', details: { need: quote.price, have: quote.balance } })}</div>`}
      <div data-dup></div>
      <label class="check confirm-check">
        <input type="checkbox" data-ok-check>
        <span>ตรวจสอบเบอร์ <b class="num">${phoneFmt(quote.phone)}</b> และเครือข่าย <b>${net?.name || quote.network_name}</b> ถูกต้องแล้ว</span>
      </label>
      <p class="xsmall muted mt-1 mb-0 row" style="--gap:6px">${icon('shield', 14)} เติมผิดเบอร์ยกเลิกไม่ได้ · ถ้าไม่สำเร็จ ระบบคืนเงินเข้ากระเป๋าอัตโนมัติ</p>
      ${quote.shop_name ? html`<p class="xsmall muted mt-1 mb-0">ถ้า${quote.shop_name}ไม่รับรายการ ระบบอาจส่งต่อให้ร้านอื่นอัตโนมัติ ในราคาเดิม</p>` : ''}
      <div data-err></div>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button>
      <button class="btn primary" data-submit disabled>${icon('check', 18)} ยืนยันชำระ ฿${baht(quote.price)}</button>`,
    onMount: (dlg, close) => {
      // ระหว่างส่ง ห้ามปิดหน้าต่าง (กันผู้ใช้เข้าใจผิดว่ายกเลิกแล้ว)
      dlg.addEventListener('click', (e) => {
        if (busy && (e.target === dlg || e.target.closest('[data-close]'))) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
      dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });

      const btn = dlg.querySelector('[data-submit]');
      const okCheck = dlg.querySelector('[data-ok-check]');
      const dupBox = dlg.querySelector('[data-dup]');
      const errBox = dlg.querySelector('[data-err]');
      const dupChecked = () => Boolean(dlg.querySelector('[data-dup-check]')?.checked);
      const sync = () => {
        btn.disabled = !(okCheck.checked && (!dupRequired || dupChecked()) && quote.enough_balance && !priceChanged);
      };
      const showDup = (message) => {
        dupRequired = true;
        setHTML(dupBox, html`<div class="mt-2">${alertBox('warning', html`<div class="small">${message}</div>
          <label class="check mt-1"><input type="checkbox" data-dup-check><span class="bold">ยืนยันทำรายการซ้ำ (ฉันต้องการเติมซ้ำจริง)</span></label>`)}</div>`);
        dupBox.querySelector('[data-dup-check]').addEventListener('change', sync);
        sync();
      };
      if (quote.warning) showDup(quote.warning.message);
      okCheck.addEventListener('change', sync);

      btn.addEventListener('click', () => {
        withLoading(btn, async () => {
          setHTML(errBox, '');
          // บัญชีที่เข้าสู่ระบบเปลี่ยนไประหว่างเปิดหน้าต่าง (เช่น เข้าสู่ระบบบัญชีอื่นจากแท็บอื่น) → ห้ามส่งในบัญชีใหม่
          if (state.user?.id !== uid) {
            setHTML(errBox, html`<div class="mt-2">${alertBox('danger', 'บัญชีที่เข้าสู่ระบบเปลี่ยนไปแล้ว — กรุณาปิดหน้าต่างแล้วทำรายการใหม่ (รายการนี้ยังไม่ถูกส่ง)')}</div>`);
            return;
          }
          busy = true;
          pendingKeys.set(sig, key); // ยังไม่รู้ผลจนกว่าจะได้คำตอบ
          try {
            // expectedPrice = ราคาที่ลูกค้าเห็นในหน้าต่างนี้ — ราคาเปลี่ยนระหว่างนั้น ระบบจะไม่ตัดเงิน (PRICE_CHANGED)
            const r = await api.post('/api/orders', {
              ...input, idempotencyKey: key, confirmDuplicate: dupRequired && dupChecked(), expectedPrice: quote.price,
            }, { timeout: ORDER_TIMEOUT_MS });
            busy = false;
            pendingKeys.delete(sig); // สร้างรายการแล้ว → ครั้งต่อไปเป็นรายการใหม่
            if (dlg.open) close(r);
            else finish(r);
          } catch (err) {
            busy = false;
            if (err.code === 'IDEMPOTENCY_MISMATCH') pendingKeys.delete(sig);
            if (isShopError(err)) {
              // ร้าน/ยอด/แพ็กเกจนี้ไม่พร้อมแล้ว (ยังไม่ตัดเงิน) → โหลดข้อมูลร้านใหม่ ปิดหน้าต่างให้เลือกร้านหรือยอดใหม่
              refreshShops();
              toast(`${err.message} — ยังไม่ได้ตัดเงิน กรุณาเลือกใหม่`, 'warning', 7000);
              if (dlg.open) close(undefined);
              return;
            }
            if (!dlg.open) { toastError(err); return; }
            if (err.code === 'DUPLICATE_RECENT') {
              showDup(err.message); // ระบบยังไม่ได้สร้างรายการ → ยืนยันแล้วส่งซ้ำด้วยคีย์เดิม
            } else {
              if (err.code === 'INSUFFICIENT_BALANCE') quote.enough_balance = false;
              if (err.code === 'PRICE_CHANGED') priceChanged = true; // ต้องเปิดใหม่เพื่อดูราคาล่าสุด (คีย์เดิมยังใช้ได้ — ยังไม่ได้สร้างรายการ)
              setHTML(errBox, html`<div class="mt-2">${orderErrorHtml(err)}</div>`);
            }
          }
        }).then(sync);
      });
      sync();
    },
  });

  if (!result?.order) return null;
  return finish(result);
}
