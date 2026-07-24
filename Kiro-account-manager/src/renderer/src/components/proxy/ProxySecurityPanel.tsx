// Anti-generational v1.8 Safety / Current limiting / Observable settings panel
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge } from '../ui'
import { ChevronDown, ChevronRight, Shield, AlertTriangle, RefreshCw, Download, Copy, CheckCircle2, FileText, Activity } from 'lucide-react'

interface ProxyConfigSecurity {
  host: string
  apiKey?: string
  apiKeys?: Array<{ key: string; enabled: boolean }>
  maxRequestBodyBytes?: number
  allowedIPs?: string[]
  deniedIPs?: string[]
  allowExternalWithoutApiKey?: boolean
  rateLimitPerKeyPerMinute?: number
  sessionAffinityEnabled?: boolean
  keepAliveTimeoutMs?: number
  headersTimeoutMs?: number
  recentRequestsLimit?: number
  enableMetrics?: boolean
  fallbackPort?: number
  enableAuditLog?: boolean
  tls?: { enabled?: boolean; cert?: string; key?: string; certPath?: string; keyPath?: string }
}

interface SelfSignedCertInfo {
  cert?: string
  key?: string
  fingerprint?: string
  notBefore?: number
  notAfter?: number
  subject?: string
  altNames?: string[]
}

interface AuditEntry {
  ts: number
  type: string
  data: Record<string, unknown>
}

interface ProxySecurityPanelProps {
  config: ProxyConfigSecurity & Record<string, unknown>
  // use unknown Alternative to strict typing, avoiding parent components ProxyConfig The type conflicts with the exact field of this component's interface
  // Actual writing only uses spread, type safety is determined by the parent component's ProxyConfig Interface guarantee
  setConfig: React.Dispatch<React.SetStateAction<unknown>>
  isRunning: boolean
  isEn: boolean
}

