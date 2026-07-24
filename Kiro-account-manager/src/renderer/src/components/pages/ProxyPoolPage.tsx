import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Network, Plus, Trash2, RefreshCw, Power, PowerOff, Upload, CheckCircle2,
  XCircle, Loader2, Globe, Clock, Activity, Settings2, Copy, FileText,
  Link2, Users, Shuffle, Unlink, Stethoscope, Pencil
} from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge } from '../ui'
import { cn } from '@/lib/utils'
import type { ProxyEntry, ProxyPoolStrategy } from '@/types/proxy'
import { IP_DETECT_ENDPOINTS } from '@/types/proxy'

const STRATEGY_OPTIONS: { value: ProxyPoolStrategy; label: string; labelEn: string; desc: string; descEn: string }[] = [
  { value: 'round_robin', label: 'polling', labelEn: 'Round Robin', desc: 'Use each proxy in turn', descEn: 'Use each proxy in sequence' },
  { value: 'random', label: 'random', labelEn: 'Random', desc: 'randomly selected', descEn: 'Pick randomly' },
  { value: 'least_used', label: 'least used', labelEn: 'Least Used', desc: 'Priority will be given to those used less frequently', descEn: 'Prefer proxies used less' },
  { value: 'fastest', label: 'fastest first', labelEn: 'Fastest', desc: 'in ascending order of latency', descEn: 'Sort by latency asc' }
]

interface ChainDiag {
  upstreamReachable: boolean; upstreamError?: string; upstreamRtMs?: number
  targetReachable: boolean; targetError?: string; targetRtMs?: number
  targetStatus?: number; targetStatusText?: string; targetBodySnippet?: string
  endToEndOk?: boolean; endToEndError?: string; endToEndRtMs?: number
}

function ChainDiagnosisCard({
  diag,
  isEn
}: {
  diag: { targetUrl: string; success: boolean; error?: string; diagnose?: ChainDiag }
  isEn: boolean
}): React.ReactNode {
  if (!diag.success || !diag.diagnose) {
    return (
      <div className="mt-2 text-[11px] rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 px-2 py-1.5">
        {isEn ? 'Diagnose failed: ' : 'Diagnosis failed:'}{diag.error || 'unknown error'}
      </div>
    )
  }
  const d = diag.diagnose
  const Row = ({ ok, label, rt, err }: { ok: boolean; label: string; rt?: number; err?: string }): React.ReactNode => (
    <div className="flex items-start gap-2 text-[11px]">
      <span className={cn('mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold',
        ok ? 'bg-green-500/20 text-green-600 dark:text-green-400' : 'bg-red-500/20 text-red-600 dark:text-red-400')}>
        {ok ? '✓' : '✗'}
      </span>
      <span className="flex-1">
        <span className="text-foreground">{label}</span>
        {rt !== undefined && <span className="ml-1 text-muted-foreground font-mono">{rt}ms</span>}
        {err && <div className="mt-0.5 text-red-600 dark:text-red-400 break-all">{err}</div>}
      </span>
    </div>
  )
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-border bg-card/50 px-3 py-2">
      <div className="text-[10px] text-muted-foreground font-mono truncate">
        target: {diag.targetUrl.replace(/:([^:@/]+)@/, ':***@')}
      </div>
      <Row
        ok={d.upstreamReachable}
        label={isEn ? 'A) Upstream TCP reachable' : 'A) upstream transfer TCP Reachable'}
        rt={d.upstreamRtMs}
        err={d.upstreamError}
      />
      <Row
        ok={d.targetReachable}
        label={isEn ? 'B) Via upstream → target proxy entry' : 'B) via upstream → Target proxy entry'}
        rt={d.targetRtMs}
        err={d.targetError}
      />
      <Row
        ok={d.endToEndOk === true}
        label={isEn
          ? `C) End-to-end CONNECT (status ${d.targetStatus ?? '?'} ${d.targetStatusText ?? ''})`.trim()
          : `C) end-to-end CONNECT(state ${d.targetStatus ?? '?'} ${d.targetStatusText ?? ''}）`.trim()}
        rt={d.endToEndRtMs}
        err={d.endToEndError}
      />
      {d.targetBodySnippet && (
        <div className="mt-1 text-[10px] text-muted-foreground font-mono break-all">
          body: {d.targetBodySnippet.slice(0, 160)}
        </div>
      )}
    </div>
  )
}

interface PoolHealthStats {
  total: number
  enabled: number
  alive: number
  slow: number
  dead: number
  untested: number
  testing: number
  totalUsed: number
  totalFailed: number
  totalSuccess: number
  successRate: number | null
  avgLatencyMs: number | null
  topUsed: Array<{ id: string; label: string; used: number; failed: number; success: number; rate: number | null; status: ProxyEntry['status'] }>
}

/** Aggregate the agent pool into several key indicators in real time to provide"health board"use */
function computePoolHealth(proxies: ProxyEntry[]): PoolHealthStats {
  const stats: PoolHealthStats = {
    total: proxies.length,
    enabled: 0, alive: 0, slow: 0, dead: 0, untested: 0, testing: 0,
    totalUsed: 0, totalFailed: 0, totalSuccess: 0,
    successRate: null,
    avgLatencyMs: null,
    topUsed: []
  }
  let latencySum = 0
  let latencyCount = 0
  for (const p of proxies) {
    if (p.enabled) stats.enabled++
    if (p.status === 'alive') stats.alive++
    else if (p.status === 'slow') stats.slow++
    else if (p.status === 'dead') stats.dead++
    else if (p.status === 'untested') stats.untested++
    else if (p.status === 'testing') stats.testing++
    stats.totalUsed += p.usedCount
    stats.totalFailed += p.failCount
    if (p.latencyMs && (p.status === 'alive' || p.status === 'slow')) {
      latencySum += p.latencyMs
      latencyCount++
    }
  }
  stats.totalSuccess = Math.max(0, stats.totalUsed - stats.totalFailed)
  stats.successRate = stats.totalUsed > 0 ? stats.totalSuccess / stats.totalUsed : null
  stats.avgLatencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null
  stats.topUsed = proxies
    .slice()
    .filter((p) => p.usedCount > 0)
    .sort((a, b) => b.usedCount - a.usedCount)
    .slice(0, 5)
    .map((p) => {
      const success = Math.max(0, p.usedCount - p.failCount)
      return {
        id: p.id,
        label: p.label || `${p.protocol}://${p.host}:${p.port}`,
        used: p.usedCount,
        failed: p.failCount,
        success,
        rate: p.usedCount > 0 ? success / p.usedCount : null,
        status: p.status
      }
    })
  return stats
}

