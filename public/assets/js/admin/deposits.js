// เติมเงินเข้ากระเป๋า: ตรวจสลิป → อนุมัติ / ไม่อนุมัติ
import {
  html, raw, api, baht, dateTime, dateTimeSec, phoneFmt, modal, promptDialog, confirmDialog, toast, toastError, withLoading, on, qs,
  showFieldError, clearFieldErrors,
} from '../lib.js';
import { icon, depositBadge, pagerHtml, bindPager, setQuery, emptyRow, store, registry } from './common.js';

const TABS = [
  ['waiting', 'รอตรวจสลิป'],
  ['pending', 'รอดำเนินการทั้งหมด'],
  ['approved', 'อนุมัติแล้ว'],
  ['rejected', 'ไม่อนุมัติ'],
  ['cancelled', 'ยกเลิก'],
  ['all', 'ทั้งหมด'],
];
const METHOD = { promptpay: 'พร้อมเพย์', bank: 'โอนเข้าบัญชี' };
const slipUrl = (id) => `/api/admin/deposits/${encodeURIComponent(id)}/slip`;

export function openSlip(id) {
  return modal({
    title: `สลิปรายการเติมเงิน #${id}`,
    wide: true,
    body: html`<img class="slip-full" src="${slipUrl(id)}" alt="สลิปการโอนเงิน รายการ #${id}">
      <p class="small muted center mt-2 mb-0">ตรวจชื่อผู้โอน ยอดเงิน (รวมเศษสตางค์) และเวลา ให้ตรงกับยอดเข้าบัญชีจริงก่อนอนุมัติ</p>`,
  });
}

const toSatang = (s) => {
  const [whole, frac = ''] = String(s).split('.');
  return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
};

/** คำเตือนจากเซิร์ฟเวอร์: สลิปซ้ำกับรายการที่เคยปฏิเสธ/ยกเลิก · ยอดซ้ำกับรายการอื่น (ตรวจยอดโอนให้ตรงรายการ) */
function dupWarnings(d, { inDialog = false } = {}) {
  const link = (id) => html`<a href="#/deposits?tab=all&q=${id}" ${inDialog ? raw('data-close') : ''}>#${id}</a>`;
  const out = [];
  if (d.slip_dup_of) out.push(html`<div class="text-danger bold">⚠️ สลิปเหมือนรายการ ${link(d.slip_dup_of)} ที่เคยถูกปฏิเสธ/ยกเลิก</div>`);
  if (d.amount_dup_of) out.push(html`<div class="text-warning bold">ยอดเดียวกับรายการ ${link(d.amount_dup_of)} — ตรวจยอดโอนให้ตรงรายการ</div>`);
  return out.length ? html`<div class="small stack" style="--gap:2px">${out}</div>` : '';
}

/** ถามหมายเหตุ (บังคับอย่างน้อย 3 ตัวอักษร) — คืน null ถ้ายกเลิก */
async function askNote({ title, label, value = '', confirmText }) {
  let v = value;
  for (;;) {
    v = await promptDialog({ title, label, value: v, confirmText, required: true, danger: true });
    if (v === null) return null;
    if (v.length >= 3) return v;
    toast('กรุณาระบุหมายเหตุอย่างน้อย 3 ตัวอักษร', 'error');
  }
}

