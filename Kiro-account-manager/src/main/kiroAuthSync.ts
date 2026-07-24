// Kiro IDE Auth Token synchronization layer
//
// Kiro IDE desktop handle token persist in ~/.aws/sso/cache/kiro-auth-token.json，
// and do this to the file fs.watchFile monitor + internal refresh loop。
//
// anti-generational IDE This file must be used as single source of truth, otherwise it will appear:
//   Anti-generational store inside refreshToken_v2, in the disk refreshToken_v1(has been invalidated by server rotation)
//   → IDE Use after one hour v1 tune OIDC → 401 → logoutAndForget()
//
// This module provides:
//   writeKiroAuthTokenFile  — by Kiro IDE Compatible format writing token document(+ IdC Client registration)
//   readKiroAuthTokenFile   — Read current disk token
//   parseAccessTokenClaims  — untie accessToken of JWT get sub/email, used to reverse account matching
//   watchKiroAuthTokenFile  — Monitor file changes (IDE Own refresh When used to reverse synchronize to the reverse generation store）

import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export const KIRO_SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache')
export const KIRO_AUTH_TOKEN_PATH = path.join(KIRO_SSO_CACHE_DIR, 'kiro-auth-token.json')

const KIRO_DEFAULT_START_URL = 'https://view.awsapps.com/start'
const KIRO_OIDC_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist'
]

// =============== profileArn decision center ===============
//
// placeholder ARN：Kiro IDE Source code FixedProfileArns Li give BuilderId Hardcoded value.
// Kiro IDE Internal logic relies on the existence of this field, and removing it will result in IDE Abnormal function.
export const KIRO_BUILDER_ID_PLACEHOLDER_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
// Social Log in(Github/Google) shared Kiro backend fixed profileArn
export const KIRO_SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

// Enterprise spare profileArn(Used when automatic acquisition fails, the area is dynamically replaced)
const ENTERPRISE_FALLBACK_PROFILE_ID = 'VNECVYCYYAWN'
const ENTERPRISE_FALLBACK_ACCOUNT_ID = '610548660232'
export function getEnterpriseFallbackArn(region?: string): string {
  const r = region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
  return `arn:aws:codewhisperer:${r}:${ENTERPRISE_FALLBACK_ACCOUNT_ID}:profile/${ENTERPRISE_FALLBACK_PROFILE_ID}`
}

const PLACEHOLDER_PROFILE_ARNS = new Set<string>([KIRO_BUILDER_ID_PLACEHOLDER_ARN])

/** Check given ARN Is it a known placeholder (old version anti-generation / Kiro IDE Dirty data that may be written by itself) */
export function isPlaceholderProfileArn(arn: string | undefined | null): boolean {
  if (!arn) return false
  return PLACEHOLDER_PROFILE_ARNS.has(arn)
}

/**
 * write token file before profileArn of"What should I write?"Make unified decisions.
 *
 * Rules (priority):
 *   1. Explicitly given by the caller profileArn and not a known placeholder → Use directly
 *   2. social/Github/Google → Use fixed Kiro Social profileArn
 *   3. BuilderId / other → use Kiro IDE official placeholder ARN（IDE Internal logic relies on the existence of this field)
 */
export function resolveProfileArnForWrite(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): string | undefined {
  if (input.profileArn && !isPlaceholderProfileArn(input.profileArn)) {
    return input.profileArn
  }
  if (input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google') {
    return KIRO_SOCIAL_PROFILE_ARN
  }
  // Enterprise The ____ does not work BuilderId placeholder (IDE Debug interface Invalid token）
  if (input.provider === 'Enterprise' || input.authMethod === 'external_idp') {
    return getEnterpriseFallbackArn(input.region)
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

export interface KiroAuthTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  authMethod?: 'IdC' | 'social' | string
  provider?: string
  region?: string
  clientIdHash?: string
  profileArn?: string
}

export interface WriteKiroAuthTokenInput {
  accessToken: string
  refreshToken: string
  /** ISO string. It is recommended to use OIDC return true expiresIn Calculate */
  expiresAtIso: string
  authMethod: 'IdC' | 'social'
  provider: string
  region?: string
  startUrl?: string
  /** IdC Required: Will write the client registration file together */
  clientId?: string
  clientSecret?: string
  profileArn?: string
}

export interface WriteKiroAuthTokenResult {
  tokenPath: string
  clientRegPath?: string
}

function computeClientIdHash(startUrl?: string): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ startUrl: startUrl || KIRO_DEFAULT_START_URL }))
    .digest('hex')
}

/**
 * with Kiro IDE Fully compatible format writing ~/.aws/sso/cache/kiro-auth-token.json
 * - mode 0o600:and IDE Be consistent (writeTokenToDisk use 0o600 Right now 384）
 * - social and IdC Field order alignment Kiro IDE Serialize results for manual convenience diff
 * - IdC Write client registration file at the same time {clientIdHash}.json
 */
