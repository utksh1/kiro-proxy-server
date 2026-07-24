import { useMemo } from 'react'
import { useAccountsStore, isBannedAccountError } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { Users, CheckCircle, AlertTriangle, Clock, Zap, Shield, Fingerprint, FolderPlus, Tag, TrendingUp, Activity, BarChart3, Ban, ChevronRight } from 'lucide-react'
import kiroLogo from '@/assets/kiro-high-resolution-logo-transparent.png'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account, AccountFilter } from '@/types/account'

// Credit emergency threshold (usage.percentUsed for 0-1 decimal)
const QUOTA_WARN_RATIO = 0.9
// Upcoming expiry threshold (days)
const EXPIRE_WARN_DAYS = 7

// Subscription type color mapping
const getSubscriptionColor = (type: string, title?: string): string => {
  const text = (title || type).toUpperCase()
  // KIRO PRO+ / PRO_PLUS - Purple
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS')) return 'bg-purple-500'
  // KIRO POWER - gold
  if (text.includes('POWER')) return 'bg-amber-500'
  // KIRO PRO - blue
  if (text.includes('PRO')) return 'bg-blue-500'
  // KIRO FREE - grey
  return 'bg-gray-500'
}

export function HomePage() {
  const { accounts, activeAccountId, getStats, darkMode, usagePrecision, setFilter, setActiveGroupTab } = useAccountsStore()
  const { t } = useTranslation()
  const stats = getStats()

  // Alarm aggregation: ban / Expiring soon / The quota is tight (one traversal, reusing existing data)
  const warnings = useMemo(() => {
    const banned: Account[] = []
    const expiring: Account[] = []
    const quotaHigh: Account[] = []
    for (const a of accounts.values()) {
      if (isBannedAccountError(a.lastError)) {
        banned.push(a)
        continue // Those that have been banned will no longer be included in other alarms.
      }
      const days = a.subscription.daysRemaining
      if (days !== undefined && days <= EXPIRE_WARN_DAYS) expiring.push(a)
      if (a.status === 'active' && a.usage.limit > 0 && a.usage.percentUsed >= QUOTA_WARN_RATIO) {
        quotaHigh.push(a)
      }
    }
    return { banned, expiring, quotaHigh }
  }, [accounts])

  // Click on the alert → Apply filters and jump to account page (clear groups Tab restrictions to ensure visibility across groups)
  const jumpToAccounts = (patch: AccountFilter): void => {
    setActiveGroupTab('all')
    setFilter(patch)
    window.dispatchEvent(new CustomEvent('navigate-page', { detail: 'accounts' }))
  }

  // Calculate credit statistics
  const usageStats = useMemo(() => {
    let totalLimit = 0
    let totalUsed = 0
    let validAccountCount = 0

    Array.from(accounts.values()).forEach(account => {
      // Only accounts in normal status are counted
      if (account.status === 'active' && account.usage) {
        const limit = account.usage.limit ?? 0
        const used = account.usage.current ?? 0
        if (limit > 0) {
          totalLimit += limit
          totalUsed += used
          validAccountCount++
        }
      }
    })

    const remaining = totalLimit - totalUsed
    const percentUsed = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0

    return {
      totalLimit,
      totalUsed,
      remaining,
      percentUsed,
      validAccountCount
    }
  }, [accounts])

  const isEn = t('common.unknown') === 'Unknown'
  const statCards = [
    { 
      label: isEn ? 'Total Accounts' : 'Total number of accounts', 
      value: stats.total, 
      icon: Users, 
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10'
    },
    { 
      label: isEn ? 'Active' : 'Normal account', 
      value: stats.byStatus?.active || 0, 
      icon: CheckCircle, 
      color: 'text-green-500',
      bgColor: 'bg-green-500/10'
    },
    { 
      label: isEn ? 'Banned' : 'Banned', 
      value: stats.byStatus?.error || 0, 
      icon: AlertTriangle, 
      color: 'text-red-500',
      bgColor: 'bg-red-500/10'
    },
    { 
      label: isEn ? 'Expiring Soon' : 'Expires soon', 
      value: stats.expiringSoonCount, 
      icon: Clock, 
      color: 'text-amber-500',
      bgColor: 'bg-amber-500/10'
    },
  ]

  // Get the current active account: use activeAccountId direct O(1) Hit and avoid every time re-render All O(n) Traverse
  const activeAccount = useMemo(
    () => (activeAccountId ? accounts.get(activeAccountId) ?? null : null),
    [accounts, activeAccountId]
  )

  // Alarm card row configuration (only render non-empty categories)
  const warnRows = [
    {
      key: 'banned',
      list: warnings.banned,
      icon: Ban,
      iconBg: 'bg-red-500/10',
      iconColor: 'text-red-500',
      label: isEn ? 'Banned' : 'Banned',
      hint: isEn ? 'Need manual unban' : 'Requires manual unblocking',
      onClick: () => jumpToAccounts({ bannedOnly: true })
    },
    {
      key: 'expiring',
      list: warnings.expiring,
      icon: Clock,
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-500',
      label: isEn ? `Expiring (≤${EXPIRE_WARN_DAYS}d)` : `Expiring soon (≤${EXPIRE_WARN_DAYS}sky)`,
      hint: isEn ? 'Renew soon' : 'Renew as soon as possible',
      onClick: () => jumpToAccounts({ daysRemainingMax: EXPIRE_WARN_DAYS })
    },
    {
      key: 'quota',
      list: warnings.quotaHigh,
      icon: Zap,
      iconBg: 'bg-orange-500/10',
      iconColor: 'text-orange-500',
      label: isEn ? `Quota ≥${Math.round(QUOTA_WARN_RATIO * 100)}%` : `The quota is tight (≥${Math.round(QUOTA_WARN_RATIO * 100)}%)`,
      hint: isEn ? 'Almost exhausted' : 'About to run out',
      onClick: () => jumpToAccounts({ usageMin: QUOTA_WARN_RATIO })
    }
  ].filter((r) => r.list.length > 0)

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <img 
            src={kiroLogo} 
            alt="Kiro" 
            className={cn("h-14 w-auto transition-all", darkMode && "invert brightness-0")} 
          />
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Welcome to Kiro Account Manager' : 'Welcome Kiro Account manager'}</h1>
            <p className="text-muted-foreground">{isEn ? 'Manage your Kiro IDE accounts, one-click switch' : 'Manage your Kiro IDE Account, one-click switching, efficient development'}</p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon
          return (
            <Card key={stat.label} className="hover-lift">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${stat.bgColor}`}>
                    <Icon className={`h-5 w-5 ${stat.color}`} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Alert warning card: There is a ban/maturity/Displayed only when the limit is urgent */}
      {warnRows.length > 0 && (
        <Card className="hover-lift border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              </div>
              {isEn ? 'Attention Needed' : 'Need attention'}
              <span className="text-xs font-normal text-muted-foreground">
                {isEn ? 'Click a row to view affected accounts' : 'Click to view affected accounts'}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {warnRows.map((row) => {
              const Icon = row.icon
              const preview = row.list.slice(0, 3).map((a) => a.nickname || a.email).join('、')
              const more = row.list.length > 3 ? (isEn ? ` +${row.list.length - 3} more` : ` wait ${row.list.length} indivual`) : ''
              return (
                <button
                  key={row.key}
                  onClick={row.onClick}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-muted/40 hover:bg-muted transition-colors text-left group"
                >
                  <div className={cn('p-2 rounded-lg shrink-0', row.iconBg)}>
                    <Icon className={cn('h-4 w-4', row.iconColor)} />
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0">
                    <span className="text-lg font-bold tabular-nums">{row.list.length}</span>
                    <span className="text-sm font-medium">{row.label}</span>
                  </div>
                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {preview}{more}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 group-hover:translate-x-0.5 transition-transform" />
                </button>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Usage Stats */}
      {usageStats.validAccountCount > 0 && (
        <Card className="hover-lift">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <BarChart3 className="h-4 w-4 text-primary" />
              </div>
              {isEn ? 'Usage Stats' : 'Quota statistics'}
              <span className="text-xs font-normal text-muted-foreground">
                ({isEn ? `Based on ${usageStats.validAccountCount} valid accounts` : `based on ${usageStats.validAccountCount} valid account`})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div className="p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  <span className="text-xs text-muted-foreground">{isEn ? 'Total' : 'total amount'}</span>
                </div>
                <p className="text-xl font-bold">{usageStats.totalLimit.toLocaleString()}</p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="h-4 w-4 text-orange-500" />
                  <span className="text-xs text-muted-foreground">{isEn ? 'Used' : 'Already used'}</span>
                </div>
                <p className="text-xl font-bold">{usageStats.totalUsed.toLocaleString()}</p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="h-4 w-4 text-green-500" />
                  <span className="text-xs text-muted-foreground">{isEn ? 'Remaining' : 'remaining balance'}</span>
                </div>
                <p className="text-xl font-bold text-green-600">{usageStats.remaining.toLocaleString()}</p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="h-4 w-4 text-purple-500" />
                  <span className="text-xs text-muted-foreground">{isEn ? 'Usage %' : 'Usage rate'}</span>
                </div>
                <p className="text-xl font-bold">{usageStats.percentUsed.toFixed(usagePrecision ? 2 : 1)}%</p>
              </div>
            </div>
            {/* progress bar - Double segment display when overage */}
            {(() => {
              const isOverQuota = usageStats.percentUsed > 100
              const overPercent = isOverQuota ? usageStats.percentUsed - 100 : 0
              const overAmount = isOverQuota ? Math.abs(usageStats.remaining) : 0
              // Visual width of excess segment: proportion to the entire progress bar based on excess ratio, up to 60% avoid complete covering
              const overBarWidth = isOverQuota ? Math.min((overPercent / usageStats.percentUsed) * 100, 60) : 0
              const precision = usagePrecision ? 2 : 1

              return (
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">{isEn ? 'Overall Progress' : 'Overall usage progress'}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {usageStats.totalUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })} / {usageStats.totalLimit.toLocaleString()}
                      </span>
                      <span className={cn(
                        "font-bold px-2 py-0.5 rounded-md",
                        isOverQuota && "bg-red-500/15 text-red-600 dark:text-red-400",
                        !isOverQuota && usageStats.percentUsed >= 80 && "bg-orange-500/15 text-orange-600 dark:text-orange-400",
                        !isOverQuota && usageStats.percentUsed >= 50 && usageStats.percentUsed < 80 && "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
                        !isOverQuota && usageStats.percentUsed < 50 && "bg-green-500/15 text-green-600 dark:text-green-400"
                      )}>
                        {usageStats.percentUsed.toFixed(precision)}%
                      </span>
                    </span>
                  </div>
                  <div className="relative h-3 bg-muted rounded-full overflow-hidden">
                    {/* Basic progress stage */}
                    <div 
                      className={cn(
                        "absolute inset-y-0 left-0 transition-all",
                        isOverQuota && "bg-red-500",
                        !isOverQuota && usageStats.percentUsed >= 80 && "bg-orange-500",
                        !isOverQuota && usageStats.percentUsed >= 50 && usageStats.percentUsed < 80 && "bg-yellow-500",
                        !isOverQuota && usageStats.percentUsed < 50 && "bg-green-500"
                      )}
                      style={{ width: `${Math.min(usageStats.percentUsed, 100)}%` }}
                    />
                    {/* excess segment - Crimson stripe animation overlays from the right */}
                    {isOverQuota && (
                      <div 
                        className="absolute inset-y-0 right-0 bg-gradient-to-r from-red-600 via-red-700 to-red-800 animate-pulse"
                        style={{
                          width: `${overBarWidth}%`,
                          backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.15) 0, rgba(255,255,255,0.15) 8px, transparent 8px, transparent 16px)',
                          backgroundSize: '22px 22px'
                        }}
                      />
                    )}
                  </div>
                  {/* Overage warning banner */}
                  {isOverQuota && (
                    <div className="flex items-center justify-between gap-3 mt-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                      <div className="flex items-center gap-2 text-xs">
                        <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                        <span className="font-bold text-red-600 dark:text-red-400">
                          {isEn ? 'Over Quota' : 'Already exceeded'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 dark:text-red-400 font-bold">
                          +{overPercent.toFixed(precision)}%
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">{isEn ? 'Excess: ' : 'Excess points:'}</span>
                        <span className="font-bold text-red-600 dark:text-red-400">
                          {overAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Current Account */}
      {activeAccount && (
        <Card className="hover-lift bg-gradient-to-r from-primary/5 to-primary/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              {isEn ? 'Current Account' : 'Currently using account'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Basic information */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
                  {(activeAccount.nickname || activeAccount.email || '?')[0].toUpperCase()}
                </div>
                <div>
                  <p className="font-medium">{activeAccount.nickname || activeAccount.email}</p>
                  <p className="text-sm text-muted-foreground">{activeAccount.email}</p>
                </div>
              </div>
              <div className="text-right">
                <span className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white',
                  getSubscriptionColor(
                    activeAccount.subscription?.type || 'Free',
                    activeAccount.subscription?.title
                  )
                )}>
                  {activeAccount.subscription?.title || activeAccount.subscription?.type || 'Free'}
                </span>
              </div>
            </div>

            {/* Details grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t">
              {/* Dosage */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{isEn ? 'Monthly Usage' : 'Usage this month'}</p>
                <p className="text-sm font-medium">
                  {activeAccount.usage?.current || 0} / {activeAccount.usage?.limit || 0}
                </p>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all ${
                      (activeAccount.usage?.percentUsed || 0) > 0.8 
                        ? 'bg-red-500' 
                        : (activeAccount.usage?.percentUsed || 0) > 0.5 
                          ? 'bg-amber-500' 
                          : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min((activeAccount.usage?.percentUsed || 0) * 100, 100)}%` }}
                  />
                </div>
              </div>

              {/* Subscription remaining */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{isEn ? 'Subscription' : 'Subscription remaining'}</p>
                <p className="text-sm font-medium">
                  {activeAccount.subscription?.daysRemaining != null 
                    ? (isEn ? `${activeAccount.subscription.daysRemaining} days` : `${activeAccount.subscription.daysRemaining} sky`)
                    : (isEn ? 'Permanent' : 'permanent')}
                </p>
              </div>

              {/* Token state */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{isEn ? 'Token Status' : 'Token state'}</p>
                {(() => {
                  const expiresAt = activeAccount.credentials?.expiresAt
                  if (!expiresAt) return <p className="text-sm font-medium text-muted-foreground">{isEn ? 'Unknown' : 'unknown'}</p>
                  const now = Date.now()
                  const remaining = expiresAt - now
                  if (remaining <= 0) return <p className="text-sm font-medium text-red-500">{isEn ? 'Expired' : 'Expired'}</p>
                  const minutes = Math.floor(remaining / 60000)
                  if (minutes < 60) return <p className="text-sm font-medium text-amber-500">{isEn ? `${minutes} min` : `${minutes} minute`}</p>
                  const hours = Math.floor(minutes / 60)
                  return <p className="text-sm font-medium text-green-500">{isEn ? `${hours} hours` : `${hours} Hour`}</p>
                })()}
              </div>

              {/* Login method */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{isEn ? 'Auth Method' : 'Login method'}</p>
                <p className="text-sm font-medium">
                  {activeAccount.credentials?.authMethod === 'social' 
                    ? (activeAccount.credentials?.provider || 'Social')
                    : 'Builder ID'}
                </p>
              </div>
            </div>

            {/* Subscription details */}
            <div className="pt-3 border-t space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{isEn ? 'Subscription Details' : 'Subscription details'}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{isEn ? 'Type:' : 'Subscription type:'}</span>
                  <span className="font-medium">{activeAccount.subscription?.title || activeAccount.subscription?.type || 'Free'}</span>
                </div>
                {activeAccount.subscription?.rawType && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{isEn ? 'Raw Type:' : 'primitive type:'}</span>
                    <span className="font-mono text-[10px]">{activeAccount.subscription.rawType}</span>
                  </div>
                )}
                {activeAccount.subscription?.expiresAt && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{isEn ? 'Expires:' : 'Expiration time:'}</span>
                    <span className="font-medium">{new Date(activeAccount.subscription.expiresAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                )}
                {activeAccount.subscription?.upgradeCapability && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{isEn ? 'Upgradeable:' : 'Upgradeable:'}</span>
                    <span className="font-medium">{activeAccount.subscription.upgradeCapability}</span>
                  </div>
                )}
                {activeAccount.subscription?.overageCapability && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{isEn ? 'Overage:' : 'excess capacity:'}</span>
                    <span className="font-medium">{activeAccount.subscription.overageCapability}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Quota details */}
            {(activeAccount.usage?.baseLimit || activeAccount.usage?.freeTrialLimit || activeAccount.usage?.bonuses?.length) && (
              <div className="pt-3 border-t space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{isEn ? 'Quota Details' : 'Quota details'}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {/* Basic amount */}
                  {activeAccount.usage?.baseLimit !== undefined && activeAccount.usage.baseLimit > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-muted-foreground">{isEn ? 'Base:' : 'Basic amount:'}</span>
                      <span className="font-medium">
                        {activeAccount.usage.baseCurrent ?? 0} / {activeAccount.usage.baseLimit}
                      </span>
                    </div>
                  )}
                  {/* Trial amount */}
                  {activeAccount.usage?.freeTrialLimit !== undefined && activeAccount.usage.freeTrialLimit > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-purple-500" />
                      <span className="text-muted-foreground">{isEn ? 'Trial:' : 'Trial amount:'}</span>
                      <span className="font-medium">
                        {activeAccount.usage.freeTrialCurrent ?? 0} / {activeAccount.usage.freeTrialLimit}
                      </span>
                      {activeAccount.usage.freeTrialExpiry && (
                        <span className="text-muted-foreground/70 text-[10px]">
                          (to {(() => {
                            const d = activeAccount.usage.freeTrialExpiry as unknown
                            try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                          })()})
                        </span>
                      )}
                    </div>
                  )}
                  {/* Reward amount */}
                  {activeAccount.usage?.bonuses?.map((bonus) => (
                    <div key={bonus.code} className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-cyan-500" />
                      <span className="text-muted-foreground truncate">{bonus.name}:</span>
                      <span className="font-medium">{bonus.current} / {bonus.limit}</span>
                      {bonus.expiresAt && (
                        <span className="text-muted-foreground/70 text-[10px]">
                          (to {(() => {
                            const d = bonus.expiresAt as unknown
                            try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                          })()})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Account information */}
            <div className="pt-3 border-t space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{isEn ? 'Account Info' : 'Account information'}</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">User ID:</span>
                  <span className="font-mono text-[10px] break-all select-all">{activeAccount.userId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">IDP:</span>
                  <span className="font-medium">{activeAccount.idp || 'BuilderId'}</span>
                </div>
                {activeAccount.usage?.nextResetDate && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{isEn ? 'Reset Date:' : 'reset date:'}</span>
                    <span className="font-medium">
                      {(() => {
                        const d = activeAccount.usage.nextResetDate as unknown
                        try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return isEn ? 'Unknown' : 'unknown' }
                      })()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Tips */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Quick Tips' : 'Quick Tips'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              {isEn ? 'Click "Accounts" to view and manage all accounts' : 'Click "Account Management" on the left to view and manage all accounts'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              {isEn ? 'Click power icon on account card to switch' : 'Click the power icon on the account card to quickly switch accounts'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              {isEn ? 'Tokens auto-refresh 5 minutes before expiry' : 'Token will be before expiration 5 Automatically refresh every minute, no manual operation required'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              {isEn ? 'Use "Privacy Mode" to hide sensitive info' : 'Use "Privacy Mode" to hide email and account information'}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Feature Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="hover-lift">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Fingerprint className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">{isEn ? 'Machine ID' : 'Machine code management'}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isEn ? 'Modify device ID, auto-switch, account binding' : 'Modify the device identifier, automatically change it when switching numbers, and support account binding'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <FolderPlus className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">{isEn ? 'Groups' : 'Group management'}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isEn ? 'Batch set groups for selected accounts' : 'After selecting multiple accounts, you can set groups in batches and move accounts with one click.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Tag className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">{isEn ? 'Tags' : 'tag management'}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isEn ? 'Batch add/remove tags, multi-tag support' : 'Multiple accounts can be added in batches/Remove tags and support multiple tags'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
