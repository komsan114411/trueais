// ตั้งค่าระบบ: สถานะผู้ให้บริการ + การแจ้งเตือน + สำรองข้อมูล + ฟอร์มตั้งค่า (สร้างอัตโนมัติจาก schema ของเซิร์ฟเวอร์)
import { html, raw, api, baht, dateTimeSec, timeAgo, modal, toast, toastError, withLoading, on, copyText, confirmDialog } from '../lib.js';
import { icon, store, ROUTING_KEYS, confirmRoutingChange, testNotify, shortLabel } from './common.js';

const CAP_LABELS = { statusCheck: 'เช็กสถานะรายการ', balance: 'เช็กเครดิต', products: 'ดึงรายการแพ็กเกจ', callback: 'รับแจ้งผล (callback)' };
// คู่มือการเชื่อมต่อของแต่ละเจ้า (โฟลเดอร์ docs ของระบบ)
const DOCS = { wondd: 'docs/WONDD-INTEGRATION.md', hubzell: 'docs/HUBZELL-INTEGRATION.md' };
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const backupUrl = (name) => `/api/admin/backups/${encodeURIComponent(name)}/download`;

function providerPanel(p) {
  const b = p.balance;
  const br = p.breaker;
  const name = shortLabel(p);
  return html`<section class="card">
    <div class="card-head">
      <h3>ผู้ให้บริการหลัก${p.providers?.length > 1 ? html` <span class="small muted">(มี ${p.providers.length} เจ้า — <a href="#/providers">ดูทุกเจ้า / ตั้งลำดับและการสลับอัตโนมัติ</a>)</span>` : ''}</h3>
      <span class="mode-badge ${p.live ? 'live' : 'mock'}">${p.live ? `ใช้งานจริง (${name})` : 'โหมดทดสอบ (MOCK)'}</span>
    </div>
    <div class="grid cols-2">
      <div class="stack">
        <dl class="dl">
          <dt>ผู้ให้บริการ</dt><dd>${p.label} <span class="muted mono small">(${p.name})</span></dd>
          <dt>สถานะการตั้งค่า</dt><dd>${p.config.ready ? html`<span class="badge success">พร้อมรับรายการ</span>` : html`<span class="badge danger">ยังไม่พร้อม — ระบบไม่รับรายการใหม่</span>`}</dd>
          <dt>ความสามารถ</dt><dd class="small">${Object.entries(CAP_LABELS).map(([k, l]) => html`<span class="pill" style="margin:0 4px 4px 0">${p.capabilities?.[k] ? '✓' : '✕'} ${l}</span>`)}</dd>
          <dt>เครดิตคงเหลือ</dt><dd>${b && b.balance !== null && b.balance !== undefined ? html`<b>฿${baht(b.balance)}</b>` : '-'} ${b?.checked_at ? html`<span class="muted small">(${timeAgo(b.checked_at)})</span>` : ''}${b?.error ? html`<div class="small text-danger">${b.error}</div>` : ''}</dd>
        </dl>
        ${p.config.ready ? '' : html`<div class="alert danger"><span class="alert-icon">!</span><div><b>สิ่งที่ยังขาด:</b><ul class="check-list">${p.config.missing.map((m) => html`<li>${m}</li>`)}</ul><div class="small mt-1">แก้ไฟล์ .env แล้วรีสตาร์ทระบบ — ดูขั้นตอนในคู่มือการเชื่อมต่อ ${name}${DOCS[p.name] ? html` (<span class="mono">${DOCS[p.name]}</span>)` : ' (โฟลเดอร์ docs)'}</div></div></div>`}
      </div>
      <div class="stack">
        <div><div class="code-label">Callback URL (ให้ ${name} ส่งผลกลับมาที่นี่)</div>
          <div class="copy-field"><code style="white-space:normal;word-break:break-all">${p.callback_url}</code><button class="btn sm" data-copy="${p.callback_url}" title="คัดลอก URL ทั้งเส้น">${icon('copy')}คัดลอก</button></div>
          <div class="small text-danger mt-1">ให้นำ URL นี้ทั้งเส้นไปตั้งที่ผู้ให้บริการ (มีรหัสลับ ห้ามเผยแพร่)</div></div>
        <div><div class="code-label">ที่อยู่เว็บไซต์ (PUBLIC_URL)</div><div class="copy-field"><code>${p.public_url}</code></div></div>
        <div class="detail-section">
          <h4>ตัวหยุดรับรายการอัตโนมัติ (circuit breaker)</h4>
          ${br.open
            ? html`<div class="alert danger"><span class="alert-icon">!</span><div>กำลังหยุดรับรายการชั่วคราวถึง ${dateTimeSec(br.openUntil)}<div class="small">ล้มเหลวติดกัน ${br.consecutiveFailures} ครั้ง · ล่าสุด: ${br.lastError || '-'}</div></div></div>`
            : html`<p class="small mb-2"><span class="badge success">ปกติ</span> ${br.consecutiveFailures ? html`<span class="muted">ล้มเหลวติดกันล่าสุด ${br.consecutiveFailures} ครั้ง</span>` : ''}</p>`}
          <div class="row wrap">
            <button class="btn sm" data-act="reset-breaker" ${br.open || br.consecutiveFailures ? '' : raw('disabled')}>${icon('bolt')}เปิดรับรายการทันที</button>
            <button class="btn sm" data-act="balance">${icon('refresh')}เช็กเครดิตตอนนี้</button>
            <button class="btn sm" data-act="worker">${icon('play')}รันงานเบื้องหลังตอนนี้</button>
          </div>
          <p class="xsmall muted mt-1 mb-0">งานเบื้องหลัง = เช็กสถานะรายการที่ยังไม่ทราบผล, กู้รายการค้าง, ส่ง webhook (ปกติทำอัตโนมัติทุกไม่กี่วินาที)</p>
        </div>
        ${p.live ? '' : html`<form class="detail-section" data-mock>
          <h4>เครดิตจำลอง (โหมดทดสอบ)</h4>
          <div class="row wrap"><input class="input" name="amount" inputmode="decimal" placeholder="จำนวนบาท" value="10000" style="max-width:180px"><button class="btn sm" type="submit">${icon('plus')}เติมเครดิตจำลอง</button></div>
          <p class="xsmall muted mt-1 mb-0">ทดสอบได้ด้วยเบอร์พิเศษ (4 หลักท้าย): 0000 ปฏิเสธ · 1111 timeout · 2222 ค้าง · 3333 ไม่สำเร็จภายหลัง · 4444 เชื่อมต่อไม่ได้ · 5555 สำเร็จภายหลัง</p>
        </form>`}
      </div>
    </div>
  </section>`;
}

