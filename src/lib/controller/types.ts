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
 *  "Kembalikan Poin" refund action on rejected rows. */
export type QueueStatusFilter = 'all' | 'pending' | 'censored' | 'post_failed' | 'rejected'

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

export type QueueAction = 'approve' | 'reject' | 'retry' | 'refund' | 'delete'

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
