// Prompt Cache emulator
// Tracking on the anti-generational side cache_control breakpoint, simulation Anthropic of prompt caching Behavior
// let Claude Code of cache_control fields produce actual effects usage statistics

import { createHash } from 'crypto'
import { estimateTokens } from './kiroApi'

// constant
const DEFAULT_CACHE_TTL = 5 * 60 * 1000       // 5 minute(Anthropic default ephemeral TTL）
const ONE_HOUR_CACHE_TTL = 60 * 60 * 1000     // 1 Hour
const DEFAULT_MIN_CACHEABLE_TOKENS = 1024      // Minimum cacheable token number
const OPUS_MIN_CACHEABLE_TOKENS = 4096         // Opus Model minimum cache threshold
const MAX_CACHE_RATIO = 0.85                   // The latest content is not possible 100% cache hit
const MAX_ENTRIES_PER_ACCOUNT = 200            // Maximum number of cache entries per account
const PRUNE_INTERVAL = 60 * 1000              // Cleanup interval 1 minute

// ============ type definition ============

interface CacheBreakpoint {
  fingerprint: string       // SHA-256 accumulation hash
  cumulativeTokens: number  // Accumulation up to this breakpoint token number
  ttl: number               // cache TTL(millisecond)
}

interface CacheProfile {
  breakpoints: CacheBreakpoint[]
  totalInputTokens: number
  model: string
}

export interface CacheUsage {
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
}

interface CacheEntry {
  expiresAt: number
  ttl: number
}

interface CacheableBlock {
  value: string             // Standardize JSON string
  tokens: number
  ttl: number               // 0 Indicates a non-breakpoint
  isMessageEnd: boolean
}

// ============ Prompt Cache Tracker ============

export class PromptCacheTracker {
  private entriesByAccount = new Map<string, Map<string, CacheEntry>>()
  private lastPrune = Date.now()

  // from Claude Request build cache profile
  buildClaudeProfile(
    system: unknown,
    messages: { role: string; content: unknown; cache_control?: { type: string; ttl?: string } }[],
    tools: { name: string; description: string; input_schema: unknown; cache_control?: { type: string; ttl?: string } }[] | undefined,
    totalInputTokens: number,
    model: string
  ): CacheProfile | null {
    const blocks = this.flattenCacheBlocks(system, messages, tools)
    if (blocks.length === 0) return null

    const hasher = createHash('sha256')
    const breakpoints: CacheBreakpoint[] = []
    let cumulativeTokens = 0
    let activeTTL = 0

    for (const block of blocks) {
      this.hashChunk(hasher, block.value)
      cumulativeTokens += block.tokens

      // Determine breakpoint TTL
      let breakpointTTL = 0
      if (block.ttl > 0) {
        breakpointTTL = block.ttl
        activeTTL = block.ttl
      } else if (block.isMessageEnd && activeTTL > 0) {
        // Implicit breakpoint: After an explicit breakpoint, the end of each message is a breakpoint
        breakpointTTL = activeTTL
      }

      if (breakpointTTL <= 0) continue

      breakpoints.push({
        fingerprint: hasher.copy().digest('hex'),
        cumulativeTokens,
        ttl: breakpointTTL
      })
    }

    if (breakpoints.length === 0) return null

    return {
      breakpoints,
      totalInputTokens: Math.max(totalInputTokens, cumulativeTokens),
      model
    }
  }

  // Calculate cache hits
  compute(accountId: string, profile: CacheProfile | null): CacheUsage {
    if (!profile || profile.breakpoints.length === 0 || !accountId) {
      return { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }
    }

    const minTokens = this.minCacheableTokens(profile.model)
    const last = profile.breakpoints[profile.breakpoints.length - 1]
    let lastTokens = Math.min(last.cumulativeTokens, profile.totalInputTokens)
    const now = Date.now()

    this.pruneIfNeeded(now)

    const entries = this.entriesByAccount.get(accountId)
    if (!entries || entries.size === 0) {
      // First request: all yes creation
      const effectiveCreation = lastTokens >= minTokens ? lastTokens : 0
      const [cache5m, cache1h] = this.computeTTLBreakdown(profile, 0)
      return {
        cacheCreationInputTokens: effectiveCreation,
        cacheReadInputTokens: 0,
        cacheCreation5mTokens: cache5m,
        cacheCreation1hTokens: cache1h
      }
    }

    // upper limit 85%
    const maxCacheable = Math.floor(profile.totalInputTokens * MAX_CACHE_RATIO)
    if (lastTokens > maxCacheable) lastTokens = maxCacheable

    // Match the longest prefix from back to front
    let matchedTokens = 0
    for (let i = profile.breakpoints.length - 1; i >= 0; i--) {
      const bp = profile.breakpoints[i]
      if (bp.cumulativeTokens < minTokens) continue

      const entry = entries.get(bp.fingerprint)
      if (!entry || entry.expiresAt < now) continue

      // Hit: Refresh expiration time
      entry.expiresAt = now + entry.ttl
      matchedTokens = Math.min(bp.cumulativeTokens, profile.totalInputTokens)
      if (matchedTokens > lastTokens) matchedTokens = lastTokens
      break
    }

    const creation = Math.max(lastTokens - matchedTokens, 0)
    const [cache5m, cache1h] = this.computeTTLBreakdown(profile, matchedTokens)

    return {
      cacheCreationInputTokens: creation,
      cacheReadInputTokens: matchedTokens,
      cacheCreation5mTokens: cache5m,
      cacheCreation1hTokens: cache1h
    }
  }

