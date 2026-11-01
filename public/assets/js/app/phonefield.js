// ช่องกรอกเบอร์มือถือ: จัดรูปแบบ 08X-XXX-XXXX ขณะพิมพ์ + ตรวจสอบทันที + เลือกจากสมุดโทรศัพท์
import { html, setHTML, normalizePhone, toast } from '../lib.js';
import { icon } from './icons.js';
import { state } from './state.js';
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

export function phoneFieldHtml({ value = '', label = 'เบอร์มือถือ 10 หลัก', id = 'phone', pick = true } = {}) {
  return html`<div class="field phone-field" data-phone-field>
    <label for="${id}">${label}</label>
    <div class="phone-input-wrap">
      <span class="phone-prefix">${icon('phone', 20)}</span>
      <input class="input" id="${id}" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
        placeholder="08X-XXX-XXXX" maxlength="16" value="${formatPhoneTyping(value)}">
      ${pick ? html`<button type="button" class="btn ghost sm pick-btn" data-pick title="เลือกจากสมุดโทรศัพท์">${icon('book', 18)}<span class="pick-label">สมุดโทรศัพท์</span></button>` : ''}
    </div>
    <div class="phone-status" data-phone-status aria-live="polite"></div>
  </div>`;
}

/**
 * ผูกการทำงานกับช่องเบอร์ที่สร้างจาก phoneFieldHtml
 * @returns {{ value: string|null, set(v), focus(), error(msg) }}
 */
export function bindPhoneField(root, { onChange, onPick } = {}) {
  const wrap = root.querySelector('[data-phone-field]');
  const input = wrap.querySelector('input');
  const status = wrap.querySelector('[data-phone-status]');

  const update = () => {
    const formatted = formatPhoneTyping(input.value);
    if (formatted !== input.value) input.value = formatted;
    const digits = input.value.replace(/\D/g, '');
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
    onChange?.(phone);
  };

  input.addEventListener('input', update);
  input.addEventListener('blur', () => {
    const digits = input.value.replace(/\D/g, '');
    if (digits && digits.length < 10) {
      wrap.classList.add('has-error');
      setHTML(status, html`<span class="text-danger">${icon('alert', 14)} เบอร์ไม่ครบ 10 หลัก</span>`);
    }
  });

  const pickBtn = wrap.querySelector('[data-pick]');
  pickBtn?.addEventListener('click', async () => {
    if (!state.user) {
      toast('เข้าสู่ระบบก่อนเพื่อใช้สมุดโทรศัพท์', 'warning');
      return;
    }
    const entry = await pickFromPhonebook();
    if (!entry) return;
    input.value = formatPhoneTyping(entry.phone);
    update();
    onPick?.(entry);
  });

  update();
  return {
    get value() { return normalizePhone(input.value); },
    set(v) {
      input.value = formatPhoneTyping(String(v ?? ''));
      update();
    },
    focus() {
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    error(msg) {
      wrap.classList.remove('is-valid');
      wrap.classList.add('has-error');
      setHTML(status, html`<span class="text-danger">${icon('alert', 14)} ${msg}</span>`);
      this.focus();
    },
  };
}
