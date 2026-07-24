import { useState, useEffect, useRef } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { SubscriptionType } from '@/types/account'
import { X, Loader2, Download, Copy, Check, ExternalLink, Info, EyeOff } from 'lucide-react'
import { splitCredentialLine } from '@/lib/utils'

interface AddAccountDialogProps {
  isOpen: boolean
  onClose: () => void
}

interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

interface VerifiedData {
  email: string
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn?: number
  subscriptionType: string
  subscriptionTitle: string
  subscription?: {
    managementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  usage: { 
    current: number
    limit: number
    baseLimit?: number
    baseCurrent?: number
    freeTrialLimit?: number
    freeTrialCurrent?: number
    freeTrialExpiry?: string
    bonuses?: BonusData[]
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
  daysRemaining?: number
  expiresAt?: number
}

type ImportMode = 'oidc' | 'sso' | 'login'
type LoginType = 'builderid' | 'google' | 'github' | 'iamsso'

export function AddAccountDialog({ isOpen, onClose }: AddAccountDialogProps): React.ReactNode {
  const { addAccount, accounts, batchImportConcurrency, loginPrivateMode, groups, activeGroupTab } = useAccountsStore()

  // Check if the account already exists (same asuserId or Same email+sameprovider Only if it is repeated)
  const isAccountExists = (email: string, userId: string, provider?: string): boolean => {
    return Array.from(accounts.values()).some(acc => {
      // userId Repeat if the same (main basis for judgment)
      if (userId && acc.userId === userId) return true
      // email are non-empty and identical, and provider If the same, it will be repeated (different login methods for the same email address are allowed)
      // There may not be a business account email,so email Not used when empty email judge
      if (email && acc.email === email && acc.credentials.provider === provider) return true
      return false
    })
  }

  // import mode
  const [importMode, setImportMode] = useState<ImportMode>('login')

  // Target group to add to (default=The currently opened group can be changed in the pop-up window);undefined=Ungrouped (default grouped)
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined)

  // OIDC Voucher input
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [authMethod, setAuthMethod] = useState<'IdC' | 'social'>('IdC')
  const [provider, setProvider] = useState('BuilderId')  // 'BuilderId', 'Enterprise', 'Github', 'Google'

  // SSO Token import
  const [ssoToken, setSsoToken] = useState('')
  const [batchImportResult, setBatchImportResult] = useState<{ total: number; success: number; failed: number; errors: string[] } | null>(null)

  // OIDC Batch import
  const [oidcImportMode, setOidcImportMode] = useState<'single' | 'batch'>('single')
  const [oidcBatchData, setOidcBatchData] = useState('')
  const [oidcBatchImportResult, setOidcBatchImportResult] = useState<{ total: number; success: number; failed: number; errors: string[] } | null>(null)

  // Validated data (reserved for conditional rendering)
  const [verifiedData, setVerifiedData] = useState<VerifiedData | null>(null)

  // state
  const [isVerifying, setIsVerifying] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // Login related status
  const [loginType, setLoginType] = useState<LoginType>('builderid')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [usePrivateMode, setUsePrivateMode] = useState(loginPrivateMode) // Temporary privacy mode switch, defaults to follow global settings
  const [builderIdLoginData, setBuilderIdLoginData] = useState<{
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  
  // IAM SSO Login related status
  const [ssoStartUrl, setSsoStartUrl] = useState('')
  const [iamSsoLoginData, setIamSsoLoginData] = useState<{
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  } | null>(null)

  // Cleanup polling
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [])

  // Selected by default when opening a pop-up window"Currently open group"（activeGroupTab when it is real grouping), otherwise it is not grouped
  useEffect(() => {
    if (!isOpen) return
    const isRealGroup = activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)
    setSelectedGroupId(isRealGroup ? activeGroupTab : undefined)
  }, [isOpen, activeGroupTab, groups])

