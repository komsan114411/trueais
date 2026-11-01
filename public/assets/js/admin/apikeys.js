// API key สำหรับเว็บไซต์ร้านค้า (เชื่อมต่อแบบ server-to-server ผ่าน /api/v1)
import { html, api, dateTime, phoneFmt, modal, confirmDialog, toast, toastError, withLoading, on, qs, copyText, debounce, showFieldError } from '../lib.js';
import { icon, emptyRow } from './common.js';

function howTo(base) {
  const curlTopup = `curl -X POST ${base}/api/v1/orders \\
  -H "Authorization: Bearer tk_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"topup","network":"AIS","phone":"0812345678","amount":100,"reference":"INV-1001"}'`;
  const curlPackage = `curl -X POST ${base}/api/v1/orders \\
  -H "Authorization: Bearer tk_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"package","network":"TRUE","phone":"0812345678","product_code":"รหัสแพ็กเกจ","reference":"INV-1002"}'`;
  const verifyNode = `// Node.js (Express): ต้องใช้ body ดิบ (raw) ในการตรวจลายเซ็น
const crypto = require('crypto');
app.post('/topup-webhook', express.raw({ type: '*/*' }), (req, res) => {
  const ts = req.get('X-Webhook-Timestamp');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.TOPUP_WEBHOOK_SECRET)
    .update(ts + '.' + req.body.toString('utf8')).digest('hex');
  const given = req.get('X-Webhook-Signature') || '';
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).send('bad signature');
  }
  const { data } = JSON.parse(req.body);  // data.reference, data.status (success | failed | refunded)
  res.send('ok');                           // ตอบ 2xx ภายใน 10 วินาที ไม่งั้นระบบจะส่งซ้ำ
});`;
  const verifyPhp = `<?php // PHP
$raw = file_get_contents('php://input');
$expected = 'sha256=' . hash_hmac('sha256', $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] . '.' . $raw, getenv('TOPUP_WEBHOOK_SECRET'));
if (!hash_equals($expected, $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '')) { http_response_code(401); exit('bad signature'); }
$event = json_decode($raw, true);  // $event['data']['reference'], $event['data']['status']
echo 'ok';`;
  return html`<section class="card how-to">
    <h3>วิธีเชื่อมเว็บไซต์ร้านค้า</h3>
    <ol class="small text-2">
      <li>สร้าง API key ผูกกับบัญชีผู้ใช้ที่จะ "จ่ายเงิน" (ตัดจากกระเป๋าของบัญชีนั้น) แล้วเก็บคีย์ไว้ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามใส่ในหน้าเว็บ</li>
      <li>ส่ง header <code>Authorization: Bearer &lt;API key&gt;</code> ทุกคำขอ</li>
      <li>สั่งรายการด้วย <code>POST /api/v1/orders</code> พร้อม <code>reference</code> (เลขที่บิลของร้าน ห้ามซ้ำ) — ส่งซ้ำด้วย reference เดิมจะได้รายการเดิม ไม่ตัดเงินซ้ำ (ปลอดภัยเมื่อ timeout)</li>
      <li>ไม่บังคับ: <code>shop</code> = เลือกร้าน (รหัสร้านจาก <code>GET /api/v1/products</code> — ไม่ส่ง = ระบบเลือกให้) และ <code>expected_price</code> = ราคาที่ร้านค้าคาดไว้ (บาท) ถ้าราคาเปลี่ยน ระบบไม่ตัดเงินและตอบ <code>PRICE_CHANGED</code></li>
      <li>รอผลทาง webhook (ตั้ง URL ตอนสร้างคีย์ หรือส่ง <code>callback_url</code> ต่อรายการ) หรือถามสถานะด้วย <code>GET /api/v1/orders?reference=INV-1001</code></li>
      <li>ตรวจลายเซ็น webhook: <code>X-Webhook-Signature = sha256=HMAC_SHA256(webhook_secret, X-Webhook-Timestamp + "." + body)</code></li>
    </ol>
    <details class="mt-2"><summary class="small" style="cursor:pointer"><b>ตัวอย่างคำสั่ง</b> (เติมเงิน / แพ็กเกจ / ตรวจลายเซ็น)</summary>
      <div class="stack mt-2">
        <div><div class="code-label">เติมเงิน</div><pre class="code">${curlTopup}</pre></div>
        <div><div class="code-label">สมัครแพ็กเกจ (ดูรหัสจาก GET /api/v1/products)</div><pre class="code">${curlPackage}</pre></div>
        <div><div class="code-label">ตรวจลายเซ็น webhook — Node.js</div><pre class="code">${verifyNode}</pre></div>
        <div><div class="code-label">ตรวจลายเซ็น webhook — PHP</div><pre class="code">${verifyPhp}</pre></div>
        <p class="small muted mb-0">อื่นๆ: <code>GET /api/v1/balance</code> (ยอดเงิน), <code>GET /api/v1/products</code> (เครือข่าย/ยอดเติม/แพ็กเกจ), <code>GET /api/v1/orders/:ref</code> — รายละเอียดเต็มใน docs/API.md</p>
      </div>
    </details>
  </section>`;
}

