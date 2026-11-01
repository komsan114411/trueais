// หน้าสถานะรายการ: แสดงผลแบบเรียลไทม์ (poll) จนกว่าจะได้ผลสุดท้าย
import { html, raw, api, on, setHTML, baht, phoneFmt, dateTimeSec, statusBadge, pollDelay, toast, copyText, promptDialog, toastError } from '../lib.js';
import { state, refreshUser, networkOf, forgetPhonebook } from './state.js';
import { icon } from './icons.js';
import { netTag, emptyState, reorderPath, typeLabel, alertBox, supportLinks } from './ui.js';

const MAX_POLL_MS = 3 * 60 * 1000;
/** รอผลนานเกินนี้ (นับจากเวลาสั่ง) → แสดงช่องทางติดต่อร้าน + ปุ่มคัดลอกเลขที่รายการ */
const SUPPORT_AFTER_MS = 5 * 60 * 1000;

function visual(o) {
  if (o.status === 'success') return 'success';
  if (o.status === 'failed' || o.status === 'refunded') return 'failed';
  return 'processing';
}

/** ข้อความใบเสร็จ (แชร์ / คัดลอกไปวางในแชตหรือโน้ต) */
function receiptText(o) {
  const s = state.catalog?.settings || {};
  const net = networkOf(o.network);
  return [
    `${s.site_name || 'TopUp'} — หลักฐานการ${o.type === 'topup' ? 'เติมเงิน' : 'สมัครแพ็กเกจ'}`,
    `สถานะ: ${o.status === 'success' ? 'สำเร็จ' : o.status_label || o.status}`,
    `เลขที่รายการ: ${o.ref}`,
    `เบอร์: ${phoneFmt(o.phone)} (${net?.name || o.network})`,
    `รายการ: ${o.product_name}`,
    `${o.type === 'topup' ? 'ยอดเติม' : 'ราคา'}: ${baht(o.face_value)} บาท`,
    `ชำระ: ${baht(o.price)} บาท`,
    `เวลา: ${dateTimeSec(o.completed_at || o.created_at)}`,
    o.provider_txn_id ? `เลขอ้างอิงผู้ให้บริการ: ${o.provider_txn_id}` : '',
  ].filter(Boolean).join('\n');
}

async function shareReceipt(o) {
  const text = receiptText(o);
  // มือถือ: เปิดเมนูแชร์ของเครื่อง (ส่ง LINE / บันทึกโน้ต) · คอมพิวเตอร์: คัดลอกข้อความ
  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: text.split('\n')[0], text });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // ลูกค้ากดยกเลิกเอง
    }
  }
  await copyText(text, 'คัดลอกใบเสร็จแล้ว — วางในแชตหรือโน้ตได้เลย');
}

