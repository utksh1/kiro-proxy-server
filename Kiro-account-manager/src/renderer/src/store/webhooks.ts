import { create } from 'zustand'

/**
 * Webhook Notification center
 *
 * Used to record key events (batch completion, risk control trigger, single account registration success)/failure, etc.) pushed to the outside IM。
 * Built-in common IM Message template: DingTalk / Qiwei / Telegram / Discord / Customize JSON。
 */

export type WebhookKind = 'dingtalk' | 'wechat-work' | 'telegram' | 'discord' | 'feishu' | 'custom'

export interface WebhookEntry {
  id: string
  kind: WebhookKind
  url: string
  label?: string
  enabled: boolean
  /** Telegram bot pattern requires chat_id */
  telegramChatId?: string
  /** custom mode JSON template,{{title}} {{message}} {{level}} placeholder */
  customTemplate?: string
  /** Which events to subscribe to */
  events: WebhookEvent[]
  createdAt: number
}

export type WebhookEvent =
  | 'batch-completed'      // Batch task completed
  | 'batch-error'          // Batch task critical error
  | 'risk-warning'         // Risk control warning triggered
  | 'account-banned'       // Account banned
  | 'register-success'     // Single account registration successful
  | 'register-failed'      // Single account registration failed
  | 'token-expired'        // Token Expired/Refresh failed

export const ALL_WEBHOOK_EVENTS: { value: WebhookEvent; label: string; labelEn: string }[] = [
  { value: 'batch-completed', label: 'Batch task completed', labelEn: 'Batch completed' },
  { value: 'batch-error', label: 'Batch task critical error', labelEn: 'Batch error' },
  { value: 'risk-warning', label: 'Risk control warning triggered', labelEn: 'Risk warning' },
  { value: 'account-banned', label: 'Account banned', labelEn: 'Account banned' },
  { value: 'register-success', label: 'Registration successful (single account)', labelEn: 'Register success' },
  { value: 'register-failed', label: 'Registration failed (single account)', labelEn: 'Register failed' },
  { value: 'token-expired', label: 'Token Expired/Refresh failed', labelEn: 'Token expired' }
]

export interface WebhookMessage {
  title: string
  message: string
  level: 'info' | 'warn' | 'error' | 'success'
  /** Optional extra fields (appended to message back) */
  fields?: Record<string, string | number>
}

interface WebhooksState {
  webhooks: Map<string, WebhookEntry>
}

interface WebhooksActions {
  addWebhook: (input: Omit<WebhookEntry, 'id' | 'createdAt'>) => string
  updateWebhook: (id: string, updates: Partial<WebhookEntry>) => void
  removeWebhook: (id: string) => void
  toggleWebhook: (id: string) => void
  /** Trigger an event: automatically enable all subscribers to the event webhook Send push */
  triggerEvent: (event: WebhookEvent, payload: WebhookMessage) => Promise<void>
  /** test single webhook(Send a test message) */
  testWebhook: (id: string) => Promise<{ success: boolean; error?: string }>
  /** Persistent loading (in store Called during initialization) */
  loadFromStorage: () => void
  saveToStorage: () => void
}

type WebhooksStore = WebhooksState & WebhooksActions

const STORAGE_KEY = 'kiro-webhooks'

export const useWebhookStore = create<WebhooksStore>()((set, get) => ({
  webhooks: new Map(),

  addWebhook: (input) => {
    const id = crypto.randomUUID()
    const entry: WebhookEntry = {
      ...input,
      id,
      createdAt: Date.now()
    }
    set((state) => {
      const next = new Map(state.webhooks)
      next.set(id, entry)
      return { webhooks: next }
    })
    get().saveToStorage()
    return id
  },

  updateWebhook: (id, updates) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, ...updates })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  removeWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      next.delete(id)
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  toggleWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, enabled: !existing.enabled })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  triggerEvent: async (event, payload) => {
    const webhooks = Array.from(get().webhooks.values())
      .filter((w) => w.enabled && w.events.includes(event))
    if (webhooks.length === 0) return
    await Promise.allSettled(webhooks.map((w) => sendWebhook(w, payload)))
  },

  testWebhook: async (id) => {
    const webhook = get().webhooks.get(id)
    if (!webhook) return { success: false, error: 'Webhook does not exist' }
    try {
      await sendWebhook(webhook, {
        title: '🧪 Test notification',
        message: 'This is from Kiro Test message for the account manager. If you see this message, it means Webhook The configuration is correct.',
        level: 'info',
        fields: { time: new Date().toLocaleString('zh-CN') }
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as WebhookEntry[]
      if (!Array.isArray(arr)) return
      const map = new Map<string, WebhookEntry>()
      for (const w of arr) map.set(w.id, w)
      set({ webhooks: map })
    } catch (err) {
      console.warn('[Webhook] Load failed:', err)
    }
  },

  saveToStorage: () => {
    try {
      const arr = Array.from(get().webhooks.values())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
    } catch (err) {
      console.warn('[Webhook] Save failed:', err)
    }
  }
}))

