// แดชบอร์ด: พร้อมเปิดร้านหรือยัง (รายการตรวจ), ตัวเลขสำคัญวันนี้/เดือนนี้, กราฟ 14 วัน, ยอดตามเครือข่าย, รายการล่าสุด, การแจ้งเตือน
import { html, raw, api, baht, numFmt, dateTime, timeAgo, phoneFmt, statusBadge, netBadge, toast, toastError, withLoading, on } from '../lib.js';
import { icon, store, successRate, pct, emptyRow, registry, safeHref, isCustomerLink, testNotify } from './common.js';
import { createColumnChart, chartTable } from './chart.js';

const stat = ({ label, value, sub, href, cls = '', extra = '' }) => (href
  ? html`<a class="stat link ${cls}" href="${href}"><div class="stat-head"><span class="stat-label">${label}</span>${extra}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</a>`
  : html`<div class="stat ${cls}"><div class="stat-head"><span class="stat-label">${label}</span>${extra}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div>`);

/** เครดิต + สถานะของผู้ให้บริการทุกเจ้า (1 ช่องต่อ 1 เจ้า) */
function providerTiles(d, bal) {
  const list = d.provider?.providers?.length ? d.provider.providers
    : [{ name: '', label: d.provider?.label || 'ผู้ให้บริการ', balance: bal, breaker: d.provider?.breaker, config: d.provider?.config, enabled: true }];
  return list.map((p) => {
    const b = p.balance;
    const state = !p.config?.ready ? html`<span class="text-danger">ตั้งค่าไม่ครบ</span>`
      : p.breaker?.open ? html`<span class="text-danger">พักชั่วคราว${p.breaker.reason ? ` · ${p.breaker.reason}` : ''}</span>`
        : !p.enabled ? html`<span class="muted">ปิดใช้ชั่วคราว</span>` : html`<span class="text-success">พร้อมรับรายการ</span>`;
    return stat({
      label: `เครดิต ${p.label}`,
      value: b && b.balance !== null && b.balance !== undefined ? `฿${baht(b.balance)}` : '-',
      sub: html`${state}${b?.error ? html` · <span class="text-danger">${b.error}</span>` : b?.checked_at ? ` · อัปเดต ${timeAgo(b.checked_at)}` : ' · ยังไม่ได้ตรวจ'}`,
      extra: html`<button class="btn ghost sm icon" data-act="balance" data-name="${p.name}" title="ตรวจเครดิตตอนนี้" aria-label="ตรวจเครดิต ${p.label}">${icon('refresh')}</button>`,
      cls: p.enabled && (p.breaker?.open || !p.config?.ready) ? 'alert-on' : '',
    });
  });
}

function kpis(d) {
  const t = d.today;
  const m = d.month;
  const bal = d.provider?.balance;
  return html`
    <div>
      <h3 class="section-title">วันนี้</h3>
      <div class="kpis">
        ${stat({ label: 'ยอดขายวันนี้', value: `฿${baht(t.revenue)}`, sub: `${numFmt(t.success)} รายการสำเร็จ` })}
        ${stat({ label: 'กำไรวันนี้', value: `฿${baht(t.profit)}`, sub: `อัตรากำไร ${pct(t.profit, t.revenue)}` })}
        ${stat({ label: 'รายการวันนี้', value: numFmt(t.orders), sub: `อัตราสำเร็จ ${successRate(t)} · ไม่สำเร็จ ${numFmt(t.failed)}` })}
        ${stat({ label: 'กำลังดำเนินการ', value: numFmt(d.processing), sub: 'รอผลจากผู้ให้บริการ', href: '#/orders?status=active', cls: d.processing > 0 ? 'warn-on' : '' })}
        ${stat({ label: 'ต้องตรวจสอบ', value: numFmt(d.needs_review), sub: d.needs_review > 0 ? 'มีรายการรอแอดมินตัดสิน' : 'ไม่มีรายการค้าง', href: '#/review', cls: d.needs_review > 0 ? 'alert-on' : '' })}
        ${stat({ label: 'เติมเงินเข้ากระเป๋ารอตรวจ', value: numFmt(d.deposits_waiting.c), sub: `รวม ฿${baht(d.deposits_waiting.amount)}`, href: '#/deposits', cls: d.deposits_waiting.c > 0 ? 'warn-on' : '' })}
      </div>
    </div>
    <div>
      <h3 class="section-title">เดือนนี้ / ระบบ</h3>
      <div class="kpis">
        ${stat({ label: 'ยอดขายเดือนนี้', value: `฿${baht(m.revenue)}`, sub: `${numFmt(m.success)} รายการสำเร็จ` })}
        ${stat({ label: 'กำไรเดือนนี้', value: `฿${baht(m.profit)}`, sub: `อัตรากำไร ${pct(m.profit, m.revenue)}` })}
        ${stat({ label: 'อัตราสำเร็จเดือนนี้', value: successRate(m), sub: `${numFmt(m.orders)} รายการ · ไม่สำเร็จ ${numFmt(m.failed)}` })}
        ${providerTiles(d, bal)}
        ${stat({ label: 'ลูกค้า', value: numFmt(d.customers.c), sub: `เงินในกระเป๋าลูกค้ารวม ฿${baht(d.customers.wallet_total)}` })}
        ${d.webhooks_failed > 0 ? stat({ label: 'Webhook ส่งไม่สำเร็จ', value: numFmt(d.webhooks_failed), sub: 'ร้านค้าอาจไม่ได้รับผลรายการ', href: '#/logs?tab=webhooks', cls: 'alert-on' }) : ''}
      </div>
    </div>`;
}

