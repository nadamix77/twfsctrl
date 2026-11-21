# ADR-007: Two-Layer Admin Auth (proxy + withAdmin)

## Status
Accepted

## Context
Admin routes need authentication. A single verification point could be either:
1. **proxy.ts only** — Verify once at the proxy layer, trust all route handlers
2. **withAdmin only** — Verify in each route handler, no proxy-level protection
3. **Both** — Verify at proxy layer AND in each route handler

Without proxy-level auth, bots hitting `/api/admin/*` spin up a Vercel serverless function + Prisma connection just to get rejected by `withAdmin()`. This wastes resources and increases cold starts.

Without route-level auth, a bug in proxy.ts (e.g., a matcher typo) could expose admin routes without authentication.

## Decision
Use both layers:

1. **proxy.ts** — Intercepts all `/admin/:path*` and `/api/admin/:path*` requests (except `/admin` root and `/api/admin/login`). Verifies the `admin_token` cookie via `verifyAdmin()`. Returns 401 (API) or redirect (frontend) on failure. This rejects unauthenticated requests before any route handler code runs.

2. **withAdmin()** — Wraps each admin route handler. Re-verifies the token via `verifyAdmin()`. Also manages `x-request-id` propagation (reads from proxy-injected header, sets on response).

Both layers call the same `verifyAdmin()` function, so there's no divergence in auth logic.

## Consequences

**Easier:**
- Defense-in-depth — a bug in one layer doesn't expose admin routes
- Resource savings — proxy.ts rejects bots before function body executes
- Request correlation — `x-request-id` flows from proxy → route handler → response

**Harder:**
- Two places to maintain auth logic (though both call `verifyAdmin()`)
- proxy.ts must carefully exclude `/admin` (login page) and `/api/admin/login` (login endpoint) from auth checks
- Future changes to auth must be tested at both layers
