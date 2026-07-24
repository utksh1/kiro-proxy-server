import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as machineIdModule from './machineId'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { encode, decode } from 'cbor-x'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Dispatcher } from 'undici'
import icon from '../../resources/icon.png?asset'
import { ProxyServer, configureProxyClients, type ProxyAccount, type ProxyConfig, type ProxyClientTarget, type ProxyClientModel } from './proxy'
import { 
  initKProxyService, 
  getKProxyService, 
  generateDeviceId, 
  isValidDeviceId,
  type KProxyConfig,
  type DeviceIdMapping
} from './kproxy'
import { fetchKiroModels, fetchSubscriptionToken, fetchAvailableSubscriptions, setUserPreference, setUseKProxyForApiInProxy, setLogStreamEvents, setPayloadSizeLimitKB, setTokenBufferReserve, setEnableTokenBufferReserve, callKiroApi, fetchEnterpriseProfileArn, setProfileArnPersistCallback, setAgentMode } from './proxy/kiroApi'
import {
  writeKiroAuthTokenFile,
  readKiroAuthTokenFile,
  parseAccessTokenClaims,
  watchKiroAuthTokenFile,
  resolveProfileArnForWrite,
  KIRO_AUTH_TOKEN_PATH
} from './kiroAuthSync'
import { openaiToKiro } from './proxy/translator'
import { getSystemProxy, safeCreateProxyAgent } from './proxy/systemProxy'
import { proxyLogStore, interceptConsole } from './proxy/logger'
import { registerProxyPoolIpcHandlers } from './ipc/proxyPool'
import {
  createTray,
  destroyTray,
  updateTrayMenu,
  updateCurrentAccount,
  updateAccountList,
  setTrayTooltip,
  updateTrayLanguage,
  type TraySettings,
  defaultTraySettings
} from './tray'

// ============ Automatically update configuration ============
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function setupAutoUpdater(): void {
  // Error checking for updates
  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error)
    mainWindow?.webContents.send('update-error', error.message)
  })

  // Checking for updates
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    mainWindow?.webContents.send('update-checking')
  })

  // Updates available
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // No updates available
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available, current:', info.version)
    mainWindow?.webContents.send('update-not-available', { version: info.version })
  })

  // Download progress
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  // Download completed
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })
}

// ============ Kiro API call ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API Endpoint configuration - official Kiro The plugin only supports us-east-1 and eu-central-1
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// according to SSO area mapped to the nearest REST API endpoint
function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  // If it is a supported endpoint area, use it directly
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  // EU area mapped to eu-central-1
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  // Default for other areas us-east-1
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// Get backup REST API endpoint (for fallback）
function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  // Return another endpoint as fallback
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

// API Type configuration
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // Used by default REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// Whether to use K-Proxy Send as agent API ask
let useKProxyForApi: boolean = false

export function setUseKProxyForApi(enabled: boolean): void {
  useKProxyForApi = enabled
  // Sync settings to kiroApi.ts
  setUseKProxyForApiInProxy(enabled)
  console.log(`[API] Use K-Proxy for API requests: ${enabled}`)
}

export function getUseKProxyForApi(): boolean {
  return useKProxyForApi
}

// Get network proxy agent(priority K-Proxy, secondly the user sets the proxy, then the system proxy)
function getNetworkAgent(): Dispatcher | undefined {
  if (useKProxyForApi) {
    const kproxyService = getKProxyService()
    if (kproxyService?.isRunning()) {
      const config = kproxyService.getConfig()
      const proxyUrl = `http://${config.host}:${config.port}`
      const agent = safeCreateProxyAgent(proxyUrl)
      if (agent) return agent
    }
  }
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const envAgent = safeCreateProxyAgent(envProxy)
  if (envAgent) return envAgent
  return safeCreateProxyAgent(getSystemProxy())
}

/**
 * Universal fetch function
 * @param url ask URL
 * @param options fetch Options
 * @param overrideProxyUrl Optional: Agent bound to the account URL(Highest priority, covering global proxy logic)
 *
 * Priority:overrideProxyUrl > K-Proxy > User settings proxy > system agent > direct connection
 */
async function fetchWithAppProxy(
  url: string,
  options: RequestInit,
  overrideProxyUrl?: string
): Promise<Response> {
  // Prioritize trying to bind the account to the agent
  if (overrideProxyUrl) {
    const accountAgent = safeCreateProxyAgent(overrideProxyUrl)
    if (accountAgent) {
      return await undiciFetch(url, { ...options, dispatcher: accountAgent } as UndiciRequestInit) as unknown as Response
    }
  }
  const agent = getNetworkAgent()
  if (agent) {
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// Compatibility function, pointing to getNetworkAgent
function getKProxyAgent(): Dispatcher | undefined {
  return getNetworkAgent()
}

// ============ OIDC Token refresh ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

// social login (GitHub/Google) of Token refresh endpoint
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ proxy settings ============

/**
 * normalized proxy URL,make sure protocol://host:port Format.
 * Error-tolerant handling of common format errors by users:
 *   http:127.0.0.1:7890     → http://127.0.0.1:7890   (lack //)
 *   http:/127.0.0.1:7890    → http://127.0.0.1:7890   (one /)
 *   127.0.0.1:7890          → http://127.0.0.1:7890   (none protocol)
 *   http://127.0.0.1:7890   → http://127.0.0.1:7890   (Standardized)
 */
export function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  // Already the standard protocol:// prefix
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  // have protocol: But missing/few //
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  // none protocol,default http
  return `http://${trimmed}`
}

// Set proxy environment variables
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    const normalized = normalizeProxyUrl(url)
    process.env.HTTP_PROXY = normalized
    process.env.HTTPS_PROXY = normalized
    process.env.http_proxy = normalized
    process.env.https_proxy = normalized
    if (normalized !== url) {
      console.log(`[Proxy] Enabled: ${normalized} (Normalized from: ${url})`)
    } else {
      console.log(`[Proxy] Enabled: ${normalized}`)
    }
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// ============ Anti-shake store write (reduce disk I/O） ============
const pendingStoreWrites: Map<string, unknown> = new Map()
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null
const STORE_FLUSH_INTERVAL = 5000 // 5 Write in batches once per second

function debouncedStoreSet(key: string, value: unknown): void {
  pendingStoreWrites.set(key, value)
  if (!storeFlushTimer) {
    storeFlushTimer = setTimeout(flushStoreWrites, STORE_FLUSH_INTERVAL)
  }
}

function flushStoreWrites(): void {
  storeFlushTimer = null
  if (!store || pendingStoreWrites.size === 0) return
  for (const [key, value] of pendingStoreWrites) {
    store.set(key, value)
  }
  pendingStoreWrites.clear()
}

let trayMenuTimer: ReturnType<typeof setTimeout> | null = null

function debouncedUpdateTrayMenu(): void {
  if (trayMenuTimer) return
  trayMenuTimer = setTimeout(() => {
    trayMenuTimer = null
    updateTrayMenu()
  }, 3000)
}

// ============ Kiro API Anti-generation server ============
let proxyServer: ProxyServer | null = null

function initProxyServer(): ProxyServer {
  if (proxyServer) return proxyServer

  // Make sure the log storage is initialized (app.whenReady has been called, here is the bottom line)
  proxyLogStore.initialize(app.getPath('userData'))

  // from store Load the saved configuration, or use the default configuration if not available
  const savedConfig = store?.get('proxyConfig') as Partial<ProxyConfig> | undefined
  // from store load saved Usage API type
  const savedUsageApiType = store?.get('usageApiType') as 'rest' | 'cbor' | undefined
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType)
  }
  // from store load saved K-Proxy proxy settings
  const savedUseKProxyForApi = store?.get('useKProxyForApi') as boolean | undefined
  if (savedUseKProxyForApi !== undefined) {
    setUseKProxyForApi(savedUseKProxyForApi)
  }
  // from store Load saved totals credits and tokens
  const savedTotalCredits = (store?.get('proxyTotalCredits') as number) || 0
  const savedInputTokens = (store?.get('proxyInputTokens') as number) || 0
  const savedOutputTokens = (store?.get('proxyOutputTokens') as number) || 0
  // from store Load saved request statistics
  const savedTotalRequests = (store?.get('proxyTotalRequests') as number) || 0
  const savedSuccessRequests = (store?.get('proxySuccessRequests') as number) || 0
  const savedFailedRequests = (store?.get('proxyFailedRequests') as number) || 0
  const defaultConfig: ProxyConfig = {
    enabled: false,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    maxRetries: 3,
    retryDelayMs: 1000,
    tokenRefreshBeforeExpiry: 300, // 5Refresh minutes in advance
    clientDrivenToolExecution: true,
    enableTokenBufferReserve: false,
    tokenBufferReserve: 20000
  }
  
  // Merge saved configuration with default configuration
  const config: ProxyConfig = savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig

  // recover payload size limit
  if (config.payloadSizeLimitKB) {
    setPayloadSizeLimitKB(config.payloadSizeLimitKB)
  }
  // recover Token buffer reserve(switch + numerical value)
  setEnableTokenBufferReserve(config.enableTokenBufferReserve === true)
  if (config.tokenBufferReserve) {
    setTokenBufferReserve(config.tokenBufferReserve)
  }
  // recover Agent model(vibe / spec）
  if (config.agentMode) {
    setAgentMode(config.agentMode)
  }

  proxyServer = new ProxyServer(
    config,
    {
      onRequest: (info) => {
        mainWindow?.webContents.send('proxy-request', info)
      },
      onResponse: (info) => {
        mainWindow?.webContents.send('proxy-response', info)
      },
      onError: (error) => {
        console.error('[ProxyServer] Error:', error)
        mainWindow?.webContents.send('proxy-error', error.message)
      },
      onStatusChange: (running, port) => {
        mainWindow?.webContents.send('proxy-status-change', { running, port })
      },
      // Token refresh callback - Reuse existing refresh logic, including account binding agent
      onTokenRefresh: async (account) => {
        try {
          console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}${account.proxyUrl ? ' [via bound proxy]' : ''}`)
          const refreshResult = await refreshTokenByMethod(
            account.refreshToken || '',
            account.clientId || '',
            account.clientSecret || '',
            account.region || 'us-east-1',
            account.authMethod,
            account.proxyUrl  // Agent bound to the account (if any)
          )

          if (refreshResult.success && refreshResult.accessToken) {
            return {
              success: true,
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresAt: Date.now() + (refreshResult.expiresIn || 3600) * 1000
            }
          }
          return { success: false, error: refreshResult.error || 'Token Refresh failed' }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
      },
      // Account update callback - Notify the rendering process to update account data
      onAccountUpdate: (account) => {
        mainWindow?.webContents.send('proxy-account-update', {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt
        })
      },
      // The account was Kiro Backend long-term ban - Notify rendering process flag lastError + persist to store
      // different from token Invalid and needs to be manually unblocked; the account pool has automatically skipped the account
      onAccountSuspended: (info) => {
        console.warn(`[ProxyServer] Account suspended: ${info.email || info.accountId} (${info.reason})`)
        // push IPC Events to the front end store
        mainWindow?.webContents.send('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
        // Persistent ban status: dependency renderer store take over IPC After passing saveToStorage Anti-shake drop plate,
        // The main process is only in lastSavedData Perform light updates on memory snapshots to avoid triggering encryption and decryption of the entire database every time a ban is issued IO。
        // This can fundamentally eliminate main process blocking in frequent ban scenarios (old code store.get + store.set Do it once each AES Full database encryption and decryption)
        if (lastSavedData && typeof lastSavedData === 'object') {
          try {
            const data = lastSavedData as { accounts?: Record<string, Record<string, unknown>> }
            if (data.accounts?.[info.accountId]) {
              data.accounts[info.accountId] = {
                ...data.accounts[info.accountId],
                status: 'error',
                lastError: `[${info.reason}] ${info.message}`,
                lastCheckedAt: Date.now()
              }
            }
          } catch (e) {
            console.error('[ProxyServer] Failed to update suspended state in memory:', e)
          }
        }
      },
      // Credits update callback - Use anti-shake persistence
      onCreditsUpdate: (totalCredits) => {
        debouncedStoreSet('proxyTotalCredits', totalCredits)
      },
      // Tokens update callback - Use anti-shake persistence
      onTokensUpdate: (inputTokens, outputTokens) => {
        debouncedStoreSet('proxyInputTokens', inputTokens)
        debouncedStoreSet('proxyOutputTokens', outputTokens)
      },
      // Request statistics update callback - Use anti-shake persistence
      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        debouncedStoreSet('proxyTotalRequests', totalRequests)
        debouncedStoreSet('proxySuccessRequests', successRequests)
        debouncedStoreSet('proxyFailedRequests', failedRequests)
        // Update tray menu (also anti-shake to avoid frequent menu rebuilding)
        debouncedUpdateTrayMenu()
      },
      // Lazy loading when the account pool is empty - from store Read account data and synchronize to pool
      onPoolEmpty: async () => {
        await initStore()
        if (!store) return
        const accountData = store.get('accountData') as {
          accounts?: Record<string, any>
          accountProxyBindings?: Record<string, string>
          proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
        } | undefined
        if (!accountData?.accounts) return

        // Build accountId → proxyUrl Mapping (used for anti-generation N:1 Bucketing)
        const bindings = accountData.accountProxyBindings || {}
        const proxyPool = accountData.proxyPool || {}
        const buildProxyUrl = (accountId: string): string | undefined => {
          const proxyId = bindings[accountId]
          if (!proxyId) return undefined
          const p = proxyPool[proxyId]
          if (!p || !p.enabled || p.status === 'dead') return undefined
          return p.url
        }

        const proxyAccounts = Object.values(accountData.accounts)
          .filter((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
          .map((acc: any) => ({
            id: acc.id,
            email: acc.email,
            accessToken: acc.credentials.accessToken,
            refreshToken: acc.credentials?.refreshToken,
            profileArn: acc.profileArn || acc.credentials?.profileArn,
            expiresAt: acc.credentials?.expiresAt,
            machineId: acc.machineId,
            clientId: acc.credentials?.clientId,
            clientSecret: acc.credentials?.clientSecret,
            region: acc.credentials?.region || 'us-east-1',
            authMethod: acc.credentials?.authMethod,
            provider: acc.credentials?.provider || acc.idp,
            proxyUrl: buildProxyUrl(acc.id)
          }))
        if (proxyAccounts.length > 0 && proxyServer) {
          const pool = proxyServer.getAccountPool()
          proxyAccounts.forEach(acc => pool.addAccount(acc))
          const boundCount = proxyAccounts.filter(a => a.proxyUrl).length
          console.log(`[ProxyServer] Lazy-synced ${proxyAccounts.length} accounts from store (${boundCount} with bound proxy)`)
        }
      }
    }
  )

  // P1-6 injection webhook Trigger: Let the key event of anti-generation (account ban / All quotas exhausted / Current limit) can push notifications
  proxyServer.setWebhookTrigger((event, payload) => {
    // pass IPC forward to renderer,Depend on useWebhookStore.triggerEvent actually sent
    mainWindow?.webContents.send('proxy-webhook-trigger', { event, payload })
  })

  // Enterprise profileArn Self-healing persistence: Reality is resolved for the first time at runtime profileArn hour,
  // Write back to account pool + memory snapshot + notify renderer Place it on the disk to avoid repeated acquisition for each request.
  setProfileArnPersistCallback((accountId, profileArn) => {
    try {
      proxyServer?.getAccountPool().updateAccount(accountId, { profileArn })
      // push IPC,let renderer store Bundle profileArn Write account data
      mainWindow?.webContents.send('proxy-account-update', { id: accountId, profileArn })
      // Synchronously update the memory snapshot to ensure that the entire database is brought to disk next time profileArn
      if (lastSavedData && typeof lastSavedData === 'object') {
        const data = lastSavedData as { accounts?: Record<string, Record<string, unknown>> }
        if (data.accounts?.[accountId]) {
          data.accounts[accountId] = { ...data.accounts[accountId], profileArn }
        }
      }
      console.log(`[ProxyServer] Persisted Enterprise profileArn for ${accountId}: ${profileArn}`)
    } catch (e) {
      console.warn('[ProxyServer] Failed to persist profileArn:', e)
    }
  })

  // Restore saved totals credits
  if (savedTotalCredits > 0) {
    proxyServer.setTotalCredits(savedTotalCredits)
  }

  // Restore saved totals tokens
  if (savedInputTokens > 0 || savedOutputTokens > 0) {
    proxyServer.setTotalTokens(savedInputTokens, savedOutputTokens)
  }

  // Restore saved request statistics
  if (savedTotalRequests > 0 || savedSuccessRequests > 0 || savedFailedRequests > 0) {
    proxyServer.setRequestStats(savedTotalRequests, savedSuccessRequests, savedFailedRequests)
  }

  // load Steering File (if workspace path is configured)
  proxyServer.loadSteering()

  return proxyServer
}

// ============ Open browser in private mode ============
import { exec, execSync } from 'child_process'

// get Windows Default browser
function getWindowsDefaultBrowser(): string {
  try {
    // Read default browser from registry
    const progId = execSync(
      'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    
    if (progId.includes('ChromeHTML') || progId.includes('Google')) return 'chrome'
    if (progId.includes('MSEdgeHTM') || progId.includes('Edge')) return 'msedge'
    if (progId.includes('FirefoxURL') || progId.includes('Firefox')) return 'firefox'
    if (progId.includes('BraveHTML') || progId.includes('Brave')) return 'brave'
    if (progId.includes('Opera')) return 'opera'
    
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// Open your browser in private mode
function openBrowserInPrivateMode(url: string): void {
  const platform = process.platform
  console.log(`[Browser] Opening in private mode on ${platform}: ${url}`)

  try {
    if (platform === 'win32') {
      // Windows: Detect default browser and use corresponding privacy mode parameters
      const defaultBrowser = getWindowsDefaultBrowser()
      console.log(`[Browser] Detected default browser: ${defaultBrowser}`)
      
      let command = ''
      switch (defaultBrowser) {
        case 'chrome':
          command = `start chrome --incognito "${url}"`
          break
        case 'msedge':
          command = `start msedge -inprivate "${url}"`
          break
        case 'firefox':
          command = `start firefox -private-window "${url}"`
          break
        case 'brave':
          command = `start brave --incognito "${url}"`
          break
        case 'opera':
          command = `start opera --private "${url}"`
          break
        default:
          // Unknown browser, try a common browser
          console.log('[Browser] Unknown default browser, trying common browsers...')
          exec(`start chrome --incognito "${url}"`, (err) => {
            if (err) {
              exec(`start msedge -inprivate "${url}"`, (err2) => {
                if (err2) {
                  exec(`start firefox -private-window "${url}"`, (err3) => {
                    if (err3) {
                      console.log('[Browser] Fallback to default browser (non-private)')
                      shell.openExternal(url)
                    }
                  })
                }
              })
            }
          })
          return
      }
      
      exec(command, (err) => {
        if (err) {
          console.log(`[Browser] Failed to open ${defaultBrowser}, fallback to default`)
          shell.openExternal(url)
        }
      })
    } else if (platform === 'darwin') {
      // macOS: try Chrome -> Firefox -> Default browser
      exec(`open -na "Google Chrome" --args --incognito "${url}"`, (err) => {
        if (err) {
          exec(`open -a Firefox --args -private-window "${url}"`, (err2) => {
            if (err2) {
              console.log('[Browser] Fallback to default browser')
              shell.openExternal(url)
            }
          })
        }
      })
    } else {
      // Linux: try Chrome -> Chromium -> Firefox
      exec(`google-chrome --incognito "${url}"`, (err) => {
        if (err) {
          exec(`chromium --incognito "${url}"`, (err2) => {
            if (err2) {
              exec(`firefox -private-window "${url}"`, (err3) => {
                if (err3) {
                  console.log('[Browser] Fallback to default browser')
                  shell.openExternal(url)
                }
              })
            }
          })
        }
      })
    }
  } catch (error) {
    console.error('[Browser] Error opening in private mode:', error)
    shell.openExternal(url)
  }
}

// IdC (BuilderId) of OIDC Token refresh
async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  proxyUrl?: string  // Account bound agent URL(optional, highest priority)
): Promise<OidcRefreshResult> {
  console.log(`[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...${proxyUrl ? ' [via bound proxy]' : ''}`)

  const url = `https://oidc.${region}.amazonaws.com/token`

  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  }

  try {
    const response = await fetchWithAppProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, proxyUrl)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)
    
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken, // May not return new refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// social login (GitHub/Google) of Token refresh
async function refreshSocialToken(
  refreshToken: string,
  proxyUrl?: string  // Account bound agent URL(optional, highest priority)
): Promise<OidcRefreshResult> {
  console.log(`[Social] Refreshing token...${proxyUrl ? ' [via bound proxy]' : ''}`)

  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`
  const machineId = getCurrentMachineId()

  try {
    const response = await fetchWithAppProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': getKiroUserAgent(machineId)
      },
      body: JSON.stringify({ refreshToken })
    }, proxyUrl)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)
    
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[Social] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// Universal Token refresh - according to authMethod Select refresh method
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string  // Account bound agent URL(optional, highest priority)
): Promise<OidcRefreshResult> {
  // For social login, use Kiro Auth Service refresh
  if (authMethod === 'social') {
    return refreshSocialToken(token, proxyUrl)
  }
  // Otherwise use OIDC refresh (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region, proxyUrl)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Kiro version and User-Agent generate
const KIRO_VERSION = '0.6.18'

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

function getCurrentMachineId(): string | undefined {
  const kproxyService = getKProxyService()
  if (!kproxyService) return undefined
  return kproxyService.getDeviceId()
}

// ============ AWS SSO Device authorization process ============
interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

async function ssoDeviceAuth(bearerToken: string, region: string = 'us-east-1'): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const portalBase = 'https://portal.sso.us-east-1.amazonaws.com'
  const startUrl = 'https://view.awsapps.com/start'
  const scopes = ['codewhisperer:analysis', 'codewhisperer:completions', 'codewhisperer:conversations', 'codewhisperer:taskassist', 'codewhisperer:transformations']

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let deviceSessionToken: string
  let interval = 1

  // Step 1: register OIDC client
  console.log('[SSO] Step 1: Registering OIDC client...')
  try {
    const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiro Account Manager',
        clientType: 'public',
        scopes,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: startUrl
      })
    })
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`)
    const regData = await regRes.json() as { clientId: string; clientSecret: string }
    clientId = regData.clientId
    clientSecret = regData.clientSecret
    console.log(`[SSO] Client registered: ${clientId.substring(0, 30)}...`)
  } catch (e) {
    return { success: false, error: `Failed to register client: ${e}` }
  }

  // Step 2: Initiate device authorization
  console.log('[SSO] Step 2: Starting device authorization...')
  try {
    const devRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    })
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`)
    const devData = await devRes.json() as { deviceCode: string; userCode: string; interval?: number }
    deviceCode = devData.deviceCode
    userCode = devData.userCode
    interval = devData.interval || 1
    console.log(`[SSO] Device code obtained, user_code: ${userCode}`)
  } catch (e) {
    return { success: false, error: `Device authorization failed: ${e}` }
  }

  // Step 3: verify Bearer Token (whoAmI)
  console.log('[SSO] Step 3: Verifying bearer token...')
  try {
    const whoRes = await fetchWithAppProxy(`${portalBase}/token/whoAmI`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Accept': 'application/json' }
    })
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`)
    console.log('[SSO] Bearer token verified')
  } catch (e) {
    return { success: false, error: `Token Authentication failed: ${e}` }
  }

  // Step 4: Get device session token
  console.log('[SSO] Step 4: Getting device session token...')
  try {
    const sessRes = await fetchWithAppProxy(`${portalBase}/session/device`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    if (!sessRes.ok) throw new Error(`Device session failed: ${sessRes.status}`)
    const sessData = await sessRes.json() as { token: string }
    deviceSessionToken = sessData.token
    console.log('[SSO] Device session token obtained')
  } catch (e) {
    return { success: false, error: `Failed to get device session: ${e}` }
  }

  // Step 5: Accept user code
  console.log('[SSO] Step 5: Accepting user code...')
  let deviceContext: { deviceContextId?: string; clientId?: string; clientType?: string } | null = null
  try {
    const acceptRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/accept_user_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://view.awsapps.com/' },
      body: JSON.stringify({ userCode, userSessionId: deviceSessionToken })
    })
    if (!acceptRes.ok) throw new Error(`Accept user code failed: ${acceptRes.status}`)
    const acceptData = await acceptRes.json() as { deviceContext?: { deviceContextId?: string; clientId?: string; clientType?: string } }
    deviceContext = acceptData.deviceContext || null
    console.log('[SSO] User code accepted')
  } catch (e) {
    return { success: false, error: `Failed to accept user code: ${e}` }
  }

  // Step 6: approve authorization
  if (deviceContext?.deviceContextId) {
    console.log('[SSO] Step 6: Approving authorization...')
    try {
      const approveRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/associate_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://view.awsapps.com/' },
        body: JSON.stringify({
          deviceContext: {
            deviceContextId: deviceContext.deviceContextId,
            clientId: deviceContext.clientId || clientId,
            clientType: deviceContext.clientType || 'public'
          },
          userSessionId: deviceSessionToken
        })
      })
      if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status}`)
      console.log('[SSO] Authorization approved')
    } catch (e) {
      return { success: false, error: `Authorization failed: ${e}` }
    }
  }

  // Step 7: Polling to obtain Token
  console.log('[SSO] Step 7: Polling for token...')
  const startTime = Date.now()
  const timeout = 120000 // 2 minutes timeout

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, interval * 1000))
    
    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { accessToken: string; refreshToken: string; expiresIn?: number }
        console.log('[SSO] Token obtained successfully!')
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
      }

      if (tokenRes.status === 400) {
        const errData = await tokenRes.json() as { error?: string }
        if (errData.error === 'authorization_pending') {
          continue // Continue polling
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token Failed to obtain: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: 'Authorization timed out, please try again' }
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp: string = 'BuilderId',  // support BuilderId, Github, Google
  accountMachineId?: string,  // Device bound to the account ID
  email?: string              // Used for log identification
): Promise<T> {
  // Prioritize the use of devices bound to the account ID, followed by using K-Proxy global device ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro API] ${operation} [${logTag}] ${idp} machineId=${machineId?.slice(0, 8) || 'none'}`)
  const agent = getKProxyAgent()
  
  // use undici fetch support agent
  const headers: Record<string, string> = {
    'accept': 'application/cbor',
    'content-type': 'application/cbor',
    'smithy-protocol': 'rpc-v2-cbor',
    'amz-sdk-invocation-id': generateInvocationId(),
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'authorization': `Bearer ${accessToken}`,
    'cookie': `Idp=${idp}; AccessToken=${accessToken}`
  }
  
  let response: Response
  if (agent) {
    response = await undiciFetch(`${KIRO_API_BASE}/${operation}`, {
      method: 'POST',
      headers,
      body: Buffer.from(encode(body)),
      dispatcher: agent
    } as UndiciRequestInit) as unknown as Response
  } else {
    response = await fetchWithAppProxy(`${KIRO_API_BASE}/${operation}`, {
      method: 'POST',
      headers,
      body: Buffer.from(encode(body))
    })
  }

  if (!response.ok) {
    // try to parse CBOR format error response
    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
      if (errorData.__type && errorData.message) {
        // Extract error type name (remove namespace)
        const errorType = errorData.__type.split('#').pop() || errorData.__type
        // Include in error message HTTP Status code to facilitate ban detection
        errorMessage = `HTTP ${response.status}: ${errorType}: ${errorData.message}`
      } else if (errorData.message) {
        errorMessage = `HTTP ${response.status}: ${errorData.message}`
      }
      console.error(`[Kiro API] Error:`, errorData)
    } catch {
      // if CBOR Parsing failed, original content displayed
      const errorText = Buffer.from(errorBuffer).toString('utf-8')
      console.error(`[Kiro API] Error (raw): ${errorText}`)
    }
    throw new Error(errorMessage)
  }

  const arrayBuffer = await response.arrayBuffer()
  const result = decode(Buffer.from(arrayBuffer)) as T
  // Compact response log: one line summary + Complete data put data（ⓘ Expand)
  const r = result as Record<string, unknown>
  const resSummary = r.email ? `${r.email} [${r.status || 'ok'}]` : `${response.status}`
  console.log(`[Kiro API] ${operation} [${logTag}] → ${resSummary}`, result)
  return result
}

