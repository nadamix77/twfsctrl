# WORKLOG — Tweetfess Controller

Catatan kerja kronologis untuk repo ini. Hanya pekerjaan controller — sejarah instance Tweetfess ada di repo instance (`tweetfess/`, referensi read-only).

---

## 2026-11-21 — Port seluruh fitur admin Tweetfess ke controller (Pengirim / Pembayaran / Pengaturan / AI / Analitik)

### 1. Simulator instance diperluas (kontrak tetap satu sumber: docs/INSTANCE-API.md)

`mini-services/tweetfess-instance/index.ts` (770 → ~1790 baris): endpoint admin yang belum diimplementasikan ditambahkan setia pada dokumen — `GET /api/admin/submitters` (+ `block`/`unblock`/`whitelist`/`image-post-allowlist`/`overrides`/`points-adjust`), `GET /api/admin/payments` (+ `confirm`/`void`/`ambiguous/:refId/dismiss`), `GET|POST|DELETE /api/admin/settings` (16 kunci valid, GET ter-mask), `GET|POST /api/admin/filter-settings` (merge per-grup + validasi bounds), `GET /api/admin/ai-status`, `GET /api/admin/ai-stats`, `GET /api/admin/analytics` (preset today/7d/30d/month + span kustom ≤366 hari, bucket hari WIB). 21 counter baru di `/api/dev/state`; route lama tak tersentuh; `filterSettings`/`FILTER_GROUP_SNAKE` jadi `Map` (idiom SAST anti object-injection). Diverifikasi penuh lewat curl (semua jalur sukses + 400/404/409) oleh subagent.

### 2. Sisi controller — kontrak + lib + 8 route baru

- `src/lib/controller/types.ts`: kontrak SubmitterItem/SubmittersSection (+`flagsKnown`), PaymentOrder/PaymentsSection/UnmatchedCredit, SettingsSnapshot/FilterSettingsSnapshot/AiSnapshot/AnalyticsSnapshot, union aksi `SubmitterAction`/`PaymentAction`.
- `src/lib/controller/parse.ts` (baru): pembaca defensif NFR-X1 (readNum/Str/Bool/Iso/StrArray/NumRecord + readPagination multi-ejaan).
- `src/lib/controller/submitters.ts` (baru): fan-out `/api/admin/submitters` + cross-ref `/api/admin/filter-settings` (ID list → flag blocked/whitelisted/imageAllowed, page 1 saja) + tabel aksi (DELETE-with-body untuk whitelist/allowlist).
- `src/lib/controller/payments.ts` (baru): fan-out `/api/admin/payments` (orders + revenue + blok gobiz: health/refresh/orphans/ambiguous) + aksi confirm (note wajib, refId opsional)/void/dismiss.
- `src/lib/controller/instance-admin.ts` (baru): proxy per-instance settings (upsert/delete), filter-settings (GET parse defensif + POST patch), AI (status+stats paralel, degradasi independen), analytics (range preset).
- Route: `GET /api/controller/submitters`, `POST /api/controller/submitters/[instanceId]/[action]`, `GET /api/controller/payments`, `POST /api/controller/payments/[instanceId]/[action]`, `GET|POST|DELETE /api/controller/settings/[instanceId]`, `GET|POST /api/controller/filter-settings/[instanceId]`, `GET /api/controller/ai/[instanceId]`, `GET /api/controller/analytics/[instanceId]` — semua `withControllerAuth` + audit `submitter.*`/`payment.*`/`settings.*`/`filter.update` (targetId = username/orderId/refId/key/group-names; note & alasan TIDAK pernah masuk audit, FR-F2). Prisma schema tidak berubah (tidak perlu db:push).
- `log.ts`: namespace debug baru `controller:submitters`/`controller:payments`.

### 3. Sisi UI — 4 view + dialog Pengaturan

