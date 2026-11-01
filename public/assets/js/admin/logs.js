// Log: การเชื่อมต่อผู้ให้บริการ / การกระทำในระบบ / webhook / สมุดบัญชีรวม
import { html, raw, api, baht, dateTimeSec, phoneFmt, statusBadge, modal, toast, toastError, withLoading, on, qs, formData } from '../lib.js';
import {
  icon, PLOG_ACTIONS, LEDGER_LABELS, signedBaht, pagerHtml, bindPager, setQuery, emptyRow, opt, detailText, registry, actionLabel, actionOptions, isCliEntry,
} from './common.js';
import { providerLogItem } from './orderDetail.js';

const TABS = [
  ['provider', 'การเชื่อมต่อผู้ให้บริการ'],
  ['audit', 'การกระทำในระบบ'],
  ['webhooks', 'Webhook ร้านค้า'],
  ['ledger', 'สมุดบัญชีรวม'],
];

function providerFilters(q) {
  return html`<form class="card filter-card toolbar" data-filter>
    <div class="field"><label>เลขที่รายการ</label><input class="input mono" name="ref" value="${q.ref || ''}" placeholder="TP…"></div>
    <div class="field"><label>คำสั่ง</label><select class="select" name="action">${opt('', 'ทั้งหมด', q.action)}${Object.entries(PLOG_ACTIONS).map(([k, l]) => opt(k, l, q.action))}</select></div>
    <label class="check" style="align-self:center"><input type="checkbox" name="errors" value="1" ${q.errors === '1' ? raw('checked') : ''}>เฉพาะที่ผิดพลาด / ไม่ทราบผล</label>
    <div class="row"><button class="btn primary" type="submit">${icon('search')}ค้นหา</button></div>
  </form>`;
}

async function providerTab(box, q) {
  const res = await api.get(`/api/admin/logs/provider${qs({ ref: q.ref, action: q.action, errors: q.errors, page: q.page, pageSize: 40 })}`);
  box.innerHTML = html`<p class="small muted">ทุกคำขอไป/กลับจากผู้ให้บริการถูกบันทึกไว้ (ซ่อนรหัสลับแล้ว) — คลิกเพื่อดูข้อมูลดิบ</p>
    ${res.rows.length ? res.rows.map((l) => providerLogItem(l, { showRef: true })) : html`<div class="card"><div class="empty">ไม่มี log</div></div>`}
    ${pagerHtml(res)}`.toString();
}

async function auditTab(box, q) {
  const res = await api.get(`/api/admin/logs/audit${qs({ action: q.action, page: q.page, pageSize: 40 })}`);
  box.innerHTML = html`<section class="card flush"><div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>ผู้กระทำ</th><th>การกระทำ</th><th>เป้าหมาย</th><th>รายละเอียด</th><th>IP</th></tr></thead>
    <tbody>${res.rows.length ? res.rows.map((a) => html`<tr>
      <td class="small nowrap">${dateTimeSec(a.created_at)}</td>
      <td class="small">${a.actor_name || (a.actor_id ? `#${a.actor_id}` : isCliEntry(a) ? html`<span class="pill">คำสั่งในเครื่อง (CLI)</span>` : html`<span class="muted">ระบบ</span>`)}${a.actor_email ? html`<span class="sub">${a.actor_email}</span>` : ''}</td>
      <td class="small">${actionLabel(a.action)}<span class="sub mono">${a.action}</span></td>
      <td class="small mono">${a.target_type ? `${a.target_type}${a.target_id ? `:${a.target_id}` : ''}` : '-'}</td>
      <td class="small" style="max-width:420px;white-space:pre-line">${detailText(a.detail)}</td>
      <td class="small mono">${a.ip || ''}</td>
    </tr>`) : emptyRow(6, 'ไม่มีข้อมูล')}</tbody></table></div>${pagerHtml(res)}</section>`.toString();
}

