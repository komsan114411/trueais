'use strict';
/**
 * โครงสร้างฐานข้อมูล SQLite (ไฟล์ในเครื่อง) — แต่ละรายการ = 1 เวอร์ชัน (PRAGMA user_version)
 * เพิ่มเวอร์ชันใหม่ต่อท้ายเท่านั้น ห้ามแก้ของเดิม (ฐานข้อมูลที่ใช้งานอยู่รันเวอร์ชันเก่าไปแล้ว)
 * ถ้าเพิ่มตาราง/คอลัมน์ ต้องเพิ่มใน schema-postgres.js ให้ตรงกันด้วย
 */
const MIGRATIONS = [
  // v1 — โครงสร้างหลักทั้งหมด
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    daily_limit INTEGER,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    last_login_ip TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX ix_sessions_user ON sessions(user_id);

  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    webhook_url TEXT,
    webhook_secret TEXT NOT NULL,
    ip_allowlist TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    last_used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE networks (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    topup_enabled INTEGER NOT NULL DEFAULT 1,
    package_enabled INTEGER NOT NULL DEFAULT 1,
    notice TEXT,
    topup_min INTEGER NOT NULL,
    topup_max INTEGER NOT NULL,
    topup_presets TEXT NOT NULL,
    topup_allow_custom INTEGER NOT NULL DEFAULT 1,
    customer_discount_bp INTEGER NOT NULL DEFAULT 0,
    provider_discount_bp INTEGER NOT NULL DEFAULT 0,
    package_provider_discount_bp INTEGER NOT NULL DEFAULT 0,
    provider_topup_code TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    network_code TEXT NOT NULL REFERENCES networks(code),
    provider_code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'เน็ต',
    data_label TEXT,
    validity_days INTEGER,
    price INTEGER NOT NULL CHECK (price > 0),
    cost INTEGER NOT NULL CHECK (cost >= 0),
    enabled INTEGER NOT NULL DEFAULT 1,
    is_demo INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (network_code, provider_code)
  );

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','bulk','api')),
    batch_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('topup','package')),
    network_code TEXT NOT NULL,
    product_id INTEGER,
    product_code TEXT,
    product_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    face_value INTEGER NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    cost INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','processing','success','failed','refunded')),
    provider TEXT NOT NULL,
    provider_txn_id TEXT,
    provider_status TEXT,
    provider_message TEXT,
    idempotency_key TEXT,
    callback_url TEXT,
    api_key_id INTEGER,
    check_attempts INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    review_reason TEXT,
    ip TEXT,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ux_orders_idem ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX ix_orders_user ON orders(user_id, id DESC);
  CREATE INDEX ix_orders_status ON orders(status, next_check_at);
  CREATE INDEX ix_orders_phone ON orders(phone, created_at);
  CREATE INDEX ix_orders_created ON orders(created_at);
  CREATE INDEX ix_orders_review ON orders(needs_review) WHERE needs_review = 1;

  CREATE TABLE order_events (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_events_order ON order_events(order_id, id);

  CREATE TABLE wallet_ledger (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('deposit','order','refund','reversal','adjust')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    actor_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_ledger_user ON wallet_ledger(user_id, id DESC);
  -- กันคืนเงิน/ตัดเงิน/เติมเครดิตซ้ำสำหรับรายการเดียวกัน
  CREATE UNIQUE INDEX ux_ledger_once ON wallet_ledger(type, ref_type, ref_id) WHERE type IN ('deposit','order','refund','reversal');

  CREATE TABLE deposits (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT 'promptpay',
    slip_file TEXT,
    transfer_at TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    credited_amount INTEGER,
    admin_note TEXT,
    reviewed_by INTEGER,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX ix_deposits_user ON deposits(user_id, id DESC);
  CREATE INDEX ix_deposits_status ON deposits(status);

  CREATE TABLE phonebook (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    network_code TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, phone)
  );

  CREATE TABLE provider_logs (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    action TEXT NOT NULL,
    order_ref TEXT,
    method TEXT,
    url TEXT,
    request TEXT,
    http_status INTEGER,
    response TEXT,
    outcome TEXT,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_plogs_ref ON provider_logs(order_ref);
  CREATE INDEX ix_plogs_created ON provider_logs(created_at);

  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    api_key_id INTEGER,
    url TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_http_status INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX ix_webhooks_due ON webhook_deliveries(status, next_attempt_at);

  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_audit_created ON audit_logs(created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE mock_txns (
    ref TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL,
    final_status TEXT NOT NULL,
    message TEXT,
    finalize_at TEXT NOT NULL,
    callback_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  `,
  // v2 — กันสลิปซ้ำ, ยืนยันตัวตน 2 ชั้น, รหัสอ้างอิงแยกตาม API key, คืนเงิน/ดึงคืนหลายรอบโดยแอดมิน, กันกดปรับยอดซ้ำ
  `
  DROP INDEX ux_orders_idem;
  CREATE UNIQUE INDEX ux_orders_idem ON orders(user_id, COALESCE(api_key_id, 0), idempotency_key) WHERE idempotency_key IS NOT NULL;

  ALTER TABLE wallet_ledger ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE wallet_ledger ADD COLUMN request_id TEXT;
  DROP INDEX ux_ledger_once;
  CREATE UNIQUE INDEX ux_ledger_once ON wallet_ledger(type, ref_type, ref_id, seq) WHERE type IN ('deposit','order','refund','reversal');
  CREATE UNIQUE INDEX ux_ledger_request ON wallet_ledger(request_id) WHERE request_id IS NOT NULL;

  ALTER TABLE deposits ADD COLUMN slip_hash TEXT;
  ALTER TABLE deposits ADD COLUMN slip_dup_of INTEGER;
  CREATE INDEX ix_deposits_slip_hash ON deposits(slip_hash) WHERE slip_hash IS NOT NULL;

  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  `,
  // v3 — ผู้ให้บริการหลายเจ้า + สลับอัตโนมัติ
  //   order_attempts   : ทุกครั้งที่ส่งรายการไปผู้ให้บริการ (ใช้พิสูจน์ว่าเจ้าไหนเคยได้รับรายการ — กันส่งซ้ำ 2 เจ้า)
  //   provider_catalog : รายการบริการที่ดึงมาจากผู้ให้บริการที่ใช้รหัสบริการของตัวเอง (เช่น HubZell)
  //   provider_map     : จับคู่ ยอดเติม/แพ็กเกจ ของเรา กับรหัสบริการของผู้ให้บริการ (แอดมินยืนยันก่อนเปิดใช้)
  `
  CREATE TABLE order_attempts (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    provider TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    code TEXT,
    cost INTEGER,
    state TEXT NOT NULL CHECK (state IN ('sending','accepted','rejected','unknown','success','failed')),
    provider_status TEXT,
    provider_txn_id TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (order_id, attempt_no)
  );
  CREATE INDEX ix_attempts_provider ON order_attempts(provider, order_id);

  ALTER TABLE orders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  INSERT INTO order_attempts (order_id, provider, attempt_no, code, cost, state, provider_status, provider_txn_id, message, created_at, updated_at)
    SELECT id, provider, 1, product_code, cost,
           CASE status WHEN 'success' THEN 'success' WHEN 'refunded' THEN 'success' WHEN 'failed' THEN 'failed' ELSE 'unknown' END,
           provider_status, provider_txn_id, provider_message, COALESCE(submitted_at, created_at), updated_at
    FROM orders WHERE submitted_at IS NOT NULL;
  UPDATE orders SET attempts = 1 WHERE submitted_at IS NOT NULL;

  CREATE TABLE provider_catalog (
    provider TEXT NOT NULL,
    service_id TEXT NOT NULL,
    product_code TEXT,
    product_name TEXT,
    service_name TEXT,
    category TEXT,
    currency TEXT,
    price INTEGER,
    input_field TEXT,
    input_pattern TEXT,
    phone_format TEXT,
    inputs_json TEXT,
    supported INTEGER NOT NULL DEFAULT 1,
    unsupported_reason TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (provider, service_id)
  );

  CREATE TABLE provider_map (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('topup','package')),
    network_code TEXT NOT NULL,
    face_value INTEGER,
    product_id INTEGER,
    service_id TEXT NOT NULL,
    input_field TEXT NOT NULL,
    input_pattern TEXT,
    phone_format TEXT NOT NULL DEFAULT 'local',
    cost INTEGER NOT NULL CHECK (cost >= 0),
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ux_pmap_topup ON provider_map(provider, network_code, face_value) WHERE kind = 'topup';
  CREATE UNIQUE INDEX ux_pmap_package ON provider_map(provider, product_id) WHERE kind = 'package';

  -- origin = ผู้ให้บริการที่รหัส provider_code ของสินค้านี้เป็นของ (primary = WonDD/โหมดทดสอบ)
  ALTER TABLE products ADD COLUMN origin TEXT NOT NULL DEFAULT 'primary';
  `,
  // v4 — ร้าน: ลูกค้าเลือกร้านเองได้ + แต่ละร้านตั้งราคา (ส่วนลด) ของตัวเองได้
  //   shops         : ชื่อร้านที่แสดงให้ลูกค้าเห็น
  //   shop_networks : ส่วนลดลูกค้าของแต่ละร้าน แยกตามเครือข่าย (ไม่มีแถว = ใช้ส่วนลดมาตรฐานของเครือข่าย)
  //   orders.shop   : ร้านที่ลูกค้าเลือก (NULL = ให้ระบบเลือก) — ร้านที่ทำรายการจริงอยู่ใน orders.provider
  `
  CREATE TABLE shops (
    provider TEXT PRIMARY KEY,
    display_name TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE shop_networks (
    provider TEXT NOT NULL,
    network_code TEXT NOT NULL,
    customer_discount_bp INTEGER NOT NULL CHECK (customer_discount_bp >= 0 AND customer_discount_bp <= 10000),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider, network_code)
  );
  ALTER TABLE orders ADD COLUMN shop TEXT;
  `,
  // v5 — กันผลขัดแย้งระหว่างผู้ให้บริการ
  //   orders.review_sticky       : ธง "ต้องตรวจสอบ" ที่ผลจากผู้ให้บริการล้างเองไม่ได้ (เช่น อาจเติมซ้ำ 2 เจ้า) — เจ้าหน้าที่ล้างได้เท่านั้น
  //   order_attempts.resends     : จำนวนครั้งที่ส่งซ้ำด้วยเลขอ้างอิงเดิม (หาผลรายการที่ไม่รู้ว่าผู้ให้บริการได้รับไหม)
  //   order_attempts.not_found   : จำนวนครั้งติดกันที่ค้นแล้ว "ไม่พบรายการ" (ครบกำหนด = หยุดเช็ก ส่งให้เจ้าหน้าที่)
  `
  ALTER TABLE orders ADD COLUMN review_sticky INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE order_attempts ADD COLUMN resends INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE order_attempts ADD COLUMN not_found INTEGER NOT NULL DEFAULT 0;
  `,
  // v6 — สลิปเติมเงินทุกใบที่เคยแนบ (เปลี่ยนสลิปแล้วใบเดิมยังถูกตรวจซ้ำได้) + รายการที่หมดเวลาอัตโนมัติ
  `
  CREATE TABLE deposit_slips (
    id INTEGER PRIMARY KEY,
    deposit_id INTEGER NOT NULL REFERENCES deposits(id),
    hash TEXT NOT NULL,
    file TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_deposit_slips_hash ON deposit_slips(hash);
  CREATE INDEX ix_deposit_slips_deposit ON deposit_slips(deposit_id);
  INSERT INTO deposit_slips (deposit_id, hash, file, created_at)
    SELECT id, slip_hash, slip_file, updated_at FROM deposits WHERE slip_hash IS NOT NULL;
  ALTER TABLE deposits ADD COLUMN expired_at TEXT;
  UPDATE deposits SET expired_at = updated_at WHERE status = 'cancelled' AND admin_note LIKE 'หมดเวลา%';
  `,
];

module.exports = { MIGRATIONS };
