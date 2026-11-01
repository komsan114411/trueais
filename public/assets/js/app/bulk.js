// เติมเงินหลายเบอร์: วางรายการ → ตรวจสอบทุกบรรทัด → ยืนยัน → ติดตามผลทั้งชุด
// ระบบหลังบ้านทำแบบ all-or-nothing: มีรายการผิดแม้แต่รายการเดียว จะไม่ตัดเงินเลย
import { html, raw, api, on, setHTML, baht, bahtShort, phoneFmt, normalizePhone, uuid, withLoading, modal, toast, toastError, pollDelay, debounce } from '../lib.js';
import {
  state, networkOf, orderBlockReason, refreshUser, netVars, loadCatalog, onChange, shopList, shopOf, shopNet, shopOpen, lastShop, rememberShop, shopNote,
  forgetRecentNumbers, loadBulkDraft, saveBulkDraft,
} from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, mockTips, alertBox, priceAfter, statusChip, nudge, busyGuard } from './ui.js';
import { orderErrorHtml, depositSuggestion, ORDER_TIMEOUT_MS, isShopError, refreshShops } from './confirm.js';

/**
 * batchKey ของชุดที่ "ยังไม่รู้ผล" แยกตามรายการในชุด (บัญชี + ร้าน + เครือข่าย/เบอร์/ยอด ทุกบรรทัดตามลำดับ)
 * ส่งชุดเดิมซ้ำ (แม้ปิดหน้าต่าง/กดตรวจสอบใหม่) → คีย์เดิม ระบบไม่ตัดเงินซ้ำ · ล้างเมื่อสร้างรายการสำเร็จเท่านั้น
 */
const pendingBatchKeys = new Map();
const batchSig = (uid, shop, rows) => JSON.stringify([uid, shop || null, rows.map((r) => [r.network, r.phone, r.amount])]);

const NET_WORDS = {
  AIS: ['AIS', 'เอไอเอส', '12CALL', 'ONE2CALL', 'วันทูคอล'],
  TRUE: ['TRUE', 'TRUEMOVE', 'TRUEMOVEH', 'ทรู', 'ทรูมูฟ'],
  DTAC: ['DTAC', 'ดีแทค', 'HAPPY', 'แฮปปี้'],
};

/** เบอร์ 9 หลักที่ขาด 0 ข้างหน้า (มักเกิดจากคัดลอกจาก Excel) — แนะนำให้แก้ ไม่เติมให้เอง */
const missingZero = (tok) => /^[689]\d{8}$/.test(String(tok || ''));

function parseLine(line) {
  let rest = ` ${line.trim()} `;
  let network = null;
  let multiNet = false;
  for (const [code, words] of Object.entries(NET_WORDS)) {
    for (const w of words) {
      const re = new RegExp(`[\\s,;]${w}(?=[\\s,;])`, 'i');
      if (re.test(rest)) {
        if (network && network !== code) multiNet = true; // ระบุหลายค่ายในบรรทัดเดียว → ให้แก้ ไม่เดาเอง
        network = code;
        rest = rest.replace(re, ' ');
      }
    }
  }
  const tokens = rest.split(/[\s,;\t]+/).filter(Boolean);
  let phoneTok = tokens.shift() || '';
  // รองรับเบอร์ที่เว้นวรรค เช่น "081 234 5678"
  if (!normalizePhone(phoneTok) && /^\d{3}$/.test(phoneTok) && /^\d{3}$/.test(tokens[0] || '') && /^\d{4}$/.test(tokens[1] || '')) {
    phoneTok += tokens.shift() + tokens.shift();
  }
  const amountTok = tokens.shift();
  return { raw: line.trim(), phone: normalizePhone(phoneTok), phoneRaw: phoneTok, amountRaw: amountTok, network, multiNet, extra: tokens };
}

