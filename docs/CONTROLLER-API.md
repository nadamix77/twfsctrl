# CONTROLLER API — HTTP API milik Controller

Referensi lengkap endpoint yang diekspos controller sendiri. Sumber kebenaran bentuk data: `src/lib/controller/types.ts`. Kontrak sisi instance yang dikonsumsi: [INSTANCE-API.md](INSTANCE-API.md).

## Konvensi

- **Base path:** semua endpoint panel ada di bawah `/api/controller` (kecuali `/api/healthz`).
- **Auth:** cookie `controller_token` (HttpOnly, SameSite=Strict) **atau** header `Authorization: Bearer <token>` (paritas curl, ADR-002). Tanpa keduanya → `401 {"error":"Tidak terautentikasi"}`.
- **Body:** JSON (`Content-Type: application/json`) kecuali disebutkan lain.
- **Copy error:** Bahasa Indonesia, ditampilkan verbatim oleh UI.
- Semua respons `Cache-Control: no-store`.

## Ringkasan

| Endpoint | Method | Auth | Fungsi |
|---|---|---|---|
| `/api/healthz` | GET | tidak | Liveness + DB reachability |
| `/api/controller/login` | POST | tidak | Login operator |
| `/api/controller/logout` | POST | tidak* | Hapus cookie sesi |
| `/api/controller/session` | GET | tidak* | Cek sesi + versi |
| `/api/controller/overview` | GET | ya | Fan-out kartu instance |
| `/api/controller/instances` | GET / POST | ya | List / daftarkan instance |
| `/api/controller/instances/test` | POST | ya | Tes koneksi (tanpa menyimpan) |
| `/api/controller/instances/[id]` | GET / PATCH / DELETE | ya | Detail / edit / hapus |
| `/api/controller/instances/[id]/actions` | POST | ya | Aksi cepat instance |
| `/api/controller/queue` | GET | ya | Antrean moderasi gabungan |
| `/api/controller/queue/[instanceId]/[submissionId]/[action]` | POST | ya | Aksi moderasi satu baris |
| `/api/controller/media/[instanceId]/[submissionId]` | GET | ya | Proxy media instance |
| `/api/controller/audit` | GET | ya | Log audit |

\* logout harus bisa menghapus cookie meski token kadaluarsa; session adalah cek publik (hanya mengembalikan `authenticated` + jumlah instance + versi — tidak ada data sensitif).

---

## GET /api/healthz

Liveness untuk uptime monitoring (PRD O3). Tidak butuh auth; hanya menjawab `{ok, db}` — tanpa nama/angka apa pun.

```json
{ "ok": true, "db": true }
```

`db: false` = database tidak terjangkau (controller tetap `200` — panel hidup untuk diagnosis).

## POST /api/controller/login

Body: `{"password": "..."}`. Rate limit per IP: 5 percobaan gagal / 15 menit → kunci 30 menit.

| Respons | Arti |
|---|---|
| `200 {"success":true}` + `Set-Cookie: controller_token=…` | Berhasil |
| `400` | Body bukan JSON / `password` kosong |
| `401 {"error":"Password salah"}` | Kredensial salah (tercatat di audit) |
| `429` + `Retry-After` | Terkunci — coba lagi setelah N detik |
| `503 {"error":"Controller belum dikonfigurasi…"}` | `ADMIN_PASSWORD`/`SESSION_SECRET` belum diset |

## POST /api/controller/logout

Selalu `200 {"success":true}` + cookie dikosongkan — bekerja dengan token kadaluarsa (sesi operator tidak pernah terkunci di layar logout).

## GET /api/controller/session

```json
{
  "authenticated": true,
  "instanceCount": 2,
  "controllerVersion": "1.0.0",
  "configured": true
}
```

`configured: false` = env auth belum diset (UI menampilkan petunjuk setup, bukan form login).

## GET /api/controller/overview

Fan-out `GET {baseUrl}/api/admin/session` ke semua instance enabled (paralel, timeout 8 s/instance).

