// ช่องกรอกเบอร์มือถือ: จัดรูปแบบ 08X-XXX-XXXX ขณะพิมพ์ + ตรวจสอบทันที + เลือกจากสมุดโทรศัพท์
import { html, setHTML, normalizePhone, toast, phoneFmt } from '../lib.js';
import { icon } from './icons.js';
import { state, recentNumbers, networkOf } from './state.js';
import { pickFromPhonebook } from './picker.js';

export function formatPhoneTyping(v) {
  let s = String(v ?? '').trim();
  if (s.startsWith('+66')) s = `0${s.slice(3)}`;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('66') && d.length >= 11) d = `0${d.slice(2)}`;
  d = d.slice(0, 10);
  if (d.length > 6) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length > 3) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return d;
}

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

/** จัดรูปแบบค่าในช่อง แล้ววางเคอร์เซอร์หลังตัวเลขตัวเดิม (ไม่กระโดดไปท้ายช่อง) */
function formatWithCaret(input, value, caret) {
  const formatted = formatPhoneTyping(value);
  const t = value.trim();
  const td = digitsOf(t);
  // +66 / 66 นำหน้าถูกแปลงเป็น 0 → ตัวเลขหน้าเคอร์เซอร์ลดลง 1 ตัว
  const converted = t.startsWith('+66') || (td.startsWith('66') && td.length >= 11);
  let k = digitsOf(value.slice(0, caret)).length;
  if (converted) k = k >= 2 ? k - 1 : Math.min(k, 1);
  let pos = 0;
  if (k > 0) {
    pos = formatted.length;
    for (let i = 0, seen = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i]) && ++seen === k) { pos = i + 1; break; }
    }
  }
  if (input.value !== formatted) input.value = formatted;
  if (document.activeElement === input) {
    try { input.setSelectionRange(pos, pos); } catch { /* ignore */ }
  }
}

/**
 * ผูกการจัดรูปแบบเบอร์กับช่องกรอก (ใช้ได้กับทุกช่องเบอร์)
 *  - แก้ตัวเลขกลางเบอร์ได้ถูกตำแหน่ง (เดิมเคอร์เซอร์กระโดดไปท้ายช่อง → ได้เบอร์ผิดแต่รูปแบบถูก)
 *  - กดลบหลังขีด = ลบตัวเลขหน้าขีด (ไม่ติดอยู่ที่ขีด)
 * @returns {(v: string) => void} ตั้งค่าช่องใหม่ (จัดรูปแบบให้)
 */
export function bindPhoneFormat(input, after) {
  let prev = input.value;
  input.addEventListener('input', (e) => {
    if (e.isComposing) return;
    let v = input.value;
    let caret = input.selectionStart ?? v.length;
    if (/^delete/.test(e.inputType || '') && v.length < prev.length && digitsOf(v) === digitsOf(prev)) {
      // ลบโดนแค่ขีด → ลบตัวเลขที่อยู่ติดขีดแทน
      if (e.inputType === 'deleteContentForward') {
        let i = caret;
        while (i < v.length && !/\d/.test(v[i])) i++;
        if (i < v.length) v = v.slice(0, i) + v.slice(i + 1);
      } else {
        let i = caret - 1;
        while (i >= 0 && !/\d/.test(v[i])) i--;
        if (i >= 0) { v = v.slice(0, i) + v.slice(i + 1); caret = i; }
      }
    }
    formatWithCaret(input, v, caret);
    prev = input.value;
    after?.();
  });
  input.addEventListener('compositionend', () => {
    formatWithCaret(input, input.value, input.selectionStart ?? input.value.length);
    prev = input.value;
    after?.();
  });
  return (v) => {
    input.value = formatPhoneTyping(String(v ?? ''));
    prev = input.value;
  };
}

export function phoneFieldHtml({ value = '', label = 'เบอร์มือถือ 10 หลัก', id = 'phone', pick = true, recent = false } = {}) {
  return html`<div class="field phone-field" data-phone-field>
    <label for="${id}">${label}</label>
    <div class="phone-input-wrap">
      <span class="phone-prefix">${icon('phone', 20)}</span>
      <input class="input" id="${id}" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
        placeholder="08X-XXX-XXXX" maxlength="16" value="${formatPhoneTyping(value)}">
      ${pick ? html`<button type="button" class="btn ghost sm pick-btn" data-pick title="เลือกจากเบอร์ล่าสุด / สมุดโทรศัพท์" aria-label="เลือกเบอร์จากเบอร์ล่าสุดหรือสมุดโทรศัพท์">${icon('book', 18)}<span class="pick-label">เลือกเบอร์</span></button>` : ''}
    </div>
    <div class="phone-status" data-phone-status aria-live="polite"></div>
    ${recent ? html`<div class="recent-chips hidden" data-recent aria-label="เบอร์ที่เคยเติมล่าสุด"></div>` : ''}
  </div>`;
}

