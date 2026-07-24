import { memo, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Card, CardContent, Badge, Button } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import {
  Check,
  RefreshCw,
  Trash2,
  Edit,
  Copy,
  AlertTriangle,
  Clock,
  Loader2,
  Info,
  FolderOpen,
  Power,
  Calendar,
  AlertCircle,
  KeyRound,
  X,
  ExternalLink,
  CreditCard,
  Sparkles,
  LogOut,
  RotateCcw
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

// Generate label halo style
function generateGlowStyle(tagColors: string[]): React.CSSProperties {
  if (tagColors.length === 0) return {}
  
  if (tagColors.length === 1) {
    const color = toRgba(tagColors[0])
    const colorTransparent = color.replace('1)', '0.15)') // Reduce shadow transparency
    return {
      boxShadow: `0 0 0 1px ${color}, 0 4px 12px -2px ${colorTransparent}`
    }
  }
  
  // When using multiple labels, use the gradient border effect
  const gradientColors = tagColors.map((c, i) => {
    const percent = (i / tagColors.length) * 100
    const nextPercent = ((i + 1) / tagColors.length) * 100
    return `${toRgba(c)} ${percent}%, ${toRgba(c)} ${nextPercent}%`
  }).join(', ')
  
  return {
    background: `linear-gradient(var(--card-solid), var(--card-solid)) padding-box, linear-gradient(135deg, ${gradientColors}) border-box`,
    border: '1.5px solid transparent',
    boxShadow: '0 4px 12px -2px rgba(0, 0, 0, 0.05)'
  }
}

interface AccountCardProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  onSelect: () => void
  onEdit: () => void
  onShowDetail: () => void
}

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

const StatusLabelsZh: Record<string, string> = {
  active: 'normal',
  expired: 'Expired',
  error: 'mistake',
  refreshing: 'Refreshing',
  unknown: 'unknown'
}

const StatusLabelsEn: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  error: 'Error',
  refreshing: 'Refreshing',
  unknown: 'Unknown'
}

// Get the account display name: nickname first, if not, then email address, if no email address, then userId
function getDisplayName(account: Account): string {
  if (account.nickname) return account.nickname
  if (account.email) return account.email
  if (account.userId) return account.userId
  return 'Unknown'
}

// format Token Expiration time
function formatTokenExpiry(expiresAt: number, isEn: boolean): string {
  const now = Date.now()
  const diff = expiresAt - now
  
  if (diff <= 0) return isEn ? 'Expired' : 'Expired'
  
  const minutes = Math.floor(diff / (60 * 1000))
  const hours = Math.floor(diff / (60 * 60 * 1000))
  
  if (minutes < 60) {
    return isEn ? `${minutes}m` : `${minutes} minute`
  } else if (hours < 24) {
    const remainingMinutes = minutes % 60
    return isEn 
      ? (remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`)
      : (remainingMinutes > 0 ? `${hours} Hour ${remainingMinutes} point` : `${hours} Hour`)
  } else {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return isEn
      ? (remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`)
      : (remainingHours > 0 ? `${days} sky ${remainingHours} Hour` : `${days} sky`)
  }
}

