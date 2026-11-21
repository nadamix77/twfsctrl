# PRD — Tweetfess Controller

**Product:** Tweetfess Controller — multi-instance control panel
**Version:** 1.0 (draft for review)
**Date:** 2026-11-20
**Status:** Implemented (v1.0) — controller extracted to its own repo/deployment (ADR-016)
**Owner:** (you)
**Related documents:**

- `docs/INSTANCE-API.md` — the instance-side API this product consumes (source of truth)
- `docs/adr/002-hmac-admin-tokens.md` — instance admin token design (reused here)
- `docs/adr/007-two-layer-admin-auth.md` — instance-side auth enforcement
- `docs/SECURITY.md` — controller security model (instance security lives in the instance repo)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [Users & Personas](#4-users--personas)
5. [Definitions, Assumptions & Constraints](#5-definitions-assumptions--constraints)
6. [Solution Overview & Architecture](#6-solution-overview--architecture)
7. [Functional Requirements](#7-functional-requirements)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Data Model](#9-data-model)
10. [Instance API Integration Contract](#10-instance-api-integration-contract)
11. [UI/UX Specification](#11-uiux-specification)
12. [Error Handling & Edge Cases](#12-error-handling--edge-cases)
13. [Security & Threat Model](#13-security--threat-model)
14. [Observability](#14-observability)
15. [Acceptance Criteria & Test Plan](#15-acceptance-criteria--test-plan)
16. [Release Plan & Milestones](#16-release-plan--milestones)
17. [Future Considerations / Backlog](#17-future-considerations--backlog)
18. [Open Questions](#18-open-questions)
19. [Appendix A — Instance Endpoint Quick Reference](#appendix-a--instance-endpoint-quick-reference)
20. [Appendix B — Key Flows](#appendix-b--key-flows)

---

## 1. Executive Summary

Tweetfess Controller is a standalone Next.js web application that lets a single operator monitor and moderate **multiple independent Tweetfess deployments** ("instances", each on its own domain, own database, own X account) from one dashboard.

It requires **zero changes to any Tweetfess instance**. Every capability it needs already exists as an authenticated admin API endpoint (`/api/admin/*`, `/api/submissions` admin operations), documented in `docs/INSTANCE-API.md`, and accepts Bearer-token authentication designed for programmatic use (ADR-002).

The MVP delivers: an instance registry with encrypted credentials, a fan-out health/stats overview grid, a **unified moderation queue** (approve / reject / retry / requeue across all instances), per-instance quick actions (circuit-breaker reset, cache clear), deep links into each instance's own admin dashboard, and an audit log.

The controller deliberately remains a **thin, read-mostly orchestrator**: instances stay the source of truth for their own data, settings editing stays in each instance's admin UI (v1), and no end-user data is persisted by the controller beyond an audit trail of operator actions.

---

## 2. Background & Problem Statement

### 2.1 Current state

Tweetfess is deployed as a single-tenant application: one deployment = one menfess account = one domain (e.g. `twfs.vercel.app`). Running a second menfess community means deploying a second copy (own Supabase, own B2 bucket, own X OAuth app, own cron jobs) with its own admin dashboard at `/admin`.

### 2.2 The problem

Operating N instances today means:

1. **N browser tabs**, N logins (each instance has its own `ADMIN_PASSWORD`), N dashboards to poll.
2. **Fragmented moderation** — pending submissions sit in per-instance queues; there is no single place to see "everything waiting for review right now".
3. **Slow incident response** — a tripped circuit breaker, an expired X cookie, or a dead cron on instance B is invisible until the operator happens to open that tab.
4. **No cross-instance view** — no aggregated revenue, no combined activity, no shared blocklist visibility.

### 2.3 Why now

The instance-side API was built API-first (stateless HMAC Bearer tokens, JSON everywhere, CSRF guards that deliberately pass non-browser traffic — see ADR-002 and `src/lib/core/origin-guard.ts`). The integration surface is already stable, documented, and tested. The controller is a pure consumer.

---

## 3. Goals & Non-Goals

### 3.1 Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Single dashboard for the health of all instances | Overview grid rendering all instances with fresh (≤ 60 s) stats |
| G2 | Single queue for all moderation decisions | Pending/censored/post_failed submissions from all instances in one list; approve/reject works end-to-end |
| G3 | Zero instance-side changes | No commits required to any Tweetfess deployment; works against today's API |
| G4 | Instance isolation preserved | An instance going down never degrades other instances in the UI; no shared databases |
| G5 | Fast to operate | Dashboard refresh ≤ 3 s with 10 instances (parallel fan-out); every moderation action ≤ 2 clicks from the queue |
| G6 | Secure by default | Instance admin passwords encrypted at rest (AES-256-GCM); controller never exposes them again after save |

### 3.2 Non-Goals (v1)

- **NG1** — Editing instance settings from the controller (word lists, rate limits, monetization, AI config). Instances stay authoritative; controller links out to their Settings tabs. (v2 candidate)
- **NG2** — Managing instance infrastructure (deploys, env vars, cron configuration, B2).
- **NG3** — Multi-tenant / multi-operator with roles. v1 is single-operator, same trust model as Tweetfess itself (ADR-002: "exactly one admin user").
- **NG4** — Persisting submissions or end-user PII in the controller database. Submission content is displayed live from instances and never written to controller storage.
- **NG5** — A mobile app. Responsive web only.
- **NG6** — Real-time push (WebSockets). Polling only in v1.
- **NG7** — Central X cookie management. The controller never stores or transmits menfess account cookies; that stays per-instance in their encrypted settings.

---

## 4. Users & Personas

**P1 — The Operator (primary, and only, user).**
Runs 2–10 Tweetfess instances for different communities. Technically comfortable (deploys on Vercel, reads logs), Indonesian-speaking (instance UIs are Indonesian), moderates on desktop mostly, occasionally on phone. Cares about: "what needs my decision right now", "is anything broken", "how is each community doing today".

Success for P1: open one URL, see everything, clear the queue in minutes, never log into N dashboards again for routine work.

**Anti-persona (explicitly not served in v1):** community moderators per instance (no RBAC), automated bots (no public API for the controller itself), anyone other than the owner.

---

## 5. Definitions, Assumptions & Constraints

### 5.1 Definitions

| Term | Meaning |
|---|---|
| **Instance** | One deployed Tweetfess app: own domain, own Supabase DB, own `/api/admin/*`. Identified in the controller by `id`, displayed by `name`. |
| **Controller** | This product. A separate Next.js app on its own domain with its own database containing only the instance registry and audit log. |
| **Admin token** | Instance-side HMAC token from `POST /api/admin/login`; valid 7 days; accepted as cookie or `Authorization: Bearer` header (ADR-002). |
| **Hot stats** | Fast-changing instance data from `GET /api/admin/stats` (status counts, circuit breaker). |
| **Warm stats** | Slower-changing data from `GET /api/admin/stats/warm` (cookie status, credits, filter settings summary, revenue today, submitter count). |
| **Unified queue** | The merged, cross-instance list of submissions in reviewable states (`pending`, `censored`, `post_failed`). |

### 5.2 Assumptions

- A1: All instances run the same Tweetfess codebase (same API version) ± minor drift; the controller tolerates unknown response fields and missing endpoints (forward-compatible parsing).
- A2: The operator knows each instance's `ADMIN_PASSWORD` and can paste it into the registry.
- A3: Instance count is small (2–15). Fan-out is linear; no sharding needed.
- A4: Instance admin API responses follow `docs/INSTANCE-API.md`; server-to-server requests without an `Origin` header pass the instance CSRF guard (verified in `src/lib/core/origin-guard.ts` — the same mechanism the cron endpoints rely on).
- A5: The controller and instances are all served over public HTTPS (Vercel).

### 5.3 Constraints

- C1: **Instance login rate limit** — 5 failed attempts / 15 min / IP, then a 30-minute lockout (429 with `Retry-After`). The controller must therefore **cache admin tokens** and never re-login per request. (Successful logins are not limited.)
- C2: **Token TTL** — 7 days; the controller must re-login transparently on expiry (with the C1 lockout rules respected).
- C3: **Signed image URLs** from instance submission lists expire (~1 h). The UI must re-fetch rather than cache image URLs long-term.
- C4: Instances expose admin data with **Indonesian UI strings** in `message`/`error` fields; the controller treats them as pass-through detail text, not as its own copy.
- C5: Vercel serverless egress IPs are dynamic — the C1 per-IP budget cannot be assumed stable; correctness of stored passwords is the only reliable guard.
- C6: Only **one Next.js app per deployment slot** — the controller is a separate repository/deployment with its own domain (e.g. `panel.example.com`), not a route inside an instance.

---

## 6. Solution Overview & Architecture

### 6.1 Topology

```
                    ┌─────────────────────────────────────┐
                    │  Tweetfess Controller (this PRD)    │
                    │  Next.js 16 (App Router) + Prisma   │
                    │  own domain, e.g. panel.example.com │
                    │  DB: instances + audit log only     │
                    └───────────────┬─────────────────────┘
                                    │ HTTPS, server-side only
                                    │ (no Origin header → CSRF pass;
                                    │  Bearer admin token auth)
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
  ┌──────────────────┐   ┌──────────────────┐    ┌──────────────────┐
  │ Instance A       │   │ Instance B       │    │ Instance C       │
  │ twfs.vercel.app  │   │ menfess-b.com    │    │ menfess-c.com    │
  │ /api/admin/*     │   │ /api/admin/*     │    │ /api/admin/*     │
  │ own DB/B2/X/cron │   │ own DB/B2/X/cron │    │ own DB/B2/X/cron │
  └──────────────────┘   └──────────────────┘    └──────────────────┘
```

### 6.2 Core design rules

1. **Instances are the source of truth.** The controller stores no submissions, no settings, no user data. Everything on screen is a live API read.
2. **The controller server is the only thing that talks to instances.** The browser never calls instance domains directly (avoids CORS entirely, keeps admin tokens off the client, allows the token cache to live server-side).
3. **Partial failure is the normal case.** Every fan-out result carries per-instance status; one dead instance degrades exactly one card.
4. **Write-only credentials.** Instance admin passwords are accepted once (add/edit form), encrypted with AES-256-GCM, and never rendered or returned again.
5. **Reuse proven instance patterns.** Controller auth copies ADR-002 (HMAC token, HttpOnly cookie, Bearer fallback, rate-limited login) and the encryption pattern from `src/lib/core/encrypt.ts` — one admin, zero session tables.

### 6.3 Technology

Same stack as Tweetfess for consistency and code reuse: Next.js 16 App Router, TypeScript, Tailwind CSS 4, shadcn/ui (New York), Prisma + PostgreSQL (Supabase), no external cache (in-memory token cache).

---

## 7. Functional Requirements

Priorities: **P0** = MVP must-have; **P1** = MVP nice-to-have (cuttable); **P2** = post-MVP.

### Epic A — Controller Authentication & Hardening

| ID | Requirement | Priority |
|---|---|---|
| FR-A1 | Login with a single `ADMIN_PASSWORD` (env var, no default — app refuses to start without it, mirroring Tweetfess). Issues an HMAC-SHA256 token (`HMAC(ADMIN_PASSWORD, "tweetfess-controller:admin:v1:<expiresAt>")`) valid 7 days, stored in an HttpOnly, SameSite=Strict cookie. | P0 |
| FR-A2 | `Authorization: Bearer` header accepted for all controller APIs (parity with instances, enables curl). | P0 |
| FR-A3 | Login rate limit: 5 failed attempts / 15 min / IP → 30-min lockout with 429 + `Retry-After` (mirror the instance scheme). | P0 |
| FR-A4 | Session check endpoint (`GET /api/session`) returning `{authenticated, instanceCount, controllerVersion}`. | P0 |
| FR-A5 | Logout clears the cookie; works with an expired token. | P0 |

### Epic B — Instance Registry

| ID | Requirement | Priority |
|---|---|---|
| FR-B1 | Add instance: fields `name` (unique, display), `baseUrl` (must be `https://`, normalized: no trailing slash, no path), `adminPassword` (write-only), optional `handle` (menfess X handle, display only), optional color tag. | P0 |
| FR-B2 | **Connectivity test** on the add/edit form: performs login + `GET /api/admin/session` against the instance and reports success/failure with the instance's own error text before the operator saves. | P0 |
| FR-B3 | Edit instance: name, handle, color, enabled flag; password field present but blank = keep existing; filled = replace (re-encrypt, drop cached token). | P0 |
| FR-B4 | Delete instance: confirm dialog requiring typed name confirmation; cascades a final audit entry. Never deletes anything on the instance itself. | P0 |
| FR-B5 | Enable/disable toggle: disabled instances are excluded from all fan-out and the unified queue, but kept in the registry (displayed greyed with "nonaktif"). | P0 |
| FR-B6 | Credentials stored AES-256-GCM encrypted (`iv:authTag:ciphertext`, key from `ENCRYPTION_KEY` env, `openssl rand -hex 32`); never returned by any API after save; never written to logs. | P0 |
| FR-B7 | Uniqueness: `name` unique; `baseUrl` unique after normalization. | P0 |
| FR-B8 | SSRF guard on `baseUrl`: reject private/loopback/link-local IP literals and hostnames resolving to them (reuse the `is-private-ip` concept from the instance codebase); reject non-443 ports unless explicitly overridden. | P0 |
| FR-B9 | Manual drag-free reordering (`sortOrder` field, up/down buttons) controlling card and queue grouping order. | P2 |

### Epic C — Overview Dashboard (fan-out)

| ID | Requirement | Priority |
|---|---|---|
| FR-C1 | One **instance card** per enabled instance showing: name + handle, health badge, pending count (prominent), censored / posting / post_failed / rejected / posted / total, circuit-breaker state (with remaining pause minutes when tripped), X cookie configured status, AI provider health summary (healthy/degraded/off), revenue today (IDR), submitter count, freshness timestamp ("update 12 dtk lalu"). | P0 |
| FR-C2 | Per-instance health derived as: **ok** (all fan-out calls 2xx), **auth-failed** (401 after a fresh login attempt — badge prompts re-entering the password), **locked-out** (login 429 — shows retry-after countdown), **down** (timeout/DNS/5xx), **disabled** (greyed). | P0 |
| FR-C3 | Fan-out uses `GET /api/admin/session` (single call, returns hot + warm merged) per instance, in parallel, with an 8 s per-instance timeout. Partial failures render the rest. | P0 |
| FR-C4 | Aggregate header: total pending across instances, instances up/down, combined revenue today (IDR, formatted), total submitters. | P0 |
| FR-C5 | Auto-refresh every 60 s while the tab is visible (paused when hidden, one immediate refresh on re-visible — same pattern as the instance dashboard), plus a manual refresh button with per-instance spinners. | P0 |
| FR-C6 | Every card deep-links to the instance's own `/admin` (new tab) for anything the controller doesn't do. | P0 |
| FR-C7 | Sortable/filterable grid: by pending count, by health, by name. Default: `sortOrder` then pending desc. | P1 |

### Epic D — Unified Moderation Queue

| ID | Requirement | Priority |
|---|---|---|
| FR-D1 | Merged list of submissions in reviewable states (`pending`, `censored`, `post_failed`) from all enabled instances, newest first. Each row shows: instance badge (name + color), submitter (username, display name, avatar via instance-signed URL), message text (full text in expandable), image thumbnail when present (instance-signed URL), raw `filterReasons` (admin-visible, with matched keyword), `nsfwStatus`, status chip, age ("3 mnt lalu"). | P0 |
| FR-D2 | Data source: `GET /api/submissions?status=…&page=&limit=` per instance (limit 50 for MVP), merged client-side by `createdAt` desc. "Load more" appends the next page per instance. | P0 |
| FR-D3 | Filters: status tabs (all / pending / censored / post_failed), instance multi-select, free-text search (delegated per-instance via the API's `search` param). | P0 |
| FR-D4 | **Approve** (`PATCH /api/submissions/[id]` with `{"status":"approved"}`) with all three success shapes handled distinctly: `auto-posted` (posted now — show tweet link), `queued` (deferred with `deferReason` — show the instance's message), `error` (approved but post failed — show error + keep row visible as post_failed). | P0 |
| FR-D5 | **Reject** (`PATCH` with `{"status":"rejected"}`); display the `refund` outcome (`refunded` / `no-spend` / `over-balance` / absent) when the instance includes it. | P0 |
| FR-D6 | **Retry post** (`POST /api/submissions/[id]/post`) for `post_failed` and `pending` rows. | P1 |
| FR-D7 | **Delete** (`DELETE /api/submissions/[id]`) behind a confirm dialog; 409 reasons (still `posting`, already `posted`) surfaced verbatim from the instance. | P1 |
| FR-D8 | **Refund points** (`POST /api/submissions/[id]/refund`) on rejected rows — the instance's "Kembalikan Poin" button. | P1 |
| FR-D9 | **Bulk requeue post_failed** per instance (`POST /api/admin/submissions/requeue`), shown as a quick action on the instance card; result count toasted. | P1 |
| FR-D10 | Optimistic row removal on action success; on 409 CAS conflict, the row re-renders with the instance's current state and a "status berubah" notice (never silent). | P0 |
| FR-D11 | Actions are disabled while an instance is `down`/`auth-failed`/`locked-out`; the queue shows those instances' sections in a frozen state with a timestamp of the last successful fetch. | P0 |

### Epic E — Instance Quick Actions

| ID | Requirement | Priority |
|---|---|---|
| FR-E1 | Per-instance quick actions in a card dropdown: **Reset circuit breaker** (`POST /api/admin/circuit-breaker/reset`), **Clear cache** (`POST /api/admin/clear-cache`), **Requeue post_failed** (FR-D9). Each requires a confirm click and is audit-logged. | P1 |
| FR-E2 | Quick actions show the instance's own success/error message verbatim in the toast. | P1 |

### Epic F — Audit Log

| ID | Requirement | Priority |
|---|---|---|
| FR-F1 | Every mutating controller action (instance create/edit/delete/enable, approve, reject, retry, delete, refund, requeue, breaker reset, cache clear) is recorded: `action`, `instanceName`, `targetId` (submission id when applicable), `outcome` (success/error + instance error string), `actorIp`, `createdAt`. | P0 |
| FR-F2 | Audit log stores **no submission content** — only ids, actions, outcomes (privacy: content lives on instances only). | P0 |
| FR-F3 | Read-only audit viewer with filters (instance, action type, date range), newest first, 90-day retention with a cleanup sweep on read. | P1 |

---

## 8. Non-Functional Requirements

### 8.1 Performance

- NFR-P1: Overview fan-out completes ≤ 3 s for 10 healthy instances (parallel, 8 s per-instance timeout ceiling only for stragglers).
- NFR-P2: Unified queue first render ≤ 3 s for 10 instances × 50 rows.
- NFR-P3: All controller API responses ≤ 100 ms of own processing (time is dominated by instance round-trips).

### 8.2 Security

- NFR-S1: Instance credentials encrypted at rest (AES-256-GCM); key via env only; decryption happens only server-side, in-memory, per request.
- NFR-S2: Admin tokens for instances live in a server-side in-memory cache only — never in the controller DB, never in cookies, never in the browser.
- NFR-S3: Strict CSP equivalent to the instance app (`default-src 'self'`, `frame-ancestors 'none'`, etc.), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- NFR-S4: All controller APIs reject unauthenticated calls with 401 (except login/logout/session-check semantics identical to the instance app).
- NFR-S5: No secret value (instance passwords, tokens) ever appears in any log line, error message, or API response.
- NFR-S6: SSRF guard (FR-B8) blocks registration of internal targets.
- NFR-S7: Dependabot/Renovate + `npm audit` clean at release; dependencies kept identical in major version to the instance app where shared.

### 8.3 Reliability

- NFR-R1: Any single instance failure (down/auth/lockout/timeout) degrades only that instance's UI sections; the dashboard never fails wholesale.
- NFR-R2: Fan-out requests are independently abortable; a slow instance cannot stall the others (Promise.allSettled semantics + per-instance timeout).
- NFR-R3: The controller functions read-only if its own DB is briefly unavailable (cached-in-memory instance list) — login is the only operation requiring the DB in that window.

### 8.4 Accessibility

- NFR-A1: WCAG 2.1 AA color contrast; keyboard navigable queue and cards; visible focus rings; 44 px touch targets; `sr-only` labels on icon-only buttons; semantic `main/header/nav`.
- NFR-A2: Fully responsive: single-column stacked cards + queue on mobile (operator moderates from phone occasionally), grid on desktop.

### 8.5 Internationalization

- NFR-I1: UI copy in **Indonesian** (matching the Tweetfess admin UX, e.g. "Setujui", "Tolak", "nonaktif") with technical terms in English; instance-provided strings pass through untranslated. (Confirm — Open Question Q1.)

### 8.6 Compatibility

- NFR-X1: Forward-compatible response parsing: unknown JSON fields ignored; missing optional fields render as "—". A missing endpoint (older instance) disables only the affected feature with a "versi instance lama" hint, never a crash.

---

## 9. Data Model

Controller database (PostgreSQL via Supabase, Prisma):

```prisma
model Instance {
  id            String   @id @default(cuid())
  name          String   @unique                    // display name, e.g. "twfs"
  baseUrl       String   @unique                    // normalized: https://host[:port], no trailing slash
  handle        String?                             // menfess X handle, display only
  colorTag      String?                             // hex color for badges
  enabled       Boolean  @default(true)
  sortOrder     Int      @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  credential    InstanceCredential?
  auditLogs     AuditLog[]
}

model InstanceCredential {
  instanceId       String   @id
  instance         Instance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  encryptedSecret  String   // AES-256-GCM "iv:authTag:ciphertext" of ADMIN_PASSWORD
  updatedAt        DateTime @updatedAt
}

model AuditLog {
  id           String    @id @default(cuid())
  instanceId   String?                                   // null for controller-level actions
  instance     Instance? @relation(fields: [instanceId], references: [id], onDelete: SetNull)
  action       String    // e.g. "instance.create", "submission.approve"
  targetId     String?   // instance submission id when applicable
  outcome      String    // "success" | "error"
  detail       String?   // instance error string / outcome nuance (no submission content)
  actorIp      String
  createdAt    DateTime  @default(now())

  @@index([createdAt])
  @@index([instanceId, createdAt])
}
```

**In-memory (not persisted):** per-instance admin token cache `{ instanceId → { token, expiresAt } }` with expiry-driven and 401-driven invalidation (in-process singleton, `src/lib/controller/instance-client.ts`).

**Environment variables:**

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Controller login (required, no default) |
| `SESSION_SECRET` | HMAC key for controller tokens (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | AES-256-GCM key for instance passwords at rest (`openssl rand -hex 32`) |
| `DATABASE_URL` | Controller DB — PostgreSQL (Supabase in production; local embedded Postgres in dev). Own database, never an instance's |
| `ALLOW_PRIVATE_TARGETS` | SSRF-guard override for local development (FR-B8); must be unset in production |

> Implemented env set (see `docs/CONFIGURATION.md`). The controller never reads instance env vars — instance credentials arrive via the registry form and are stored encrypted.

---

## 10. Instance API Integration Contract

All calls are server-side `fetch` from the controller to `{instance.baseUrl}` + path. No `Origin`/`Referer` headers are sent (Node fetch), which is exactly why the instance CSRF guard passes them (`origin-guard.ts` scope: browser same-origin POSTs only).

### 10.1 Authentication flow & token lifecycle

1. **On credential save (FR-B2) or first use:** `POST /api/admin/login` with `{"password": <decrypted>}` → instance sets `admin_token` cookie. The controller extracts the token from `Set-Cookie` and stores it in the in-memory cache with a 7-day TTL.
2. **On every instance call:** send `Authorization: Bearer <token>`.
3. **On 401:** invalidate the cached token → re-login **once** → retry the original call. If the re-login also fails (401 → wrong stored password → mark instance `auth-failed`; 429 → mark `locked-out` with `Retry-After`).
4. **On login 429:** never retry within `Retry-After`; surface the countdown in the UI (C1 constraint).
5. **No concurrent login storms:** a single-flight lock per instance (only one in-flight login; parallel callers await it).

### 10.2 Endpoints consumed

| Purpose | Method & Path | Notes |
|---|---|---|
| Login | `POST /api/admin/login` | Body `{"password"}`; token in `Set-Cookie: admin_token`; 401 "Password salah"; 429 rate-limited |
| Overview (one call) | `GET /api/admin/session` | Returns `{authenticated, stats}` — hot + warm merged; fallback shape `{authenticated:true}` when stats fail → degrade card to auth-only |
| Hot stats | `GET /api/admin/stats` | Poll fallback if session shape is stats-less |
| Warm stats | `GET /api/admin/stats/warm` | Optional `?refresh=true` |
| Queue list | `GET /api/submissions?status=&page=&limit=&search=` | Admin view: raw `filterReasons`, `imageUrl` (signed), submitter + limits. Status values: `pending/censored/posting/post_failed/rejected/posted`; invalid → 400 |
| Approve / Reject | `PATCH /api/submissions/[id]` | `{"status":"approved"\|"rejected"}`; responses `auto-posted` / `queued` (deferReason) / `error`; reject may carry `refund`; 400/404/409/429/503 |
| Retry post | `POST /api/submissions/[id]/post` | Same ladder as approve; `postMethod: "retry"` |
| Refund | `POST /api/submissions/[id]/refund` | Rejected rows only; outcomes `refunded/already-refunded/no-spend/over-balance` |
| Delete | `DELETE /api/submissions/[id]` | 409 while `posting` or already `posted` |
| Bulk requeue | `POST /api/admin/submissions/requeue` | `{requeued: n}` |
| Breaker reset | `POST /api/admin/circuit-breaker/reset` | Also marks autopost pending |
| Cache clear | `POST /api/admin/clear-cache` | `{success, message}` |
| AI health | `GET /api/admin/ai-status` | `{healthy, providers[], results[]}` — used for the AI badge |
| Payments overview (v2) | `GET /api/admin/payments` | Orders + revenue + GoBiz health |
| Analytics (v2) | `GET /api/admin/analytics?range=` | Presets `today/7d/30d/month` |

Explicitly **not** called in v1: `/api/admin/settings` (GET is harmless but P2 — masked values only), `/api/admin/filter-settings` POST, `/api/admin/submitters/*` mutations, payments confirm/void. They are listed in the API surface for v2 planning (Section 17).

### 10.3 Error mapping (instance → controller UI)

| Instance response | Controller interpretation |
|---|---|
| 2xx | Parse; render |
| 401 (after re-login attempt also 401) | Instance badge `auth-failed`; card action "Perbarui password" opens the edit form focused on the password field |
| 401 (login) + 429 | `locked-out`; countdown from `Retry-After` |
| 404 on an endpoint | Feature unavailable on that instance ("versi lama"); hide the related UI affordance |
| 409 on PATCH/DELETE | CAS conflict → refresh that row from the instance; toast the instance's message verbatim |
| 429 (non-login) | Transient; per-instance backoff, show "coba lagi" |
| 503 (breaker active on approve) | Surface "circuit breaker aktif" + link to instance card quick action |
| Timeout (8 s) / DNS / 5xx | Instance badge `down`; last-known data shown greyed with timestamp |
| Any body shape drift | NFR-X1: ignore unknown fields; never crash on parse |

---

## 11. UI/UX Specification

### 11.1 Screens

1. **Login** — single password field, controller branding, error "Password salah", lockout countdown when rate-limited. No "forgot password" (env-var credential; a note says to set `ADMIN_PASSWORD` on the host).
2. **Dashboard (the only main screen)** —
   - Sticky header: logo, aggregate summary chips (Total pending / Instances up / Revenue today), refresh button, account menu (audit log, logout).
   - **Overview grid**: instance cards (FR-C1), responsive `1/2/3` columns; empty state with an "Tambah instance" CTA when none registered.
   - **Unified queue** below the grid: status tabs, instance filter chips, search box; submission rows grouped by nothing (flat, newest first) with an instance badge on each row; pagination "Muat lagi".
3. **Instance add/edit dialog** — form fields (FR-B1/B3) + "Test koneksi" button with inline result (green "Terhubung — 5 pending" or the instance's error verbatim).
4. **Audit log dialog** — filterable table (FR-F3).
5. **Confirm dialogs** — destructive actions (delete instance, delete submission) and quick actions.

### 11.2 States per instance card

`ok` (green dot) · `auth-failed` (amber, action) · `locked-out` (amber, countdown) · `down` (red, last-seen timestamp) · `nonaktif` (grey). Data renders identically in all states when present — badges communicate freshness, not presence.

### 11.3 Interaction rules

- Approve/reject/retry/refund/delete act on one row at a time (no multi-select bulk moderation in v1 — the CAS semantics make bulk risky).
- Every action gives immediate feedback: row-level spinner → outcome toast (instance message verbatim when present) → row state update.
- Images open full-size in a new tab via the instance's signed URL; if expired, the thumbnail re-fetches the row first.
- Keyboard: `A` = approve focused row, `R` = reject, `↑/↓` navigate; visible focus ring.

---

## 12. Error Handling & Edge Cases

| # | Case | Handling |
|---|---|---|
| E1 | Instance unreachable mid-session | Card → `down`; queue section frozen with timestamp; auto-retry on next 60 s cycle |
| E2 | Stored password wrong (rotated on instance) | One silent re-login attempt → `auth-failed` badge → operator re-enters password |
| E3 | Instance login locked out (bad password retries) | `locked-out` + countdown; controller refuses further login attempts until expiry (C1) |
| E4 | Token expires between polls | 401 → single-flight re-login → retry original call (invisible to operator) |
| E5 | Two operators? (v1: impossible — single admin) | n/a; audit log still records actor IP |
| E6 | Approve races instance-side auto-post | 409 CAS → controller refreshes row, shows "Status submission telah berubah. Refresh halaman." |
| E7 | Approve deferred by breaker | 503 → toast + card badge reflects tripped breaker; suggest quick action |
| E8 | Instance upgraded with API drift | Unknown fields ignored (NFR-X1); missing endpoint → feature hidden with "versi lama" hint |
| E9 | Same instance registered twice | Blocked by normalized-`baseUrl` uniqueness (FR-B7) |
| E10 | Operator registers a non-Tweetfess HTTPS URL | Connectivity test fails ("login endpoint tidak ditemukan"); save allowed only after a passing test or an explicit override checkbox |
| E11 | Signed image URL expired in an open tab | Click re-fetches the row, then opens the fresh URL |
| E12 | Fan-out partially times out | allSettled; stragglers render `down` after 8 s without blocking others (NFR-R2) |
| E13 | Controller DB briefly down | In-memory instance list serves reads; mutations disabled with a banner |

---

## 13. Security & Threat Model

| Threat | Vector | Mitigation |
|---|---|---|
| Controller DB breach | Supabase credential leak | Instance passwords AES-256-GCM at rest (FR-B6); key not in the DB; audit log contains no secrets and no submission content |
| Controller admin token theft | XSS / cookie | HttpOnly + SameSite=Strict cookie, strict CSP (NFR-S3), Bearer parity only for curl; 7-day expiry |
| Credential brute force | Login endpoint | 5/15 min lockout (FR-A3), same hardening as instances |
| SSRF via registry | `baseUrl` pointing inside the network | FR-B8 private-IP + port guard |
| Instance token leakage | Token leaves server | Tokens only in server memory (NFR-S2); never logged (NFR-S5) |
| Blast radius of controller compromise | All instances' admin access | Documented accepted risk; mitigations: strong unique `ADMIN_PASSWORD`, optional Vercel password protection / IP allowlist on the controller deployment, 2FA deferred to v2 (Q3) |
| Audit tampering | Direct DB edit | Accepted (single operator owns the DB); append-only API surface |

**Residual risk statement:** the controller is, by design, the single most sensitive asset in the fleet — it holds working admin credentials for every instance. This is accepted in exchange for the operational win; the mitigations above bound but do not eliminate it.

---

## 14. Observability

- O1: Structured request logs with per-instance timings (`instance=twfs ms=812 status=200`) — no payloads.
- O2: Debug namespaces (mirroring instance `DEBUG=` convention): `fanout`, `instance-auth`, `queue`.
- O3: Health endpoint `GET /api/healthz` → `{ok, db: true/false}` for uptime monitoring.
- O4: The overview grid itself is the operator's monitoring surface (per-instance health badges); no external alerting in v1 (v2: Telegram/Discord webhook on `down` / `auth-failed` / breaker trips).

---

## 15. Acceptance Criteria & Test Plan

### 15.1 MVP acceptance criteria (must all pass)

1. Operator can register 2+ live instances (connectivity test passing) and see both cards with real stats within 3 s.
2. Approving a pending submission from the unified queue posts it on the instance's X account (verified on X), and the row leaves the queue; all three approve outcomes (`auto-posted`, `queued`, `error`) render correctly.
3. Rejecting a submission reflects on the instance dashboard; refund outcome displays when present.
4. Killing one instance (simulate: wrong password / unreachable URL) degrades exactly that card and its queue section; all other instances remain fully operable.
5. Token lifecycle: no login call is made for a cached token; exactly one re-login occurs on a 401; a wrong password flips the card to `auth-failed` within one refresh cycle **without** tripping the instance lockout (single attempt).
6. Registry credentials are unrecoverable from the API (write-only); DB rows contain only ciphertext.
7. Every mutating action appears in the audit log with outcome and timestamp.
8. Keyboard-only operator can login, filter the queue, and approve a submission.
9. Dashboard works at 360 px width (single column) and 1440 px (3-column grid).
10. Fresh clone → `bun install && bun run db:push && bun run dev` with the 5 env vars boots to a working login screen.

### 15.2 Test plan (no unit tests beyond the seams the instance app established; focus on integration)

- Unit: credential encrypt/decrypt round-trip; URL normalization + SSRF guard matrix; token cache single-flight; response-shape parsers (golden JSON fixtures from `docs/INSTANCE-API.md`).
- Integration (vitest, mocked fetch): fan-out partial failure; 401→re-login→retry; 429 lockout; CAS 409 refresh.
- E2E manual: the 10 acceptance criteria against two real deployments (e.g. the live `twfs` instance + a staging copy).

---

## 16. Release Plan & Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Scaffold** (the "basic first" slice) | Repo, env, auth (Epic A), registry CRUD + connectivity test + encryption (Epic B), healthz | AC 1 (single instance), 5, 6, 10 |
| **M1 — MVP** | Overview fan-out (Epic C), unified queue with approve/reject (FR-D1–D5, D10, D11), quick actions (Epic E), audit log (Epic F) | All 10 acceptance criteria |
| **M1.1** | Retry / delete / refund / bulk requeue (FR-D6–D9), audit viewer (FR-F3), card sorting (FR-C7) | Regression green |
| **M2 — Visibility** | Per-instance payments overview, cross-instance aggregated analytics (7d/30d), webhook notifications | Feature-flagged rollout |
| **M3 — Control** | Read-only settings viewer, settings editing (NG1 revisited), submitters block/unblock across instances, optional 2FA | New PRD cycle |

---

## 17. Future Considerations / Backlog

- Aggregated "fleet" analytics (revenue, funnels, moderation latency across instances).
- Notifications (Telegram bot is the leading candidate for the Indonesian operator context).
- Fleet-wide blocklist sync (push a blocked username to all instances at once).
- Per-instance cookie expiry alerts (from `cookieAuthStatus`) with deep link to the instance's credential form.
- Instance provisioning wizard (clone Tweetfess to a new Vercel project + Supabase + B2 via APIs) — large, separate PRD.
- Multi-operator RBAC with scoped instance access.

---

## 18. Open Questions

| # | Question | Default if unresolved |
|---|---|---|
| Q1 | Controller UI language: Indonesian (match instances) or English? | Indonesian |
| Q2 | Expected fleet size in 6 months (affects fan-out design headroom)? | 10 |
| Q3 | Is single-operator + strong password sufficient, or is 2FA needed at M1? | Deferred to M3 |
| Q4 | Should the controller deployment get Vercel password protection as an extra layer? | Recommended yes (documented in DEPLOYMENT) |
| Q5 | Where does the controller live — same Vercel account (convenient) or separate (isolation)? | Same account, separate team/project |

---

## Appendix A — Instance Endpoint Quick Reference

All paths relative to `instance.baseUrl`; auth = `Authorization: Bearer <admin_token>` unless noted.

| Endpoint | Method | Used for (controller feature) |
|---|---|---|
| `/api/admin/login` | POST | Credential verification, token acquisition |
| `/api/admin/session` | GET | Overview card (hot + warm stats in one call) |
| `/api/admin/stats` | GET | Overview card (fallback) |
| `/api/admin/stats/warm` | GET | Overview card (fallback / refresh) |
| `/api/admin/ai-status` | GET | AI health badge |
| `/api/submissions?status=&page=&limit=&search=` | GET | Unified queue |
| `/api/submissions/[id]` | PATCH | Approve / reject |
| `/api/submissions/[id]` | DELETE | Delete submission |
| `/api/submissions/[id]/post` | POST | Retry posting |
| `/api/submissions/[id]/refund` | POST | Refund points |
| `/api/admin/submissions/requeue` | POST | Bulk requeue post_failed |
| `/api/admin/circuit-breaker/reset` | POST | Quick action |
| `/api/admin/clear-cache` | POST | Quick action |
| `/api/admin/payments` | GET | (v2) Payments overview |
| `/api/admin/analytics` | GET | (v2) Aggregated analytics |

## Appendix B — Key Flows

**B1 — Overview refresh (every 60 s):**

```
Browser ── GET /api/overview (controller) ──► controller
   for each enabled instance (parallel, 8 s timeout, Promise.allSettled):
      token = cache[instance] ?? singleFlightLogin(instance)
      GET {baseUrl}/api/admin/session  (Bearer token)
        ├─ 200 → merge {instanceId, status:'ok', stats}
        ├─ 401 → re-login once → retry; fail → 'auth-failed'
        ├─ 429 (login) → 'locked-out' + retryAfter
        └─ timeout/5xx → 'down'
   merge + persist nothing; respond {instances: [...], fetchedAt}
```

**B2 — Approve from the unified queue:**

```
Operator clicks Setujui on row (instance B, submission X)
Browser ── POST /api/queue/{instanceId}/submissions/{id}/approve ──► controller
   token = cache[B] ?? login(B)
   PATCH {B.baseUrl}/api/submissions/{id}  {"status":"approved"}
      ├─ 200 kind:auto-posted → audit success → row leaves queue → toast + tweet link
      ├─ 200 kind:queued      → audit success(deferReason) → row updates → toast (instance message)
      ├─ 200 kind:error       → audit error → row → post_failed → toast (instance error)
      ├─ 409                  → re-fetch row from B → row re-renders + notice
      └─ 503                  → toast "circuit breaker aktif" + card badge hint
```

**B3 — Credential save with connectivity test:**

```
Operator fills form → clicks "Test koneksi"
Browser ── POST /api/instances/test ──► controller
   POST {baseUrl}/api/admin/login {password}
      ├─ 200 → GET /api/admin/session → report "Terhubung — N pending"
      ├─ 401 → "Password salah" (verbatim)
      └─ 429 → "Terkunci — coba lagi dalam MmSd"
Save → AES-256-GCM encrypt → upsert Instance + InstanceCredential → drop token cache entry → audit
```

---

*End of PRD. Approve to proceed with M0 scaffolding, or annotate sections for revision.*
