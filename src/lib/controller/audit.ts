// ============================================================
// audit.ts — Audit log service (Epic F, FR-F1/F2/F3)
//
// Records every mutating controller action. Stores NO submission
// content and NO secrets — only ids, actions, outcomes (FR-F2).
// Reads sweep entries older than 90 days (retention, FR-F3).
// ============================================================

import { controllerDb } from './db'
import { controllerError } from './log'

export interface AuditRecordInput {
  instanceId?: string | null
  instanceName?: string | null
  action: string // e.g. "instance.create", "submission.approve"
  targetId?: string | null
  outcome: 'success' | 'error'
  detail?: string | null
  actorIp: string
}

/** Best-effort write — an audit failure must never fail the user action.
 *  (Append-only surface; single operator owns the DB — PRD §13.) */
export async function recordAudit(entry: AuditRecordInput): Promise<void> {
  try {
    await controllerDb.auditLog.create({
      data: {
        instanceId: entry.instanceId ?? null,
        instanceName: entry.instanceName ?? null,
        action: entry.action,
        targetId: entry.targetId ?? null,
        outcome: entry.outcome,
        detail: entry.detail?.slice(0, 500) ?? null,
        actorIp: entry.actorIp,
      },
    })
  } catch (e) {
    controllerError('failed to record audit:', entry.action, e instanceof Error ? e.message : e)
  }
}

export interface AuditListFilters {
  instanceId?: string | null // null-safe: 'all' or specific id
  action?: string | null
  page: number
  limit: number
}

const RETENTION_DAYS = 90

/** List newest-first with filters + the 90-day retention sweep (FR-F3). */
export async function listAuditEntries(filters: AuditListFilters) {
  // Retention sweep — cheap DELETE on the createdAt index, runs on read.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000)
  try {
    await controllerDb.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  } catch {
    // sweep is best-effort; the read must proceed
  }

  const where = {
    ...(filters.instanceId ? { instanceId: filters.instanceId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
  }

  const [entries, total] = await Promise.all([
    controllerDb.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    }),
    controllerDb.auditLog.count({ where }),
  ])

  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      instanceId: entry.instanceId,
      instanceName: entry.instanceName,
      action: entry.action,
      targetId: entry.targetId,
      outcome: entry.outcome,
      detail: entry.detail,
      actorIp: entry.actorIp,
      createdAt: entry.createdAt.toISOString(),
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  }
}

/** Distinct action names for the audit filter dropdown. */
export async function listAuditActions(): Promise<string[]> {
  const rows = await controllerDb.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } })
  return rows.map((row) => row.action)
}