  // Update cache entry (called after successful request)
  update(accountId: string, profile: CacheProfile | null): void {
    if (!profile || profile.breakpoints.length === 0 || !accountId) return

    const minTokens = this.minCacheableTokens(profile.model)
    const now = Date.now()

    let entries = this.entriesByAccount.get(accountId)
    if (!entries) {
      entries = new Map()
      this.entriesByAccount.set(accountId, entries)
    }

    for (const bp of profile.breakpoints) {
      if (bp.cumulativeTokens < minTokens) continue
      entries.set(bp.fingerprint, {
        expiresAt: now + bp.ttl,
        ttl: bp.ttl
      })
    }

    // Limit the number of entries per account
    if (entries.size > MAX_ENTRIES_PER_ACCOUNT) {
      const sorted = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      const toDelete = sorted.slice(0, entries.size - MAX_ENTRIES_PER_ACCOUNT)
      for (const [key] of toDelete) entries.delete(key)
    }
  }

  // clear all cache
  clear(): number {
    const count = this.totalEntries()
    this.entriesByAccount.clear()
    return count
  }

  totalEntries(): number {
    let count = 0
    for (const entries of this.entriesByAccount.values()) count += entries.size
    return count
  }

  // ============ internal method ============

  private flattenCacheBlocks(
    system: unknown,
    messages: { role: string; content: unknown; cache_control?: { type: string; ttl?: string } }[],
    tools: { name: string; description: string; input_schema: unknown; cache_control?: { type: string; ttl?: string } }[] | undefined
  ): CacheableBlock[] {
    const blocks: CacheableBlock[] = []

    // Tool definition
    if (tools) {
      for (const tool of tools) {
        const value = this.canonicalize({ kind: 'tool', name: tool.name, description: tool.description, input_schema: tool.input_schema })
        blocks.push({
          value,
          tokens: estimateTokens(value),
          ttl: this.extractTTL(tool),
          isMessageEnd: false
        })
      }
    }

    // System prompt
    this.appendSystemBlocks(blocks, system)

    // Messages
    for (let i = 0; i < messages.length; i++) {
      this.appendMessageBlocks(blocks, messages[i], i)
    }

    return blocks
  }

  private appendSystemBlocks(blocks: CacheableBlock[], system: unknown): void {
    if (!system) return
    if (typeof system === 'string') {
      const value = this.canonicalize({ kind: 'system', type: 'text', text: system })
      blocks.push({ value, tokens: estimateTokens(system), ttl: 0, isMessageEnd: false })
    } else if (Array.isArray(system)) {
      for (const block of system) {
        const obj = typeof block === 'string' ? { type: 'text', text: block } : block
        const value = this.canonicalize({ kind: 'system', block: obj })
        const text = (obj as Record<string, unknown>).text as string || ''
        blocks.push({
          value,
          tokens: estimateTokens(text || JSON.stringify(obj)),
          ttl: this.extractTTL(obj),
          isMessageEnd: false
        })
      }
    }
  }

  private appendMessageBlocks(
    blocks: CacheableBlock[],
    msg: { role: string; content: unknown; cache_control?: { type: string; ttl?: string } },
    messageIndex: number
  ): void {
    const content = msg.content
    if (typeof content === 'string') {
      const value = this.canonicalize({ kind: 'message', role: msg.role, index: messageIndex, type: 'text', text: content })
      blocks.push({
        value,
        tokens: estimateTokens(content),
        ttl: this.extractTTL(msg),
        isMessageEnd: true
      })
    } else if (Array.isArray(content)) {
      const lastIdx = content.length - 1
      for (let i = 0; i < content.length; i++) {
        const block = content[i] as Record<string, unknown>
        const text = (block.text as string) || (block.thinking as string) || ''
        const value = this.canonicalize({ kind: 'message', role: msg.role, index: messageIndex, blockIndex: i, block })
        blocks.push({
          value,
          tokens: estimateTokens(text || JSON.stringify(block)),
          ttl: this.extractTTL(block),
          isMessageEnd: i === lastIdx
        })
      }
    }
  }

