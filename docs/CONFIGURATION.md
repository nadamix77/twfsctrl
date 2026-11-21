# CONFIGURATION — Variabel Environment

Semua konfigurasi controller lewat environment variables. Tidak ada settings di database — controller sengaja tidak punya tabel settings ([PRD §6.2](PRD-CONTROLLER.md)).

Salin `.env.example` → `.env` untuk lokal. Di sandbox dev, preferensikan `.env.local` — dimuat SETELAH `.env` oleh `scripts/with-env.sh` (last-wins) sehingga tahan penimpaan `.env` oleh harness. Referensi lengkap:

## Variabel

### `ADMIN_PASSWORD` — wajib

Password login operator (satu-satunya kredensial; tidak ada username, tidak ada multi-user di v1).

- Tanpa nilai ini **dan** `SESSION_SECRET`: login dinonaktifkan — layar login menampilkan petunjuk setup, bukan crash. Route API login menjawab `503` dengan pesan konfigurasi.
- Kuat & unik per deployment: controller adalah aset paling sensitif di fleet (memegang akses admin semua instance — lihat [SECURITY.md](SECURITY.md)).
- Rotasi: ganti nilai lalu restart. Semua sesi (token ditandatangani dengan password sebagai input HMAC bersama session secret) otomatis tidak valid — semua browser harus login ulang.
- Klasifikasi: **rahasia kritis**.

### `SESSION_SECRET` — wajib

Kunci HMAC-SHA256 untuk token sesi controller (`HMAC(SESSION_SECRET, "tweetfess-controller:admin:v1:<expiresAt>")`, TTL 7 hari — [ADR-002](adr/002-hmac-admin-tokens.md)).

- Generate: `openssl rand -hex 32`
- Rotasi me-log-out semua sesi aktif.
- Klasifikasi: **rahasia kritis**.

### `ENCRYPTION_KEY` — wajib untuk mutasi registry

Kunci AES-256-GCM untuk enkripsi kredensial instance at-rest (`iv:authTag:ciphertext`).

- Wajib **64 karakter hex** (32 byte). `openssl rand -hex 32`
- Controller menolak menyimpan kredensial tanpa kunci valid (tidak ada fallback plaintext) — route create/edit instance error sampai kunci benar.
- **Rotasi menghapus akses:** kredensial lama tak bisa didekripsi. Rotasi = simpan ulang password tiap instance (edit instance, isi ulang password). Rencanakan rotasi bertahap bila perlu.
- Klasifikasi: **rahasia kritis**.

### `DATABASE_URL` — wajib (runtime)

Connection string PostgreSQL untuk **runtime** (Prisma Client di Next.js — `datasource.url`).

- Lokal: `postgresql://postgres:postgres@localhost:5432/controller` — dari service Postgres embedded (`mini-services/postgres-service`, lihat [SETUP.md](SETUP.md)); tanpa pooler.
- Produksi (Supabase): **transaction pooler** (port `6543`) + `?pgbouncer=true&connection_limit=1` untuk serverless/Vercel; direct connection untuk VPS/long-running. Detail: [DEPLOYMENT.md](DEPLOYMENT.md).
- **Jangan pernah** arahkan ke database sebuah instance — controller dan instance harus punya database terpisah.
- Catatan sandbox: harness bisa menyuntikkan `DATABASE_URL` basi (path SQLite lama) ke environment proses, **dan saat restart sesi menimpa `.env` + `.env.local`, menghapus `dev.log`, me-reset pgdata, dan mematikan semua proses** — itu mengalahkan `.env`. Semua skrip npm sudah dibungkus `scripts/with-env.sh` yang mensource `.env` → `.env.local` → `~/.config/tweetfess-controller/env` (last-wins, semantik override). File ketiga ada **di luar repo** sehingga selamat dari reset harness — taruh rahasia sandbox di sana. Bila menjalankan perintah prisma/next manual, lewat wrapper atau export dulu nilainya.
- Klasifikasi: **rahasia** (memuat kredensial DB di produksi).

### `DATABASE_URL_UNPOOLED` — wajib untuk operasi schema (CLI)

Connection string **direct/unpooled** untuk Prisma CLI — `datasource.directUrl`: `bun run db:push` dan `bun run db:studio` memakai ini, runtime Next.js **tidak** membacanya.

- Lokal: sama dengan `DATABASE_URL` (embedded Postgres, tanpa pooler).
- Produksi (Supabase): direct connection atau session pooler (port `5432`) — **jangan** transaction pooler (`6543`): advisory lock + prepared statement Prisma CLI tidak selamat dari transaction pooling.
- `prisma generate` tidak me-resolve variable ini (build CI/Vercel jalan tanpa DB) — hanya dibutuhkan saat menjalankan `db:push`/`studio`.
- Klasifikasi: **rahasia** (memuat kredensial DB di produksi).

### `ALLOW_PRIVATE_TARGETS` — opsional, default `false`

Override guard SSRF (FR-B8): bila `true`, URL instance ber-IP privat/loopback, plain `http://`, dan port non-443 diterima.

- **Hanya untuk development lokal** (instance localhost). Di produksi harus unset/`false` — jika tidak, orang yang bisa mengakses panel bisa mendaftarkan target internal jaringan Anda.
- Klasifikasi: konfigurasi.

## Matriks ringkas

| Variabel | Wajib | Default | Rotasi mengakibatkan | Klasifikasi |
|---|---|---|---|---|
| `ADMIN_PASSWORD` | ya | — | semua sesi logout | rahasia kritis |
| `SESSION_SECRET` | ya | — | semua sesi logout | rahasia kritis |
| `ENCRYPTION_KEY` | ya (mutasi) | — | kredensial instance harus diisi ulang | rahasia kritis |
| `DATABASE_URL` | ya | `postgresql://…localhost:5432/controller` | — | rahasia (prod) |
| `DATABASE_URL_UNPOOLED` | ya (CLI schema) | sama seperti `DATABASE_URL` | — | rahasia (prod) |
| `ALLOW_PRIVATE_TARGETS` | tidak | `false` | — | konfigurasi |

## Env lain yang dibaca kode

- `DEBUG_DB` (opsional) — set nilai apa pun untuk menambahkan log Prisma `warn` selain `error` (`src/lib/controller/db.ts`).

## Yang TIDAK dipakai controller

Controller hanya membaca lima variabel di atas (+ `DEBUG_DB`). Ia **tidak** membaca variabel aplikasi instance Tweetfess (`B2_*`, `OAUTH2_*`, `NEXTAUTH_URL`, `X_*`, `CRON_SECRET`, dsb.) — kredensial instance masuk lewat form **Tambah/Edit Instance** (tersimpan terenkripsi), bukan lewat environment.

> Catatan penamaan: `ADMIN_PASSWORD`/`DATABASE_URL` sengaja tanpa prefiks — controller adalah repo/deployment standalone (ADR-016), jadi nama-namanya tidak ambigu di dalam deployment ini.

## Pemuatan nilai

- Next.js memuat `.env` otomatis di development.
- Produksi: set variabel di platform (Vercel Project Settings → Environment Variables, dsb.) — jangan commit `.env`.
- Pembacaan selalu server-side (`src/lib/controller/config.ts`); tidak ada nilai yang diekspos ke browser.
