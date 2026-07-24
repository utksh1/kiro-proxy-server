import * as tls from 'tls'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import type { SessionClient } from 'tlsclientwrapper'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import { randomEmailPrefix } from './names'

function getRegistrationProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || undefined
}

async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  const agent = safeCreateProxyAgent(getRegistrationProxyUrl())
  if (agent) {
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// ============ Verification code extraction ============

const OTP_PATTERN = /\b(\d{6})\b/g

export function extractCode(body: string): string {
  const matches = body.match(OTP_PATTERN)
  if (!matches || matches.length === 0) return ''
  return matches[matches.length - 1]
}

// ============ TempEmailService interface ============

export interface TempEmailService {
  create(): Promise<string>
  /** signal: Interrupt polling (stop/Exit immediately after pausing instead of waiting until it is full timeout） */
  waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string>
  getAddress(): string
}

/** can be AbortSignal Interrupted sleep: Immediately when registration is stopped reject, no more stupid waiting */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Registration canceled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Registration canceled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ============ MoEmail Temporary mailbox ============

export class MoEmailService implements TempEmailService {
  private baseURL: string
  private apiKey: string
  private address = ''

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = MoEmailService.normalizeBaseURL(baseURL)
    this.apiKey = apiKey
  }

  /**
   * Normalized user input baseURL：
   *   - Remove leading and trailing whitespace and trailing slashes
   *   - Lack protocol Time to make up for `https://`
   *   - The verification protocol only allows http / https, otherwise throw a clear error
   * used to circumvent fetch Thrown due to illegal protocol
   * "Invalid URL protocol: the URL must start with `http:` or `https:`."
   */
  private static normalizeBaseURL(raw: string): string {
    const trimmed = (raw || '').trim().replace(/\/+$/, '')
    if (!trimmed) throw new Error('MoEmail BaseURL Not configured')
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    let u: URL
    try {
      u = new URL(withScheme)
    } catch {
      throw new Error(`MoEmail BaseURL Invalid format: ${raw}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`MoEmail BaseURL The protocol is not supported (Only supports http/https): ${u.protocol}`)
    }
    return withScheme
  }

  async create(): Promise<string> {
    const url = `${this.baseURL}/api/mail/create`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(30000) })
    const data = (await resp.json()) as Record<string, unknown>

    const addr =
      (data.address as string) ||
      (data.email as string) ||
      ((data.data as Record<string, unknown>)?.address as string) ||
      ((data.data as Record<string, unknown>)?.email as string) ||
      ''

    if (!addr) {
      console.log('[MoEmail] Failed to create mailbox:', JSON.stringify(data))
      return ''
    }
    this.address = addr
    return addr
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('Email address is empty')

    const maxRetries = Math.floor(timeoutSec / intervalSec)
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Registration canceled')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const code = await this.fetchCode()
        if (code) return code
      } catch (err) {
        if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] Query failed:`, err)
      }
      if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] No verification code yet...`)
    }
    throw new Error(`Timeout waiting for verification code (${timeoutSec}s)`)
  }

  getAddress(): string {
    return this.address
  }

  private async fetchCode(): Promise<string> {
    const url = `${this.baseURL}/api/mail/messages?address=${this.address}`
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15000) })
    const raw = await resp.json()

    let messages: Array<Record<string, unknown>> = []
    if (Array.isArray(raw)) {
      messages = raw as Array<Record<string, unknown>>
    } else if (typeof raw === 'object' && raw !== null) {
      const wrapper = raw as Record<string, unknown>
      if (Array.isArray(wrapper.data)) {
        messages = wrapper.data as Array<Record<string, unknown>>
      }
    }

    for (const msg of messages) {
      const text = (msg.text as string) || (msg.body as string) || (msg.html as string) || ''
      if (text) {
        const code = extractCode(text)
        if (code) return code
      }
    }
    return ''
  }
}

// ============ TempMail.Plus + Self-created domain name ============

export class TempMailPlusService implements TempEmailService {
  private static readonly BASE_URL = 'https://tempmail.plus/api'

  private readonly tmEmail: string   // tempmail.plus Username (excluding @mailto.plus）
  private readonly epin: string
  /** Supports multiple domain names (users fill in multiple lines/comma/separated by spaces), each time create Pick one at random to reduce risk control associated with a single domain name */
  private readonly domains: string[]
  private domain = ''
  private address = ''

  constructor(tmEmail: string, epin: string, domain: string) {
    this.tmEmail = tmEmail
    this.epin = epin
    this.domains = domain
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, ''))
      .filter(Boolean)
    if (this.domains.length === 0) {
      throw new Error('TempMail.Plus Self-created domain name is empty')
    }
  }

  private get headers(): Record<string, string> {
    return {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://tempmail.plus/zh/',
      'cookie': `email=${encodeURIComponent(this.fullEmail)}`
    }
  }

  async create(): Promise<string> {
    const prefix = randomEmailPrefix()
    this.domain = this.domains[Math.floor(Math.random() * this.domains.length)]
    this.address = `${prefix}@${this.domain}`
    if (this.domains.length > 1) {
      console.log(`[TempMailPlus] Generate mailbox: ${this.address}  (Domain name pool ${this.domains.length} indivual)`)
    } else {
      console.log(`[TempMailPlus] Generate mailbox: ${this.address}`)
    }
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('Email address is empty')
    const maxRetries = Math.floor(timeoutSec / intervalSec)
    const checkedIds = new Set<number>()

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Registration canceled')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const mails = await this.fetchMailList()
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[TempMailPlus] [${attempt}/${maxRetries}] Number of emails: ${mails.length}`)
        }
        for (const mail of mails) {
          const mailId = mail.mail_id as number
          if (checkedIds.has(mailId)) continue
          checkedIds.add(mailId)

          const detail = await this.fetchMailDetail(mailId)
          if (!detail) continue

          // Verify recipient matches
          const toField = String(detail.to || '').toLowerCase()
          if (!toField.includes(this.address.toLowerCase())) {
            console.log(`[TempMailPlus] Recipient does not match: ${toField} (expected to contain: ${this.address})`)
            continue
          }

          // Extract verification code
          const code = this.extractOTP(detail)
          if (code) {
            console.log(`[TempMailPlus] Verification code: ${code}`)
            await this.deleteMail(mailId)
            return code
          } else {
            console.log(`[TempMailPlus] mail ${mailId} Verification code not retrieved`)
          }
        }
      } catch (err) {
        console.log(`[TempMailPlus] [${attempt}/${maxRetries}] Query failed:`, err)
      }
      if (attempt % 5 === 0) console.log(`[TempMailPlus] [${attempt}/${maxRetries}] No verification code yet...`)
    }
    throw new Error(`Timeout waiting for verification code (${timeoutSec}s)`)
  }

  private get fullEmail(): string {
    return `${this.tmEmail}@mailto.plus`
  }

  private async fetchMailList(): Promise<Array<Record<string, unknown>>> {
    const url = `${TempMailPlusService.BASE_URL}/mails?email=${encodeURIComponent(this.fullEmail)}&first_id=0&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    if (!data.result) return []
    return (data.mail_list as Array<Record<string, unknown>>) || []
  }

  private async fetchMailDetail(mailId: number): Promise<Record<string, unknown> | null> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}?email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    return data.result ? data : null
  }

  private async deleteMail(mailId: number): Promise<void> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}`
    const headers = { ...this.headers, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    const body = `email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    try {
      await proxyFetch(url, { method: 'DELETE', headers, body, signal: AbortSignal.timeout(10000) })
      console.log(`[TempMailPlus] Deleted messages: ${mailId}`)
    } catch (err) {
      console.log(`[TempMailPlus] Failed to delete message:`, err)
    }
  }

  private extractOTP(detail: Record<string, unknown>): string {
    // Extract from topic
    const subject = String(detail.subject || '')
    const subjectMatch = subject.match(/(\d{6})/)
    if (subjectMatch) return subjectMatch[1]
    // Extract from text
    const text = String(detail.text || '')
    const code = extractCode(text)
    if (code) return code
    // from HTML extract
    const html = String(detail.html || '')
    return extractCode(html)
  }
}

// ============ GPTmail (mail.chatgpt.org.uk) — Domain name email code retrieval ============

/**
 * GPTmail（mail.chatgpt.org.uk) Get the code source,**Supports two modes of play at the same time**：
 *
 * How to play A：Private domain name direct payment (recommended, no need CF）
 *   1) Users put their own domain name MX parse directly to GPTmail(exist GPTmail Site add private/After the domain name is made public, it will be MX instruction)
 *   2) Generated during registration `prefix@User domain name` —— The address itself is GPTmail on inbox，
 *      All emails sent to it GPTmail received directly
 *   3) use the same address GET Page take token, polling to get the code
 *   inboxEmail Leave blank to use this mode.
 *
 * How to play B：CF Email Routing Forward
 *   1) User is in GPTmail Have a fixed receiving mailbox (such as one in a public domain name pool) abc@msn-mail-free-9224.dynv6.net）
 *   2) Users in their own domain name Cloudflare match catch-all：*@example.com → abc@msn-mail-free-9224.dynv6.net
 *   3) Generated during registration `prefix@example.com`，CF Forward to receiving email
 *   4) Use receiving email token Polling, soft matching this registration address from the email (CF forwarded mail to The field will be the receiving email address)
 *   inboxEmail Filling it out means going into this mode.
 *
 * GPTmail Key points of the agreement (based on the official front-end + Packet capture):
 *  - direct GET `https://mail.chatgpt.org.uk/<email>` page, from HTML parse `window.__BROWSER_AUTH.token`
 *    (server SSR Embed, this is what the browser initially gets token of"zero cost"path, than POST /api/inbox-token More difficult to be reversed)
 *  - GET /api/emails?email=<inbox> (header x-inbox-token)
 *      -> {success, data:{emails:[{id, email_address, from_address, subject, content, html_content}]}, auth:{token,...}}
 *  - DELETE /api/emails/clear?email=<inbox> (header x-inbox-token)
 *  - Each response will be refreshed token(Including sid+email+exp), this type automatically scrolls and saves
 *  - Cloudflare Backend passes TLS fingerprint + sec-ch-* + Referer check"Is it true Chrome"，
 *    So this class must pass tlsclientwrapper SessionClient send request
 */
export class GptMailService implements TempEmailService {
  private static readonly DEFAULT_BASE_URL = 'https://mail.chatgpt.org.uk'
  // and sessionOpts of tlsClientIdentifier='chrome_146' and SessionClient default UA Be consistent,
  // otherwise sec-ch-ua / UA / JA3 If the three versions do not match each other, it is easy to be Cloudflare Risk control sees through.
  private static readonly CHROME_MAJOR = 146
  private static readonly UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${GptMailService.CHROME_MAJOR}.0.0.0 Safari/537.36`
  private static readonly SEC_CH_UA = `"Google Chrome";v="${GptMailService.CHROME_MAJOR}", "Chromium";v="${GptMailService.CHROME_MAJOR}", "Not)A;Brand";v="24"`

  private readonly baseURL: string
  /**
   * Fixed receiving email (CF forwarding target).
   * - How to play A(Private domain name is received directly): Leave blank —— The registered address itself is inbox
   * - How to play B（CF Forward): filled in, all prefix@domain Forward them all to this email
   */
  private readonly fixedInboxEmail: string
  /** User’s own domain name pool (how to play A：MX has been resolved to GPTmail;How to play B：CF Matched catch-all）*/
  private readonly domains: string[]
  /** Optional fixed prefix; leave blank to use randomEmailPrefix() generate */
  private readonly fixedPrefix: string
  /**
   * Optional: Private domain name password.
   * exist GPTmail When adding a "private domain name" to the site, a password will be set, and all the inbox Before checking email, you must unlock。
   * Leave blank = Public domain name or public domain name (no password required).
   */
  private readonly privatePassword: string
  /**
   * Get current TLS SessionClient of getter(camouflage Chrome JA3 fingerprint).
   * GPTmail Backend passes TLS Handshake fingerprint verification"Is it a real browser?"，
   * Node default TLS / undici Will be found out and return 401 "Browser session required"，
   * So it must be used Registrar Already initialized SessionClient Send a request.
   *
   * Key: here**Cannot cache SessionClient Example**。Registrar During the registration process (Portal/WorkflowInit
   * Retry, network jitter, recoverable TLS error) will rebuildTlsClient() —— destroy old session Build a new one.
   * If the old reference is cached, once it occurs between the creation of the mailbox and the retrieval of the code, rebuild,old session already destroyed，
   * Each subsequent poll will throw "SessionClient has been destroyed" until timeout.
   * So every request goes through getter read Registrar of**up to date** session。
   */
  private readonly getSession: () => SessionClient | null

  /** Used for this registration"User side"Email address (prefix@User domain name)—— This is what you see when you register for the site */
  private address = ''
  /** Used to actually query emails GPTmail inbox address (how to play A = address;How to play B = fixedInboxEmail）*/
  private inboxEmail = ''
  /** current scroll token: Each response if brought back auth.token then replace */
  private token = ''
  /**
   * create() already existed inbox mail ID baseline.
   * CF In forwarding mode, multiple concurrent registrations share the same inbox, never use the full amount clear(Verification codes pending for other tasks will be deleted);
   * Record baseline instead ID, skip these old emails when polling, to achieve no side effects and safe concurrency.
   */
  private baselineIds = new Set<string>()

  constructor(opts: {
    baseURL?: string
    inboxEmail?: string
    domain: string
    prefix?: string
    privatePassword?: string
    /** Get current SessionClient of getter(Do not cache, circumvent rebuildTlsClient later reference invalid) */
    getSession: () => SessionClient | null
  }) {
    if (typeof opts.getSession !== 'function') {
      throw new Error('GPTmail Must be passed in getSession(used to get the latest every time TLS SessionClient bypass 401 check)')
    }
    this.getSession = opts.getSession
    this.baseURL = GptMailService.normalizeBaseURL(opts.baseURL || GptMailService.DEFAULT_BASE_URL)
    this.fixedInboxEmail = (opts.inboxEmail || '').trim()
    if (this.fixedInboxEmail && !this.fixedInboxEmail.includes('@')) {
      throw new Error('GPTmail The receiving email format is invalid (should be xxx@yyy.zzz, or leave it blank to smuggle domain names for direct payment)')
    }
    this.domains = (opts.domain || '')
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, ''))
      .filter(Boolean)
    if (this.domains.length === 0) {
      throw new Error('GPTmail The self-created domain name pool is empty (private mode: MX has been resolved to GPTmail domain name;CF model: CF Matched catch-all domain name)')
    }
    this.fixedPrefix = (opts.prefix || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
    this.privatePassword = (opts.privatePassword || '').trim()
  }

  private static normalizeBaseURL(raw: string): string {
    const trimmed = (raw || '').trim().replace(/\/+$/, '')
    if (!trimmed) return 'https://mail.chatgpt.org.uk'
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    let u: URL
    try {
      u = new URL(withScheme)
    } catch {
      throw new Error(`GPTmail BaseURL Invalid format: ${raw}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`GPTmail BaseURL The protocol is not supported (Only supports http/https): ${u.protocol}`)
    }
    return withScheme
  }

  /**
   * from page HTML extracted from `window.__BROWSER_AUTH = {...}` of JSON text.
   * Balance the scan with brackets (identify strings and escapes), starting with the first `{` Start finding matches `}`，
   * Supports nesting within objects {} —— More robust than non-greedy regularization.
   */
  private static extractBrowserAuthJson(html: string): string | null {
    const anchor = html.indexOf('__BROWSER_AUTH')
    if (anchor < 0) return null
    const start = html.indexOf('{', anchor)
    if (start < 0) return null
    let depth = 0
    let inStr = false
    let quote = ''
    let escaped = false
    for (let i = start; i < html.length; i++) {
      const ch = html[i]
      if (inStr) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === quote) inStr = false
        continue
      }
      if (ch === '"' || ch === '\'') {
        inStr = true
        quote = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) return html.slice(start, i + 1)
      }
    }
    return null
  }

  /**
   * General Request: Pass tlsclientwrapper(camouflage Chrome JA3 fingerprint) call GPTmail API。
   *
   * key:GPTmail pass TLS fingerprint + Referer/Origin/sec-ch-* check"Is it true Chrome"，
   * use Node default TLS / undici Will be found out and return 401 {"error":"Browser session required"}。
   * This method goes Registrar of SessionClient(camouflage chrome_146 JA3) and complete the browser headers，
   * to pass Cloudflare Climb backwards.
   *
   * automatic injection x-inbox-token, and scroll updates from the response token。
   */
  private async request<T = Record<string, unknown>>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'DELETE'; body?: string; withToken?: boolean; headers?: Record<string, string>; _retried?: boolean } = {}
  ): Promise<T> {
    const url = `${this.baseURL}${path}`
    const origin = new URL(this.baseURL).origin
    // Referer Aligned with the official packet capture:`https://mail.chatgpt.org.uk/<inboxEmail>`(without /zh/）
    const referer = `${origin}/${this.inboxEmail || ''}`
    const method: 'GET' | 'POST' | 'DELETE' = init.method ?? 'GET'

    const headers: Record<string, string> = {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': GptMailService.UA,
      'origin': origin,
      'referer': referer,
      'sec-ch-ua': GptMailService.SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...(init.headers || {})
    }
    if (init.body && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json'
    }
    if ((init.withToken ?? true) && this.token) {
      headers['x-inbox-token'] = this.token
    }

    // Walk tlsclientwrapper(camouflage Chrome 146 JA3 + Depend on Registrar of sessionOpts injection UA/acting)
    const session = this.getSession()
    if (!session) throw new Error('GPTmail TLS SessionClient Unavailable (may be rebuilding, try again later)')
    let raw: { status: number; body: string }
    if (method === 'POST') {
      raw = await session.post(url, init.body ?? '', { headers })
    } else if (method === 'DELETE') {
      raw = await session.delete(url, { headers })
    } else {
      raw = await session.get(url, { headers })
    }

    let data: unknown
    try { data = JSON.parse(raw.body) } catch { data = raw.body }

    // 401/403 And bring token: maybe scrolling token Expired —— Get it from the page again token Try again later.
    // (if TLS Fingerprints revealed "Browser session required", it is harmless to retrieve, and it will be thrown according to the original error if it fails at most once)
    if ((raw.status === 401 || raw.status === 403) && !init._retried && (init.withToken ?? true) && path !== '') {
      try {
        await this.fetchInitialTokenFromPage()
        return await this.request<T>(path, { ...init, _retried: true })
      } catch { /* If retrieval fails, the original error will be thrown. */ }
    }

    if (raw.status < 200 || raw.status >= 300) {
      const snippet = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)
      throw new Error(`GPTmail ${path} HTTP ${raw.status}: ${snippet}`)
    }

    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      const auth = obj.auth as Record<string, unknown> | undefined
      const newToken = auth?.token
      if (typeof newToken === 'string' && newToken) {
        this.token = newToken
      }
    }
    return data as T
  }

  async create(): Promise<string> {
    // step 1: generate"prefix@User-created domain name" as the email address submitted for registration site
    const domain = this.domains[Math.floor(Math.random() * this.domains.length)]
    const prefix = this.fixedPrefix || randomEmailPrefix()
    this.address = `${prefix}@${domain}`

    // step 2: Decide to query GPTmail Which one to use when inbox Mail
    //   How to play A(Private domain name is collected directly):inboxEmail = address —— The registered address itself is inbox（MX has been resolved to GPTmail）
    //   How to play B（CF Forward):     inboxEmail = fixedInboxEmail —— Forward all emails to this pin inbox
    this.inboxEmail = this.fixedInboxEmail || this.address

    // step 3: GET Inbox page https://mail.chatgpt.org.uk/<inboxEmail>,from HTML analysis
    //   Server SSR embedded window.__BROWSER_AUTH(Including initial token）。
    //   Compare POST /api/inbox-token It is less likely to trigger anti-climbing (that POST The endpoint will return 401 "Browser session required"）。
    await this.fetchInitialTokenFromPage()
    if (!this.token) {
      throw new Error('GPTmail from page HTML parse __BROWSER_AUTH.token fail')
    }

    // step 4: Private domain name password unlock (if a password is set)—— Private domain name inbox in the future unlock pre-check emails will return 403
    if (this.privatePassword) {
      await this.unlockPrivateInbox()
    }

    // step 5: Record inbox Existing mail ID As a baseline, these old emails are skipped when polling to avoid historical CAPTCHA contamination.
    //   No longer do the full amount clear —— CF In forwarding mode, multiple concurrent registrations share the same inbox，
    //   Deleting all of them will accidentally delete the verification codes waiting for other tasks. The baseline regimen has no side effects and is safe.
    try {
      const existing = await this.fetchMails()
      for (const mail of existing) {
        const id = String(mail.id ?? '')
        if (id) this.baselineIds.add(id)
      }
      if (this.baselineIds.size > 0) {
        console.log(`[GPTmail] inbox Baseline number of messages: ${this.baselineIds.size}(will be skipped when polling)`)
      }
    } catch { /* Failure to obtain the baseline does not affect subsequent polling */ }

    const mode = this.fixedInboxEmail
      ? `CF Forward → ${this.inboxEmail}`
      : this.privatePassword ? 'Private domain name direct acquisition (unlocked)' : 'Private domain name direct collection (MX→GPTmail）'
    if (this.domains.length > 1) {
      console.log(`[GPTmail] Register email: ${this.address}  (Domain name pool ${this.domains.length} individual, pattern: ${mode})`)
    } else {
      console.log(`[GPTmail] Register email: ${this.address}  (model: ${mode})`)
    }
    return this.address
  }

  /**
   * pass GET page HTML parse window.__BROWSER_AUTH initial token。
   * GPTmail The server will be in SSR Time `{token,email,expires_at}` render to HTML inline script inside,
   * This is what the browser gets token of"zero cost"path, will not trigger /api/inbox-token Anti-climbing protection.
   */
  private async fetchInitialTokenFromPage(): Promise<void> {
    const origin = new URL(this.baseURL).origin
    const pageUrl = `${origin}/${this.inboxEmail}`

    const pageHeaders: Record<string, string> = {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': GptMailService.UA,
      'sec-ch-ua': GptMailService.SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    }

    const session = this.getSession()
    if (!session) throw new Error('GPTmail TLS SessionClient Unavailable (may be rebuilding, try again later)')
    const raw = await session.get(pageUrl, { headers: pageHeaders })
    if (raw.status < 200 || raw.status >= 300) {
      throw new Error(`GPTmail GET ${pageUrl} HTTP ${raw.status}: ${raw.body.slice(0, 200)}`)
    }

    // parse window.__BROWSER_AUTH = { ... };Use brackets to balance scans instead of non-greedy regularization,
    // Avoid nested objects {} when being `\{[\s\S]*?\}` Early truncation results in JSON Parsing failed.
    const jsonText = GptMailService.extractBrowserAuthJson(raw.body)
    if (!jsonText) {
      throw new Error('GPTmail Not found on the page window.__BROWSER_AUTH(Server structure may have changed)')
    }
    let auth: Record<string, unknown>
    try {
      auth = JSON.parse(jsonText)
    } catch (err) {
      throw new Error(`GPTmail __BROWSER_AUTH JSON Parsing failed: ${err instanceof Error ? err.message : err}`)
    }
    const token = typeof auth.token === 'string' ? auth.token : ''
    if (!token) {
      throw new Error(`GPTmail __BROWSER_AUTH lack token Field: ${JSON.stringify(auth).slice(0, 200)}`)
    }
    this.token = token
    console.log(`[GPTmail] Already got initial from page token（email=${auth.email}, exp=${auth.expires_at}）`)
  }

  /**
   * Unlock private domain name password.
   * GPTmail Private domain name inbox in the future unlock Called before /api/emails will return 403 "private domain password required"。
   * must first POST /api/private-domains/unlock {email, password} get unlock later token, and then poll for emails.
   */
  private async unlockPrivateInbox(): Promise<void> {
    const lang = 'zh-CN' // and official frontend Consistent by default
    const resp = await this.request<Record<string, unknown>>(
      `/api/private-domains/unlock?lang=${encodeURIComponent(lang)}`,
      {
        method: 'POST',
        body: JSON.stringify({ email: this.inboxEmail, password: this.privatePassword })
      }
    )
    if (!resp.success) {
      const err = (resp.error as string) || JSON.stringify(resp).slice(0, 200)
      throw new Error(`GPTmail Unlocking private domain name failed: ${err}(Wrong password? Domain not set to private?)`)
    }
    console.log(`[GPTmail] Private domain name inbox Unlocked successfully: ${this.inboxEmail}`)
    // token has been request() internally from auth.token Automatic rolling updates
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('GPTmail The registered email is empty and needs to be called first create()')
    if (!this.inboxEmail) throw new Error('GPTmail inbox The mailbox is empty and needs to be called first create()')
    if (!this.token) throw new Error('GPTmail token is empty, needs to be called first create()')

    const maxRetries = Math.max(1, Math.floor(timeoutSec / intervalSec))
    // use create() baseline recorded at ID Initialization: Skip existing before registration inbox old emails
    const checkedIds = new Set<string>(this.baselineIds)
    const userLocal = this.address.toLowerCase().split('@')[0]
    // In private domain name direct acquisition mode,inbox = address, all messages to must be address, just match strictly
    const isPrivateDirect = !this.fixedInboxEmail

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Registration canceled')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const mails = await this.fetchMails()
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[GPTmail] [${attempt}/${maxRetries}] Inbox(${this.inboxEmail}) Number of emails: ${mails.length}`)
        }
        for (const mail of mails) {
          const id = String(mail.id ?? '')
          if (!id || checkedIds.has(id)) continue
          checkedIds.add(id)

          const subject = String(mail.subject ?? '')
          const content = String(mail.content ?? '')
          const html = String(mail.html_content ?? mail.html ?? '')

          if (isPrivateDirect) {
            // Private direct collection:inbox=address，email_address Must match
            const to = String(mail.email_address ?? '').toLowerCase()
            if (to && to !== this.address.toLowerCase()) {
              continue
            }
          } else {
            // CF Forward:email_address=inbox, need to start from subject/body Soft matching this registration address,
            //         avoid getting the same inbox Old verification codes for other registrations
            const blob = `${subject}\n${content}\n${html}`.toLowerCase()
            const matches = blob.includes(this.address.toLowerCase()) || blob.includes(userLocal)
            if (!matches) {
              // Notice:subject/body It may not contain the registered address (some services only send"your verification code"No email response),
              //       If at this time inbox There happens to be only this one new email, and it may be from this time. —— But we skip it conservatively to avoid misuse
              continue
            }
          }

          const code = this.extractOTP(mail)
          if (code) {
            console.log(`[GPTmail] Extract verification code: ${code} (from=${mail.from_address ?? ''}, subject=${subject.slice(0, 60)})`)
            // No longer the full amount clear inbox：CF In forwarding mode, multiple tasks share the same inbox，
            // Clearing it will accidentally delete the verification codes waiting for other tasks. This email has been credited checkedIds，
            // Subsequent examples rely on create() Recapturing baseline skips is sufficient to avoid repeated decoding.
            return code
          }
        }
      } catch (err) {
        if (attempt % 5 === 0) {
          console.log(`[GPTmail] [${attempt}/${maxRetries}] Query failed:`, err instanceof Error ? err.message : err)
        }
      }
      if (attempt % 5 === 0) console.log(`[GPTmail] [${attempt}/${maxRetries}] No verification code yet...`)
    }
    throw new Error(`GPTmail Timeout waiting for verification code (${timeoutSec}s)`)
  }

  private async fetchMails(): Promise<Array<Record<string, unknown>>> {
    const url = `/api/emails?email=${encodeURIComponent(this.inboxEmail)}`
    const resp = await this.request<Record<string, unknown>>(url)
    if (!resp.success) return []
    const data = resp.data as Record<string, unknown> | undefined
    const arr = data?.emails
    return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : []
  }

  private extractOTP(mail: Record<string, unknown>): string {
    // 1) Included directly in the theme 6 digit ("Your code is 123456" kind)
    const subject = String(mail.subject ?? '')
    const subjMatch = subject.match(/(\d{6})/)
    if (subjMatch) return subjMatch[1]

    // 2) text(content is a plain text field,HAR inside AWS Verification code is here)
    const content = String(mail.content ?? '')
    const c1 = extractCode(content)
    if (c1) return c1

    // 3) HTML reveal all the details
    const html = String(mail.html_content ?? mail.html ?? '')
    return extractCode(html)
  }
}

// ============ Outlook IMAP ============

export interface OutlookAccount {
  email: string
  password: string
  clientId: string
  refreshToken: string
}

/** according to ---- split; extra hyphen(N-4)Return the previous field (refreshToken wait base64url may be '-' end) */
function splitByDashes(line: string): string[] {
  const parts: string[] = []
  const re = /-{4,}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    parts.push(line.slice(last, m.index) + '-'.repeat(m[0].length - 4))
    last = m.index + m[0].length
  }
  parts.push(line.slice(last))
  return parts
}

export function parseOutlookLines(data: string): OutlookAccount[] {
  const accounts: OutlookAccount[] = []
  data = data.trim()
  if (!data) return accounts

  const lines = data.split('\n')
  const parseEntry = (entry: string): void => {
    entry = entry.trim()
    if (!entry) return
    const parts = splitByDashes(entry)
    if (parts.length === 4) {
      accounts.push({
        email: parts[0].trim(),
        password: parts[1].trim(),
        clientId: parts[2].trim(),
        refreshToken: parts[3].trim()
      })
    }
  }

  if (lines.length === 1) {
    for (const part of data.split(/\s+/)) parseEntry(part)
  } else {
    for (const line of lines) parseEntry(line)
  }
  return accounts
}

export async function refreshOutlookToken(acc: OutlookAccount): Promise<string> {
  const form = new URLSearchParams({
    client_id: acc.clientId,
    refresh_token: acc.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
  })

  const resp = await proxyFetch(
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }
  )
  const data = (await resp.json()) as Record<string, unknown>
  if (resp.status !== 200) throw new Error(`Refresh failed ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const token = data.access_token as string
  if (!token) throw new Error('None in response access_token')
  return token
}