async function approveFlow(d) {
  const result = await modal({
    title: `อนุมัติเติมเงิน #${d.id}`,
    body: html`<form class="stack" data-form novalidate>
      <div class="alert warning"><span class="alert-icon">!</span><div>ตรวจสอบว่ามี <b>เงินเข้าบัญชีจริง ${baht(d.amount)} บาท</b> ก่อนอนุมัติ — อนุมัติแล้วเงินจะเข้ากระเป๋าลูกค้าทันทีและยกเลิกไม่ได้ (ต้องปรับยอดเอง)</div></div>
      ${d.slip_dup_of || d.amount_dup_of ? html`<div class="alert danger"><span class="alert-icon">!</span><div class="grow">${dupWarnings(d, { inDialog: true })}</div></div>` : ''}
      ${d.has_slip ? '' : html`<div class="alert danger"><span class="alert-icon">!</span><div>รายการนี้ยังไม่มีสลิป — อนุมัติได้เฉพาะเมื่อตรวจพบยอดเงินเข้าบัญชีแล้ว (ต้องยืนยันอีกครั้งพร้อมหมายเหตุ)</div></div>`}
      <dl class="dl"><dt>ลูกค้า</dt><dd>${d.user_name} ${d.user_phone ? phoneFmt(d.user_phone) : ''}</dd><dt>ยอดที่แจ้ง</dt><dd>${baht(d.amount)} บาท</dd><dt>ช่องทาง</dt><dd>${METHOD[d.method] || d.method}</dd><dt>เวลาโอน</dt><dd>${dateTimeSec(d.transfer_at)}</dd></dl>
      <div class="field"><label>ยอดที่จะเติมเข้ากระเป๋า (บาท)</label><input class="input" name="amount" inputmode="decimal" value="${(d.amount / 100).toFixed(2)}"><div class="help">แก้ได้ถ้ายอดที่โอนจริงไม่ตรงกับที่แจ้ง (ต้องระบุเหตุผลในหมายเหตุ)</div><div class="error-text"></div></div>
      <div class="field"><label>หมายเหตุ (บังคับเมื่อแก้ยอด)</label><input class="input" name="note" maxlength="300" placeholder="เช่น ตรวจยอดเข้า KBank แล้ว"><div class="error-text"></div></div>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn success" data-ok>${icon('check')}อนุมัติและเติมเงิน</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const amountInput = form.querySelector('[name="amount"]');
      const noteInput = form.querySelector('[name="note"]');
      const submit = (e) => {
        e?.preventDefault();
        clearFieldErrors(form);
        const amount = amountInput.value.trim().replace(/,/g, '');
        if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
          showFieldError(form, { message: 'จำนวนเงินไม่ถูกต้อง', details: { field: 'amount' } });
          return;
        }
        const note = noteInput.value.trim();
        if (toSatang(amount) !== d.amount && note.length < 3) {
          showFieldError(form, { message: 'ยอดไม่ตรงกับที่ลูกค้าแจ้ง — กรุณาระบุเหตุผลในหมายเหตุ (อย่างน้อย 3 ตัวอักษร)', details: { field: 'note' } });
          return;
        }
        close({ amount, note });
      };
      form.addEventListener('submit', submit);
      dlg.querySelector('[data-ok]').addEventListener('click', submit);
    },
  });
  if (!result) return false;
  const satang = toSatang(result.amount);
  // เติมน้อยกว่าที่แจ้ง → ยืนยันอีกชั้น (เติมมากกว่าที่แจ้ง เซิร์ฟเวอร์จะถามเอง: AMOUNT_OVER_REQUESTED)
  if (satang < d.amount) {
    const ok = await confirmDialog({
      title: 'ยอดที่จะเติมน้อยกว่าที่ลูกค้าแจ้ง',
      body: html`<p class="mb-0">เติมเข้ากระเป๋า <b>${d.user_name}</b> จำนวน <b class="num">${baht(satang)} บาท</b>
        แทนยอดที่ลูกค้าแจ้ง <b class="num">${baht(d.amount)} บาท</b> (น้อยกว่า ${baht(d.amount - satang)} บาท) — ตรวจกับยอดเงินเข้าบัญชีจริงแล้วใช่หรือไม่?</p>`,
      confirmText: `ยืนยันเติม ${baht(satang)} บาท`,
      danger: true,
    });
    if (!ok) return false;
  }
  const body = { amount: result.amount, note: result.note };
  // ส่งได้ไม่เกิน 3 รอบ: ปกติ → (ไม่มีสลิป: ยืนยัน + หมายเหตุ) → (เติมเกินที่แจ้ง: ยืนยัน)
  for (;;) {
    try {
      const r = await api.post(`/api/admin/deposits/${d.id}/approve`, body);
      toast(`อนุมัติแล้ว เติม ${baht(r.deposit.credited_amount ?? d.amount)} บาท ยอดคงเหลือลูกค้า ${baht(r.balance)} บาท`, 'success', 5000);
      return true;
    } catch (err) {
      if (err.code === 'NO_SLIP' && !body.no_slip) {
        const why = await askNote({
          title: 'อนุมัติแบบไม่มีสลิป',
          label: `อนุมัติแบบไม่มีสลิป — ตรวจพบยอดเงินเข้าบัญชีแล้วเท่านั้น · ${d.user_name} · เติม ${baht(satang)} บาท · หมายเหตุ (บังคับ เช่น เวลาและธนาคารที่เงินเข้า)`,
          value: body.note,
          confirmText: `อนุมัติแบบไม่มีสลิป ${baht(satang)} บาท`,
        });
        if (why === null) return false;
        Object.assign(body, { no_slip: true, note: why });
        continue;
      }
      if (err.code === 'AMOUNT_OVER_REQUESTED' && !body.confirm_over) {
        const credited = err.details?.credited ?? satang;
        const ok = await confirmDialog({
          title: 'ยอดที่จะเติมมากกว่าที่ลูกค้าแจ้ง',
          body: html`<p>${err.message}</p><p class="small mb-0">ลูกค้า <b>${d.user_name}</b> · แจ้ง ${baht(err.details?.requested ?? d.amount)} บาท → เติม <b class="num">${baht(credited)} บาท</b></p>`,
          confirmText: `ยืนยันเติม ${baht(credited)} บาท`,
          danger: true,
        });
        if (!ok) return false;
        body.confirm_over = true;
        continue;
      }
      throw err;
    }
  }
}

async function rejectFlow(d) {
  const note = await promptDialog({
    title: `ไม่อนุมัติรายการ #${d.id}`,
    label: `${d.user_name} · ยอดแจ้ง ${baht(d.amount)} บาท — เหตุผล (ลูกค้าจะเห็นข้อความนี้ อย่างน้อย 3 ตัวอักษร)`,
    placeholder: 'เช่น ไม่พบยอดเงินเข้า / สลิปไม่ชัด กรุณาแนบใหม่',
    confirmText: 'ไม่อนุมัติ',
    required: true,
    danger: true,
  });
  if (note === null) return false;
  await api.post(`/api/admin/deposits/${d.id}/reject`, { note });
  toast('บันทึกไม่อนุมัติแล้ว', 'success');
  return true;
}

