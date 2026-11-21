'use client'

import { MotionConfig } from 'framer-motion'
import { TriangleAlert } from 'lucide-react'
import { useControllerSession } from '@/hooks/use-controller-session'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { XLogo } from '@/components/shared/x-logo'
import { LoginScreen } from './login-screen'
import { Dashboard } from './dashboard'

// ============================================================
// controller-app.tsx — the controller shell / session gate
//
// MotionConfig respects prefers-reduced-motion (the admin shell
// idiom). The gate: boot spinner → session check →
//   configured:false → setup notice (env vars to set on the host)
//   authenticated:false → login screen
//   else → Dashboard (which owns overview + queue + dialogs)
// ============================================================

const SETUP_ENV_VARS = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY'] as const

export function ControllerApp() {
  const { session, loading, login, logout, refresh } = useControllerSession()

  return (
    <MotionConfig reducedMotion="user">
      {loading ? (
        <main className="flex flex-1 items-center justify-center px-4">
          <div className="flex flex-col items-center gap-3">
            <div className="size-8 animate-spin rounded-full border-2 border-ink border-t-transparent" />
            <p className="text-sm text-ink-2">Memeriksa sesi...</p>
          </div>
        </main>
      ) : session === null ? (
        // The session probe itself failed (network down / route missing).
        <main className="flex flex-1 items-center justify-center px-4">
          <Card className="max-w-sm py-0">
            <CardContent className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl border border-cerah-amber-line bg-cerah-amber-soft">
                <TriangleAlert className="size-6 text-cerah-amber-strong" />
              </span>
              <h1 className="text-base font-bold text-ink">Tidak dapat menghubungi server</h1>
              <p className="m-0 text-sm text-ink-2">
                Sesi controller tidak dapat diperiksa. Periksa koneksi lalu coba lagi.
              </p>
              <Button onClick={() => { void refresh() }} className="mt-1">
                Coba lagi
              </Button>
            </CardContent>
          </Card>
        </main>
      ) : !session.configured ? (
        // Env-var setup notice — the app refuses to run half-configured.
        <main className="flex flex-1 items-center justify-center px-4">
          <Card className="max-w-md py-0">
            <CardContent className="flex flex-col items-center gap-4 px-6 py-8 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-cerah-surface-2">
                <XLogo className="size-7 text-ink" />
              </span>
              <div>
                <h1 className="text-lg font-bold text-ink">Controller belum dikonfigurasi</h1>
                <p className="mt-1 m-0 text-sm text-ink-2">
                  Atur variabel lingkungan berikut di server, lalu muat ulang halaman ini:
                </p>
              </div>
              <ul className="m-0 flex list-none flex-col gap-1.5 rounded-lg border border-line bg-cerah-surface-2 p-3 text-left">
                {SETUP_ENV_VARS.map((envVar) => (
                  <li key={envVar} className="font-mono text-xs text-ink">{envVar}</li>
                ))}
              </ul>
              <p className="m-0 text-xs text-ink-3">
                Contoh (key enkripsi): <code className="font-mono">openssl rand -hex 32</code>
              </p>
            </CardContent>
          </Card>
        </main>
      ) : !session.authenticated ? (
        <LoginScreen onLogin={login} />
      ) : (
        <Dashboard onLogout={logout} onSessionExpired={refresh} />
      )}
    </MotionConfig>
  )
}