function byNetworkTable(rows) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>เครือข่าย</th><th class="num">รายการ</th><th class="num">สำเร็จ</th><th class="num">ไม่สำเร็จ</th><th class="num">อัตราสำเร็จ</th><th class="num">ยอดขาย</th><th class="num">กำไร</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => html`<tr>
      <td>${netBadge(r.network)}</td>
      <td class="num">${numFmt(r.orders)}</td>
      <td class="num">${numFmt(r.success)}</td>
      <td class="num">${numFmt(r.failed)}</td>
      <td class="num">${successRate(r)}</td>
      <td class="num">${baht(r.revenue)}</td>
      <td class="num">${baht(r.profit)}</td>
    </tr>`) : emptyRow(7, 'ยังไม่มีรายการเดือนนี้')}</tbody></table></div>`;
}

// บนมือถือแสดงเป็นการ์ด (คลาส cards-sm + o1..o5 = ลำดับในการ์ด, ซ้าย/ขวาสลับกัน)
function recentTable(rows) {
  return html`<div class="table-wrap"><table class="table cards-sm">
    <thead><tr><th>เวลา</th><th>รายการ</th><th>เบอร์</th><th class="num">ราคา</th><th>สถานะ</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => html`<tr class="clickable ${r.needs_review ? 'row-review' : ''}" data-ref="${r.ref}">
      <td class="nowrap small o5 full">${dateTime(r.created_at)}<span class="sub">${r.user_name}</span></td>
      <td class="o1"><div class="item">${netBadge(r.network)}<span class="truncate">${r.product_name}</span></div><span class="sub mono">${r.ref}</span></td>
      <td class="nowrap num o3 left-sm bold-sm">${phoneFmt(r.phone)}</td>
      <td class="num o4">${baht(r.price)}</td>
      <td class="o2 r">${statusBadge(r.status)}${r.needs_review ? html` <span class="flag">ตรวจ</span>` : ''}</td>
    </tr>`) : emptyRow(5, 'ยังไม่มีรายการ')}</tbody></table></div>`;
}

// ───────────── พร้อมเปิดร้านหรือยัง (รายการตรวจจากเซิร์ฟเวอร์) ─────────────
// item = { key, level: 'warn' | 'info' | 'ok', message, link?, group?: 'setup' | 'security' }
const SECURITY_KEYS = new Set(['config', 'bootstrap_password', 'admin_2fa', 'admins_2fa']);
// ลิงก์สำรอง (เซิร์ฟเวอร์รุ่นที่ยังไม่ส่ง link มา) — รหัสผ่าน / ยืนยัน 2 ชั้น อยู่ที่หน้าบัญชีของฉัน (เว็บลูกค้า)
function fallbackLink(key) {
  if (key === 'admin_2fa' || key === 'bootstrap_password') return '/#/account';
  if (key === 'backup') return '#/settings?focus=backup';
  if (key === 'notify') return '#/settings?focus=notify';
  if (key === 'admins_2fa') return '#/users?role=admin';
  const m = /^provider_([a-z0-9_]+?)_map$/.exec(key || '');
  if (m) return `#/providers?tab=map:${m[1]}`;
  if (/^provider_[a-z0-9_]+$/.test(key || '') && !/_https$/.test(key)) return '#/providers';
  return null;
}
const LEVEL_RANK = { warn: 0, info: 1, ok: 2 };
const LEVEL_MARK = { warn: '!', info: 'i', ok: '✓' };
const LEVEL_TEXT = { warn: 'ต้องแก้', info: 'แนะนำ', ok: 'เรียบร้อย' };