export function ProxySecurityPanel({ config, setConfig, isRunning, isEn }: ProxySecurityPanelProps): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const [showCert, setShowCert] = useState(false)
  const [certInfo, setCertInfo] = useState<SelfSignedCertInfo | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [needsRestart, setNeedsRestart] = useState(false)
  const [copiedCert, setCopiedCert] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // The local state of the input box (make sure it is not blocked when editing) config Synchronous interruption)
  const [allowedIPsText, setAllowedIPsText] = useState((config.allowedIPs || []).join('\n'))
  const [deniedIPsText, setDeniedIPsText] = useState((config.deniedIPs || []).join('\n'))

  useEffect(() => {
    setAllowedIPsText((config.allowedIPs || []).join('\n'))
    setDeniedIPsText((config.deniedIPs || []).join('\n'))
  }, [config.allowedIPs, config.deniedIPs])

  // load needsRestart state
  useEffect(() => {
    if (!isRunning) { setNeedsRestart(false); return }
    let mounted = true
    void window.api.proxyNeedsRestart().then(r => { if (mounted) setNeedsRestart(r.needsRestart) })
    const timer = setInterval(() => {
      void window.api.proxyNeedsRestart().then(r => { if (mounted) setNeedsRestart(r.needsRestart) })
    }, 5000)
    return () => { mounted = false; clearInterval(timer) }
  }, [isRunning])

  const updateConfig = useCallback(<K extends keyof ProxyConfigSecurity>(key: K, value: ProxyConfigSecurity[K]) => {
    setConfig((prev: unknown) => ({ ...(prev as object), [key]: value }))
    void window.api.proxyUpdateConfig({ [key]: value })
  }, [setConfig])

  // parse IP text (one per line)
  const parseIPList = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean)

  const fetchCertInfo = useCallback(async () => {
    const info = await window.api.proxySelfSignedCertInfo()
    if (info.success) setCertInfo(info)
  }, [])

  useEffect(() => {
    if (showCert && !certInfo) void fetchCertInfo()
  }, [showCert, certInfo, fetchCertInfo])

  const handleRegenerateCert = useCallback(async () => {
    if (!confirm(isEn ? 'Regenerate self-signed certificate? You will need to re-install it on clients.' : 'Regenerate self-signed certificate? All clients need to be reinstalled.')) return
    setRegenerating(true)
    try {
      const info = await window.api.proxySelfSignedCertRegenerate()
      if (info.success) {
        setCertInfo(info)
        alert(isEn ? 'Regenerated. Restart proxy to apply.' : 'Regenerated. It will take effect after restarting the reverse generation.')
      } else {
        alert(isEn ? `Failed: ${info.error}` : `fail: ${info.error}`)
      }
    } finally {
      setRegenerating(false)
    }
  }, [isEn])

  const handleDownloadCert = useCallback(() => {
    if (!certInfo?.cert) return
    const blob = new Blob([certInfo.cert], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'kiro-proxy-cert.crt'
    a.click()
    URL.revokeObjectURL(url)
  }, [certInfo])

  const handleCopyCert = useCallback(async () => {
    if (!certInfo?.cert) return
    await navigator.clipboard.writeText(certInfo.cert)
    setCopiedCert(true)
    setTimeout(() => setCopiedCert(false), 2000)
  }, [certInfo])

  const fetchAudit = useCallback(async () => {
    const r = await window.api.proxyAuditLog()
    setAuditEntries(r.entries)
  }, [])

  useEffect(() => {
    if (showAudit) void fetchAudit()
  }, [showAudit, fetchAudit])

  const handleRestart = useCallback(async () => {
    if (!confirm(isEn ? 'Restart proxy server now? Active streams will be interrupted.' : 'Restart the anti-generation server immediately? The ongoing streaming response will be interrupted.')) return
    const r = await window.api.proxyRestart()
    if (r.success) {
      setNeedsRestart(false)
    } else {
      alert(isEn ? `Restart failed: ${r.error}` : `Restart failed: ${r.error}`)
    }
  }, [isEn])

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-500" />
            <CardTitle className="text-base">{isEn ? 'Security & Observability (v1.8)' : 'Security and observability settings (v1.8)'}</CardTitle>
            {needsRestart && (
              <Badge variant="destructive" className="ml-2">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {isEn ? 'Restart required' : 'Need to restart'}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 text-sm">
          {needsRestart && (
            <div className="flex items-center justify-between p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-xs">{isEn ? 'Configuration change requires a restart to take effect.' : 'The configuration has been changed and will take effect after restarting.'}</span>
              </div>
              <Button size="sm" onClick={handleRestart}>
                <RefreshCw className="h-3 w-3 mr-1" />
                {isEn ? 'Restart Now' : 'Restart now'}
              </Button>
            </div>
          )}

          {/* Request security */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Max body size (MB)' : 'Request body limit (MB)'}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                step={1}
                value={Math.round((config.maxRequestBodyBytes || 10 * 1024 * 1024) / (1024 * 1024))}
                onChange={(e) => {
                  const mb = parseInt(e.target.value) || 10
                  updateConfig('maxRequestBodyBytes', mb * 1024 * 1024)
                }}
                placeholder="10"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Reject larger requests with HTTP 413' : 'Return if exceeded HTTP 413'}</p>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Rate limit (req/min per Key)' : 'Speed ​​limit (per Key per minute)'}</Label>
              <Input
                type="number"
                min={0}
                max={10000}
                step={10}
                value={config.rateLimitPerKeyPerMinute || 0}
                onChange={(e) => updateConfig('rateLimitPerKeyPerMinute', parseInt(e.target.value) || 0)}
                placeholder={isEn ? '0 = unlimited' : '0 = no limit'}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Anonymous → by IP' : 'Press when anonymous IP speed limit'}</p>
            </div>
          </div>

          {/* IP access control */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Allowed IPs (whitelist)' : 'IP whitelist'}</Label>
              <textarea
                value={allowedIPsText}
                onChange={(e) => setAllowedIPsText(e.target.value)}
                onBlur={() => updateConfig('allowedIPs', parseIPList(allowedIPsText))}
                placeholder={isEn ? 'One per line, supports CIDR (e.g. 10.0.0.0/8)' : 'One per line, support CIDR (like 10.0.0.0/8)'}
                className="w-full h-20 px-3 py-2 text-xs rounded-md border border-input bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Empty = no restriction' : 'is empty = no limit'}</p>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Denied IPs (blacklist)' : 'IP blacklist'}</Label>
              <textarea
                value={deniedIPsText}
                onChange={(e) => setDeniedIPsText(e.target.value)}
                onBlur={() => updateConfig('deniedIPs', parseIPList(deniedIPsText))}
                placeholder={isEn ? 'Higher priority than allowed list' : 'Priority higher than whitelist'}
                className="w-full h-20 px-3 py-2 text-xs rounded-md border border-input bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'IPv4 / IPv6 / CIDR' : 'support IPv4 / IPv6 / CIDR'}</p>
            </div>
          </div>

          {/* dangerous binding */}
          {(config.host === '0.0.0.0' || config.host === '::') && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-red-600 dark:text-red-400">{isEn ? `Binding to ${config.host} exposes accounts to the network!` : `Currently bound to ${config.host}(local area network/Public network accessible)`}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isEn ? 'API Key is required to start the server.' : 'At least one must be set API Key to start.'}
                </p>
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <Switch
                    checked={config.allowExternalWithoutApiKey || false}
                    onCheckedChange={(checked) => updateConfig('allowExternalWithoutApiKey', checked)}
                    disabled={isRunning}
                  />
                  <span className="text-xs text-red-600 dark:text-red-400">{isEn ? 'I understand the risk, allow without API Key (DANGEROUS)' : 'I understand the risks and allow no Key Start (dangerous)'}</span>
                </label>
              </div>
            </div>
          )}

          {/* session stickiness + speed limit */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Session affinity' : 'session stickiness'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Route same client to same account (prompt cache + anti-risk)' : 'Always use the same account for the same client (guaranteed cache + Risk prevention and control)'}</p>
              </div>
              <Switch
                checked={config.sessionAffinityEnabled || false}
                onCheckedChange={(checked) => updateConfig('sessionAffinityEnabled', checked)}
              />
            </div>
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Prometheus /metrics' : 'Prometheus /metrics'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Expose monitoring metrics endpoint' : 'Exposure Monitoring Metrics Endpoint'}</p>
              </div>
              <Switch
                checked={config.enableMetrics || false}
                onCheckedChange={(checked) => updateConfig('enableMetrics', checked)}
              />
            </div>
          </div>

          {/* Audit log + Number of log entries */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Audit log' : 'Audit log'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Track config changes & critical events' : 'Record configuration changes and key events'}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={config.enableAuditLog || false}
                  onCheckedChange={(checked) => updateConfig('enableAuditLog', checked)}
                />
                <Button variant="outline" size="sm" onClick={() => setShowAudit(!showAudit)}>
                  <FileText className="h-3 w-3 mr-1" />
                  {isEn ? 'View' : 'Check'}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Recent requests limit' : 'Number of recent request log entries'}</Label>
              <Input
                type="number"
                min={20}
                max={10000}
                step={50}
                value={config.recentRequestsLimit || 100}
                onChange={(e) => updateConfig('recentRequestsLimit', parseInt(e.target.value) || 100)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Default 100, max 10000' : 'default 100, upper limit 10000'}</p>
            </div>
          </div>

          {/* keep-alive time out */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Keep-alive timeout (sec)' : 'keep-alive Idle timeout (seconds)'}</Label>
              <Input
                type="number"
                min={5}
                max={600}
                step={5}
                value={Math.round((config.keepAliveTimeoutMs || 65000) / 1000)}
                onChange={(e) => updateConfig('keepAliveTimeoutMs', (parseInt(e.target.value) || 65) * 1000)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'HTTP fallback port (when TLS enabled)' : 'HTTP Fallback port (enable TLS hour)'}</Label>
              <Input
                type="number"
                min={0}
                max={65535}
                step={1}
                value={config.fallbackPort || 0}
                onChange={(e) => updateConfig('fallbackPort', parseInt(e.target.value) || 0)}
                placeholder={isEn ? '0 = disabled' : '0 = Not enabled'}
                className="h-9"
                disabled={isRunning}
              />
            </div>
          </div>

          {/* TLS self-signed certificate */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">{isEn ? 'Self-signed TLS Certificate' : 'self-signed TLS Certificate'}</Label>
              <Button variant="outline" size="sm" onClick={() => setShowCert(!showCert)}>
                {showCert ? (isEn ? 'Hide' : 'hide') : (isEn ? 'Show details' : 'check the details')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {isEn
                ? 'When TLS is enabled but no cert/key configured, the proxy auto-generates a 2-year self-signed cert (in userData/proxy-tls/). Install on clients or set NODE_TLS_REJECT_UNAUTHORIZED=0.'
                : 'enable TLS But when the certificate is not configured, the reverse generation is automatically generated. 2 Self-signed certificate valid for userData/proxy-tls/). The client needs to install the certificate or settings NODE_TLS_REJECT_UNAUTHORIZED=0。'}
            </p>
            {showCert && certInfo && (
              <div className="space-y-2 mt-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">{isEn ? 'Subject:' : 'main body:'}</span>
                    <p className="font-mono">{certInfo.subject || '-'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{isEn ? 'Expires:' : 'Expired:'}</span>
                    <p className="font-mono">{certInfo.notAfter ? new Date(certInfo.notAfter).toLocaleString() : '-'}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{isEn ? 'SHA-256 Fingerprint:' : 'SHA-256 fingerprint:'}</span>
                    <p className="font-mono text-[10px] break-all">{certInfo.fingerprint || '-'}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{isEn ? 'Subject Alt Names:' : 'alternative name (SAN):'}</span>
                    <p className="font-mono text-[10px]">{certInfo.altNames?.join(', ') || '-'}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleDownloadCert}>
                    <Download className="h-3 w-3 mr-1" />
                    {isEn ? 'Download .crt' : 'download .crt'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCopyCert}>
                    {copiedCert ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <Copy className="h-3 w-3 mr-1" />}
                    {copiedCert ? (isEn ? 'Copied' : 'Copied') : (isEn ? 'Copy PEM' : 'copy PEM')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleRegenerateCert} disabled={regenerating}>
                    <RefreshCw className={`h-3 w-3 mr-1 ${regenerating ? 'animate-spin' : ''}`} />
                    {isEn ? 'Regenerate' : 'Regenerate'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Audit log view */}
          {showAudit && (
            <div className="border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-medium">{isEn ? 'Audit Log (recent 200)' : 'Audit log (most recent 200 strip)'}</Label>
                <Button variant="outline" size="sm" onClick={fetchAudit}>
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {isEn ? 'Refresh' : 'refresh'}
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-2 space-y-1">
                {auditEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">{isEn ? 'No entries' : 'No record yet'}</p>
                ) : (
                  auditEntries.slice().reverse().map((entry, i) => (
                    <div key={i} className="text-[10px] font-mono p-1.5 rounded bg-background/50 border">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">{entry.type}</Badge>
                      </div>
                      <pre className="mt-1 break-all whitespace-pre-wrap">{JSON.stringify(entry.data, null, 0)}</pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* /metrics endpoint tip */}
          {config.enableMetrics && isRunning && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs">
              <Activity className="h-3 w-3 text-blue-500" />
              <span className="text-muted-foreground">{isEn ? 'Metrics available at:' : 'Metric endpoint:'}</span>
              <code className="font-mono">/metrics</code>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
