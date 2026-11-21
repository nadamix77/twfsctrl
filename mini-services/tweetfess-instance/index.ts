// ============================================================
// tweetfess-instance — Instance API contract simulator
// (docs/INSTANCE-API.md, the source of truth for every endpoint
// the Controller consumes)
//
// Purpose: E2E-verify the Tweetfess Controller against a faithful
// instance. Implements exactly the endpoints the Controller calls:
//
//   POST   /api/admin/login                      (ADR-002 HMAC token)
//   GET    /api/admin/session                    (stats.pending probe)
//   GET    /api/submissions?status&page&limit&search
//   PATCH  /api/submissions/:id                  (approve / reject)
//   PUT    /api/submissions/:id                  (edit message text)
//   DELETE /api/submissions/:id
//   POST   /api/submissions/:id/post             (retry)
//   POST   /api/submissions/:id/refund
//   POST   /api/submissions/:id/censor           (region image censor)
//   POST   /api/admin/submissions/requeue        (quick action)
//   POST   /api/admin/circuit-breaker/reset      (quick action)
//   POST   /api/admin/clear-cache                (quick action)
//   GET    /api/admin/submitters                 (registry: search + pagination)
//   POST   /api/admin/submitters/block|unblock   (block auto-rejects pending)
//   POST/DELETE /api/admin/submitters/whitelist
//   POST/DELETE /api/admin/submitters/image-post-allowlist
//   PATCH  /api/admin/submitters/overrides       (limits + pricing families)
//   POST   /api/admin/submitters/points-adjust   (admin_adjust ledger)
//   GET    /api/admin/payments                   (orders + revenue + GoBiz)
//   POST   /api/admin/payments/[id]/confirm|void
//   POST   /api/admin/payments/ambiguous/[refId]/dismiss
//   GET/POST/DELETE /api/admin/settings          (scalar; masked on GET)
//   GET/POST /api/admin/filter-settings          (batched groups)
//   GET    /api/admin/ai-status | ai-stats
//   GET    /api/admin/analytics                  (WIB-window trends)
//   GET    /api/media/:id                        (auth-gated, ETag)
//   GET    /api/dev/state                        (admin auth; test introspection)
//
// Faithful behaviors:
//   - HMAC admin tokens `<hmacHex>.<expiresAtHexSeconds>`, 7-day TTL,
//     cookie `admin_token` (HttpOnly, SameSite=Strict) AND Bearer.
//   - Origin guard on state-changing methods (OWASP: Origin or Referer
//     must match the request Host — header-less POSTs are rejected 403).
//   - Login rate limit: 5 failed attempts / 15 min / IP -> 30-min
//     lockout answering 429 + Retry-After.
//   - Instance response bodies verbatim from docs/INSTANCE-API.md.
// ============================================================

import crypto from 'node:crypto'
import zlib from 'node:zlib'

const PORT = 3010
const ADMIN_PASSWORD = process.env.INSTANCE_ADMIN_PASSWORD ?? 'twfs-sim-password'
const TOKEN_TTL_SEC = 7 * 86_400

// ── ADR-002 HMAC admin token ─────────────────────────────────

const TOKEN_KEY = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest()

function generateToken(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC
  const expiresHex = expiresAt.toString(16)
  const hmac = crypto.createHmac('sha256', TOKEN_KEY).update(expiresHex).digest('hex')
  return `${hmac}.${expiresHex}`
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) {
    // burn a comparison anyway to keep timing flat
    crypto.timingSafeEqual(ba, ba)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

function verifyToken(token: string | null): boolean {
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot === -1) return false
  const hmac = token.slice(0, dot)
  const expiresHex = token.slice(dot + 1)
  const expiresAt = parseInt(expiresHex, 16)
  if (isNaN(expiresAt) || expiresAt * 1000 < Date.now()) return false
  const expected = crypto.createHmac('sha256', TOKEN_KEY).update(expiresHex).digest('hex')
  return timingSafeEqual(hmac, expected)
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const cookie = req.headers.get('cookie')
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === 'admin_token') return v.join('=')
    }
  }
  return null
}

// ── Origin guard (state-changing methods) ────────────────────

function originOk(req: Request): boolean {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')
  const host = req.headers.get('host')
  if (!host) return false
  let source: URL | null = null
  if (origin) {
    try { source = new URL(origin) } catch { return false }
  } else if (referer) {
    try { source = new URL(referer) } catch { return false }
  }
  if (!source) return false
  return source.host === host
}

// ── Login rate limit: 5 fails / 15 min / IP -> 30-min lockout ─

interface AttemptLedger { fails: number[]; lockedUntil: number }
const ledgers = new Map<string, AttemptLedger>()
const FAIL_WINDOW_MS = 15 * 60_000
const LOCKOUT_MS = 30 * 60_000

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1'
  )
}

function consumeLoginAttempt(ip: string): { allowed: boolean; retryAfterSec: number | null } {
  const now = Date.now()
  const ledger = ledgers.get(ip) ?? { fails: [], lockedUntil: 0 }
  ledger.fails = ledger.fails.filter((t) => now - t < FAIL_WINDOW_MS)
  if (ledger.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((ledger.lockedUntil - now) / 1000) }
  }
  ledgers.set(ip, ledger)
  return { allowed: true, retryAfterSec: null }
}

function recordLoginFail(ip: string): number | null {
  const now = Date.now()
  const ledger = ledgers.get(ip) ?? { fails: [], lockedUntil: 0 }
  ledger.fails = ledger.fails.filter((t) => now - t < FAIL_WINDOW_MS)
  ledger.fails.push(now)
  if (ledger.fails.length >= 5) {
    ledger.lockedUntil = now + LOCKOUT_MS
    ledger.fails = []
  }
  ledgers.set(ip, ledger)
  return ledger.lockedUntil > now ? Math.ceil((ledger.lockedUntil - now) / 1000) : null
}

function clearLoginFails(ip: string): void {
  ledgers.delete(ip)
}

// ── Seed data (realistic Indonesian menfess content) ─────────

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()

interface Submitter {
  id: string
  username: string
  displayName: string
  profileImage: string | null
  twitterId: string
}

interface Submission {
  id: string
  message: string
  status: 'pending' | 'censored' | 'posting' | 'post_failed' | 'rejected' | 'posted'
  tweetId: string | null
  postMethod: string | null
  postError: string | null
  filterReasons: string[] | null
  imageUrl: string | null
  imageSha256: string | null
  nsfwStatus: string | null
  paidPost: boolean
  refundedAt: string | null
  createdAt: string
  updatedAt: string
  submitter: Submitter & { limits: Record<string, unknown> }
}

function submitter(
  id: string,
  username: string,
  displayName: string,
  twitterId: string,
): Submitter & { limits: Record<string, unknown> } {
  return {
    id,
    username,
    displayName,
    profileImage: null,
    twitterId,
    limits: {
      dailyCap: 20,
      dailyUsed: 3,
      pendingCap: 5,
      pendingUsed: 1,
      postCap: 5,
      postUsed: 2,
      isWhitelisted: false,
      isBanned: false,
      isCustom: false,
    },
  }
}

