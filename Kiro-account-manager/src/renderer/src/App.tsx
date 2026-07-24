import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AccountManager } from './components/accounts'
import { Sidebar, TitleBar, type PageType } from './components/layout'
import { HomePage, AboutPage, SettingsPage, MachineIdPage, KiroSettingsPage, ProxyPage, KProxyPage, ProxyPoolPage, WebhooksPage, DiagnosePage, ConfigSyncPage, RegisterPage, SubscriptionPage, LogsPage } from './components/pages'
import { useWebhookStore } from './store/webhooks'
import { UpdateDialog } from './components/UpdateDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { useAccountsStore, isBannedAccountError } from './store/accounts'

// Tray information anti-shake delay: merge multiple cross-processes during background refresh storm IPC for a single
const TRAY_UPDATE_DEBOUNCE_MS = 400
// Background refresh result batching interval:N Results are merged into one set,avoid N Second-rate Map Full copy + Rendering jitter
const BACKGROUND_RESULT_FLUSH_MS = 120

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)

  const {
    loadFromStorage,
    startAutoTokenRefresh,
    stopAutoTokenRefresh,
    applyBackgroundRefreshResults,
    applyBackgroundCheckResults,
    flushSaveImmediately,
    accounts,
    activeAccountId,
    setActiveAccount,
    checkAndRefreshExpiringTokens,
    updateAccountStatus,
    updateAccount
  } = useAccountsStore()

  // Switch to next available account
  const switchToNextAccount = useCallback(() => {
    const activeAccounts = Array.from(accounts.values()).filter(acc => acc.status === 'active')
    if (activeAccounts.length <= 1) return

    const currentIndex = activeAccounts.findIndex(acc => acc.id === activeAccountId)
    const nextIndex = (currentIndex + 1) % activeAccounts.length
    setActiveAccount(activeAccounts[nextIndex].id)
  }, [accounts, activeAccountId, setActiveAccount])

  // Tray information anti-shake: account number Map Merge when frequent changes (background refresh storm) N Second-rate IPC for 1 Second-rate
  const trayDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateTrayInfo = useCallback(() => {
    if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    trayDebounceRef.current = setTimeout(() => {
      trayDebounceRef.current = null
      const currentState = useAccountsStore.getState()
      const currentAccounts = currentState.accounts
      const currentActiveId = currentState.activeAccountId

      const accountList = Array.from(currentAccounts.values()).map(acc => ({
        id: acc.id,
        email: acc.email || 'Unknown',
        idp: acc.idp || 'Unknown',
        status: acc.status
      }))
      window.api.updateTrayAccountList(accountList)

      if (currentActiveId) {
        const activeAccount = currentAccounts.get(currentActiveId)
        if (activeAccount) {
          window.api.updateTrayAccount({
            id: activeAccount.id,
            email: activeAccount.email || 'Unknown',
            idp: activeAccount.idp || 'Unknown',
            status: activeAccount.status,
            subscription: activeAccount.subscription?.title || undefined,
            usage: activeAccount.usage ? {
              usedCredits: activeAccount.usage.current || 0,
              totalCredits: activeAccount.usage.limit || 0,
              totalRequests: 0,
              successRequests: 0,
              failedRequests: 0
            } : undefined
          })
        } else {
          window.api.updateTrayAccount(null)
        }
      } else {
        window.api.updateTrayAccount(null)
      }
    }, TRAY_UPDATE_DEBOUNCE_MS)
  }, [])

  // Load data when the app starts and start automatic refresh
  useEffect(() => {
    loadFromStorage().then(() => {
      startAutoTokenRefresh()
    })
    // Synchronous active renewal switch (persistent in main process electron-store）
    useAccountsStore.getState().loadProactiveRenewalEnabled()
    // load Webhook Configuration
    useWebhookStore.getState().loadFromStorage()

    return () => {
      stopAutoTokenRefresh()
    }
  }, [loadFromStorage, startAutoTokenRefresh, stopAutoTokenRefresh])

  // subscription Kiro IDE Own refresh token Events detected after generation
  // Trigger time point:Kiro IDE in the background refresh loop put the disk token Write something new, go against the times watcher Reverse sync to store
  // After receiving the event here, reload the account data from the disk, so that UI Show latest immediately expiresAt / accessToken
  useEffect(() => {
    if (typeof window.api.onKiroIdeTokenChanged !== 'function') return
    const unsubscribe = window.api.onKiroIdeTokenChanged((data) => {
      console.log(`[App] Kiro IDE refreshed token for account ${data.accountId} (${data.reason}), reloading accounts...`)
      loadFromStorage().catch((e) => console.warn('[App] reload after IDE token change failed:', e))
    })
    return unsubscribe
  }, [loadFromStorage])

  // Anti-generational key events → trigger webhook（v1.8 Newly added)
  // Depend on main/proxyServer built-in webhookTrigger pass IPC Push it over and unify it renderer tune useWebhookStore
  useEffect(() => {
    const unsubscribe = window.api.onProxyWebhookTrigger?.((event, payload) => {
      try {
        const store = useWebhookStore.getState()
        // Mapping event names → Webhook event type
        const webhookEventMap: Record<string, 'risk-warning' | 'account-banned'> = {
          'proxy-account-suspended': 'account-banned',
          'proxy-all-exhausted': 'risk-warning'
        }
        const targetEvent = webhookEventMap[event] || 'risk-warning'
        // Standardize level（main use 'error'/'info' String literals, etc., need to be mapped to store accepted types)
        const rawLevel = (payload as { level?: string })?.level
        const level: 'info' | 'warn' | 'error' | 'success' =
          rawLevel === 'error' ? 'error'
          : rawLevel === 'info' ? 'info'
          : rawLevel === 'success' ? 'success'
          : 'warn'
        void store.triggerEvent(targetEvent, {
          title: String((payload as Record<string, unknown>).title ?? 'Anti-generation warning'),
          message: String((payload as Record<string, unknown>).message ?? ''),
          level,
          fields: (payload as { fields?: Record<string, string | number> })?.fields
        })
      } catch (err) {
        console.error('[App] Proxy webhook trigger failed:', err)
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  // In-app page jump (lightweight CustomEvent, no need for deep components prop Drill to cut pages)
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<PageType>).detail
      if (detail) setCurrentPage(detail)
    }
    window.addEventListener('navigate-page', handler)
    return () => window.removeEventListener('navigate-page', handler)
  }, [])

  // Add new banned account → Desktop notifications (only"new ban"Play it once and remove the duplicates + Launch grace period to avoid initial load/Refresh the screen during batch refresh)
  const bannedNotifyStartRef = useRef(Date.now())
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const KEY = 'kiro-notified-banned-ids'
    let notifiedSet: Set<string>
    try {
      notifiedSet = new Set<string>(JSON.parse(localStorage.getItem(KEY) || '[]'))
    } catch {
      notifiedSet = new Set<string>()
    }

    const currentBanned: string[] = []
    const fresh: { email: string; nickname?: string }[] = []
    for (const a of accounts.values()) {
      if (isBannedAccountError(a.lastError)) {
        currentBanned.push(a.id)
        if (!notifiedSet.has(a.id)) fresh.push({ email: a.email, nickname: a.nickname })
      }
    }

    // After startup 8s Only establishes a baseline and does not pop up notifications (covering asynchronous loading) + first status check) before blocking new pop-ups
    const inGracePeriod = Date.now() - bannedNotifyStartRef.current < 8000
    if (!inGracePeriod && fresh.length > 0 && Notification.permission !== 'denied') {
      const fire = (): void => {
        const lang = useAccountsStore.getState().language
        const isEn = lang === 'en' || (lang === 'auto' && !navigator.language.startsWith('zh'))
        const title = fresh.length === 1
          ? (isEn ? 'Account banned' : 'Account banned')
          : (isEn ? `${fresh.length} accounts banned` : `${fresh.length} Accounts have been banned`)
        const names = fresh.slice(0, 3).map((a) => a.nickname || a.email)
        const body = names.join('\n') + (fresh.length > 3 ? (isEn ? `\n+${fresh.length - 3} more` : `\nwait ${fresh.length} indivual`) : '')
        try { new Notification(title, { body }) } catch { /* ignore */ }
      }
      if (Notification.permission === 'granted') fire()
      else void Notification.requestPermission().then((p) => { if (p === 'granted') fire() })
    }

    // Persistence of currently banned collections: removal of unblocked items (you can be reminded again if banned again in the future), and recording of newly banned items to avoid repeated bans
    try { localStorage.setItem(KEY, JSON.stringify(currentBanned)) } catch { /* ignore */ }
  }, [accounts])

  // closure/Force before refresh flush Data to be saved in anti-shake to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = (): void => { void flushSaveImmediately() }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    }
  }, [flushSaveImmediately])

  // Account/Trigger tray update when activation changes (internal anti-shake + directly from store Read the latest data to avoid stale closure）
  useEffect(() => {
    updateTrayInfo()
  }, [accounts, activeAccountId, updateTrayInfo])

  // Listen for tray refresh account events
  useEffect(() => {
    const unsubscribe = window.api.onTrayRefreshAccount(() => {
      checkAndRefreshExpiringTokens()
      updateTrayInfo()
    })
    return () => {
      unsubscribe()
    }
  }, [checkAndRefreshExpiringTokens, updateTrayInfo])

  // Listen for tray switching account events
  useEffect(() => {
    const unsubscribe = window.api.onTraySwitchAccount(() => {
      switchToNextAccount()
    })
    return () => {
      unsubscribe()
    }
  }, [switchToNextAccount])

  // Listening to background refresh results: buffering + Batch flush，N The results are merged into one set,eliminate Map copy storm
  useEffect(() => {
    const refreshBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (refreshBuffer.length === 0) return
      const batch = refreshBuffer.splice(0)
      applyBackgroundRefreshResults(batch)
    }

    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      refreshBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        // Before uninstalling flush Remaining results to prevent loss
        flush()
      }
    }
  }, [applyBackgroundRefreshResults])

  // Monitoring background check results: the same batching strategy
  useEffect(() => {
    const checkBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (checkBuffer.length === 0) return
      const batch = checkBuffer.splice(0)
      applyBackgroundCheckResults(batch)
    }

    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      checkBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flush()
      }
    }
  }, [applyBackgroundCheckResults])

  // Monitor anti-generation account ban events (TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // After the anti-generation is triggered, synchronize the ban status to store let UI show
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountSuspended((info) => {
      console.warn(`[App] Account suspended via proxy: ${info.email || info.id} (${info.reason})`)
      updateAccountStatus(info.id, 'error', `[${info.reason}] ${info.message}`)
    })
    return () => {
      unsubscribe()
    }
  }, [updateAccountStatus])

  // Monitor anti-generation account update events (Enterprise profileArn self-healing), lasting to store + disk
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountUpdate((info) => {
      if (!info.profileArn) return
      const account = useAccountsStore.getState().accounts.get(info.id)
      if (!account || account.credentials?.profileArn === info.profileArn) return
      updateAccount(info.id, {
        profileArn: info.profileArn,
        credentials: { ...account.credentials, profileArn: info.profileArn }
      })
      console.log(`[App] Persisted Enterprise profileArn for ${info.id}`)
    })
    return () => {
      unsubscribe()
    }
  }, [updateAccount])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return <KiroSettingsPage />
      case 'proxy':
        return <ProxyPage />
      case 'kproxy':
        return <KProxyPage />
      case 'proxyPool':
        return <ProxyPoolPage />
      case 'register':
        return <RegisterPage />
      case 'subscription':
        return <SubscriptionPage />
      case 'webhooks':
        return <WebhooksPage />
      case 'diagnose':
        return <DiagnosePage />
      case 'configSync':
        return <ConfigSyncPage />
      case 'logs':
        return <LogsPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="h-screen ambient-bg overflow-hidden flex flex-col">
      <TitleBar />
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        <Sidebar
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className="flex-1 min-w-0 overflow-hidden rounded-3xl page-surface">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="h-full flex flex-col"
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <UpdateDialog />
      <CloseConfirmDialog />
    </div>
  )
}

export default App
