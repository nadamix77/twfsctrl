# ADR-002: HMAC-Derived Admin Tokens

## Status
Accepted

## Context
The admin dashboard needs authentication. Common approaches include:
- **JWT** — Self-contained tokens with claims, signed with a secret
- **NextAuth.js** — Full-featured auth library with session management
- **Session-based** — Server-side sessions stored in a database
- **HMAC-derived tokens** — Simple tokens derived from a password + expiry

This is a single-admin application. There is exactly one admin user. No role-based access, no user registration, no session database needed.

## Decision
Use HMAC-derived tokens. On login, derive a token via `HMAC-SHA256(ADMIN_PASSWORD, "tweetfess:admin:v1:<expiresAt>")` and return `<hmac_hex>.<expiresAt_hex>` as the admin token. Subsequent requests verify by re-deriving the expected HMAC and comparing with `timingSafeEqual()`.

The token is stored in an `HttpOnly` cookie (`admin_token`) with a 7-day TTL. A `Bearer` header fallback supports API/curl usage.

## Consequences

**Easier:**
- Zero dependencies — uses Node.js `crypto` module only
- No session database — stateless verification
- No library lock-in — easy to understand and audit
- Password never exposed to the client — only the HMAC-derived token
- Automatic expiry via embedded timestamp — no cleanup needed

**Harder:**
- No multi-admin support — changing the password invalidates all sessions
- No session revocation without password change — there's no session DB to delete from
- Token rotation requires the admin to re-login (acceptable for a single-admin app)
