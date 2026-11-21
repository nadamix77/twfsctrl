// ============================================================
// types.ts — Tweetfess Controller shared contract
// (docs/PRD-CONTROLLER.md §7, §10, §11)
//
// Single source of truth for every shape crossing the controller
// API boundary. The instance-side shapes documented here mirror
// docs/API.md of the Tweetfess instance app — the controller is a
// pure consumer and must tolerate unknown/missing fields
// (NFR-X1 forward compatibility).
// ============================================================

// ── Health (PRD FR-C2) ──────────────────────────────────────

/** Per-instance connectivity classification. */
export type InstanceHealth = 'ok' | 'auth-failed' | 'locked-out' | 'down'

/** Card states — `disabled` is registry state, not fan-out result. */
export type InstanceCardState = InstanceHealth | 'disabled'

// ── Registry DTOs (no secrets ever leave the server) ────────

/** API-safe instance row. `hasCredential` is the only credential signal. */
export interface InstanceDto {
  id: string
  name: string
  baseUrl: string
  handle: string | null
  colorTag: string | null
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  hasCredential: boolean
}

/** Payload for POST /api/controller/instances (create). */
export interface InstanceCreateInput {
  name: string
  baseUrl: string
  adminPassword: string
  handle?: string | null
  colorTag?: string | null
}

/** Payload for PATCH /api/controller/instances/[id] (edit).
 *  `adminPassword` omitted/blank = keep existing; filled = replace. */
export interface InstanceUpdateInput {
  name?: string
  handle?: string | null
  colorTag?: string | null
  enabled?: boolean
  sortOrder?: number
  adminPassword?: string
}

/** Result of POST /api/controller/instances/test (FR-B2). */
export interface ConnectionTestResult {
  ok: boolean
  /** Instance HTTP status of the login call (0 = network failure). */
  status: number
  message: string
  /** Populated on success — quick stats snapshot for the inline hint. */
  pending?: number
  retryAfterSec?: number
}

// ── Overview fan-out (Epic C) ───────────────────────────────

/** The subset of instance stats the card renders (PRD FR-C1).
 *  Forward-compatible parse: unknown fields ignored, missing → null. */
export interface InstanceStatsSnapshot {
  pending: number | null
  censored: number | null
  posting: number | null
  postFailed: number | null
  rejected: number | null
  posted: number | null
  total: number | null
  circuitBreaker: {
    paused: boolean
    remainingMinutes: number
    failCount: number
    threshold: number
    halfOpen: boolean
  } | null
  cookieConfigured: boolean | null
  /** Derived from filterSettings.aiProviders: enabled providers with ≥1 API key / total configured. */
  aiEnabled: number | null
  aiConfigured: number | null
  revenueTodayIdr: number | null
  revenueMonthIdr: number | null
  submitters: number | null
  postMethodSetting: string | null
  encryptionEnabled: boolean | null
  pendingPaymentsNow: number | null
  paymentsNeedingReview: number | null
  /** Post-method mix over the instance's recent posts (the warm-stats
   *  `postMethodStats`): direct vs retry vs fallback counts + rates. */
  postMethodStats: {
    total: number
    direct: number
    retry: number
    fallback: number
    directRate: number
    retryRate: number
    fallbackRate: number
  } | null
}

/** One instance card in the overview grid. */
export interface InstanceOverview {
  instance: InstanceDto
  health: InstanceCardState
  /** null → auth-only degrade ("data tidak tersedia" hint). */
  stats: InstanceStatsSnapshot | null
  /** Verbatim instance/controller error text when health != ok. */
  error: string | null
  /** Seconds remaining on an instance login lockout (health === 'locked-out'). */
  retryAfterSec: number | null
  fetchedAt: string
}

/** GET /api/controller/overview response. */
export interface OverviewResponse {
  instances: InstanceOverview[]
  aggregate: {
    totalPending: number
    instancesUp: number
    instancesEnabled: number
    instancesTotal: number
    revenueTodayIdr: number
    submitters: number
  }
  fetchedAt: string
}

// ── Unified queue (Epic D) ──────────────────────────────────

/** Queue tabs: the reviewable states (PRD §5.1 "unified queue") plus
 *  `rejected` — a P1 tab (FR-D8) so operators can reach the manual
 *  "Kembalikan Poin" refund action on rejected rows — and the two
 *  live/history states: `posting` (in-flight to X) and `posted`
 *  (successfully posted, with its tweet link). Rows on those two tabs
 *  are read-only — the instance refuses approve/reject/retry from them
 *  (400/409) and delete as well (409: in-flight / terminal). */
export type QueueStatusFilter =
  | 'all'
  | 'pending'
  | 'censored'
  | 'posting'
  | 'post_failed'
  | 'rejected'
  | 'posted'

/** One merged queue row. `imageUrl` is a CONTROLLER-relative proxy path
 *  (instance media is auth-gated — the browser can never hit it directly). */