  private extractTTL(obj: unknown): number {
    if (!obj || typeof obj !== 'object') return 0
    const record = obj as Record<string, unknown>
    const cacheControl = record.cache_control as Record<string, unknown> | undefined
    if (!cacheControl) return 0
    if (String(cacheControl.type).toLowerCase() !== 'ephemeral') return 0

    const ttlValue = cacheControl.ttl
    if (ttlValue === '1h' || ttlValue === '1H') return ONE_HOUR_CACHE_TTL
    if (typeof ttlValue === 'number' && ttlValue > 0) return ttlValue * 1000
    return DEFAULT_CACHE_TTL
  }

  private canonicalize(obj: unknown): string {
    return PromptCacheTracker.stableStringify(obj)
  }

  /**
   * Deep stable serialization: Object keys at all levels are sorted lexicographically.
   * The ____ does not work `JSON.stringify(obj, Object.keys(obj).sort())` —— array replacer yes
   * Act on**All levels**whitelist of keys, nested objects (messages block、tool input_schema etc.) keys
   * If it is not in the top-level key list, it will be discarded as a whole, causing the fingerprint to only reflect the structure but not the content.
   * Requests for different content will be misjudged as cache hits.
   */
  private static stableStringify(value: unknown): string {
    const json = (v: unknown): string | undefined => {
      if (v === null) return 'null'
      const t = typeof v
      if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(v)
      if (t !== 'object') return undefined // undefined/function/symbol and JSON.stringify Behave consistently
      if (Array.isArray(v)) return `[${v.map((item) => json(item) ?? 'null').join(',')}]`
      const obj = v as Record<string, unknown>
      const parts: string[] = []
      for (const k of Object.keys(obj).sort()) {
        const sv = json(obj[k])
        if (sv !== undefined) parts.push(`${JSON.stringify(k)}:${sv}`)
      }
      return `{${parts.join(',')}}`
    }
    return json(value) ?? 'null'
  }

  private hashChunk(hasher: ReturnType<typeof createHash>, chunk: string): void {
    hasher.update(`${chunk.length}\0${chunk}\0`)
  }

  private minCacheableTokens(model: string): number {
    return model.toLowerCase().includes('opus') ? OPUS_MIN_CACHEABLE_TOKENS : DEFAULT_MIN_CACHEABLE_TOKENS
  }

  private computeTTLBreakdown(profile: CacheProfile, matchedTokens: number): [number, number] {
    let cache5m = 0
    let cache1h = 0
    let previous = matchedTokens
    for (const bp of profile.breakpoints) {
      const current = Math.min(bp.cumulativeTokens, profile.totalInputTokens)
      if (current <= previous) continue
      const delta = current - previous
      if (bp.ttl >= ONE_HOUR_CACHE_TTL) {
        cache1h += delta
      } else {
        cache5m += delta
      }
      previous = current
    }
    return [cache5m, cache1h]
  }

  private pruneIfNeeded(now: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL) return
    this.lastPrune = now
    for (const [accountId, entries] of this.entriesByAccount) {
      for (const [fp, entry] of entries) {
        if (entry.expiresAt < now) entries.delete(fp)
      }
      if (entries.size === 0) this.entriesByAccount.delete(accountId)
    }
  }
}

// Global singleton
export const promptCacheTracker = new PromptCacheTracker()

// Build with cache usage of Claude usage object
export function buildCachedClaudeUsage(
  inputTokens: number,
  outputTokens: number,
  cacheUsage: CacheUsage
): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
} {
  const billed = Math.max(inputTokens - cacheUsage.cacheCreationInputTokens - cacheUsage.cacheReadInputTokens, 0)
  const result: Record<string, unknown> = {
    input_tokens: billed,
    output_tokens: outputTokens
  }
  if (cacheUsage.cacheCreationInputTokens > 0) {
    result.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens
  }
  if (cacheUsage.cacheReadInputTokens > 0) {
    result.cache_read_input_tokens = cacheUsage.cacheReadInputTokens
  }
  if (cacheUsage.cacheCreation5mTokens > 0 || cacheUsage.cacheCreation1hTokens > 0) {
    result.cache_creation = {
      ...(cacheUsage.cacheCreation5mTokens > 0 ? { ephemeral_5m_input_tokens: cacheUsage.cacheCreation5mTokens } : {}),
      ...(cacheUsage.cacheCreation1hTokens > 0 ? { ephemeral_1h_input_tokens: cacheUsage.cacheCreation1hTokens } : {})
    }
  }
  return result as ReturnType<typeof buildCachedClaudeUsage>
}
