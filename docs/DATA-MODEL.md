# DATA-MODEL — Skema Database Controller

Sumber kebenaran: `prisma/schema.prisma`. Controller sengaja hanya memiliki **tiga model** — registry instance, kredensial terenkripsi, dan audit. Tidak ada submissions, settings, atau data end-user ([PRD §6.2](PRD-CONTROLLER.md#62-core-design-rules): instance adalah sumber kebenaran).

## ERD

```
┌──────────────────┐        ┌────────────────────────┐
│ Instance         │ 1───1  │ InstanceCredential     │
├──────────────────┤        ├────────────────────────┤
│ id        cuid PK│        │ instanceId  PK, FK ────┼─► Instance.id (Cascade)
│ name      unique │        │ encryptedSecret string │  AES-256-GCM "iv:authTag:ciphertext"
│ baseUrl   unique │        │ updatedAt   DateTime   │
│ handle    ?      │        └────────────────────────┘
│ colorTag  ?      │
│ enabled   bool   │        ┌────────────────────────┐
│ sortOrder int    │ 1───*  │ AuditLog               │
│ createdAt        ├───────►├────────────────────────┤
│ updatedAt        │        │ id          cuid PK    │
└──────────────────┘        │ instanceId  ? FK ──────┼─► Instance.id (SetNull)
                            │ instanceName ? string  │  denormalized — riwayat
                            │ action      string     │  tetap terbaca setelah hapus
                            │ targetId    ? string   │
                            │ outcome     string     │
                            │ detail      ? string   │
                            │ actorIp     string     │
                            │ createdAt   DateTime   │  @@index([createdAt])
                            └────────────────────────┘  @@index([instanceId, createdAt])
```

## Model

### Instance

Baris registry. `baseUrl` ternormalisasi (`https://host[:port]`, tanpa trailing slash, tanpa path) dan unik — mencegah instance sama terdaftar dua kali (E9). `sortOrder` mengatur urutan kartu/antrean. `handle` + `colorTag` hanya tampilan.

### InstanceCredential

Satu-ke-satu dengan Instance. `encryptedSecret` = password admin instance terenkripsi AES-256-GCM (`ENCRYPTION_KEY`), format `iv:authTag:ciphertext`. Write-only — tidak pernah keluar via API. `onDelete: Cascade` — hapus instance menghapus kredensialnya.

### AuditLog

Append-only. `instanceId` nullable (`null` = aksi level controller, mis. `controller.login`) dengan `onDelete: SetNull` + `instanceName` denormalized — riwayat audit tetap terbaca setelah instance dihapus. **Tidak ada isi submission** (FR-F2) — `targetId` hanya id, `detail` hanya error string/outcome. Retensi 90 hari (bersih otomatis saat dibaca).

Nilai `action` yang dipakai implementasi:

| action | Pemicu |
|---|---|
| `controller.login` | login operator (success/error) |
| `instance.create` / `instance.update` / `instance.delete` | mutasi registry |
| `instance.enable` / `instance.disable` | toggle enabled |
| `instance.test` | tes koneksi dari form |
| `instance.requeue` / `instance.breaker-reset` / `instance.clear-cache` | aksi cepat |
| `submission.approve` / `.reject` / `.retry` / `.refund` / `.delete` | aksi antrean (targetId = id submission instance) |

## State di luar database

**Token cache in-memory** `{ instanceId → { token, expiresAt } }` — token admin instance hasil login, TTL 7 hari, diinvalidasi oleh 401 (re-login sekali) dan pergantian password. Tidak dipersist (NFR-S2); restart proses mengosongkannya dengan aman.

## Portabilitas provider

Schema berjalan di **PostgreSQL** (produksi: Supabase; lokal: service Postgres embedded). Tanpa enum Prisma dan tanpa raw SQL by design — bila suatu deployment butuh provider lain (mis. kembali ke SQLite untuk demo tanpa server DB), perpindahannya hanya:

1. `datasource db.provider` di `prisma/schema.prisma`
2. `DATABASE_URL` sesuai provider
3. `bun run db:push`

Data tidak ikut pindah otomatis — ekspor/impor manual bila perlu.
