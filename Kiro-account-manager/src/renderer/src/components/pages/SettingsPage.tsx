import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import { Eye, EyeOff, RefreshCw, Clock, Trash2, Download, Upload, Globe, Repeat, Palette, Moon, Sun, Fingerprint, Info, ChevronDown, ChevronUp, Settings, Database, Layers, UserX, Monitor } from 'lucide-react'
import { useState, useEffect } from 'react'
import { ExportDialog } from '../accounts/ExportDialog'
import { useTranslation } from '@/hooks/useTranslation'

// Theme configuration - Group by color
const themeGroupsZh = [
  {
    name: 'blue color',
    themes: [
      { id: 'default', name: 'sky blue', color: '#3b82f6' },
      { id: 'indigo', name: 'Jinglan', color: '#6366f1' },
      { id: 'cyan', name: 'fresh green', color: '#06b6d4' },
      { id: 'sky', name: 'clear sky blue', color: '#0ea5e9' },
      { id: 'teal', name: 'teal blue', color: '#14b8a6' },
    ]
  },
  {
    name: 'Purple red series',
    themes: [
      { id: 'purple', name: 'elegant purple', color: '#a855f7' },
      { id: 'violet', name: 'violet', color: '#8b5cf6' },
      { id: 'fuchsia', name: 'magenta', color: '#d946ef' },
      { id: 'pink', name: 'pink', color: '#ec4899' },
      { id: 'rose', name: 'guilloché red', color: '#f43f5e' },
    ]
  },
  {
    name: 'Warm colors',
    themes: [
      { id: 'red', name: 'passion red', color: '#ef4444' },
      { id: 'orange', name: 'Vibrant orange', color: '#f97316' },
      { id: 'amber', name: 'amber gold', color: '#f59e0b' },
      { id: 'yellow', name: 'bright yellow', color: '#eab308' },
    ]
  },
  {
    name: 'green system',
    themes: [
      { id: 'emerald', name: 'verdant', color: '#10b981' },
      { id: 'green', name: 'green grass', color: '#22c55e' },
      { id: 'lime', name: 'lime', color: '#84cc16' },
    ]
  },
  {
    name: 'neutral colors',
    themes: [
      { id: 'slate', name: 'slate gray', color: '#64748b' },
      { id: 'zinc', name: 'Zinc gray', color: '#71717a' },
      { id: 'stone', name: 'warm gray', color: '#78716c' },
      { id: 'neutral', name: 'neutral gray', color: '#737373' },
    ]
  },
  {
    name: 'Luxurious colors',
    themes: [
      { id: 'gold', name: 'luxury gold', color: '#C9A227' },
      { id: 'navy', name: 'navy blue', color: '#1E40AF' },
      { id: 'wine', name: 'wine red', color: '#9F1239' },
      { id: 'champagne', name: 'champagne', color: '#B89968' },
    ]
  },
  {
    name: 'Morandi',
    themes: [
      { id: 'dustyblue', name: 'smoke blue', color: '#64748B' },
      { id: 'terracotta', name: 'Terracotta Orange', color: '#B45434' },
      { id: 'sage', name: 'sage', color: '#6B8E5A' },
      { id: 'mauve', name: 'smoke purple', color: '#8E7CC3' },
    ]
  },
  {
    name: 'Natural dark color',
    themes: [
      { id: 'coral', name: 'coral pink', color: '#F87171' },
      { id: 'forest', name: 'forest green', color: '#166534' },
      { id: 'ocean', name: 'deep sea green', color: '#155E75' },
    ]
  }
]