/** ตรวจทุกบรรทัดตามร้านที่เลือก (ส่วนลด + ยอดที่ร้านนั้นขาย) — ไม่มีร้าน = ใช้ส่วนลดมาตรฐานของเครือข่าย */
function validate(lines, defNet, defAmount, shopCode) {
  const shop = shopOf(shopCode);
  const rows = lines.map((r, i) => {
    const errors = [];
    const code = r.network || defNet;
    const n = networkOf(code);
    const sn = shop ? shopNet(shop, code) : null;
    const fixed = Array.isArray(sn?.amounts) ? sn.amounts : null; // ร้านที่ขายเฉพาะบางยอด
    const amountStr = String(r.amountRaw ?? defAmount ?? '').replace(/,/g, '').replace(/บาท$/, '');
    let amount = null;
    const zero = !r.phone && missingZero(r.phoneRaw);
    if (zero) errors.push(`เบอร์มี 9 หลัก — ขาดเลข 0 ข้างหน้าหรือไม่? (${phoneFmt(`0${r.phoneRaw}`)})`);
    else if (!r.phone) errors.push(r.phoneRaw ? `เบอร์ "${r.phoneRaw}" ไม่ถูกต้อง` : 'ไม่มีเบอร์');
    if (r.multiNet) errors.push('ระบุเครือข่ายมากกว่า 1 ค่าย');
    if (!n) errors.push('ไม่ได้เลือกเครือข่าย');
    else if (!n.topup.open) errors.push(`${n.name} ปิดชั่วคราว`);
    else if (shop && fixed && !fixed.length) errors.push(`${shop.name} ไม่มีบริการ ${n.name}`);
    if (!amountStr) errors.push('ไม่ระบุยอดเงิน');
    else if (!/^\d{1,6}$/.test(amountStr)) errors.push('ยอดต้องเป็นจำนวนเต็มบาท');
    else {
      amount = Number(amountStr);
      if (n && fixed) {
        if (fixed.length && !fixed.includes(amount)) errors.push(`${shop.name} มีเฉพาะยอด ${fixed.join(', ')} บาท`);
      } else if (n && (amount * 100 < n.topup.min || amount * 100 > n.topup.max)) errors.push(`ยอด ${bahtShort(n.topup.min)}-${bahtShort(n.topup.max)} บาท`);
      else if (n && !(sn ? sn.custom : n.topup.allow_custom) && !n.topup.presets.includes(amount)) errors.push(`เติมได้เฉพาะ ${n.topup.presets.join(', ')}`);
    }
    if (r.extra.length) errors.push(`มีข้อมูลเกิน "${r.extra.join(' ')}"`);
    const bp = sn ? sn.discount_bp || 0 : n?.topup.discount_bp || 0;
    return { ...r, line: i + 1, network: code, amount, bp, errors, zero, dup: false, warn: null, serverError: null };
  });

  // เบอร์เดียวกันหลายบรรทัด: เครือข่ายไม่ตรงกัน = ผิดแน่นอน (เบอร์หนึ่งมีเครือข่ายเดียว) · ยอดต่างกัน = เตือนให้ตรวจ
  const byPhone = new Map();
  for (const r of rows) if (r.phone) byPhone.set(r.phone, [...(byPhone.get(r.phone) || []), r]);
  for (const list of byPhone.values()) {
    if (list.length < 2) continue;
    const others = (r) => list.filter((x) => x !== r).map((x) => x.line).join(', ');
    const nets = new Set(list.map((x) => x.network));
    if (nets.size > 1) {
      for (const r of list) r.errors.push(`เบอร์นี้อยู่หลายบรรทัดแต่เครือข่ายไม่ตรงกัน (บรรทัด ${others(r)}) — เบอร์หนึ่งใช้ได้เครือข่ายเดียว`);
    } else if (new Set(list.map((x) => x.amount)).size > 1) {
      for (const r of list) r.warn = `เบอร์นี้อยู่หลายบรรทัด ยอดต่างกัน (บรรทัด ${others(r)}) — ตรวจว่าตั้งใจเติมหลายครั้ง`;
    }
  }

  // รายการเดียวกันซ้ำ (เบอร์ + เครือข่าย + ยอด เดียวกัน) → บรรทัดหลังขึ้น "ซ้ำในรายการ" ต้องติ๊กยืนยันก่อนส่ง
  const seen = new Set();
  for (const r of rows) {
    const ok = r.errors.length === 0;
    r.price = ok ? priceAfter(r.amount * 100, r.bp) : 0;
    if (!ok) continue;
    const sig = `${r.phone}|${r.network}|${r.amount}`;
    r.dup = seen.has(sig);
    seen.add(sig);
  }
  return rows;
}

