# ARCHITECTURE — Arsitektur & Struktur Kode

Referensi implementasi. Untuk latar belakang produk: [PRD-CONTROLLER.md](PRD-CONTROLLER.md).

## Gambar besar

Controller adalah **Next.js 16 App Router** satu-route (`/`) yang berperan sebagai *orchestrator* multi-instance:

1. **Browser hanya berbicara dengan controller** (`/api/controller/*`) — browser tidak pernah memanggil domain instance langsung: tidak ada CORS, token admin instance tidak pernah menyentuh klien, media instance di-proxy lewat route controller.
2. **Server controller satu-satunya yang memanggil instance** — server-side `fetch` ke `{baseUrl}/api/admin/*` dengan `Authorization: Bearer <token>` (tanpa header `Origin`/`Referer` — guard CSRF instance lolos karena scope-nya browser same-origin saja).
3. **Instance adalah sumber kebenaran** — controller hanya menyimpan registry + kredensial terenkripsi + audit. Semua yang tampil di layar adalah bacaan API langsung (fan-out, `Promise.allSettled`, timeout 8 s per instance).

```
Browser ── GET /api/controller/overview ──► Controller (auth HMAC)
             │ untuk tiap instance enabled (paralel):
             │   token = cache ?? singleFlightLogin(instance)
             │   GET {baseUrl}/api/admin/session (Bearer)
             │     2xx → stats · 401 → re-login sekali → 'auth-failed'
             │     429 (login) → 'locked-out' · timeout/5xx → 'down'
             ▼
        { instances[], aggregate, fetchedAt }  — tidak dipersist
```

## Struktur direktori

```
scripts/with-env.sh         # wrapper: load .env dengan semantik override (kalahkan injeksi env basi sandbox)
db/                         # (tidak dipakai lagi — era SQLite; DB kini PostgreSQL)
mini-services/
  postgres-service/         # embedded Postgres untuk dev (pgdata gitignored)
prisma/schema.prisma        # 3 model: Instance, InstanceCredential, AuditLog
src/
  app/
    page.tsx                # satu-satunya route UI — <ControllerApp/>
    layout.tsx              # font, tema, Toaster; metadata statis
    robots.ts               # disallow-all (panel privat)
    api/
      healthz/route.ts              # {ok, db} — uptime monitor
      controller/
        login|logout|session/       # Epic A — auth controller
        overview/route.ts           # Epic C — fan-out kartu instance
        instances/…                 # Epic B — registry CRUD + test koneksi
        instances/[id]/actions/     # Epic E — aksi cepat (requeue/breaker/cache)
        queue/route.ts              # Epic D — antrean gabungan (GET)
        queue/[iId]/[sId]/[action]/ # Epic D — approve/reject/retry/refund/delete
        media/[iId]/[sId]/route.ts  # proxy media instance (auth-gated)
        audit/route.ts              # Epic F — log audit (GET)
  components/
    controller/             # seluruh UI panel (lihat di bawah)
    ui/                     # shadcn/ui (button, card, dialog, …)
    shared/                 # komponen kecil lintas-fitur (x-logo, status-badge, …)
  hooks/
    use-controller-session.ts   # sesi + login/logout
    use-controller-overview.ts  # polling overview 60 s (jeda saat tab hidden)
    use-controller-queue.ts     # fetch + aksi antrean
    use-toast.ts, use-countdown.ts
  lib/
    controller/
      config.ts             # pembaca env (password, secret, kunci enkripsi, SSRF override)
      auth.ts               # token HMAC, cookie, withControllerAuth()
      db.ts                 # Prisma client singleton (src/generated/controller-client)
      registry.ts           # CRUD instance + normalisasi URL + validasi
      credential-crypto.ts  # AES-256-GCM encrypt/decrypt kredensial
      instance-client.ts    # fetch ke instance + lifecycle token (cache, re-login, lockout)
      instance-url.ts       # normalisasi + guard SSRF (FR-B8)
      overview.ts           # fan-out overview + parsing stats toleran-drift
      queue.ts              # fan-out antrean + merge
      actions.ts            # aksi moderasi → panggilan instance
      audit.ts              # tulis/baca audit (retensi 90 hari)
      log.ts                # log terstruktur per-instance (tanpa payload)
      rate-limit.ts         # limiter login controller (5/15m → kunci 30m)
      types.ts              # KONTRAK tunggal seluruh DTO API (sumber dok CONTROLLER-API.md)
    auth/login-rate-limit.ts   # limiter generik (dipakai login controller)
    core/                   # util murni: api-response, format, utils, crypto, …
  generated/controller-client/  # hasil prisma generate (gitignored)
```

## Alur data utama

### Autentikasi controller (Epic A)

