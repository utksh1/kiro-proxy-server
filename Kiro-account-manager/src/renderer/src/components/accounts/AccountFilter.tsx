import { useMemo, useState } from 'react'
import { Button } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { AccountFilter as FilterType, SubscriptionType, AccountStatus, IdpType } from '@/types/account'
import { cn } from '@/lib/utils'

const SubscriptionOptions: { value: SubscriptionType; label: string; color: string; activeColor: string }[] = [
  { value: 'Free', label: 'KIRO FREE', color: 'text-gray-500 border-gray-300', activeColor: 'bg-gray-500 text-white border-gray-500' },
  { value: 'Pro', label: 'KIRO PRO', color: 'text-blue-500 border-blue-300', activeColor: 'bg-blue-500 text-white border-blue-500' },
  { value: 'Pro_Plus', label: 'KIRO PRO+', color: 'text-purple-500 border-purple-300', activeColor: 'bg-purple-500 text-white border-purple-500' },
  { value: 'Enterprise', label: 'KIRO POWER', color: 'text-amber-500 border-amber-300', activeColor: 'bg-amber-500 text-white border-amber-500' }
]

const StatusOptionsZh: { value: AccountStatus; label: string }[] = [
  { value: 'active', label: 'normal' },
  { value: 'expired', label: 'Expired' },
  { value: 'error', label: 'mistake' },
  { value: 'unknown', label: 'unknown' }
]

const StatusOptionsEn: { value: AccountStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'error', label: 'Error' },
  { value: 'unknown', label: 'Unknown' }
]

const IdpOptions: { value: IdpType; label: string }[] = [
  { value: 'Google', label: 'Google' },
  { value: 'Github', label: 'GitHub' },
  { value: 'BuilderId', label: 'BuilderId' },
  { value: 'Enterprise', label: 'Enterprise' },
  { value: 'AWSIdC', label: 'AWSIdC' }
]

// parse ARGB Color converted to CSS rgba
function toRgba(argbColor: string): string {
  // Supported formats: #AARRGGBB or #RRGGBB
  let alpha = 255
  let rgb = argbColor
  if (argbColor.length === 9 && argbColor.startsWith('#')) {
    alpha = parseInt(argbColor.slice(1, 3), 16)
    rgb = '#' + argbColor.slice(3)
  }
  const hex = rgb.startsWith('#') ? rgb.slice(1) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
}

// The maximum number of default displays for domain name filtering, and the excess will be folded
const DOMAIN_DISPLAY_LIMIT = 16