- `dashboard.tsx`: tab view Ringkasan | Pengirim | Pembayaran | Analitik (nav aria, wrapper scroll-x mobile — bug overflow 390px ditemukan & diperbaiki saat verifikasi).
- `submitters-panel.tsx` (baru): chip instance + search debounce + baris dengan badge Diblokir/Whitelist/Izin gambar/Limit khusus/Harga khusus + menu aksi (Blokir… dengan alasan, whitelist, izin gambar, dialog Override Limit & Harga 7+3 field, dialog Sesuaikan Poin delta+note wajib).
- `payments-panel.tsx` (baru): tab status + kartu ringkasan per-instance (revenue + badge GoBiz) + baris order (Konfirmasi…/Batalkan untuk pending) + blok kredit ambigu (Abaikan) + kredit yatim (display-only).
- `analytics-panel.tsx` (baru): preset rentang + strip agregat + kartu per-instance (6 tile, funnel, paket top-up, leaderboard, alasan tolak, kelas kegagalan); tile Pendapatan tanpa prefiks "Rp" + tooltip nilai persis (aturan compact-rounds).
- `instance-settings-dialog.tsx` (baru): 3 tab — Kredensial & X (list masked + tambah/perbaru/hapus 16 kunci), Filter (switch + textarea kata + prompt AI + mode gambar + batas/CB/monetisasi; patch hanya grup berubah), AI (health penyedia + Periksa ulang + tabel statistik fase×provider). Dibuka dari menu kartu instance ("Pengaturan Instance").
- `use-instance-sections.ts` (baru): state machine sections generik (doktrin use-controller-queue: page-1 refetch, loadMore merge+dedupe, refresh 1..N, slice beku FR-D11) — dipakai Pengirim & Pembayaran.
- Idiom lint yang dipegang: Map/entries+fromEntries (anti object-injection), `const run = async () => {}` + `void run()` dalam efek (anti set-state-in-effect + narrowing), DialogFooter lokal (ui/dialog tak mengekspor footer).

### Verifikasi

- `bun run lint` 0 error 0 warning; `bunx tsc --noEmit` 0 error.
- Browser E2E (agent-browser, login → semua view): blokir @neneng_t (badge muncul) → buka blokir (badge hilang); points-adjust @dimas_p −3 → toast "Saldo sekarang 1 poin"; override @ditaaa (badge Limit khusus tetap); konfirmasi ord_002 + note + refId gobiz:TXN200 → "Order dikonfirmasi" (validasi note kosong ditolak dulu); void ord_003; dismiss ambigu TXN777 → blok hilang; Pengaturan: simpan post_method=twitterapi (mask "twi***api"), hapus require_follow (baris hilang), Filter: autoApprove on + blockedWords + submissionDailyCap 30 → terverifikasi di simulator (`autoApprove: true`), AI: 2 penyedia + tabel text/vision + Periksa ulang.
- Audit trail: `filter.update autoApprove,blockedWords,rateLimits success`, `settings.save/delete`, `payment.confirm/void/dismiss`, `submitter.block/unblock/points-adjust (balance=1)/overrides` — semua success, tanpa konten bebas.
- dev.log: seluruh panggilan route baru 200 (nol 4xx/5xx setelah fix); overflow mobile diperbaiki (scrollW 390 == viewport); VLM: layout bersih, tile satu baris penuh.
- Simulator di-reseed segar (touch → hot reload) pasca-verifikasi.

### Status akhir hari

- Semua fitur admin instance (moderasi, pengirim, monetisasi, pengaturan kredensial, filter, AI, analitik, maintenance) kini dapat dijalankan dari satu panel controller; audit & slice-beku menyusul pola Epic D/F.

---

## 2026-11-21 — Ekstraksi repo + PostgreSQL + rename env

### 1. Ekstraksi controller menjadi repo standalone (ADR-016)

Repo ini sebelumnya adalah aplikasi instance Tweetfess dengan controller dikembangkan di dalamnya (route `/` menggantikan halaman publik). Hari ini dipisah total:

