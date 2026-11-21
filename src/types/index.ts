// ============================================================
// types/index.ts — Shared TypeScript types (Controller edition)
//
// The controller never touches an instance database — these are
// the wire shapes it consumes from instance admin APIs
// (docs/INSTANCE-API.md) and renders in the moderation queue.
// Status values mirror the instance Prisma enums exactly; they are
// declared here as literal unions so the controller compiles
// without any instance codegen.
// ============================================================

// --- Status (instance SubmissionStatus enum) ---
export type SubmissionStatus =
  | 'pending'
  | 'censored'
  | 'posting'
  | 'post_failed'
  | 'rejected'
  | 'posted'

// --- Post method (instance PostMethod enum — the result of a
//     submission's posting attempt, reported back by the instance) ---
export type PostMethodResult = 'direct' | 'retry' | 'fallback_cookie' | 'fallback_login'
