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
//   DELETE /api/submissions/:id
//   POST   /api/submissions/:id/post             (retry)
//   POST   /api/submissions/:id/refund
//   POST   /api/admin/submissions/requeue        (quick action)
//   POST   /api/admin/circuit-breaker/reset      (quick action)
//   POST   /api/admin/clear-cache                (quick action)
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
  requeues: 0,
  breakerResets: 0,
  clearCaches: 0,
  mediaServed: 0,
  mediaNotModified: 0,
  originBlocked: 0,
  authRejected: 0,
}

let tweetSeq = 1798000200000000000n

function nextTweetId(): string {
  tweetSeq += 137n
  return tweetSeq.toString()
}

// ── Stats (hot shape from GET /api/admin/stats) ──────────────

function computeStats() {
  const count = (s: string) => submissions.filter((x) => x.status === s).length
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
