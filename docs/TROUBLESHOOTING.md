# TROUBLESHOOTING — Diagnosis Cepat

Gejala → penyebab → perbaikan. Lengkapnya model kegagalan: PRD §12; ancaman: [SECURITY.md](SECURITY.md).

## Tidak bisa login

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| Layar login menampilkan petunjuk setup, bukan form | `ADMIN_PASSWORD`/`SESSION_SECRET` belum diset | Isi `.env` → restart dev server |
| `503 Controller belum dikonfigurasi` (API) | Sama | Sama |
| "Password salah" | Salah kredensial | Pakai nilai `ADMIN_PASSWORD` persis |
| `429` + hitung mundur | 5× salah dalam 15 menit | Tunggu (30 menit) — atau restart dev server di lokal (limiter in-memory) |
| Semua sesi tiba-tiba logout | Password/secret dirotasi (redploy) | Login ulang — perilaku normal rotasi |

## Instance bermasalah (badge kartu)

| Badge | Penyebab umum | Perbaikan |
|---|---|---|
| `auth-failed` | Password instance berubah / salah saat daftar | Edit instance → isi password baru → Test Koneksi |
| `locked-out` (hitung mundur) | 5 login gagal ke instance (biasanya password salah yang tersimpan) | Perbaiki password; TUNGGU hitung mundur habis — controller menolak mencoba lebih dulu |
| `down` + timestamp | Instance mati / DNS / TLS / 5xx; atau instance tidak bisa dijangkau dari jaringan controller | Cek instance di browser; cek `healthz` instance; kartu pulih otomatis di siklus 60 s berikutnya |
| `down` tepat setelah deploy controller | Instance menolak IP baru / firewall | Pastikan instance menerima koneksi dari egress deployment controller |

## Test koneksi gagal

- "login endpoint tidak ditemukan" / 404 → URL bukan instance Tweetfess, atau path berbeda — verifikasi `{baseUrl}/api/admin/login` bisa diakses.
- `status: 0` → kegagalan jaringan (DNS mati, TLS gagal, instance down).
- Error SSRF ("URL tidak diizinkan" dsb.) → target privat/loopback ditolak guard. Untuk development lokal: `ALLOW_PRIVATE_TARGETS=true`. Di produksi: jangan.
- Terhubung tapi kartu tetap `down` → cek apakah instance memblokir user-agent/bearer dari server (mis. WAF).

## Antrean / aksi

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| Baris tidak hilang setelah Setujui | Instance menjawab `queued` (ditunda) atau `error` (posting gagal) — baris sengaja tetap tampil | Baca toast hasil; baris `post_failed` bisa **Coba Lagi** |
| "Status submission telah berubah" (409) | Moderasi balapan dengan autopost instance (CAS) | Baris ter-refresh otomatis dengan status terkini — tinjau ulang |
| "circuit breaker aktif" (503) saat approve | Breaker instance sedang pause | Tunggu, atau aksi cepat **Reset circuit breaker** di kartu |
| Aksi tombol disabled semua | Instance `down`/`auth-failed`/`locked-out` (FR-D11) | Pulihkan kesehatan instance dulu |
| Gambar thumbnail tidak muncul | Media instance gagal / sudah dihapus | Klik ulang (route proxy me-refresh); cek `502` di Network tab |

## Error startup / build

| Gejala | Perbaikan |
|---|---|
| `ENCRYPTION_KEY must be 64 hex characters` | `openssl rand -hex 32` — kunci wajib 64 karakter hex |
| Error Prisma "URL must start with postgresql://" saat perintah manual | Environment proses menyuntikkan `DATABASE_URL` basi (path SQLite) yang mengalahkan `.env` — jalankan lewat `bash scripts/with-env.sh <cmd>` atau `export` dulu nilai dari `.env` |
| `db/controller.db` tidak ada / tabel hilang | Tidak berlaku lagi (era SQLite) — sekarang: pastikan service Postgres jalan, lalu `bun run db:push` |
| Font error saat dev setelah perubahan layout | Restart dev server (cache Turbopack) |
| Tidak bisa konek DB produksi | Cek `DATABASE_URL` memakai URI pooler Supabase (`?pgbouncer=true&connection_limit=1` di Vercel) — lihat [DEPLOYMENT.md](DEPLOYMENT.md) |

## Kesehatan cepat

```bash
curl -s https://panel.example.com/api/healthz
# {"ok":true,"db":true}   → panel hidup, DB terjangkau
# {"ok":true,"db":false}  → panel hidup, DB bermasalah (cek connection string)
```

Log audit (`controller.login` ber-outcome `error` beruntun) = indikasi percobaan login jahat — cek IP di viewer audit.
