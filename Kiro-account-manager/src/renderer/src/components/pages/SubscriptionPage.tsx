import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAccountsStore } from '@/store/accounts'
import { Button, Card, CardContent } from '../ui'
import { 
  CreditCard, 
  ExternalLink, 
  Copy, 
  Download, 
  Loader2, 
  CheckCircle, 
  XCircle, 
  CheckSquare, 
  Square, 
  Minus,
  RefreshCw,
  Trash2,
  Zap,
  ShieldCheck,
  AlertTriangle,
  Ban,
  Upload,
  ListChecks,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Pre-check before subscription upgrade: Determine whether an account can participate in batch upgrade from the perspective of an account
 * return { eligible: bool, reason?: string }
 */
type EligibilityReason = 'ok' | 'no-token' | 'already-pro' | 'banned' | 'cant-upgrade' | 'unknown-status'
function checkUpgradeEligibility(account: ReturnType<typeof useAccountsStore.getState>['accounts'] extends Map<string, infer T> ? T : never): { eligible: boolean; reason: EligibilityReason; detail?: string } {
  if (!account.credentials?.accessToken) return { eligible: false, reason: 'no-token' }

  const type = (account.subscription?.type || '').toUpperCase()
  const title = (account.subscription?.title || '').toUpperCase()
  const isFreeTier = type.includes('FREE') || title.includes('FREE') || (!type && !title)
  const isAlreadyPaid = type.includes('PRO') || type.includes('ENTERPRISE') || type.includes('TEAMS')
    || title.includes('PRO') || title.includes('ENTERPRISE') || title.includes('TEAMS')

  if (isAlreadyPaid) {
    return { eligible: false, reason: 'already-pro', detail: account.subscription?.title || account.subscription?.type }
  }
  if (!isFreeTier) {
    return { eligible: false, reason: 'unknown-status', detail: account.subscription?.title || account.subscription?.type || 'Not detected' }
  }

  // Ban detection
  const lastError = (account.lastError || '').toLowerCase()
  const isBanned = account.status === 'error' && (
    lastError.includes('suspended') || lastError.includes('ban') || lastError.includes('temporarily')
  )
  if (isBanned) {
    return { eligible: false, reason: 'banned', detail: account.lastError }
  }

  // upgradeCapability examine(API When it is clearly stated that upgrade is not possible)
  const upgradeCap = account.subscription?.upgradeCapability
  if (upgradeCap && upgradeCap.toUpperCase().includes('NOT')) {
    return { eligible: false, reason: 'cant-upgrade', detail: upgradeCap }
  }

  return { eligible: true, reason: 'ok' }
}

type SubTab = 'overage' | 'links' | 'manage'

interface SubscriptionPlan {
  name: string
  qSubscriptionType: string
  description: { title: string; billingInterval: string; featureHeader: string; features: string[] }
  pricing: { amount: number; currency: string }
}

interface SubscriptionLink {
  accountId: string
  email: string
  status: 'pending' | 'loading' | 'success' | 'error' | 'expired'
  url?: string
  error?: string
  /** Link generation time (used to estimate validity period) */
  generatedAt?: number
  /** Whether the link has been tested for local validity and passed */
  validated?: boolean
}

interface OverageItem {
  accountId: string
  email: string
  status: 'pending' | 'loading' | 'success' | 'error' | 'skipped'
  error?: string
}

// Module-level state: retained after component uninstallation (within the same session)
let _links: SubscriptionLink[] = []
let _linksNotify: ((links: SubscriptionLink[]) => void) | null = null

export function appendSubscriptionLink(link: SubscriptionLink): void {
  _links = [..._links, link]
  _linksNotify?.(_links)
}

export function updateSubscriptionLink(accountId: string, update: Partial<SubscriptionLink>): void {
  _links = _links.map(l => l.accountId === accountId ? { ...l, ...update } : l)
  _linksNotify?.(_links)
}
let _availablePlans: SubscriptionPlan[] = []
let _selectedPlanType = ''
let _selectedLinkIds: Set<string> = new Set()
let _activeTab: SubTab = 'overage'
let _overageItems: OverageItem[] = []
let _quickPickCount = 10

/**
 * Parse the link text imported in batches: one per line, support pure URL or "email<delimiter>URL」
 * Delimiters are compatible with spaces / comma / Tab / vertical line / ----，URL Automatically extract from rows
 */
function parseImportedLinks(text: string): Array<{ email: string; url: string }> {
  const out: Array<{ email: string; url: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/https?:\/\/[^\s,|]+/i)
    if (!m || m.index === undefined) continue
    const url = m[0].replace(/[)\]}>.,;'"]+$/, '')
    const prefix = line.slice(0, m.index).trim()
    const emailMatch = prefix.match(/[^\s,|<>"']+@[^\s,|<>"']+\.[^\s,|<>"']+/)
    out.push({ email: emailMatch ? emailMatch[0] : '', url })
  }
  return out
}

