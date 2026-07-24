import { SessionClient, type ModuleClient } from 'tlsclientwrapper'
import { acquireModuleClient } from './tlsClientPool'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { RegistrationConfig } from './config'
import { BrowserIdentity, randomIdentity } from './browser-identity'
import { ChainProxyRelay } from './chainProxy'
import { FingerprintContext, newFPContext, resetPerfTiming, generateFingerprint } from './fingerprint'
import { encryptPassword } from './jwe'
import { refreshAppJSConfig } from './xxtea'
import {
  visitorId, awsccc, ubidGen, newUUID, gmtDate,
  extractParam, splitAfter, saveCookies,
  getNestedMap, getNestedStringMap
} from './http-utils'
import {
  TempEmailService, MoEmailService, TempMailPlusService, GptMailService,
  parseOutlookLines, getInboxCount, waitForOTP
} from './email-service'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import { redactString } from '../utils/redact'

export type LogFn = (message: string) => void

export interface FingerprintSnapshot {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  canvasHash: number
  screen: { width: number; height: number }
  /** Proxy URL used during registration (redacted prefix) */
  proxyUrl?: string
  /** Detected exit IP (actual public IP used during registration) */
  exitIP?: string
}

export interface RegistrationResult {
  status: 'success' | 'failed'
  email: string
  password?: string
  error?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  region?: string
  provider?: string
  verify?: Record<string, unknown>
  /** Fingerprint snapshot used in this registration (for audit and future reuse) */
  fingerprint?: FingerprintSnapshot
}

type StepFn = () => Promise<void>

/** Observable "stage" identifier for the registration process, for real-time progress display by task ID on frontend */
export type RegStepName =
  | 'init' | 'proxy-chain-ready' | 'tls-ready' | 'exit-ip'
  | 'oidc' | 'device' | 'email-created'
  | 'portal' | 'workflow-init' | 'submit-email'
  | 'signup' | 'send-otp' | 'waiting-otp' | 'otp-received'
  | 'create-identity' | 'set-password' | 'sso-workflow' | 'sso-token'
  | 'verify-alive' | 'done'

export interface RegStepEvent {
  name: RegStepName
  ts: number
  email?: string
  exitIp?: string
  extra?: Record<string, unknown>
}

export type StepFn2 = (event: RegStepEvent) => void

export class Registrar {
  private cfg: RegistrationConfig
  private session: SessionClient | null = null
  /** Shared ModuleClient (from tlsClientPool); not terminated in cleanup, released when process exits */
  private moduleClient: ModuleClient | null = null
  private cookies = new Map<string, string>()
  private identity: BrowserIdentity
  private fpCtx: FingerprintContext
  private vid: string

  private email = ''
  private emailSvc: TempEmailService | null = null
  private clientId = ''
  private clientSecret = ''
  private deviceCode = ''
  private userCode = ''
  private workflowHandle = ''
  private workflowId = ''
  private workflowState = ''
  private ubid = ''
  private regCode = ''
  private signState = ''
  private authCode = ''
  private ssoState = ''
  private wdcCSRFToken = ''
  private ssoToken = ''
  private outlookMailCount = 0

  private log: LogFn
  private onStep: StepFn2
  private abortController = new AbortController()
  private chainRelay: ChainProxyRelay | null = null
  private chainTargetProxy = ''
  private exitIP = ''
  private readonly tlsSessionId = newUUID() // Fixed: only one session registered in DLL throughout the Registrar lifecycle

  constructor(cfg: RegistrationConfig, log?: LogFn, onStep?: StepFn2) {
    this.cfg = cfg
    this.identity = randomIdentity()
    this.fpCtx = newFPContext(this.identity)
    this.vid = visitorId()
    // Registration logs are pushed to UI/console, uniformly redacting proxy credentials, tokens and other sensitive fragments
    const rawLog = log || ((msg: string): void => console.log(msg))
    this.log = (msg: string): void => rawLog(redactString(msg))
    this.onStep = onStep || ((): void => {})
  }

  /** Trigger step event: upper layer (frontend UI) can display real-time progress based on this. Fails silently to avoid affecting main flow. */
  private emitStep(name: RegStepName, info?: Partial<RegStepEvent>): void {
    try {
      this.onStep({ name, ts: Date.now(), email: this.email || undefined, exitIp: this.exitIP || undefined, ...info })
    } catch { /* ignore */ }
  }

  /** sec-ch-ua header based on current identity (dynamically generated, aligned with chromeVer) */
  private get secUA(): string {
    const major = this.identity.chromeVer.split('.')[0]
    return `"Chromium";v="${major}", "Not/A)Brand";v="24", "Google Chrome";v="${major}"`
  }

  /** Abort current registration process */
  abort(): void {
    this.abortController.abort()
  }

  /**
   * Enable proxy chain: if both upstreamProxy (upstream relay) and proxy (target proxy) are configured,
   * start a relay on localhost to chain the route as "localhost → relay → upstream relay (non-mainland) → target proxy → target site",
   * and point cfg.proxy to the local relay, making all subsequent requests automatically go through the chain.
   */
  private async setupProxyChain(): Promise<void> {
    const target = (this.cfg.proxy || '').trim()
    const upstream = (this.cfg.upstreamProxy || '').trim()
    if (!target || !upstream) return
    try {
      this.chainRelay = new ChainProxyRelay(upstream, target, (m) => this.log(m))
      const relayUrl = await this.chainRelay.start()
      this.chainTargetProxy = target
      this.cfg.proxy = relayUrl
      this.log('[ProxyChain] Proxy chain enabled: localhost → upstream relay → target proxy → target site')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.chainRelay = null
      // In strict proxy mode, chain failure must abort immediately to prevent "fallback to target proxy only" when mainland IP would be rejected by target
      if (this.cfg.strictProxy) {
        throw new Error(`[ProxyChain] Failed to enable, strict proxy mode aborted: ${msg}`)
      }
      this.log(`[ProxyChain] Failed to enable, falling back to direct target proxy use: ${msg}`)
    }
  }

  private checkAborted(): void {
    if (this.abortController.signal.aborted) throw new Error('Registration cancelled')
  }