export default async function orderPage(ctx) {
  const ref = String(ctx.params.ref || '').toUpperCase();
  let timer = null;
  let lateTimer = null;
  let stopped = false;
  let lastSig = '';
  let wasFinal = null;
  let attempt = 0;
  let started = Date.now();
  let data = null;
  let lastOpts = {};
  ctx.onLeave(() => { stopped = true; clearTimeout(timer); clearTimeout(lateTimer); });

  function render(d, opts = {}) {
    lastOpts = opts;
    const { slow = false, offline = false } = opts;
    const o = d.order;
    const vis = visual(o);
    const net = networkOf(o.network);
    const switched = Boolean(o.shop_name && o.handled_by && o.handled_by !== o.shop_name); // ร้านที่เลือกไม่รับ → ส่งต่อร้านอื่น
    const created = Date.parse(o.created_at);
    const late = !o.final && (slow || (Number.isFinite(created) && Date.now() - created > SUPPORT_AFTER_MS));
    const again = reorderPath(o); // null ระหว่างรอผล (ไม่เสนอให้ทำซ้ำ)
    const title = vis === 'success'
      ? (o.type === 'topup' ? 'เติมเงินสำเร็จ' : 'สมัครแพ็กเกจสำเร็จ')
      : vis === 'failed' ? (o.status === 'refunded' ? 'คืนเงินแล้ว' : 'ทำรายการไม่สำเร็จ') : 'กำลังดำเนินการ';
    const sub = vis === 'success'
      ? html`${o.product_name} → <span class="num">${phoneFmt(o.phone)}</span>`
      : vis === 'failed'
        ? html`<span class="bold">คืนเงิน ฿${baht(o.price)} เข้ากระเป๋าแล้ว</span>`
        : 'กำลังส่งรายการไปยังผู้ให้บริการ ปกติใช้เวลาไม่เกิน 1 นาที';
    const contact = supportLinks();
    const recheckBtn = html`<button class="btn sm" data-recheck>${icon('refresh', 16)} ตรวจสอบอีกครั้ง</button>`;
    setHTML(ctx.view, html`
      <section class="card status-card ${vis}">
        <div class="status-hero">
          <div class="status-icon ${vis}">${vis === 'processing' ? raw('<span class="spinner"></span>') : icon(vis === 'success' ? 'check' : 'x', 46)}</div>
          <h1 class="status-title">${title}</h1>
          <p class="status-sub">${sub}</p>
          ${vis === 'failed' ? html`<div class="fail-reason">
            <div class="small"><b>สาเหตุ:</b> ${o.message || 'ผู้ให้บริการไม่รับรายการนี้'}</div>
            <div class="xsmall muted mt-1">${o.type === 'topup'
              ? 'ถ้าเบอร์นี้ย้ายค่าย หรือเลือกเครือข่ายไม่ตรงกับเบอร์ ให้ลองใหม่โดยเลือกเครือข่ายที่ใช้อยู่จริง'
              : 'ตรวจว่าเบอร์นี้ใช้เครือข่ายนี้อยู่จริง และสมัครแพ็กเกจนี้ได้ (บางแพ็กเกจสมัครได้เฉพาะเบอร์เติมเงิน)'}</div>
          </div>` : ''}
          ${switched ? html`<p class="small muted mt-1 mb-0">${o.shop_name} ไม่รับรายการ — ระบบส่งต่อให้ ${o.handled_by} อัตโนมัติ ในราคาเดิม</p>` : ''}
          <div class="status-amount num">฿${baht(o.price)}</div>
          <div class="status-meta"><span class="mono">${o.ref}</span> · ${statusBadge(o.status)}</div>
        </div>
        ${offline ? html`<div class="px-3">${alertBox('warning', 'การเชื่อมต่อขัดข้อง กำลังลองเชื่อมต่อใหม่...')}</div>` : ''}
        ${!o.final && !late ? html`<div class="px-3">${alertBox('info', html`<div class="bold">กำลังรอผล — ไม่ต้องทำรายการใหม่</div>
          <div class="small">ถ้าไม่สำเร็จ ระบบคืนเงินเข้ากระเป๋าอัตโนมัติ · หน้านี้อัปเดตผลให้เอง</div>`)}</div>` : ''}
        ${late ? html`<div class="px-3">${alertBox('warning', html`<div class="bold">รอผลนานกว่าปกติ — ไม่ต้องทำรายการใหม่</div>
          <div class="small">ระบบยังตรวจสอบผลให้อยู่ ถ้าไม่สำเร็จจะคืนเงินอัตโนมัติ · ต้องการสอบถาม แจ้งเลขที่รายการ <b class="mono">${o.ref}</b> กับร้าน${contact ? html` (${contact})` : ''}</div>
          <div class="row wrap mt-1" style="--gap:6px">
            <button class="btn sm" data-copy="${o.ref}" data-copy-msg="คัดลอกเลขที่รายการแล้ว">${icon('copy', 16)} คัดลอกเลขที่รายการ</button>
            ${slow ? recheckBtn : ''}
          </div>`)}</div>` : ''}
        <div class="status-actions">
          ${vis === 'success' ? html`<button class="btn primary" data-receipt>${icon('download', 18)} บันทึก/แชร์ใบเสร็จ</button>` : ''}
          ${again && vis === 'success' ? html`<a class="btn" href="#${again}">${icon('repeat', 18)} ${o.type === 'topup' ? 'เติมอีกครั้ง' : 'สมัครอีกครั้ง'}</a>` : ''}
          ${again && vis === 'failed' ? html`<a class="btn primary" href="#${again}">${icon('repeat', 18)} ลองอีกครั้ง (เลือกเครือข่ายใหม่)</a>` : ''}
          <a class="btn" href="#/history">${icon('clock', 18)} ดูประวัติ</a>
          <button class="btn ghost" data-save>${icon('book', 18)} บันทึกเบอร์</button>
        </div>
      </section>
      <div class="order-layout mt-2">
        <section class="card">
          <h3 class="mb-2">รายละเอียด</h3>
          <dl class="dl">
            <dt>เลขที่รายการ</dt><dd><span class="mono">${o.ref}</span> <button class="btn ghost sm icon" data-copy="${o.ref}" data-copy-msg="คัดลอกเลขที่รายการแล้ว" title="คัดลอก" aria-label="คัดลอกเลขที่รายการ">${icon('copy', 16)}</button></dd>
            <dt>ประเภท</dt><dd>${typeLabel(o.type)}${o.source === 'bulk' ? ' (เติมหลายเบอร์)' : ''}</dd>
            <dt>เครือข่าย</dt><dd>${netTag(o.network)} ${net?.full_name || ''}</dd>
            ${o.shop_name || o.handled_by ? html`<dt>ร้าน</dt><dd>${o.shop_name || 'ระบบเลือกให้'}${o.handled_by && o.handled_by !== o.shop_name
              ? html`<div class="xsmall text-2">${o.shop_name ? `ส่งต่อให้ ${o.handled_by} อัตโนมัติ (ราคาเดิม)` : `ดำเนินการโดย ${o.handled_by}`}</div>` : ''}</dd>` : ''}
            <dt>เบอร์ปลายทาง</dt><dd class="num">${phoneFmt(o.phone)}</dd>
            <dt>รายการ</dt><dd>${o.product_name}</dd>
            <dt>${o.type === 'topup' ? 'ยอดเติม' : 'ราคา'}</dt><dd class="num">฿${baht(o.face_value)}</dd>
            <dt>ชำระ</dt><dd class="num">฿${baht(o.price)}</dd>
            <dt>เวลาทำรายการ</dt><dd>${dateTimeSec(o.created_at)}</dd>
            ${o.completed_at ? html`<dt>เสร็จสิ้นเมื่อ</dt><dd>${dateTimeSec(o.completed_at)}</dd>` : ''}
            ${o.provider_txn_id ? html`<dt>เลขอ้างอิงผู้ให้บริการ</dt><dd class="mono small">${o.provider_txn_id}</dd>` : ''}
            ${o.message && vis !== 'failed' ? html`<dt>ข้อความ</dt><dd class="small">${o.message}</dd>` : ''}
          </dl>
        </section>
        <section class="card">
          <h3 class="mb-2">ความคืบหน้า</h3>
          <ul class="timeline">
            ${d.events.map((e) => html`<li class="${e.status}"><div class="t-msg">${e.message}</div><div class="t-meta">${dateTimeSec(e.created_at)} · ${e.source_label}</div></li>`)}
          </ul>
        </section>
      </div>`);
  }

  /** ถึงเวลาแสดงช่องทางติดต่อร้าน (รอนานเกินปกติ) → วาดใหม่ครั้งเดียว แม้หยุด poll ไปแล้ว */
  function scheduleLate(o) {
    clearTimeout(lateTimer);
    const created = Date.parse(o.created_at);
    if (o.final || !Number.isFinite(created)) return;
    const wait = created + SUPPORT_AFTER_MS - Date.now() + 500;
    if (wait <= 0) return;
    lateTimer = setTimeout(() => {
      if (stopped || !ctx.alive() || !data || data.order.final) return;
      lastSig = '';
      render(data, lastOpts);
    }, wait);
  }

  let ticking = false; // กันกด "ตรวจสอบอีกครั้ง" ซ้อนกันจนมีการ poll หลายสาย
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await poll();
    } finally {
      ticking = false;
    }
  }

  async function poll() {
    if (stopped || !ctx.alive()) return;
    let d;
    try {
      d = await api.get(`/api/orders/${encodeURIComponent(ref)}`, { timeout: 20000 });
    } catch (err) {
      if (!ctx.alive()) return;
      if (err.code === 'NOT_FOUND' || err.status === 404) {
        setHTML(ctx.view, emptyState('search', 'ไม่พบรายการนี้', `เลขที่ ${ref}`, html`<a class="btn primary sm" href="#/history">ไปที่ประวัติ</a>`));
        return;
      }
      if (err.status === 401) return; // เซสชันหมดอายุ → ระบบพาไปหน้าเข้าสู่ระบบ
      // ลองใหม่ได้ไม่เกินเวลาที่กำหนด (ไม่ poll ไม่รู้จบ) — หลังจากนั้นให้กด "ตรวจสอบอีกครั้ง" เอง
      const giveUp = Date.now() - started > MAX_POLL_MS;
      lastSig = ''; // ต่อได้แล้วต้องวาดใหม่ (ล้างแถบ "การเชื่อมต่อขัดข้อง")
      if (data) render(data, { offline: true, slow: giveUp });
      else {
        setHTML(ctx.view, emptyState('alert', 'โหลดรายการไม่สำเร็จ', err.message,
          html`<button class="btn sm" data-recheck>${icon('refresh', 16)} ลองใหม่</button>`));
      }
      if (!giveUp) timer = setTimeout(tick, 5000);
      return;
    }
    if (stopped || !ctx.alive()) return;
    data = d;
    const final = d.order.final;
    const slow = !final && Date.now() - started > MAX_POLL_MS;
    const sig = JSON.stringify([d.order.status, d.order.message, d.events.length, d.order.handled_by, slow]);
    if (sig !== lastSig) {
      lastSig = sig;
      render(d, { slow });
    }
    if (final) {
      clearTimeout(lateTimer);
      if (wasFinal === false) {
        refreshUser();
        if (d.order.status === 'success') toast(d.order.type === 'topup' ? 'เติมเงินสำเร็จ' : 'สมัครแพ็กเกจสำเร็จ', 'success');
        else toast('รายการไม่สำเร็จ ระบบคืนเงินเข้ากระเป๋าแล้ว', 'warning', 5000);
      } else if (wasFinal === null) {
        refreshUser(); // เปิดหน้ามาตอนรายการจบแล้ว (เช่น คืนเงินแล้ว) → ยอดเงินบนหน้าต้องเป็นยอดล่าสุด
      }
      wasFinal = true;
      return;
    }
    if (wasFinal === null) scheduleLate(d.order);
    wasFinal = false;
    if (slow) return;
    timer = setTimeout(tick, pollDelay(attempt++));
  }

  on(ctx.view, 'click', '[data-copy]', (e, el) => copyText(el.dataset.copy, el.dataset.copyMsg || undefined));
  on(ctx.view, 'click', '[data-receipt]', () => { if (data) shareReceipt(data.order); });
  on(ctx.view, 'click', '[data-recheck]', () => {
    started = Date.now();
    attempt = 0;
    lastSig = '';
    clearTimeout(timer);
    tick();
  });
  on(ctx.view, 'click', '[data-save]', async () => {
    if (!data) return;
    const o = data.order;
    // บันทึกเครือข่ายเฉพาะรายการที่สำเร็จ (รายการไม่สำเร็จ/ยังไม่รู้ผล อาจเลือกเครือข่ายผิด — ไม่บันทึกต่อให้ผิดซ้ำ)
    const ok = o.status === 'success';
    const name = await promptDialog({
      title: 'บันทึกเบอร์ลงสมุดโทรศัพท์',
      label: `ตั้งชื่อเรียกเบอร์ ${phoneFmt(o.phone)}${ok ? '' : ' (ไม่บันทึกเครือข่าย เพราะรายการนี้ยังไม่สำเร็จ)'}`,
      placeholder: 'เช่น แม่, ร้านค้า, เบอร์ตัวเอง',
      required: true,
      confirmText: 'บันทึก',
    });
    if (!name) return;
    try {
      await api.post('/api/phonebook', { name, phone: o.phone, ...(ok ? { network: o.network } : {}) });
      forgetPhonebook();
      toast('บันทึกเบอร์แล้ว', 'success');
    } catch (err) {
      if (err.code === 'PHONE_EXISTS') toast('เบอร์นี้อยู่ในสมุดโทรศัพท์แล้ว', 'warning');
      else toastError(err);
    }
  });

  await tick();
}