export async function writeKiroAuthTokenFile(
  input: WriteKiroAuthTokenInput
): Promise<WriteKiroAuthTokenResult> {
  await fs.mkdir(KIRO_SSO_CACHE_DIR, { recursive: true })

  const clientIdHash = computeClientIdHash(input.startUrl)

  const tokenData: Record<string, unknown> =
    input.authMethod === 'social'
      ? {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          profileArn: input.profileArn,
          expiresAt: input.expiresAtIso,
          authMethod: input.authMethod,
          provider: input.provider
        }
      : {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAtIso,
          clientIdHash,
          authMethod: input.authMethod,
          provider: input.provider,
          region: input.region || 'us-east-1',
          profileArn: input.profileArn
        }

  await fs.writeFile(KIRO_AUTH_TOKEN_PATH, JSON.stringify(tokenData, null, 2), {
    mode: 0o600
  })
  // Windows superior chmod right 0o600 yes no-op But don’t throw an error;Linux/macOS Make sure the permissions are correct
  try {
    await fs.chmod(KIRO_AUTH_TOKEN_PATH, 0o600)
  } catch {
    /* ignore */
  }

  let clientRegPath: string | undefined
  if (input.authMethod !== 'social' && input.clientId && input.clientSecret) {
    clientRegPath = path.join(KIRO_SSO_CACHE_DIR, `${clientIdHash}.json`)
    // IDE Client registration validity period 90 sky(Kiro IDE Original method), the format is to remove Z of ISO string
    const clientExpiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace('Z', '')
    const clientData = {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      expiresAt: clientExpiresAt,
      scopes: KIRO_OIDC_SCOPES
    }
    await fs.writeFile(clientRegPath, JSON.stringify(clientData, null, 2), { mode: 0o600 })
    try {
      await fs.chmod(clientRegPath, 0o600)
    } catch {
      /* ignore */
    }
  }

  return { tokenPath: KIRO_AUTH_TOKEN_PATH, clientRegPath }
}

export async function readKiroAuthTokenFile(): Promise<KiroAuthTokenFile | null> {
  try {
    const content = await fs.readFile(KIRO_AUTH_TOKEN_PATH, 'utf-8')
    const parsed = JSON.parse(content) as KiroAuthTokenFile
    if (!parsed.accessToken || !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * untie accessToken of JWT Second paragraph (payload)take sub / email / aud / preferred_username。
 * - if not JWT Format return null
 * - Do not verify signature (only used for reverse matching account)
 */
export interface AccessTokenClaims {
  sub?: string
  email?: string
  aud?: string
  preferredUsername?: string
}

export function parseAccessTokenClaims(accessToken: string): AccessTokenClaims | null {
  if (!accessToken) return null
  const parts = accessToken.split('.')
  if (parts.length < 2) return null
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const json = Buffer.from(b64, 'base64').toString('utf-8')
    const claims = JSON.parse(json) as Record<string, unknown>
    const audRaw = claims.aud
    const aud = typeof audRaw === 'string' ? audRaw : Array.isArray(audRaw) && typeof audRaw[0] === 'string' ? (audRaw[0] as string) : undefined
    return {
      sub: typeof claims.sub === 'string' ? (claims.sub as string) : undefined,
      email: typeof claims.email === 'string' ? (claims.email as string) : undefined,
      aud,
      preferredUsername:
        typeof claims['preferred_username'] === 'string'
          ? (claims['preferred_username'] as string)
          : undefined
    }
  } catch {
    return null
  }
}

/**
 * monitor Kiro IDE of token File changes.
 * - use fs.watchFile（polling) to ensure cross-platform consistency
 * - Internal content stabilization (same pair accessToken+refreshToken No repeated triggering)
 * - return dispose function
 */
export type WatchCallback = (token: KiroAuthTokenFile) => void | Promise<void>

export function watchKiroAuthTokenFile(onChange: WatchCallback, intervalMs = 2000): () => void {
  let debounceTimer: NodeJS.Timeout | null = null
  let lastSeenSig = ''
  let disposed = false

  const tick = async (): Promise<void> => {
    if (disposed) return
    try {
      const token = await readKiroAuthTokenFile()
      if (!token) return
      const sig = `${token.accessToken}|${token.refreshToken}`
      if (sig === lastSeenSig) return
      lastSeenSig = sig
      await onChange(token)
    } catch (e) {
      // Silence:watcher shouldn't throw Affects the main process
      console.warn('[kiroAuthSync] watcher tick failed:', e)
    }
  }

  const listener = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void tick()
    }, 600)
  }

  // Do a baseline reading first to avoid the first time after startup"False changes"
  void readKiroAuthTokenFile().then((t) => {
    if (t) lastSeenSig = `${t.accessToken}|${t.refreshToken}`
  })

  fsSync.watchFile(KIRO_AUTH_TOKEN_PATH, { interval: intervalMs }, listener)

  return () => {
    disposed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    fsSync.unwatchFile(KIRO_AUTH_TOKEN_PATH, listener)
  }
}
