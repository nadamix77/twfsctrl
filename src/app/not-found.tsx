import Link from 'next/link'

// The controller is a single-route app (`/`); every other path is a
// genuine 404. Absolute title — the root layout defines no template.
export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-cerah-bg px-4">
      <h1 className="text-4xl font-bold text-ink mb-2">404</h1>
      <p className="text-ink-2 mb-6">Halaman tidak ditemukan</p>
      <Link
        href="/"
        className="bg-ink hover:bg-ink-hover text-white px-6 py-2 rounded-lg text-sm font-medium"
      >
        Kembali ke Panel Kontrol
      </Link>
    </main>
  )
}