export function SubscriptionPage() {
  const { accounts, selectedIds, updateAccount, removeAccount } = useAccountsStore()
  const { actualLanguage } = useTranslation()
  const isEn = actualLanguage === 'en'

  const [activeTab, setActiveTabState] = useState<SubTab>(_activeTab)
  const setActiveTab = (v: SubTab) => { _activeTab = v; setActiveTabState(v) }
  
  const [links, setLinksState] = useState<SubscriptionLink[]>(_links)
  const [isFetching, setIsFetching] = useState(false)
  const [selectedLinkIds, setSelectedLinkIdsState] = useState<Set<string>>(_selectedLinkIds)
  // Batch import link dialog box
  const [showImportDialog, setShowImportDialog] = useState(false)
  // Quick selection: Select available links in batches by a set number from the top (default 10, cross-page memory)
  const [quickPickCount, setQuickPickCountState] = useState(_quickPickCount)
  const [quickPickCursor, setQuickPickCursor] = useState(0)
  const setQuickPickCount = (n: number) => { _quickPickCount = n; setQuickPickCountState(n) }
  
  // Plan selection related
  const [availablePlans, setAvailablePlansState] = useState<SubscriptionPlan[]>(_availablePlans)
  const [selectedPlanType, setSelectedPlanTypeState] = useState<string>(_selectedPlanType)
  const [isLoadingPlans, setIsLoadingPlans] = useState(false)

  // excess correlation
  const [overageItems, setOverageItemsState] = useState<OverageItem[]>(_overageItems)
  const [isSettingOverage, setIsSettingOverage] = useState(false)
  const overageListRef = useRef<HTMLDivElement>(null)

  // Package setter, update module-level variables synchronously
  const setLinks = (val: SubscriptionLink[] | ((prev: SubscriptionLink[]) => SubscriptionLink[])) => {
    setLinksState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _links = next
      return next
    })
  }
  const setSelectedLinkIds = (val: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setSelectedLinkIdsState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _selectedLinkIds = next
      return next
    })
  }
  const setAvailablePlans = (val: SubscriptionPlan[]) => {
    _availablePlans = val
    setAvailablePlansState(val)
  }
  const setSelectedPlanType = (val: string) => {
    _selectedPlanType = val
    setSelectedPlanTypeState(val)
  }
  const setOverageItems = (val: OverageItem[] | ((prev: OverageItem[]) => OverageItem[])) => {
    setOverageItemsState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _overageItems = next
      return next
    })
  }

  // Register an external write callback (let appendSubscriptionLink/updateSubscriptionLink synchronous React state）
  useEffect(() => {
    _linksNotify = setLinksState
    return () => { _linksNotify = null }
  }, [])

  // Excess list automatically scrolls to bottom
  useEffect(() => {
    const el = overageListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [overageItems])

  // Get upgradeable FREE Accounts (from selected or all)
  const getUpgradeableAccounts = useCallback(() => {
    const source = selectedIds.size > 0 
      ? Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
      : Array.from(accounts.values())
    
    return source.filter(acc => {
      if (!acc) return false
      const type = (acc.subscription?.type || '').toUpperCase()
      const title = (acc.subscription?.title || '').toUpperCase()
      const isFreeTier = type.includes('FREE') || title.includes('FREE') || (!type && !title)
      const hasToken = !!acc.credentials?.accessToken
      return isFreeTier && hasToken
    })
  }, [accounts, selectedIds])

  // Subscription pre-upgrade preflight: based on"Select an account or all accounts"Do a complete check and list upgradeable / Reason for not upgrading
  const preflightReport = useMemo(() => {
    const source = selectedIds.size > 0
      ? Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
      : Array.from(accounts.values())
    const eligible: typeof source = []
    const blocked: Array<{ account: NonNullable<typeof source[number]>; reason: EligibilityReason; detail?: string }> = []
    for (const acc of source) {
      if (!acc) continue
      const r = checkUpgradeEligibility(acc)
      if (r.eligible) eligible.push(acc)
      else blocked.push({ account: acc, reason: r.reason, detail: r.detail })
    }
    // according to reason bucket
    const reasonBuckets: Record<EligibilityReason, number> = {
      'ok': eligible.length,
      'no-token': 0, 'already-pro': 0, 'banned': 0, 'cant-upgrade': 0, 'unknown-status': 0
    }
    for (const b of blocked) reasonBuckets[b.reason]++
    return { eligible, blocked, reasonBuckets, totalScanned: source.length }
  }, [accounts, selectedIds])

  // Load available subscription plans (call with any available account)
  const handleLoadPlans = async () => {
    const upgradeableAccounts = getUpgradeableAccounts()
    if (upgradeableAccounts.length === 0) return

    setIsLoadingPlans(true)
    const acc = upgradeableAccounts[0]!
    
    try {
      const result = await window.api.accountGetSubscriptions(
        acc.credentials.accessToken,
        acc.credentials?.region,
        acc.profileArn,
        acc.machineId,
        acc.credentials?.provider || acc.idp,
        acc.credentials?.authMethod,
        acc.id
      )
      if (result.success && result.plans && result.plans.length > 0) {
        setAvailablePlans(result.plans)
        // The first one is selected by default PRO plan
        const defaultPlan = result.plans.find(p => 
          p.qSubscriptionType?.toUpperCase().includes('PRO') && !p.qSubscriptionType?.toUpperCase().includes('PLUS')
        ) || result.plans[0]
        setSelectedPlanType(defaultPlan.qSubscriptionType)
      }
    } catch (error) {
      console.error('[SubscriptionPage] Failed to load plans:', error)
    }
    setIsLoadingPlans(false)
  }

  // Number of concurrencies
  const [concurrency, setConcurrency] = useState(5)

  // Whether to delete the account itself when deleting the failed link (clearance of banned accounts)
  const [deleteAlsoAccount, setDeleteAlsoAccount] = useState(false)

  // Get subscription links in batches concurrently
  const handleBatchFetch = async () => {
    const upgradeableAccounts = getUpgradeableAccounts()
    if (upgradeableAccounts.length === 0 || !selectedPlanType) return

    setIsFetching(true)
    
    // initialization state
    const initialLinks: SubscriptionLink[] = upgradeableAccounts.map(acc => ({
      accountId: acc!.id,
      email: acc!.email || 'Unknown',
      status: 'pending'
    }))
    setLinks(initialLinks)
    setSelectedLinkIds(new Set())

    // Obtain tasks for a single account
    const fetchOne = async (idx: number) => {
      const acc = upgradeableAccounts[idx]!
      setLinks(prev => prev.map((link, i) => 
        i === idx ? { ...link, status: 'loading' } : link
      ))

      try {
        const tokenResult = await window.api.accountGetSubscriptionUrl(
          acc.credentials.accessToken,
          selectedPlanType,
          acc.credentials?.region,
          acc.profileArn,
          acc.machineId,
          acc.credentials?.provider || acc.idp,
          acc.credentials?.authMethod,
          acc.id
        )

        if (tokenResult.success && tokenResult.url) {
          setLinks(prev => prev.map((link, i) => 
            i === idx ? { ...link, status: 'success', url: tokenResult.url, generatedAt: Date.now(), validated: false } : link
          ))
        } else {
          setLinks(prev => prev.map((link, i) => 
            i === idx ? { ...link, status: 'error', error: tokenResult.error || 'Failed to get URL' } : link
          ))
        }
      } catch (error) {
        setLinks(prev => prev.map((link, i) => 
          i === idx ? { ...link, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' } : link
        ))
      }
    }

    // Concurrency pool execution
    const indices = Array.from({ length: upgradeableAccounts.length }, (_, i) => i)
    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < indices.length) {
        const idx = cursor++
        await fetchOne(idx)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, indices.length) }, () => runNext())
    await Promise.all(workers)

    setIsFetching(false)
  }

  // choose/Deselect link (allow any status)
  const toggleLinkSelection = (accountId: string) => {
    setSelectedLinkIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      return next
    })
  }

  // Select all / Unselect all links in the current list (no longer limited to success）
  const toggleSelectAll = () => {
    if (selectedLinkIds.size === links.length && links.length > 0) {
      setSelectedLinkIds(new Set())
    } else {
      setSelectedLinkIds(new Set(links.map(l => l.accountId)))
    }
  }

  // Counter-election
  const invertSelection = () => {
    setSelectedLinkIds(prev => {
      const next = new Set<string>()
      for (const l of links) {
        if (!prev.has(l.accountId)) next.add(l.accountId)
      }
      return next
    })
  }

  // Cancel multiple selections (clear selection)
  const clearSelection = () => {
    setSelectedLinkIds(new Set())
  }

  // Select by status: Add links with specified status to the current selection set (retain existing selections)
  const selectByStatus = (status: SubscriptionLink['status']) => {
    setSelectedLinkIds(prev => {
      const next = new Set(prev)
      for (const l of links) {
        if (l.status === status) next.add(l.accountId)
      }
      return next
    })
  }

  // Quick selection: start from the top before selecting N available (success) link to facilitate opening in batches
  const quickPickTop = () => {
    const successList = links.filter(l => l.status === 'success' && l.url)
    const n = Math.max(1, quickPickCount)
    const picked = successList.slice(0, n)
    setSelectedLinkIds(new Set(picked.map(l => l.accountId)))
    setQuickPickCursor(picked.length)
  }

  // Quickly select the next batch: continue selecting from the last cursor N available links, then loop back to the beginning after reaching the end
  const quickPickNext = () => {
    const successList = links.filter(l => l.status === 'success' && l.url)
    if (successList.length === 0) return
    const n = Math.max(1, quickPickCount)
    let start = quickPickCursor
    if (start >= successList.length) start = 0
    const picked = successList.slice(start, start + n)
    setSelectedLinkIds(new Set(picked.map(l => l.accountId)))
    setQuickPickCursor(start + picked.length)
  }

  // Import external links in batches: after parsing, use success Status is appended to the list (press url Remove duplicates), you can select as many as existing links/Open/Export
  const handleImportLinks = (text: string): number => {
    const parsed = parseImportedLinks(text)
    if (parsed.length === 0) return 0
    const existingUrls = new Set(links.map(l => l.url).filter(Boolean) as string[])
    const now = Date.now()
    const added: SubscriptionLink[] = []
    let seq = links.length
    for (const { email, url } of parsed) {
      if (existingUrls.has(url)) continue
      existingUrls.add(url)
      seq++
      added.push({
        accountId: `import-${crypto.randomUUID()}`,
        email: email || (isEn ? `(Imported #${seq})` : `(import #${seq})`),
        status: 'success',
        url,
        generatedAt: now,
        validated: false
      })
    }
    if (added.length > 0) setLinks(prev => [...prev, ...added])
    return added.length
  }

  // Delete selected links in batches (remove from the results list, no call will be made) API）
  const handleBatchDelete = () => {
    if (selectedLinkIds.size === 0) return
    if (!confirm(isEn
      ? `Remove ${selectedLinkIds.size} selected links from the list?`
      : `Remove selected from list ${selectedLinkIds.size} A link?`
    )) return
    setLinks(prev => prev.filter(l => !selectedLinkIds.has(l.accountId)))
    setSelectedLinkIds(new Set())
  }

  // Batch delete"fail + Expired": Clean up invalid items and keep available links; check deleteAlsoAccount Delete the account simultaneously
  const handleDeleteFailed = () => {
    const failedLinks = links.filter(l => l.status === 'error' || l.status === 'expired')
    const count = failedLinks.length
    if (count === 0) return
    const confirmMsg = deleteAlsoAccount
      ? (isEn
        ? `Remove ${count} failed/expired links AND delete their accounts permanently?`
        : `Remove ${count} a failure/Expired links and permanently delete these accounts?`)
      : (isEn
        ? `Remove ${count} failed/expired links?`
        : `Remove ${count} a failure/Expired link?`)
    if (!confirm(confirmMsg)) return

    const removedIds = failedLinks.map(l => l.accountId)

    // Delete the account together (clean up the banned account)
    if (deleteAlsoAccount && removedIds.length > 0) {
      for (const id of removedIds) {
        removeAccount(id)
      }
    }

    setLinks(prev => {
      const filtered = prev.filter(l => l.status !== 'error' && l.status !== 'expired')
      if (removedIds.length > 0) {
        setSelectedLinkIds(s => {
          const next = new Set(s)
          for (const id of removedIds) next.delete(id)
          return next
        })
      }
      return filtered
    })
  }

  // Get list of target links (selected or all successful)
  const getTargetLinks = (mode: 'selected' | 'all'): SubscriptionLink[] => {
    const successLinks = links.filter(l => l.status === 'success' && l.url)
    if (mode === 'selected') {
      return successLinks.filter(l => selectedLinkIds.has(l.accountId))
    }
    return successLinks
  }

  // Open a single link
  const handleOpenLink = async (url: string) => {
    await window.api.openSubscriptionWindow(url)
  }

  // Regenerate a single link (called when the link expires)
  const handleRegenerateLink = async (accountId: string): Promise<void> => {
    if (!selectedPlanType) {
      alert(isEn ? 'Please select a plan first' : 'Please select a plan first')
      return
    }
    const acc = accounts.get(accountId)
    if (!acc || !acc.credentials?.accessToken) return

    setLinks(prev => prev.map((l) => l.accountId === accountId ? { ...l, status: 'loading', error: undefined } : l))
    try {
      const r = await window.api.accountGetSubscriptionUrl(
        acc.credentials.accessToken,
        selectedPlanType,
        acc.credentials?.region,
        acc.profileArn,
        acc.machineId,
        acc.credentials?.provider || acc.idp,
        acc.credentials?.authMethod,
        acc.id
      )
      setLinks(prev => prev.map((l) =>
        l.accountId === accountId
          ? (r.success && r.url
            ? { ...l, status: 'success', url: r.url, error: undefined, generatedAt: Date.now(), validated: false }
            : { ...l, status: 'error', error: r.error || 'Failed' }
          )
          : l
      ))
    } catch (err) {
      setLinks(prev => prev.map((l) =>
        l.accountId === accountId
          ? { ...l, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' }
          : l
      ))
    }
  }

  // Check all link validity: based on generation time + reality HTTP HEAD probe(C5）
  const [isValidatingLinks, setIsValidatingLinks] = useState(false)
  const handleValidateLinks = async (): Promise<void> => {
    setIsValidatingLinks(true)
    try {
      const targets = links.filter((l) => l.status === 'success' && l.url)
      const STALE_AFTER_MS = 15 * 60 * 1000
      const now = Date.now()

      // Mark by time first expired, the remaining concurrency is used HTTP Detect true reachability
      const checkResults: Record<string, 'success' | 'expired'> = {}
      const realProbe = targets.filter((l) => {
        const age = l.generatedAt ? now - l.generatedAt : Number.POSITIVE_INFINITY
        if (age > STALE_AFTER_MS) {
          checkResults[l.accountId] = 'expired'
          return false
        }
        return true
      })

      // Concurrently probe remaining links (limit concurrency to avoid DDoS Own / Trigger risk control)
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < realProbe.length) {
          const idx = cursor++
          const l = realProbe[idx]
          if (!l.url) continue
          try {
            const r = await window.api.diagnoseHttpProbe({ url: l.url, method: 'HEAD', timeoutMs: 6000 })
            // 4xx/5xx deemed invalid,2xx/3xx considered valid
            checkResults[l.accountId] = r.success || (r.status !== undefined && r.status < 400)
              ? 'success'
              : 'expired'
          } catch {
            checkResults[l.accountId] = 'expired'
          }
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, realProbe.length) }, () => worker())
      await Promise.all(workers)

      const next = links.map((l) => {
        const result = checkResults[l.accountId]
        if (!result) return l
        if (result === 'expired') {
          return { ...l, status: 'expired' as const, error: 'The link has expired (HTTP Detection failed or exceeded 15 minute)' }
        }
        return { ...l, validated: true }
      })
      setLinks(next)

      const expired = next.filter((l) => l.status === 'expired').length
      const valid = next.filter((l) => l.status === 'success' && l.validated).length
      addLog(`[Validate] Test completed:${valid} valid,${expired} failure`)
    } finally {
      setIsValidatingLinks(false)
    }
  }
  // Simple log (not available on the subscription page addLog,only console）
  function addLog(msg: string): void {
    console.log(`[SubscriptionPage] ${msg}`)
  }

  // Open links in batches (all at the same time)
  const handleBatchOpen = async (mode: 'selected' | 'all') => {
    const targetLinks = getTargetLinks(mode)
    await Promise.all(
      targetLinks
        .filter(l => l.url)
        .map(l => window.api.openSubscriptionWindow(l.url!))
    )
  }

  // Copy a single link
  const handleCopyLink = async (url: string) => {
    await navigator.clipboard.writeText(url)
  }

  // Export link
  const handleExport = async (mode: 'selected' | 'all') => {
    const targetLinks = getTargetLinks(mode)
    const text = targetLinks.map(l => l.url).join('\n')
    await navigator.clipboard.writeText(text)
  }

  // ===== One-click overage function =====
  // Get the account that can set the overage (only not opened): subscribed (not Free),have token, excess capacity is available, excess capacity is not enabled
  const getOverageableAccounts = useCallback(() => {
    return getAllSubscribedAccounts().filter(acc => acc && acc.subscription?.overageCapability === 'OVERAGE_CAPABLE' && acc.usage?.resourceDetail?.overageEnabled !== true)
  }, [accounts, selectedIds])

  // Get all subscribed accounts (no limit on excess capacity, no limit on whether they are enabled)
  const getAllSubscribedAccounts = useCallback(() => {
    const source = selectedIds.size > 0
      ? Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
      : Array.from(accounts.values())

    return source.filter(acc => {
      if (!acc) return false
      const hasToken = !!acc.credentials?.accessToken
      const type = (acc.subscription?.type || '').toUpperCase()
      const title = (acc.subscription?.title || '').toUpperCase()
      const isSubscribed = type.includes('PRO') || type.includes('ENTERPRISE') || type.includes('TEAMS') || title.includes('PRO') || title.includes('ENTERPRISE') || title.includes('TEAMS')
      return hasToken && isSubscribed
    })
  }, [accounts, selectedIds])

  const handleBatchSetOverage = async (customTargets?: NonNullable<ReturnType<typeof getAllSubscribedAccounts>>) => {
    const targets = customTargets ?? getOverageableAccounts()
    if (targets.length === 0) return

    setIsSettingOverage(true)

    // initialization list
    const initialItems: OverageItem[] = targets.map(acc => ({
      accountId: acc!.id,
      email: acc!.email || 'Unknown',
      status: 'pending'
    }))
    setOverageItems(initialItems)

    const setOne = async (idx: number) => {
      const acc = targets[idx]!
      setOverageItems(prev => prev.map((item, i) =>
        i === idx ? { ...item, status: 'loading' } : item
      ))

      try {
        const res = await window.api.accountSetOverage(
          acc.credentials.accessToken,
          'ENABLED',
          acc.credentials?.region,
          acc.profileArn,
          acc.machineId,
          acc.credentials?.provider || acc.idp,
          acc.credentials?.authMethod,
          acc.id
        )
        if (res.success) {
          setOverageItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: 'success' } : item
          ))
          // renew store The overage status of the account in the UI Immediate response
          const existing = accounts.get(acc.id)
          if (existing) {
            updateAccount(acc.id, {
              usage: {
                ...existing.usage,
                resourceDetail: {
                  ...existing.usage?.resourceDetail,
                  overageEnabled: true
                }
              }
            })
          }
        } else {
          setOverageItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: 'error', error: res.error || 'Unknown error' } : item
          ))
        }
      } catch (e) {
        setOverageItems(prev => prev.map((item, i) =>
          i === idx ? { ...item, status: 'error', error: e instanceof Error ? e.message : 'Unknown error' } : item
        ))
      }
    }

    // Concurrency pool
    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < targets.length) {
        const idx = cursor++
        await setOne(idx)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => runNext())
    await Promise.all(workers)

    setIsSettingOverage(false)
  }

  const overageableCount = getOverageableAccounts().length
  const allSubscribedCount = getAllSubscribedAccounts().length
  const overageSuccessCount = overageItems.filter(i => i.status === 'success').length
  const overageErrorCount = overageItems.filter(i => i.status === 'error').length

  const successCount = links.filter(l => l.status === 'success').length
  const errorCount = links.filter(l => l.status === 'error').length
  const selectedCount = selectedLinkIds.size
  const upgradeableCount = getUpgradeableAccounts().length

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary/10">
            <CreditCard className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Batch Subscription' : 'Bulk subscription'}</h1>
            <p className="text-sm text-muted-foreground">
              {selectedIds.size > 0
                ? (isEn ? `Using ${selectedIds.size} selected accounts` : `Use selected ${selectedIds.size} accounts`)
                : (isEn ? 'Using all accounts' : 'Use all accounts')
              }
            </p>
          </div>
        </div>
      </div>

      {/* internal Tab switch */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('overage')}
          className={cn(
            'px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'overage'
              ? 'bg-background shadow text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Zap className="h-4 w-4" />
          {isEn ? 'Overage Settings' : 'Overage setting'}
        </button>
        <button
          onClick={() => setActiveTab('links')}
          className={cn(
            'px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'links'
              ? 'bg-background shadow text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <CreditCard className="h-4 w-4" />
          {isEn ? 'Subscription Links' : 'Get link'}
        </button>
        <button
          onClick={() => setActiveTab('manage')}
          className={cn(
            'px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'manage'
              ? 'bg-background shadow text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <ShieldCheck className="h-4 w-4" />
          {isEn ? 'Manage Subscriptions' : 'Subscription management'}
        </button>
      </div>

      {/* ===== Overage setting Tab ===== */}
      {activeTab === 'overage' && (
        <>
          {/* Action bar */}
          <Card>
            <CardContent className="py-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => handleBatchSetOverage()}
                disabled={isSettingOverage || overageableCount === 0}
              >
                {isSettingOverage ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Enable Overage (${overageableCount})`
                  : `One-click overage (${overageableCount})`
                }
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBatchSetOverage(getAllSubscribedAccounts())}
                disabled={isSettingOverage || allSubscribedCount === 0}
              >
                {isSettingOverage ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Set All (${allSubscribedCount})`
                  : `All settings (${allSubscribedCount})`
                }
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOverageItems([])}
                disabled={isSettingOverage || overageItems.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Clear' : 'Clear'}
              </Button>

              {/* Only delete failed items (keep successful results for auditing purposes) */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOverageItems(prev => prev.filter(it => it.status !== 'error'))}
                disabled={isSettingOverage || overageErrorCount === 0}
                title={isEn ? 'Remove failed items only' : 'Remove only failed items'}
              >
                <XCircle className="h-4 w-4 mr-1" />
                {isEn ? `Clear Failed (${overageErrorCount})` : `Clear failed (${overageErrorCount})`}
              </Button>

              {/* Concurrency control */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">{isEn ? 'Concurrency:' : 'concurrent:'}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (val > 0) setConcurrency(val)
                  }}
                  disabled={isSettingOverage}
                  className="h-7 w-14 px-1.5 rounded border border-border bg-background text-xs text-center"
                />
              </div>

              <span className="text-xs text-muted-foreground ml-2">
                {overageableCount > 0
                  ? (isEn ? `${overageableCount} subscribed accounts without overage enabled` : `${overageableCount} Subscribed accounts have not been exceeded`)
                  : (isEn ? 'No accounts need overage enablement' : 'There is no need to open an excess account')
                }
              </span>

              {/* statistics */}
              {overageItems.length > 0 && (
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  {overageSuccessCount > 0 && (
                    <span className="flex items-center gap-1 text-green-600">
                      <CheckCircle className="h-3 w-3" /> {overageSuccessCount}
                    </span>
                  )}
                  {overageErrorCount > 0 && (
                    <span className="flex items-center gap-1 text-red-500">
                      <XCircle className="h-3 w-3" /> {overageErrorCount}
                    </span>
                  )}
                  {isSettingOverage && (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {overageItems.filter(i => i.status === 'pending' || i.status === 'loading').length}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Excess result list */}
          {overageItems.length > 0 && (
            <Card>
              <CardContent className="py-2">
                {/* Header */}
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : 'Mail'}</span>
                  <span className="w-20 text-center">{isEn ? 'Status' : 'state'}</span>
                  <span className="flex-1 text-right">{isEn ? 'Details' : 'Details'}</span>
                </div>

                {/* list */}
                <div ref={overageListRef} className="max-h-[60vh] overflow-y-auto">
                  {overageItems.map((item, idx) => (
                    <div
                      key={item.accountId}
                      className="flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                    >
                      <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>
                      <span className="flex-1 text-sm truncate" title={item.email}>{item.email}</span>
                      <span className="w-20 flex justify-center">
                        {item.status === 'pending' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Pending' : 'Waiting'}</span>
                        )}
                        {item.status === 'loading' && (
                          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        )}
                        {item.status === 'success' && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {item.status === 'error' && (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        {item.status === 'skipped' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Skipped' : 'jump over'}</span>
                        )}
                      </span>
                      <span className="flex-1 text-right text-xs truncate">
                        {item.status === 'success' && (
                          <span className="text-green-600">{isEn ? 'Overage enabled' : 'Overage is enabled'}</span>
                        )}
                        {item.status === 'error' && (
                          <span className="text-red-500" title={item.error}>{item.error}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Overview of account overage status (displayed when batch operations are not performed) */}
          {overageItems.length === 0 && (
            <Card>
              <CardContent className="py-2">
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : 'Mail'}</span>
                  <span className="w-24 text-center">{isEn ? 'Subscription' : 'Subscription type'}</span>
                  <span className="w-24 text-center">{isEn ? 'Overage Capable' : 'excess capacity'}</span>
                  <span className="w-24 text-center">{isEn ? 'Overage Status' : 'excess status'}</span>
                </div>
                {allSubscribedCount > 0 ? (
                  <div className="max-h-[60vh] overflow-y-auto">
                    {getAllSubscribedAccounts().map((acc, idx) => {
                      if (!acc) return null
                      const capable = acc.subscription?.overageCapability === 'OVERAGE_CAPABLE'
                      const enabled = acc.usage?.resourceDetail?.overageEnabled === true
                      return (
                        <div
                          key={acc.id}
                          className="flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                        >
                          <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>
                          <span className="flex-1 text-sm truncate" title={acc.email}>{acc.email}</span>
                          <span className="w-24 text-center text-xs">
                            {acc.subscription?.title || acc.subscription?.type || '-'}
                          </span>
                          <span className="w-24 flex justify-center">
                            {capable ? (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-muted-foreground/40" />
                            )}
                          </span>
                          <span className="w-24 flex justify-center">
                            {enabled ? (
                              <span className="text-xs text-green-600 font-medium">{isEn ? 'ENABLED' : 'Already turned on'}</span>
                            ) : capable ? (
                              <span className="text-xs text-amber-500 font-medium">{isEn ? 'DISABLED' : 'Not turned on'}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="py-12 text-center text-muted-foreground">
                    <Zap className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">
                      {isEn
                        ? 'No subscribed accounts found. Ensure accounts are checked first.'
                        : 'Subscribed account not found. Please check the account status first.'}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ===== Subscription management Tab ===== */}
      {activeTab === 'manage' && (
        <ManageSubscriptionsTab
          getAllSubscribed={getAllSubscribedAccounts}
          updateAccount={updateAccount}
          concurrency={concurrency}
          isEn={isEn}
        />
      )}

      {false && false && (
        <>
          {/* Description (replaced by new ManageSubscriptionsTab alternative, reserved as dead code Prevent accidental deletion - eslint ignored) */}
          <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/10">
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-medium">
                  {isEn ? 'Subscription Lifecycle Management' : 'Subscription lifecycle management'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Cancel or downgrade subscriptions. Kiro/AWS does not provide a direct cancel API for OIDC accounts — clicking "Get cancel URL" generates the same subscription portal link used for upgrade, where you can manage/cancel via AWS billing console.'
                  : 'Cancel or downgrade your subscription.Kiro/AWS right OIDC If the account is not public, you can cancel the subscription directly. API, click"Get cancel link"A link to the subscription portal will be generated, available at AWS Billing console manual management/Unsubscribe.'
                }
              </p>
            </CardContent>
          </Card>

          {/* Subscribed account list */}
          <Card>
            <CardContent className="py-0 px-0">
              <div className="flex items-center gap-3 py-2 px-3 border-b text-xs font-medium text-muted-foreground bg-muted/30">
                <span className="w-8 text-center">#</span>
                <span className="flex-1">{isEn ? 'Email' : 'Mail'}</span>
                <span className="w-32 text-center">{isEn ? 'Plan' : 'Subscription type'}</span>
                <span className="w-32 text-center">{isEn ? 'Expires' : 'maturity'}</span>
                <span className="w-40 text-center">{isEn ? 'Actions' : 'operate'}</span>
              </div>

              {(() => {
                const subscribed = getAllSubscribedAccounts()
                if (subscribed.length === 0) {
                  return (
                    <div className="py-12 text-center text-muted-foreground">
                      <CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">
                        {isEn
                          ? 'No subscribed accounts found. Run "Check Accounts" first to refresh status.'
                          : 'No subscribed account found. Please first go to the account page"Batch inspection"Refresh status.'
                        }
                      </p>
                    </div>
                  )
                }
                return (
                  <div className="max-h-[60vh] overflow-y-auto">
                    {subscribed.map((acc, idx) => {
                      if (!acc) return null
                      const planName = acc.subscription?.title || acc.subscription?.type || '-'
                      const expiresAt = acc.subscription?.expiresAt
                      const daysLeft = acc.subscription?.daysRemaining
                      return (
                        <div
                          key={acc.id}
                          className="flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs"
                        >
                          <span className="w-8 text-center text-muted-foreground">{idx + 1}</span>
                          <span className="flex-1 truncate" title={acc.email}>{acc.email}</span>
                          <span className="w-32 text-center">
                            <span className={cn(
                              'inline-block px-2 py-0.5 rounded text-[10px] font-medium',
                              planName.toUpperCase().includes('PRO+') || planName.toUpperCase().includes('PRO_PLUS')
                                ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
                                : planName.toUpperCase().includes('POWER')
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                  : planName.toUpperCase().includes('PRO')
                                    ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                                    : 'bg-muted text-muted-foreground'
                            )}>
                              {planName}
                            </span>
                          </span>
                          <span className="w-32 text-center text-muted-foreground">
                            {expiresAt
                              ? new Date(expiresAt).toLocaleDateString('zh-CN')
                              : (daysLeft != null
                                ? (isEn ? `${daysLeft}d` : `${daysLeft} sky`)
                                : '-'
                              )
                            }
                          </span>
                          <span className="w-40 flex justify-center gap-1">
                            <button
                              onClick={async () => {
                                // Reuse fetchSubscriptionToken Get the portal link and open it in an incognito browser
                                const r = await window.api.accountGetSubscriptionUrl(
                                  acc.credentials.accessToken,
                                  undefined,
                                  acc.credentials?.region,
                                  acc.profileArn,
                                  acc.machineId,
                                  acc.credentials?.provider || acc.idp,
                                  acc.credentials?.authMethod,
                                  acc.id
                                )
                                if (r.success && r.url) {
                                  await window.api.openSubscriptionWindow(r.url)
                                } else {
                                  alert(isEn ? `Failed: ${r.error}` : `fail: ${r.error}`)
                                }
                              }}
                              className="px-2 py-1 rounded text-[10px] bg-primary/10 text-primary hover:bg-primary/20"
                              title={isEn ? 'Open subscription portal to cancel/manage' : 'Open subscription portal to cancel/manage'}
                            >
                              <ExternalLink className="h-3 w-3 inline mr-1" />
                              {isEn ? 'Manage' : 'manage'}
                            </button>

                            {acc.usage?.resourceDetail?.overageEnabled && (
                              <button
                                onClick={async () => {
                                  if (!confirm(isEn
                                    ? `Disable overage for ${acc.email}?`
                                    : `closure ${acc.email} of excess?`
                                  )) return
                                  const r = await window.api.accountSetOverage(
                                    acc.credentials.accessToken,
                                    'DISABLED',
                                    acc.credentials?.region,
                                    acc.profileArn,
                                    acc.machineId,
                                    acc.credentials?.provider || acc.idp,
                                    acc.credentials?.authMethod,
                                    acc.id
                                  )
                                  if (r.success) {
                                    updateAccount(acc.id, {
                                      usage: {
                                        ...acc.usage,
                                        resourceDetail: { ...acc.usage?.resourceDetail, overageEnabled: false }
                                      }
                                    })
                                  } else {
                                    alert(isEn ? `Failed: ${r.error}` : `fail: ${r.error}`)
                                  }
                                }}
                                className="px-2 py-1 rounded text-[10px] bg-amber-500/15 text-amber-700 hover:bg-amber-500/25"
                                title={isEn ? 'Disable overage' : 'Close overage'}
                              >
                                <Ban className="h-3 w-3 inline mr-0.5" />
                                {isEn ? 'No-Overage' : 'Close excess'}
                              </button>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        </>
      )}

      {/* ===== Get link Tab ===== */}
      {activeTab === 'links' && (
        <>
          {/* Preflight Panel: Display Upgradeable / Cause of blocking */}
          {preflightReport.totalScanned > 0 && (
            <Card className={cn(
              preflightReport.eligible.length === 0 && 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/10'
            )}>
              <CardContent className="py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">
                    {isEn ? 'Pre-flight Check' : 'Upgrade preflight'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isEn
                      ? `Scanned ${preflightReport.totalScanned} accounts: ${preflightReport.eligible.length} eligible, ${preflightReport.blocked.length} blocked`
                      : `scanning ${preflightReport.totalScanned} accounts:${preflightReport.eligible.length} Upgradeable,${preflightReport.blocked.length} Not upgradeable`
                    }
                  </span>
                </div>

                {/* Blocked Classification Badge */}
                {preflightReport.blocked.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    {preflightReport.reasonBuckets['already-pro'] > 0 && (
                      <span className="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 inline-flex items-center gap-1">
                        <CheckCircle className="h-2.5 w-2.5" />
                        {isEn ? `Already subscribed: ${preflightReport.reasonBuckets['already-pro']}` : `Subscribed ${preflightReport.reasonBuckets['already-pro']}`}
                      </span>
                    )}
                    {preflightReport.reasonBuckets['no-token'] > 0 && (
                      <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground inline-flex items-center gap-1">
                        <XCircle className="h-2.5 w-2.5" />
                        {isEn ? `No token: ${preflightReport.reasonBuckets['no-token']}` : `none Token ${preflightReport.reasonBuckets['no-token']}`}
                      </span>
                    )}
                    {preflightReport.reasonBuckets['banned'] > 0 && (
                      <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                        <Ban className="h-2.5 w-2.5" />
                        {isEn ? `Banned: ${preflightReport.reasonBuckets['banned']}` : `Banned ${preflightReport.reasonBuckets['banned']}`}
                      </span>
                    )}
                    {preflightReport.reasonBuckets['cant-upgrade'] > 0 && (
                      <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {isEn ? `Can't upgrade: ${preflightReport.reasonBuckets['cant-upgrade']}` : `Not upgradeable ${preflightReport.reasonBuckets['cant-upgrade']}`}
                      </span>
                    )}
                    {preflightReport.reasonBuckets['unknown-status'] > 0 && (
                      <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 inline-flex items-center gap-1">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {isEn ? `Unknown status: ${preflightReport.reasonBuckets['unknown-status']}` : `Status unknown ${preflightReport.reasonBuckets['unknown-status']}`}
                      </span>
                    )}
                  </div>
                )}

                {preflightReport.eligible.length === 0 && preflightReport.totalScanned > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {isEn
                      ? 'No eligible accounts. Run "Check Accounts" on the accounts page first to get latest status.'
                      : 'There is no way to upgrade your account. It is recommended to first go to the account management page"Batch inspection"Get the latest status.'
                    }
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Plan selection */}
          <Card>
            <CardContent className="py-3 space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLoadPlans}
                  disabled={isLoadingPlans || upgradeableCount === 0}
                >
                  {isLoadingPlans ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  {isEn ? 'Load Plans' : 'Load plan'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {availablePlans.length > 0
                    ? (isEn ? `${availablePlans.length} plans available` : `Loaded ${availablePlans.length} plan`)
                    : (isEn ? 'Click to load available subscription plans' : 'Click to load available subscription plans')
                  }
                </span>
              </div>

              {availablePlans.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {availablePlans.map(plan => (
                    <button
                      key={plan.qSubscriptionType}
                      onClick={() => setSelectedPlanType(plan.qSubscriptionType)}
                      className={cn(
                        'px-3 py-1.5 rounded-md border text-xs font-medium transition-colors',
                        selectedPlanType === plan.qSubscriptionType
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/50'
                      )}
                    >
                      <div>{plan.description.title || plan.name}</div>
                      <div className="text-[10px] opacity-70">
                        ${plan.pricing.amount / 100}/{plan.description.billingInterval}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Action bar */}
          <Card>
            <CardContent className="py-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={handleBatchFetch}
                disabled={isFetching || upgradeableCount === 0 || !selectedPlanType}
              >
                {isFetching ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <CreditCard className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Fetch Links (${upgradeableCount})`
                  : `Get link (${upgradeableCount})`
                }
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setLinks([]); setSelectedLinkIds(new Set()) }}
                disabled={isFetching || links.length === 0}
                title={isEn ? 'Clear results' : 'Clear results'}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Clear' : 'Clear'}
              </Button>

              {/* Import external links in batches */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowImportDialog(true)}
                disabled={isFetching}
                title={isEn ? 'Import links from text (one per line)' : 'Batch import links from text (one per line)'}
              >
                <Upload className="h-4 w-4 mr-1" />
                {isEn ? 'Import' : 'Import link'}
              </Button>

              {/* Check link validity */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleValidateLinks}
                disabled={isFetching || isValidatingLinks || links.filter(l => l.status === 'success').length === 0}
                title={isEn ? 'Detect expired links (>15min old)' : 'Detect expired links (generating more than 15 minute)'}
              >
                {isValidatingLinks ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                {isEn ? 'Validate' : 'Test effectiveness'}
              </Button>

              {/* Delete failed/Expired — always show */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDeleteFailed}
                disabled={isFetching || links.filter(l => l.status === 'error' || l.status === 'expired').length === 0}
                title={isEn ? 'Remove failed and expired links' : 'Remove failed and expired links'}
                className={deleteAlsoAccount ? 'text-destructive hover:text-destructive hover:bg-destructive/10' : ''}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Remove Failed' : 'Clear failed'}
                {' '}({links.filter(l => l.status === 'error' || l.status === 'expired').length})
              </Button>
              {/* Check: Delete the account at the same time if the cleanup fails. */}
              <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer select-none" title={isEn ? 'Also permanently delete the accounts (for banned accounts cleanup)' : 'At the same time, these accounts will be permanently deleted (used to clean up banned accounts)'}>
                <input
                  type="checkbox"
                  checked={deleteAlsoAccount}
                  onChange={(e) => setDeleteAlsoAccount(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border"
                />
                {isEn ? 'Delete accounts' : 'Delete account continuously'}
              </label>

              {/* Multi-select auxiliary operation (displayed when only results are available) */}
              {links.length > 0 && (
                <>
                  <div className="w-px h-6 bg-border" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={invertSelection}
                    disabled={isFetching}
                    title={isEn ? 'Invert selection' : 'Counter-election'}
                  >
                    <Minus className="h-4 w-4 mr-1" />
                    {isEn ? 'Invert' : 'Counter-election'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearSelection}
                    disabled={isFetching || selectedLinkIds.size === 0}
                    title={isEn ? 'Clear selection' : 'Cancel multiple selections'}
                  >
                    <Square className="h-4 w-4 mr-1" />
                    {isEn ? 'Deselect' : 'Cancel multiple selections'}
                  </Button>

                  {/* Quick Selection: Select available links in batches by quantity from the top */}
                  <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-dashed">
                    <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">{isEn ? 'Quick pick' : 'Quick selection'}</span>
                    <input
                      type="number"
                      min={1}
                      value={quickPickCount}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        if (v > 0) setQuickPickCount(v)
                      }}
                      disabled={isFetching}
                      className="h-6 w-12 px-1 rounded border border-border bg-background text-[11px] text-center"
                      title={isEn ? 'Number of links to pick' : 'Quick selection quantity'}
                    />
                    <button
                      onClick={quickPickTop}
                      disabled={isFetching || successCount === 0}
                      className="text-[10px] px-1.5 py-0.5 rounded hover:bg-primary/15 text-primary disabled:opacity-40"
                      title={isEn ? `Select top ${quickPickCount} available links` : `Before selecting from the top ${quickPickCount} available links`}
                    >
                      {isEn ? 'Top' : 'forwardNindivual'}
                    </button>
                    <button
                      onClick={quickPickNext}
                      disabled={isFetching || successCount === 0}
                      className="text-[10px] px-1.5 py-0.5 rounded hover:bg-primary/15 text-primary disabled:opacity-40"
                      title={isEn ? 'Select next batch (continue from last pick)' : 'Select next batch (continue from last position)'}
                    >
                      {isEn ? 'Next' : 'next batch'}
                    </button>
                  </div>

                  {/* Quick selection by status */}
                  <div className="relative inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-dashed">
                    <span className="text-[10px] text-muted-foreground">{isEn ? 'Pick:' : 'choose:'}</span>
                    <button
                      className="text-[10px] px-1.5 py-0.5 rounded hover:bg-green-500/15 text-green-700 dark:text-green-300"
                      onClick={() => selectByStatus('success')}
                      disabled={isFetching}
                      title={isEn ? 'Add all "Success" to selection' : 'Bundle"success"Items added to the selection'}
                    >
                      ✓ {isEn ? 'Success' : 'success'} ({links.filter(l => l.status === 'success').length})
                    </button>
                    <button
                      className="text-[10px] px-1.5 py-0.5 rounded hover:bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      onClick={() => selectByStatus('expired')}
                      disabled={isFetching}
                      title={isEn ? 'Add all "Expired" to selection' : 'Bundle"Expired"Items added to the selection'}
                    >
                      ⚠ {isEn ? 'Expired' : 'Expired'} ({links.filter(l => l.status === 'expired').length})
                    </button>
                    <button
                      className="text-[10px] px-1.5 py-0.5 rounded hover:bg-red-500/15 text-red-700 dark:text-red-300"
                      onClick={() => selectByStatus('error')}
                      disabled={isFetching}
                      title={isEn ? 'Add all "Error" to selection' : 'Bundle"fail"Items added to the selection'}
                    >
                      ✗ {isEn ? 'Error' : 'fail'} ({links.filter(l => l.status === 'error').length})
                    </button>
                  </div>

                  {/* Batch delete selected */}
                  {selectedLinkIds.size > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBatchDelete}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      title={isEn ? `Delete ${selectedLinkIds.size} selected links` : `Delete selected ${selectedLinkIds.size} links`}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      {isEn ? `Delete Selected (${selectedLinkIds.size})` : `Remove selected (${selectedLinkIds.size})`}
                    </Button>
                  )}
                </>
              )}

              {/* Concurrency control */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">{isEn ? 'Concurrency:' : 'concurrent:'}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (val > 0) setConcurrency(val)
                  }}
                  disabled={isFetching}
                  className="h-7 w-14 px-1.5 rounded border border-border bg-background text-xs text-center"
                />
              </div>

              <div className="w-px h-6 bg-border" />

              {successCount > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBatchOpen('selected')}
                    disabled={selectedCount === 0}
                    title={isEn ? 'Open selected in incognito' : 'Open selected link incognito'}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {isEn ? `Open Selected (${selectedCount})` : `open selected (${selectedCount})`}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBatchOpen('all')}
                    title={isEn ? 'Open all in incognito' : 'Open all links without trace'}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {isEn ? `Open All (${successCount})` : `open all (${successCount})`}
                  </Button>

                  <div className="w-px h-6 bg-border" />

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('selected')}
                    disabled={selectedCount === 0}
                    title={isEn ? 'Copy selected links' : 'Copy selected link'}
                  >
                    <Copy className="h-4 w-4 mr-1" />
                    {isEn ? `Export Selected (${selectedCount})` : `Export selected (${selectedCount})`}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('all')}
                    title={isEn ? 'Copy all links' : 'Copy all links'}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    {isEn ? `Export All (${successCount})` : `Export all (${successCount})`}
                  </Button>
                </>
              )}

              {/* statistics */}
              {links.length > 0 && (
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  {successCount > 0 && (
                    <span className="flex items-center gap-1 text-green-600">
                      <CheckCircle className="h-3 w-3" /> {successCount}
                    </span>
                  )}
                  {errorCount > 0 && (
                    <span className="flex items-center gap-1 text-red-500">
                      <XCircle className="h-3 w-3" /> {errorCount}
                    </span>
                  )}
                  {isFetching && (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {links.filter(l => l.status === 'pending' || l.status === 'loading').length}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Linked list */}
          {links.length > 0 && (
            <Card>
              <CardContent className="py-2">
                {/* Header */}
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <button
                    onClick={toggleSelectAll}
                    className="flex-shrink-0"
                    disabled={links.length === 0}
                    title={
                      selectedLinkIds.size === links.length && links.length > 0
                        ? (isEn ? 'Deselect all' : 'Deselect all')
                        : (isEn ? 'Select all' : 'Select all')
                    }
                  >
                    {selectedLinkIds.size === links.length && links.length > 0 ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : selectedLinkIds.size > 0 ? (
                      <Minus className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : 'Mail'}</span>
                  <span className="w-20 text-center">{isEn ? 'Status' : 'state'}</span>
                  <span className="w-24 text-center">{isEn ? 'Actions' : 'operate'}</span>
                </div>

                {/* list */}
                <div className="max-h-[60vh] overflow-y-auto">
                  {links.map((link, idx) => (
                    <div
                      key={link.accountId}
                      className={cn(
                        "flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors",
                        selectedLinkIds.has(link.accountId) && 'bg-primary/5'
                      )}
                    >
                      {/* selection box — Any status is optional (facilitates batch deletion)/Retry failed items) */}
                      <button
                        onClick={() => toggleLinkSelection(link.accountId)}
                        className="flex-shrink-0"
                      >
                        {selectedLinkIds.has(link.accountId) ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>

                      {/* serial number */}
                      <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>

                      {/* Mail */}
                      <span className="flex-1 text-sm truncate" title={link.email}>
                        {link.email}
                      </span>

                      {/* state */}
                      <span className="w-20 flex justify-center">
                        {link.status === 'pending' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Pending' : 'Waiting'}</span>
                        )}
                        {link.status === 'loading' && (
                          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        )}
                        {link.status === 'success' && (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle className="h-4 w-4 text-green-500" />
                            {link.generatedAt && (
                              <span className="text-[9px] text-muted-foreground tabular-nums" title={isEn ? 'Minutes since generated' : 'Number of minutes since creation'}>
                                {Math.round((Date.now() - link.generatedAt) / 60000)}m
                              </span>
                            )}
                          </span>
                        )}
                        {link.status === 'expired' && (
                          <span className="inline-flex items-center gap-1 text-amber-600" title={isEn ? 'May have expired' : 'may have expired'}>
                            <AlertTriangle className="h-4 w-4" />
                            <span className="text-[9px]">{isEn ? 'Expired' : 'Expired'}</span>
                          </span>
                        )}
                        {link.status === 'error' && (
                          <span className="text-xs text-red-500 truncate" title={link.error}>
                            <XCircle className="h-4 w-4 inline" />
                          </span>
                        )}
                      </span>

                      {/* operate */}
                      <span className="w-24 flex justify-center gap-1">
                        {(link.status === 'success' || link.status === 'expired') && link.url && (
                          <>
                            <button
                              onClick={() => handleOpenLink(link.url!)}
                              className="p-1 rounded hover:bg-muted"
                              title={isEn ? 'Open in incognito' : 'Open without trace'}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleCopyLink(link.url!)}
                              className="p-1 rounded hover:bg-muted"
                              title={isEn ? 'Copy link' : 'Copy link'}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        {(link.status === 'expired' || link.status === 'error') && (
                          <button
                            onClick={() => void handleRegenerateLink(link.accountId)}
                            className="p-1 rounded hover:bg-primary/10 text-primary"
                            title={isEn ? 'Regenerate' : 'Regenerate'}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {link.status === 'error' && (
                          <span className="text-[10px] text-red-500 truncate max-w-[80px]" title={link.error}>
                            {link.error}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Empty state */}
          {links.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  {upgradeableCount > 0
                    ? (isEn
                        ? `${upgradeableCount} FREE accounts available for upgrade. Click "Fetch Links" to start.`
                        : `have ${upgradeableCount} indivual FREE Accounts can be upgraded. Click"Get link"start.`)
                    : (isEn
                        ? 'No FREE tier accounts found. Select accounts in the Accounts page first.'
                        : 'not found FREE account. Please select an account on the account management page first.')
                  }
                </p>
              </CardContent>
            </Card>
          )}

          {/* Batch import link dialog box */}
          <ImportLinksDialog
            open={showImportDialog}
            onClose={() => setShowImportDialog(false)}
            onImport={handleImportLinks}
            isEn={isEn}
          />
        </>
      )}
    </div>
  )
}

// ============ Batch import link dialog box ============

interface ImportLinksDialogProps {
  open: boolean
  onClose: () => void
  onImport: (text: string) => number
  isEn: boolean
}

function ImportLinksDialog({ open, onClose, onImport, isEn }: ImportLinksDialogProps): React.ReactNode {
  const [text, setText] = useState('')
  if (!open) return null

  const detectedCount = parseImportedLinks(text).length
  const handleConfirm = (): void => {
    const n = onImport(text)
    setText('')
    onClose()
    setTimeout(() => alert(isEn ? `Imported ${n} link(s)` : `Imported successfully ${n} links`), 0)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* title bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEn ? 'Import Links' : 'Batch import links'}</h2>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* content */}
        <div className="px-6 py-4 space-y-3 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            {isEn
              ? 'Paste links, one per line. Supports plain URLs or "email<sep>url" (sep = space / comma / tab / | / ----). URLs are auto-extracted; duplicates are skipped.'
              : 'One link per line. Support pure URL, or "email<delimiter>URL” (The delimiter can be space / comma / Tab / | / ----). automatic recognition URL, duplicate links will be skipped.'}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            autoFocus
            spellCheck={false}
            placeholder={'https://aws.amazon.com/...\nuser@mail.com  https://aws.amazon.com/...'}
            className="w-full rounded-lg border border-foreground/15 bg-[var(--glass-bg)] backdrop-blur-md px-3 py-2 text-sm font-mono resize-y focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30"
          />
          <p className="text-xs text-muted-foreground">
            {isEn ? `Detected ${detectedCount} valid link(s)` : `Recognized ${detectedCount} valid links`}
          </p>
        </div>

        {/* bottom button */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" onClick={onClose}>{isEn ? 'Cancel' : 'Cancel'}</Button>
          <Button disabled={detectedCount === 0} onClick={handleConfirm}>
            <Upload className="h-4 w-4 mr-2" />
            {isEn ? `Import (${detectedCount})` : `import (${detectedCount})`}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ============ Subscription management Tab: Batch cancellation + Bulk customs clearance for excess amount ============

type AccountType = ReturnType<typeof useAccountsStore.getState>['accounts'] extends Map<string, infer T> ? T : never

interface ManageSubscriptionsTabProps {
  getAllSubscribed: () => Array<AccountType | undefined>
  updateAccount: ReturnType<typeof useAccountsStore.getState>['updateAccount']
  concurrency: number
  isEn: boolean
}

function ManageSubscriptionsTab({ getAllSubscribed, updateAccount, concurrency, isEn }: ManageSubscriptionsTabProps): React.ReactNode {
  const subscribed = getAllSubscribed()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBatchOpening, setIsBatchOpening] = useState(false)
  const [isBatchDisablingOverage, setIsBatchDisablingOverage] = useState(false)

  const toggleSelect = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = (): void => {
    if (selectedIds.size === subscribed.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(subscribed.map((a) => a!.id)))
  }

  /** Open subscription portal in batches (for unsubscription) */
  const handleBatchOpenPortal = async (mode: 'selected' | 'all'): Promise<void> => {
    const targets = mode === 'selected'
      ? subscribed.filter((a) => a && selectedIds.has(a.id))
      : subscribed
    if (targets.length === 0) return
    if (!confirm(isEn
      ? `Open ${targets.length} subscription portal pages? (in browser incognito mode)`
      : `Open ${targets.length} Subscription portal page? (browser incognito mode)`
    )) return

    setIsBatchOpening(true)
    try {
      // Concurrency pool
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const idx = cursor++
          const acc = targets[idx]
          if (!acc) continue
          try {
            const r = await window.api.accountGetSubscriptionUrl(
              acc.credentials.accessToken,
              undefined,
              acc.credentials?.region,
              acc.profileArn,
              acc.machineId,
              acc.credentials?.provider || acc.idp,
              acc.credentials?.authMethod,
              acc.id
            )
            if (r.success && r.url) {
              await window.api.openSubscriptionWindow(r.url)
              // Leave between each 500ms, giving the browser time to respond
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
          } catch (err) {
            console.warn('Open portal failed for', acc.email, err)
          }
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
      await Promise.all(workers)
    } finally {
      setIsBatchOpening(false)
    }
  }

  /** Close excess in batches */
  const handleBatchDisableOverage = async (mode: 'selected' | 'all'): Promise<void> => {
    const targets = (mode === 'selected'
      ? subscribed.filter((a) => a && selectedIds.has(a.id))
      : subscribed
    ).filter((a) => a?.usage?.resourceDetail?.overageEnabled === true)
    if (targets.length === 0) {
      alert(isEn ? 'No accounts with overage enabled' : 'No excess account is opened')
      return
    }
    if (!confirm(isEn ? `Disable overage on ${targets.length} accounts?` : `closure ${targets.length} An account's overage limit?`)) return

    setIsBatchDisablingOverage(true)
    try {
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const idx = cursor++
          const acc = targets[idx]
          if (!acc) continue
          try {
            const r = await window.api.accountSetOverage(
              acc.credentials.accessToken,
              'DISABLED',
              acc.credentials?.region,
              acc.profileArn,
              acc.machineId,
              acc.credentials?.provider || acc.idp,
              acc.credentials?.authMethod,
              acc.id
            )
            if (r.success) {
              updateAccount(acc.id, {
                usage: {
                  ...acc.usage,
                  resourceDetail: { ...acc.usage?.resourceDetail, overageEnabled: false }
                }
              })
            }
          } catch (err) {
            console.warn('Disable overage failed for', acc.email, err)
          }
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
      await Promise.all(workers)
    } finally {
      setIsBatchDisablingOverage(false)
    }
  }

  if (subscribed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {isEn
              ? 'No subscribed accounts found. Run "Check Accounts" first to refresh status.'
              : 'No subscribed account found. Please first go to the account page"Batch inspection"Refresh status.'
            }
          </p>
        </CardContent>
      </Card>
    )
  }

  const selectedCount = selectedIds.size
  const overageEnabledCount = subscribed.filter((a) => a?.usage?.resourceDetail?.overageEnabled === true).length

  return (
    <>
      {/* illustrate */}
      <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/10">
        <CardContent className="py-3 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-medium">
              {isEn ? 'Subscription Lifecycle Management' : 'Subscription lifecycle management'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {isEn
              ? 'Bulk open subscription portals in browser (cancel/manage there), or bulk disable overage.'
              : 'Open subscription portal in bulk (cancel in browser/Management), or turn off excess in batches.'
            }
          </p>
        </CardContent>
      </Card>

      {/* Batch operation bar */}
      <Card>
        <CardContent className="py-3 flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() => handleBatchOpenPortal('selected')}
            disabled={isBatchOpening || selectedCount === 0}
          >
            {isBatchOpening ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ExternalLink className="h-4 w-4 mr-1" />}
            {isEn ? `Open Portal (Selected: ${selectedCount})` : `Open portal (selected ${selectedCount}）`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleBatchOpenPortal('all')}
            disabled={isBatchOpening}
          >
            <ExternalLink className="h-4 w-4 mr-1" />
            {isEn ? `Open All (${subscribed.length})` : `Open all (${subscribed.length})`}
          </Button>

          <div className="w-px h-6 bg-border" />

          <Button
            size="sm"
            variant="outline"
            onClick={() => handleBatchDisableOverage('selected')}
            disabled={isBatchDisablingOverage || selectedCount === 0}
          >
            {isBatchDisablingOverage ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Ban className="h-4 w-4 mr-1" />}
            {isEn ? `Disable Overage (Selected)` : 'Turn off excess (selected)'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleBatchDisableOverage('all')}
            disabled={isBatchDisablingOverage || overageEnabledCount === 0}
          >
            <Ban className="h-4 w-4 mr-1" />
            {isEn ? `Disable All Overage (${overageEnabledCount})` : `Close all excess (${overageEnabledCount})`}
          </Button>

          <span className="ml-auto text-xs text-muted-foreground">
            {selectedCount > 0
              ? (isEn ? `${selectedCount} of ${subscribed.length} selected` : `Selected ${selectedCount} / ${subscribed.length}`)
              : (isEn ? `${subscribed.length} subscribed accounts` : `${subscribed.length} subscribed accounts`)
            }
          </span>
        </CardContent>
      </Card>

      {/* Account list (multiple choices) */}
      <Card>
        <CardContent className="py-0 px-0">
          <div className="flex items-center gap-3 py-2 px-3 border-b text-xs font-medium text-muted-foreground bg-muted/30">
            <button onClick={toggleSelectAll} className="flex-shrink-0">
              {selectedIds.size === subscribed.length && subscribed.length > 0
                ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
                : selectedIds.size > 0
                  ? <Minus className="h-3.5 w-3.5 text-primary" />
                  : <Square className="h-3.5 w-3.5" />
              }
            </button>
            <span className="w-8 text-center">#</span>
            <span className="flex-1">{isEn ? 'Email' : 'Mail'}</span>
            <span className="w-28 text-center">{isEn ? 'Plan' : 'Subscription type'}</span>
            <span className="w-20 text-center">{isEn ? 'Days Left' : 'Days remaining'}</span>
            <span className="w-24 text-center">{isEn ? 'Overage' : 'excess status'}</span>
            <span className="w-32 text-center">{isEn ? 'Actions' : 'operate'}</span>
          </div>

          <SubscribedAccountsVirtualList
            subscribed={subscribed}
            selectedIds={selectedIds}
            toggleSelect={toggleSelect}
            updateAccount={updateAccount}
            isEn={isEn}
          />

          {/* Taking up space to prevent the following dead code Deleted by mistake (actually rendered SubscribedAccountsVirtualList） */}
          {false && (
            <div className="max-h-[60vh] overflow-y-auto">
              {subscribed.map((acc, idx) => {
                if (!acc) return null
                const planName = acc.subscription?.title || acc.subscription?.type || '-'
                const daysLeft = acc.subscription?.daysRemaining
                const overageEnabled = acc.usage?.resourceDetail?.overageEnabled === true
                const overageCapable = acc.subscription?.overageCapability === 'OVERAGE_CAPABLE'
                const selected = selectedIds.has(acc.id)

                return (
                  <div
                    key={acc.id}
                    className={cn(
                      'flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs transition-colors',
                      selected && 'bg-primary/5'
                    )}
                  >
                    <button onClick={() => toggleSelect(acc.id)} className="flex-shrink-0">
                    {selected
                      ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
                      : <Square className="h-3.5 w-3.5" />
                    }
                  </button>
                  <span className="w-8 text-center text-muted-foreground">{idx + 1}</span>
                  <span className="flex-1 truncate" title={acc.email}>{acc.email}</span>
                  <span className="w-28 text-center">
                    <span className={cn(
                      'inline-block px-2 py-0.5 rounded text-[10px] font-medium',
                      planName.toUpperCase().includes('PRO+') || planName.toUpperCase().includes('PRO_PLUS')
                        ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
                        : planName.toUpperCase().includes('POWER')
                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          : planName.toUpperCase().includes('PRO')
                            ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                            : 'bg-muted text-muted-foreground'
                    )}>
                      {planName}
                    </span>
                  </span>
                  <span className="w-20 text-center text-muted-foreground">
                    {daysLeft != null
                      ? <span className={cn(
                          daysLeft <= 3 ? 'text-red-500' : daysLeft <= 7 ? 'text-amber-500' : ''
                        )}>{isEn ? `${daysLeft}d` : `${daysLeft} sky`}</span>
                      : '-'
                    }
                  </span>
                  <span className="w-24 text-center">
                    {overageEnabled
                      ? <span className="text-green-600 text-[10px]">{isEn ? 'ENABLED' : 'Already turned on'}</span>
                      : overageCapable
                        ? <span className="text-muted-foreground text-[10px]">{isEn ? 'DISABLED' : 'Not turned on'}</span>
                        : <span className="text-muted-foreground text-[10px]">-</span>
                    }
                  </span>
                  <span className="w-32 flex justify-center gap-1">
                    <button
                      onClick={async () => {
                        const r = await window.api.accountGetSubscriptionUrl(
                          acc.credentials.accessToken,
                          undefined,
                          acc.credentials?.region,
                          acc.profileArn,
                          acc.machineId,
                          acc.credentials?.provider || acc.idp,
                          acc.credentials?.authMethod,
                          acc.id
                        )
                        if (r.success && r.url) {
                          await window.api.openSubscriptionWindow(r.url)
                        } else {
                          alert(isEn ? `Failed: ${r.error}` : `fail: ${r.error}`)
                        }
                      }}
                      className="px-2 py-1 rounded text-[10px] bg-primary/10 text-primary hover:bg-primary/20"
                      title={isEn ? 'Open subscription portal' : 'Open subscription portal'}
                    >
                      <ExternalLink className="h-3 w-3 inline mr-1" />
                      {isEn ? 'Manage' : 'manage'}
                    </button>
                  </span>
                </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}

/**
 * Subscription account virtualization list (to avoid lags when processing thousands of subscribed accounts)
 */
interface SubscribedListProps {
  subscribed: Array<AccountType | undefined>
  selectedIds: Set<string>
  toggleSelect: (id: string) => void
  updateAccount: ReturnType<typeof useAccountsStore.getState>['updateAccount']
  isEn: boolean
}

function SubscribedAccountsVirtualList({ subscribed, selectedIds, toggleSelect, updateAccount, isEn }: SubscribedListProps): React.ReactNode {
  void updateAccount  // Not used yet (preserve parameter alignment API）
  const parentRef = useRef<HTMLDivElement>(null)
  const ROW_HEIGHT = 44
  const validItems = useMemo(() => subscribed.filter((a): a is AccountType => !!a), [subscribed])

  const virtualizer = useVirtualizer({
    count: validItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  // less than 50 Render directly at runtime
  if (validItems.length < 50) {
    return (
      <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
        {validItems.map((acc, idx) => (
          <SubscribedRow
            key={acc.id}
            acc={acc}
            idx={idx}
            selected={selectedIds.has(acc.id)}
            onToggleSelect={() => toggleSelect(acc.id)}
            isEn={isEn}
          />
        ))}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div ref={parentRef} className="max-h-[60vh] overflow-y-auto" style={{ contain: 'strict' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((virtualRow) => {
          const acc = validItems[virtualRow.index]
          if (!acc) return null
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <SubscribedRow
                acc={acc}
                idx={virtualRow.index}
                selected={selectedIds.has(acc.id)}
                onToggleSelect={() => toggleSelect(acc.id)}
                isEn={isEn}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SubscribedRow({ acc, idx, selected, onToggleSelect, isEn }: {
  acc: AccountType
  idx: number
  selected: boolean
  onToggleSelect: () => void
  isEn: boolean
}): React.ReactNode {
  const planName = acc.subscription?.title || acc.subscription?.type || '-'
  const daysLeft = acc.subscription?.daysRemaining
  const overageEnabled = acc.usage?.resourceDetail?.overageEnabled === true
  const overageCapable = acc.subscription?.overageCapability === 'OVERAGE_CAPABLE'

  return (
    <div
      className={cn(
        'flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs transition-colors',
        selected && 'bg-primary/5'
      )}
    >
      <button onClick={onToggleSelect} className="flex-shrink-0">
        {selected
          ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
          : <Square className="h-3.5 w-3.5" />
        }
      </button>
      <span className="w-8 text-center text-muted-foreground">{idx + 1}</span>
      <span className="flex-1 truncate" title={acc.email}>{acc.email}</span>
      <span className="w-28 text-center">
        <span className={cn(
          'inline-block px-2 py-0.5 rounded text-[10px] font-medium',
          planName.toUpperCase().includes('PRO+') || planName.toUpperCase().includes('PRO_PLUS')
            ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
            : planName.toUpperCase().includes('POWER')
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : planName.toUpperCase().includes('PRO')
                ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                : 'bg-muted text-muted-foreground'
        )}>{planName}</span>
      </span>
      <span className="w-20 text-center text-muted-foreground">
        {daysLeft != null
          ? <span className={cn(daysLeft <= 3 ? 'text-red-500' : daysLeft <= 7 ? 'text-amber-500' : '')}>{isEn ? `${daysLeft}d` : `${daysLeft} sky`}</span>
          : '-'
        }
      </span>
      <span className="w-24 text-center">
        {overageEnabled
          ? <span className="text-green-600 text-[10px]">{isEn ? 'ENABLED' : 'Already turned on'}</span>
          : overageCapable
            ? <span className="text-muted-foreground text-[10px]">{isEn ? 'DISABLED' : 'Not turned on'}</span>
            : <span className="text-muted-foreground text-[10px]">-</span>
        }
      </span>
      <span className="w-32 flex justify-center gap-1">
        <button
          onClick={async () => {
            const r = await window.api.accountGetSubscriptionUrl(
              acc.credentials.accessToken,
              undefined,
              acc.credentials?.region,
              acc.profileArn,
              acc.machineId,
              acc.credentials?.provider || acc.idp,
              acc.credentials?.authMethod,
              acc.id
            )
            if (r.success && r.url) {
              await window.api.openSubscriptionWindow(r.url)
            } else {
              alert(isEn ? `Failed: ${r.error}` : `fail: ${r.error}`)
            }
          }}
          className="px-2 py-1 rounded text-[10px] bg-primary/10 text-primary hover:bg-primary/20"
          title={isEn ? 'Open subscription portal' : 'Open subscription portal'}
        >
          <ExternalLink className="h-3 w-3 inline mr-1" />
          {isEn ? 'Manage' : 'manage'}
        </button>
      </span>
    </div>
  )
}
