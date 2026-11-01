# API สำหรับเชื่อมต่อเว็บไซต์ร้านค้า (v1)

ใช้เมื่อคุณมีเว็บไซต์อื่นอยู่แล้ว (เช่น WordPress, Laravel, เว็บ PHP) และต้องการสั่งเติมเงิน/แพ็กเกจผ่านระบบนี้แบบ **server-to-server**
ระบบนี้จะจัดการ WonDD, การกันเติมซ้ำ, การคืนเงิน และแจ้งผลกลับให้เว็บของคุณผ่าน webhook

- **Base URL:** `https://<โดเมนของระบบนี้>/api/v1`
- **ยืนยันตัวตน:** header `Authorization: Bearer tk_xxxxxxxxxxxxxxxx` (สร้างได้ที่หน้าแอดมิน → API ร้านค้า)
- **เงิน:** ตัดจากกระเป๋าเงินของบัญชีที่ผูกกับ API key — หน่วยเป็น **บาท** (ทศนิยม 2 ตำแหน่ง)
- **ห้ามใช้ API key ในหน้าเว็บฝั่งผู้ใช้ (JavaScript ในเบราว์เซอร์)** ให้เรียกจากเซิร์ฟเวอร์เท่านั้น
- จำกัด IP ที่ใช้ key ได้ (แนะนำ) ที่หน้าแอดมิน — ใส่ได้ทั้ง IP เดี่ยว และช่วงแบบ CIDR เช่น `203.0.113.0/24` (คั่นด้วย `,`)
- ส่งข้อมูลเป็น **JSON** เท่านั้น (`Content-Type: application/json`)

## รูปแบบคำตอบ

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "INSUFFICIENT_BALANCE", "message": "ยอดเงินในกระเป๋าไม่พอ ...", "details": { } } }
```

| HTTP | code | ความหมาย |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_PHONE`, `AMOUNT_OUT_OF_RANGE`, `PRODUCT_DISABLED` | ข้อมูลไม่ถูกต้อง (ยังไม่ตัดเงิน) |
| 401 | `UNAUTHORIZED` | API key ไม่ถูกต้อง |
| 402 | `INSUFFICIENT_BALANCE` | เงินในกระเป๋าไม่พอ |
| 403 | `FORBIDDEN`, `DAILY_LIMIT` | IP ไม่ได้รับอนุญาต / เกินวงเงินต่อวัน |
| 404 | `NOT_FOUND`, `PRODUCT_NOT_FOUND` | ไม่พบรายการ/สินค้า |
| 409 | `DUPLICATE_RECENT`, `IDEMPOTENCY_MISMATCH`, `PRICE_CHANGED` | เบอร์+ยอดเดียวกันเพิ่งทำไป **หรือรายการเดิมของเบอร์+ยอดนี้ยังรอผลอยู่** (`details.waiting = true` — ทำซ้ำตอนนี้อาจได้ 2 ครั้ง) / reference ถูกใช้กับข้อมูลอื่น / ราคาไม่ตรง `expected_price` (ยังไม่ตัดเงิน) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | ส่งข้อมูลที่ไม่ใช่ JSON — ต้องใส่ `Content-Type: application/json` |
| 429 | `RATE_LIMITED` | ส่งถี่เกินไป — รอตามวินาทีใน header `Retry-After` แล้วส่งใหม่ (ใช้ reference เดิม) |
| 400 | `SHOP_UNAVAILABLE`, `AMOUNT_NOT_AT_SHOP`, `PRODUCT_NOT_AT_SHOP` | ร้านที่เลือกปิดอยู่ / ร้านนี้ไม่มียอดหรือแพ็กเกจนี้ (ยังไม่ตัดเงิน) |
| 503 | `MAINTENANCE`, `NETWORK_CLOSED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_READY`, `NO_PROVIDER` | ปิดชั่วคราว / ยังไม่มีร้านไหนทำรายการนี้ได้ (ยังไม่ตัดเงิน) ลองใหม่ภายหลัง |

---

## GET /balance

```bash
curl https://topup.example.com/api/v1/balance -H "Authorization: Bearer tk_xxx"
```
```json
{ "ok": true, "data": { "balance": 1250.5, "currency": "THB" } }
```

## GET /products

คืนเครือข่าย (ยอดเติมขั้นต่ำ/สูงสุด) และแพ็กเกจที่เปิดขาย

```json
{ "ok": true, "data": {
  "networks": [ { "code": "AIS", "name": "AIS One-2-Call!", "topup": { "available": true, "min": 10, "max": 1000, "presets": [10,20,50,100], "allow_custom": true, "discount_percent": 0 }, "package": { "available": true }, "notice": null } ],
  "packages": [ { "code": "AIS-NET15G30D", "network": "AIS", "name": "เน็ต 15GB 30 วัน", "category": "รายเดือน", "data": "15GB", "validity_days": 30, "price": 199 } ],
  "shops": [ { "code": "hubzell", "name": "HubZell", "available": true,
               "topup": { "AIS": { "discount_percent": 2, "amounts": [20, 50, 100], "allow_custom": false } },
               "package_codes": ["HUBZELL:HZ_AIS_NET_3GB"] } ]
} }
```