const submissions: Submission[] = [
  {
    id: 'sub_pending_1',
    message:
      'hai, mau curcol sedikit. kemarin aku ketemu mantan di mall dan dia pura-pura gak kenal aku. sakit banget ternyata :(',
    status: 'pending',
    tweetId: null,
    postMethod: null,
    postError: null,
    filterReasons: null,
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(180),
    submitter: submitter('usr_budi', 'budi_setiawan', 'Budi Setiawan', '881001'),
  },
  {
    id: 'sub_pending_2',
    message:
      'numpang promosi bakso pak rt deket kampus, ramenya anget, harganya masih 15rb. dukung usaha kecil ya!',
    status: 'pending',
    tweetId: null,
    postMethod: null,
    postError: null,
    filterReasons: null,
    imageUrl: 'http://localhost:3010/api/media/sub_pending_2',
    imageSha256: 'b7f3a9c2d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9',
    nsfwStatus: 'approved',
    paidPost: true,
    refundedAt: null,
    createdAt: minutesAgo(95),
    updatedAt: minutesAgo(95),
    submitter: submitter('usr_sari', 'sari_bakso', 'Sari Bakso Keju', '881002'),
  },
  {
    id: 'sub_censored_1',
    message: 'buruan daftar slot gacor malam ini, maxwin terus, cek bio ya guys!!1!',
    status: 'censored',
    tweetId: null,
    postMethod: null,
    postError: null,
    filterReasons: ['blocked_word:judol', 'caps_ratio'],
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(70),
    updatedAt: minutesAgo(70),
    submitter: submitter('usr_promo', 'akun_promo77', 'Promo Dadakan', '881003'),
  },
  {
    id: 'sub_censored_2',
    message: 'KENAPA SIH DIA GAK BALES CHAT AKU PADAHAL DIA ONLINE TERUS HUHU',
    status: 'censored',
    tweetId: null,
    postMethod: null,
    postError: null,
    filterReasons: ['all_caps'],
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'flagged',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(45),
    updatedAt: minutesAgo(45),
    submitter: submitter('usr_rina', 'rina_mel', 'Rina Meliana', '881004'),
  },
  {
    id: 'sub_failed_1',
    message: 'selamat ulang tahun buat sahabatku yang sekarang udah jauh di sana. semoga sehat selalu ya.',
    status: 'post_failed',
    tweetId: null,
    postMethod: 'direct',
    postError:
      'Gagal posting ke X: 401 Unauthorized. Cek X Settings lalu klik "Post to X" untuk retry.',
    filterReasons: null,
    imageUrl: 'http://localhost:3010/api/media/sub_failed_1',
    imageSha256: 'c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a',
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(25),
    updatedAt: minutesAgo(20),
    submitter: submitter('usr_agus', 'agus_pratama', 'Agus Pratama', '881005'),
  },
  {
    id: 'sub_posted_1',
    message: 'semangat buat yang lagi UTS minggu ini! jangan lupa istirahat dan minum air putih ya',
    status: 'posted',
    tweetId: '1798000111122223333',
    postMethod: 'direct',
    postError: null,
    filterReasons: null,
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(598),
    submitter: submitter('usr_dita', 'ditaaa', 'Dita Anjani', '881006'),
  },
  {
    id: 'sub_posted_2',
    message: 'hari ini aku nerima keputusan sulit dan walau berat rasanya lega. doakan ya',
    status: 'posted',
    tweetId: '1798000444455556666',
    postMethod: 'retry',
    postError: null,
    filterReasons: null,
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: true,
    refundedAt: null,
    createdAt: minutesAgo(430),
    updatedAt: minutesAgo(428),
    submitter: submitter('usr_budi', 'budi_setiawan', 'Budi Setiawan', '881001'),
  },
  {
    id: 'sub_posted_3',
    message: 'numpang pinjem katalho: buat yang nunggu hasil hari ini, semoga kabar baiknya nyampe sore ini',
    status: 'posted',
    tweetId: '1798000777788889999',
    postMethod: 'fallback',
    postError: null,
    filterReasons: null,
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(300),
    updatedAt: minutesAgo(298),
    submitter: submitter('usr_rina', 'rina_mel', 'Rina Meliana', '881004'),
  },
  {
    id: 'sub_rejected_1',
    message: 'beli follower murah cuma 50rb, dm ya',
    status: 'rejected',
    tweetId: null,
    postMethod: null,
    postError: null,
    filterReasons: ['blocked_word:jualfollowers'],
    imageUrl: null,
    imageSha256: null,
    nsfwStatus: 'approved',
    paidPost: false,
    refundedAt: null,
    createdAt: minutesAgo(900),
    updatedAt: minutesAgo(895),
    submitter: submitter('usr_spam', 'spamking99', 'Spam King', '881007'),
  },
]

// ── Submitters registry (per-status counts are synthetic history) ──

const hoursAgo = (h: number) => minutesAgo(h * 60)
const daysAgo = (d: number) => minutesAgo(d * 24 * 60)

interface SubmitterRecord {
  id: string
  username: string
  displayName: string
  profileImage: string | null
  twitterId: string
  customLimits: Record<string, number> | null
  customPricing: Record<string, number> | null
  createdAt: string
  counts: {
    total: number
    posted: number
    pending: number
    censored: number
    posting: number
    rejected: number
    postFailed: number
  }
  points: number
}

function submitterRecord(
  id: string,
  username: string,
  displayName: string,
  twitterId: string,
  createdAt: string,
  counts: SubmitterRecord['counts'],
  points: number,
  customLimits: Record<string, number> | null = null,
  customPricing: Record<string, number> | null = null,
): SubmitterRecord {
  return {
    id,
    username,
    displayName,
    profileImage: null,
    twitterId,
    customLimits,
    customPricing,
    createdAt,
    counts,
    points,
  }
}

const submitterRecords: SubmitterRecord[] = [
  submitterRecord('usr_budi', 'budi_setiawan', 'Budi Setiawan', '881001', daysAgo(60), { total: 12, posted: 8, pending: 1, censored: 2, posting: 0, rejected: 1, postFailed: 0 }, 12),
  submitterRecord('usr_sari', 'sari_bakso', 'Sari Bakso Keju', '881002', daysAgo(55), { total: 9, posted: 7, pending: 1, censored: 0, posting: 0, rejected: 1, postFailed: 0 }, 30),
  submitterRecord('usr_rina', 'rina_mel', 'Rina Meliana', '881004', daysAgo(50), { total: 6, posted: 3, pending: 0, censored: 2, posting: 0, rejected: 1, postFailed: 0 }, 0),
  submitterRecord('usr_agus', 'agus_pratama', 'Agus Pratama', '881005', daysAgo(45), { total: 14, posted: 9, pending: 0, censored: 1, posting: 0, rejected: 2, postFailed: 2 }, 5),
  submitterRecord('usr_dita', 'ditaaa', 'Dita Anjani', '881006', daysAgo(40), { total: 23, posted: 21, pending: 0, censored: 0, posting: 1, rejected: 1, postFailed: 0 }, 8, { submissionDailyCap: 50 }),
  submitterRecord('usr_spam', 'spamking99', 'Spam King', '881007', daysAgo(35), { total: 31, posted: 4, pending: 0, censored: 22, posting: 0, rejected: 5, postFailed: 0 }, 0),
  submitterRecord('usr_dimas', 'dimas_p', 'Dimas Prasetyo', '881008', daysAgo(30), { total: 11, posted: 10, pending: 0, censored: 0, posting: 0, rejected: 1, postFailed: 0 }, 4),
  submitterRecord('usr_neneng', 'neneng_t', 'Neneng Tika', '881009', daysAgo(25), { total: 3, posted: 1, pending: 0, censored: 1, posting: 0, rejected: 1, postFailed: 0 }, 2),
  submitterRecord('usr_jokowi', 'jokowi_fans', 'Penggemar Sejati', '881010', daysAgo(20), { total: 5, posted: 2, pending: 1, censored: 1, posting: 0, rejected: 1, postFailed: 0 }, 0),
]

const blocklist = new Map<string, { twitterId: string; reason: string | null }>()
blocklist.set('spamking99', { twitterId: '881007', reason: 'Spam berulang' })

const whitelist = new Set<string>(['ditaaa'])
const imageAllowlist = new Set<string>(['sari_bakso'])

const POINTS_BALANCE_CEILING = 10_000

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().toLowerCase().replace(/^@+/, '')
  return /^[a-z0-9_]{1,30}$/.test(name) ? name : null
}

function findSubmitter(username: string): SubmitterRecord | undefined {
  return submitterRecords.find((r) => r.username === username)
}

let newUserSeq = 0

function ensureSubmitter(username: string): SubmitterRecord {
  const existing = findSubmitter(username)
  if (existing) return existing
  newUserSeq++
  const record: SubmitterRecord = {
    id: `usr_new_${newUserSeq}`,
    username,
    displayName: username,
    profileImage: null,
    twitterId: '',
    customLimits: null,
    customPricing: null,
    createdAt: new Date().toISOString(),
    counts: { total: 0, posted: 0, pending: 0, censored: 0, posting: 0, rejected: 0, postFailed: 0 },
    points: 0,
  }
  submitterRecords.push(record)
  return record
}

