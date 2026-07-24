import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type {
  Account,
  AccountGroup,
  AccountTag,
  AccountFilter,
  AccountSort,
  AccountStatus,
  AccountStats,
  AccountExportData,
  AccountImportItem,
  BatchOperationResult,
  AccountSubscription,
  SubscriptionType,
  IdpType
} from '../types/account'
import type {
  ProxyEntry,
  ProxyPoolConfig,
  ProxyValidationResult,
  ProxyProtocol
} from '../types/proxy'
import { DEFAULT_PROXY_POOL_CONFIG } from '../types/proxy'
import { useWebhookStore, type WebhookEvent, type WebhookMessage } from './webhooks'

// ============================================
// Account management Store
// ============================================

// Generate random 64 bit hexadecimal device ID
function generateRandomMachineId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// automatic Token refresh timer
let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null
// The refresh advance must be ≥ 2× Check the interval, otherwise the account will be in twice tick Expires between:
// Some time tick When the remaining value just slightly exceeds the threshold, it will be skipped. Next time tick(interval minutes later) time has expired.
// Overlay again IPC + OIDC The network refresh itself takes time and insufficient margin will occur."Use only when expired"。
const TOKEN_REFRESH_MIN_LEAD_MS = 10 * 60 * 1000
function tokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, TOKEN_REFRESH_MIN_LEAD_MS)
}

// Persistent anti-shake: merge continuous mutation It is a single disk write to avoid background refresh storms. IPC + IO storm
const SAVE_DEBOUNCE_MS = 500
/** Anti-shake maximum delay: continuous mutation The disk should be downloaded once every time and at the latest within this time to prevent data from not being stored on the disk for a long time during a storm. */
const SAVE_MAX_WAIT_MS = 5000
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let saveMaxWaitTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight: Promise<void> | null = null
/** All callers waiting for the anti-shake window to be dropped in this round resolver;Wake up in batches to avoid storms Promise hang permanently */
let savePendingResolvers: Array<() => void> = []

// ============ getFilteredAccounts / getStats Reference cache ============
// In the scenario of large account volume, these two selector every time re-render All run away O(n) calculate(filter + sort）
// Compare cached input snapshots by reference, and directly return the last result when a hit occurs. N×n The calculation reduces to 1×n
let _filterCache: {
  accounts: unknown
  filter: unknown
  sort: unknown
  activeGroupTab: unknown
  output: Account[]
} | null = null

let _statsCache: {
  accounts: unknown
  output: AccountStats
} | null = null

/**
 * asynchronous synchronous local SSO The activation account in the cache arrives store。
 * Contains potential network requests (verifyAccountCredentials),from loadFromStorage Take it out
 * Asynchronous execution to avoid blocking the first screen loading (isLoading）。
 */
type SetFn = (
  partial:
    | Partial<AccountsState>
    | ((state: AccountsState) => Partial<AccountsState>)
) => void