function card(d) {
  return html`<article class="card dep-card" data-id="${d.id}">
    ${d.has_slip
      ? html`<div class="slip" data-slip="${d.id}" title="คลิกเพื่อดูภาพเต็ม"><img loading="lazy" src="${slipUrl(d.id)}" alt="สลิป #${d.id}"></div>`
      : html`<div class="slip none">ลูกค้ายังไม่แนบสลิป</div>`}
    <div class="row between"><span class="amount num">฿${baht(d.amount)}</span>${depositBadge(d.status, d.status_label)}</div>
    <div class="small">
      <div><button class="link-btn" data-user="${d.user_id}">${d.user_name}</button> <span class="muted">${d.user_phone ? phoneFmt(d.user_phone) : ''}</span></div>
      <div class="muted">#${d.id} · ${METHOD[d.method] || d.method} · แจ้งเมื่อ ${dateTime(d.created_at)}</div>
      ${d.transfer_at ? html`<div class="muted">เวลาโอนที่แจ้ง ${dateTimeSec(d.transfer_at)}</div>` : ''}
      ${d.note ? html`<div class="text-2">หมายเหตุลูกค้า: ${d.note}</div>` : ''}
    </div>
    ${dupWarnings(d)}
    ${d.status === 'pending' ? html`<div class="row">
      <button class="btn success sm grow" data-approve="${d.id}" title="${d.has_slip ? 'อนุมัติและเติมเงินเข้ากระเป๋า' : 'ลูกค้ายังไม่แนบสลิป — ตรวจยอดเข้าบัญชีก่อนอนุมัติ'}">${icon('check')}อนุมัติ</button>
      <button class="btn danger sm grow" data-reject="${d.id}">${icon('x')}ไม่อนุมัติ</button>
    </div>` : ''}
  </article>`;
}

function table(rows) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>#</th><th>เวลา</th><th>ลูกค้า</th><th>ช่องทาง</th><th class="num">ยอดแจ้ง</th><th class="num">ยอดที่เติม</th><th>สลิป</th><th>สถานะ</th><th>ผู้ตรวจ / หมายเหตุ</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((d) => html`<tr>
      <td class="mono">${d.id}</td>
      <td class="nowrap small">${dateTime(d.created_at)}</td>
      <td><button class="link-btn" data-user="${d.user_id}">${d.user_name}</button><span class="sub">${d.user_phone ? phoneFmt(d.user_phone) : ''}</span></td>
      <td class="small">${METHOD[d.method] || d.method}</td>
      <td class="num">${baht(d.amount)}</td>
      <td class="num">${d.credited_amount !== null && d.credited_amount !== undefined ? baht(d.credited_amount) : '-'}</td>
      <td>${d.has_slip ? html`<img class="slip-thumb" data-slip="${d.id}" loading="lazy" src="${slipUrl(d.id)}" alt="สลิป #${d.id}">` : html`<span class="muted small">-</span>`}</td>
      <td>${depositBadge(d.status, d.status_label)}</td>
      <td class="small">${dupWarnings(d)}${d.reviewer_name || ''}${d.reviewed_at ? html`<span class="sub">${dateTime(d.reviewed_at)}</span>` : ''}${d.admin_note ? html`<span class="sub">${d.admin_note}</span>` : ''}</td>
      <td class="actions">${d.status === 'pending' ? html`<button class="btn success sm" data-approve="${d.id}">อนุมัติ</button> <button class="btn danger sm" data-reject="${d.id}">ไม่อนุมัติ</button>` : ''}</td>
    </tr>`) : emptyRow(10, 'ไม่มีรายการ')}</tbody></table></div>`;
}