function StatTile({
  label, value, sub, tone
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'default' | 'green' | 'amber' | 'red' | 'blue'
}): React.ReactNode {
  const toneCls = tone === 'green' ? 'text-green-600 dark:text-green-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'red' ? 'text-red-600 dark:text-red-400'
    : tone === 'blue' ? 'text-blue-600 dark:text-blue-400'
    : 'text-foreground'
  return (
    <div className="rounded-lg border border-border bg-card/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', toneCls)}>{value}</div>
      {sub !== undefined && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function HealthDashboard({ stats, isEn }: { stats: PoolHealthStats; isEn: boolean }): React.ReactNode {
  if (stats.total === 0) return null
  const availabilityRate = stats.total > 0 ? (stats.alive + stats.slow) / stats.total : 0
  const successPct = stats.successRate !== null ? Math.round(stats.successRate * 100) : null
  const successTone: 'green' | 'amber' | 'red' | 'default' = successPct === null ? 'default'
    : successPct >= 80 ? 'green' : successPct >= 50 ? 'amber' : 'red'
  const availTone: 'green' | 'amber' | 'red' | 'default' = stats.total === 0 ? 'default'
    : availabilityRate >= 0.7 ? 'green' : availabilityRate >= 0.3 ? 'amber' : 'red'
  return (
    <Card className="hover-lift">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          {isEn ? 'Pool Health Dashboard' : 'Agent pool health dashboard'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <StatTile
            label={isEn ? 'Total / Enabled' : 'total / Enabled'}
            value={<>{stats.total}<span className="text-muted-foreground text-base"> / {stats.enabled}</span></>}
          />
          <StatTile
            label={isEn ? 'Availability' : 'Availability'}
            value={`${Math.round(availabilityRate * 100)}%`}
            sub={`${stats.alive + stats.slow} ${isEn ? 'alive' : 'Available'}`}
            tone={availTone}
          />
          <StatTile
            label={isEn ? 'Success Rate' : 'success rate'}
            value={successPct !== null ? `${successPct}%` : '—'}
            sub={`${stats.totalSuccess} / ${stats.totalUsed}`}
            tone={successTone}
          />
          <StatTile
            label={isEn ? 'Avg Latency' : 'average delay'}
            value={stats.avgLatencyMs !== null ? `${stats.avgLatencyMs}ms` : '—'}
            tone="blue"
          />
          <StatTile
            label={isEn ? 'Dead' : 'Invalid'}
            value={stats.dead}
            tone={stats.dead > 0 ? 'red' : 'default'}
          />
          <StatTile
            label={isEn ? 'Untested' : 'Not tested'}
            value={stats.untested + stats.testing}
            tone={stats.untested > 0 ? 'amber' : 'default'}
          />
        </div>

        {stats.topUsed.length > 0 && (
          <div>
            <div className="mb-2 text-xs text-muted-foreground">
              {isEn ? `Top ${stats.topUsed.length} most used proxies` : `Amount of commitment Top ${stats.topUsed.length}`}
            </div>
            <div className="space-y-1.5">
              {stats.topUsed.map((p) => {
                const rate = p.rate !== null ? Math.round(p.rate * 100) : null
                const ratePct = p.rate !== null ? p.rate * 100 : 0
                const barTone = rate === null ? 'bg-muted-foreground/30'
                  : rate >= 80 ? 'bg-green-500'
                  : rate >= 50 ? 'bg-amber-500' : 'bg-red-500'
                return (
                  <div key={p.id} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <StatusBadge status={p.status} />
                        <span className="font-mono text-[11px] truncate">{p.label}</span>
                      </div>
                      <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {p.success}/{p.used}
                        {rate !== null && <span className="ml-1.5 font-medium text-foreground">{rate}%</span>}
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={cn('h-full transition-all', barTone)} style={{ width: `${ratePct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status, latency }: { status: ProxyEntry['status']; latency?: number }): React.ReactNode {
  const cfg = {
    untested: { color: 'bg-muted text-muted-foreground', label: 'Not tested', labelEn: 'Untested' },
    testing: { color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', label: 'Under test', labelEn: 'Testing' },
    alive: { color: 'bg-green-500/15 text-green-600 dark:text-green-400', label: 'Available', labelEn: 'Alive' },
    slow: { color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: 'slower', labelEn: 'Slow' },
    dead: { color: 'bg-red-500/15 text-red-600 dark:text-red-400', label: 'Invalid', labelEn: 'Dead' }
  }[status]

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium', cfg.color)}>
      {status === 'testing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'alive' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'slow' && <Activity className="h-3 w-3" />}
      {status === 'dead' && <XCircle className="h-3 w-3" />}
      <span>{cfg.label}</span>
      {latency !== undefined && (status === 'alive' || status === 'slow') && (
        <span className="font-mono opacity-70">{latency}ms</span>
      )}
    </span>
  )
}

export function ProxyPoolPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const {
    proxyPool,
    proxyPoolConfig,
    addProxy,
    importProxies,
    removeProxy,
    removeProxies,
    toggleProxyEnabled,
    updateProxy,
    validateProxy,
    validateProxiesBatch,
    clearProxyPool,
    setProxyPoolConfig,
    accounts,
    accountProxyBindings,
    unbindAccountFromProxy,
    clearAccountProxyBindings,
    autoDistributeAccountsToProxies
  } = useAccountsStore()

  const [singleInput, setSingleInput] = useState('')
  const [bulkInput, setBulkInput] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // search / filter(v1.8 Extension: protocol / Enabled status / Delay / Last verification time + full text)
  const [filterText, setFilterText] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | ProxyEntry['status']>('all')
  const [filterProtocol, setFilterProtocol] = useState<'all' | ProxyEntry['protocol']>('all')
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [filterLatency, setFilterLatency] = useState<'all' | 'fast' | 'medium' | 'slow' | 'unknown'>('all')
  const [filterTestedWithin, setFilterTestedWithin] = useState<'all' | '1h' | '1d' | '7d' | 'never'>('all')
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)
  const [isValidatingAll, setIsValidatingAll] = useState(false)
  const [testConcurrency, setTestConcurrency] = useState(10)
  // Anti-generation bucketing: Number of accounts carried by each agent (0 = divided equally)
  const [accountsPerProxy, setAccountsPerProxy] = useState<number>(5)
  const [bindingPanelExpanded, setBindingPanelExpanded] = useState(false)
  // Agent chain diagnostic status
  const [chainDiagnosing, setChainDiagnosing] = useState(false)
  const [chainDiagnose, setChainDiagnose] = useState<{
    targetUrl: string
    success: boolean
    error?: string
    diagnose?: {
      upstreamReachable: boolean; upstreamError?: string; upstreamRtMs?: number
      targetReachable: boolean; targetError?: string; targetRtMs?: number
      targetStatus?: number; targetStatusText?: string; targetBodySnippet?: string
      endToEndOk?: boolean; endToEndError?: string; endToEndRtMs?: number
    }
  } | null>(null)

  // Use the first one in the pool enabled agent as the diagnostic target; if none, use any first
  const runChainDiagnose = useCallback(async () => {
    const upstream = proxyPoolConfig.upstreamProxy?.trim()
    if (!upstream) return
    const candidates = Array.from(proxyPool.values())
    const target = candidates.find((p) => p.enabled) || candidates[0]
    if (!target) return
    setChainDiagnosing(true)
    setChainDiagnose(null)
    try {
      const res = await window.api.proxyPoolDiagnoseChain({
        targetUrl: target.url,
        upstreamProxy: upstream
      })
      setChainDiagnose({ targetUrl: target.url, ...res })
    } catch (err) {
      setChainDiagnose({
        targetUrl: target.url,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChainDiagnosing(false)
    }
  }, [proxyPool, proxyPoolConfig.upstreamProxy])

  const proxies = useMemo(() => Array.from(proxyPool.values()), [proxyPool])
  const poolHealth = useMemo(() => computePoolHealth(proxies), [proxies])

  // Anti-generation bucketing: current account-Agent binding relationship
  const bindingStats = useMemo(() => {
    const allAccounts = Array.from(accounts.values())
    const totalActive = allAccounts.filter((a) => a.status === 'active').length
    const boundCount = Object.keys(accountProxyBindings).filter(
      (aid) => accounts.has(aid)
    ).length
    const aliveProxies = proxies.filter((p) => p.enabled && p.status !== 'dead')
    // Number of accounts carried by each agent
    const perProxy: Record<string, number> = {}
    for (const [aid, pid] of Object.entries(accountProxyBindings)) {
      if (!accounts.has(aid)) continue
      perProxy[pid] = (perProxy[pid] || 0) + 1
    }
    // Risk point: Number of single agent accounts > Recommended threshold (default 5）
    const overloadedProxies = Object.entries(perProxy)
      .filter(([, c]) => c > 10)
      .map(([pid, c]) => ({ pid, count: c, proxy: proxyPool.get(pid) }))
    return {
      totalActive,
      boundCount,
      unboundCount: totalActive - boundCount,
      aliveProxyCount: aliveProxies.length,
      perProxy,
      overloadedProxies
    }
  }, [accounts, accountProxyBindings, proxies, proxyPool])

  // Backstage scheduled verification
  const lastAutoValidateRef = useRef(0)
  useEffect(() => {
    const intervalMin = proxyPoolConfig.autoValidateIntervalMin
    if (!intervalMin || intervalMin <= 0) return

    const tick = (): void => {
      const now = Date.now()
      if (now - lastAutoValidateRef.current < intervalMin * 60_000) return
      const enabledIds = Array.from(proxyPool.values())
        .filter((p) => p.enabled)
        .map((p) => p.id)
      if (enabledIds.length === 0) return
      lastAutoValidateRef.current = now
      console.log(`[ProxyPool] Auto-validate ${enabledIds.length} proxies`)
      void validateProxiesBatch(enabledIds, proxyPoolConfig.autoValidateConcurrency || 5)
    }

    // Check every minute
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [proxyPoolConfig.autoValidateIntervalMin, proxyPoolConfig.autoValidateConcurrency, proxyPool, validateProxiesBatch])

  const handleAutoDistribute = useCallback((onlyUnbound: boolean) => {
    if (bindingStats.aliveProxyCount === 0) {
      alert(isEn ? 'No alive proxies. Validate proxies first.' : 'There is no available proxy, please activate the proxy first.')
      return
    }
    const activeAccountIds = Array.from(accounts.values())
      .filter((a) => a.status === 'active')
      .map((a) => a.id)
    if (activeAccountIds.length === 0) {
      alert(isEn ? 'No active accounts.' : 'No account available')
      return
    }
    const result = autoDistributeAccountsToProxies({
      accountsPerProxy,
      onlyUnbound,
      accountIds: activeAccountIds
    })
    alert(isEn
      ? `Distributed ${result.distributed} accounts, skipped ${result.skipped}`
      : `assigned ${result.distributed} account, skip ${result.skipped}`
    )
  }, [accounts, accountsPerProxy, autoDistributeAccountsToProxies, bindingStats.aliveProxyCount, isEn])

  const stats = useMemo(() => {
    let alive = 0, dead = 0, slow = 0, untested = 0, enabled = 0
    for (const p of proxies) {
      if (p.enabled) enabled++
      if (p.status === 'alive') alive++
      else if (p.status === 'dead') dead++
      else if (p.status === 'slow') slow++
      else if (p.status === 'untested') untested++
    }
    return { total: proxies.length, alive, dead, slow, untested, enabled }
  }, [proxies])

  // v1.8 Upgraded version of filtering: full text matching (any field fragment can be searched)+ Multi-dimensional filtering
  const filtered = useMemo(() => {
    const now = Date.now()
    const HOUR = 60 * 60 * 1000
    const DAY = 24 * HOUR
    return proxies.filter(p => {
      // Status filtering
      if (filterStatus !== 'all' && p.status !== filterStatus) return false
      // Protocol filtering
      if (filterProtocol !== 'all' && p.protocol !== filterProtocol) return false
      // Enable status filtering
      if (filterEnabled === 'enabled' && !p.enabled) return false
      if (filterEnabled === 'disabled' && p.enabled) return false
      // Delay range filtering
      if (filterLatency !== 'all') {
        const lat = p.latencyMs
        if (filterLatency === 'unknown') {
          if (typeof lat === 'number') return false
        } else if (typeof lat !== 'number') {
          return false
        } else {
          if (filterLatency === 'fast' && lat >= 200) return false
          if (filterLatency === 'medium' && (lat < 200 || lat >= 1000)) return false
          if (filterLatency === 'slow' && lat < 1000) return false
        }
      }
      // Last verification time filter
      if (filterTestedWithin !== 'all') {
        if (filterTestedWithin === 'never') {
          if (p.lastTestedAt) return false
        } else if (!p.lastTestedAt) {
          return false
        } else {
          const diff = now - p.lastTestedAt
          if (filterTestedWithin === '1h' && diff > HOUR) return false
          if (filterTestedWithin === '1d' && diff > DAY) return false
          if (filterTestedWithin === '7d' && diff > 7 * DAY) return false
        }
      }
      // Full text search (host / port / protocol / username / label / lastBoundEmail / url / tags）
      if (filterText) {
        const q = filterText.toLowerCase().trim()
        const haystack = [
          p.host,
          String(p.port),
          p.protocol,
          p.username || '',
          p.label || '',
          p.lastBoundEmail || '',
          p.url || '',
          (p.tags || []).join(' '),
          p.source || ''
        ].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [proxies, filterText, filterStatus, filterProtocol, filterEnabled, filterLatency, filterTestedWithin])

  // Applied filter count (used in UI show"Advanced search"badge)
  const activeAdvancedFilterCount = useMemo(() => {
    let n = 0
    if (filterProtocol !== 'all') n++
    if (filterEnabled !== 'all') n++
    if (filterLatency !== 'all') n++
    if (filterTestedWithin !== 'all') n++
    return n
  }, [filterProtocol, filterEnabled, filterLatency, filterTestedWithin])

  const clearAdvancedFilters = useCallback(() => {
    setFilterProtocol('all')
    setFilterEnabled('all')
    setFilterLatency('all')
    setFilterTestedWithin('all')
  }, [])

  const handleAddSingle = useCallback(() => {
    if (!singleInput.trim()) return
    const id = addProxy(singleInput.trim())
    if (id) {
      setSingleInput('')
    } else {
      alert(isEn ? 'Invalid proxy URL or duplicate' : 'acting URL Invalid or duplicate')
    }
  }, [singleInput, addProxy, isEn])

  const handleImport = useCallback(() => {
    if (!bulkInput.trim()) return
    const result = importProxies(bulkInput)
    alert(isEn
      ? `Imported: added ${result.added}, skipped ${result.skipped}, failed ${result.failed}`
      : `Import completed: new ${result.added},jump over ${result.skipped},fail ${result.failed}`
    )
    setBulkInput('')
    setBulkOpen(false)
  }, [bulkInput, importProxies, isEn])

  const handleValidateAll = useCallback(async () => {
    const ids = filtered.map(p => p.id)
    if (ids.length === 0) return
    setIsValidatingAll(true)
    try {
      await validateProxiesBatch(ids, testConcurrency)
    } finally {
      setIsValidatingAll(false)
    }
  }, [filtered, validateProxiesBatch, testConcurrency])

  const handleValidateSelected = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setIsValidatingAll(true)
    try {
      await validateProxiesBatch(ids, testConcurrency)
    } finally {
      setIsValidatingAll(false)
    }
  }, [selectedIds, validateProxiesBatch, testConcurrency])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    if (!confirm(isEn ? `Delete ${selectedIds.size} proxies?` : `Confirm deletion ${selectedIds.size} An agent?`)) return
    removeProxies(Array.from(selectedIds))
    setSelectedIds(new Set())
  }, [selectedIds, removeProxies, isEn])

  const handleRemoveDead = useCallback(() => {
    const deadIds = proxies.filter(p => p.status === 'dead').map(p => p.id)
    if (deadIds.length === 0) return
    if (!confirm(isEn ? `Remove ${deadIds.length} dead proxies?` : `Confirm removal ${deadIds.length} A failed agent?`)) return
    removeProxies(deadIds)
  }, [proxies, removeProxies, isEn])

  const toggleSelect = (id: string): void => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(p => p.id)))
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-cyan-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-cyan-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-cyan-500 shadow-lg shadow-cyan-500/25">
            <Network className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-cyan-600 dark:text-cyan-400">
              {isEn ? 'Proxy Pool' : 'proxy pool'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'IP rotation pool for registration tasks. Reduces association/risk control on batch sign-ups.'
                : 'Register batch tasks IP Rotation pool. Lower the same IP Risk control associated with multiple accounts.'
              }
            </p>
          </div>
        </div>
      </div>

      {/* Health Dashboard: Pool Overview + Top Amount of commitment */}
      <HealthDashboard stats={poolHealth} isEn={isEn} />

      {/* Pool main switch + Scheduling strategy */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            {isEn ? 'Pool Configuration' : 'Pool configuration'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* main switch */}
          <div className="flex items-center gap-3">
            <Switch
              checked={proxyPoolConfig.enabled}
              onCheckedChange={(v) => setProxyPoolConfig({ enabled: v })}
            />
            <div>
              <Label className="cursor-pointer text-sm">
                {isEn ? 'Enable proxy pool for registration' : 'Enable proxy pool for registration process'}
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {isEn
                  ? 'When enabled, each registration task picks an available proxy by the strategy below.'
                  : 'After turning on, each registration task will automatically select an available agent according to the policy below.'
                }
              </p>
            </div>
          </div>

          {/* Scheduling strategy */}
          <div className="space-y-2">
            <Label className="text-xs">{isEn ? 'Selection Strategy' : 'Scheduling strategy'}</Label>
            <div className="flex flex-wrap gap-2">
              {STRATEGY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setProxyPoolConfig({ strategy: opt.value })}
                  className={cn(
                    'px-3 py-1.5 rounded-md border text-xs transition-colors',
                    proxyPoolConfig.strategy === opt.value
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  )}
                  title={isEn ? opt.descEn : opt.desc}
                >
                  {isEn ? opt.labelEn : opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Automatically deactivate + failure threshold + test URL */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
            <div className="flex items-center gap-2">
              <Switch
                checked={proxyPoolConfig.autoDisableDead}
                onCheckedChange={(v) => setProxyPoolConfig({ autoDisableDead: v })}
              />
              <Label className="text-xs cursor-pointer">
                {isEn ? 'Auto-disable on failure' : 'Automatically deactivate on failure'}
              </Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'Failure threshold' : 'failure threshold'}</Label>
              <Input
                type="number" min={1} max={20}
                value={proxyPoolConfig.failureThreshold}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setProxyPoolConfig({ failureThreshold: v })
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'IP Detection Endpoint' : 'IP Detection endpoints'}</Label>
              <div className="flex gap-1.5">
                <select
                  value={IP_DETECT_ENDPOINTS.find(e => e.url === proxyPoolConfig.testUrl)?.id || '_custom'}
                  onChange={(e) => {
                    const ep = IP_DETECT_ENDPOINTS.find(ep => ep.id === e.target.value)
                    if (ep) setProxyPoolConfig({ testUrl: ep.url })
                  }}
                  className="h-8 text-xs rounded-lg border border-foreground/15 bg-[var(--glass-bg)] backdrop-blur-md px-2 flex-shrink-0"
                >
                  {IP_DETECT_ENDPOINTS.map(ep => (
                    <option key={ep.id} value={ep.id}>{ep.label}</option>
                  ))}
                  <option value="_custom">{isEn ? 'Custom...' : 'Customize...'}</option>
                </select>
                <Input
                  value={proxyPoolConfig.testUrl}
                  onChange={(e) => setProxyPoolConfig({ testUrl: e.target.value })}
                  placeholder="https://api.ipify.org?format=json"
                  className="h-8 text-xs font-mono flex-1"
                />
              </div>
            </div>
          </div>

          {/* Scheduled automatic verification (B2) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {isEn ? 'Auto-validate interval (min, 0=off)' : 'Scheduled automatic life verification (minutes,0=closure)'}
              </Label>
              <Input
                type="number" min={0} max={1440}
                value={proxyPoolConfig.autoValidateIntervalMin}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 0) setProxyPoolConfig({ autoValidateIntervalMin: v })
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'Auto-validate concurrency' : 'Concurrency verification'}</Label>
              <Input
                type="number" min={1} max={50}
                value={proxyPoolConfig.autoValidateConcurrency}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setProxyPoolConfig({ autoValidateConcurrency: v })
                }}
                disabled={proxyPoolConfig.autoValidateIntervalMin === 0}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Upstream transit agent (agent chain): used for target agents requiring non-mainland sources IP scene */}
          <div className="space-y-1">
            <Label className="text-xs">
              {isEn ? 'Upstream relay proxy (proxy chaining)' : 'Upstream transit agent (agent chain)'}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={proxyPoolConfig.upstreamProxy || ''}
                onChange={(e) => setProxyPoolConfig({ upstreamProxy: e.target.value })}
                placeholder={isEn ? 'e.g. socks5://127.0.0.1:7890 (empty = off)' : 'like socks5://127.0.0.1:7890(leave blank=Not enabled)'}
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                size="sm" variant="outline"
                className="h-8 px-3 text-xs whitespace-nowrap"
                disabled={!proxyPoolConfig.upstreamProxy?.trim() || proxyPool.size === 0 || chainDiagnosing}
                onClick={() => void runChainDiagnose()}
                title={isEn ? 'Diagnose proxy chain (locates failure layer)' : 'Diagnostic agent chain (locating the layer where the failure occurred)'}
              >
                {chainDiagnosing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Stethoscope className="h-3.5 w-3.5" />}
                <span className="ml-1">{isEn ? 'Diagnose' : 'diagnosis'}</span>
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {isEn
                ? 'When set, traffic chains: local → relay → target proxy → site. Use when the target proxy requires a non-mainland source IP (e.g. bestproxy). Supports http/socks5; your VPN local port works.'
                : 'After filling in, the link is: This machine → upstream transfer → target agent → target site. Used for target proxies requiring non-mainland sources IP situation (such as bestproxy). support http/socks5, you can fill in the local port for your scientific Internet access.'}
            </p>
            {chainDiagnose && <ChainDiagnosisCard diag={chainDiagnose} isEn={isEn} />}
          </div>
        </CardContent>
      </Card>

      {/* Add proxy */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" />
            {isEn ? 'Add Proxies' : 'Add proxy'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* single add */}
          <div className="flex gap-2">
            <Input
              value={singleInput}
              onChange={(e) => setSingleInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSingle()}
              placeholder={isEn
                ? 'http://user:pass@host:port  or  host:port  or  socks5://...'
                : 'http://user:pass@host:port or host:port or socks5://...'
              }
              className="font-mono text-xs"
            />
            <Button onClick={handleAddSingle} disabled={!singleInput.trim()}>
              <Plus className="h-4 w-4 mr-1" />
              {isEn ? 'Add' : 'Add to'}
            </Button>
            <Button variant="outline" onClick={() => setBulkOpen(!bulkOpen)}>
              <Upload className="h-4 w-4 mr-1" />
              {isEn ? 'Bulk' : 'batch'}
            </Button>
          </div>

          {/* Batch import */}
          {bulkOpen && (
            <div className="space-y-2 p-3 bg-muted/30 rounded-lg border border-dashed">
              <Label className="text-xs">
                {isEn
                  ? 'One proxy per line. Supports: http(s)://host:port, user:pass@host:port, host:port:user:pass, socks5://...'
                  : 'One agent per line. Supported formats: http(s)://host:port、user:pass@host:port、host:port:user:pass、socks5://...'
                }
              </Label>
              <textarea
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 bg-background border rounded-lg text-xs font-mono resize-none"
                placeholder={'http://127.0.0.1:7890\nuser:pass@1.2.3.4:8080\nsocks5://example.com:1080'}
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setBulkInput(''); setBulkOpen(false) }}>
                  {isEn ? 'Cancel' : 'Cancel'}
                </Button>
                <Button size="sm" onClick={handleImport} disabled={!bulkInput.trim()}>
                  <FileText className="h-4 w-4 mr-1" />
                  {isEn ? 'Import' : 'import'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* statistics + Toolbar */}
      <Card>
        <CardContent className="py-3 space-y-3">
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <span className="text-muted-foreground">
              {isEn ? 'Total:' : 'total:'} <strong className="text-foreground">{stats.total}</strong>
            </span>
            <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30">
              {isEn ? 'Alive' : 'Available'}: {stats.alive}
            </Badge>
            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/30">
              {isEn ? 'Slow' : 'slower'}: {stats.slow}
            </Badge>
            <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30">
              {isEn ? 'Dead' : 'Invalid'}: {stats.dead}
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {isEn ? 'Untested' : 'Not tested'}: {stats.untested}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {isEn ? `${stats.enabled} enabled` : `${stats.enabled} Enabled`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder={isEn ? 'Search any field (host/port/protocol/user/email/label/url)...' : 'Search any field (host/port/protocol/user/Mail/Remark/URL）...'}
              className="h-8 max-w-md text-xs"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'all' | ProxyEntry['status'])}
              className="h-8 px-2 rounded-md border bg-background text-xs"
            >
              <option value="all">{isEn ? 'All Status' : 'All status'}</option>
              <option value="alive">{isEn ? 'Alive' : 'Available'}</option>
              <option value="slow">{isEn ? 'Slow' : 'slower'}</option>
              <option value="dead">{isEn ? 'Dead' : 'Invalid'}</option>
              <option value="untested">{isEn ? 'Untested' : 'Not tested'}</option>
            </select>

            <Button
              size="sm"
              variant={advancedSearchOpen || activeAdvancedFilterCount > 0 ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setAdvancedSearchOpen(!advancedSearchOpen)}
            >
              {isEn ? 'Advanced' : 'advanced'}
              {activeAdvancedFilterCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-background/30 text-[10px]">
                  {activeAdvancedFilterCount}
                </span>
              )}
            </Button>

            {(filterText || filterStatus !== 'all' || activeAdvancedFilterCount > 0) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => {
                  setFilterText('')
                  setFilterStatus('all')
                  clearAdvancedFilters()
                }}
              >
                {isEn ? 'Clear' : 'Clear'}
              </Button>
            )}

            <div className="w-px h-6 bg-border" />

            <Button
              size="sm"
              variant="outline"
              onClick={handleValidateAll}
              disabled={isValidatingAll || filtered.length === 0}
            >
              {isValidatingAll
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <RefreshCw className="h-4 w-4 mr-1" />
              }
              {isEn ? `Test All (${filtered.length})` : `All tests (${filtered.length})`}
            </Button>

            {selectedIds.size > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={handleValidateSelected}>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {isEn ? `Test Selected (${selectedIds.size})` : `test selected (${selectedIds.size})`}
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={handleDeleteSelected}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  {isEn ? `Delete (${selectedIds.size})` : `delete (${selectedIds.size})`}
                </Button>
              </>
            )}

            <Button size="sm" variant="ghost" onClick={handleRemoveDead} disabled={stats.dead === 0}>
              <XCircle className="h-4 w-4 mr-1" />
              {isEn ? 'Remove Dead' : 'Remove invalid'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={() => {
                if (proxies.length === 0) return
                if (confirm(isEn ? 'Clear all proxies?' : 'Are you sure you want to clear all proxies?')) clearProxyPool()
              }}
              disabled={proxies.length === 0}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {isEn ? 'Clear All' : 'Clear'}
            </Button>

            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">{isEn ? 'Concurrency:' : 'concurrent:'}</span>
              <Input
                type="number" min={1} max={50}
                value={testConcurrency}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setTestConcurrency(v)
                }}
                className="h-7 w-14 text-xs text-center"
              />
            </div>
          </div>

          {/* Advanced search accordion: Protocols / enable / Delay / final verification */}
          {advancedSearchOpen && (
            <div className="flex flex-wrap items-center gap-2 p-3 rounded-md border bg-muted/30 mt-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Protocol:' : 'protocol:'}</span>
                <select
                  value={filterProtocol}
                  onChange={(e) => setFilterProtocol(e.target.value as 'all' | ProxyEntry['protocol'])}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : 'all'}</option>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Enabled:' : 'enable:'}</span>
                <select
                  value={filterEnabled}
                  onChange={(e) => setFilterEnabled(e.target.value as 'all' | 'enabled' | 'disabled')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : 'all'}</option>
                  <option value="enabled">{isEn ? 'Enabled' : 'Enabled'}</option>
                  <option value="disabled">{isEn ? 'Disabled' : 'Deactivated'}</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Latency:' : 'Delay:'}</span>
                <select
                  value={filterLatency}
                  onChange={(e) => setFilterLatency(e.target.value as 'all' | 'fast' | 'medium' | 'slow' | 'unknown')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : 'all'}</option>
                  <option value="fast">{isEn ? '< 200ms (Fast)' : '< 200ms(quick)'}</option>
                  <option value="medium">{isEn ? '200-1000ms' : '200-1000ms'}</option>
                  <option value="slow">{isEn ? '> 1000ms (Slow)' : '> 1000ms(slow)'}</option>
                  <option value="unknown">{isEn ? 'Unknown' : 'unknown'}</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Tested:' : 'Verified in:'}</span>
                <select
                  value={filterTestedWithin}
                  onChange={(e) => setFilterTestedWithin(e.target.value as 'all' | '1h' | '1d' | '7d' | 'never')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'Any time' : 'any time'}</option>
                  <option value="1h">{isEn ? 'Last 1h' : 'recent 1 Hour'}</option>
                  <option value="1d">{isEn ? 'Last 1 day' : 'recent 1 sky'}</option>
                  <option value="7d">{isEn ? 'Last 7 days' : 'recent 7 sky'}</option>
                  <option value="never">{isEn ? 'Never tested' : 'never tested'}</option>
                </select>
              </div>

              {activeAdvancedFilterCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 ml-auto text-xs"
                  onClick={clearAdvancedFilters}
                >
                  {isEn ? 'Reset' : 'reset'}
                </Button>
              )}

              <div className="w-full text-[10px] text-muted-foreground mt-1">
                {isEn
                  ? `Matched ${filtered.length} of ${proxies.length}`
                  : `match ${filtered.length} / ${proxies.length}`}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Anti-generation account-acting N:1 bucket */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            {isEn ? 'Reverse Proxy: Account-to-IP Bucketing' : 'Anti-generation bucketing (account binding proxy IP）'}
            <span className="text-[10px] font-normal text-muted-foreground">
              {isEn
                ? '— Limit accounts per IP to avoid risk-control association'
                : '— Limit per IP Number of accounts to avoid being associated with risk control'
              }
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="p-2 bg-muted/30 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Active Accounts' : 'Available accounts'}</div>
              <div className="text-lg font-bold">{bindingStats.totalActive}</div>
            </div>
            <div className="p-2 bg-green-50 dark:bg-green-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Bound' : 'Bound'}</div>
              <div className="text-lg font-bold text-green-600">{bindingStats.boundCount}</div>
            </div>
            <div className="p-2 bg-amber-50 dark:bg-amber-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Unbound' : 'Not bound'}</div>
              <div className="text-lg font-bold text-amber-600">{bindingStats.unboundCount}</div>
            </div>
            <div className="p-2 bg-cyan-50 dark:bg-cyan-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Alive Proxies' : 'Available proxies'}</div>
              <div className="text-lg font-bold text-cyan-600">{bindingStats.aliveProxyCount}</div>
            </div>
          </div>

          {/* Risk warning */}
          {bindingStats.overloadedProxies.length > 0 && (
            <div className="p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded text-xs">
              <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
                <XCircle className="h-3.5 w-3.5" />
                {isEn ? 'Risk: Overloaded proxies' : 'Risk: Overloading the proxy'}
              </div>
              <p className="text-muted-foreground mt-1">
                {isEn
                  ? `${bindingStats.overloadedProxies.length} proxy/proxies are carrying more than 10 accounts. Consider re-distributing.`
                  : `${bindingStats.overloadedProxies.length} agents hosted more than 10 account, it is recommended to reallocate it.`
                }
              </p>
            </div>
          )}

          {/* automatic allocation */}
          <div className="flex items-center gap-3 flex-wrap p-3 bg-muted/20 rounded-lg border border-dashed">
            <div className="flex items-center gap-2">
              <Shuffle className="h-4 w-4 text-primary" />
              <Label className="text-sm">{isEn ? 'Accounts per proxy' : 'Per agent carries'}:</Label>
              <Input
                type="number" min={0} max={50}
                value={accountsPerProxy}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 0) setAccountsPerProxy(v)
                }}
                className="h-8 w-20 text-xs text-center"
              />
              <span className="text-[10px] text-muted-foreground italic">
                {accountsPerProxy === 0
                  ? (isEn ? '(0 = even split)' : '(0 = Divide equally)')
                  : (isEn ? `accounts → 1 IP` : 'account / IP')
                }
              </span>
            </div>
            <Button size="sm" onClick={() => handleAutoDistribute(true)} disabled={bindingStats.unboundCount === 0}>
              <Users className="h-4 w-4 mr-1" />
              {isEn ? `Auto-Bind Unbound (${bindingStats.unboundCount})` : `Autobinding is not assigned (${bindingStats.unboundCount})`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleAutoDistribute(false)}>
              <RefreshCw className="h-4 w-4 mr-1" />
              {isEn ? 'Re-Distribute All' : 'reassign all'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={() => {
                if (bindingStats.boundCount === 0) return
                if (confirm(isEn ? `Unbind all ${bindingStats.boundCount} accounts?` : `Unbind all ${bindingStats.boundCount} An account?`)) {
                  clearAccountProxyBindings()
                }
              }}
              disabled={bindingStats.boundCount === 0}
            >
              <Unlink className="h-4 w-4 mr-1" />
              {isEn ? 'Unbind All' : 'Unbind all'}
            </Button>
          </div>

          {/* Detailed binding relationship (collapse) */}
          <button
            onClick={() => setBindingPanelExpanded(!bindingPanelExpanded)}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            {bindingPanelExpanded
              ? (isEn ? '▼ Hide binding details' : '▼ Hide binding details')
              : (isEn ? '▶ Show binding details' : '▶ Show binding details')
            }
          </button>

          {bindingPanelExpanded && (
            <div className="space-y-2 max-h-64 overflow-y-auto border rounded-lg">
              {proxies.filter((p) => p.enabled && p.status !== 'dead').map((p) => {
                const boundAccountIds = Object.entries(accountProxyBindings)
                  .filter(([, pid]) => pid === p.id)
                  .map(([aid]) => aid)
                if (boundAccountIds.length === 0) return null
                return (
                  <div key={p.id} className="p-2 border-b last:border-b-0">
                    <div className="flex items-center justify-between gap-2 text-xs mb-1">
                      <span className="font-mono truncate" title={p.url}>
                        {p.host}:{p.port}
                        {p.label && <Badge variant="outline" className="ml-1.5 h-4 text-[9px]">{p.label}</Badge>}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {boundAccountIds.length} {isEn ? 'accounts' : 'account'}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1 pl-2">
                      {boundAccountIds.map((aid) => {
                        const acc = accounts.get(aid)
                        return (
                          <span
                            key={aid}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-[10px] hover:bg-destructive/10 transition-colors group"
                          >
                            <span title={acc?.email}>{(acc?.email || aid.slice(0, 8))}</span>
                            <button
                              onClick={() => unbindAccountFromProxy(aid)}
                              className="opacity-30 group-hover:opacity-100 text-destructive"
                              title={isEn ? 'Unbind' : 'unbundle'}
                            >
                              <XCircle className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {bindingStats.unboundCount > 0 && (
                <div className="p-2 bg-amber-50 dark:bg-amber-950/10 text-xs">
                  <span className="text-amber-700 dark:text-amber-300">
                    {isEn ? `${bindingStats.unboundCount} accounts have no proxy binding (will use global proxy / direct).` : `${bindingStats.unboundCount} The account is not bound to a proxy (global proxy will be used) / direct connection)`}
                  </span>
                </div>
              )}
              {bindingStats.boundCount === 0 && (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  {isEn ? 'No bindings yet. Click "Auto-Bind" above to start.' : 'No binding yet. Click above"Automatic binding"start.'}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* proxy list */}
      {filtered.length > 0 ? (
        <Card>
          <CardContent className="py-0 px-0">
            {/* Header */}
            <div className="flex items-center gap-3 py-2 px-3 border-b text-xs font-medium text-muted-foreground bg-muted/30">
              <button onClick={toggleSelectAll} className="flex-shrink-0">
                <input
                  type="checkbox"
                  readOnly
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  className="cursor-pointer"
                />
              </button>
              <span className="w-12 text-center">{isEn ? 'On' : 'enable'}</span>
              <span className="flex-1">URL</span>
              <span className="w-24 text-center">{isEn ? 'Status' : 'state'}</span>
              <span className="w-20 text-center">{isEn ? 'Used' : 'use'}</span>
              <span className="w-20 text-center">{isEn ? 'Failed' : 'fail'}</span>
              <span className="w-32 text-center">{isEn ? 'External IP / Email' : 'exit IP / Mail'}</span>
              <span className="w-24 text-center">{isEn ? 'Actions' : 'operate'}</span>
            </div>

            <ProxyVirtualList
              filtered={filtered}
              selectedIds={selectedIds}
              onSelect={toggleSelect}
              onToggle={toggleProxyEnabled}
              onTest={validateProxy}
              onDelete={removeProxy}
              onSaveLabel={(id, label) => updateProxy(id, { label })}
              isEn={isEn}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {proxies.length === 0
                ? (isEn ? 'No proxies yet. Add some to begin.' : 'No agent yet. Start by adding some proxies.')
                : (isEn ? 'No proxies match the current filter.' : 'There are no matching agents in the current filter.')
              }
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface ProxyRowProps {
  proxy: ProxyEntry
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onTest: () => Promise<unknown>
  onDelete: () => void
  onSaveLabel: (label?: string) => void
  isEn: boolean
}

function ProxyRow({ proxy, selected, onSelect, onToggle, onTest, onDelete, onSaveLabel, isEn }: ProxyRowProps): React.ReactNode {
  // Desensitization password part
  const displayUrl = useMemo(() => {
    if (!proxy.password) return proxy.url
    return proxy.url.replace(/:([^:@\/]+)@/, ':***@')
  }, [proxy.url, proxy.password])

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(proxy.url)
  }

  // Remark inline Edit: click pencil/Enter the badge into the editor and press Enter/Save out of focus,ESC Cancel
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(proxy.label || '')
  const startEditLabel = (): void => {
    setLabelDraft(proxy.label || '')
    setEditingLabel(true)
  }
  const saveLabel = (): void => {
    const v = labelDraft.trim()
    if (v !== (proxy.label || '')) onSaveLabel(v || undefined)
    setEditingLabel(false)
  }

  return (
    <div className={cn(
      'flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs transition-colors',
      selected && 'bg-primary/5',
      !proxy.enabled && 'opacity-60'
    )}>
      <input type="checkbox" checked={selected} onChange={onSelect} className="flex-shrink-0 cursor-pointer" />
      <button
        onClick={onToggle}
        className="w-12 flex justify-center text-muted-foreground hover:text-foreground"
        title={isEn ? (proxy.enabled ? 'Disable' : 'Enable') : (proxy.enabled ? 'deactivate' : 'enable')}
      >
        {proxy.enabled
          ? <Power className="h-4 w-4 text-green-500" />
          : <PowerOff className="h-4 w-4" />
        }
      </button>
      <span className="flex-1 font-mono truncate flex items-center min-w-0" title={displayUrl}>
        <span className="opacity-50 mr-1 flex-shrink-0">{proxy.protocol}://</span>
        <span className="truncate">{proxy.host}:{proxy.port}{proxy.username && <span className="opacity-50 ml-1">@{proxy.username}</span>}</span>
        {editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel()
              else if (e.key === 'Escape') { setLabelDraft(proxy.label || ''); setEditingLabel(false) }
            }}
            placeholder={isEn ? 'Note' : 'Remark'}
            className="ml-2 px-1.5 h-5 text-[10px] rounded border border-primary bg-background font-sans w-28 flex-shrink-0 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : proxy.label ? (
          <Badge
            variant="outline"
            className="ml-2 h-4 text-[9px] cursor-pointer hover:bg-muted flex-shrink-0"
            onClick={startEditLabel}
            title={isEn ? 'Click to edit note' : 'Click to edit the note'}
          >
            {proxy.label}
          </Badge>
        ) : null}
      </span>
      <span className="w-24 flex justify-center">
        <StatusBadge status={proxy.status} latency={proxy.latencyMs} />
      </span>
      <span className="w-20 text-center font-mono tabular-nums">{proxy.usedCount}</span>
      <span className={cn('w-20 text-center font-mono tabular-nums', proxy.failCount > 0 && 'text-amber-600')}>
        {proxy.failCount}
      </span>
      <span className="w-32 text-center text-[10px] truncate" title={proxy.lastBoundEmail}>
        {proxy.lastBoundEmail
          ? <span className="text-muted-foreground">{proxy.lastBoundEmail}</span>
          : (proxy.lastTestedAt
            ? <span className="text-muted-foreground inline-flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                {Math.round((Date.now() - proxy.lastTestedAt) / 60000)}m
              </span>
            : <span className="opacity-40">-</span>
          )
        }
      </span>
      <span className="w-24 flex justify-center gap-1">
        <button
          onClick={() => void onTest()}
          disabled={proxy.status === 'testing'}
          className="p-1 rounded hover:bg-muted"
          title={isEn ? 'Test' : 'test'}
        >
          {proxy.status === 'testing'
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />
          }
        </button>
        <button
          onClick={startEditLabel}
          className="p-1 rounded hover:bg-muted"
          title={isEn ? 'Edit note' : "Editor's Notes"}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button onClick={handleCopy} className="p-1 rounded hover:bg-muted" title={isEn ? 'Copy URL' : 'copy URL'}>
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-destructive/10 text-destructive"
          title={isEn ? 'Delete' : 'delete'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  )
}

/**
 * Virtualized rendering of proxy lists (avoiding lags when processing hundreds to thousands of proxies)
 * row height approx. 44px(Including padding and border）
 */
interface ProxyVirtualListProps {
  filtered: ProxyEntry[]
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onTest: (id: string) => Promise<unknown>
  onDelete: (id: string) => void
  onSaveLabel: (id: string, label?: string) => void
  isEn: boolean
}

function ProxyVirtualList({ filtered, selectedIds, onSelect, onToggle, onTest, onDelete, onSaveLabel, isEn }: ProxyVirtualListProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const ROW_HEIGHT = 44

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  // Fewer rows (< 50) is not virtual, and is rendered directly to avoid virtual list layout overhead.
  if (filtered.length < 50) {
    return (
      <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
        {filtered.map((p) => (
          <ProxyRow
            key={p.id}
            proxy={p}
            selected={selectedIds.has(p.id)}
            onSelect={() => onSelect(p.id)}
            onToggle={() => onToggle(p.id)}
            onTest={() => onTest(p.id)}
            onDelete={() => onDelete(p.id)}
            onSaveLabel={(label) => onSaveLabel(p.id, label)}
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
          const p = filtered[virtualRow.index]
          if (!p) return null
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
              <ProxyRow
                proxy={p}
                selected={selectedIds.has(p.id)}
                onSelect={() => onSelect(p.id)}
                onToggle={() => onToggle(p.id)}
                onTest={() => onTest(p.id)}
                onDelete={() => onDelete(p.id)}
                onSaveLabel={(label) => onSaveLabel(p.id, label)}
                isEn={isEn}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