- **Dihapus:** seluruh kode instance — halaman publik & `/admin`, API instance (`/api/admin`, `/api/submissions`, `/api/payments`, `/api/auth`, `/api/media`, `/api/nsfw-scan`, `/api/autopost`, `/api/test-x`, `/api/x-keepalive`), lib instance (x-api, payments, ai, image, posting, settings, submission, submitter, content-filter, access, services), `src/proxy.ts`, contexts + 19 hooks instance, seluruh `src/__tests__`, vitest config, schema instance + 15 migrasi, mini-service Postgres lama, seeder demo, release-please, 21 dokumen instance + `flows/` + `how-to/` + 13 ADR instance, workflow CI/CD instance, `worklog`/`CHANGELOG`/`FINDINGS` instance, `og-default.png`.
- **Dependency prune:** 12 package dihapus (tfjs, nsfwjs, sharp, aws-sdk, qrcode, undici, zod, vitest, madge, dll.) — diverifikasi zero import tersisa.
- **Dipertahankan dari instance:** util `lib/core` murni, `components/ui` (shadcn) + 6 komponen `shared/`, `use-toast`/`use-countdown`, login rate limiter, ADR-002 + ADR-007, kontrak API instance → `docs/INSTANCE-API.md`.
- `prisma/controller.prisma` → `prisma/schema.prisma` (schema tunggal).
- Data demo lama (instance `twfs-lokal` menunjuk instance lokal yang ikut terhapus) dibersihkan — registry mulai kosong.
- Rewrite app shell: `layout.tsx` (metadata statis, tanpa branding DB), `not-found.tsx`, `robots.ts` (disallow-all), `types/index.ts` minimal (literal union status instance), `constants.ts` slim, `next.config.ts` (CSP `img-src https:` — avatar/media dari domain instance operator; hapus serverExternalPackages + remotePatterns).
- Dokumentasi ditulis ulang lengkap (lihat `docs/README.md`).
- **Keputusan proxy.ts:** dihapus — hanya melindungi route instance yang tak ada lagi; route controller self-protect via `withControllerAuth()` (penjelasan: `docs/ARCHITECTURE.md#mengapa-tidak-ada-proxyts`).

### 2. Rename variabel environment

