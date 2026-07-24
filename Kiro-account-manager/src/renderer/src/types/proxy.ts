/**
 * Agent pool data model
 *
 * Purpose: Rotate different exits for each account when registering batch tasks IP, reduce the risks associated with risk control.
 * and `proxy/kproxy` Different - those two are"Anti-generational/client proxy",here it is"Export proxy pool"。
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4'

export type ProxyStatus =
  | 'untested'   // Not tested
  | 'testing'    // Under test
  | 'alive'      // Available
  | 'dead'       // Not available
  | 'slow'       // Available but higher latency

/** Agent pool entry */
export interface ProxyEntry {
  id: string
  url: string            // Complete after normalization URL,like http://user:pass@host:port
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string

  // metadata
  label?: string         // The remark name marked by the user
  source?: string        // Source tag (manual / document / subscription)
  tags?: string[]

  // Vitality verification information
  status: ProxyStatus
  latencyMs?: number     // Latency of the most recent test (milliseconds)
  lastTestedAt?: number  // Timestamp
  lastError?: string     // Reason for test failure

  // statistics
  usedCount: number      // Cumulative number of uses
  failCount: number      // Cumulative number of failures
  lastUsedAt?: number
  lastBoundEmail?: string // The most recently bound email address (for association tracing)

  // Configuration
  enabled: boolean       // Whether to enable (deactivated agents do not participate in polling)

  createdAt: number
}

/** Agent live verification results */
export interface ProxyValidationResult {
  success: boolean
  latencyMs?: number
  externalIp?: string    // Seen through proxy exit IP
  error?: string
}

/** Agent pool scheduling strategy */
export type ProxyPoolStrategy =
  | 'round_robin'  // polling
  | 'random'       // random
  | 'least_used'   // least used first
  | 'fastest'      // Latest lowest first

/** Default IP Detection endpoints */
export interface IpDetectEndpoint {
  id: string
  label: string
  url: string
  /** Response format:json Extract from field IP，text Use regular matching */
  format: 'json' | 'text'
  /** JSON Responding IP The field path where the 'ip' / 'query' / 'origin'）*/
  ipField?: string
}

export const IP_DETECT_ENDPOINTS: IpDetectEndpoint[] = [
  { id: 'ipify',       label: 'ipify',        url: 'https://api.ipify.org?format=json',  format: 'json', ipField: 'ip' },
  { id: 'ip-api',      label: 'IP-API',        url: 'http://ip-api.com/json',             format: 'json', ipField: 'query' },
  { id: 'ipinfo',      label: 'IPinfo',        url: 'https://ipinfo.io/json',             format: 'json', ipField: 'ip' },
  { id: 'ip2location', label: 'IP2Location',   url: 'https://api.ip2location.io',         format: 'json', ipField: 'ip' },
  { id: 'httpbin',     label: 'httpbin',       url: 'https://httpbin.org/ip',             format: 'json', ipField: 'origin' },
  { id: 'ifconfig',    label: 'ifconfig.me',   url: 'https://ifconfig.me/ip',             format: 'text' },
  { id: 'icanhazip',   label: 'icanhazip',     url: 'https://icanhazip.com',              format: 'text' },
  { id: 'ipapi-co',    label: 'ipapi.co',      url: 'https://ipapi.co/json',              format: 'json', ipField: 'ip' },
]

/** Agent pool configuration */
export interface ProxyPoolConfig {
  enabled: boolean              // Whether to enable the proxy pool (automatically accessed during registration)
  strategy: ProxyPoolStrategy
  validateOnStartup: boolean    // Automatic verification at startup
  autoDisableDead: boolean      // Failed agents are automatically deactivated
  failureThreshold: number      // Cumulative failures N Disable after
  testUrl: string               // Viability test URL(default https://api.ipify.org）
  testTimeoutMs: number         // Single live verification timeout
  /** Scheduled automatic verification: in minutes,0 means closed */
  autoValidateIntervalMin: number
  /** Concurrency number of scheduled live verification */
  autoValidateConcurrency: number
  /** Upstream transfer agent (optional): cooperate"Target agent requires non-mainland source IP"Scenario series agent chain; support http/socks5 */
  upstreamProxy?: string
}

export const DEFAULT_PROXY_POOL_CONFIG: ProxyPoolConfig = {
  enabled: false,
  strategy: 'round_robin',
  validateOnStartup: false,
  autoDisableDead: true,
  failureThreshold: 3,
  testUrl: 'https://api.ipify.org?format=json',
  testTimeoutMs: 8000,
  autoValidateIntervalMin: 0,
  autoValidateConcurrency: 5,
  upstreamProxy: ''
}