function submitterPublicRow(r: SubmitterRecord): Record<string, unknown> {
  return {
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    profileImage: r.profileImage,
    twitterId: r.twitterId,
    customLimits: r.customLimits,
    customPricing: r.customPricing,
    createdAt: r.createdAt,
    totalSubmissions: r.counts.total,
    posted: r.counts.posted,
    pending: r.counts.pending,
    censored: r.counts.censored,
    posting: r.counts.posting,
    rejected: r.counts.rejected,
    postFailed: r.counts.postFailed,
    blocked: blocklist.has(r.username),
    whitelisted: whitelist.has(r.username),
    imageAllowed: imageAllowlist.has(r.username),
    points: r.points,
  }
}

// ── Orders / payments (Monetisasi tab) ───────────────────────

interface Order {
  id: string
  username: string
  purpose: 'topup' | 'unblock'
  points: number
  amountIdr: number
  status: 'pending' | 'paid' | 'expired'
  verifiedBy: string | null
  refId: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
}

const plus24h = (iso: string) => new Date(Date.parse(iso) + 24 * 3_600_000).toISOString()

const orders: Order[] = [
  { id: 'ord_001', username: 'dimas_p', purpose: 'topup', points: 10, amountIdr: 10122, status: 'paid', verifiedBy: 'gobiz', refId: 'gobiz:TXN100', expiresAt: plus24h(hoursAgo(3)), paidAt: hoursAgo(2), createdAt: hoursAgo(3) },
  { id: 'ord_002', username: 'neneng_t', purpose: 'topup', points: 20, amountIdr: 20244, status: 'pending', verifiedBy: null, refId: null, expiresAt: plus24h(minutesAgo(20)), paidAt: null, createdAt: minutesAgo(20) },
  { id: 'ord_003', username: 'budi_setiawan', purpose: 'unblock', points: 5, amountIdr: 5061, status: 'pending', verifiedBy: null, refId: null, expiresAt: plus24h(minutesAgo(40)), paidAt: null, createdAt: minutesAgo(40) },
  { id: 'ord_004', username: 'rina_mel', purpose: 'topup', points: 10, amountIdr: 10122, status: 'expired', verifiedBy: null, refId: null, expiresAt: daysAgo(2), paidAt: null, createdAt: daysAgo(3) },
  { id: 'ord_005', username: 'agus_pratama', purpose: 'topup', points: 5, amountIdr: 5061, status: 'paid', verifiedBy: 'admin', refId: 'gobiz:TXN045', expiresAt: plus24h(hoursAgo(30)), paidAt: hoursAgo(26), createdAt: hoursAgo(30) },
  { id: 'ord_006', username: 'jokowi_fans', purpose: 'topup', points: 5, amountIdr: 5061, status: 'pending', verifiedBy: null, refId: null, expiresAt: plus24h(minutesAgo(55)), paidAt: null, createdAt: minutesAgo(55) },
]

const claimedRefIds = new Set<string>(['gobiz:TXN100', 'gobiz:TXN045'])
const resolvedAmbiguous = new Set<string>()

const gobiz = {
  health: { lastSuccessAt: minutesAgo(5), lastFailureAt: null as string | null, consecutiveFailures: 0 },
  refresh: { configured: true, blockedUntil: null as string | null, consecutiveRejections: 0 },
  orphans: [{ refId: 'gobiz:TXN901', amountIdr: 10122, date: minutesAgo(35) }],
  ambiguous: [{ refId: 'gobiz:TXN777', amountIdr: 5061, date: minutesAgo(50) }],
  error: null as string | null,
}

function orderPublicRow(o: Order): Record<string, unknown> {
  return {
    id: o.id,
    username: o.username,
    purpose: o.purpose,
    points: o.points,
    amountIdr: o.amountIdr,
    status: o.status,
    verifiedBy: o.verifiedBy,
    refId: o.refId,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    createdAt: o.createdAt,
  }
}

function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Scalar admin settings (X / GoBiz credentials) ────────────

const VALID_SETTING_KEYS = [
  'x_cookie_string',
  'x_bearer_token',
  'twitterapi_keys',
  'twitterapi_proxy',
  'post_method',
  'x_username',
  'x_email',
  'x_password',
  'x_totp_secret',
  'twitterapi_login_cookie',
  'v2_login_enabled',
  'post_hashtags',
  'require_follow',
  'gobiz_session_token',
  'gobiz_refresh_token',
  'merchants_static_qris',
]

const settingsMap = new Map<string, { value: string; updatedAt: string }>()
const settingsSeed: Array<[string, string]> = [
  ['post_method', 'direct'],
  ['x_username', 'menfessku'],
  ['x_cookie_string', 'auth_token=abc123def456;ct0=xyz789ghi012'],
  ['post_hashtags', '#curcol #menfess'],
  ['require_follow', 'false'],
  ['gobiz_session_token', 'eyJhbGciOiJIUzI1NiJ9.simulated.token'],
  ['twitterapi_proxy', ''],
]
for (const [key, value] of settingsSeed) {
  settingsMap.set(key, { value, updatedAt: new Date(now).toISOString() })
}

