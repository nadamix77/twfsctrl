# Tweetfess Controller

Panel kontrol multi-instance untuk [Tweetfess](docs/INSTANCE-API.md) — pantau, moderasi, dan kelola beberapa deployment menfess sekaligus dari satu dashboard.

Setiap instance Tweetfess adalah deployment mandiri (domain, database, akun X sendiri). Controller menghubungkan semuanya lewat API admin yang sudah ada di setiap instance — **tanpa perubahan apa pun di sisi instance** — dan tetap menjadi *orchestrator* tipis yang read-mostly: instance tetap menjadi sumber kebenaran untuk data mereka sendiri.

```
┌─────────────────────────────┐
│  Tweetfess Controller       │
│  Next.js 16 + Prisma        │
│  DB: registry + audit saja  │
└──────────────┬──────────────┘
               │ HTTPS server-side, Bearer admin token
   ┌───────────┼───────────┐
   ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│ twfs   │ │ menfess │ │ menfess │   ← setiap instance: /api/admin/*
│ .app   │ │ -b.com  │ │ -c.com  │      own DB / B2 / X / cron
└────────┘ └────────┘ └────────┘
```

## Fitur

- **Registry instance** — daftar/hapus instance, kredensial admin terenkripsi AES-256-GCM (write-only, tidak pernah dikembalikan API), tes koneksi sebelum simpan.
- **Overview fan-out** — kartu per instance: pending, status circuit breaker, kesehatan AI, pendapatan hari ini, badge kesehatan (`ok` / `auth-failed` / `locked-out` / `down` / `nonaktif`).
- **Antrean moderasi terpadu** — gabungan submission `pending` / `censored` / `post_failed` dari semua instance: Setujui, Tolak, Coba Lagi, Kembalikan Poin, Hapus — dengan pesan instance ditampilkan apa adanya.
- **Aksi cepat instance** — reset circuit breaker, clear cache, bulk requeue post_failed.
- **Log audit** — semua aksi mutasi tercatat (aksi, instance, outcome, IP); tanpa isi pesan (konten hanya ada di instance).
- **Keamanan** — login terbatas laju (5 percobaan / 15 menit → kunci 30 menit), token HMAC di cookie HttpOnly + paritas Bearer untuk curl, SSRF guard pada URL instance, CSP ketat.

## Stack

Next.js 16 (App Router) · TypeScript 5 · Tailwind CSS 4 + shadcn/ui · Prisma 6 + PostgreSQL (Supabase di produksi, embedded Postgres lokal) · tanpa cache eksternal (token cache in-memory)

## Mulai cepat

```bash
bun install
cp .env.example .env        # lalu isi nilainya (lihat docs/CONFIGURATION.md)
bun run db:push             # sinkronkan schema → database Postgres
bun run dev                 # http://localhost:3000 (butuh service Postgres — lihat SETUP.md)
```

Butuh 3 nilai sebelum login aktif: `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` (dua yang terakhir: `openssl rand -hex 32`).

Menambahkan instance pertama: buka dashboard → **Tambah Instance** → isi nama, URL (`https://…`), password admin instance → **Test Koneksi** → simpan. Detailnya di [docs/USAGE.md](docs/USAGE.md).

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [docs/README.md](docs/README.md) | Indeks dokumentasi |
| [docs/PRD-CONTROLLER.md](docs/PRD-CONTROLLER.md) | PRD produk (kebutuhan, arsitektur, keputusan) |
| [docs/SETUP.md](docs/SETUP.md) | Setup lokal langkah demi langkah |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Referensi variabel environment |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arsitektur & struktur kode |
| [docs/CONTROLLER-API.md](docs/CONTROLLER-API.md) | HTTP API milik controller |
| [docs/INSTANCE-API.md](docs/INSTANCE-API.md) | Kontrak API instance yang dikonsumsi |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Skema database controller |
| [docs/SECURITY.md](docs/SECURITY.md) | Model keamanan & ancaman |
| [docs/USAGE.md](docs/USAGE.md) | Panduan operator (sehari-hari) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment produksi |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Diagnosis masalah umum |
| [docs/adr/](docs/adr/) | Architecture Decision Records |

## Prasyarat instance

Instance harus menjalankan Tweetfess dengan API admin aktif (`/api/admin/login`, `/api/admin/session`, `/api/submissions`, …) dan autentikasi Bearer token — lihat [docs/INSTANCE-API.md](docs/INSTANCE-API.md) untuk kontrak lengkap yang dikonsumsi controller.
