import { memo, useState, useMemo, useCallback } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Badge, Button } from '../ui'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import {
  Check,
  RefreshCw,
  Trash2,
  Edit,
  Info,
  AlertCircle,
  Power,
  LogOut,
  RotateCcw,
  ExternalLink,
  Loader2,
  Clock,
  KeyRound,
  FolderOpen,
  Copy
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  toRgba,
  generateRowGlowStyle,
  unauthorizedRowStyle,
  getSubscriptionColor,
  getStatusBadgeClass,
  StatusLabelsZh,
  StatusLabelsEn,
  formatTokenExpiry,
  isBannedError
} from './_helpers'

interface AccountListRowProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  onEdit: () => void
  onShowDetail: () => void
}

// Compact list row — visual alignment AccountCard
// high ~72px, rounded corners + Streamer border + label halo + Banned red background
function AccountListRowComponent({
  account,
  tags,
  groups,
  isSelected,
  onEdit,
  onShowDetail
}: AccountListRowProps): React.ReactNode {
  const {
    setActiveAccount,
    removeAccount,
    checkAccountStatus,
    refreshAccountToken,
    toggleSelection,
    maskEmail,
    maskNickname,
    usagePrecision,
    updateAccountStatus,
    accountProxyBindings,
    proxyPool,
    unbindAccountFromProxy
  } = useAccountsStore()

  // The agent bound to the account (if any)
  const boundProxy = useMemo(() => {
    const proxyId = accountProxyBindings[account.id]
    if (!proxyId) return null
    return proxyPool.get(proxyId) || null
  }, [accountProxyBindings, account.id, proxyPool])

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isClearingSuspended, setIsClearingSuspended] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)

  // Ban decision
  const isUnauthorized = isBannedError(account.lastError)

  // Label
  const accountTags = useMemo(
    () => (account.tags || []).map(id => tags.get(id)).filter((t): t is AccountTag => !!t),
    [account.tags, tags]
  )
  const tagColors = useMemo(() => accountTags.map(t => t.color), [accountTags])

  // Group
  const accountGroup = useMemo(() => {
    if (!account.groupId) return null
    return groups.get(account.groupId) || null
  }, [account.groupId, groups])

  // Display name (nickname takes precedence) + privacy mode mask）
  const displayName = useMemo(() => {
    if (account.nickname) return maskNickname(account.nickname)
    return maskEmail(account.email)
  }, [account.nickname, account.email, maskEmail, maskNickname])

  const maskedEmail = useMemo(() => maskEmail(account.email), [account.email, maskEmail])

  // Credits
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }
  const percentUsed = account.usage.percentUsed * 100
  const isHighUsage = percentUsed > 80
  const isCritical = percentUsed > 100

  // maturity
  const daysRemaining = account.subscription.daysRemaining
  const isExpiringSoon = daysRemaining !== undefined && daysRemaining <= 7
  const isTokenExpiringSoon =
    account.credentials.expiresAt !== undefined &&
    account.credentials.expiresAt - Date.now() < 5 * 60 * 1000

  // === Row outer style synthesis ===
  // Priority:active streamer > ban red > label halo
  const rowStyle = useMemo(() => {
    if (account.isActive) return {} // active-glow-border class deal with
    if (isUnauthorized) return unauthorizedRowStyle
    if (tagColors.length > 0) return generateRowGlowStyle(tagColors)
    return {}
  }, [account.isActive, isUnauthorized, tagColors])

  // === Handlers ===
  const handleSwitch = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    const { credentials } = account
    const { switchTarget } = useAccountsStore.getState()

    if (!credentials.refreshToken) {
      alert(isEn ? 'Incomplete credentials, cannot switch' : 'The account credentials are incomplete and cannot be switched.')
      return
    }
    if (credentials.authMethod !== 'social' && (!credentials.clientId || !credentials.clientSecret)) {
      alert(isEn ? 'Incomplete credentials, cannot switch' : 'The account credentials are incomplete and cannot be switched.')
      return
    }

    const cliPayload = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      region: credentials.region || 'us-east-1',
      profileArn: account.profileArn,
      provider: credentials.provider
    }
    const idePayload = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId || '',
      clientSecret: credentials.clientSecret || '',
      region: credentials.region || 'us-east-1',
      startUrl: credentials.startUrl,
      authMethod: credentials.authMethod,
      provider: credentials.provider,
      profileArn: account.profileArn,
      accountId: account.id
    }

    let success = true
    let errorMsg = ''
    const target = switchTarget || 'ide'
    if (target === 'ide' || target === 'both') {
      const result = await window.api.switchAccount(idePayload)
      if (!result.success) {
        success = false
        errorMsg = result.error || ''
      } else if (result.refreshedCredentials) {
        // synchronous main process refresh Latest after credentials arrive store, to avoid counter-generation store Leave the voided refreshToken
        const rc = result.refreshedCredentials
        useAccountsStore.setState((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(account.id)
          if (acc) {
            accounts.set(account.id, {
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
        useAccountsStore.getState().saveToStorage()
      }
    }
    if (target === 'cli' || target === 'both') {
      const result = await window.api.switchAccountCli(cliPayload)
      if (!result.success && target === 'cli') { success = false; errorMsg = result.error || '' }
    }

    if (success) {
      setActiveAccount(account.id)
    } else {
      alert(isEn ? `Switch failed: ${errorMsg}` : `Switch failed:${errorMsg}`)
    }
  }, [account, isEn, setActiveAccount])

  const handleRefresh = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await refreshAccountToken(account.id)
      await checkAccountStatus(account.id)
    } finally {
      setIsRefreshing(false)
    }
  }, [account.id, isRefreshing, refreshAccountToken, checkAccountStatus])

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(isEn ? `Delete account "${account.email}"?` : `Confirm to delete account "${account.email}"？`)) return
    removeAccount(account.id)
  }, [account.id, account.email, isEn, removeAccount])

  const handleLogout = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(isEn ? 'Clear local SSO cache and logout from Kiro?' : 'clear local SSO Cache and exit Kiro Log in?')) return
    const result = await window.api.logoutAccount()
    if (result.success) {
      setActiveAccount(null)
    } else {
      alert(isEn ? `Logout failed: ${result.error}` : `Exit failed:${result.error}`)
    }
  }, [isEn, setActiveAccount])

  const handleClearSuspended = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isClearingSuspended) return
    setIsClearingSuspended(true)
    try {
      const result = await window.api.proxyClearAccountSuspended(account.id)
      if (result.success) {
        updateAccountStatus(account.id, 'active', undefined)
      }
    } finally {
      setIsClearingSuspended(false)
    }
  }, [account.id, isClearingSuspended, updateAccountStatus])

  const handleCopyEmail = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const text = account.email || account.userId || ''
    if (text) {
      navigator.clipboard.writeText(text)
      setEmailCopied(true)
      setTimeout(() => setEmailCopied(false), 1500)
    }
  }, [account.email, account.userId])

  // ============ rendering ============

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 pl-3 pr-3 py-2.5 rounded-xl border bg-solid-card transition-all duration-300 cursor-pointer overflow-hidden',
        'hover:shadow-md',
        account.isActive && 'active-glow-border border-transparent',
        !account.isActive && !isUnauthorized && tagColors.length === 0 && !isSelected && 'border-border'
      )}
      style={rowStyle}
      onClick={() => toggleSelection(account.id)}
    >
      {/* Selected independent overlay — Avoid being multi-tagged rowStyle of backgroundImage cover */}
      {isSelected && !account.isActive && !isUnauthorized && (
        <div className="absolute inset-0 pointer-events-none rounded-[inherit] ring-2 ring-inset ring-primary/60 bg-primary/[0.08] z-10" />
      )}

      {/* Checkbox */}
      <div
        className={cn(
          'flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors cursor-pointer',
          isSelected
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-muted-foreground/30 hover:border-primary'
        )}
        onClick={(e) => { e.stopPropagation(); toggleSelection(account.id) }}
      >
        {isSelected && <Check className="h-3 w-3" />}
      </div>

      {/* === Email column (fixed 280px） === */}
      <div className="w-[280px] flex-shrink-0 flex flex-col gap-1 min-w-0">
        {/* Uplink: Email/Nick name + Deputy mailbox */}
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={cn(
              'font-semibold text-sm truncate cursor-pointer transition-colors min-w-0',
              emailCopied ? 'text-success' : 'text-foreground/90 hover:text-primary'
            )}
            title={`${displayName} (${isEn ? 'Click to copy' : 'Click to copy'})`}
            onClick={handleCopyEmail}
          >
            {emailCopied ? (isEn ? 'Copied!' : 'Copied!') : displayName}
          </h3>
          {account.nickname && (
            <span className="text-xs text-muted-foreground truncate min-w-0" title={account.email}>
              {maskedEmail}
            </span>
          )}
        </div>

        {/* Downstream: grouping + Label + mistake + copy */}
        <div className="flex items-center gap-1.5 min-w-0 text-[10px] overflow-hidden">
          {accountGroup && (
            <span
              className="px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
              style={{ color: accountGroup.color, backgroundColor: accountGroup.color + '15' }}
            >
              <FolderOpen className="w-3 h-3" />
              {accountGroup.name}
            </span>
          )}
          {accountTags.slice(0, 4).map(tag => {
            const tagColor = toRgba(tag.color)
            return (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 rounded-md font-medium flex-shrink-0 border"
                style={{
                  backgroundColor: tagColor.replace(/[\d.]+\)$/, '0.12)'),
                  color: tagColor,
                  borderColor: tagColor.replace(/[\d.]+\)$/, '0.30)')
                }}
              >
                {tag.name}
              </span>
            )
          })}
          {accountTags.length > 4 && (
            <span className="px-1.5 py-0.5 text-muted-foreground bg-muted rounded-sm flex-shrink-0">
              +{accountTags.length - 4}
            </span>
          )}

          {/* Error message (not a ban since the ban is shown with a red badge) */}
          {account.lastError && !isUnauthorized && (
            <span className="text-destructive truncate flex-1 min-w-0 italic" title={account.lastError}>
              {account.lastError}
            </span>
          )}

          {/* Copy mailbox icon */}
          {!account.nickname && (
            <button
              type="button"
              onClick={handleCopyEmail}
              className="ml-auto text-muted-foreground/60 hover:text-primary transition-colors flex-shrink-0"
              title={isEn ? 'Copy email' : 'Copy mailbox'}
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* === Fixed column for badges (fitted closely to the mailbox column, each badge is equal width to ensure alignment across rows) === */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {/* status badge (min-w Keep the same width) */}
        <div
          className={cn(
            'text-[10px] font-medium h-5 px-2 rounded-full flex items-center justify-center gap-1 min-w-[52px]',
            getStatusBadgeClass(account.status, isUnauthorized)
          )}
        >
          {account.status === 'refreshing' && <Loader2 className="h-3 w-3 animate-spin" />}
          {isUnauthorized && <AlertCircle className="h-3 w-3" />}
          {isUnauthorized ? (
            <span
              className="cursor-pointer hover:underline"
              onClick={(e) => { e.stopPropagation(); onShowDetail() }}
            >
              {isEn ? 'Banned' : 'Banned'}
            </span>
          ) : (
            (isEn ? StatusLabelsEn : StatusLabelsZh)[account.status] || account.status
          )}
        </div>

        {/* Subscribe Badge (min-w Keep the same width,PRO+/FREE visual alignment) */}
        <Badge
          className={cn(
            'text-white text-[10px] h-5 px-2 border-0 min-w-[90px] flex items-center justify-center',
            getSubscriptionColor(account.subscription.type, account.subscription.title)
          )}
        >
          {account.subscription.title || account.subscription.type}
        </Badge>

        {/* IDP(Fixed width, all accounts are visually aligned) */}
        <Badge
          variant="outline"
          className="text-[10px] h-5 px-1.5 text-muted-foreground font-normal border-muted-foreground/30 bg-muted/30 min-w-[72px] flex items-center justify-center"
        >
          {account.idp}
        </Badge>

        {/* Agent binding badge: click to unbind (only displayed when bound) */}
        {boundProxy && (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] h-5 px-1.5 font-normal cursor-pointer group transition-colors',
              boundProxy.enabled && boundProxy.status !== 'dead'
                ? 'border-cyan-500/40 text-cyan-700 dark:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20'
                : 'border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10'
            )}
            title={`${isEn ? 'Bound proxy:' : 'Bind proxy:'} ${boundProxy.host}:${boundProxy.port}${boundProxy.label ? ` (${boundProxy.label})` : ''}\n${isEn ? 'Click to unbind' : 'Click to unbind'}`}
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(isEn
                ? `Unbind ${account.email} from ${boundProxy.host}:${boundProxy.port}?`
                : `unbundle ${account.email} and ${boundProxy.host}:${boundProxy.port}？`
              )) {
                unbindAccountFromProxy(account.id)
              }
            }}
          >
            <span className="opacity-70 group-hover:hidden">⇄</span>
            <span className="hidden group-hover:inline">✕</span>
            <span className="ml-0.5 max-w-[80px] truncate inline-block align-middle">
              {boundProxy.host}
            </span>
          </Badge>
        )}

        {/* Active Container (always retains width, ensuring subsequent elements are positioned at a fixed location) */}
        <div className="w-[60px] flex items-center">
          {account.isActive && (
            <Badge className="h-5 px-2 bg-success text-white border-0 hover:bg-success/90 text-[10px] flex items-center justify-center w-full">
              <Power className="h-2.5 w-2.5 mr-0.5" />
              {isEn ? 'Active' : 'current'}
            </Badge>
          )}
        </div>
      </div>

      {/* === Flexible interval (eating remaining space) === */}
      <div className="flex-1 min-w-0" />

      {/* === Credits District (middle right) === */}
      <div className="flex-shrink-0 w-40 flex flex-col gap-0.5 px-2">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">{isEn ? 'Usage' : 'Usage'}</span>
          <span className={cn(
            'font-mono font-medium tabular-nums',
            isCritical ? 'text-destructive' : isHighUsage ? 'text-warning' : 'text-foreground'
          )}>
            {percentUsed.toFixed(usagePrecision ? 2 : 0)}%
            {isCritical && (
              <span className="ml-1 text-[9px] text-destructive font-semibold">
                +{(percentUsed - 100).toFixed(usagePrecision ? 2 : 0)}%
              </span>
            )}
          </span>
        </div>
        {(() => {
          if (isCritical) {
            const planRatioPct = (100 / percentUsed) * 100
            return (
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div className="absolute inset-y-0 left-0 bg-warning transition-all duration-300" style={{ width: `${planRatioPct}%` }} />
                <div className="absolute inset-y-0 right-0 bg-destructive transition-all duration-300" style={{ left: `${planRatioPct}%` }} />
              </div>
            )
          }
          return (
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className={cn('absolute inset-y-0 left-0 transition-all duration-300', isHighUsage ? 'bg-warning' : 'bg-primary')}
                style={{ width: `${Math.min(percentUsed, 100)}%` }}
              />
            </div>
          )
        })()}
        <div className="flex justify-between text-[9px] text-muted-foreground pt-0.5">
          <span className={cn(isCritical && 'text-destructive font-semibold')}>
            {formatUsage(account.usage.current)}
            {isCritical && ` (+${formatUsage(account.usage.current - account.usage.limit)})`}
          </span>
          <span>/ {formatUsage(account.usage.limit)}</span>
        </div>
      </div>

      {/* === Time information area === */}
      <div className="flex-shrink-0 hidden lg:flex flex-col leading-tight gap-0.5 text-[10px] text-muted-foreground w-28">
        <div className="flex items-center gap-1" title={isEn ? 'Subscription days left' : 'Number of days remaining in subscription'}>
          <Clock className="h-3 w-3" />
          <span className={isExpiringSoon ? 'text-warning font-medium' : ''}>
            {daysRemaining !== undefined ? (isEn ? `${daysRemaining}d` : `${daysRemaining}sky`) : '-'}
          </span>
        </div>
        <div
          className="flex items-center gap-1"
          title={account.credentials.expiresAt
            ? new Date(account.credentials.expiresAt).toLocaleString(isEn ? 'en-US' : 'zh-CN')
            : (isEn ? 'Unknown' : 'unknown')
          }
        >
          <KeyRound className="h-3 w-3" />
          <span className={isTokenExpiringSoon ? 'text-destructive font-medium' : ''}>
            {account.credentials.expiresAt ? formatTokenExpiry(account.credentials.expiresAt, isEn) : '-'}
          </span>
        </div>
      </div>

      {/* === operating area (hover show) === */}
      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 border-l border-border/40 pl-2 ml-1">
        {isUnauthorized && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-warning hover:bg-warning/10"
              onClick={handleClearSuspended}
              disabled={isClearingSuspended}
              title={isEn ? 'Reset Suspended' : 'Reset ban status'}
            >
              {isClearingSuspended ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </Button>
            <a
              href="https://support.aws.amazon.com/#/contacts/kiro"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-primary/10"
              onClick={(e) => e.stopPropagation()}
              title={isEn ? 'Contact Support' : 'Contact support'}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </>
        )}

        {!account.isActive && !isUnauthorized && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 hover:bg-primary/10 hover:text-primary"
            onClick={handleSwitch}
            title={isEn ? 'Switch to this account' : 'Switch to this account'}
          >
            <Power className="h-3.5 w-3.5" />
          </Button>
        )}

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
          disabled={isRefreshing || account.status === 'refreshing'}
          title={isEn ? 'Check account info' : 'Check account information'}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onShowDetail() }}
          title={isEn ? 'Details' : 'Details'}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          title={isEn ? 'Edit' : 'edit'}
        >
          <Edit className="h-3.5 w-3.5" />
        </Button>

        {account.isActive ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive"
            onClick={handleLogout}
            title={isEn ? 'Logout (clear SSO cache)' : 'Log out (clear SSO cache)'}
          >
            <LogOut className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDelete}
            title={isEn ? 'Delete' : 'delete'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Banned corner mark (same style as the card) */}
      {account.isActive && isUnauthorized && (
        <div className="banned-badge" title={isEn ? 'Banned' : 'Banned'} />
      )}
    </div>
  )
}

export const AccountListRow = memo(AccountListRowComponent)
