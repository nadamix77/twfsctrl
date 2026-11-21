# SETUP — Menjalankan Controller Lokal

Panduan dari clone ke dashboard berjalan. Untuk produksi lihat [DEPLOYMENT.md](DEPLOYMENT.md).

## Prasyarat

- **Bun** 1.x (runtime & package manager)
- Node.js 20+ (Bun menjalankannya; hanya perlu jika ingin `node` eksplisit)
- Instance Tweetfess minimal satu yang hidup (untuk data nyata) — opsional untuk sekadar melihat UI

## Langkah

### 1. Install dependensi

```bash
bun install
```

`postinstall` menjalankan `prisma generate` — client Prisma controller dihasilkan ke `src/generated/controller-client` (di-gitignore).

### 2. Siapkan environment

```bash
cp .env.example .env
```

Edit `.env` — minimal empat nilai pertama:

```ini
ADMIN_PASSWORD=<password-login-anda>
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/controller
DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@localhost:5432/controller
```

Lokal tidak ada pooler — `DATABASE_URL_UNPOOLED` (Prisma `directUrl`, dipakai `db:push`/`studio`) sama dengan `DATABASE_URL`. Di sandbox dev, taruh nilai ini di `~/.config/tweetfess-controller/env` — file di luar repo yang selamat dari reset harness (yang menimpa `.env`/`.env.local`); `scripts/with-env.sh` memuatnya otomatis (lihat [CONFIGURATION.md](CONFIGURATION.md)).

Tanpa `ADMIN_PASSWORD` + `SESSION_SECRET`, login dinonaktifkan dan layar login menampilkan petunjuk setup (aplikasi tetap hidup — lihat [CONFIGURATION.md](CONFIGURATION.md)).

`ENCRYPTION_KEY` wajib 64 karakter hex (32 byte untuk AES-256). Controller **menolak** menyimpan kredensial instance tanpa enkripsi — route mutasi registry akan menolak dengan error konfigurasi bila kuncinya tidak valid.

### 3. Jalankan database Postgres lokal

Database controller adalah **PostgreSQL** (produksi: Supabase). Untuk development lokal, repo ini menyertakan service Postgres embedded:

```bash
cd mini-services/postgres-service
bun install
bun run dev        # postgres di :5432, database `controller` dibuat otomatis
```

Service ini daemonisasi postgres via `pg_ctl` — data persist di `pgdata/` (gitignored). Biarkan berjalan di background, lalu kembali ke root repo.

### 4. Sinkronkan schema

```bash
bun run db:push
```

Membuat tiga tabel di database `controller`: `Instance`, `InstanceCredential`, `AuditLog` (lihat [DATA-MODEL.md](DATA-MODEL.md)).

### 5. Jalankan

```bash
bun run dev
```

Buka `http://localhost:3000` — satu-satunya route adalah `/` (login + dashboard). Login dengan `ADMIN_PASSWORD`.

### 6. (Opsional) Simulator instance untuk testing lokal

Butuh instance untuk eksperimen lokal tanpa men-deploy Tweetfess? Repo ini menyertakan simulator yang mengimplementasikan kontrak Instance API ([INSTANCE-API.md](INSTANCE-API.md)) persis seperti yang dikonsumsi Controller — termasuk token HMAC admin (ADR-002), origin-guard, rate-limit login 5x/15 menit, dan endpoint aksi lengkap:

```bash
cd mini-services/tweetfess-instance
bun run dev        # :3010 — password admin `twfs-sim-password`
                    # (override via INSTANCE_ADMIN_PASSWORD)
```

Seed 7 submission realistis (`pending` / `censored` / `post_failed` / `posted` / `rejected`). Saat mendaftarkan instance ini:

- **URL Instance**: `http://localhost:3010` (butuh `ALLOW_PRIVATE_TARGETS=true`)
- **Password Admin Instance**: `twfs-sim-password`

`GET /api/dev/state` (dengan token admin) memdump state internal + counter per-endpoint — berguna untuk memverifikasi aksi controller benar-benar sampai ke instance (E2E).

### 7. Daftarkan instance pertama

1. Klik **Tambah Instance**.
2. Isi **Nama** (unik, tampilan), **URL Instance** (`https://host` — tanpa path, tanpa trailing slash), **Password Admin Instance** (password `ADMIN_PASSWORD` instance tersebut).
3. Klik **Test Koneksi** — controller melakukan login + `GET /api/admin/session` ke instance dan melaporkan hasilnya apa adanya.
4. Hijau → **Tambah Instance**. Merah → perbaiki URL/password; atau centang *Simpan tanpa tes berhasil* untuk tetap menyimpan.

> **Instance localhost?** Guard SSRF menolak target privat/loopback secara default. Untuk development melawan instance lokal, set `ALLOW_PRIVATE_TARGETS=true` di `.env` — **jangan pernah** di produksi.

## Skrip

| Perintah | Fungsi |
|---|---|
| `bun run dev` | Dev server di port 3000 |
| `bun run lint` | ESLint |
| `bun run typecheck` | `prisma generate` + `tsc --noEmit` |
| `bun run db:push` | Sinkronkan schema → database |
| `bun run db:generate` | Regenerasi client Prisma |
| `bun run db:studio` | Prisma Studio (lihat/edit data) |
| `bun run build` / `bun run start` | Build & jalankan produksi |

## Verifikasi cepat

```bash
curl -s http://localhost:3000/api/healthz
# {"ok":true,"db":true}

curl -s -X POST http://localhost:3000/api/controller/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<ADMIN_PASSWORD>"}' -i | rg -i "set-cookie|HTTP/"
```

Berhasil bila `HTTP/1.1 200` + `Set-Cookie: controller_token=…` (HttpOnly). Lihat [CONTROLLER-API.md](CONTROLLER-API.md) untuk seluruh permukaan API.
