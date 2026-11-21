// ============================================================
// registry.ts — Instance registry service (Epic B)
//
// All DB access for the Instance/InstanceCredential tables lives
// here. Routes stay thin; secrets never leave this module's server
// boundary (write-only credentials — FR-B6/B7).
// ============================================================

import { controllerDb, toInstanceDto } from './db'
import { encryptSecret, decryptSecret } from './credential-crypto'
import { dropCachedToken } from './instance-client'
import type { InstanceDto } from './types'

/** A registry row with its credential DECRYPTED for fan-out use.
 *  `password` is null when no credential is stored or decryption
 *  failed (wrong key) — callers surface that as auth-failed. */
export interface ResolvedInstance {
  id: string
  name: string
  baseUrl: string
  handle: string | null
  colorTag: string | null
  enabled: boolean
  sortOrder: number
  password: string | null
  /** Set when the stored credential could not be decrypted. */
  credentialError: string | null
}

export class RegistryError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message)
  }
}

/** List instances (API-safe DTOs, sorted by sortOrder then name). */
export async function listInstances(): Promise<InstanceDto[]> {
  const rows = await controllerDb.instance.findMany({
    include: { credential: { select: { instanceId: true } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map(toInstanceDto)
}

/** Load instances with credentials resolved (server-only).
 *  `enabledOnly` excludes disabled rows from fan-out (FR-B5). */
export async function loadResolvedInstances(enabledOnly: boolean): Promise<ResolvedInstance[]> {
  const rows = await controllerDb.instance.findMany({
    include: { credential: true },
    ...(enabledOnly ? { where: { enabled: true } } : {}),
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  return rows.map((row) => {
    let password: string | null = null
    let credentialError: string | null = null
    if (row.credential) {
      try {
        password = decryptSecret(row.credential.encryptedSecret)
      } catch (e) {
        credentialError = e instanceof Error ? e.message : 'Kredensial tidak dapat didekripsi'
      }
    }
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      handle: row.handle,
      colorTag: row.colorTag,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
      password,
      credentialError,
    }
  })
}

export async function getResolvedInstance(id: string): Promise<ResolvedInstance | null> {
  const all = await loadResolvedInstances(false)
  return all.find((instance) => instance.id === id) ?? null
}

async function assertUnique(name: string, baseUrl: string, excludeId?: string): Promise<void> {
  const [nameClash, urlClash] = await Promise.all([
    controllerDb.instance.findFirst({ where: { name, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true } }),
    controllerDb.instance.findFirst({ where: { baseUrl, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true } }),
  ])
  if (nameClash) throw new RegistryError(`Nama instance "${name}" sudah dipakai`, 409)
  if (urlClash) throw new RegistryError('URL instance ini sudah terdaftar', 409)
}

export interface CreateInstanceParams {
  name: string
  baseUrl: string // pre-normalized by validateInstanceBaseUrl
  adminPassword: string
  handle: string | null
  colorTag: string | null
}

export async function createInstance(params: CreateInstanceParams): Promise<InstanceDto> {
  await assertUnique(params.name, params.baseUrl)

  const maxSort = await controllerDb.instance.aggregate({ _max: { sortOrder: true } })
  const row = await controllerDb.instance.create({
    data: {
      name: params.name,
      baseUrl: params.baseUrl,
      handle: params.handle,
      colorTag: params.colorTag,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      credential: { create: { encryptedSecret: encryptSecret(params.adminPassword) } },
    },
    include: { credential: { select: { instanceId: true } } },
  })
  return toInstanceDto(row)
}

export interface UpdateInstanceParams {
  name?: string
  handle?: string | null
  colorTag?: string | null
  enabled?: boolean
  sortOrder?: number
  /** Blank/undefined = keep; non-empty = replace (re-encrypt + drop token). */
  adminPassword?: string
}

export async function updateInstance(id: string, params: UpdateInstanceParams): Promise<InstanceDto> {
  const existing = await controllerDb.instance.findUnique({ where: { id } })
  if (!existing) throw new RegistryError('Instance tidak ditemukan', 404)

  if (params.name != null && params.name !== existing.name) {
    await assertUnique(params.name, existing.baseUrl, id)
  }

  const newPassword = params.adminPassword?.trim()
  if (newPassword) {
    dropCachedToken(id)
    await controllerDb.instanceCredential.upsert({
      where: { instanceId: id },
      create: { instanceId: id, encryptedSecret: encryptSecret(newPassword) },
      update: { encryptedSecret: encryptSecret(newPassword), updatedAt: new Date() },
    })
  }

  const row = await controllerDb.instance.update({
    where: { id },
    data: {
      ...(params.name != null ? { name: params.name } : {}),
      ...(params.handle !== undefined ? { handle: params.handle } : {}),
      ...(params.colorTag !== undefined ? { colorTag: params.colorTag } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.sortOrder !== undefined ? { sortOrder: params.sortOrder } : {}),
    },
    include: { credential: { select: { instanceId: true } } },
  })

  if (params.enabled === false) dropCachedToken(id)
  return toInstanceDto(row)
}

export async function deleteInstance(id: string): Promise<InstanceDto> {
  const row = await controllerDb.instance.findUnique({
    where: { id },
    include: { credential: { select: { instanceId: true } } },
  })
  if (!row) throw new RegistryError('Instance tidak ditemukan', 404)

  await controllerDb.instance.delete({ where: { id } })
  dropCachedToken(id)
  return toInstanceDto(row)
}

export async function countInstances(): Promise<number> {
  return controllerDb.instance.count()
}