  /**
   * Detect exit IP of current proxy and log it.
   * If detection fails and proxy URL is in parameterized format (bestproxy etc.), automatically switch session and rebuild proxy chain for retry.
   * Retry up to maxRetries times (default 2), ensuring a usable exit is obtained before continuing registration.
   */
  private async detectExitIP(maxRetries = 2): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proxyUrl = this.sessionOpts.proxyUrl
      try {
        const agent = safeCreateProxyAgent(proxyUrl)
        const resp = await undiciFetch('https://api.ipify.org?format=json', {
          method: 'GET',
          dispatcher: agent || undefined,
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': this.identity.ua }
        } as UndiciRequestInit)
        if (resp.ok) {
          const body = await resp.json() as Record<string, unknown>
          const ip = String(body.ip || body.query || body.origin || '').trim()
          if (ip) {
            this.exitIP = ip
            this.emitStep('exit-ip', { exitIp: ip })
          }
          const via = proxyUrl ? proxyUrl.replace(/:([^:@/]+)@/, ':***@') : undefined
          this.log(`[✓ IP] Exit IP: ${ip || 'unknown'}${via ? ` (via ${via})` : ' (direct)'}`)
          return // Success, exit
        }
        this.log(`[IP] Exit IP detection failed: HTTP ${resp.status}`)
      } catch (err) {
        this.log(`[IP] Exit IP detection failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // After failure, try switching session and rebuilding proxy chain
      if (attempt < maxRetries && this.canRefreshProxySession()) {
        this.log(`[IP] Switching session for retry (${attempt + 1}/${maxRetries})...`)
        await this.refreshProxySession()
      }
    }
    // All retries failed, continue registration (proxy might be temporarily unstable but TLS Client might work on different path)
    this.log('[IP] All exit IP detections failed, continuing registration process')
  }

  /** Check if current proxy supports session rotation (parameterized format + contains _session- or _area-/_life- etc.) */
  private canRefreshProxySession(): boolean {
    const target = this.chainTargetProxy || this.cfg.proxy || ''
    return /_(area|life|city|state|region|country)-/i.test(target)
  }

  /** Re-randomize session and rebuild proxy chain */
  private async refreshProxySession(): Promise<void> {
    // Restore to original target proxy URL (proxy chain replaces cfg.proxy with local relay address)
    const original = this.chainTargetProxy || this.cfg.proxy || ''
    if (!original) return

    // Replace or append _session-randomvalue
    const session = Array.from({ length: 8 }, () =>
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]
    ).join('')

    let newTarget: string
    if (/_session-[^_:@/]*/i.test(original)) {
      // Already has _session-xxx → replace
      newTarget = original.replace(/(_session-)[^_:@/]*/i, `$1${session}`)
    } else {
      // No _session- → insert before : or @
      const atIdx = original.indexOf('@')
      const colonIdx = original.indexOf(':', original.indexOf('://') + 3)
      const insertPos = colonIdx > 0 && colonIdx < atIdx ? colonIdx : atIdx
      newTarget = original.slice(0, insertPos) + `_session-${session}` + original.slice(insertPos)
    }

    this.log(`[IP] New session: ${newTarget.replace(/:([^:@/]+)@/, ':***@')}`)

    // Stop old proxy chain
    if (this.chainRelay) {
      await this.chainRelay.stop()
      this.chainRelay = null
    }

    // Rebuild
    this.cfg.proxy = newTarget
    this.chainTargetProxy = ''
    await this.setupProxyChain()
  }

  /** TLS SessionClient options */
  private get sessionOpts() {
    const explicit = (this.cfg.proxy && this.cfg.proxy.trim()) || undefined
    // Strict mode: must have explicit proxy, forbid fallback to environment variable/system proxy to prevent exposing real IP
    if (this.cfg.strictProxy) {
      if (!explicit) {
        throw new Error('Strict proxy mode: cfg.proxy is empty, aborted to prevent direct connection exposing real IP')
      }
    }
    const proxyUrl = this.cfg.strictProxy
      ? explicit
      : (explicit
        || process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy
        || getSystemProxy() || undefined)
    return {
      tlsClientIdentifier: 'chrome_146' as const,
      // 25s：AWS register API normal response 1-5s, slow residential agent 10-15s;More than basic is a hang.
      // Cooperate sendRequest of 3 retries, single step worst ~75s(old value 60s Will arrive ~180s, is a batch card 1-5 minute main reason)
      timeoutSeconds: 25,
      followRedirects: true,
      insecureSkipVerify: true,
      // Multithread isolation: fixed sessionId isolation DLL level shared TLS session cache
      // entire Registrar Use the same one during the life cycle ID,avoid rebuildTlsClient spawn zombies session
      sessionId: this.tlsSessionId,
      proxyUrl
    }
  }

  /**
   * initialization TLS client
   *
   * DLL Storage policy (by priority, from high to low):
   *   1. userData/tls-client/ — Application user data directory (the system will not clean it,**permanent reuse**）
   *   2. resources/ — Application installation directory (packaged resources, development version may not exist)
   *   3. tmpdir → Automatically migrate to userData(Old version compatible)
   *   4. GitHub Download to userData(The final answer, only the first time)
   */
  private async initTlsClient(): Promise<void> {
    const { existingPath, downloadDir } = this.ensureTlsLib()
    const opts = existingPath
      ? { customLibraryPath: existingPath }
      : { customLibraryDownloadPath: downloadDir }
    // Shared pool: the first registration is the real open(DLL+worker pool), after which all registrations are reused in seconds
    this.moduleClient = await acquireModuleClient(opts)
    this.log('[TLS] using shared ModuleClient, pool stats: ' + JSON.stringify(this.moduleClient.getPoolStats()))
    this.session = new SessionClient(this.moduleClient, this.sessionOpts)
  }

  /**
   * make sure tls-client Shared libraries are available
   * @returns existingPath Already existing complete DLL File path (if any, pass customLibraryPath）
   *          downloadDir  The directory to be downloaded (if not found, pass customLibraryDownloadPath let tlsclientwrapper automatic download)
   *
   * Prioritize to userData, to avoid being accidentally deleted by the system temporary directory cleaning tool (previously used tmpdir will be cleaned)
   */
  private ensureTlsLib(): { existingPath?: string; downloadDir: string } {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')
    const { app } = require('electron')

    const platform = os.platform()
    const arch = os.arch()
    let filename = 'tls-client-xgo-1.14.0-'
    if (platform === 'win32') {
      filename += (arch.includes('64') ? 'windows-amd64' : 'windows-386') + '.dll'
    } else if (platform === 'darwin') {
      filename += (arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64') + '.dylib'
    } else {
      filename += (arch === 'arm64' ? 'linux-arm64' : 'linux-amd64') + '.so'
    }

    // 1. userData Permanent directory (preferred)
    const userDataDir = app.getPath('userData')
    const tlsClientDir = path.join(userDataDir, 'tls-client')
    const finalPath = path.join(tlsClientDir, filename)

    // Make sure the directory exists
    try { fs.mkdirSync(tlsClientDir, { recursive: true }) } catch { /* ignore */ }

    // Already exists → Direct reuse
    if (fs.existsSync(finalPath)) {
      this.log('[TLS] Library reused from userData (persistent): ' + finalPath)
      return { existingPath: finalPath, downloadDir: tlsClientDir }
    }

    // 2. Copy from packaged resources (included in the installation package)
    const resourcePath = path.join(process.cwd() || '', filename)
    if (fs.existsSync(resourcePath)) {
      this.log('[TLS] Copying library from resources to userData (one-time): ' + resourcePath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(resourcePath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Failed to copy from resources: ' + (err as Error).message)
      }
    }

    // 3. Compatible with older versions: Check tmpdir copy and migrate to userData
    const tmpPath = path.join(os.tmpdir(), filename)
    if (fs.existsSync(tmpPath)) {
      this.log('[TLS] Migrating library from tmpdir to userData: ' + tmpPath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(tmpPath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Migration failed, will use tmpdir as fallback: ' + (err as Error).message)
        return { existingPath: tmpPath, downloadDir: tlsClientDir }
      }
    }

    // 4. None → return downloadDir,let tlsclientwrapper open() Automatically download to this directory (save permanently)
    this.log('[TLS] Library not found, will download from GitHub to userData (one-time): ' + tlsClientDir)
    return { downloadDir: tlsClientDir }
  }

  private async rebuildTlsClient(): Promise<void> {
    // Only rebuild lightweight ones SessionClient(new TLS connection), reuse heavyweight ModuleClient（worker pool + DLL）
    // Previous implementation meeting terminate + again open ModuleClient, causing each registration to create 2 indivual worker pool
    try { await this.session?.destroySession() } catch { /* ignore */ }
    if (!this.moduleClient) {
      await this.initTlsClient()
      return
    }
    this.session = new SessionClient(this.moduleClient, this.sessionOpts)
  }

  /**
   * use undici direct fetch Static resources (such as AWS signin app.js), bypassing tls-client。
   * reason:tls-client of dll It is a process-level singleton, and failed requests will pollute its global state.
   * resulting in subsequent reconstruction SessionClient Still reported later "no tls client for modification check"。
   * Static resources are not required TLS Fingerprint camouflage, use directly Node/undici fetch That’s it.
   */
  private async fetchAppJS(url: string, init?: RequestInit): Promise<Response> {
    const proxyUrl = (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
    const agent = safeCreateProxyAgent(proxyUrl)
    if (agent) {
      const resp = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent })
      return resp as unknown as Response
    }
    return await fetch(url, init)
  }

  private isRecoverableTlsClientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    return err.message.includes('EOF')
      || err.message.includes('no tls client for modification check')
      || err.message.includes('failed to modify existing client')
  }

  /** clean up TLS Client resources: destroyed only SessionClient；ModuleClient It is a process-level shared pool, no longer every time terminate */
  private async cleanup(): Promise<void> {
    if (this.chainRelay) {
      try { await this.chainRelay.stop() } catch { /* ignore */ }
      this.chainRelay = null
    }
    if (this.session) {
      // destroySession bring 3 Second timeout:Go runtime of idle connections May have to wait 60 Close in seconds
      const s = this.session
      this.session = null
      try {
        await Promise.race([
          s.destroySession(),
          new Promise(resolve => setTimeout(resolve, 3000))
        ])
      } catch { /* ignore */ }
    }
    // moduleClient It is a shared reference and cannot terminate(It will affect other running registrations)
    this.moduleClient = null
  }

  /** Public destruction method for external calls to release resources. at the same time abort All ongoing asynchronous operations. */
  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.cleanup()
  }

  // ============ HTTP Tool method ============

  private cookieString(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private buildHeaders(referer: string, origin: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Content-Type': 'application/json',
      'User-Agent': this.identity.ua,
      'sec-ch-ua': this.secUA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    if (referer) h['Referer'] = referer
    if (origin) h['Origin'] = origin
    if (this.cookies.size > 0) h['Cookie'] = this.cookieString()
    return h
  }

  private buildProfileHeaders(referer: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': this.identity.ua,
      'Origin': this.cfg.profileBase,
      'Referer': referer,
      'sec-ch-ua': this.secUA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'priority': 'u=1, i'
    }
    const keys = ['awsccc', 'aws-user-profile-ubid', 'i18next']
    if (this.cookies.has('awsd2c-token')) keys.push('awsd2c-token', 'awsd2c-token-c')
    const parts = keys.filter((k) => this.cookies.has(k)).map((k) => `${k}=${this.cookies.get(k)}`)
    if (parts.length) h['Cookie'] = parts.join('; ')
    return h
  }

  private async doGet(url: string, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    return this.sendRequest('GET', url, headers)
  }

  private async doPost(url: string, payload: unknown, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    return this.sendRequest('POST', url, headers, JSON.stringify(payload))
  }

  /** Network layer backoff duration: index + Jitter (approx. 0.8s / 1.6s / 3.2s, capped 8s） */
  private netBackoffMs(attempt: number): number {
    const base = Math.min(800 * Math.pow(2, attempt - 1), 8000)
    return base + Math.floor(Math.random() * 400)
  }

  /**
   * Determine whether the response is a "transient failure" and need to be retried.
   * key:tlsclientwrapper Will fail the connection layer (EOF / reset / timeout) packaged as status=0 + body error description,
   * No exception is thrown; if it is not recognized by the response layer, it will be regarded as a business failure by the upper layer and directly sentenced to death (such as #9 "The encryption public key was not obtained").
   */
  private isTransientResponse(status: number, body: string): boolean {
    if (status === 0 || status === 429 || status === 502 || status === 503 || status === 504) return true
    const lower = body.toLowerCase()
    return lower.includes('failed to do request') || lower.includes('eof')
      || lower.includes('connection reset') || lower.includes('timeout')
  }

  /**
   * Determining whether it is a "timeout type" failed (exit IP slow / Being restricted / tunnel hang).
   * This type of failed reconstruction TLS(same IP Reconnect) is useless and should be replaced proxy session switch outlet IP。
   */
  private isTimeoutResponse(status: number, body: string): boolean {
    if (status === 504) return true
    if (status !== 0) return false
    const lower = body.toLowerCase()
    return lower.includes('timeout') || lower.includes('deadline')
      || lower.includes('client.timeout') || lower.includes('failed to do request')
  }

  /**
   * unified TLS Request Sent: Failure on transient network (status=0 / EOF / 5xx / 429) automatically "rebuilds TLS + Exponential backoff" and try again.
   * The client will only be rebuilt if the connection class fails, and the current limiting class will only back off;cookies exist in this.cookies, will not be lost with reconstruction.
   */
  private async sendRequest(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    if (!this.session) throw new Error('TLS Client not initialized')
    const maxAttempts = 3
    let lastErr: unknown = null
    let sessionRefreshed = false // The entire request can be changed at most 1 Second-rate proxy session, to avoid frequent suspension of proxy chain construction
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = method === 'GET'
          ? await this.session!.get(url, { headers })
          : await this.session!.post(url, body ?? '', { headers })
        const decoded = this.decodeBody(resp.body)
        const status = resp.status
        if (attempt < maxAttempts && this.isTransientResponse(status, decoded)) {
          const broken = status === 0 || /eof|reset|failed to do request/i.test(decoded)
          // Timeout class (export IP slow/restricted/Tunnel hung): Rebuild TLS same IP Useless, change proxy session switch outlet IP
          if (this.isTimeoutResponse(status, decoded) && !sessionRefreshed && this.canRefreshProxySession()) {
            this.log(`[Net] ${method} time out(status=${status}),Change proxy session switch outlet IP Try again ${attempt}/${maxAttempts - 1}`)
            try {
              await this.refreshProxySession()
              await this.rebuildTlsClient()
              sessionRefreshed = true
            } catch (e) {
              this.log(`[Net] Change session Failure, fallback to normal reconstruction: ${e instanceof Error ? e.message : String(e)}`)
              await this.rebuildTlsClient()
            }
          } else {
            this.log(`[Net] ${method} instantaneous failure status=${status}，${broken ? 'reconstruction TLS + ' : ''}Back off and retry ${attempt}/${maxAttempts - 1}`)
            if (broken) await this.rebuildTlsClient()
          }
          await this.abortableSleep(this.netBackoffMs(attempt))
          continue
        }
        return { body: decoded, status, headers: (resp.headers || {}) as Record<string, string | string[]> }
      } catch (err: unknown) {
        lastErr = err
        if (attempt < maxAttempts && this.isRecoverableTlsClientError(err)) {
          this.log(`[TLS] ${method} Recoverable errors:${err instanceof Error ? err.message : String(err)},reconstruction TLS Back off and retry ${attempt}/${maxAttempts - 1}`)
          await this.rebuildTlsClient()
          await this.abortableSleep(this.netBackoffMs(attempt))
          continue
        }
        throw err
      }
    }
    if (lastErr) throw lastErr
    throw new Error(`${method} ${url} Try again ${maxAttempts} Still failed`)
  }

  /** Interruptible by abort sleep: Stop waiting immediately when registration is stopped, let abort Effective immediately */
  private abortableSleep(ms: number): Promise<void> {
    const signal = this.abortController.signal
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Registration canceled')); return }
      let timer: ReturnType<typeof setTimeout>
      const onAbort = (): void => { clearTimeout(timer); reject(new Error('Registration canceled')) }
      timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Anthropomorphic random delays: pauses between steps, reducing robotic rhythm characteristics */
  private async humanDelay(min = 800, max = 2500): Promise<void> {
    await this.abortableSleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
  }

  /**
   * Overall timeout watchdog: give arbitrary steps Promise Add upper limit, after timeout reject(Original Promise fend for themselves in the background).
   * Used in batch scenarios to quickly release stuck threads to avoid a single account occupying a concurrent slot. 1-5 minute. support abort Instant interruption.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    const signal = this.abortController.signal
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Registration canceled')); return }
      let done = false
      const settle = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        fn()
      }
      const timer = setTimeout(() => settle(() => reject(new Error(`${label} overall timeout ${Math.round(ms / 1000)}s`))), ms)
      const onAbort = (): void => settle(() => reject(new Error('Registration canceled')))
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e))
      )
    })
  }

  /**
   * Idempotent step retry: retreat and retry after failure (only used for pre-steps without side effects, such as OIDC / Device / Portal / WorkflowInit）。
   * - timeoutMs: Add an overall timeout watchdog for each attempt. When the timeout expires, it will be judged as failed and enter the next time (to prevent the card from being full in a single time). 3×25s）
   * - refreshSession: After failure, if the agent supports it, change proxy session switch outlet IP Retreat (avoid the slow/restricted IP）
   */
  private async retryStep(
    name: string,
    fn: StepFn,
    attempts: number,
    opts?: { timeoutMs?: number; refreshSession?: boolean }
  ): Promise<void> {
    let lastErr: unknown = null
    for (let i = 1; i <= attempts; i++) {
      try {
        if (opts?.timeoutMs) await this.withTimeout(fn(), opts.timeoutMs, name)
        else await fn()
        return
      } catch (err) {
        lastErr = err
        if (i < attempts) {
          // Idempotent step failed: if it supports changing session, switch the export first IP Back off again (for slow/Restricted residence IP）
          if (opts?.refreshSession && this.canRefreshProxySession()) {
            try {
              await this.refreshProxySession()
              await this.rebuildTlsClient()
              this.log(`[${name}] Already replaced proxy session switch outlet IP`)
            } catch { /* Change session If it fails, continue to retry normally. */ }
          }
          const wait = 1500 * i + Math.floor(Math.random() * 800)
          this.log(`[${name}] No. ${i}/${attempts} failed:${(err as Error).message}，${wait}ms Try again later`)
          await this.abortableSleep(wait)
        }
      }
    }
    throw lastErr
  }

  /**
   * tls-client returned body Is a byte transparent transmission string (latin1）；
   * If the response is actually UTF-8 Encoding (including Chinese and other multi-byte characters) requires secondary decoding.
   * Implementation: put string as latin1 Read the bytes back and use them again UTF-8 decoding;
   * If decoded it contains U+FFFD If there are many more replacement characters than the original text, the original value will be returned (indicating that it was originally latin1 / ASCII）。
   */
  private decodeBody(body: string | undefined | null): string {
    if (!body) return ''
    try {
      // Fast Path: Pure ASCII Return directly
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7F]*$/.test(body)) return body
      const buf = Buffer.from(body, 'latin1')
      const utf8 = buf.toString('utf-8')
      // Detection mojibake:Original text if in latin1 decoding UTF-8 Bytes, a large number of characters will appear in \u00a0-\u00ff interval
      // After reinterpreting, if the number of replacement characters is significantly more than the original text, it means that it is not UTF-8, return to the original value
      const replaceInOriginal = (body.match(/\uFFFD/g) || []).length
      const replaceInUtf8 = (utf8.match(/\uFFFD/g) || []).length
      if (replaceInUtf8 > replaceInOriginal + 2) return body
      return utf8
    } catch {
      return body
    }
  }

  private parseBody(body: string): Record<string, unknown> {
    try { return JSON.parse(body) } catch { return {} }
  }

  /**
   * identify AWS Error response triggered by risk control, returning a human-readable label
   * @returns Risk control type label (such as 'AWS-RISK-CONTROL'), not a risk control return null
   */
  private detectRiskControl(body: string, status: number): string | null {
    if (status !== 400) return null
    const lower = body.toLowerCase()
    // Chinese message (correctly decoded)
    if (body.includes('Please try again later') && body.includes('administrator')) return 'AWS-RISK-CONTROL'
    if (body.includes('An unexpected error occurred')) return 'AWS-RISK-CONTROL'
    // English message
    if (lower.includes('try again later') && lower.includes('administrator')) return 'AWS-RISK-CONTROL'
    if (lower.includes('unexpected error') && lower.includes('contact')) return 'AWS-RISK-CONTROL'
    return null
  }

  /** Format response errors into more friendly messages (including risk control identification) */
  private formatErrorBody(body: string, status: number): string {
    const risk = this.detectRiskControl(body, status)
    if (risk) {
      return `${risk}（AWS Risk control, suggestions:1) Enable proxy pool N:1 bucket;2) Enable speed limit + Risk control automatically pauses;3) Avoid mass registration of domain names with the same email address)`
    }
    return `status=${status} body=${body.substring(0, 200)}`
  }

  private async fetchD2CToken(origin: string, referer: string): Promise<void> {
    const headers: Record<string, string> = {
      'Accept': '*/*', 'Content-Type': 'application/json',
      'User-Agent': this.identity.ua, 'Origin': origin, 'Referer': referer,
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const parts: string[] = []
    if (this.cookies.has('awsccc')) parts.push('awsccc=' + this.cookies.get('awsccc'))
    if (this.cookies.has('awsd2c-token')) {
      const old = this.cookies.get('awsd2c-token')!
      parts.push('awsd2c-token=' + old, 'awsd2c-token-c=' + old)
    }
    if (parts.length) headers['Cookie'] = parts.join('; ')

    const payload: Record<string, string> = {}
    if (this.cookies.has('awsd2c-token')) payload.token = this.cookies.get('awsd2c-token')!

    const resp = await this.doPost('https://vs.aws.amazon.com/token', payload, headers)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const tok = data.token as string
    if (tok) {
      this.cookies.set('awsd2c-token', tok)
      this.cookies.set('awsd2c-token-c', tok)
      // from JWT extracted from visitor ID
      const jwtParts = tok.split('.')
      if (jwtParts.length >= 2) {
        try {
          const decoded = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString())
          if (decoded.vid) this.vid = decoded.vid
        } catch { /* ignore */ }
      }
    }
  }

  // ============ Fingerprint generation ============

  private genFP(pageType: string, eventType: string, emailLen: number, emailAddr: string): string {
    return this.genFPWithTime(pageType, eventType, 0, emailLen, emailAddr)
  }

  private genFPWithTime(pageType: string, eventType: string, timeOnPage: number, emailLen: number, emailAddr: string): string {
    const did = this.cfg.directoryId
    let loc = '', ref = ''

    switch (pageType) {
      case 'signin':
        loc = `${this.cfg.signinBase}/platform/${did}/login?workflowStateHandle=${this.workflowHandle}`
        break
      case 'signup':
        loc = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
        break
      default: // profile
        if (eventType === 'PageSubmit') {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/enter-email`
        } else {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/start`
        }
        if (!this.workflowId) loc = this.cfg.profileBase + '/'
    }

    if (pageType === 'profile') {
      ref = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
    } else {
      ref = this.cfg.viewBase + '/'
    }

    return generateFingerprint(this.identity, loc, ref, this.fpCtx, pageType, eventType, timeOnPage, emailLen, emailAddr)
  }

  // ============ Registration steps ============

  private async step1OIDC(): Promise<void> {
    this.emitStep('oidc')
    this.log('[1] OIDC register')
    const payload = {
      clientName: 'Amazon Q Developer for command line',
      clientType: 'public',
      scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations', 'codewhisperer:transformations', 'codewhisperer:taskassist']
    }
    const headers = { 'Content-Type': 'application/json' }

    let resp: { body: string; status: number; headers: Record<string, string | string[]> } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await this.doPost(this.cfg.oidcBase + '/client/register', payload, headers)
        if (resp.status === 200) break
      } catch (err: unknown) {
        if (attempt < 2) {
          this.log(`[1] OIDC Try again (${attempt + 1}/3)...`)
          await this.abortableSleep(2000 * (attempt + 1))
          await this.rebuildTlsClient()
          continue
        }
        throw err
      }
    }
    if (!resp) throw new Error('OIDC Registration failed: All retries failed')
    const data = this.parseBody(resp.body)
    this.clientId = (data.clientId as string) || ''
    this.clientSecret = (data.clientSecret as string) || ''
    if (!this.clientId) throw new Error(`OIDC Registration failed: ${resp.body.slice(0, 200)}`)
  }

  private async step2Device(): Promise<void> {
    this.emitStep('device')
    this.log('[2] Device authorization')
    const resp = await this.doPost(this.cfg.oidcBase + '/device_authorization', {
      clientId: this.clientId, clientSecret: this.clientSecret,
      startUrl: this.cfg.startURL
    }, { 'Content-Type': 'application/json' })
    const data = this.parseBody(resp.body)
    this.deviceCode = (data.deviceCode as string) || ''
    this.userCode = (data.userCode as string) || ''
    this.log(`user_code=${this.userCode}`)
  }

  private async step3Email(): Promise<void> {
    if (this.cfg.manualMode) return // Manual mode is set externally

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      this.log('[3] use Outlook Mail')
      const accounts = parseOutlookLines(this.cfg.outlookData)
      if (accounts.length === 0) throw new Error('None available Outlook account')
      // single line → Use it directly (when batch concurrency occurs, the front end has already set the task Cut a row to avoid concurrent preemption)
      // Multiple lines (single registration) → Pick a row at random
      const acc = accounts.length === 1
        ? accounts[0]
        : accounts[Math.floor(Math.random() * accounts.length)]
      this.email = acc.email
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useTempMailPlus) {
      this.log('[3] Use self-built domain name mailbox (TempMail.Plus)')
      if (!this.cfg.tempMailPlusEmail || !this.cfg.tempMailPlusEpin || !this.cfg.tempMailPlusDomain) {
        throw new Error('TempMail.Plus Incomplete configuration')
      }
      this.emailSvc = new TempMailPlusService(
        this.cfg.tempMailPlusEmail, this.cfg.tempMailPlusEpin, this.cfg.tempMailPlusDomain
      )
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('Failed to generate email address')
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useGptMail) {
      const mode = this.cfg.gptMailInboxEmail
        ? `CF Forward → ${this.cfg.gptMailInboxEmail}`
        : this.cfg.gptMailPrivatePassword ? 'Private domain name direct transfer (with password)' : 'Direct transfer of private domain names'
      this.log(`[3] use GPTmail (${mode}) → mail.chatgpt.org.uk`)
      if (!this.cfg.gptMailDomain) {
        throw new Error('GPTmail Domain name is not configured')
      }
      // Reuse the registration process that has been initialized TLS SessionClient(camouflage Chrome 146 JA3 + injection agent),
      // otherwise GPTmail Backend passes TLS Fingerprint verification will return 401 "Browser session required"
      if (!this.session) throw new Error('TLS SessionClient Not initialized, unable to start GPTmail(please check the agent)')
      this.emailSvc = new GptMailService({
        baseURL: this.cfg.gptMailBaseURL,
        inboxEmail: this.cfg.gptMailInboxEmail,
        domain: this.cfg.gptMailDomain,
        prefix: this.cfg.gptMailPrefix,
        privatePassword: this.cfg.gptMailPrivatePassword,
        // pass getter Instead of a snapshot:Registrar Follow-up rebuildTlsClient() Will change session instance,
        // GptMailService Read the latest reference here on every request to avoid using existing destroyed old session
        getSession: () => this.session
      })
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('generate GPTmail Failed to register email')
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    this.log('[3] Create temporary mailbox')
    if (!this.cfg.moEmailBaseURL) throw new Error('MoEmail Not configured')
    this.emailSvc = new MoEmailService(this.cfg.moEmailBaseURL, this.cfg.moEmailAPIKey)
    this.email = await this.emailSvc.create()
    if (!this.email) throw new Error('Failed to create temporary mailbox')
    this.emitStep('email-created')
    this.log(`email=${this.email}`)
  }

  private async step4Portal(): Promise<void> {
    this.emitStep('portal')
    this.log('[4] Portal initialization')
    this.cookies.set('awsccc', awsccc())
    const redirect = `${this.cfg.viewBase}/start/#/device?user_code=${this.userCode}`
    const url = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirect}`

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'User-Agent': this.identity.ua
    }
    const resp = await this.doGet(url, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)

    const rurl = (data.redirectUrl as string) || ''
    if (rurl.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)
    if (!this.workflowHandle) throw new Error('Portal Not returned workflow handle')

    const loginURL = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    await this.fetchD2CToken(this.cfg.signinBase, loginURL)
  }

  private async step5WorkflowInit(): Promise<void> {
    this.emitStep('workflow-init')
    this.log('[5] Workflow initialization')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signin', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: this.workflowHandle,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
      if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    }
  }

  private async step6SubmitEmail(): Promise<'signup' | 'login'> {
    this.emitStep('submit-email')
    this.log(`[6] Submit email ${this.email}`)
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signin', 'PageSubmit', this.email.length, this.email)
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SUBMIT',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'ApplicationTypeRequestInput', applicationType: 'SSO_INDIVIDUAL_ID' },
        {
          input_type: 'UserEventRequestInput', directoryId: this.cfg.directoryId,
          userName: this.email,
          userEvents: [{ input_type: 'UserEvent', eventType: 'PAGE_SUBMIT', pageName: 'IDENTIFICATION', timeSpentOnPage: 5000 }]
        },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (resp.status === 400) return 'signup'
    if (resp.status === 200) return 'login'
    throw new Error(`Failed to submit email: ${resp.status} - ${resp.body.slice(0, 200)}`)
  }

  private async step7Signup(): Promise<void> {
    this.emitStep('signup')
    this.log('[7] register (SIGNUP)')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signup', 'PageSubmit', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SIGNUP',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
  }

  private async step7_5SignupInit(): Promise<void> {
    this.log('[7.5] Signup API initialization')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signup', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    if (data.stepId !== 'start') throw new Error(`Signup init fail: ${this.formatErrorBody(resp.body, resp.status)}`)

    fp = this.genFP('signup', 'PageLoad', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'start', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowID=')) {
      let wid = splitAfter(rurl, 'workflowID=')
      const hashIdx = wid.indexOf('#')
      if (hashIdx >= 0) wid = wid.slice(0, hashIdx)
      this.workflowId = wid
    }
    if (!this.workflowId) throw new Error('Signup init Not returned workflowID')
  }

  private async step7_8ProfileInit(): Promise<void> {
    this.log('[7.8] Profile Page initialization')
    this.ubid = ubidGen()
    this.cookies.set('aws-user-profile-ubid', this.ubid)
    this.cookies.set('i18next', 'zh-CN')
    if (!this.cookies.has('awsccc')) this.cookies.set('awsccc', awsccc())

    const url = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const resp = await this.doGet(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': this.identity.ua,
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate'
    })
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    resetPerfTiming(this.fpCtx)
    await this.fetchD2CToken(this.cfg.profileBase, url)
  }

  private async step8ProfileStart(): Promise<void> {
    this.log('[8] Profile start up')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'PageLoad', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/start', {
      workflowID: this.workflowId,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: '38', eventType: 'PageLoad',
          ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.workflowState = (data.workflowState as string) || ''
    if (!this.workflowState) throw new Error(`Profile start Not returned workflowState: ${resp.body.slice(0, 200)}`)
  }

  private async step9SendOTP(): Promise<void> {
    this.emitStep('send-otp')
    this.log('[9] Send verification code')

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (acc) {
        try {
          this.outlookMailCount = await getInboxCount(acc)
          this.log(`Number of emails before sending: ${this.outlookMailCount}`)
        } catch (err) {
          this.log(`Failed to get the number of emails: ${err}, Default is0`)
        }
      }
    }

    // Human-like delay: users spend 8-20 seconds reading the email form before submitting
    // CRITICAL: Must actually wait this time, not just claim it in fingerprint
    const timeOnPage = 8000 + Math.floor(Math.random() * 12001) // 8-20 seconds
    this.log(`[9] Simulating human behavior: waiting ${Math.round(timeOnPage / 1000)}s before submitting email...`)
    await this.abortableSleep(timeOnPage)

    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFPWithTime('profile', 'PageSubmit', timeOnPage, this.email.length, this.email)
    const tsp = String(timeOnPage)

    const payload = {
      workflowState: this.workflowState,
      email: this.email,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: tsp, pageName: 'EMAIL_COLLECTION',
          eventType: 'PageSubmit', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }

    const resp = await this.doPost(this.cfg.profileBase + '/api/send-otp', payload, this.buildProfileHeaders(ref))
    if (resp.status !== 200) throw new Error(`send-otp fail (${resp.status}), body: ${resp.body.substring(0, 300)}`)
    this.log('Verification code sent')
  }

  private async step10GetOTP(): Promise<string> {
    if (this.cfg.manualMode) throw new Error('Manual mode requires external verification code')

    this.emitStep('waiting-otp')
    this.log('[10] Wait for verification code')
    const signal = this.abortController.signal
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (!acc) throw new Error('No correspondence found Outlook account')
      return await waitForOTP(acc, this.outlookMailCount, 120, 5, signal)
    }
    if (!this.emailSvc) throw new Error('Mailbox service not initialized')
    return await this.emailSvc.waitForCode(120, 3, signal)
  }

  private async step11CreateIdentity(otp: string): Promise<void> {
    this.emitStep('otp-received')
    this.emitStep('create-identity')
    this.log('[11] Create an identity')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'EmailVerification', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/create-identity', {
      workflowState: this.workflowState,
      userData: { email: this.email, fullName: this.cfg.fullName },
      otpCode: otp,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: '45000', pageName: 'EMAIL_VERIFICATION',
          eventType: 'EmailVerification', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.regCode = (data.registrationCode as string) || ''
    this.signState = (data.signInState as string) || ''
    if (!this.regCode) throw new Error(`create-identity Not returned registrationCode: ${resp.body.slice(0, 200)}`)
  }

  private async step12SetPassword(): Promise<void> {
    this.emitStep('set-password')
    this.log('[12] Set password')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?registrationCode=${this.regCode}&state=${this.signState}`
    let fp = this.genFP('signup', 'PageSubmit', 0, '')

    // 12a: Get the encryption public key
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', state: this.signState,
      inputs: [
        { input_type: 'UserRegistrationRequestInput', registrationCode: this.regCode, state: this.signState },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    this.workflowHandle = (data.workflowStateHandle as string) || ''

    const encCtx = getNestedMap(data as Record<string, unknown>, 'workflowResponseData', 'encryptionContextResponse')
    const pubKeyMap = encCtx ? getNestedStringMap(encCtx, 'publicKey') : null
    if (!pubKeyMap?.n) throw new Error(`The encryption public key was not obtained: ${this.formatErrorBody(resp.body, resp.status)}`)

    const issuer = (encCtx?.issuer as string) || 'signin'
    const audience = (encCtx?.audience as string) || 'AWSPasswordService'
    const region = (encCtx?.region as string) || 'us-east-1'

    const encrypted = encryptPassword(this.cfg.password, pubKeyMap, issuer, audience, region)

    // 12b: Submit password
    fp = this.genFP('signup', 'PageSubmit', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'get-new-password-for-password-creation',
      workflowStateHandle: this.workflowHandle, actionId: 'SUBMIT',
      inputs: [
        { input_type: 'PasswordRequestInput', password: encrypted, successfullyEncrypted: 'SUCCESSFUL' },
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (!rurl) throw new Error(`Password setting not returned redirect: ${resp.body.slice(0, 200)}`)

    const wh = extractParam(rurl, 'workflowStateHandle')
    const st = extractParam(rurl, 'state')
    const rh = extractParam(rurl, 'workflowResultHandle')
    await this.completeSignup(wh, st, rh)
  }

  private async completeSignup(wh: string, state: string, rh: string): Promise<void> {
    this.log('[12.5] Complete the registration workflow')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}&state=${state}&workflowResultHandle=${rh}`
    const fp = this.genFP('signin', 'PageLoad', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      workflowResultHandle: rh, state,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.stepId !== 'end-of-workflow-success') throw new Error(`Failed to complete workflow: ${data.stepId || 'undefined'} ${this.formatErrorBody(resp.body, resp.status)}`)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl) {
      this.authCode = extractParam(rurl, 'workflowResultHandle')
      this.ssoState = extractParam(rurl, 'state')
      this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
    }
  }

  // ============ SSO Authorize (Step12.8-13) ============

  private async step12_8SSOWorkflow(): Promise<void> {
    this.emitStep('sso-workflow')
    this.log('[12.8] SSO Workflow')
    const redirectURL = encodeURIComponent(this.cfg.viewBase + '/start/#/')
    const loginURL = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirectURL}`

    const h: Record<string, string> = {
      'Accept': '*/*', 'User-Agent': this.identity.ua,
      'Origin': this.cfg.viewBase, 'Referer': this.cfg.viewBase + '/',
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    if (this.cookies.has('awsccc')) h['Cookie'] = 'awsccc=' + this.cookies.get('awsccc')

    const resp = await this.doGet(loginURL, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)

    const rurl = (data.redirectUrl as string) || ''
    let wh = ''
    if (rurl.includes('workflowStateHandle=')) {
      wh = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (!wh) throw new Error('SSO Unable to obtain workflowStateHandle')

    await this.completeSSOWorkflow(wh)
  }

  private async completeSSOWorkflow(wh: string): Promise<void> {
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}`
    let fp = this.genFP('signin', 'PageLoad', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    let newWH = (data.workflowStateHandle as string) || wh

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: newWH,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
    }

    if (data.stepId === 'end-of-workflow-success') {
      const redir = data.redirect as Record<string, unknown> | undefined
      const rurl = redir?.url as string
      if (rurl) {
        this.authCode = extractParam(rurl, 'workflowResultHandle')
        this.ssoState = extractParam(rurl, 'state')
        this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
      }
    }

    // access start page
    const params = new URLSearchParams()
    if (this.ssoState) params.set('state', this.ssoState)
    params.set('workflowResultHandle', this.authCode)
    if (this.wdcCSRFToken) params.set('wdc_csrf_token', this.wdcCSRFToken)
    const startURL = this.cfg.viewBase + '/start/?' + params.toString()

    const cookieParts: string[] = []
    if (this.cookies.has('loginCsrfToken')) cookieParts.push('loginCsrfToken=' + this.cookies.get('loginCsrfToken'))
    if (this.cookies.has('awsccc')) cookieParts.push('awsccc=' + this.cookies.get('awsccc'))

    await this.doGet(startURL, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': this.identity.ua,
      'Referer': this.cfg.signinBase + '/',
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
      ...(cookieParts.length ? { Cookie: cookieParts.join('; ') } : {})
    })
  }

  private async step13SSOToken(): Promise<Record<string, unknown>> {
    this.emitStep('sso-token')
    this.log('[13] get SSO Token')
    const csrf = this.cookies.get('loginCsrfToken')
    if (!csrf) throw new Error('Lack loginCsrfToken')

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.identity.ua, 'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'x-amz-sso-csrf-token': csrf,
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const formData = `authCode=${encodeURIComponent(this.authCode)}&state=${encodeURIComponent(this.ssoState)}&orgId=view`

    // Polling with new client SSO Token
    const ssoSession = new SessionClient(this.moduleClient!, this.sessionOpts)

    try {
      for (let retry = 0; retry < 5; retry++) {
        const resp = await ssoSession.post(this.cfg.portalBase + '/auth/sso-token', formData, { headers: h })
        const data = JSON.parse(resp.body || '{}')

        if (data.token) {
          this.ssoToken = data.token
          break
        }
        const errMsg = (data.errorMessage || '') as string
        if (errMsg.toLowerCase().includes('not authorized')) {
          await this.abortableSleep(3000)
          continue
        }
        throw new Error(`SSO Token fail: ${resp.body?.slice(0, 200)}`)
      }
    } finally {
      try { await ssoSession.destroySession() } catch { /* ignore */ }
    }

    if (!this.ssoToken) throw new Error('SSO Token Try again 5 Still failed')

    // Accept device + Associate token
    let resp = await this.doPost(this.cfg.oidcBase + '/device_authorization/accept_user_code', {
      userCode: this.userCode, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })
    const dcData = this.parseBody(resp.body)
    const dc = dcData.deviceContext

    await this.doPost(this.cfg.oidcBase + '/device_authorization/associate_token', {
      deviceContext: dc, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })

    // polling token
    for (let i = 0; i < 120; i++) {
      resp = await this.doPost(this.cfg.oidcBase + '/token', {
        clientId: this.clientId, clientSecret: this.clientSecret,
        deviceCode: this.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code'
      }, { 'Content-Type': 'application/json' })

      if (resp.status === 200) return this.parseBody(resp.body)
      await this.abortableSleep(3000)
    }
    throw new Error('Token Poll timeout (Wait timeout)')
  }

  // ============ Live test ============

  private async verifyAlive(awsToken: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.log('[Live test] refresh Token + Check dosage')
    const refreshToken = (awsToken.refreshToken as string) || ''

    const resp = await this.doPost('https://oidc.us-east-1.amazonaws.com/token', {
      clientId: this.clientId, clientSecret: this.clientSecret,
      refreshToken, grantType: 'refresh_token'
    }, { 'Content-Type': 'application/json' })

    if (resp.status !== 200) {
      this.log(`Token Refresh failed: ${resp.status}`)
      return { alive: false, error: `refresh failed: ${resp.status}` }
    }

    const tok = this.parseBody(resp.body)
    const access = (tok.accessToken as string) || ''

    const usageUA = 'aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E KiroIDE-0.6.18'

    for (const baseURL of ['https://q.us-east-1.amazonaws.com/getUsageLimits', 'https://q.eu-central-1.amazonaws.com/getUsageLimits']) {
      const usageURL = baseURL + '?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true'
      const usageResp = await this.doGet(usageURL, {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + access,
        'User-Agent': usageUA
      })

      if (usageResp.status === 403 && usageResp.body.toLowerCase().includes('suspended')) {
        return { alive: false, suspended: true, error: 'suspended' }
      }
      if (usageResp.status === 200) {
        return this.parseUsage(usageResp.body)
      }
    }
    return { alive: false, error: 'usage query failed' }
  }

  private parseUsage(body: string): Record<string, unknown> {
    const usage = this.parseBody(body)
    const userInfo = (usage.userInfo as Record<string, unknown>) || {}
    const emailAddr = (userInfo.email as string) || ''
    const subInfo = (usage.subscriptionInfo as Record<string, unknown>) || {}
    let sub = (subInfo.subscriptionTitle as string) || 'Free'

    let totalLimit = 0, totalUsed = 0
    const breakdown = usage.usageBreakdownList as Array<Record<string, unknown>> | undefined
    if (breakdown) {
      for (const item of breakdown) {
        const rt = item.resourceType as string
        const dn = item.displayName as string
        if (rt === 'CREDIT' || dn === 'Credits') {
          totalLimit = (item.usageLimitWithPrecision as number) || (item.usageLimit as number) || 0
          totalUsed = (item.currentUsageWithPrecision as number) || (item.currentUsage as number) || 0

          const ft = item.freeTrialInfo as Record<string, unknown> | undefined
          if (ft?.freeTrialStatus === 'ACTIVE') {
            totalLimit += (ft.usageLimitWithPrecision as number) || 0
            totalUsed += (ft.currentUsageWithPrecision as number) || 0
          }
          break
        }
      }
    }

    this.log(`Live test successful! Mail=${emailAddr} subscription=${sub} Credit=${totalUsed}/${totalLimit}`)
    return { alive: true, email: emailAddr, subscription: sub, credit_used: totalUsed, credit_limit: totalLimit }
  }

  // ============ Main process ============

  /** Perform full registration process (automatic mode) */
  async run(): Promise<RegistrationResult> {
    this.emitStep('init')
    try {
      await this.setupProxyChain()
      if (this.chainRelay) this.emitStep('proxy-chain-ready')
      await this.initTlsClient()
      this.emitStep('tls-ready')
      await this.detectExitIP()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      // Idempotent read-only steps:retry frequency + Overall timeout watchdog + Failed to change the exit IP。
      // OIDC Keep it for the first step (if it fails, the account will be discarded) 3 Retries do not time out quickly;Email Create side effects are not retried.
      const initSteps: Array<{ name: string; fn: StepFn; retry?: number; timeoutMs?: number; refreshSession?: boolean }> = [
        { name: 'OIDC', fn: () => this.step1OIDC() },
        { name: 'Device', fn: () => this.step2Device(), retry: 2, timeoutMs: 30000, refreshSession: true },
        { name: 'Email', fn: () => this.step3Email() },
        { name: 'Portal', fn: () => this.step4Portal(), retry: 3, timeoutMs: 35000, refreshSession: true },
        { name: 'WorkflowInit', fn: () => this.step5WorkflowInit(), retry: 2, timeoutMs: 35000, refreshSession: true }
      ]
      for (const s of initSteps) {
        this.checkAborted()
        try {
          if (s.retry) await this.retryStep(s.name, s.fn, s.retry, { timeoutMs: s.timeoutMs, refreshSession: s.refreshSession })
          else await s.fn()
        } catch (err) {
          return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
        }
        await this.humanDelay()
      }

      this.checkAborted()
      // Non-idempotent steps uniformly add an overall timeout watchdog (default 55s): Quickly fail to release the concurrency slot when stuck, and do not die, etc. 3×25s
      const STEP_TIMEOUT = 55000
      const emailStatus = await this.withTimeout(this.step6SubmitEmail(), STEP_TIMEOUT, 'SubmitEmail')

      if (emailStatus === 'signup') {
        const signupSteps: Array<{ name: string; fn: StepFn }> = [
          { name: 'Signup', fn: () => this.step7Signup() },
          { name: 'SignupInit', fn: () => this.step7_5SignupInit() },
          { name: 'ProfileInit', fn: () => this.step7_8ProfileInit() },
          { name: 'ProfileStart', fn: () => this.step8ProfileStart() },
          { name: 'SendOTP', fn: () => this.step9SendOTP() }
        ]
        for (const s of signupSteps) {
          this.checkAborted()
          try { await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name) } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
          await this.humanDelay()
        }

        this.checkAborted()
        let otp: string
        try { otp = await this.step10GetOTP() } catch (err) {
          return { status: 'failed', email: this.email, error: `[GetOTP] ${(err as Error).message}` }
        }

        for (const s of [
          { name: 'CreateIdentity', fn: () => this.step11CreateIdentity(otp) },
          { name: 'SetPassword', fn: () => this.step12SetPassword() }
        ] as Array<{ name: string; fn: StepFn }>) {
          this.checkAborted()
          try { await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name) } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
          await this.humanDelay()
        }
      } else {
        return { status: 'failed', email: this.email, error: 'This email address has already been registered' }
      }

      // ====== Later steps (SSO + Token）======
      // The account has been created here (Step 11-12 Success), and then just get the login credentials.
      // If it fails due to network fluctuations, on the same Registrar Retry within (reuse existing registration status),
      // Avoid wasting a completed registration process by having the outer layer start over from scratch.
      this.checkAborted()
      let awsToken: Record<string, unknown> | null = null
      const SSO_MAX_RETRIES = 2
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          // SSO Contains token Polling, single attempt plus overall timeout (cut off and enter the next retry when stuck)
          await this.withTimeout(this.step12_8SSOWorkflow(), 60000, 'SSOWorkflow')
          await this.abortableSleep(2000)
          this.checkAborted()
          awsToken = await this.withTimeout(this.step13SSOToken(), 90000, 'SSOToken')
          break // SSO success
        } catch (err) {
          const errMsg = (err as Error).message
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(`[SSO] Post step failed, internal retry (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`)
            await this.abortableSleep(3000 + Math.floor(Math.random() * 2000))
          } else {
            // Final failure: The account has been created but cannot be obtained Token
            return { status: 'failed', email: this.email, error: `[SSOToken] ${errMsg} (The account has been created and can be manually imported and refreshed.)` }
          }
        }
      }

      const token = awsToken!
      this.emitStep('verify-alive')
      const verify = await this.withTimeout(this.verifyAlive(token), 60000, 'VerifyAlive')
      if (verify.suspended) {
        return { status: 'failed', email: this.email, error: 'suspended' }
      }

      this.emitStep('done')
      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (token.refreshToken as string) || '',
        accessToken: (token.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId',
        verify,
        fingerprint: this.fingerprintSnapshot()
      }
    } finally {
      await this.cleanup()
    }
  }

  /**
   * Returns the actual effective agent for this registration URL(according to sessionOpts Same priority parsing),
   * Used to accurately display in the fingerprint summary whether it is directly connected or through a proxy.
   */
  private resolvedProxyUrl(): string | undefined {
    // When proxy chaining is enabled cfg.proxy is the local relay address, auditing should show the real destination proxy
    return (this.chainTargetProxy && this.chainTargetProxy.trim())
      || (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
  }

  /** Output the fingerprint summary used for this registration (for auditing and subsequent reuse) */
  private fingerprintSnapshot(): FingerprintSnapshot {
    const resolved = this.resolvedProxyUrl()
    return {
      chromeVer: this.identity.chromeVer,
      ua: this.identity.ua,
      gpuVendor: this.identity.gpuVendor,
      gpuModel: this.identity.gpuModel,
      canvasHash: this.identity.canvasHash,
      screen: { width: this.identity.screen.width, height: this.identity.screen.height },
      // Desensitize and save (hide the password part) while ensuring that the system/Environment variable proxies are also captured
      proxyUrl: resolved ? resolved.replace(/:([^:@/]+)@/, ':***@') : undefined,
      exitIP: this.exitIP || undefined
    }
  }

  /** Manual mode registration - Step1-2 automatic,Step3 Waiting for the external mailbox to be set up,Step4-9 automatic,Step10 Wait for external OTP */
  async runManualPhase1(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.setupProxyChain()
      await this.initTlsClient()
      await this.detectExitIP()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      await this.step1OIDC()
      await this.withTimeout(this.step2Device(), 30000, 'Device')
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** manual mode - After setting up your email address, continue the registration process to send OTP */
  async runManualPhase2(email: string, fullName?: string): Promise<{ success: boolean; error?: string }> {
    this.email = email
    if (fullName) this.cfg.fullName = fullName

    try {
      // Idempotent read-only steps:retry + timeout watchdog + Failed to change the exit IP;Subsequent non-idempotent steps only add timeout and fail quickly.
      const STEP_TIMEOUT = 55000
      await this.retryStep('Portal', () => this.step4Portal(), 3, { timeoutMs: 35000, refreshSession: true })
      await this.retryStep('WorkflowInit', () => this.step5WorkflowInit(), 2, { timeoutMs: 35000, refreshSession: true })

      const status = await this.withTimeout(this.step6SubmitEmail(), STEP_TIMEOUT, 'SubmitEmail')
      if (status !== 'signup') return { success: false, error: 'This email address has already been registered' }

      await this.withTimeout(this.step7Signup(), STEP_TIMEOUT, 'Signup')
      await this.withTimeout(this.step7_5SignupInit(), STEP_TIMEOUT, 'SignupInit')
      await this.withTimeout(this.step7_8ProfileInit(), STEP_TIMEOUT, 'ProfileInit')
      await this.withTimeout(this.step8ProfileStart(), STEP_TIMEOUT, 'ProfileStart')
      await this.withTimeout(this.step9SendOTP(), STEP_TIMEOUT, 'SendOTP')
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** manual mode - enter OTP Complete registration after */
  async runManualPhase3(otp: string): Promise<RegistrationResult> {
    try {
      // Non-idempotent steps plus an overall timeout watchdog to fail quickly when stuck
      await this.withTimeout(this.step11CreateIdentity(otp), 55000, 'CreateIdentity')
      await this.withTimeout(this.step12SetPassword(), 55000, 'SetPassword')

      // SSO + Token: The account has been created, and it will be on the same page when the network fluctuates. Registrar Retry (reuse existing registration status) to avoid wasting completed registration
      let awsToken: Record<string, unknown> | null = null
      const SSO_MAX_RETRIES = 2
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          await this.withTimeout(this.step12_8SSOWorkflow(), 60000, 'SSOWorkflow')
          await this.abortableSleep(2000)
          this.checkAborted()
          awsToken = await this.withTimeout(this.step13SSOToken(), 90000, 'SSOToken')
          break
        } catch (err) {
          const errMsg = (err as Error).message
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(`[SSO] Post step failed, internal retry (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`)
            await this.abortableSleep(3000 + Math.floor(Math.random() * 2000))
          } else {
            return { status: 'failed', email: this.email, error: `[SSOToken] ${errMsg} (The account has been created and can be manually imported and refreshed.)` }
          }
        }
      }

      const token = awsToken!
      const verify = await this.withTimeout(this.verifyAlive(token), 60000, 'VerifyAlive')
      if (verify.suspended) {
        return { status: 'failed', email: this.email, error: 'suspended' }
      }

      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (token.refreshToken as string) || '',
        accessToken: (token.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId',
        verify,
        fingerprint: this.fingerprintSnapshot()
      }
    } catch (err) {
      return { status: 'failed', email: this.email, error: (err as Error).message }
    } finally {
      await this.cleanup()
    }
  }
}