async function webhooksTab(box, q) {
  const res = await api.get(`/api/admin/webhooks${qs({ status: q.status, page: q.page, pageSize: 40 })}`);
  box.innerHTML = html`<section class="card flush"><div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>รายการ</th><th>URL ร้านค้า</th><th>สถานะ</th><th class="num">ส่งแล้ว</th><th>ผลล่าสุด</th><th>ลองใหม่</th><th></th></tr></thead>
    <tbody>${res.rows.length ? res.rows.map((w) => html`<tr>
      <td class="small nowrap">${dateTimeSec(w.created_at)}</td>
      <td><button class="link-btn mono small" data-ref="${w.order_ref}">${w.order_ref}</button></td>
      <td class="mono xsmall" style="max-width:280px;word-break:break-all">${w.url}</td>
      <td>${w.status === 'delivered' ? html`<span class="badge success">ส่งแล้ว</span>` : w.status === 'failed' ? html`<span class="badge danger">ล้มเหลว</span>` : html`<span class="badge warning">รอส่ง</span>`}</td>
      <td class="num">${w.attempts}</td>
      <td class="small">${w.last_http_status ? `HTTP ${w.last_http_status} ` : ''}${w.last_error || ''}</td>
      <td class="small nowrap">${w.next_attempt_at ? dateTimeSec(w.next_attempt_at) : '-'}</td>
      <td class="actions">${w.status !== 'delivered' ? html`<button class="btn sm" data-retry="${w.id}">${icon('refresh')}ส่งใหม่</button>` : ''}</td>
    </tr>`) : emptyRow(8, 'ไม่มี webhook')}</tbody></table></div>${pagerHtml(res)}</section>`.toString();
}

/** อธิบายรายการที่เงินไม่ตรงสถานะ (net = ผลรวมสมุดบัญชีของรายการ ติดลบ = เก็บเงินลูกค้า) */
function reconcileReason(o) {
  const charged = -Number(o.net || 0);
  const expected = o.status === 'failed' || o.status === 'refunded' ? 0 : o.price;
  if (o.status === 'success' && charged === 0) return 'สำเร็จแต่ยังไม่ได้เก็บเงิน';
  if (expected === 0 && charged > 0) return 'ไม่สำเร็จแต่ยังไม่ได้คืนเงิน';
  if (expected > 0 && charged === 0) return 'ยังไม่ได้ตัดเงิน';
  return `เก็บเงินแล้ว ${baht(charged)} บาท (ควรเป็น ${baht(expected)} บาท)`;
}