Prefiks `CONTROLLER_*` dihapus → `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `ALLOW_PRIVATE_TARGETS` (repo standalone; nama pendek tidak ambigu). Terrenamkan di: `src/lib/controller/config.ts`, `prisma/schema.prisma`, `.env`(+example), CI, dan seluruh docs.

### 3. Database → PostgreSQL (Supabase)

- `prisma/schema.prisma`: provider `sqlite` → `postgresql` (schema memang tanpa enum & tanpa raw SQL — perpindahan mulus).
- **Mini-service Postgres lokal dibangun ulang** (`mini-services/postgres-service/`): mengemudikan binary `initdb`/`pg_ctl` dari `@embedded-postgres/linux-x64` langsung. Library umbrella `embedded-postgres` tidak dipakai — `initialise()`-nya memaksa `--lc-messages=en_US.UTF-8`, locale yang tidak ada di container ini (hanya `C`/`C.utf8`/`POSIX`) → initdb exit 1. Cluster: port 5432, superuser `postgres`, database `controller`, auth trust (dev only), pgdata persist + gitignored.
- **Gotcha sandbox:** harness meng-inject `DATABASE_URL=file:/home/z/my-project/db/custom.db` (sisa SQLite) ke environment proses — mengalahkan `.env` baik di Prisma CLI maupun Next.js. Solusi: `scripts/with-env.sh` — wrapper yang `source .env` dengan `set -a` (override semantics), pass-through bila `.env` absen (produksi aman). Semua script package.jsch yang sensitif-env kini lewat wrapper.
- `db:push` ke Postgres sukses; SQLite `db/controller.db` dihapus; `.gitignore` disesuaikan.
- Produksi: Supabase session pooler (`?pgbouncer=true&connection_limit=1`) — `docs/DEPLOYMENT.md`.

### 4. Referensi instance (read-only)

`tweetfess/` di-clone dari `github.com/james2256/tweetfess` (PAT dipakai sekali untuk clone lalu di-scrub dari `.git/config` — **token sebaiknya dirotasi** karena pernah muncul di chat). Folder ini: reference only — di-gitignore, di-exclude dari tsconfig + eslint, **jangan pernah diedit**.

### 5. Verifikasi

- `bun run lint` — 0 error 0 warning (override eslint `mini-services/**/*.mjs` boleh console: service CLI memang log).
- `bun run typecheck` — clean.
- Dev server + service Postgres berjalan; `healthz` → `{"ok":true,"db":true}` (Postgres).
- Browser E2E: login → dashboard (registry kosong) → dialog Tambah Instance (validasi + test koneksi + switch override) → menu akun → Log Audit (filter + paginasi) — semua 200, dev.log bersih.

### Status akhir hari

- App: controller-only, Postgres-backed, env tanpa prefiks.
- Login dev: `controller-sandbox-demo` (nilai `ADMIN_PASSWORD` di `.env`).
- Registry kosong — menunggu instance produksi didaftarkan.
- CI: lint + typecheck + build (`.github/workflows/ci.yml`).

---

## 2026-11-21 — E2E recheck penuh: simulator instance + verifikasi seluruh permukaan integrasi

### 1. Simulator instance Tweetfess (`mini-services/tweetfess-instance/`, port 3010)

Untuk membuktikan controller benar-benar bekerja melawan instance Tweetfess (repo ini sudah tidak punya instance lokal sejak ekstraksi), dibangun simulator yang mengimplementasikan kontrak `docs/INSTANCE-API.md` secara setia: token admin HMAC `<hmac>.<expiresAtHex>` (ADR-002, cookie `admin_token` + Bearer), origin-guard pada semua mutasi (POST tanpa Origin/Referer → 403), rate-limit login 5 gagal/15 mnt/IP → 429 + Retry-After 30 mnt, `GET /api/submissions` (status/page/limit/search + pagination), `PATCH` approve/reject (body respons verbatim), `DELETE`, `POST :id/post` (retry), `POST :id/refund`, quick action (requeue/breaker-reset/clear-cache), media auth-gated dengan ETag/304, plus `GET /api/dev/state` (dump counter per-endpoint untuk pembuktian E2E). Seed 7 submission realistis berbahasa Indonesia. Password: `twfs-sim-password` (override `INSTANCE_ADMIN_PASSWORD`). Didokumentasikan di `docs/SETUP.md` §6.

### 2. Verifikasi positif (browser + curl + dump state instance)

- **Login controller:** password salah → alert "Password salah"; benar → dashboard. Logout → login ulang OK.
- **SSRF guard (FR-B8):** dengan `ALLOW_PRIVATE_TARGETS` mati, register `http://localhost:3010` ditolak 400 dengan pesan persis dari spec. Diaktifkan → Next.js auto-reload `.env` (terlihat "Reload env" di dev.log).
- **Registrasi instance:** dialog Tambah Instance → Test Koneksi → "Terhubung — 2 menunggu review" (probe `stats.pending` lewat session instance) → simpan → kartu instance "Sehat" dengan stats live (2/2/0/1/1/1, total 7, CB normal).
- **Antrean Moderasi:** 5 item reviewable (2 pending — satu berbayar, 2 censored — satu NSFW-flagged dengan filter flag `all_caps`, satu `Diblokir: "judol"` + `caps_ratio`, 1 post_failed dengan postError). Tab filter + badge count benar; search per-status diteruskan ke instance ("rina" cocok, "bakso" di tab Disensor → kosong); clear search (tombol X) → refetch penuh.
- **Aksi antrean → mutasi state instance terverifikasi lewat counter `/api/dev/state`:** approve (sub_pending_1 → posted + tweetId), reject ×2 (spam → rejected; paid post → toast "Poin dikembalikan" dari `refund:"refunded"`), retry (sub_failed_1 → posted, postMethod `retry`), refund manual (200, body instance verbatim, `refundedAt` tertulis), delete (dialog konfirmasi → row hilang, counter deletes +1).
- **Quick action:** Requeue (dialog konfirmasi → `{requeued:1}`, post_failed → pending, tab Menunggu 2→3), Reset Circuit Breaker + Bersihkan Cache (toast menampilkan pesan instance verbatim: "Circuit breaker reset", "Cache dibersihkan (12 jenis)").
- **Nonaktifkan/Aktifkan (FR-B5):** disabled → header Instance 0/0, kartu "nonaktif", antrean kosong; enabled → pulih.
- **Keyboard:** fokus row + `a` → approve (counter instance +1, queue 5→4).
- **Media proxy (§6.2):** `<img>` browser memuat lewat `/api/controller/media/<instanceId>/<submissionId>` — decode 16×16 PNG sukses; browser tidak pernah menyentuh origin instance.
- **Audit log:** 15 entri mencatat seluruh sesi (controller.login sukses+gagal, logout, instance.create/test, submission.approve/reject/retry/refund/delete, instance.requeue/breaker-reset/clear-cache) — tanpa isi pesan (privasi by design).
- **Kredensial at rest (FR-B6):** `InstanceCredential.encryptedSecret` = base64 `iv:authTag:ciphertext` AES-256-GCM, tidak mengandung plaintext.