const themeGroupsEn = [
  {
    name: 'Blue',
    themes: [
      { id: 'default', name: 'Sky Blue', color: '#3b82f6' },
      { id: 'indigo', name: 'Indigo', color: '#6366f1' },
      { id: 'cyan', name: 'Cyan', color: '#06b6d4' },
      { id: 'sky', name: 'Sky', color: '#0ea5e9' },
      { id: 'teal', name: 'Teal', color: '#14b8a6' },
    ]
  },
  {
    name: 'Purple',
    themes: [
      { id: 'purple', name: 'Purple', color: '#a855f7' },
      { id: 'violet', name: 'Violet', color: '#8b5cf6' },
      { id: 'fuchsia', name: 'Fuchsia', color: '#d946ef' },
      { id: 'pink', name: 'Pink', color: '#ec4899' },
      { id: 'rose', name: 'Rose', color: '#f43f5e' },
    ]
  },
  {
    name: 'Warm',
    themes: [
      { id: 'red', name: 'Red', color: '#ef4444' },
      { id: 'orange', name: 'Orange', color: '#f97316' },
      { id: 'amber', name: 'Amber', color: '#f59e0b' },
      { id: 'yellow', name: 'Yellow', color: '#eab308' },
    ]
  },
  {
    name: 'Green',
    themes: [
      { id: 'emerald', name: 'Emerald', color: '#10b981' },
      { id: 'green', name: 'Green', color: '#22c55e' },
      { id: 'lime', name: 'Lime', color: '#84cc16' },
    ]
  },
  {
    name: 'Neutral',
    themes: [
      { id: 'slate', name: 'Slate', color: '#64748b' },
      { id: 'zinc', name: 'Zinc', color: '#71717a' },
      { id: 'stone', name: 'Stone', color: '#78716c' },
      { id: 'neutral', name: 'Neutral', color: '#737373' },
    ]
  },
  {
    name: 'Luxury',
    themes: [
      { id: 'gold', name: 'Gold', color: '#C9A227' },
      { id: 'navy', name: 'Navy', color: '#1E40AF' },
      { id: 'wine', name: 'Wine', color: '#9F1239' },
      { id: 'champagne', name: 'Champagne', color: '#B89968' },
    ]
  },
  {
    name: 'Morandi',
    themes: [
      { id: 'dustyblue', name: 'Dusty Blue', color: '#64748B' },
      { id: 'terracotta', name: 'Terracotta', color: '#B45434' },
      { id: 'sage', name: 'Sage', color: '#6B8E5A' },
      { id: 'mauve', name: 'Mauve', color: '#8E7CC3' },
    ]
  },
  {
    name: 'Natural',
    themes: [
      { id: 'coral', name: 'Coral', color: '#F87171' },
      { id: 'forest', name: 'Forest', color: '#166534' },
      { id: 'ocean', name: 'Ocean', color: '#155E75' },
    ]
  }
]