// ============ GetUsageLimits REST API (official format) ============
interface UsageLimitsResponse {
  // REST API actual return usageBreakdownList(no usageBreakdowns）
  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageCharges?: number
    currentOverages?: number
    freeTrialUsage?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
    // REST API Return directly freeTrialInfo(and freeTrialUsage structure is the same)
    freeTrialInfo?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number | string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      description?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: number | string  // REST API Returns a numeric timestamp
      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string  // Unix timestamp (seconds) or ISO string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

// Auxiliary function: will Unix timestamp (seconds) or ISO String converted to ISO string
function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix Timestamp (seconds), created after conversion to milliseconds Date
    return new Date(value * 1000).toISOString()
  }
  return value
}

async function fetchRestApi(
  baseUrl: string,
  path: string,
  accessToken: string,
  machineId?: string
): Promise<Response> {
  const agent = getKProxyAgent()
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': getKiroUserAgent(machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(machineId)
  }
  const url = `${baseUrl}${path}`
  if (agent) {
    return await undiciFetch(url, {
      method: 'GET',
      headers,
      dispatcher: agent
    } as UndiciRequestInit) as unknown as Response
  }
  return await fetchWithAppProxy(url, { method: 'GET', headers })
}

async function getUsageLimitsRest(
  accessToken: string,
  profileArn?: string,
  accountMachineId?: string,  // Device bound to the account ID
  ssoRegion?: string,         // SSO area for selecting the correct REST API endpoint
  email?: string              // Used for log identification
): Promise<UsageLimitsResponse> {
  // Prioritize the use of devices bound to the account ID, followed by using K-Proxy global device ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)
  
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) {
    params.set('profileArn', profileArn)
  }
  const path = `/getUsageLimits?${params.toString()}`
  
  // according to SSO Region selection primary endpoint
  const primaryBase = getRestApiBase(ssoRegion)
  const fallbackBase = getFallbackRestApiBase(ssoRegion)
  
  let response = await fetchRestApi(primaryBase, path, accessToken, machineId)
  
  // If the main endpoint returns 403, try the alternate endpoint
  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, accessToken, machineId)
  }
  
  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }
  
  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`, result)
  return result
}

// Unified usage query interface - Choose according to configuration API type
interface UnifiedUsageResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    type?: string
    freeTrialInfo?: {
      freeTrialStatus?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialExpiry?: string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string
      status?: string
    }>
  }>
  nextDateReset?: string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

async function getUsageAndLimits(
  accessToken: string,
  idp: string = 'BuilderId',
  profileArn?: string,
  accountMachineId?: string,  // Device bound to the account ID
  ssoRegion?: string,         // SSO area for selecting the correct REST API endpoint
  email?: string              // Used for log identification
): Promise<UnifiedUsageResponse> {
  if (currentUsageApiType === 'rest') {
    // use REST API (GetUsageLimits)
    const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email)
    // REST API Returned field names and CBOR API Same, return directly
    return {
      usageBreakdownList: result.usageBreakdownList?.map(b => ({
        resourceType: b.resourceType || b.type,
        displayName: b.displayName,
        displayNamePlural: b.displayNamePlural,
        currentUsage: b.currentUsage,
        currentUsageWithPrecision: b.currentUsageWithPrecision,
        usageLimit: b.usageLimit,
        usageLimitWithPrecision: b.usageLimitWithPrecision,
        currency: b.currency,
        unit: b.unit,
        overageRate: b.overageRate,
        overageCap: b.overageCap,
        type: b.type,
        // REST API Return directly freeTrialInfo，CBOR API return freeTrialUsage
        freeTrialInfo: b.freeTrialInfo ? {
          freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
          usageLimit: b.freeTrialInfo.usageLimit,
          usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
          currentUsage: b.freeTrialInfo.currentUsage,
          currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
          // REST API Returns a numeric timestamp, which needs to be converted to ISO string
          freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
            ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
            : b.freeTrialInfo.freeTrialExpiry
        } : (b.freeTrialUsage ? {
          freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
          usageLimit: b.freeTrialUsage.usageLimit,
          usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
          currentUsage: b.freeTrialUsage.currentUsage,
          currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
          freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
        } : undefined),
        // Convert bonuses The timestamp in is ISO string
        bonuses: b.bonuses?.map(bonus => ({
          ...bonus,
          expiresAt: typeof bonus.expiresAt === 'number' 
            ? new Date(bonus.expiresAt * 1000).toISOString() 
            : bonus.expiresAt
        }))
      })),
      // REST API returned nextDateReset yes Unix Timestamp (seconds), needs to be converted to ISO string
      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    }
  } else {
    // use CBOR API (GetUserUsageAndLimits)
    // CBOR API (app.kiro.dev) It is a web portal and only supports BuilderId Certification
    // Enterprise/IdC Account may return 401,need fallback arrive REST API
    try {
      return await kiroApiRequest<UnifiedUsageResponse>(
        'GetUserUsageAndLimits',
        { isEmailRequired: true, origin: 'KIRO_IDE' },
        accessToken,
        idp,
        accountMachineId,
        email
      )
    } catch (cborError) {
      const errorMsg = cborError instanceof Error ? cborError.message : ''
      // CBOR 401/403 automatically fallback arrive REST API
      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`)
        const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email)
        return {
          usageBreakdownList: result.usageBreakdownList?.map(b => ({
            resourceType: b.resourceType || b.type,
            displayName: b.displayName,
            displayNamePlural: b.displayNamePlural,
            currentUsage: b.currentUsage,
            currentUsageWithPrecision: b.currentUsageWithPrecision,
            usageLimit: b.usageLimit,
            usageLimitWithPrecision: b.usageLimitWithPrecision,
            currency: b.currency,
            unit: b.unit,
            overageRate: b.overageRate,
            overageCap: b.overageCap,
            type: b.type,
            freeTrialInfo: b.freeTrialInfo ? {
              freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
              usageLimit: b.freeTrialInfo.usageLimit,
              usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
              currentUsage: b.freeTrialInfo.currentUsage,
              currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
              freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
                ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
                : b.freeTrialInfo.freeTrialExpiry
            } : (b.freeTrialUsage ? {
              freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
              usageLimit: b.freeTrialUsage.usageLimit,
              usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
              currentUsage: b.freeTrialUsage.currentUsage,
              currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
              freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
            } : undefined),
            bonuses: b.bonuses?.map(bonus => ({
              ...bonus,
              expiresAt: typeof bonus.expiresAt === 'number' 
                ? new Date(bonus.expiresAt * 1000).toISOString() 
                : bonus.expiresAt
            }))
          })),
          nextDateReset: normalizeResetDate(result.nextDateReset as unknown as number | string),
          subscriptionInfo: result.subscriptionInfo,
          overageConfiguration: result.overageConfiguration,
          userInfo: result.userInfo
        }
      }
      throw cborError
    }
  }
}

// GetUserInfo API - Just need accessToken Can be called
interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

async function getUserInfo(accessToken: string, idp: string = 'BuilderId', accountMachineId?: string, email?: string): Promise<UserInfoResponse> {
  return kiroApiRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, accountMachineId, email)
}

// Define custom protocols
const PROTOCOL_PREFIX = 'kiro'

// electron-store Example (lazy initialization)
let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// Last saved data (for crash recovery)
let lastSavedData: unknown = null

async function initStore(): Promise<void> {
  if (store) return
  const Store = (await import('electron-store')).default
  const path = await import('path')
  
  const storeInstance = new Store({
    name: 'kiro-accounts',
    encryptionKey: 'kiro-account-manager-secret-key'
  })
  
  store = storeInstance as unknown as typeof store
  
  // Attempt to restore data from backup (if primary data is corrupted). Backup read-first encryption .enc, compatible with old plaintext .json
  try {
    const mainData = storeInstance.get('accountData')

    if (!mainData) {
      try {
        const { readSecureBackup } = await import('./secureBackup')
        const backupData = await readSecureBackup(path.dirname(storeInstance.path)) as { accounts?: unknown } | null
        if (backupData && backupData.accounts) {
          console.log('[Store] Restoring data from backup...')
          storeInstance.set('accountData', backupData)
          console.log('[Store] Data restored from backup successfully')
        }
      } catch {
        // The backup does not exist either, ignore it.
      }
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }

  // One-time migration: cleanup BuilderId placeholder profileArn Waiting for dirty data
  // See details migrateAccountDataIfNeeded Comment
  try {
    migrateAccountDataIfNeeded()
  } catch (error) {
    console.error('[Store] Account data migration failed:', error)
  }

  // Load active renewal switch status (off by default)
  try {
    proactiveRenewalEnabled = !!storeInstance.get('proactiveRenewalEnabled', false)
    console.log(`[ProactiveRenewal] Loaded from settings: ${proactiveRenewalEnabled ? 'enabled' : 'disabled'}`)
  } catch (e) {
    console.warn('[ProactiveRenewal] Failed to load setting:', e)
  }
}

// ============ Kiro IDE Auth Token reverse sync ============
//
// Kiro IDE It’s also available on the desktop refresh loop:Every N Check in seconds token If it is about to expire, use the one in the disk when it expires.
// refreshToken tune OIDC, get new access + new refresh write back later ~/.aws/sso/cache/kiro-auth-token.json。
//
// If you are anti-generation and do not perceive this kind of"IDE I changed it myself token document", adjust again next time refresh I'm still using the old stuff refresh
// → OIDC reject → Follow-up IDE Automatic refresh also hangs continuously.
//
// Start one here fs.watchFile Listener:
//   - disk detected token change + It’s not that I’m going against what I just wrote (lastWrittenTokenSignature inconsistent)
//   - put new access/refresh/expiresAt Synchronize back to generation store
//   - pass webContents.send notify renderer again loadAccounts，UI Refresh immediately
//
// Account matching priority (any hit is considered the same account):
//   1) accessToken JWT untie sub, and countergeneration store An account in cached accessToken claims of sub consistent
//   2) lastSwitchedAccountId(Anti-generation Gang switch-account The one that passed)
//   3) refreshToken old value match (IDE Before the first self-refresh, the disk refresh Still equal to store inside)
let stopKiroAuthTokenWatcher: (() => void) | null = null

function startKiroAuthTokenWatcher(): void {
  if (stopKiroAuthTokenWatcher) return
  stopKiroAuthTokenWatcher = watchKiroAuthTokenFile(async (token) => {
    const sig = `${token.accessToken}|${token.refreshToken}`
    if (sig === lastWrittenTokenSignature) {
      // Replacing what you just wrote, skipping to avoid loops
      return
    }
    if (sig === lastSyncedFromIdeSignature) {
      // once before IDE Synchronization has processed this content, skip it
      return
    }
    lastSyncedFromIdeSignature = sig
    try {
      await syncIdeTokenChangeToStore(token)
    } catch (e) {
      console.warn('[KiroAuthSync] syncIdeTokenChangeToStore failed:', e)
    }
  })
  console.log('[KiroAuthSync] Watching:', KIRO_AUTH_TOKEN_PATH)
}

async function syncIdeTokenChangeToStore(token: {
  accessToken: string
  refreshToken: string
  expiresAt: string
  provider?: string
  authMethod?: string
  region?: string
  profileArn?: string
}): Promise<void> {
  if (!store) {
    try {
      await initStore()
    } catch (e) {
      console.warn('[KiroAuthSync] initStore failed, cannot sync back:', e)
      return
    }
  }
  const accountData = store?.get('accountData') as
    | { accounts?: Record<string, { id?: string; email?: string; credentials?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }> }
    | null
    | undefined
  if (!accountData?.accounts) {
    console.log('[KiroAuthSync] No accounts in store, skip')
    return
  }

  // 1) JWT sub Match (most accurate)
  const newClaims = parseAccessTokenClaims(token.accessToken)
  let matchedId: string | null = null
  let matchedReason = ''
  if (newClaims?.sub) {
    for (const [id, acc] of Object.entries(accountData.accounts)) {
      const oldClaims = acc.credentials?.accessToken
        ? parseAccessTokenClaims(acc.credentials.accessToken)
        : null
      if (oldClaims?.sub && oldClaims.sub === newClaims.sub) {
        matchedId = id
        matchedReason = `JWT sub match (${newClaims.sub.slice(0, 12)}…)`
        break
      }
    }
  }

  // 2) lastSwitchedAccountId reveal all the details
  if (!matchedId && lastSwitchedAccountId && accountData.accounts[lastSwitchedAccountId]) {
    matchedId = lastSwitchedAccountId
    matchedReason = 'lastSwitchedAccountId fallback'
  }

  // 3) old refreshToken match
  if (!matchedId) {
    for (const [id, acc] of Object.entries(accountData.accounts)) {
      if (acc.credentials?.accessToken === token.accessToken) {
        // store and disk access Completely consistent, no synchronization required
        return
      }
      if (acc.credentials?.refreshToken && acc.credentials.refreshToken === token.refreshToken) {
        matchedId = id
        matchedReason = 'refreshToken exact match (no rotation yet)'
        break
      }
    }
  }

  if (!matchedId) {
    console.warn(
      '[KiroAuthSync] IDE token file changed but no matching account in store. ' +
        'This usually means the user signed in directly inside Kiro IDE without going through Anti-generation number. ' +
        'sub=',
      newClaims?.sub
    )
    return
  }

  const accountToUpdate = accountData.accounts[matchedId]
  if (!accountToUpdate) return
  accountToUpdate.credentials = {
    ...accountToUpdate.credentials,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.parse(token.expiresAt) || Date.now() + 3600 * 1000
  }

  store!.set('accountData', accountData)
  console.log(
    `[KiroAuthSync] Synced IDE-refreshed token back to account ${accountToUpdate.email || matchedId} (${matchedReason})`
  )

  try {
    mainWindow?.webContents.send('kiro-ide-token-changed', {
      accountId: matchedId,
      reason: matchedReason
    })
  } catch (e) {
    console.warn('[KiroAuthSync] failed to notify renderer:', e)
  }
}

// ============ Active renewal implementation ============
//
// Design points:
//  - only for"current IDE Activate account"Scheduling timer(most 1 indivual in-flight timer）
//  - schedule Always before clear,make sure timer will not leak (switch Go to another account, turn off functions, and log out. clear）
//  - runProactiveRenewal internal adjustment refreshTokenByMethod + writeKiroAuthTokenFile(Reuse existing logic)
//  - Automatically after successful renewal schedule next time (based on new token of expiresAt）
//  - Renewal failed: No more scheduling to avoid infinite retries; let IDE own refresh loop Stay safe (two-way synchronization is still in effect)
//  - pass webContents.send('kiro-ide-token-changed') notify renderer reload,UI Refresh immediately

function clearProactiveRenewal(reason?: string): void {
  if (proactiveRenewalTimer) {
    clearTimeout(proactiveRenewalTimer)
    proactiveRenewalTimer = null
    if (reason) console.log(`[ProactiveRenewal] Timer cleared: ${reason}`)
  }
}

/**
 * exist token Remaining (PROACTIVE_RENEWAL_LEAD_MS) Renewal is triggered.
 * The caller is responsible for passing in the exact expiresAt(from OIDC reality expiresIn), do not read store Avoid inconsistencies.
 */
function scheduleProactiveRenewal(accountId: string, expiresAtMs: number): void {
  clearProactiveRenewal()
  if (!proactiveRenewalEnabled) return
  const msUntilRenewal = expiresAtMs - Date.now() - PROACTIVE_RENEWAL_LEAD_MS
  // If it is already within the window (including expired), renew immediately
  const delay = Math.max(msUntilRenewal, 0)
  console.log(
    `[ProactiveRenewal] Scheduled in ${Math.round(delay / 1000)}s for account ${accountId} ` +
      `(token expiresAt ${new Date(expiresAtMs).toISOString()})`
  )
  proactiveRenewalTimer = setTimeout(() => {
    proactiveRenewalTimer = null
    void runProactiveRenewal(accountId)
  }, delay)
}

async function runProactiveRenewal(accountId: string): Promise<void> {
  if (!proactiveRenewalEnabled) {
    console.log('[ProactiveRenewal] Disabled, skip run')
    return
  }
  if (!store) {
    try {
      await initStore()
    } catch (e) {
      console.warn('[ProactiveRenewal] initStore failed:', e)
      return
    }
  }
  const accountData = store?.get('accountData') as
    | { accounts?: Record<string, { id?: string; email?: string; profileArn?: string; proxyUrl?: string; credentials?: { refreshToken?: string; clientId?: string; clientSecret?: string; region?: string; authMethod?: string; startUrl?: string; provider?: string; accessToken?: string; expiresAt?: number } }> }
    | null
    | undefined
  const account = accountData?.accounts?.[accountId]
  if (!account) {
    console.log(`[ProactiveRenewal] Account ${accountId} no longer exists, stop`)
    return
  }
  const creds = account.credentials
  if (!creds?.refreshToken) {
    console.log(`[ProactiveRenewal] Account ${accountId} has no refreshToken, stop`)
    return
  }
  console.log(
    `[ProactiveRenewal] Renewing token for IDE active account ${account.email || accountId}...`
  )
  let refreshResult
  try {
    refreshResult = await refreshTokenByMethod(
      creds.refreshToken,
      creds.clientId || '',
      creds.clientSecret || '',
      creds.region || 'us-east-1',
      creds.authMethod,
      account.proxyUrl
    )
  } catch (e) {
    console.warn('[ProactiveRenewal] refreshTokenByMethod threw, stop scheduling:', e)
    return
  }
  if (!refreshResult.success || !refreshResult.accessToken) {
    console.warn(
      `[ProactiveRenewal] Renewal failed: ${refreshResult.error || 'unknown'}. ` +
        `Stop scheduling; IDE's own refresh loop will take over as fallback.`
    )
    return
  }
  const newAccess = refreshResult.accessToken
  const newRefresh = refreshResult.refreshToken || creds.refreshToken
  const expiresIn = refreshResult.expiresIn ?? 3600
  const newExpiresAt = Date.now() + expiresIn * 1000

  const resolvedProfileArn = resolveProfileArnForWrite({
    profileArn: account.profileArn,
    authMethod: creds.authMethod,
    provider: creds.provider,
    region: creds.region
  })

  // 1. Write to disk (synchronously to IDE）
  try {
    await writeKiroAuthTokenFile({
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresAtIso: new Date(newExpiresAt).toISOString(),
      authMethod: (creds.authMethod === 'social' ? 'social' : 'IdC'),
      provider: creds.provider || 'BuilderId',
      region: creds.region,
      startUrl: creds.startUrl,
      clientId: creds.clientId || undefined,
      clientSecret: creds.clientSecret || undefined,
      profileArn: resolvedProfileArn
    })
    lastWrittenTokenSignature = `${newAccess}|${newRefresh}`
    lastSwitchedAccountId = accountId
  } catch (e) {
    console.warn('[ProactiveRenewal] Failed to write IDE token file (will still try store sync):', e)
  }

  // 2. Write store(synchronous reverse generation/UI）
  if (store) {
    account.credentials = {
      ...creds,
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresAt: newExpiresAt
    }
    store.set('accountData', accountData)
  }

  // 3. notify renderer reload
  try {
    mainWindow?.webContents.send('kiro-ide-token-changed', {
      accountId,
      reason: 'proactive-renewal'
    })
  } catch {
    /* renderer may be closed */
  }

  console.log(
    `[ProactiveRenewal] Renewed OK for ${account.email || accountId}. ` +
      `Next renewal in ${expiresIn - PROACTIVE_RENEWAL_LEAD_MS / 1000}s`
  )

  // 4. Schedule next time
  scheduleProactiveRenewal(accountId, newExpiresAt)
}

/**
 * Account data migration (deactivated): used for cleanup profileArn placeholder,
 * but Kiro IDE Internal logic relies on the existence of this field. Removing it caused serious problems and has been rolled back.
 * Preserve the function shell and mark writing to prevent repeated execution when the old version is rolled back.
 */
function migrateAccountDataIfNeeded(): void {
  if (!store) return
  const MIGRATION_KEY = 'accountDataMigration'
  const FLAG = 'builderIdArn'
  const migrationState = (store.get(MIGRATION_KEY, {}) as Record<string, number>) || {}
  const accountData = store.get('accountData') as
    | { accounts?: Record<string, { id?: string; provider?: string; profileArn?: string; email?: string }> }
    | null
    | undefined

  if (!accountData?.accounts) {
    if (!migrationState[FLAG]) {
      store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
    }
    return
  }

  // profileArn Placeholders are no longer cleaned up —— Kiro IDE Internal logic relies on the existence of this field
  // Preserve migration mark writes to avoid duplication when rolling back old versions

  if (!migrationState[FLAG]) {
    store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
  }
}

// ============ Backup throttling configuration ============
// Backup is for disaster recovery. There is no need to completely rewrite the file every time it is saved. Throttling based on time can significantly reduce disk usage. IO。
const BACKUP_THROTTLE_MS = 5 * 60 * 1000 // 5 Backup can be written at most once every minute
let lastBackupTime = 0
let pendingBackupData: unknown = null
let pendingBackupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Create data backup (throttling)
 * - Not enough time since last backup BACKUP_THROTTLE_MS When, only the data pointer is recorded and the disk is not written immediately.
 * - After the throttling window ends, automatically flush The latest data
 * - Can be called manually before exiting flushBackupNow() Force disk writing
 */
async function createBackup(data: unknown): Promise<void> {
  pendingBackupData = data
  const now = Date.now()
  const elapsed = now - lastBackupTime

  if (elapsed >= BACKUP_THROTTLE_MS) {
    // The throttling window has passed, write disk immediately
    await writeBackupNow()
    return
  }

  // Within the throttling window: schedule a delay flush(if not scheduled yet)
  if (!pendingBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed
    pendingBackupTimer = setTimeout(() => {
      pendingBackupTimer = null
      void writeBackupNow()
    }, delay)
  }
}

/**
 * Really perform backup and write to disk. only if pendingBackupData Written when not empty.
 */
async function writeBackupNow(): Promise<void> {
  if (!store || pendingBackupData == null) return
  const data = pendingBackupData
  pendingBackupData = null
  lastBackupTime = Date.now()
  try {
    const path = await import('path')
    const { writeSecureBackup, isSecureBackupAvailable } = await import('./secureBackup')
    await writeSecureBackup(path.dirname(store.path), data)
    console.log(`[Backup] Data backup created (${isSecureBackupAvailable() ? 'encrypted' : 'plaintext-fallback'})`)
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error)
  }
}