/** การแจ้งเตือนแอดมิน (LINE / Telegram) + ปุ่มส่งข้อความทดสอบ */
function notifyCard(p) {
  const n = p.notify || {};
  const any = n.line || n.telegram;
  return html`<section class="card" id="notify" data-focus="notify">
    <div class="card-head"><h3>${icon('bell')} แจ้งเตือนแอดมิน</h3>
      <button class="btn sm ${any ? 'primary' : ''}" data-act="notify-test">${icon('bell')}ส่งข้อความทดสอบ</button></div>
    <p class="small mb-1">LINE: ${n.line ? html`<span class="text-success bold">ตั้งค่าแล้ว</span>` : html`<span class="muted">ยังไม่ตั้ง</span>`} ·
      Telegram: ${n.telegram ? html`<span class="text-success bold">ตั้งค่าแล้ว</span>` : html`<span class="muted">ยังไม่ตั้ง</span>`}</p>
    <p class="small muted mb-0">${any
      ? 'กด "ส่งข้อความทดสอบ" แล้วดูว่าโทรศัพท์ได้รับข้อความ — ระบบจะแจ้งเมื่อมีรายการต้องตรวจสอบ, เครดิตใกล้หมด, ผู้ให้บริการขัดข้อง, มีการแตะบัญชีแอดมิน'
      : 'ยังไม่ได้ตั้ง — จะไม่รู้ทันทีเมื่อมีรายการต้องตรวจสอบ ตั้งค่าในไฟล์ .env (LINE_CHANNEL_ACCESS_TOKEN + ผู้รับ หรือ TELEGRAM_BOT_TOKEN + chat id) แล้วรีสตาร์ทระบบ'}</p>
  </section>`;
}