function keyForm(k = null, presetUser = null) {
  return html`<form class="stack" data-form autocomplete="off">
    ${k ? '' : html`<div class="field"><label>บัญชีผู้ใช้ที่ผูกกับคีย์ (ตัดเงินจากกระเป๋าบัญชีนี้)</label>
      <input type="hidden" name="user_id" value="${presetUser?.id || ''}">
      <div data-picked class="${presetUser ? '' : 'hidden'}"><span class="pill" data-picked-label>${presetUser ? `#${presetUser.id} ${presetUser.name}` : ''}</span> <button type="button" class="link-btn small" data-repick>เปลี่ยน</button></div>
      <div data-picker class="${presetUser ? 'hidden' : ''} stack" style="--gap:6px">
        <input class="input" data-user-search placeholder="ค้นหาชื่อ / เบอร์ / อีเมล">
        <div class="picker-results" data-results><div class="small muted" style="padding:10px">พิมพ์เพื่อค้นหา</div></div>
      </div><div class="error-text"></div></div>`}
    <div class="field"><label>ชื่อคีย์</label><input class="input" name="name" value="${k?.name || ''}" placeholder="เช่น เว็บร้านหลัก" maxlength="60"><div class="error-text"></div></div>
    <div class="field"><label>Webhook URL (ไม่บังคับ)</label><input class="input" name="webhook_url" value="${k?.webhook_url || ''}" placeholder="https://www.myshop.com/topup-webhook"><div class="help">ระบบจะ POST ผลรายการมาที่นี่เมื่อสำเร็จ/ไม่สำเร็จ</div><div class="error-text"></div></div>
    <div class="field"><label>จำกัด IP ที่เรียกได้ (ไม่บังคับ)</label><input class="input mono" name="ip_allowlist" value="${k?.ip_allowlist || ''}" placeholder="เช่น 203.0.113.10, 203.0.113.11"><div class="help">แนะนำให้ใส่ IP เซิร์ฟเวอร์ร้านค้า เพื่อกันคีย์รั่ว</div><div class="error-text"></div></div>
  </form>`;
}