export default async function bulkPage(ctx) {
  const c = state.catalog;
  const max = c.settings.max_bulk_items;
  const openNets = c.networks.filter((n) => n.topup.open);
  const st = { rows: [], parsed: [], defNet: '', defAmount: '', shopCode: '', result: null, undo: null };
  const shops = () => shopList();
  if (state.user) refreshUser(); // ยอดเงินล่าสุด (ใช้ตรวจว่าเงินพอทั้งชุดไหม)
  /** ร้านเริ่มต้น: ร้านที่ใช้ล่าสุด (ถ้าเปิดอยู่) → ร้านแรกที่เปิดอยู่ */
  const defaultShop = () => {
    const open = shops().filter(shopOpen);
    return (open.find((s) => s.code === lastShop()) || open[0] || shops()[0])?.code || '';
  };

  setHTML(ctx.view, html`
    ${pageHead('เติมเงินหลายเบอร์', `เติมได้สูงสุด ${max} เบอร์ต่อครั้ง · ตรวจสอบครบทุกบรรทัดก่อนตัดเงิน`)}
    ${!c.mode.live ? mockTips({ fill: false }) : ''}
    <div class="bulk-layout">
      <section class="card" data-input-card>
        <div class="field mb-2" data-shop-field></div>
        <div class="grid cols-2">
          <div class="field">
            <label for="defNet">เครือข่ายเริ่มต้น</label>
            <select class="select" id="defNet" name="defNet">
              ${openNets.map((n) => html`<option value="${n.code}">${n.full_name}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="defAmount">ยอดเริ่มต้น (บาท)</label>
            <input class="input" id="defAmount" name="defAmount" inputmode="numeric" placeholder="เช่น 50" maxlength="6">
          </div>
        </div>
        <div class="field mt-2">
          <label for="lines">รายการเบอร์ (1 บรรทัด ต่อ 1 เบอร์)</label>
          <textarea class="textarea mono bulk-text" id="lines" name="lines" rows="8" spellcheck="false" autocomplete="off"
            placeholder="0812345678 50&#10;0898765432 100 TRUE&#10;0861234567 dtac"></textarea>
          <div class="help">รูปแบบ: <code>เบอร์ ยอดเงิน เครือข่าย</code> — ถ้าไม่ใส่ยอดหรือเครือข่าย จะใช้ค่าเริ่มต้นด้านบน · รายการที่วางไว้ยังอยู่ แม้ออกไปเติมเงินเข้ากระเป๋าแล้วกลับมา</div>
        </div>
        <div class="row between mt-2 wrap">
          <span class="small muted" data-count>0 บรรทัด</span>
          <button class="btn primary" data-check>${icon('search', 18)} ตรวจสอบรายการ</button>
        </div>
      </section>
      <section data-preview></section>
    </div>`);

  const view = ctx.view;
  const textEl = view.querySelector('#lines');
  const defNetEl = view.querySelector('#defNet');
  const defAmountEl = view.querySelector('#defAmount');
  const countEl = view.querySelector('[data-count]');
  const previewEl = view.querySelector('[data-preview]');
  const shopField = view.querySelector('[data-shop-field]');

  // ร้านสำหรับทั้งชุด — ราคาแต่ละบรรทัดใช้ส่วนลดของร้านนี้ (ร้านปิดชั่วคราวเลือกไม่ได้)
  let shopValue = defaultShop();
  function renderShopField() {
    const list = shops();
    shopField.classList.toggle('hidden', !list.length);
    if (!list.length) { shopValue = ''; return; }
    if (!list.some((s) => s.code === shopValue && shopOpen(s))) shopValue = defaultShop();
    if (list.length === 1) {
      setHTML(shopField, html`<span class="label">ร้าน</span><div class="bold">${list[0].name}${list[0].paused ? html` <span class="badge danger">ปิดชั่วคราว</span>` : ''}</div>`);
      return;
    }
    setHTML(shopField, html`<label for="bulkShop">ร้าน (ใช้กับทุกบรรทัด)</label>
      <select class="select" id="bulkShop" name="shop">${list.map((s) => html`<option value="${s.code}" ${s.code === shopValue ? raw('selected') : ''} ${shopOpen(s) ? '' : raw('disabled')}>${s.name}${shopOpen(s) ? '' : ' (ปิดชั่วคราว)'}</option>`)}</select>
      <div class="help">ราคาแต่ละบรรทัดคิดตามส่วนลดของร้านที่เลือก · ถ้าร้านไม่รับรายการ ระบบอาจส่งต่อร้านอื่นอัตโนมัติในราคาเดิม</div>`);
  }
  on(shopField, 'change', 'select[name="shop"]', (e, el) => { shopValue = el.value; invalidate(); keep(); });

  const lines = () => textEl.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const updateCount = () => {
    const n = lines().length;
    countEl.textContent = `${n} บรรทัด${n > max ? ` (เกิน ${max})` : ''}`;
    countEl.classList.toggle('text-danger', n > max);
  };
  // แก้รายการ/ค่าเริ่มต้นหลังกดตรวจสอบ → ล้างผลตรวจเดิม (กันยืนยันด้วยยอด/เครือข่ายที่ไม่ใช่ค่าล่าสุด)
  const invalidate = () => { st.undo = null; if (st.rows.length && !st.result) { st.rows = []; setHTML(previewEl, ''); } };
  // จำรายการที่วางไว้ในแท็บนี้ (ไปเติมเงินเข้ากระเป๋าแล้วกลับมา ไม่ต้องวางใหม่) — ส่งชุดนี้แล้วไม่ต้องจำ
  const keepNow = () => {
    if (!st.result) saveBulkDraft({ text: textEl.value, defNet: defNetEl.value, defAmount: defAmountEl.value, shop: shopValue });
  };
  const keep = debounce(keepNow, 300);
  ctx.onLeave(keepNow);
  textEl.addEventListener('input', () => { updateCount(); invalidate(); keep(); });
  defNetEl.addEventListener('change', () => { invalidate(); keep(); });
  // คงจุดทศนิยมไว้ให้ตรวจแล้วแจ้ง "ต้องเป็นจำนวนเต็มบาท" (ไม่ตัดจุดทิ้งจน 50.5 กลายเป็น 505)
  defAmountEl.addEventListener('input', () => { defAmountEl.value = defAmountEl.value.replace(/[^\d.]/g, '').slice(0, 6); invalidate(); keep(); });

  function previewStats() {
    const rows = st.rows;
    const valid = rows.filter((r) => !r.errors.length && !r.serverError);
    const bad = rows.length - valid.length;
    const total = valid.reduce((s, r) => s + r.price, 0);
    const u = state.user;
    const short = u ? total - u.balance : 0;
    const block = orderBlockReason();
    const over = rows.length > max;
    return { rows, valid, bad, total, short, block, over, canSubmit: Boolean(rows.length) && !bad && !over && !block && short <= 0 };
  }

  function renderPreview() {
    const { rows, valid, bad, total, short, block, over, canSubmit } = previewStats();
    const dups = rows.filter((r) => r.dup).length;
    const zeros = rows.filter((r) => r.zero).length;
    const removable = rows.filter((r) => r.errors.length || r.serverError || r.dup).length;
    const u = state.user;
    setHTML(previewEl, html`<div class="card flush">
      <div class="bulk-summary">
        <div><div class="small muted">ทั้งหมด</div><div class="bold num">${rows.length} รายการ</div></div>
        <div><div class="small muted">ถูกต้อง</div><div class="bold num text-success">${valid.length}</div></div>
        <div><div class="small muted">ต้องแก้ไข</div><div class="bold num ${bad ? 'text-danger' : ''}">${bad}</div></div>
        <div><div class="small muted">รวมชำระ</div><div class="bold num">฿${baht(total)}</div></div>
      </div>
      ${st.undo ? html`<div class="px-3 pt-3">${alertBox('info', html`<div class="row between wrap" style="--gap:8px"><span>${st.undo.message}</span>
        <button type="button" class="btn sm" data-undo>${icon('repeat', 16)} เลิกทำ</button></div>`)}</div>` : ''}
      ${zeros || removable ? html`<div class="bulk-fixes px-3 pt-3">
        ${zeros ? html`<button type="button" class="btn sm primary" data-fix-zero>${icon('edit', 16)} เติม 0 หน้าเบอร์ 9 หลัก (${zeros} บรรทัด)</button>` : ''}
        ${removable ? html`<button type="button" class="btn sm" data-remove-bad>${icon('trash', 16)} ลบบรรทัดที่ผิด/ซ้ำ (${removable} บรรทัด)</button>` : ''}
      </div>` : ''}
      <div class="table-wrap"><table class="table bulk-table">
        <thead><tr><th>#</th><th>เบอร์</th><th>เครือข่าย</th><th class="num">ยอด</th><th class="num">ชำระ</th><th>ตรวจสอบ</th></tr></thead>
        <tbody>${rows.map((r) => {
          const err = r.serverError || r.errors.join(', ');
          return html`<tr class="${err ? 'row-error' : r.dup || r.warn ? 'row-warn' : ''}" data-line="${r.line}">
            <td class="muted">${r.line}</td>
            <td class="num nowrap">${r.phone ? phoneFmt(r.phone) : html`<span class="text-danger">${r.phoneRaw || '-'}</span>`}</td>
            <td>${networkOf(r.network) ? netTag(r.network) : '-'}</td>
            <td class="num">${r.amount ? bahtShort(r.amount * 100) : '-'}</td>
            <td class="num">${r.price ? baht(r.price) : '-'}</td>
            <td class="small">${err ? html`<span class="text-danger">${icon('alert', 14)} ${err}</span>`
              : r.dup ? html`<span class="text-warning">${icon('alert', 14)} ${r.dupRef ? `เพิ่งเติมไปแล้ว (${r.dupRef})` : 'ซ้ำในรายการ'}</span>`
                : r.warn ? html`<span class="text-warning">${icon('alert', 14)} ${r.warn}</span>`
                  : html`<span class="text-success">${icon('check', 14)} พร้อม</span>`}</td>
          </tr>`;
        })}</tbody>
      </table></div>
      <div class="bulk-foot">
        ${over ? html`<div data-over>${alertBox('danger', `เกินจำนวนสูงสุด ${max} เบอร์ต่อครั้ง กรุณาแบ่งเป็นหลายชุด`)}</div>` : ''}
        ${bad ? alertBox('danger', `มี ${bad} รายการที่ต้องแก้ไข — แก้ในช่องด้านบนแล้วกด "ตรวจสอบรายการ" อีกครั้ง (ยังไม่ได้ตัดเงิน)`) : ''}
        ${dups ? alertBox('warning', `มี ${dups} รายการที่อาจซ้ำ (เบอร์และยอดซ้ำกันในชุด หรือเพิ่งเติมไป) ถ้าตั้งใจเติมซ้ำ ให้ติ๊กยืนยันในขั้นตอนถัดไป`) : ''}
        ${u && short > 0 && !bad ? html`<div data-short>${alertBox('danger', html`ยอดเงินในกระเป๋าไม่พอ ขาดอีก ฿${baht(short)}
          <div class="mt-1"><a class="btn sm primary" href="#/wallet?amount=${depositSuggestion(short)}">${icon('plus', 16)} เติมเงินเข้ากระเป๋า</a></div>
          <div class="xsmall muted mt-1">รายการเบอร์ที่วางไว้ยังอยู่ — เติมเงินเสร็จแล้วกลับมาหน้านี้ ยืนยันต่อได้เลย</div>`)}</div>` : ''}
        ${block ? alertBox('warning', block) : ''}
        <div class="row between wrap">
          <span class="small muted">${shopOf(st.shopCode) ? html`ร้าน <b>${shopOf(st.shopCode).name}</b> · ` : ''}${u ? html`ยอดในกระเป๋า ฿${baht(u.balance)}` : ''}</span>
          <button class="btn primary lg ${canSubmit ? '' : 'soft-disabled'}" data-submit aria-disabled="${canSubmit ? 'false' : 'true'}">${icon('shield', 20)} ยืนยันเติม ${valid.length} เบอร์ · ฿${baht(total)}</button>
        </div>
      </div>
    </div>`);
  }

  function check({ scroll = true } = {}) {
    const parsed = lines().map(parseLine);
    if (!parsed.length) {
      if (scroll) {
        toast('กรุณาวางรายการเบอร์อย่างน้อย 1 บรรทัด', 'warning');
        textEl.focus();
      }
      return;
    }
    st.parsed = parsed;
    st.defNet = defNetEl.value;
    st.defAmount = defAmountEl.value.trim();
    st.shopCode = shopValue;
    st.rows = validate(parsed, st.defNet, st.defAmount, st.shopCode);
    renderPreview();
    if (scroll) previewEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  view.querySelector('[data-check]').addEventListener('click', () => { st.undo = null; check(); });

  /** แก้ข้อความในช่องรายการ (ลบ/แก้บางบรรทัด) แล้วตรวจใหม่ — เลิกทำได้ */
  function rewriteLines(fn, message) {
    const before = textEl.value;
    const ls = lines();
    const next = fn(ls);
    textEl.value = next.join('\n');
    updateCount();
    keep();
    st.rows = [];
    check({ scroll: false });
    st.undo = { text: before, message };
    renderPreview();
  }
  on(previewEl, 'click', '[data-fix-zero]', () => {
    const fix = new Set(st.rows.filter((r) => r.zero).map((r) => r.line - 1));
    rewriteLines((ls) => ls.map((l, i) => {
      if (!fix.has(i)) return l;
      const tok = st.parsed[i]?.phoneRaw;
      return tok && /^\d+$/.test(tok) ? l.replace(new RegExp(`(^|[\\s,;])${tok}(?=$|[\\s,;])`), `$10${tok}`) : l;
    }), `เติม 0 หน้าเบอร์ 9 หลักแล้ว ${fix.size} บรรทัด — ตรวจเบอร์อีกครั้งก่อนยืนยัน`);
  });
  on(previewEl, 'click', '[data-remove-bad]', () => {
    const drop = new Set(st.rows.filter((r) => r.errors.length || r.serverError || r.dup).map((r) => r.line - 1));
    rewriteLines((ls) => ls.filter((l, i) => !drop.has(i)), `ลบแล้ว ${drop.size} บรรทัด (บรรทัดที่ผิด/ซ้ำ)`);
  });
  on(previewEl, 'click', '[data-undo]', () => {
    if (!st.undo) return;
    textEl.value = st.undo.text;
    st.undo = null;
    updateCount();
    keep();
    st.rows = [];
    check({ scroll: false });
  });

  /** ได้ผลจากเซิร์ฟเวอร์ (แม้หน้าต่างยืนยันถูกปิดไประหว่างรอ) → แสดงผล */
  function handleResult(result) {
    if (result.error) {
      const e = result.error;
      // ราคาเปลี่ยน / ร้านหรือยอดไม่พร้อม → โหลดข้อมูลล่าสุดไว้ ให้กด "ตรวจสอบรายการ" ครั้งถัดไปคำนวณ/ตรวจจากข้อมูลใหม่
      const codes = [e.code, ...(e.details?.errors || []).map((x) => x.code)];
      if (codes.includes('PRICE_CHANGED') || codes.some((code) => isShopError({ code }))) refreshShops();
      toast(result.error.message, 'error', 6000);
      if (ctx.alive()) renderPreview();
      return;
    }
    if (st.shopCode) rememberShop(st.shopCode);
    refreshUser();
    forgetRecentNumbers();
    saveBulkDraft(null); // ส่งแล้ว → ไม่ต้องจำรายการที่วางไว้อีก
    if (result.existing) toast('ชุดนี้ถูกส่งไปแล้ว — ระบบไม่ตัดเงินซ้ำ', 'warning', 5000);
    else toast(`ส่งรายการ ${result.orders.length} เบอร์แล้ว`, 'success');
    if (!ctx.alive()) return;
    st.result = result;
    showResults(result.batch_id, result.orders);
  }

  on(previewEl, 'click', '[data-submit]', async (e, submitBtn) => {
    if (submitBtn.classList.contains('is-loading')) return;
    // ปุ่มกดได้เสมอ — ยังส่งไม่ได้ = ชี้ไปที่สิ่งที่ต้องแก้ก่อน (ไม่ส่งรายการ)
    const pre = previewStats();
    if (!pre.canSubmit) {
      if (pre.over) nudge(previewEl.querySelector('[data-over]'));
      else if (pre.bad) {
        const first = st.rows.find((r) => r.errors.length || r.serverError);
        nudge(previewEl.querySelector(`tr[data-line="${first?.line}"]`) || previewEl);
        toast(`มี ${pre.bad} รายการที่ต้องแก้ไขก่อน`, 'warning');
      } else if (pre.block) toast(pre.block, 'warning', 5000);
      else if (pre.short > 0) { refreshUser(); nudge(previewEl.querySelector('[data-short]')); }
      return;
    }
    // ราคา/ส่วนลด/สถานะเครือข่ายอาจเปลี่ยนหลังกด "ตรวจสอบ" → โหลดล่าสุดแล้วตรวจซ้ำ ให้ยอดที่ยืนยันตรงกับที่จะตัดเงินจริง
    let changed = false;
    const checked = await withLoading(submitBtn, async () => {
      try { await loadCatalog(true); } catch { return true; /* โหลดไม่ได้ → ใช้ผลตรวจเดิม */ }
      const fresh = validate(st.parsed, st.defNet, st.defAmount, st.shopCode);
      changed = fresh.length !== st.rows.length || fresh.some((r, i) => r.price !== st.rows[i].price
        || r.network !== st.rows[i].network || r.errors.join('|') !== st.rows[i].errors.join('|'));
      if (changed) st.rows = fresh;
      return true;
    });
    if (!checked || !ctx.alive()) return; // กดซ้ำระหว่างกำลังตรวจ
    const shop = shopOf(st.shopCode);
    const block = orderBlockReason() || (shop && !shopOpen(shop) ? `${shop.name} ปิดชั่วคราว — กรุณาเลือกร้านอื่นแล้วกด "ตรวจสอบรายการ" อีกครั้ง` : null);
    if (changed || block) {
      renderPreview();
      toast(block || 'ราคาหรือสถานะเครือข่าย/ร้านเพิ่งมีการเปลี่ยนแปลง — กรุณาตรวจสอบยอดอีกครั้งก่อนยืนยัน', 'warning', 6000);
      return;
    }
    const rows = st.rows.filter((r) => !r.errors.length);
    const total = rows.reduce((s, r) => s + r.price, 0);
    const dups = rows.some((r) => r.dup);
    const uid = state.user?.id;
    const sig = batchSig(uid, st.shopCode, rows);
    // คีย์เดียวต่อ "ชุดนี้" — ส่งซ้ำ (เน็ตหลุด/หมดเวลา/ยืนยันรายการซ้ำ) ใช้คีย์เดิมเสมอ
    const batchKey = pendingBatchKeys.get(sig) || uuid();
    let needDupConfirm = dups;
    let busy = false;
    const result = await modal({
      title: `ยืนยันเติมเงิน ${rows.length} เบอร์`,
      wide: true,
      body: html`
        <div class="confirm-box">
          <div class="sum-lines">
            ${shop ? html`<div class="sum-line"><span class="muted">ร้าน</span><span class="bold">${shop.name}</span></div>` : ''}
            <div class="sum-line"><span class="muted">จำนวนเบอร์</span><span class="num bold">${rows.length} เบอร์</span></div>
            ${[...new Set(rows.map((r) => r.network))].map((code) => {
              const list = rows.filter((r) => r.network === code);
              return html`<div class="sum-line small"><span>${netTag(code)} × ${list.length}</span><span class="num">฿${baht(list.reduce((s, r) => s + r.price, 0))}</span></div>`;
            })}
            <div class="sum-line total"><span>ชำระรวม</span><span class="num">฿${baht(total)}</span></div>
          </div>
        </div>
        <div class="bulk-confirm-list mt-2">${rows.map((r) => html`<div class="bc-item"><span class="num bold">${phoneFmt(r.phone)}</span>${netTag(r.network)}<span class="num">${bahtShort(r.amount * 100)} บาท</span>${r.dup ? html`<span class="badge warning plain">อาจซ้ำ</span>` : ''}</div>`)}</div>
        <div data-dup>${dups ? html`<div class="mt-2">${alertBox('warning', html`มีรายการที่อาจซ้ำ (ดูป้าย &quot;อาจซ้ำ&quot; ด้านบน)
          <label class="check mt-1"><input type="checkbox" data-dup-check><span class="bold">ยืนยันทำรายการซ้ำ (ตั้งใจเติมซ้ำ)</span></label>`)}</div>` : ''}</div>
        <label class="check confirm-check" data-ok-label><input type="checkbox" data-ok-check><span>ตรวจสอบเบอร์ เครือข่าย และยอดเงินทุกรายการถูกต้องแล้ว</span></label>
        <div class="xsmall text-danger mt-1" data-ok-hint role="alert"></div>
        <div data-err></div>`,
      foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary soft-disabled" data-go aria-disabled="true">${icon('check', 18)} ยืนยันชำระ ฿${baht(total)}</button>`,
      onMount: (dlg, close) => {
        dlg.addEventListener('click', (e) => {
          if (busy && (e.target === dlg || e.target.closest('[data-close]'))) { e.preventDefault(); e.stopImmediatePropagation(); }
        }, true);
        dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
        const btn = dlg.querySelector('[data-go]');
        const ok = dlg.querySelector('[data-ok-check]');
        const okHint = dlg.querySelector('[data-ok-hint]');
        const errBox = dlg.querySelector('[data-err]');
        const dupBox = dlg.querySelector('[data-dup]');
        const dupChecked = () => Boolean(dlg.querySelector('[data-dup-check]')?.checked);
        const canGo = () => ok.checked && (!needDupConfirm || dupChecked());
        const sync = () => {
          const ready = canGo();
          btn.classList.toggle('soft-disabled', !ready);
          btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
          if (ok.checked) okHint.textContent = '';
        };
        dlg.addEventListener('change', sync);
        btn.addEventListener('click', () => {
          if (busy || btn.classList.contains('is-loading')) return;
          if (!canGo()) {
            // ยังไม่ได้ติ๊กยืนยัน → ชี้ไปที่ช่องที่ต้องติ๊ก (ไม่ส่งรายการ)
            if (!ok.checked) {
              okHint.textContent = 'ติ๊กช่องนี้หลังตรวจทุกรายการแล้ว จึงจะยืนยันได้';
              nudge(dlg.querySelector('[data-ok-label]'), { focus: ok });
            } else {
              const dc = dlg.querySelector('[data-dup-check]');
              nudge(dc?.closest('label') || dupBox, { focus: dc });
            }
            return;
          }
          withLoading(btn, async () => {
            setHTML(errBox, '');
            // บัญชีเปลี่ยนไประหว่างเปิดหน้าต่าง (เข้าสู่ระบบบัญชีอื่นจากแท็บอื่น) → ห้ามตัดเงินบัญชีใหม่
            if (state.user?.id !== uid) {
              setHTML(errBox, html`<div class="mt-2">${alertBox('danger', 'บัญชีที่เข้าสู่ระบบเปลี่ยนไปแล้ว — กรุณาปิดหน้าต่างแล้วตรวจสอบรายการใหม่ (ยังไม่ได้ส่งรายการ)')}</div>`);
              return;
            }
            busy = true;
            const release = busyGuard(); // กันปิด/รีเฟรชหน้าระหว่างรอผล
            pendingBatchKeys.set(sig, batchKey); // ยังไม่รู้ผลจนกว่าจะได้คำตอบ
            try {
              const r = await api.post('/api/orders/bulk', {
                // expectedPrice = ยอดที่แสดงในหน้าต่างนี้ — ราคาเปลี่ยนระหว่างนั้น ระบบจะไม่ตัดเงินทั้งชุด
                items: rows.map((x) => ({ type: 'topup', network: x.network, phone: x.phone, amount: x.amount, expectedPrice: x.price })),
                batchKey,
                ...(st.shopCode ? { shop: st.shopCode } : {}), // ร้านเดียวกันทั้งชุด
                // ยืนยันซ้ำเฉพาะบรรทัดที่ขึ้นป้าย "อาจซ้ำ" ให้ลูกค้าเห็นแล้ว — บรรทัดอื่นที่ซ้ำ เซิร์ฟเวอร์จะแจ้งกลับมาให้ดูก่อน
                confirmDuplicateIndexes: needDupConfirm && dupChecked() ? rows.map((x, i) => (x.dup ? i : -1)).filter((i) => i >= 0) : [],
              }, { timeout: ORDER_TIMEOUT_MS });
              busy = false;
              release();
              pendingBatchKeys.delete(sig); // สร้างรายการแล้ว → ชุดถัดไปเป็นชุดใหม่
              if (dlg.open) close(r);
              else handleResult(r);
            } catch (err) {
              busy = false;
              release();
              if (err.code === 'IDEMPOTENCY_MISMATCH') pendingBatchKeys.delete(sig);
              // ชุดที่มี 1 บรรทัด เซิร์ฟเวอร์แจ้ง error ของบรรทัดนั้นตรงๆ (ไม่มี errors[]) → แสดงที่บรรทัดแรกเหมือนกัน
              const errs = err.details?.errors
                || (rows.length === 1 && (err.code === 'PRICE_CHANGED' || err.details?.field) ? [{ index: 0, message: err.message }] : null);
              if (Array.isArray(errs)) {
                errs.forEach((x) => { if (rows[x.index]) rows[x.index].serverError = x.message; });
                if (dlg.open) close({ error: err });
                else handleResult({ error: err });
                return;
              }
              if (!dlg.open) { toastError(err); return; }
              if (err.code === 'DUPLICATE_RECENT' || err.code === 'DUPLICATE_IN_BATCH') {
                // ระบบยังไม่ได้สร้างรายการใดเลย → ให้เห็น "ทุก" บรรทัดที่อาจซ้ำ แล้วติ๊กยืนยัน ส่งซ้ำด้วยคีย์เดิม
                const list = Array.isArray(err.details?.duplicates) && err.details.duplicates.length
                  ? err.details.duplicates
                  : [{ index: err.details?.index, ref: err.details?.ref || null, in_batch: err.code === 'DUPLICATE_IN_BATCH' }];
                const suspects = list.filter((x) => rows[x.index]);
                suspects.forEach((x) => { rows[x.index].dup = true; rows[x.index].dupRef = x.in_batch ? null : x.ref || null; });
                needDupConfirm = true;
                setHTML(dupBox, html`<div class="mt-2">${alertBox('warning', html`<div class="small">${err.message}</div>
                  ${suspects.length ? html`<ul class="small mt-1 mb-0">${suspects.map((x) => html`<li>บรรทัด ${rows[x.index].line}: <span class="num bold">${phoneFmt(rows[x.index].phone)}</span>
                    ${netTag(rows[x.index].network)} ${bahtShort(rows[x.index].amount * 100)} บาท — ${x.in_batch ? 'ซ้ำกับบรรทัดอื่นในชุดนี้' : `เพิ่งเติมไปแล้ว${x.ref ? ` (เลขที่ ${x.ref})` : ''}`}</li>`)}</ul>` : ''}
                  <label class="check mt-1"><input type="checkbox" data-dup-check><span class="bold">ยืนยันทำรายการซ้ำทั้ง ${rows.filter((x) => x.dup).length || 1} รายการที่ขึ้นป้าย "อาจซ้ำ" (ตั้งใจเติมซ้ำ)</span></label>`)}</div>`);
              } else {
                setHTML(errBox, html`<div class="mt-2">${orderErrorHtml(err)}</div>`);
              }
            }
          }).then(sync);
        });
        sync();
      },
    });
    if (!result) {
      if (ctx.alive() && rows.some((r) => r.dup)) renderPreview(); // ปิดหน้าต่าง → ให้เห็นบรรทัดที่ระบบแจ้งว่าอาจซ้ำในตาราง
      return;
    }
    handleResult(result);
  });

  let timer = null;
  let pollGen = 0; // กันรอบ poll ที่ค้างอยู่ วาดผลทับหน้า "เติมชุดใหม่"
  ctx.onLeave(() => { pollGen++; clearTimeout(timer); });

  /** follow: 'live' = กำลังติดตามผล · 'stopped' = หยุดติดตามอัตโนมัติแล้ว (กดรีเฟรชเอง) · 'done' = ครบทุกรายการ */
  function renderResults(orders, follow) {
    const count = (fn) => orders.filter(fn).length;
    const ok = count((o) => o.status === 'success');
    const fail = count((o) => o.status === 'failed' || o.status === 'refunded');
    const wait = orders.length - ok - fail;
    setHTML(previewEl, html`<div class="card flush">
      <div class="card-head pad-x">
        <h3>ผลการเติมเงิน ${orders.length} เบอร์${orders[0]?.shop_name ? html` <span class="small muted">· ร้าน ${orders[0].shop_name}</span>` : ''}</h3>
        ${follow === 'live' ? html`<span class="badge warning pulse">กำลังติดตามผล</span>` : follow === 'stopped' ? html`<span class="badge">หยุดติดตามอัตโนมัติ</span>` : ''}
      </div>
      <div class="bulk-summary">
        <div><div class="small muted">สำเร็จ</div><div class="bold num text-success">${ok}</div></div>
        <div><div class="small muted">ไม่สำเร็จ (คืนเงินแล้ว)</div><div class="bold num ${fail ? 'text-danger' : ''}">${fail}</div></div>
        <div><div class="small muted">กำลังดำเนินการ</div><div class="bold num ${wait ? 'text-warning' : ''}">${wait}</div></div>
        <div><div class="small muted">ชำระรวม</div><div class="bold num">฿${baht(orders.reduce((s, o) => s + o.price, 0))}</div></div>
      </div>
      <div class="order-list">${orders.map((o) => html`<a class="order-item" href="#/order/${o.ref}">
        <span class="oi-icon" style="${netVars(networkOf(o.network)?.color)}">${icon('bolt', 18)}</span>
        <span class="oi-main"><span class="oi-title num">${phoneFmt(o.phone)}</span><span class="oi-sub">${o.product_name}${o.handled_by && o.shop_name && o.handled_by !== o.shop_name ? ` · ร้าน ${shopNote(o)}` : ''}${o.message && o.final && o.status !== 'success' ? ` · ${o.message}` : ''}</span></span>
        <span class="oi-side"><span class="oi-price num">฿${baht(o.price)}</span>${statusChip(o)}</span>
      </a>`)}</div>
      <div class="bulk-foot">
        ${follow === 'live' ? html`<p class="small muted mb-0">${icon('info', 14)} ไม่ต้องทำรายการซ้ำ — ระบบติดตามผลให้อัตโนมัติ ปิดหน้านี้ได้ ดูผลได้ที่ประวัติ</p>` : ''}
        ${follow === 'stopped' ? html`<div class="row wrap between" style="--gap:8px"><p class="small muted mb-0">${icon('info', 14)} บางรายการยังรอผล — ไม่ต้องทำรายการซ้ำ กดรีเฟรชเพื่อดูผลล่าสุด</p>
          <button type="button" class="btn sm" data-bulk-refresh>${icon('refresh', 16)} รีเฟรช</button></div>` : ''}
        <div class="row wrap">
          <a class="btn" href="#/history?batch=${orders[0]?.batch_id || ''}">ดูในประวัติ</a>
          <button class="btn primary" data-new-batch>${icon('plus', 18)} เติมชุดใหม่</button>
        </div>
      </div>
    </div>`);
  }

  let lastResult = { batchId: null, orders: [] };
  function showResults(batchId, orders) {
    view.querySelector('[data-input-card]').classList.add('hidden');
    lastResult = { batchId, orders };
    const allFinal = orders.every((o) => o.final);
    renderResults(orders, allFinal ? 'done' : 'live');
    if (allFinal) return;
    const started = Date.now();
    let attempt = 0;
    clearTimeout(timer);
    const gen = ++pollGen;
    const tick = async () => {
      if (!ctx.alive() || gen !== pollGen) return;
      try {
        const d = await api.get(`/api/orders?batch=${encodeURIComponent(batchId)}&pageSize=200`, { timeout: 20000 });
        if (!ctx.alive() || gen !== pollGen) return;
        const list = d.rows.slice().reverse();
        if (list.length) lastResult.orders = list;
        const done = lastResult.orders.every((o) => o.final);
        if (done) {
          renderResults(lastResult.orders, 'done');
          refreshUser();
          return;
        }
        renderResults(lastResult.orders, 'live');
      } catch { /* ลองใหม่รอบหน้า */ }
      if (Date.now() - started > 180000) {
        renderResults(lastResult.orders, 'stopped'); // หยุดติดตาม → บอกให้ชัด ไม่ปล่อยป้าย "กำลังติดตามผล" ค้าง
        return;
      }
      timer = setTimeout(tick, pollDelay(attempt++));
    };
    timer = setTimeout(tick, 1200);
  }

  on(previewEl, 'click', '[data-bulk-refresh]', () => {
    if (lastResult.batchId) showResults(lastResult.batchId, lastResult.orders); // เริ่มติดตามผลใหม่อีก 3 นาที
  });

  on(previewEl, 'click', '[data-new-batch]', () => {
    pollGen++;
    clearTimeout(timer);
    st.rows = [];
    st.result = null;
    st.undo = null;
    textEl.value = '';
    saveBulkDraft(null);
    updateCount();
    setHTML(previewEl, '');
    view.querySelector('[data-input-card]').classList.remove('hidden');
    textEl.focus();
  });

  // ข้อมูลร้านเปลี่ยน (เช่น ร้านปิดชั่วคราว / ราคาเปลี่ยน) → อัปเดตตัวเลือกร้าน — ร้านที่เลือกใช้ไม่ได้แล้ว ล้างผลตรวจเดิม
  // ยอดเงินเปลี่ยน → วาดสรุปใหม่ (เงินพอ/ไม่พอ)
  const off = onChange((what) => {
    if (!ctx.alive() || !state.catalog) return;
    if (what === 'user') {
      if (st.rows.length && !st.result) renderPreview();
      return;
    }
    if (what !== 'catalog') return;
    const before = shopValue;
    renderShopField();
    if (shopValue !== before) {
      invalidate();
      if (before) toast('ร้านที่เลือกไว้ไม่พร้อมให้บริการแล้ว — เลือกร้านใหม่ให้แล้ว กรุณากด "ตรวจสอบรายการ" อีกครั้ง', 'warning', 6000);
    }
  });
  ctx.onLeave(off);

  // รายการที่วางไว้ก่อนออกไปเติมเงินเข้ากระเป๋า → ใส่คืนให้ แล้วตรวจให้เลย
  const kept = loadBulkDraft();
  if (kept?.text) {
    textEl.value = String(kept.text);
    if (kept.defNet && openNets.some((n) => n.code === kept.defNet)) defNetEl.value = kept.defNet;
    if (kept.defAmount) defAmountEl.value = String(kept.defAmount).replace(/[^\d.]/g, '').slice(0, 6);
    if (kept.shop && shops().some((s) => s.code === kept.shop && shopOpen(s))) shopValue = kept.shop;
  }
  renderShopField();
  updateCount();
  if (kept?.text && lines().length) {
    check({ scroll: false });
    toast('นำรายการเบอร์ที่วางไว้กลับมาให้แล้ว — ตรวจสอบแล้วยืนยันได้เลย', 'info', 4500);
  }
}