`POST /api/controller/login {password}` → verifikasi + limiter IP (5 gagal / 15 mnt → kunci 30 mnt, `Retry-After`) → token `HMAC(SESSION_SECRET, "tweetfess-controller:admin:v1:<exp>")`, format `<hmac>.<expHex>`, TTL 7 hari → cookie `controller_token` (HttpOnly, SameSite=Strict). Semua route mutasi dibungkus `withControllerAuth()`; header `Authorization: Bearer` diterima untuk paritas curl ([ADR-002](adr/002-hmac-admin-tokens.md)).

### Kredensial instance (Epic B)

Password admin instance diterima sekali di form → AES-256-GCM (`ENCRYPTION_KEY`) → kolom `InstanceCredential.encryptedSecret` (`iv:authTag:ciphertext`). Tidak pernah dikembalikan API, tidak pernah ke log. Decrypt hanya server-side per request, hasilnya hanya hidup di memori sesi panggilan.

### Token instance (in-memory)

Cache `{ instanceId → { token, expiresAt } }` di memori proses (NFR-S2 — tidak di DB/cookie/browser):

- Login single-flight per instance (satu panggilan login in-flight; pemanggil paralel menunggu).
- `401` → invalidasi cache → re-login **sekali** → retry panggilan asli. Re-login gagal `401` → badge `auth-failed`; `429` → `locked-out` + hitung mundur `Retry-After`.
- Restart proses = cache kosong = login ulang saat dipakai (normal, tidak terlihat operator).

### Fan-out & kegagalan parsial

Semua bacaan multi-instance memakai `Promise.allSettled` + timeout 8 s. Satu instance mati hanya menurunkan kartunya sendiri (badge `down`, data terakhir tampil redup + timestamp); dashboard tidak pernah gagal total (NFR-R1/R2).

### Media instance

`GET /api/controller/media/[instanceId]/[submissionId]` — proxy server-side ke URL media instance (auth-gated di instance), mengembalikan bytes ke browser. Alamat instance asli tidak pernah bocor ke klien.

## Pola & konvensi kode

- **`src/lib/controller/types.ts` adalah kontrak tunggal** — setiap DTO yang melintasi batas API controller dideklarasikan di sana; `docs/CONTROLLER-API.md` ditulis dari berkas ini.
- **Parsing toleran-drift (NFR-X1):** field instance yang tidak dikenal diabaikan; field opsional yang hilang → `null` → dirender "—". Endpoint hilang (instance versi lama) → fitur terkait disembunyikan dengan petunjuk, bukan crash.
- **Teks instance apa adanya (pass-through):** pesan sukses/gagal instance (Bahasa Indonesia, verbatim) diteruskan ke toast UI — controller tidak menerjemahkan ulang.
- **Audit di setiap mutasi:** wrapper route mencatat `action`, `instanceName`, `targetId`, `outcome`, `actorIp` — tanpa isi submission (privasi: konten hanya ada di instance).
- **Bahasa UI Indonesia**, identifier teknis Inggris — konsisten dengan instance.
- **Tanpa raw SQL** terhadap schema controller (murni Prisma Client) — schema tetap portabel antar provider.

## Mengapa tidak ada `proxy.ts`?

Aplikasi instance Tweetfess punya `src/proxy.ts` (middleware Next.js 16 — lihat `tweetfess/src/proxy.ts` di repo reference dan [ADR-007](adr/007-two-layer-admin-auth.md)): ia memverifikasi token admin **sebelum** route handler berjalan supaya bot yang menghantam `/api/admin/*` tidak mem-spin serverless function + koneksi Prisma hanya untuk ditolak, sementara tiap route tetap memverifikasi ulang (belt + suspenders).

Controller **sengaja tidak memilikinya**:

1. Proxy instance melindungi route-group `/admin` dan `/api/admin/*` — route yang tidak ada di repo ini; matchers-nya akan kosong.
2. Permukaan controller sudah dilindungi di route level (`withControllerAuth()` di setiap handler `/api/controller/*`) — lapisan kedua di proxy hanya menambah kompleksitas tanpa menambah keamanan.
3. Justifikasi biaya proxy (menghemat cold-start Prisma dari bot) jauh lebih lemah di controller: panel ini tidak terindeks (robots disallow-all, `noindex`), tidak di-link dari mana pun, dan traffic bot-nya minimal.

Bila kelak controller dipublikasikan lebih lebar, ADR-007 adalah pola yang dipakai ulang.

## Keputusan arsitektur

Lihat [adr/](adr/):

- [ADR-002](adr/002-hmac-admin-tokens.md) — token admin HMAC (diadopsi controller untuk sesinya sendiri, secret & nama cookie terpisah dari instance).
- [ADR-007](adr/007-two-layer-admin-auth.md) — auth dua lapis instance (konteks: mengapa instance menerima Bearer paritas).
- [ADR-016](adr/016-controller-standalone-repo.md) — controller sebagai repo/deployment terpisah dari instance.