async function syncLocalSsoAccountAsync(
  get: () => AccountsStore,
  set: SetFn
): Promise<void> {
  try {
    const localResult = await window.api.getLocalActiveAccount()
    if (!localResult.success || !localResult.data?.refreshToken) return

    const localRefreshToken = localResult.data.refreshToken
    const currentAccounts = get().accounts

    // Find matching accounts
    let foundAccountId: string | null = null
    for (const [id, account] of currentAccounts) {
      if (account.credentials.refreshToken === localRefreshToken) {
        foundAccountId = id
        break
      }
    }

    if (foundAccountId) {
      // Find the matching account and update it activeAccountId
      set({ activeAccountId: foundAccountId })
      // synchronous isActive Field
      set((state) => {
        const accounts = new Map(state.accounts)
        for (const [id, account] of accounts) {
          const shouldBeActive = id === foundAccountId
          if (account.isActive !== shouldBeActive) {
            accounts.set(id, { ...account, isActive: shouldBeActive })
          }
        }
        return { accounts }
      })
      console.log('[Store] Synced active account from local SSO cache:', foundAccountId)
      get().saveToStorage()
      return
    }

    // No matching account found, try to import automatically (network request)
    console.log('[Store] Local account not found in app, importing...')
    const importResult = await window.api.loadKiroCredentials()
    if (!importResult.success || !importResult.data) return

    const verifyResult = await window.api.verifyAccountCredentials({
      refreshToken: importResult.data.refreshToken,
      clientId: importResult.data.clientId || '',
      clientSecret: importResult.data.clientSecret || '',
      region: importResult.data.region,
      authMethod: importResult.data.authMethod,
      provider: importResult.data.provider
    })
    if (!verifyResult.success || !verifyResult.data) return

    const now = Date.now()
    const newId = `${verifyResult.data.email}-${now}`
    const newAccount: Account = {
      id: newId,
      email: verifyResult.data.email,
      userId: verifyResult.data.userId,
      nickname: verifyResult.data.email ? verifyResult.data.email.split('@')[0] : undefined,
      idp: (importResult.data.provider || 'BuilderId') as 'BuilderId' | 'Google' | 'Github',
      credentials: {
        accessToken: verifyResult.data.accessToken,
        csrfToken: '',
        refreshToken: verifyResult.data.refreshToken,
        clientId: importResult.data.clientId || '',
        clientSecret: importResult.data.clientSecret || '',
        region: importResult.data.region || 'us-east-1',
        expiresAt: verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600 * 1000,
        authMethod: importResult.data.authMethod as 'IdC' | 'social',
        provider: (importResult.data.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
      },
      subscription: {
        type: verifyResult.data.subscriptionType as SubscriptionType,
        title: verifyResult.data.subscriptionTitle,
        rawType: verifyResult.data.subscription?.rawType,
        daysRemaining: verifyResult.data.daysRemaining,
        expiresAt: verifyResult.data.expiresAt,
        managementTarget: verifyResult.data.subscription?.managementTarget,
        upgradeCapability: verifyResult.data.subscription?.upgradeCapability,
        overageCapability: verifyResult.data.subscription?.overageCapability
      },
      usage: {
        current: verifyResult.data.usage.current,
        limit: verifyResult.data.usage.limit,
        percentUsed: verifyResult.data.usage.limit > 0
          ? verifyResult.data.usage.current / verifyResult.data.usage.limit
          : 0,
        lastUpdated: now,
        baseLimit: verifyResult.data.usage.baseLimit,
        baseCurrent: verifyResult.data.usage.baseCurrent,
        freeTrialLimit: verifyResult.data.usage.freeTrialLimit,
        freeTrialCurrent: verifyResult.data.usage.freeTrialCurrent,
        freeTrialExpiry: verifyResult.data.usage.freeTrialExpiry,
        bonuses: verifyResult.data.usage.bonuses,
        nextResetDate: verifyResult.data.usage.nextResetDate,
        resourceDetail: verifyResult.data.usage.resourceDetail
      },
      status: 'active',
      createdAt: now,
      lastUsedAt: now,
      tags: [],
      isActive: true
    }

    set((state) => {
      const accounts = new Map(state.accounts)
      // Cancel the activation status of other accounts
      for (const [id, account] of accounts) {
        if (account.isActive) {
          accounts.set(id, { ...account, isActive: false })
        }
      }
      accounts.set(newId, newAccount)
      return { accounts, activeAccountId: newId }
    })
    console.log('[Store] Auto-imported account from local SSO cache:', verifyResult.data.email)
    get().saveToStorage()
  } catch (e) {
    console.warn('[Store] Failed to sync local active account:', e)
  }
}

export function isBannedAccountError(error?: string): boolean {
  if (!error) return false
  const lowerError = error.toLowerCase()
  const hasSuspendedSignal =
    lowerError.includes('accountsuspendedexception') ||
    lowerError.includes('account suspended') ||
    lowerError.includes('temporarily_suspended') ||
    lowerError.includes('temporarily suspended') ||
    (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
    lowerError.includes('Account has been banned') ||
    lowerError.includes('Banned') ||
    /\b423\b/.test(lowerError)
  if (hasSuspendedSignal) return true
  if (
    lowerError.includes('fetch failed') ||
    lowerError.includes('network') ||
    lowerError.includes('token expired') ||
    lowerError.includes('token Expired') ||
    lowerError.includes('Refresh failed') ||
    lowerError.includes('unauthorizedexception')
  ) {
    return false
  }
  return false
}

// Automatic number change timer
let autoSwitchTimer: ReturnType<typeof setInterval> | null = null

// Scheduled automatic save timer (to prevent data loss)
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
const AUTO_SAVE_INTERVAL = 30 * 1000 // Every 30 Automatically save once every second
let lastSaveHash = '' // Used to detect whether data changes

interface AccountsState {
  // Application version number
  appVersion: string

  // data
  accounts: Map<string, Account>
  groups: Map<string, AccountGroup>
  tags: Map<string, AccountTag>

  // Currently active account
  activeAccountId: string | null

  // Filter and sort
  filter: AccountFilter
  /** Currently active group Tab：'all' | 'ungrouped' | <groupId>, mutually exclusive */
  activeGroupTab: string
  sort: AccountSort

  // Selected account (for batch operations)
  selectedIds: Set<string>

  // Loading status
  isLoading: boolean
  isSyncing: boolean

  // Auto refresh settings
  autoRefreshEnabled: boolean
  autoRefreshInterval: number // minute
  autoRefreshConcurrency: number // Automatically refresh the number of concurrency
  autoRefreshSyncInfo: boolean // Whether to synchronize the detection of account information (usage, subscription, ban status) when refreshing
  statusCheckInterval: number // minute

  // Active renewal switch (persistent in main process electron-store;This is just a mirror image, no writing saveToStorage）
  proactiveRenewalEnabled: boolean
  proactiveRenewalLeadMinutes: number

  // privacy mode
  privacyMode: boolean

  // Usage display accuracy
  usagePrecision: boolean // true: Show exact decimals, false: Display integer

  // proxy settings
  proxyEnabled: boolean
  proxyUrl: string // Format: http://host:port or socks5://host:port

  // Automatic number change settings
  autoSwitchEnabled: boolean
  autoSwitchThreshold: number // Balance threshold, automatically switch when it is lower than this value
  autoSwitchInterval: number // Check interval (minutes)

  // Batch import settings
  batchImportConcurrency: number // Number of concurrent batch imports

  // Log in to browser privacy mode
  loginPrivateMode: boolean // Use browser privacy when logged in/Incognito mode

  // Number cutting target setting
  switchTarget: 'ide' | 'cli' | 'both' // ide=only Kiro IDE, cli=only Kiro CLI, both=cut both

  // Theme settings
  theme: string // Topic name: default, purple, emerald, orange, rose, cyan, amber
  darkMode: boolean // dark mode

  // Language settings
  language: 'auto' | 'en' | 'zh' // auto: Follow the system

  // Machine code management
  machineIdConfig: {
    autoSwitchOnAccountChange: boolean // Automatically change the machine code when cutting numbers
    bindMachineIdToAccount: boolean // Account machine code binding
    useBindedMachineId: boolean // Use bound machine code (otherwise randomly generated)
  }
  currentMachineId: string // Current machine code
  originalMachineId: string | null // Backup original machine code
  originalBackupTime: number | null // Original machine code backup time
  accountMachineIds: Record<string, string> // Machine code mapping for account binding
  machineIdHistory: Array<{
    id: string
    machineId: string
    timestamp: number
    action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
    accountId?: string
    accountEmail?: string
  }>

  // ============ Agent pool (used when registering IP rotation)============
  /** Agent entry list (Map ensure O(1) Find) */
  proxyPool: Map<string, ProxyEntry>
  /** Agent pool configuration (enablement status, scheduling policy, etc.) */
  proxyPoolConfig: ProxyPoolConfig
  /** Poll schedule cursor (only for round_robin Strategy) */
  proxyPoolCursor: number
  /** account-proxy binding map(accountId → proxyId); used for"Against the times N Shared by accounts 1 indivual IP" */
  accountProxyBindings: Record<string, string>
}

interface AccountsActions {
  // account CRUD
  addAccount: (account: Omit<Account, 'id' | 'createdAt' | 'isActive'>) => string
  updateAccount: (id: string, updates: Partial<Account>) => void
  removeAccount: (id: string) => void
  removeAccounts: (ids: string[]) => BatchOperationResult

  // Activate account
  setActiveAccount: (id: string | null) => void
  getActiveAccount: () => Account | null

  // Grouping operations
  addGroup: (group: Omit<AccountGroup, 'id' | 'createdAt' | 'order'>) => string
  updateGroup: (id: string, updates: Partial<AccountGroup>) => void
  removeGroup: (id: string) => void
  moveAccountsToGroup: (accountIds: string[], groupId: string | undefined) => void

  // Label operations
  addTag: (tag: Omit<AccountTag, 'id'>) => string
  updateTag: (id: string, updates: Partial<AccountTag>) => void
  removeTag: (id: string) => void
  addTagToAccounts: (accountIds: string[], tagId: string) => void
  removeTagFromAccounts: (accountIds: string[], tagId: string) => void

  // Filter and sort
  setFilter: (filter: AccountFilter) => void
  clearFilter: () => void
  setActiveGroupTab: (tab: string) => void
  setSort: (sort: AccountSort) => void
  getFilteredAccounts: () => Account[]

  // Select action
  selectAccount: (id: string) => void
  deselectAccount: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
  toggleSelection: (id: string) => void
  getSelectedAccounts: () => Account[]

  // Import and export
  exportAccounts: (ids?: string[]) => AccountExportData
  importAccounts: (items: AccountImportItem[]) => BatchOperationResult
  importFromExportData: (data: AccountExportData) => BatchOperationResult

  // Status management
  updateAccountStatus: (id: string, status: AccountStatus, error?: string) => void
  refreshAccountToken: (id: string) => Promise<boolean>
  batchRefreshTokens: (ids: string[]) => Promise<BatchOperationResult>
  checkAccountStatus: (id: string) => Promise<void>
  batchCheckStatus: (ids: string[]) => Promise<BatchOperationResult>

  // statistics
  getStats: () => AccountStats

  // persistence
  loadFromStorage: () => Promise<void>
  /** Anti-shake trigger persistence (recommended: high frequency mutation Automatically merge write disks) */
  saveToStorage: () => Promise<void>
  /** Immediate persistence (for beforeunload or key operational scenarios) */
  flushSaveImmediately: () => Promise<void>

  // set up
  setAutoRefresh: (enabled: boolean, interval?: number) => void
  setAutoRefreshConcurrency: (concurrency: number) => void
  setAutoRefreshSyncInfo: (enabled: boolean) => void
  /** tune main process IPC, synchronization is enabled/Turn off active renewal; update the local image after success */
  setProactiveRenewalEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  /** from main The process reads the current status of the active renewal switch */
  loadProactiveRenewalEnabled: () => Promise<void>
  setStatusCheckInterval: (interval: number) => void

  // privacy mode
  setPrivacyMode: (enabled: boolean) => void
  maskEmail: (email: string) => string
  maskNickname: (nickname: string | undefined) => string

  // Usage accuracy
  setUsagePrecision: (enabled: boolean) => void

  // proxy settings
  setProxy: (enabled: boolean, url?: string) => Promise<void>

  // Theme settings
  setTheme: (theme: string) => void
  setDarkMode: (enabled: boolean) => void
  applyTheme: () => void

  // Language settings
  setLanguage: (language: 'auto' | 'en' | 'zh') => void

  // Automatic number change
  setAutoSwitch: (enabled: boolean, threshold?: number, interval?: number) => void

  // Number of concurrent batch imports
  setBatchImportConcurrency: (concurrency: number) => void

  // Log in to browser privacy mode
  setLoginPrivateMode: (enabled: boolean) => void

  // Number cutting target setting
  setSwitchTarget: (target: 'ide' | 'cli' | 'both') => void

  startAutoSwitch: () => void
  stopAutoSwitch: () => void
  checkAndAutoSwitch: () => Promise<void>

  // automatic Token refresh
  startAutoTokenRefresh: () => void
  stopAutoTokenRefresh: () => void
  checkAndRefreshExpiringTokens: () => Promise<void>
  refreshExpiredTokensOnly: () => Promise<void>
  triggerBackgroundRefresh: () => Promise<void>
  handleBackgroundRefreshResult: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  handleBackgroundCheckResult: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  /** Batch processing background refresh results: once set application N results, eliminate N Second-rate Map Full copy */
  applyBackgroundRefreshResults: (items: Array<{ id: string; success: boolean; data?: unknown; error?: string }>) => void
  /** Batch processing background check results: once set application N results */
  applyBackgroundCheckResults: (items: Array<{ id: string; success: boolean; data?: unknown; error?: string }>) => void

  // Automatically save regularly (to prevent data loss)
  startAutoSave: () => void
  stopAutoSave: () => void

  // Machine code management
  setMachineIdConfig: (config: Partial<{
    autoSwitchOnAccountChange: boolean
    bindMachineIdToAccount: boolean
    useBindedMachineId: boolean
  }>) => void
  refreshCurrentMachineId: () => Promise<void>
  changeMachineId: (newMachineId?: string) => Promise<boolean>
  restoreOriginalMachineId: () => Promise<boolean>
  bindMachineIdToAccount: (accountId: string, machineId?: string) => void
  getMachineIdForAccount: (accountId: string) => string | null
  backupOriginalMachineId: () => void
  clearMachineIdHistory: () => void

  // ============ Agent pool operations ============
  /** Add a single proxy (automatically resolve protocols/Host/port/certification) */
  addProxy: (url: string, options?: { label?: string; source?: string; tags?: string[] }) => string | null
  /** Batch import (text, one per line, supported http://host:port、socks5://user:pass@host:port、host:port wait) */
  importProxies: (text: string) => { added: number; skipped: number; failed: number }
  /** Delete proxy */
  removeProxy: (id: string) => void
  /** Batch delete */
  removeProxies: (ids: string[]) => void
  /** Toggle enabled status */
  toggleProxyEnabled: (id: string, enabled?: boolean) => void
  /** Update agent metadata */
  updateProxy: (id: string, updates: Partial<ProxyEntry>) => void
  /** Testing a single agent (asynchronous, main process execution) */
  validateProxy: (id: string) => Promise<ProxyValidationResult>
  /** Batch testing (concurrency) */
  validateProxiesBatch: (ids: string[], concurrency?: number) => Promise<void>
  /** Clear all proxies */
  clearProxyPool: () => void
  /** Update proxy pool configuration */
  setProxyPoolConfig: (config: Partial<ProxyPoolConfig>) => void
  /** Select the next available agent according to the current policy (called internally in the registration process) */
  pickNextProxy: () => ProxyEntry | null
  /** Mark agent usage results (for reporting during the registration process, for failure counting and automatic deactivation) */
  reportProxyResult: (id: string, success: boolean, boundEmail?: string, errorMsg?: string) => void

  // ============ account-Proxy binding (anti-generation bucketing)============
  /** Bind the account to the designated agent */
  bindAccountToProxy: (accountId: string, proxyId: string) => void
  /** Bulk binding (for bulk allocation) */
  bindAccountsToProxy: (accountIds: string[], proxyId: string) => void
  /** Unbind account */
  unbindAccountFromProxy: (accountId: string) => void
  /** Clear all account bindings */
  clearAccountProxyBindings: () => void
  /**
   * Automatic allocation: press the account number N:1 The proportion is evenly distributed among the currently enabled agents.
   * @param accountsPerProxy The number of accounts carried by each agent; is 0 Means to divide as equally as possible
   * @param onlyUnbound Whether to assign only unbound accounts;false then reallocate all
   * @returns Distribution statistics
   */
  autoDistributeAccountsToProxies: (params: {
    accountsPerProxy?: number
    onlyUnbound?: boolean
    accountIds?: string[]  // Limit the distribution range, if not filled in, all
  }) => { distributed: number; perProxy: Record<string, number>; skipped: number }
  /** Read the agent bound to the account URL(for main process synchronization) */
  getAccountProxyUrl: (accountId: string) => string | undefined
}

type AccountsStore = AccountsState & AccountsActions

// Default sort
const defaultSort: AccountSort = { field: 'lastUsedAt', order: 'desc' }

// Default filter
const defaultFilter: AccountFilter = {}

// from localStorage recovery group Tab(follow Electron renderer environment is always available)
const loadActiveGroupTab = (): string => {
  try {
    return localStorage.getItem('accounts_activeGroupTab') || 'all'
  } catch {
    return 'all'
  }
}

export const useAccountsStore = create<AccountsStore>()((set, get) => ({
  // initial state
  appVersion: '1.0.0',
  accounts: new Map(),
  groups: new Map(),
  tags: new Map(),
  activeAccountId: null,
  filter: defaultFilter,
  activeGroupTab: loadActiveGroupTab(),
  sort: defaultSort,
  selectedIds: new Set(),
  isLoading: false,
  isSyncing: false,
  autoRefreshEnabled: true,
  autoRefreshInterval: 5,
  autoRefreshConcurrency: 100,
  autoRefreshSyncInfo: true,
  statusCheckInterval: 60,
  proactiveRenewalEnabled: false,
  proactiveRenewalLeadMinutes: 15,
  privacyMode: false,
  usagePrecision: false,
  proxyEnabled: false,
  proxyUrl: '',
  autoSwitchEnabled: false,
  autoSwitchThreshold: 0,
  autoSwitchInterval: 5,
  batchImportConcurrency: 100,
  loginPrivateMode: false,
  switchTarget: 'ide' as const,
  theme: 'default',
  darkMode: false,
  language: 'auto',

  machineIdConfig: {
    autoSwitchOnAccountChange: false,
    bindMachineIdToAccount: false,
    useBindedMachineId: true
  },
  currentMachineId: '',
  originalMachineId: null,
  originalBackupTime: null,
  accountMachineIds: {},
  machineIdHistory: [],

  // Agent pool initial state
  proxyPool: new Map<string, ProxyEntry>(),
  proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG },
  proxyPoolCursor: 0,
  accountProxyBindings: {},

  // ==================== account CRUD ====================

  addAccount: (accountData) => {
    const id = uuidv4()
    const now = Date.now()

    // if not provided machineId, automatically generate a random 64 bit hexadecimal device ID
    const machineId = accountData.machineId || generateRandomMachineId()

    const account: Account = {
      ...accountData,
      id,
      machineId,
      createdAt: now,
      lastUsedAt: now,
      isActive: false,
      tags: accountData.tags || []
    }

    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.set(id, account)
      return { accounts }
    })

    get().saveToStorage()
    return id
  },

  updateAccount: (id, updates) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, { ...account, ...updates })
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeAccount: (id) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.delete(id)

      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)

      const activeAccountId = state.activeAccountId === id ? null : state.activeAccountId

      // Clean up the account at the same time-proxy binding
      const bindings = { ...state.accountProxyBindings }
      delete bindings[id]

      return { accounts, selectedIds, activeAccountId, accountProxyBindings: bindings }
    })
    get().saveToStorage()
  },

  removeAccounts: (ids) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    set((state) => {
      const accounts = new Map(state.accounts)
      const selectedIds = new Set(state.selectedIds)
      let activeAccountId = state.activeAccountId
      const bindings = { ...state.accountProxyBindings }

      for (const id of ids) {
        if (accounts.has(id)) {
          accounts.delete(id)
          selectedIds.delete(id)
          delete bindings[id]
          if (activeAccountId === id) activeAccountId = null
          result.success++
        } else {
          result.failed++
          result.errors.push({ id, error: 'Account not found' })
        }
      }

      return { accounts, selectedIds, activeAccountId, accountProxyBindings: bindings }
    })

    get().saveToStorage()
    return result
  },

  // ==================== Activate account ====================

  setActiveAccount: async (id) => {
    const state = get()
    
    set((s) => {
      const accounts = new Map(s.accounts)

      // Cancel previous activation status
      if (s.activeAccountId) {
        const prev = accounts.get(s.activeAccountId)
        if (prev) {
          accounts.set(s.activeAccountId, { ...prev, isActive: false })
        }
      }

      // Set new activation status
      if (id) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, { ...account, isActive: true, lastUsedAt: Date.now() })
        }
      }

      return { accounts, activeAccountId: id }
    })
    
    // Automatically change the machine code when switching accounts (if enabled)
    if (id && state.machineIdConfig.autoSwitchOnAccountChange) {
      try {
        const account = state.accounts.get(id)
        
        if (state.machineIdConfig.bindMachineIdToAccount) {
          // Use the machine code bound to the account
          let boundMachineId = state.accountMachineIds[id]
          
          if (!boundMachineId) {
            // If there is no machine code bound, generate one for the account
            boundMachineId = await window.api.machineIdGenerateRandom()
            get().bindMachineIdToAccount(id, boundMachineId)
          }
          
          if (state.machineIdConfig.useBindedMachineId) {
            // Use bound machine code
            await get().changeMachineId(boundMachineId)
          } else {
            // Randomly generate new machine code
            await get().changeMachineId()
          }
        } else {
          // Randomly generate new machine code every time you switch
          await get().changeMachineId()
        }
        
        // Update history
        const newMachineId = get().currentMachineId
        set((s) => ({
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: newMachineId,
              timestamp: Date.now(),
              action: 'auto_switch' as const,
              accountId: id,
              accountEmail: account?.email
            }
          ]
        }))
        
        console.log(`[MachineId] Auto-switched machine ID for account: ${account?.email}`)
      } catch (error) {
        console.error('[MachineId] Failed to auto-switch machine ID:', error)
      }
    }
    
    get().saveToStorage()
  },

  getActiveAccount: () => {
    const { accounts, activeAccountId } = get()
    return activeAccountId ? accounts.get(activeAccountId) ?? null : null
  },

  // ==================== Grouping operations ====================

  addGroup: (groupData) => {
    const id = uuidv4()
    const { groups } = get()

    const group: AccountGroup = {
      ...groupData,
      id,
      order: groups.size,
      createdAt: Date.now()
    }

    set((state) => {
      const groups = new Map(state.groups)
      groups.set(id, group)
      return { groups }
    })

    get().saveToStorage()
    return id
  },

  updateGroup: (id, updates) => {
    set((state) => {
      const groups = new Map(state.groups)
      const group = groups.get(id)
      if (group) {
        groups.set(id, { ...group, ...updates })
      }
      return { groups }
    })
    get().saveToStorage()
  },

  removeGroup: (id) => {
    set((state) => {
      const groups = new Map(state.groups)
      groups.delete(id)

      // Remove account group reference
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.groupId === id) {
          accounts.set(accountId, { ...account, groupId: undefined })
        }
      }

      return { groups, accounts }
    })
    get().saveToStorage()
  },

  moveAccountsToGroup: (accountIds, groupId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, { ...account, groupId })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== Label operations ====================

  addTag: (tagData) => {
    const id = uuidv4()

    const tag: AccountTag = { ...tagData, id }

    set((state) => {
      const tags = new Map(state.tags)
      tags.set(id, tag)
      return { tags }
    })

    get().saveToStorage()
    return id
  },

  updateTag: (id, updates) => {
    set((state) => {
      const tags = new Map(state.tags)
      const tag = tags.get(id)
      if (tag) {
        tags.set(id, { ...tag, ...updates })
      }
      return { tags }
    })
    get().saveToStorage()
  },

  removeTag: (id) => {
    set((state) => {
      const tags = new Map(state.tags)
      tags.delete(id)

      // Remove account label reference
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.tags.includes(id)) {
          accounts.set(accountId, {
            ...account,
            tags: account.tags.filter((t) => t !== id)
          })
        }
      }

      return { tags, accounts }
    })
    get().saveToStorage()
  },

  addTagToAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account && !account.tags.includes(tagId)) {
          accounts.set(id, { ...account, tags: [...account.tags, tagId] })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeTagFromAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, {
            ...account,
            tags: account.tags.filter((t) => t !== tagId)
          })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== Filter and sort ====================

  setFilter: (filter) => {
    set({ filter })
  },

  clearFilter: () => {
    set({ filter: defaultFilter })
  },

  setActiveGroupTab: (tab) => {
    try { localStorage.setItem('accounts_activeGroupTab', tab) } catch { /* no-op */ }
    set({ activeGroupTab: tab })
  },

  setSort: (sort) => {
    set({ sort })
  },

  getFilteredAccounts: () => {
    const { accounts, filter, sort, activeGroupTab } = get()

    // Reference cache hit: Returns the last result (the array is the same as the reference, which is convenient for consumers useMemo multiplexing)
    if (
      _filterCache &&
      _filterCache.accounts === accounts &&
      _filterCache.filter === filter &&
      _filterCache.sort === sort &&
      _filterCache.activeGroupTab === activeGroupTab
    ) {
      return _filterCache.output
    }

    let result = Array.from(accounts.values())

    // Prioritize by group Tab Mutually exclusive filtering (with filter.groupIds independent)
    if (activeGroupTab === 'ungrouped') {
      result = result.filter((a) => !a.groupId)
    } else if (activeGroupTab !== 'all') {
      result = result.filter((a) => a.groupId === activeGroupTab)
    }

    // Apply filters
    if (filter.search) {
      const search = filter.search.toLowerCase()
      result = result.filter(
        (a) =>
          a.email.toLowerCase().includes(search) ||
          a.nickname?.toLowerCase().includes(search)
      )
    }

    if (filter.subscriptionTypes?.length) {
      result = result.filter((a) => filter.subscriptionTypes!.includes(a.subscription.type))
    }

    if (filter.statuses?.length) {
      result = result.filter((a) => filter.statuses!.includes(a.status))
    }

    if (filter.idps?.length) {
      result = result.filter((a) => filter.idps!.includes(a.idp))
    }

    if (filter.groupIds?.length) {
      result = result.filter((a) => a.groupId && filter.groupIds!.includes(a.groupId))
    }

    if (filter.tagIds?.length) {
      result = result.filter((a) => filter.tagIds!.some((t) => a.tags.includes(t)))
    }

    if (filter.emailDomains?.length) {
      result = result.filter((a) => {
        const atIndex = a.email.lastIndexOf('@')
        if (atIndex < 0) return false
        const domain = a.email.slice(atIndex + 1).toLowerCase()
        return filter.emailDomains!.includes(domain)
      })
    }

    if (filter.usageMin !== undefined) {
      result = result.filter((a) => a.usage.percentUsed >= filter.usageMin!)
    }

    if (filter.usageMax !== undefined) {
      result = result.filter((a) => a.usage.percentUsed <= filter.usageMax!)
    }

    if (filter.daysRemainingMin !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining >= filter.daysRemainingMin!
      )
    }

    if (filter.daysRemainingMax !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining <= filter.daysRemainingMax!
      )
    }

    // ban filter
    if (filter.bannedOnly) {
      result = result.filter((a) => isBannedAccountError(a.lastError))
    }

    // Apply sorting
    result.sort((a, b) => {
      let cmp = 0

      switch (sort.field) {
        case 'email':
          cmp = a.email.localeCompare(b.email)
          break
        case 'nickname':
          cmp = (a.nickname ?? '').localeCompare(b.nickname ?? '')
          break
        case 'subscription':
          cmp = a.subscription.type.localeCompare(b.subscription.type)
          break
        case 'usage':
          cmp = a.usage.percentUsed - b.usage.percentUsed
          break
        case 'daysRemaining':
          cmp = (a.subscription.daysRemaining ?? 999) - (b.subscription.daysRemaining ?? 999)
          break
        case 'lastUsedAt':
          cmp = a.lastUsedAt - b.lastUsedAt
          break
        case 'createdAt':
          cmp = a.createdAt - b.createdAt
          break
        case 'status':
          cmp = a.status.localeCompare(b.status)
          break
      }

      return sort.order === 'desc' ? -cmp : cmp
    })

    // Write cache: The same input will hit directly next time
    _filterCache = { accounts, filter, sort, activeGroupTab, output: result }
    return result
  },

  // ==================== Select action ====================

  selectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.add(id)
      return { selectedIds }
    })
  },

  deselectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)
      return { selectedIds }
    })
  },

  selectAll: () => {
    const filtered = get().getFilteredAccounts()
    set({ selectedIds: new Set(filtered.map((a) => a.id)) })
  },

  deselectAll: () => {
    set({ selectedIds: new Set() })
  },

  toggleSelection: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) {
        selectedIds.delete(id)
      } else {
        selectedIds.add(id)
      }
      return { selectedIds }
    })
  },

  getSelectedAccounts: () => {
    const { accounts, selectedIds } = get()
    return Array.from(selectedIds)
      .map((id) => accounts.get(id))
      .filter((a): a is Account => a !== undefined)
  },

  // ==================== Import and export ====================

  exportAccounts: (ids) => {
    const { accounts, groups, tags } = get()

    let exportAccounts: Account[]
    if (ids?.length) {
      exportAccounts = ids
        .map((id) => accounts.get(id))
        .filter((a): a is Account => a !== undefined)
    } else {
      exportAccounts = Array.from(accounts.values())
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const data: AccountExportData = {
      version: get().appVersion,
      exportedAt: Date.now(),
      accounts: exportAccounts.map(({ isActive, ...rest }) => rest),
      groups: Array.from(groups.values()),
      tags: Array.from(tags.values())
    }

    return data
  },

  importAccounts: (items) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    // verify idp Is it valid?
    const validIdps = ['Google', 'Github', 'BuilderId'] as const
    const normalizeIdp = (idp?: string): IdpType => {
      if (!idp) return 'Google'
      const normalized = validIdps.find(v => v.toLowerCase() === idp.toLowerCase())
      return normalized || 'Google'
    }

    // Construct account objects in batches + once set,avoid N Second-rate new Map(O(n²)) and N Second-rate re-render
    const newAccounts: Account[] = []
    for (const item of items) {
      try {
        const now = Date.now()
        const id = uuidv4()
        const machineId = generateRandomMachineId()

        const account: Account = {
          id,
          createdAt: now,
          isActive: false,
          machineId,
          email: item.email,
          password: item.password,
          nickname: item.nickname,
          idp: normalizeIdp(item.idp as string),
          credentials: {
            accessToken: item.accessToken || '',
            csrfToken: item.csrfToken || '',
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || 'us-east-1',
            expiresAt: now + 3600 * 1000
          },
          subscription: {
            type: 'Free'
          },
          usage: {
            current: 0,
            limit: 25,
            percentUsed: 0,
            lastUpdated: now
          },
          groupId: item.groupId,
          tags: item.tags ?? [],
          status: 'unknown',
          lastUsedAt: now
        }
        newAccounts.push(account)
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: item.email,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    if (newAccounts.length > 0) {
      set((state) => {
        // complete only once Map copy
        const accounts = new Map(state.accounts)
        for (const account of newAccounts) {
          accounts.set(account.id, account)
        }
        return { accounts }
      })
      // Anti-shake triggers one-time persistence
      get().saveToStorage()
    }

    return result
  },

  importFromExportData: (data) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }
    const { accounts: existingAccounts } = get()
    
    // Check if the account already exists (same email address+sameprovider or sameuserId Only if it is repeated)
    const isAccountExists = (email: string, userId?: string, provider?: string): boolean => {
      return Array.from(existingAccounts.values()).some(acc => {
        // userId Repeat if same
        if (userId && acc.userId === userId) return true
        // email same and provider If the same, it will be repeated (different login methods for the same email address are allowed)
        if (acc.email === email && acc.credentials.provider === provider) return true
        return false
      })
    }
    
    // Deduplication: Deduplication within files
    const seenEmails = new Set<string>()
    const seenUserIds = new Set<string>()
    const uniqueAccounts = data.accounts.filter(acc => {
      if (seenEmails.has(acc.email) || (acc.userId && seenUserIds.has(acc.userId))) {
        return false
      }
      seenEmails.add(acc.email)
      if (acc.userId) seenUserIds.add(acc.userId)
      return true
    })

    // Collect all changes, once set,avoid N Second-rate new Map（O(n²)）
    let skipped = 0
    const accountsToAdd: Account[] = []

    for (const accountData of uniqueAccounts) {
      // Check if local already exists (pass in provider parameter)
      if (isAccountExists(accountData.email, accountData.userId, accountData.credentials?.provider)) {
        skipped++
        continue
      }
      try {
        accountsToAdd.push({ ...accountData, isActive: false })
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: accountData.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    // once set Apply all groups, labels, accounts — Single re-render
    if (data.groups.length > 0 || data.tags.length > 0 || accountsToAdd.length > 0) {
      set((state) => {
        const groups = data.groups.length > 0 ? new Map(state.groups) : state.groups
        if (data.groups.length > 0) {
          for (const group of data.groups) groups.set(group.id, group)
        }
        const tags = data.tags.length > 0 ? new Map(state.tags) : state.tags
        if (data.tags.length > 0) {
          for (const tag of data.tags) tags.set(tag.id, tag)
        }
        const accounts = accountsToAdd.length > 0 ? new Map(state.accounts) : state.accounts
        if (accountsToAdd.length > 0) {
          for (const acc of accountsToAdd) accounts.set(acc.id, acc)
        }
        return { groups, tags, accounts }
      })
    }

    // Record skip count
    if (skipped > 0) {
      result.errors.push({
        id: 'skipped',
        error: `jump over ${skipped} existing accounts`
      })
    }

    get().saveToStorage()
    return result
  },

  // ==================== Status management ====================

  updateAccountStatus: (id, status, error) => {
    const wasBanned = isBannedAccountError(get().accounts.get(id)?.lastError)
    const isBanned = isBannedAccountError(error)
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, {
          ...account,
          status,
          lastError: error,
          lastCheckedAt: Date.now()
        })
      }
      return { accounts }
    })
    get().saveToStorage()
    // trigger webhook: Notification when the account has just been banned (those already banned will not be repeated)
    if (isBanned && !wasBanned) {
      const acc = get().accounts.get(id)
      triggerWebhook('account-banned', {
        title: 'Account banned',
        message: `account ${acc?.email || id} Status changed to banned`,
        level: 'error',
        fields: { Mail: acc?.email || '-', mistake: error || '-' }
      })
    }
  },

  refreshAccountToken: async (id) => {
    const { accounts, updateAccountStatus } = get()
    const account = accounts.get(id)

    if (!account) return false

    updateAccountStatus(id, 'refreshing')

    try {
      // Called through the main process Kiro API refresh Token(avoid CORS）
      const result = await window.api.refreshAccountToken(account)

      if (result.success && result.data) {
        // when refresh back main The process detects that the account is IDE The currently activated account will be automatically synchronized to disk. token document;
        // Otherwise only update the reverse generation store，IDE Still used token —— Remind users to avoid mistaking"refresh pair IDE Also effective"
        if (result.data.syncedToIde) {
          console.log(`[refreshAccountToken] Token refreshed AND synced to Kiro IDE (account=${account.email})`)
        } else {
          console.warn(
            `[refreshAccountToken] Token refreshed but NOT synced to Kiro IDE (account=${account.email}). ` +
              `Reason: ${result.data.syncSkipReason || 'unknown'}. ` +
              `Kiro IDE will still use its previously cached token until its own refresh loop kicks in.`
          )
        }

        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            // Enterprise When the account is refreshed, the main process will return true profileArn, persistence to avoid subsequent repeated acquisitions
            const resolvedProfileArn = result.data!.profileArn || acc.credentials.profileArn || acc.profileArn
            accounts.set(id, {
              ...acc,
              profileArn: resolvedProfileArn,
              credentials: {
                ...acc.credentials,
                accessToken: result.data!.accessToken,
                // If a new one is returned refreshToken, update it
                refreshToken: result.data!.refreshToken || acc.credentials.refreshToken,
                expiresAt: Date.now() + result.data!.expiresIn * 1000,
                profileArn: resolvedProfileArn
              },
              status: 'active',
              lastError: undefined,
              lastCheckedAt: Date.now()
            })
          }
          return { accounts }
        })
        get().saveToStorage()
        return true
      } else {
        updateAccountStatus(id, 'error', result.error?.message)
        // trigger webhook：Token Refresh failed
        triggerWebhook('token-expired', {
          title: 'Token Refresh failed',
          message: `account ${account.email} Token Refresh failed`,
          level: 'warn',
          fields: { Mail: account.email, mistake: result.error?.message || '-' }
        })
        return false
      }
    } catch (error) {
      updateAccountStatus(id, 'error', error instanceof Error ? error.message : 'Unknown error')
      return false
    }
  },

  batchRefreshTokens: async (ids) => {
    const { accounts, autoRefreshConcurrency } = get()
    
    // Collect accounts that need to be refreshed
    const accountsToRefresh: Array<{
      id: string
      email: string
      profileArn?: string
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
    }> = []

    for (const id of ids) {
      const account = accounts.get(id)
      if (!account?.credentials.refreshToken) continue
      
      accountsToRefresh.push({
        id,
        email: account.email,
        profileArn: account.profileArn,
        credentials: {
          refreshToken: account.credentials.refreshToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod,
          accessToken: account.credentials.accessToken,
          provider: account.credentials.provider || account.idp,
          profileArn: account.credentials.profileArn
        }
      })
    }

    if (accountsToRefresh.length === 0) {
      return { success: 0, failed: 0, errors: [] }
    }

    console.log(`[BatchRefresh] Triggering background refresh for ${accountsToRefresh.length} accounts...`)
    
    // Use background refresh API(not blocking UI）
    const result = await window.api.backgroundBatchRefresh(accountsToRefresh, autoRefreshConcurrency)
    
    return { 
      success: result.successCount, 
      failed: result.failedCount, 
      errors: [] 
    }
  },

  checkAccountStatus: async (id) => {
    const { accounts, updateAccountStatus } = get()
    const account = accounts.get(id)

    if (!account) return

    // Set refresh status and provide visual feedback
    updateAccountStatus(id, 'refreshing')

    try {
      // Called through the main process Kiro API Get status (avoid CORS）
      const result = await window.api.checkAccountStatus(account)

      if (result.success && result.data) {
        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            // if token Refreshed, update credentials
            const updatedCredentials = result.data!.newCredentials 
              ? {
                  ...acc.credentials,
                  accessToken: result.data!.newCredentials.accessToken,
                  refreshToken: result.data!.newCredentials.refreshToken ?? acc.credentials.refreshToken,
                  expiresAt: result.data!.newCredentials.expiresAt ?? acc.credentials.expiresAt
                }
              : acc.credentials

            // merge usage data, making sure to include all necessary fields
            const apiUsage = result.data!.usage
            const mergedUsage = apiUsage ? {
              current: apiUsage.current ?? acc.usage.current,
              limit: apiUsage.limit ?? acc.usage.limit,
              percentUsed: apiUsage.limit > 0 ? apiUsage.current / apiUsage.limit : 0,
              lastUpdated: apiUsage.lastUpdated ?? Date.now(),
              baseLimit: apiUsage.baseLimit,
              baseCurrent: apiUsage.baseCurrent,
              freeTrialLimit: apiUsage.freeTrialLimit,
              freeTrialCurrent: apiUsage.freeTrialCurrent,
              freeTrialExpiry: apiUsage.freeTrialExpiry,
              bonuses: apiUsage.bonuses,
              nextResetDate: apiUsage.nextResetDate,
              resourceDetail: apiUsage.resourceDetail
            } : acc.usage

            // Merge subscription information
            const apiSub = result.data!.subscription
            const mergedSubscription = apiSub ? {
              ...acc.subscription,
              ...apiSub
            } : acc.subscription

            // Convert IDP Type (keep the original value first, update only when there is a clear match)
            const apiIdp = result.data!.idp
            let idpType = acc.idp
            if (apiIdp) {
              if (apiIdp === 'BuilderId') idpType = 'BuilderId'
              else if (apiIdp === 'Google') idpType = 'Google'
              else if (apiIdp === 'Github') idpType = 'Github'
              else if (apiIdp === 'AWSIdC') idpType = 'AWSIdC'
              else if (apiIdp === 'Enterprise' || apiIdp === 'Internal') idpType = 'Enterprise'
              // Unknown types keep their original values ​​and are not forced to change to Internal
            }

            accounts.set(id, {
              ...acc,
              // Update email (if API returned)
              email: result.data!.email ?? acc.email,
              userId: result.data!.userId ?? acc.userId,
              idp: idpType,
              status: result.data!.status as AccountStatus,
              usage: mergedUsage,
              subscription: mergedSubscription as AccountSubscription,
              credentials: updatedCredentials,
              lastCheckedAt: Date.now(),
              lastError: undefined
            })
          }
          return { accounts }
        })
        get().saveToStorage()
        
        // If refreshed token, print log
        if (result.data.newCredentials) {
          console.log(`[Account] Token refreshed for ${account?.email}`)
        }
      } else {
        // Check if it is a ban error
        const isBanned = (result.error as { isBanned?: boolean })?.isBanned
        if (isBanned) {
          // Ban account: Set error status and mark as banned
          updateAccountStatus(id, 'error', `Account has been banned: ${result.error?.message}`)
        } else {
          updateAccountStatus(id, 'error', result.error?.message)
        }
      }
    } catch (error) {
      updateAccountStatus(id, 'error', error instanceof Error ? error.message : 'Unknown error')
    }
  },

  batchCheckStatus: async (ids) => {
    const { accounts, autoRefreshConcurrency } = get()
    
    // Collect accounts that need to be checked (use batch check API, do not refresh Token）
    const accountsToCheck: Array<{
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
    }> = []

    for (const id of ids) {
      const account = accounts.get(id)
      if (!account?.credentials.accessToken) continue
      
      accountsToCheck.push({
        id,
        email: account.email,
        credentials: {
          accessToken: account.credentials.accessToken,
          refreshToken: account.credentials.refreshToken,
          clientId: account.credentials.clientId,
          clientSecret: account.credentials.clientSecret,
          region: account.credentials.region,
          authMethod: account.credentials.authMethod,
          provider: account.credentials.provider
        },
        idp: account.idp
      })
    }

    if (accountsToCheck.length === 0) {
      return { success: 0, failed: 0, errors: [] }
    }

    console.log(`[BatchCheck] Triggering background check for ${accountsToCheck.length} accounts...`)
    
    // Use background checks API(Only check status, do not refresh Token）
    const result = await window.api.backgroundBatchCheck(accountsToCheck, autoRefreshConcurrency)
    
    return { 
      success: result.successCount, 
      failed: result.failedCount, 
      errors: [] 
    }
  },

  // ==================== statistics ====================

  getStats: () => {
    const { accounts } = get()

    // Reference cache hit: avoid re-rendering every time O(n) Traverse
    if (_statsCache && _statsCache.accounts === accounts) {
      return _statsCache.output
    }

    const accountList = Array.from(accounts.values())

    const stats: AccountStats = {
      total: accountList.length,
      byStatus: {
        active: 0,
        expired: 0,
        error: 0,
        refreshing: 0,
        unknown: 0
      },
      bySubscription: {
        Free: 0,
        Pro: 0,
        Pro_Plus: 0,
        Enterprise: 0,
        Teams: 0
      },
      byIdp: {
        Google: 0,
        Github: 0,
        BuilderId: 0,
        Enterprise: 0,
        AWSIdC: 0,
        Internal: 0,
        IAM_SSO: 0
      },
      activeCount: 0,
      expiringSoonCount: 0,
      bannedCount: 0
    }

    for (const account of accountList) {
      stats.byStatus[account.status]++
      stats.bySubscription[account.subscription.type]++
      stats.byIdp[account.idp]++

      if (account.isActive) stats.activeCount++
      if (account.subscription.daysRemaining !== undefined &&
          account.subscription.daysRemaining <= 7) {
        stats.expiringSoonCount++
      }
      // Statistics of banned accounts
      if (isBannedAccountError(account.lastError)) {
        stats.bannedCount++
      }
    }

    _statsCache = { accounts, output: stats }
    return stats
  },

  // ==================== persistence ====================

  loadFromStorage: async () => {
    set({ isLoading: true })

    try {
      // Get application version number
      const appVersion = await window.api.getAppVersion()
      set({ appVersion })

      const data = await window.api.loadAccounts()

      if (data) {
        const accounts = new Map(Object.entries(data.accounts ?? {}) as [string, Account][])
        const activeAccountId = data.activeAccountId ?? null

        // for not having machineId Generate a
        let needsSave = false
        for (const [id, account] of accounts) {
          if (!account.machineId) {
            account.machineId = generateRandomMachineId()
            accounts.set(id, account)
            needsSave = true
            console.log(`[Store] Generated machineId for account ${account.email}: ${account.machineId.substring(0, 16)}...`)
          }
        }

        // according to activeAccountId Resync all accounts isActive status to ensure that only one account is active
        for (const [id, account] of accounts) {
          const shouldBeActive = id === activeAccountId
          if (account.isActive !== shouldBeActive) {
            accounts.set(id, { ...account, isActive: shouldBeActive })
          }
        }

        set({
          accounts,
          groups: new Map(Object.entries(data.groups ?? {}) as [string, AccountGroup][]),
          tags: new Map(Object.entries(data.tags ?? {}) as [string, AccountTag][]),
          activeAccountId,
          autoRefreshEnabled: data.autoRefreshEnabled ?? true,
          autoRefreshInterval: data.autoRefreshInterval ?? 5,
          autoRefreshConcurrency: data.autoRefreshConcurrency ?? 100,
          autoRefreshSyncInfo: data.autoRefreshSyncInfo ?? true,
          statusCheckInterval: data.statusCheckInterval ?? 60,
          privacyMode: data.privacyMode ?? false,
          usagePrecision: data.usagePrecision ?? false,
          proxyEnabled: data.proxyEnabled ?? false,
          proxyUrl: data.proxyUrl ?? '',
          autoSwitchEnabled: data.autoSwitchEnabled ?? false,
          autoSwitchThreshold: data.autoSwitchThreshold ?? 0,
          autoSwitchInterval: data.autoSwitchInterval ?? 5,
          switchTarget: data.switchTarget ?? 'ide',
          theme: data.theme ?? 'default',
          darkMode: data.darkMode ?? false,
          language: data.language ?? 'auto',
          machineIdConfig: data.machineIdConfig ?? {
            autoSwitchOnAccountChange: false,
            bindMachineIdToAccount: false,
            useBindedMachineId: true
          },
          accountMachineIds: data.accountMachineIds ?? {},
          machineIdHistory: data.machineIdHistory ?? [],
          proxyPool: data.proxyPool
            ? new Map(Object.entries(data.proxyPool as Record<string, ProxyEntry>))
            : new Map<string, ProxyEntry>(),
          proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG, ...(data.proxyPoolConfig as Partial<ProxyPoolConfig> | undefined) },
          proxyPoolCursor: typeof data.proxyPoolCursor === 'number' ? data.proxyPoolCursor : 0,
          accountProxyBindings: (data.accountProxyBindings as Record<string, string> | undefined) || {}
        })

        // Apply theme
        get().applyTheme()

        // If the proxy is enabled, pass store of setProxy(will automatically normalize URL and write back UI）
        if (data.proxyEnabled && data.proxyUrl) {
          void get().setProxy(true, data.proxyUrl)
        }

        // If automatic number change is enabled, start the timer
        if (data.autoSwitchEnabled) {
          get().startAutoSwitch()
        }

        // Start scheduled automatic saving (to prevent data loss)
        get().startAutoSave()

        // If a new one is generated machineId, save to storage
        if (needsSave) {
          console.log('[Store] Saving accounts with newly generated machineIds')
          get().saveToStorage()
        }

        // SSO Synchronous (including potential network requests) and asynchronous execution without blocking the loading of the first screen
        // Pass after completion set application results,UI Will update naturally
        queueMicrotask(() => { void syncLocalSsoAccountAsync(get, set) })
      }
    } catch (error) {
      console.error('Failed to load accounts:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  /**
   * Anti-shake trigger persistence: continuous mutation exist SAVE_DEBOUNCE_MS The disk is only written once.
   * The caller can still await Should Promise;returned Promise It will end after the anti-shake window ends and the actual placement is completed. resolve。
   * Used to eliminate high-frequency update scenarios (such as 1000 Account background refresh storm) IPC/IO Jitter.
   */
  /**
   * Anti-shake trigger persistence: continuous mutation exist SAVE_DEBOUNCE_MS The disk is only written once;
   * Forced at the same time SAVE_MAX_WAIT_MS Maximum delay to avoid being called again during background refresh storm reset As a result, it will never be placed on the market.
   * All callers in the same window share a set of resolvers, wake up in batches after the actual placement.
   */
  saveToStorage: async () => {
    return new Promise<void>((resolve) => {
      savePendingResolvers.push(resolve)
      const flushNow = async (): Promise<void> => {
        if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
        if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
        const resolvers = savePendingResolvers
        savePendingResolvers = []
        await get().flushSaveImmediately()
        for (const r of resolvers) r()
      }
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer)
      saveDebounceTimer = setTimeout(flushNow, SAVE_DEBOUNCE_MS)
      if (!saveMaxWaitTimer) {
        saveMaxWaitTimer = setTimeout(flushNow, SAVE_MAX_WAIT_MS)
      }
    })
  },

  /**
   * Immediately download (skipping anti-shake). used for beforeunload, forced persistence scenarios before and after key operations.
   * Concurrent calls will automatically wait for the same in-flight Save to avoid re-entry.
   * Will wake up all the walking saveToStorage The caller who is waiting for the order to be placed in this window.
   */
  flushSaveImmediately: async () => {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
    if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
    const pending = savePendingResolvers
    savePendingResolvers = []
    if (saveInFlight) {
      const inflight = saveInFlight
      void inflight.then(() => { for (const r of pending) r() })
      return inflight
    }

    const {
      accounts,
      groups,
      tags,
      activeAccountId,
      autoRefreshEnabled,
      autoRefreshInterval,
      autoRefreshConcurrency,
      statusCheckInterval,
      privacyMode,
      usagePrecision,
      proxyEnabled,
      proxyUrl,
      autoSwitchEnabled,
      autoSwitchThreshold,
      autoSwitchInterval,
      switchTarget,
      theme,
      darkMode,
      language,
      machineIdConfig,
      accountMachineIds,
      machineIdHistory,
      proxyPool,
      proxyPoolConfig,
      proxyPoolCursor,
      accountProxyBindings
    } = get()

    set({ isSyncing: true })

    saveInFlight = (async () => {
      try {
        await window.api.saveAccounts({
          accounts: Object.fromEntries(accounts),
          groups: Object.fromEntries(groups),
          tags: Object.fromEntries(tags),
          activeAccountId,
          autoRefreshEnabled,
          autoRefreshInterval,
          autoRefreshConcurrency,
          statusCheckInterval,
          privacyMode,
          usagePrecision,
          proxyEnabled,
          proxyUrl,
          autoSwitchEnabled,
          autoSwitchThreshold,
          autoSwitchInterval,
          switchTarget,
          theme,
          darkMode,
          language,
          machineIdConfig,
          accountMachineIds,
          machineIdHistory,
          proxyPool: Object.fromEntries(proxyPool),
          proxyPoolConfig,
          proxyPoolCursor,
          accountProxyBindings
        })
      } catch (error) {
        console.error('Failed to save accounts:', error)
      } finally {
        set({ isSyncing: false })
        saveInFlight = null
        for (const r of pending) r()
      }
    })()

    return saveInFlight
  },

  // ==================== set up ====================

  setAutoRefresh: (enabled, interval) => {
    set({
      autoRefreshEnabled: enabled,
      autoRefreshInterval: interval ?? get().autoRefreshInterval
    })
    get().saveToStorage()
    
    // Restart timer
    if (enabled) {
      get().startAutoTokenRefresh()
    } else {
      get().stopAutoTokenRefresh()
    }
  },

  setAutoRefreshConcurrency: (concurrency) => {
    set({ autoRefreshConcurrency: Math.max(1, Math.min(500, concurrency)) })
    get().saveToStorage()
  },

  setAutoRefreshSyncInfo: (enabled) => {
    set({ autoRefreshSyncInfo: enabled })
    get().saveToStorage()
  },

  setProactiveRenewalEnabled: async (enabled) => {
    if (typeof window.api?.setProactiveRenewalEnabled !== 'function') {
      return { success: false, error: 'API not available' }
    }
    const result = await window.api.setProactiveRenewalEnabled(enabled)
    if (result.success) {
      set({ proactiveRenewalEnabled: !!result.enabled })
    }
    return { success: result.success, error: result.error }
  },

  loadProactiveRenewalEnabled: async () => {
    if (typeof window.api?.getProactiveRenewalEnabled !== 'function') return
    try {
      const result = await window.api.getProactiveRenewalEnabled()
      if (result.success) {
        set({
          proactiveRenewalEnabled: !!result.enabled,
          proactiveRenewalLeadMinutes: result.leadTimeMinutes ?? 15
        })
      }
    } catch (e) {
      console.warn('[Store] loadProactiveRenewalEnabled failed:', e)
    }
  },

  setStatusCheckInterval: (interval) => {
    set({ statusCheckInterval: interval })
    get().saveToStorage()
  },

  // ==================== privacy mode ====================

  setPrivacyMode: (enabled) => {
    set({ privacyMode: enabled })
    get().saveToStorage()
  },

  maskEmail: (email) => {
    if (!get().privacyMode || !email) return email
    // Generate a fixed-length random string as a disguised email address
    const hash = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const maskedName = `user${(hash % 100000).toString().padStart(5, '0')}`
    return `${maskedName}@***.com`
  },

  maskNickname: (nickname) => {
    if (!get().privacyMode || !nickname) return nickname || ''
    // Generate a fixed fake nickname based on the original nickname
    const hash = nickname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    return `user${(hash % 100000).toString().padStart(5, '0')}`
  },

  // ==================== Usage accuracy ====================

  setUsagePrecision: (enabled) => {
    set({ usagePrecision: enabled })
    get().saveToStorage()
  },

  // ==================== proxy settings ====================

  setProxy: async (enabled, url) => {
    const targetUrl = url ?? get().proxyUrl
    set({ 
      proxyEnabled: enabled,
      proxyUrl: targetUrl
    })
    get().saveToStorage()
    // Notify the main process to update the proxy settings and use the normalized URL write back store
    try {
      const result = await window.api.setProxy?.(enabled, targetUrl)
      if (result?.normalizedUrl && result.normalizedUrl !== targetUrl) {
        set({ proxyUrl: result.normalizedUrl })
        get().saveToStorage()
      }
    } catch (err) {
      console.error('[Store] setProxy IPC failed:', err)
    }
  },

  // ==================== Theme settings ====================

  setTheme: (theme) => {
    set({ theme })
    get().saveToStorage()
    get().applyTheme()
  },

  setDarkMode: (enabled) => {
    set({ darkMode: enabled })
    get().saveToStorage()
    get().applyTheme()
  },

  // ==================== Language settings ====================

  setLanguage: (language) => {
    set({ language })
    get().saveToStorage()
    // Update tray menu language
    const actualLang = language === 'auto' 
      ? (navigator.language.startsWith('zh') ? 'zh' : 'en')
      : language
    window.api.updateTrayLanguage(actualLang)
  },

  applyTheme: () => {
    const { theme, darkMode } = get()
    const root = document.documentElement
    
    // Remove all theme classes (including all 32 topics)
    root.classList.remove(
      'dark', 
      // blue color
      'theme-indigo', 'theme-cyan', 'theme-sky', 'theme-teal',
      // Purple red series
      'theme-purple', 'theme-violet', 'theme-fuchsia', 'theme-pink', 'theme-rose',
      // Warm colors
      'theme-red', 'theme-orange', 'theme-amber', 'theme-yellow',
      // green system
      'theme-emerald', 'theme-green', 'theme-lime',
      // neutral colors
      'theme-slate', 'theme-zinc', 'theme-stone', 'theme-neutral',
      // Luxurious colors
      'theme-gold', 'theme-navy', 'theme-wine', 'theme-champagne',
      // Morandi
      'theme-dustyblue', 'theme-terracotta', 'theme-sage', 'theme-mauve',
      // Natural dark color
      'theme-coral', 'theme-forest', 'theme-ocean'
    )
    
    // Apply dark mode
    if (darkMode) {
      root.classList.add('dark')
    }
    
    // Apply theme colors
    if (theme !== 'default') {
      root.classList.add(`theme-${theme}`)
    }
  },

  // ==================== Automatic number change ====================

  setAutoSwitch: (enabled, threshold, interval) => {
    set({
      autoSwitchEnabled: enabled,
      autoSwitchThreshold: threshold ?? get().autoSwitchThreshold,
      autoSwitchInterval: interval ?? get().autoSwitchInterval
    })
    get().saveToStorage()
    
    // Restart timer
    if (enabled) {
      get().startAutoSwitch()
    } else {
      get().stopAutoSwitch()
    }
  },

  setBatchImportConcurrency: (concurrency) => {
    set({ batchImportConcurrency: Math.max(1, Math.min(500, concurrency)) })
    get().saveToStorage()
  },

  setLoginPrivateMode: (enabled) => {
    set({ loginPrivateMode: enabled })
    get().saveToStorage()
  },

  setSwitchTarget: (target) => {
    set({ switchTarget: target })
    get().saveToStorage()
  },

  startAutoSwitch: () => {
    const { autoSwitchEnabled, autoSwitchInterval, checkAndAutoSwitch } = get()
    
    if (!autoSwitchEnabled) return
    
    // Clear existing timer
    if (autoSwitchTimer) {
      clearInterval(autoSwitchTimer)
    }
    
    // Check once now
    checkAndAutoSwitch()
    
    // Set up scheduled checks
    autoSwitchTimer = setInterval(() => {
      checkAndAutoSwitch()
    }, autoSwitchInterval * 60 * 1000)
    
    console.log(`[AutoSwitch] Started with interval: ${autoSwitchInterval} minutes`)
  },

  stopAutoSwitch: () => {
    if (autoSwitchTimer) {
      clearInterval(autoSwitchTimer)
      autoSwitchTimer = null
      console.log('[AutoSwitch] Stopped')
    }
  },

  checkAndAutoSwitch: async () => {
    const { accounts, autoSwitchThreshold, checkAccountStatus, setActiveAccount } = get()
    const activeAccount = get().getActiveAccount()
    
    if (!activeAccount) {
      console.log('[AutoSwitch] No active account')
      return
    }

    console.log(`[AutoSwitch] Checking active account: ${activeAccount.email}`)

    // Refresh the current account status to get the latest balance
    await checkAccountStatus(activeAccount.id)
    
    // Retrieve updated account information
    const updatedAccount = get().accounts.get(activeAccount.id)
    if (!updatedAccount) return

    const remaining = updatedAccount.usage.limit - updatedAccount.usage.current
    console.log(`[AutoSwitch] Remaining: ${remaining}, Threshold: ${autoSwitchThreshold}`)

    // Check if you need to switch
    if (remaining <= autoSwitchThreshold) {
      console.log(`[AutoSwitch] Account ${updatedAccount.email} reached threshold, switching...`)
      
      // Find available accounts
      const availableAccount = Array.from(accounts.values()).find(acc => {
        // Exclude current account
        if (acc.id === activeAccount.id) return false
        // Exclude banned accounts
        if (isBannedAccountError(acc.lastError)) return false
        // Exclude accounts with insufficient balance
        const accRemaining = acc.usage.limit - acc.usage.current
        if (accRemaining <= autoSwitchThreshold) return false
        return true
      })

      if (availableAccount) {
        console.log(`[AutoSwitch] Switching to: ${availableAccount.email}`)
        setActiveAccount(availableAccount.id)
        // according to switchTarget Settings determine switching target
        const { switchTarget: target } = get()
        const creds = availableAccount.credentials
        if (target === 'ide' || target === 'both') {
          const switchResult = await window.api.switchAccount({
            accessToken: creds.accessToken || '',
            refreshToken: creds.refreshToken || '',
            clientId: creds.clientId || '',
            clientSecret: creds.clientSecret || '',
            region: creds.region || 'us-east-1',
            startUrl: creds.startUrl,
            authMethod: creds.authMethod,
            provider: creds.provider,
            profileArn: (availableAccount as { profileArn?: string }).profileArn,
            accountId: availableAccount.id
          })
          // Bundle main process refresh Latest after credentials Sync back store，
          // otherwise store inside refreshToken Still v1(Has been removed by the server rotate void), any next time refresh will all fail
          if (switchResult?.success && switchResult.refreshedCredentials) {
            const rc = switchResult.refreshedCredentials
            set((state) => {
              const accounts = new Map(state.accounts)
              const acc = accounts.get(availableAccount.id)
              if (acc) {
                accounts.set(availableAccount.id, {
                  ...acc,
                  credentials: {
                    ...acc.credentials,
                    accessToken: rc.accessToken,
                    refreshToken: rc.refreshToken,
                    expiresAt: Date.now() + rc.expiresIn * 1000
                  }
                })
              }
              return { accounts }
            })
            get().saveToStorage()
          }
        }
        if (target === 'cli' || target === 'both') {
          window.api.switchAccountCli?.({
            accessToken: creds.accessToken || '',
            refreshToken: creds.refreshToken || '',
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            region: creds.region || 'us-east-1',
            profileArn: (availableAccount as { profileArn?: string }).profileArn,
            provider: creds.provider
          }).catch(err => console.warn('[AutoSwitch CLI] Failed:', err))
        }
      } else {
        console.log('[AutoSwitch] No available account to switch to')
      }
    }
  },

  // ==================== automatic Token refresh ====================

  checkAndRefreshExpiringTokens: async () => {
    const { accounts, refreshAccountToken, checkAccountStatus, autoSwitchEnabled, autoRefreshConcurrency, autoRefreshSyncInfo, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    console.log(`[AutoRefresh] Checking ${accounts.size} accounts... (syncInfo: ${autoRefreshSyncInfo}, autoSwitch: ${autoSwitchEnabled})`)

    // Filter the accounts that need to be processed
    const accountsToProcess: Array<{ id: string; email: string; needsTokenRefresh: boolean }> = []
    
    for (const [id, account] of accounts) {
      // Skip accounts that have been banned or have an error status
      if (isBannedAccountError(account.lastError)) {
        console.log(`[AutoRefresh] Skipping ${account.email} (banned/error)`)
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      const needsTokenRefresh = expiresAt && timeUntilExpiry <= refreshLeadMs

      accountsToProcess.push({ id, email: account.email, needsTokenRefresh: !!needsTokenRefresh })
    }

    console.log(`[AutoRefresh] Processing ${accountsToProcess.length} accounts...`)

    // Concurrency control: Use the configured number of concurrencies to avoid lags
    const BATCH_SIZE = autoRefreshConcurrency
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < accountsToProcess.length; i += BATCH_SIZE) {
      const batch = accountsToProcess.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(async ({ id, email, needsTokenRefresh }) => {
          try {
            if (needsTokenRefresh) {
              console.log(`[AutoRefresh] Refreshing token for ${email}...`)
              await refreshAccountToken(id)
              console.log(`[AutoRefresh] Token for ${email} refreshed`)
              // Token Synchronously refresh account information after refreshing
              await checkAccountStatus(id)
              console.log(`[AutoRefresh] Account info for ${email} updated`)
            } else if (autoRefreshSyncInfo || autoSwitchEnabled) {
              // Refresh account information when synchronized detection of account information or automatic number change is enabled.
              await checkAccountStatus(id)
              console.log(`[AutoRefresh] Account info for ${email} updated`)
            }
            return { email, success: true }
          } catch (e) {
            console.error(`[AutoRefresh] Failed for ${email}:`, e)
            return { email, success: false, error: e }
          }
        })
      )
      
      successCount += results.filter(r => r.status === 'fulfilled' && r.value.success).length
      failCount += results.length - results.filter(r => r.status === 'fulfilled' && r.value.success).length
      
      // inter-batch delay
      if (i + BATCH_SIZE < accountsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    console.log(`[AutoRefresh] Completed: ${successCount} success, ${failCount} failed`)
  },

  // Only refresh invalid Token(Do not refresh account information)
  refreshExpiredTokensOnly: async () => {
    const { accounts, refreshAccountToken, autoRefreshConcurrency, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    // Filter needs to be refreshed Token account
    const expiredAccounts: Array<{ id: string; email: string }> = []
    
    for (const [id, account] of accounts) {
      // Skip accounts that have been banned or have an error status
      if (isBannedAccountError(account.lastError)) {
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      
      // Token Expired or about to expire
      if (expiresAt && timeUntilExpiry <= refreshLeadMs) {
        expiredAccounts.push({ id, email: account.email })
      }
    }

    if (expiredAccounts.length === 0) {
      console.log('[AutoRefresh] No expired tokens found')
      return
    }

    console.log(`[AutoRefresh] Refreshing ${expiredAccounts.length} expired tokens...`)

    // Concurrency control: Use the configured number of concurrencies to avoid lags
    const BATCH_SIZE = autoRefreshConcurrency
    for (let i = 0; i < expiredAccounts.length; i += BATCH_SIZE) {
      const batch = expiredAccounts.slice(i, i + BATCH_SIZE)
      await Promise.allSettled(
        batch.map(async ({ id, email }) => {
          try {
            await refreshAccountToken(id)
            console.log(`[AutoRefresh] Token for ${email} refreshed`)
          } catch (e) {
            console.error(`[AutoRefresh] Failed to refresh token for ${email}:`, e)
          }
        })
      )
      // inter-batch delay
      if (i + BATCH_SIZE < expiredAccounts.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  },

  startAutoTokenRefresh: () => {
    const { autoRefreshEnabled, autoRefreshInterval } = get()
    
    // If there is a timer, stop it first
    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
    }
    
    // If not enabled, the timer is not started
    if (!autoRefreshEnabled) {
      console.log('[AutoRefresh] Auto-refresh is disabled')
      return
    }

    // Trigger background refresh at startup (executed in the main process, without blocking UI）
    get().triggerBackgroundRefresh()

    // Use user-set interval (minutes to milliseconds)
    const intervalMs = autoRefreshInterval * 60 * 1000
    tokenRefreshTimer = setInterval(() => {
      get().triggerBackgroundRefresh()
    }, intervalMs)

    console.log(`[AutoRefresh] Token auto-refresh started with interval: ${autoRefreshInterval} minutes`)
  },

  stopAutoTokenRefresh: () => {
    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
      console.log('[AutoRefresh] Token auto-refresh stopped')
    }
  },

  // Trigger background refresh (executed in the main process, without blocking UI）
  triggerBackgroundRefresh: async () => {
    const { accounts, autoRefreshConcurrency, autoRefreshSyncInfo, autoSwitchEnabled, autoRefreshInterval } = get()
    const now = Date.now()
    const refreshLeadMs = tokenRefreshLeadMs(autoRefreshInterval)

    // Filter the accounts that need to be processed
    const accountsToRefresh: Array<{
      id: string
      email: string
      idp?: string
      profileArn?: string
      needsTokenRefresh: boolean
      machineId?: string  // Device bound to the account ID
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
    }> = []
    
    for (const [id, account] of accounts) {
      // Skip accounts that have been banned or have an error status
      if (isBannedAccountError(account.lastError)) {
        continue
      }

      const expiresAt = account.credentials.expiresAt
      const timeUntilExpiry = expiresAt ? expiresAt - now : Infinity
      const needsTokenRefresh = expiresAt && timeUntilExpiry <= refreshLeadMs
      
      // Token It is about to expire and needs to be refreshed, or synchronization detection is turned on./Automatic number change requires checking account information
      if (needsTokenRefresh || autoRefreshSyncInfo || autoSwitchEnabled) {
        accountsToRefresh.push({
          id,
          email: account.email,
          idp: account.idp,
          profileArn: account.profileArn,
          needsTokenRefresh: !!needsTokenRefresh,
          machineId: account.machineId,  // Pass the device bound to the account ID
          credentials: {
            refreshToken: account.credentials.refreshToken || '',
            clientId: account.credentials.clientId,
            clientSecret: account.credentials.clientSecret,
            region: account.credentials.region,
            authMethod: account.credentials.authMethod,
            accessToken: account.credentials.accessToken,
            provider: account.credentials.provider,
            profileArn: account.credentials.profileArn
          }
        })
      }
    }

    if (accountsToRefresh.length === 0) {
      console.log('[BackgroundRefresh] No accounts need processing')
      return
    }

    console.log(`[BackgroundRefresh] Triggering refresh for ${accountsToRefresh.length} accounts (syncInfo: ${autoRefreshSyncInfo})...`)
    
    // Call the main process background refresh without waiting for the result (via IPC event reception)
    window.api.backgroundBatchRefresh(accountsToRefresh, autoRefreshConcurrency, autoRefreshSyncInfo)
  },

  // Process background refresh results (compatible with the entrance; please leave for high-frequency scenarios) applyBackgroundRefreshResults batch)
  handleBackgroundRefreshResult: (data) => {
    get().applyBackgroundRefreshResults([data])
  },

  // Batch processing background refresh results: merge N Results arrive once set,avoid N Second-rate Map Full copy
  applyBackgroundRefreshResults: (items) => {
    if (!items || items.length === 0) return

    set((state) => {
      // complete only once Map copy
      const accounts = new Map(state.accounts)
      const now = Date.now()

      for (const data of items) {
        const { id, success, data: resultData, error } = data
        const account = accounts.get(id)
        if (!account) continue

        if (!success) {
          accounts.set(id, {
            ...account,
            status: 'error',
            lastError: error,
            lastCheckedAt: now
          })
          continue
        }

        const refreshData = resultData as {
        accessToken?: string
        refreshToken?: string
        expiresIn?: number
        profileArn?: string
        usage?: {
          current?: number
          limit?: number
          baseCurrent?: number
          baseLimit?: number
          freeTrialCurrent?: number
          freeTrialLimit?: number
          freeTrialExpiry?: string
          bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
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
        }
        subscription?: { type?: string; title?: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string }
        userInfo?: { email?: string; userId?: string }
        status?: string
        errorMessage?: string
      } | undefined

      // Check ban status
      const newStatus = refreshData?.status === 'error' ? 'error' as AccountStatus : 'active' as AccountStatus
      const newError = refreshData?.errorMessage

      // During background refresh, the main process may return the automatically obtained profileArn, persisted to the top level and credentials
      const bgProfileArn = refreshData?.profileArn || account.credentials.profileArn || account.profileArn
      accounts.set(id, {
        ...account,
        ...(bgProfileArn ? { profileArn: bgProfileArn } : {}),
        credentials: {
          ...account.credentials,
          accessToken: refreshData?.accessToken || account.credentials.accessToken,
          refreshToken: refreshData?.refreshToken || account.credentials.refreshToken,
          expiresAt: refreshData?.expiresIn ? now + refreshData.expiresIn * 1000 : account.credentials.expiresAt,
          ...(bgProfileArn ? { profileArn: bgProfileArn } : {})
        },
        usage: refreshData?.usage ? (() => {
          const newCurrent = refreshData.usage.current ?? account.usage.current
          const newLimit = refreshData.usage.limit ?? account.usage.limit
          return {
            ...account.usage,
            current: newCurrent,
            limit: newLimit,
            percentUsed: newLimit > 0 ? newCurrent / newLimit : 0,
            baseCurrent: refreshData.usage.baseCurrent ?? account.usage.baseCurrent,
            baseLimit: refreshData.usage.baseLimit ?? account.usage.baseLimit,
            freeTrialCurrent: refreshData.usage.freeTrialCurrent ?? account.usage.freeTrialCurrent,
            freeTrialLimit: refreshData.usage.freeTrialLimit ?? account.usage.freeTrialLimit,
            freeTrialExpiry: refreshData.usage.freeTrialExpiry ?? account.usage.freeTrialExpiry,
            bonuses: refreshData.usage.bonuses ?? account.usage.bonuses,
            nextResetDate: refreshData.usage.nextResetDate ?? account.usage.nextResetDate,
            resourceDetail: refreshData.usage.resourceDetail ?? account.usage.resourceDetail,
            lastUpdated: now
          }
        })() : account.usage,
        subscription: refreshData?.subscription ? {
          ...account.subscription,
          type: (refreshData.subscription.type as SubscriptionType) || account.subscription.type,
          title: refreshData.subscription.title || account.subscription.title,
          daysRemaining: refreshData.subscription.daysRemaining ?? account.subscription.daysRemaining,
          expiresAt: refreshData.subscription.expiresAt ?? account.subscription.expiresAt,
          overageCapability: refreshData.subscription.overageCapability ?? account.subscription.overageCapability,
          upgradeCapability: refreshData.subscription.upgradeCapability ?? account.subscription.upgradeCapability,
          managementTarget: refreshData.subscription.subscriptionManagementTarget ?? account.subscription.managementTarget
        } : account.subscription,
        email: refreshData?.userInfo?.email || account.email,
        userId: refreshData?.userInfo?.userId || account.userId,
        status: newStatus,
        lastError: newError,
        lastCheckedAt: now
      })
      } // end for-loop

      return { accounts }
    })
  },

  // Processing background check results (compatible with the entrance; please leave for high-frequency scenarios) applyBackgroundCheckResults batch)
  handleBackgroundCheckResult: (data) => {
    get().applyBackgroundCheckResults([data])
  },

  // Batch processing background check results: merge N Results arrive once set
  applyBackgroundCheckResults: (items) => {
    if (!items || items.length === 0) return

    set((state) => {
      const accounts = new Map(state.accounts)
      const now = Date.now()

      for (const data of items) {
        const { id, success, data: resultData, error } = data
        const account = accounts.get(id)
        if (!account) continue

        if (!success) {
          accounts.set(id, {
            ...account,
            status: 'error',
            lastError: error,
            lastCheckedAt: now
          })
          continue
        }

        const checkData = resultData as {
        usage?: {
          current?: number
          limit?: number
          baseCurrent?: number
          baseLimit?: number
          freeTrialCurrent?: number
          freeTrialLimit?: number
          freeTrialExpiry?: string
          bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
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
        }
        subscription?: { type?: string; title?: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string }
        userInfo?: { email?: string; userId?: string }
        status?: string
        errorMessage?: string
        needsRefresh?: boolean
      } | undefined

      // detection status
      let newStatus: AccountStatus = 'active'
      if (checkData?.status === 'error') {
        newStatus = 'error'
      } else if (checkData?.status === 'expired' || checkData?.needsRefresh) {
        newStatus = 'expired'
      }
      const newError = checkData?.errorMessage

      accounts.set(id, {
        ...account,
        usage: checkData?.usage ? (() => {
          const newCurrent = checkData.usage.current ?? account.usage.current
          const newLimit = checkData.usage.limit ?? account.usage.limit
          return {
            ...account.usage,
            current: newCurrent,
            limit: newLimit,
            percentUsed: newLimit > 0 ? newCurrent / newLimit : 0,
            baseCurrent: checkData.usage.baseCurrent ?? account.usage.baseCurrent,
            baseLimit: checkData.usage.baseLimit ?? account.usage.baseLimit,
            freeTrialCurrent: checkData.usage.freeTrialCurrent ?? account.usage.freeTrialCurrent,
            freeTrialLimit: checkData.usage.freeTrialLimit ?? account.usage.freeTrialLimit,
            freeTrialExpiry: checkData.usage.freeTrialExpiry ?? account.usage.freeTrialExpiry,
            bonuses: checkData.usage.bonuses ?? account.usage.bonuses,
            nextResetDate: checkData.usage.nextResetDate ?? account.usage.nextResetDate,
            resourceDetail: checkData.usage.resourceDetail ?? account.usage.resourceDetail,
            lastUpdated: now
          }
        })() : account.usage,
        subscription: checkData?.subscription ? {
          ...account.subscription,
          type: (checkData.subscription.type as 'Free' | 'Pro' | 'Enterprise' | 'Teams') ?? account.subscription.type,
          title: checkData.subscription.title ?? account.subscription.title,
          daysRemaining: checkData.subscription.daysRemaining ?? account.subscription.daysRemaining,
          expiresAt: checkData.subscription.expiresAt ?? account.subscription.expiresAt,
          overageCapability: checkData.subscription.overageCapability ?? account.subscription.overageCapability,
          upgradeCapability: checkData.subscription.upgradeCapability ?? account.subscription.upgradeCapability,
          managementTarget: checkData.subscription.subscriptionManagementTarget ?? account.subscription.managementTarget
        } : account.subscription,
        email: checkData?.userInfo?.email || account.email,
        userId: checkData?.userInfo?.userId || account.userId,
        status: newStatus,
        lastError: newError,
        lastCheckedAt: now
      })
      } // end for-loop

      return { accounts }
    })
  },

  // ==================== Automatically save regularly ====================

  startAutoSave: () => {
    // If there is a timer, stop it first
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
    }

    // Calculate the hash value of the current data
    const computeHash = () => {
      const { accounts, groups, tags, activeAccountId } = get()
      return JSON.stringify({
        accounts: Object.fromEntries(accounts),
        groups: Object.fromEntries(groups),
        tags: Object.fromEntries(tags),
        activeAccountId
      })
    }

    // Initialize hash value
    lastSaveHash = computeHash()

    // Set scheduled save
    autoSaveTimer = setInterval(async () => {
      const currentHash = computeHash()
      
      // Save only when data changes
      if (currentHash !== lastSaveHash) {
        console.log('[AutoSave] Data changed, saving...')
        await get().saveToStorage()
        lastSaveHash = currentHash
        console.log('[AutoSave] Data saved successfully')
      }
    }, AUTO_SAVE_INTERVAL)

    console.log(`[AutoSave] Auto-save started with interval: ${AUTO_SAVE_INTERVAL / 1000}s`)
  },

  stopAutoSave: () => {
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
      autoSaveTimer = null
      console.log('[AutoSave] Auto-save stopped')
    }
  },

  // ==================== Machine code management ====================

  setMachineIdConfig: (config) => {
    set((state) => ({
      machineIdConfig: { ...state.machineIdConfig, ...config }
    }))
    get().saveToStorage()
  },

  refreshCurrentMachineId: async () => {
    try {
      const result = await window.api.machineIdGetCurrent()
      if (result.success && result.machineId) {
        set({ currentMachineId: result.machineId })
        
        // Automatically back up the original machine code when acquiring it for the first time
        const { originalMachineId } = get()
        if (!originalMachineId) {
          get().backupOriginalMachineId()
        }
      }
    } catch (error) {
      console.error('[MachineId] Failed to refresh current machine ID:', error)
    }
  },

  changeMachineId: async (newMachineId) => {
    const state = get()
    
    // Back up original machine code when first changed
    if (!state.originalMachineId) {
      state.backupOriginalMachineId()
    }

    // Generate new machine code if not provided
    const machineIdToSet = newMachineId || await window.api.machineIdGenerateRandom()
    
    try {
      const result = await window.api.machineIdSet(machineIdToSet)
      
      if (result.success) {
        // update status
        set((s) => ({
          currentMachineId: machineIdToSet,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: machineIdToSet,
              timestamp: Date.now(),
              action: 'manual'
            }
          ]
        }))
        get().saveToStorage()
        return true
      } else if (result.requiresAdmin) {
        // Administrator rights are required, and the main process will handle pop-ups.
        return false
      } else {
        console.error('[MachineId] Failed to change:', result.error)
        return false
      }
    } catch (error) {
      console.error('[MachineId] Error changing machine ID:', error)
      return false
    }
  },

  restoreOriginalMachineId: async () => {
    const { originalMachineId } = get()
    
    if (!originalMachineId) {
      console.warn('[MachineId] No original machine ID to restore')
      return false
    }

    try {
      const result = await window.api.machineIdSet(originalMachineId)
      
      if (result.success) {
        set((s) => ({
          currentMachineId: originalMachineId,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: originalMachineId,
              timestamp: Date.now(),
              action: 'restore'
            }
          ]
        }))
        get().saveToStorage()
        return true
      }
      return false
    } catch (error) {
      console.error('[MachineId] Error restoring original machine ID:', error)
      return false
    }
  },

  bindMachineIdToAccount: (accountId, machineId) => {
    const account = get().accounts.get(accountId)
    if (!account) return

    // Generate or use the provided machine code
    const boundMachineId = machineId || crypto.randomUUID()

    set((state) => ({
      accountMachineIds: {
        ...state.accountMachineIds,
        [accountId]: boundMachineId
      },
      machineIdHistory: [
        ...state.machineIdHistory,
        {
          id: crypto.randomUUID(),
          machineId: boundMachineId,
          timestamp: Date.now(),
          action: 'bind',
          accountId,
          accountEmail: account.email
        }
      ]
    }))
    get().saveToStorage()
  },

  getMachineIdForAccount: (accountId) => {
    return get().accountMachineIds[accountId] || null
  },

  backupOriginalMachineId: () => {
    const { currentMachineId, originalMachineId } = get()
    
    // Only back up if there is no backup and current machine code is available
    if (!originalMachineId && currentMachineId) {
      set({
        originalMachineId: currentMachineId,
        originalBackupTime: Date.now()
      })
      
      // add history
      set((s) => ({
        machineIdHistory: [
          ...s.machineIdHistory,
          {
            id: crypto.randomUUID(),
            machineId: currentMachineId,
            timestamp: Date.now(),
            action: 'initial'
          }
        ]
      }))
      
      get().saveToStorage()
      console.log('[MachineId] Original machine ID backed up:', currentMachineId)
    }
  },

  clearMachineIdHistory: () => {
    set({ machineIdHistory: [] })
    get().saveToStorage()
  },

  // ==================== proxy pool ====================

  addProxy: (url, options) => {
    const parsed = parseProxyUrl(url)
    if (!parsed) return null

    // Deduplication: same host:port:protocol:username Treat as duplicate
    // Contains username to support bestproxy Waiting for "single entrance, distinguishing regions by user name"/Add multiple items to the rotation proxy of "Session"
    const existingPool = get().proxyPool
    for (const entry of existingPool.values()) {
      if (entry.host === parsed.host && entry.port === parsed.port && entry.protocol === parsed.protocol
        && (entry.username || '') === (parsed.username || '')) {
        return null
      }
    }

    const id = uuidv4()
    const entry: ProxyEntry = {
      id,
      url: parsed.normalized,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      label: options?.label,
      source: options?.source ?? 'manual',
      tags: options?.tags,
      status: 'untested',
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }

    set((state) => {
      const next = new Map(state.proxyPool)
      next.set(id, entry)
      return { proxyPool: next }
    })
    get().saveToStorage()
    return id
  },

  importProxies: (text) => {
    const result = { added: 0, skipped: 0, failed: 0 }
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (lines.length === 0) return result

    // Construct new entries in batches, finally only set once, avoid O(n²) re-render
    const existingPool = get().proxyPool
    const existingKeys = new Set<string>()
    for (const entry of existingPool.values()) {
      existingKeys.add(`${entry.protocol}://${entry.username || ''}@${entry.host}:${entry.port}`)
    }
    const newEntries: ProxyEntry[] = []

    for (const line of lines) {
      const parsed = parseProxyUrl(line)
      if (!parsed) { result.failed++; continue }
      const key = `${parsed.protocol}://${parsed.username || ''}@${parsed.host}:${parsed.port}`
      if (existingKeys.has(key)) { result.skipped++; continue }
      existingKeys.add(key)
      newEntries.push({
        id: uuidv4(),
        url: parsed.normalized,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        source: 'import',
        status: 'untested',
        usedCount: 0,
        failCount: 0,
        enabled: true,
        createdAt: Date.now()
      })
      result.added++
    }

    if (newEntries.length > 0) {
      set((state) => {
        const next = new Map(state.proxyPool)
        for (const e of newEntries) next.set(e.id, e)
        return { proxyPool: next }
      })
      get().saveToStorage()
    }
    return result
  },

  removeProxy: (id) => {
    // Collect affected accounts (accounts bound to the agent)
    const affectedAccountIds = Object.entries(get().accountProxyBindings)
      .filter(([, pid]) => pid === id)
      .map(([aid]) => aid)
    set((state) => {
      const next = new Map(state.proxyPool)
      next.delete(id)
      // Synchronous cleanup binding
      const bindings = { ...state.accountProxyBindings }
      for (const aid of affectedAccountIds) delete bindings[aid]
      return { proxyPool: next, accountProxyBindings: bindings }
    })
    get().saveToStorage()
    // Notify the main process: These accounts now have no agent binding, and fall back to the global situation.
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  removeProxies: (ids) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const affectedAccountIds = Object.entries(get().accountProxyBindings)
      .filter(([, pid]) => idSet.has(pid))
      .map(([aid]) => aid)
    set((state) => {
      const next = new Map(state.proxyPool)
      for (const id of ids) next.delete(id)
      const bindings = { ...state.accountProxyBindings }
      for (const aid of affectedAccountIds) delete bindings[aid]
      return { proxyPool: next, accountProxyBindings: bindings }
    })
    get().saveToStorage()
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  toggleProxyEnabled: (id, enabled) => {
    set((state) => {
      const next = new Map(state.proxyPool)
      const entry = next.get(id)
      if (entry) {
        next.set(id, { ...entry, enabled: enabled ?? !entry.enabled })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // Notify all accounts bound to the agent to update the main process memory (enabling changes will affect whether it is available)
    syncAllAccountsBoundToProxy(id)
  },

  updateProxy: (id, updates) => {
    set((state) => {
      const next = new Map(state.proxyPool)
      const entry = next.get(id)
      if (entry) {
        next.set(id, { ...entry, ...updates })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // url / Enabled status / All status changes require simultaneous binding of accounts.
    if ('url' in updates || 'enabled' in updates || 'status' in updates) {
      syncAllAccountsBoundToProxy(id)
    }
  },

  validateProxy: async (id) => {
    const entry = get().proxyPool.get(id)
    if (!entry) {
      return { success: false, error: 'Proxy not found' }
    }
    const { proxyPoolConfig } = get()

    // Set first to testing state
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, status: 'testing' })
      return { proxyPool: next }
    })

    let result: ProxyValidationResult
    try {
      result = await window.api.proxyPoolValidate({
        url: entry.url,
        testUrl: proxyPoolConfig.testUrl,
        timeoutMs: proxyPoolConfig.testTimeoutMs,
        upstreamProxy: proxyPoolConfig.upstreamProxy
      })
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (existing) {
        const latencyMs = result.latencyMs
        const status: ProxyEntry['status'] = result.success
          ? (latencyMs !== undefined && latencyMs > 3000 ? 'slow' : 'alive')
          : 'dead'
        next.set(id, {
          ...existing,
          status,
          latencyMs: result.latencyMs,
          lastTestedAt: Date.now(),
          lastError: result.success ? undefined : result.error,
          // Failed life verification also accumulates to failCount, but not included in reportProxyResult Registration failed
          failCount: result.success ? existing.failCount : existing.failCount + 1,
          // Automatic deactivation: Cumulative failures exceed threshold; but agents are available in the pool <= 1 Protective retention (rotate the proxy to avoid becoming directly connected)
          enabled: result.success
            ? existing.enabled
            : (state.proxyPoolConfig.autoDisableDead
              && existing.failCount + 1 >= state.proxyPoolConfig.failureThreshold
              && Array.from(state.proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead').length > 1
              ? false
              : existing.enabled)
        })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    // Synchronously bind account: status change (alive/slow/dead) affects whether the agent is available
    syncAllAccountsBoundToProxy(id)
    return result
  },

  validateProxiesBatch: async (ids, concurrency = 5) => {
    if (ids.length === 0) return
    const validateProxy = get().validateProxy
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const idx = cursor++
        try { await validateProxy(ids[idx]) } catch { /* per-item error logged */ }
      }
    }
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, () => worker())
    await Promise.all(workers)
  },

  clearProxyPool: () => {
    const affectedAccountIds = Object.keys(get().accountProxyBindings)
    set({ proxyPool: new Map(), proxyPoolCursor: 0, accountProxyBindings: {} })
    get().saveToStorage()
    // Notify all previously bound accounts to return to global
    for (const aid of affectedAccountIds) syncAccountProxyToMain(aid)
  },

  setProxyPoolConfig: (config) => {
    set((state) => ({
      proxyPoolConfig: { ...state.proxyPoolConfig, ...config }
    }))
    get().saveToStorage()
  },

  pickNextProxy: () => {
    const { proxyPool, proxyPoolConfig, proxyPoolCursor } = get()
    if (!proxyPoolConfig.enabled) return null

    // Only when enabled and not dead Choose from agents
    const candidates = Array.from(proxyPool.values())
      .filter(p => p.enabled && p.status !== 'dead')
    if (candidates.length === 0) return null

    let picked: ProxyEntry
    switch (proxyPoolConfig.strategy) {
      case 'random':
        picked = candidates[Math.floor(Math.random() * candidates.length)]
        break
      case 'least_used':
        picked = candidates.reduce((min, cur) => (cur.usedCount < min.usedCount ? cur : min))
        break
      case 'fastest':
        // Those that have been tested are given priority in ascending order of delay; those that have not been tested are ranked last.
        picked = candidates.slice().sort((a, b) => {
          const la = a.latencyMs ?? Number.POSITIVE_INFINITY
          const lb = b.latencyMs ?? Number.POSITIVE_INFINITY
          return la - lb
        })[0]
        break
      case 'round_robin':
      default: {
        const idx = proxyPoolCursor % candidates.length
        picked = candidates[idx]
        set({ proxyPoolCursor: proxyPoolCursor + 1 })
        break
      }
    }

    // Update usage count (immediately reflected in UI,use saveToStorage anti-shake)
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(picked.id)
      if (existing) {
        next.set(picked.id, { ...existing, usedCount: existing.usedCount + 1, lastUsedAt: Date.now() })
      }
      return { proxyPool: next }
    })
    get().saveToStorage()
    return picked
  },

  reportProxyResult: (id, success, boundEmail, errorMsg) => {
    let autoDisabled = false
    set((state) => {
      const next = new Map(state.proxyPool)
      const existing = next.get(id)
      if (!existing) return state
      // Only "proxy connection layer errors" are accumulated failCount；AWS business/Risk control failure (such as Portal/EOF/Email address has been registered) will not be counted,
      // Avoid misjudgment and deactivation of a good proxy (especially a rotating proxy with only one configuration), causing the direct connection to be exposed. IP。
      const isProxyFail = !success && isProxyConnectionError(errorMsg)
      const failCount = isProxyFail ? existing.failCount + 1 : existing.failCount
      // Rotating agent protection: available agents in the pool <= 1 not automatically deactivated
      const enabledCount = Array.from(state.proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead').length
      const autoDisable = isProxyFail
        && state.proxyPoolConfig.autoDisableDead
        && failCount >= state.proxyPoolConfig.failureThreshold
        && enabledCount > 1
      autoDisabled = autoDisable
      next.set(id, {
        ...existing,
        failCount,
        lastBoundEmail: boundEmail || existing.lastBoundEmail,
        lastError: success ? existing.lastError : (errorMsg || existing.lastError),
        enabled: autoDisable ? false : existing.enabled,
        status: autoDisable ? 'dead' : existing.status
      })
      return { proxyPool: next }
    })
    get().saveToStorage()
    // The main process is only notified when the agent is automatically deactivated (normal used/failCount Count changes do not require synchronization)
    if (autoDisabled) {
      syncAllAccountsBoundToProxy(id)
    }
  },

  // ==================== account-proxy binding ====================

  bindAccountToProxy: (accountId, proxyId) => {
    set((state) => ({
      accountProxyBindings: { ...state.accountProxyBindings, [accountId]: proxyId }
    }))
    get().saveToStorage()
    // Synchronize to the account pool of the main process
    syncAccountProxyToMain(accountId)
  },

  bindAccountsToProxy: (accountIds, proxyId) => {
    if (accountIds.length === 0) return
    set((state) => {
      const next = { ...state.accountProxyBindings }
      for (const id of accountIds) next[id] = proxyId
      return { accountProxyBindings: next }
    })
    get().saveToStorage()
    for (const id of accountIds) syncAccountProxyToMain(id)
  },

  unbindAccountFromProxy: (accountId) => {
    set((state) => {
      const next = { ...state.accountProxyBindings }
      delete next[accountId]
      return { accountProxyBindings: next }
    })
    get().saveToStorage()
    syncAccountProxyToMain(accountId)
  },

  clearAccountProxyBindings: () => {
    const old = Object.keys(get().accountProxyBindings)
    set({ accountProxyBindings: {} })
    get().saveToStorage()
    for (const id of old) syncAccountProxyToMain(id)
  },

  autoDistributeAccountsToProxies: ({ accountsPerProxy = 0, onlyUnbound = false, accountIds }) => {
    const state = get()
    const aliveProxies = Array.from(state.proxyPool.values())
      .filter((p) => p.enabled && p.status !== 'dead')
    if (aliveProxies.length === 0) {
      return { distributed: 0, perProxy: {}, skipped: 0 }
    }

    // Candidate account
    const candidates = accountIds
      ? accountIds.map((id) => state.accounts.get(id)).filter((a): a is Account => !!a)
      : Array.from(state.accounts.values())
    const targets = onlyUnbound
      ? candidates.filter((a) => !state.accountProxyBindings[a.id])
      : candidates

    if (targets.length === 0) {
      return { distributed: 0, perProxy: {}, skipped: candidates.length }
    }

    const perProxy: Record<string, number> = {}
    aliveProxies.forEach((p) => { perProxy[p.id] = 0 })
    const newBindings = { ...state.accountProxyBindings }

    // Cancel has been bound to expire/There is no agent account (only onlyUnbound=false unified redistribution)
    if (!onlyUnbound) {
      for (const id of Object.keys(newBindings)) {
        const proxyExists = aliveProxies.some((p) => p.id === newBindings[id])
        if (!proxyExists) delete newBindings[id]
      }
    }

    let distributed = 0
    let cursor = 0
    for (const account of targets) {
      // accountsPerProxy=0: equally divided; not 0: filled per agent N one and then another one
      let chosenProxyId: string
      if (accountsPerProxy > 0) {
        // Find the first agent that is not filled yet
        let found: string | undefined
        for (let i = 0; i < aliveProxies.length; i++) {
          const pid = aliveProxies[i].id
          if (perProxy[pid] < accountsPerProxy) {
            found = pid
            break
          }
        }
        if (!found) {
          // All agents are full: skip remaining accounts
          break
        }
        chosenProxyId = found
      } else {
        chosenProxyId = aliveProxies[cursor % aliveProxies.length].id
        cursor++
      }
      newBindings[account.id] = chosenProxyId
      perProxy[chosenProxyId]++
      distributed++
    }

    set({ accountProxyBindings: newBindings })
    get().saveToStorage()
    // Sync to main process
    for (const id of targets.slice(0, distributed)) {
      syncAccountProxyToMain(id.id)
    }
    return { distributed, perProxy, skipped: targets.length - distributed }
  },

  getAccountProxyUrl: (accountId) => {
    const state = get()
    const proxyId = state.accountProxyBindings[accountId]
    if (!proxyId) return undefined
    const proxy = state.proxyPool.get(proxyId)
    if (!proxy || !proxy.enabled || proxy.status === 'dead') return undefined
    return proxy.url
  }
}))