export function SettingsPage() {
  const { 
    privacyMode, 
    setPrivacyMode,
    usagePrecision,
    setUsagePrecision,
    autoRefreshEnabled,
    autoRefreshInterval,
    autoRefreshConcurrency,
    autoRefreshSyncInfo,
    proactiveRenewalEnabled,
    proactiveRenewalLeadMinutes,
    setProactiveRenewalEnabled,
    setAutoRefresh,
    setAutoRefreshConcurrency,
    setAutoRefreshSyncInfo,
    checkAndRefreshExpiringTokens,
    proxyEnabled,
    proxyUrl,
    setProxy,
    autoSwitchEnabled,
    autoSwitchThreshold,
    autoSwitchInterval,
    setAutoSwitch,
    batchImportConcurrency,
    setBatchImportConcurrency,
    loginPrivateMode,
    setLoginPrivateMode,
    switchTarget,
    setSwitchTarget,
    theme,
    darkMode,
    setTheme,
    setDarkMode,
    language,
    setLanguage,
    accounts,
    importFromExportData
  } = useAccountsStore()

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [tempProxyUrl, setTempProxyUrl] = useState(proxyUrl)
  const [themeExpanded, setThemeExpanded] = useState(false)
  const [isManualRefreshing, setIsManualRefreshing] = useState(false)
  
  // Tray setup status
  const [traySettings, setTraySettings] = useState({
    enabled: true,
    closeAction: 'ask' as 'ask' | 'minimize' | 'quit',
    showNotifications: true,
    minimizeOnStart: false
  })
  const [trayLoading, setTrayLoading] = useState(true)

  // Shortcut key setting status
  const [showWindowShortcut, setShowWindowShortcut] = useState('')
  const [shortcutLoading, setShortcutLoading] = useState(true)
  const [shortcutError, setShortcutError] = useState('')
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false)

  // Load shortcut key settings
  useEffect(() => {
    const loadShortcut = async () => {
      try {
        const shortcut = await window.api.getShowWindowShortcut()
        setShowWindowShortcut(shortcut)
      } catch (error) {
        console.error('Failed to load shortcut:', error)
      } finally {
        setShortcutLoading(false)
      }
    }
    loadShortcut()
  }, [])

  // Save shortcut key settings
  const handleShortcutChange = async (shortcut: string) => {
    setShowWindowShortcut(shortcut)
    setShortcutError('')
    try {
      const result = await window.api.setShowWindowShortcut(shortcut)
      if (!result.success) {
        setShortcutError(result.error || 'Failed to set shortcut')
      }
    } catch (error) {
      setShortcutError(String(error))
    }
  }

  // Key recording processing
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isRecordingShortcut) return
    e.preventDefault()
    
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.metaKey) parts.push('Command')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    
    // Ignore individual modifier keys
    const key = e.key
    if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
      // Convert special key names
      const keyName = key.length === 1 ? key.toUpperCase() : key
      parts.push(keyName)
      
      const shortcut = parts.join('+')
      handleShortcutChange(shortcut)
      setIsRecordingShortcut(false)
    }
  }

  // Usage API type status
  const [usageApiType, setUsageApiType] = useState<'rest' | 'cbor'>('rest')
  const [usageApiLoading, setUsageApiLoading] = useState(true)

  // load Usage API Type settings
  useEffect(() => {
    const loadUsageApiType = async () => {
      try {
        const type = await window.api.getUsageApiType()
        setUsageApiType(type)
      } catch (error) {
        console.error('Failed to load usage API type:', error)
      } finally {
        setUsageApiLoading(false)
      }
    }
    loadUsageApiType()
  }, [])

  // save Usage API type
  const handleUsageApiTypeChange = async (type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    try {
      await window.api.setUsageApiType(type)
    } catch (error) {
      console.error('Failed to save usage API type:', error)
    }
  }

  // K-Proxy proxy settings status
  const [useKProxyForApi, setUseKProxyForApi] = useState(false)
  const [kproxyLoading, setKproxyLoading] = useState(true)

  // load K-Proxy proxy settings
  useEffect(() => {
    const loadKProxySettings = async () => {
      try {
        const enabled = await window.api.getUseKProxyForApi()
        setUseKProxyForApi(enabled)
      } catch (error) {
        console.error('Failed to load K-Proxy settings:', error)
      } finally {
        setKproxyLoading(false)
      }
    }
    loadKProxySettings()
  }, [])

  // save K-Proxy proxy settings
  const handleKProxyChange = async (enabled: boolean) => {
    setUseKProxyForApi(enabled)
    try {
      await window.api.setUseKProxyForApi(enabled)
    } catch (error) {
      console.error('Failed to save K-Proxy settings:', error)
    }
  }

  // Load tray settings
  useEffect(() => {
    const loadTraySettings = async () => {
      try {
        const settings = await window.api.getTraySettings()
        setTraySettings(settings)
      } catch (error) {
        console.error('Failed to load tray settings:', error)
      } finally {
        setTrayLoading(false)
      }
    }
    loadTraySettings()
  }, [])

  // Save tray settings
  const handleTraySettingChange = async (key: keyof typeof traySettings, value: boolean | string) => {
    const newSettings = { ...traySettings, [key]: value }
    setTraySettings(newSettings)
    try {
      await window.api.saveTraySettings({ [key]: value })
    } catch (error) {
      console.error('Failed to save tray settings:', error)
    }
  }

  const handleManualRefresh = async () => {
    setIsManualRefreshing(true)
    try {
      await checkAndRefreshExpiringTokens()
    } finally {
      setIsManualRefreshing(false)
    }
  }
  const themeGroups = isEn ? themeGroupsEn : themeGroupsZh

  const handleExport = () => {
    setShowExportDialog(true)
  }

  const handleImport = async () => {
    setIsImporting(true)
    try {
      const fileData = await window.api.importFromFile()
      if (fileData && fileData.format === 'json') {
        const data = JSON.parse(fileData.content)
        const importResult = importFromExportData(data)
        alert(`Import completed: successful ${importResult.success} one, failed ${importResult.failed} indivual`)
      } else if (fileData) {
        alert('The settings page only supports JSON Format import, please use the account management page to import. CSV/TXT')
      }
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setIsImporting(false)
    }
  }

  const handleClearData = () => {
    if (confirm('Are you sure you want to clear all account data? This operation is irreversible!')) {
      if (confirm('Confirm again: this will delete all account, group and tag data!')) {
        // Clear all data
        Array.from(accounts.keys()).forEach(id => {
          useAccountsStore.getState().removeAccount(id)
        })
        alert('All data cleared')
      }
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Page header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
            <Settings className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{t('settings.title')}</h1>
            <p className="text-muted-foreground">{t('settings.title') === 'Settings' ? 'Configure app features' : 'Configure app features'}</p>
          </div>
        </div>
      </div>

      {/* Language settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            language / Language
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Display language / Display Language</p>
              <p className="text-sm text-muted-foreground">Select interface display language / Select interface language</p>
            </div>
            <select
              className="w-[160px] h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'auto' | 'en' | 'zh')}
            >
              <option value="auto">🌐 automatic (Auto)</option>
              <option value="zh">🇨🇳 Simplified Chinese</option>
              <option value="en">🇺🇸 English</option>
            </select>
          </div>
          <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 space-y-1">
            <p>• Automatic mode will automatically select based on the system language</p>
            <p>• Auto mode will follow system language</p>
            <p>• Support custom translation file extension (under development)</p>
          </div>
        </CardContent>
      </Card>

      {/* Theme settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Palette className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Theme' : 'Theme settings'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* dark mode */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Dark Mode' : 'dark mode'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Toggle dark/light theme' : 'switch dark color/light theme'}</p>
            </div>
            <Button
              variant={darkMode ? "default" : "outline"}
              size="sm"
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? <Moon className="h-4 w-4 mr-2" /> : <Sun className="h-4 w-4 mr-2" />}
              {darkMode ? (isEn ? 'Dark' : 'Dark') : (isEn ? 'Light' : 'light color')}
            </Button>
          </div>

          {/* theme color */}
          <div className="pt-2 border-t">
            <button 
              className="flex items-center justify-between w-full text-left"
              onClick={() => setThemeExpanded(!themeExpanded)}
            >
              <div className="flex items-center gap-2">
                <p className="font-medium">{isEn ? 'Theme Color' : 'theme color'}</p>
                {!themeExpanded && (
                  <div 
                    className="w-5 h-5 rounded-full ring-2 ring-primary ring-offset-1"
                    style={{ backgroundColor: themeGroups.flatMap(g => g.themes).find(t => t.id === theme)?.color || '#3b82f6' }}
                  />
                )}
              </div>
              {themeExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {themeExpanded && (
              <div className="space-y-3 mt-3">
                {themeGroups.map((group) => (
                  <div key={group.name} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-14 shrink-0">{group.name}</span>
                    <div className="flex flex-wrap gap-2">
                      {group.themes.map((t) => (
                        <button
                          key={t.id}
                          className={`group relative w-7 h-7 rounded-full transition-all ${
                            theme === t.id 
                              ? 'ring-2 ring-primary ring-offset-2 scale-110' 
                              : 'hover:scale-110 hover:shadow-md'
                          }`}
                          style={{ backgroundColor: t.color }}
                          onClick={() => setTheme(t.id)}
                          title={t.name}
                        >
                          <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity bg-popover px-1.5 py-0.5 rounded shadow-sm border pointer-events-none z-10">
                            {t.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Privacy settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              {privacyMode ? <EyeOff className="h-4 w-4 text-primary" /> : <Eye className="h-4 w-4 text-primary" />}
            </div>
            {isEn ? 'Privacy' : 'Privacy settings'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Privacy Mode' : 'privacy mode'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Hide emails and sensitive info' : 'Hide sensitive email and account information'}</p>
            </div>
            <Button
              variant={privacyMode ? "default" : "outline"}
              size="sm"
              onClick={() => setPrivacyMode(!privacyMode)}
            >
              {privacyMode ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
              {privacyMode ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">{isEn ? 'Usage Precision' : 'Usage accuracy'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Show decimal places for usage values' : 'Display usage to decimal precision (e.g. 1.22 rather than 1）'}</p>
            </div>
            <Button
              variant={usagePrecision ? "default" : "outline"}
              size="sm"
              onClick={() => setUsagePrecision(!usagePrecision)}
            >
              {usagePrecision ? (isEn ? 'Decimal' : 'decimal') : (isEn ? 'Integer' : 'integer')}
            </Button>
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">{isEn ? 'Switch Target' : 'Number cut target'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Which client to switch account credentials to' : 'Switch the client where account credentials are written'}</p>
            </div>
            <select
              className="h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              value={switchTarget}
              onChange={(e) => setSwitchTarget(e.target.value as 'ide' | 'cli' | 'both')}
            >
              <option value="ide">Kiro IDE</option>
              <option value="cli">Kiro CLI</option>
              <option value="both">{isEn ? 'Both (IDE + CLI)' : 'both (IDE + CLI)'}</option>
            </select>
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">{isEn ? 'Login Private Mode' : 'Log in to privacy mode'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Open browser in incognito/private mode when logging in' : 'Use an incognito browser when logging in online/Privacy mode on'}</p>
            </div>
            <Button
              variant={loginPrivateMode ? "default" : "outline"}
              size="sm"
              onClick={() => setLoginPrivateMode(!loginPrivateMode)}
            >
              <UserX className="h-4 w-4 mr-2" />
              {loginPrivateMode ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Token Refresh settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <RefreshCw className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Auto Refresh' : 'Auto refresh'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Auto Refresh' : 'Auto refresh'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Auto refresh tokens before expiration' : 'Token Automatically refresh before expiration and update account information synchronously'}</p>
            </div>
            <Button
              variant={autoRefreshEnabled ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh(!autoRefreshEnabled)}
            >
              {autoRefreshEnabled ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>

          <div className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg p-3 space-y-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              {isEn ? 'About Kiro IDE auto refresh' : 'about Kiro IDE Auto refresh'}
            </p>
            <p>
              {isEn
                ? '• Kiro IDE has its own internal refresh loop (independent of this app). Disabling Auto Refresh here only stops this app from refreshing — it does NOT stop Kiro IDE.'
                : `• Kiro IDE Comes with independent refresh cycle, close this tool"Auto refresh"won't stop IDE own refresh.`}
            </p>
            <p>
              {isEn
                ? '• When switching accounts or refreshing tokens here, the new token is synced to ~/.aws/sso/cache/kiro-auth-token.json only for the IDE current active account; other accounts only update the local store.'
                : '• Cut number / refresh Token , only if the account is Kiro IDE Only the currently activated account will be synchronized to the disk file; inactive accounts will only update the inside of this tool. store。'}
            </p>
            <p>
              {isEn
                ? '• If IDE refreshes the token itself, this app detects the file change and syncs the new token back to its store (bidirectional sync).'
                : '• when Kiro IDE Own refresh Afterwards, this tool will monitor disk file changes and reversely synchronize to store(Two-way sync).'}
            </p>
          </div>

          {/* Active renewal switch (off by default) */}
          <div className="flex items-center justify-between pt-3 border-t">
            <div>
              <p className="font-medium">
                {isEn ? 'Proactive Token Renewal for IDE' : 'IDE Active renewal'}
                <span className="ml-2 text-xs text-muted-foreground">
                  ({isEn ? 'Advanced' : 'Advanced'})
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {isEn
                  ? `Renew IDE's active token ~${proactiveRenewalLeadMinutes} min before expiry, so Kiro IDE never refreshes by itself (eliminates all race conditions).`
                  : `exist IDE Account activated token left ~${proactiveRenewalLeadMinutes} First in minutes refresh,let Kiro IDE never myself refresh(completely eliminates race conditions).`}
              </p>
            </div>
            <Button
              variant={proactiveRenewalEnabled ? 'default' : 'outline'}
              size="sm"
              onClick={async () => {
                const result = await setProactiveRenewalEnabled(!proactiveRenewalEnabled)
                if (!result.success && result.error) {
                  alert(
                    (isEn ? 'Failed to toggle proactive renewal: ' : 'Failed to switch active renewal:') +
                      result.error
                  )
                }
              }}
            >
              {proactiveRenewalEnabled ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>
          {proactiveRenewalEnabled && (
            <div className="text-xs text-muted-foreground bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-lg p-3 space-y-1">
              <p>
                {isEn
                  ? `• On: a single in-process timer renews token ${proactiveRenewalLeadMinutes} min before expiry; Kiro IDE keeps seeing fresh tokens (≥${60 - proactiveRenewalLeadMinutes} min remaining) and never invokes OIDC by itself.`
                  : `• After enabling: the account manager main process will be in token left ${proactiveRenewalLeadMinutes} Automatically renews every minute,Kiro IDE always see remaining ≥ ${60 - proactiveRenewalLeadMinutes} minutes token, will never adjust it by itself OIDC。`}
              </p>
              <p>
                {isEn
                  ? '• Only the IDE current active account is renewed. Switching accounts re-schedules the timer for the new active account.'
                  : '• only for IDE Current active account renewal. When cutting numbers timer It will be automatically rescheduled to a new account.'}
              </p>
              <p>
                {isEn
                  ? '• If a renewal fails (e.g. server outage), the timer stops; IDE\'s own refresh loop takes over as fallback.'
                  : '• When renewal fails timer stop by IDE own refresh loop Takeover (two-way sync still takes effect).'}
              </p>
            </div>
          )}

          {autoRefreshEnabled && (
            <>
              <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 space-y-1">
                <p>• {isEn ? 'Auto refresh tokens to keep login' : 'Token Automatically refresh when it is about to expire and keep you logged in'}</p>
                <p>• {isEn ? 'Update usage and subscription info after refresh' : 'Token Automatically update account usage, subscription and other information after refreshing'}</p>
                <p>• {isEn ? 'Check all balances when auto-switch is on' : 'When automatic number change is turned on, all account balances will be checked regularly'}</p>
              </div>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">{isEn ? 'Check Interval' : 'Check interval'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'How often to check account status' : 'How often should you check your account status?'}</p>
                </div>
                <select
                  className="w-[120px] h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoRefreshInterval}
                  onChange={(e) => setAutoRefresh(true, parseInt(e.target.value))}
                >
                  <option value="1">{isEn ? '1 min' : '1 minute'}</option>
                  <option value="3">{isEn ? '3 min' : '3 minute'}</option>
                  <option value="5">{isEn ? '5 min' : '5 minute'}</option>
                  <option value="10">{isEn ? '10 min' : '10 minute'}</option>
                  <option value="15">{isEn ? '15 min' : '15 minute'}</option>
                  <option value="20">{isEn ? '20 min' : '20 minute'}</option>
                  <option value="30">{isEn ? '30 min' : '30 minute'}</option>
                  <option value="45">{isEn ? '45 min' : '45 minute'}</option>
                  <option value="60">{isEn ? '60 min' : '60 minute'}</option>
                </select>
              </div>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">{isEn ? 'Concurrency' : 'Number of concurrent refreshes'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Number of accounts to refresh simultaneously' : 'The number of accounts refreshed at the same time may cause lag if it is too large.'}</p>
                </div>
                <input
                  type="number"
                  className="w-24 h-9 px-3 rounded-lg border bg-background text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoRefreshConcurrency}
                  min={1}
                  max={500}
                  onChange={(e) => setAutoRefreshConcurrency(parseInt(e.target.value) || 50)}
                />
              </div>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">{isEn ? 'Sync Account Info' : 'Synchronously detect account information'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Detect usage, subscription, and ban status' : 'refresh Token Detect usage, subscription, and ban status simultaneously'}</p>
                </div>
                <Button
                  variant={autoRefreshSyncInfo ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAutoRefreshSyncInfo(!autoRefreshSyncInfo)}
                >
                  {autoRefreshSyncInfo ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
                </Button>
              </div>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">{isEn ? 'Manual Trigger' : 'manual trigger'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Manually trigger auto-refresh for debugging' : 'Manually trigger an automatic refresh process (for debugging)'}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleManualRefresh}
                  disabled={isManualRefreshing}
                >
                  {isManualRefreshing ? (isEn ? 'Refreshing...' : 'Refreshing...') : (isEn ? 'Trigger Now' : 'trigger immediately')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* API Type settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Database className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'API Settings' : 'API set up'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Usage API Type' : 'Usage query API'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Select API type for querying usage limits' : 'Choose to query account usage API type'}</p>
            </div>
            <select
              className="w-[180px] h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              value={usageApiType}
              onChange={(e) => handleUsageApiTypeChange(e.target.value as 'rest' | 'cbor')}
              disabled={usageApiLoading}
            >
              <option value="rest">REST (GetUsageLimits)</option>
              <option value="cbor">CBOR (GetUserUsageAndLimits)</option>
            </select>
          </div>
          <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 space-y-1">
            <p>• <strong>REST</strong>: {isEn ? 'Official Kiro IDE format, recommended' : 'official Kiro IDE The format used is recommended'}</p>
            <p>• <strong>CBOR</strong>: {isEn ? 'Web portal format, may have different fields' : 'Web page format, fields may be different'}</p>
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">{isEn ? 'Use K-Proxy for API' : 'API Ask to go K-Proxy'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Route API requests through K-Proxy MITM proxy' : 'API Request passed K-Proxy MITM Send as agent'}</p>
            </div>
            <Button
              variant={useKProxyForApi ? "default" : "outline"}
              size="sm"
              onClick={() => handleKProxyChange(!useKProxyForApi)}
              disabled={kproxyLoading}
            >
              {useKProxyForApi ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>
          {useKProxyForApi && (
            <div className="text-xs text-amber-500 bg-amber-500/10 rounded-lg p-3">
              {isEn ? '⚠️ K-Proxy must be running for this to work' : '⚠️ Need to start first K-Proxy MITM The agent can take effect'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* proxy settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Proxy' : 'proxy settings'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Enable Proxy' : 'Enable proxy'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'All requests through proxy server' : 'All network requests will go through the proxy server'}</p>
            </div>
            <Button
              variant={proxyEnabled ? "default" : "outline"}
              size="sm"
              onClick={() => setProxy(!proxyEnabled, tempProxyUrl)}
            >
              {proxyEnabled ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <label className="text-sm font-medium">{isEn ? 'Proxy URL' : 'proxy address'}</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 h-9 px-3 rounded-lg border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                placeholder={isEn ? 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080' : 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080'}
                value={tempProxyUrl}
                onChange={(e) => setTempProxyUrl(e.target.value)}
              />
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setProxy(proxyEnabled, tempProxyUrl)}
                disabled={tempProxyUrl === proxyUrl}
              >
                {isEn ? 'Save' : 'save'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isEn ? 'Supports HTTP/HTTPS/SOCKS5, format: protocol://host:port' : 'support HTTP/HTTPS/SOCKS5 agent, format: protocol://host:port'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Automatic number change settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Repeat className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Auto Switch' : 'Automatic number change'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Enable Auto Switch' : 'Enable automatic number changing'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Auto switch when balance is low' : 'Automatically switch to other available accounts when the balance is insufficient'}</p>
            </div>
            <Button
              variant={autoSwitchEnabled ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoSwitch(!autoSwitchEnabled)}
            >
              {autoSwitchEnabled ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>

          {autoSwitchEnabled && (
            <>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">{isEn ? 'Balance Threshold' : 'Balance threshold'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Switch when balance below this' : 'Automatically switches when the balance is lower than this value'}</p>
                </div>
                <input
                  type="number"
                  className="w-20 h-9 px-3 rounded-lg border bg-background text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoSwitchThreshold}
                  min={0}
                  onChange={(e) => setAutoSwitch(true, parseInt(e.target.value) || 0)}
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    {isEn ? 'Check Interval' : 'Check interval'}
                  </p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'How often to check balance' : 'How often to check your balance'}</p>
                </div>
                <select
                  className="h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoSwitchInterval}
                  onChange={(e) => setAutoSwitch(true, undefined, parseInt(e.target.value))}
                >
                  <option value="1">{isEn ? '1 min' : '1 minute'}</option>
                  <option value="3">{isEn ? '3 min' : '3 minute'}</option>
                  <option value="5">{isEn ? '5 min' : '5 minute'}</option>
                  <option value="10">{isEn ? '10 min' : '10 minute'}</option>
                  <option value="15">{isEn ? '15 min' : '15 minute'}</option>
                  <option value="30">{isEn ? '30 min' : '30 minute'}</option>
                </select>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Batch import settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Layers className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Batch Import' : 'Batch import'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Concurrency' : 'Number of concurrencies'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Too high may cause API rate limiting' : 'The number of accounts to be verified simultaneously, if too large, may result in API Current limiting'}</p>
            </div>
            <input
              type="number"
              className="w-24 h-9 px-3 rounded-lg border bg-background text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              value={batchImportConcurrency}
              min={1}
              max={500}
              onChange={(e) => setBatchImportConcurrency(parseInt(e.target.value) || 100)}
            />
          </div>
          <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-2">
            {isEn ? 'Recommended: 10-100. Too high may cause failures, too low is slow.' : 'Recommended range: 10-100. Setting it too large may result in a large number of "validation failures", while setting it too small may result in slower import speeds.'}
          </p>
        </CardContent>
      </Card>

      {/* System tray settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Monitor className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'System Tray' : 'system tray'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {trayLoading ? (
            <div className="text-sm text-muted-foreground">{isEn ? 'Loading...' : 'loading...'}</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{isEn ? 'Enable System Tray' : 'Enable system tray'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Show icon in system tray' : 'Show icon in system tray'}</p>
                </div>
                <Button
                  variant={traySettings.enabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleTraySettingChange('enabled', !traySettings.enabled)}
                >
                  {traySettings.enabled ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
                </Button>
              </div>

              {traySettings.enabled && (
                <>
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <p className="font-medium">{isEn ? 'Close Button Action' : 'Close button behavior'}</p>
                      <p className="text-sm text-muted-foreground">{isEn ? 'What happens when you click X' : 'Behavior when clicking close button'}</p>
                    </div>
                    <select
                      className="w-[140px] h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      value={traySettings.closeAction}
                      onChange={(e) => handleTraySettingChange('closeAction', e.target.value)}
                    >
                      <option value="ask">{isEn ? 'Ask every time' : 'Ask every time'}</option>
                      <option value="minimize">{isEn ? 'Minimize to tray' : 'Minimize to tray'}</option>
                      <option value="quit">{isEn ? 'Quit application' : 'Exit program'}</option>
                    </select>
                  </div>
                </>
              )}

              <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 space-y-1">
                <p>• {isEn ? 'Double-click tray icon to show window' : 'Double-click the tray icon to display the main window'}</p>
                <p>• {isEn ? 'Right-click tray icon to show menu' : 'Right-click on the tray icon to display the menu'}</p>
                <p>• {isEn ? 'Tray menu shows current account info and usage' : 'You can view current account information and usage in the tray menu'}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Shortcut key settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Settings className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Keyboard Shortcuts' : 'shortcut key'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {shortcutLoading ? (
            <div className="text-sm text-muted-foreground">{isEn ? 'Loading...' : 'loading...'}</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{isEn ? 'Show Window' : 'Show main window'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Global shortcut to show main window' : 'Global shortcut keys bring up the main window'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className={`w-[160px] h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-center ${isRecordingShortcut ? 'border-primary ring-1 ring-primary animate-pulse' : ''}`}
                    value={isRecordingShortcut ? (isEn ? 'Press keys...' : 'Please press the button...') : showWindowShortcut}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setIsRecordingShortcut(true)}
                    onBlur={() => setIsRecordingShortcut(false)}
                    readOnly
                    placeholder={isEn ? 'Click to record' : 'Click to record'}
                  />
                  {showWindowShortcut && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 px-2"
                      onClick={() => handleShortcutChange('')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              {shortcutError && (
                <p className="text-sm text-destructive">{shortcutError}</p>
              )}
              <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 space-y-1">
                <p>• {isEn ? 'Click input and press key combination to record' : 'Click the input box and press the key combination to record automatically'}</p>
                <p>• {isEn ? 'macOS use Command, Windows/Linux use Ctrl' : 'macOS use Command，Windows/Linux use Ctrl'}</p>
                <p>• {isEn ? 'Click trash icon to clear shortcut' : 'Click the trash can icon to clear shortcuts'}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Machine code management tips */}
      <Card className="hover-lift bg-primary/5">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Fingerprint className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">{isEn ? 'Machine ID' : 'Machine code management'}</p>
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Device identifier, auto-switch, account binding' : 'Functions such as modifying device identifiers, automatically changing codes when switching numbers, binding account machine codes, etc.'}
              </p>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3 w-3" />
              <span>{isEn ? 'Set in sidebar "Machine ID"' : 'Please set it in the sidebar "Machine Code"'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Data management */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Database className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Data Management' : 'Data management'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{isEn ? 'Export Data' : 'Export data'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Supports JSON, TXT, CSV, Clipboard' : 'support JSON、TXT、CSV, clipboard and other formats'}</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              {isEn ? 'Export' : 'Export'}
            </Button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">{isEn ? 'Import Data' : 'Import data'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Import accounts from JSON file' : 'from JSON File import account data'}</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleImport} disabled={isImporting}>
              <Upload className="h-4 w-4 mr-2" />
              {isImporting ? (isEn ? 'Importing...' : 'Importing...') : (isEn ? 'Import' : 'import')}
            </Button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium text-destructive">{isEn ? 'Clear All Data' : 'Clear all data'}</p>
              <p className="text-sm text-muted-foreground">{isEn ? 'Delete all accounts, groups and tags' : 'Delete all accounts, groups and labels'}</p>
            </div>
            <Button variant="destructive" size="sm" onClick={handleClearData}>
              <Trash2 className="h-4 w-4 mr-2" />
              {isEn ? 'Clear' : 'Clear'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Configuration synchronization (without sensitive credentials, easy to share across multiple devices) */}
      <ConfigSyncCard isEn={isEn} />

      {/* Export dialog */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={Array.from(accounts.values())}
        selectedCount={0}
      />
    </div>
  )
}

/**
 * Configure sync card: put all"non-sensitive"configuration(agent pool,Webhook, template, speed limit, timing, various localStorage) package export/Import.
 * Not included: account number token / Private Credentials.
 */
function ConfigSyncCard({ isEn }: { isEn: boolean }): React.ReactNode {
  const proxyPool = useAccountsStore((s) => s.proxyPool)
  const proxyPoolConfig = useAccountsStore((s) => s.proxyPoolConfig)

  // Collect all syncable localStorage key
  const COLLECTED_LS_KEYS = [
    'kiro-register-config',
    'kiro-register-history',  // Optional: the user can decide whether to
    'kiro-register-templates',
    'kiro-register-ratelimit-enabled',
    'kiro-register-ratelimit-max',
    'kiro-register-autobackoff',
    'kiro-register-dailyquota-limit',
    'kiro-register-schedule-enabled',
    'kiro-register-schedule-time',
    'kiro-register-mixed-sources',
    'kiro-webhooks',
    'accounts_viewMode',
    'accounts_activeGroupTab',
    'systemLogs_displayLimit',
    'kiro-diagnose-moemail',
    'proxyLogs_timeRange',
    'proxyLogs_displayLimit'
  ]

  const handleExport = (): void => {
    const localData: Record<string, string> = {}
    for (const key of COLLECTED_LS_KEYS) {
      const v = localStorage.getItem(key)
      if (v != null) localData[key] = v
    }
    const payload = {
      version: 1,
      type: 'kiro-account-manager-config',
      exportedAt: Date.now(),
      // Agent pool entries (excluding sensitive accounts)
      proxyPool: Object.fromEntries(proxyPool),
      proxyPoolConfig,
      // Various localStorage
      localStorage: localData
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kiro-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (): Promise<void> => {
    const fileData = await window.api.importFromFile()
    if (!fileData || fileData.format !== 'json') {
      alert(isEn ? 'Please select a JSON file' : 'Please select JSON document')
      return
    }
    try {
      const payload = JSON.parse(fileData.content)
      if (payload.type !== 'kiro-account-manager-config') {
        alert(isEn ? 'Not a valid config file' : 'Not a valid configuration file')
        return
      }
      if (!confirm(isEn ? 'This will overwrite proxy pool / webhooks / templates. Continue?' : 'This will overwrite the proxy pool / Webhook / Template and other configurations, are you sure to continue?')) {
        return
      }

      // recover localStorage
      if (payload.localStorage && typeof payload.localStorage === 'object') {
        for (const [k, v] of Object.entries(payload.localStorage)) {
          if (COLLECTED_LS_KEYS.includes(k) && typeof v === 'string') {
            try { localStorage.setItem(k, v) } catch { /* ignore */ }
          }
        }
      }

      // Recovery agent pool (via store interface)
      if (payload.proxyPool && typeof payload.proxyPool === 'object') {
        const store = useAccountsStore.getState()
        store.clearProxyPool()
        // pass directly set reconstruction Map(Bypass addProxy parsing steps, retaining the original ID）
        useAccountsStore.setState({
          proxyPool: new Map(Object.entries(payload.proxyPool as Record<string, never>)) as Parameters<typeof useAccountsStore.setState>[0] extends infer T ? (T extends { proxyPool: infer P } ? P : never) : never
        } as Parameters<typeof useAccountsStore.setState>[0])
      }
      if (payload.proxyPoolConfig) {
        useAccountsStore.getState().setProxyPoolConfig(payload.proxyPoolConfig)
      }

      alert(isEn
        ? 'Config imported. Please restart the app to fully apply.'
        : 'Configuration has been imported. It is recommended to restart the application to take full effect.'
      )
    } catch (e) {
      alert((isEn ? 'Import failed: ' : 'Import failed: ') + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Repeat className="h-4 w-4 text-primary" />
          </div>
          {isEn ? 'Configuration Sync' : 'Configuration synchronization'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {isEn
            ? 'Export all non-sensitive settings (proxy pool, webhooks, templates, rate limits, UI preferences) to a file, for backup or multi-device sync. Does NOT include account tokens or credentials.'
            : 'Export all"non-sensitive"configuration(agent pool,Webhook, registration template, speed limit,UI preferences, etc.) to files for easy backup or multi-device synchronization. Does not include account number Token with credentials.'
          }
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" />
            {isEn ? 'Export Config' : 'Export configuration'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="h-4 w-4 mr-2" />
            {isEn ? 'Import Config' : 'Import configuration'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
