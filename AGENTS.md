# AGENTS.md — Panduan Agen untuk Repo Ini

Repositori ini adalah **Tweetfess Controller**: panel operator multi-instance untuk deployment menfess Tweetfess (Next.js 16 App Router + TypeScript + Prisma + PostgreSQL). Satu route UI (`/`), API di `/api/controller/*`, database 3 tabel (registry instance + kredensial terenkripsi + audit). PRD: `docs/PRD-CONTROLLER.md`. Arsitektur: `docs/ARCHITECTURE.md`.

## Aturan mutlak

1. **`tweetfess/` adalah referensi READ-ONLY.** Clone repo aplikasi instance untuk dilihat/dibandingkan saja. JANGAN pernah mengedit, memindahkan, atau menghapus file di dalamnya, dan jangan menambahkannya ke build/lint/tsconfig (sudah di-exclude). Perubahan kontrak API instance → update `docs/INSTANCE-API.md` di repo INI, bukan repo itu.
2. **`src/generated/controller-client/` hasil generate** — jangan diedit; regenerasi via `bun run db:generate`.
3. **Environment process bisa kotor.** Harness sandbox meng-inject `DATABASE_URL` basi (path SQLite). Selalu jalankan perintah sensitif-env lewat script package.json (sudah dibungkus `scripts/with-env.sh`) atau `bash scripts/with-env.sh <cmd>`. Jangan pernah hardcode connection string di kode.
4. **Dev server: port 3000, SELALU berjalan di background, jangan dobel.** Log: `dev.log` di root (baca bagian ekor saja). **Jangan pernah `bun run build`** di sandbox ini.
5. **Jangan menulis unit test** di repo ini (keputusan repo: verifikasi via `bun run lint` + `bun run typecheck` + browser E2E lewat dev server).
6. UI copy **Bahasa Indonesia** (konsisten instance); identifier teknis Inggris. Jangan gunakan warna indigo/blue dari Tailwind default selain token tema yang sudah ada (`globals.css`).
7. Production target: **Supabase PostgreSQL** + Vercel. Jangan menambah dependensi eksternal (Redis, dll.) — token cache sengaja in-memory.

## Perintah

| Perintah | Fungsi |
|---|---|
| `bun run dev` | Dev server :3000 (log → `dev.log`) |
| `bun run lint` | ESLint (harus 0 error 0 warning) |
| `bun run typecheck` | prisma generate + `tsc --noEmit` (harus clean) |
| `bun run db:push` | Sinkron schema → DATABASE_URL |
| `bun run db:generate` | Regenerasi client Prisma |
| `bun run db:studio` | Prisma Studio |
| `cd mini-services/postgres-service && bun run dev` | Database Postgres lokal :5432 (DB `controller`) |

Urutan hidup lokal: pastikan Postgres service jalan → `bun run dev` → cek `dev.log` → verifikasi `curl localhost:3000/api/healthz` = `{"ok":true,"db":true}`.

## Variabel environment (`.env`)

| Nama | Wajib | Catatan |
|---|---|---|
| `ADMIN_PASSWORD` | ya | login operator; tanpa ini + `SESSION_SECRET` login nonaktif (by design) |
| `SESSION_SECRET` | ya | HMAC token sesi; `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | ya | AES-256-GCM kredensial instance; wajib 64 hex; rotasi = isi ulang password semua instance |
| `DATABASE_URL` | ya | PostgreSQL (lokal: service mini; prod: Supabase pooler) |
| `ALLOW_PRIVATE_TARGETS` | tidak | override SSRF guard, dev only — JANGAN set di produksi |

Detail + rotasi: `docs/CONFIGURATION.md`. Jangan commit `.env`.

## Peta kode

```
src/app/page.tsx                  # UI: <ControllerApp/>
src/app/api/controller/…          # login/logout/session/overview/instances/queue/media/audit
src/components/controller/…       # seluruh UI panel
src/hooks/use-controller-*.ts     # sesi / overview (poll 60 dtk) / antrean
src/lib/controller/               # inti: config, auth, db, registry, credential-crypto,
                                  #       instance-client (token cache + re-login), overview,
                                  #       queue, actions, audit, log, rate-limit, instance-url, types
src/lib/core/                     # util murni lintas-fitur (api-response, format, utils, …)
prisma/schema.prisma              # Instance / InstanceCredential / AuditLog
mini-services/postgres-service/   # dev database (embedded Postgres)
scripts/with-env.sh               # wrapper env override (lihat Aturan #3)
docs/                             # seluruh dokumentasi (docs/README.md = indeks)
```

## Konvensi implementasi

- **`src/lib/controller/types.ts` adalah kontrak tunggal** semua DTO API. Menambah/mengubah bentuk respons? Ubah di sana, lalu sinkronkan `docs/CONTROLLER-API.md`.
- **Parsing toleran-drift (NFR-X1):** field instance tak dikenal diabaikan; field opsional hilang → `null` → UI render "—". Jangan pernah crash pada body instance.
- **Pass-through copy:** pesan sukses/gagal instance ditampilkan verbatim di toast — jangan diterjemahkan/ditulis ulang.
- **Setiap mutasi API dibungkus `withControllerAuth()`** dan menulis audit (`recordAudit`) — tanpa isi submission, hanya id/aksi/outcome/IP.
- **Tanpa raw SQL** dan **tanpa enum Prisma** di schema (portabilitas provider by design).
- Kredensial instance: write-only, AES-256-GCM (`credential-crypto.ts`), tidak pernah keluar via API/log.
- Error API memakai helper `lib/core/api-response` (bentuk konsisten + copy Indonesia).
- Setelah menulis kode: `bun run lint` + `bun run typecheck` WAJIB clean, lalu verifikasi browser di `http://localhost:3000` (login → alur yang disentuh) dan cek `dev.log` — "compiles" bukan selesai; browser-verified interactivity adalah standar done.

## Saat mendiagnosis masalah

- `docs/TROUBLESHOOTING.md` dulu — tabel gejala→perbaikan.
- Instance bermasalah → badge kartu (`auth-failed`/`locked-out`/`down`) punya arti spesifik (`docs/USAGE.md`).
- Prisma error "URL must start with postgresql://" → Aturan #3 (env injection) — pakai wrapper.
- Postgres lokal mati → jalankan ulang service mini (folder `pgdata` persist; jangan dihapus).
