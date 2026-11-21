// ============================================================
// config.ts — Controller environment configuration
// (PRD-CONTROLLER.md §9 environment variables)
//
// This standalone repo owns its env names without a prefix
// (ADR-016 addendum):
//   ADMIN_PASSWORD  — login credential (required, no default)
//   SESSION_SECRET  — HMAC key for controller tokens
//   ENCRYPTION_KEY  — AES-256-GCM key for instance passwords
//   DATABASE_URL    — controller database (Prisma schema)
//   ALLOW_PRIVATE_TARGETS — SSRF-guard override (FR-B8),
//     for local development against a localhost instance
// ============================================================

/** Controller login password. null = not configured (login disabled
 *  with a setup hint — the app still boots so the operator sees the
 *  instruction instead of a hard crash). */
export function getControllerAdminPassword(): string | null {
  const value = process.env.ADMIN_PASSWORD
  return value && value.length > 0 ? value : null
}

/** HMAC key for controller session tokens. null = not configured. */
export function getControllerSessionSecret(): string | null {
  const value = process.env.SESSION_SECRET
  return value && value.length > 0 ? value : null
}

/** True when the controller can issue/verify sessions at all. */
export function isControllerAuthConfigured(): boolean {
  return getControllerAdminPassword() !== null && getControllerSessionSecret() !== null
}

/** AES-256 key material (32 bytes) from ENCRYPTION_KEY.
 *  Throws with a generation hint when unset/malformed — the controller
 *  REFUSES to store credentials unencrypted (stricter than the instance
 *  app's {PLAINTEXT} fallback; PRD FR-B6). */
export function getControllerEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256). ' +
        'Generate one with: openssl rand -hex 32',
    )
  }
  return Buffer.from(hex, 'hex')
}

/** SSRF-guard override (FR-B8): when true, private/loopback targets,
 *  plain http, and non-443 ports are accepted — for local development
 *  against a localhost instance. Production stays false. */
export function allowPrivateInstanceTargets(): boolean {
  return process.env.ALLOW_PRIVATE_TARGETS === 'true'
}
