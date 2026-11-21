// ============================================================
// db.ts — Prisma client for the controller database
// (prisma/schema.prisma — own SQLite/Postgres DB, separate
// from every instance database by design, PRD §6.1)
//
// Generated client lives in src/generated/controller-client
// (gitignored; `bun run db:generate` regenerates).
// Standard dev-singleton pattern (survives Next.js HMR).
// ============================================================

import { PrismaClient } from '@/generated/controller-client'

const globalForController = globalThis as unknown as {
  controllerPrisma: PrismaClient | undefined
}

export const controllerDb =
  globalForController.controllerPrisma ??
  new PrismaClient({
    log: process.env.DEBUG_DB ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForController.controllerPrisma = controllerDb

/** Controller-side DTO mapper — never includes credential material. */
export function toInstanceDto(row: {
  id: string
  name: string
  baseUrl: string
  handle: string | null
  colorTag: string | null
  enabled: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  credential?: { instanceId: string } | null
}): {
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
} {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    handle: row.handle,
    colorTag: row.colorTag,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasCredential: row.credential != null,
  }
}
