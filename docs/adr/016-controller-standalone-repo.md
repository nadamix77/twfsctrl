# ADR-016: Controller sebagai Repo & Deployment Terpisah

## Status

Accepted

## Konteks

Tweetfess Controller awalnya dikembangkan di dalam repo aplikasi instance Tweetfess (di bawah `src/app/api/controller/`, `src/lib/controller/`, `src/components/controller/`) sebagai cara tercepat mengirim MVP: satu repo, satu dev server, controller sementara dipasang di route `/` menggantikan halaman publik instance.

Dua produk dengan siklus hidup berbeda akhirnya berbagi satu codebase:

- **Instance**: aplikasi end-user penuh (OAuth X, pembayaran QRIS, posting pipeline, AI filter, media B2, admin dashboard sendiri) — berat, banyak dependensi native (nsfwjs/TensorFlow, sharp, AWS SDK), database besar.
- **Controller**: panel operator tipis (registry + antrean + audit) — read-mostly, dependensi minimal, database 3 tabel.

Konsekuensi tanpa pemisahan:

1. Setiap deploy controller ikut membawa ratusan file & dependensi instance yang tidak dipakai (bundle, permukaan audit dependensi, waktu install).
2. `prisma/schema.prisma` instance dan `prisma/controller.prisma` berdampingan — dua klien Prisma dalam satu proses, dua skrip generate, membingungkan.
3. Risiko konfigurasi: `.env` berisi secret instance dan controller sekaligus; satu kebocoran membunuh dua produk.
4. PRD controller (§6.1) memang mendesain controller sebagai aplikasi standalone — "own domain, own database" — yang tidak terwujud bila menumpang repo instance.
5. Instance dan controller idealnya tidak pernah co-deploy: controller memegang kredensial semua instance; instance ter-expose ke publik.

## Keputusan

Repo `/home/z/my-project` menjadi **hanya** Tweetfess Controller:

1. **Seluruh kode instance dihapus** — halaman publik & admin, API instance (`/api/admin/*`, `/api/submissions/*`, `/api/payments/*`, `/api/auth/*`, `/api/media/*`, dsb.), lib instance (x-api, payments, ai, image, posting, settings, …), komponen/instance tests, schema+migrasi instance, mini-service Postgres, seeder demo.
2. **Schema controller dipromosikan** menjadi `prisma/schema.prisma` (satu-satunya) — klien di `src/generated/controller-client`, env `DATABASE_URL`.
3. **Env dipisah total** — `.env` repo ini hanya berisi milik controller; tidak ada kredensial instance (`B2_*`/`OAUTH2_*`/`X_*`/`CRON_SECRET`) di sini. Kredensial instance masuk lewat form registry (terenkripsi), bukan environment. *(Addendum: prefiks `CONTROLLER_*` kemudian dihapus — `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `ALLOW_PRIVATE_TARGETS` — karena repo standalone membuat nama pendek tidak ambigu; lihat docs/CONFIGURATION.md.)*
4. **Yang dipertahankan dari instance** hanya lapisan shared yang benar-benar dipakai controller: util `lib/core` murni (api-response, format, utils, crypto, origin-guard, is-private-ip, time-constants, debug, bounded-map), komponen `ui/` (shadcn) + enam komponen `shared/`, hooks `use-toast`/`use-countdown`, login rate limiter, dan dua ADR yang relevan (002, 007) plus kontrak API instance sebagai `docs/INSTANCE-API.md`.
5. **Dokumentasi ditulis ulang** untuk controller (README, SETUP, CONFIGURATION, ARCHITECTURE, CONTROLLER-API, INSTANCE-API, DATA-MODEL, SECURITY, USAGE, DEPLOYMENT, TROUBLESHOOTING); seluruh dokumen instance dihapus dari repo ini (dokumen instance hidup di repo instance).

## Konsekuensi

- Positif: deploy controller ringan & terisolasi; permukaan secret minimal; satu schema Prisma; siklus rilis independen; sesuai desain PRD.
- Negatif: perubahan kontrak API admin instance (repo instance) kini harus disinkronkan manual ke `docs/INSTANCE-API.md` + parser toleran-drift di controller (NFR-X1 sudah menjadi bantalan).
- Diterima: data demo instance terdaftar di controller lama (menunjuk ke instance yang ikut terhapus) dibersihkan — registry mulai kosong; operator mendaftarkan ulang instance produksi.
- Diterima: nilai `.env` dev lama (password/secret/kunci lama) tidak dipindahkan — diganti nilai dev baru; kredensial instance lama tidak terbaca dengan kunci baru (moot: data demo dihapus).

## Addendum (perubahan pasca-split)

1. **Prefiks env dihapus** — `CONTROLLER_*` → `ADMIN_PASSWORD`/`SESSION_SECRET`/`ENCRYPTION_KEY`/`DATABASE_URL`/`ALLOW_PRIVATE_TARGETS`: repo standalone membuat nama pendek tidak ambigu.
2. **Database beralih ke PostgreSQL penuh** (Supabase di produksi). Service Postgres embedded lokal (`mini-services/postgres-service`) dibangun ulang sebagai dev-database — mengemudikan binary `initdb`/`pg_ctl` langsung, karena library umbrella `embedded-postgres` memaksa locale `en_US.UTF-8` yang tidak tersedia di container ini. Wrapper `scripts/with-env.sh` memastikan `.env` mengalahkan injeksi `DATABASE_URL` basi dari harness sandbox.
