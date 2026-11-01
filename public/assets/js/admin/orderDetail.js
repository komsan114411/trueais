// หน้าต่างรายละเอียดรายการ + ปุ่มจัดการ (เช็กสถานะ / ยืนยันสำเร็จ / ยืนยันไม่สำเร็จ+คืนเงิน / ปิดการแจ้งเตือน)
import {
  html, api, baht, dateTimeSec, phoneFmt, statusBadge, netBadge, modal, confirmDialog, promptDialog,
  toast, toastError, withLoading, copyText, on,
} from '../lib.js';
import { icon, SOURCE_LABELS, TYPE_LABELS, LEDGER_LABELS, PLOG_ACTIONS, outcomeBadge, signedBaht, codeBlock, store, registry } from './common.js';

function infoList(o) {
  const rows = [
    ['ลูกค้า', html`<button class="link-btn" data-open-user="${o.user_id}">${o.user_name}</button> <span class="muted">${o.user_phone ? phoneFmt(o.user_phone) : ''}</span>`],
    ['ประเภท', html`${TYPE_LABELS[o.type] || o.type} · ${netBadge(o.network)}`],
    ['รายการ', o.product_name],
    ['เบอร์ปลายทาง', html`<span class="bold num">${phoneFmt(o.phone)}</span>`],
    ['ยอดเติม/ราคาแพ็กเกจ', `${baht(o.face_value)} บาท`],
    ['ราคาขาย (ลูกค้าจ่าย)', `${baht(o.price)} บาท`],
    ['ต้นทุน', `${baht(o.cost)} บาท`],
    ['กำไร', o.status === 'success' ? `${baht(o.price - o.cost)} บาท` : html`<span class="muted">- (นับเมื่อสำเร็จ)</span>`],
    ['ช่องทาง', html`${SOURCE_LABELS[o.source] || o.source}${o.batch_id ? html` · ชุด <span class="mono">${o.batch_id}</span>` : ''}`],
    ['เลขอ้างอิงลูกค้า', o.reference ? html`<span class="mono">${o.reference}</span>` : '-'],
  ];
  return html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function providerList(o) {
  const switched = Boolean(o.shop_name && o.handled_by && o.handled_by !== o.shop_name);
  const rows = [
    ['ร้านที่ลูกค้าเลือก', o.shop_name || html`<span class="muted">ไม่ได้เลือก (ระบบเลือกให้)</span>`],
    ['ผู้ให้บริการที่ทำรายการ', html`${o.provider_label || o.provider || '-'}${o.attempts > 1 ? html` <span class="pill">ส่ง ${o.attempts} ครั้ง</span>` : ''}${switched
      ? html`<div class="small text-warning">${o.shop_name} ไม่รับ → ส่งต่อให้ ${o.handled_by} อัตโนมัติ (ราคาเดิม)</div>` : ''}`],
    ['สถานะจากผู้ให้บริการ', o.provider_status || '-'],
    ['เลขที่ผู้ให้บริการ', o.provider_txn_id ? html`<span class="mono">${o.provider_txn_id}</span>` : '-'],
    ['ข้อความ', o.message || '-'],
    ['เช็กสถานะแล้ว', `${o.check_attempts} ครั้ง`],
    ['เช็กครั้งถัดไป', o.next_check_at ? dateTimeSec(o.next_check_at) : '-'],
    ['สร้างเมื่อ', dateTimeSec(o.created_at)],
    ['ส่งเมื่อ', dateTimeSec(o.submitted_at)],
    ['เสร็จเมื่อ', dateTimeSec(o.completed_at)],
    ['IP', o.ip || '-'],
    ['Callback ร้านค้า', o.callback_url ? html`<span class="mono xsmall">${o.callback_url}</span>` : '-'],
  ];
  return html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function actionBar(o) {
  const btns = [];
  if (o.status !== 'pending') btns.push(html`<button class="btn sm" data-act="recheck">${icon('refresh')}เช็กสถานะกับผู้ให้บริการ</button>`);
  if (['processing', 'failed', 'refunded'].includes(o.status)) btns.push(html`<button class="btn sm success" data-act="success">${icon('check')}ยืนยันว่าสำเร็จ</button>`);
  if (['pending', 'processing'].includes(o.status)) btns.push(html`<button class="btn sm danger" data-act="failed">${icon('x')}ยืนยันไม่สำเร็จ + คืนเงิน</button>`);
  if (o.status === 'success') btns.push(html`<button class="btn sm danger" data-act="failed">${icon('x')}คืนเงินลูกค้า</button>`);
  if (o.final && o.needs_review) btns.push(html`<button class="btn sm soft" data-act="clear">${icon('check')}ตรวจแล้ว (ปิดการแจ้งเตือน)</button>`);
  return btns.length ? html`<div class="action-bar">${btns}</div>` : '';
}

function eventsList(events) {
  if (!events.length) return html`<p class="muted small mb-0">ไม่มีประวัติ</p>`;
  return html`<ol class="timeline">${events.map((e) => html`<li class="${e.status}">
    <div class="t-msg">${e.message}</div>
    <div class="t-meta">${dateTimeSec(e.created_at)} · ${e.source_label}${e.data?.internal ? html` · <span class="pill">เห็นเฉพาะแอดมิน</span>` : ''}</div>
    ${e.data?.note ? html`<div class="small text-2">หมายเหตุ: ${e.data.note}</div>` : ''}
  </li>`)}</ol>`;
}

function ledgerList(rows) {
  if (!rows.length) return html`<p class="muted small mb-0">ไม่มีรายการเงิน</p>`;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>ประเภท</th><th class="num">จำนวน</th><th class="num">คงเหลือหลังทำ</th><th>หมายเหตุ</th></tr></thead>
    <tbody>${rows.map((l) => html`<tr>
      <td class="nowrap small">${dateTimeSec(l.created_at)}</td>
      <td>${l.type_label || LEDGER_LABELS[l.type] || l.type}</td>
      <td class="num">${signedBaht(l.amount)}</td>
      <td class="num">${baht(l.balance_after)}</td>
      <td class="small">${l.note || ''}</td>
    </tr>`)}</tbody></table></div>`;
}

const ATTEMPT_BADGE = { success: 'success', failed: 'danger', rejected: 'warning', accepted: 'info', sending: 'warning', unknown: 'warning' };

/** การส่งไปผู้ให้บริการแต่ละครั้ง — "ปฏิเสธ" = ยืนยันแล้วว่าเจ้านั้นไม่ได้ทำรายการ ระบบจึงส่งต่อเจ้าอื่น */
function attemptsList(rows) {
  if (!rows?.length) return html`<p class="muted small mb-0">ยังไม่ได้ส่งไปผู้ให้บริการ</p>`;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th class="num">ครั้งที่</th><th>ผู้ให้บริการ</th><th>ผล</th><th class="num">ต้นทุน</th><th>เลขที่ผู้ให้บริการ</th><th>ข้อความ</th><th>เวลา</th></tr></thead>
    <tbody>${rows.map((a) => html`<tr>
      <td class="num">${a.attempt_no}</td>
      <td>${a.provider_label || a.provider}${a.code ? html`<span class="sub mono">${a.code}</span>` : ''}</td>
      <td><span class="badge ${ATTEMPT_BADGE[a.state] || ''}">${a.state_label || a.state}</span>${a.provider_status ? html`<span class="sub mono">${a.provider_status}</span>` : ''}</td>
      <td class="num">${a.cost !== null && a.cost !== undefined ? baht(a.cost) : '-'}</td>
      <td class="mono small">${a.provider_txn_id || '-'}</td>
      <td class="small">${a.message || ''}${a.resends ? html`<span class="sub">ส่งซ้ำด้วยเลขเดิม ${a.resends} ครั้ง (ไม่ตัดเงินซ้ำ)</span>` : ''}${a.not_found ? html`<span class="sub">ค้นแล้วไม่พบ ${a.not_found} ครั้ง</span>` : ''}</td>
      <td class="small nowrap">${dateTimeSec(a.created_at)}</td>
    </tr>`)}</tbody></table></div>`;
}

export function providerLogItem(l, { showRef = false } = {}) {
  return html`<details class="log">
    <summary>
      <span class="pill">${PLOG_ACTIONS[l.action] || l.action}</span>
      ${showRef && l.order_ref ? html`<span class="mono small">${l.order_ref}</span>` : ''}
      <span class="small muted">${dateTimeSec(l.created_at)}</span>
      ${l.http_status ? html`<span class="pill">HTTP ${l.http_status}</span>` : ''}
      ${outcomeBadge(l.outcome)}
      ${l.duration_ms !== null && l.duration_ms !== undefined ? html`<span class="small muted">${l.duration_ms} ms</span>` : ''}
      ${l.error ? html`<span class="small text-danger">${l.error}</span>` : ''}
    </summary>
    <div class="log-body">
      ${l.url ? html`<div class="small"><span class="code-label">${l.method || ''}</span> <span class="mono">${l.url}</span></div>` : ''}
      <div><div class="code-label">คำขอ (ซ่อนรหัสลับแล้ว)</div>${codeBlock(l.request)}</div>
      <div><div class="code-label">คำตอบ</div>${codeBlock(l.response)}</div>
    </div>
  </details>`;
}

function webhookList(rows) {
  if (!rows.length) return '';
  return html`<div class="detail-section mt-2"><h4>Webhook ไปยังร้านค้า</h4><div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>URL</th><th>สถานะ</th><th class="num">ครั้ง</th><th>ผลล่าสุด</th></tr></thead>
    <tbody>${rows.map((w) => html`<tr>
      <td class="nowrap small">${dateTimeSec(w.created_at)}</td>
      <td class="mono xsmall">${w.url}</td>
      <td>${w.status === 'delivered' ? html`<span class="badge success">ส่งแล้ว</span>` : w.status === 'failed' ? html`<span class="badge danger">ล้มเหลว</span>` : html`<span class="badge warning">รอส่ง</span>`}</td>
      <td class="num">${w.attempts}</td>
      <td class="small">${w.last_http_status ? `HTTP ${w.last_http_status}` : ''} ${w.last_error || ''}</td>
    </tr>`)}</tbody></table></div></div>`;
}

function renderDetail(d) {
  const o = d.order;
  return html`<div class="adm-detail">
    <div class="detail-head">
      <span class="ref">${o.ref}</span>
      <button class="btn ghost sm icon" data-copy="${o.ref}" title="คัดลอกเลขที่รายการ">${icon('copy')}</button>
      ${statusBadge(o.status, o.status_label)}
      ${o.needs_review ? html`<span class="flag">${icon('review')}ต้องตรวจสอบ</span>` : ''}
      ${o.review_locked ? html`<span class="badge danger" title="ผลจากผู้ให้บริการล้างเองไม่ได้ เจ้าหน้าที่ต้องตรวจแล้วกดยืนยันเอง">อาจเติมซ้ำ / ผลขัดแย้ง</span>` : ''}
      <span class="muted small">${dateTimeSec(o.created_at)}</span>
    </div>
    ${o.needs_review ? html`<div class="review-box"><b>เหตุผลที่ต้องตรวจสอบ:</b> ${o.review_reason || '-'}
      ${o.review_locked ? html`<div class="small mt-1"><b>ผู้ให้บริการมากกว่า 1 เจ้าอาจทำรายการนี้</b> — ดูตาราง "การส่งไปผู้ให้บริการ" ด้านล่าง แล้วตรวจในระบบของทุกเจ้าที่มีชื่ออยู่ (ธงนี้ระบบไม่ล้างให้เอง)</div>` : ''}
      <div class="small text-2 mt-1">${o.final
        ? `รายการนี้ปิดแล้ว แต่ผลจากผู้ให้บริการขัดแย้งกับสถานะในระบบ — ตรวจกับ ${provName(o)} แล้วยืนยันผลที่ถูกต้อง หรือกด "ตรวจแล้ว" ถ้าสถานะในระบบถูกต้องอยู่แล้ว`
        : `ยังไม่ทราบผลสุดท้าย — กด "เช็กสถานะ" ก่อน ถ้ายังไม่ชัดเจนให้ตรวจในระบบหลังบ้านของ ${provName(o)} (ค้นด้วยเลขที่รายการ${o.provider_txn_id ? ' หรือเลขที่ผู้ให้บริการ' : ''} / เบอร์ปลายทาง) แล้วยืนยันว่าสำเร็จหรือไม่สำเร็จ`}</div>
    </div>` : ''}
    ${actionBar(o)}
    <div class="detail-grid">
      <div class="detail-section"><h4>ข้อมูลรายการ</h4>${infoList(o)}</div>
      <div class="detail-section"><h4>ผู้ให้บริการ / เวลา</h4>${providerList(o)}</div>
    </div>
    <div class="detail-section mt-2"><h4>การส่งไปผู้ให้บริการ (${d.attempts?.length || 0})</h4>${attemptsList(d.attempts)}</div>
    <div class="detail-grid mt-2">
      <div class="detail-section"><h4>ประวัติสถานะ</h4>${eventsList(d.events)}</div>
      <div class="detail-section"><h4>การเคลื่อนไหวของเงิน</h4>${ledgerList(d.ledger)}</div>
    </div>
    <div class="detail-section mt-2"><h4>การเชื่อมต่อผู้ให้บริการ (${d.provider_logs.length})</h4>
      ${d.provider_logs.length ? d.provider_logs.map((l) => providerLogItem(l)) : html`<p class="muted small mb-0">ยังไม่มีการเชื่อมต่อ</p>`}
    </div>
    ${webhookList(d.webhooks)}
  </div>`;
}

/** ข้อความระบุรายการที่กำลังจัดการ (ใส่ในหน้าต่างยืนยันทุกครั้ง กันกดผิดรายการ) */
const targetText = (o) => `รายการ ${o.ref} · ${o.product_name} → ${phoneFmt(o.phone)} · ลูกค้า ${o.user_name || `#${o.user_id}`}`;

/** ชื่อผู้ให้บริการที่ทำรายการนี้ (ไม่ผูกกับเจ้าใดเจ้าหนึ่ง) */
function provName(o) {
  const name = String(o.provider_label || o.handled_by || '').replace(/\s*\([^)]*\)\s*$/, '');
  return name || 'ผู้ให้บริการ';
}

/**
 * ก่อนส่งคำสั่งที่ขยับเงิน: โหลดสถานะล่าสุดอีกครั้ง — ถ้าสถานะเปลี่ยนไปจากที่แอดมินเห็น (เช่น ระบบเพิ่งคืนเงินเอง)
 * ห้ามทำต่อ เพราะผลทางเงินจะต่างจากข้อความที่ยืนยันไป (เช่น "ยืนยันสำเร็จ" กลายเป็นดึงเงินคืนจากลูกค้า)
 */
async function statusUnchanged(o) {
  const fresh = (await api.get(`/api/admin/orders/${encodeURIComponent(o.ref)}`)).order;
  if (fresh.status === o.status) return true;
  toast(`สถานะรายการเปลี่ยนเป็น "${fresh.status_label || fresh.status}" แล้ว — ยังไม่ได้ทำรายการ กรุณาตรวจสอบอีกครั้ง`, 'warning', 7000);
  return false;
}

/**
 * ส่งคำสั่งตัดสินผล (expected_status = สถานะที่แอดมินเห็น — เซิร์ฟเวอร์ปฏิเสธถ้าเปลี่ยนไปแล้ว)
 * คืน 'ok' | 'reload' (สถานะเปลี่ยน) | 'wait' (กำลังรอคำตอบจากผู้ให้บริการ) — error อื่นโยนต่อให้ผู้เรียกจัดการ
 */
let lastDecision = null; // คำตอบล่าสุดจากเซิร์ฟเวอร์ (เช่น refunded = ยอดที่คืนจริง)
async function postDecision(url, body) {
  try {
    lastDecision = await api.post(url, body);
    return 'ok';
  } catch (err) {
    if (err.code === 'STATUS_CHANGED') { toast(`${err.message} — ยังไม่ได้ทำรายการ`, 'warning', 7000); return 'reload'; }
    if (err.code === 'ORDER_IN_FLIGHT') { toast('กำลังรอคำตอบจากผู้ให้บริการ ลองใหม่สักครู่', 'warning', 6000); return 'wait'; }
    throw err;
  }
}

/** ถามเหตุผล (บังคับอย่างน้อย 3 ตัวอักษร) — คืน null ถ้ายกเลิก */
async function askReason({ title, label, value = '', confirmText }) {
  let v = value;
  for (;;) {
    v = await promptDialog({ title, label, value: v, confirmText, required: true, danger: true });
    if (v === null) return null;
    if (v.length >= 3) return v;
    toast('กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร', 'error');
  }
}

async function runAction(act, o, btn) {
  const base = `/api/admin/orders/${encodeURIComponent(o.ref)}`;
  if (act === 'recheck') {
    return withLoading(btn, async () => {
      const r = await api.post(`${base}/recheck`);
      const label = { success: 'สำเร็จ', failed: 'ไม่สำเร็จ', processing: 'กำลังดำเนินการ', unknown: 'ยังไม่ทราบผล' }[r.result.outcome] || r.result.outcome;
      toast(`ผู้ให้บริการแจ้ง: ${label}${r.result.message ? ` — ${r.result.message}` : ''}`, r.result.outcome === 'success' ? 'success' : 'info', 6000);
      return true;
    });
  }
  if (act === 'success') {
    const refunded = o.status === 'failed' || o.status === 'refunded';
    const note = await promptDialog({
      title: 'ยืนยันว่ารายการนี้สำเร็จ',
      label: `${targetText(o)} — ${refunded
        ? `รายการนี้เคยคืนเงินให้ลูกค้าแล้ว ระบบจะ "ดึงเงิน ${baht(o.price)} บาท กลับ" จากกระเป๋าลูกค้า — ใช้เมื่อตรวจกับผู้ให้บริการแล้วว่าเติมสำเร็จจริงเท่านั้น`
        : `ใช้เมื่อตรวจกับผู้ให้บริการแล้วว่าเติมสำเร็จจริง (ลูกค้าไม่ได้เงินคืน ${baht(o.price)} บาท)`} · หมายเหตุ (บันทึกไว้ตรวจย้อนหลัง)`,
      placeholder: `เช่น ตรวจในระบบ ${provName(o)} แล้ว สถานะสำเร็จ`,
      confirmText: refunded ? `ยืนยันสำเร็จ + ดึงเงิน ${baht(o.price)} บาท` : 'ยืนยันว่าสำเร็จ',
      required: true,
      danger: refunded,
    });
    if (note === null) return false;
    return withLoading(btn, async () => {
      if (!(await statusUnchanged(o))) return true;
      const body = { note, expected_status: o.status };
      let r;
      try {
        r = await postDecision(`${base}/mark-success`, body);
      } catch (err) {
        if (err.code !== 'INSUFFICIENT_BALANCE' || !err.details?.canSkipReversal) throw err;
        // ลูกค้าใช้เงินที่คืนไปแล้ว ดึงคืนไม่ได้ → ทางเลือก: บันทึกว่าสำเร็จโดยไม่ดึงเงิน (ร้านต้องตามเก็บเงินเอง)
        const why = await askReason({
          title: 'ดึงเงินคืนจากลูกค้าไม่ได้',
          label: `${err.message} — ${targetText(o)} · ยอด ${baht(o.price)} บาท · เหตุผล (บังคับ อย่างน้อย 3 ตัวอักษร)`,
          value: note,
          confirmText: 'บันทึกว่าสำเร็จโดยไม่ดึงเงินคืน (ต้องตามเก็บเงินลูกค้าเอง)',
        });
        if (why === null) return false;
        r = await postDecision(`${base}/mark-success`, { ...body, note: why, skip_reversal: true });
        if (r === 'ok') {
          toast(`บันทึกว่าสำเร็จแล้ว โดยไม่ได้ดึงเงิน ${baht(o.price)} บาท คืน — ต้องติดตามเก็บเงินจากลูกค้าเอง`, 'warning', 8000);
          return true;
        }
      }
      if (r === 'ok') toast('บันทึกว่ารายการสำเร็จแล้ว', 'success');
      return r !== 'wait';
    });
  }
  if (act === 'failed') {
    const wasSuccess = o.status === 'success';
    const warn = o.status === 'processing'
      ? ' ⚠️ รายการยังอยู่ระหว่างดำเนินการ ถ้าผู้ให้บริการแจ้งว่าสำเร็จภายหลัง ระบบจะแจ้งเตือน "ผลขัดแย้ง" ให้ตรวจสอบอีกครั้ง'
      : '';
    const note = await promptDialog({
      title: wasSuccess ? 'คืนเงินรายการที่สำเร็จแล้ว' : 'ยืนยันว่ารายการไม่สำเร็จ',
      label: `${targetText(o)} — ${wasSuccess ? 'ใช้เมื่อผู้ให้บริการยกเลิก/ดึงเงินคืนแล้ว' : 'ใช้เมื่อตรวจกับผู้ให้บริการแล้วว่าไม่สำเร็จ'} ระบบจะคืนเงิน ${baht(o.price)} บาท เข้ากระเป๋าลูกค้า (คืนได้ครั้งเดียว)${warn} — หมายเหตุ`,
      placeholder: `เช่น ${provName(o)} แจ้งว่ารายการไม่สำเร็จ`,
      confirmText: `ยืนยันและคืนเงิน ${baht(o.price)} บาท`,
      required: true,
      danger: true,
    });
    if (note === null) return false;
    return withLoading(btn, async () => {
      if (!(await statusUnchanged(o))) return true;
      const body = { note, expected_status: o.status };
      let r;
      try {
        r = await postDecision(`${base}/mark-failed`, body);
      } catch (err) {
        if (err.code !== 'ORDER_RECENT') throw err;
        // เพิ่งส่งไม่ถึง 2 นาที ผู้ให้บริการอาจยังเติมสำเร็จ → แนะนำให้ "เช็กสถานะ" ก่อน ยืนยันซ้ำเท่านั้นจึงคืนเงิน
        const ok = await confirmDialog({
          title: 'รายการนี้เพิ่งส่งไปไม่ถึง 2 นาที',
          body: html`<p>${err.message}</p><p class="small text-danger mb-0">${targetText(o)} — ถ้าคืนเงิน ${baht(o.price)} บาท แล้วผู้ให้บริการเติมสำเร็จภายหลัง ร้านจะเสียเงิน</p>`,
          confirmText: `ยืนยันไม่สำเร็จ + คืนเงิน ${baht(o.price)} บาท`,
          cancelText: 'ยกเลิก (ไปกดเช็กสถานะก่อน)',
          danger: true,
        });
        if (!ok) return false;
        r = await postDecision(`${base}/mark-failed`, { ...body, confirm_recent: true });
      }
      if (r === 'ok') {
        const refunded = lastDecision?.refunded;
        toast(refunded === 0
          ? 'บันทึกว่าไม่สำเร็จแล้ว — ไม่ต้องคืนเงิน (ลูกค้าไม่ได้ถูกเก็บเงินสำหรับรายการนี้อยู่แล้ว)'
          : `คืนเงิน ${baht(refunded || o.price)} บาท ให้ลูกค้าแล้ว`, 'success');
      }
      return r !== 'wait';
    });
  }
  if (act === 'clear') {
    const ok = await confirmDialog({
      title: 'ปิดการแจ้งเตือนรายการนี้',
      body: `${targetText(o)} — ยืนยันว่าตรวจสอบแล้ว และสถานะในระบบ "${o.status_label || o.status}" ถูกต้อง (ไม่มีการขยับเงิน)`,
      confirmText: 'ตรวจแล้ว',
    });
    if (!ok) return false;
    return withLoading(btn, async () => {
      if (!(await statusUnchanged(o))) return true;
      const r = await postDecision(`${base}/clear-review`, { note: 'ตรวจสอบแล้ว', expected_status: o.status });
      if (r === 'ok') toast('ปิดการแจ้งเตือนแล้ว', 'success');
      return r !== 'wait';
    });
  }
  return false;
}

/** เปิดหน้าต่างรายละเอียดรายการ — onChange() ถูกเรียกเมื่อมีการเปลี่ยนสถานะ */
export function openOrderDetail(idOrRef, { onChange } = {}) {
  return modal({
    title: 'รายละเอียดรายการ',
    wide: true,
    body: html`<div data-detail><div class="row"><span class="spinner"></span><span class="muted">กำลังโหลด...</span></div></div>`,
    onMount: (dlg, close) => {
      const box = dlg.querySelector('[data-detail]');
      let current = null;
      const load = async () => {
        try {
          current = await api.get(`/api/admin/orders/${encodeURIComponent(idOrRef)}`);
          box.innerHTML = renderDetail(current).toString();
        } catch (err) {
          box.innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
        }
      };
      on(box, 'click', '[data-act]', async (e, btn) => {
        if (!current) return;
        try {
          const changed = await runAction(btn.dataset.act, current.order, btn);
          if (changed) {
            await load();
            onChange?.();
            store.refresh().catch(() => {});
          }
        } catch (err) {
          toastError(err);
        }
      });
      on(box, 'click', '[data-copy]', (e, el) => copyText(el.dataset.copy));
      on(box, 'click', '[data-open-user]', (e, el) => {
        close();
        if (registry.openUser) registry.openUser(Number(el.dataset.openUser));
      });
      load();
    },
  });
}

registry.openOrder = (ref, opts) => openOrderDetail(ref, opts);