function maskSettingValue(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`
}

// ── Filter settings (Settings tabs batch save) ───────────────

// Map (not Record) — computed-key access stays SAST-clean.
const filterSettings = new Map<string, unknown>(
  Object.entries({
    autoApprove: false,
    blockedWords: ['spam', 'judol'],
    nsfwWords: [],
    filterRules: { blockedWords: true, urls: true, capsRatio: true, allCaps: true, mentions: true, hashtags: true },
    aiEnabled: false,
    aiApiKeys: null,
    aiProviders: [],
    aiSystemPrompt: '',
    aiImageSystemPrompt: '',
    rateLimits: { submissionCooldown: 2, submissionDailyCap: 20, userPendingCap: 5, userPostDailyCap: 5, minAccountAgeDays: 0, minFollowers: 0, minTotalPosts: 0 },
    circuitBreaker: { circuitBreakerThreshold: 3, circuitBreakerCooldownMin: 30 },
    monetization: { pointsEnabled: true, pricePerPointIdr: 1000, topupBonusPercent: 10, unblockFeeIdr: 10000 },
    requireFollow: false,
    nsfwThresholds: { Porn: 0.25, Hentai: 0.25, Sexy: 0.5 },
    imagePostingMode: 'everyone',
    postingGuidelinesEnabled: true,
    postingGuidelines: { allowed: ['Curhat santai', 'Promosi usaha kecil'], notAllowed: ['SARA', 'Konten 18+'] },
  }),
)

const FILTER_GROUP_SNAKE = new Map<string, string>(
  Object.entries({
    autoApprove: 'auto_approve',
    blockedWords: 'blocked_words',
    nsfwWords: 'nsfw_words',
    filterRules: 'filter_rules',
    aiEnabled: 'ai_enabled',
    aiProviders: 'ai_providers',
    aiApiKeys: 'ai_api_keys',
    aiSystemPrompt: 'ai_system_prompt',
    aiImageSystemPrompt: 'ai_image_system_prompt',
    rateLimits: 'rate_limits',
    circuitBreaker: 'circuit_breaker',
    monetization: 'monetization',
    imagePostingMode: 'image_posting_mode',
    requireFollow: 'require_follow',
    postingGuidelinesEnabled: 'posting_guidelines_enabled',
    postingGuidelines: 'posting_guidelines',
    nsfwThresholds: 'nsfw_thresholds',
  }),
)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function validateFilterGroup(key: string, value: unknown): string | null {
  switch (key) {
    case 'autoApprove':
    case 'aiEnabled':
    case 'requireFollow':
    case 'postingGuidelinesEnabled':
      return typeof value === 'boolean' ? null : 'Tipe nilai tidak valid'
    case 'blockedWords':
    case 'nsfwWords':
      return Array.isArray(value) && value.every((w) => typeof w === 'string') ? null : 'Tipe nilai tidak valid'
    case 'filterRules':
    case 'aiApiKeys':
      return isPlainObject(value) ? null : 'Tipe nilai tidak valid'
    case 'aiProviders':
      return Array.isArray(value) ? null : 'Tipe nilai tidak valid'
    case 'aiSystemPrompt':
    case 'aiImageSystemPrompt':
      return typeof value === 'string' ? null : 'Tipe nilai tidak valid'
    case 'rateLimits':
    case 'circuitBreaker': {
      if (!isPlainObject(value)) return 'Tipe nilai tidak valid'
      for (const v of Object.values(value)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return 'Tipe nilai tidak valid'
      }
      return null
    }
    case 'monetization': {
      if (!isPlainObject(value)) return 'Tipe nilai tidak valid'
      for (const [k, v] of Object.entries(value)) {
        if (k === 'pointsEnabled') {
          if (typeof v !== 'boolean') return 'Tipe nilai tidak valid'
        } else if (typeof v !== 'number' || !Number.isFinite(v)) {
          return 'Tipe nilai tidak valid'
        }
      }
      const price = value.pricePerPointIdr
      if (typeof price === 'number' && (price < 100 || price > 1_000_000)) {
        return 'Nilai monetisasi di luar batas'
      }
      return null
    }
    case 'imagePostingMode':
      return value === 'everyone' || value === 'allowlist' || value === 'nobody' ? null : 'Mode gambar tidak valid'
    case 'postingGuidelines': {
      if (!isPlainObject(value)) return 'Tipe nilai tidak valid'
      const okList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
      return okList(value.allowed) && okList(value.notAllowed) ? null : 'Tipe nilai tidak valid'
    }
    case 'nsfwThresholds': {
      if (!isPlainObject(value)) return 'Tipe nilai tidak valid'
      for (const v of Object.values(value)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return 'Tipe nilai tidak valid'
      }
      return null
    }
    default:
      return 'Grup setting tidak dikenal'
  }
}

function derivedTwitterIds(usernames: Iterable<string>): string[] {
  const ids: string[] = []
  for (const username of usernames) {
    const record = findSubmitter(username)
    if (record) ids.push(record.twitterId)
  }
  return ids
}

function filterSettingsPublic(): Record<string, unknown> {
  const blockedTwitterIds: string[] = []
  for (const [username, entry] of blocklist) {
    blockedTwitterIds.push(findSubmitter(username)?.twitterId ?? entry.twitterId)
  }
  const apiKeys = filterSettings.get('aiApiKeys')
  const out: Record<string, unknown> = {
    ...Object.fromEntries(filterSettings),
    aiApiKeySet: !!apiKeys && typeof apiKeys === 'object' && Object.keys(apiKeys).length > 0,
    whitelistTwitterIds: derivedTwitterIds(whitelist),
    blockedTwitterIds,
    imagePostTwitterIds: derivedTwitterIds(imageAllowlist),
    defaults: { autoApprove: false, blockedWords: [], rateLimits: {}, monetization: {} },
  }
  delete out.aiApiKeys
  return out
}

// ── Per-user overrides (limits + pricing families) ───────────

const OVERRIDE_LIMIT_KEYS = [
  'submissionCooldown',
  'submissionDailyCap',
  'userPendingCap',
  'userPostDailyCap',
  'minAccountAgeDays',
  'minFollowers',
  'minTotalPosts',
]
const OVERRIDE_PRICING_KEYS = ['topupDiscountPercent', 'pointsPerSubmission', 'unblockFeeIdr']

function overridePricingValueOk(key: string, value: number): boolean {
  if (key === 'topupDiscountPercent') return value >= 0 && value <= 90
  if (key === 'pointsPerSubmission') return value >= 1 && value <= 100
  return value >= 1000 && value <= 499001 // unblockFeeIdr
}

type OverrideFamilyResult = { error: string } | { value: Record<string, number> | null }

function computeOverrideFamily(
  current: Record<string, number> | null,
  family: unknown,
  allowedKeys: readonly string[],
  valueOk: (key: string, value: number) => boolean,
  valueError: string,
): OverrideFamilyResult {
  if (family === undefined) return { value: current }
  if (family === null) return { value: null }
  if (!isPlainObject(family)) return { error: valueError }
  // Entries-based rewrite — no computed member writes (SAST idiom).
  const next: Array<[string, number]> = Object.entries(current ?? {})
  const dropEntry = (key: string) => {
    const idx = next.findIndex(([k]) => k === key)
    if (idx >= 0) next.splice(idx, 1)
  }
  for (const [key, raw] of Object.entries(family)) {
    if (!allowedKeys.includes(key)) return { error: 'Key override tidak dikenal' }
    if (raw === null) {
      dropEntry(key)
      continue
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || !valueOk(key, raw)) {
      return { error: valueError }
    }
    dropEntry(key)
    next.push([key, raw])
  }
  return { value: next.length > 0 ? Object.fromEntries(next) : null }
}

// ── Analytics (Statistik page, WIB day buckets) ──────────────

const WIB_OFFSET_MS = 7 * 3_600_000

function wibDayKey(ms: number): string {
  return new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10)
}

function parseDayKey(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const y = parseInt(day.slice(0, 4), 10)
  const m = parseInt(day.slice(5, 7), 10)
  const d = parseInt(day.slice(8, 10), 10)
  const ms = Date.UTC(y, m - 1, d)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null
  return ms
}

// ── Quick-action call counters (E2E verification surface) ────

const counters = {
  loginSuccess: 0,
  loginFail: 0,
  sessionProbes: 0,
  listCalls: 0,
  approves: 0,
  rejects: 0,
  deletes: 0,
  retries: 0,
  refunds: 0,
  edits: 0,
  censors: 0,
  requeues: 0,
  breakerResets: 0,
  clearCaches: 0,
  mediaServed: 0,
  mediaNotModified: 0,
  originBlocked: 0,
  authRejected: 0,
  // ── Admin surface extension (submitters / payments / settings / analytics) ──
  submittersListCalls: 0,
  submitterBlocks: 0,
  submitterUnblocks: 0,
  whitelistAdds: 0,
  whitelistRemoves: 0,
  imageAllowAdds: 0,
  imageAllowRemoves: 0,
  overridesApplied: 0,
  pointsAdjusts: 0,
  paymentsListCalls: 0,
  paymentConfirms: 0,
  paymentVoids: 0,
  ambiguousDismisses: 0,
  settingsGets: 0,
  settingsSaves: 0,
  settingsDeletes: 0,
  filterGets: 0,
  filterSaves: 0,
  aiStatusCalls: 0,
  aiStatsCalls: 0,
  analyticsCalls: 0,
}

let tweetSeq = 1798000200000000000n

function nextTweetId(): string {
  tweetSeq += 137n
  return tweetSeq.toString()
}

// ── Stats (hot shape from GET /api/admin/stats) ──────────────

function computeStats() {
  const count = (s: string) => submissions.filter((x) => x.status === s).length
  // Post-method mix (the warm-stats postMethodStats): direct / retry /
  // fallback over posted rows — rates as whole percentages.
  const posted = submissions.filter((x) => x.status === 'posted')
  const pmTotal = posted.length
  const pmDirect = posted.filter((x) => x.postMethod === 'direct').length
  const pmRetry = posted.filter((x) => x.postMethod === 'retry').length
  const pmFallback = posted.filter((x) => x.postMethod === 'fallback').length
  const rate = (n: number) => (pmTotal === 0 ? 0 : Math.round((n / pmTotal) * 100))
  return {
    pending: count('pending'),
    censored: count('censored'),
    posting: count('posting'),
    postFailed: count('post_failed'),
    rejected: count('rejected'),
    posted: count('posted'),
    total: submissions.length,
    circuitBreaker: {
      paused: false,
      failCount: 0,
      pausedUntil: null,
      remainingMinutes: 0,
      threshold: 3,
    },
    postMethodStats: {
      total: pmTotal,
      direct: pmDirect,
      retry: pmRetry,
      fallback: pmFallback,
      directRate: rate(pmDirect),
      retryRate: rate(pmRetry),
      fallbackRate: rate(pmFallback),
    },
  }
}

// ── PNG media generation (16x16, color derived from the id) ──

function crc32(buf: Buffer): number {
  let c: number
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table.push(c)
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function solidPng(id: string): Buffer {
  const hash = crypto.createHash('sha256').update(id).digest()
  const [r, g, b] = [hash[0], hash[1], hash[2]]
  const size = 16
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc(size * (1 + size * 3))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      raw[p++] = (r + x * 8) & 0xff
      raw[p++] = (g + y * 8) & 0xff
      raw[p++] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mediaCache = new Map<string, { body: Buffer; etag: string }>()

function mediaFor(id: string): { body: Buffer; etag: string } {
  let entry = mediaCache.get(id)
  if (!entry) {
    const body = solidPng(id)
    entry = { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"` }
    mediaCache.set(id, entry)
  }
  return entry
}

