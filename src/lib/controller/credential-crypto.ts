// ============================================================
// credential-crypto.ts — Instance admin passwords at rest (FR-B6)
//
// AES-256-GCM, "iv:authTag:ciphertext" (base64 segments) — the same
// format as the instance app's encrypt.ts, but keyed by the
// controller's OWN ENCRYPTION_KEY and with NO plaintext
// fallback: the controller refuses to save credentials unencrypted.
// Decryption happens only server-side, per request, in memory.
// ============================================================

import crypto from 'crypto'
import { getControllerEncryptionKey } from './config'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export function encryptSecret(plaintext: string): string {
  const key = getControllerEncryptionKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(stored: string): string {
  const key = getControllerEncryptionKey()
  const parts = stored.split(':')
  if (parts.length !== 3) {
    throw new Error('Kredensial instance korup — format tidak valid.')
  }
  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string]
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'), {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Kredensial instance tidak dapat didekripsi — ENCRYPTION_KEY salah atau data berubah.')
  }
}

// Server-only guard (mirrors encrypt.ts): this module must never be
// bundled into the client.
if (typeof window !== 'undefined') {
  throw new Error('credential-crypto.ts must only be imported on the server.')
}