- ราคาเติมเงินที่ร้าน S = ยอด − ส่วนลดของร้าน S (`discount_percent`) ปัดเศษส่วนลดลง
- `amounts` = ร้านนี้ขายได้เฉพาะยอดเหล่านี้ (`null` = ได้ทุกยอดตาม `networks[].topup`)

## POST /orders — สั่งเติมเงิน / สมัครแพ็กเกจ

| ฟิลด์ | จำเป็น | คำอธิบาย |
|---|---|---|
| `reference` | ✔ | เลขอ้างอิงฝั่งร้าน **ห้ามซ้ำ** (8-100 ตัว A-Z a-z 0-9 _ - : .) เช่น เลขที่คำสั่งซื้อ |
| `type` | ✔ | `topup` หรือ `package` (ตัวพิมพ์ใหญ่/เล็กก็ได้) |
| `network` | ✔ (topup) | `AIS`, `TRUE`, `DTAC` |
| `phone` | ✔ | เบอร์ปลายทาง 10 หลัก (รับ `081-234-5678`, `+66812345678`, `66812345678` ได้) |
| `amount` | ✔ (topup) | ยอดเติม (บาท จำนวนเต็ม) |
| `product_code` | ✔ (package) | รหัสแพ็กเกจจาก `/products` (ส่ง `network` มาด้วย) |
| `callback_url` | | URL รับผล (ถ้าไม่ส่ง ใช้ webhook ที่ตั้งไว้กับ API key) — ต้องเป็น http(s) **ที่อยู่สาธารณะ** พอร์ต 80, 443 หรือ 1024 ขึ้นไป (ห้าม localhost / IP ภายใน) |
| `allow_duplicate` | | `true` = อนุญาตเบอร์+ยอดเดียวกันในเวลาใกล้กัน / ขณะรายการเดิมยังรอผล (ใช้เมื่อตั้งใจเติมซ้ำจริงเท่านั้น) |
| `expected_price` | แนะนำ | ราคาที่ร้านคาดว่าจะถูกตัด (บาท) — ถ้าราคาในระบบเปลี่ยนไป จะได้ `409 PRICE_CHANGED` และ **ไม่ตัดเงิน** |
| `shop` | | รหัสร้านที่ต้องการ (จาก `shops[].code` ใน `/products`) — ราคาเป็นของร้านนั้น ไม่ส่ง หรือ `auto` = ให้ระบบเลือกร้านให้ (ราคามาตรฐาน) ถ้าร้านที่เลือกไม่รับรายการ ระบบส่งต่อร้านอื่นในราคาเดิมอัตโนมัติ |

```bash
curl -X POST https://topup.example.com/api/v1/orders \
  -H "Authorization: Bearer tk_xxx" -H "Content-Type: application/json" \
  -d '{"reference":"INV-2026-000123","type":"topup","network":"AIS","phone":"0812345678","amount":100}'
```
```json
{ "ok": true, "data": { "existing": false, "order": {
  "ref": "TP261101K7Q2M9XD", "reference": "INV-2026-000123", "type": "topup", "network": "AIS",
  "product_code": null, "product_name": "เติมเงิน AIS 100 บาท", "phone": "0812345678",
  "amount": 100, "price": 100, "status": "pending", "status_label": "รอดำเนินการ", "final": false,
  "message": null, "created_at": "2026-11-01T14:00:00.000Z", "completed_at": null,
  "updated_at": "2026-11-01T14:00:00.000Z", "version": 1832 } } }
```

### ⚠️ กันเติมซ้ำ: กฎสำคัญที่สุด

- ส่ง `reference` เดิมซ้ำกี่ครั้งก็ได้ → ได้รายการเดิมกลับมา (`existing: true`) **ไม่ตัดเงินซ้ำ ไม่เติมซ้ำ** (แม้ระบบกำลังปิดปรับปรุงอยู่ก็ตอบรายการเดิมได้)
- ถ้าเรียกแล้ว **timeout / เน็ตหลุด** ให้ส่งซ้ำด้วย **reference เดิม** หรือเช็กด้วย `GET /orders?reference=...` — **ห้ามสร้าง reference ใหม่** สำหรับคำสั่งซื้อเดิม
- `reference` แยกกันตาม **API key** — ถ้ามีหลายเว็บ (หลาย key) ในบัญชีเดียว แต่ละเว็บใช้เลขชุดของตัวเองได้โดยไม่ชนกัน
- จำกัดความถี่ตามค่า "จำนวนรายการสูงสุดต่อนาที ผ่าน API ร้านค้า" ในหน้าตั้งค่า (เกิน = `429`, ยังไม่ตัดเงิน)
- `message` ของรายการเป็นข้อความสำหรับแสดงลูกค้า (เช่น "เติมเงินสำเร็จ", "หมายเลขปลายทางไม่ถูกต้อง") — ระหว่างรอผลเป็น `null`; ระบบไม่ส่งรายละเอียดภายในของผู้ให้บริการออกไป

### สถานะ