```json
{
  "instances": [
    {
      "instance": { "id": "…", "name": "twfs", "baseUrl": "https://twfs.app",
                     "handle": "@twfs", "colorTag": "#0F1419", "enabled": true,
                     "sortOrder": 0, "createdAt": "…", "updatedAt": "…",
                     "hasCredential": true },
      "health": "ok",
      "stats": {
        "pending": 4, "censored": 2, "posting": 0, "postFailed": 0,
        "rejected": 12, "posted": 300, "total": 318,
        "circuitBreaker": { "paused": false, "remainingMinutes": 0,
                            "failCount": 0, "threshold": 3, "halfOpen": false },
        "cookieConfigured": true,
        "aiEnabled": 1, "aiConfigured": 1,
        "revenueTodayIdr": 15000, "revenueMonthIdr": 420000,
        "submitters": 210, "postMethodSetting": "auto",
        "encryptionEnabled": true,
        "pendingPaymentsNow": 0, "paymentsNeedingReview": 0
      },
      "error": null, "retryAfterSec": null, "fetchedAt": "2026-11-21T01:00:00.000Z"
    }
  ],
  "aggregate": {
    "totalPending": 4, "instancesUp": 1, "instancesEnabled": 1,
    "instancesTotal": 1, "revenueTodayIdr": 15000, "submitters": 210
  },
  "fetchedAt": "2026-11-21T01:00:00.000Z"
}
```

- `health`: `"ok" | "auth-failed" | "locked-out" | "down"` (instance enabled) — `"disabled"` untuk instance nonaktif.
- `stats: null` + `health` bukan `ok` → kartu turun ke mode auth-only ("data tidak tersedia").
- `stats` memakai parsing toleran-drift: field hilang → `null` (NFR-X1).
- Instance `down` menampilkan data terakhir yang berhasil + timestamp.

## GET /api/controller/instances

`200 {"instances": [InstanceDto…]}` — diurutkan `sortOrder` lalu nama. `hasCredential` adalah satu-satunya sinyal kredensial (password tidak pernah keluar).

## POST /api/controller/instances

Body:

```json
{
  "name": "twfs",
  "baseUrl": "https://twfs.app",
  "adminPassword": "password-admin-instance",
  "handle": "@twfs",
  "colorTag": "#0F1419"
}
```

- `name` unik; `baseUrl` dinormalisasi (paksa `https://`, tanpa trailing slash/path) dan unik; guard SSRF menolak IP privat/loopback/port non-443 kecuali `ALLOW_PRIVATE_TARGETS=true`.
- `adminPassword` dienkripsi AES-256-GCM sebelum disimpan.

`201 {"instance": InstanceDto}` · `400` (validasi — pesan field Indonesia) · `409` (nama/URL sudah terdaftar) · `503` (kunci enkripsi tidak terkonfigurasi).

## POST /api/controller/instances/test

Tes koneksi **tanpa menyimpan apa pun** (FR-B2): controller melakukan login ke `{baseUrl}/api/admin/login` + `GET /api/admin/session`, melaporkan hasil apa adanya.

Body: `{"baseUrl": "https://twfs.app", "adminPassword": "…"}`

```json
{ "ok": true, "status": 200, "message": "Terhubung — 5 pending", "pending": 5 }
```

Gagal: `{ "ok": false, "status": 401, "message": "Password salah" }` — atau `status: 0` untuk kegagalan jaringan; `retryAfterSec` terisi saat terkunci (429).

## GET /api/controller/instances/[id]

`200 {"instance": InstanceDto}` · `404`.

## PATCH /api/controller/instances/[id]

Body (semua opsional): `name`, `handle`, `colorTag`, `enabled`, `sortOrder`, `adminPassword`.

- `adminPassword` kosong/diabaikan = pertahankan; terisi = ganti (re-enkripsi + buang token cache instance).
- `200 {"instance": InstanceDto}` · `400` · `404` · `409`.

## DELETE /api/controller/instances/[id]

Menghapus dari registry **saja** — tidak menyentuh apa pun di instance (FR-B4). Entri audit final dicatat (`instanceName` denormalized supaya riwayat tetap terbaca).

`200 {"success":true}` · `404`. (UI meminta konfirmasi ketik nama sebelum memanggil ini.)

## POST /api/controller/instances/[id]/actions

Body: `{"action": "requeue" | "breaker-reset" | "clear-cache"}` — aksi cepat (Epic E), dikonfirmasi di UI, ter-audit.