### 3. Verifikasi jalur kegagalan

- Test koneksi password salah → `{"ok":false,"status":401,"message":"Password salah"}` (teks instance verbatim, aturan C4).
- Port mati → "Instance tidak dapat dijangkau (DNS/jaringan)".
- **Lockout instance (E3):** 4×401 → percobaan ke-5 429 + `retryAfterSec:1800`; percobaan ke-6 dijawab dari memori lockout controller sendiri ("Login instance terkunci…") — controller tidak pernah menghantam instance terkunci. Sim di-restart untuk reset; instance terdaftar tetap Sehat (token cache bertahan, kunci `test:` terpisah dari kunci instance id).
- Login instance tanpa Origin → 403 origin-guard (sim menolak POST tanpa Origin/Referer; controller selalu mengirim `Origin: <baseUrl instance>` — terbukti tidak ada satu pun blokir origin selama sesi).

### 4. Catatan

- `agent-browser fill ""` tidak memicu onChange React (artefak tooling) dan click berbasis koordinat pada tombol X search tidak konsisten — diverifikasi BUKAN bug produk: JS `.click()` + mouse click mentah di koordinat tombol bekerja normal dan refetch jalan.
- Post-mortem kecil: error modul lama (`@/components/payments/format-idr`, `@/lib/core/site-url`) yang muncul di buffer console browser adalah sisa riwayat sesi sebelum ekstraksi selesai — reload bersih: 0 page error.
- eslint override `mini-services/**/*.mjs` diperluas ke `*.ts` (simulator adalah daemon CLI juga). Lint simulator di-fixa (object-injection → `push`, unused var, timing-attack → `timingSafeEqual`).

### Verifikasi

- `bun run lint` — clean (0 error, 0 warning).
- dev.log: 213×200, 1×201 (instance.create), 1×400 + 1×401 (uji negatif yang disengaja), 0×5xx, 0 error kompilasi.
- Browser: reload bersih — 0 page error, console hanya HMR.
- Mobile 390×844: tanpa horizontal scroll, semua tombol aksi render, target sentuh memadai; desktop 1440×900 normal.

### Status akhir hari

- Instance `twfs-lokal` → `http://localhost:3010` terdaftar, Sehat, kredensial terenkripsi.
- Simulator berjalan di :3010; Postgres di :5432; controller di :3000.
- `ALLOW_PRIVATE_TARGETS=true` aktif di `.env` — **hanya untuk development lokal** (produksi wajib mati).

---

## 2026-11-21 — Perbaikan pasca-restart sandbox: env resilient + tab Ditolak (FR-D8)

### 1. `.env` ditimpa harness → `.env.local` (env resilience)

Restart sesi sandbox menimpa `.env` kembali ke `DATABASE_URL=file:…custom.db` (SQLite basi) — `ADMIN_PASSWORD`/`SESSION_SECRET`/`ENCRYPTION_KEY` hilang, dev server mati. Perbaikan:

- Konfigurasi sungguhan pindah ke **`.env.local`** (gitignored, tidak disentuh harness): `ADMIN_PASSWORD=controller-sandbox-demo`, `SESSION_SECRET`+`ENCRYPTION_KEY` baru (hex 32), `DATABASE_URL` Postgres, `ALLOW_PRIVATE_TARGETS=true`.
- `scripts/with-env.sh` kini mensource **`.env` lalu `.env.local`** (last-wins) — rewrite `.env` oleh harness tidak lagi mematikan app.
- Konsekuensi rotasi `ENCRYPTION_KEY`: kredensial terenkripsi lama tak terdekripsi — namun pgdata juga ter-reset antar sesi (registry kosong), jadi tidak ada data basi; instance didaftarkan ulang.