// ── Helpers ──────────────────────────────────────────────────

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const errJson = (error: string, status: number, headers: Record<string, string> = {}) =>
  json({ error }, status, headers)

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function publicRow(s: Submission): Record<string, unknown> {
  return {
    id: s.id,
    message: s.message,
    status: s.status,
    tweetId: s.tweetId,
    postMethod: s.postMethod,
    postError: s.postError,
    filterReasons: s.filterReasons,
    imageUrl: s.imageUrl,
    imageSha256: s.imageSha256,
    nsfwStatus: s.nsfwStatus,
    paidPost: s.paidPost,
    refundedAt: s.refundedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    submitter: s.submitter,
  }
}

const VALID_LIST_STATUSES = ['pending', 'censored', 'posting', 'post_failed', 'rejected', 'posted']

// ── Edit + censor validation (the instance app's own bounds) ──

const MIN_MESSAGE_LENGTH = 5
const MAX_CENSOR_REGIONS = 16
const REGION_COORD_EPS = 1e-6
const CENSOR_REGION_TYPES = ['pixelate', 'blur', 'black'] as const

function randomSha256(): string {
  let hex = ''
  while (hex.length < 64) hex += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return hex.slice(0, 64)
}

/** Validate an untrusted censor-region payload: an array of 1..16 rects
 *  in FRACTIONAL image coordinates (x/y/w/h in 0..1, x+w/y+h within
 *  bounds + eps) with a whitelisted type and an optional angle. Returns
 *  the typed array, or an Indonesian error string. Mirrors the instance
 *  app's validateCensorRegions contract. */
function validateRegions(input: unknown): Array<{ x: number; y: number; w: number; h: number; type: string; angle?: number }> | string {
  if (!Array.isArray(input)) return 'Format area sensor tidak valid'
  if (input.length === 0) return 'Minimal satu area sensor diperlukan'
  if (input.length > MAX_CENSOR_REGIONS) return `Maksimal ${MAX_CENSOR_REGIONS} area sensor`
  const out: Array<{ x: number; y: number; w: number; h: number; type: string; angle?: number }> = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'Format area sensor tidak valid'
    const r = raw as Record<string, unknown>
    const { x, y, w, h, type, angle } = r
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    if (!(finite(x) && finite(y) && finite(w) && finite(h))) return 'Format area sensor tidak valid'
    if (x < 0 || x > 1 || y < 0 || y > 1 || w <= 0 || h <= 0
      || x + w > 1 + REGION_COORD_EPS || y + h > 1 + REGION_COORD_EPS) {
      return 'Area sensor keluar dari batas gambar'
    }
    if (typeof type !== 'string' || !(CENSOR_REGION_TYPES as readonly string[]).includes(type)) {
      return 'Jenis sensor tidak valid'
    }
    const region: { x: number; y: number; w: number; h: number; type: string; angle?: number } = { x, y, w, h, type }
    if (angle !== undefined) {
      if (!finite(angle) || angle < -180 || angle > 180) return 'Sudut rotasi tidak valid'
      if (angle !== 0) region.angle = angle
    }
    out.push(region)
  }
  return out
}