function backupCard(list) {
  return html`<section class="card" id="backup" data-focus="backup">
    <div class="card-head"><h3>สำรองข้อมูล</h3><button class="btn sm primary" data-act="backup">${icon('download')}สำรองตอนนี้</button></div>
    <p class="small muted">ระบบสำรองอัตโนมัติวันละครั้ง ไฟล์อยู่บนเครื่องที่รันระบบ (โฟลเดอร์ <code>data/backups</code>)</p>
    <div class="alert warning mb-2"><span class="alert-icon">!</span><div class="small"><b>ดาวน์โหลดเก็บไว้นอกเครื่องนี้อย่างน้อยสัปดาห์ละครั้ง</b> (เช่น Google Drive, แฟลชไดรฟ์) — ถ้าเครื่องนี้เสียหรือหาย ข้อมูลยอดเงินลูกค้าและรายการทั้งหมดจะหายไปด้วย ·
      ไฟล์มีข้อมูลลูกค้า เก็บไว้ในที่ที่มีรหัสผ่าน ห้ามส่งต่อ</div></div>
    ${list === null ? html`<p class="small text-danger mb-0">โหลดรายการสำรองไม่สำเร็จ</p>` : list.length
      ? html`<div class="table-wrap"><table class="table cards-sm"><thead><tr><th>ไฟล์</th><th class="num">ขนาด</th><th>เวลา</th><th></th></tr></thead>
          <tbody>${list.map((b) => html`<tr>
            <td class="mono small o1 full">${b.name}</td>
            <td class="num o3 left-sm" data-label="ขนาด">${fileSize(b.size)}</td>
            <td class="small nowrap o4 r" data-label="เวลา">${dateTimeSec(b.created_at)}</td>
            <td class="actions o5 full"><a class="btn sm" href="${backupUrl(b.name)}" download="${b.name}" data-download="${b.name}">${icon('download')}ดาวน์โหลด</a></td>
          </tr>`)}</tbody></table></div>`
      : html`<p class="small muted mb-0">ยังไม่มีไฟล์สำรอง</p>`}
  </section>`;
}

