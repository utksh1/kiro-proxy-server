import { useState, useEffect } from 'react'
import { X, Loader2, RefreshCw, Download, CheckCircle, Copy, Check } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useAccountsStore } from '@/store'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account, SubscriptionType } from '@/types/account'

interface EditAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
}

export function EditAccountDialog({
  open,
  onOpenChange,
  account
}: EditAccountDialogProps) {
  const { updateAccount } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // OIDC Credentials (Core)
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [region, setRegion] = useState('us-east-1')

  // editable fields
  const [nickname, setNickname] = useState('')

  // Automatically obtained information (read-only display)
  const [accountInfo, setAccountInfo] = useState<{
    email: string
    userId: string
    accessToken: string
    subscriptionType: string
    subscriptionTitle: string
    usage: { 
      current: number
      limit: number
      baseLimit?: number
      baseCurrent?: number
      freeTrialLimit?: number
      freeTrialCurrent?: number
      freeTrialExpiry?: string
      bonuses?: { code: string; name: string; current: number; limit: number; expiresAt?: string }[]
      nextResetDate?: string
    }
    daysRemaining?: number
    expiresAt?: number
  } | null>(null)

  // state
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)

  const handleCopyAccessToken = (): void => {
    if (accountInfo?.accessToken) {
      navigator.clipboard.writeText(accountInfo.accessToken)
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 2000)
    }
  }

  // Update form when account changes
  useEffect(() => {
    if (account) {
      setRefreshToken(account.credentials.refreshToken || '')
      setClientId(account.credentials.clientId || '')
      setClientSecret(account.credentials.clientSecret || '')
      setRegion(account.credentials.region || 'us-east-1')
      setNickname(account.nickname || '')
      
      // Set current account information
      setAccountInfo({
        email: account.email,
        userId: account.userId || '',
        accessToken: account.credentials.accessToken,
        subscriptionType: account.subscription.type,
        subscriptionTitle: account.subscription.title || account.subscription.type,
        usage: {
          current: account.usage?.current || 0,
          limit: account.usage?.limit || 0
        },
        daysRemaining: account.subscription.daysRemaining,
        expiresAt: account.subscription.expiresAt
      })
      setError(null)
    }
  }, [account])

  // Import from local configuration
  const handleImportFromLocal = async () => {
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        setRefreshToken(result.data.refreshToken)
        setClientId(result.data.clientId)
        setClientSecret(result.data.clientSecret)
        setRegion(result.data.region)
        setError(null)
      } else {
        setError(result.error || 'Import failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    }
  }

  // Verify and refresh information
  const handleVerifyAndRefresh = async () => {
    const isSocial = account?.credentials.authMethod === 'social'
    if (!refreshToken) {
      setError('Please fill in Refresh Token')
      return
    }
    if (!isSocial && (!clientId || !clientSecret)) {
      setError('Please fill in Client ID and Client Secret')
      return
    }

    setIsVerifying(true)
    setError(null)

    try {
      const result = await window.api.verifyAccountCredentials({
        refreshToken,
        clientId,
        clientSecret,
        region,
        authMethod: account?.credentials.authMethod,
        provider: account?.credentials.provider || account?.idp
      })

      if (result.success && result.data) {
        setAccountInfo({
          email: result.data.email,
          userId: result.data.userId,
          accessToken: result.data.accessToken,
          subscriptionType: result.data.subscriptionType,
          subscriptionTitle: result.data.subscriptionTitle,
          usage: result.data.usage,
          daysRemaining: result.data.daysRemaining,
          expiresAt: result.data.expiresAt
        })
        // renew refreshToken(may return new one)
        if (result.data.refreshToken) {
          setRefreshToken(result.data.refreshToken)
        }
      } else {
        setError(result.error || 'Authentication failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setIsVerifying(false)
    }
  }

  // save
  const handleSave = () => {
    if (!account || !accountInfo) return

    const now = Date.now()

    updateAccount(account.id, {
      email: accountInfo.email,
      userId: accountInfo.userId,
      nickname: nickname || undefined,
      credentials: {
        ...account.credentials,
        accessToken: accountInfo.accessToken,
        csrfToken: '',
        refreshToken,
        clientId,
        clientSecret,
        region,
        expiresAt: now + 3600 * 1000
      },
      subscription: {
        type: accountInfo.subscriptionType as SubscriptionType,
        title: accountInfo.subscriptionTitle,
        daysRemaining: accountInfo.daysRemaining,
        expiresAt: accountInfo.expiresAt
      },
      usage: {
        current: accountInfo.usage.current,
        limit: accountInfo.usage.limit,
        percentUsed: accountInfo.usage.limit > 0 
          ? accountInfo.usage.current / accountInfo.usage.limit 
          : 0,
        lastUpdated: now,
        baseLimit: accountInfo.usage.baseLimit,
        baseCurrent: accountInfo.usage.baseCurrent,
        freeTrialLimit: accountInfo.usage.freeTrialLimit,
        freeTrialCurrent: accountInfo.usage.freeTrialCurrent,
        freeTrialExpiry: accountInfo.usage.freeTrialExpiry,
        bonuses: accountInfo.usage.bonuses,
        nextResetDate: accountInfo.usage.nextResetDate
      },
      status: 'active'
    })

    onOpenChange(false)
  }

  if (!open || !account) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      <Card className="relative w-full max-w-lg max-h-[90vh] overflow-auto z-10 animate-in zoom-in-95 duration-200">
        {/* head */}
        <CardHeader className="pb-4 border-b sticky top-0 bg-background z-20">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold">{isEn ? 'Edit Account' : 'Edit account'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{isEn ? 'Modify account settings or update credentials' : 'Modify account configuration or update credentials'}</p>
        </CardHeader>

        <CardContent className="p-6 space-y-6">
          {/* Current account information */}
          {accountInfo && (
            <div className="p-4 bg-primary/5 rounded-xl border border-primary/10 space-y-3">
              <div className="flex items-center justify-between border-b border-primary/10 pb-2">
                <span className="text-sm font-semibold text-foreground/80">{isEn ? 'Account Status' : 'Current account status'}</span>
                <div className="px-2.5 py-0.5 rounded-full bg-success/10 text-success text-xs font-medium flex items-center gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5" />
                  {isEn ? 'Verified' : 'Verified'}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Email' : 'Mail'}</span>
                  <span className="font-medium font-mono text-xs truncate block" title={accountInfo.email}>{accountInfo.email}</span>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Plan' : 'Subscription plan'}</span>
                  <span className="font-medium">{accountInfo.subscriptionTitle}</span>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Usage' : 'Usage quota'}</span>
                  <span className="font-medium">
                    {accountInfo.usage.current.toLocaleString()} / {accountInfo.usage.limit.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Days Left' : 'Days remaining'}</span>
                  <span className="font-medium">{accountInfo.daysRemaining ?? '-'} {isEn ? 'd' : 'sky'}</span>
                </div>
              </div>
            </div>
          )}

          {/* Alias */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{isEn ? 'Nickname' : 'Account alias'}</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={isEn ? 'Give this account a memorable name' : 'Give this account a memorable name'}
              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            />
          </div>

          {/* Credential configuration */}
          <div className="space-y-5 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {account?.credentials.authMethod === 'social' ? (isEn ? 'Social Login' : 'Social login credentials') : (isEn ? 'OIDC Credentials' : 'OIDC Credential configuration')}
                </h3>
                {account?.credentials.authMethod === 'social' && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                    {account?.credentials.provider || account?.idp}
                  </span>
                )}
              </div>
              {account?.credentials.authMethod !== 'social' && (
                <Button 
                  type="button" 
                  variant="outline" 
                  size="sm"
                  className="h-8 rounded-lg text-xs"
                  onClick={handleImportFromLocal}
                >
                  <Download className="h-3 w-3 mr-1.5" />
                  {isEn ? 'Import Local' : 'Import from local'}
                </Button>
              )}
            </div>

            {account?.credentials.authMethod === 'social' && (
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Social login only needs Refresh Token' : 'Social login account only requires Refresh Token,unnecessary Client ID and Client Secret'}
              </p>
            )}

            <div className="space-y-4">
              {/* Access Token (Read only, copyable) */}
              {accountInfo?.accessToken && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Access Token</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleCopyAccessToken}
                    >
                      {copiedToken ? <Check className="h-3 w-3 mr-1 text-success" /> : <Copy className="h-3 w-3 mr-1" />}
                      {copiedToken ? (isEn ? 'Copied' : 'Copied') : (isEn ? 'Copy' : 'copy')}
                    </Button>
                  </div>
                  <div className="w-full px-3 py-2.5 text-sm rounded-xl border border-input bg-muted/50 font-mono text-muted-foreground truncate">
                    {accountInfo.accessToken.slice(0, 50)}...
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Refresh Token <span className="text-destructive">*</span>
                </label>
                <textarea
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="aorAAAAA..."
                  className="w-full min-h-[80px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                />
              </div>

              {account?.credentials.authMethod !== 'social' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Client ID <span className="text-destructive">*</span>
                      </label>
                      <input
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="Client ID"
                        className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Client Secret <span className="text-destructive">*</span>
                      </label>
                      <input
                        type="text"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder="Client Secret"
                        className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">AWS Region</label>
                    <select
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <option value="us-east-1">us-east-1 (N. Virginia)</option>
                      <option value="us-west-2">us-west-2 (Oregon)</option>
                      <option value="eu-west-1">eu-west-1 (Ireland)</option>
                    </select>
                  </div>
                </>
              )}

              <Button 
                type="button" 
                variant="secondary"
                className="w-full h-10 rounded-xl font-medium"
                onClick={handleVerifyAndRefresh}
                disabled={isVerifying || !refreshToken || (account?.credentials.authMethod !== 'social' && (!clientId || !clientSecret))}
              >
                {isVerifying ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {isEn ? 'Verify & Refresh' : 'Verify and refresh credential information'}
              </Button>
            </div>
          </div>

          {/* error message */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
              <div className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
              {error}
            </div>
          )}
        </CardContent>

        {/* bottom button */}
        <div className="sticky bottom-0 bg-background/95 backdrop-blur p-4 border-t flex justify-end gap-3 z-20">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-xl h-10 px-6">
            {isEn ? 'Cancel' : 'Cancel'}
          </Button>
          <Button onClick={handleSave} disabled={!accountInfo} className="rounded-xl h-10 px-6">
            {isEn ? 'Save Changes' : 'Save changes'}
          </Button>
        </div>
      </Card>
    </div>
  )
}