### 2. Bug FR-D8: refund manual tak terjangkau — tab "Ditolak" ditambahkan

`QueueStatusFilter` hanya `all|pending|censored|post_failed` → baris `rejected` tak pernah masuk antrean, padahal tombol "Kembalikan Poin" (`POST …/refund`, FR-D8 P1) hanya render di baris rejected — dead code. Fix (4 file + 2 docs):

- `types.ts`: union + `'rejected'`; `queue/route.ts`: whitelist parse + komentar; `use-controller-queue.ts`: `QueueTotals.rejected`; `queue-panel.tsx`: tab "Ditolak" + count disembunyikan saat tab lain (rejected bukan bagian fetch "all" — count 0 pasti menyesatkan) + empty-state copy khusus.
- `docs/CONTROLLER-API.md` + `docs/USAGE.md` diperbarui. `STATUS_CONFIG` sudah punya label "Ditolak" — tanpa perubahan.
- Simulator & kontrak instance sudah menerima `status=rejected` (`VALID_LIST_STATUSES`) — tanpa perubahan sisi instance.

### 3. Touch target badge instance (mobile)

Badge filter instance di baris antrean hanya 22px — area sentuh diperluas via pseudo-elemen `after:-inset-1.5` (≈35px efektif) tanpa mengubah visual.

### 4. Verifikasi E2E penuh (browser + dump state instance)

- Login salah/benar, logout, login ulang. Registrasi `twfs-lokal` → `http://localhost:3010` (Test Koneksi "Terhubung — 2 menunggu review", kartu Sehat).
- Aksi antrean terverifikasi lewat counter instance: approve (→posted+tweetId), reject ×2 (free + paid → toast "Poin dikembalikan" dari `refund:"refunded"` inline), retry (postMethod=retry), delete (konfirmasi), **refund manual di tab Ditolak** (toast, `refunds:1`, `refundedAt` tertulis, baris hilang).
- Quick action: requeue (`sub_failed_1` → pending, tab Menunggu 2→3), reset breaker + clear cache (toast verbatim: "Circuit breaker reset", "Cache dibersihkan (12 jenis)") — semuanya lewat dialog konfirmasi.
- Nonaktifkan/aktifkan; keyboard `a` approve; search "rina" + clear; media proxy (img decode via `/api/controller/media/…`); audit log 13+ entri sesi (controller.login … submission.refund) dengan targetId/outcome/IP.
- Resiliensi auth: simulator di-restart (reseed) → controller re-login transparan, kartu tetap Sehat. Edit Instance: URL terkunci, Test Koneksi password salah → "Password salah" verbatim.
- Mobile 390×844 tanpa horizontal scroll, tombol aksi 44px; desktop 1440×900 normal. Tanpa footer by design (app dashboard).

### 5. Catatan operasional

- Dev server dijalankan langsung sebagai user `z` (`bun run dev` dari repo root) — proses `sudo -u z` milik harness sesi lama sudah mati.
- Reseed simulator: kill proses `bun --hot run index.ts` di `mini-services/tweetfess-instance/` lalu `nohup bun run dev` (state in-memory; `touch` TIDAK me-reseed).

### Verifikasi

- `bun run lint` — 0 error 0 warning; `bun run typecheck` — exit 0, 0 error TS.
- dev.log sesi ini: 85×200, 1×201 (instance.create), 1×401 (uji password salah), 0×5xx, 0 error kompilasi; `GET /api/controller/queue?status=rejected` 200.
- `healthz` → `{"ok":true,"db":true}` (Postgres).

### Status akhir hari

- Instance `twfs-lokal` terdaftar, Sehat, kredensial terenkripsi dengan `ENCRYPTION_KEY` yang ada di `.env.local`.
- Simulator :3010 (seed segar: 2 pending/2 censored/1 failed/1 rejected/1 posted), Postgres :5432, controller :3000.
- FR-D8 kini terjangkau dari UI; `.env.local` + with-env.sh tahan rewrite harness.

---