export async function render(el, params, query) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'waiting';
  const q = query.q || '';
  const page = Number(query.page) || 1;
  el.innerHTML = html`
    <div class="page-head"><p class="desc">ลูกค้าโอนเงินผ่านพร้อมเพย์/บัญชีธนาคารแล้วแนบสลิป — ตรวจยอดเข้าบัญชีจริงทุกครั้งก่อนอนุมัติ (ยอดมีเศษสตางค์ช่วยจับคู่สลิปกับรายการ)</p></div>
    <div class="row between wrap">
      <div class="tabs" role="tablist">${TABS.map(([k, label]) => html`<button class="${k === tab ? 'active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}">${label}${k === 'waiting' && store.dash?.deposits_waiting?.c ? html`<span class="count">${store.dash.deposits_waiting.c}</span>` : ''}</button>`)}</div>
      <form class="row" data-search><input class="input" name="q" value="${q}" placeholder="ชื่อ/เบอร์ลูกค้า หรือเลขที่" style="min-height:38px;width:220px"><button class="btn sm" type="submit">${icon('search')}ค้นหา</button></form>
    </div>
    <div data-list><div class="empty"><span class="spinner"></span></div></div>`.toString();

  const rowsById = new Map();
  const load = async () => {
    try {
      const res = await api.get(`/api/admin/deposits${qs({ status: tab === 'all' ? '' : tab, q, page, pageSize: tab === 'waiting' ? 60 : 30 })}`);
      rowsById.clear();
      res.rows.forEach((r) => rowsById.set(String(r.id), r));
      const list = el.querySelector('[data-list]');
      if (tab === 'waiting') {
        list.innerHTML = res.rows.length
          ? html`<div class="dep-grid">${res.rows.map(card)}</div>${pagerHtml(res)}`.toString()
          : html`<div class="card"><div class="empty"><div class="empty-icon">✓</div><b>ไม่มีสลิปรอตรวจ</b><div class="small">รายการใหม่จะแสดงที่นี่เมื่อมีลูกค้าแนบสลิป</div></div></div>`.toString();
      } else {
        list.innerHTML = html`<section class="card flush">${table(res.rows)}${pagerHtml(res)}</section>`.toString();
      }
    } catch (err) {
      el.querySelector('[data-list]').innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
    }
  };

  const findRow = async (id) => rowsById.get(String(id));

  on(el, 'click', '[data-tab]', (e, b) => setQuery('/deposits', { tab: b.dataset.tab, q }));
  el.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    setQuery('/deposits', { tab, q: e.target.querySelector('[name="q"]').value.trim() });
  });
  on(el, 'click', '[data-slip]', (e, s) => openSlip(s.dataset.slip));
  on(el, 'click', '[data-user]', (e, b) => registry.openUser?.(Number(b.dataset.user)));
  // ล็อกปุ่มตลอดขั้นตอน (หน้าต่างยืนยัน + ส่งคำสั่ง) กันกดอนุมัติ/ไม่อนุมัติซ้ำ
  on(el, 'click', '[data-approve]', (e, b) => withLoading(b, async () => {
    try {
      const d = await findRow(b.dataset.approve);
      if (!d) throw new Error('ไม่พบรายการ');
      if (await approveFlow(d)) { await load(); store.refresh().catch(() => {}); }
    } catch (err) { toastError(err); }
  }));
  on(el, 'click', '[data-reject]', (e, b) => withLoading(b, async () => {
    try {
      const d = await findRow(b.dataset.reject);
      if (!d) throw new Error('ไม่พบรายการ');
      if (await rejectFlow(d)) { await load(); store.refresh().catch(() => {}); }
    } catch (err) { toastError(err); }
  }));
  bindPager(el, (p) => setQuery('/deposits', { tab, q, page: p }));
  await load();
  if (tab === 'waiting') {
    const unsub = store.subscribe(() => load().catch(() => {}));
    return () => unsub();
  }
  return undefined;
}

export { approveFlow, rejectFlow };
