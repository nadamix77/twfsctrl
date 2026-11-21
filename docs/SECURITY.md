# SECURITY — Model Keamanan Controller

Controller adalah, sesuai desain, **aset paling sensitif di fleet**: ia menyimpan kredensial admin yang berfungsi untuk setiap instance. Dokumen ini memetakan bagaimana risiko itu dibatasi — dan sisa risiko yang diterima.

## Lapisan pertahanan

### 1. Autentikasi operator

- Satu kredensial: `ADMIN_PASSWORD` (env, tanpa default — tanpa nilai, login nonaktif + petunjuk setup, route login `503`).
- Token sesi: HMAC-SHA256 (`SESSION_SECRET`) dengan expiry tertanam, TTL 7 hari, format `<hmac_hex>.<expiresAt_hex>` — pola [ADR-002](adr/002-hmac-admin-tokens.md), tanpa tabel sesi. Secret dan nama cookie (`controller_token`) sepenuhnya terpisah dari instance sehingga token instance dan controller tidak pernah saling tervalidasi.
- Cookie `HttpOnly` + `SameSite=Strict` — JavaScript tidak bisa membaca; request lintas situs tidak membawa.
- Paritas `Authorization: Bearer` untuk curl/integrasi (permukaan yang sama, kredensial yang sama).
- **Rate limit login:** 5 percobaan gagal / 15 menit / IP → kunci 30 menit (`429` + `Retry-After`). Percobaan gagal ter-audit.
- Logout berfungsi dengan token kadaluarsa (operator tidak pernah terkunci).

### 2. Kredensial instance

- Password admin instance diterima sekali (form add/edit), dienkripsi **AES-256-GCM** (`iv:authTag:ciphertext`, kunci `ENCRYPTION_KEY`), disimpan di `InstanceCredential.encryptedSecret`.
- **Write-only:** tidak pernah dikembalikan API mana pun, tidak dirender, tidak masuk log (NFR-S5). `hasCredential` adalah satu-satunya sinyal keberadaannya.
- Dekripsi hanya di server, per-request, hasilnya hanya hidup di memori sesaat.
- Controller menolak menyimpan kredensial tanpa kunci enkripsi valid — tidak ada fallback plaintext.
- Token admin instance hanya hidup di **cache in-memory proses** (tidak di DB, tidak di cookie, tidak di browser — NFR-S2).

### 3. Permukaan jaringan

- **Browser → controller saja.** Browser tidak pernah memanggil domain instance (tanpa CORS, tanpa token di klien); media instance di-proxy lewat `/api/controller/media/…`.
- **Guard SSRF (FR-B8):** URL instance wajib `https://`, tanpa IP privat/loopback/link-local (literal maupun hasil resolusi DNS), port 443 saja — kecuali `ALLOW_PRIVATE_TARGETS=true` (development saja).
- **Header keamanan (semua route, `next.config.ts`):** CSP ketat (`default-src 'self'`, `frame-ancestors 'none'`, `img-src 'self' data: blob: https:` — https: diperlukan karena avatar/media berasal dari domain instance yang didaftarkan operator), HSTS 2 tahun + preload, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` mematikan kamera/mikrofon/geolokasi/payment.
- `robots.ts` disallow-all; metadata `noindex` — panel privat, bukan permukaan publik.

### 4. Aplikasi

- Semua route `/api/controller/*` (kecuali login/logout/session/healthz) dibungkus `withControllerAuth()` → `401` JSON untuk panggilan tanpa kredensial.
- Validasi input di setiap mutasi (nama/URL unik, status enum, page/limit clamp) — `400` dengan pesan field Indonesia.
- Audit append-only via API; tidak ada endpoint yang menulis audit arbitrer.

## Model ancaman

| Ancaman | Vektor | Mitigasi |
|---|---|---|
| Brute force password controller | Spray ke `/api/controller/login` | Rate limit 5/15m → kunci 30m; audit `controller.login` gagal |
| Pencurian sesi (XSS) | Skrip di panel | CSP ketat; cookie HttpOnly (JS tak bisa membaca); SameSite=Strict |
| CSRF | Panggilan lintas situs dengan cookie operator | SameSite=Strict; tanpa `Origin`/`Referer` permintaan lintas situs tidak membawa cookie |
| Kebocoran database controller | Kredensial DB bocor | Kredensial instance AES-256-GCM at-rest; kunci tidak di DB; audit tanpa isi pesan & tanpa secret |
| SSRF via registry | `baseUrl` menunjuk internal jaringan | Guard SSRF FR-B8 (IP privat/loopback/port); override dev terpisah |
| Kebocoran token instance | Token keluar dari server | Hanya cache in-memory; tidak pernah di-log; `log.ts` tidak mencatat payload |
| Instance bernama jahat (payload di pesan error) | Teks instance dirender | React escaping default; teks instance dirender sebagai teks, bukan HTML |
| Kompromi total controller | Semua akses admin instance | Sisa risiko yang **diterima** (lihat bawah) |

## Sisa risiko yang diterima

> Controller memegang kredensial admin untuk semua instance. Kompromi penuh controller = kompromi semua instance. Ini **diterima** dengan imbalan efisiensi operasional; mitigasi di atas membatasi tetapi tidak menghilangkannya.

Pengikat risiko yang disarankan di deployment:

1. `ADMIN_PASSWORD` panjang, unik, generator-acak.
2. Lapisan tambahan di depan controller: Vercel Password Protection / IP allowlist / Cloudflare Access (Q4 PRD — rekomendasi: ya).
3. Rotasi `SESSION_SECRET` berkala (me-logout semua sesi).
4. Jangan pernah set `ALLOW_PRIVATE_TARGETS` di produksi.
5. Pantau `/api/healthz` + entry audit `controller.login` ber-outcome `error`.

## Privasi data

- Controller **tidak menyimpan** isi submission, data submitter, settings, atau PII end-user — hanya id, aksi, outcome, IP aktor di audit ([DATA-MODEL.md](DATA-MODEL.md)).
- Isi pesan menfess yang tampil di antrean adalah bacaan API langsung — tidak dipersist oleh controller; menutup tab menghapusnya.
- IP aktor di audit: internal (satu operator), retensi 90 hari.
