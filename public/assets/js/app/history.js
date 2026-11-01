// ประวัติการทำรายการ: กรองสถานะ/ประเภท/เครือข่าย/วันที่ + ค้นหา + ดาวน์โหลด CSV + ทำรายการซ้ำ
import { html, api, on, setHTML, qs, baht, phoneFmt, dateTime, statusBadge, debounce, navigate } from '../lib.js';
import { state, shopNote } from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, orderItem, emptyState, pager, reorderPath, typeLabel } from './ui.js';

const STATUS_TABS = [
  { v: '', l: 'ทั้งหมด' },
  { v: 'success', l: 'สำเร็จ' },
  { v: 'active', l: 'กำลังดำเนินการ' },
  { v: 'failed', l: 'ไม่สำเร็จ' },
  { v: 'refunded', l: 'คืนเงินแล้ว' },
];

export default async function historyPage(ctx) {
  const q = ctx.query;
  const f = {
    status: STATUS_TABS.some((t) => t.v === q.status) ? q.status : '',
    type: ['topup', 'package'].includes(q.type) ? q.type : '',
    network: q.network || '',
    q: q.q || '',
    from: q.from || '',
    to: q.to || '',
    batch: q.batch || '',
    page: Math.max(1, Number(q.page) || 1),
  };
  const nets = state.catalog.networks;

  setHTML(ctx.view, html`
    ${pageHead('ประวัติการทำรายการ', 'ดูสถานะ รายละเอียด และความคืบหน้าของทุกรายการ', html`<a class="btn sm" data-export download>${icon('download', 16)} ดาวน์โหลด CSV</a>`)}
    <div class="filters">
      <div class="segmented scroll" data-status role="tablist">
        ${STATUS_TABS.map((t) => html`<button type="button" role="tab" data-v="${t.v}" class="${f.status === t.v ? 'active' : ''}">${t.l}</button>`)}
      </div>
      <div class="filter-row">
        <div class="search-box">${icon('search', 18)}<input class="input" data-f="q" type="search" placeholder="ค้นหาเลขที่รายการ หรือเบอร์" value="${f.q}" autocomplete="off"></div>
        <select class="select" data-f="type" aria-label="ประเภท">
          <option value="">ทุกประเภท</option>
          <option value="topup" ${f.type === 'topup' ? 'selected' : ''}>เติมเงิน</option>
          <option value="package" ${f.type === 'package' ? 'selected' : ''}>แพ็กเกจ</option>
        </select>
        <select class="select" data-f="network" aria-label="เครือข่าย">
          <option value="">ทุกเครือข่าย</option>
          ${nets.map((n) => html`<option value="${n.code}" ${f.network === n.code ? 'selected' : ''}>${n.name}</option>`)}
        </select>
        <input class="input" type="date" data-f="from" value="${f.from}" aria-label="ตั้งแต่วันที่" title="ตั้งแต่วันที่">
        <input class="input" type="date" data-f="to" value="${f.to}" aria-label="ถึงวันที่" title="ถึงวันที่">
      </div>
      <div data-batch-note></div>
    </div>
    <div class="card flush" data-list></div>`);

  const view = ctx.view;
  const listEl = view.querySelector('[data-list]');
  const exportEl = view.querySelector('[data-export]');
  const batchNote = view.querySelector('[data-batch-note]');
  let rows = [];
  let seq = 0;

  function filterQuery(withPage) {
    const { page, ...rest } = f;
    return withPage ? { ...rest, page: page > 1 ? page : '' } : rest;
  }

  async function load() {
    const my = ++seq;
    history.replaceState(null, '', `#/history${qs(filterQuery(true))}`);
    exportEl.href = `/api/orders/export.csv${qs(filterQuery(false))}`;
    setHTML(batchNote, f.batch ? html`<div class="chip sm active">ชุดเติมหลายเบอร์ ${f.batch} <button type="button" class="chip-x" data-clear-batch aria-label="ล้าง">✕</button></div>` : '');
    setHTML(listEl, html`<div class="p-3 stack">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:52px"></div>`)}</div>`);
    let d;
    try {
      d = await api.get(`/api/orders${qs({ ...filterQuery(false), page: f.page, pageSize: 20 })}`);
    } catch (err) {
      if (my === seq && ctx.alive()) setHTML(listEl, emptyState('alert', 'โหลดประวัติไม่สำเร็จ', err.message, html`<button class="btn sm" data-retry>ลองใหม่</button>`));
      return;
    }
    if (my !== seq || !ctx.alive()) return;
    rows = d.rows;
    const filtered = f.status || f.type || f.network || f.q || f.from || f.to || f.batch;
    if (!rows.length) {
      setHTML(listEl, emptyState('clock', filtered ? 'ไม่พบรายการตามเงื่อนไข' : 'ยังไม่มีรายการ',
        filtered ? 'ลองเปลี่ยนตัวกรองหรือคำค้นหา' : 'เริ่มเติมเงินหรือสมัครแพ็กเกจได้เลย',
        filtered ? html`<button class="btn sm" data-clear>ล้างตัวกรอง</button>` : html`<a class="btn primary sm" href="#/topup">เติมเงินมือถือ</a>`));
      return;
    }
    setHTML(listEl, html`
      <div class="order-list only-mobile">${rows.map((o) => orderItem(o, { reorder: true }))}</div>
      <div class="table-wrap only-desktop"><table class="table">
        <thead><tr><th>วันที่ / เลขที่</th><th>รายการ</th><th>เบอร์</th><th class="num">ชำระ</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${rows.map((o) => html`<tr class="clickable" data-ref="${o.ref}">
          <td class="nowrap"><div class="small">${dateTime(o.created_at)}</div><div class="xsmall muted mono">${o.ref}</div></td>
          <td><div class="row" style="--gap:8px">${netTag(o.network)}<span>${o.product_name}</span></div>
            <div class="xsmall muted">${typeLabel(o.type)}${o.source === 'bulk' ? ' · เติมหลายเบอร์' : o.source === 'api' ? ' · API' : ''}${shopNote(o) ? ` · ร้าน ${shopNote(o)}` : ''}${!o.final ? '' : o.status !== 'success' && o.message ? ` · ${o.message}` : ''}</div></td>
          <td class="num nowrap">${phoneFmt(o.phone)}</td>
          <td class="num">฿${baht(o.price)}</td>
          <td>${statusBadge(o.status)}</td>
          <td class="right">${!o.final ? html`<span class="xsmall muted">รอผล</span>`
            : html`<button type="button" class="btn sm ghost" data-reorder="${o.ref}" title="${o.status === 'success' ? 'ทำรายการเดิมอีกครั้ง' : 'ลองอีกครั้ง (เลือกเครือข่ายใหม่)'}">${icon('repeat', 16)} ${o.status === 'success' ? 'เติมซ้ำ' : 'ลองใหม่'}</button>`}</td>
        </tr>`)}</tbody>
      </table></div>
      ${pager(d)}`);
  }

  on(view.querySelector('[data-status]'), 'click', '[data-v]', (e, el) => {
    f.status = el.dataset.v;
    f.page = 1;
    view.querySelectorAll('[data-status] [data-v]').forEach((b) => b.classList.toggle('active', b === el));
    load();
  });
  const onFilter = (el) => {
    f[el.dataset.f] = el.value.trim();
    f.page = 1;
    load();
  };
  const debounced = debounce(onFilter, 350);
  on(view, 'input', 'input[data-f="q"]', (e, el) => debounced(el));
  on(view, 'change', 'select[data-f], input[type="date"][data-f]', (e, el) => onFilter(el));
  on(listEl, 'click', '[data-page]', (e, el) => {
    f.page = Math.max(1, Number(el.dataset.page));
    load();
    view.scrollIntoView({ block: 'start' });
  });
  on(listEl, 'click', '[data-reorder]', (e, el) => {
    const o = rows.find((x) => x.ref === el.dataset.reorder);
    const path = reorderPath(o); // ยังไม่รู้ผล = ไม่มีให้ทำซ้ำ
    if (path) navigate(path);
  });
  on(listEl, 'click', 'tr[data-ref]', (e, el) => {
    if (e.target.closest('[data-reorder]')) return;
    navigate(`/order/${el.dataset.ref}`);
  });
  on(listEl, 'click', '[data-retry]', () => load());
  const clearAll = () => {
    Object.assign(f, { status: '', type: '', network: '', q: '', from: '', to: '', batch: '', page: 1 });
    view.querySelectorAll('[data-f]').forEach((el) => { el.value = ''; });
    view.querySelectorAll('[data-status] [data-v]').forEach((b) => b.classList.toggle('active', b.dataset.v === ''));
    load();
  };
  on(listEl, 'click', '[data-clear]', clearAll);
  on(batchNote, 'click', '[data-clear-batch]', () => { f.batch = ''; f.page = 1; load(); });

  await load();
}