/**
 * force flush Backup to be written (for backup before exiting)
 */
async function flushBackupNow(): Promise<void> {
  if (pendingBackupTimer) {
    clearTimeout(pendingBackupTimer)
    pendingBackupTimer = null
  }
  if (pendingBackupData != null) {
    await writeBackupNow()
  }
}

let mainWindow: BrowserWindow | null = null

// ============ Kiro IDE Auth Sync status ============
// Account Manager last written kiro-auth-token.json corresponding to accountId，watcher Use it first during reverse synchronization
let lastSwitchedAccountId: string | null = null
// The account manager was last written to token sign(access|refresh）。
// watcher If the signatures are consistent when triggered, it means that the account manager wrote it itself, skipping reverse synchronization and avoiding loopbacks.
let lastWrittenTokenSignature: string | null = null
// Flashed when the last reverse synchronization was successful store data signature for dedupe webContents.send
let lastSyncedFromIdeSignature: string | null = null

// ============ Active renewal (Proactive Token Renewal） ============
// Idea: in Kiro IDE internal refresh loop before triggering (token left 10 minutes) take the lead refresh，
//   let IDE Always get enough time left token，IDE You never need to adjust yourself OIDC → completely eliminate race。
// only for"current IDE Activate account"（lastSwitchedAccountId) maintain a timer, low overhead.
// It is closed by default and requires the user to Settings Open explicitly in .
let proactiveRenewalEnabled = false
let proactiveRenewalTimer: NodeJS.Timeout | null = null
// exist token How much time remains to trigger active renewal.15 minute > Kiro IDE of 10 Minute threshold to ensure priority.
const PROACTIVE_RENEWAL_LEAD_MS = 15 * 60 * 1000

// ============ Account pool token Active refresh (main process scheduling, does not rely on window survival)============
//
// Background: Originally there was only the rendering process setInterval In the scheduling pool token Refresh, the window will be minimized to the tray
// Chromium Background throttling, resulting in token It will be refreshed after a few minutes after expiration. Put here"Scheduling"Moved to the main process: main process timer
// Unaffected by window visibility, read on point store Accounts in, refresh those that are about to expire token, the result is
// background-refresh-result Events are streamed back to the rendering process for persistence (the window is hidden but still alive).
// The rendering process timer is retained (background throttling is turned off) for information synchronization/Automatic number change; both sides token refreshed by
// poolRefreshInFlightIds Remove duplicates and avoid duplicates of the same refreshToken Concurrent refresh invalidates one of them.
type BackgroundRefreshAccount = {
  id: string
  idp?: string
  profileArn?: string
  needsTokenRefresh?: boolean
  machineId?: string
  credentials: {
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    accessToken?: string
    provider?: string
    profileArn?: string
  }
}
/** background-batch-refresh The core implementation (by IPC Shared with the main process scheduler). exist whenReady assigned value. */
let backgroundBatchRefreshImpl:
  | ((accounts: BackgroundRefreshAccount[], concurrency?: number, syncInfo?: boolean) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>)
  | null = null
/** Account being refreshed ID Deduplication collection, the rendering process is shared with the main process scheduler to prevent the same refreshToken Refreshed concurrently. */
const poolRefreshInFlightIds = new Set<string>()
let mainPoolRefreshTimer: NodeJS.Timeout | null = null

/** Ban on the main process side/Suspension determination, mirror rendering process isBannedAccountError */
function isBannedAccountErrorMain(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return e.includes('accountsuspendedexception')
    || e.includes('account suspended')
    || e.includes('temporarily_suspended')
    || e.includes('temporarily suspended')
    || e.includes('Banned')
    || /\b423\b/.test(e)
}

/** Refresh advance amount: ≥ 2× The check interval must be no less than 10 minutes, make sure token not twice tick expire between. */
function mainTokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, 10 * 60 * 1000)
}

/** read store account in the pool, refresh the pool that is about to expire token(only brush token, information synchronization is still the responsibility of the rendering process). */
async function runMainPoolTokenRefreshTick(): Promise<void> {
  if (!backgroundBatchRefreshImpl) return
  try {
    if (!store) { await initStore() }
    if (!store) return
    const data = store.get('accountData') as {
      accounts?: Record<string, {
        id?: string
        email?: string
        idp?: string
        profileArn?: string
        machineId?: string
        lastError?: string
        credentials?: {
          refreshToken?: string
          clientId?: string
          clientSecret?: string
          region?: string
          authMethod?: string
          accessToken?: string
          provider?: string
          profileArn?: string
          expiresAt?: number
        }
      }>
      autoRefreshEnabled?: boolean
      autoRefreshInterval?: number
      autoRefreshConcurrency?: number
    } | undefined
    if (!data?.accounts) return
    if (data.autoRefreshEnabled === false) return

    const intervalMin = Math.max(1, data.autoRefreshInterval ?? 5)
    const leadMs = mainTokenRefreshLeadMs(intervalMin)
    const concurrency = Math.max(1, Math.min(500, data.autoRefreshConcurrency ?? 100))
    const now = Date.now()

    const toRefresh: BackgroundRefreshAccount[] = []
    for (const [id, acc] of Object.entries(data.accounts)) {
      const creds = acc?.credentials
      if (!creds?.refreshToken) continue
      if (isBannedAccountErrorMain(acc.lastError)) continue
      const expiresAt = creds.expiresAt
      // Just brush"Expires soon/Expired"of; no expiresAt Skip (unable to judge)
      if (!expiresAt || expiresAt - now > leadMs) continue
      toRefresh.push({
        id,
        idp: acc.idp,
        profileArn: acc.profileArn,
        needsTokenRefresh: true,
        machineId: acc.machineId,
        credentials: {
          refreshToken: creds.refreshToken,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region,
          authMethod: creds.authMethod,
          accessToken: creds.accessToken,
          provider: creds.provider,
          profileArn: creds.profileArn
        }
      })
    }

    if (toRefresh.length === 0) return
    console.log(`[MainPoolRefresh] ${toRefresh.length} token(s) expiring within ${Math.round(leadMs / 60000)}min, refreshing...`)
    // syncInfo=false: brush only token;Dosage/The rendering process timer is responsible for synchronizing information such as subscriptions to avoid heavy work in the main process.
    await backgroundBatchRefreshImpl(toRefresh, concurrency, false)
  } catch (err) {
    console.warn('[MainPoolRefresh] tick failed:', err instanceof Error ? err.message : err)
  }
}

/** Start the main process pool token Refresh scheduler (does not depend on window being visible)/survive). */
function startMainPoolTokenRefresh(): void {
  stopMainPoolTokenRefresh()
  // After starting, wait for a while and run it first (let the store and the account pool is ready), and then check it every minute;
  // Whether it actually needs to be refreshed depends on runMainPoolTokenRefreshTick Internal press expiresAt + Advance judgment.
  setTimeout(() => { void runMainPoolTokenRefreshTick() }, 15_000)
  mainPoolRefreshTimer = setInterval(() => { void runMainPoolTokenRefreshTick() }, 60_000)
  console.log('[MainPoolRefresh] Scheduler started (main process, checks every 60s)')
}

function stopMainPoolTokenRefresh(): void {
  if (mainPoolRefreshTimer) {
    clearInterval(mainPoolRefreshTimer)
    mainPoolRefreshTimer = null
  }
}

// ============ Pallet related variables ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // Flag whether the app is actually exited

// ============ Global shortcut key settings ============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// Load shortcut key settings
async function loadShortcutSettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('showWindowShortcut') as string | undefined
    if (saved) {
      showWindowShortcut = saved
    }
  } catch (error) {
    console.error('[Shortcut] Failed to load shortcut settings:', error)
  }
}

// Save shortcut key settings
async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// Register the shortcut key for displaying the main window
function registerShowWindowShortcut(): void {
  // Unregister all registered shortcut keys first
  globalShortcut.unregisterAll()
  
  if (!showWindowShortcut) return
  
  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: Restore when window is shown Dock icon
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`)
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`)
    }
  } catch (error) {
    console.error('[Shortcut] Error registering shortcut:', error)
  }
}
let currentProxyAccount: { id: string; email: string; idp: string; status: string; subscription?: string; usage?: { usedCredits: number; totalCredits: number; totalRequests: number; successRequests: number; failedRequests: number } } | null = null
let allAccounts: { id: string; email: string; idp: string; status: string }[] = []

// Load tray settings
async function loadTraySettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('traySettings') as TraySettings | undefined
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved }
    }
  } catch (error) {
    console.error('[Tray] Failed to load tray settings:', error)
  }
}