## 2026-11-21 — Split DATABASE_URL / DATABASE_URL_UNPOOLED (Prisma directUrl) + env lapis ketiga di luar repo

### 1. Pooled/unpooled split — jawaban untuk "Session pooler = DATABASE_URL_UNPOOLED?"

Dokumen lama menyarankan Session pooler + `?pgbouncer=true&connection_limit=1` untuk runtime serverless — kombinasi keliru (`pgbouncer=true` adalah parameter mode **transaction**) dan tidak memisahkan koneksi runtime vs operasi schema. Sekarang mengikuti pola kanonik Prisma:

- `prisma/schema.prisma`: `datasource.db` kini punya `url = env("DATABASE_URL")` (runtime) + `directUrl = env("DATABASE_URL_UNPOOLED")` (CLI: `db:push`/`studio`). Advisory lock + prepared statement Prisma CLI tidak selamat dari transaction pooling → directUrl wajib direct/session-pooler.
- Rekomendasi produksi (DEPLOYMENT.md §1): **runtime** = Supabase transaction pooler `:6543` + `?pgbouncer=true&connection_limit=1` (serverless/Vercel; direct untuk VPS); **schema ops** = direct / session pooler `:5432`. Contoh pasangan URI disertakan. Checklist pra-deploy + bagian Vercel diperbarui.
- `DATABASE_URL_UNPOOLED` didokumentasikan di CONFIGURATION.md (section + matriks), SETUP.md, `.env.example`, dan placeholder CI (`ci.yml` Build).
- Terverifikasi: `prisma generate` jalan **tanpa** kedua env var (build CI/Vercel aman tanpa DB); `db:push` memakai directUrl ("already in sync"); runtime tetap `url`.

### 2. Env lapis ketiga: `~/.config/tweetfess-controller/env`

Restart harness pukul 04:22 ternyata bukan cuma menimpa `.env` — `.env.local` **juga** dihapus, `dev.log` dihapus, pgdata di-reset (database kosong), semua proses dimatikan (sim + Postgres di-restart harness; dev server mati). Bukti: mtime `.env`/pgdata 04:22:28-37, `.env.local` tersisa hanya blok hasil `>>` saya pukul 04:25, cache `~/.bun` berisi file pra-04:22 (home SELAMAT).

- `scripts/with-env.sh` kini mensource `.env` → `.env.local` → **`~/.config/tweetfess-controller/env`** (last-wins) — file di luar repo, selamat dari reset harness, `chmod 600`.
- `.env.local` tetap dipulihkan berisi 6 var (lapis kedua); home file = sumber kebenaran sandbox.
- Konsekuensi reset pgdata: registry + audit kosong tiap restart harness — instance didaftarkan ulang (prosedur reseed simulator sudah tercatat di entri sebelumnya).
- Dokumen: CONFIGURATION.md (catatan sandbox diperluas: daftar lengkap apa yang di-reset harness), SETUP.md.

### 3. Pemulihan + verifikasi pasca-reset

- `db:push` ke pgdata segar → 3 tabel; dev server restart; `healthz` → `{"ok":true,"db":true}`.
- Browser E2E: login → Tambah Instance (Test Koneksi "Terhubung — 2 menunggu review") → kartu Sehat, antrean 5 item → approve 1 (counter instance `approves:1`, stats censored 2→1/posted 1→2) — media proxy 200.
- `bun run lint` — 0 error 0 warning. dev.log bersih (200s, termasuk `POST …/approve` dan 2× media proxy).

### Status akhir hari

- `twfs-lokal` terdaftar ulang, Sehat; simulator :3010 seed segar; Postgres :5432; controller :3000.
- Rahasia sandbox kini bertahan lintas reset harness via `~/.config/tweetfess-controller/env`.
- Produksi: `DATABASE_URL` (pooled, runtime) + `DATABASE_URL_UNPOOLED` (direct, schema ops) — pola Vercel×Supabase standar.

---

## Format entri berikutnya

```
## YYYY-MM-DD — <judul singkat>

### <nomor>. <apa yang dilakukan>
- <detail / file yang disentuh / alasan>

### Verifikasi
- <lint/typecheck/browser/healthz>
```