export function AccountFilterPanel(): React.ReactNode {
  const { filter, setFilter, clearFilter, tags, accounts, getStats } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const StatusOptions = isEn ? StatusOptionsEn : StatusOptionsZh
  const [showAllDomains, setShowAllDomains] = useState(false)

  const stats = getStats()

  // Extract the email domain name suffix and quantity from existing accounts, in descending order of quantity
  const domainCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const account of accounts.values()) {
      const atIndex = account.email.lastIndexOf('@')
      if (atIndex < 0) continue
      const domain = account.email.slice(atIndex + 1).toLowerCase()
      if (!domain) continue
      counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [accounts])

  // Make sure the selected domain name is visible when folding
  const visibleDomains = useMemo(() => {
    if (showAllDomains || domainCounts.length <= DOMAIN_DISPLAY_LIMIT) return domainCounts
    const top = domainCounts.slice(0, DOMAIN_DISPLAY_LIMIT)
    const selected = new Set(filter.emailDomains ?? [])
    for (const entry of domainCounts.slice(DOMAIN_DISPLAY_LIMIT)) {
      if (selected.has(entry[0])) top.push(entry)
    }
    return top
  }, [domainCounts, showAllDomains, filter.emailDomains])

  const hasActiveFilters = Boolean(
    filter.subscriptionTypes?.length ||
    filter.statuses?.length ||
    filter.idps?.length ||
    filter.groupIds?.length ||
    filter.tagIds?.length ||
    filter.emailDomains?.length ||
    filter.usageMin !== undefined ||
    filter.usageMax !== undefined ||
    filter.daysRemainingMin !== undefined ||
    filter.daysRemainingMax !== undefined ||
    filter.bannedOnly
  )

  const toggleArrayFilter = <T extends string>(
    key: keyof FilterType,
    value: T
  ): void => {
    const current = (filter[key] as T[] | undefined) ?? []
    const newValue = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]

    setFilter({
      ...filter,
      [key]: newValue.length > 0 ? newValue : undefined
    })
  }

  const setRangeFilter = (
    minKey: keyof FilterType,
    maxKey: keyof FilterType,
    min: number | undefined,
    max: number | undefined
  ): void => {
    setFilter({
      ...filter,
      [minKey]: min,
      [maxKey]: max
    })
  }

  return (
    <div className="p-3 space-y-2">
      {/* Clear filter button */}
      {hasActiveFilters && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => clearFilter()}
          >
            {isEn ? 'Clear' : 'Clear filters'}
          </Button>
        </div>
      )}
      {/* First line: Subscription type + state + identity provider */}
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
            {/* Subscription type */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">{isEn ? 'Plan:' : 'subscription:'}</span>
              <div className="flex flex-wrap gap-1">
                {SubscriptionOptions.map((option) => {
                  const isActive = filter.subscriptionTypes?.includes(option.value)
                  const count = stats.bySubscription[option.value]
                  return (
                    <button
                      key={option.value}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        isActive ? option.activeColor : `hover:bg-muted/50 ${option.color}`
                      )}
                      onClick={() => toggleArrayFilter('subscriptionTypes', option.value)}
                    >
                      {option.label}({count})
                    </button>
                  )
                })}
              </div>
            </div>

            {/* state */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">{isEn ? 'Status:' : 'state:'}</span>
              <div className="flex flex-wrap gap-1">
                {StatusOptions.map((option) => {
                  const isActive = filter.statuses?.includes(option.value)
                  const count = stats.byStatus[option.value]
                  return (
                    <button
                      key={option.value}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => toggleArrayFilter('statuses', option.value)}
                    >
                      {option.label}({count})
                    </button>
                  )
                })}
                {/* ban filter */}
                <button
                  className={cn(
                    'px-2 py-0.5 text-xs rounded border transition-colors',
                    filter.bannedOnly
                      ? 'bg-red-500 text-white border-red-500'
                      : 'hover:bg-muted text-red-500 border-red-200'
                  )}
                  onClick={() => setFilter({ ...filter, bannedOnly: !filter.bannedOnly })}
                >
                  {isEn ? 'Banned' : 'Banned'}({stats.bannedCount})
                </button>
              </div>
            </div>

            {/* identity provider */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">IDP:</span>
              <div className="flex flex-wrap gap-1">
                {IdpOptions.map((option) => {
                  const isActive = filter.idps?.includes(option.value)
                  const count = stats.byIdp[option.value]
                  return (
                    <button
                      key={option.value}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => toggleArrayFilter('idps', option.value)}
                    >
                      {option.label}({count})
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Second line: label + Range filtering (grouping uses top instead) Tab Mutually exclusive switching, no more multi-select filtering) */}
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 mt-2">
            {/* Label */}
            {tags.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">{isEn ? 'Tags:' : 'Label:'}</span>
                <div className="flex flex-wrap gap-1">
                  {Array.from(tags.values()).map((tag) => {
                    const isActive = filter.tagIds?.includes(tag.id)
                    return (
                      <button
                        key={tag.id}
                        className={cn(
                          'px-2 py-0.5 text-xs rounded border transition-colors',
                          isActive ? 'text-white border-transparent' : 'hover:bg-muted'
                        )}
                        style={isActive ? { backgroundColor: toRgba(tag.color) } : undefined}
                        onClick={() => toggleArrayFilter('tagIds', tag.id)}
                      >
                        {tag.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Usage range */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">{isEn ? 'Usage:' : 'Usage:'}</span>
              <input
                type="number"
                min="0"
                max="100"
                placeholder="min"
                className="w-14 px-1.5 py-0.5 text-xs rounded-md border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                value={filter.usageMin ?? ''}
                onChange={(e) =>
                  setRangeFilter(
                    'usageMin',
                    'usageMax',
                    e.target.value ? Number(e.target.value) / 100 : undefined,
                    filter.usageMax
                  )
                }
              />
              <span className="text-muted-foreground text-xs">-</span>
              <input
                type="number"
                min="0"
                max="100"
                placeholder="max"
                className="w-14 px-1.5 py-0.5 text-xs rounded-md border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                value={filter.usageMax !== undefined ? filter.usageMax * 100 : ''}
                onChange={(e) =>
                  setRangeFilter(
                    'usageMin',
                    'usageMax',
                    filter.usageMin,
                    e.target.value ? Number(e.target.value) / 100 : undefined
                  )
                }
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>

            {/* Remaining days range */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">{isEn ? 'Days:' : 'Remaining:'}</span>
              <input
                type="number"
                min="0"
                placeholder="min"
                className="w-14 px-1.5 py-0.5 text-xs rounded-md border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                value={filter.daysRemainingMin ?? ''}
                onChange={(e) =>
                  setRangeFilter(
                    'daysRemainingMin',
                    'daysRemainingMax',
                    e.target.value ? Number(e.target.value) : undefined,
                    filter.daysRemainingMax
                  )
                }
              />
              <span className="text-muted-foreground text-xs">-</span>
              <input
                type="number"
                min="0"
                placeholder="max"
                className="w-14 px-1.5 py-0.5 text-xs rounded-md border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                value={filter.daysRemainingMax ?? ''}
                onChange={(e) =>
                  setRangeFilter(
                    'daysRemainingMin',
                    'daysRemainingMax',
                    filter.daysRemainingMin,
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
              />
              <span className="text-xs text-muted-foreground">{isEn ? 'd' : 'sky'}</span>
            </div>
          </div>

          {/* The third line: Email domain name suffix */}
          {domainCounts.length > 0 && (
            <div className="flex items-start gap-2 mt-2">
              <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{isEn ? 'Domain:' : 'domain name:'}</span>
              <div className="flex flex-wrap gap-1">
                {visibleDomains.map(([domain, count]) => {
                  const isActive = filter.emailDomains?.includes(domain)
                  return (
                    <button
                      key={domain}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => toggleArrayFilter('emailDomains', domain)}
                    >
                      @{domain}({count})
                    </button>
                  )
                })}
                {domainCounts.length > DOMAIN_DISPLAY_LIMIT && (
                  <button
                    className="px-2 py-0.5 text-xs rounded border hover:bg-muted text-muted-foreground transition-colors"
                    onClick={() => setShowAllDomains(!showAllDomains)}
                  >
                    {showAllDomains
                      ? (isEn ? 'Less' : 'close')
                      : `+${domainCounts.length - DOMAIN_DISPLAY_LIMIT}`}
                  </button>
                )}
              </div>
            </div>
          )}
    </div>
  )
}
