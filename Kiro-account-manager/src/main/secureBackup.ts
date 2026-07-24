// Safe backup: use Electron safeStorage（OS Level encryption:Windows DPAPI / macOS Keychain / Linux libsecret）
// Encrypt disaster recovery backup files to avoid account token, agency account secret in clear text JSON falls on the disk.
//
// Strategy:
//   - Write:safeStorage Available → Write encrypted files *.backup.enc, and clean up old plaintext *.backup.json
//          Not available (very few Linux none keyring）→ Return clear text JSON, ensuring that disaster recovery is not lost
//   - Read: Decrypt first *.backup.enc;fail/Read the old plaintext if it does not exist *.backup.json(smooth migration)

import { safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

const ENC_NAME = 'kiro-accounts.backup.enc'
const LEGACY_JSON_NAME = 'kiro-accounts.backup.json'

function encPath(dir: string): string {
  return path.join(dir, ENC_NAME)
}
function legacyPath(dir: string): string {
  return path.join(dir, LEGACY_JSON_NAME)
}

/** safeStorage Is it really available (partial Linux Returned when the environment does not have a keyring false） */
export function isSecureBackupAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Write backup: Prioritize encryption; if unavailable, return to plain text JSON To ensure that disaster recovery is not lost */
export async function writeSecureBackup(dir: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data)
  if (isSecureBackupAvailable()) {
    const enc = safeStorage.encryptString(json)
    await fs.writeFile(encPath(dir), enc)
    // Clean up old plaintext backups to avoid long-term retention of plaintext
    try { await fs.unlink(legacyPath(dir)) } catch { /* Ignore if it does not exist */ }
    return
  }
  // Get the bottom line: Even if the environment does not support encryption, still write plain text, and give priority to ensuring that no data is lost.
  await fs.writeFile(legacyPath(dir), JSON.stringify(data, null, 2), 'utf-8')
}

/** Read backup: decrypt first .enc, fail and read the old plaintext again .json. return null Indicates no backup available */
export async function readSecureBackup(dir: string): Promise<unknown | null> {
  // 1) Encrypted backup
  if (isSecureBackupAvailable()) {
    try {
      const buf = await fs.readFile(encPath(dir))
      const json = safeStorage.decryptString(buf)
      return JSON.parse(json)
    } catch {
      /* .enc Does not exist or decryption failed → try plaintext */
    }
  }
  // 2) Old plain text backup (smooth migration)
  try {
    const content = await fs.readFile(legacyPath(dir), 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}
