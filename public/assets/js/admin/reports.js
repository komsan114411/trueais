// รายงานยอดขาย: เลือกช่วงวันที่ + จัดกลุ่ม (รายวัน/เดือน/เครือข่าย/ประเภท/สินค้า/ลูกค้า/ช่องทาง) + ส่งออก CSV
import { html, api, baht, numFmt, netBadge, todayBkk, qs } from '../lib.js';
import { icon, emptyRow, opt, setQuery, successRate, pct } from './common.js';
import { fmtDayLong } from './chart.js';

const GROUPS = [
  ['day', 'รายวัน'],
  ['month', 'รายเดือน'],
  ['network', 'ตามเครือข่าย'],
  ['type', 'ตามประเภท'],
  ['product', 'ตามสินค้า'],
  ['user', 'ตามลูกค้า'],
  ['source', 'ตามช่องทาง'],
];
const monthFmt = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function label(group, r) {
  if (group === 'day') return fmtDayLong(r.label);
  if (group === 'month') return monthFmt.format(new Date(`${r.label}-01T00:00:00Z`));
  if (group === 'network') return netBadge(r.label);
  return r.label;
}

function monthStart() {
  return `${todayBkk().slice(0, 7)}-01`;
}

export async function render(el, params, query) {
  const f = {
    from: query.from || todayBkk(-29),
    to: query.to || todayBkk(),
    group: GROUPS.some(([k]) => k === query.group) ? query.group : 'day',
  };
  const presets = [
    ['วันนี้', todayBkk(), todayBkk()],
    ['7 วัน', todayBkk(-6), todayBkk()],
    ['30 วัน', todayBkk(-29), todayBkk()],
    ['90 วัน', todayBkk(-89), todayBkk()],
    ['เดือนนี้', monthStart(), todayBkk()],
  ];
  el.innerHTML = html`
    <form class="card filter-card toolbar" data-filter>
      <div class="field"><label>ช่วงเวลาด่วน</label><div class="chips">${presets.map(([l, a, b]) => html`<button type="button" class="chip sm ${f.from === a && f.to === b ? 'active' : ''}" data-from="${a}" data-to="${b}">${l}</button>`)}</div></div>
      <div class="field"><label>ตั้งแต่</label><input class="input" type="date" name="from" value="${f.from}"></div>
      <div class="field"><label>ถึง</label><input class="input" type="date" name="to" value="${f.to}"></div>
      <div class="field"><label>จัดกลุ่ม</label><select class="select" name="group">${GROUPS.map(([k, l]) => opt(k, l, f.group))}</select></div>
      <div class="row"><button class="btn primary" type="submit">ดูรายงาน</button><a class="btn" href="/api/admin/reports/sales.csv${qs(f)}">${icon('download')}CSV</a></div>
    </form>
    <div data-totals></div>
    <section class="card flush" data-table><div class="empty"><span class="spinner"></span></div></section>`.toString();

  const form = el.querySelector('[data-filter]');
  const val = (name) => form.querySelector(`[name="${name}"]`).value;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setQuery('/reports', { from: val('from'), to: val('to'), group: val('group') });
  });
  form.querySelectorAll('[data-from]').forEach((b) => b.addEventListener('click', () => {
    setQuery('/reports', { from: b.dataset.from, to: b.dataset.to, group: val('group') });
  }));

  try {
    const r = await api.get(`/api/admin/reports/sales${qs(f)}`);
    const t = r.total;
    el.querySelector('[data-totals]').innerHTML = html`<div class="kpis">
      <div class="stat"><div class="stat-label">ยอดขาย (สำเร็จ)</div><div class="stat-value">฿${baht(t.revenue)}</div></div>
      <div class="stat"><div class="stat-label">ต้นทุน</div><div class="stat-value">฿${baht(t.cost)}</div></div>
      <div class="stat"><div class="stat-label">กำไร</div><div class="stat-value">฿${baht(t.profit)}</div><div class="stat-sub">อัตรากำไร ${pct(t.profit, t.revenue)}</div></div>
      <div class="stat"><div class="stat-label">รายการทั้งหมด</div><div class="stat-value">${numFmt(t.orders)}</div><div class="stat-sub">สำเร็จ ${numFmt(t.success)} · ไม่สำเร็จ ${numFmt(t.failed)}</div></div>
      <div class="stat"><div class="stat-label">อัตราสำเร็จ</div><div class="stat-value">${successRate(t)}</div><div class="stat-sub">กำลังดำเนินการ ${numFmt(t.processing)}</div></div>
    </div>`.toString();
    el.querySelector('[data-table]').innerHTML = html`<div class="table-wrap"><table class="table">
      <thead><tr><th>${GROUPS.find(([k]) => k === r.group)?.[1] || 'กลุ่ม'}</th><th class="num">รายการ</th><th class="num">สำเร็จ</th><th class="num">ไม่สำเร็จ</th><th class="num">อัตราสำเร็จ</th><th class="num">ยอดขาย</th><th class="num">ต้นทุน</th><th class="num">กำไร</th><th class="num">อัตรากำไร</th></tr></thead>
      <tbody>${r.rows.length ? r.rows.map((x) => html`<tr>
        <td>${label(r.group, x)}</td>
        <td class="num">${numFmt(x.orders)}</td>
        <td class="num">${numFmt(x.success)}</td>
        <td class="num">${numFmt(x.failed)}</td>
        <td class="num">${successRate(x)}</td>
        <td class="num">${baht(x.revenue)}</td>
        <td class="num">${baht(x.cost)}</td>
        <td class="num">${baht(x.profit)}</td>
        <td class="num">${pct(x.profit, x.revenue)}</td>
      </tr>`) : emptyRow(9, 'ไม่มีรายการในช่วงเวลานี้')}</tbody>
      ${r.rows.length ? html`<tfoot><tr class="bold"><td>รวม</td><td class="num">${numFmt(t.orders)}</td><td class="num">${numFmt(t.success)}</td><td class="num">${numFmt(t.failed)}</td><td class="num">${successRate(t)}</td><td class="num">${baht(t.revenue)}</td><td class="num">${baht(t.cost)}</td><td class="num">${baht(t.profit)}</td><td class="num">${pct(t.profit, t.revenue)}</td></tr></tfoot>` : ''}
    </table></div>`.toString();
  } catch (err) {
    el.querySelector('[data-table]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
  }
}
