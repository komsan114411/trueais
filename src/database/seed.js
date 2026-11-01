'use strict';
// ข้อมูลเริ่มต้น: เครือข่าย + แพ็กเกจตัวอย่าง (แพ็กเกจตัวอย่างใช้ได้เฉพาะโหมดทดสอบ)
// ใส่เฉพาะตอนฐานข้อมูลยังว่าง (ยังไม่มีเครือข่าย) — ใช้ได้ทั้ง SQLite และ PostgreSQL

function seed(db, now) {
  if (db.get('SELECT COUNT(*) AS c FROM networks').c > 0) return;
  const presets = JSON.stringify([10, 20, 50, 100, 150, 200, 300, 500, 1000]);
  // [code, name, full_name, color, sort, providerDiscountBp(เติมเงิน), packageDiscountBp, providerCode]
  // ส่วนลดตั้งต้นอ้างอิงหน้า "บริการ" ของ WonDD (สมาชิกทั่วไป): dtac 3.25%, AIS เงินคืน 1.20%, True 3.25% / โปรเสริม 5%
  const nets = [
    ['AIS', 'AIS', 'AIS One-2-Call!', '#5BA829', 1, 120, 120, 'AIS'],
    ['TRUE', 'True', 'TrueMove H', '#E4002B', 2, 325, 500, 'TRUEMOVE'],
    ['DTAC', 'dtac', 'dtac', '#0097D8', 3, 325, 325, 'DTAC'],
  ];
  for (const n of nets) {
    db.run(
      `INSERT INTO networks (code, name, full_name, color, sort, topup_min, topup_max, topup_presets,
         provider_discount_bp, package_provider_discount_bp, provider_topup_code, updated_at)
       VALUES (?, ?, ?, ?, ?, 1000, 100000, ?, ?, ?, ?, ?)`,
      n[0], n[1], n[2], n[3], n[4], presets, n[5], n[6], n[7], now,
    );
  }

  const demo = {
    AIS: [
      ['DEMO-AIS-D3G', 'เน็ต 3GB ใช้ได้ 1 วัน', 'รายวัน', '3GB', 1, 19],
      ['DEMO-AIS-W4M', 'เน็ตไม่อั้น 4Mbps 7 วัน', 'รายสัปดาห์', 'ไม่อั้น 4Mbps', 7, 150],
      ['DEMO-AIS-M15G', 'เน็ต 15GB ใช้ได้ 30 วัน', 'รายเดือน', '15GB', 30, 199],
      ['DEMO-AIS-C10G', 'โทรฟรีในเครือข่าย + เน็ต 10GB 30 วัน', 'โทร+เน็ต', '10GB', 30, 249],
    ],
    TRUE: [
      ['DEMO-TRUE-D2G', 'เน็ต 2GB ใช้ได้ 1 วัน', 'รายวัน', '2GB', 1, 15],
      ['DEMO-TRUE-W6M', 'เน็ตไม่อั้น 6Mbps 7 วัน', 'รายสัปดาห์', 'ไม่อั้น 6Mbps', 7, 189],
      ['DEMO-TRUE-M20G', 'เน็ต 20GB ใช้ได้ 30 วัน', 'รายเดือน', '20GB', 30, 229],
      ['DEMO-TRUE-C5G', 'โทรทุกเครือข่าย 100 นาที + เน็ต 5GB 30 วัน', 'โทร+เน็ต', '5GB', 30, 199],
    ],
    DTAC: [
      ['DEMO-DTAC-D3G', 'เน็ต 3GB ใช้ได้ 1 วัน', 'รายวัน', '3GB', 1, 20],
      ['DEMO-DTAC-W4M', 'เน็ตไม่อั้น 4Mbps 7 วัน', 'รายสัปดาห์', 'ไม่อั้น 4Mbps', 7, 159],
      ['DEMO-DTAC-M12G', 'เน็ต 12GB ใช้ได้ 30 วัน', 'รายเดือน', '12GB', 30, 189],
      ['DEMO-DTAC-C8G', 'โทรฟรีในเครือข่าย + เน็ต 8GB 30 วัน', 'โทร+เน็ต', '8GB', 30, 219],
    ],
  };
  for (const [code, items] of Object.entries(demo)) {
    const bp = nets.find((n) => n[0] === code)[6];
    items.forEach((p, i) => {
      const price = p[5] * 100;
      const cost = price - Math.floor((price * bp) / 10000);
      db.run(
        `INSERT INTO products (network_code, provider_code, name, category, data_label, validity_days,
           price, cost, is_demo, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        code, p[0], p[1], p[2], p[3], p[4], price, cost, i + 1, now, now,
      );
    });
  }
}

module.exports = { seed };
