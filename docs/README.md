# Dokumentasi Tweetfess Controller

Dokumentasi untuk **Tweetfess Controller** — panel kontrol multi-instance untuk deployment Tweetfess. Satu operator, banyak instance, satu dashboard.

## Indeks

| Jika ingin… | Baca |
|---|---|
| Memahami produk & keputusan desain | [PRD-CONTROLLER.md](PRD-CONTROLLER.md) |
| Menjalankan controller pertama kali | [SETUP.md](SETUP.md) |
| Mengonfigurasi variabel environment | [CONFIGURATION.md](CONFIGURATION.md) |
| Memahami arsitektur & struktur kode | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Memanggil API controller (curl/integrasi) | [CONTROLLER-API.md](CONTROLLER-API.md) |
| Tahu endpoint instance yang dibutuhkan | [INSTANCE-API.md](INSTANCE-API.md) |
| Memahami skema database | [DATA-MODEL.md](DATA-MODEL.md) |
| Memahami model keamanan | [SECURITY.md](SECURITY.md) |
| Mengoperasikan sehari-hari (tambah instance, moderasi, audit) | [USAGE.md](USAGE.md) |
| Deploy ke produksi | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Memperbaiki masalah | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| Melihat keputusan arsitektur | [adr/](adr/) |

## Sekilas

- **Stack:** Next.js 16 (App Router) + TypeScript 5 + Prisma 6 + PostgreSQL (Supabase produksi / embedded Postgres lokal) + Tailwind CSS 4 + shadcn/ui
- **Peran:** orchestrator tipis read-mostly — instance tetap sumber kebenaran; controller hanya menyimpan registry instance + log audit
- **Integrasi:** API admin instance (`/api/admin/*`, `/api/submissions`) dengan Bearer token — [INSTANCE-API.md](INSTANCE-API.md)
- **Bahasa UI:** Indonesia (konsisten dengan admin instance), istilah teknis tetap Inggris

## Konvensi dokumen

- Kode dan identifier teknis dalam bahasa Inggris; copy UI dalam bahasa Indonesia.
- Referensi FR-xx / NFR-xx mengacu pada pasal di [PRD-CONTROLLER.md](PRD-CONTROLLER.md).
- Referensi ADR-xxx mengacu pada berkas di [adr/](adr/).
