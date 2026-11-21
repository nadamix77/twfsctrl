// GET /api/healthz — Controller liveness + DB reachability (PRD §14 O3).
// Unauthenticated by design: answers only {ok, db} — no counts, no names.

import { NextResponse } from 'next/server'
import { controllerDb } from '@/lib/controller/db'

export async function GET() {
  try {
    await controllerDb.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true, db: true })
  } catch {
    return NextResponse.json({ ok: true, db: false }, { status: 200 })
  }
}