  // monitor Social Auth callback
  useEffect(() => {
    if (!isLoggingIn || loginType === 'builderid') return

    const unsubscribe = window.api.onSocialAuthCallback(async (data) => {
      console.log('[AddAccountDialog] Social auth callback:', data)
      
      if (data.error) {
        setError(`Login failed: ${data.error}`)
        setIsLoggingIn(false)
        return
      }

      if (data.code && data.state) {
        try {
          const result = await window.api.exchangeSocialToken(data.code, data.state)
          if (result.success) {
            await handleLoginSuccess({
              accessToken: result.accessToken!,
              refreshToken: result.refreshToken!,
              authMethod: 'social',
              provider: result.provider
            })
          } else {
            setError(result.error || 'Token Exchange failed')
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Login failed')
        } finally {
          setIsLoggingIn(false)
        }
      }
    })

    return () => unsubscribe()
  }, [isLoggingIn, loginType])

  // Handle login success
  const handleLoginSuccess = async (tokenData: {
    accessToken: string
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    startUrl?: string
    authMethod?: string
    provider?: string
  }) => {
    console.log('[AddAccountDialog] Login successful, verifying credentials...')
    
    try {
      // Verify credentials and obtain account information
      const result = await window.api.verifyAccountCredentials({
        refreshToken: tokenData.refreshToken,
        clientId: tokenData.clientId || '',
        clientSecret: tokenData.clientSecret || '',
        region: tokenData.region || 'us-east-1',
        authMethod: tokenData.authMethod,
        provider: tokenData.provider
      })

      if (result.success && result.data) {
        const { email, userId } = result.data
        const providerName = tokenData.provider || 'BuilderId'
        
        // Check if the account already exists
        if (isAccountExists(email, userId, providerName)) {
          setError(isEn ? 'This account already exists' : 'This account already exists, no need to add it again')
          return
        }
        
        // Add account
        const now = Date.now()
        addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: providerName as 'BuilderId' | 'Google' | 'Github',
          groupId: selectedGroupId,
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId: tokenData.clientId || '',
            clientSecret: tokenData.clientSecret || '',
            region: tokenData.region || 'us-east-1',
            startUrl: tokenData.startUrl,
            expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod: tokenData.authMethod as 'IdC' | 'social',
            provider: (tokenData.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google',
            profileArn: result.data.profileArn
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            rawType: result.data.subscription?.rawType,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0 
              ? result.data.usage.current / result.data.usage.limit 
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          tags: [],
          status: 'active',
          lastUsedAt: now
        })

        resetForm()
        onClose()
      } else {
        setError(result.error || 'Authentication failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add account')
    }
  }

  // start up Builder ID Log in
  const handleStartBuilderIdLogin = async () => {
    setIsLoggingIn(true)
    setError(null)
    setBuilderIdLoginData(null)

    try {
      const result = await window.api.startBuilderIdLogin(region)
      
      if (result.success && result.userCode && result.verificationUri) {
        setBuilderIdLoginData({
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresIn: result.expiresIn || 600,
          interval: result.interval || 5
        })

        // Open the browser (privacy mode supported)
        window.api.openExternal(result.verificationUri, usePrivateMode)

        // Start polling
        startPolling(result.interval || 5)
      } else {
        setError(result.error || 'Start login failed')
        setIsLoggingIn(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start login failed')
      setIsLoggingIn(false)
    }
  }

  // start up IAM SSO Log in (Authorization Code flow)
  const handleStartIamSsoLogin = async () => {
    if (!ssoStartUrl.trim()) {
      setError(isEn ? 'Please enter SSO Start URL' : 'Please enter SSO Start URL')
      return
    }
    
    setIsLoggingIn(true)
    setError(null)
    setIamSsoLoginData(null)

    try {
      const result = await window.api.startIamSsoLogin(ssoStartUrl.trim(), region)
      
      if (result.success && result.authorizeUrl) {
        // Set login data (used to display waiting status)
        setIamSsoLoginData({
          userCode: '',
          verificationUri: result.authorizeUrl,
          expiresIn: result.expiresIn || 600,
          interval: 3
        })

        // Open the browser (privacy mode supported)
        window.api.openExternal(result.authorizeUrl, usePrivateMode)

        // Start polling (wait for server callback to complete automatically token exchange)
        startIamSsoPolling(3)
      } else {
        setError(result.error || (isEn ? 'Failed to start login' : 'Start login failed'))
        setIsLoggingIn(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : (isEn ? 'Failed to start login' : 'Start login failed'))
      setIsLoggingIn(false)
    }
  }

  // Start polling IAM SSO Authorize
  const startIamSsoPolling = (interval: number) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await window.api.pollIamSsoAuth(region)
        
        if (!result.success) {
          setError(result.error || (isEn ? 'Authorization failed' : 'Authorization failed'))
          setIsLoggingIn(false)
          setIamSsoLoginData(null)
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          return
        }

        if (result.completed) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          
          await handleLoginSuccess({
            accessToken: result.accessToken!,
            refreshToken: result.refreshToken!,
            clientId: result.clientId,
            clientSecret: result.clientSecret,
            region: result.region,
            startUrl: ssoStartUrl.trim(),
            authMethod: 'IdC',
            provider: 'Enterprise'
          })
          
          setIsLoggingIn(false)
          setIamSsoLoginData(null)
        }
        // in the case of pending or slow_down, continue polling
      } catch (e) {
        console.error('[AddAccountDialog] IAM SSO Poll error:', e)
      }
    }, interval * 1000)
  }

  // Start polling Builder ID Authorize
  const startPolling = (interval: number) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await window.api.pollBuilderIdAuth(region)
        
        if (!result.success) {
          setError(result.error || 'Authorization failed')
          setIsLoggingIn(false)
          setBuilderIdLoginData(null)
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          return
        }

        if (result.completed) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          
          await handleLoginSuccess({
            accessToken: result.accessToken!,
            refreshToken: result.refreshToken!,
            clientId: result.clientId,
            clientSecret: result.clientSecret,
            region: result.region,
            authMethod: 'IdC',
            provider: 'BuilderId'
          })
          
          setIsLoggingIn(false)
          setBuilderIdLoginData(null)
        }
        // in the case of pending or slow_down, continue polling
      } catch (e) {
        console.error('[AddAccountDialog] Poll error:', e)
      }
    }, interval * 1000)
  }

  // Cancel login
  const handleCancelLogin = async () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    if (loginType === 'builderid') {
      await window.api.cancelBuilderIdLogin()
    } else if (loginType === 'iamsso') {
      await window.api.cancelIamSsoLogin()
    } else {
      await window.api.cancelSocialLogin()
    }

    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setIamSsoLoginData(null)
    setError(null)
  }

  // start up Social Auth Log in (Google/GitHub)
  const handleStartSocialLogin = async (socialProvider: 'Google' | 'Github') => {
    setIsLoggingIn(true)
    setError(null)

    try {
      const result = await window.api.startSocialLogin(socialProvider, usePrivateMode)
      
      if (!result.success) {
        setError(result.error || 'Start login failed')
        setIsLoggingIn(false)
      }
      // Wait for callback after success
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start login failed')
      setIsLoggingIn(false)
    }
  }

  // copy user_code
  const handleCopyUserCode = async () => {
    if (builderIdLoginData?.userCode) {
      await navigator.clipboard.writeText(builderIdLoginData.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Import from local configuration
  const handleImportFromLocal = async () => {
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        setRefreshToken(result.data.refreshToken)
        setClientId(result.data.clientId)
        setClientSecret(result.data.clientSecret)
        setRegion(result.data.region)
        setAuthMethod(result.data.authMethod as 'IdC' | 'social' || 'IdC')
        setProvider(result.data.provider || 'BuilderId')
        setError(null)
      } else {
        setError(result.error || 'Import failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    }
  }

  // from SSO Token Import and add accounts (supports batches)
  const handleSsoImport = async () => {
    if (!ssoToken.trim()) {
      setError('Please enter x-amz-sso_authn value')
      return
    }

    // Parse multiple Token(one per line)
    const tokens = ssoToken
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0)

    if (tokens.length === 0) {
      setError('Please enter at least one Token')
      return
    }

    setIsVerifying(true)
    setError(null)
    setBatchImportResult(null)

    const importResult = { total: tokens.length, success: 0, failed: 0, errors: [] as string[], failedIndices: [] as number[] }

    // single Token Import function
    const importSingleToken = async (token: string, index: number): Promise<void> => {
      try {
        const result = await window.api.importFromSsoToken(token, region)
        
        if (result.success && result.data) {
          const { email, userId } = result.data
          
          // Check whether the account already exists (the existing account is also removed from the input box)
          if (email && userId && isAccountExists(email, userId, 'BuilderId')) {
            importResult.errors.push(`#${index + 1}: ${email} ${isEn ? 'already exists' : 'Already exists'}`)
            return
          }
          
          // Add account
          const now = Date.now()
          addAccount({
            email: email || '',
            userId: userId || '',
            nickname: email ? email.split('@')[0] : undefined,
            idp: 'BuilderId',
            groupId: selectedGroupId,
            credentials: {
              accessToken: result.data.accessToken,
              csrfToken: '',
              refreshToken: result.data.refreshToken,
              clientId: result.data.clientId,
              clientSecret: result.data.clientSecret,
              region: result.data.region,
              expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000
            },
            subscription: {
              type: (result.data.subscriptionType || 'Free') as SubscriptionType,
              title: result.data.subscriptionTitle || 'KIRO',
              daysRemaining: result.data.daysRemaining,
              managementTarget: result.data.subscription?.managementTarget,
              upgradeCapability: result.data.subscription?.upgradeCapability,
              overageCapability: result.data.subscription?.overageCapability
            },
            usage: {
              current: result.data.usage?.current || 0,
              limit: result.data.usage?.limit || 0,
              percentUsed: (result.data.usage?.limit || 0) > 0 
                ? (result.data.usage?.current || 0) / (result.data.usage?.limit || 1) 
                : 0,
              lastUpdated: now,
              baseLimit: result.data.usage?.baseLimit,
              baseCurrent: result.data.usage?.baseCurrent,
              freeTrialLimit: result.data.usage?.freeTrialLimit,
              freeTrialCurrent: result.data.usage?.freeTrialCurrent,
              freeTrialExpiry: result.data.usage?.freeTrialExpiry,
              bonuses: result.data.usage?.bonuses,
              nextResetDate: result.data.usage?.nextResetDate,
              resourceDetail: result.data.usage?.resourceDetail
            },
            tags: [],
            status: 'active',
            lastUsedAt: now
          })
          
          importResult.success++
        } else {
          importResult.failed++
          importResult.failedIndices.push(index)
          importResult.errors.push(`#${index + 1}: ${result.error?.message || 'Import failed'}`)
        }
      } catch (e) {
        importResult.failed++
        importResult.failedIndices.push(index)
        importResult.errors.push(`#${index + 1}: ${e instanceof Error ? e.message : 'Import failed'}`)
      }
    }

    try {
      // Concurrency control: Use the configured number of concurrencies to avoid API Current limiting
      const BATCH_SIZE = batchImportConcurrency
      for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        const batch = tokens.slice(i, i + BATCH_SIZE)
        await Promise.allSettled(
          batch.map((token, batchIndex) => importSingleToken(token, i + batchIndex))
        )
        // Add a short delay between batches
        if (i + BATCH_SIZE < tokens.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      setBatchImportResult(importResult)
      
      // If everything is successful, close the pop-up window
      if (importResult.failed === 0) {
        resetForm()
        onClose()
      } else {
        // keep failed Token in the input box
        const failedTokens = importResult.failedIndices.map(i => tokens[i])
        if (failedTokens.length > 0) {
          setSsoToken(failedTokens.join('\n'))
        }
        if (importResult.success > 0) {
          setError(`Imported successfully ${importResult.success} one, failed ${importResult.failed} indivual`)
        } else {
          setError(`All import failed (${importResult.failed} indivual)`)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SSO Import failed')
    } finally {
      setIsVerifying(false)
    }
  }

  // OIDC Batch import
  const handleOidcBatchAdd = async () => {
    if (!oidcBatchData.trim()) {
      setError('Please enter credential data')
      return
    }

    // Parse Credential Data: Automatic Identification JSON or card format
    let credentials: Array<{
      refreshToken: string
      password?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: 'IdC' | 'social'
      provider?: string
    }>

    const trimmed = oidcBatchData.trim()
    let isKamiFormat = false

    try {
      const parsed = JSON.parse(trimmed)
      credentials = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // JSON Parsing failed, try card format: email----password----RefreshToken----ClientId----ClientSecret
      // Supported delimiters:----、Tab, continuous spaces
      const lines = trimmed.split('\n').filter(line => line.trim() && !line.startsWith('#'))
      if (lines.length === 0) {
        setError(isEn ? 'Invalid format' : 'Format error, please enter JSON Array or card format (email----password----Token----ID----Secret）')
        return
      }

      credentials = lines.map(line => {
        const parts = splitCredentialLine(line)
        const rawPwd = parts[1]?.trim()
        const clientId = parts[3]?.trim() || undefined
        const clientSecret = parts[4]?.trim() || undefined
        // No.6The field is the login method(idp): The new card number will be brought directly; if the old card number does not have this field, press ClientId/Secret infer--
        // social(Github/Google) only refreshToken，IdC(BuilderId/Enterprise) only have ClientId/Secret。
        // provider Decide below verify of authMethod(social→ Just refreshToken / IdC→Required ClientId+Secret)
        const rawIdp = parts[5]?.trim()
        const provider = rawIdp || ((!clientId && !clientSecret) ? 'Google' : 'BuilderId')
        return {
          _email: parts[0]?.trim() || '',
          password: (rawPwd && rawPwd !== 'no_password') ? rawPwd : undefined,
          refreshToken: parts[2]?.trim() || '',
          clientId,
          clientSecret,
          provider
        }
      }).filter(item => item.refreshToken) as typeof credentials

      if (credentials.length === 0) {
        setError(isEn ? 'Invalid format' : 'Format error, please enter JSON Array or card format (email----password----Token----ID----Secret）')
        return
      }
      isKamiFormat = true
    }

    if (credentials.length === 0) {
      setError(isEn ? 'Enter at least one credential' : 'Please enter at least one credential')
      return
    }

    setIsSubmitting(true)
    setError(null)
    setOidcBatchImportResult(null)

    const importResult = { total: credentials.length, success: 0, failed: 0, errors: [] as string[], failedIndices: [] as number[] }

    // Single credential import function
    const importSingleCredential = async (cred: typeof credentials[0], index: number): Promise<void> => {
      try {
        if (!cred.refreshToken) {
          importResult.failed++
          importResult.failedIndices.push(index)
          importResult.errors.push(`#${index + 1}: Lack refreshToken`)
          return
        }

        // according to provider Automatically determined authMethod
        const credProvider = cred.provider || 'BuilderId'
        const credAuthMethod = cred.authMethod || ((credProvider === 'BuilderId' || credProvider === 'Enterprise') ? 'IdC' : 'social')

        const result = await window.api.verifyAccountCredentials({
          refreshToken: cred.refreshToken,
          clientId: cred.clientId || '',
          clientSecret: cred.clientSecret || '',
          region: cred.region || 'us-east-1',
          authMethod: credAuthMethod,
          provider: credProvider
        })

        if (result.success && result.data) {
          const { email, userId } = result.data
          const provider = (cred.provider || 'BuilderId') as 'BuilderId' | 'Enterprise' | 'Github' | 'Google'
          
          if (isAccountExists(email, userId, provider)) {
            // Existing ones are not recorded as failures and are also removed from the input box.
            importResult.errors.push(`#${index + 1}: ${email} ${isEn ? 'already exists' : 'Already exists'}`)
            return
          }
          
          // according to provider Sure idp and authMethod
          const idpMap: Record<string, 'BuilderId' | 'Enterprise' | 'Github' | 'Google'> = {
            'BuilderId': 'BuilderId',
            'Enterprise': 'Enterprise',
            'Github': 'Github',
            'Google': 'Google'
          }
          const idp = idpMap[provider] || 'BuilderId'
          // GitHub and Google use social Authentication method,BuilderId and Enterprise use IdC
          const authMethod = cred.authMethod || ((provider === 'BuilderId' || provider === 'Enterprise') ? 'IdC' : 'social')
          
          const now = Date.now()
          addAccount({
            email,
            password: cred.password,
            userId,
            nickname: email ? email.split('@')[0] : undefined,
            idp,
            groupId: selectedGroupId,
            credentials: {
              accessToken: result.data.accessToken,
              csrfToken: '',
              refreshToken: result.data.refreshToken,
              clientId: cred.clientId || '',
              clientSecret: cred.clientSecret || '',
              region: cred.region || 'us-east-1',
              expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
              authMethod,
              provider,
              profileArn: result.data.profileArn
            },
            subscription: {
              type: result.data.subscriptionType as SubscriptionType,
              title: result.data.subscriptionTitle,
              daysRemaining: result.data.daysRemaining,
              expiresAt: result.data.expiresAt,
              managementTarget: result.data.subscription?.managementTarget,
              upgradeCapability: result.data.subscription?.upgradeCapability,
              overageCapability: result.data.subscription?.overageCapability
            },
            usage: {
              current: result.data.usage.current,
              limit: result.data.usage.limit,
              percentUsed: result.data.usage.limit > 0 
                ? result.data.usage.current / result.data.usage.limit 
                : 0,
              lastUpdated: now,
              baseLimit: result.data.usage.baseLimit,
              baseCurrent: result.data.usage.baseCurrent,
              freeTrialLimit: result.data.usage.freeTrialLimit,
              freeTrialCurrent: result.data.usage.freeTrialCurrent,
              freeTrialExpiry: result.data.usage.freeTrialExpiry,
              bonuses: result.data.usage.bonuses,
              nextResetDate: result.data.usage.nextResetDate,
              resourceDetail: result.data.usage.resourceDetail
            },
            tags: [],
            status: 'active',
            lastUsedAt: now
          })
          
          importResult.success++
        } else {
          importResult.failed++
          importResult.failedIndices.push(index)
          const err = result.error as { message?: string } | string | undefined
          const errorMsg = typeof err === 'object' ? (err?.message || 'Authentication failed') : (err || 'Authentication failed')
          importResult.errors.push(`#${index + 1}: ${errorMsg}`)
        }
      } catch (e) {
        importResult.failed++
        importResult.failedIndices.push(index)
        importResult.errors.push(`#${index + 1}: ${e instanceof Error ? e.message : 'Import failed'}`)
      }
    }

    try {
      // Concurrency control: Use the configured number of concurrencies to avoid API Current limiting
      const BATCH_SIZE = batchImportConcurrency
      for (let i = 0; i < credentials.length; i += BATCH_SIZE) {
        const batch = credentials.slice(i, i + BATCH_SIZE)
        await Promise.allSettled(
          batch.map((cred, batchIndex) => importSingleCredential(cred, i + batchIndex))
        )
        // Add a short delay between batches to further avoid throttling
        if (i + BATCH_SIZE < credentials.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      setOidcBatchImportResult(importResult)
      
      if (importResult.failed === 0) {
        resetForm()
        onClose()
      } else {
        // Keep failed credentials in input box
        const failedCredentials = importResult.failedIndices.map(i => credentials[i])
        if (failedCredentials.length > 0) {
          if (isKamiFormat) {
            // Card secret format: restore to card secret text
            const kamiLines = failedCredentials.map(c => 
              [(c as Record<string, string>)._email || '', c.password || '', c.refreshToken, c.clientId || '', c.clientSecret || '', c.provider || ''].join('----')
            )
            setOidcBatchData(kamiLines.join('\n'))
          } else {
            setOidcBatchData(JSON.stringify(failedCredentials, null, 2))
          }
        }
        if (importResult.success > 0) {
          setError(`Imported successfully ${importResult.success} one, failed ${importResult.failed} indivual`)
        } else {
          setError(`All import failed (${importResult.failed} indivual)`)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OIDC Batch import failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  // OIDC Add account with credentials (verify and add)
  const handleOidcAdd = async () => {
    if (!refreshToken) {
      setError('Please fill in Refresh Token')
      return
    }
    // Social login not required clientId and clientSecret
    if (authMethod !== 'social' && (!clientId || !clientSecret)) {
      setError('Please fill in Client ID and Client Secret')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const result = await window.api.verifyAccountCredentials({
        refreshToken,
        clientId,
        clientSecret,
        region,
        authMethod,
        provider
      })

      if (result.success && result.data) {
        const { email, userId } = result.data
        const providerName = provider || 'BuilderId'
        
        // Check if the account already exists
        if (isAccountExists(email, userId, providerName)) {
          setError(isEn ? 'This account already exists' : 'This account already exists, no need to add it again')
          return
        }
        
        // Add account directly
        const now = Date.now()
        addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: providerName as 'BuilderId' | 'Github' | 'Google',
          groupId: selectedGroupId,
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId,
            clientSecret,
            region,
            expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod,
            provider: (provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0 
              ? result.data.usage.current / result.data.usage.limit 
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          tags: [],
          status: 'active',
          lastUsedAt: now
        })

        resetForm()
        onClose()
      } else {
        setError(result.error || 'Authentication failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetForm = () => {
    setImportMode('login')
    setRefreshToken('')
    setClientId('')
    setClientSecret('')
    setRegion('us-east-1')
    setAuthMethod('IdC')
    setProvider('BuilderId')
    setSsoToken('')
    setVerifiedData(null)
    setError(null)
    // Clear login status
    setLoginType('builderid')
    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setCopied(false)
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <Card className="relative w-full max-w-lg max-h-[90vh] overflow-auto z-10">
        <CardHeader className="pb-4 border-b">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-xl font-bold">{isEn ? 'Add Account' : 'Add account'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{isEn ? 'Choose a method to add your Kiro account' : 'Choose a way to add your Kiro account'}</p>
        </CardHeader>

        <CardContent className="space-y-6 pt-6">
          {/* Add to group (default=The currently opened group (can be changed); not displayed if there is no group */}
          {groups.size > 0 && (
            <div className="flex items-center gap-3">
              <Label className="text-sm whitespace-nowrap">{isEn ? 'Add to group' : 'Add to group'}</Label>
              <Select
                className="flex-1"
                value={selectedGroupId ?? '__default__'}
                onChange={(v) => setSelectedGroupId(v === '__default__' ? undefined : v)}
                options={[
                  { value: '__default__', label: isEn ? 'Default (Ungrouped)' : 'Default (ungrouped)' },
                  ...Array.from(groups.values()).sort((a, b) => a.order - b.order).map(g => ({ value: g.id, label: g.name }))
                ]}
              />
            </div>
          )}
          {/* Import mode switch */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-muted/50 rounded-xl border">
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'login' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('login'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn}
            >
              {isEn ? 'Login' : 'Login online'}
            </button>
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'oidc' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('oidc'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn}
            >
              {isEn ? 'OIDC Token' : 'OIDC certificate'}
            </button>
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'sso' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('sso'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn}
            >
              SSO Token
            </button>
          </div>

          {/* login mode */}
          {importMode === 'login' && !verifiedData && (
            <div className="space-y-4">
              {/* Login status - Builder ID */}
              {isLoggingIn && builderIdLoginData && (
                <div className="space-y-4">
                  <div className="p-4 bg-primary/[0.08] rounded-lg text-center border border-primary/15">
                    <p className="text-sm text-primary mb-2">
                      {isEn ? 'Complete login in browser and enter this code:' : 'Please complete the login in your browser and enter the following code:'}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      <code className="text-2xl font-bold tracking-widest bg-white dark:bg-gray-800 px-4 py-2 rounded border">
                        {builderIdLoginData.userCode}
                      </code>
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={handleCopyUserCode}
                        title={isEn ? 'Copy code' : 'Copy code'}
                      >
                        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {isEn ? 'Waiting for authorization...' : 'Waiting for authorization...'}
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      className="flex-1"
                      onClick={() => window.api.openExternal(builderIdLoginData.verificationUri, usePrivateMode)}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      {isEn ? 'Open Browser' : 'Reopen browser'}
                    </Button>
                    <Button 
                      variant="destructive" 
                      className="flex-1"
                      onClick={handleCancelLogin}
                    >
                      {isEn ? 'Cancel' : 'Cancel login'}
                    </Button>
                  </div>
                </div>
              )}

              {/* Login status - Social Auth */}
              {isLoggingIn && !builderIdLoginData && (
                <div className="space-y-4">
                  <div className="p-4 bg-primary/[0.08] rounded-lg text-center border border-primary/15">
                    <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-primary" />
                    <p className="text-sm text-primary">
                      {isEn ? 'Complete login in browser...' : 'Please complete the login in the browser...'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {isEn ? 'Will auto return after login' : 'You will automatically return after logging in.'}
                    </p>
                  </div>
                  
                  <Button 
                    variant="destructive" 
                    className="w-full"
                    onClick={handleCancelLogin}
                  >
                    {isEn ? 'Cancel' : 'Cancel login'}
                  </Button>
                </div>
              )}

              {/* Not logged in - Show login options */}
              {!isLoggingIn && (
                <div className="space-y-4 py-2">
                  <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Check className="w-6 h-6 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Choose Login Method' : 'Choose login method'}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {isEn ? 'Multiple quick login options' : 'Support multiple ways to log in quickly'}
                    </p>
                  </div>

                  {/* Privacy mode options */}
                  <div className="px-2">
                    <button
                      type="button"
                      onClick={() => setUsePrivateMode(!usePrivateMode)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-200 ${
                        usePrivateMode 
                          ? 'bg-primary/5 border-primary/30 hover:bg-primary/10' 
                          : 'bg-muted/30 border-transparent hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                          usePrivateMode ? 'bg-primary/20' : 'bg-muted'
                        }`}>
                          <EyeOff className={`w-4 h-4 ${usePrivateMode ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <span className={`text-sm font-medium ${usePrivateMode ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {isEn ? 'Private/Incognito Mode' : 'privacy/Incognito mode'}
                        </span>
                      </div>
                      <div className={`w-10 h-6 rounded-full p-1 transition-colors ${
                        usePrivateMode ? 'bg-primary' : 'bg-muted-foreground/30'
                      }`}>
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                          usePrivateMode ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </div>
                    </button>
                  </div>
                  
                  <div className="space-y-3 px-2">
                    {/* Google */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('google')
                        handleStartSocialLogin('Google')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">{isEn ? 'Google Account' : 'Google account'}</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Quick login with Google' : 'use Google Account quick login'}</span>
                      </div>
                    </button>

                    {/* GitHub */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('github')
                        handleStartSocialLogin('Github')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" fill="#24292f" className="w-full h-full dark:fill-white">
                          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">{isEn ? 'GitHub Account' : 'GitHub account'}</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Quick login with GitHub' : 'use GitHub Account quick login'}</span>
                      </div>
                    </button>

                    {/* AWS Builder ID */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('builderid')
                        handleStartBuilderIdLogin()
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full">
                          <text x="0" y="17" fontSize="12" fontWeight="bold" fontFamily="Arial" className="fill-[#232f3e] dark:fill-white">aws</text>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">AWS Builder ID</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Login with AWS Builder ID' : 'use AWS Builder ID Log in'}</span>
                      </div>
                    </button>

                    {/* IAM Identity Center (Organization) */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('iamsso')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full fill-[#232f3e] dark:fill-white">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">Enterprise</span>
                        <span className="text-xs text-muted-foreground">IAM Identity Center SSO</span>
                      </div>
                    </button>
                  </div>

                  {/* IAM SSO Input box */}
                  {loginType === 'iamsso' && !iamSsoLoginData && (
                    <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                      <div className="space-y-2">
                        <Label htmlFor="ssoStartUrl" className="text-sm font-medium">{isEn ? 'SSO Start URL' : 'SSO Start URL'}</Label>
                        <Input
                          id="ssoStartUrl"
                          type="url"
                          placeholder="https://your-org.awsapps.com/start"
                          value={ssoStartUrl}
                          onChange={(e) => setSsoStartUrl(e.target.value)}
                          className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          {isEn ? 'Get this from your organization admin' : 'Get it from your organization administrator'}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="ssoRegion" className="text-sm font-medium">{isEn ? 'SSO Region' : 'SSO area'}</Label>
                        <div className="flex gap-2">
                          <select
                            id="ssoRegion"
                            value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                            onChange={(e) => {
                              if (e.target.value !== 'custom') setRegion(e.target.value)
                            }}
                            className="flex-1 h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          >
                            <optgroup label="US">
                              <option value="us-east-1">us-east-1 (N. Virginia)</option>
                              <option value="us-east-2">us-east-2 (Ohio)</option>
                              <option value="us-west-1">us-west-1 (N. California)</option>
                              <option value="us-west-2">us-west-2 (Oregon)</option>
                            </optgroup>
                            <optgroup label="Europe">
                              <option value="eu-west-1">eu-west-1 (Ireland)</option>
                              <option value="eu-west-2">eu-west-2 (London)</option>
                              <option value="eu-west-3">eu-west-3 (Paris)</option>
                              <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                              <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                              <option value="eu-south-1">eu-south-1 (Milan)</option>
                            </optgroup>
                            <optgroup label="Asia Pacific">
                              <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                              <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                              <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                              <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                              <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                              <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                              <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                            </optgroup>
                            <optgroup label="Other">
                              <option value="ca-central-1">ca-central-1 (Canada)</option>
                              <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                              <option value="me-south-1">me-south-1 (Bahrain)</option>
                              <option value="af-south-1">af-south-1 (Cape Town)</option>
                            </optgroup>
                            <optgroup label={isEn ? 'Custom' : 'Customize'}>
                              <option value="custom">{isEn ? '-- Custom Input --' : '-- custom input --'}</option>
                            </optgroup>
                          </select>
                          <input
                            type="text"
                            value={region}
                            onChange={(e) => setRegion(e.target.value)}
                            placeholder={isEn ? 'e.g., cn-north-1' : 'For example: cn-north-1'}
                            className="w-32 h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          />
                        </div>
                      </div>
                      <Button 
                        className="w-full"
                        onClick={handleStartIamSsoLogin}
                        disabled={!ssoStartUrl.trim() || isLoggingIn}
                      >
                        {isLoggingIn ? (isEn ? 'Starting...' : 'Starting...') : (isEn ? 'Start Login' : 'Start logging in')}
                      </Button>
                    </div>
                  )}

                  {/* IAM SSO Authorizing */}
                  {loginType === 'iamsso' && iamSsoLoginData && (
                    <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                      <div className="text-center space-y-2">
                        <p className="text-sm font-medium">{isEn ? 'Enter this code in browser:' : 'Enter this code into your browser:'}</p>
                        <div className="flex items-center justify-center gap-2">
                          <code className="px-4 py-2 bg-primary/10 text-primary font-mono text-2xl font-bold rounded-lg">
                            {iamSsoLoginData.userCode}
                          </code>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(iamSsoLoginData.userCode)
                              setCopied(true)
                              setTimeout(() => setCopied(false), 2000)
                            }}
                          >
                            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{isEn ? 'Waiting for authorization...' : 'Waiting for authorization...'}</span>
                      </div>
                      <Button 
                        variant="destructive" 
                        className="w-full"
                        onClick={handleCancelLogin}
                      >
                        {isEn ? 'Cancel' : 'Cancel login'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SSO Token import mode */}
          {importMode === 'sso' && !verifiedData && (
            <div className="space-y-5">
              <div className="p-4 bg-primary/[0.04] rounded-xl border border-primary/15">
                <div className="flex items-start gap-3">
                   <div className="p-2 bg-primary/10 rounded-lg text-primary">
                      <Info className="w-4 h-4" />
                   </div>
                   <div className="flex-1">
                      <p className="text-sm font-semibold text-primary mb-1.5">{isEn ? 'How to get Token?' : 'How to get Token?'}</p>
                      <ol className="text-xs text-primary/90 list-decimal list-inside space-y-1.5">
                        <li>{isEn ? 'Visit and login:' : 'Visit in a browser and log in:'} <a href="https://view.awsapps.com/start/#/device?user_code=PQCF-FCCN/start/#/device?user_code=PQCF-FCCN" target="_blank" className="underline hover:text-primary/80 font-medium">view.awsapps.com/start/#/device?user_code=PQCF-FCCN</a></li>
                        <li>{isEn ? 'Press F12 → Application → Cookies' : 'according to F12 Open developer tools → Application → Cookies'}</li>
                        <li>{isEn ? 'Find and copy' : 'Find and copy'} <code className="px-1 py-0.5 bg-primary/15 rounded font-mono text-[10px]">x-amz-sso_authn</code> {isEn ? 'value' : 'value'}</li>
                      </ol>
                   </div>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-1">
                    x-amz-sso_authn <span className="text-destructive">*</span>
                    <span className="text-xs text-muted-foreground font-normal ml-2">{isEn ? 'Supports batch import, one per line' : 'Supports batch import, one per line Token'}</span>
                  </label>
                  <textarea
                    className="w-full min-h-[120px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                    placeholder={isEn ? 'Paste Token content, one per line&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2...' : 'Paste Token Content, one per line&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2...'}
                    value={ssoToken}
                    onChange={(e) => { setSsoToken(e.target.value); setBatchImportResult(null) }}
                  />
                  {ssoToken.trim() && (
                    <p className="text-xs text-muted-foreground">
                      {isEn ? `Entered ${ssoToken.split('\n').filter(t => t.trim()).length} tokens` : `entered ${ssoToken.split('\n').filter(t => t.trim()).length} indivual Token`}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">AWS Region</label>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                      onChange={(e) => {
                        if (e.target.value !== 'custom') setRegion(e.target.value)
                      }}
                    >
                      <optgroup label="US">
                        <option value="us-east-1">us-east-1 (N. Virginia)</option>
                        <option value="us-east-2">us-east-2 (Ohio)</option>
                        <option value="us-west-1">us-west-1 (N. California)</option>
                        <option value="us-west-2">us-west-2 (Oregon)</option>
                      </optgroup>
                      <optgroup label="Europe">
                        <option value="eu-west-1">eu-west-1 (Ireland)</option>
                        <option value="eu-west-2">eu-west-2 (London)</option>
                        <option value="eu-west-3">eu-west-3 (Paris)</option>
                        <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                        <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                        <option value="eu-south-1">eu-south-1 (Milan)</option>
                      </optgroup>
                      <optgroup label="Asia Pacific">
                        <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                        <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                        <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                        <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                        <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                        <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                        <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                      </optgroup>
                      <optgroup label="Other">
                        <option value="ca-central-1">ca-central-1 (Canada)</option>
                        <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                        <option value="me-south-1">me-south-1 (Bahrain)</option>
                        <option value="af-south-1">af-south-1 (Cape Town)</option>
                      </optgroup>
                      <optgroup label={isEn ? 'Custom' : 'Customize'}>
                        <option value="custom">{isEn ? '-- Custom --' : '-- Customize --'}</option>
                      </optgroup>
                    </select>
                    <input
                      type="text"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      placeholder={isEn ? 'e.g., cn-north-1' : 'For example: cn-north-1'}
                      className="w-28 h-10 px-2 text-sm rounded-xl border border-input bg-background/50"
                    />
                  </div>
                </div>
              </div>

              {/* Batch import results */}
              {batchImportResult && (
                <div className={`p-3 rounded-lg text-sm ${batchImportResult.failed > 0 ? 'bg-warning/10 border border-warning/30' : 'bg-success/10 border border-success/30'}`}>
                  <p className={`font-medium ${batchImportResult.failed > 0 ? 'text-warning' : 'text-success'}`}>
                    {isEn ? `Result: ${batchImportResult.success}/${batchImportResult.total} succeeded` : `Import results: success ${batchImportResult.success}/${batchImportResult.total}`}
                  </p>
                  {batchImportResult.errors.length > 0 && (
                    <ul className="mt-2 text-xs text-warning/90 space-y-0.5 max-h-20 overflow-y-auto">
                      {batchImportResult.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <Button 
                type="button" 
                className="w-full h-11 text-sm font-medium rounded-xl shadow-sm"
                onClick={handleSsoImport}
                disabled={isVerifying || !ssoToken.trim()}
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {isEn ? `Importing ${ssoToken.split('\n').filter(t => t.trim()).length} accounts...` : `Importing concurrently ${ssoToken.split('\n').filter(t => t.trim()).length} accounts...`}
                  </>
                ) : (
                  ssoToken.split('\n').filter(t => t.trim()).length > 1 
                    ? (isEn ? `Batch import ${ssoToken.split('\n').filter(t => t.trim()).length} accounts` : `Batch import ${ssoToken.split('\n').filter(t => t.trim()).length} accounts`)
                    : (isEn ? 'Import & Verify' : 'Import and verify')
                )}
              </Button>
            </div>
          )}

          {/* OIDC Voucher input mode */}
          {importMode === 'oidc' && !verifiedData && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{isEn ? 'Enter OIDC Token' : 'enter OIDC certificate'}</h3>
                <div className="flex items-center gap-2">
                  {/* single/batch switch */}
                  <div className="flex bg-muted/50 rounded-lg p-0.5">
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'single' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('single'); setOidcBatchImportResult(null) }}
                    >
                      {isEn ? 'Single' : 'single'}
                    </button>
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'batch' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('batch'); setOidcBatchImportResult(null) }}
                    >
                      {isEn ? 'Batch' : 'batch'}
                    </button>
                  </div>
                  {oidcImportMode === 'single' && (
                    <Button 
                      type="button" 
                      variant="outline" 
                      size="sm"
                      className="h-7 rounded-lg text-xs"
                      onClick={handleImportFromLocal}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      {isEn ? 'Import' : 'Local import'}
                    </Button>
                  )}
                </div>
              </div>

              {/* Single import mode */}
              {oidcImportMode === 'single' && (
                <>
                  <div className="space-y-4">
                    {/* Login type selection */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{isEn ? 'Login Type' : 'Login type'}</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'IdC' && provider === 'BuilderId' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('IdC')
                            setProvider('BuilderId')
                          }}
                        >
                          Builder ID
                        </button>
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'IdC' && provider === 'Enterprise' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('IdC')
                            setProvider('Enterprise')
                          }}
                        >
                          Enterprise
                        </button>
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'social' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('social')
                            setProvider('Google')
                          }}
                        >
                          Social
                        </button>
                      </div>
                      {authMethod === 'social' && (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className={`flex-1 h-8 px-3 text-xs rounded-lg border transition-all ${provider === 'Google' ? 'bg-primary/20 text-primary border-primary/50' : 'bg-background border-input hover:bg-muted'}`}
                              onClick={() => setProvider('Google')}
                            >
                              Google
                            </button>
                            <button
                              type="button"
                              className={`flex-1 h-8 px-3 text-xs rounded-lg border transition-all ${provider === 'Github' ? 'bg-primary/20 text-primary border-primary/50' : 'bg-background border-input hover:bg-muted'}`}
                              onClick={() => setProvider('Github')}
                            >
                              GitHub
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {isEn ? 'Social login does not require Client ID and Secret' : 'Social login not required Client ID and Client Secret'}
                          </p>
                        </div>
                      )}
                      {authMethod === 'IdC' && provider === 'Enterprise' && (
                        <p className="text-xs text-muted-foreground">
                          Enterprise (IAM Identity Center SSO)
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Refresh Token <span className="text-destructive">*</span>
                      </label>
                      <textarea
                        className="w-full min-h-[80px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                        placeholder={isEn ? 'Paste Refresh Token...' : 'Paste Refresh Token...'}
                        value={refreshToken}
                        onChange={(e) => setRefreshToken(e.target.value)}
                      />
                    </div>

                    {/* IdC Login required Client ID、Client Secret and Region */}
                    {authMethod !== 'social' && (
                      <>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Client ID <span className="text-destructive">*</span>
                            </label>
                            <input
                              type="text"
                              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                              placeholder="Client ID"
                              value={clientId}
                              onChange={(e) => setClientId(e.target.value)}
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Client Secret <span className="text-destructive">*</span>
                            </label>
                            <input
                              type="password"
                              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                              placeholder="Client Secret"
                              value={clientSecret}
                              onChange={(e) => setClientSecret(e.target.value)}
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">AWS Region</label>
                          <div className="flex gap-2">
                            <select
                              className="flex-1 h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                              value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                              onChange={(e) => {
                                if (e.target.value !== 'custom') setRegion(e.target.value)
                              }}
                            >
                              <optgroup label="US">
                                <option value="us-east-1">us-east-1 (N. Virginia)</option>
                                <option value="us-east-2">us-east-2 (Ohio)</option>
                                <option value="us-west-1">us-west-1 (N. California)</option>
                                <option value="us-west-2">us-west-2 (Oregon)</option>
                              </optgroup>
                              <optgroup label="Europe">
                                <option value="eu-west-1">eu-west-1 (Ireland)</option>
                                <option value="eu-west-2">eu-west-2 (London)</option>
                                <option value="eu-west-3">eu-west-3 (Paris)</option>
                                <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                                <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                                <option value="eu-south-1">eu-south-1 (Milan)</option>
                              </optgroup>
                              <optgroup label="Asia Pacific">
                                <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                                <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                                <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                                <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                                <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                                <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                                <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                              </optgroup>
                              <optgroup label="Other">
                                <option value="ca-central-1">ca-central-1 (Canada)</option>
                                <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                                <option value="me-south-1">me-south-1 (Bahrain)</option>
                                <option value="af-south-1">af-south-1 (Cape Town)</option>
                              </optgroup>
                              <optgroup label={isEn ? 'Custom' : 'Customize'}>
                                <option value="custom">{isEn ? '-- Custom --' : '-- Customize --'}</option>
                              </optgroup>
                            </select>
                            <input
                              type="text"
                              value={region}
                              onChange={(e) => setRegion(e.target.value)}
                              placeholder={isEn ? 'e.g., cn-north-1' : 'For example: cn-north-1'}
                              className="w-28 h-10 px-2 text-sm rounded-xl border border-input bg-background/50"
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}

              {/* Batch import mode */}
              {oidcImportMode === 'batch' && (
                <>
                  <div className="p-3 bg-primary/[0.04] rounded-xl border border-primary/15">
                    <p className="text-xs text-primary">
                      {isEn ? 'Supports JSON array or Card Key format. JSON required:' : 'support JSON Array or card format.JSON Required:'} <code className="px-1 bg-primary/15 rounded">refreshToken</code>.
                      {isEn ? 'Card Key format:' : 'Card secret format:'} <code className="px-1 bg-primary/15 rounded">{isEn ? 'email----pwd----token----id----secret' : 'Mail----password----Token----ID----Secret'}</code>
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      {isEn ? 'Credentials Data' : 'Voucher data'} <span className="text-destructive">*</span>
                    </label>
                    <textarea
                      className="w-full min-h-[180px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono text-xs"
                      placeholder={isEn 
                        ? `JSON format:
[
  {
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId"
  },
  {
    "refreshToken": "yyy",
    "clientId": "yyy",
    "clientSecret": "yyy",
    "provider": "Enterprise"
  },
  {
    "refreshToken": "zzz",
    "provider": "Github"
  },
  {
    "refreshToken": "aaa",
    "provider": "Google"
  }
]

Or Card Key format (one per line):
email----password----refreshToken----clientId----clientSecret`
                        : `JSON Format:
[
  {
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId"
  },
  {
    "refreshToken": "yyy",
    "clientId": "yyy",
    "clientSecret": "yyy",
    "provider": "Enterprise"
  },
  {
    "refreshToken": "zzz",
    "provider": "Github"
  },
  {
    "refreshToken": "aaa",
    "provider": "Google"
  }
]

Or card secret format (one per line):
Mail----password----RefreshToken----ClientId----ClientSecret`}
                      value={oidcBatchData}
                      onChange={(e) => { setOidcBatchData(e.target.value); setOidcBatchImportResult(null) }}
                    />
                    {oidcBatchData.trim() && (() => {
                      const val = oidcBatchData.trim()
                      try {
                        const parsed = JSON.parse(val)
                        const count = Array.isArray(parsed) ? parsed.length : 1
                        return <p className="text-xs text-muted-foreground">{isEn ? `Entered ${count} credentials (JSON)` : `entered ${count} voucher (JSON)`}</p>
                      } catch {
                        // Try card format count
                        const kamiLines = val.split('\n').filter(l => l.trim() && !l.startsWith('#'))
                        if (kamiLines.length > 0 && kamiLines.some(l => l.includes('----') || l.includes('\t') || /\s{2,}/.test(l))) {
                          return <p className="text-xs text-muted-foreground">{isEn ? `Entered ${kamiLines.length} credentials (Card Key)` : `entered ${kamiLines.length} voucher (Card secret format)`}</p>
                        }
                        return <p className="text-xs text-destructive">{isEn ? 'Invalid format (JSON or Card Key)' : 'Format error (support JSON or card format)'}</p>
                      }
                    })()}
                  </div>

                  {/* Batch import results */}
                  {oidcBatchImportResult && (
                    <div className={`p-3 rounded-lg text-sm ${oidcBatchImportResult.failed > 0 ? 'bg-warning/10 border border-warning/30' : 'bg-success/10 border border-success/30'}`}>
                      <p className={`font-medium ${oidcBatchImportResult.failed > 0 ? 'text-warning' : 'text-success'}`}>
                        {isEn ? `Result: ${oidcBatchImportResult.success}/${oidcBatchImportResult.total} succeeded` : `Import results: success ${oidcBatchImportResult.success}/${oidcBatchImportResult.total}`}
                      </p>
                      {oidcBatchImportResult.errors.length > 0 && (
                        <ul className="mt-2 text-xs text-warning/90 space-y-0.5 max-h-20 overflow-y-auto">
                          {oidcBatchImportResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* error message */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
              <div className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
              {error}
            </div>
          )}

          {/* submit button - only in OIDC Mode display */}
          {importMode === 'oidc' && (
            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={onClose} className="rounded-xl h-10 px-6">
                {isEn ? 'Cancel' : 'Cancel'}
              </Button>
              {oidcImportMode === 'single' ? (
                <Button 
                  onClick={handleOidcAdd} 
                  disabled={isSubmitting || !refreshToken || (authMethod !== 'social' && (!clientId || !clientSecret))}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {isEn ? 'Add Account' : 'Confirm to add'}
                </Button>
              ) : (
                <Button 
                  onClick={handleOidcBatchAdd} 
                  disabled={isSubmitting || !oidcBatchData.trim()}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {isEn ? 'Importing...' : 'Importing concurrently...'}
                    </>
                  ) : (
                    (() => {
                      try {
                        const parsed = JSON.parse(oidcBatchData.trim())
                        const count = Array.isArray(parsed) ? parsed.length : 1
                        return isEn ? `Batch import ${count} accounts` : `Batch import ${count} accounts`
                      } catch {
                        return isEn ? 'Batch Import' : 'Batch import'
                      }
                    })()
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