function reconcileBody(r) {
  const orders = r.orders || [];
  if (!r.mismatches.length && !orders.length) {
    return html`<div class="alert success"><span class="alert-icon">✓</span><div>ยอดเงินทุกบัญชีตรงกับสมุดบัญชี และทุกรายการเก็บเงิน/คืนเงินตรงกับสถานะ ไม่พบความผิดปกติ</div></div>`;
  }
  return html`
    ${r.mismatches.length
      ? html`<div class="alert danger"><span class="alert-icon">!</span><div>พบ ${r.mismatches.length} บัญชีที่ยอดในกระเป๋าไม่ตรงกับสมุดบัญชี — กรุณาตรวจสอบ</div></div>
        <div class="table-wrap mt-2"><table class="table"><thead><tr><th>ผู้ใช้</th><th class="num">ยอดในกระเป๋า</th><th class="num">ผลรวมสมุดบัญชี</th></tr></thead>
        <tbody>${r.mismatches.map((m) => html`<tr><td><button class="link-btn" data-user="${m.id}">#${m.id} ${m.name}</button></td><td class="num">${baht(m.balance)}</td><td class="num">${baht(m.ledger_sum)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="alert success"><span class="alert-icon">✓</span><div>ยอดในกระเป๋าทุกบัญชีตรงกับสมุดบัญชี</div></div>`}
    ${orders.length ? html`<h4 class="mt-2 mb-1">รายการที่ยอดเงินไม่ตรงสถานะ (${orders.length})</h4>
      <p class="small muted mt-0">ตรวจกับผู้ให้บริการและสมุดบัญชีของลูกค้า แล้วปรับยอดเองที่หน้าผู้ใช้ (ระบบไม่ขยับเงินให้อัตโนมัติ)</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>เลขที่</th><th>ลูกค้า</th><th>สถานะ</th><th class="num">ราคา</th><th class="num">เก็บเงินสุทธิ</th><th>ปัญหา</th></tr></thead>
      <tbody>${orders.map((o) => html`<tr>
        <td><button class="link-btn mono small" data-ref="${o.ref}">${o.ref}</button></td>
        <td class="small"><button class="link-btn" data-user="${o.user_id}">#${o.user_id} ${o.user_name}</button></td>
        <td>${statusBadge(o.status)}</td>
        <td class="num">${baht(o.price)}</td>
        <td class="num">${baht(-Number(o.net || 0))}</td>
        <td class="small text-danger bold">${reconcileReason(o)}</td>
      </tr>`)}</tbody></table></div>` : ''}`;
}

async function ledgerTab(box, q) {
  const res = await api.get(`/api/admin/ledger${qs({ type: q.type, page: q.page, pageSize: 40 })}`);
  box.innerHTML = html`<section class="card flush"><div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>ประเภท</th><th class="num">จำนวน</th><th class="num">คงเหลือ</th><th>อ้างอิง / หมายเหตุ</th></tr></thead>
    <tbody>${res.rows.length ? res.rows.map((l) => html`<tr>
      <td class="small nowrap">${dateTimeSec(l.created_at)}</td>
      <td class="small"><button class="link-btn" data-user="${l.user_id}">${l.user_name}</button><span class="sub">${l.user_phone ? phoneFmt(l.user_phone) : ''}</span></td>
      <td class="small">${l.type_label || LEDGER_LABELS[l.type] || l.type}</td>
      <td class="num">${signedBaht(l.amount)}</td>
      <td class="num">${baht(l.balance_after)}</td>
      <td class="small">${l.order_ref ? html`<button class="link-btn mono" data-ref="${l.order_ref}">${l.order_ref}</button> ` : ''}${l.note || ''}${l.actor_name ? html`<span class="sub">โดย ${l.actor_name}</span>` : ''}</td>
    </tr>`) : emptyRow(6, 'ไม่มีข้อมูล')}</tbody></table></div>${pagerHtml(res)}</section>`.toString();
}

export async function render(el, params, query) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'provider';
  const q = { ...query, tab };
  const filters = {
    provider: providerFilters(q),
    audit: html`<form class="card filter-card toolbar" data-filter>
      <div class="field grow"><label for="lg-action">การกระทำ</label><select class="select" id="lg-action" name="action">${actionOptions(q.action)}</select>
        <div class="help">เลือก "ทั้งหมดในหมวด" เพื่อดูทุกการกระทำของหมวดนั้น (เช่น ผู้ให้บริการ / จับคู่บริการ)</div></div>
      <div class="row"><button class="btn primary" type="submit">${icon('search')}ค้นหา</button></div></form>`,
    webhooks: html`<form class="card filter-card toolbar" data-filter>
      <div class="field"><label>สถานะ</label><select class="select" name="status">${opt('', 'ทั้งหมด', q.status)}${opt('pending', 'รอส่ง', q.status)}${opt('delivered', 'ส่งแล้ว', q.status)}${opt('failed', 'ล้มเหลว', q.status)}</select></div>
      <div class="row"><button class="btn primary" type="submit">${icon('search')}ค้นหา</button></div></form>`,
    ledger: html`<form class="card filter-card toolbar" data-filter>
      <div class="field"><label>ประเภท</label><select class="select" name="type">${opt('', 'ทั้งหมด', q.type)}${Object.entries(LEDGER_LABELS).map(([k, l]) => opt(k, l, q.type))}</select></div>
      <div class="row"><button class="btn primary" type="submit">${icon('search')}ค้นหา</button><button class="btn" type="button" data-reconcile title="ตรวจความถูกต้องของยอดเงิน (กระเป๋า ↔ สมุดบัญชี ↔ สถานะรายการ)">${icon('check')}ตรวจยอดเงิน</button></div></form>`,
  };
  el.innerHTML = html`
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button class="${k === tab ? 'active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}">${l}</button>`)}</div>
    ${filters[tab]}
    <div data-box><div class="empty"><span class="spinner"></span></div></div>`.toString();

  const box = el.querySelector('[data-box]');
  const loaders = { provider: providerTab, audit: auditTab, webhooks: webhooksTab, ledger: ledgerTab };
  const load = async () => {
    try {
      await loaders[tab](box, q);
    } catch (err) {
      box.innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
    }
  };

  on(el, 'click', '[data-tab]', (e, b) => setQuery('/logs', { tab: b.dataset.tab }));
  el.querySelector('[data-filter]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(e.target);
    setQuery('/logs', { tab, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
  });
  bindPager(box, (p) => setQuery('/logs', { ...q, page: p }));
  on(box, 'click', '[data-ref]', (e, b) => registry.openOrder(b.dataset.ref));
  on(box, 'click', '[data-user]', (e, b) => registry.openUser?.(Number(b.dataset.user)));
  on(box, 'click', '[data-retry]', (e, b) => withLoading(b, async () => {
    try {
      await api.post(`/api/admin/webhooks/${b.dataset.retry}/retry`);
      toast('ส่ง webhook ใหม่แล้ว', 'success');
      setTimeout(load, 800);
    } catch (err) { toastError(err); }
  }));
  el.querySelector('[data-reconcile]')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      const r = await api.get('/api/admin/reconcile');
      modal({
        title: 'ผลการตรวจยอดเงิน',
        wide: Boolean(r.orders?.length),
        body: reconcileBody(r),
        onMount: (dlg, close) => {
          on(dlg, 'click', '[data-ref]', (ev, b) => { close(); registry.openOrder(b.dataset.ref); });
          on(dlg, 'click', '[data-user]', (ev, b) => { close(); registry.openUser?.(Number(b.dataset.user)); });
        },
      });
    } catch (err) { toastError(err); }
  }));
  await load();
}