```json
{ "ok": true, "status": 200, "body": { "requeued": 3 }, "error": null }
```

`body` = JSON instance **verbatim** (toast menampilkan pesan instance apa adanya).

## GET /api/controller/queue

Query: `status` (`all|pending|censored|post_failed|rejected` — `all` hanya status reviewable; `rejected` adalah tab FR-D8 untuk refund manual), `page` (≥1), `limit` (1–50, default 50), `search` (string kosong/pendek diterima), `instances` (id koma-terpisah; kosong = semua instance enabled).

```json
{
  "sections": [
    {
      "instanceId": "…", "instanceName": "twfs", "instanceColor": "#0F1419",
      "health": "ok", "error": null, "retryAfterSec": null,
      "items": [
        {
          "instanceId": "…", "instanceName": "twfs", "instanceColor": "#0F1419",
          "id": "subm_…", "message": "isi menfess…", "status": "pending",
          "filterReasons": ["blocked_word:…"], "nsfwStatus": null,
          "hasImage": true, "imageUrl": "/api/controller/media/…/…",
          "tweetId": null, "postError": null, "paidPost": false,
          "createdAt": "2026-11-21T00:30:00.000Z",
          "submitter": { "username": "senja", "displayName": "Senja", "profileImage": "https://…" }
        }
      ],
      "page": 1, "hasMore": false, "total": 4,
      "lastFetchedAt": "2026-11-21T01:00:00.000Z"
    }
  ],
  "fetchedAt": "2026-11-21T01:00:00.000Z"
}
```

- `imageUrl` adalah **path proxy controller** (media instance auth-gated — browser tidak pernah memanggil instance langsung).
- Instance `down`/`auth-failed`/`locked-out` → `items: []` + `error` terisi; UI membekukan seksi dengan timestamp (FR-D11).

## POST /api/controller/queue/[instanceId]/[submissionId]/[action]

`action`: `approve | reject | retry | refund | delete` (FR-D4–D8). Tanpa body.

```json
{ "ok": true, "status": 200, "body": { "kind": "auto-posted", "tweetId": "176…", "submission": {…} }, "error": null }
```

- `body` = JSON instance **verbatim** — `kind` (`auto-posted`/`queued`+`deferReason`/`error`), `refund`, `submission` terbaru, dll. dirender oleh UI apa adanya.
- `409` = konflik CAS di instance (status berubah) — UI me-refresh baris, bukan diam-diam.
- `503` = circuit breaker aktif di instance (approve ditunda).
- Semua hasil ter-audit sebagai `submission.<action>`.

## GET /api/controller/media/[instanceId]/[submissionId]

Proxy gambar submission (auth-gated instance → stream bytes). Bukan JSON. `200 image/*` · `404` (instance/submission tidak ada) · `502 {"error":"Gambar tidak dapat dimuat."}` (instance gagal).

## GET /api/controller/audit

Query: `page` (≥1), `limit`, `instanceId`, `action` (filter persis).

```json
{
  "entries": [
    { "id": "…", "instanceId": "…", "instanceName": "twfs",
      "action": "submission.approve", "targetId": "subm_…",
      "outcome": "success", "detail": null,
      "actorIp": "203.0.113.10", "createdAt": "2026-11-21T00:35:00.000Z" }
  ],
  "total": 44, "page": 1, "limit": 20,
  "actions": ["controller.login", "instance.create", "submission.approve", "…"]
}
```

`actions` = daftar action unik untuk dropdown filter. Retensi 90 hari (bersih otomatis saat dibaca, FR-F3). Tidak ada isi submission — hanya id/aksi/outcome (FR-F2).

## Contoh sesi curl

```bash
# login → simpan cookie
curl -c jar.txt -X POST http://localhost:3000/api/controller/login \
  -H 'Content-Type: application/json' -d '{"password":"…"}'

# overview
curl -b jar.txt http://localhost:3000/api/controller/overview

# setujui sebuah submission
curl -b jar.txt -X POST \
  http://localhost:3000/api/controller/queue/<instanceId>/<submissionId>/approve

# atau tanpa cookie — Bearer paritas
TOKEN="… dari Set-Cookie login …"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/controller/queue?status=pending
```
