import { useState, useEffect, useCallback } from 'react'
import { 
  Play, Square, RefreshCw, Copy, Check, Shield, Activity, 
  AlertCircle, Globe, Loader2, FileText, Download, Key, 
  Fingerprint, Server
} from 'lucide-react'
import { 
  Button, Card, CardContent, CardDescription, CardHeader, 
  CardTitle, Input, Label, Switch, Badge 
} from '../ui'
import { useTranslation } from '../../hooks/useTranslation'
import { cn } from '../../lib/utils'

interface KProxyConfig {
  enabled: boolean
  port: number
  host: string
  mitmDomains: string[]
  deviceId?: string
  autoStart: boolean
  logRequests: boolean
}

interface KProxyStats {
  totalRequests: number
  mitmRequests: number
  bypassRequests: number
  modifiedRequests: number
  startTime: number
  lastRequestTime: number
}

interface CACertInfo {
  certPath: string
  fingerprint: string
  validFrom: string
  validTo: string
}

// K-Proxy Request log: module-level persistence + Single subscription to avoid switching to other pages unmount The post-log is cleared and intermediate request events are lost.
type KProxyRecentRequest = {
  timestamp: number
  host: string
  method: string
  path: string
  isMitm: boolean
  deviceIdReplaced?: boolean
}
let _kproxyRecentRequests: KProxyRecentRequest[] = []
let _refSetKproxyRecentRequests: ((v: KProxyRecentRequest[]) => void) | null = null
let _kproxyRequestListenerRegistered = false
function ensureKproxyRequestListenerRegistered(): void {
  if (_kproxyRequestListenerRegistered) return
  _kproxyRequestListenerRegistered = true
  window.api.onKproxyRequest((info) => {
    _kproxyRecentRequests = [{
      timestamp: info.timestamp,
      host: info.host,
      method: info.method,
      path: info.path,
      isMitm: info.isMitm,
      deviceIdReplaced: info.deviceIdReplaced
    }, ..._kproxyRecentRequests].slice(0, 50)
    _refSetKproxyRecentRequests?.(_kproxyRecentRequests)
  })
}