/**
 * ผูกการทำงานกับช่องเบอร์ที่สร้างจาก phoneFieldHtml
 * onChange(phone) เรียกทุกครั้งที่ค่าในช่องเปลี่ยน (phone = เบอร์ที่ถูกต้อง หรือ null)
 * onPick(entry) เรียกหลัง onChange เมื่อเลือกจากเบอร์ล่าสุด / สมุดโทรศัพท์
 * @returns {{ value: string|null, set(v), focus(), error(msg) }}
 */
export function bindPhoneField(root, { onChange, onPick } = {}) {
  const wrap = root.querySelector('[data-phone-field]');
  const input = wrap.querySelector('input');
  const status = wrap.querySelector('[data-phone-status]');

  const update = () => {
    const digits = digitsOf(input.value);
    const phone = normalizePhone(digits);
    wrap.classList.remove('has-error', 'is-valid');
    if (!digits) setHTML(status, '');
    else if (phone) {
      wrap.classList.add('is-valid');
      setHTML(status, html`<span class="text-success">${icon('check', 14)} รูปแบบเบอร์ถูกต้อง</span>`);
    } else if (digits.length < 10) {
      setHTML(status, html`<span class="muted">กรอกอีก ${10 - digits.length} หลัก</span>`);
    } else {
      wrap.classList.add('has-error');
      setHTML(status, html`<span class="text-danger">${icon('alert', 14)} เบอร์มือถือต้องขึ้นต้นด้วย 06, 08 หรือ 09</span>`);
    }
    renderRecent(); // ไฮไลต์เบอร์ล่าสุดที่ตรงกับเบอร์ในช่อง (พิมพ์เอง / เลือกจากรายการ)
    onChange?.(phone);
  };

  const setValue = bindPhoneFormat(input, update);
  input.addEventListener('blur', () => {
    const digits = digitsOf(input.value);
    if (digits && digits.length < 10) {
      wrap.classList.add('has-error');
      setHTML(status, html`<span class="text-danger">${icon('alert', 14)} เบอร์ไม่ครบ 10 หลัก</span>`);
    }
  });

  // เบอร์ที่เคยเติมล่าสุด: กดเพื่อใส่เบอร์ (+ เครือข่ายที่เคยเติมสำเร็จ + ร้าน) ให้ทันที ไม่ต้องพิมพ์
  const recentEl = wrap.querySelector('[data-recent]');
  let recentList = [];
  function renderRecent() {
    if (!recentEl) return;
    const cur = normalizePhone(input.value);
    const items = recentList.slice(0, 4);
    recentEl.classList.toggle('hidden', !items.length);
    setHTML(recentEl, items.length ? html`<span class="xsmall muted">เบอร์ล่าสุด:</span>${items.map((r) => {
      // แสดงเครือข่ายเฉพาะที่เคยเติมสำเร็จ (ยังไม่สำเร็จ = อาจเลือกผิด ไม่ชี้นำ)
      const n = r.network_confirmed ? networkOf(r.network) : null;
      return html`<button type="button" class="chip ${r.phone === cur ? 'active' : ''}" data-recent-phone="${r.phone}" aria-pressed="${r.phone === cur ? 'true' : 'false'}">
        <span class="num">${phoneFmt(r.phone)}</span>${r.name ? html`<span class="chip-sub">${r.name}</span>` : ''}${n ? html`<span class="chip-sub">${n.name}</span>` : ''}</button>`;
    })}` : '');
  }
  if (recentEl && state.user) {
    recentNumbers().then((list) => { recentList = list; renderRecent(); }).catch(() => {});
    recentEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-recent-phone]');
      if (!b) return;
      const entry = recentList.find((r) => r.phone === b.dataset.recentPhone);
      if (!entry) return;
      setValue(entry.phone);
      update();
      onPick?.({ ...entry, source: 'recent' });
    });
  }

  const pickBtn = wrap.querySelector('[data-pick]');
  pickBtn?.addEventListener('click', async () => {
    if (!state.user) {
      toast('เข้าสู่ระบบก่อนเพื่อใช้สมุดโทรศัพท์', 'warning');
      return;
    }
    const entry = await pickFromPhonebook();
    if (!entry) return;
    setValue(entry.phone);
    update();
    onPick?.(entry);
  });

  update();
  return {
    get value() { return normalizePhone(input.value); },
    set(v) {
      setValue(v);
      update();
    },
    focus() {
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    error(msg) {
      wrap.classList.remove('is-valid');
      wrap.classList.add('has-error');
      setHTML(status, html`<span class="text-danger" role="alert">${icon('alert', 14)} ${msg}</span>`);
      this.focus();
    },
  };
}