// ── Router ───────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    // Simple liveness page
    if (path === '/' && method === 'GET') {
      return new Response(
        '<h3>Tweetfess instance simulator</h3><p>Implements the Instance API contract consumed by the Controller (docs/INSTANCE-API.md).</p>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }

    // ---- POST /api/admin/login ----
    if (path === '/api/admin/login' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      const ip = clientIp(req)
      const attempt = consumeLoginAttempt(ip)
      if (!attempt.allowed) {
        return errJson('Terlalu banyak percobaan login. Coba lagi nanti.', 429, {
          'retry-after': String(attempt.retryAfterSec ?? 60),
        })
      }
      const body = await readJson(req)
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!timingSafeEqual(password, ADMIN_PASSWORD)) {
        counters.loginFail++
        const retryAfter = recordLoginFail(ip)
        if (retryAfter !== null) {
          return errJson('Terlalu banyak percobaan login. Coba lagi nanti.', 429, {
            'retry-after': String(retryAfter),
          })
        }
        return errJson('Password salah', 401)
      }
      counters.loginSuccess++
      clearLoginFails(ip)
      const res = json({ success: true })
      res.headers.append(
        'set-cookie',
        `admin_token=${generateToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TOKEN_TTL_SEC}`,
      )
      return res
    }

    // ---- admin-authenticated surface ----
    const token = extractToken(req)
    const authed = verifyToken(token)
    if (!authed) counters.authRejected++

    if (path === '/api/admin/session' && method === 'GET') {
      if (!authed) return json({ authenticated: false })
      counters.sessionProbes++
      return json({ authenticated: true, stats: computeStats() })
    }

    if (path === '/api/dev/state' && method === 'GET') {
      if (!authed) return errJson('Unauthorized', 401)
      return json({
        counters,
        stats: computeStats(),
        submissions: submissions.map(publicRow),
      })
    }

    if (path === '/api/submissions' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.listCalls++
      const status = url.searchParams.get('status') ?? 'all'
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
      const search = (url.searchParams.get('search') ?? '').trim().toLowerCase()
      if (status !== 'all' && !VALID_LIST_STATUSES.includes(status)) {
        return errJson('Status tidak valid', 400)
      }
      let rows = status === 'all' ? submissions : submissions.filter((s) => s.status === status)
      if (search) {
        rows = rows.filter(
          (s) =>
            s.message.toLowerCase().includes(search) ||
            s.submitter.username.toLowerCase().includes(search) ||
            s.submitter.displayName.toLowerCase().includes(search),
        )
      }
      const total = rows.length
      const totalPages = Math.max(1, Math.ceil(total / limit))
      const start = (page - 1) * limit
      const items = rows
        .slice(start, start + limit)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return json({
        submissions: items.map(publicRow),
        pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
      })
    }

    // /api/submissions/:id[/post|/refund]
    let match = path.match(/^\/api\/submissions\/([^/]+)$/)
    if (match) {
      const id = decodeURIComponent(match[1])
      const sub = submissions.find((s) => s.id === id)

      if (method === 'PATCH') {
        if (!originOk(req)) {
          counters.originBlocked++
          return errJson('Header Origin/Referer tidak ditemukan', 403)
        }
        if (!authed) return errJson('Silakan login sebagai admin', 401)
        if (!sub) return errJson('Submission tidak ditemukan', 404)
        const body = await readJson(req)
        const status = body?.status
        const reviewable = ['pending', 'censored', 'post_failed']
        if (status === 'approved') {
          if (!reviewable.includes(sub.status)) {
            return errJson('Submission sudah diproses', 400)
          }
          sub.status = 'posted'
          sub.tweetId = nextTweetId()
          sub.postMethod = 'direct'
          sub.postError = null
          sub.nsfwStatus = 'approved'
          sub.updatedAt = new Date().toISOString()
          counters.approves++
          return json({
            kind: 'auto-posted',
            submission: publicRow(sub),
            tweetId: sub.tweetId,
            postMethod: 'direct',
            description: 'Pesan otomatis diposting ke X.',
          })
        }
        if (status === 'rejected') {
          if (!reviewable.includes(sub.status)) {
            return errJson('Submission sudah diproses', 400)
          }
          sub.status = 'rejected'
          sub.updatedAt = new Date().toISOString()
          counters.rejects++
          const res: Record<string, unknown> = { submission: publicRow(sub) }
          if (sub.paidPost) res.refund = 'refunded'
          return json(res)
        }
        return errJson('Status tidak valid', 400)
      }

      if (method === 'PUT') {
        // Edit message text — the instance app's message-only content edit
        // (the [id] collection's PUT). Same status gate as censor: only
        // reviewable rows are editable; posted/rejected/refunded refuse.
        if (!originOk(req)) {
          counters.originBlocked++
          return errJson('Header Origin/Referer tidak ditemukan', 403)
        }
        if (!authed) return errJson('Silakan login sebagai admin', 401)
        if (!sub) return errJson('Submission tidak ditemukan', 404)
        const body = await readJson(req)
        const message = body?.message
        if (typeof message !== 'string') return errJson('Pesan wajib diisi', 400)
        const trimmed = message.trim()
        if (trimmed.length < MIN_MESSAGE_LENGTH) {
          return errJson(`Pesan terlalu pendek — minimal ${MIN_MESSAGE_LENGTH} karakter`, 400)
        }
        if (trimmed.length > 5000) return errJson('Pesan terlalu panjang', 400)
        if (!['pending', 'censored', 'post_failed'].includes(sub.status)) {
          return errJson('Status tidak valid untuk edit', 400)
        }
        counters.edits++
        if (sub.message === trimmed) {
          // No-op guard — the instance app performs no write on a zero-effect save.
          return json({ success: true, changed: false, submission: { id: sub.id, message: trimmed } })
        }
        sub.message = trimmed
        sub.updatedAt = new Date().toISOString()
        return json({ success: true, changed: true, submission: { id: sub.id, message: trimmed } })
      }

      if (method === 'DELETE') {
        if (!originOk(req)) {
          counters.originBlocked++
          return errJson('Header Origin/Referer tidak ditemukan', 403)
        }
        if (!authed) return errJson('Silakan login sebagai admin', 401)
        if (!sub) return errJson('Submission tidak ditemukan', 404)
        if (sub.status === 'posted') {
          return errJson('Submission sudah diposting ke X (terminal)', 409)
        }
        submissions.splice(submissions.indexOf(sub), 1)
        counters.deletes++
        return json({ success: true })
      }
    }

    match = path.match(/^\/api\/submissions\/([^/]+)\/post$/)
    if (match && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const sub = submissions.find((s) => s.id === decodeURIComponent(match[1]))
      if (!sub) return errJson('Submission tidak ditemukan', 404)
      if (!['pending', 'censored', 'post_failed'].includes(sub.status)) {
        return errJson('Status tidak valid untuk retry', 400)
      }
      sub.status = 'posted'
      sub.tweetId = nextTweetId()
      sub.postMethod = 'retry'
      sub.postError = null
      sub.updatedAt = new Date().toISOString()
      counters.retries++
      return json({
        kind: 'auto-posted',
        submission: publicRow(sub),
        tweetId: sub.tweetId,
        postMethod: 'retry',
        retriesUsed: 1,
      })
    }

    match = path.match(/^\/api\/submissions\/([^/]+)\/refund$/)
    if (match && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const sub = submissions.find((s) => s.id === decodeURIComponent(match[1]))
      if (!sub) return errJson('Submission tidak ditemukan', 404)
      if (sub.status !== 'rejected') {
        return errJson('Hanya submission rejected yang bisa direfund', 400)
      }
      if (sub.refundedAt) return json({ submission: publicRow(sub), refund: 'already-refunded' })
      if (!sub.paidPost) return json({ submission: publicRow(sub), refund: 'no-spend' })
      sub.refundedAt = new Date().toISOString()
      sub.updatedAt = sub.refundedAt
      counters.refunds++
      return json({ submission: publicRow(sub), refund: 'refunded' })
    }

    match = path.match(/^\/api\/submissions\/([^/]+)\/censor$/)
    if (match && method === 'POST') {
      // Region image censor — the instance app renders the regions
      // server-side and swaps in a NEW content-addressed image (the
      // original bytes stay in B2, orphaned). Simulated here by bumping
      // imageSha256 so the controller's ?v= cache-bust picks the new
      // version — the observable contract (updated row + new sha).
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const sub = submissions.find((s) => s.id === decodeURIComponent(match[1]))
      if (!sub) return errJson('Submission tidak ditemukan', 404)
      if (!['pending', 'censored', 'post_failed'].includes(sub.status)) {
        return errJson('Status tidak valid untuk sensor gambar', 400)
      }
      if (!sub.imageUrl) return errJson('Kiriman tidak memiliki gambar', 400)
      const body = await readJson(req)
      const regions = validateRegions(body?.regions)
      if (typeof regions === 'string') return errJson(regions, 400)
      counters.censors++
      sub.imageSha256 = randomSha256()
      sub.updatedAt = new Date().toISOString()
      return json({ success: true, submission: publicRow(sub), regions: regions.length })
    }

    // ---- Quick actions ----
    if (path === '/api/admin/submissions/requeue' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      let requeued = 0
      for (const s of submissions) {
        if (s.status === 'post_failed') {
          s.status = 'pending'
          s.updatedAt = new Date().toISOString()
          requeued++
        }
      }
      counters.requeues++
      return json({ requeued })
    }

    if (path === '/api/admin/circuit-breaker/reset' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.breakerResets++
      return json({ success: true, message: 'Circuit breaker reset' })
    }

    if (path === '/api/admin/clear-cache' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.clearCaches++
      return json({ success: true, message: 'Cache dibersihkan (12 jenis)' })
    }

    // ---- Submitters registry ----
    if (path === '/api/admin/submitters' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.submittersListCalls++
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))
      const search = (url.searchParams.get('search') ?? '').trim().toLowerCase()
      let rows = [...submitterRecords].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      )
      if (search) {
        rows = rows.filter(
          (r) => r.username.toLowerCase().includes(search) || r.displayName.toLowerCase().includes(search),
        )
      }
      const totalCount = rows.length
      const totalPages = Math.max(1, Math.ceil(totalCount / limit))
      const start = (page - 1) * limit
      return json({
        submitters: rows.slice(start, start + limit).map(submitterPublicRow),
        totalCount,
        totalPages,
        page,
        limit,
        hasMore: page < totalPages,
      })
    }

    if (path === '/api/admin/submitters/block' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (!username) return errJson('Username tidak valid', 400)
      const record = ensureSubmitter(username)
      const rawReason = body?.reason
      const reason = typeof rawReason === 'string' ? rawReason.slice(0, 200) : null
      whitelist.delete(username)
      blocklist.set(username, { twitterId: record.twitterId, reason })
      const stamp = new Date().toISOString()
      for (const s of submissions) {
        if (s.submitter.username === username && ['pending', 'censored', 'post_failed'].includes(s.status)) {
          s.status = 'rejected'
          s.postError = '[Auto] Submitter blocked'
          s.updatedAt = stamp
          counters.rejects++
        }
      }
      counters.submitterBlocks++
      return json({ success: true, blocked: username })
    }

    if (path === '/api/admin/submitters/unblock' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (!username || !blocklist.has(username)) {
        return errJson('Pengguna tidak ditemukan di blocklist', 400)
      }
      blocklist.delete(username)
      counters.submitterUnblocks++
      return json({ success: true, unblocked: username })
    }

    if (path === '/api/admin/submitters/whitelist' && (method === 'POST' || method === 'DELETE')) {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (method === 'POST') {
        if (!username) return errJson('Username tidak valid', 400)
        whitelist.add(username)
        blocklist.delete(username)
        counters.whitelistAdds++
        return json({ success: true, whitelisted: username })
      }
      if (!username || !whitelist.has(username)) {
        return errJson('Pengguna tidak ditemukan di whitelist', 400)
      }
      whitelist.delete(username)
      counters.whitelistRemoves++
      return json({ success: true, removed: username })
    }

    if (path === '/api/admin/submitters/image-post-allowlist' && (method === 'POST' || method === 'DELETE')) {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (method === 'POST') {
        if (!username) return errJson('Username tidak valid', 400)
        imageAllowlist.add(username)
        counters.imageAllowAdds++
        return json({ success: true, added: username })
      }
      if (!username || !imageAllowlist.has(username)) {
        return errJson('Pengguna tidak ditemukan di allowlist gambar', 400)
      }
      imageAllowlist.delete(username)
      counters.imageAllowRemoves++
      return json({ success: true, removed: username })
    }

    if (path === '/api/admin/submitters/overrides' && method === 'PATCH') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (!username) return errJson('Username tidak valid', 400)
      const hasLimits = body?.customLimits !== undefined
      const hasPricing = body?.customPricing !== undefined
      if (!hasLimits && !hasPricing) {
        return errJson('Minimal satu keluarga override harus diisi', 400)
      }
      const record = findSubmitter(username)
      if (!record) return errJson('Pengguna tidak ditemukan', 404)
      const previousCustomLimits = record.customLimits
      const previousCustomPricing = record.customPricing
      if (hasLimits) {
        const result = computeOverrideFamily(
          record.customLimits,
          body?.customLimits,
          OVERRIDE_LIMIT_KEYS,
          (_key, value) => value >= -1,
          'Nilai limit tidak valid',
        )
        if ('error' in result) return errJson(result.error, 400)
        record.customLimits = result.value
      }
      if (hasPricing) {
        const result = computeOverrideFamily(
          record.customPricing,
          body?.customPricing,
          OVERRIDE_PRICING_KEYS,
          overridePricingValueOk,
          'Nilai harga tidak valid',
        )
        if ('error' in result) return errJson(result.error, 400)
        record.customPricing = result.value
      }
      counters.overridesApplied++
      return json({
        success: true,
        submitter: submitterPublicRow(record),
        previousCustomLimits,
        previousCustomPricing,
      })
    }

    if (path === '/api/admin/submitters/points-adjust' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const username = normalizeUsername(body?.username)
      if (!username) return errJson('Username tidak valid', 400)
      const delta = body?.delta
      if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
        return errJson('Delta harus bilangan bulat tidak nol', 400)
      }
      const note = body?.note
      if (typeof note !== 'string' || !note.trim()) return errJson('Catatan wajib diisi', 400)
      const record = findSubmitter(username)
      if (!record) return errJson('Pengguna tidak ditemukan', 404)
      if (delta > 0 && record.points + delta > POINTS_BALANCE_CEILING) {
        return errJson('Melebihi batas saldo maksimum', 409)
      }
      if (delta < 0 && record.points + delta < 0) {
        return errJson('Saldo tidak cukup', 409)
      }
      record.points += delta
      counters.pointsAdjusts++
      return json({ success: true, balance: record.points })
    }

    // ---- Payments (Monetisasi tab) ----
    if (path === '/api/admin/payments' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.paymentsListCalls++
      const status = url.searchParams.get('status')
      if (status !== null && !['pending', 'paid', 'expired'].includes(status)) {
        return errJson('Status tidak valid', 400)
      }
      const purpose = url.searchParams.get('purpose')
      if (purpose !== null && !['topup', 'unblock'].includes(purpose)) {
        return errJson('Purpose tidak valid', 400)
      }
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
      const limit = 30
      let rows = [...orders]
      if (status !== null) rows = rows.filter((o) => o.status === status)
      if (purpose !== null) rows = rows.filter((o) => o.purpose === purpose)
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      const todayKey = localDayKey(Date.now())
      let todayIdr = 0
      let totalIdr = 0
      for (const o of orders) {
        if (o.status === 'paid' && o.paidAt) {
          totalIdr += o.amountIdr
          if (localDayKey(Date.parse(o.paidAt)) === todayKey) todayIdr += o.amountIdr
        }
      }
      const start = (page - 1) * limit
      return json({
        orders: rows.slice(start, start + limit).map(orderPublicRow),
        total: rows.length,
        page,
        revenue: { todayIdr, totalIdr },
        gobiz,
      })
    }

    match = path.match(/^\/api\/admin\/payments\/([^/]+)\/confirm$/)
    if (match && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const orderId = decodeURIComponent(match[1])
      const body = await readJson(req)
      const note = body?.note
      if (typeof note !== 'string' || !note.trim()) return errJson('Catatan wajib diisi', 400)
      const rawRefId = body?.refId
      let refId: string | null = null
      if (rawRefId !== undefined && rawRefId !== null) {
        if (typeof rawRefId !== 'string' || !/^gobiz:[A-Za-z0-9_-]+$/.test(rawRefId)) {
          return errJson('Format refId tidak valid', 400)
        }
        refId = rawRefId
      }
      const order = orders.find((o) => o.id === orderId)
      if (!order) return errJson('Order tidak ditemukan', 404)
      if (order.status === 'paid') return errJson('Order sudah dibayar', 409)
      if (refId && claimedRefIds.has(refId)) {
        return errJson('Referensi sudah dipakai order lain', 409)
      }
      let latePayment = false
      if (order.status === 'expired') {
        if (order.expiresAt && Date.now() - Date.parse(order.expiresAt) > 24 * 3_600_000) {
          return errJson('Order kedaluwarsa lebih dari 24 jam', 409)
        }
        latePayment = true
      }
      order.status = 'paid'
      order.verifiedBy = 'admin'
      order.paidAt = new Date().toISOString()
      if (refId) {
        order.refId = refId
        claimedRefIds.add(refId)
        const before = gobiz.ambiguous.length
        gobiz.ambiguous = gobiz.ambiguous.filter((e) => e.refId !== refId)
        if (gobiz.ambiguous.length < before) resolvedAmbiguous.add(refId)
      }
      counters.paymentConfirms++
      return json({ success: true, overBalance: false, latePayment })
    }

    match = path.match(/^\/api\/admin\/payments\/([^/]+)\/void$/)
    if (match && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const orderId = decodeURIComponent(match[1])
      const order = orders.find((o) => o.id === orderId)
      if (!order) return errJson('Order tidak ditemukan', 404)
      if (order.status !== 'pending') return errJson('Order tidak pending', 409)
      order.status = 'expired'
      counters.paymentVoids++
      return json({ success: true })
    }

    match = path.match(/^\/api\/admin\/payments\/ambiguous\/([^/]+)\/dismiss$/)
    if (match && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const refId = decodeURIComponent(match[1])
      if (!/^gobiz:[A-Za-z0-9_-]+$/.test(refId)) {
        return errJson('Format refId tidak valid', 400)
      }
      if (resolvedAmbiguous.has(refId)) return errJson('Hold sudah diselesaikan', 409)
      const index = gobiz.ambiguous.findIndex((e) => e.refId === refId)
      if (index === -1) return errJson('Hold ambigu tidak ditemukan', 404)
      gobiz.ambiguous.splice(index, 1)
      counters.ambiguousDismisses++
      return json({ success: true })
    }

    // ---- Scalar admin settings ----
    if (path === '/api/admin/settings' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.settingsGets++
      const settings = [...settingsMap.entries()].map(([key, entry]) => ({
        key,
        value: maskSettingValue(entry.value),
        updatedAt: entry.updatedAt,
      }))
      return json({ settings, encryptionEnabled: true })
    }

    if (path === '/api/admin/settings' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = await readJson(req)
      const key = body?.key
      if (typeof key !== 'string' || !VALID_SETTING_KEYS.includes(key)) {
        return errJson('Key tidak valid', 400)
      }
      const value = body?.value
      if (typeof value !== 'string' || value.length < 1 || value.length > 5000) {
        return errJson('Nilai tidak boleh kosong', 400)
      }
      const updatedAt = new Date().toISOString()
      settingsMap.set(key, { value, updatedAt })
      counters.settingsSaves++
      return json({ setting: { key, updatedAt }, autoLogin: null })
    }

    if (path === '/api/admin/settings' && method === 'DELETE') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const key = url.searchParams.get('key')
      if (typeof key !== 'string' || !VALID_SETTING_KEYS.includes(key)) {
        return errJson('Key tidak valid', 400)
      }
      settingsMap.delete(key)
      counters.settingsDeletes++
      return json({ success: true })
    }

    // ---- Filter settings (batched groups) ----
    if (path === '/api/admin/filter-settings' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.filterGets++
      return json(filterSettingsPublic())
    }

    if (path === '/api/admin/filter-settings' && method === 'POST') {
      if (!originOk(req)) {
        counters.originBlocked++
        return errJson('Header Origin/Referer tidak ditemukan', 403)
      }
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const body = (await readJson(req)) ?? {}
      const groups = Object.entries(body)
      for (const [key, value] of groups) {
        if (!FILTER_GROUP_SNAKE.has(key)) return errJson('Grup setting tidak dikenal', 400)
        const groupError = validateFilterGroup(key, value)
        if (groupError) return errJson(groupError, 400)
      }
      const results: Array<{ key: string; updated: boolean }> = []
      for (const [key, value] of groups) {
        if (key === 'rateLimits' || key === 'circuitBreaker') {
          const existing = filterSettings.get(key)
          const baseEntries = isPlainObject(existing)
            ? Object.entries(existing).filter((e): e is [string, number] => typeof e[1] === 'number')
            : []
          const patch = Object.entries(value as Record<string, unknown>).map(
            ([k, v]): [string, number] => [k, Math.min(10_000, Math.max(0, Math.round(v as number)))],
          )
          const patchKeys = new Set(patch.map(([k]) => k))
          const merged = Object.fromEntries([
            ...baseEntries.filter(([k]) => !patchKeys.has(k)),
            ...patch,
          ])
          filterSettings.set(key, merged)
        } else if (isPlainObject(value)) {
          const existingGroup = filterSettings.get(key)
          // object groups merge key-by-key ("only provided keys are written")
          filterSettings.set(key, isPlainObject(existingGroup) ? { ...existingGroup, ...value } : value)
        } else {
          filterSettings.set(key, value)
        }
        results.push({ key: FILTER_GROUP_SNAKE.get(key) ?? key, updated: true })
      }
      counters.filterSaves++
      return json({ success: true, results })
    }

    // ---- AI moderation health + stats ----
    if (path === '/api/admin/ai-status' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.aiStatusCalls++
      return json({
        healthy: true,
        providers: [
          { id: 'openai-1', name: 'OpenAI GPT-4o', model: 'gpt-4o', enabled: true },
          { id: 'gemini-1', name: 'Gemini 1.5 Flash', model: 'gemini-1.5-flash', enabled: false },
        ],
        results: [
          { id: 'openai-1', name: 'OpenAI GPT-4o', model: 'gpt-4o', healthy: true, modelAvailable: true, error: null, latencyMs: 234 },
          { id: 'gemini-1', name: 'Gemini 1.5 Flash', model: 'gemini-1.5-flash', healthy: false, modelAvailable: null, error: 'API key belum diset', latencyMs: 0 },
        ],
        encryptionEnabled: true,
        error: null,
      })
    }

    if (path === '/api/admin/ai-stats' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.aiStatsCalls++
      return json({
        windowHours: 24,
        generatedAt: new Date().toISOString(),
        rows: [
          { phase: 'text', provider: 'openai-1', model: 'gpt-4o-mini', totalCalls: 180, passCount: 160, flagCount: 18, errorCount: 2, timeoutCount: 0, passRatePct: 88.9, avgLatencyMs: 215, p50LatencyMs: 190, p95LatencyMs: 640, avgTotalTokens: 310, totalTokens: 55800 },
          { phase: 'vision', provider: 'openai-1', model: 'gpt-4o-mini', totalCalls: 24, passCount: 20, flagCount: 3, errorCount: 1, timeoutCount: 0, passRatePct: 83.3, avgLatencyMs: 640, p50LatencyMs: 580, p95LatencyMs: 1200, avgTotalTokens: 850, totalTokens: 20400 },
        ],
        deletedRows: 0,
      })
    }

    // ---- Analytics (Statistik page, WIB windows) ----
    if (path === '/api/admin/analytics' && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      counters.analyticsCalls++
      const hasRange = url.searchParams.has('range')
      const hasFromTo = url.searchParams.has('from') || url.searchParams.has('to')
      if (hasRange && hasFromTo) {
        return errJson('Pilih preset atau rentang kustom, tidak keduanya', 400)
      }
      const todayMs = parseDayKey(wibDayKey(Date.now())) as number
      let startMs: number
      let endMs: number
      if (hasFromTo) {
        const fromParam = url.searchParams.get('from')
        const toParam = url.searchParams.get('to')
        if (fromParam === null || toParam === null) {
          return errJson('from dan to harus bersamaan', 400)
        }
        const fromMs = parseDayKey(fromParam)
        const toMs = parseDayKey(toParam)
        if (fromMs === null || toMs === null) return errJson('Tanggal tidak valid', 400)
        if (fromMs > toMs) return errJson('from harus sebelum to', 400)
        if (fromMs > todayMs) return errJson('from tidak boleh di masa depan', 400)
        endMs = Math.min(toMs, todayMs)
        if ((endMs - fromMs) / 86_400_000 + 1 > 366) {
          return errJson('Rentang maksimal 366 hari', 400)
        }
        startMs = fromMs
      } else {
        const range = url.searchParams.get('range') ?? '30d'
        if (range !== 'today' && range !== '7d' && range !== '30d' && range !== 'month') {
          return errJson('Range tidak valid', 400)
        }
        if (range === 'today') {
          startMs = todayMs
          endMs = todayMs
        } else if (range === 'month') {
          startMs = parseDayKey(`${wibDayKey(Date.now()).slice(0, 7)}-01`) as number
          endMs = todayMs
        } else {
          startMs = todayMs - (range === '7d' ? 6 : 29) * 86_400_000
          endMs = todayMs
        }
      }
      const days: string[] = []
      for (let ms = startMs; ms <= endMs; ms += 86_400_000) days.push(wibDayKey(ms))
      const submissionsDaily: Array<Record<string, unknown>> = []
      const revenueDaily: Array<Record<string, unknown>> = []
      const submittersDaily: Array<Record<string, unknown>> = []
      const pointsDaily: Array<Record<string, unknown>> = []
      const topupTrendDaily: Array<Record<string, unknown>> = []
      let createdSum = 0
      let ordersSum = 0
      for (const day of days) {
        const h = crypto.createHash('sha256').update(day).digest()
        const total = 18 + (h[0] % 34)
        const posted = Math.round(total * 0.55) + (h[1] % 6)
        const notPassed = Math.round(total * 0.25)
        const inFlight = Math.max(0, total - posted - notPassed)
        const dayOrders = h[2] % 5
        const granted = dayOrders * 10
        submissionsDaily.push({ day, total, posted, notPassed, inFlight })
        revenueDaily.push({ day, orders: dayOrders, revenueIdr: dayOrders * 10122 })
        submittersDaily.push({ day, count: h[3] % 4 })
        pointsDaily.push({ day, granted, spent: Math.round(granted * 0.8), refunded: h[4] % 4 })
        topupTrendDaily.push({ day, orders: [h[5] % 3, dayOrders, h[6] % 2] })
        createdSum += total
        ordersSum += dayOrders
      }
      const funnelCreated = createdSum + 120
      return json({
        windowDays: days.length,
        generatedAt: new Date().toISOString(),
        submissionsDaily,
        revenueDaily,
        submittersDaily,
        pointsDaily,
        failureClasses: [
          { failureClass: 'auth_failure', count: 23 },
          { failureClass: null, count: 5 },
        ],
        rejectionReasons: [
          { reason: 'blocked_word', count: 41 },
          { reason: 'caps_ratio', count: 12 },
        ],
        topupPackages: [
          { points: 10, orders: 41, revenueIdr: 410000 },
          { points: 20, orders: 18, revenueIdr: 360000 },
          { points: 5, orders: 12, revenueIdr: 60000 },
        ],
        topupTrend: { packages: [10, 20, 5], daily: topupTrendDaily },
        userLeaderboards: {
          spenders: [
            { username: 'budi_setiawan', totalIdr: 410000, orders: 3 },
            { username: 'dimas_p', totalIdr: 202440, orders: 2 },
            { username: 'neneng_t', totalIdr: 101220, orders: 1 },
          ],
          posters: [
            { username: 'ditaaa', submissions: 23 },
            { username: 'agus_pratama', submissions: 14 },
            { username: 'budi_setiawan', submissions: 12 },
          ],
        },
        funnel: {
          windowDays: days.length,
          pendingNow: computeStats().pending,
          created: funnelCreated,
          resumed: 8,
          qrViewed: Math.round(funnelCreated * 0.74),
          paid: ordersSum + 52,
          latePaid: 3,
          expired: 14,
          voided: 2,
        },
      })
    }

    // ---- Auth-gated media ----
    match = path.match(/^\/api\/media\/([^/]+)$/)
    if (match && method === 'GET') {
      if (!authed) return errJson('Silakan login sebagai admin', 401)
      const id = decodeURIComponent(match[1])
      const sub = submissions.find((s) => s.id === id || s.imageUrl?.endsWith(`/api/media/${id}`))
      if (!sub || !sub.imageUrl) return errJson('Gambar tidak ditemukan', 404)
      const media = mediaFor(id)
      const ifNoneMatch = req.headers.get('if-none-match')
      if (ifNoneMatch && ifNoneMatch === media.etag) {
        counters.mediaNotModified++
        return new Response(null, {
          status: 304,
          headers: { etag: media.etag, 'cache-control': 'private, max-age=86400, immutable' },
        })
      }
      counters.mediaServed++
      return new Response(media.body, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          etag: media.etag,
          'cache-control': 'private, max-age=86400, immutable',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    return errJson('Not found', 404)
  },
})

console.log(`[tweetfess-instance] listening on http://localhost:${PORT}`)
console.log(`[tweetfess-instance] admin password: ${ADMIN_PASSWORD}`)