export interface QueueItem {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  id: string
  message: string
  status: string
  /** Parsed from the instance's JSON-string column; raw admin detail. */
  filterReasons: string[]
  nsfwStatus: string | null
  hasImage: boolean
  imageUrl: string | null
  tweetId: string | null
  postError: string | null
  paidPost: boolean
  createdAt: string
  submitter: {
    username: string
    displayName: string | null
    profileImage: string | null
  }
}

/** Per-instance slice of the merged queue. */
export interface QueueSection {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  health: InstanceHealth
  error: string | null
  retryAfterSec: number | null
  items: QueueItem[]
  /** Current page fetched per instance (1-based). */
  page: number
  hasMore: boolean
  total: number
  lastFetchedAt: string
}

/** GET /api/controller/queue response. */
export interface QueueResponse {
  sections: QueueSection[]
  fetchedAt: string
}

// ── Queue actions (FR-D4–D8) ────────────────────────────────

export type QueueAction = 'approve' | 'reject' | 'retry' | 'refund' | 'delete' | 'edit' | 'censor'

/** One censor region in FRACTIONAL image coordinates (x/y/w/h in 0..1,
 *  x+w/y+h within bounds) — the instance app's CensorRegion contract.
 *  `type`: pixelate (mosaic) | blur (gaussian) | black (solid bar).
 *  `angle` rotates the rect around its own center (degrees, -180..180). */
export interface CensorRegionInput {
  x: number
  y: number
  w: number
  h: number
  type: 'pixelate' | 'blur' | 'black'
  angle?: number
}

/** Request body for the body-carrying queue actions. `edit` carries the
 *  new message text (PUT semantics — message-only content edit); `censor`
 *  carries the region list (POST …/censor). The bodyless verbs ignore it. */
export interface QueueActionPayload {
  message?: string
  regions?: CensorRegionInput[]
}

/** POST /api/controller/queue/[instanceId]/[submissionId]/[action] response.
 *  `body` is the VERBATIM instance JSON (kind/submission/tweetId/refund/…)
 *  so the client renders instance copy exactly (C4 pass-through). */
export interface QueueActionResponse {
  ok: boolean
  /** Instance HTTP status (0 = controller-side failure before the call). */
  status: number
  body: unknown
  error: string | null
}

// ── Instance quick actions (Epic E) ─────────────────────────

export type InstanceQuickAction = 'requeue' | 'breaker-reset' | 'clear-cache'

/** POST /api/controller/instances/[id]/actions response. */
export interface QuickActionResponse {
  ok: boolean
  status: number
  body: unknown
  error: string | null
}

// ── Submitters management (Pengirim) ───────────────────────

/** One merged submitter row. Flags (blocked / whitelisted /
 *  imageAllowed) are derived server-side by cross-referencing the
 *  instance's filter-settings ID lists against `twitterId`. */
export interface SubmitterItem {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  id: string
  username: string
  displayName: string | null
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
  blocked: boolean
  whitelisted: boolean
  imageAllowed: boolean
}

/** Per-instance slice of the merged submitters list. */
export interface SubmittersSection {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  health: InstanceHealth
  error: string | null
  retryAfterSec: number | null
  items: SubmitterItem[]
  page: number
  hasMore: boolean
  total: number
  /** false → the filter-settings cross-reference failed, so the
   *  blocked/whitelisted/imageAllowed flags are UNKNOWN (rendered
   *  as "unflagged" — the actions still work by username). */
  flagsKnown: boolean
  lastFetchedAt: string
}

/** GET /api/controller/submitters response. */
export interface SubmittersResponse {
  sections: SubmittersSection[]
  fetchedAt: string
}

/** POST /api/controller/submitters/[instanceId]/[action] verbs. */
export type SubmitterAction =
  | 'block'
  | 'unblock'
  | 'whitelist'
  | 'whitelist-remove'
  | 'image-allow'
  | 'image-deny'
  | 'overrides'
  | 'points-adjust'

// ── Payments management (Monetisasi) ───────────────────────

export type PaymentStatusFilter = 'all' | 'pending' | 'paid' | 'expired'

/** One merged payment order row. */
export interface PaymentOrder {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  id: string
  username: string
  purpose: string
  points: number | null
  amountIdr: number | null
  status: string
  verifiedBy: string | null
  refId: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
}

/** A GoBiz statement credit matching no (or 2+) pending orders —
 *  the same three-field shape for both the orphan and ambiguous queues. */
export interface UnmatchedCredit {
  refId: string
  amountIdr: number | null
  date: string | null
}

/** Per-instance slice of the merged payments list. */
export interface PaymentsSection {
  instanceId: string
  instanceName: string
  instanceColor: string | null
  health: InstanceHealth
  error: string | null
  retryAfterSec: number | null
  orders: PaymentOrder[]
  page: number
  hasMore: boolean
  total: number
  revenue: { todayIdr: number | null; totalIdr: number | null } | null
  gobiz: {
    health: {
      lastSuccessAt: string | null
      lastFailureAt: string | null
      consecutiveFailures: number | null
    } | null
    refresh: {
      configured: boolean | null
      blockedUntil: string | null
      consecutiveRejections: number | null
    } | null
    orphans: UnmatchedCredit[]
    ambiguous: UnmatchedCredit[]
    error: string | null
  } | null
  lastFetchedAt: string
}

