'use strict';
// สถานะผู้ให้บริการทุกเจ้า: เครดิตคงเหลือ, การตั้งค่า, การพักชั่วคราว (circuit breaker), ลำดับการเลือก — แสดงในหน้าแอดมิน
const db = require('../db');
const providers = require('../providers');
const settings = require('./settings');
const breaker = require('./breaker');
const { alertAdmin, channels } = require('../lib/notify');
const { fmt } = require('../lib/money');

const balanceKey = (name) => `_provider_balance_${name}`;

/** เช็กเครดิตเจ้าเดียว หรือทุกเจ้า (ไม่ระบุชื่อ) */
async function refreshBalance(name) {
  const names = name ? [name] : providers.configured();
  const out = {};
  for (const n of names) {
    const p = providers.byName(n);
    if (!p || !p.capabilities.balance) continue;
    let r;
    try {
      r = await p.getBalance();
    } catch (e) {
      r = { ok: false, message: e.message };
    }
    // ปัญหาบัญชี/การตั้งค่าที่เจอตอนเช็กเครดิต (เช่น key ผิด, IP ไม่อยู่ใน whitelist) → พักเจ้านั้นไว้ก่อน
    if (r.trip) breaker.record(n, { trip: r.trip, message: r.message });
    const prev = settings.getInternal(balanceKey(n), {}) || {};
    const state = r.ok
      ? { provider: n, balance: r.balance, checked_at: new Date().toISOString(), error: null }
      : { provider: n, balance: prev.balance ?? null, checked_at: new Date().toISOString(), error: r.message || 'เช็กเครดิตไม่สำเร็จ' };
    settings.setInternal(balanceKey(n), state);
    const threshold = settings.get('low_balance_baht') * 100;
    if (r.ok && threshold > 0 && r.balance < threshold) {
      alertAdmin(`low-balance-${n}`, `เครดิตที่ ${p.label} เหลือ ${fmt(r.balance)} บาท (ต่ำกว่า ${fmt(threshold)} บาท) กรุณาเติมเครดิต`, { cooldownSec: 3600 });
    }
    out[n] = state;
  }
  return name ? out[name] || null : out;
}

function providerInfo(name, ordered) {
  const p = providers.byName(name);
  const mapped = p.capabilities.catalog === 'mapped';
  return {
    name,
    label: p.label,
    live: name !== 'mock' && name !== 'mock2',
    enabled: ordered.includes(name),
    priority: ordered.indexOf(name),
    capabilities: p.capabilities,
    config: p.configStatus(),
    balance: settings.getInternal(balanceKey(name), null),
    breaker: breaker.snapshot(name),
    mappings: mapped ? db.get('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM provider_map WHERE provider = ?', name) : null,
  };
}

function snapshot() {
  const configured = providers.configured();
  const ordered = providers.ordered();
  const primary = providers.primary();
  const list = [...ordered, ...configured.filter((n) => !ordered.includes(n))].map((n) => providerInfo(n, ordered));
  const first = list.find((x) => x.name === primary.name) || list[0];
  return {
    // ข้อมูลของเจ้าหลัก (หน้าจอเดิมใช้)
    name: primary.name,
    label: primary.label,
    live: providers.isLive(),
    capabilities: primary.capabilities,
    config: primary.configStatus(),
    balance: first?.balance || null,
    breaker: breaker.snapshot(primary.name),
    notify: channels(),
    // ทุกเจ้า + การเลือกเจ้า
    providers: list,
    routing: { mode: settings.get('routing_mode'), failover: settings.get('failover_enabled'), order: ordered },
  };
}

module.exports = { refreshBalance, snapshot, balanceKey };