function bindPicker(dlg) {
  const search = dlg.querySelector('[data-user-search]');
  if (!search) return;
  const results = dlg.querySelector('[data-results]');
  const hidden = dlg.querySelector('[name="user_id"]');
  const picker = dlg.querySelector('[data-picker]');
  const picked = dlg.querySelector('[data-picked]');
  const run = debounce(async () => {
    const q = search.value.trim();
    if (!q) { results.innerHTML = '<div class="small muted" style="padding:10px">พิมพ์เพื่อค้นหา</div>'; return; }
    try {
      const res = await api.get(`/api/admin/users${qs({ q, pageSize: 8 })}`);
      results.innerHTML = res.rows.length
        ? html`${res.rows.map((u) => html`<button type="button" data-pick="${u.id}" data-label="#${u.id} ${u.name}"><span><b>${u.name}</b> <span class="muted small">#${u.id}</span></span><span class="small muted">${u.phone ? phoneFmt(u.phone) : u.email || ''}</span></button>`)}`.toString()
        : '<div class="small muted" style="padding:10px">ไม่พบผู้ใช้</div>';
    } catch (err) { toastError(err); }
  }, 250);
  search.addEventListener('input', run);
  on(results, 'click', '[data-pick]', (e, b) => {
    hidden.value = b.dataset.pick;
    dlg.querySelector('[data-picked-label]').textContent = b.dataset.label;
    picker.classList.add('hidden');
    picked.classList.remove('hidden');
  });
  dlg.querySelector('[data-repick]').addEventListener('click', () => {
    hidden.value = '';
    picked.classList.add('hidden');
    picker.classList.remove('hidden');
    search.focus();
  });
  search.focus();
}

function showSecrets(r) {
  return modal({
    title: 'สร้าง API key แล้ว',
    dismissible: false,
    body: html`<div class="stack">
      <div class="alert danger"><span class="alert-icon">!</span><div><b>ข้อมูลนี้จะแสดงครั้งเดียว</b> — ระบบเก็บเฉพาะค่า hash ถ้าทำหายต้องสร้างคีย์ใหม่ เก็บไว้ในไฟล์ตั้งค่าฝั่งเซิร์ฟเวอร์ร้านค้า (เช่น .env) ห้ามใส่ในหน้าเว็บหรือส่งในแชท</div></div>
      <div class="secret-box stack" style="--gap:10px">
        <div><div class="code-label">API key</div><div class="copy-field"><code>${r.api_key}</code><button class="btn sm" data-copy="${r.api_key}">${icon('copy')}คัดลอก</button></div></div>
        <div><div class="code-label">Webhook secret (ใช้ตรวจลายเซ็น)</div><div class="copy-field"><code>${r.webhook_secret}</code><button class="btn sm" data-copy="${r.webhook_secret}">${icon('copy')}คัดลอก</button></div></div>
      </div>
    </div>`,
    foot: html`<button class="btn primary" data-close>เก็บเรียบร้อยแล้ว</button>`,
    onMount: (dlg) => on(dlg, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy)),
  });
}