export function KProxyPanel() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  
  const [isRunning, setIsRunning] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const [config, setConfig] = useState<KProxyConfig>({
    enabled: false,
    port: 8899,
    host: '127.0.0.1',
    mitmDomains: ['amazonaws.com', 'amazon.com'],
    autoStart: false,
    logRequests: true
  })
  const [stats, setStats] = useState<KProxyStats | null>(null)
  const [caInfo, setCaInfo] = useState<CACertInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deviceIdCopied, setDeviceIdCopied] = useState(false)
  const [recentRequests, setRecentRequests] = useState<KProxyRecentRequest[]>(_kproxyRecentRequests)
  const [caInstalled, setCaInstalled] = useState<boolean | null>(null)

  // examine CA Whether the certificate is installed
  const checkCaInstalled = useCallback(async () => {
    try {
      const result = await window.api.kproxyCheckCaCertInstalled()
      setCaInstalled(result.installed)
    } catch {
      setCaInstalled(null)
    }
  }, [])

  // initialization K-Proxy
  const initKProxy = useCallback(async () => {
    if (isInitialized || isInitializing) return
    setIsInitializing(true)
    setError(null)
    
    try {
      const result = await window.api.kproxyInit()
      if (result.success) {
        setIsInitialized(true)
        if (result.caInfo) {
          setCaInfo(result.caInfo)
        }
        // Get status
        const status = await window.api.kproxyGetStatus()
        if (status.config) {
          setConfig(status.config as KProxyConfig)
        }
        if (status.stats) {
          setStats(status.stats as KProxyStats)
        }
        setIsRunning(status.running)
      } else {
        setError(result.error || 'Failed to initialize K-Proxy')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Init failed')
    } finally {
      setIsInitializing(false)
    }
  }, [isInitialized, isInitializing])

  // initialization
  useEffect(() => {
    initKProxy()
    checkCaInstalled()
  }, [initKProxy, checkCaInstalled])

  // Listen for events
  useEffect(() => {
    // onKproxyRequest: Module-level single subscription; only mounted during component mounting setter aisle
    ensureKproxyRequestListenerRegistered()
    _refSetKproxyRecentRequests = setRecentRequests

    const unsubStatus = window.api.onKproxyStatusChange((status) => {
      setIsRunning(status.running)
    })

    const unsubError = window.api.onKproxyError((err) => {
      setError(err)
    })

    return () => {
      unsubStatus()
      unsubError()
      _refSetKproxyRecentRequests = null
    }
  }, [])

  // start up/stop
  const toggleProxy = async () => {
    setError(null)
    try {
      if (isRunning) {
        const result = await window.api.kproxyStop()
        if (!result.success) {
          setError(result.error || 'Failed to stop')
        }
      } else {
        const result = await window.api.kproxyStart(config)
        if (!result.success) {
          setError(result.error || 'Failed to start')
        }
      }
      // refresh status
      const status = await window.api.kproxyGetStatus()
      setIsRunning(status.running)
      if (status.stats) {
        setStats(status.stats as KProxyStats)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    }
  }

  // Update configuration
  const updateConfig = async (updates: Partial<KProxyConfig>) => {
    const newConfig = { ...config, ...updates }
    setConfig(newConfig)
    try {
      await window.api.kproxyUpdateConfig(updates)
    } catch (err) {
      console.error('Failed to update config:', err)
    }
  }

  // Generate device ID
  const generateDeviceId = async () => {
    try {
      const result = await window.api.kproxyGenerateDeviceId()
      if (result.success && result.deviceId) {
        await updateConfig({ deviceId: result.deviceId })
        await window.api.kproxySetDeviceId(result.deviceId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate device ID')
    }
  }

  // Copy proxy address
  const copyProxyAddress = () => {
    const address = `${config.host}:${config.port}`
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Copy device ID
  const copyDeviceId = () => {
    if (config.deviceId) {
      navigator.clipboard.writeText(config.deviceId)
      setDeviceIdCopied(true)
      setTimeout(() => setDeviceIdCopied(false), 2000)
    }
  }

  // Export CA Certificate
  const exportCaCert = async () => {
    try {
      const result = await window.api.kproxyExportCaCert()
      if (!result.success) {
        setError(result.error || 'Export failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    }
  }

  // Format time
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString()
  }

  if (!isInitialized) {
    // The loading status is displayed during initialization or when initialization has not yet started.
    if (isInitializing || !error) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">
            {isEn ? 'Initializing K-Proxy...' : 'Initializing K-Proxy...'}
          </p>
        </div>
      )
    }
    // Only display error status if there is a clear error
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-destructive">{error}</p>
        <Button onClick={initKProxy}>
          <RefreshCw className="h-4 w-4 mr-2" />
          {isEn ? 'Retry' : 'Try again'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Error message */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-2 rounded-md flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">{error}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={() => setError(null)}>
            ✕
          </Button>
        </div>
      )}

      {/* main control card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">K-Proxy MITM</CardTitle>
              <Badge variant={isRunning ? 'default' : 'secondary'} className={cn(
                "ml-2",
                isRunning && "bg-green-500 hover:bg-green-600"
              )}>
                {isRunning ? (
                  <span className="flex items-center gap-1">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                    </span>
                    {isEn ? 'Running' : 'Running'}
                  </span>
                ) : (isEn ? 'Stopped' : 'Stopped')}
              </Badge>
            </div>
            <Button
              onClick={toggleProxy}
              variant={isRunning ? 'destructive' : 'default'}
              size="sm"
            >
              {isRunning ? (
                <>
                  <Square className="h-4 w-4 mr-1" />
                  {isEn ? 'Stop' : 'stop'}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-1" />
                  {isEn ? 'Start' : 'start up'}
                </>
              )}
            </Button>
          </div>
          <CardDescription>
            {isEn 
              ? 'MITM proxy for replacing Machine ID in Kiro requests' 
              : 'MITM proxy, used to replace Kiro Requesting Machine ID'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* proxy address */}
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{isEn ? 'Proxy:' : 'proxy address:'}</span>
            <code className="bg-muted px-2 py-1 rounded text-sm font-mono">
              {config.host}:{config.port}
            </code>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copyProxyAddress}>
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>

          {/* Configuration items */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{isEn ? 'Port' : 'port'}</Label>
              <Input
                type="number"
                value={config.port}
                onChange={(e) => updateConfig({ port: parseInt(e.target.value) || 8899 })}
                disabled={isRunning}
                className="h-8"
              />
            </div>
            <div className="space-y-2">
              <Label>{isEn ? 'Host' : 'listening address'}</Label>
              <Input
                value={config.host}
                onChange={(e) => updateConfig({ host: e.target.value })}
                disabled={isRunning}
                className="h-8"
              />
            </div>
          </div>

          {/* Switch options */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <Label>{isEn ? 'Log Requests' : 'Record request log'}</Label>
            </div>
            <Switch
              checked={config.logRequests}
              onCheckedChange={(checked) => updateConfig({ logRequests: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Play className="h-4 w-4 text-muted-foreground" />
              <Label>{isEn ? 'Auto Start' : 'automatic start'}</Label>
            </div>
            <Switch
              checked={config.autoStart}
              onCheckedChange={(checked) => updateConfig({ autoStart: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* equipment ID card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">{isEn ? 'Device ID' : 'equipment ID'}</CardTitle>
          </div>
          <CardDescription>
            {isEn 
              ? 'Machine ID to replace in requests (64 hex characters)' 
              : 'Replace in request Machine ID（64bit hexadecimal)'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={config.deviceId || ''}
              onChange={(e) => {
                updateConfig({ deviceId: e.target.value })
                if (e.target.value.length === 64) {
                  window.api.kproxySetDeviceId(e.target.value)
                }
              }}
              placeholder={isEn ? 'Enter or generate device ID' : 'input or generation device ID'}
              className="font-mono text-xs h-8"
            />
            <Button variant="outline" size="sm" className="h-8" onClick={generateDeviceId}>
              <Key className="h-3 w-3 mr-1" />
              {isEn ? 'Generate' : 'generate'}
            </Button>
            {config.deviceId && (
              <Button variant="ghost" size="sm" className="h-8 px-2" onClick={copyDeviceId}>
                {deviceIdCopied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </Button>
            )}
          </div>
          {config.deviceId && (
            <p className="text-xs text-muted-foreground">
              {config.deviceId.length === 64 
                ? (isEn ? '✓ Valid device ID format' : '✓ equipment ID Correct format')
                : (isEn ? `⚠ Invalid length: ${config.deviceId.length}/64` : `⚠ Incorrect length: ${config.deviceId.length}/64`)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* CA certificate card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">{isEn ? 'CA Certificate' : 'CA Certificate'}</CardTitle>
            </div>
            <div className="flex gap-2">
              {caInstalled === false ? (
                <Button variant="default" size="sm" onClick={async () => {
                  try {
                    const result = await window.api.kproxyInstallCaCert()
                    if (result.success) {
                      setCaInstalled(true)
                      alert(result.message || (isEn ? 'Certificate installed' : 'Certificate installed'))
                    } else {
                      alert(result.error || (isEn ? 'Failed to install' : 'Installation failed'))
                    }
                  } catch (e) {
                    alert(e instanceof Error ? e.message : String(e))
                  }
                }}>
                  {isEn ? 'Install' : 'Install'}
                </Button>
              ) : caInstalled === true ? (
                <Button variant="destructive" size="sm" onClick={async () => {
                  try {
                    const result = await window.api.kproxyUninstallCaCert()
                    if (result.success) {
                      setCaInstalled(false)
                      alert(result.message || (isEn ? 'Certificate uninstalled' : 'Certificate has been uninstalled'))
                    } else {
                      alert(result.error || (isEn ? 'Failed to uninstall' : 'Uninstall failed'))
                    }
                  } catch (e) {
                    alert(e instanceof Error ? e.message : String(e))
                  }
                }}>
                  {isEn ? 'Uninstall' : 'uninstall'}
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  {isEn ? 'Checking...' : 'Under detection...'}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={exportCaCert}>
                <Download className="h-3 w-3 mr-1" />
                {isEn ? 'Export' : 'Export'}
              </Button>
            </div>
          </div>
          <CardDescription>
            {isEn 
              ? 'Install this certificate to trust K-Proxy MITM' 
              : 'Install this certificate to trust K-Proxy MITM acting'}
          </CardDescription>
        </CardHeader>
        {caInfo && (
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{isEn ? 'Fingerprint:' : 'fingerprint:'}</span>
              <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono truncate max-w-[300px]">
                {caInfo.fingerprint}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{isEn ? 'Valid:' : 'Validity period:'}</span>
              <span className="text-xs">
                {new Date(caInfo.validFrom).toLocaleDateString()} - {new Date(caInfo.validTo).toLocaleDateString()}
              </span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Statistics cards */}
      {stats && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">{isEn ? 'Statistics' : 'statistics'}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold">{stats.totalRequests}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'Total' : 'total requests'}</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-blue-500">{stats.mitmRequests}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'MITM' : 'MITM'}</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-500">{stats.modifiedRequests}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'Modified' : 'Modified'}</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-500">{stats.bypassRequests}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'Bypass' : 'pass-through'}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* recent requests */}
      {recentRequests.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">{isEn ? 'Recent Requests' : 'recent requests'}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {recentRequests.slice(0, 10).map((req, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs py-1 border-b last:border-0">
                  <span className="text-muted-foreground w-16">{formatTime(req.timestamp)}</span>
                  <Badge variant={req.isMitm ? 'default' : 'secondary'} className="text-[10px] px-1 py-0">
                    {req.isMitm ? 'MITM' : 'PASS'}
                  </Badge>
                  {req.deviceIdReplaced && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 text-green-600 border-green-600">
                      ID
                    </Badge>
                  )}
                  <span className="font-mono truncate flex-1">{req.host}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Instructions for use */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{isEn ? 'Usage Guide' : 'Instructions for use'}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>1. {isEn ? 'Export and install the CA certificate to your system trust store' : 'Export and install CA Certificate to system trust store'}</p>
          <p>2. {isEn ? 'Set your system/application proxy to' : 'Set up the system/The application agent is'} <code className="bg-muted px-1 rounded">{config.host}:{config.port}</code></p>
          <p>3. {isEn ? 'Generate or enter a device ID to use for requests' : 'Generate or enter the device used for the request ID'}</p>
          <p>4. {isEn ? 'Start the proxy and use Kiro IDE normally' : 'Use normally after starting the agent Kiro IDE'}</p>
        </CardContent>
      </Card>
    </div>
  )
}
