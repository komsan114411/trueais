// ตั้งค่าระบบ: สถานะผู้ให้บริการ + สำรองข้อมูล + ฟอร์มตั้งค่า (สร้างอัตโนมัติจาก schema ของเซิร์ฟเวอร์)
import { html, raw, api, baht, dateTimeSec, timeAgo, toast, toastError, withLoading, on, copyText, confirmDialog } from '../lib.js';
import { icon, store } from './common.js';

const CAP_LABELS = { statusCheck: 'เช็กสถานะรายการ', balance: 'เช็กเครดิต', products: 'ดึงรายการแพ็กเกจ', callback: 'รับแจ้งผล (callback)' };
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function providerPanel(p) {
  const b = p.balance;
  const br = p.breaker;
  return html`<section class="card">
    <div class="card-head">
      <h3>ผู้ให้บริการหลัก${p.providers?.length > 1 ? html` <span class="small muted">(มี ${p.providers.length} เจ้า — <a href="#/providers">ดูทุกเจ้า / ตั้งลำดับและการสลับอัตโนมัติ</a>)</span>` : ''}</h3>
      <span class="mode-badge ${p.live ? 'live' : 'mock'}">${p.live ? `ใช้งานจริง (${p.label})` : 'โหมดทดสอบ (MOCK)'}</span>
    </div>
    <div class="grid cols-2">
      <div class="stack">
        <dl class="dl">
          <dt>ผู้ให้บริการ</dt><dd>${p.label} <span class="muted mono small">(${p.name})</span></dd>
          <dt>สถานะการตั้งค่า</dt><dd>${p.config.ready ? html`<span class="badge success">พร้อมรับรายการ</span>` : html`<span class="badge danger">ยังไม่พร้อม — ระบบไม่รับรายการใหม่</span>`}</dd>
          <dt>ความสามารถ</dt><dd class="small">${Object.entries(CAP_LABELS).map(([k, l]) => html`<span class="pill" style="margin:0 4px 4px 0">${p.capabilities?.[k] ? '✓' : '✕'} ${l}</span>`)}</dd>
          <dt>เครดิตคงเหลือ</dt><dd>${b && b.balance !== null && b.balance !== undefined ? html`<b>฿${baht(b.balance)}</b>` : '-'} ${b?.checked_at ? html`<span class="muted small">(${timeAgo(b.checked_at)})</span>` : ''}${b?.error ? html`<div class="small text-danger">${b.error}</div>` : ''}</dd>
          <dt>แจ้งเตือนแอดมิน</dt><dd class="small">LINE: ${p.notify?.line ? html`<span class="text-success">ตั้งค่าแล้ว</span>` : html`<span class="muted">ยังไม่ตั้ง</span>`} · Telegram: ${p.notify?.telegram ? html`<span class="text-success">ตั้งค่าแล้ว</span>` : html`<span class="muted">ยังไม่ตั้ง</span>`}<div class="muted">ตั้งใน .env (LINE_CHANNEL_ACCESS_TOKEN / TELEGRAM_BOT_TOKEN)</div></dd>
        </dl>
        ${p.config.ready ? '' : html`<div class="alert danger"><span class="alert-icon">!</span><div><b>สิ่งที่ยังขาด:</b><ul class="check-list">${p.config.missing.map((m) => html`<li>${m}</li>`)}</ul><div class="small mt-1">แก้ไฟล์ .env แล้วรีสตาร์ทระบบ — ดูขั้นตอนใน docs/WONDD-INTEGRATION.md</div></div></div>`}
      </div>
      <div class="stack">
        <div><div class="code-label">Callback URL (ให้ WonDD ส่งผลกลับมาที่นี่)</div>
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
          <div class="row"><input class="input" name="amount" inputmode="decimal" placeholder="จำนวนบาท" value="10000" style="max-width:180px"><button class="btn sm" type="submit">${icon('plus')}เติมเครดิตจำลอง</button></div>
          <p class="xsmall muted mt-1 mb-0">ทดสอบได้ด้วยเบอร์พิเศษ (4 หลักท้าย): 0000 ปฏิเสธ · 1111 timeout · 2222 ค้าง · 3333 ไม่สำเร็จภายหลัง · 4444 เชื่อมต่อไม่ได้ · 5555 สำเร็จภายหลัง</p>
        </form>`}
      </div>
    </div>
  </section>`;
}

function backupCard(list) {
  return html`<section class="card">
    <div class="card-head"><h3>สำรองข้อมูล</h3><button class="btn sm primary" data-act="backup">${icon('download')}สำรองตอนนี้</button></div>
    <p class="small muted">ระบบสำรองอัตโนมัติวันละครั้ง เก็บ 14 ชุดล่าสุดที่โฟลเดอร์ <code>data/backups</code> (ไฟล์อยู่บนเซิร์ฟเวอร์ ควรคัดลอกเก็บไว้ที่อื่นด้วย)</p>
    ${list === null ? html`<p class="small text-danger mb-0">โหลดรายการสำรองไม่สำเร็จ</p>` : list.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>ไฟล์</th><th class="num">ขนาด</th><th>เวลา</th></tr></thead>
          <tbody>${list.map((b) => html`<tr><td class="mono small">${b.name}</td><td class="num">${fileSize(b.size)}</td><td class="small nowrap">${dateTimeSec(b.created_at)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="small muted mb-0">ยังไม่มีไฟล์สำรอง</p>`}
  </section>`;
}

function control(f, value) {
  const name = f.key;
  // มีตัวเลือกกำหนดไว้ → ให้เลือกจากรายการ (กันพิมพ์ค่าผิด)
  if (Array.isArray(f.options) && f.options.length) {
    const has = f.options.some((o) => String(o.value) === String(value ?? ''));
    return html`<select class="select" name="${name}">${has ? '' : html`<option value="${value ?? ''}" selected>${value ?? ''} (ค่าปัจจุบัน)</option>`}${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value ?? '') ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  }
  if (f.type === 'boolean') {
    return html`<label class="switch"><input type="checkbox" name="${name}" ${value ? raw('checked') : ''}><span class="track"></span><span class="small" data-swlabel>${value ? 'เปิด' : 'ปิด'}</span></label>`;
  }
  if (f.type === 'number') {
    return html`<input class="input" type="number" name="${name}" value="${value}" ${f.min !== undefined ? html`min="${f.min}"` : ''} ${f.max !== undefined ? html`max="${f.max}"` : ''} step="any">`;
  }
  if (f.type === 'text') {
    return html`<textarea class="textarea" name="${name}" ${f.max ? html`maxlength="${f.max}"` : ''}>${value ?? ''}</textarea>`;
  }
  return html`<input class="input" name="${name}" value="${value ?? ''}" ${f.max ? html`maxlength="${f.max}"` : ''}>`;
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
          <div><div class="s-label">${f.label}</div>${f.help ? html`<div class="s-help">${f.help}</div>` : ''}<div class="s-help">ค่าเริ่มต้น: ${f.type === 'boolean' ? (f.default ? 'เปิด' : 'ปิด') : f.default === '' ? '(ว่าง)' : String(f.default)}${f.min !== undefined ? ` · ช่วง ${f.min} - ${f.max}` : ''}</div></div>
          <div>${control(f, values[f.key])}</div>
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

export async function render(el) {
  el.innerHTML = html`
    <div data-provider><div class="card"><span class="spinner"></span></div></div>
    <div data-backups></div>
    <div data-form><div class="card"><span class="spinner"></span></div></div>`.toString();

  let provider = null;
  const loadProvider = async () => {
    try {
      provider = await api.get('/api/admin/provider');
      el.querySelector('[data-provider]').innerHTML = providerPanel(provider).toString();
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
  const loadSettings = async () => {
    const s = await api.get('/api/admin/settings');
    schema = s.schema;
    original = { ...s.values };
    el.querySelector('[data-form]').innerHTML = settingsForm(s.values, s.schema, provider?.live).toString();
    bindForm();
  };

  function bindForm() {
    const form = el.querySelector('[data-settings]');
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
    form.addEventListener('input', refresh);
    form.addEventListener('change', (e) => {
      const lbl = e.target.closest('.switch')?.querySelector('[data-swlabel]');
      if (lbl) lbl.textContent = e.target.checked ? 'เปิด' : 'ปิด';
      refresh();
    });
    resetBtn.addEventListener('click', () => loadSettings().catch(toastError));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = diff();
      const bad = Object.entries(d).find(([, v]) => typeof v === 'number' && Number.isNaN(v));
      if (bad) { toast('กรุณากรอกตัวเลขให้ครบ', 'error'); return; }
      withLoading(saveBtn, async () => {
        try {
          if (d.maintenance_mode === true) {
            const ok = await confirmDialog({ title: 'เปิดโหมดปิดปรับปรุง', body: 'ลูกค้าและ API ร้านค้าจะทำรายการใหม่ไม่ได้จนกว่าจะปิดโหมดนี้ (รายการที่ค้างอยู่ยังทำงานต่อตามปกติ)', confirmText: 'เปิดโหมดปิดปรับปรุง', danger: true });
            if (!ok) return;
          }
          const r = await api.put('/api/admin/settings', d);
          toast(`บันทึกแล้ว ${r.changed.length} รายการ`, 'success');
          await loadSettings();
          store.refresh().catch(() => {});
        } catch (err) {
          const field = err.details?.field;
          if (field) form.querySelector(`[data-row="${CSS.escape(field)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          toastError(err);
        }
      });
    });
  }

  on(el, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
  on(el, 'click', '[data-act]', (e, b) => {
    const act = b.dataset.act;
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
          toast(`สำรองข้อมูลแล้ว: ${r.name} (${fileSize(r.size)})`, 'success', 5000);
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
    const form = e.target.closest('[data-mock]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const amount = form.querySelector('[name="amount"]').value.trim().replace(/,/g, '');
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
}