| status | final | ความหมาย |
|---|---|---|
| `pending` | false | รับรายการแล้ว รอส่ง |
| `processing` | false | ส่งไปผู้ให้บริการแล้ว รอผล (อาจใช้เวลาหลายนาทีในกรณีระบบปลายทางช้า) |
| `success` | true | สำเร็จ |
| `failed` | true | ไม่สำเร็จ — **คืนเงินเข้ากระเป๋าแล้ว** |
| `refunded` | true | เคยสำเร็จ แต่ถูกยกเลิก/คืนเงินภายหลัง |

## GET /orders/:ref และ GET /orders?reference=...

```bash
curl "https://topup.example.com/api/v1/orders?reference=INV-2026-000123" -H "Authorization: Bearer tk_xxx"
```

---

## Webhook (แจ้งผลอัตโนมัติ)

เมื่อรายการได้ผลสุดท้าย ระบบจะ `POST` JSON ไปที่ `callback_url` (หรือ webhook ของ API key)

```http
POST /your-webhook HTTP/1.1
Content-Type: application/json
X-Webhook-Event: order.updated
X-Webhook-Id: 42
X-Webhook-Timestamp: 1793541600
X-Webhook-Signature: sha256=5f2b...

{"event":"order.updated","sent_at":"...","data":{ ...รูปแบบเดียวกับ order ด้านบน... }}
```

- ตอบ HTTP 2xx ภายใน 10 วินาที = รับสำเร็จ (ระบบไม่ตาม redirect — ตอบ 3xx ถือว่าไม่สำเร็จ)
- ถ้าไม่สำเร็จจะส่งซ้ำ: 30 วิ, 2 นาที, 10 นาที, 30 นาที, 2 ชม., 6 ชม. — **เว็บของคุณต้องรับข้อมูลซ้ำได้** (ใช้ `reference` เช็กว่าเคยอัปเดตแล้วหรือยัง)
- ทุกครั้งที่ส่ง (รวมถึงการส่งซ้ำ) ข้อมูลคือ **สถานะล่าสุด ณ ตอนส่ง** และมี `data.version` (ตัวเลขที่เพิ่มขึ้นทุกครั้งที่รายการเปลี่ยน) กับ `data.updated_at`
  → **ให้อัปเดตเฉพาะเมื่อ `version` มากกว่าที่เคยบันทึกไว้** (webhook อาจมาถึงไม่เรียงลำดับ)
- **ต้องตรวจลายเซ็นทุกครั้ง:** `sha256=` + HMAC-SHA256(webhook_secret, `timestamp + "." + body ดิบ`) และปฏิเสธถ้า timestamp เก่ากว่า 5 นาที
- URL รับ webhook ต้องเป็นที่อยู่สาธารณะบนอินเทอร์เน็ต (ระบบไม่ส่งไป localhost / IP ภายใน)

### ตัวอย่างตรวจลายเซ็น — PHP

```php
<?php
$secret = 'whsec_xxx'; // ได้ตอนสร้าง API key
$body = file_get_contents('php://input');
$ts   = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$sig  = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $body, $secret);
if (!hash_equals($expected, $sig) || abs(time() - (int)$ts) > 300) {
    http_response_code(401); exit('bad signature');
}
$event = json_decode($body, true);
$order = $event['data'];
// อัปเดตเฉพาะเมื่อ version ใหม่กว่าที่บันทึกไว้ (webhook อาจมาไม่เรียงลำดับ)
// เช่น UPDATE orders SET status = ?, topup_version = ? WHERE id = ? AND topup_version < ?
// แล้วใช้ $order['reference'], $order['status'], $order['version']
http_response_code(200);
echo 'ok';
```

### ตัวอย่างตรวจลายเซ็น — Node.js (Express)

```js
const crypto = require('crypto');
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-Webhook-Timestamp');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${ts}.${req.body}`).digest('hex');
  const given = req.get('X-Webhook-Signature') || '';
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).end();
  const { data: order } = JSON.parse(req.body);
  // อัปเดตคำสั่งซื้อด้วย order.reference / order.status เฉพาะเมื่อ order.version > version ที่บันทึกไว้
  res.send('ok');
});
```

### ตัวอย่างสั่งเติมเงิน — PHP

```php
<?php
function topupApi($method, $path, $data = null) {
    $ch = curl_init('https://topup.example.com/api/v1' . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . getenv('TOPUP_API_KEY'), 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => $data ? json_encode($data) : null,
    ]);
    $res = curl_exec($ch);
    if ($res === false) { // timeout / เน็ตหลุด → อย่าสร้าง reference ใหม่ ให้เช็กด้วย reference เดิม
        return null;
    }
    return json_decode($res, true);
}

$r = topupApi('POST', '/orders', [
    'reference' => 'INV-' . $orderId,
    'type' => 'topup', 'network' => 'TRUE', 'phone' => '0891234567', 'amount' => 50,
    'expected_price' => 48.38, // ราคาที่แสดงให้ลูกค้าของคุณ — ถ้าไม่ตรง ระบบไม่ตัดเงิน
]);
if ($r === null) {
    $r = topupApi('GET', '/orders?reference=INV-' . $orderId);
}
```