/**
 * Synchronize the agent binding information of a single account to the main process account pool
 * (In the main process account pool ProxyAccount.proxyUrl thus IPC set up)
 */
function syncAccountProxyToMain(accountId: string): void {
  try {
    const url = useAccountsStore.getState().getAccountProxyUrl(accountId)
    void window.api.accountSetProxyBinding?.(accountId, url)
  } catch (err) {
    console.warn('[Store] Failed to sync account proxy binding to main:', err)
  }
}

/**
 * When an agent changes (URL/Enabled status/effectiveness),
 * Synchronize all accounts bound to the agent to the main process to ensure that the ProxyAccount.proxyUrl Consistent with the actual situation of the proxy pool
 */
function syncAllAccountsBoundToProxy(proxyId: string): void {
  try {
    const state = useAccountsStore.getState()
    const affectedAccountIds = Object.entries(state.accountProxyBindings)
      .filter(([, pid]) => pid === proxyId)
      .map(([aid]) => aid)
    for (const aid of affectedAccountIds) {
      syncAccountProxyToMain(aid)
    }
  } catch (err) {
    console.warn('[Store] Failed to sync accounts bound to proxy:', err)
  }
}

/** trigger Webhook Event (encapsulates error handling and does not block the main business process) */
function triggerWebhook(event: WebhookEvent, payload: WebhookMessage): void {
  try {
    void useWebhookStore.getState().triggerEvent(event, payload)
  } catch (err) {
    console.warn(`[Webhook] trigger ${event} failed:`, err)
  }
}