// ==================== Webhook Send implementation ====================

/** C9: each webhook Last sent timestamp queue (used for local rate limiting) */
const sendTimestamps = new Map<string, number[]>()
const MAX_PER_MINUTE = 20  // each webhook max per minute 20 strip
const RETRY_COUNT = 3
const RETRY_DELAY_BASE_MS = 1500  // Exponential backoff base

/**
 * Check and log rate: return when threshold is exceeded false, the caller should skip sending this
 */
function checkAndRecordRate(webhookId: string): boolean {
  const now = Date.now()
  const arr = sendTimestamps.get(webhookId) || []
  // clean up 1 minutes away
  const filtered = arr.filter((t) => now - t < 60_000)
  if (filtered.length >= MAX_PER_MINUTE) {
    sendTimestamps.set(webhookId, filtered)
    return false
  }
  filtered.push(now)
  sendTimestamps.set(webhookId, filtered)
  return true
}

/**
 * according to webhook Type construct message body and POST(Including retry + rate limit)
 * Network errors are not thrown to the caller (only console.warn) to avoid affecting the main business process
 */
async function sendWebhook(webhook: WebhookEntry, payload: WebhookMessage): Promise<void> {
  // C9: rate limit
  if (!checkAndRecordRate(webhook.id)) {
    console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} rate limit exceeded (>${MAX_PER_MINUTE}/min), drop`)
    return
  }

  const body = buildWebhookBody(webhook, payload)
  const url = webhook.kind === 'telegram'
    ? buildTelegramUrl(webhook)
    : webhook.url

  // C9: Retry logic (exponential backoff)
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delay))
      console.log(`[Webhook] Retry ${attempt}/${RETRY_COUNT} for ${webhook.kind} ${webhook.label || webhook.id}`)
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      clearTimeout(timer)
      if (resp.ok) {
        if (attempt > 0) {
          console.log(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} succeeded on retry ${attempt}`)
        }
        return
      }
      // 4xx Client error (except 408/429) do not retry
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} HTTP ${resp.status} (no retry)`)
        return
      }
      lastError = new Error(`HTTP ${resp.status}`)
    } catch (err) {
      lastError = err
    }
  }
  console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} failed after ${RETRY_COUNT} retries:`, lastError)
}

function buildTelegramUrl(webhook: WebhookEntry): string {
  // Telegram of URL directly https://api.telegram.org/bot<token>/sendMessage
  return webhook.url.endsWith('/sendMessage') ? webhook.url : `${webhook.url.replace(/\/$/, '')}/sendMessage`
}

function buildWebhookBody(webhook: WebhookEntry, payload: WebhookMessage): unknown {
  const icon = ({ info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' } as const)[payload.level]
  const fieldsText = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n')
    : ''
  const plainFields = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  const fullText = `${icon} ${payload.title}\n\n${payload.message}${plainFields}`

  switch (webhook.kind) {
    case 'dingtalk':
      // DingTalk Robot markdown
      return {
        msgtype: 'markdown',
        markdown: {
          title: payload.title,
          text: `### ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'wechat-work':
      // Enterprise WeChat robot markdown
      return {
        msgtype: 'markdown',
        markdown: {
          content: `## ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'feishu':
      // Feishu Robot text
      return {
        msg_type: 'text',
        content: { text: fullText }
      }
    case 'telegram':
      return {
        chat_id: webhook.telegramChatId,
        text: fullText,
        parse_mode: 'Markdown'
      }
    case 'discord':
      // Discord webhook
      return {
        username: 'Kiro Account Manager',
        embeds: [{
          title: `${icon} ${payload.title}`,
          description: payload.message,
          color: payload.level === 'error' ? 0xff0000
            : payload.level === 'warn' ? 0xffaa00
            : payload.level === 'success' ? 0x00ff00
            : 0x4a9eff,
          fields: payload.fields
            ? Object.entries(payload.fields).map(([name, value]) => ({ name, value: String(value), inline: true }))
            : undefined,
          timestamp: new Date().toISOString()
        }]
      }
    case 'custom':
    default: {
      if (webhook.customTemplate) {
        // Easy template replacement
        try {
          const tpl = webhook.customTemplate
            .replace(/\{\{title\}\}/g, escapeJsonString(payload.title))
            .replace(/\{\{message\}\}/g, escapeJsonString(payload.message))
            .replace(/\{\{level\}\}/g, payload.level)
            .replace(/\{\{icon\}\}/g, icon)
          return JSON.parse(tpl)
        } catch {
          // Template parsing failed: return to simple JSON
        }
      }
      return {
        title: payload.title,
        message: payload.message,
        level: payload.level,
        fields: payload.fields,
        timestamp: new Date().toISOString()
      }
    }
  }
}

function escapeJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}
