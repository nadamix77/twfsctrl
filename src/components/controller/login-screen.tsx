'use client'

import { useCallback, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SecretInput } from '@/components/shared/secret-input'
import { XLogo } from '@/components/shared/x-logo'
import { useCountdown } from '@/hooks/use-countdown'
import { formatMmSs } from '@/lib/core/format'
import { SECOND_MS } from '@/lib/core/time-constants'
import type { ControllerLoginResult } from '@/hooks/use-controller-session'

// ============================================================
// login-screen.tsx — Controller login (PRD §11.1 screen 1)
//
// Full-screen single password field with controller branding.
// The 429 lockout arms a countdown (M:SS, the admin-login idiom);
// there is no "forgot password" — the credential is the
// ADMIN_PASSWORD env var, and the hint says so.
// ============================================================

interface LoginScreenProps {
  onLogin: (password: string) => Promise<ControllerLoginResult>
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The 429 lockout deadline (epoch ms; null = none) — every 429 arms a
   *  fresh epoch so repeated lockouts can never dead-arm the countdown. */
  const [lockoutDeadline, setLockoutDeadline] = useState<number | null>(null)
  const lockoutRemaining = useCountdown(lockoutDeadline)

  const handleSubmit = useCallback(async () => {
    // Enter (and auto-repeat) must not double-submit or re-arm the lockout —
    // the same closure guards as the admin login dialog.
    if (submitting) return
    if (lockoutRemaining > 0) return
    if (!password.trim()) {
      setError('Password tidak boleh kosong')
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await onLogin(password)
    if (result.error != null) {
      setError(result.error)
      setLockoutDeadline(
        result.retryAfterSec != null ? Date.now() + result.retryAfterSec * SECOND_MS : null,
      )
    }
    // On success the shell flips to the dashboard and unmounts this screen.
    setSubmitting(false)
  }, [onLogin, password, submitting, lockoutRemaining])

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-sm"
      >
        <Card className="py-0">
          <CardContent className="flex flex-col gap-5 px-6 py-8">
            {/* Brand block */}
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-cerah-surface-2">
                <XLogo className="size-7 text-ink" />
              </span>
              <div>
                <h1 className="text-lg font-bold tracking-[-0.01em] text-ink">Tweetfess Controller</h1>
                <p className="text-sm text-ink-2">Panel multi-instance untuk menfess</p>
              </div>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void handleSubmit()
              }}
            >
              <div className="flex flex-col gap-2">
                <label htmlFor="controller-password" className="text-sm font-medium text-ink">
                  Password
                </label>
                <SecretInput
                  id="controller-password"
                  value={password}
                  onChange={(value) => { setPassword(value) }}
                  placeholder="Password controller..."
                  reveal={reveal}
                  onRevealChange={setReveal}
                  autoComplete="current-password"
                />
                {error != null && (
                  <p className="m-0 text-sm text-cerah-red" role="alert">
                    {error}
                  </p>
                )}
                {lockoutRemaining > 0 && (
                  <p className="m-0 text-sm font-semibold text-cerah-amber-strong [font-variant-numeric:tabular-nums]">
                    Coba lagi dalam {formatMmSs(lockoutRemaining)}
                  </p>
                )}
              </div>
              <Button type="submit" disabled={submitting || lockoutRemaining > 0} className="w-full">
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting ? 'Memproses...' : 'Masuk'}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-xs text-ink-3">
          Password diatur lewat <code className="font-mono">ADMIN_PASSWORD</code> di server.
        </p>
      </motion.div>
    </main>
  )
}