function control(f, value) {
  const name = f.key;
  // มีตัวเลือกกำหนดไว้ → ให้เลือกจากรายการ (กันพิมพ์ค่าผิด)
  if (Array.isArray(f.options) && f.options.length) {
    const has = f.options.some((o) => String(o.value) === String(value ?? ''));
    return html`<select class="select" name="${name}" id="set-${name}">${has ? '' : html`<option value="${value ?? ''}" selected>${value ?? ''} (ค่าปัจจุบัน)</option>`}${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value ?? '') ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  }
  if (f.type === 'boolean') {
    return html`<label class="switch"><input type="checkbox" name="${name}" id="set-${name}" ${value ? raw('checked') : ''}><span class="track"></span><span class="small" data-swlabel>${value ? 'เปิด' : 'ปิด'}</span></label>`;
  }
  if (f.type === 'number') {
    return html`<input class="input" type="number" name="${name}" id="set-${name}" value="${value}" ${f.min !== undefined ? html`min="${f.min}"` : ''} ${f.max !== undefined ? html`max="${f.max}"` : ''} step="any" inputmode="numeric">`;
  }
  if (f.type === 'text') {
    return html`<textarea class="textarea" name="${name}" id="set-${name}" ${f.max ? html`maxlength="${f.max}"` : ''}>${value ?? ''}</textarea>`;
  }
  // หมายเลขพร้อมเพย์: ปุ่มทดสอบ QR 1 บาท (สแกนดูชื่อผู้รับก่อนเปิดรับเงินจริง)
  if (name === 'promptpay_id') {
    return html`<div class="stack" style="--gap:6px"><input class="input" name="${name}" id="set-${name}" value="${value ?? ''}" ${f.max ? html`maxlength="${f.max}"` : ''} inputmode="numeric" autocomplete="off">
      <button type="button" class="btn sm" data-act="pp-test">${icon('qr')}ทดสอบ QR 1 บาท</button></div>`;
  }
  return html`<input class="input" name="${name}" id="set-${name}" value="${value ?? ''}" ${f.max ? html`maxlength="${f.max}"` : ''}>`;
}

function settingsForm(values, schema, live) {
  const groups = Object.entries(schema.groups);
  return html`<form class="settings-grid" data-settings novalidate>
    ${groups.map(([g, label]) => {
      const fields = schema.fields.filter((f) => f.group === g);
      if (!fields.length) return '';
      return html`<section class="card">
        <div class="card-head"><h3>${label}</h3>${g === 'mock' ? html`<span class="badge ${live ? '' : 'warning'} plain">${live ? 'ไม่มีผลในโหมดใช้งานจริง' : 'ใช้เฉพาะโหมดทดสอบ'}</span>` : ''}</div>
        ${fields.map((f) => html`<div class="setting-row ${f.type === 'text' ? 'wide' : ''}" data-row="${f.key}">
          <div>${f.type === 'boolean'
            // สวิตช์: ชื่อการตั้งค่าไม่ใช่ปุ่มกด (กันแตะชื่อแล้วสวิตช์เปลี่ยนเองโดยไม่ตั้งใจ)
            ? html`<div class="s-label">${f.label}</div>`
            : html`<label class="s-label" for="set-${f.key}">${f.label}</label>`}${f.help ? html`<div class="s-help">${f.help}</div>` : ''}<div class="s-help">ค่าเริ่มต้น: ${f.type === 'boolean' ? (f.default ? 'เปิด' : 'ปิด') : f.default === '' ? '(ว่าง)' : String(f.default)}${f.min !== undefined ? ` · ช่วง ${f.min} - ${f.max}` : ''}</div></div>
          <div>${control(f, values[f.key])}<div class="s-error" data-err="${f.key}" role="alert"></div></div>
        </div>`)}
      </section>`;
    })}
    <div class="save-bar" data-savebar>
      <span class="small" data-changed>ยังไม่มีการแก้ไข</span>
      <span class="row"><button class="btn" type="button" data-reset disabled>ยกเลิกการแก้ไข</button><button class="btn primary" type="submit" data-save disabled>บันทึกการตั้งค่า</button></span>
    </div>
  </form>`;
}

function readValue(form, f) {
  const el = form.querySelector(`[name="${CSS.escape(f.key)}"]`);
  if (!el) return undefined;
  if (f.type === 'boolean') return el.checked;
  if (f.type === 'number') return el.value === '' ? NaN : Number(el.value);
  return el.value;
}

/** ค่าที่อ่านเข้าใจสำหรับหน้าต่างสรุป */
function showValue(f, v) {
  if (f.type === 'boolean') return v ? 'เปิด' : 'ปิด';
  if (Array.isArray(f.options)) return f.options.find((o) => String(o.value) === String(v))?.label || String(v ?? '');
  const s = String(v ?? '');
  if (!s) return '(ว่าง)';
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// การตั้งค่าที่เปลี่ยนแล้วเสี่ยง → เตือนเพิ่มในหน้าต่างสรุป
const RISKY = {
  maintenance_mode: (v) => (v === true ? 'ลูกค้าและ API ร้านค้าจะทำรายการใหม่ไม่ได้จนกว่าจะปิดโหมดนี้ (รายการที่ค้างอยู่ยังทำงานต่อตามปกติ)' : ''),
  registration_enabled: (v) => (v === false ? 'ปิดรับสมัคร — ลูกค้าใหม่สมัครสมาชิกไม่ได้' : ''),
  duplicate_window_sec: (v) => (v === 0 ? 'ปิดการกันเติมซ้ำ — เบอร์ + ยอดเดียวกันจะเติมซ้ำได้ทันที (เสี่ยงลูกค้ากดซ้ำ)' : ''),
  daily_limit_baht: (v) => (v === 0 ? 'วงเงินต่อวัน = ไม่จำกัด — ถ้าบัญชีลูกค้าถูกขโมย จะใช้เงินในกระเป๋าได้ทั้งหมดทันที' : ''),
  deposit_unique_satang: (v) => (v === false ? 'ปิดเศษสตางค์ — ยอดโอนของลูกค้าจะซ้ำกันได้ ตรวจสลิปจับคู่รายการยากขึ้น' : ''),
  promptpay_id: () => 'หมายเลขพร้อมเพย์เปลี่ยน — ลูกค้าจะโอนเงินเข้าหมายเลขใหม่ทันที (แนะนำกด "ทดสอบ QR 1 บาท" ตรวจชื่อผู้รับก่อน)',
};

export async function render(el, params, query = {}) {
  el.innerHTML = html`
    <div data-provider><div class="card"><span class="spinner"></span></div></div>
    <div data-notify></div>
    <div data-backups></div>
    <div data-form><div class="card"><span class="spinner"></span></div></div>`.toString();

  let provider = null;
  const loadProvider = async () => {
    try {
      provider = await api.get('/api/admin/provider');
      el.querySelector('[data-provider]').innerHTML = providerPanel(provider).toString();
      el.querySelector('[data-notify]').innerHTML = notifyCard(provider).toString();
    } catch (err) {
      el.querySelector('[data-provider]').innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
    }
  };
  const loadBackups = async () => {
    let list = null;
    try { list = await api.get('/api/admin/backups'); } catch { list = null; }
    el.querySelector('[data-backups]').innerHTML = backupCard(list).toString();
  };

  let schema = null;
  let original = {};
  let form = null;
  const loadSettings = async () => {
    const s = await api.get('/api/admin/settings');
    schema = s.schema;
    original = { ...s.values };
    el.querySelector('[data-form]').innerHTML = settingsForm(s.values, s.schema, provider?.live).toString();
    bindForm();
  };

  /** แสดง error ที่แถวของการตั้งค่านั้น (เช่น หมายเลขพร้อมเพย์ไม่ถูกต้อง) */
  const rowError = (field, message) => {
    if (!form) return false;
    const row = form.querySelector(`[data-row="${CSS.escape(field)}"]`);
    if (!row) return false;
    row.classList.add('has-error');
    const t = row.querySelector('.s-error');
    if (t) t.textContent = message;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    return true;
  };
  const clearRowErrors = () => form?.querySelectorAll('.setting-row.has-error').forEach((r) => {
    r.classList.remove('has-error');
    const t = r.querySelector('.s-error');
    if (t) t.textContent = '';
  });

  function bindForm() {
    form = el.querySelector('[data-settings]');
    const changedLabel = form.querySelector('[data-changed]');
    const saveBtn = form.querySelector('[data-save]');
    const resetBtn = form.querySelector('[data-reset]');
    const diff = () => {
      const out = {};
      for (const f of schema.fields) {
        const v = readValue(form, f);
        if (v === undefined) continue;
        const same = f.type === 'number' ? Number(original[f.key]) === v : original[f.key] === v;
        form.querySelector(`[data-row="${CSS.escape(f.key)}"]`)?.classList.toggle('changed', !same);
        if (!same) out[f.key] = v;
      }
      return out;
    };
    const refresh = () => {
      const d = diff();
      const n = Object.keys(d).length;
      changedLabel.textContent = n ? `แก้ไขแล้ว ${n} รายการ (ยังไม่บันทึก)` : 'ยังไม่มีการแก้ไข';
      saveBtn.disabled = !n;
      resetBtn.disabled = !n;
    };
    form.addEventListener('input', (e) => {
      e.target.closest('.setting-row')?.classList.remove('has-error');
      refresh();
    });
    form.addEventListener('change', (e) => {
      const lbl = e.target.closest('.switch')?.querySelector('[data-swlabel]');
      if (lbl) lbl.textContent = e.target.checked ? 'เปิด' : 'ปิด';
      refresh();
    });
    resetBtn.addEventListener('click', () => loadSettings().catch(toastError));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearRowErrors();
      const d = diff();
      const bad = Object.entries(d).find(([, v]) => typeof v === 'number' && Number.isNaN(v));
      if (bad) { rowError(bad[0], 'กรุณากรอกตัวเลข'); toast('กรุณากรอกตัวเลขให้ครบ', 'error'); return; }
      withLoading(saveBtn, async () => {
        try {
          // การเลือกผู้ให้บริการ → หน้าต่างยืนยันเดียวกับหน้า "ผู้ให้บริการ & ร้าน"
          const routing = Object.fromEntries(Object.entries(d).filter(([k]) => ROUTING_KEYS.includes(k)));
          if (!(await confirmRoutingChange(routing, { values: original, providers: provider?.providers || [] }))) return;
          // การตั้งค่าอื่น: สรุป "ค่าเดิม → ค่าใหม่" ให้ตรวจก่อนบันทึก (กันแก้โดยไม่ตั้งใจ) + เตือนเรื่องเสี่ยง
          const rest = Object.entries(d).filter(([k]) => !ROUTING_KEYS.includes(k));
          if (rest.length) {
            const fieldOf = (k) => schema.fields.find((f) => f.key === k) || { key: k, label: k };
            const risks = rest.map(([k, v]) => RISKY[k]?.(v)).filter(Boolean);
            const ok = await confirmDialog({
              title: d.maintenance_mode === true ? 'เปิดโหมดปิดปรับปรุง' : `บันทึกการตั้งค่า ${rest.length} รายการ`,
              body: html`<div class="stack">
                <ul class="check-list small">${rest.map(([k, v]) => { const f = fieldOf(k); return html`<li><b>${f.label}</b>: ${showValue(f, original[k])} → <b>${showValue(f, v)}</b></li>`; })}</ul>
                ${risks.length ? html`<div class="alert danger"><span class="alert-icon">!</span><div><ul class="check-list small">${risks.map((r) => html`<li>${r}</li>`)}</ul></div></div>` : ''}
                <p class="small mb-0">มีผลทันทีหลังบันทึก</p></div>`,
              confirmText: d.maintenance_mode === true ? 'เปิดโหมดปิดปรับปรุง' : 'บันทึก',
              danger: risks.length > 0,
            });
            if (!ok) return;
          }
          const r = await api.put('/api/admin/settings', d);
          toast(`บันทึกแล้ว ${r.changed.length} รายการ`, 'success');
          await loadSettings();
          store.refresh().catch(() => {});
        } catch (err) {
          const field = err.details?.field;
          if (!(field && rowError(field, err.message))) toastError(err);
        }
      });
    });
  }

  /** ทดสอบ QR พร้อมเพย์ 1 บาท — ใช้หมายเลขที่กรอกอยู่ (ยังไม่บันทึกก็ได้) ให้เจ้าของร้านสแกนดูชื่อผู้รับ (ไม่ต้องโอน) */
  const promptpayTest = async (btn) => {
    const input = form?.querySelector('[name="promptpay_id"]');
    const typed = input ? input.value.trim() : '';
    const saved = String(original.promptpay_id || '');
    if (!typed && !saved) { rowError('promptpay_id', 'กรุณากรอกหมายเลขพร้อมเพย์ก่อน'); return; }
    const unsaved = typed !== saved;
    await withLoading(btn, async () => {
      try {
        const r = await api.post('/api/admin/settings/promptpay-test', unsaved && typed ? { promptpay_id: typed } : {});
        form?.querySelector('[data-row="promptpay_id"]')?.classList.remove('has-error');
        const nameInput = form?.querySelector('[name="promptpay_name"]');
        const shopName = (nameInput ? nameInput.value : original.promptpay_name || '').trim();
        modal({
          title: 'ทดสอบ QR พร้อมเพย์ (1 บาท)',
          body: html`<div class="stack pp-test">
            <div class="pp-qr">${raw(r.qr_svg || '')}</div>
            <dl class="dl"><dt>พร้อมเพย์</dt><dd class="num">${r.target}</dd><dt>ยอดทดสอบ</dt><dd>${baht(r.amount)} บาท</dd>
              <dt>ชื่อที่ร้านตั้งไว้</dt><dd>${shopName || html`<span class="muted">(ยังไม่ได้ตั้ง)</span>`}</dd></dl>
            <ol class="small mb-0 pp-steps">
              <li>เปิดแอปธนาคาร → สแกนจ่าย แล้วสแกน QR นี้ (ถ้าเปิดหน้านี้ในโทรศัพท์เครื่องเดียวกัน ให้บันทึกภาพหน้าจอ แล้วเลือก "สแกนจากรูป" ในแอปธนาคาร)</li>
              <li>ดู<b>ชื่อผู้รับเงิน</b>ที่แอปแสดง — ต้องเป็นชื่อบัญชีของร้านคุณ${shopName ? html` (ตรงกับ "${shopName}")` : ''}</li>
              <li><b>ไม่ต้องกดโอน</b> — ตรวจชื่อแล้วกดยกเลิกในแอปได้เลย</li>
            </ol>
            <div class="alert danger"><span class="alert-icon">!</span><div class="small">ถ้าชื่อผู้รับไม่ใช่ร้านคุณ <b>ห้ามบันทึก/ใช้หมายเลขนี้</b> — ลูกค้าจะโอนเงินเข้าบัญชีคนอื่น</div></div>
            ${unsaved ? html`<p class="small text-warning mb-0">หมายเลขนี้ยังไม่ได้บันทึก — ถ้าชื่อถูกต้อง ปิดหน้าต่างนี้แล้วกด "บันทึกการตั้งค่า"</p>` : ''}
          </div>`,
          foot: html`<button class="btn primary" data-close>ปิด</button>`,
        });
      } catch (err) {
        if (!(err.details?.field && rowError(err.details.field, err.message))) toastError(err);
      }
    });
  };

  on(el, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
  on(el, 'click', '[data-act]', async (e, b) => {
    const act = b.dataset.act;
    if (act === 'pp-test') { promptpayTest(b); return; }
    if (act === 'notify-test') { testNotify(b); return; }
    if (act === 'reset-breaker') {
      // เปิดรับทั้งที่ยังไม่ได้แก้ปัญหา (เช่น เครดิตหมด / key / KYC / IP) อาจล้มเหลวซ้ำ และผู้ให้บริการอาจบล็อก → ยืนยันก่อน (เหมือนหน้าอื่น)
      const br = provider?.breaker || {};
      const ok = await confirmDialog({
        title: `เปิดรับรายการ ${provider ? shortLabel(provider) : ''} ทันที`,
        body: `${br.reason || br.lastError ? `เหตุที่พัก: ${br.reason || br.lastError} — ` : ''}เปิดใช้เมื่อแก้ปัญหาแล้วเท่านั้น ถ้ายังไม่ได้แก้ ระบบจะส่งรายการแล้วล้มเหลวซ้ำ และผู้ให้บริการอาจบล็อกการเชื่อมต่อ`,
        confirmText: 'เปิดรับรายการ',
        danger: true,
      });
      if (!ok) return;
    }
    withLoading(b, async () => {
      try {
        if (act === 'reset-breaker') {
          await api.post('/api/admin/provider/reset-breaker');
          toast('เปิดรับรายการแล้ว', 'success');
        } else if (act === 'balance') {
          const r = await api.post('/api/admin/provider/refresh-balance');
          if (r?.error) toast(`เช็กเครดิตไม่สำเร็จ: ${r.error}`, 'error');
          else toast('อัปเดตเครดิตแล้ว', 'success');
        } else if (act === 'worker') {
          await api.post('/api/admin/worker/run');
          toast('รันงานเบื้องหลังเสร็จแล้ว', 'success');
        } else if (act === 'backup') {
          const r = await api.post('/api/admin/backups', {});
          toast(`สำรองข้อมูลแล้ว: ${r.name} (${fileSize(r.size)}) — กด "ดาวน์โหลด" เพื่อเก็บสำเนาไว้นอกเครื่องนี้`, 'success', 7000);
          await loadBackups();
          return;
        }
        await loadProvider();
        store.refresh().catch(() => {});
      } catch (err) {
        toastError(err);
      }
    });
  });
  el.addEventListener('submit', (e) => {
    const mock = e.target.closest('[data-mock]');
    if (!mock) return;
    e.preventDefault();
    const btn = mock.querySelector('button[type="submit"]');
    const amount = mock.querySelector('[name="amount"]').value.trim().replace(/,/g, '');
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || !(Number(amount) > 0)) { toast('จำนวนเงินไม่ถูกต้อง (ตัวเลขมากกว่า 0)', 'error'); return; }
    withLoading(btn, async () => {
      try {
        const ok = await confirmDialog({
          title: 'เติมเครดิตจำลอง',
          body: `เพิ่มเครดิตจำลองที่ผู้ให้บริการ (โหมดทดสอบ) ${Number(amount).toLocaleString('th-TH', { maximumFractionDigits: 2 })} บาท? ไม่มีผลกับเงินจริงหรือกระเป๋าลูกค้า`,
          confirmText: 'เติมเครดิตจำลอง',
        });
        if (!ok) return;
        await api.post('/api/admin/provider/mock-credit', { amount });
        toast('เติมเครดิตจำลองแล้ว', 'success');
        await loadProvider();
        store.refresh().catch(() => {});
      } catch (err) { toastError(err); }
    });
  });

  await loadProvider();
  await Promise.all([loadBackups(), loadSettings().catch((err) => {
    el.querySelector('[data-form]').innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
  })]);

  // มาจากลิงก์ "ไปแก้" (เช่น #/settings?focus=promptpay_id / backup / notify) → เลื่อนไปที่หัวข้อนั้น
  if (query.focus) {
    const target = el.querySelector(`[data-row="${CSS.escape(query.focus)}"], [data-focus="${CSS.escape(query.focus)}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 2400);
    }
  }
}
