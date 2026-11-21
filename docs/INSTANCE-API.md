# Instance API Reference (Tweetfess)

> **Provenance note:** this document is the **instance-side API contract**, carried over from the Tweetfess instance app — it is the source of truth for every endpoint the Controller consumes (`docs/PRD-CONTROLLER.md` §10, Appendix A). The Controller repo implements only the client side of this contract; changes to the instance API must be reflected here (the controller's parsers tolerate unknown/missing fields — NFR-X1). Authentication details below refer to the instance app's own auth model.

This document lists every HTTP endpoint exposed by a tweetfess instance. All endpoints are under `/api/` and use JSON for request/response bodies (unless noted).

> **Authentication:** Most endpoints require either an admin token (cookie or `Authorization: Bearer`), a submitter session cookie, or a `CRON_SECRET` bearer token. The admin token design is documented in [adr/002-hmac-admin-tokens.md](adr/002-hmac-admin-tokens.md).

---

## Table of Contents

- [Public Endpoints](#public-endpoints)
  - [POST /api/submissions](#post-apisubmissions)
  - [GET /api/submissions/mine](#get-apisubmissionsmine)
- [Auth Endpoints](#auth-endpoints)
  - [GET /api/auth/twitter](#get-apiauthtwitter)
  - [GET /api/auth/twitter/callback](#get-apiauthtwittercallback)
  - [POST /api/auth/set-session](#post-apiauthset-session)
  - [GET /api/auth/me](#get-apiauthme)
  - [POST /api/auth/logout](#post-apiauthlogout)
- [Payment Endpoints](#payment-endpoints)
  - [POST /api/payments/orders](#post-apipaymentsorders)
  - [GET /api/payments/orders](#get-apipaymentsorders)
  - [GET /api/payments/orders/[id]](#get-apipaymentsordersid)
  - [GET /api/payments/points](#get-apipaymentspoints)
- [Admin Endpoints](#admin-endpoints)
  - [POST /api/admin/login](#post-apiadminlogin)
  - [POST /api/admin/logout](#post-apiadminlogout)
  - [GET /api/admin/session](#get-apiadminsession)
  - [GET /api/admin/stats](#get-apiadminstats)
  - [GET /api/admin/stats/warm](#get-apiadminstatswarm)
  - [GET/POST/DELETE /api/admin/settings](#getpostdelete-apiadminsettings)
  - [GET/POST /api/admin/filter-settings](#getpost-apiadminfilter-settings)
  - [GET /api/admin/ai-status](#get-apiadminai-status)
  - [GET /api/admin/ai-stats](#get-apiadminai-stats)
  - [GET /api/admin/analytics](#get-apiadminanalytics)
  - [POST /api/admin/clear-cache](#post-apiadminclear-cache)
  - [POST /api/admin/circuit-breaker/reset](#post-apiadmincircuit-breakerreset)
  - [GET /api/admin/submitters](#get-apiadminsubmitters)
  - [POST /api/admin/submitters/block](#post-apiadminsubmittersblock)
  - [POST /api/admin/submitters/unblock](#post-apiadminsubmittersunblock)
  - [POST/DELETE /api/admin/submitters/whitelist](#postdelete-apiadminsubmitterswhitelist)
  - [POST/DELETE /api/admin/submitters/image-post-allowlist](#postdelete-apiadminsubmittersimage-post-allowlist)
  - [PATCH /api/admin/submitters/overrides](#patch-apiadminsubmittersoverrides)
  - [POST /api/admin/submitters/points-adjust](#post-apiadminsubmitterspoints-adjust)
  - [GET /api/submissions](#get-apisubmissions)
  - [PATCH /api/submissions/[id]](#patch-apisubmissionsid)
  - [PUT /api/submissions/[id]](#put-apisubmissionsid)
  - [DELETE /api/submissions/[id]](#delete-apisubmissionsid)
  - [POST /api/submissions/[id]/post](#post-apisubmissionsidpost)
  - [POST /api/submissions/[id]/refund](#post-apisubmissionsidrefund)
  - [POST /api/submissions/[id]/censor](#post-apisubmissionsidcensor)
  - [POST /api/admin/submissions/requeue](#post-apiadminsubmissionsrequeue)
  - [GET /api/admin/payments](#get-apiadminpayments)
  - [POST /api/admin/payments/[id]/confirm](#post-apiadminpaymentsidconfirm)
  - [POST /api/admin/payments/[id]/void](#post-apiadminpaymentsidvoid)
  - [POST /api/admin/payments/ambiguous/[refId]/dismiss](#post-apiadminpaymentsambiguousrefiddismiss)
- [Cron Endpoints](#cron-endpoints)
  - [GET /api/autopost](#get-apiautopost)
  - [GET /api/nsfw-scan](#get-apinsfw-scan)
  - [GET /api/payments/sweep](#get-apipaymentssweep)
- [Dev Endpoints](#dev-endpoints)
  - [GET/POST /api/test-x](#getpost-apitest-x)
- [Error Format](#error-format)

---

## Public Endpoints

These are callable by anyone with a valid submitter session (the `menfess_session` cookie set by X OAuth login).

### POST /api/submissions

Submit a new confession. Requires a logged-in submitter session.

**Request body** — either of:

- `multipart/form-data` with `message` (text) and optional `image` (file, max 4 MB) — required when attaching an image
- `application/json` for text-only submissions:

```json
{ "message": "Your confession text" }
```

**The 14-step pipeline** (in order): load settings (fail-closed) → validate input → image-posting gate → rate limits → always-on filters (hard reject) → image sanitize + B2 upload → non-AI filters → DB insert (points charge happens here on the pay-to-post path) → AI filters → CAS status update → auto-approve branch → posting gates → X media upload → post to X.

**Response (201 Created)** — one of five `kind` values:

```json
// kind: "created" — accepted, waiting for review (auto-approve OFF)
{ "kind": "created", "submission": { "id": "clk...", "status": "pending", "...": "..." } }

// kind: "censored" — a filter flagged it; admin review needed
{ "kind": "censored", "submission": { "...": "..." }, "censoredReason": "filter", "filterReasons": ["blocked_word"] }

// kind: "pending_reverification" — the image NSFW scan could not run (infra failure,
// not a content decision); the row stays censored with nsfwStatus 'pending' and the
// nsfw-scan cron re-verifies it automatically
{ "kind": "pending_reverification", "submission": { "...": "..." }, "censoredReason": "reverification", "filterReasons": ["nsfw_scan_failed:submit"] }

// kind: "auto-posted" — posted to X immediately (auto-approve ON, gates clear)
{ "kind": "auto-posted", "submission": { "...": "..." }, "tweetId": "1234567890", "postMethod": "direct" }

// kind: "post-failed" — accepted but the X post failed; queued for admin review
{ "kind": "post-failed", "submission": { "...": "..." }, "error": "Gagal auto-post. Pesanmu masuk antrean untuk review admin." }
```

`submission.imageUrl` is a time-limited signed URL (only when an image was uploaded). `filterReasons` returned to the submitter are sanitized — the matched keyword after the colon (e.g. `blocked_word:xxx`) is stripped; the raw values are admin-only. On the `censored` kind, the top-level `filterReasons` array is present on the auto-approve-ON branch (the auto-approve-OFF body carries `kind` + `submission` + `censoredReason` only); on `pending_reverification` it is always present and uniform across both branches.

The distinct `pending_reverification` kind exists so the submitter does **not** resubmit (a resubmit on the pay-to-post path would double-charge): the UI shows "Poinmu aman" because the cron either recovers the row or — if it ends in a terminal infra-failure outcome (3-strike escalation, cron vision failure) — the payments sweep refunds the spend automatically.

**Response (202 Accepted)** — accepted but posting deferred. The submission sits in `pending` and the autopost cron (or an admin) posts it later:

```json
{ "kind": "queued", "submission": { "...": "..." }, "error": "Pesanmu sudah masuk antrean dan akan diposting oleh admin setelahnya." }
```

The `postCapped: true` variant is returned when the submitter's own daily post cap was hit:

```json
{ "kind": "queued", "submission": { "...": "..." }, "postCapped": true, "error": "Batas post harian kamu tercapai (...). Pesan masuk antrean dan akan diposting oleh admin setelahnya." }
```

**Error codes:**

| Status | When | Body |
|---|---|---|
| 400 | Validation failed (empty/too short/too long message, ALL CAPS spam, duplicate within the configured window, bad image format, image > 4 MB) | `{ "error": "Pesan terlalu pendek..." }` |
| 401 | No submitter session | `{ "error": "Silakan login dengan akun X terlebih dahulu" }` |
| 402 | Pay-to-post: a concurrent spend emptied the balance mid-flight | `{ "error": "...", "code": "payment_required", "pointsNeeded": 3, "balance": 0 }` |
| 403 | Blocked, must follow first, not eligible, not on the image allowlist, or anonymous (broken) profile | `{ "error": "Akun diblokir", "code": "forbidden", "message": "..." }` |
| 409 | Duplicate image (SHA-256 match within the configured window), or status changed mid-post (CAS abort) | `{ "error": "..." }` |
| 429 | Rate limits: cooldown, per-user daily cap, per-user pending cap, or global daily cap | `{ "error": "Tunggu sebentar", "code": "rate_limit", "message": "..." }` |
| 500 | Server error (image processing, DB insert) | `{ "error": "Terjadi kesalahan server. Coba lagi nanti." }` |
| 503 | Fail-closed: settings could not be loaded from the DB, or the circuit breaker is paused | `{ "error": "Sistem sedang sibuk. Coba lagi beberapa saat." }` |

---

### GET /api/submissions/mine

List the current submitter's own submissions, plus status stats and live limit counters.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | 1 | Page number (1-indexed) |
| `limit` | number | 50 | Items per page (clamped to `[1, 100]`) |

**Response (200):**

```json
{
  "submissions": [
    {
      "id": "clk...",
      "message": "...",
      "status": "posted",
      "tweetId": "1234567890",
      "filterReasons": null,
      "postError": null,
      "imageUrl": "https://...",  // signed URL, only if image
      "mediaId": "123...",
      "nsfwStatus": "approved",
      "imageContentType": "image/jpeg",
      "createdAt": "2026-06-19T..."
    }
  ],
  "stats": { "total": 12, "pending": 1, "posting": 0, "censored": 2, "posted": 8, "rejected": 1, "postFailed": 0 },
  "limits": {
    "dailyCap": 20, "dailyUsed": 3,
    "pendingCap": 5, "pendingUsed": 1,
    "postCap": 5, "postUsed": 2,
    "cooldownSeconds": 0,
    "isWhitelisted": false,
    "isCustom": false,
    "autoApprove": false,
    "hashtags": "menfess, confession",
    "maxMessageLength": 265,
    "canPostImage": true
  },
  "pagination": { "page": 1, "limit": 50, "total": 12, "totalPages": 1 }
}
```

`stats` is computed over the user's full history (not just the current page). `limits` reflects per-user custom limits and whitelist status (`-1` = unlimited). `nsfwCategories` is intentionally excluded — detailed NSFW probabilities are admin-only.

**Errors:** 401 (no session), 403 (anonymous profile — re-login needed), 500.

---

## Auth Endpoints

### GET /api/auth/twitter

Start the X OAuth 2.0 flow (PKCE). Redirects the user to X's authorization page.

Rate-limited: max 10 flow initiations per 15 minutes per IP (429 beyond that) — protects the `OAuthFlow` table from flooding.

**Response:** 302 Redirect to `https://x.com/i/oauth2/authorize?...`

Sets three cookies (10-minute TTL) as fallbacks for desktop browsers:
- `twitter_oauth_verifier`
- `twitter_oauth_state`
- `twitter_oauth_flow_id`

The PKCE state is primarily stored in the `OAuthFlow` database table (for mobile cross-context reliability).

---

### GET /api/auth/twitter/callback

OAuth 2.0 callback endpoint. X redirects here with `?code=...&state=...`.

**Response (success): 200** — an intermediate HTML page (not a redirect) that POSTs the session token to `/api/auth/set-session` via JavaScript, then redirects the browser to `/?auth=success`. This is more reliable on serverless CDNs than setting cookies in a redirect.

**Response (failure): 302** — redirect to `/?auth=error` (state mismatch/CSRF, expired flow, token exchange failure) or `/?auth=denied` (user refused access). OAuth temp cookies are cleared.

---

### POST /api/auth/set-session

Called by the intermediate HTML page after the OAuth callback. Sets the session cookie.

**Request body:**

```json
{ "token": "<signed-session-token>" }
```

**CSRF protection:** Validates the `Origin` (or `Referer` fallback) header matches the request `Host`. Blocks if both are absent. See [SECURITY.md](SECURITY.md).

**Response (200):**

```json
{ "success": true, "submitter": { "id": "clk...", "username": "johndoe", "...": "..." } }
```

Sets the `menfess_session` cookie (HttpOnly, SameSite=Lax, 30-day TTL). The token is an HMAC signature derived from `NEXTAUTH_SECRET`.

**Errors:** 400 (missing/invalid body or Host header), 401 (invalid token), 403 (origin mismatch), 404 (submitter no longer exists).

---

### GET /api/auth/me

Get the current submitter's profile + access state (from the session cookie). The homepage uses this to decide which walls (login / follow / eligibility / block) to show.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `refresh` | `1` | "Cek Ulang" — re-check follow status and re-pull live account metrics from X using the stored OAuth token. Every armed refresh runs live; there is no cooldown |

**Response (200, logged in):**

```json
{
  "authenticated": true,
  "submitter": {
    "id": "clk...",
    "username": "johndoe",
    "displayName": "John Doe",
    "profileImage": "https://...",
    "twitterId": "123456",
    "followersCount": 42,
    "tweetCount": 100,
    "accountCreatedAt": "2020-01-01T..."
  },
  "blocked": false,
  "blockReason": null,
  "mustFollow": false,
  "menfessHandle": "menfess_handle",
  "points": { "enabled": true, "balance": 7, "pricing": { "pricePerPointIdr": 1000, "pointsPerSubmission": 3, "unblockFeeIdr": 20000 } }
}
```

Conditional fields: `followPending` (follow check in flight), `notEligible` + `eligibilityReason`/`eligibilityDetail`/`eligibilityChecks` (below an eligibility threshold; `metricsRefreshFailed` when the live re-pull failed), and `points` (only when payments are enabled — the kill switch keeps the response identical to pre-monetization when off).

On `?refresh=1` with a confirmed follow, sets the short-lived `__fv` cookie so the next server-rendered page bypasses the in-memory follow cache.

**Response (200, not logged in):**

```json
{ "authenticated": false }
```

**Errors:** 500 (server error), 503 (fail-closed — DB outage while verifying block/eligibility).

---

### POST /api/auth/logout

Clear the submitter session cookie plus any stale OAuth cookies (`twitter_oauth_verifier`, `twitter_oauth_state`, `twitter_oauth_flow_id`).

**Response (200):**

```json
{ "success": true }
```

---

## Payment Endpoints

Points top-up & paid unblock (monetization). All require a submitter session. When `points_enabled` is off, these all return **404** and the monetization CTAs are hidden (kill switch).

### POST /api/payments/orders

Create a top-up or unblock payment order. Two limiters: a per-IP in-memory rate limit (5 orders / 15 min) plus the per-user DB caps below.

**Request body:**

```json
{ "purpose": "topup", "points": 10 }
```

- `purpose`: `topup` or `unblock`
- `points`: required for `topup` — one of the fixed packages `5`, `10`, or `20`; must be absent for `unblock`

**Per-package resume:** if a live pending top-up for the **same** package exists, it is re-issued (same order, same QR — HTTP 200). Choosing a **different** package creates a fresh order for it while any previous live invoice stays payable (at most one live pending per package — a switch never voids an issued QR); a payment landing on an order after its TTL expiry is still credited via the expired < 24 h repair path.

**Response (201 Created — new order; 200 OK — resumed order; identical body):**

```json
{
  "order": {
    "id": "cm...",
    "purpose": "topup",
    "points": 10,
    "amountIdr": 10122,
    "status": "pending",
    "expiresAt": "2025-06-15T12:15:00.000Z",
    "qrSvg": "<svg xmlns=...>"     // dynamic QRIS (exact amount embedded), server-rendered
  },
  "balance": 0
}
```

`amountIdr` = package × `price_per_point_idr` (or the unblock fee) + a unique random suffix 1–999 that disambiguates concurrent orders.

**Error codes:**

| Status | When |
|---|---|
| 400 | Invalid `purpose`, invalid/missing package for topup, or `points` sent with unblock |
| 401 | No submitter session |
| 403 | Unblock requested while not blocked |
| 404 | Payments disabled (`points_enabled` off) |
| 409 | Daily top-up cap reached, or paid-unblock cooldown active |
| 422 | Package would push the balance over the ceiling |
| 429 | Per-IP rate limit (includes a `Retry-After` header) |
| 500 | Unique-amount allocation failed (retry shortly) |
| 503 | QRIS not configured (`merchants_static_qris` not set) |

---

### GET /api/payments/orders

My order history. **Query:** `?status=pending|paid|expired&purpose=topup|unblock` (invalid values → 400). Newest first, max 20.

**Response (200):**

```json
{
  "orders": [
    {
      "id": "cm...", "purpose": "topup", "points": 5, "amountIdr": 5123,
      "status": "expired", "expiresAt": "...", "paidAt": null, "createdAt": "...",
      "latePaidAt": "2025-06-15T12:20:00.000Z"
    }
  ]
}
```

Each row carries the user-facing order fields only (the explicit select is the privacy boundary — no `verifyMeta`, `paidRefId`, `submitterId`). `latePaidAt` is DERIVED (never stored on the order): present ONLY on an expired row still inside the 24 h repair window with an unclaimed linkable statement credit — the amber "menunggu konfirmasi admin" signal (home banner + the panel's Pesanan tab). The derivation is the same one the status poll uses, batched over the page (zero extra queries when no row qualifies).

**Errors:** 400 (invalid filter), 401, 404 (kill switch), 500.

---

### GET /api/payments/orders/[id]

Status poll for the browser (every 5 s while the payment panel is live — expanded OR folded; a hidden tab skips ticks). Only the user's own orders are visible. For a pending order, triggers the TTL-gated GoBiz verification first, then returns the fresh state.

Client poll discipline (payment-panel.tsx): at most **one poll in flight** — the interval skips a tick while the previous poll has not settled; a response for a superseded poll or the previous order (a new order was created) is discarded whole (sequence-guarded); the manual "Cek Status" button deliberately bypasses the latch (newest-wins, same order).

**Response (200):**

```json
{ "order": { "status": "paid", "paidAt": "2025-06-15T12:03:11.000Z" }, "balance": 10 }
```

An expired order still inside the repair window with a detected late payment additionally carries `order.latePaidAt` (omitted otherwise).

**Errors:** 401, 404 (kill switch, or order not found / not yours), 500.

---

### GET /api/payments/points

Balance + last 20 ledger rows (top-up grants, paid submissions, admin adjustments).

**Response (200):**

```json
{
  "balance": 7,
  "ledger": [
    { "id": "cm...", "delta": -3, "balanceAfter": 7, "reason": "submission_spend", "note": null, "createdAt": "..." }
  ]
}
```

**Errors:** 401, 404 (kill switch), 500.

---

### Payment error on POST /api/submissions (402)

A concurrent spend that empties the balance mid-flight returns:

```json
{
  "error": "Poin tidak cukup — saldo berubah saat kiriman diproses",
  "code": "payment_required",
  "pointsNeeded": 3,
  "balance": 0
}
```

`GET /api/auth/me` additionally returns the `points` block shown above when payments are enabled.

---

## Admin Endpoints

All `/api/admin/*` endpoints (and `/api/test-x`, which additionally 410s outside dev/staging — see [Dev Endpoints](#getpost-apitest-x)) require admin authentication. Two ways to authenticate:

1. **Cookie:** the `admin_token` cookie (HttpOnly, SameSite=Strict; set by `/api/admin/login`)
2. **Bearer:** `Authorization: Bearer <admin_token>` header

The token is an HMAC-SHA256 signature derived from `ADMIN_PASSWORD` + an expiry timestamp, valid for 7 days. Authentication is enforced twice: once in `src/proxy.ts` (pre-handler, so bots don't spin up DB connections) and again per route via `withAdmin()`. See [ADR-002](adr/002-hmac-admin-tokens.md) and [ADR-007](adr/007-two-layer-admin-auth.md).

---

### POST /api/admin/login

Authenticate as admin.

**Request body:**

```json
{ "password": "<ADMIN_PASSWORD>" }
```

**Response (200):**

```json
{ "success": true }
```

Sets the `admin_token` cookie (7-day TTL).

**Response (401):**

```json
{ "error": "Password salah" }
```

Rate-limited: 5 failed attempts per 15 minutes per IP, then a 30-minute lockout (429 with `Retry-After` while locked).

---

### POST /api/admin/logout

Clear the admin session cookie. **No auth required** — logout must work even with an expired token (otherwise the admin couldn't clear a dead cookie).

**Response (200):**

```json
{ "success": true }
```

---

### GET /api/admin/session

Check if the admin session is valid. On success, returns the full stats payload (hot + warm merged) for initial hydration. If the stats payload fails to load, degrades gracefully to an auth-only response.

**Response (200, valid — stats included):**

```json
{
  "authenticated": true,
  "stats": {
    "pending": 5,
    "censored": 2,
    "posting": 0,
    "postFailed": 1,
    "rejected": 10,
    "posted": 150,
    "total": 168,
    "circuitBreaker": { "paused": false, "failCount": 0, "pausedUntil": null, "remainingMinutes": 0, "threshold": 3 },
    "cookieAuthStatus": { "configured": true, "source": "database", "lastUpdated": "2026-06-19T...", "missing": [] },
    "postMethodStats": { "total": 125, "direct": 120, "retry": 0, "fallback": 5, "directRate": 96, "retryRate": 0, "fallbackRate": 4 },
    "apiCredits": [{ "apiKey": "taio...key1", "rechargeCredits": 8000, "bonusCredits": 500, "totalCredits": 8500 }],
    "apiLoginStatus": { "enabled": false, "lastLoginAt": null },
    "filterSettings": { "...": "the parsed settings object, see GET /api/admin/filter-settings" },
    "postMethodSetting": "auto",
    "submitters": 432,
    "encryptionEnabled": true,
    "revenueTodayIdr": 10122
  }
}
```

**Response (200, valid — stats-error fallback):**

```json
{ "authenticated": true }
```

**Response (200, invalid):**

```json
{ "authenticated": false }
```

---

### GET /api/admin/stats

Get dashboard **hot stats** — submission status counts + circuit breaker status. Polled every 15 s. Cheap and fast-changing; never cached (no `refresh` parameter).

**Response (200):**

```json
{
  "pending": 5,
  "censored": 2,
  "posting": 0,
  "postFailed": 1,
  "rejected": 10,
  "posted": 150,
  "total": 168,
  "circuitBreaker": {
    "paused": false,
    "failCount": 0,
    "pausedUntil": null,
    "remainingMinutes": 0,
    "threshold": 3
  }
}
```

---

### GET /api/admin/stats/warm

Get dashboard **warm stats** — slower-changing data: connection status, credits, post-method stats, filter settings, submitter count, encryption flag, today's revenue. Polled every 60 s. Pass `?refresh=true` to invalidate caches before fetching (serverless instances each keep their own cache). Both polls pause while the browser tab is hidden; when it becomes visible again the client fires one immediate hot + warm pair.

**Response (200):**

```json
{
  "cookieAuthStatus": {
    "configured": true,
    "source": "database",
    "lastUpdated": "2026-06-19T...",
    "missing": []
  },
  "postMethodStats": {
    "total": 125,
    "direct": 120,
    "retry": 0,
    "fallback": 5,
    "directRate": 96,
    "retryRate": 0,
    "fallbackRate": 4
  },
  "apiCredits": [
    { "apiKey": "taio...key1", "rechargeCredits": 8000, "bonusCredits": 500, "totalCredits": 8500 }
  ],
  "apiLoginStatus": {
    "enabled": false,
    "lastLoginAt": null
  },
  "filterSettings": {
    "autoApprove": false,
    "blockedWords": ["..."],
    "rateLimits": { "...": "effective limit values" },
    "circuitBreaker": { "...": "effective breaker values" },
    "monetization": { "pointsEnabled": false, "...": "see CONFIGURATION.md" },
    "menfessAccountHandle": "menfess_handle",
    "defaultBlockedWords": ["..."],
    "defaultNsfwWords": ["..."],
    "defaultAISystemPrompt": "...",
    "defaultAiImageSystemPrompt": "...",
    "defaultPostingGuidelines": { "allowed": [], "notAllowed": [] }
  },
  "postMethodSetting": "auto",
  "submitters": 432,
  "encryptionEnabled": true,
  "revenueTodayIdr": 10122
}
```

`postMethodStats.fallback` combines `fallback_cookie` + `fallback_login`; legacy posts without a method count as `direct`. `apiCredits` has one entry per configured twitterapi.io key (fetched from the free `/oapi/my/info` endpoint).

---

### GET/POST/DELETE /api/admin/settings

Scalar admin settings (X credentials, GoBiz credentials, posting method) — one key at a time. Filter-type settings (word lists, caps, monetization) belong to [/api/admin/filter-settings](#getpost-apiadminfilter-settings) instead.

**GET** — all `Setting` rows with values masked:

```json
{
  "settings": [
    { "key": "x_username", "value": "men***ess", "updatedAt": "2026-06-19T..." },
    { "key": "x_cookie_string", "value": "***", "updatedAt": "2026-06-19T..." }
  ],
  "encryptionEnabled": true
}
```

**POST** — upsert one setting:

```json
{ "key": "gobiz_session_token", "value": "eyJ..." }
```

Only the 16 keys in `VALID_KEYS` (`src/lib/core/setting-keys.ts`) are accepted: `x_cookie_string`, `x_bearer_token`, `twitterapi_keys`, `twitterapi_proxy`, `post_method`, `x_username`, `x_email`, `x_password`, `x_totp_secret`, `twitterapi_login_cookie`, `v2_login_enabled`, `post_hashtags`, `require_follow`, `gobiz_session_token`, `gobiz_refresh_token`, `merchants_static_qris`. Encrypted keys are encrypted before storage; saving a V2-login credential key triggers `tryAutoLogin` automatically. **Response:** `{ "setting": { "key": "...", "updatedAt": "..." }, "autoLogin": ... }` (plus `parsed` cookie details for `x_cookie_string`, `keyCount` for `twitterapi_keys`).

**DELETE** — `?key=<name>` removes one setting. Deleting a V2 login auth field (`x_username`, `x_email`, `x_password`, `x_totp_secret`) also clears the cached `twitterapi_login_cookie`. **Response:** `{ "success": true }`.

---

### GET/POST /api/admin/filter-settings

The batched settings save endpoint (the admin UI's Settings tabs). All writes happen in one Prisma transaction, so a crash mid-save can't leave half-applied settings. **Whitelist/blocklist/image-allowlist are NOT saved here** — those have dedicated atomic routes (see [Submitters](#get-apiadminsubmitters)) that prevent a stale form overwriting concurrent block/unblock actions.

**GET** — the full parsed settings object (camelCase field names, sensitive values like AI API keys stripped):

```json
{
  "autoApprove": false,
  "blockedWords": ["spam"],
  "nsfwWords": [],
  "filterRules": { "blockedWords": true, "urls": true, "...": "..." },
  "aiEnabled": false,
  "aiApiKeySet": false,
  "aiProviders": [],
  "aiSystemPrompt": "...",
  "aiImageSystemPrompt": "...",
  "rateLimits": { "submissionCooldown": 2, "...": "..." },
  "circuitBreaker": { "circuitBreakerThreshold": 3, "...": "..." },
  "monetization": { "pointsEnabled": false, "...": "..." },
  "whitelistTwitterIds": [],
  "blockedTwitterIds": [],
  "requireFollow": false,
  "nsfwThresholds": { "Porn": 0.25, "...": "..." },
  "imagePostingMode": "everyone",
  "imagePostTwitterIds": [],
  "postingGuidelinesEnabled": true,
  "postingGuidelines": { "allowed": [], "notAllowed": [] },
  "defaults": { "blockedWords": ["..."], "rateLimits": {}, "monetization": {}, "...": "factory defaults" }
}
```

**POST** — a partial object of settings to update; only provided keys are written:

```json
{
  "autoApprove": true,
  "blockedWords": ["spam", "kontol"],
  "filterRules": { "blockedWords": true, "urls": false },
  "rateLimits": { "submissionDailyCap": 30 },
  "monetization": { "pricePerPointIdr": 1000 }
}
```

Accepted groups: `autoApprove`, `blockedWords`, `nsfwWords`, `filterRules`, `aiEnabled`, `aiProviders`, `aiApiKeys`, `aiSystemPrompt`, `aiImageSystemPrompt`, `rateLimits`, `circuitBreaker`, `monetization`, `imagePostingMode`, `requireFollow`, `postingGuidelinesEnabled`, `postingGuidelines`, `nsfwThresholds`. Rate-limit and circuit-breaker values are clamped to their per-field bounds; monetization values outside `MONETIZATION_DEFS` bounds are rejected with 400.

**Response (200):**

```json
{
  "success": true,
  "results": [
    { "key": "auto_approve", "updated": true },
    { "key": "blocked_words", "updated": true }
  ]
}
```

After the transaction commits, the filter-settings cache is invalidated, the autopost work flag is marked pending (cap changes may make old submissions eligible), and the follow cache is cleared when `requireFollow` changed.

---

### GET /api/admin/ai-status

Health check for configured AI providers. Calls each provider's `GET /models` (a zero-cost operation) and, when the catalog is parseable, verifies the configured model IDs actually exist in it.

**Response (200):**

```json
{
  "healthy": true,
  "providers": [{ "id": "openai-1", "name": "OpenAI GPT-4o", "model": "gpt-4o", "enabled": true, "...": "client-safe config" }],
  "results": [
    {
      "id": "openai-1",
      "name": "OpenAI GPT-4o",
      "model": "gpt-4o",
      "healthy": true,
      "modelAvailable": true,
      "error": null,
      "latencyMs": 234
    }
  ],
  "encryptionEnabled": true,
  "error": null
}
```

`modelAvailable` is `null` when the catalog couldn't be parsed (verification unavailable). Overall `healthy` requires at least one provider that is both reachable and serving its configured model.

---

### GET /api/admin/ai-stats

AI moderation decision statistics — aggregated per phase × provider × model over a rolling 24-hour window (from the `AIDecisionLog` table). Cached 10 minutes server-side; pass `?refresh=true` to bypass.

Also runs the time-gated (≤ 1/hour) 30-day retention sweep for old decision logs; the number of deleted rows is returned as `deletedRows`.

**Response (200):**

```json
{
  "windowHours": 24,
  "generatedAt": "2026-06-19T12:00:00.000Z",
  "rows": [
    {
      "phase": "text",
      "provider": "openai-1",
      "model": "gpt-4o-mini",
      "totalCalls": 180,
      "passCount": 160,
      "flagCount": 18,
      "errorCount": 2,
      "timeoutCount": 0,
      "passRatePct": 88.9,
      "avgLatencyMs": 215,
      "p50LatencyMs": 190,
      "p95LatencyMs": 640,
      "avgTotalTokens": 310,
      "totalTokens": 55800
    }
  ],
  "deletedRows": 0
}
```

One row per phase (`text` / `vision`) × provider × model. `windowHours` is the rolling window (24 h); `generatedAt` goes stale while the 10-minute cache serves.

---

### GET /api/admin/analytics

The admin Statistik page payload — the SELECTED WIB window's read-only trends and breakdowns in one aggregate. The default 30-day range serves a 10-minute TTL cache (single instance, single-flight); `?refresh=true` invalidates it before fetching, the clear-cache route invalidates it too, and every other range is fetched fresh.

**Query parameters** (a preset or a custom span — never both; every violation returns a specific 400):

| Param | Type | Default | Description |
|---|---|---|---|
| `range` | string | `30d` | Preset token: `today` \| `7d` \| `30d` \| `month` |
| `from` | string | — | Custom-span start (`YYYY-MM-DD`, required together with `to`) |
| `to` | string | — | Custom-span end (`YYYY-MM-DD`; a future date clamps to today WIB) |
| `refresh` | string | — | `true` invalidates the cache before fetching |

Custom-span rules: `from` ≤ `to` (calendar day keys — `2026-02-30` is a 400), `from` not in the future, and the span ≤ 366 days.

**Response (200)** (illustrative — the contract is the shape plus its invariants: the four `*Daily` arrays and `topupTrend.daily` carry exactly `windowDays` ascending, zero-filled rows of the selected window; `failureClass` may be `null`; `topupTrend.packages` carries the window's top-5 packages by paid orders in ranking order, plus the aggregate `Lainnya` column (`null`) only when more than 5 sold):

```json
{
  "windowDays": 30,
  "generatedAt": "2026-10-05T09:20:41.117Z",
  "submissionsDaily": [ { "day": "2026-09-06", "total": 38, "posted": 27, "notPassed": 9, "inFlight": 2 } ],
  "revenueDaily":    [ { "day": "2026-09-06", "orders": 3, "revenueIdr": 61500 } ],
  "submittersDaily": [ { "day": "2026-09-06", "count": 2 } ],
  "pointsDaily":     [ { "day": "2026-09-06", "granted": 70, "spent": 55, "refunded": 15 } ],
  "failureClasses":  [ { "failureClass": "auth_failure", "count": 23 }, { "failureClass": null, "count": 5 } ],
  "rejectionReasons": [ { "reason": "blocked_word", "count": 41 } ],
  "topupPackages":   [ { "points": 10, "orders": 41, "revenueIdr": 20500 } ],
  "topupTrend": {
    "packages": [10, 20, 5, 7, 30, null],
    "daily":    [ { "day": "2026-09-06", "orders": [0, 20, 20, 0, 0, 2] } ]
  },
  "userLeaderboards": {
    "spenders": [ { "username": "budi", "totalIdr": 410000, "orders": 3 } ],
    "posters":  [ { "username": "budi", "submissions": 23 } ]
  },
  "funnel": {
    "windowDays": 30, "pendingNow": 4, "created": 120, "resumed": 8,
    "qrViewed": 89, "paid": 52, "latePaid": 3, "expired": 14, "voided": 2
  }
}
```

Day buckets are WIB calendar days; the last row is today WIB and therefore partial. `points` in `topupPackages` is the granted snapshot (base + bonus). `topupTrend` derives from the same (day, points) query rows as `topupPackages` — the two cards' order totals are equal by construction; `topupTrend.daily[i].orders[k]` is that day's paid orders of `packages[k]`, zero-filled per series per day. The `funnel` object is the same `getPaymentFunnel()` result the Monetisasi footer renders — same function, same numbers; `pendingNow` is the value at cache-fill time, not live.

---

### POST /api/admin/clear-cache

Clear all server-side caches: filter settings, follow, credits, post-method stats, AI decision stats, analytics, GoBiz statement + merchant, X transaction ID + pair dictionary, create-tweet spec (placeholder/queryId DB rows are deleted so the next post re-fetches them), post-method stats. Useful when X updates their frontend and cached data goes stale.

**Response (200):**

```json
{
  "success": true,
  "message": "Cache dibersihkan (12 jenis)"
}
```

---

### POST /api/admin/circuit-breaker/reset

Manually reset the circuit breaker (clear failure count + pause). Also marks autopost work pending so `post_failed` submissions become eligible again.

**Response (200):**

```json
{ "success": true, "message": "Circuit breaker reset" }
```

---

### GET /api/admin/submitters

List submitters with per-status submission counts (server-side pagination + search).

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | 1 | Page number |
| `limit` | number | 50 | Items per page (clamped to `[1, 200]`) |
| `search` | string | (none) | Search by username or display name (case-insensitive) |

**Response (200):**

```json
{
  "submitters": [
    {
      "id": "clk...",
      "username": "johndoe",
      "displayName": "John Doe",
      "profileImage": "https://...",
      "twitterId": "123456",
      "customLimits": null,
      "createdAt": "2026-06-01T...",
      "totalSubmissions": 12,
      "posted": 8,
      "pending": 1,
      "censored": 2,
      "posting": 0,
      "rejected": 1,
      "postFailed": 0
    }
  ],
  "totalCount": 100,
  "totalPages": 2,
  "page": 1,
  "limit": 50,
  "hasMore": true
}
```

---

### POST /api/admin/submitters/block

Block a submitter by username. Writes are atomic PostgreSQL jsonb operations (no read-merge-write race). Blocking also removes the user from the whitelist, stores the optional reason, and **auto-rejects their pending/censored/post_failed submissions** with `postError: "[Auto] Submitter blocked"`.

**Request body:**

```json
{ "username": "johndoe", "reason": "Spamming submissions" }
```

`username` is normalized (lowercased, leading `@` stripped). If the user has never logged in, a placeholder Submitter row is created so pre-emptive blocks work.

**Response (200):**

```json
{ "success": true, "blocked": "johndoe" }
```

**Errors:** 400 (missing/invalid username).

---

### POST /api/admin/submitters/unblock

Remove a submitter from the blocklist (also clears their block reason).

**Request body:**

```json
{ "username": "johndoe" }
```

**Response (200):**

```json
{ "success": true, "unblocked": "johndoe" }
```

**Errors:** 400 (user not found in blocklist).

---

### POST/DELETE /api/admin/submitters/whitelist

Add/remove a submitter from the whitelist (bypasses eligibility + follow checks + per-user limits). Adding to the whitelist also removes the user from the blocklist and clears their block reason.

**Request body (both methods):**

```json
{ "username": "johndoe" }
```

**Response (200):**

```json
{ "success": true, "whitelisted": "johndoe" }   // POST
{ "success": true, "removed": "johndoe" }       // DELETE
```

**Errors:** 400 (DELETE: user not found in whitelist).

---

### POST/DELETE /api/admin/submitters/image-post-allowlist

Add/remove a submitter from the image-posting allowlist (used when `image_posting_mode` is `allowlist`).

**Request body (both methods):**

```json
{ "username": "johndoe" }
```

**Response (200):**

```json
{ "success": true, "added": "johndoe" }         // POST
{ "success": true, "removed": "johndoe" }       // DELETE
```

**Errors:** 400 (DELETE: user not found in allowlist).

---

### PATCH /api/admin/submitters/overrides

Set/clear per-user overrides for a submitter — the **limits family** (`customLimits`) and/or the **pricing family** (`customPricing`), in one request, one transaction, one response. (Renamed from `.../limits`; no old path kept.)

**Request body:**

```json
{
  "username": "johndoe",
  "customLimits": {
    "submissionDailyCap": 50,
    "userPostDailyCap": 20
  },
  "customPricing": {
    "topupDiscountPercent": 20
  }
}
```

- Either family may be omitted (untouched by the save); at least one must be present
- Limits keys (camelCase, the 7 per-user fields): `submissionCooldown`, `submissionDailyCap`, `userPendingCap`, `userPostDailyCap`, `minAccountAgeDays`, `minFollowers`, `minTotalPosts` — `-1` = unlimited; a number ≥ -1 sets the override
- Pricing keys (the 3 per-user scalars): `topupDiscountPercent` (0–90; an explicit `0` suppresses a live global promo for this user — the discount REPLACES the global one, never stacks), `pointsPerSubmission` (1–100), `unblockFeeIdr` (1000–499001)
- `null` for a key removes that single override; a family `null` clears **all** of that family's overrides
- A `topupDiscountPercent` set-entry is cross-checked against the live package list + live global price: a discount that would push any live package below the real-paid-amount floor (Rp 10) is refused (400)

**Response (200):**

```json
{ "success": true, "submitter": { "id": "clk...", "username": "johndoe", "customLimits": { "...": "..." }, "customPricing": { "topupDiscountPercent": 20 } }, "previousCustomLimits": null, "previousCustomPricing": null }
```

**Errors:** 400 (invalid key, out-of-bounds value, sub-floor discount, body carrying neither family).

---

### POST /api/admin/submitters/points-adjust

Create an `admin_adjust` ledger entry (refund/compensation). **The note is mandatory** — it is the audit trail.

**Request body:**

```json
{ "username": "dimas", "delta": -3, "note": "refund post berbayar yang di-moderasi" }
```

**Response (200):**

```json
{ "success": true, "balance": 4 }
```

**Errors:** 400 (missing username, `delta` not a non-zero integer, empty note), 404 (unknown user), 409 (positive delta would exceed the balance ceiling; negative delta would go below zero).

---

### GET /api/submissions

List all submissions (admin only). Includes submitter info + computed per-submitter limits.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | 1 | Page number |
| `limit` | number | 50 | Items per page (clamped to `[1, 200]`) |
| `status` | string | `all` | Filter by status: `pending`, `censored`, `posting`, `post_failed`, `rejected`, `posted` (invalid value → 400) |
| `search` | string | (none) | Search message text, username, display name |

**Response (200):**

```json
{
  "submissions": [
    {
      "id": "clk...",
      "message": "...",
      "status": "pending",
      "tweetId": null,
      "postMethod": null,
      "postError": null,
      "filterReasons": null,
      "imageUrl": "https://...",
      "nsfwStatus": "approved",
      "nsfwCategories": "{\"Porn\":0.01,...}",
      "createdAt": "2026-06-19T...",
      "updatedAt": "2026-06-19T...",
      "submitter": {
        "id": "clk...",
        "username": "johndoe",
        "displayName": "John Doe",
        "profileImage": "https://...",
        "twitterId": "123456",
        "limits": { "dailyCap": 20, "dailyUsed": 3, "pendingCap": 5, "pendingUsed": 1, "postCap": 5, "postUsed": 2, "isWhitelisted": false, "isBanned": false, "isCustom": false }
      }
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 100, "totalPages": 2, "hasMore": true }
}
```

Admin responses keep **raw** `filterReasons` (with the matched keyword after the colon) — unlike the submitter-facing routes, which sanitize them.

---

### PATCH /api/submissions/[id]

Approve or reject a submission (admin only).

**Request body:**

```json
{ "status": "approved" }   // or "rejected"
```

**Approve** (`status: "approved"`) — valid from `pending`, `censored`, or `post_failed`:
- Posts the submission to X immediately (with the full retry + fallback ladder). NSFW-flagged submissions are marked `nsfwStatus: 'approved'` first (admin override).
- When auto-approve is ON and the submission was `censored`, posting gates are respected: circuit breaker / cooldown / window cap / user post cap defer it back to `pending` (202 queued response); the global post cap returns 400.
- When auto-approve is OFF, only the circuit breaker can block the admin (503) — cooldowns/caps are treated as autopost-specific.

**Reject** (`status: "rejected"`) — valid from `pending`, `censored`, or `post_failed` (CAS-guarded against concurrent changes; a `nsfwStatus` is set to `rejected` unless it was already terminal).

**Response (200, posted):**

```json
{ "kind": "auto-posted", "submission": { "id": "clk...", "status": "posted", "...": "..." }, "tweetId": "1234567890", "postMethod": "direct", "description": "Pesan otomatis diposting ke X." }
```

**Response (200, queued — deferred):**

```json
{ "kind": "queued", "submission": { "...": "..." }, "deferReason": "cooldown", "message": "Disetujui, tapi sedang ada jeda antar post..." }
```

**Response (200, post failed):**

```json
{ "kind": "error", "submission": { "...": "..." }, "error": "Disetujui, tapi gagal posting ke X: ...", "postMethod": "direct" }
```

**Response (200, rejected):**

```json
{ "submission": { "id": "clk...", "status": "rejected", "...": "..." }, "refund": "refunded" }
```

`refund` rides the response only when the `auto_refund_on_reject` policy is ON — the synchronous settlement outcome of the paid spend (`refunded`; `no-spend` for free rows; `over-balance` defers to a manual settle via [POST /api/submissions/[id]/refund](#post-apisubmissionsidrefund); `not-refundable` — the status left the eligible set before the CAS, no refund happened). When the policy is OFF the field is absent: no refund was attempted, and the rejected row keeps holding its spend until the manual settle.

**Error codes:** 400 (invalid status value; already `posted`/`rejected`; global post cap on approve), 404 (not found), 409 (currently `posting` and not stale — CAS conflict message "Status submission telah berubah. Refresh halaman."; posting lock busy), 429 (caps hit under the lock), 503 (circuit breaker active).

---

### PUT /api/submissions/[id]

Edit the submission's message text (admin only) — the message-only content edit. No status change, no filter pipeline: the sanitized text replaces the stored message (hashtags append at post time, so a saved-while-editing hashtag change converges on the next read).

**Request body:**

```json
{ "message": "edited confession text" }
```

**Status gate:** identical to the censor verb — editable from `pending` / `censored` / `post_failed`; `posted` → 400 (terminal), fresh `posting` → 409, `rejected`/refunded → 400.

**Response (200):**

```json
{ "success": true, "changed": true, "submission": { "id": "clk...", "message": "edited confession text" } }
```

`changed: false` is the no-op guard — a zero-effect save (identical message) performs no write.

**Error codes:** 400 (non-string/empty message, below the shared min-length floor, invalid status), 404 (not found), 409 (posting CAS conflict).

---

### DELETE /api/submissions/[id]

Delete a submission (admin only). Deletes the B2 image too (best-effort).

**Response (200):**

```json
{ "success": true }
```

**Error codes:**

| Status | When |
|---|---|
| 404 | Submission not found |
| 409 | Currently `posting` (and not stale — wait a few minutes), or already `posted` (terminal — the tweet is on X and can't be undone) |

A `posting` status stuck for > 2 minutes is auto-recovered as stale, then the delete proceeds.

---

### POST /api/submissions/[id]/post

Manually retry posting a submission to X (admin only). Valid from `pending`, `censored`, or `post_failed` — the same validation as approve. NSFW-flagged submissions get the admin override (marked approved). Circuit breaker active → 503.

**Response (200, success):**

```json
{ "kind": "auto-posted", "submission": { "...": "..." }, "tweetId": "1234567890", "postMethod": "retry", "retriesUsed": 2 }
```

**Response (200, failed):**

```json
{ "kind": "error", "submission": { "...": "..." }, "error": "Gagal posting ke X: 401 Unauthorized. Cek X Settings lalu klik \"Post to X\" untuk retry.", "postMethod": "direct" }
```

**Error codes:** 400 (invalid status for retry; already posted/rejected), 404 (not found — also returned post-failure when the row vanished), 409 (currently `posting`; lock busy; CAS abort), 202 (queued — cooldown/window cap hit under the lock), 429 (post caps), 503 (circuit breaker).

---

### POST /api/submissions/[id]/refund

Manually settle a rejected row's spend (admin only, no request body) — the dashboard's **Kembalikan Poin** button. Works in **both** `auto_refund_on_reject` modes: the per-case settler when the switch is OFF, and the retry for a reject-time refund that the points-balance ceiling blocked when it is ON (the button stays on the card until `refundedAt` lands). The money moves through the same CAS-idempotent engine as every automatic settlement.

**Population gate:** the row must be `rejected`, and it must not be a 187 true-duplicate reject (`postError: "Duplicate of submission …"` — that content is live on X via the twin row, so its spend is never refundable).

**Response (200):**

```json
{ "submission": { "id": "clk...", "status": "rejected", "refundedAt": "2026-...", "...": "..." }, "refund": "refunded" }
```

`refund` is the engine outcome: `refunded` (settled now — the response carries the fresh re-read row), `already-refunded` (replay — a double click is harmless), `no-spend` (free row — nothing was deducted), `over-balance` (the balance ceiling blocked the settle; nothing was consumed, retry later).

**Error codes:**

| Status | When |
|---|---|
| 400 | Not `rejected` (live rows settle via their own synchronous sites), or a 187-marked duplicate reject |
| 404 | Unknown id — also the answer when a racing delete removes the row |
| 409 | The CAS raced a concurrent delete: `{ "kind": "error", "submission": ... }` with `error: "Status pesan berubah sebelum diproses. Cek riwayat submission-mu."` — the honest current row rides the response |

---

### POST /api/submissions/[id]/censor

Region image censor (admin only). The instance downloads the CURRENT image bytes, renders the censor regions server-side, and uploads the result as a NEW immutable content-addressed object — the four image-pointer fields on the row CAS-swap to it (approve/retry/autopost all consume the new bytes with zero posting-side changes). The original bytes stay in storage, orphaned, until bucket lifecycle expires them.

**Status gate:** identical to the edit verb — censorable from `pending` / `censored` / `post_failed`; `posted` → 400, fresh `posting` → 409, `rejected`/refunded → 400. Requires the row to HAVE an image (400 otherwise).

**Request body** — `regions`: 1–16 rects in FRACTIONAL image coordinates (`x`/`y`/`w`/`h` in 0..1, `x+w`/`y+h` within bounds), each with a whitelisted `type`. Optional `angle` rotates the rect around its own center (degrees, −180..180; absent = axis-aligned, explicit 0 collapses to absent). Optional `intensity` is per-type (pixelate: mosaic block size; blur: gaussian sigma; black: ignored/absent):

```json
{
  "regions": [
    { "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.2, "type": "pixelate" },
    { "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.25, "type": "black", "angle": 15 }
  ]
}
```

**Response (200):**

```json
{ "success": true, "submission": { "id": "clk...", "imageSha256": "<new sha>", "...": "the updated row" }, "regions": 2 }
```

The new `imageSha256` is the cache-bust key: clients that proxy media with `?v=<sha prefix>` re-fetch the censored version automatically.

**Error codes:** 400 (no image on the row; invalid region format/bounds/type/angle/intensity; invalid status), 404 (not found), 409 (posting CAS conflict), 500 (image storage not configured / image load failed), 503 (storage cap window).

---

### POST /api/admin/submissions/requeue

Bulk-requeue **retryable** `post_failed` submissions back to `pending` (bodyless). Rows with a permanent failure class stay put — their spend settles via the refund universe (the sweep's step e) — and legacy NULL-class rows wait for the autopost self-heal to backfill their class. `postError` survives (history); the derived `failureClass` is cleared. If anything was requeued, autopost work is marked pending so the cron picks the rows up.

**Response (200):**

```json
{ "requeued": 3 }
```

---

### GET /api/admin/payments

Orders list + revenue aggregates + GoBiz health + the unattributed-credit queues for the Monetisasi tab. Filters: `?status=pending|paid|expired&purpose=topup|unblock&page=N` (30/page; invalid filter → 400). The orphan queue is computed fresh from the TTL-gated GoBiz statement on every call; the ambiguous queue is durable (`AmbiguousCredit` table) — it outlives the 1-day statement window and is served even while the statement fetch fails.

**Response (200, trimmed):**

```json
{
  "orders": [
    { "id": "cm...", "username": "dimas", "purpose": "topup", "points": 10, "amountIdr": 10122,
      "status": "paid", "verifiedBy": "gobiz", "verifyMeta": "{...}", "expiresAt": "...", "paidAt": "...", "createdAt": "..." }
  ],
  "total": 1,
  "page": 1,
  "revenue": { "todayIdr": 10122, "totalIdr": 312000 },
  "gobiz": {
    "health": { "lastSuccessAt": "...", "lastFailureAt": null, "consecutiveFailures": 0 },
    "refresh": { "configured": true, "blockedUntil": null, "consecutiveRejections": 0 },
    "orphans": [],
    "ambiguous": [],
    "error": null
  }
}
```

`gobiz.error` is non-null when the statement could not be fetched (dead session token / backoff). `gobiz.refresh` is the session-keeper state: `configured` = a refresh token is set, `blockedUntil` is non-null while a definitive-rejection cooldown is active (the card's "tempel token baru" banner). `orphans` are statement credits matching no pending order (late payments — money is never silently dropped). `ambiguous` are credits whose amount collided across 2+ pending orders (rows of the same three-field shape) — held unmatchable until an admin resolves them via confirm-with-ref or [dismiss](#post-apiadminpaymentsambiguousrefiddismiss). Revenue sums **paid** orders only (they are the permanent record).

---

### POST /api/admin/payments/[id]/confirm

Repair confirm (the human fallback for GoBiz failure modes — NOT a payment channel; money must have actually arrived). Runs the same completion transaction with `verifiedBy='admin'`. Valid on **pending** orders and on orders **expired < 24 h** (late-payment repair, flagged `latePayment`). Every confirm is audited with a mandatory note. Optional `refId` (`gobiz:<txId>`, invalid format → 400): claims the statement reference — `paidRefId` arms the replay shield so the same credit can never also auto-complete another order, and any ambiguity hold resolves in the same transaction (an already-claimed ref → 409).

**Request body:**

```json
{ "note": "dana sudah masuk di GoBiz, poller error", "refId": "gobiz:TXN123" }
```

**Response (200):**

```json
{ "success": true, "overBalance": false, "latePayment": false }
```

**Error codes:** 400 (empty/missing note), 404 (order not found), 409 (already paid; the reference was consumed by another order; or expired > 24 h — compensate via points-adjust instead).

---

### POST /api/admin/payments/[id]/void

Early expiry of a pending order (typo'd amounts, abandoned flows). CAS pending→expired; idempotent.

**Response (200):**

```json
{ "success": true }
```

**Error codes:** 404 (order not found), 409 (order not pending).

---

### POST /api/admin/payments/ambiguous/[refId]/dismiss

Dismiss a durable ambiguity hold the admin determines is **not** a real payment (e.g. a same-amount transfer from an unrelated party). Bodyless by design — the void precedent: dismiss moves no money, so it carries no note; the two-click confirm in the Monetisasi tab is the irreversibility friction. Resolution encoding: a claim writes `resolvedAt` + `resolvedOrderId`, a dismiss writes `resolvedAt` alone — distinguishable forever. `refId` must match `gobiz:<txId>` (copy it from the ambiguous queue). A wrong dismissal blocks nothing downstream: the claim write only fires from the confirm-with-ref path, and the points-adjust remedy carries its own mandatory note.

**Response (200):**

```json
{ "success": true }
```

**Error codes:** 400 (invalid `refId` format), 404 (hold not found), 409 (already resolved — raced a confirm-with-ref claim or a repeat click).

---

## Cron Endpoints

These endpoints are called by an external cron service (e.g. cron-job.org). They all require `Authorization: Bearer <CRON_SECRET>` (timing-safe comparison) and return `Cache-Control: no-store`. Recommended cadence: `/api/autopost` every **2 minutes**, `/api/payments/sweep` every **2 minutes**, `/api/nsfw-scan` every **5 minutes**. All three have `maxDuration = 30` (Vercel function timeout).

### GET /api/autopost

Run one autopost cycle — picks the next eligible submission (oldest first, skipping blocked users and users at their post cap) and posts it to X. Processes **exactly 1 submission per hit** (the 2-minute cadence plus the `auto_post_cooldown` setting spread posts out).

**Headers:**

```
Authorization: Bearer <CRON_SECRET>
```

**Response (200, posted):**

```json
{
  "processed": true,
  "submissionId": "clk...",
  "tweetId": "1234567890",
  "postMethod": "direct"
}
```

**Response (200, no work):**

```json
{ "processed": false, "reason": "no_eligible_submissions" }
```

All `reason` values:

| Reason | Meaning |
|---|---|
| `no_eligible_submissions` | Nothing pending (or the smart-skip flag says the DB is empty) |
| `all_candidates_capped` | Candidates exist but every submitter is at their post cap |
| `auto_approve_off` | Auto-approve is disabled, nothing to auto-post |
| `circuit_breaker_paused` | Circuit breaker is open — includes `pausedUntil` + `remainingMinutes` |
| `auth_not_configured` | X cookies/bearer missing — includes a `missing` array |
| `posting_lock_busy` | Another post is in progress (skip this cycle) |
| `status_changed` | The submission's status changed before the post (CAS abort) |
| `image_resolution_failed` | B2 download + X upload both failed — includes `submissionId`; the row is marked `post_failed` |
| `post_failed` | The X post failed after retries — includes `submissionId` + `error` |
| `cooldown_active` / `window_cap_reached` / `global_post_daily_cap_reached` / `user_post_cap_reached` | Under-lock gate aborts |
| `settings_load_failed` | Couldn't load settings (DB issue) — **the only reason that returns HTTP 503** |

All other failures return 200 with `processed: false` — the cron service shouldn't retry on those.

---

### GET /api/nsfw-scan

Safety-net scan for images stuck in `nsfwStatus: 'pending'` (e.g. the NSFW model timed out or the submission was queued on first attempt). Scans up to 5 submissions per run (FIFO): re-downloads from B2, re-runs the local ensemble model, and applies the verdict (approved submissions become eligible for autopost; flagged ones go to admin review; repeated download/scan failures escalate to review).

**Headers:**

```
Authorization: Bearer <CRON_SECRET>
```

**Response (200, nothing to scan):**

```json
{ "processed": false, "reason": "no_pending_images" }
```

**Response (200, pending rows existed but every one was deferred):**

```json
{ "processed": false, "reason": "all_deferred" }
```

`all_deferred` means the queue was NOT idle — pending rows existed but none produced a scan result this run (budget deferral, vision-headroom deferral, non-escalating failures, lost CAS races). Distinguishing it from `no_pending_images` keeps the cron signal honest.

**Response (200, scanned):**

```json
{
  "processed": 5,
  "results": [
    { "id": "clk...", "decision": "approved", "score": 0 },
    { "id": "clk...", "decision": "flagged", "score": 0.62 }
  ]
}
```

`decision` is `approved` / `flagged`, or `escalated:download` / `escalated:scan` when the attempt failed repeatedly and the submission was escalated to admin review.

---

### GET /api/payments/sweep

Payment-order hygiene cycle (every 2 min, next to `/api/autopost`). Order of operations — verification runs **before** expiry so a razor-edge payment (paid just before `expiresAt`) still matches its pending order instead of orphaning:

- **(a)** verify pending orders as a safety net (GoBiz, batch ≤ 20)
- **(b)** expire stale pending orders (CAS pending→expired) — gated on (a): during a GoBiz outage orders stay pending so the matcher can self-serve them on recovery
- **(c)** report unattributed credits — orphans and newly detected ambiguous collisions (durably persisted) — runs only while pending orders exist or an expired order is still inside the 24 h repair window; a quiet store makes **zero** upstream calls
- **(d)** time-gated (≤ 1/hour) 90-day cleanups — **expired** orders only (paid orders are the permanent revenue record), **resolved** ambiguous credits, and **stale** late-payment records (unresolved holds await admin action)
- **(e)** refund backlog — settles refunds for paid submissions in the refund universe (permanent `post_failed` classes + the infra-failure censored outcomes: NSFW 3-strike escalation, cron vision failures), ≤ 20 rows per sweep behind the fast-path settlements in execute-post
- **(f)** expired OAuthFlow GC (10-min PKCE TTL) — best-effort, gated ≤ 1/hour

**Headers:**

```
Authorization: Bearer <CRON_SECRET>
```

**Response (200):**

```json
{
  "expired": { "count": 0 },
  "verified": { "checked": 0, "completed": 0, "skipped": 0 },
  "orphanedCredits": 0,
  "ambiguousCredits": 0,
  "cleanedExpiredOld": 0,
  "cleanedAmbiguousOld": 0,
  "cleanedLateOld": 0,
  "refunds": { "refundable": 0, "refunded": 0, "overBalance": 0, "failed": 0 },
  "cleanedFlows": 0
}
```

---

## Dev Endpoints

### GET/POST /api/test-x

Admin-only X connectivity diagnostics. Requires admin auth (`withAdmin` + the proxy layer). **Dev/staging only — both verbs return `410 Gone` (`{ error: 'Endpoint ini hanya tersedia di lingkungan development.' }`) when `NODE_ENV=production`**: a production request must never post a real test tweet or spend paid-API credits. In production, read the Direct Posting card's parsed-cookie preview and the dashboard's post-method stats instead.

**GET** — configuration status check (no posting, no cost):

```json
{
  "oauth2": { "configured": true, "note": "OAuth 2.0 is for user LOGIN only (free)." },
  "cookieAuth": { "configured": true, "source": "database", "lastUpdated": "2026-06-19T...", "missing": [] }
}
```

`cookieAuth.missing` lists missing requirements (`x_cookie_string`, `x_bearer_token`).

**POST** — post a real test tweet under the production posting lock (409 if another post is in flight):

```json
{ "text": "Tweetfess test! 🚀" }   // optional custom text
```

```json
{ "success": true, "tweetId": "1234567890", "text": "Tweetfess test! 🚀", "error": null, "tweetUrl": "https://x.com/i/status/1234567890" }
```

> **Note:** The test post does **not** trip the production circuit breaker (3 test failures won't pause autoposting) — but it does post a real tweet to your X account. Use it for diagnostics only, not in automated flows.

---

## Error Format

Error responses use a consistent JSON shape (`ApiError.toResponse()` spreads extra data at the top level):

```json
{
  "error": "Human-readable error message",
  "code": "validation",           // optional, machine-readable
  "data": { ... }                 // optional, additional context (often spread top-level instead)
}
```

Common error codes:

| Code | HTTP status | Meaning |
|---|---|---|
| `validation` | 400 | Request body failed validation |
| `unauthorized` | 401 | Missing or invalid auth token |
| `forbidden` | 403 | Authenticated but not allowed (blocked, must follow, not eligible) |
| `not_found` | 404 | Resource not found |
| `conflict` | 409 | CAS abort or duplicate resource |
| `payment_required` | 402 | Pay-to-post balance insufficient (includes `pointsNeeded` + `balance`) |
| `payment` | 400/403/409/422/503 | Payment-order domain errors |
| `rate_limit` | 429 | Rate limit hit |
| `server_error` | 500 | Unexpected server error |

The `error` message is in Indonesian for user-facing endpoints (submissions, auth, payments) and the generic `Terjadi kesalahan server. Coba lagi nanti.` for 500s. Cron endpoints return English error labels.

---

## Calling APIs with curl

### As admin

```bash
# Login (sets cookie in cookie-jar)
curl -c cookies.txt -X POST https://yourdomain.com/api/admin/login \
  -H 'content-type: application/json' \
  -d '{"password":"<ADMIN_PASSWORD>"}'

# Use the cookie for subsequent calls
curl -b cookies.txt https://yourdomain.com/api/admin/stats

# Or use the token directly (extract from cookie first)
TOKEN=$(grep admin_token cookies.txt | awk '{print $7}')
curl -H "Authorization: Bearer $TOKEN" https://yourdomain.com/api/admin/stats
```

### As cron

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://yourdomain.com/api/autopost
```

### As a submitter

```bash
# Start OAuth flow (opens browser)
curl -c cookies.txt -L https://yourdomain.com/api/auth/twitter

# After OAuth completes, the session cookie is set
curl -b cookies.txt https://yourdomain.com/api/submissions/mine
```
