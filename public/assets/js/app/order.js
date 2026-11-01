// หน้าสถานะรายการ: แสดงผลแบบเรียลไทม์ (poll) จนกว่าจะได้ผลสุดท้าย
import { html, raw, api, on, setHTML, baht, phoneFmt, dateTimeSec, statusBadge, pollDelay, toast, copyText, promptDialog, toastError } from '../lib.js';
import { refreshUser, networkOf } from './state.js';
import { icon } from './icons.js';
import { netTag, emptyState, reorderPath, typeLabel, alertBox } from './ui.js';

const MAX_POLL_MS = 3 * 60 * 1000;

function visual(o) {
  if (o.status === 'success') return 'success';
  if (o.status === 'failed' || o.status === 'refunded') return 'failed';
  return 'processing';
}

export default async function orderPage(ctx) {
  const ref = String(ctx.params.ref || '').toUpperCase();
  let timer = null;
  let stopped = false;
  let lastSig = '';
  let wasFinal = null;
  let attempt = 0;
  let started = Date.now();
  let data = null;
  ctx.onLeave(() => { stopped = true; clearTimeout(timer); });

  function render(d, { slow = false, offline = false } = {}) {
    const o = d.order;
    const vis = visual(o);
    const net = networkOf(o.network);
    const switched = Boolean(o.shop_name && o.handled_by && o.handled_by !== o.shop_name); // ร้านที่เลือกไม่รับ → ส่งต่อร้านอื่น
    const title = vis === 'success'
      ? (o.type === 'topup' ? 'เติมเงินสำเร็จ' : 'สมัครแพ็กเกจสำเร็จ')
      : vis === 'failed' ? (o.status === 'refunded' ? 'คืนเงินแล้ว' : 'ทำรายการไม่สำเร็จ') : 'กำลังดำเนินการ';
    const sub = vis === 'success'
      ? html`${o.product_name} → <span class="num">${phoneFmt(o.phone)}</span>`
      : vis === 'failed'
        ? html`<span class="bold">คืนเงิน ฿${baht(o.price)} เข้ากระเป๋าแล้ว</span>`
        : 'กำลังส่งรายการไปยังผู้ให้บริการ ปกติใช้เวลาไม่เกิน 1 นาที — ไม่ต้องทำรายการซ้ำ';
    setHTML(ctx.view, html`
      <section class="card status-card ${vis}">
        <div class="status-hero">
          <div class="status-icon ${vis}">${vis === 'processing' ? raw('<span class="spinner"></span>') : icon(vis === 'success' ? 'check' : 'x', 46)}</div>
          <h1 class="status-title">${title}</h1>
          <p class="status-sub">${sub}</p>
          ${vis === 'failed' && o.message ? html`<p class="small muted mt-1 mb-0">สาเหตุ: ${o.message}</p>` : ''}
          ${switched ? html`<p class="small muted mt-1 mb-0">${o.shop_name} ไม่รับรายการ — ระบบส่งต่อให้ ${o.handled_by} อัตโนมัติ ในราคาเดิม</p>` : ''}
          <div class="status-amount num">฿${baht(o.price)}</div>
          <div class="status-meta"><span class="mono">${o.ref}</span> · ${statusBadge(o.status)}</div>
        </div>
        ${offline ? html`<div class="px-3">${alertBox('warning', 'การเชื่อมต่อขัดข้อง กำลังลองเชื่อมต่อใหม่...')}</div>` : ''}
        ${slow && !o.final ? html`<div class="px-3">${alertBox('info', html`ระบบจะตรวจสอบผลให้อัตโนมัติ ดูผลได้ที่ <a href="#/history">ประวัติ</a> — ไม่ต้องทำรายการซ้ำ ระบบจะไม่ตัดเงินซ้ำ
          <div class="mt-1"><button class="btn sm" data-recheck>${icon('refresh', 16)} ตรวจสอบอีกครั้ง</button></div>`)}</div>` : ''}
        <div class="status-actions">
          <a class="btn primary" href="#${reorderPath(o)}">${icon('repeat', 18)} ${o.type === 'topup' ? 'เติมอีกครั้ง' : 'สมัครอีกครั้ง'}</a>
          <a class="btn" href="#/history">${icon('clock', 18)} ดูประวัติ</a>
          <button class="btn ghost" data-save>${icon('book', 18)} บันทึกเบอร์</button>
        </div>
      </section>
      <div class="order-layout mt-2">
        <section class="card">
          <h3 class="mb-2">รายละเอียด</h3>
          <dl class="dl">
            <dt>เลขที่รายการ</dt><dd><span class="mono">${o.ref}</span> <button class="btn ghost sm icon" data-copy="${o.ref}" title="คัดลอก">${icon('copy', 16)}</button></dd>
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
            ${o.message ? html`<dt>ข้อความ</dt><dd class="small">${o.message}</dd>` : ''}
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
      d = await api.get(`/api/orders/${encodeURIComponent(ref)}`);
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
      if (wasFinal === false) {
        refreshUser();
        if (d.order.status === 'success') toast(d.order.type === 'topup' ? 'เติมเงินสำเร็จ' : 'สมัครแพ็กเกจสำเร็จ', 'success');
        else toast('รายการไม่สำเร็จ ระบบคืนเงินเข้ากระเป๋าแล้ว', 'warning', 5000);
      }
      wasFinal = true;
      return;
    }
    wasFinal = false;
    if (slow) return;
    timer = setTimeout(tick, pollDelay(attempt++));
  }

  on(ctx.view, 'click', '[data-copy]', (e, el) => copyText(el.dataset.copy));
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
    const name = await promptDialog({ title: 'บันทึกเบอร์ลงสมุดโทรศัพท์', label: `ตั้งชื่อเรียกเบอร์ ${phoneFmt(o.phone)}`, placeholder: 'เช่น แม่, ร้านค้า, เบอร์ตัวเอง', required: true, confirmText: 'บันทึก' });
    if (!name) return;
    try {
      await api.post('/api/phonebook', { name, phone: o.phone, network: o.network });
      toast('บันทึกเบอร์แล้ว', 'success');
    } catch (err) {
      if (err.code === 'PHONE_EXISTS') toast('เบอร์นี้อยู่ในสมุดโทรศัพท์แล้ว', 'warning');
      else toastError(err);
    }
  });

  await tick();
}