function buildXOAuth2(email: string, accessToken: string): string {
  const auth = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(auth).toString('base64')
}

class IMAPClient {
  private socket: tls.TLSSocket | null = null
  private buffer = ''
  private tag = 0

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(993, 'outlook.office365.com', { servername: 'outlook.office365.com' })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Connection timeout'))
      }, 15000)

      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.readLine().then(() => resolve()).catch(reject)
      })
    })
  }

  private readLine(timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected'))

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.socket?.removeListener('data', onData)
        this.socket?.removeListener('error', onError)
        reject(new Error('IMAP readLine time out'))
      }, timeoutMs)

      const done = (line: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket?.removeListener('data', onData)
        this.socket?.removeListener('error', onError)
        resolve(line)
      }

      const onError = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket?.removeListener('data', onData)
        reject(err)
      }

      const check = (): boolean => {
        const idx = this.buffer.indexOf('\r\n')
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          done(line)
          return true
        }
        return false
      }
      if (check()) return

      const onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString()
        check()
      }
      this.socket.on('data', onData)
      this.socket.once('error', onError)
    })
  }

  private async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('Not connected')
    this.tag++
    const tagStr = `A${String(this.tag).padStart(3, '0')}`
    this.socket.write(`${tagStr} ${cmd}\r\n`)
    return tagStr
  }

  private async readUntilTag(tag: string): Promise<{ lines: string[]; result: string }> {
    const lines: string[] = []
    while (true) {
      const line = await this.readLine()
      if (line.startsWith(`${tag} `)) return { lines, result: line }
      lines.push(line)
    }
  }

  async authenticate(email: string, accessToken: string): Promise<void> {
    const xoauth2 = buildXOAuth2(email, accessToken)
    const tag = await this.sendCommand(`AUTHENTICATE XOAUTH2 ${xoauth2}`)
    const { result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`Authentication failed: ${result}`)
    console.log('[IMAP] Authentication successful')
    await abortableSleep(800)
  }

  async selectInbox(): Promise<number> {
    for (let retry = 0; retry < 3; retry++) {
      const tag = await this.sendCommand('SELECT INBOX')
      const { lines, result } = await this.readUntilTag(tag)
      if (result.includes('OK')) {
        for (const line of lines) {
          const m = line.match(/\*\s+(\d+)\s+EXISTS/)
          if (m) return parseInt(m[1], 10)
        }
        return 0
      }
      if (retry < 2) {
        console.log(`[IMAP] SELECT INBOX fail (${result}), Try again ${retry + 1}/3...`)
        await abortableSleep((1 + retry) * 1000)
      }
    }
    throw new Error('SELECT INBOX Exhausted retries')
  }

  async fetchLatestBody(seq: number): Promise<string> {
    if (seq <= 0) throw new Error('Invalid email sequence number')
    const tag = await this.sendCommand(`FETCH ${seq} (BODY.PEEK[TEXT])`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`FETCH TEXT fail: ${result}`)

    const rawLines: string[] = []
    let inBody = false
    for (const line of lines) {
      if (line.includes('FETCH')) { inBody = true; continue }
      if (line === ')') continue
      if (inBody) rawLines.push(line)
    }
    const raw = rawLines.join('\n')

    // try to decode MIME base64
    const parts = raw.split('------=_Part_')
    let decoded = ''
    for (const part of parts) {
      if (part.includes('base64')) {
        const idx = part.indexOf('base64')
        const content = part.slice(idx + 6)
        const b64 = content.replace(/[\s]/g, '')
        try {
          decoded += Buffer.from(b64, 'base64').toString() + ' '
        } catch { /* ignore */ }
      }
    }
    if (decoded) return decoded

    // overall base64 decoding
    const cleaned = raw.replace(/[\s]/g, '')
    try {
      return Buffer.from(cleaned, 'base64').toString()
    } catch {
      return raw
    }
  }

  close(): void {
    if (this.socket) {
      try { this.socket.write('A999 LOGOUT\r\n') } catch { /* ignore */ }
      this.socket.destroy()
      this.socket = null
    }
  }
}