export const AccountCard = memo(function AccountCard({
  account,
  tags,
  groups,
  isSelected,
  onSelect,
  onEdit,
  onShowDetail
}: AccountCardProps) {
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

  // Unblocking mark (loading state)
  const [isClearingSuspended, setIsClearingSuspended] = useState(false)

  // Manually unblock the block mark: call the backend IPC → Qing anti-generation pool suspended + Clean the front end lastError
  const handleClearSuspended = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isClearingSuspended) return
    setIsClearingSuspended(true)
    try {
      const result = await window.api.proxyClearAccountSuspended(account.id)
      if (result.success) {
        // front end store synchronous:status → active, lastError → undefined
        updateAccountStatus(account.id, 'active', undefined)
        setShowBanDialog(false)
      } else {
        console.error('[AccountCard] Clear suspended failed:', result.error)
      }
    } catch (err) {
      console.error('[AccountCard] Clear suspended error:', err)
    } finally {
      setIsClearingSuspended(false)
    }
  }

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // Format usage values
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }

  const handleSwitch = async (): Promise<void> => {
    const { credentials } = account
    const { switchTarget } = useAccountsStore.getState()
    
    // Social login only requires refreshToken，IdC Login required clientId and clientSecret
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

    // according to switchTarget Settings determine switching target
    if (switchTarget === 'ide' || switchTarget === 'both') {
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
    if (switchTarget === 'cli' || switchTarget === 'both') {
      const result = await window.api.switchAccountCli(cliPayload)
      if (!result.success && switchTarget === 'cli') { success = false; errorMsg = result.error || '' }
    }

    if (success) {
      setActiveAccount(account.id)
    } else {
      alert(isEn ? `Switch failed: ${errorMsg}` : `Switch failed: ${errorMsg}`)
    }
  }

  const handleRefresh = async (): Promise<void> => {
    // Get the latest usage data
    await checkAccountStatus(account.id)
  }

  const handleLogout = async (): Promise<void> => {
    if (!confirm(isEn ? 'This will clear local SSO cache and logout from Kiro. Continue?' : 'This will clear the local SSO Cache and exit Kiro Log in, continue?')) {
      return
    }
    
    const result = await window.api.logoutAccount()
    if (result.success) {
      // Cancel the activation status of the current account
      setActiveAccount(null)
      alert(isEn ? `Logged out successfully, cleared ${result.deletedCount} cache files` : `Exit successfully, cleared ${result.deletedCount} cache files`)
    } else {
      alert(isEn ? `Logout failed: ${result.error}` : `Exit failed: ${result.error}`)
    }
  }

  const [isRefreshingToken, setIsRefreshingToken] = useState(false)
  const handleRefreshToken = async (): Promise<void> => {
    setIsRefreshingToken(true)
    try {
      await refreshAccountToken(account.id)
    } finally {
      setIsRefreshingToken(false)
    }
  }

  const handleDelete = (): void => {
    if (confirm(isEn ? `Delete account ${getDisplayName(account)}?` : `Confirm to delete account ${getDisplayName(account)} ?`)) {
      removeAccount(account.id)
    }
  }

  const [copied, setCopied] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)

  const handleCopyCredentials = (): void => {
    const credentials = {
      accessToken: account.credentials.accessToken,
      refreshToken: account.credentials.refreshToken,
      clientId: account.credentials.clientId,
      clientSecret: account.credentials.clientSecret
    }
    navigator.clipboard.writeText(JSON.stringify(credentials, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const accountTags = account.tags
    .map((id) => tags.get(id))
    .filter((t): t is AccountTag => t !== undefined)

  // Get group information
  const accountGroup = account.groupId ? groups.get(account.groupId) : undefined

  // Generate halo style
  const glowStyle = useMemo(() => {
    const tagColors = accountTags.map(t => t.color)
    return generateGlowStyle(tagColors)
  }, [accountTags])

  const isExpiringSoon = account.subscription.daysRemaining !== undefined &&
                         account.subscription.daysRemaining <= 7

  // percentUsed yes 0~1 decimal (such as 0.85 = 85%),overtake 1 express >100%
  const isHighUsage = account.usage.percentUsed > 0.8
  const isCritical = account.usage.percentUsed > 1

  // Check if account is banned/Pause (various error formats)
  const lowerError = account.lastError?.toLowerCase()
  const isUnauthorized = !!lowerError && (
    lowerError.includes('accountsuspendedexception') ||
    lowerError.includes('account suspended') ||
    lowerError.includes('temporarily_suspended') ||
    lowerError.includes('temporarily suspended') ||
    (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
    lowerError.includes('Account has been banned') ||
    lowerError.includes('Banned') ||
    /\b423\b/.test(lowerError)
  )
  
  // Banning details popup status
  const [showBanDialog, setShowBanDialog] = useState(false)
  
  // Subscription management pop-up status
  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false)
  const [subscriptionLoading, setSubscriptionLoading] = useState(false)
  const [subscriptionPlans, setSubscriptionPlans] = useState<Array<{
    name: string
    qSubscriptionType: string
    description: { title: string; billingInterval: string; featureHeader: string; features: string[] }
    pricing: { amount: number; currency: string }
  }>>([])
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [paymentLoading, setPaymentLoading] = useState(false)

  // Whether you are a first-time user (need to select subscription type)
  const [isFirstTimeUser, setIsFirstTimeUser] = useState(false)
  // Subscribe to error messages
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  // Subscription success prompt
  const [subscriptionSuccess, setSubscriptionSuccess] = useState<string | null>(null)

  // Click the Subscriptions tab to open subscription management
  const handleSubscriptionClick = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (subscriptionLoading || !account.credentials?.accessToken) return
    
    setSubscriptionLoading(true)
    try {
      // Get the list of available subscriptions first
      const result = await window.api.accountGetSubscriptions(account.credentials.accessToken, account.credentials?.region, account.profileArn, account.machineId, account.credentials?.provider || account.idp, account.credentials?.authMethod, account.id)
      if (result.success && result.plans.length > 0) {
        setSubscriptionPlans(result.plans)
        // Check if this is a first time user (current subscription type is FREE or no subscription)
        const currentType = account.subscription.type?.toUpperCase() || ''
        const isFirstTime = currentType === '' || currentType.includes('FREE')
        setIsFirstTimeUser(isFirstTime)
        setShowSubscriptionDialog(true)
      } else {
        console.error('[AccountCard] Failed to get subscriptions:', result.error)
      }
    } catch (error) {
      console.error('[AccountCard] Subscription click error:', error)
    } finally {
      setSubscriptionLoading(false)
    }
  }

  // Choose a subscription plan and get payment link
  const handleSelectPlan = async (planName: string): Promise<void> => {
    if (paymentLoading || !account.credentials?.accessToken) return
    
    setSelectedPlan(planName)
    setPaymentLoading(true)
    setSubscriptionError(null)
    try {
      const result = await window.api.accountGetSubscriptionUrl(account.credentials.accessToken, planName, account.credentials?.region, account.profileArn, account.machineId, account.credentials?.provider || account.idp, account.credentials?.authMethod, account.id)
      if (result.success && result.url) {
        // Automatically copy link to clipboard
        await navigator.clipboard.writeText(result.url)
        // Show copy success prompt
        setSubscriptionSuccess(isEn ? 'Link copied to clipboard!' : 'Link copied to clipboard!')
        // After a short display, close the pop-up window and open the link
        const urlToOpen = result.url
        setTimeout(async () => {
          setShowSubscriptionDialog(false)
          setSubscriptionSuccess(null)
          await window.api.openSubscriptionWindow(urlToOpen)
        }, 800)
      } else {
        const errorMsg = result.error || (isEn ? 'Failed to get payment URL' : 'Failed to obtain payment link')
        setSubscriptionError(errorMsg)
        console.error('[AccountCard] Failed to get payment URL:', result.error)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : (isEn ? 'Unknown error' : 'unknown error')
      setSubscriptionError(errorMsg)
      console.error('[AccountCard] Payment URL error:', error)
    } finally {
      setPaymentLoading(false)
      setSelectedPlan(null)
    }
  }

  // Get subscription management link (already subscribed user)
  const handleManageSubscription = async (): Promise<void> => {
    if (paymentLoading || !account.credentials?.accessToken) return
    
    setPaymentLoading(true)
    setSubscriptionError(null)
    try {
      const result = await window.api.accountGetSubscriptionUrl(account.credentials.accessToken, undefined, account.credentials?.region, account.profileArn, account.machineId, account.credentials?.provider || account.idp, account.credentials?.authMethod, account.id)
      if (result.success && result.url) {
        setShowSubscriptionDialog(false)
        await window.api.openSubscriptionWindow(result.url)
      } else {
        // Show error message
        const errorMsg = result.error || (isEn ? 'Failed to get management URL' : 'Failed to get management link')
        setSubscriptionError(errorMsg)
        console.error('[AccountCard] Failed to get management URL:', result.error)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : (isEn ? 'Unknown error' : 'unknown error')
      setSubscriptionError(errorMsg)
      console.error('[AccountCard] Management URL error:', error)
    } finally {
      setPaymentLoading(false)
    }
  }

  // Ban status style (red)- highest priority
  const unauthorizedStyle: React.CSSProperties = isUnauthorized ? {
    backgroundColor: 'var(--card-unauthorized-bg)',
    borderColor: 'var(--card-unauthorized-border)',
    boxShadow: `
      0 0 0 1px var(--card-unauthorized-ring),
      0 4px 20px -2px var(--card-unauthorized-shadow),
      inset 0 0 20px var(--card-unauthorized-glow)
    `
  } : {}

  // Currently used high-end style - Only the outer glow is retained when the streamer border is used
  const activeGlowStyle: React.CSSProperties = account.isActive ? {
    boxShadow: '0 8px 24px -4px var(--card-active-shadow)'
  } : {}

  // Final style merge logic
  let finalStyle: React.CSSProperties = {}
  
  if (account.isActive) {
    // Current use (including bans)+Currently used): Streamer Border + External glow, bans are displayed through corner markers
    finalStyle = { ...glowStyle, ...activeGlowStyle }
  } else if (isUnauthorized) {
    // Ban status only: Show full ban style
    finalStyle = unauthorizedStyle
  } else {
    // Normal state: only display label halo
    finalStyle = glowStyle
  }

  return (
    <Card
      className={cn(
        'relative cursor-pointer h-full flex flex-col overflow-hidden bg-solid-card',
        // default hover float + Shadow enhancement (except active/Except for the banned state, the state has its own style)
        !account.isActive && !isUnauthorized && 'hover-lift',
        // Current use: streamer border, remove default border
        account.isActive && 'border-transparent active-glow-border',
        // Banned: red border
        isUnauthorized && 'border-destructive/50',
        // There is a halo of tags: transparent borders give way to halos
        accountTags.length > 0 && !account.isActive && !isUnauthorized && 'border-transparent'
      )}
      style={finalStyle}
      onClick={() => toggleSelection(account.id)}
    >
      {/* Selected independent overlay — Avoid being haloed by labels inline style (box-shadow/background) cover
          z-10 Above the card content,pointer-events-none Let the interaction penetrate Card */}
      {isSelected && !account.isActive && !isUnauthorized && (
        <div className="absolute inset-0 pointer-events-none rounded-[inherit] ring-2 ring-inset ring-primary/60 bg-primary/[0.08] z-10" />
      )}

      {/* ban corner mark - Shown on streamer border when currently in use */}
      {account.isActive && isUnauthorized && (
        <div className="banned-badge" title={t('accounts.card.banned')} />
      )}
      <CardContent className="p-4 flex-1 flex flex-col gap-3 overflow-hidden">
        {/* Header: Checkbox, Email/Nickname, Group */}
        <div className="flex gap-3 items-start">
           {/* Checkbox */}
           <div
            className={cn(
              'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 mt-0.5 cursor-pointer',
              isSelected
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-muted-foreground/30 hover:border-primary'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onSelect()
            }}
          >
            {isSelected && <Check className="h-3.5 w-3.5" />}
          </div>

           <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                 <h3 
                   className={cn(
                     "font-semibold text-sm truncate cursor-pointer transition-colors",
                     emailCopied ? "text-success" : "text-foreground/90 hover:text-primary"
                   )}
                   title={`${getDisplayName(account)} (${isEn ? 'Click to copy' : 'Click to copy'})`}
                   onClick={(e) => {
                     e.stopPropagation()
                     const text = account.email || account.userId || ''
                     if (text) {
                       navigator.clipboard.writeText(text)
                       setEmailCopied(true)
                       setTimeout(() => setEmailCopied(false), 1500)
                     }
                   }}
                 >{emailCopied ? (isEn ? 'Copied!' : 'Copied!') : (account.email ? maskEmail(account.email) : getDisplayName(account))}</h3>
                 {/* Status Badge */}
                 <div className={cn(
                    "text-[10px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0",
                    isUnauthorized ? "text-destructive bg-destructive/10" :
                    account.status === 'active' ? "text-success bg-success/10" :
                    account.status === 'error' ? "text-destructive bg-destructive/10" :
                    account.status === 'expired' ? "text-warning bg-warning/10" :
                    account.status === 'refreshing' ? "text-primary bg-primary/10" :
                    "text-muted-foreground bg-muted"
                 )}>
                    {account.status === 'refreshing' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {isUnauthorized && <AlertCircle className="h-3 w-3" />}
                    {isUnauthorized ? (
                      <span 
                        className="cursor-pointer hover:underline" 
                        onClick={(e) => { e.stopPropagation(); setShowBanDialog(true); }}
                      >
                        {isEn ? 'Banned' : 'Banned'}
                      </span>
                    ) : (isEn ? StatusLabelsEn : StatusLabelsZh)[account.status]}
                 </div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                  {account.nickname && <span className="text-xs text-muted-foreground truncate">{maskNickname(account.nickname)}</span>}
                  {accountGroup && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1"
                      style={{ color: accountGroup.color, backgroundColor: accountGroup.color + '15' }}
                    >
                      <FolderOpen className="w-3 h-3" /> {accountGroup.name}
                    </span>
                  )}
              </div>
           </div>
        </div>

        {/* Badges Row */}
        <div className="flex items-center gap-2 flex-wrap">
            <Badge 
              className={cn(
                'text-white text-[10px] h-5 px-2 border-0 cursor-pointer transition-all hover:opacity-80 hover:scale-105',
                getSubscriptionColor(account.subscription.type, account.subscription.title),
                subscriptionLoading && 'opacity-60 cursor-wait'
              )}
              onClick={handleSubscriptionClick}
              title={isEn ? 'Click to manage subscription' : 'Click Manage Subscriptions'}
            >
                {subscriptionLoading ? (isEn ? 'Loading...' : 'loading...') : (account.subscription.title || account.subscription.type)}
            </Badge>
            <Badge variant="outline" className="text-[10px] h-5 px-2 text-muted-foreground font-normal border-muted-foreground/30 bg-muted/30">
                {account.idp}
            </Badge>
            {/* Agent binding badge: click to unbind */}
            {boundProxy && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] h-5 px-1.5 font-normal cursor-pointer transition-colors group',
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
                <span className="ml-0.5">{boundProxy.host.length > 15 ? boundProxy.host.slice(0, 12) + '…' : boundProxy.host}</span>
              </Badge>
            )}
            {account.isActive && (
              <Badge variant="default" className="ml-auto h-5 bg-success text-white border-0 hover:bg-success/90">
                {isEn ? 'Active' : 'currently in use'}
              </Badge>
            )}
        </div>

        {/* Usage Section */}
        <div className="bg-muted/30 p-3 rounded-lg space-y-2 border border-border/50">
            <div className="flex justify-between items-end text-xs">
                <span className="text-muted-foreground font-medium">{isEn ? 'Usage' : 'Usage'}</span>
                <span className={cn(
                  "font-mono font-medium tabular-nums",
                  isCritical ? "text-destructive" : isHighUsage ? "text-warning" : "text-foreground"
                )}>
                   {(account.usage.percentUsed * 100).toFixed(usagePrecision ? 2 : 0)}%
                   {isCritical && (
                     <span className="ml-1.5 text-[10px] text-red-600 font-semibold">
                       (+{((account.usage.percentUsed - 1) * 100).toFixed(usagePrecision ? 2 : 0)}% {isEn ? 'over' : 'overtake'})
                     </span>
                   )}
                </span>
            </div>
            {/* Customized double-layer progress bar: Display the package in segments when overage (amber）+ excess (red） */}
            {(() => {
              const percent = account.usage.percentUsed
              if (isCritical) {
                // The proportion of the package part to the total progress = 1 / percent
                const planRatioPct = (1 / percent) * 100
                return (
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="absolute inset-y-0 left-0 bg-warning transition-all duration-300"
                      style={{ width: `${planRatioPct}%` }}
                    />
                    <div
                      className="absolute inset-y-0 right-0 bg-red-500 transition-all duration-300"
                      style={{ left: `${planRatioPct}%` }}
                    />
                  </div>
                )
              }
              return (
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 transition-all duration-300",
                      isHighUsage ? "bg-warning" : "bg-primary"
                    )}
                    style={{ width: `${Math.min(percent * 100, 100)}%` }}
                  />
                </div>
              )
            })()}
            <div className="flex justify-between text-[10px] text-muted-foreground pt-0.5">
                <span className="flex items-center gap-1.5">
                  <span>{formatUsage(account.usage.current)} / {formatUsage(account.usage.limit)}</span>
                  {isCritical && (
                    <span className="text-red-600 font-semibold">
                      (+{formatUsage(account.usage.current - account.usage.limit)})
                    </span>
                  )}
                </span>
                {account.usage.nextResetDate && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                     {(() => {
                      const d = account.usage.nextResetDate as unknown
                      try {
                         return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0]
                      } catch { return 'Unknown' }
                    })()} {isEn ? 'reset' : 'reset'}
                  </span>
                )}
            </div>
        </div>

        {/* Detailed Quotas - Compact list */}
        <div className="space-y-1.5 min-h-0 overflow-y-auto pr-1 text-[10px] max-h-24">
           {/* Basic amount */}
           {account.usage.baseLimit !== undefined && account.usage.baseLimit > 0 && (
             <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
               <span className="text-muted-foreground">{isEn ? 'Base:' : 'Base:'}</span>
               <span className="font-medium">{formatUsage(account.usage.baseCurrent ?? 0)}/{formatUsage(account.usage.baseLimit)}</span>
               {account.usage.nextResetDate && (
                 <span className="text-muted-foreground/70 ml-auto">
                   {isEn ? 'to' : 'to'} {(() => {
                      const d = account.usage.nextResetDate as unknown
                      try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                   })()}
                 </span>
               )}
             </div>
           )}
           {/* Trial amount */}
           {account.usage.freeTrialLimit !== undefined && account.usage.freeTrialLimit > 0 && (
             <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" />
               <span className="text-muted-foreground">{isEn ? 'Trial:' : 'try out:'}</span>
               <span className="font-medium">{formatUsage(account.usage.freeTrialCurrent ?? 0)}/{formatUsage(account.usage.freeTrialLimit)}</span>
               {account.usage.freeTrialExpiry && (
                 <span className="text-muted-foreground/70 ml-auto">
                   {isEn ? 'to' : 'to'} {(() => {
                      const d = account.usage.freeTrialExpiry as unknown
                      try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                   })()}
                 </span>
               )}
             </div>
           )}
           {/* Reward amount */}
           {account.usage.bonuses?.map((bonus) => (
             <div key={bonus.code} className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
               <span className="text-muted-foreground truncate max-w-[80px]" title={bonus.name}>{bonus.name}:</span>
               <span className="font-medium">{formatUsage(bonus.current)}/{formatUsage(bonus.limit)}</span>
               {bonus.expiresAt && (
                 <span className="text-muted-foreground/70 ml-auto">
                   {isEn ? 'to' : 'to'} {(() => {
                      const d = bonus.expiresAt as unknown
                      try { return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0] } catch { return '' }
                   })()}
                 </span>
               )}
             </div>
           ))}
        </div>
        
        {/* Tags - placed before footer */}
        {accountTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-auto pt-2">
            {accountTags.slice(0, 4).map((tag) => (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 text-[10px] rounded-sm text-white font-medium shadow-sm"
                style={{ backgroundColor: toRgba(tag.color) }}
              >
                {tag.name}
              </span>
            ))}
             {accountTags.length > 4 && (
              <span className="px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded-sm">
                +{accountTags.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="pt-3 border-t flex items-center justify-between mt-auto gap-2 shrink-0">
            {/* Left: Token expiry info */}
            <div className="text-[10px] text-muted-foreground flex flex-col leading-tight gap-0.5">
                <div className="flex items-center gap-1">
                   <Clock className="h-3 w-3" />
                   <span className={isExpiringSoon ? "text-warning font-medium" : ""}>
                      {account.subscription.daysRemaining !== undefined ? (isEn ? `${account.subscription.daysRemaining}d left` : `left ${account.subscription.daysRemaining} sky`) : '-'}
                   </span>
                </div>
                <div className="flex items-center gap-1" title={account.credentials.expiresAt ? new Date(account.credentials.expiresAt).toLocaleString(isEn ? 'en-US' : 'zh-CN') : (isEn ? 'Unknown' : 'unknown')}>
                   <KeyRound className="h-3 w-3" />
                   <span className={account.credentials.expiresAt && account.credentials.expiresAt - Date.now() < 5 * 60 * 1000 ? "text-red-500 font-medium" : ""}>
                      Token: {account.credentials.expiresAt ? formatTokenExpiry(account.credentials.expiresAt, isEn) : '-'}
                   </span>
                </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-0.5">
               {account.isActive ? (
                 <Button
                   size="icon"
                   variant="ghost"
                   className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive transition-colors"
                   onClick={(e) => { e.stopPropagation(); handleLogout() }}
                   title={isEn ? 'Logout (clear SSO cache)' : 'Log out (clear SSO cache)'}
                 >
                   <LogOut className="h-3.5 w-3.5" />
                 </Button>
               ) : (
                 <Button
                   size="icon"
                   variant="ghost"
                   className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
                   onClick={(e) => { e.stopPropagation(); handleSwitch() }}
                   title={isEn ? 'Switch to this account' : 'Switch to this account'}
                 >
                   <Power className="h-3.5 w-3.5" />
                 </Button>
               )}
               
               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); handleRefresh() }} disabled={account.status === 'refreshing'} title={isEn ? 'Check account info' : 'Check account information (usage, subscriptions, ban status)'}>
                  <RefreshCw className={cn("h-3.5 w-3.5", account.status === 'refreshing' && "animate-spin")} />
               </Button>
               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); handleRefreshToken() }} disabled={isRefreshingToken} title={isEn ? 'Refresh Token' : 'refresh Token(Only refresh access token)'}>
                  <KeyRound className={cn("h-3.5 w-3.5", isRefreshingToken && "animate-pulse")} />
               </Button>
               
               <Button size="icon" variant="ghost" className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", copied && "text-success")} onClick={(e) => { e.stopPropagation(); handleCopyCredentials() }} title={isEn ? 'Copy credentials' : 'Copy credentials'}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
               </Button>

               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); onShowDetail() }} title={isEn ? 'Details' : 'Details'}>
                  <Info className="h-3.5 w-3.5" />
               </Button>
               
               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); onEdit() }} title={isEn ? 'Edit' : 'edit'}>
                  <Edit className="h-3.5 w-3.5" />
               </Button>
               
               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive transition-colors" onClick={(e) => { e.stopPropagation(); handleDelete() }} title={isEn ? 'Delete' : 'delete'}>
                  <Trash2 className="h-3.5 w-3.5" />
               </Button>
            </div>
        </div>

        {/* Error Message (Non-banned) */}
        {account.lastError && !isUnauthorized && (
          <div className="bg-red-50 text-red-600 text-[10px] p-1.5 rounded flex items-center gap-1.5 truncate mt-1" title={account.lastError}>
             <AlertTriangle className="h-3 w-3 shrink-0" />
             <span className="truncate">{account.lastError}</span>
          </div>
        )}
      </CardContent>

      {/* Ban details popup */}
      {showBanDialog && isUnauthorized && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowBanDialog(false)} />
          <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-lg m-4 animate-in fade-in zoom-in-95 duration-200 border overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between bg-red-50 dark:bg-red-900/20">
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <AlertCircle className="h-5 w-5" />
                <span className="font-bold">{isEn ? 'Account Suspended' : 'Account has been banned'}</span>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => setShowBanDialog(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-4 space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Account' : 'Account'}</label>
                <div className="text-sm font-medium">{getDisplayName(account)}</div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Error Details' : 'Error details'}</label>
                <div className="text-xs font-mono bg-muted/50 p-3 rounded-lg border break-all whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                  {account.lastError}
                </div>
              </div>
              <div className="flex items-center justify-between pt-2 gap-2 flex-wrap">
                <a 
                  href="https://support.aws.amazon.com/#/contacts/kiro" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                  {isEn ? 'Contact Support' : 'Contact support'}
                </a>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleClearSuspended}
                    disabled={isClearingSuspended}
                    title={isEn ? 'Mark as recovered — proxy pool will use this account again' : 'Mark as recovered — The anti-generation pool will reuse the account'}
                  >
                    {isClearingSuspended ? (
                      <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3 mr-1" />
                    )}
                    {isEn ? 'Reset Suspended' : 'Reset ban status'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowBanDialog(false)}>
                    {isEn ? 'Close' : 'closure'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Subscription management pop-up window */}
      {showSubscriptionDialog && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setShowSubscriptionDialog(false); setIsFirstTimeUser(false); setSubscriptionError(null); setSubscriptionSuccess(null) }} />
          <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-2xl m-4 animate-in fade-in zoom-in-95 duration-200 border overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between bg-gradient-to-r from-primary/10 to-[var(--gradient-to)]/10">
              <div className="flex items-center gap-2 text-primary">
                <CreditCard className="h-5 w-5" />
                <span className="font-bold">{isEn ? (isFirstTimeUser ? 'Choose Your Plan' : 'Subscription Plans') : (isFirstTimeUser ? 'Choose a subscription plan' : 'Subscription plan')}</span>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => { setShowSubscriptionDialog(false); setIsFirstTimeUser(false); setSubscriptionError(null); setSubscriptionSuccess(null) }}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-4 space-y-4">
              {isFirstTimeUser ? (
                <div className="text-xs text-muted-foreground mb-2 bg-warning/10 text-warning p-2 rounded-lg">
                  {isEn ? 'Please select a subscription plan to continue.' : 'Please select a subscription plan to continue using it.'}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground mb-2">
                  {isEn ? 'Current subscription: ' : 'Current subscription: '}
                  <span className="font-medium text-foreground">{account.subscription.title || account.subscription.type}</span>
                </div>
              )}
              
              {subscriptionError && (
                <div className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 p-2 rounded-lg flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{subscriptionError}</span>
                </div>
              )}
              
              {subscriptionSuccess && (
                <div className="text-xs bg-success/10 text-success p-2 rounded-lg flex items-center gap-2">
                  <Check className="h-4 w-4 shrink-0" />
                  <span>{subscriptionSuccess}</span>
                </div>
              )}
              
              <div className="grid grid-cols-2 gap-3">
                {subscriptionPlans.map((plan) => {
                  const isCurrent = plan.name === account.subscription.type || plan.description.title === account.subscription.title
                  const isLoading = paymentLoading && selectedPlan === plan.qSubscriptionType
                  return (
                    <div
                      key={plan.name}
                      className={cn(
                        'relative p-4 rounded-lg border-2 transition-all cursor-pointer hover:shadow-md',
                        isCurrent ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                        isLoading && 'opacity-70 cursor-wait'
                      )}
                      onClick={() => !isCurrent && handleSelectPlan(plan.qSubscriptionType)}
                    >
                      {isCurrent && (
                        <div className="absolute -top-2 -right-2 bg-primary text-primary-foreground text-[10px] px-2 py-0.5 rounded-full font-medium">
                          {isEn ? 'Current' : 'current'}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mb-2">
                        <Sparkles className={cn('h-4 w-4', plan.pricing.amount === 0 ? 'text-green-500' : 'text-amber-500')} />
                        <span className="font-bold text-sm">{plan.description.title}</span>
                      </div>
                      <div className="text-2xl font-bold mb-2">
                        {plan.pricing.amount === 0 ? (isEn ? 'Free' : 'free') : `$${plan.pricing.amount}`}
                        {plan.pricing.amount > 0 && <span className="text-xs font-normal text-muted-foreground">/{plan.description.billingInterval}</span>}
                      </div>
                      <ul className="space-y-1.5">
                        {plan.description.features.slice(0, 4).map((feature, idx) => (
                          <li key={idx} className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <Check className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                      {!isCurrent && (
                        <Button 
                          size="sm" 
                          className="w-full mt-3" 
                          variant={plan.pricing.amount === 0 ? 'outline' : 'default'}
                          disabled={isLoading}
                        >
                          {isLoading ? (
                            <><Loader2 className="h-3 w-3 mr-1 animate-spin" />{isEn ? 'Loading...' : 'loading...'}</>
                          ) : (
                            isEn ? 'Select' : 'choose'
                          )}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-between pt-3 border-t">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={handleManageSubscription}
                  disabled={paymentLoading}
                  className="text-xs"
                >
                  {paymentLoading && !selectedPlan ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" />{isEn ? 'Loading...' : 'loading...'}</>
                  ) : (
                    <><ExternalLink className="h-3 w-3 mr-1" />{isEn ? 'Manage Billing' : 'Manage bills'}</>
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowSubscriptionDialog(false); setIsFirstTimeUser(false); setSubscriptionError(null); setSubscriptionSuccess(null) }}>
                  {isEn ? 'Close' : 'closure'}
                </Button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </Card>
  )
})


