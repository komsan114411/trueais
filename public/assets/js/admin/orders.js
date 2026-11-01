// หน้ารายการทั้งหมด + หน้ารอตรวจสอบ
import { html, api, baht, numFmt, dateTime, phoneFmt, statusBadge, netBadge, qs, on, formData, toastError } from '../lib.js';
import { icon, SOURCE_LABELS, pagerHtml, bindPager, setQuery, emptyRow, networkOptions, opt, store, registry } from './common.js';

const STATUS_OPTS = [
  ['', 'ทุกสถานะ'],
  ['active', 'รอ/กำลังดำเนินการ'],
  ['success', 'สำเร็จ'],
  ['failed', 'ไม่สำเร็จ'],
  ['refunded', 'คืนเงินแล้ว'],
  ['review', 'ต้องตรวจสอบ'],
];

function ordersTable(rows) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr>
      <th>เวลา</th><th>เลขที่ / ลูกค้า</th><th>รายการ</th><th>ร้าน</th><th>เบอร์</th>
      <th class="num">ราคา</th><th class="num">กำไร</th><th>สถานะ</th>
    </tr></thead>
    <tbody>${rows.length ? rows.map((o) => html`<tr class="clickable ${o.needs_review ? 'row-review' : ''}" data-ref="${o.ref}">
      <td class="nowrap small">${dateTime(o.created_at)}<span class="sub">${SOURCE_LABELS[o.source] || o.source}</span></td>
      <td><span class="mono">${o.ref}</span><span class="sub">${o.user_name}${o.user_phone ? ` · ${phoneFmt(o.user_phone)}` : ''}</span></td>
      <td><div class="item">${netBadge(o.network)}<span class="truncate" style="max-width:260px">${o.product_name}</span></div>${o.message && !o.final ? html`<span class="sub truncate" style="max-width:300px">${o.message}</span>` : ''}</td>
      <td class="small">${o.handled_by || o.shop_name || html`<span class="muted">-</span>`}${o.shop_name && o.handled_by && o.shop_name !== o.handled_by
        ? html`<span class="sub text-warning">ลูกค้าเลือก ${o.shop_name} → ส่งต่อ</span>` : ''}</td>
      <td class="nowrap num">${phoneFmt(o.phone)}</td>
      <td class="num">${baht(o.price)}</td>
      <td class="num">${o.status === 'success' ? baht(o.profit) : html`<span class="muted">-</span>`}</td>
      <td>${statusBadge(o.status, o.status_label)}${o.needs_review ? html`<span class="sub"><span class="flag">${icon('review')}ตรวจสอบ</span></span>` : ''}</td>
    </tr>`) : emptyRow(8, 'ไม่พบรายการตามเงื่อนไข')}</tbody>
  </table></div>`;
}

export async function renderOrders(el, params, query) {
  const q = { status: query.status || '', type: query.type || '', network: query.network || '', source: query.source || '', q: query.q || '', from: query.from || '', to: query.to || '', userId: query.userId || '', batch: query.batch || '', page: query.page || 1 };
  el.innerHTML = html`
    <div class="page-head"><p class="desc">ค้นหาด้วยเลขที่รายการ, เบอร์ปลายทาง, เลขอ้างอิงร้านค้า หรือเลขที่ผู้ให้บริการ · คลิกแถวเพื่อดูรายละเอียดและจัดการ</p></div>
    <form class="card filter-card toolbar" data-filter>
      <div class="field grow"><label>ค้นหา</label><input class="input" name="q" value="${q.q}" placeholder="เช่น TP261101… หรือ 0812345678"></div>
      <div class="field"><label>สถานะ</label><select class="select" name="status">${STATUS_OPTS.map(([v, l]) => opt(v, l, q.status))}</select></div>
      <div class="field"><label>ประเภท</label><select class="select" name="type">${opt('', 'ทั้งหมด', q.type)}${opt('topup', 'เติมเงิน', q.type)}${opt('package', 'แพ็กเกจ', q.type)}</select></div>
      <div class="field"><label>เครือข่าย</label><select class="select" name="network">${networkOptions(q.network)}</select></div>
      <div class="field"><label>ช่องทาง</label><select class="select" name="source">${opt('', 'ทั้งหมด', q.source)}${Object.entries(SOURCE_LABELS).map(([v, l]) => opt(v, l, q.source))}</select></div>
      <div class="field"><label>ตั้งแต่วันที่</label><input class="input" type="date" name="from" value="${q.from}"></div>
      <div class="field"><label>ถึงวันที่</label><input class="input" type="date" name="to" value="${q.to}"></div>
      ${q.userId ? html`<input type="hidden" name="userId" value="${q.userId}">` : ''}
      ${q.batch ? html`<input type="hidden" name="batch" value="${q.batch}">` : ''}
      <div class="row">
        <button class="btn primary" type="submit">${icon('search')}ค้นหา</button>
        <button class="btn" type="button" data-reset>ล้าง</button>
        <a class="btn" data-csv href="#">${icon('download')}CSV</a>
      </div>
    </form>
    ${q.userId || q.batch ? html`<div class="alert"><span class="alert-icon">i</span><div>กำลังกรอง${q.userId ? html` เฉพาะผู้ใช้ #${q.userId}` : ''}${q.batch ? html` เฉพาะชุด <span class="mono">${q.batch}</span>` : ''} · <a href="#/orders">ดูทั้งหมด</a></div></div>` : ''}
    <section class="card flush">
      <div class="summary-line" data-summary style="padding:12px 16px;border-bottom:1px solid var(--border)"><span class="muted">กำลังโหลด...</span></div>
      <div data-list><div class="empty"><span class="spinner"></span></div></div>
    </section>`.toString();

  const form = el.querySelector('[data-filter]');
  const params2 = () => {
    const f = formData(form);
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  };
  el.querySelector('[data-csv]').href = `/api/admin/orders/export.csv${qs({ ...q, page: undefined })}`;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setQuery('/orders', params2());
  });
  el.querySelector('[data-reset]').addEventListener('click', () => setQuery('/orders', {}));

  const load = async () => {
    try {
      const res = await api.get(`/api/admin/orders${qs({ ...q, pageSize: 25 })}`);
      el.querySelector('[data-summary]').innerHTML = html`
        <span>พบ <b>${numFmt(res.summary.count)}</b> รายการ</span>
        <span>ยอดขาย (สำเร็จ) <b>฿${baht(res.summary.revenue)}</b></span>
        <span>กำไร <b>฿${baht(res.summary.profit)}</b></span>
        <span class="grow"></span>
        <button class="btn ghost sm" data-reload>${icon('refresh')}รีเฟรช</button>`.toString();
      el.querySelector('[data-list]').innerHTML = html`${ordersTable(res.rows)}${pagerHtml(res)}`.toString();
    } catch (err) {
      el.querySelector('[data-list]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
    }
  };
  on(el, 'click', 'tr[data-ref]', (e, tr) => registry.openOrder(tr.dataset.ref, { onChange: load }));
  on(el, 'click', '[data-reload]', () => load());
  bindPager(el, (p) => setQuery('/orders', { ...params2(), page: p }));
  await load();
}

export async function renderReview(el) {
  el.innerHTML = html`
    <section class="card">
      <h3>รายการที่ต้องตรวจสอบคืออะไร?</h3>
      <p class="text-2 small">ระบบจะส่งรายการมาที่นี่เมื่อ <b>ไม่แน่ใจผลลัพธ์</b> เช่น ผู้ให้บริการตอบกลับไม่ทัน (timeout), เช็กสถานะหลายครั้งแล้วยังไม่ทราบผล, ค้างนานเกินกำหนด หรือ <b>ผลขัดแย้ง</b> (เช่น คืนเงินไปแล้วแต่ภายหลังผู้ให้บริการแจ้งว่าสำเร็จ) — ระบบจะไม่ส่งซ้ำและไม่คืนเงินเองในกรณีเหล่านี้ เพื่อกันเติมซ้ำหรือเงินหาย</p>
      <div class="grid cols-3">
        <div class="stack" style="--gap:4px"><b>${icon('refresh')} เช็กสถานะ</b><span class="small text-2">ถามผู้ให้บริการอีกครั้ง ถ้าได้ผลชัดเจน ระบบจะปิดรายการให้เอง</span></div>
        <div class="stack" style="--gap:4px"><b class="text-success">${icon('check')} ยืนยันว่าสำเร็จ</b><span class="small text-2">เมื่อตรวจกับผู้ให้บริการแล้วว่าเติมเข้าเบอร์จริง (ถ้าเคยคืนเงินแล้ว ระบบจะดึงเงินคืนจากกระเป๋าลูกค้า)</span></div>
        <div class="stack" style="--gap:4px"><b class="text-danger">${icon('x')} ยืนยันไม่สำเร็จ + คืนเงิน</b><span class="small text-2">เมื่อแน่ใจว่าไม่ได้เติม ระบบคืนเงินเข้ากระเป๋าลูกค้าครั้งเดียว</span></div>
      </div>
      <p class="small muted mt-2 mb-0">ตรวจผลได้จากเว็บ WonDD (เมนูประวัติการทำรายการ) ด้วยเลขที่รายการหรือเบอร์ปลายทาง ก่อนกดยืนยันทุกครั้ง</p>
    </section>
    <section class="card flush"><div data-list><div class="empty"><span class="spinner"></span></div></div></section>`.toString();

  const load = async () => {
    try {
      const res = await api.get('/api/admin/orders?status=review&pageSize=100');
      el.querySelector('[data-list]').innerHTML = res.rows.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>เวลา</th><th>เลขที่ / ลูกค้า</th><th>รายการ</th><th>เบอร์</th><th class="num">ราคา</th><th>สถานะ</th><th>เหตุผล</th></tr></thead>
            <tbody>${res.rows.map((o) => html`<tr class="clickable row-review" data-ref="${o.ref}">
              <td class="nowrap small">${dateTime(o.created_at)}</td>
              <td><span class="mono">${o.ref}</span><span class="sub">${o.user_name}</span></td>
              <td><div class="item">${netBadge(o.network)}<span class="truncate" style="max-width:220px">${o.product_name}</span></div></td>
              <td class="nowrap num">${phoneFmt(o.phone)}</td>
              <td class="num">${baht(o.price)}</td>
              <td>${statusBadge(o.status, o.status_label)}<span class="sub">เช็กแล้ว ${o.check_attempts} ครั้ง</span></td>
              <td class="small" style="max-width:320px">${o.review_reason || '-'}</td>
            </tr>`)}</tbody></table></div>`.toString()
        : html`<div class="empty"><div class="empty-icon">✓</div><b>ไม่มีรายการที่ต้องตรวจสอบ</b><div class="small">ทุกรายการได้ผลชัดเจนแล้ว</div></div>`.toString();
    } catch (err) {
      el.querySelector('[data-list]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
    }
  };
  on(el, 'click', 'tr[data-ref]', (e, tr) => registry.openOrder(tr.dataset.ref, { onChange: load }));
  await load();
  const unsub = store.subscribe(() => load().catch(toastError));
  return () => unsub();
}