function keyDialog(k = null, presetUser = null) {
  return modal({
    title: k ? `แก้ไข API key — ${k.name}` : 'สร้าง API key',
    body: keyForm(k, presetUser),
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>${k ? 'บันทึก' : html`${icon('key')}สร้างคีย์`}</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      bindPicker(dlg);
      const btn = dlg.querySelector('[data-ok]');
      const submit = (e) => {
        e?.preventDefault();
        withLoading(btn, async () => {
          const body = {
            name: form.querySelector('[name="name"]').value.trim(),
            webhook_url: form.querySelector('[name="webhook_url"]').value.trim(),
            ip_allowlist: form.querySelector('[name="ip_allowlist"]').value.trim(),
          };
          try {
            if (k) {
              await api.put(`/api/admin/api-keys/${k.id}`, body);
              toast('บันทึกแล้ว', 'success');
              close(true);
            } else {
              const userId = form.querySelector('[name="user_id"]').value;
              if (!userId) { toast('กรุณาเลือกบัญชีผู้ใช้', 'error'); return; }
              const r = await api.post('/api/admin/api-keys', { ...body, user_id: Number(userId) });
              close(r);
            }
          } catch (err) {
            if (!showFieldError(form, err)) toastError(err);
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
    },
  });
}

export async function render(el, params, query) {
  el.innerHTML = html`
    <div data-howto></div>
    <section class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><h3>API key ทั้งหมด</h3><button class="btn primary sm" data-create>${icon('plus')}สร้าง API key</button></div>
      <div data-list class="mt-1"><div class="empty"><span class="spinner"></span></div></div>
    </section>`.toString();

  api.get('/api/admin/provider')
    .then((p) => { el.querySelector('[data-howto]').innerHTML = howTo(p.public_url || location.origin).toString(); })
    .catch(() => { el.querySelector('[data-howto]').innerHTML = howTo(location.origin).toString(); });

  let keys = [];
  const load = async () => {
    try {
      keys = await api.get('/api/admin/api-keys');
      el.querySelector('[data-list]').innerHTML = html`<div class="table-wrap"><table class="table">
        <thead><tr><th>ชื่อ</th><th>บัญชีที่ผูก</th><th>คีย์</th><th>Webhook</th><th>จำกัด IP</th><th>สถานะ</th><th>ใช้ล่าสุด</th><th></th></tr></thead>
        <tbody>${keys.length ? keys.map((k) => html`<tr>
          <td class="bold">${k.name}<span class="sub">สร้าง ${dateTime(k.created_at)}</span></td>
          <td class="small">#${k.user_id} ${k.user_name}</td>
          <td class="mono small">${k.key_prefix}…</td>
          <td class="mono xsmall" style="max-width:240px;word-break:break-all">${k.webhook_url || html`<span class="muted">-</span>`}</td>
          <td class="mono xsmall">${k.ip_allowlist || html`<span class="muted">ไม่จำกัด</span>`}</td>
          <td>${k.status === 'active' ? html`<span class="badge success">ใช้งาน</span>` : html`<span class="badge danger">ยกเลิกแล้ว</span>`}</td>
          <td class="small nowrap">${dateTime(k.last_used_at)}</td>
          <td class="actions">${k.status === 'active' ? html`<button class="btn ghost sm" data-edit="${k.id}">${icon('edit')}แก้ไข</button><button class="btn ghost sm text-danger" data-revoke="${k.id}">ยกเลิกคีย์</button>` : ''}</td>
        </tr>`) : emptyRow(8, 'ยังไม่มี API key')}</tbody></table></div>`.toString();
    } catch (err) {
      el.querySelector('[data-list]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
    }
  };

  const create = async (presetUser) => {
    const r = await keyDialog(null, presetUser);
    if (r && r.api_key) {
      await showSecrets(r);
      load();
    }
  };
  el.querySelector('[data-create]').addEventListener('click', () => create(null));
  on(el, 'click', '[data-edit]', async (e, b) => {
    const k = keys.find((x) => String(x.id) === b.dataset.edit);
    if (k && (await keyDialog(k))) load();
  });
  on(el, 'click', '[data-revoke]', (e, b) => withLoading(b, async () => {
    const k = keys.find((x) => String(x.id) === b.dataset.revoke);
    if (!k) return;
    const ok = await confirmDialog({ title: 'ยกเลิก API key', body: `ยกเลิกคีย์ "${k.name}" (${k.key_prefix}…) ของบัญชี #${k.user_id} ${k.user_name || ''}? เว็บไซต์ที่ใช้คีย์นี้จะเรียก API ไม่ได้ทันที (ย้อนกลับไม่ได้)`, confirmText: 'ยกเลิกคีย์', danger: true });
    if (!ok) return;
    try {
      await api.post(`/api/admin/api-keys/${k.id}/revoke`);
      toast('ยกเลิกคีย์แล้ว', 'success');
      load();
    } catch (err) { toastError(err); }
  }));

  await load();
  if (query.user) {
    // มาจากหน้าผู้ใช้: เปิดฟอร์มสร้างคีย์โดยเลือกบัญชีไว้ให้ (ล้าง ?user ออกจาก URL โดยไม่โหลดหน้าใหม่)
    history.replaceState(null, '', '#/api-keys');
    try {
      const d = await api.get(`/api/admin/users/${encodeURIComponent(query.user)}`);
      create({ id: d.user.id, name: d.user.name });
    } catch (err) { toastError(err); }
  }
}