export async function getInboxCount(acc: OutlookAccount): Promise<number> {
  const accessToken = await refreshOutlookToken(acc)
  const client = new IMAPClient()
  try {
    await client.connect()
    await client.authenticate(acc.email, accessToken)
    return await client.selectInbox()
  } finally {
    client.close()
  }
}

export async function waitForOTP(
  acc: OutlookAccount,
  beforeCount: number,
  timeout: number,
  interval: number,
  signal?: AbortSignal
): Promise<string> {
  console.log(`[Outlook IMAP] Wait for verification code, Mail=${acc.email}, Number of emails before sending=${beforeCount}`)
  let accessToken = await refreshOutlookToken(acc)
  const maxRetries = Math.floor(timeout / interval)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Registration canceled')
    let client: IMAPClient | null = null
    try {
      client = new IMAPClient()
      await client.connect()
      await client.authenticate(acc.email, accessToken)
      const total = await client.selectInbox()

      if (total <= beforeCount) {
        if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] No new emails yet (current${total}seal up)...`)
        await abortableSleep(interval * 1000, signal)
        continue
      }

      for (let i = total; i > beforeCount; i--) {
        try {
          const body = await client.fetchLatestBody(i)
          const code = extractCode(body)
          if (code) {
            console.log(`[Outlook IMAP] Get verification code: ${code}`)
            return code
          }
        } catch { /* continue */ }
      }

      if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] Verification code not found in new email...`)
    } catch (err) {
      if (attempt % 5 === 0) console.log(`[Outlook IMAP] Connection failed:`, err)
      try { accessToken = await refreshOutlookToken(acc) } catch { /* ignore */ }
    } finally {
      client?.close()
    }
    await abortableSleep(interval * 1000, signal)
  }
  throw new Error(`Timeout waiting for verification code (${timeout}s)`)
}

