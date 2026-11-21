# DEPLOYMENT — Produksi

Controller adalah Next.js standar: deploy ke Vercel (rekomendasi — sama dengan instance), atau Node/VPS/Docker. Database: PostgreSQL.

## Checklist pra-deploy

- [ ] `ADMIN_PASSWORD` — panjang, acak, unik (generator password; bukan kata sandi yang dipakai di tempat lain)
- [ ] `SESSION_SECRET` — `openssl rand -hex 32`
- [ ] `ENCRYPTION_KEY` — `openssl rand -hex 32` (simpan cadangannya di password manager; rotasi = isi ulang password semua instance)
- [ ] `DATABASE_URL` — Postgres controller **sendiri** (mis. Supabase project terpisah) — jangan pernah se-DB dengan sebuah instance. Runtime memakai koneksi **pooled** (transaction pooler di serverless)
- [ ] `DATABASE_URL_UNPOOLED` — koneksi **direct/session-pooler** untuk operasi schema (`prisma db push` / studio, via Prisma `directUrl`) — tidak pernah lewat transaction pooler
- [ ] `ALLOW_PRIVATE_TARGETS` — **tidak diset** (guard SSRF aktif)
- [ ] Semua instance terdaftar via `https://` dan dapat dijangkau dari jaringan deployment

## 1. Database (Supabase PostgreSQL)

Buat **project Supabase khusus controller** (jangan satu project dengan instance apa pun — lihat [ADR-016](adr/016-controller-standalone-repo.md)):

1. Supabase → New project, pilih region terdekat operator (mis. `ap-southeast-1` untuk Indonesia).
2. Ambil **dua** connection string dari **Project Settings → Database → Connection string** — runtime dan operasi schema dipisah (pola Prisma `url` + `directUrl`):
   - **`DATABASE_URL` (runtime — Prisma Client di Next.js):**
     - **Serverless (Vercel):** **Transaction pooler** (port `6543`) + `?pgbouncer=true&connection_limit=1`. Function serverless hidup singkat dan banyak; transaction pooling multiplex per-transaksi sehingga koneksi tidak meledak. `pgbouncer=true` mematikan prepared statement (wajib untuk mode transaction).
     - **VPS / long-running:** direct connection (port `5432`) tanpa parameter pooler — satu proses Node memegang pool kecil secara persisten.
   - **`DATABASE_URL_UNPOOLED` (operasi schema — `prisma db push` / `studio`):** direct connection (atau **Session pooler**, port `5432`). Advisory lock dan prepared statement yang dipakai Prisma CLI tidak selamat dari transaction pooling — jangan pernah arahkan directUrl ke port `6543`.
3. Set keduanya di environment deployment (`DATABASE_URL_UNPOOLED` hanya dibaca Prisma CLI — runtime Next.js tidak memakainya; `prisma generate` tidak butuh keduanya, jadi build CI/Vercel aman tanpa DB).
4. Jalankan `bun run db:push` sekali dari mesin yang bisa menjangkau database — otomatis memakai `DATABASE_URL_UNPOOLED`. (Atau lewat Supabase Studio → SQL Editor dengan hasil `prisma migrate diff`.) Schema cuma 3 tabel; `db push` idempoten.

Contoh pasangan URI (Vercel + Supabase):

```
# DATABASE_URL — runtime, transaction pooler
postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/post?pgbouncer=true&connection_limit=1

# DATABASE_URL_UNPOOLED — schema ops (db push / studio), session pooler
postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/post
```

> Integrasi Vercel×Supabase/Neon yang menyediakan pasangan pooled+unpooled otomatis biasanya sudah mengikuti konvensi nama ini — kalau beda, salin nilai direct-nya manual ke `DATABASE_URL_UNPOOLED`.
>
> Koneksi gagal dari Vercel? Pastikan runtime memakai pooler URI (bukan `db.<ref>.supabase.com` direct, yang dibatasi IPv6 di beberapa region).

## 2. Vercel

1. Import repo → **Framework preset: Next.js** (build `bun run build` terdeteksi otomatis dari `package.json`).
2. Environment variables (Production): semua variabel dari checklist — `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct; hanya untuk `db push`, tidak dipakai runtime — boleh diset hanya di mesin operator, tapi aman juga diset di Vercel).
3. Deploy.
4. Domain: beri subdomain khusus, mis. `panel.example.com`.
5. **Rekomendasi (Q4 PRD):** aktifkan Vercel Password Protection / Deployment Protection, atau letakkan di belakang Cloudflare Access / IP allowlist — lapisan kedua di depan aset paling sensitif fleet ([SECURITY.md](SECURITY.md)).
6. Uptime monitor → `GET /api/healthz` (harus `{"ok":true,"db":true}`).

## 3. VPS / Docker (alternatif)

```bash
bun install
bun run build
bun run start          # next start -p 3000 (di belakang reverse proxy TLS)
```

- Jalankan sebagai service (systemd/supervisor) dengan restart otomatis.
- Terminasi TLS di reverse proxy (Caddy/nginx) — HSTS sudah dikirim aplikasi.
- Pastikan proses punya memori ≥ 512 MB (fan-out + Next.js runtime).

## 4. Pasca-deploy

1. Buka `https://panel.example.com` → login → **Tambah Instance** → Test Koneksi per instance.
2. Verifikasi kartu overview menampilkan statistik nyata dalam ≤ 3 s (NFR-P1).
3. Verifikasi satu aksi (approve) di instance staging — cek tweet ter-post dan entry audit muncul.
4. Simpan kredensial deployment di password manager.

## Operasional

| Kegiatan | Rutinitas |
|---|---|
| Rotasi password login | Ganti env → redeploy → semua sesi logout otomatis |
| Rotasi session secret | Sama seperti atas (me-logout semua sesi) |
| Rotasi kunci enkripsi | Set env baru → redeploy → **isi ulang password tiap instance** (edit instance); kredensial lama tidak terbaca lagi |
| Backup | Snapshot database controller (kecil — registry + audit) |
| Pemantauan | healthz + badge kesehatan kartu (panel itu sendiri adalah surface monitoring — O4) |

## Catatan penskalaan

- Desain headroom: ~10 instance aktif (Q2 PRD). Fan-out paralel dengan timeout 8 s/instance — instance lambat tidak menjegal yang lain.
- Satu operator (v1). Multi-operator RBAC ada di backlog ([PRD §17](PRD-CONTROLLER.md#17-future-considerations--backlog)).
- Tanpa cron/background job di v1 — semua bacaan on-demand (polling 60 s dari browser yang terbuka).