// Save tray settings
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// Initialize tray
function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        // macOS: Restore when window is shown Dock icon
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send('tray-refresh-account')
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send('tray-switch-account')
    },
    onToggleProxy: async () => {
      const server = initProxyServer()
      if (server.isRunning()) {
        server.stop()
      } else {
        await server.start()
      }
      updateTrayMenu()
    },
    getProxyStatus: () => {
      const server = initProxyServer()
      return {
        running: server.isRunning(),
        port: server.getConfig().port
      }
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts,
    getProxyStats: () => {
      const server = initProxyServer()
      const stats = server.getStats()
      return {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests
      }
    },
    getSessionStats: () => {
      const server = initProxyServer()
      return server.getSessionStats()
    }
  })

  // Set initial prompt
  setTrayTooltip(`Kiro Account manager v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `Kiro Account manager v${app.getVersion()}`,
    width: 1200,   // Just enough to accommodate 3 Column cards (340*3 + 16*2 + margin)
    height: 1200,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // Customize titlebar：mac Keep traffic lights + Hide title bar;win/linux Absolutely nothing frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // Opaque window (turn off transparency + Mica/Vibrancy Avoid distractions from desktop elements)
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Turn off background throttling: the window is hidden after minimizing to the tray,Chromium By default, the rendering process will
      // setInterval(Including token auto-refresh timer) heavily downclocked (aligned to about every minute or even slower),
      // When the pallet is hung token It took several minutes to refresh after expiration. Turn it off to keep the timer running.
      backgroundThrottling: false
    }
  })

  // ============ Customize titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // Set title with version number (HTML Initial title will be overwritten after loading)
    mainWindow?.setTitle(`Kiro Account manager v${app.getVersion()}`)
    mainWindow?.show()
    
    // Check the proxy service auto-start configuration
    setTimeout(async () => {
      try {
        await initStore()
        if (!store) return
        
        const savedProxyConfig = store.get('proxyConfig') as ProxyConfig | undefined
        if (!savedProxyConfig?.autoStart) return
        
        console.log('[ProxyServer] Auto-starting proxy server...')
        const server = initProxyServer()
        server.updateConfig(savedProxyConfig)
        
        // Synchronize the account to the agent pool during startup (including retry mechanism to deal with cold start data delay)
        const syncAccountsToPool = (): number => {
          const accountData = store!.get('accountData') as {
            accounts?: Record<string, any>
            accountProxyBindings?: Record<string, string>
            proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
          } | undefined
          if (!accountData?.accounts) return 0

          const bindings = accountData.accountProxyBindings || {}
          const proxyPool = accountData.proxyPool || {}
          const buildProxyUrl = (accountId: string): string | undefined => {
            const proxyId = bindings[accountId]
            if (!proxyId) return undefined
            const p = proxyPool[proxyId]
            if (!p || !p.enabled || p.status === 'dead') return undefined
            return p.url
          }

          const proxyAccounts = Object.values(accountData.accounts)
            .filter((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
            .map((acc: any) => {
              const provider = acc.credentials?.provider || acc.idp
              const authMethod = acc.credentials?.authMethod
              const profileArn = acc.profileArn || acc.credentials?.profileArn
              // BuilderId/Social No pre-filling required profileArn（resolveProfileArn Will tell you the truth, the streaming endpoint automatically does not pass the placeholder)
              // Enterprise Leave it to self-healing to get the truth ARN
              return {
                id: acc.id,
                email: acc.email,
                accessToken: acc.credentials.accessToken,
                refreshToken: acc.credentials?.refreshToken,
                profileArn,
                expiresAt: acc.credentials?.expiresAt,
                machineId: acc.machineId,
                clientId: acc.credentials?.clientId,
                clientSecret: acc.credentials?.clientSecret,
                region: acc.credentials?.region || 'us-east-1',
                authMethod,
                provider,
                proxyUrl: buildProxyUrl(acc.id)
              }
            })
          if (proxyAccounts.length > 0) {
            const pool = server.getAccountPool()
            pool.clear()
            proxyAccounts.forEach(acc => pool.addAccount(acc))
          }
          return proxyAccounts.length
        }

        let syncedCount = syncAccountsToPool()
        if (syncedCount > 0) {
          console.log('[ProxyServer] Auto-synced', syncedCount, 'accounts')
        } else {
          // cold start store There may be no data yet (the rendering process has not been initialized yet), delay and retry.
          console.log('[ProxyServer] No accounts found on initial sync, will retry...')
          const retrySync = (attempt: number) => {
            setTimeout(() => {
              const count = syncAccountsToPool()
              if (count > 0) {
                console.log(`[ProxyServer] Retry #${attempt}: synced ${count} accounts`)
              } else if (attempt < 5) {
                retrySync(attempt + 1)
              } else {
                console.log('[ProxyServer] All retry attempts exhausted, no accounts available. Accounts will sync when UI loads.')
              }
            }, attempt * 2000) // 2s, 4s, 6s, 8s, 10s
          }
          retrySync(1)
        }
        
        await server.start()
        console.log('[ProxyServer] Auto-started successfully on port', savedProxyConfig.port || 5580)
      } catch (error) {
        console.error('[ProxyServer] Auto-start failed:', error)
      }

      // K-Proxy MITM self start
      try {
        const savedKProxyConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
        if (savedKProxyConfig?.autoStart) {
          console.log('[KProxy] Auto-starting K-Proxy MITM...')
          const service = initKProxyService(savedKProxyConfig, {
            onRequest: (info) => {
              mainWindow?.webContents.send('kproxy-request', info)
            },
            onResponse: (info) => {
              mainWindow?.webContents.send('kproxy-response', info)
            },
            onError: (error) => {
              console.error('[KProxy] Error:', error)
              mainWindow?.webContents.send('kproxy-error', error.message)
            },
            onStatusChange: (running, port) => {
              mainWindow?.webContents.send('kproxy-status-change', { running, port })
            },
            onMitmIntercept: (host, modified) => {
              mainWindow?.webContents.send('kproxy-mitm', { host, modified })
            }
          })
          await service.initialize()
          await service.start()
          console.log('[KProxy] Auto-started successfully')
        }
      } catch (error) {
        console.error('[KProxy] Auto-start failed:', error)
      }
    }, 1000)
  })

  mainWindow.on('close', (event) => {
    // Pallet minimization logic - Must be checked and called synchronously preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // Minimize directly to tray
        event.preventDefault()
        mainWindow?.hide()
        // macOS: Hide when window is hidden Dock icon
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // Ask user - Prevent shutdown first, then process it asynchronously
        event.preventDefault()
        // Notify the rendering process to display a custom dialog box
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' Continue closing process when
    }

    // Save data before closing the window (save simultaneously, without waiting for backup)
    if (lastSavedData && store) {
      try {
        console.log('[Window] Saving data before close...')
        store.set('accountData', lastSavedData)
        // Backup is performed asynchronously and does not block shutdown.
        createBackup(lastSavedData).then(() => {
          console.log('[Window] Backup created')
        }).catch(err => {
          console.error('[Window] Backup failed:', err)
        })
        console.log('[Window] Data saved successfully')
      } catch (error) {
        console.error('[Window] Failed to save data:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register a custom agreement
function registerProtocol(): void {
  // Log out the old registration first (to prevent the last abnormal exit from not logging out)
  unregisterProtocol()
  
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        join(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// Unregister custom agreement (Called when the application exits)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        join(process.argv[1])
      ])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// Processing Agreement URL (used for OAuth callback)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // deal with auth callback
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Initialize the log system (intercept as early as possible to ensure all console The output goes into log storage)
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()

  // start up Kiro IDE token File monitoring (reverse synchronization:IDE Own refresh Put the new one later token Synchronize back to generation store）
  // See syncIdeTokenChangeToStore Comment
  startKiroAuthTokenWatcher()

  // Register a custom agreement
  registerProtocol()

  // Load tray settings and initialize the tray
  await loadTraySettings()
  initTray()

  // Initialize automatic updates (production environment only)
  if (!is.dev) {
    setupAutoUpdater()
    // Delay checking for updates after startup
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(console.error)
    }, 3000)
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.kiro.account-manager')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: Open external link
  ipcMain.on('open-external', (_event, url: string, usePrivateMode?: boolean) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (usePrivateMode) {
        openBrowserInPrivateMode(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  // ============ Registration function IPC ============

  // ============ Pallet related IPC ============

  // IPC: Get tray settings
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // ============ Customize titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: Get the shortcut key to display the main window
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: Set the shortcut key to display the main window
  ipcMain.handle('set-show-window-shortcut', async (_event, shortcut: string) => {
    try {
      showWindowShortcut = shortcut
      await saveShortcutSettings()
      registerShowWindowShortcut()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // IPC: Save tray settings
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()
      
      // Enable based on settings/Disable tray
      if (settings.enabled !== undefined) {
        if (settings.enabled) {
          initTray()
        } else {
          destroyTray()
        }
      }
      
      return { success: true }
    } catch (error) {
      console.error('[Tray] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: Update tray account information (called from the render process)
  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)
    
    // Update tray tips
    if (account) {
      setTrayTooltip(`Kiro Account manager\ncurrent account: ${account.email}`)
    } else {
      setTrayTooltip(`Kiro Account manager v${app.getVersion()}`)
    }
  })

  // IPC: Update tray account list (called from render process)
  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: Refresh tray menu
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: Update tray language
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    updateTrayLanguage(language)
  })

  // IPC: Close confirmation dialog response
  ipcMain.on('close-confirm-response', (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
    if (action === 'minimize') {
      mainWindow?.hide()
      // macOS: Hide when window is hidden Dock icon
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide()
      }
    } else if (action === 'quit') {
      // If the user chooses to remember the selection
      if (rememberChoice) {
        traySettings.closeAction = 'quit'
        saveTraySettings()
      }
      isQuitting = true
      app.quit()
    }
    // cancel Do nothing when
    
    // If the user chooses to remember"minimize"choose
    if (action === 'minimize' && rememberChoice) {
      traySettings.closeAction = 'minimize'
      saveTraySettings()
    }
  })

  // IPC: Get application version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: Check for updates
  ipcMain.handle('check-for-updates', async () => {
    if (is.dev) {
      return { hasUpdate: false, message: 'The development environment does not support update checks' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        hasUpdate: !!result?.updateInfo,
        version: result?.updateInfo?.version,
        releaseDate: result?.updateInfo?.releaseDate
      }
    } catch (error) {
      console.error('[AutoUpdater] Check failed:', error)
      return { hasUpdate: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: Download updates
  ipcMain.handle('download-update', async () => {
    if (is.dev) {
      return { success: false, message: 'The development environment does not support updates' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: Install updates and reboot
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // IPC: Check for updates manually (using GitHub API, used for AboutPage）
  const GITHUB_REPO = 'chaogei/Kiro-account-manager'
  const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  
  ipcMain.handle('check-for-updates-manual', async () => {
    try {
      console.log('[Update] Manual check via GitHub API...')
      const currentVersion = app.getVersion()
      
      const response = await fetchWithAppProxy(GITHUB_API_URL, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Kiro-Account-Manager'
        }
      })
      
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('GitHub API The number of requests has exceeded the limit, please try again later.')
        } else if (response.status === 404) {
          throw new Error('Release version not found')
        }
        throw new Error(`GitHub API mistake: ${response.status}`)
      }
      
      const release = await response.json() as {
        tag_name: string
        name: string
        body: string
        html_url: string
        published_at: string
        assets: Array<{
          name: string
          browser_download_url: string
          size: number
        }>
      }
      
      const latestVersion = release.tag_name.replace(/^v/, '')
      
      // Compare version numbers
      const compareVersions = (v1: string, v2: string): number => {
        const parts1 = v1.split('.').map(Number)
        const parts2 = v2.split('.').map(Number)
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
          const p1 = parts1[i] || 0
          const p2 = parts2[i] || 0
          if (p1 > p2) return 1
          if (p1 < p2) return -1
        }
        return 0
      }
      
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      
      console.log(`[Update] Current: ${currentVersion}, Latest: ${latestVersion}, HasUpdate: ${hasUpdate}`)
      
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseNotes: release.body || '',
        releaseName: release.name || `v${latestVersion}`,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        assets: release.assets.map(a => ({
          name: a.name,
          downloadUrl: a.browser_download_url,
          size: a.size
        }))
      }
    } catch (error) {
      console.error('[Update] Manual check failed:', error)
      return {
        hasUpdate: false,
        error: error instanceof Error ? error.message : 'Check for updates failed'
      }
    }
  })

  // ============ One-click diagnosis ============
  /**
   * Test a set of goals URL connectivity (for diagnostic panels)
   * Support designated agents URL;Return the delay and error for each target
   */
  ipcMain.handle('diagnose:run', async (_event, params: {
    proxyUrl?: string
    targets: Array<{ id: string; label: string; url: string; timeoutMs?: number; expectStatus?: number[] }>
  }) => {
    const { proxyUrl, targets } = params || {}
    const agent = proxyUrl ? safeCreateProxyAgent(proxyUrl) : undefined

    const results = await Promise.all((targets || []).map(async (t) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 8000)
      const start = Date.now()
      try {
        const init: UndiciRequestInit = {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'KiroAccountManager-Diagnose/1.0' }
        }
        if (agent) init.dispatcher = agent
        const resp = await undiciFetch(t.url, init)
        const latencyMs = Date.now() - start
        const expected = t.expectStatus
        const ok = expected ? expected.includes(resp.status) : (resp.status >= 200 && resp.status < 400)
        return {
          id: t.id,
          label: t.label,
          url: t.url,
          success: ok,
          httpStatus: resp.status,
          latencyMs,
          error: ok ? undefined : `HTTP ${resp.status}`
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
          id: t.id,
          label: t.label,
          url: t.url,
          success: false,
          latencyMs: Date.now() - start,
          error: controller.signal.aborted ? 'time out' : errMsg
        }
      } finally {
        clearTimeout(timer)
      }
    }))

    return { results }
  })

  // ============ Agent pool verification ============
  /**
   * by designated agent URL Request test address, return delay and exit IP
   * Only supports http/https Agreement agent (subject to undici ProxyAgent limit;socks The agreement will be safeCreateProxyAgent Skip silently)
   */
  // Agent pool related IPC handler Split into independent modules to facilitate subsequent maintenance
  registerProxyPoolIpcHandlers()

  // ============ account-Agent binding (when reverse generation N One account IP）============
  /**
   * Set the export proxy used by the account in anti-generation scenarios URL
   * Also updated: existing accounts in the anti-generation account pool ProxyAccount.proxyUrl + store persistent accountProxyBindings
   */
  ipcMain.handle('account-set-proxy-binding', async (_event, accountId: string, proxyUrl: string | undefined) => {
    try {
      if (!accountId) return { success: false }
      // Update the memory of the anti-generation account pool proxyUrl
      if (proxyServer) {
        const pool = proxyServer.getAccountPool()
        const acc = pool.getAccount(accountId)
        if (acc) {
          acc.proxyUrl = proxyUrl || undefined
          console.log(`[ProxyServer] Account ${acc.email || accountId.slice(0, 8)} proxy ${proxyUrl ? `bound to ${proxyUrl.replace(/:([^:@/]+)@/, ':***@')}` : 'unbound'}`)
        }
      }
      return { success: true }
    } catch (err) {
      console.error('[account-set-proxy-binding] error:', err)
      return { success: false }
    }
  })

  // ============ Universal HTTP diagnostic detection ============
  /**
   * Initiate once using app proxy settings GET/HEAD Request, return delay, status code, error information.
   * used for"One-click diagnosis"Detection in panel Kiro API / Email service / Public network connectivity.
   */
  ipcMain.handle('diagnose:http-probe', async (_event, params: {
    url: string
    method?: 'GET' | 'HEAD'
    timeoutMs?: number
  }) => {
    const { url, method = 'GET', timeoutMs = 5000 } = params || {}
    if (!url) return { success: false, error: 'Missing url' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = Date.now()
    try {
      const resp = await fetchWithAppProxy(url, {
        method,
        signal: controller.signal,
        headers: { 'User-Agent': 'KiroAccountManager-Diagnose/1.0' }
      })
      const latencyMs = Date.now() - start
      return { success: resp.ok, latencyMs, status: resp.status }
    } catch (err) {
      const isAbort = controller.signal.aborted
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: isAbort ? `Timeout (${timeoutMs}ms)` : (err instanceof Error ? err.message : String(err))
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // IPC: Account activity test —— Specify the account to follow the reverse logic (callKiroApi, the same underlying call as the reverse generation server)
  // Send a test message to the specified model to verify whether the account can be returned normally for one-click diagnosis"Account activity test"Function
  ipcMain.handle('diagnose:account-liveness', async (_event, params: {
    account: {
      id?: string
      email?: string
      accessToken?: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp'
      provider?: string
      profileArn?: string
      machineId?: string
      expiresAt?: number
      proxyUrl?: string
    }
    model?: string
    message?: string
    timeoutMs?: number
  }) => {
    const acc = params?.account
    const model = (params?.model || 'claude-sonnet-4.5').trim()
    const message = (params?.message || 'Hi, reply with "pong" only.').trim()
    const timeoutMs = params?.timeoutMs ?? 45000
    const start = Date.now()

    if (!acc || !acc.accessToken) {
      return { success: false, error: 'Account missing accessToken', latencyMs: 0 }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 1) Token Expires soon/Expired → Refresh first (use the account binding agent)
      let accessToken = acc.accessToken
      const needsRefresh = acc.expiresAt ? (acc.expiresAt - Date.now() < 60_000) : false
      if (needsRefresh && acc.refreshToken) {
        try {
          const r = await refreshTokenByMethod(
            acc.refreshToken,
            acc.clientId || '',
            acc.clientSecret || '',
            acc.region || 'us-east-1',
            acc.authMethod,
            acc.proxyUrl
          )
          if (r.success && r.accessToken) accessToken = r.accessToken
        } catch { /* If the refresh fails, the original token Try and let the real mistakes come to light */ }
      }

      // 2) Build ProxyAccount（callKiroApi Account structure required)
      const proxyAccount: ProxyAccount = {
        id: acc.id || 'diagnose',
        email: acc.email,
        accessToken,
        refreshToken: acc.refreshToken,
        clientId: acc.clientId,
        clientSecret: acc.clientSecret,
        region: acc.region || 'us-east-1',
        authMethod: acc.authMethod,
        provider: acc.provider,
        profileArn: acc.profileArn,
        machineId: acc.machineId,
        proxyUrl: acc.proxyUrl,
        expiresAt: acc.expiresAt
      }

      // 3) Build minimal OpenAI chat ask → change Kiro payload
      const payload = openaiToKiro({
        model,
        messages: [{ role: 'user', content: message }],
        stream: false,
        max_tokens: 64
      }, proxyAccount.profileArn)

      // 4) call (exactly the same underlying call as inside the reverse generation server)
      const result = await callKiroApi(proxyAccount, payload, controller.signal)
      const latencyMs = Date.now() - start
      const content = (result.content || '').trim()
      return {
        success: true,
        latencyMs,
        model,
        content: content.slice(0, 500),
        usage: {
          inputTokens: result.usage?.inputTokens || 0,
          outputTokens: result.usage?.outputTokens || 0,
          credits: result.usage?.credits || 0
        }
      }
    } catch (err) {
      const isAbort = controller.signal.aborted
      const rawMsg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        latencyMs: Date.now() - start,
        model,
        error: isAbort ? `time out (${timeoutMs}ms)` : rawMsg
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // IPC: Load account data
  ipcMain.handle('load-accounts', async () => {
    try {
      await initStore()
      return store!.get('accountData', null)
    } catch (error) {
      console.error('Failed to load accounts:', error)
      return null
    }
  })

  // IPC: Save account data
  ipcMain.handle('save-accounts', async (_event, data) => {
    try {
      await initStore()
      store!.set('accountData', data)
      
      // Save last data (for crash recovery)
      lastSavedData = data
      
      // Also creates a backup every time you save
      await createBackup(data)
    } catch (error) {
      console.error('Failed to save accounts:', error)
      throw error
    }
  })

  // IPC: Refresh account Token(support IdC and social login)
  ipcMain.handle('refresh-account-token', async (_event, account) => {
    try {
      const { refreshToken, clientId, clientSecret, region, authMethod, startUrl, provider } = account.credentials || {}

      if (!refreshToken) {
        return { success: false, error: { message: 'Lack Refresh Token' } }
      }

      // Social login only requires refreshToken，IdC Login required clientId and clientSecret
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: { message: 'Lack OIDC Refresh credentials (clientId/clientSecret)' } }
      }

      // Find the agent bound to the account URL(Already in the account pool proxyUrl field)
      const boundProxyUrl = proxyServer
        ? (proxyServer.getAccountPool().getAccount(account.id || '')?.proxyUrl)
        : undefined

      console.log(`[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`)

      // according to authMethod Select the refresh method (transparent transmission of account binding agent)
      const refreshResult = await refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region || 'us-east-1',
        authMethod,
        boundProxyUrl
      )

      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: { message: refreshResult.error || 'Token Refresh failed' } }
      }

      const newAccess = refreshResult.accessToken
      const newRefresh = refreshResult.refreshToken || refreshToken
      const expiresIn = refreshResult.expiresIn ?? 3600

      // bug B Fix: Only if the account is Kiro IDE When the account is currently activated, it is written to disk synchronously. token document
      // Determine priority (any hit is considered"is the currently activated account"）：
      //   1) disk token of refreshToken === renderer incoming account.credentials.refreshToken(most accurate)
      //   2) account.id === lastSwitchedAccountId(Anti-generation of someone who has just had his account cut off)
      // Out-of-sync scenario: What the user refreshes in reverse generation is"Not currently active account", to avoid mistaken coverage IDE Current account
      let syncedToIde = false
      let syncSkipReason: string | undefined
      try {
        const diskToken = await readKiroAuthTokenFile()
        const matchByRefresh = !!diskToken && diskToken.refreshToken === refreshToken
        const matchByLastSwitch = !!account.id && lastSwitchedAccountId === account.id
        if (matchByRefresh || matchByLastSwitch) {
          const resolvedProfileArn = resolveProfileArnForWrite({
            profileArn: account.profileArn,
            authMethod,
            provider,
            region
          })
          await writeKiroAuthTokenFile({
            accessToken: newAccess,
            refreshToken: newRefresh,
            expiresAtIso: new Date(Date.now() + expiresIn * 1000).toISOString(),
            authMethod: (authMethod === 'social' ? 'social' : 'IdC'),
            provider: provider || (diskToken?.provider as string | undefined) || 'BuilderId',
            region: region || diskToken?.region,
            startUrl,
            clientId: clientId || undefined,
            clientSecret: clientSecret || undefined,
            profileArn: resolvedProfileArn
          })
          // Record the signature just written to avoid watcher Trigger reverse sync loopback
          lastWrittenTokenSignature = `${newAccess}|${newRefresh}`
          if (account.id) lastSwitchedAccountId = account.id
          syncedToIde = true
          console.log(`[Refresh] Synced refreshed token to Kiro IDE for account ${account.email || account.id}`)
          // again schedule Active renewal timer(Based on new expiresAt, overwriting any old timer）
          if (proactiveRenewalEnabled && account.id) {
            scheduleProactiveRenewal(account.id, Date.now() + expiresIn * 1000)
          }
        } else {
          syncSkipReason = diskToken
            ? 'This account is not Kiro IDE Currently activated account, skip disk synchronization'
            : 'not found on disk kiro-auth-token.json（IDE Not logged in), skip disk synchronization'
        }
      } catch (e) {
        syncSkipReason = `Disk synchronization exception:${e instanceof Error ? e.message : String(e)}`
        console.warn('[Refresh] Failed to sync token to IDE:', e)
      }

      // Get it automatically after refreshing profileArn(only Enterprise Need to adjust API, other types are not adjusted)
      let resolvedEnterpriseArn: string | undefined
      const existingProfileArn = account.profileArn || account.credentials?.profileArn
      if (!existingProfileArn) {
        const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
        if (isEnt) {
          try {
            resolvedEnterpriseArn = await fetchEnterpriseProfileArn({
              id: account.id || '',
              accessToken: newAccess,
              region: region || 'us-east-1',
              provider,
              authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined,
              machineId: account.machineId
            })
            if (resolvedEnterpriseArn) {
              console.log(`[Refresh] Enterprise profileArn auto-resolved: ${resolvedEnterpriseArn}`)
            }
          } catch (e) {
            console.warn('[Refresh] Failed to fetch Enterprise profileArn:', e)
          }
        }
        // BuilderId/Social Out of tune API, no need to return profileArn(Used for anti-generation and self-healing) resolveProfileArn reveal all the details)
      }

      return {
        success: true,
        data: {
          accessToken: newAccess,
          refreshToken: newRefresh,
          expiresIn,
          // Enterprise automatically obtained profileArn（renderer Need to be stored in account data)
          profileArn: resolvedEnterpriseArn || undefined,
          // let renderer Decide whether to display it to the user"Already synced to IDE"Feedback
          syncedToIde,
          syncSkipReason
        }
      }
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // ============ Active renewal switch IPC ============
  // Once enabled, the account manager will IDE Currently activated account token left PROACTIVE_RENEWAL_LEAD_MS(default 15 minutes) hours
  // Be the first refresh + write to disk,IDE Always get the remainder ≥ 45 minutes token，IDE internal refresh loop will not trigger,
  // completely eliminate IDE Simultaneously with Account Manager refresh Possibility of crash.
  ipcMain.handle('set-proactive-renewal-enabled', async (_event, enabled: boolean) => {
    try {
      await initStore()
      proactiveRenewalEnabled = !!enabled
      store?.set('proactiveRenewalEnabled', proactiveRenewalEnabled)
      console.log(`[ProactiveRenewal] ${proactiveRenewalEnabled ? 'Enabled' : 'Disabled'} by user`)

      if (proactiveRenewalEnabled) {
        // When enabled: If there is currently IDE Activate your account immediately schedule
        if (lastSwitchedAccountId) {
          const accountData = store?.get('accountData') as
            | { accounts?: Record<string, { credentials?: { expiresAt?: number } }> }
            | null
            | undefined
          const acc = accountData?.accounts?.[lastSwitchedAccountId]
          const exp = acc?.credentials?.expiresAt
          if (typeof exp === 'number' && exp > Date.now()) {
            scheduleProactiveRenewal(lastSwitchedAccountId, exp)
          } else {
            console.log('[ProactiveRenewal] No valid expiresAt for current IDE active account, will schedule after next switch/refresh')
          }
        } else {
          console.log('[ProactiveRenewal] No IDE active account recorded yet, will schedule after next switch')
        }
      } else {
        clearProactiveRenewal('disabled by user')
      }
      return { success: true, enabled: proactiveRenewalEnabled }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  ipcMain.handle('get-proactive-renewal-enabled', async () => {
    try {
      await initStore()
      return {
        success: true,
        enabled: !!store?.get('proactiveRenewalEnabled', false),
        leadTimeMinutes: PROACTIVE_RENEWAL_LEAD_MS / 60000
      }
    } catch (error) {
      return {
        success: false,
        enabled: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // IPC: from SSO Token Import account (x-amz-sso_authn)
  ipcMain.handle('import-from-sso-token', async (_event, bearerToken: string, region: string = 'us-east-1') => {
    console.log('[IPC] import-from-sso-token called')
    
    try {
      // implement SSO Device authorization process
      const ssoResult = await ssoDeviceAuth(bearerToken, region)
      
      if (!ssoResult.success || !ssoResult.accessToken) {
        return { success: false, error: { message: ssoResult.error || 'SSO Authorization failed' } }
      }

      // Get user information and usage in parallel
      interface UsageBreakdownItem {
        resourceType?: string
        currentUsage?: number
        currentUsageWithPrecision?: number
        usageLimit?: number
        usageLimitWithPrecision?: number
        displayName?: string
        displayNamePlural?: string
        currency?: string
        unit?: string
        overageRate?: number
        overageCap?: number
        freeTrialInfo?: { currentUsage?: number; currentUsageWithPrecision?: number; usageLimit?: number; usageLimitWithPrecision?: number; freeTrialExpiry?: string; freeTrialStatus?: string }
        bonuses?: Array<{ bonusCode?: string; displayName?: string; currentUsage?: number; currentUsageWithPrecision?: number; usageLimit?: number; usageLimitWithPrecision?: number; expiresAt?: string }>
      }
      interface UsageApiResponse {
        userInfo?: { email?: string; userId?: string }
        subscriptionInfo?: { type?: string; subscriptionTitle?: string; upgradeCapability?: string; overageCapability?: string; subscriptionManagementTarget?: string }
        usageBreakdownList?: UsageBreakdownItem[]
        nextDateReset?: string
        overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
      }

      let userInfo: UserInfoResponse | undefined
      let usageData: UsageApiResponse | undefined

      try {
        console.log('[SSO] Fetching user info and usage data...')
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(ssoResult.accessToken).catch(e => { console.error('[SSO] getUserInfo failed:', e); return undefined }),
          getUsageAndLimits(ssoResult.accessToken, 'BuilderId', undefined, undefined, region).catch(e => { console.error('[SSO] getUsageAndLimits failed:', e); return undefined })
        ])
        userInfo = userInfoResult
        usageData = usageResult
        console.log('[SSO] userInfo:', userInfo?.email)
        console.log('[SSO] usageData:', usageData?.subscriptionInfo?.subscriptionTitle)
      } catch (e) {
        console.error('[IPC] API calls failed:', e)
      }

      // Parse usage data
      const creditUsage = usageData?.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'
      
      // Normalized subscription types (note the order of checks: check more specific types first)
      let subscriptionType = 'Free'
      const titleUpper = subscriptionTitle.toUpperCase()
      if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
        subscriptionType = 'Pro_Plus'
      } else if (titleUpper.includes('POWER')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (titleUpper.includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // Basic amount (use exact decimals)
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

      // Trial amount (use exact decimal)
      let freeTrialLimit = 0, freeTrialCurrent = 0, freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // Reward amount (use exact decimal)
      const bonuses = (creditUsage?.bonuses || []).map(b => ({
        code: b.bonusCode || '',
        name: b.displayName || '',
        current: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
        limit: b.usageLimitWithPrecision ?? b.usageLimit ?? 0,
        expiresAt: b.expiresAt
      }))

      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
      const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

      return {
        success: true,
        data: {
          accessToken: ssoResult.accessToken,
          refreshToken: ssoResult.refreshToken,
          clientId: ssoResult.clientId,
          clientSecret: ssoResult.clientSecret,
          region: ssoResult.region,
          expiresIn: ssoResult.expiresIn,
          email: usageData?.userInfo?.email || userInfo?.email,
          userId: usageData?.userInfo?.userId || userInfo?.userId,
          idp: userInfo?.idp || 'BuilderId',
          status: userInfo?.status,
          subscriptionType,
          subscriptionTitle,
          subscription: {
            managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
            upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
            overageCapability: usageData?.subscriptionInfo?.overageCapability
          },
          usage: {
            current: totalCurrent,
            limit: totalLimit,
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses,
            nextResetDate: usageData?.nextDateReset,
            resourceDetail: creditUsage ? {
              displayName: creditUsage.displayName,
              displayNamePlural: creditUsage.displayNamePlural,
              resourceType: creditUsage.resourceType,
              currency: creditUsage.currency,
              unit: creditUsage.unit,
              overageRate: creditUsage.overageRate,
              overageCap: creditUsage.overageCap,
              overageEnabled: usageData?.overageConfiguration?.overageStatus === 'ENABLED' || usageData?.overageConfiguration?.overageEnabled === true
            } : undefined
          },
          daysRemaining: usageData?.nextDateReset ? Math.max(0, Math.ceil((new Date(usageData.nextDateReset).getTime() - Date.now()) / 86400000)) : undefined
        }
      }
    } catch (error) {
      console.error('[IPC] import-from-sso-token error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: Check account status (supports automatic refresh Token）
  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      status?: string
      expiresAt?: string  // API What is returned is expiresAt
    }

    interface FreeTrialInfo {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }

    interface UsageBreakdown {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      bonuses?: Bonus[]
      freeTrialInfo?: FreeTrialInfo
    }

    interface SubscriptionInfo {
      subscriptionTitle?: string
      type?: string
      upgradeCapability?: string
      overageCapability?: string
      subscriptionManagementTarget?: string
    }

    interface UserInfo {
      email?: string
      userId?: string
    }

    interface OverageConfiguration {
      overageEnabled?: boolean
      overageStatus?: string
    }

    interface UsageResponse {
      daysUntilReset?: number
      nextDateReset?: string
      usageBreakdownList?: UsageBreakdown[]
      overageConfiguration?: OverageConfiguration
      subscriptionInfo?: SubscriptionInfo
      userInfo?: UserInfo
    }

    // parse API Response helper function
    const parseUsageResponse = (result: UsageResponse, newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresIn?: number
    }, userInfo?: UserInfoResponse) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || 'unknown'}]`, result)

      // parse Credits Usage (resourceType for CREDIT）
      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // Parse usage (verbose, use exact decimals)
      // Basic amount
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // Trial amount
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // Reward amount
      const bonusesData: { code: string; name: string; current: number; limit: number; expiresAt?: string }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonusesData.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }
      
      // Calculate total amount
      const totalLimit = baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      const nextResetDate = result.nextDateReset

      // Parse subscription type
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // Parse reset time and calculate remaining days
      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime()
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // Resource details
      const resourceDetail = creditUsage ? {
        resourceType: creditUsage.resourceType,
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: result.overageConfiguration?.overageStatus === 'ENABLED' || result.overageConfiguration?.overageEnabled === true
      } : undefined

      return {
        success: true,
        data: {
          status: (!userInfo?.status || userInfo.status === 'Active' || userInfo.status === 'Stale') ? 'active' : 'error',
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // If refreshed token, return new credentials
          newCredentials: newCredentials ? {
            accessToken: newCredentials.accessToken,
            refreshToken: newCredentials.refreshToken,
            expiresAt: newCredentials.expiresIn 
              ? Date.now() + newCredentials.expiresIn * 1000 
              : undefined
          } : undefined
        }
      }
    }

    try {
      const { accessToken, refreshToken, clientId, clientSecret, region, authMethod, provider } = account.credentials || {}

      // Query the agent bound to the account (account pool)
      const boundProxyUrl = proxyServer
        ? proxyServer.getAccountPool().getAccount(account.id || '')?.proxyUrl
        : undefined

      // determine the correct idp: priority use credentials.provider, otherwise fall back to account.idp
      // social login using actual provider (Github/Google)，IdC use BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!accessToken) {
        console.log('[IPC] Missing accessToken')
        return { success: false, error: { message: 'Lack accessToken' } }
      }

      // Get the device bound to the account ID
      const accountMachineId = account?.machineId as string | undefined

      // First try: use current accessToken
      try {
        // Parallel calls GetUserInfo and getUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(accessToken, idp, accountMachineId, account?.email).catch((err: Error) => {
            // Banning errors cannot be swallowed and must be thrown upwards
            if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
              throw err
            }
            return undefined
          }),
          getUsageAndLimits(accessToken, idp, undefined, accountMachineId, region, account?.email)
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''
        
        // Check if it is an explicit ban error (423 or AccountSuspendedException）
        if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
          console.log('[IPC] Account suspended/banned')
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          }
        }
        
        // Check if it is 401 mistake(token Expired)
        // Social login only requires refreshToken，IdC Login required clientId and clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          console.log(`[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`)

          // try to refresh token - according to authMethod Select the refresh method (transparent account proxy)
          const refreshResult = await refreshTokenByMethod(
            refreshToken,
            clientId || '',
            clientSecret || '',
            region || 'us-east-1',
            authMethod,
            boundProxyUrl
          )
          
          if (refreshResult.success && refreshResult.accessToken) {
            console.log('[IPC] Token refreshed, retrying API call...')
            
            // Use new token Parallel calls GetUserInfo and getUsageAndLimits
            const [userInfoResult, usageResult] = await Promise.all([
              getUserInfo(refreshResult.accessToken, idp, accountMachineId).catch((err: Error) => {
                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return undefined
              }),
              getUsageAndLimits(refreshResult.accessToken, idp, undefined, accountMachineId, region)
            ])
            
            // Return the result and include the new credentials
            return parseUsageResponse(usageResult, {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresIn: refreshResult.expiresIn
            }, userInfoResult)
          } else {
            console.error('[IPC] Token refresh failed:', refreshResult.error)
            return {
              success: false,
              error: { message: `Token Expired and failed to refresh: ${refreshResult.error}` }
            }
          }
        }
        
        // no 401 Or the credentials are not refreshed and the original error is thrown.
        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: Refresh accounts in batches in the background (executed in the main process, without blocking UI）
  const backgroundBatchRefresh = async (accounts: BackgroundRefreshAccount[], concurrency: number = 10, syncInfo: boolean = true): Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }> => {
    console.log(`[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`)
    
    let completed = 0
    let success = 0
    let failed = 0

    // Process each batch serially to avoid excessive concurrency
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)
      
      await Promise.allSettled(
        batch.map(async (account) => {
          // Deduplication: The rendering process timer and the main process scheduler may trigger refresh at the same time.
          // Concurrent refreshes on the same account will cause one of them to be used rotate obsolete old refreshToken。
          // If you are already on the way, skip this time (success or failure will not be counted, just wait for the results of the time on the way to be returned).
          if (account.id && poolRefreshInFlightIds.has(account.id)) {
            return
          }
          if (account.id) poolRefreshInFlightIds.add(account.id)
          try {
            const { refreshToken, clientId, clientSecret, region, authMethod, accessToken, provider } = account.credentials
            const needsTokenRefresh = account.needsTokenRefresh !== false // Default is true(compatible with older versions)

            // Query the agent bound to the account (from the main process account pool)
            const boundProxyUrl = proxyServer
              ? proxyServer.getAccountPool().getAccount(account.id)?.proxyUrl
              : undefined

            // determine the correct idp
            let idp = 'BuilderId'
            if (authMethod === 'social') {
              idp = provider || account.idp || 'BuilderId'
            } else if (provider) {
              idp = provider
            }
            
            let newAccessToken = accessToken
            let newRefreshToken = refreshToken
            let newExpiresIn: number | undefined

            // Only need to refresh Token Refresh only when
            if (needsTokenRefresh) {
              if (!refreshToken) {
                failed++
                completed++
                return
              }

              // refresh Token(Transparent account binding agent)
              const refreshResult = await refreshTokenByMethod(
                refreshToken,
                clientId || '',
                clientSecret || '',
                region || 'us-east-1',
                authMethod,
                boundProxyUrl
              )

              if (!refreshResult.success) {
                failed++
                completed++
                // Notify the rendering process that the refresh failed
                mainWindow?.webContents.send('background-refresh-result', {
                  id: account.id,
                  success: false,
                  error: refreshResult.error
                })
                return
              }

              newAccessToken = refreshResult.accessToken || accessToken
              newRefreshToken = refreshResult.refreshToken || refreshToken
              newExpiresIn = refreshResult.expiresIn

              // Only if the account is Kiro IDE When the account is currently activated, synchronize the new token to disk token document.
              // otherwise IDE exist ~50min will be used on disk later"Invalidated by automatic refresh"old refreshToken tune OIDC → 401 → logoutAndForget。
              // Determine priority (any hit):1) disk refresh Match account  2) lastSwitchedAccountId match
              if (newAccessToken && newRefreshToken && newExpiresIn) {
                try {
                  const diskToken = await readKiroAuthTokenFile()
                  const matchByRefresh = !!diskToken && diskToken.refreshToken === refreshToken
                  const matchByLastSwitch = lastSwitchedAccountId === account.id
                  if (matchByRefresh || matchByLastSwitch) {
                    const resolvedProfileArn = resolveProfileArnForWrite({
                      profileArn: diskToken?.profileArn,
                      authMethod,
                      provider,
                      region
                    })
                    await writeKiroAuthTokenFile({
                      accessToken: newAccessToken,
                      refreshToken: newRefreshToken,
                      expiresAtIso: new Date(Date.now() + newExpiresIn * 1000).toISOString(),
                      authMethod: (authMethod === 'social' ? 'social' : 'IdC'),
                      provider: provider || (diskToken?.provider as string | undefined) || 'BuilderId',
                      region: region || diskToken?.region,
                      // background-batch-refresh Didn't pass startUrl,but disk of clientIdHash no longer changes;
                      // helper Will use the default startUrl Calculate the same hash, written client The registration file path will not change
                      clientId: clientId || undefined,
                      clientSecret: clientSecret || undefined,
                      profileArn: resolvedProfileArn
                    })
                    lastWrittenTokenSignature = `${newAccessToken}|${newRefreshToken}`
                    if (account.id) lastSwitchedAccountId = account.id
                    console.log(`[BackgroundRefresh] Synced refreshed token to Kiro IDE for account ${account.id}`)
                    if (proactiveRenewalEnabled && account.id) {
                      scheduleProactiveRenewal(account.id, Date.now() + newExpiresIn * 1000)
                    }
                  }
                } catch (e) {
                  console.warn(`[BackgroundRefresh] sync to IDE failed for ${account.id}:`, e)
                }
              }
            }

            // Enterprise Account: automatically obtained after background refresh profileArn（BuilderId/Social No need to adjust API）
            const existingProfileArn = account.profileArn || account.credentials?.profileArn
            let resolvedBgProfileArn: string | undefined
            const isEnt = (provider || account.idp) === 'Enterprise' || authMethod === 'external_idp'
            if (!existingProfileArn && newAccessToken && isEnt) {
              try {
                resolvedBgProfileArn = await fetchEnterpriseProfileArn({
                  id: account.id || '',
                  accessToken: newAccessToken,
                  region: region || 'us-east-1',
                  provider: provider || account.idp,
                  authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined,
                  machineId: account.machineId
                })
                if (resolvedBgProfileArn) {
                  console.log(`[BackgroundRefresh] Enterprise profileArn auto-resolved: ${resolvedBgProfileArn} (${account.id})`)
                }
              } catch (e) {
                console.warn(`[BackgroundRefresh] Failed to fetch Enterprise profileArn for ${account.id}:`, e)
              }
            }

            // Get account information
            if (!newAccessToken) {
              failed++
              completed++
              return
            }

            // according to syncInfo Decide whether to check account information
            let parsedUsage: {
              current: number
              limit: number
              baseCurrent: number
              baseLimit: number
              freeTrialCurrent: number
              freeTrialLimit: number
              freeTrialExpiry?: string
              bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
              nextResetDate?: string
              resourceDetail?: {
                displayName?: string
                displayNamePlural?: string
                resourceType?: string
                currency?: string
                unit?: string
                overageRate?: number
                overageCap?: number
                overageEnabled?: boolean
              }
            } | undefined
            let userInfoData: UserInfoResponse | undefined
            let subscriptionData: { type: string; title: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string } | undefined
            let status = 'active'
            let errorMessage: string | undefined

            if (syncInfo) {
              // call getUsageAndLimits API(Select according to configuration REST or CBOR Format)
              try {
                interface UsageBreakdownItem {
                  resourceType?: string
                  displayName?: string
                  currentUsage?: number
                  currentUsageWithPrecision?: number
                  usageLimit?: number
                  usageLimitWithPrecision?: number
                  freeTrialInfo?: {
                    freeTrialStatus?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialExpiry?: string
                  }
                  bonuses?: Array<{
                    bonusCode?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    expiresAt?: string
                    status?: string
                  }>
                }
                interface UsageResponse {
                  usageBreakdownList?: UsageBreakdownItem[]
                  nextDateReset?: string
                  subscriptionInfo?: {
                    subscriptionTitle?: string
                    type?: string
                    overageCapability?: string
                    upgradeCapability?: string
                    subscriptionManagementTarget?: string
                  }
                  overageConfiguration?: {
                    overageStatus?: string
                    overageEnabled?: boolean
                    overageLimit?: number | null
                  }
                }
                console.log(`[BackgroundRefresh] Account ${account.id} machineId: ${account.machineId || 'undefined'}`)
                const rawUsage = await getUsageAndLimits(newAccessToken, idp, undefined, account.machineId, region) as UsageResponse
                
                // Parse usage data
                const creditUsage = rawUsage.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
                const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                let freeTrialCurrent = 0
                let freeTrialLimit = 0
                let freeTrialExpiry: string | undefined
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                  freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
                  freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                }
                const bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }> = []
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === 'ACTIVE') {
                      bonuses.push({
                        code: bonus.bonusCode || '',
                        name: bonus.displayName || '',
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      })
                    }
                  }
                }
                const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
                
                parsedUsage = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset,
                  resourceDetail: creditUsage ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: (creditUsage as { displayNamePlural?: string }).displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: (creditUsage as { currency?: string }).currency,
                    unit: (creditUsage as { unit?: string }).unit,
                    overageRate: (creditUsage as { overageRate?: number }).overageRate,
                    overageCap: (creditUsage as { overageCap?: number }).overageCap,
                    overageEnabled: rawUsage.overageConfiguration?.overageStatus === 'ENABLED' || rawUsage.overageConfiguration?.overageEnabled === true
                  } : undefined
                }
                
                // Parse subscription information (note the order of checks: check more specific types first)
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle || 'Free'
                let subscriptionType = 'Free'
                const titleUpper = subscriptionTitle.toUpperCase()
                if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
                  subscriptionType = 'Pro_Plus'
                } else if (titleUpper.includes('POWER')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('PRO')) {
                  subscriptionType = 'Pro'
                } else if (titleUpper.includes('ENTERPRISE')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('TEAMS')) {
                  subscriptionType = 'Teams'
                }
                
                // Calculate remaining days and expiration time
                let daysRemaining: number | undefined
                let expiresAt: number | undefined
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime()
                  daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
                }
                
                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
                }
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                console.log(`[BackgroundRefresh] Usage API error for ${account.id}:`, errMsg)
                if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }

              // call GetUserInfo API Get user status
              try {
                userInfoData = await getUserInfo(newAccessToken, idp, account.machineId)
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }
            }

            success++
            completed++

            // Notify the rendering process to update the account
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: true,
              data: {
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
                expiresIn: newExpiresIn,
                profileArn: resolvedBgProfileArn || undefined,
                usage: parsedUsage,
                subscription: subscriptionData,
                userInfo: syncInfo ? userInfoData : undefined,
                status,
                errorMessage
              }
            })
          } catch (e) {
            failed++
            completed++
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: false,
              error: e instanceof Error ? e.message : 'Unknown error'
            })
          } finally {
            if (account.id) poolRefreshInFlightIds.delete(account.id)
          }
        })
      )

      // Notify progress
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // Delay between batches to give the main process breathing time
      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  }
  // Exposed to the main process scheduler for reuse (startMainPoolTokenRefresh）
  backgroundBatchRefreshImpl = backgroundBatchRefresh
  ipcMain.handle('background-batch-refresh', (_event, accounts: BackgroundRefreshAccount[], concurrency: number = 10, syncInfo: boolean = true) => backgroundBatchRefresh(accounts, concurrency, syncInfo))
  // Start the main process pool token Refresh scheduler (does not depend on window being visible)/Survive, the hanging tray is also refreshed as usual)
  startMainPoolTokenRefresh()

  // IPC: Check account status in batches in the background (without refreshing Token, only check status)
  ipcMain.handle('background-batch-check', async (_event, accounts: Array<{
    id: string
    email: string
    credentials: {
      accessToken: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      provider?: string
    }
    idp?: string
  }>, concurrency: number = 10) => {
    console.log(`[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`)
    
    let completed = 0
    let success = 0
    let failed = 0

    // Process each batch serially
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)
      
      await Promise.allSettled(
        batch.map(async (account) => {
          try {
            const { accessToken, authMethod, provider } = account.credentials
            
            if (!accessToken) {
              failed++
              completed++
              mainWindow?.webContents.send('background-check-result', {
                id: account.id,
                success: false,
                error: 'Lack accessToken'
              })
              return
            }

            // Sure idp
            let idp = account.idp || 'BuilderId'
            if (authMethod === 'social' && provider) {
              idp = provider
            }

            // call API Get usage and user information (selected based on configuration REST or CBOR Format)
            const [usageRes, userInfoRes] = await Promise.allSettled([
              getUsageAndLimits(accessToken, idp, undefined, undefined, account.credentials?.region, account.email) as Promise<{
                usageBreakdownList?: Array<{
                  resourceType?: string
                  displayName?: string
                  usageLimit?: number
                  usageLimitWithPrecision?: number
                  currentUsage?: number
                  currentUsageWithPrecision?: number
                  freeTrialInfo?: {
                    freeTrialStatus?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialExpiry?: string
                  }
                  bonuses?: Array<{
                    bonusCode?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    expiresAt?: string
                    status?: string
                  }>
                }>
                nextDateReset?: string
                subscriptionInfo?: {
                  subscriptionTitle?: string
                  type?: string
                  overageCapability?: string
                  upgradeCapability?: string
                  subscriptionManagementTarget?: string
                }
                overageConfiguration?: {
                  overageStatus?: string
                  overageEnabled?: boolean
                  overageLimit?: number | null
                }
                userInfo?: {
                  email?: string
                  userId?: string
                }
              }>,
              kiroApiRequest<{
                email?: string
                userId?: string
                status?: string
                idp?: string
              }>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, undefined, account.email).catch((err: Error) => {
                // Banning errors cannot be swallowed and need to be detected in subsequent logic.
                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return null
              })
            ])

            // parse response(kiroApiRequest Return data directly or throw an exception)
            let usageData: {
              current: number
              limit: number
              baseCurrent?: number
              baseLimit?: number
              freeTrialCurrent?: number
              freeTrialLimit?: number
              freeTrialExpiry?: string
              bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
              nextResetDate?: string
            } | null = null
            let subscriptionData: {
              type: string
              title: string
              daysRemaining?: number
              expiresAt?: number
              overageCapability?: string
              upgradeCapability?: string
              subscriptionManagementTarget?: string
            } | null = null
            let resourceDetail: {
              displayName?: string
              displayNamePlural?: string
              resourceType?: string
              currency?: string
              unit?: string
              overageRate?: number
              overageCap?: number
              overageEnabled?: boolean
            } | undefined
            let userInfoData: {
              email?: string
              userId?: string
              status?: string
            } | null = null
            let status = 'active'
            let errorMessage: string | undefined

            // Handling usage responses
            if (usageRes.status === 'fulfilled') {
              const rawUsage = usageRes.value
              // parse Credits Usage (same as single check)
              const creditUsage = rawUsage.usageBreakdownList?.find(
                (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
              )
              
              const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
              const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
              let freeTrialCurrent = 0
              let freeTrialLimit = 0
              let freeTrialExpiry: string | undefined
              if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
                freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
                freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
              }
              
              // parse bonuses
              const bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }> = []
              if (creditUsage?.bonuses) {
                for (const bonus of creditUsage.bonuses) {
                  if (bonus.status === 'ACTIVE') {
                    bonuses.push({
                      code: bonus.bonusCode || '',
                      name: bonus.displayName || '',
                      current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                      limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                      expiresAt: bonus.expiresAt
                    })
                  }
                }
              }
              
              const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
              const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
              
              usageData = {
                current: totalCurrent,
                limit: totalLimit,
                baseCurrent,
                baseLimit,
                freeTrialCurrent,
                freeTrialLimit,
                freeTrialExpiry,
                bonuses,
                nextResetDate: rawUsage.nextDateReset
              }

              // Parse resource details (including excess information)
              if (creditUsage) {
                resourceDetail = {
                  displayName: creditUsage.displayName,
                  displayNamePlural: (creditUsage as { displayNamePlural?: string }).displayNamePlural,
                  resourceType: creditUsage.resourceType,
                  currency: (creditUsage as { currency?: string }).currency,
                  unit: (creditUsage as { unit?: string }).unit,
                  overageRate: (creditUsage as { overageRate?: number }).overageRate,
                  overageCap: (creditUsage as { overageCap?: number }).overageCap,
                  overageEnabled: rawUsage.overageConfiguration?.overageStatus === 'ENABLED' || rawUsage.overageConfiguration?.overageEnabled === true
                }
              }

              // Parse subscription information (note the order of checks: check more specific types first)
              const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle ?? 'Free'
              let subscriptionType = 'Free'
              const titleUpper = subscriptionTitle.toUpperCase()
              if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
                subscriptionType = 'Pro_Plus'
              } else if (titleUpper.includes('POWER')) {
                subscriptionType = 'Enterprise'
              } else if (titleUpper.includes('PRO')) {
                subscriptionType = 'Pro'
              } else if (titleUpper.includes('ENTERPRISE')) {
                subscriptionType = 'Enterprise'
              } else if (titleUpper.includes('TEAMS')) {
                subscriptionType = 'Teams'
              }
              
              // Calculate remaining days and expiration time
              let daysRemaining: number | undefined
              let expiresAt: number | undefined
              if (rawUsage.nextDateReset) {
                expiresAt = new Date(rawUsage.nextDateReset).getTime()
                daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
              }
              
              subscriptionData = {
                type: subscriptionType,
                title: subscriptionTitle,
                daysRemaining,
                expiresAt,
                overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
              }
            } else if (usageRes.status === 'rejected') {
              // API The call failed (possibly due to ban or Token Expired)
              const errorMsg = usageRes.reason?.message || String(usageRes.reason)
              console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
              if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
                status = 'error'
                errorMessage = errorMsg
              } else if (errorMsg.includes('401')) {
                status = 'expired'
                errorMessage = 'Token Expired, please refresh'
              } else {
                status = 'error'
                errorMessage = errorMsg
              }
            }

            // Handle user information response
            if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
              const rawUserInfo = userInfoRes.value
              userInfoData = {
                email: rawUserInfo.email,
                userId: rawUserInfo.userId,
                status: rawUserInfo.status
              }
              // Check user status (Stale considered normal, only Suspended/Disabled etc. as abnormal)
              if (rawUserInfo.status && rawUserInfo.status !== 'Active' && rawUserInfo.status !== 'Stale' && status !== 'error') {
                status = 'error'
                errorMessage = `Abnormal user status: ${rawUserInfo.status}`
              }
            } else if (userInfoRes.status === 'rejected') {
              // GetUserInfo Failed (banning error will go here)
              const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
              if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
                status = 'error'
                errorMessage = errMsg
              }
            }

            success++
            completed++

            // Notify the rendering process to update the account
            mainWindow?.webContents.send('background-check-result', {
              id: account.id,
              success: true,
              data: {
                usage: usageData ? { ...usageData, resourceDetail } : null,
                subscription: subscriptionData,
                userInfo: userInfoData,
                status,
                errorMessage
              }
            })
          } catch (e) {
            failed++
            completed++
            mainWindow?.webContents.send('background-check-result', {
              id: account.id,
              success: false,
              error: e instanceof Error ? e.message : 'Unknown error'
            })
          }
        })
      )

      // Notify progress
      mainWindow?.webContents.send('background-check-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // inter-batch delay
      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  })

  // IPC: export to file
  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export account data',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  // IPC: import from file
  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Import account data',
        filters: [
          { name: 'All supported formats', extensions: ['json', 'csv', 'txt'] },
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'TXT Files', extensions: ['txt'] }
        ],
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const ext = filePath.split('.').pop()?.toLowerCase() || 'json'
        return { content, format: ext }
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })

  // IPC: Verify credentials and obtain account information (used to add accounts)
  ipcMain.handle('verify-account-credentials', async (_event, credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string
    provider?: string  // 'BuilderId', 'Github', 'Google' wait
  }) => {
    console.log('[IPC] verify-account-credentials called')
    
    try {
      const { refreshToken, clientId, clientSecret, region = 'us-east-1', authMethod, provider } = credentials
      // Sure idp: Social login use provider，IdC It also needs to be based on provider distinguish BuilderId and Enterprise
      const idp = provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google') 
        ? provider 
        : 'BuilderId'
      
      // Social login only requires refreshToken，IdC need clientId and clientSecret
      if (!refreshToken) {
        return { success: false, error: 'Please fill in Refresh Token' }
      }
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: 'Please fill in Client ID and Client Secret' }
      }
      
      // Step 1: Use the appropriate method to refresh the acquisition accessToken
      console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
      const refreshResult = await refreshTokenByMethod(refreshToken, clientId, clientSecret, region, authMethod)
      
      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: `Token Refresh failed: ${refreshResult.error}` }
      }
      
      console.log('[Verify] Step 2: Getting user info...')
      
      // Step 2: call GetUserUsageAndLimits Get user information
      interface Bonus {
        bonusCode?: string
        displayName?: string
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        status?: string
        expiresAt?: string  // API What is returned is expiresAt
      }
      
      interface FreeTrialInfo {
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        freeTrialStatus?: string
        freeTrialExpiry?: string
      }
      
      interface UsageBreakdown {
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        resourceType?: string
        displayName?: string
        displayNamePlural?: string
        currency?: string
        unit?: string
        overageRate?: number
        overageCap?: number
        bonuses?: Bonus[]
        freeTrialInfo?: FreeTrialInfo
      }
      
      interface UsageResponse {
        nextDateReset?: string
        usageBreakdownList?: UsageBreakdown[]
        subscriptionInfo?: { 
          subscriptionTitle?: string
          type?: string
          subscriptionManagementTarget?: string
          upgradeCapability?: string
          overageCapability?: string
        }
        overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
        userInfo?: { email?: string; userId?: string }
      }
      
      const usageResult = await getUsageAndLimits(refreshResult.accessToken, idp, undefined, undefined, region) as UsageResponse
      
      // Parse user information
      const email = usageResult.userInfo?.email || ''
      const userId = usageResult.userInfo?.userId || ''
      
      // Parse subscription types (note the order of checks: check more specific types first)
      const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
      let subscriptionType = 'Free'
      const titleUpper = subscriptionTitle.toUpperCase()
      if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
        subscriptionType = 'Pro_Plus'
      } else if (titleUpper.includes('POWER')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (titleUpper.includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('TEAMS')) {
        subscriptionType = 'Teams'
      }
      
      // Parse usage (verbose, use exact decimals)
      const creditUsage = usageResult.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      
      // Basic amount
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // Trial amount
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // Reward amount
      const bonuses: { code: string; name: string; current: number; limit: number; expiresAt?: string }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonuses.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }
      
      // Calculate total amount
      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
      
      // Calculate days remaining for reset
      let daysRemaining: number | undefined
      let expiresAt: number | undefined
      const nextResetDate = usageResult.nextDateReset
      if (nextResetDate) {
        expiresAt = new Date(nextResetDate).getTime()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
      }
      
      console.log('[Verify] Success! Email:', email)

      // Enterprise Account: automatically obtained during verification profileArn（BuilderId/Social No need to adjust API）
      let enterpriseProfileArn: string | undefined
      const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
      if (isEnt) {
        try {
          enterpriseProfileArn = await fetchEnterpriseProfileArn({
            id: '',
            accessToken: refreshResult.accessToken!,
            region: region || 'us-east-1',
            provider,
            authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined
          })
          if (enterpriseProfileArn) {
            console.log(`[Verify] Enterprise profileArn auto-resolved: ${enterpriseProfileArn}`)
          }
        } catch (e) {
          console.warn('[Verify] Failed to fetch Enterprise profileArn:', e)
        }
      }
      
      return {
        success: true,
        data: {
          email,
          userId,
          accessToken: refreshResult.accessToken,
          refreshToken: refreshResult.refreshToken || refreshToken,
          expiresIn: refreshResult.expiresIn,
          profileArn: enterpriseProfileArn || undefined,
          subscriptionType,
          subscriptionTitle,
          subscription: {
            rawType: usageResult.subscriptionInfo?.type,
            managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
            upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
            overageCapability: usageResult.subscriptionInfo?.overageCapability
          },
          usage: {
            current: totalUsed,
            limit: totalLimit,
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses,
            nextResetDate,
            resourceDetail: creditUsage ? {
              displayName: creditUsage.displayName,
              displayNamePlural: creditUsage.displayNamePlural,
              resourceType: creditUsage.resourceType,
              currency: creditUsage.currency,
              unit: creditUsage.unit,
              overageRate: creditUsage.overageRate,
              overageCap: creditUsage.overageCap,
              overageEnabled: usageResult.overageConfiguration?.overageStatus === 'ENABLED' || usageResult.overageConfiguration?.overageEnabled === true
            } : undefined
          },
          daysRemaining,
          expiresAt
        }
      }
    } catch (error) {
      console.error('[Verify] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Authentication failed' }
    }
  })

  // IPC: Get local SSO The account information currently used in the cache
  ipcMain.handle('get-local-active-account', async () => {
    const os = await import('os')
    const path = await import('path')
    
    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      
      const tokenContent = await readFile(tokenPath, 'utf-8')
      const tokenData = JSON.parse(tokenContent)
      
      if (!tokenData.refreshToken) {
        return { success: false, error: 'Not in local cache refreshToken' }
      }
      
      return {
        success: true,
        data: {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
          authMethod: tokenData.authMethod,
          provider: tokenData.provider
        }
      }
    } catch {
      return { success: false, error: 'Unable to read local SSO cache' }
    }
  })

  // IPC: from Kiro Local configuration import credentials
  ipcMain.handle('load-kiro-credentials', async () => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const fs = await import('fs/promises')
    
    try {
      // from ~/.aws/sso/cache/kiro-auth-token.json read token
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      console.log('[Kiro Credentials] Reading token from:', tokenPath)
      
      let tokenData: {
        accessToken?: string
        refreshToken?: string
        clientIdHash?: string
        region?: string
        authMethod?: string
        provider?: string
      }
      
      try {
        const tokenContent = await readFile(tokenPath, 'utf-8')
        tokenData = JSON.parse(tokenContent)
      } catch {
        return { success: false, error: 'not found kiro-auth-token.json file, please first Kiro IDE Log in' }
      }
      
      if (!tokenData.refreshToken) {
        return { success: false, error: 'kiro-auth-token.json missing in refreshToken' }
      }
      
      // Sure clientIdHash: Use the one in the file first, otherwise calculate the default value
      let clientIdHash = tokenData.clientIdHash
      if (!clientIdHash) {
        // Use standard startUrl calculate hash(and Kiro Client consistent)
        const startUrl = 'https://view.awsapps.com/start'
        clientIdHash = crypto.createHash('sha1')
          .update(JSON.stringify({ startUrl }))
          .digest('hex')
        console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
      }
      
      // Read client registration information
      let clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
      console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)
      
      let clientData: {
        clientId?: string
        clientSecret?: string
      } | null = null
      
      try {
        const clientContent = await readFile(clientRegPath, 'utf-8')
        clientData = JSON.parse(clientContent)
      } catch {
        // If not found, try searching the directory for other .json files (exclude kiro-auth-token.json）
        console.log('[Kiro Credentials] Client file not found, searching cache directory...')
        try {
          const files = await fs.readdir(ssoCache)
          for (const file of files) {
            if (file.endsWith('.json') && file !== 'kiro-auth-token.json') {
              try {
                const content = await readFile(path.join(ssoCache, file), 'utf-8')
                const data = JSON.parse(content)
                if (data.clientId && data.clientSecret) {
                  clientData = data
                  console.log('[Kiro Credentials] Found client registration in:', file)
                  break
                }
              } catch {
                // Ignore unresolved files
              }
            }
          }
        } catch {
          // Ignore directory read errors
        }
      }
      
      // Social login not required clientId/clientSecret
      const isSocialAuth = tokenData.authMethod === 'social'
      
      if (!isSocialAuth && (!clientData || !clientData.clientId || !clientData.clientSecret)) {
        return { success: false, error: 'The client registration file cannot be found, please make sure it is Kiro IDE Complete login in' }
      }
      
      console.log(`[Kiro Credentials] Successfully loaded credentials (authMethod: ${tokenData.authMethod || 'IdC'})`)
      
      return {
        success: true,
        data: {
          accessToken: tokenData.accessToken || '',
          refreshToken: tokenData.refreshToken,
          clientId: clientData?.clientId || '',
          clientSecret: clientData?.clientSecret || '',
          region: tokenData.region || 'us-east-1',
          authMethod: tokenData.authMethod || 'IdC',
          provider: tokenData.provider || 'BuilderId'
        }
      }
    } catch (error) {
      console.error('[Kiro Credentials] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'unknown error' }
    }
  })

  // IPC: Switch account - Write credentials to local SSO cache
  //
  // Key design: Before cutting number, you must first refresh Once, but not the same as the old implementation -
  //   1. (bug A repair) Bundle OIDC return new refreshToken Also writes to disk
  //      (Old implementations only update accessToken，refreshToken Still has been server-side rotate void v1，
  //       lead to Kiro IDE ~55min for later use v1 refresh → 401 → logoutAndForget）
  //   2. (bug C repair) expiresAt use OIDC return true expiresIn, no longer hard-coded 3600
  //   3. (bug D repair) refresh When failure occurs, an error is reported directly and the file is refused to be written to avoid burying the hatchet.
  //   4. (bug F support) pass refreshedCredentials put new refresh return renderer, let the anti-generation store synchronous
  //   5. Record lastSwitchedAccountId,for fs.watch Used as a backup for account matching during reverse synchronization
  ipcMain.handle('switch-account', async (_event, credentials: {
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    startUrl?: string
    authMethod?: 'IdC' | 'social'
    provider?: 'BuilderId' | 'Github' | 'Google' | 'Enterprise'
    profileArn?: string
    accountId?: string
  }) => {
    try {
      const {
        refreshToken,
        clientId,
        clientSecret,
        region = 'us-east-1',
        startUrl,
        authMethod = 'IdC',
        provider = 'BuilderId',
        profileArn,
        accountId
      } = credentials
      let finalAccessToken = credentials.accessToken
      let finalRefreshToken = refreshToken
      let finalExpiresIn = 3600

      // Before cutting number refresh, make sure that what is written on the disk is the latest access + up to date refresh（rotating）
      if (refreshToken) {
        console.log(`[Switch Account] Refreshing token before switch (authMethod: ${authMethod})...`)
        const refreshResult = await refreshTokenByMethod(refreshToken, clientId, clientSecret, region, authMethod)
        if (refreshResult.success && refreshResult.accessToken) {
          finalAccessToken = refreshResult.accessToken
          // bug A repair:OIDC return new refreshToken must be replaced; otherwise next time IDE/Anti-generational refresh It will hit the invalid one v1
          finalRefreshToken = refreshResult.refreshToken || refreshToken
          finalExpiresIn = refreshResult.expiresIn ?? 3600
          console.log('[Switch Account] Token refreshed successfully (rotated refreshToken updated)')
        } else {
          // bug D repair:refresh Failure does not write file + Report errors directly to avoid giving IDE Leave"half bad"token
          const errMsg = refreshResult.error || 'Unknown refresh error'
          console.warn(`[Switch Account] Token refresh failed, aborting switch: ${errMsg}`)
          return {
            success: false,
            error: `refresh Token failed, not written Kiro IDE Disk file to avoid automatic refresh failure next time IDE Force logout. reason:${errMsg}`
          }
        }
      }

      // profileArn Decision-making unified by helper：Enterprise Use regionalized backup ARN，BuilderId Use placeholders
      const resolvedProfileArn = resolveProfileArnForWrite({
        profileArn,
        authMethod,
        provider,
        region
      })

      // bug C Fix: use real expiresIn Calculate expiresAt
      const expiresAtIso = new Date(Date.now() + finalExpiresIn * 1000).toISOString()

      const { tokenPath, clientRegPath } = await writeKiroAuthTokenFile({
        accessToken: finalAccessToken,
        refreshToken: finalRefreshToken,
        expiresAtIso,
        authMethod,
        provider,
        region,
        startUrl,
        clientId,
        clientSecret,
        profileArn: resolvedProfileArn
      })
      console.log('[Switch Account] Token written to:', tokenPath)
      if (clientRegPath) {
        console.log('[Switch Account] Client registration written to:', clientRegPath)
      }

      // Record lastSwitchedAccountId(for watcher Recognition during reverse synchronization IDE current account)
      if (accountId) {
        lastSwitchedAccountId = accountId
        // Synchronous recording access/refresh of"trust source",avoid watcher Write the same data you just wrote back again
        lastWrittenTokenSignature = `${finalAccessToken}|${finalRefreshToken}`
        // If active renewal is enabled, immediately schedule Next time (based on what was just written expiresAt）
        if (proactiveRenewalEnabled) {
          scheduleProactiveRenewal(accountId, Date.now() + finalExpiresIn * 1000)
        }
      }

      return {
        success: true,
        // bug F Support: passback refresh Latest after credentials let renderer renew store
        refreshedCredentials: {
          accessToken: finalAccessToken,
          refreshToken: finalRefreshToken,
          expiresIn: finalExpiresIn
        }
      }
    } catch (error) {
      console.error('[Switch Account] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Switch failed' }
    }
  })

  // IPC: Switch account to Kiro CLI - Write credentials to SQLite database
  // kiro-cli use ~/.local/share/kiro-cli/data.sqlite3 in auth_kv surface
  ipcMain.handle('switch-account-cli', async (_event, credentials: {
    accessToken: string
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    profileArn?: string
    provider?: string
    scopes?: string[]
  }) => {
    const os = await import('os')
    const path = await import('path')
    const { mkdir } = await import('fs/promises')

    try {
      const {
        refreshToken,
        clientId,
        clientSecret,
        region = 'us-east-1',
        profileArn,
        provider,
        scopes
      } = credentials
      let { accessToken } = credentials

      // Refresh before switching numbers token(and IDE Cut numbers are the same)
      if (refreshToken) {
        const authMethod = (provider === 'Google' || provider === 'Github') ? 'social' : undefined
        console.log(`[Switch CLI] Refreshing token before switch (provider: ${provider})...`)
        const refreshResult = await refreshTokenByMethod(refreshToken, clientId || '', clientSecret || '', region, authMethod)
        if (refreshResult.success && refreshResult.accessToken) {
          accessToken = refreshResult.accessToken
          console.log('[Switch CLI] Token refreshed successfully')
        } else {
          console.warn(`[Switch CLI] Token refresh failed: ${refreshResult.error}, using existing token`)
        }
      }

      // kiro-cli SQLite Database path
      // Windows: %LOCALAPPDATA%\kiro-cli\data.sqlite3
      // macOS/Linux: ~/.local/share/kiro-cli/data.sqlite3
      const dataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'kiro-cli')
        : path.join(os.homedir(), '.local', 'share', 'kiro-cli')
      await mkdir(dataDir, { recursive: true })
      const dbPath = path.join(dataDir, 'data.sqlite3')

      // judge token key：social For login social:token，IdC For login odic:token
      const isSocial = provider === 'Google' || provider === 'Github'
      const preferredTokenKey = isSocial ? 'kirocli:social:token' : 'kirocli:odic:token'
      const preferredRegKey = 'kirocli:odic:device-registration'

      // profileArn Decision-making unified by helper：BuilderId Without profileArn
      // kiro-cli The same should not be in SQLite Riese placeholder ARN(Actual measurement will trigger REST endpoint 403）
      const resolvedProfileArn = resolveProfileArnForWrite({
        profileArn,
        authMethod: isSocial ? 'social' : 'IdC',
        provider,
        region
      })

      // Build token JSON（snake_case field name, with kiro-cli Rust structurally consistent)
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
      const tokenData: Record<string, unknown> = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        region
      }
      // profileArn Appended only if a valid value is parsed out,BuilderId Wait without bringing (avoid kiro-cli take placeholder ARN tune REST trigger 403）
      if (resolvedProfileArn) {
        tokenData.profile_arn = resolvedProfileArn
      }
      if (scopes) tokenData.scopes = scopes

      // use sqlite3 Command line operation (cross-platform compatible, no native module compilation required)
      const { execFileSync } = await import('child_process')
      const sqlite3Bin = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3'

      // Build SQL statement
      const sqlStatements: string[] = [
        'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
        `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredTokenKey}', '${JSON.stringify(tokenData).replace(/'/g, "''")}');`
      ]

      // write device-registration(only IdC Log in)
      if (clientId && clientSecret && !isSocial) {
        const regData = { client_id: clientId, client_secret: clientSecret, region }
        sqlStatements.push(
          `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredRegKey}', '${JSON.stringify(regData).replace(/'/g, "''")}');`
        )
      }

      // Clear old ones with other priorities key
      const cliTokenKeys = ['kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token']
      for (const key of cliTokenKeys) {
        if (key !== preferredTokenKey) {
          sqlStatements.push(`DELETE FROM auth_kv WHERE key = '${key}';`)
        }
      }

      try {
        execFileSync(sqlite3Bin, [dbPath], {
          input: sqlStatements.join('\n'),
          timeout: 10000,
          encoding: 'utf-8'
        })
      } catch (sqlite3Error) {
        // sqlite3 The command does not exist, try using Node.js 22+ of built-in SQLite
        console.log('[Switch CLI] sqlite3 command not available, trying Node.js built-in SQLite...')
        try {
          const { DatabaseSync } = await import('node:sqlite') as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } }
          const db = new DatabaseSync(dbPath)
          try {
            for (const sql of sqlStatements) {
              db.exec(sql)
            }
          } finally {
            db.close()
          }
        } catch {
          throw new Error(`SQLite Operation failed: sqlite3 Command not available (${(sqlite3Error as Error).message}),and Node.js built-in SQLite Not supported. Please make sure the system is installed sqlite3 Command line tools.`)
        }
      }

      console.log(`[Switch CLI] Token saved to SQLite key: ${preferredTokenKey}`)
      console.log(`[Switch CLI] Account switched successfully in ${dbPath}`)
      return { success: true, dbPath }
    } catch (error) {
      console.error('[Switch CLI] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'CLI Switch failed' }
    }
  })


  // IPC: Log out - clear local SSO cache
  ipcMain.handle('logout-account', async () => {
    const os = await import('os')
    const path = await import('path')
    const { readdir, unlink } = await import('fs/promises')

    // Clear the active renewal immediately timer and"Activate account"remember, avoid watcher / timer Mis-sync
    clearProactiveRenewal('logout-account')
    lastSwitchedAccountId = null
    lastWrittenTokenSignature = null

    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      console.log('[Logout] Clearing SSO cache:', ssoCache)
      
      // Read all files in the directory
      const files = await readdir(ssoCache).catch(() => [])
      
      // Delete all files
      for (const file of files) {
        const filePath = path.join(ssoCache, file)
        await unlink(filePath).catch((e) => {
          console.warn('[Logout] Failed to delete file:', filePath, e)
        })
      }
      
      console.log('[Logout] SSO cache cleared, deleted', files.length, 'files')
      return { success: true, deletedCount: files.length }
    } catch (error) {
      console.error('[Logout] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Exit failed' }
    }
  })

  // ============ Manual login related IPC ============

  // Store current login status
  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO Related
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO dedicated
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth Related
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: start up Builder ID Manual login
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')
    
    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: register OIDC client
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `Failed to register client: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: Initiate device authorization
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `Device authorization failed: ${errText}` }
      }

      const authData = await authRes.json()
      const { deviceCode, userCode, verificationUri, verificationUriComplete, interval = 5, expiresIn = 600 } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // Save login status
      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Login failed' }
    }
  })

  // IPC: polling Builder ID Authorization status
  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: 'No login in progress' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: 'Authorization has expired, please start again' }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')
        
        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
        
        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: 'Device code has expired' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: 'User refuses authorization' }
        } else {
          currentLoginState = null
          return { success: false, error: `Authorization error: ${error}` }
        }
      } else {
        return { success: false, error: `Unknown response: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Polling failed' }
    }
  })

  // IPC: Cancel Builder ID Log in
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO Local server and status
  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
  let iamSsoResult: {
    completed: boolean
    success: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  } | null = null

  // IPC: start up IAM Identity Center SSO Log in (use Authorization Code Grant with PKCE)
  ipcMain.handle('start-iam-sso-login', async (_event, startUrl: string, region: string = 'us-east-1') => {
    console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
    console.log('[Login] Start URL:', startUrl)
    
    // verify startUrl Format
    if (!startUrl || !startUrl.startsWith('https://')) {
      return { success: false, error: 'SSO Start URL Must be https:// beginning' }
    }
    
    const crypto = await import('crypto')
    const http = await import('http')
    
    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: register OIDC client (use authorization_code grant type)
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['authorization_code', 'refresh_token'],
          redirectUris: ['http://127.0.0.1/oauth/callback'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        console.error('[Login] IAM SSO client registration failed:', regRes.status, errText)
        
        if (errText.includes('UnauthorizedException') || errText.includes('access denied')) {
          return { 
            success: false, 
            error: 'Authorization failed: Your organization may not be configured Amazon Q Developer access rights. Please contact your organization administrator at IAM Identity Center Enable relevant permissions.' 
          }
        }
        
        return { success: false, error: `Failed to register client: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: generate PKCE and state
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomUUID()

      // Step 3: Start local HTTP Server receives callback
      console.log('[Login] Step 2: Starting local OAuth callback server...')
      
      // Shut down the previous server
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }

      // Find an available port
      const port = await new Promise<number>((resolve, reject) => {
        const server = http.createServer()
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            const p = addr.port
            server.close(() => resolve(p))
          } else {
            reject(new Error('Unable to get port'))
          }
        })
      })

      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      console.log('[Login] Redirect URI:', redirectUri)

      // Reset results
      iamSsoResult = null

      // Create callback server
      iamSsoServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${port}`)
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          
          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: `Authorization failed: ${error}` }
            return
          }
          
          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>Authorization failed</h1><p>Status does not match, please try again.</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: 'status mismatch' }
            return
          }
          
          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>Authorization successful!</h1><p>Retrieving token, please wait....</p></body></html>')
            
            // autocomplete token exchange
            try {
              const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  clientId,
                  clientSecret,
                  grantType: 'authorization_code',
                  redirectUri,
                  code,
                  codeVerifier
                })
              })

              if (!tokenRes.ok) {
                const errText = await tokenRes.text()
                console.error('[Login] Token exchange failed:', tokenRes.status, errText)
                iamSsoResult = { completed: true, success: false, error: `get Token fail: ${errText}` }
              } else {
                const tokenData = await tokenRes.json()
                console.log('[Login] IAM SSO Authorization successful!')
                iamSsoResult = {
                  completed: true,
                  success: true,
                  accessToken: tokenData.accessToken,
                  refreshToken: tokenData.refreshToken,
                  clientId,
                  clientSecret,
                  region,
                  expiresIn: tokenData.expiresIn
                }
              }
            } catch (tokenError) {
              console.error('[Login] Token exchange error:', tokenError)
              iamSsoResult = { 
                completed: true, 
                success: false, 
                error: tokenError instanceof Error ? tokenError.message : 'get Token fail' 
              }
            }
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>Authorization failed</h1><p>Authorization code not received.</p></body></html>')
            iamSsoResult = { completed: true, success: false, error: 'Authorization code not received' }
          }
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      iamSsoServer.listen(port, '127.0.0.1', () => {
        console.log('[Login] OAuth callback server listening on port', port)
      })

      // Step 4: Build authorization URL and open the browser
      const authorizeParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: scopes.join(','),
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      })
      const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`
      console.log('[Login] Opening browser for authorization...')

      // Save login status
      currentLoginState = {
        type: 'iamsso',
        clientId,
        clientSecret,
        codeVerifier,
        redirectUri,
        region,
        startUrl,
        expiresAt: Date.now() + 600000
      }

      // return authorization URL, the front end will open the browser
      return {
        success: true,
        authorizeUrl,
        expiresIn: 600
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Login failed' }
    }
  })

  // IPC: polling IAM SSO Authorization status (Check if the local server received the callback)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: 'nothing in progress IAM SSO Log in' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: 'Authorization has expired, please start again' }
    }

    // Check if the callback has been received and completed token exchange
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // Clean status
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // Still waiting for callback
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: Cancel IAM SSO Log in
  ipcMain.handle('cancel-iam-sso-login', async () => {
    console.log('[Login] Cancelling IAM SSO login...')
    if (iamSsoServer) {
      iamSsoServer.close()
      iamSsoServer = null
    }
    iamSsoResult = null
    currentLoginState = null
    return { success: true }
  })

  // IPC: start up Social Auth Log in (Google/GitHub)
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
    console.log(`[Login] Starting ${provider} Social Auth login... (privateMode: ${usePrivateMode})`)
    
    const crypto = await import('crypto')

    // generate PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // Build login URL
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // Save login status
    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    const urlStr = loginUrl.toString()
    console.log(`[Login] Opening browser for ${provider} login...`)

    // Choose how to open based on whether to use privacy mode
    if (usePrivateMode) {
      openBrowserInPrivateMode(urlStr)
    } else {
      shell.openExternal(urlStr)
    }

    return {
      success: true,
      loginUrl: urlStr,
      state: oauthState
    }
  })

  // IPC: exchange Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: 'No social login in progress' }
    }

    // verify state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: 'Status parameters do not match, there may be security risks' }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'

    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token Exchange failed: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token Exchange failed' }
    }
  })

  // IPC: Cancel Social Auth Log in
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: Set proxy
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    const normalizedUrl = enabled && url ? normalizeProxyUrl(url) : url
    console.log(`[IPC] set-proxy called: enabled=${enabled}, url=${normalizedUrl}${normalizedUrl !== url ? ` (original: ${url})` : ''}`)
    try {
      applyProxySettings(enabled, url)
      
      // Set simultaneously Electron of session acting
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && normalizedUrl) {
          await session.setProxy({ proxyRules: normalizedUrl })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }
      
      return { success: true, normalizedUrl }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============ Kiro Settings management IPC ============

  // IPC: get Kiro set up
  ipcMain.handle('get-kiro-settings', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      const kiroSteeringPath = path.join(homeDir, '.kiro', 'steering')
      const kiroMcpUserPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      let settings = {}
      let mcpConfig = { mcpServers: {} }
      let steeringFiles: string[] = []
      
      // read Kiro settings.json (VS Code style JSON, may have a trailing comma)
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // Remove trailing commas and comments for standards compatibility JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // Remove single line comments
          .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
          .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
        const parsed = JSON.parse(cleanedContent)
        settings = {
          modelSelection: parsed['kiroAgent.modelSelection'],
          agentAutonomy: parsed['kiroAgent.agentAutonomy'],
          enableDebugLogs: parsed['kiroAgent.enableDebugLogs'],
          enableTabAutocomplete: parsed['kiroAgent.enableTabAutocomplete'],
          enableCodebaseIndexing: parsed['kiroAgent.enableCodebaseIndexing'],
          usageSummary: parsed['kiroAgent.usageSummary'],
          codeReferences: parsed['kiroAgent.codeReferences.referenceTracker'],
          configureMCP: parsed['kiroAgent.configureMCP'],
          trustedCommands: parsed['kiroAgent.trustedCommands'] || [],
          trustedTools: parsed['kiroAgent.trustedTools'] || {},
          commandDenylist: parsed['kiroAgent.commandDenylist'] || [],
          ignoreFiles: parsed['kiroAgent.ignoreFiles'] || [],
          mcpApprovedEnvVars: parsed['kiroAgent.mcpApprovedEnvVars'] || [],
          notificationsActionRequired: parsed['kiroAgent.notifications.agent.actionRequired'],
          notificationsFailure: parsed['kiroAgent.notifications.agent.failure'],
          notificationsSuccess: parsed['kiroAgent.notifications.agent.success'],
          notificationsBilling: parsed['kiroAgent.notifications.billing']
        }
      }
      
      // read MCP Configuration
      if (fs.existsSync(kiroMcpUserPath)) {
        const mcpContent = fs.readFileSync(kiroMcpUserPath, 'utf-8')
        mcpConfig = JSON.parse(mcpContent)
      }
      
      // read Steering file list
      if (fs.existsSync(kiroSteeringPath)) {
        const files = fs.readdirSync(kiroSteeringPath)
        steeringFiles = files.filter(f => f.endsWith('.md'))
        console.log('[KiroSettings] Steering path:', kiroSteeringPath)
        console.log('[KiroSettings] Found steering files:', steeringFiles)
      } else {
        console.log('[KiroSettings] Steering path does not exist:', kiroSteeringPath)
      }
      
      return { settings, mcpConfig, steeringFiles }
    } catch (error) {
      console.error('[KiroSettings] Failed to get settings:', error)
      return { error: error instanceof Error ? error.message : 'Failed to get settings' }
    }
  })

  // IPC: get Kiro List of available models (use the current account to call the official API）
  ipcMain.handle('get-kiro-available-models', async () => {
    try {
      if (!store) return { models: [] }
      const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
      if (!accountData?.accounts) return { models: [] }

      // Priority will be given to the currently activated account (isActive), followed by using the first active And there is accessToken account
      const allAccounts = Object.values(accountData.accounts) as any[]
      const account = allAccounts.find((acc: any) => acc.isActive && acc.credentials?.accessToken)
        || allAccounts.find((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
      if (!account) return { models: [] }

      const proxyAccount = {
        id: account.id,
        email: account.email,
        accessToken: account.credentials.accessToken,
        refreshToken: account.credentials?.refreshToken,
        profileArn: account.profileArn,
        expiresAt: account.credentials?.expiresAt,
        clientId: account.credentials?.clientId,
        clientSecret: account.credentials?.clientSecret,
        region: account.credentials?.region || 'us-east-1',
        authMethod: account.credentials?.authMethod
      }

      const models = await fetchKiroModels(proxyAccount)
      return {
        models: models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description
        }))
      }
    } catch (error) {
      console.error('[KiroSettings] Failed to fetch models:', error)
      return { models: [], error: error instanceof Error ? error.message : 'Failed to fetch models' }
    }
  })

  // IPC: save Kiro set up
  ipcMain.handle('save-kiro-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      let existingSettings = {}
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // Remove trailing commas and comments for standards compatibility JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // Remove single line comments
          .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
          .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
        existingSettings = JSON.parse(cleanedContent)
      }
      
      // Mapping set to Kiro format
      const kiroSettings = {
        ...existingSettings,
        'kiroAgent.modelSelection': settings.modelSelection,
        'kiroAgent.agentAutonomy': settings.agentAutonomy,
        'kiroAgent.enableDebugLogs': settings.enableDebugLogs,
        'kiroAgent.enableTabAutocomplete': settings.enableTabAutocomplete,
        'kiroAgent.enableCodebaseIndexing': settings.enableCodebaseIndexing,
        'kiroAgent.usageSummary': settings.usageSummary,
        'kiroAgent.codeReferences.referenceTracker': settings.codeReferences,
        'kiroAgent.configureMCP': settings.configureMCP,
        'kiroAgent.trustedCommands': settings.trustedCommands,
        'kiroAgent.trustedTools': settings.trustedTools,
        'kiroAgent.commandDenylist': settings.commandDenylist,
        'kiroAgent.ignoreFiles': settings.ignoreFiles,
        'kiroAgent.mcpApprovedEnvVars': settings.mcpApprovedEnvVars,
        'kiroAgent.notifications.agent.actionRequired': settings.notificationsActionRequired,
        'kiroAgent.notifications.agent.failure': settings.notificationsFailure,
        'kiroAgent.notifications.agent.success': settings.notificationsSuccess,
        'kiroAgent.notifications.billing': settings.notificationsBilling
      }
      
      // Make sure the directory exists
      const dir = path.dirname(kiroSettingsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(kiroSettingsPath, JSON.stringify(kiroSettings, null, 4))
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' }
    }
  })

  // IPC: Open Kiro MCP Configuration file
  ipcMain.handle('open-kiro-mcp-config', async (_event, type: 'user' | 'workspace') => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      
      let configPath: string
      if (type === 'user') {
        configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      } else {
        // Workspace configuration, open the current workspace .kiro/settings/mcp.json
        configPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      }
      
      // If the file does not exist, create an empty configuration
      const fs = await import('fs')
      if (!fs.existsSync(configPath)) {
        const dir = path.dirname(configPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
      }
      
      shell.openPath(configPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open MCP config:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open MCP config' }
    }
  })

  // IPC: Open Kiro Steering Table of contents
  ipcMain.handle('open-kiro-steering-folder', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      
      // If the directory does not exist, create it
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      shell.openPath(steeringPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering folder:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering folder' }
    }
  })

  // IPC: Open Kiro settings.json document
  ipcMain.handle('open-kiro-settings-file', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      // If the file does not exist, create a default configuration
      if (!fs.existsSync(settingsPath)) {
        const dir = path.dirname(settingsPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const defaultSettings = {
          'workbench.colorTheme': 'Kiro Light',
          'kiroAgent.modelSelection': 'claude-haiku-4.5'
        }
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4))
      }
      
      shell.openPath(settingsPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open settings file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open settings file' }
    }
  })

  // IPC: Open the specified Steering document
  ipcMain.handle('open-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      shell.openPath(filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering file' }
    }
  })

  // IPC: create default rules.md document
  ipcMain.handle('create-kiro-default-rules', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const rulesPath = path.join(steeringPath, 'rules.md')
      
      // Make sure the directory exists
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      // Default rule content
      const defaultContent = `# Role: Advanced Software Development Assistant
1. The system isWindows10
2. Debug files, test scripts,testRelevant documents are placed intestInside the folder,mdThe file is placed indocsInside the folder
# core principles


## 1. Communication and collaboration
- **Honesty first**: Speculation or pretense is strictly prohibited under any circumstances.当需求不明确、存在技术风险或遇到知识盲区时，必须停止工作，并立即向用户澄清。
- **Technical difficulties**: When faced with a technical problem, the primary goal is to find and propose a high-quality solution. Only after all feasible options have been evaluated should downgrade or replacement options be discussed with the user.
- **critical thinking**: When performing tasks, if you find that there are technical limitations, potential risks, or better implementation paths for current requirements, you must proactively provide your insights and improvement suggestions to users.
- **Language requirements**: Always use Chinese when thinking and answering.


## 2. Architecture design
- **Modular design**: All designs must follow the principles of functional decoupling and single responsibility. strictly adhere toSOLIDandDRYin principle.
- **forward thinking**: Future scalability and maintainability must be considered when designing to ensure that the solution can be integrated into the overall architecture of the project.
- **Technical debt first**: When refactoring or optimizing, prioritize technical debt and infrastructure issues that have the greatest impact on system stability and maintainability.


## 3. Code and deliverable quality standards
### writing specifications
- **architectural perspective**: Always write code with the overall project architecture in mind, ensuring that code snippets are seamlessly integrated rather than isolated functions.
- **Zero technical debt**: It is strictly prohibited to create any form of technical debt, including but not limited to: temporary files, hard-coded values, modules or functions with unclear responsibilities.
- **Problem exposed**: It is forbidden to add any code to cover up or bypass the error.fallbackmechanism. Code should be designed to fail fast (Fail-Fast) to ensure that problems are discovered as soon as possible.


### Quality requirements
- **readability**: Use clear and meaningful variable and function names. The code logic must be clear and easy to understand and supported by necessary comments.
- **Standard compliance**: Strictly follow the community best practices and official coding standards of the target programming language.
- **Robustness**: Must contain adequate error handling logic and boundary condition checks.
- **performance awareness**: Under the premise of ensuring code quality and readability, perform reasonable optimization of performance-sensitive parts to avoid unnecessary computational complexity and resource consumption.


### Deliverable specifications
- **No documentation**: Do not create any unless explicitly requested by the userMarkdownDocumentation or other form of documentation.
- **No testing**: Don’t write unit or integration test code unless explicitly asked to do so by the user.
- **No compilation/run**: Disables compilation or execution of any code. Your mission is to produce high-quality code and design solutions.


# Things to note
- Unless otherwise specified, do not create new documentation, do not test, do not compile, do not run, do not summarize, unless the user actively requests it


- Ask users for clarification when requirements are unclear and provide predefined options
- When there are multiple solutions, you need to ask the user instead of making your own decision.
- There is a plan/When policies need to be updated, you need to ask users instead of making your own decisions.


- ACEforaugmentContextEngineabbreviation for tool
- If asked to view documentation please use Context7 MCP
- If necessaryWEBPlease use this for front-end page testing Playwright MCP
- If the user replies'continue' then please continue completing the task following best practices
`
      
      fs.writeFileSync(rulesPath, defaultContent, 'utf-8')
      console.log('[KiroSettings] Created default rules.md at:', rulesPath)
      
      // open file
      shell.openPath(rulesPath)
      
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to create default rules:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create default rules' }
    }
  })

  // IPC: read Steering File content
  ipcMain.handle('read-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' }
      }
      
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      console.error('[KiroSettings] Failed to read steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })

  // IPC: save Steering File content
  ipcMain.handle('save-kiro-steering-file', async (_event, filename: string, content: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const filePath = path.join(steeringPath, filename)
      
      // Make sure the directory exists
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      fs.writeFileSync(filePath, content, 'utf-8')
      console.log('[KiroSettings] Saved steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save file' }
    }
  })

  // ============ Kiro API Anti-generation server IPC ============

  // IPC: Start the anti-generation server
  ipcMain.handle('proxy-start', async (_event, config?: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      if (config) {
        server.updateConfig(config)
      }
      await server.start()
      // Update tray menu status
      updateTrayMenu()
      return { success: true, port: server.getConfig().port }
    } catch (error) {
      console.error('[ProxyServer] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy server' }
    }
  })

  // IPC: Stop anti-generation server
  ipcMain.handle('proxy-stop', async () => {
    try {
      if (proxyServer) {
        await proxyServer.stop()
      }
      // Update tray menu status
      updateTrayMenu()
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop proxy server' }
    }
  })

  // IPC: Get anti-generation server status
  ipcMain.handle('proxy-get-status', () => {
    if (!proxyServer) {
      // When not initialized from store Read saved configuration
      const savedConfig = store?.get('proxyConfig') as ProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, sessionStats: null }
    }
    return {
      running: proxyServer.isRunning(),
      config: proxyServer.getConfig(),
      stats: proxyServer.getStats(),
      sessionStats: proxyServer.getSessionStats()
    }
  })

  // IPC: reset total credits
  ipcMain.handle('proxy-reset-credits', () => {
    if (proxyServer) {
      proxyServer.resetTotalCredits()
    }
    if (store) {
      store.set('proxyTotalCredits', 0)
    }
    return { success: true }
  })

  // IPC: reset total tokens
  ipcMain.handle('proxy-reset-tokens', () => {
    if (proxyServer) {
      proxyServer.resetTotalTokens()
    }
    if (store) {
      store.set('proxyInputTokens', 0)
      store.set('proxyOutputTokens', 0)
    }
    return { success: true }
  })

  // IPC: Reset request statistics
  ipcMain.handle('proxy-reset-request-stats', () => {
    if (proxyServer) {
      proxyServer.resetRequestStats()
    }
    if (store) {
      store.set('proxyTotalRequests', 0)
      store.set('proxySuccessRequests', 0)
      store.set('proxyFailedRequests', 0)
    }
    return { success: true }
  })

  // IPC: Get anti-generation log
  ipcMain.handle('proxy-get-logs', (_event, count?: number) => {
    if (count) {
      return proxyLogStore.getLast(count)
    }
    return proxyLogStore.getAll()
  })

  // IPC: Clear reverse generation logs
  ipcMain.handle('proxy-clear-logs', () => {
    proxyLogStore.clear()
    return { success: true }
  })

  // IPC: Get the number of reverse generation logs
  ipcMain.handle('proxy-get-logs-count', () => {
    return proxyLogStore.count()
  })

  // IPC: get Usage API type
  ipcMain.handle('get-usage-api-type', () => {
    return currentUsageApiType
  })

  // IPC: set up Usage API type
  ipcMain.handle('set-usage-api-type', (_event, type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    // save to store
    if (store) {
      store.set('usageApiType', type)
    }
    return { success: true, type }
  })

  // IPC: Get whether to use K-Proxy acting
  ipcMain.handle('get-use-kproxy-for-api', () => {
    return getUseKProxyForApi()
  })

  // IPC: Set whether to use K-Proxy acting
  ipcMain.handle('set-use-kproxy-for-api', (_event, enabled: boolean) => {
    setUseKProxyForApi(enabled)
    // save to store
    if (store) {
      store.set('useKProxyForApi', enabled)
    }
    return { success: true, enabled }
  })

  // IPC: Update anti-generation server configuration
  ipcMain.handle('proxy-update-config', async (_event, config: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      server.updateConfig(config)
      const newConfig = server.getConfig()
      // Synchronous streaming log switch
      if (config.logStreamEvents !== undefined) {
        setLogStreamEvents(config.logStreamEvents)
      }
      // synchronous payload size limit
      if (config.payloadSizeLimitKB !== undefined) {
        setPayloadSizeLimitKB(config.payloadSizeLimitKB)
      }
      // synchronous Token buffer reserve(switch + numerical value)
      if (config.enableTokenBufferReserve !== undefined) {
        setEnableTokenBufferReserve(config.enableTokenBufferReserve)
      }
      if (config.tokenBufferReserve !== undefined) {
        setTokenBufferReserve(config.tokenBufferReserve)
      }
      // synchronous Agent model
      if (config.agentMode) {
        setAgentMode(config.agentMode)
      }
      // Reload when workspace path changes steering
      if (config.workspacePath !== undefined) {
        server.loadSteering()
      }
      // Save configuration to store(for self-starting)
      if (store) {
        store.set('proxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[ProxyServer] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // ============ Anti-generational security / observable IPC（v1.8 Newly added) ============

  // Obtain self-signed certificate information (PEM, fingerprint, validity period,SAN）
  ipcMain.handle('proxy-self-signed-cert-info', () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      const info = proxyServer.getSelfSignedCertInfo()
      if (!info) return { success: false, error: 'Failed to get self-signed cert info' }
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Regenerate self-signed certificate (triggered by user)
  ipcMain.handle('proxy-self-signed-cert-regenerate', () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      const info = proxyServer.regenerateSelfSignedCert()
      if (!info) return { success: false, error: 'Failed to regenerate self-signed cert' }
      return { success: true, ...info }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Check whether the anti-generation configuration needs to be restarted
  ipcMain.handle('proxy-needs-restart', () => {
    try {
      if (!proxyServer) return { needsRestart: false }
      return { needsRestart: proxyServer.needsRestart() }
    } catch {
      return { needsRestart: false }
    }
  })

  // Restart the reverse generation (the user is UI point"Restart now"called when)
  ipcMain.handle('proxy-restart', async () => {
    try {
      if (!proxyServer) return { success: false, error: 'Proxy server not initialized' }
      await proxyServer.restartServer()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Get anti-generation audit logs
  ipcMain.handle('proxy-audit-log', () => {
    try {
      if (!proxyServer) return { entries: [] }
      return { entries: proxyServer.getAuditLog().slice(-200) }
    } catch {
      return { entries: [] }
    }
  })

  // ============ API Key manage IPC ============

  // IPC: Get all API Keys
  ipcMain.handle('proxy-get-api-keys', () => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      return { success: true, apiKeys: config.apiKeys || [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get API keys', apiKeys: [] }
    }
  })

  // IPC: Add to API Key
  ipcMain.handle('proxy-add-api-key', async (_event, apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }) => {
    try {
      const crypto = await import('crypto')
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      // Generate random according to format Key
      const format = apiKey.format || 'sk'
      let newKey = apiKey.key
      if (!newKey) {
        const randomHex = crypto.randomBytes(24).toString('hex')
        switch (format) {
          case 'sk':
            newKey = `sk-${randomHex}`
            break
          case 'simple':
            newKey = `PROXY_KEY_${randomHex.toUpperCase().substring(0, 32)}`
            break
          case 'token':
            newKey = `KEY:${randomHex.substring(0, 16)}:TOKEN:${randomHex.substring(16, 32)}`
            break
          default:
            newKey = `sk-${randomHex}`
        }
      }
      
      const newApiKey: import('./proxy/types').ApiKey = {
        id: crypto.randomUUID(),
        name: apiKey.name || `API Key ${apiKeys.length + 1}`,
        key: newKey,
        format: format,
        enabled: true,
        createdAt: Date.now(),
        creditsLimit: apiKey.creditsLimit,
        usage: {
          totalRequests: 0,
          totalCredits: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          daily: {}
        }
      }
      
      apiKeys.push(newApiKey)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true, apiKey: newApiKey }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add API key' }
    }
  })

  // IPC: renew API Key
  ipcMain.handle('proxy-update-api-key', (_event, id: string, updates: Partial<import('./proxy/types').ApiKey>) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      // Update fields (updates not allowed id、createdAt、usage）
      const { id: _, createdAt: __, usage: ___, ...allowedUpdates } = updates
      apiKeys[index] = { ...apiKeys[index], ...allowedUpdates }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true, apiKey: apiKeys[index] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update API key' }
    }
  })

  // IPC: delete API Key
  ipcMain.handle('proxy-delete-api-key', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKeys.splice(index, 1)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete API key' }
    }
  })

  // IPC: reset API Key Usage statistics
  ipcMain.handle('proxy-reset-api-key-usage', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const apiKey = apiKeys.find(k => k.id === id)
      if (!apiKey) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKey.usage = {
        totalRequests: 0,
        totalCredits: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        daily: {}
      }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset usage' }
    }
  })

  // IPC: Add account to anti-generation pool
  ipcMain.handle('proxy-add-account', (_event, account: ProxyAccount) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().addAccount(account)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Add account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add account' }
    }
  })

  // IPC: Remove account from anti-generation pool
  ipcMain.handle('proxy-remove-account', (_event, accountId: string) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().removeAccount(accountId)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Remove account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove account' }
    }
  })

  // IPC: Synchronize accounts to the anti-generation pool (batch update)
  ipcMain.handle('proxy-sync-accounts', (_event, accounts: ProxyAccount[]) => {
    try {
      const server = initProxyServer()
      const pool = server.getAccountPool()
      pool.clear()
      for (const account of accounts) {
        pool.addAccount(account)
      }
      return { success: true, accountCount: pool.size }
    } catch (error) {
      console.error('[ProxyServer] Sync accounts failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync accounts' }
    }
  })

  // IPC: Get the anti-generation pool account list
  ipcMain.handle('proxy-get-accounts', () => {
    if (!proxyServer) {
      return { accounts: [], availableCount: 0 }
    }
    const pool = proxyServer.getAccountPool()
    return {
      accounts: pool.getAllAccounts(),
      availableCount: pool.availableCount
    }
  })

  // IPC: Refresh model cache
  ipcMain.handle('proxy-refresh-models', () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized' }
    }
    proxyServer.clearModelCache()
    return { success: true }
  })

  // IPC: Get a list of available models
  ipcMain.handle('proxy-get-models', async () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized', models: [] }
    }
    try {
      const result = await proxyServer.getAvailableModels()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
    }
  })

  ipcMain.handle('proxy-configure-clients', async (_event, input: { clients: ProxyClientTarget[]; modelId: string; modelName?: string; models?: ProxyClientModel[] }) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKey = (config.apiKey || config.apiKeys?.find(key => key.enabled)?.key || '').trim()
      if (!apiKey) {
        return {
          success: false,
          proxyOrigin: '',
          openaiBaseUrl: '',
          results: [],
          error: 'Please set or enable it in the anti-generation configuration first API Key'
        }
      }
      return await configureProxyClients({
        clients: input.clients,
        host: config.host,
        port: config.port,
        tlsEnabled: config.tls?.enabled,
        apiKey,
        modelId: input.modelId,
        modelName: input.modelName,
        models: input.models
      })
    } catch (error) {
      return {
        success: false,
        proxyOrigin: '',
        openaiBaseUrl: '',
        results: [],
        error: error instanceof Error ? error.message : 'Failed to configure clients'
      }
    }
  })

  // IPC: Get the list of models available for the account
  ipcMain.handle('account-get-models', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const models = await fetchKiroModels({
        id: accountId || 'model-list-request',
        accessToken,
        region: region || 'us-east-1',
        profileArn,
        machineId,
        provider,
        authMethod: authMethod as ProxyAccount['authMethod']
      } as ProxyAccount)
      return {
        success: true,
        models: models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description,
          inputTypes: m.supportedInputTypes,
          maxInputTokens: m.tokenLimits?.maxInputTokens,
          maxOutputTokens: m.tokenLimits?.maxOutputTokens,
          rateMultiplier: m.rateMultiplier,
          rateUnit: m.rateUnit
        }))
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
    }
  })

  // IPC: Get a list of available subscriptions
  ipcMain.handle('account-get-subscriptions', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await fetchAvailableSubscriptions({ id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount)
      if (result.subscriptionPlans) {
        return { 
          success: true, 
          plans: result.subscriptionPlans,
          disclaimer: result.disclaimer 
        }
      }
      return { success: false, error: 'No subscription plans returned', plans: [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscriptions', plans: [] }
    }
  })

  // IPC: Get subscription management/Payment link
  ipcMain.handle('account-get-subscription-url', async (_event, accessToken: string, subscriptionType?: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await fetchSubscriptionToken({ id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount, subscriptionType)
      if (result.encodedVerificationUrl) {
        return { success: true, url: result.encodedVerificationUrl, status: result.status }
      }
      return { success: false, error: result.message || 'No subscription URL returned' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscription URL' }
    }
  })

  // IPC: Set user preferences (oversubscription enabled/closure)
  ipcMain.handle('account-set-overage', async (_event, accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await setUserPreference(
        { id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount,
        overageStatus
      )
      return result
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set overage' }
    }
  })

  // IPC: Open the subscription link in your system's default browser in incognito mode
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' }
    }
  })

  // Agent log persistence (request logs, stored separately from detailed logs)
  const getProxyLogsPath = (): string => join(app.getPath('userData'), 'proxy-request-logs.json')
  const MAX_LOGS = 100

  // IPC: Save agent logs
  ipcMain.handle('proxy-save-logs', async (_event, logs: Array<{ time: string; path: string; status: number; tokens?: number }>) => {
    try {
      const logsPath = getProxyLogsPath()
      // Keep only the most recent 100 strip
      const trimmedLogs = logs.slice(0, MAX_LOGS)
      await writeFile(logsPath, JSON.stringify(trimmedLogs, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('[ProxyLogs] Save failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save logs' }
    }
  })

  // IPC: Load agent logs
  ipcMain.handle('proxy-load-logs', async () => {
    try {
      const logsPath = getProxyLogsPath()
      const content = await readFile(logsPath, 'utf-8')
      const logs = JSON.parse(content)
      return { success: true, logs }
    } catch (error) {
      // It is normal for the file not to exist
      return { success: true, logs: [] }
    }
  })

  // IPC: Reset generation pool status
  ipcMain.handle('proxy-reset-pool', () => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().reset()
      }
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Reset pool failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset pool' }
    }
  })

  // IPC: Manually lift the account ban mark (called after the user confirms that the account has been restored)
  // 1) Clear the generation pool suspended state
  // 2) Sync clear store.accountData[id].lastError, the status returns to active
  ipcMain.handle('proxy-clear-account-suspended', (_event, accountId: string) => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().clearSuspended(accountId)
      }
      // Persistent cleanup lastError
      if (store) {
        const accountData = store.get('accountData') as { accounts?: Record<string, Record<string, unknown>> } | undefined
        if (accountData?.accounts?.[accountId]) {
          const acc = accountData.accounts[accountId]
          accountData.accounts[accountId] = {
            ...acc,
            status: 'active',
            lastError: undefined,
            lastCheckedAt: Date.now()
          }
          store.set('accountData', accountData)
          lastSavedData = accountData
        }
      }
      console.log(`[ProxyServer] Cleared suspended flag for account ${accountId}`)
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Clear suspended failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to clear suspended' }
    }
  })

  // ============ K-Proxy MITM acting IPC ============

  // IPC: initialization K-Proxy Serve
  ipcMain.handle('kproxy-init', async () => {
    try {
      const savedConfig = store?.get('kproxyConfig') as Partial<KProxyConfig> | undefined
      const service = initKProxyService(savedConfig || {}, {
        onRequest: (info) => {
          mainWindow?.webContents.send('kproxy-request', info)
        },
        onResponse: (info) => {
          mainWindow?.webContents.send('kproxy-response', info)
        },
        onError: (error) => {
          console.error('[KProxy] Error:', error)
          mainWindow?.webContents.send('kproxy-error', error.message)
        },
        onStatusChange: (running, port) => {
          mainWindow?.webContents.send('kproxy-status-change', { running, port })
        },
        onMitmIntercept: (host, modified) => {
          mainWindow?.webContents.send('kproxy-mitm', { host, modified })
        }
      })
      const caInfo = await service.initialize()
      return { 
        success: true, 
        caInfo: {
          certPath: caInfo.certPath,
          fingerprint: caInfo.fingerprint,
          validFrom: caInfo.validFrom.toISOString(),
          validTo: caInfo.validTo.toISOString()
        }
      }
    } catch (error) {
      console.error('[KProxy] Init failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to init K-Proxy' }
    }
  })

  // IPC: start up K-Proxy
  ipcMain.handle('kproxy-start', async (_event, config?: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      if (config) {
        service.updateConfig(config)
      }
      await service.start()
      // Save configuration
      if (store) {
        store.set('kproxyConfig', service.getConfig())
      }
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      console.error('[KProxy] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start K-Proxy' }
    }
  })

  // IPC: stop K-Proxy
  ipcMain.handle('kproxy-stop', async () => {
    try {
      const service = getKProxyService()
      if (service) {
        await service.stop()
      }
      return { success: true }
    } catch (error) {
      console.error('[KProxy] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop K-Proxy' }
    }
  })

  // IPC: get K-Proxy state
  ipcMain.handle('kproxy-get-status', () => {
    const service = getKProxyService()
    if (!service) {
      const savedConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, caInfo: null }
    }
    return {
      running: service.isRunning(),
      config: service.getConfig(),
      stats: service.getStats(),
      caInfo: service.getCACertInfo()
    }
  })

  // IPC: renew K-Proxy Configuration
  ipcMain.handle('kproxy-update-config', async (_event, config: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.updateConfig(config)
      const newConfig = service.getConfig()
      if (store) {
        store.set('kproxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[KProxy] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // IPC: Set current device ID
  ipcMain.handle('kproxy-set-device-id', (_event, deviceId: string) => {
    try {
      if (!isValidDeviceId(deviceId)) {
        return { success: false, error: 'Invalid device ID format (must be 64 hex characters)' }
      }
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.setDeviceId(deviceId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set device ID' }
    }
  })

  // IPC: Generate new device ID
  ipcMain.handle('kproxy-generate-device-id', () => {
    return { success: true, deviceId: generateDeviceId() }
  })

  // IPC: Add device ID mapping
  ipcMain.handle('kproxy-add-device-mapping', (_event, mapping: DeviceIdMapping) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.addDeviceIdMapping(mapping)
      // Save mapping
      const mappings = service.getAllDeviceIdMappings()
      if (store) {
        store.set('kproxyDeviceMappings', mappings)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add mapping' }
    }
  })

  // IPC: Get all devices ID mapping
  ipcMain.handle('kproxy-get-device-mappings', () => {
    const service = getKProxyService()
    if (!service) {
      const savedMappings = store?.get('kproxyDeviceMappings') as DeviceIdMapping[] | undefined
      return { success: true, mappings: savedMappings || [] }
    }
    return { success: true, mappings: service.getAllDeviceIdMappings() }
  })

  // IPC: Switch to account device ID
  ipcMain.handle('kproxy-switch-to-account', (_event, accountId: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const switched = service.switchToAccount(accountId)
      return { success: switched, error: switched ? undefined : 'No device ID mapping for account' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to switch account' }
    }
  })

  // IPC: get CA Certificate PEM(for exporting/Install)
  ipcMain.handle('kproxy-get-ca-cert', () => {
    const service = getKProxyService()
    if (!service) {
      return { success: false, error: 'K-Proxy not initialized' }
    }
    const certPem = service.getCACertPem()
    const caInfo = service.getCACertInfo()
    if (!certPem || !caInfo) {
      return { success: false, error: 'CA certificate not available' }
    }
    return { 
      success: true, 
      certPem,
      certPath: caInfo.certPath,
      fingerprint: caInfo.fingerprint
    }
  })

  // IPC: Export CA Certificate to specified path
  ipcMain.handle('kproxy-export-ca-cert', async (_event, exportPath?: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const certPem = service.getCACertPem()
      if (!certPem) {
        return { success: false, error: 'CA certificate not available' }
      }
      
      let targetPath = exportPath
      if (!targetPath) {
        const result = await dialog.showSaveDialog({
          title: 'Export CA Certificate',
          defaultPath: 'kproxy-ca.crt',
          filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }
        targetPath = result.filePath
      }
      
      await writeFile(targetPath, certPem, 'utf-8')
      return { success: true, path: targetPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to export certificate' }
    }
  })

  // IPC: reset K-Proxy statistics
  ipcMain.handle('kproxy-reset-stats', () => {
    const service = getKProxyService()
    if (service) {
      service.resetStats()
    }
    return { success: true }
  })

  // IPC: examine CA Whether the certificate is installed to the system trust store
  ipcMain.handle('kproxy-check-ca-cert-installed', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, installed: false, error: 'K-Proxy not initialized' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: use certutil Check certificate
        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      } else if (platform === 'darwin') {
        // macOS: use security command check
        try {
          execSync('security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db', { encoding: 'utf-8' })
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      } else {
        // Linux: Check if the file exists
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        return { success: true, installed: fs.existsSync(targetPath) }
      }
    } catch (error) {
      console.error('[KProxy] Check CA cert installed failed:', error)
      return { success: false, installed: false, error: error instanceof Error ? error.message : 'Check failed' }
    }
  })

  // IPC: Install CA Certificate to system trust store
  ipcMain.handle('kproxy-install-ca-cert', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const caInfo = service.getCACertInfo()
      if (!caInfo) {
        return { success: false, error: 'CA certificate not available' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: use certutil Install into the root certificate store
        try {
          execSync(`certutil -addstore -user Root "${caInfo.certPath}"`, { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate installed to Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('already in store') || errMsg.includes('Already in storage')) {
            return { success: true, message: 'CA certificate already installed' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: use security Command to install to keychain
        execSync(`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caInfo.certPath}"`)
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      } else {
        // Linux: Copy to system CA Table of contents
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        fs.copyFileSync(caInfo.certPath, targetPath)
        execSync('sudo update-ca-certificates')
        return { success: true, message: 'CA certificate installed to Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Install CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install certificate' }
    }
  })

  // IPC: uninstall CA Certificate from system trust store
  ipcMain.handle('kproxy-uninstall-ca-cert', async () => {
    try {
      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: use certutil Delete certificate
        try {
          execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate removed from Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('not found') || errMsg.includes('not found')) {
            return { success: true, message: 'CA certificate not found in store' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: use security command delete
        execSync('security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db')
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      } else {
        // Linux: Delete certificate and update
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath)
          execSync('sudo update-ca-certificates --fresh')
        }
        return { success: true, message: 'CA certificate removed from Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Uninstall CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall certificate' }
    }
  })

  // ============ MCP Server management IPC ============

  // IPC: save MCP Server configuration
  ipcMain.handle('save-mcp-server', async (_event, name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      // Read existing configuration
      let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      if (fs.existsSync(mcpPath)) {
        const content = fs.readFileSync(mcpPath, 'utf-8')
        mcpConfig = JSON.parse(content)
      }
      
      // If it is renamed, delete the old one first
      if (oldName && oldName !== name) {
        delete mcpConfig.mcpServers[oldName]
      }
      
      // Add to/update server
      mcpConfig.mcpServers[name] = config
      
      // Make sure the directory exists
      const dir = path.dirname(mcpPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Saved MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save MCP server' }
    }
  })

  // IPC: delete MCP server
  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: 'Configuration file does not exist' }
      }
      
      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)
      
      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: 'Server does not exist' }
      }
      
      delete mcpConfig.mcpServers[name]
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Deleted MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' }
    }
  })

  // IPC: delete Steering document
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' }
      }
      
      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete file' }
    }
  })

  // ============ Machine code management IPC ============
  
  // IPC: Get operating system type
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: Get the current machine code
  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: Set new machine code
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)
    
    if (!result.success && result.requiresAdmin) {
      // A pop-up window asks the user whether to restart with administrator privileges
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }
    
    return result
  })

  // IPC: Generate random machine code
  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: Check admin rights
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: Request administrator permission to restart
  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: Backup machine code to file
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Backup machine code',
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    
    if (result.canceled || !result.filePath) {
      return false
    }
    
    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: Recover machine code from file
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Restore machine code',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: 'User cancels' }
    }
    
    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // Updated protocol handler functions to support Social Auth callback
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - Redefining protocol handling
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)
      
      // deal with Social Auth callback (kiro://kiro.kiroAgent/authenticate-success)
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // Call the original processing function to handle other protocols
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: Click Dock Show the main window when the icon is displayed
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Load and register global shortcut keys
  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: Handle the second instance and protocol URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: protocol URL Will be passed in as command line parameters
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // Focus on main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: Processing Agreement URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Log out before app exit URI Protocol handler and saves data
app.on('will-quit', async (event) => {
  // Prevent duplication of processing
  if (isQuitting) return
  
  // Stop the main process pool token Refresh scheduler
  stopMainPoolTokenRefresh()

  // To prevent the app from exiting immediately, save the data first
  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true
    
    // Set a timeout to ensure 3 Force exit after seconds (to prevent shutdown blocking)
    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)
    
    try {
      console.log('[Exit] Saving data before quit...')
      // Refresh the anti-shake data to be written
      flushStoreWrites()
      store.set('accountData', lastSavedData)
      // Exit the scene to skip throttling and ensure that the backup is immediately placed on the disk.
      await createBackup(lastSavedData)
      await flushBackupNow()
      // Forced placement agent log (tail data in asynchronous throttling)
      try {
        const { proxyLogStore } = await import('./proxy/logger')
        await proxyLogStore.flushSaveNow()
      } catch (err) {
        console.error('[Exit] Failed to flush proxy logs:', err)
      }
      // release shared TLS ModuleClient（worker pool + DLL）
      try {
        const { shutdownTlsClientPool } = await import('./registration/tlsClientPool')
        await shutdownTlsClientPool()
      } catch (err) {
        console.error('[Exit] Failed to shutdown TLS client pool:', err)
      }
      console.log('[Exit] Data saved successfully')
    } catch (error) {
      console.error('[Exit] Failed to save data:', error)
    }
    
    clearTimeout(forceQuitTimer)
    unregisterProtocol()
    app.exit(0)
  } else {
    unregisterProtocol()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