function normalizeItems(items) {
  return items.filter((x) => x && x.message).map((x) => {
    const level = Object.hasOwn(LEVEL_RANK, x.level) ? x.level : 'info';
    const group = x.group === 'security' || x.group === 'setup' ? x.group : SECURITY_KEYS.has(x.key) ? 'security' : 'setup';
    return { ...x, level, group, href: safeHref(x.link) || safeHref(fallbackLink(x.key)) };
  });
}

function checkItem(x) {
  const ext = x.href && isCustomerLink(x.href);
  const link = x.href && x.level !== 'ok'
    ? html`<a class="btn sm ${x.level === 'warn' ? 'primary' : ''}" href="${x.href}" ${ext ? raw('target="_blank" rel="noopener"') : ''} title="${ext ? 'เปิดหน้าบัญชีของฉันในเว็บลูกค้า (บัญชีเดียวกันนี้) ในแท็บใหม่' : 'ไปหน้าที่แก้ได้'}">ไปแก้${ext ? icon('external') : ' →'}</a>`
    : '';
  const test = x.key === 'notify' && x.level === 'ok' ? html`<button type="button" class="btn sm" data-act="notify-test">${icon('bell')}ส่งข้อความทดสอบ</button>` : '';
  return html`<li class="gl-${x.level}">
    <span class="gl-mark" aria-hidden="true">${LEVEL_MARK[x.level]}</span>
    <span class="gl-txt"><span class="sr-only">${LEVEL_TEXT[x.level]}: </span>${x.message}${ext && x.level !== 'ok' ? html`<span class="sub">แก้ที่หน้า "บัญชีของฉัน" ในเว็บลูกค้า (ใช้บัญชีเดียวกันนี้)</span>` : ''}</span>
    ${link || test ? html`<span class="gl-act">${link}${test}</span>` : ''}
  </li>`;
}

/** การ์ด "พร้อมเปิดร้านหรือยัง" — แยกเรื่องตั้งค่าร้าน กับเรื่องความปลอดภัย · open = null ให้ระบบเลือก (เปิดเมื่อมีเรื่องต้องแก้) */
function goLiveCard(items, open) {
  if (!Array.isArray(items) || !items.length) return '';
  const list = normalizeItems(items);
  if (!list.length) return '';
  const warns = list.filter((x) => x.level === 'warn').length;
  const done = list.filter((x) => x.level === 'ok').length;
  const total = list.length;
  const ready = warns === 0;
  const isOpen = open === null ? !ready : open;
  const groups = [['setup', 'ตั้งค่าร้าน'], ['security', 'ความปลอดภัย']]
    .map(([g, label]) => [label, list.filter((x) => x.group === g).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])])
    .filter(([, l]) => l.length);
  const percent = Math.round((done / total) * 100);
  return html`<details class="card flush golive ${ready ? 'is-ready' : 'not-ready'}" data-golive ${isOpen ? raw('open') : ''}>
    <summary class="golive-head">
      <span class="golive-ico" aria-hidden="true">${ready ? '✓' : '!'}</span>
      <span class="grow"><span class="golive-title">พร้อมเปิดร้านหรือยัง?</span>
        <span class="golive-sub">${ready
          ? (done === total ? `พร้อมแล้ว — ผ่านครบทั้ง ${total} ข้อ` : `พร้อมเปิดร้าน — ไม่มีเรื่องต้องแก้ด่วน (มีข้อแนะนำ ${total - done} ข้อ)`)
          : `ยังไม่พร้อม — ต้องแก้ ${warns} เรื่องก่อนรับลูกค้าจริง`}</span></span>
      <span class="badge ${ready ? 'success' : 'warning'}" title="เรียบร้อย ${done} จาก ${total} ข้อ">${done}/${total}</span>
    </summary>
    <div class="golive-body">
      <div class="golive-bar" role="progressbar" aria-label="ความพร้อมของร้าน" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${percent}%"></span></div>
      ${groups.map(([label, l]) => html`<h4 class="golive-group">${label}</h4><ul class="golive-list">${l.map(checkItem)}</ul>`)}
    </div>
  </details>`;
}

