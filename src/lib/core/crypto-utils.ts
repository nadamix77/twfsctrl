import crypto from 'crypto'

/** Timing-safe string comparison to prevent timing side-channel attacks.
 *
 *  Both buffers are padded to equal length so crypto.timingSafeEqual always
 *  runs, then we check length separately — the && short-circuit is safe
 *  because by that point the time cost is already paid by crypto.timingSafeEqual.
 *
 *  This pattern handles inputs of any length without throwing. Note: the
 *  comparison cost is proportional to max(a.length, b.length), so an attacker
 *  probing with tokens of increasing length could observe a timing knee at
 *  ~expected_length. This is not exploitable for fixed-length HMAC tokens
 *  (admin_token, cron secret), but callers should not rely on length secrecy
 *  for variable-length secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  const maxLen = Math.max(bufA.length, bufB.length)
  const paddedA = Buffer.concat([bufA, Buffer.alloc(maxLen - bufA.length)])
  const paddedB = Buffer.concat([bufB, Buffer.alloc(maxLen - bufB.length)])
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length
}

/** Hex SHA-256 digest — the token-fingerprint idiom shared by the
 *  refresh keeper's change detector (goid-refresh) and the merchant
 *  cache's token key (gobiz-client). Stores and compares only the
 *  fingerprint, never the secret itself. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}