// ==================== acting URL Parsing assistance ====================

interface ParsedProxy {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  normalized: string
}

/**
 * Parse multiple proxies URL Format:
 *   - http://host:port
 *   - http://user:pass@host:port
 *   - socks5://host:port
 *   - host:port              (default http）
 *   - host:port:user:pass    （Stormproxies and other commonly used formats by agents)
 *   - user:pass@host:port    (omitted scheme）
 */
// Determine whether the error is a "proxy connection layer" problem (rather than AWS business/Risk control failed).
// Only errors of this type accumulate agents failCount / Trigger automatic deactivation to avoid risk control failure and accidentally kill good agents (especially single rotation agents) into direct connections.
function isProxyConnectionError(msg: string | undefined): boolean {
  const m = (msg || '').toLowerCase()
  if (!m) return false
  return m.includes('proxy')
    || m.includes('econnrefused')
    || m.includes('econnreset')
    || m.includes('etimedout')
    || m.includes('ehostunreach')
    || m.includes('enetunreach')
    || m.includes('tunnel')
    || m.includes('dial tcp')
    || m.includes('connection refused')
    || m.includes('connection reset')
    || m.includes('407')
    || m.includes('socks')
}

function parseProxyUrl(raw: string): ParsedProxy | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null

  // form 1: scheme://...
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      const protocol = normalizeProtocol(u.protocol.replace(':', ''))
      if (!protocol) return null
      const port = Number(u.port) || defaultPort(protocol)
      if (!u.hostname || !Number.isFinite(port)) return null
      return {
        protocol,
        host: u.hostname,
        port,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        normalized: buildProxyUrl(protocol, u.hostname, port, u.username, u.password)
      }
    } catch {
      return null
    }
  }

  // form 2: host:port:user:pass（4 Paragraphs separated by colon)
  const segs = trimmed.split(':')
  if (segs.length === 4 && /^\d+$/.test(segs[1])) {
    const [host, portStr, user, pass] = segs
    const port = Number(portStr)
    if (!host || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host, port,
      username: user || undefined,
      password: pass || undefined,
      normalized: buildProxyUrl('http', host, port, user, pass)
    }
  }

  // form 3: user:pass@host:port(lack scheme）
  if (trimmed.includes('@')) {
    const [authPart, hostPart] = trimmed.split('@')
    const [user, pass] = authPart.split(':')
    const [host, portStr] = (hostPart || '').split(':')
    const port = Number(portStr)
    if (!host || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host, port,
      username: user || undefined,
      password: pass || undefined,
      normalized: buildProxyUrl('http', host, port, user, pass)
    }
  }

  // form 4: host:port(naked format, default http）
  if (segs.length === 2 && /^\d+$/.test(segs[1])) {
    const port = Number(segs[1])
    if (!segs[0] || !Number.isFinite(port)) return null
    return {
      protocol: 'http',
      host: segs[0],
      port,
      normalized: buildProxyUrl('http', segs[0], port)
    }
  }

  return null
}

function normalizeProtocol(raw: string): ProxyProtocol | null {
  const p = raw.toLowerCase()
  if (p === 'http' || p === 'https' || p === 'socks5' || p === 'socks4') return p
  if (p === 'socks') return 'socks5'
  return null
}

function defaultPort(protocol: ProxyProtocol): number {
  switch (protocol) {
    case 'http': return 8080
    case 'https': return 443
    case 'socks5':
    case 'socks4': return 1080
  }
}

function buildProxyUrl(
  protocol: ProxyProtocol,
  host: string,
  port: number,
  username?: string,
  password?: string
): string {
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : ''
  return `${protocol}://${auth}${host}:${port}`
}