function alertsList(rows) {
  if (!rows.length) return html`<p class="muted small mb-0">ไม่มีการแจ้งเตือน</p>`;
  return html`<ul class="alert-list">${rows.map((a) => html`<li>
    <span class="when">${timeAgo(a.created_at)}</span>
    <span class="txt">${a.detail?.text || a.key}</span>
  </li>`)}</ul>`;
}

export async function render(el) {
  el.innerHTML = html`
    <div data-security class="hidden"></div>
    <div data-kpis><div class="kpis">${[1, 2, 3, 4, 5, 6].map(() => html`<div class="stat"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton mt-1" style="height:26px;width:80%"></div></div>`)}</div></div>
    <div class="dash-cols">
      <section class="card chart-card viz-root">
        <div class="card-head"><h3>ยอดขาย 14 วันล่าสุด (บาท)</h3><button class="btn ghost sm" data-toggle="rev">${icon('table')}ตาราง</button></div>
        <p class="chart-sub">นับเฉพาะรายการที่สำเร็จ · ตัวเลขบนแท่ง = วันสูงสุดและวันล่าสุด</p>
        <div data-chart="rev"></div><div data-table="rev" class="hidden"></div>
      </section>
      <section class="card chart-card viz-root">
        <div class="card-head"><h3>จำนวนรายการ 14 วันล่าสุด</h3><button class="btn ghost sm" data-toggle="ord">${icon('table')}ตาราง</button></div>
        <div class="viz-legend"><span class="key"><span class="sw ok"></span>สำเร็จ</span><span class="key"><span class="sw bad"></span>✕ ไม่สำเร็จ</span></div>
        <div data-chart="ord"></div><div data-table="ord" class="hidden"></div>
      </section>
    </div>
    <div class="dash-cols">
      <section class="card flush"><div class="card-head" style="padding:16px 18px 0"><h3>รายการล่าสุด</h3><a class="btn ghost sm" href="#/orders">ดูทั้งหมด</a></div><div data-recent class="mt-1"></div></section>
      <div class="stack">
        <section class="card flush"><div class="card-head" style="padding:16px 18px 0"><h3>ยอดตามเครือข่าย (เดือนนี้)</h3></div><div data-nets class="mt-1"></div></section>
        <section class="card"><div class="card-head"><h3>การแจ้งเตือนล่าสุด</h3><a class="btn ghost sm" href="#/logs?tab=audit&action=system.alert">ทั้งหมด</a></div><div data-alerts></div></section>
      </div>
    </div>`.toString();

  const rev = createColumnChart(el.querySelector('[data-chart="rev"]'), {
    ariaLabel: 'กราฟแท่งยอดขายรายวัน 14 วันล่าสุด',
    layers: [{ key: 'revenue', cls: 's1', value: (r) => r.revenue / 100 }],
    labelValue: (r) => r.revenue / 100,
    formatValue: (n) => n.toLocaleString('th-TH', { maximumFractionDigits: 0 }),
    tooltipRows: (r) => [
      { label: 'ยอดขาย', value: `฿${baht(r.revenue)}`, color: 'var(--viz-series-1)' },
      { label: 'กำไร', value: `฿${baht(r.profit)}` },
      { label: 'รายการสำเร็จ', value: numFmt(r.success) },
    ],
  });
  const ord = createColumnChart(el.querySelector('[data-chart="ord"]'), {
    ariaLabel: 'กราฟแท่งซ้อนจำนวนรายการสำเร็จและไม่สำเร็จรายวัน 14 วันล่าสุด',
    integer: true,
    layers: [
      { key: 'success', cls: 'ok', value: (r) => r.success },
      { key: 'failed', cls: 'bad', value: (r) => r.failed },
    ],
    labelValue: (r) => r.success + r.failed,
    formatValue: (n) => numFmt(n),
    tooltipRows: (r) => [
      { label: 'สำเร็จ', value: numFmt(r.success), color: 'var(--viz-muted-fill)' },
      { label: 'ไม่สำเร็จ', value: numFmt(r.failed), color: 'var(--viz-critical)' },
      { label: 'กำลังดำเนินการ', value: numFmt(r.processing) },
      { label: 'อัตราสำเร็จ', value: successRate(r) },
    ],
  });

  // เปิด/ปิดการ์ด "พร้อมเปิดร้าน" ตามที่ผู้ใช้กดไว้ (null = ให้ระบบเลือก) — คงไว้ระหว่างรีเฟรชอัตโนมัติ
  let goLiveOpen = null;
  const draw = (d) => {
    if (!d || !el.isConnected) return;
    const sec = goLiveCard(d.security, goLiveOpen).toString();
    const secBox = el.querySelector('[data-security]');
    secBox.innerHTML = sec;
    secBox.classList.toggle('hidden', !sec); // ไม่มีเรื่องต้องแจ้ง → ไม่กินพื้นที่
    el.querySelector('[data-kpis]').innerHTML = kpis(d).toString();
    rev.update(d.series);
    ord.update(d.series);
    el.querySelector('[data-table="rev"]').innerHTML = chartTable(d.series, [
      { label: 'ยอดขาย (บาท)', value: (r) => baht(r.revenue) },
      { label: 'กำไร (บาท)', value: (r) => baht(r.profit) },
      { label: 'สำเร็จ', value: (r) => numFmt(r.success) },
    ]).toString();
    el.querySelector('[data-table="ord"]').innerHTML = chartTable(d.series, [
      { label: 'ทั้งหมด', value: (r) => numFmt(r.orders) },
      { label: 'สำเร็จ', value: (r) => numFmt(r.success) },
      { label: 'ไม่สำเร็จ', value: (r) => numFmt(r.failed) },
      { label: 'กำลังดำเนินการ', value: (r) => numFmt(r.processing) },
    ]).toString();
    el.querySelector('[data-recent]').innerHTML = recentTable(d.recent).toString();
    el.querySelector('[data-nets]').innerHTML = byNetworkTable(d.by_network).toString();
    el.querySelector('[data-alerts]').innerHTML = alertsList(d.alerts).toString();
  };

  on(el, 'click', '[data-toggle]', (e, btn) => {
    const k = btn.dataset.toggle;
    const chart = el.querySelector(`[data-chart="${k}"]`);
    const table = el.querySelector(`[data-table="${k}"]`);
    const showTable = table.classList.contains('hidden');
    table.classList.toggle('hidden', !showTable);
    chart.classList.toggle('hidden', showTable);
    btn.innerHTML = (showTable ? html`${icon('chart')}กราฟ` : html`${icon('table')}ตาราง`).toString();
  });
  on(el, 'click', '[data-golive] > summary', (e, s) => { goLiveOpen = !s.parentElement.open; }); // คลิกก่อนสถานะเปลี่ยน
  on(el, 'click', '[data-act="notify-test"]', (e, b) => testNotify(b));
  on(el, 'click', 'tr[data-ref]', (e, tr) => registry.openOrder(tr.dataset.ref, { onChange: () => store.refresh() }));
  on(el, 'click', '[data-act="balance"]', (e, btn) => {
    e.preventDefault();
    withLoading(btn, async () => {
      try {
        const name = btn.dataset.name;
        const r = await api.post(name ? `/api/admin/providers/${encodeURIComponent(name)}/refresh-balance` : '/api/admin/provider/refresh-balance');
        if (r?.error) toast(`ตรวจเครดิตไม่สำเร็จ: ${r.error}`, 'error');
        else toast('อัปเดตเครดิตแล้ว', 'success');
        await store.refresh();
      } catch (err) {
        toastError(err);
      }
    });
  });

  if (store.dash) draw(store.dash);
  const unsub = store.subscribe((d) => draw(d));
  store.refresh().catch(toastError);
  return () => {
    unsub();
    rev.destroy();
    ord.destroy();
  };
}
