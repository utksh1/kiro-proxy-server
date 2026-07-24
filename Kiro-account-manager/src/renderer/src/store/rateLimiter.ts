/**
 * Register batch task speed limit + Risk control signal detection
 *
 * design:
 * - Sliding window statistics: maintained recently N Success within seconds/Failure timestamp
 * - Dynamic backoff: When consecutive failures exceed the threshold, the interval is automatically extended (exponential backoff)
 * - Risk control trigger: The success rate suddenly drops below the threshold, triggering a warning + Automatically slow down
 *
 * How to use:
 *   const limiter = createRateLimiter({...})
 *   limiter.reportResult(true / false)         // Report at the end of each task
 *   await limiter.waitForSlot()                // Wait for a token before starting a new task
 *   limiter.snapshot()                          // UI Read real-time status
 */

export interface RateLimiterConfig {
  /** Maximum number of startup tasks per minute (token bucket rate) */
  maxPerMinute: number
  /** Burst upper limit (token bucket capacity) */
  burst: number
  /** Success rate monitoring window (seconds) */
  windowSec: number
  /** The success rate threshold for triggering risk control warnings (0-1） */
  successRateThreshold: number
  /** The minimum number of samples required to trigger a risk control warning (to avoid misjudgment with a small number of samples) */
  minSamples: number
  /** The number of consecutive failures triggers backoff */
  consecutiveFailureThreshold: number
  /** Backoff base duration (milliseconds) */
  backoffBaseMs: number
  /** Maximum backoff duration (milliseconds) */
  backoffMaxMs: number
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxPerMinute: 10,
  burst: 3,
  windowSec: 120,
  successRateThreshold: 0.5,
  minSamples: 5,
  consecutiveFailureThreshold: 3,
  backoffBaseMs: 8_000,
  backoffMaxMs: 120_000
}

export interface RateLimiterSnapshot {
  /** Number of tokens available in the current bucket */
  availableTokens: number
  /** Number of successes within window */
  windowSuccess: number
  /** Number of failures within window */
  windowFailed: number
  /** Current success rate (0-1） */
  successRate: number
  /** Number of consecutive failures */
  consecutiveFailures: number
  /** Current remaining backoff duration (milliseconds,0 Indicates no backoff) */
  backoffRemainingMs: number
  /** Is it currently in a risk control warning state? */
  riskWarning: boolean
  /** Actual throughput rate (number of/minute) */
  throughputPerMinute: number
}

interface RateLimiterInternal {
  config: RateLimiterConfig
  /** Token bucket last filled time */
  lastRefillTime: number
  /** Currently available tokens */
  tokens: number
  /** timestamp event queue [timestamp, success] */
  events: Array<[number, boolean]>
  /** Number of consecutive failures */
  consecutiveFailures: number
  /** Backoff end timestamp (0 Indicates no longer retreating) */
  backoffEndAt: number
}

export interface RateLimiter {
  /** Called before starting a task: waiting to obtain the token (including backoff) */
  waitForSlot: (signal?: { aborted: boolean }) => Promise<void>
  /** Report results after task completion */
  reportResult: (success: boolean) => void
  /** Read real-time status (for UI show) */
  snapshot: () => RateLimiterSnapshot
  /** Update configuration */
  updateConfig: (next: Partial<RateLimiterConfig>) => void
  /** reset statistics */
  reset: () => void
}

export function createRateLimiter(config: Partial<RateLimiterConfig> = {}): RateLimiter {
  const state: RateLimiterInternal = {
    config: { ...DEFAULT_RATE_LIMITER_CONFIG, ...config },
    lastRefillTime: Date.now(),
    tokens: (config.burst ?? DEFAULT_RATE_LIMITER_CONFIG.burst),
    events: [],
    consecutiveFailures: 0,
    backoffEndAt: 0
  }

  /** Replenish tokens according to token bucket rules */
  function refillTokens(): void {
    const now = Date.now()
    const elapsedMs = now - state.lastRefillTime
    if (elapsedMs <= 0) return
    const tokensPerMs = state.config.maxPerMinute / 60_000
    state.tokens = Math.min(state.config.burst, state.tokens + elapsedMs * tokensPerMs)
    state.lastRefillTime = now
  }

  /** Clean up events outside the window */
  function pruneEvents(): void {
    const cutoff = Date.now() - state.config.windowSec * 1000
    while (state.events.length > 0 && state.events[0][0] < cutoff) {
      state.events.shift()
    }
  }

  return {
    waitForSlot: async (signal) => {
      while (true) {
        if (signal?.aborted) return
        // Backoff priority
        const now = Date.now()
        if (state.backoffEndAt > now) {
          const wait = Math.min(state.backoffEndAt - now, 1000)
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
        refillTokens()
        if (state.tokens >= 1) {
          state.tokens -= 1
          return
        }
        // Not enough tokens: estimated wait time by rate
        const tokensPerMs = state.config.maxPerMinute / 60_000
        const tokensNeeded = 1 - state.tokens
        const waitMs = Math.max(50, Math.min(2000, tokensNeeded / tokensPerMs))
        await new Promise((r) => setTimeout(r, waitMs))
      }
    },

    reportResult: (success) => {
      const now = Date.now()
      state.events.push([now, success])
      pruneEvents()

      if (success) {
        state.consecutiveFailures = 0
      } else {
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= state.config.consecutiveFailureThreshold) {
          // Exponential Backoff: No. N failed → backoffBase × 2^(N - threshold)
          const overflow = state.consecutiveFailures - state.config.consecutiveFailureThreshold + 1
          const backoffMs = Math.min(
            state.config.backoffBaseMs * Math.pow(2, overflow - 1),
            state.config.backoffMaxMs
          )
          state.backoffEndAt = now + backoffMs
        }
      }
    },

    snapshot: () => {
      refillTokens()
      pruneEvents()
      const now = Date.now()
      let success = 0, failed = 0
      for (const [, ok] of state.events) {
        if (ok) success++; else failed++
      }
      const total = success + failed
      const successRate = total > 0 ? success / total : 1
      const samples = total
      const riskWarning = samples >= state.config.minSamples && successRate < state.config.successRateThreshold
      const throughput = state.config.windowSec > 0
        ? (success * 60 / state.config.windowSec)
        : 0

      return {
        availableTokens: Math.floor(state.tokens),
        windowSuccess: success,
        windowFailed: failed,
        successRate,
        consecutiveFailures: state.consecutiveFailures,
        backoffRemainingMs: Math.max(0, state.backoffEndAt - now),
        riskWarning,
        throughputPerMinute: Math.round(throughput * 10) / 10
      }
    },

    updateConfig: (next) => {
      state.config = { ...state.config, ...next }
    },

    reset: () => {
      state.events = []
      state.consecutiveFailures = 0
      state.backoffEndAt = 0
      state.tokens = state.config.burst
      state.lastRefillTime = Date.now()
    }
  }
}
