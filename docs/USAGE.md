# USAGE — Panduan Operator

Hari ke hari di balik panel. Setup awal: [SETUP.md](SETUP.md). Semua istilah tombol mengikuti UI (Bahasa Indonesia).

## Login

Satu field password (`ADMIN_PASSWORD`). Salah 5× dalam 15 menit → terkunci 30 menit dengan hitung mundur di layar. Tidak ada "lupa password" — kredensial ada di env host; atur ulang di sana bila perlu.

## Dashboard

Dua area: **Instance** (grid kartu) dan **Antrean Moderasi**. Header agregat: total pending, instance hidup, pendapatan hari ini, jumlah submitter. Data menyegar otomatis tiap 60 s selama tab terlihat; tombol **Muat ulang data** memaksa refresh.

### Status kartu instance

| Badge | Arti | Tindakan |
|---|---|---|
| hijau (`ok`) | Semua panggilan berhasil | — |
| kuning `auth-failed` | Password instance salah/berubah | **Edit instance** → isi ulang password |
| kuning `locked-out` | Login instance terkunci (429) | Tunggu hitung mundur — controller menolak mencoba sebelumnya habis |
| merah `down` | Timeout/DNS/5xx | Data terakhir tampil redup + timestamp; pulih otomatis di siklus berikutnya |
| abu-abu `nonaktif` | Instance dinonaktifkan di registry | Aktifkan lewat menu kartu bila perlu |

Kartu menautkan langsung ke `/admin` instance (tab baru) untuk hal yang tidak dikerjakan controller (settings, dsb.).

## Menambah instance

1. **Tambah Instance** → isi **Nama** (unik), **URL Instance** (`https://host`), **Password Admin Instance**, opsional handle X & warna.
2. **Test Koneksi** — controller mencoba login + membaca sesi instance; hasil muncul inline (mis. "Terhubung — 5 pending" atau error instance apa adanya).
3. Simpan. Instance langsung masuk fan-out.

Catatan: mengubah password di form edit — kosongkan field untuk mempertahankan yang lama, isi untuk mengganti.

## Menonaktifkan / menghapus

- **Nonaktifkan** (menu kartu): keluar dari fan-out & antrean, tetap di registry (abu-abu) — cocok untuk instance istirahat/maintenance.
- **Hapus**: konfirmasi dengan mengetik nama instance. Hanya menghapus dari registry controller — **tidak menyentuh data instance apa pun**. Entri audit terakhir dicatat.

## Moderasi dari antrean terpadu

Baris dari semua instance enabled bergabung, terbaru dulu. Filter: tab status (Semua / Menunggu / Disensor / Gagal Posting / Ditolak), chip instance, dan kotak cari (pesan/username — diteruskan ke pencarian tiap instance). **Muat lagi** memuat halaman berikutnya per instance. Tab **Ditolak** tidak dihitung di "Semua" (Semua = status reviewable saja); gunakan tab itu untuk mengembalikan poin pesan berbayar yang sudah ditolak (FR-D8).

Aksi per baris (satu per satu — tidak ada bulk moderasi di v1):

| Tombol | Efek di instance | Hasil yang mungkin |
|---|---|---|
| **Setujui** | `PATCH …/submissions/[id] {"status":"approved"}` | `auto-posted` (link tweet) · `queued` (ditunda, pesan instance) · `error` (disetujui tapi posting gagal — baris tetap tampil) |
| **Tolak** | `{"status":"rejected"}` | + hasil `refund` bila instance melampirkannya (`refunded`/`no-spend`/`over-balance`) |
| **Coba Lagi** | `POST …/post` | untuk baris `post_failed`/`pending` |
| **Kembalikan Poin** | `POST …/refund` | hanya baris rejected |
| **Hapus** (menu ⋯) | `DELETE …/submissions/[id]` | konfirmasi dulu; `409` bila masih `posting`/sudah `posted` (pesan instance apa adanya) |

Semua pesan sukses/gagal instance ditampilkan **apa adanya** (pass-through) — sumber kebenaran copy tetap instance. Konflik status (`409` CAS) me-refresh baris dengan status terkini — tidak pernah diam-diam.

Baris instance yang `down`/`auth-failed`/`locked-out` tampil terkunci dengan timestamp terakhir berhasil; aksinya dinonaktifkan sampai pulih.

## Aksi cepat instance

Menu kartu (⋯): **Requeue post_failed** (bulk, hasil berapa baris masuk antrean), **Reset circuit breaker**, **Clear cache**. Semua berkonfirmasi, hasil instance tampil verbatim, dan ter-audit.

## Log audit

Menu akun (kanan atas) → **Log Audit**. Filter instance & jenis aksi, paginasi. Isi: aksi, instance, id target, outcome, IP, waktu — **tanpa isi pesan menfess** (konten hanya ada di instance). Retensi 90 hari.

## Kebiasaan yang disarankan

- Pantau badge kuning `auth-failed` — berarti password instance berubah; perbaiki secepatnya supaya antreannya kembali hidup.
- `locked-out` + hitung mundur panjang biasanya berarti password yang tersimpan salah dan lima percobaan login terjadi — jangan spam; perbaiki passwordnya.
- Sebelum maintenance instance, nonaktifkan dulu di controller agar antrean tidak berisik.
- Setelah rotasi `ADMIN_PASSWORD` sebuah instance, langsung perbarui di controller (edit instance, isi password baru).