/** GET /api/controller/payments response. */
export interface PaymentsResponse {
  sections: PaymentsSection[]
  fetchedAt: string
}

/** POST /api/controller/payments/[instanceId]/[action] verbs. */
export type PaymentAction = 'confirm' | 'void' | 'dismiss'

// ── Instance admin surfaces (settings / filter / AI / analytics) ──

/** One scalar instance setting row (value MASKED by the instance). */
export interface SettingRow {
  key: string
  value: string
  updatedAt: string | null
}

/** GET /api/controller/settings/[instanceId] response. */
export interface SettingsSnapshot {
  settings: SettingRow[]
  encryptionEnabled: boolean | null
}

/** GET /api/controller/filter-settings/[instanceId] response —
 *  defensively parsed; unknown/missing fields tolerated (NFR-X1). */
export interface FilterSettingsSnapshot {
  autoApprove: boolean | null
  blockedWords: string[]
  nsfwWords: string[]
  filterRules: Record<string, unknown> | null
  aiEnabled: boolean | null
  aiApiKeySet: boolean | null
  aiSystemPrompt: string | null
  aiImageSystemPrompt: string | null
  rateLimits: Record<string, number> | null
  circuitBreaker: Record<string, number> | null
  monetization: Record<string, number | boolean> | null
  requireFollow: boolean | null
  imagePostingMode: string | null
  postingGuidelinesEnabled: boolean | null
  postingGuidelines: { allowed: string[]; notAllowed: string[] } | null
  nsfwThresholds: Record<string, number> | null
}

/** One AI provider health probe result. */
export interface AiProviderStatus {
  id: string
  name: string | null
  model: string | null
  enabled: boolean | null
  healthy: boolean | null
  modelAvailable: boolean | null
  error: string | null
  latencyMs: number | null
}

export interface AiStatusSnapshot {
  healthy: boolean | null
  providers: AiProviderStatus[]
  encryptionEnabled: boolean | null
  error: string | null
}

/** One AI decision-stats row (phase × provider × model). */
export interface AiStatsRow {
  phase: string
  provider: string
  model: string | null
  totalCalls: number
  passCount: number
  flagCount: number
  errorCount: number
  timeoutCount: number
  passRatePct: number | null
  avgLatencyMs: number | null
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTotalTokens: number | null
  totalTokens: number | null
}

/** GET /api/controller/ai/[instanceId] response — status + stats
 *  fetched in parallel; each may degrade independently. */
export interface AiSnapshot {
  status: AiStatusSnapshot | null
  statusError: string | null
  stats: { windowHours: number | null; generatedAt: string | null; rows: AiStatsRow[] } | null
  statsError: string | null
}

/** Analytics preset windows (WIB-based on the instance side). */
export type AnalyticsRange = 'today' | '7d' | '30d' | 'month'

/** GET /api/controller/analytics/[instanceId] response — key
 *  aggregates defensively parsed; the daily series are passed as
 *  plain typed rows (arrays are zero-filled per the instance contract). */
export interface AnalyticsSnapshot {
  windowDays: number | null
  generatedAt: string | null
  submissionsDaily: Array<{ day: string; total: number | null; posted: number | null; notPassed: number | null; inFlight: number | null }>
  revenueDaily: Array<{ day: string; orders: number | null; revenueIdr: number | null }>
  submittersDaily: Array<{ day: string; count: number | null }>
  pointsDaily: Array<{ day: string; granted: number | null; spent: number | null; refunded: number | null }>
  failureClasses: Array<{ failureClass: string | null; count: number }>
  rejectionReasons: Array<{ reason: string; count: number }>
  topupPackages: Array<{ points: number | null; orders: number | null; revenueIdr: number | null }>
  userLeaderboards: {
    spenders: Array<{ username: string; totalIdr: number | null; orders: number | null }>
    posters: Array<{ username: string; submissions: number | null }>
  } | null
  funnel: {
    windowDays: number | null
    pendingNow: number | null
    created: number | null
    resumed: number | null
    qrViewed: number | null
    paid: number | null
    latePaid: number | null
    expired: number | null
    voided: number | null
  } | null
}

// ── Controller session (Epic A) ─────────────────────────────

/** GET /api/controller/session response (FR-A4). */
export interface ControllerSessionResponse {
  authenticated: boolean
  instanceCount: number
  controllerVersion: string
  configured: boolean
}

// ── Audit log (Epic F) ──────────────────────────────────────

export interface AuditEntryDto {
  id: string
  instanceId: string | null
  instanceName: string | null
  action: string
  targetId: string | null
  outcome: string
  detail: string | null
  actorIp: string
  createdAt: string
}

/** GET /api/controller/audit response. `actions` carries the distinct
 *  action names for the filter dropdown. */
export interface AuditListResponse {
  entries: AuditEntryDto[]
  total: number
  page: number
  limit: number
  actions: string[]
}
