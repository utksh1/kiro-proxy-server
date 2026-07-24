import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { UserPlus, Mail, Key, Loader2, CheckCircle2, XCircle, Trash2, Play, Square, Clock, RotateCcw, RefreshCw, Download, Upload, Settings2, Link2, AtSign, Shuffle, Info, Pause, AlertTriangle, ShieldAlert, Gauge, Activity, CalendarClock, Timer } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAccountsStore } from '@/store/accounts'
import { useTaskStore } from '@/store/tasks'
import { createRateLimiter, type RateLimiter, type RateLimiterSnapshot } from '@/store/rateLimiter'
import { useWebhookStore } from '@/store/webhooks'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Progress, Badge, Switch } from '../ui'
import { cn } from '@/lib/utils'
import { appendSubscriptionLink, updateSubscriptionLink } from './SubscriptionPage'
import { generateNextDotVariant, countSameRootVariants, totalVariantCount, splitEmail } from '@/lib/dotVariants'

// Failure error code classification: filtering for failure retry queue
type ErrCategory =
  | 'risk_control' | 'proxy_chain' | 'strict_proxy' | 'proxy_whitelist'
  | 'eof' | 'otp_timeout' | 'network' | 'email_used'
  | 'rate_limit' | 'auth' | 'suspended' | 'unknown'

interface ErrorDiagnosis {
  category: ErrCategory
  title: string
  reasons: string[]
  suggestions: string[]
}

/**
 * Translate the reason for failure into"mandarin"diagnosis + It is recommended to cover the most common types of failures in batch registration.
 * Priority: risk control > Proxy whitelist > proxy chain > strictly proxy > EOF > OTPtime out > network > Email is used > Current limiting > Authentication > suspended > unknown
 */
function diagnoseRegError(err: string | undefined): ErrorDiagnosis {
  const e = (err || '').toLowerCase()
  if (!e) {
    return { category: 'unknown', title: 'unknown error', reasons: ['No specific error information was captured'], suggestions: ['View full log'] }
  }
  // AWS Risk control
  if (e.includes('aws-risk-control') || e.includes('Risk control') || e.includes('Please try again later') || e.includes('try again later')) {
    return {
      category: 'risk_control',
      title: 'AWS Risk control trigger',
      reasons: ['The registration request was AWS Security policy interception', 'Common triggers: same IP Register multiple accounts in a short time, mechanize the rhythm of behavior, and associate email domain names'],
      suggestions: ['Enable proxy pool + Unique for each number session(One for each number IP）', 'Reduce speed (speed limit 10/minutes or less)', 'Email rotation using multiple domain names', 'If used bestproxy Class residential agent, ensure source IP non-continent']
    }
  }
  // bestproxy 610 / IP whitelist class
  if (e.includes('610') || e.includes('whitelist') || (e.includes('connect') && e.includes('http 4'))) {
    return {
      category: 'proxy_whitelist',
      title: 'Agency certification / Whitelist failed',
      reasons: ['The target agent refuses authentication (the account password is wrong or the source IP Not in the whitelist)', 'bestproxy of 610 = source IP Unauthorized'],
      suggestions: ['Put the current export in the proxy background IP Add to whitelist', 'Or switch to the direct account connection mode + Make sure the source is from a permitted region', 'Cooperate"upstream transfer agent"Transfer via non-mainland China']
    }
  }
  // Agent chain failed
  if (e.includes('proxychain') || e.includes('proxy chain') || e.includes('upstream transfer')) {
    return {
      category: 'proxy_chain',
      title: 'Agency chain establishment failed',
      reasons: ['"upstream transfer → target agent"Link handshake failed'],
      suggestions: ['Go to the "Agent Pool" page and click "Diagnosis" to locate which layer is down.', 'Confirm the upstream transit port (e.g. socks5://127.0.0.1:7890) is already running', 'If the target proxy requires a whitelist, ensure the transit exit IP Whitened']
    }
  }
  // Strict proxy (reject streaking if no proxy is available)
  if (e.includes('strictly proxy') || e.includes('strict') && e.includes('proxy')) {
    return {
      category: 'strict_proxy',
      title: 'Strict proxy mode interception',
      reasons: ['Proxy pool enabled"Never run naked and connect directly", but no proxy is currently available'],
      suggestions: ['Go to the agent pool to verify your liveness and confirm that at least 1 strip alive', 'Check if the proxy is automatically deactivated', 'All proxies can be manually enabled temporarily / turn off"Automatically deactivate on failure"']
    }
  }
  // EOF / status=0 Network jitter
  if (e.includes('eof') || (e.includes('status=0') && e.includes('failed to do request')) || e.includes('connection reset')) {
    return {
      category: 'eof',
      title: 'The network is momentarily disconnected (EOF）',
      reasons: ['TLS The connection was blocked by the peer during handshake or transmission RST/closure', 'Commonly seen in proxy instability / High concurrency squeeze / Intermediate network jitter'],
      suggestions: ['Reduce concurrency', 'Change agent / Plus upstream transfer', 'Retries are built-in and can be ignored if they happen occasionally; if there are a lot of them continuously, the outlet will be replaced.']
    }
  }
  // OTP time out
  if ((e.includes('timeout') || e.includes('time out')) && (e.includes('otp') || e.includes('Verification code') || e.includes('code'))) {
    return {
      category: 'otp_timeout',
      title: 'Timeout waiting for verification code',
      reasons: ['The temporary email was not received within the deadline. AWS Verification email', 'possible AWS Not sent (risk control interception)/ Mail falls into trash / Temporary mailbox service delay'],
      suggestions: ['Confirm that temporary mailbox service is available', 'This email domain name may be AWS Marked black, change domain name and try again', 'If it happens repeatedly, it’s probably AWS Silent risk control needs to be replaced IP/Change of pace']
    }
  }
  // general network
  if (e.includes('timeout') || e.includes('time out') || e.includes('etimedout') || e.includes('fetch failed') || e.includes('econnreset') || e.includes('econnrefused') || e.includes('enotfound') || e.includes('network')) {
    return {
      category: 'network',
      title: 'network error',
      reasons: ['connect / DNS / Timeout class failure'],
      suggestions: ['Check local network and proxy reachability', 'Reduce concurrency and try again']
    }
  }
  // Email has been registered
  if (e.includes('Registered') || (e.includes('email') && (e.includes('already') || e.includes('exists') || e.includes('used') || e.includes('Already exists') || e.includes('has been')))) {
    return {
      category: 'email_used',
      title: 'Email has been registered',
      reasons: ['this email address AWS side already exists'],
      suggestions: ['The prefix generator has recently been enhanced with randomness (middle name/(double surname), there will be almost no collision if you run again', 'Use multiple domain names to further reduce conflicts']
    }
  }
  // Current limiting
  if (e.includes('rate') || e.includes('limit') || e.includes('too many') || e.includes('Current limiting') || e.includes('429')) {
    return {
      category: 'rate_limit',
      title: 'Trigger current limit',
      reasons: ['The number of short-term requests exceeds AWS Acceptance range'],
      suggestions: ['reduce maxPerMinute with concurrency', 'Enable risk control auto-pause']
    }
  }
  // suspended
  if (e.includes('suspended')) {
    return {
      category: 'suspended',
      title: 'Account has been deactivated',
      reasons: ['The registration process is completed but AWS In the last step, mark the account as suspended', 'Usually it is a risk control level determination (domain name/IP/Fingerprint synthesis)'],
      suggestions: ['Change outlet IP / Change email domain name / Reduce rate', 'can be regarded as"Soft risk control"signal, you should slow down immediately']
    }
  }
  // Authentication
  if (e.includes('unauthorized') || e.includes('401') || e.includes('403')) {
    return {
      category: 'auth',
      title: 'Authentication failed',
      reasons: ['Upstream interface returns 401/403'],
      suggestions: ['Check credentials / Look at the response body on the interface side']
    }
  }
  return { category: 'unknown', title: 'Other errors', reasons: [err || ''], suggestions: ['View complete log location'] }
}

/** old API Compatible: existing retryFailed Wait for use classifyError do screening */
function classifyError(err: string | undefined): 'network' | 'otp_timeout' | 'email_used' | 'rate_limit' | 'auth' | 'risk_control' | 'unknown' {
  const cat = diagnoseRegError(err).category
  if (cat === 'risk_control') return 'risk_control'
  if (cat === 'otp_timeout') return 'otp_timeout'
  if (cat === 'email_used') return 'email_used'
  if (cat === 'rate_limit') return 'rate_limit'
  if (cat === 'auth') return 'auth'
  if (cat === 'eof' || cat === 'network' || cat === 'proxy_chain' || cat === 'proxy_whitelist' || cat === 'strict_proxy') return 'network'
  return 'unknown'
}

// random session Value (alphanumeric) used for agent "session stickiness" - same value keeps the same exit IP
function randomSession(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/**
 * as agent URL Inject "unique per account" session”, allowing the entire registration process for the same account to go through the same exit. IP, Different accounts use different IP。
 * 1) url Contains {session} placeholder → Replace with a random value (universal, adaptable to any service provider);
 * 2) Parameterized username (bestproxy Wait, including _area-/_life-/_city-/_state- etc.) and not written _session- → Automatically add one;
 * Other situations (ordinary agent, written session) is returned as is, without interference.
 */
function injectProxySession(url: string): string {
  if (!url) return url
  const session = randomSession()
  if (url.includes('{session}')) {
    return url.replace(/\{session\}/g, session)
  }
  const m = url.match(/^(\w+:\/\/)([^@/]+)@(.+)$/)
  if (m) {
    const [, scheme, userinfo, hostpart] = m
    const ci = userinfo.indexOf(':')
    const username = ci >= 0 ? userinfo.slice(0, ci) : userinfo
    const password = ci >= 0 ? userinfo.slice(ci + 1) : ''
    const isParamStyle = /_(area|life|city|state|session|region|country)-/i.test(username)
    if (isParamStyle && !/_session-/i.test(username)) {
      const newUser = `${username}_session-${session}`
      return `${scheme}${newUser}${ci >= 0 ? ':' + password : ''}@${hostpart}`
    }
  }
  return url
}

type RegMode = 'manual' | 'outlook' | 'tempmail' | 'proton' | 'gptmail' | 'mixed'
type AutoEmailSource = 'outlook' | 'tempmail' | 'proton' | 'gptmail'
/**
 * Phase State machine:
 * - idle: not started
 * - initializing：OIDC Device authorization initialization
 * - email: Wait for the user to enter their email address
 * - otp: Wait for the user to enter the verification code
 * - running: The registration process is in progress (Verify/Password/Token Inferred from log keywords)
 * - done: The core registration process is completed (including Token), which is the final state when no post-processing is enabled.
 * - importing: Automatically importing accounts
 * - fetching-link: Obtaining Pro Subscription link
 * - finalized: Final finish including all post-processing
 */
type Phase = 'idle' | 'initializing' | 'email' | 'otp' | 'running' | 'done' | 'importing' | 'fetching-link' | 'finalized'

interface FingerprintSnapshot {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  canvasHash: number
  screen: { width: number; height: number }
  proxyUrl?: string
  exitIP?: string
}

interface RegResult {
  status: 'success' | 'failed'
  email: string
  password?: string
  error?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  region?: string
  provider?: string
  verify?: Record<string, unknown>
  fingerprint?: FingerprintSnapshot
}

type BatchItemStatus = 'pending' | 'running' | 'retrying' | 'success' | 'failed' | 'imported' | 'import_failed'

interface HistoryItem {
  id: string
  time: number
  email: string
  status: 'success' | 'failed'
  error?: string
  password?: string
  result?: RegResult
  imported: boolean
  subscriptionUrl?: string
}

type RegStepName =
  | 'init' | 'proxy-chain-ready' | 'tls-ready' | 'exit-ip'
  | 'oidc' | 'device' | 'email-created'
  | 'portal' | 'workflow-init' | 'submit-email'
  | 'signup' | 'send-otp' | 'waiting-otp' | 'otp-received'
  | 'create-identity' | 'set-password' | 'sso-workflow' | 'sso-token'
  | 'verify-alive' | 'done'

/** step → Short Chinese tags for UI For display */
const STEP_LABEL_CN: Record<RegStepName, string> = {
  'init': 'initialization',
  'proxy-chain-ready': 'Agent chain ready',
  'tls-ready': 'TLS ready',
  'exit-ip': 'Explore the exit IP',
  'oidc': 'OIDC',
  'device': 'Device authorization',
  'email-created': 'Email has been created',
  'portal': 'Portal',
  'workflow-init': 'Workflow',
  'submit-email': 'Submit email',
  'signup': 'Signup',
  'send-otp': 'Send verification code',
  'waiting-otp': 'Waiting for verification code',
  'otp-received': 'Verification code arrives',
  'create-identity': 'Create an identity',
  'set-password': 'Set password',
  'sso-workflow': 'SSO Workflow',
  'sso-token': 'Pick Token',
  'verify-alive': 'Live test',
  'done': 'Finish'
}

interface BatchItem {
  id: string
  index: number
  status: BatchItemStatus
  email: string
  error?: string
  retryCount: number
  /** Real-time progress: current step, starting time, current step Start time, export IP */
  currentStep?: RegStepName
  startedAt?: number
  stepStartedAt?: number
  exitIp?: string
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

/** Display of single-line batch tasks: status icon + Mail + current step + Total time spent + exit IP / mistake + Failure diagnosis expands.
 * Splitting into sub-components can reduce the workload when re-rendering the parent component and coordinate batchClock Let the total elapsed time scroll over seconds.
 */
function BatchItemRow({
  item,
  t,
  batchClock
}: {
  item: BatchItem
  t: (k: string) => string
  batchClock: number
}): React.ReactNode {
  const isActive = item.status === 'running' || item.status === 'retrying'
  const now = isActive ? batchClock : (item.stepStartedAt || item.startedAt || 0)
  const totalMs = item.startedAt ? Math.max(0, now - item.startedAt) : undefined
  const stepLabel = item.currentStep ? STEP_LABEL_CN[item.currentStep] : ''
  const [diagOpen, setDiagOpen] = useState(false)
  const isFailed = item.status === 'failed' || item.status === 'import_failed'
  const diag = isFailed && item.error ? diagnoseRegError(item.error) : null

  return (
    <div className="border-b last:border-b-0 text-xs hover:bg-muted/50 transition-colors">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-muted-foreground w-6 text-right shrink-0">#{item.index}</span>
          {item.status === 'pending' && <span className="text-muted-foreground shrink-0">—</span>}
          {item.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
          {item.status === 'retrying' && <RefreshCw className="h-3 w-3 animate-spin text-yellow-500 shrink-0" />}
          {item.status === 'success' && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
          {item.status === 'imported' && <Download className="h-3 w-3 text-green-600 shrink-0" />}
          {item.status === 'failed' && <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
          {item.status === 'import_failed' && <XCircle className="h-3 w-3 text-orange-500 shrink-0" />}
          <span className="font-mono truncate">{item.email || <span className="text-muted-foreground italic">To be generated</span>}</span>
          {isActive && stepLabel && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal shrink-0">{stepLabel}</Badge>
          )}
          {item.exitIp && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0 hidden sm:inline">IP {item.exitIp}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalMs !== undefined && (
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">{fmtMs(totalMs)}</span>
          )}
          <span className={cn('text-xs whitespace-nowrap',
            (item.status === 'success' || item.status === 'imported') && 'text-green-600',
            (item.status === 'failed' || item.status === 'import_failed') && 'text-red-500',
            item.status === 'retrying' && 'text-yellow-600',
            (item.status === 'pending' || item.status === 'running') && 'text-muted-foreground'
          )}>
            {item.status === 'pending' ? '' :
             item.status === 'running' ? '' :
             item.status === 'retrying' ? `${t('register.batchItemRetrying')} (${item.retryCount})` :
             item.status === 'success' ? t('register.batchItemSuccess') :
             item.status === 'imported' ? t('register.batchItemImported') :
             item.status === 'import_failed' ? t('register.batchItemImportFailed') :
             diag ? diag.title : (item.error || t('register.batchItemFailed'))}
          </span>
          {diag && (
            <button
              onClick={() => setDiagOpen((v) => !v)}
              className="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              title="View reasons and suggestions"
            >
              {diagOpen ? 'close' : 'diagnosis'}
            </button>
          )}
        </div>
      </div>
      {diag && diagOpen && (
        <div className="px-3 pb-2 pl-12 pr-3 space-y-1.5">
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1.5">
            <div className="font-medium text-red-700 dark:text-red-400 text-[11px]">{diag.title}</div>
            {diag.reasons.length > 0 && (
              <div className="text-[11px] text-foreground/80">
                <div className="text-muted-foreground">Possible reasons:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {diag.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {diag.suggestions.length > 0 && (
              <div className="text-[11px] text-foreground/80">
                <div className="text-muted-foreground">suggestion:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {diag.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {item.error && (
              <div className="text-[10px] text-muted-foreground font-mono break-all pt-1 border-t border-red-500/20">
                original:{item.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The core of registration progress 6 step:OIDC → Email → Verify → Password → Token → Done
 * Optional post-processing additions:Import(When automatic import is turned on),ProLink(obtained automatically Pro (when the link is open)
 */
const CORE_STEPS = ['OIDC', 'Email', 'Verify', 'Password', 'Token', 'Done'] as const

/**
 * Dynamically build a list of steps based on user switches
 * @param hasImport Whether automatic import is enabled
 * @param hasProLink Whether automatic acquisition is enabled Pro Link
 */
function buildManualSteps(hasImport: boolean, hasProLink: boolean): readonly string[] {
  const extras: string[] = []
  if (hasImport) extras.push('Import')
  if (hasProLink) extras.push('ProLink')
  if (extras.length === 0) return CORE_STEPS
  // exist Done Insert extra steps before;'Done' always at the end
  return [...CORE_STEPS.slice(0, -1), ...extras, 'Done']
}

/**
 * Will phase + Recent log extrapolated to current step index (based on dynamic step array)
 * @param phase Registration phase issued by the backend (including post-processing phase)
 * @param lastLog The most recent log (used in running The stages are subdivided into Verify/Password/Token）
 * @param steps pass buildManualSteps Constructed dynamic step array
 */
function phaseToStep(phase: Phase, lastLog: string | undefined, steps: readonly string[]): number {
  // Step index assistance: find the position of the specific step name in the dynamic array
  const idxOf = (name: string): number => steps.indexOf(name)
  const lastIdx = steps.length - 1

  switch (phase) {
    case 'idle': return -1
    case 'initializing': return idxOf('OIDC')
    case 'email': return idxOf('Email')
    case 'otp': return idxOf('Verify')
    case 'done': return idxOf('Done')  // The core process is completed (final state when post-processing is not enabled)
    case 'importing': {
      const i = idxOf('Import')
      return i >= 0 ? i : idxOf('Done')
    }
    case 'fetching-link': {
      const i = idxOf('ProLink')
      return i >= 0 ? i : idxOf('Done')
    }
    case 'finalized': return lastIdx
    case 'running': {
      if (!lastLog) return Math.max(0, idxOf('Email'))
      const log = lastLog.toLowerCase()
      // automatic mode OTP Also go when submitting running, here the message is processed after recognition
      if (log.includes('Getting pro') || log.includes('pro link') || log.includes('fetching pro')) {
        const i = idxOf('ProLink')
        if (i >= 0) return i
      }
      if (log.includes('Importing') || log.includes('importing') || log.includes('Imported')) {
        const i = idxOf('Import')
        if (i >= 0) return i
      }
      // [13] SSO Token / [12.5] complete-signup / Live test successful
      if (log.includes('sso') || log.includes('token') || log.includes('Live test') || log.includes('complete') || log.includes('end-of-workflow')) return idxOf('Token')
      // [12] Set password / SetPassword / Encryption public key
      if (log.includes('password') || log.includes('password') || log.includes('Encryption public key')) return idxOf('Password')
      // [9] OTP / [10] verify-email / signup verify
      if (log.includes('Verification code') || log.includes('otp') || log.includes('verify')) return idxOf('Verify')
      // [7-8] Signup / SignupInit / Profile
      if (log.includes('signup') || log.includes('profile') || log.includes('Registration initialization')) return idxOf('Verify')
      // [6] Submit email / SubmitEmail
      if (log.includes('Submit email') || log.includes('submit') || log.includes('Mail')) return idxOf('Email')
      return Math.max(0, idxOf('Email'))
    }
  }
}

const STORAGE_KEY = 'kiro-register-config'
const HISTORY_KEY = 'kiro-register-history'
/** Known occupied mailbox blacklist: registration failed for email_used Join now and skip automatically next time */
const EMAIL_BLACKLIST_KEY = 'kiro-register-email-blacklist'
/** Registration Policy Template: Complete RegisterConfig Name snapshots for easy one-click switching of scenes */
const TEMPLATES_KEY = 'kiro-register-templates'

interface RegisterTemplate {
  id: string
  name: string
  config: RegisterConfig
  createdAt: number
}

function loadTemplates(): RegisterTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    return raw ? JSON.parse(raw) as RegisterTemplate[] : []
  } catch { return [] }
}

function saveTemplates(items: RegisterTemplate[]): void {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(items)) } catch { /* ignore */ }
}

function loadEmailBlacklist(): Set<string> {
  try {
    const raw = localStorage.getItem(EMAIL_BLACKLIST_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(arr.map((e) => e.toLowerCase()))
  } catch {
    return new Set()
  }
}

function saveEmailBlacklist(set: Set<string>): void {
  try {
    // most restrictive 5000 to avoid unlimited growth
    const arr = Array.from(set).slice(-5000)
    localStorage.setItem(EMAIL_BLACKLIST_KEY, JSON.stringify(arr))
  } catch { /* ignore */ }
}

function clearEmailBlacklist(): void {
  try { localStorage.removeItem(EMAIL_BLACKLIST_KEY) } catch { /* ignore */ }
}

// Module-level state: retained after component uninstallation (within the same session)
let _logs: string[] = []
let _phase: Phase = 'idle'
let _result: RegResult | null = null
let _batchRunning = false
let _batchDone = 0
let _batchSuccess = 0
let _batchFail = 0
let _batchItems: BatchItem[] = []
// Proton The login state is cached to the module level: switching pages does not lose the display (the real login state is persisted in persist:proton session）
let _protonLoggedIn = false
/**
 * Module level mapping:taskId(rear end) → batchItem.id(front end), used to put step Events are routed to the corresponding row.
 * Must be placed at module level — Used before useRef Will switch pages unmount is lost, resulting in remounting
 * of tasks still running step/IP/Time consuming and no longer updated (the page will look like"Information not saved"）。
 */
const _taskIdToItemId = new Map<string, string>()

/**
 * module level step Event subscription: Register once and never cancel.
 * The old implementation put the subscription in useEffect, switch to other pages unmount when being cleanup Cancel,
 * everything that happened during step All events are lost, and after switching back UI Information is missing.
 */
let _stepListenerRegistered = false
function ensureStepListenerRegistered(): void {
  if (_stepListenerRegistered) return
  _stepListenerRegistered = true
  window.api.onRegistrationStep(({ taskId, event }) => {
    if (!taskId) return
    const itemId = _taskIdToItemId.get(taskId)
    if (!itemId) return
    const now = event.ts || Date.now()
    // Write module level data + Notification is being mounted React Component refresh (using _refSetBatchItems）
    _batchItems = _batchItems.map((it) => {
      if (it.id !== itemId) return it
      return {
        ...it,
        currentStep: event.name as RegStepName,
        startedAt: it.startedAt ?? now,
        stepStartedAt: now,
        email: event.email || it.email,
        exitIp: event.exitIp || it.exitIp
      }
    })
    _refSetBatchItems?.([..._batchItems])
  })
}

/**
 * module level log The same applies to subscriptions: logs that occur during page switching will not be lost.
 * behavioral alignment addLog:Add timestamp prefix.
 */
let _logListenerRegistered = false
function ensureLogListenerRegistered(): void {
  if (_logListenerRegistered) return
  _logListenerRegistered = true
  window.api.onRegistrationLog((msg) => {
    const next = [..._logs, `[${new Date().toLocaleTimeString()}] ${msg}`]
    if (next.length > 500) next.splice(0, next.length - 500)
    _logs = next
    _refSetLogs?.(next)
  })
}

// module level React setter refs: Asynchronous code calls the latest across component life cycles setter
let _refSetPhase: ((v: Phase) => void) | null = null
let _refSetResult: ((v: RegResult | null) => void) | null = null
let _refSetLogs: ((v: string[]) => void) | null = null
let _refSetBatchRunning: ((v: boolean) => void) | null = null
let _refSetBatchDone: ((v: number) => void) | null = null
let _refSetBatchSuccess: ((v: number) => void) | null = null
let _refSetBatchFail: ((v: number) => void) | null = null
let _refSetBatchItems: ((v: BatchItem[]) => void) | null = null
let _refSetHistory: ((v: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => void) | null = null

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100))) } catch { /* ignore */ }
}

/** Subscription plan type (corresponds to Kiro rear end qSubscriptionType）*/
export type ProPlanType = 'Q_DEVELOPER_STANDALONE_PRO' | 'Q_DEVELOPER_STANDALONE_PRO_PLUS' | 'Q_DEVELOPER_STANDALONE_POWER'

interface RegisterConfig {
  mode: RegMode
  outlookData: string
  fullName: string
  batchCount: number
  batchInterval: number
  batchAutoImport: boolean
  batchRetries: number
  batchConcurrency: number
  autoFetchProLink: boolean
  proPlanType: ProPlanType
  tempMailEmail: string
  tempMailEpin: string
  tempMailDomain: string
  /** Proton Mother mailbox (dot alias mother number, such as evanbartellchae@protonmail.com）*/
  protonBaseEmail: string
  /** GPTmail (mail.chatgpt.org.uk) — Supports two modes: private domain name direct acquisition (inbox leave blank) or CF Forward (fill in inbox）；
   *   Fill it in when a password is set for the private domain name privatePassword */
  gptMailBaseURL: string
  gptMailInboxEmail: string
  gptMailDomain: string
  gptMailPrefix: string
  gptMailPrivatePassword: string
  /** manual mode — Parent email address (the real email address where the verification code is received)*/
  manualParentEmail: string
  /** manual mode — Enable anonymous mailbox (dot dot variant)*/
  manualAnonymousEmail: boolean
  /** blend mode — Enabled mailbox sources */
  mixedEnabledSources?: AutoEmailSource[]
}

function loadConfig(): Partial<RegisterConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveConfig(cfg: RegisterConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)) } catch { /* ignore */ }
}

export function RegisterPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const saved = useRef(loadConfig()).current

  const [mode, setMode] = useState<RegMode>(saved.mode || 'manual')
  const [phase, _setPhase] = useState<Phase>(_phase)
  const [logs, setLogs] = useState<string[]>(_logs)
  const [result, _setResult] = useState<RegResult | null>(_result)
  const [imported, setImported] = useState(false)

  const setPhase = useCallback((p: Phase) => { _phase = p; _refSetPhase?.(p) }, [])
  const setResult = useCallback((r: RegResult | null) => { _result = r; _refSetResult?.(r) }, [])

  // manual mode
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState(saved.fullName || '')
  const [otp, setOtp] = useState('')
  const [parentEmail, setParentEmail] = useState(saved.manualParentEmail || '')
  const [anonymousEmail, setAnonymousEmail] = useState(saved.manualAnonymousEmail ?? false)

  // Outlook Configuration
  const [outlookData, setOutlookData] = useState(saved.outlookData || '')

  // TempMail.Plus Configuration
  const [tempMailEmail, setTempMailEmail] = useState(saved.tempMailEmail || '')
  const [tempMailEpin, setTempMailEpin] = useState(saved.tempMailEpin || '')
  const [tempMailDomain, setTempMailDomain] = useState(saved.tempMailDomain || '')

  // Proton configure(dotalias,webview To obtain the code from the official backdoor website, you need to log in first)
  const [protonBaseEmail, setProtonBaseEmail] = useState(saved.protonBaseEmail || '')
  // The initial value is module-level cache: switch to other pages and come back and still maintain the login status display.
  const [protonLoggedIn, _setProtonLoggedIn] = useState(_protonLoggedIn)
  const setProtonLoggedIn = useCallback((v: boolean): void => { _protonLoggedIn = v; _setProtonLoggedIn(v) }, [])
  const [protonChecking, setProtonChecking] = useState(false)

  // GPTmail (mail.chatgpt.org.uk) Configuration —— Supports two modes at the same time:
  //   A. Private domain name direct payment:MX parse to GPTmail；inboxEmail Leave it blank; fill it in if you set a password for the private domain name privatePassword
  //   B. CF Email Routing Forward:inboxEmail Fill in fixed GPTmail Mail
  const [gptMailBaseURL, setGptMailBaseURL] = useState(saved.gptMailBaseURL || '')
  const [gptMailInboxEmail, setGptMailInboxEmail] = useState(saved.gptMailInboxEmail || '')
  const [gptMailDomain, setGptMailDomain] = useState(saved.gptMailDomain || '')
  const [gptMailPrefix, setGptMailPrefix] = useState(saved.gptMailPrefix || '')
  const [gptMailPrivatePassword, setGptMailPrivatePassword] = useState(saved.gptMailPrivatePassword || '')

  const logContainerRef = useRef<HTMLDivElement>(null)
  const { addAccount, accounts } = useAccountsStore()

  /** Removes the next available proxy from the proxy pool (if enabled) and returns proxy + upstreamProxy For registration configuration injection */
  const getRegistrationProxy = useCallback((): { proxy: string; upstreamProxy: string; proxyId: string; label: string } | null => {
    const { pickNextProxy, proxyPoolConfig } = useAccountsStore.getState()
    const entry = pickNextProxy()
    if (!entry) return null
    const masked = entry.url.replace(/:([^:@/]+)@/, ':***@')
    return {
      proxy: entry.url,
      upstreamProxy: proxyPoolConfig.upstreamProxy || '',
      proxyId: entry.id,
      label: masked
    }
  }, [])

  const addLog = useCallback((msg: string) => {
    const next = [..._logs, `[${new Date().toLocaleTimeString()}] ${msg}`]
    _logs = next
    _refSetLogs?.(next)
  }, [])

  useEffect(() => {
    const el = logContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // Register one-time log / step IPC Listener: module level registration, never canceled,
  // Avoid losing intermediate events when switching to other pages (previously used useEffect exist unmount If canceled, the event will be lost)
  useEffect(() => {
    ensureLogListenerRegistered()
    ensureStepListenerRegistered()
  }, [])

  // Detect the registration process status when the page is mounted
  useEffect(() => {
    window.api.registrationStatus().then((res) => {
      if (res.inProgress && _phase === 'idle') {
        // There is a process in the backend but no state in the frontend (application restart scenario), cancel the remaining
        window.api.registrationCancel()
      }
    })
  }, [])

  const reset = (): void => {
    _phase = 'idle'
    _logs = []
    _result = null
    setPhase('idle')
    setLogs([])
    setResult(null)
    setImported(false)
    setOtp('')
  }

  // ============ manual mode ============

  /** Collect local used mailbox collections (account inventory + Registration history + Known occupancy blacklist)*/
  const collectUsedEmails = useCallback((): Set<string> => {
    const used = new Set<string>()
    for (const acc of accounts.values()) {
      if (acc.email) used.add(acc.email.toLowerCase())
    }
    // Registration history (including history of unimported accounts)
    for (const item of loadHistory()) {
      if (item.email) used.add(item.email.toLowerCase())
    }
    // Known occupied mailbox blacklist
    for (const e of loadEmailBlacklist()) {
      used.add(e)
    }
    return used
  }, [accounts])

  // Proton Dot variant allocation: session-level allocated collection to avoid concurrency/Continuous registration generates duplicate variants
  const protonAllocatedRef = useRef<Set<string>>(new Set())
  /** Generate the next unused Proton Dot number variant address; the main email address is not filled in or the variants are exhausted and returned null */
  const generateProtonEmail = useCallback((): string | null => {
    const base = protonBaseEmail.trim()
    if (!base || !splitEmail(base)) return null
    const used = new Set(collectUsedEmails())
    for (const e of protonAllocatedRef.current) used.add(e.toLowerCase())
    const result = generateNextDotVariant(base, used)
    if (result.variant) protonAllocatedRef.current.add(result.variant.toLowerCase())
    return result.variant
  }, [protonBaseEmail, collectUsedEmails])

  const startManual = async (): Promise<void> => {
    // 1. Pre-generated email: Generate dot number variants from the parent email when anonymous is turned on; otherwise use the parent email itself (if filled in)
    let preEmail = ''
    if (anonymousEmail) {
      const parent = parentEmail.trim()
      if (!parent || !splitEmail(parent)) {
        addLog(t('register.logAnonymousNoParent'))
        return
      }
      const result = generateNextDotVariant(parent, collectUsedEmails())
      if (!result.variant) {
        addLog(t('register.logAnonymousExhausted'))
        return
      }
      preEmail = result.variant
      setEmail(preEmail)
      addLog(t('register.logAnonymousGenerated').replace('{email}', preEmail).replace('{dots}', String(result.dotCount)))
    } else if (parentEmail.trim()) {
      preEmail = parentEmail.trim()
      setEmail(preEmail)
    }

    setPhase('initializing')
    _logs = []; setLogs([])
    setResult(null)
    setImported(false)
    addLog(t('register.logManualInit'))

    const config: Record<string, string> = {}
    if (fullName.trim()) config.fullName = fullName.trim()

    // Proxy pool injection: If the proxy pool is enabled and there is an available proxy, one will be automatically taken and passed in config
    const proxyInfo = getRegistrationProxy()
    if (proxyInfo) {
      config.proxy = injectProxySession(proxyInfo.proxy)
      config.upstreamProxy = proxyInfo.upstreamProxy
      addLog(`[Proxy] ${isEn ? 'Using proxy pool' : 'Use proxy pool'}: ${config.proxy.replace(/:([^:@/]+)@/, ':***@')}`)
    }

    const res = await window.api.registrationManualPhase1(config)
    if (!res.success) {
      addLog(`${t('register.logInitFailed')} ${res.error}`)
      setPhase('idle')
      return
    }
    addLog(t('register.logInitDone'))
    setPhase('email')

    // 2. If the email address is prefilled, it will be automatically submitted. phase2Skip the manual entry stage
    if (preEmail) {
      setPhase('running')
      addLog(`${t('register.logSubmitEmail')} ${preEmail}`)
      const phase2Res = await window.api.registrationManualPhase2(preEmail, fullName.trim() || undefined)
      if (phase2Res.success) {
        addLog(t('register.logOtpSent'))
        setPhase('otp')
      } else {
        addLog(`${t('register.logFailed')} ${phase2Res.error}`)
        setPhase('idle')
      }
    }
  }

  const submitEmail = async (): Promise<void> => {
    if (!email.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitEmail')} ${email}`)

    const res = await window.api.registrationManualPhase2(email.trim(), fullName.trim() || undefined)
    if (res.success) {
      addLog(t('register.logOtpSent'))
      setPhase('otp')
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  const submitOTP = async (): Promise<void> => {
    if (!otp.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitOtp')} ${otp}`)

    const res = await window.api.registrationManualPhase3(otp.trim())
    if (res.success) {
      const regResult = res.result as RegResult
      setResult(regResult)
      setPhase('done')
      addHistory({ email: regResult.email, status: regResult.status, password: regResult.password, result: regResult })
      const isSuccess = regResult.status === 'success'
      const needImport = batchAutoImport && isSuccess
      const needProLink = autoFetchProLink && isSuccess

      if (needImport) {
        setPhase('importing')
        const ok = await autoImportResult(regResult)
        if (ok) {
          setImported(true)
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === regResult.email && !h.imported)
            if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], imported: true }; return u }
            return prev
          })
        }
      }
      if (needProLink) {
        setPhase('fetching-link')
        await fetchProSubscriptionUrl(regResult, regResult.email)
      }
      // All post-processing completed → finalized;Hold when no postprocessing is enabled done(Semantic equivalent)
      if (needImport || needProLink) {
        setPhase('finalized')
      }
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  // ============ automatic mode (MoEmail / Outlook) ============

  const startAuto = async (): Promise<void> => {
    setPhase('running')
    _logs = []; setLogs([])
    setResult(null)
    setImported(false)
    const modeLabel = mode === 'tempmail' ? 'TempMail.Plus' : mode === 'proton' ? 'Proton' : mode === 'gptmail' ? 'GPTmail' : 'Outlook'
    addLog(t('register.logAutoStart').replace('{mode}', modeLabel))

    const config: Record<string, unknown> = {}
    if (mode === 'outlook') {
      config.useOutlook = true
      config.outlookData = outlookData
    } else if (mode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (mode === 'proton') {
      const variant = generateProtonEmail()
      if (!variant) {
        addLog(isEn ? '[Proton] Base email not set or all dot-variants used up' : '[Proton] The parent mailbox is not configured or the dot number variants have been exhausted.')
        setPhase('idle')
        return
      }
      config.useProton = true
      config.protonEmail = variant
      addLog(`[Proton] ${isEn ? 'Using dot-variant' : 'Use dot variant'}: ${variant}`)
    } else if (mode === 'gptmail') {
      if (!gptMailDomain.trim()) {
        addLog(isEn ? '[GPTmail] Domain not configured' : '[GPTmail] No domain name configured')
        setPhase('idle')
        return
      }
      config.useGptMail = true
      config.gptMailBaseURL = gptMailBaseURL.trim()
      config.gptMailInboxEmail = gptMailInboxEmail.trim()  // Leave blank → Private domain name will be collected directly; filled in → CF Forward
      config.gptMailDomain = gptMailDomain
      config.gptMailPrefix = gptMailPrefix.trim()
      config.gptMailPrivatePassword = gptMailPrivatePassword  // Fill in the private domain name after setting a password
    }

    // Agent pool injection
    const proxyInfo = getRegistrationProxy()
    if (proxyInfo) {
      config.proxy = injectProxySession(proxyInfo.proxy)
      config.upstreamProxy = proxyInfo.upstreamProxy
      addLog(`[Proxy] ${isEn ? 'Using proxy pool' : 'Use proxy pool'}: ${String(config.proxy).replace(/:([^:@/]+)@/, ':***@')}`)
    }

    const res = await window.api.registrationStartAuto(config as Parameters<typeof window.api.registrationStartAuto>[0])
    if (!res.success) {
      addLog(`${t('register.logStartFailed')} ${res.error}`)
      setPhase('idle')
    }
  }

  // ============ Cancel ============

  const cancel = async (): Promise<void> => {
    await window.api.registrationCancel()
    addLog(t('register.logCancelled'))
    setPhase('idle')
  }

  // ============ Import account ============

  const importAccount = async (): Promise<void> => {
    if (!result || result.status !== 'success' || !result.refreshToken) return

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: result.refreshToken,
        clientId: result.clientId!,
        clientSecret: result.clientSecret!,
        region: result.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn
          ? now + verifyResult.data.expiresIn * 1000
          : now + 3600000
        const usage = verifyResult.data.usage
          ? {
              ...verifyResult.data.usage,
              percentUsed: verifyResult.data.usage.limit > 0
                ? Math.round((verifyResult.data.usage.current / verifyResult.data.usage.limit) * 100)
                : 0,
              lastUpdated: now
            }
          : defaultUsage

        addAccount({
          email: verifyResult.data.email || result.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: result.refreshToken,
            clientId: result.clientId!,
            clientSecret: result.clientSecret!,
            accessToken: verifyResult.data.accessToken || result.accessToken || '',
            csrfToken: '',
            region: result.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt
          },
          subscription: {
            type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free',
            title: verifyResult.data.subscriptionTitle || 'Free Tier'
          },
          usage,
          tags: [],
          lastUsedAt: now
        })
        setImported(true)
        addLog(t('register.logImported'))
      } else {
        addLog(`${t('register.logVerifyFailed')} ${verifyResult.error}`)
        addAccount({
          email: result.email,
          idp: 'BuilderId',
          status: 'active',
          credentials: {
            refreshToken: result.refreshToken,
            clientId: result.clientId!,
            clientSecret: result.clientSecret!,
            accessToken: result.accessToken || '',
            csrfToken: '',
            region: result.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt: now + 3600000
          },
          subscription: { type: 'Free', title: 'Free Tier' },
          usage: defaultUsage,
          tags: [],
          lastUsedAt: now
        })
        setImported(true)
        addLog(t('register.logDirectImport'))
      }
    } catch (err) {
      addLog(`${t('register.logImportFailed')} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 'isRunning' Indicates that the main line of the registration process is in progress (excluding idle/email/otp Waiting for user input state, not including completion state)
  const isRunning = phase === 'initializing' || phase === 'running' || phase === 'importing' || phase === 'fetching-link'
  // manualSteps / currentStep below"Batch registration"block state Calculated after definition

  // ============ Batch registration ============

  const [batchCount, setBatchCount] = useState(saved.batchCount ?? 1)
  const [batchInterval, setBatchInterval] = useState(saved.batchInterval ?? 5)
  const [batchRunning, _setBatchRunning] = useState(_batchRunning)
  const [batchDone, _setBatchDone] = useState(_batchDone)
  const [batchSuccess, _setBatchSuccess] = useState(_batchSuccess)
  const [batchFail, _setBatchFail] = useState(_batchFail)
  const [batchAutoImport, setBatchAutoImport] = useState(saved.batchAutoImport ?? true)
  const [batchRetries, setBatchRetries] = useState(saved.batchRetries ?? 1)
  const [batchConcurrency, setBatchConcurrency] = useState(saved.batchConcurrency ?? 1)
  const [autoFetchProLink, setAutoFetchProLink] = useState(saved.autoFetchProLink ?? false)
  const [proPlanType, setProPlanType] = useState<ProPlanType>(saved.proPlanType ?? 'Q_DEVELOPER_STANDALONE_PRO')
  const [batchItems, _setBatchItems] = useState<BatchItem[]>(_batchItems)

  // taskId → batchItem.id Mapping: direct reference to module level Map, component unmount/remount does not affect
  const taskIdToItemId = useRef(_taskIdToItemId)

  /** 1Hz Heartbeat, allowing running tasks to"Total time spent"Live beat (only batchRunning When enabled, save power) */
  const [batchClock, setBatchClock] = useState(Date.now())
  useEffect(() => {
    if (!batchRunning) return
    const id = setInterval(() => setBatchClock(Date.now()), 1000)
    return () => clearInterval(id)
  }, [batchRunning])

  // Dynamically build registration step (depending on whether automatic import is enabled / Pro Link)
  const manualSteps = useMemo(
    () => buildManualSteps(batchAutoImport, autoFetchProLink),
    [batchAutoImport, autoFetchProLink]
  )
  const lastLogText = logs.length > 0 ? logs[logs.length - 1] : undefined
  const currentStep = phaseToStep(phase, lastLogText, manualSteps)

  const setBatchRunning = (v: boolean) => { _batchRunning = v; _refSetBatchRunning?.(v) }
  const setBatchDone = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchDone) : v; _batchDone = next; _refSetBatchDone?.(next)
  }
  const setBatchSuccess = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchSuccess) : v; _batchSuccess = next; _refSetBatchSuccess?.(next)
  }
  const setBatchFail = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchFail) : v; _batchFail = next; _refSetBatchFail?.(next)
  }
  const setBatchItems = (v: BatchItem[] | ((p: BatchItem[]) => BatchItem[])) => {
    const next = typeof v === 'function' ? v(_batchItems) : v; _batchItems = next; _refSetBatchItems?.(next)
  }
  const batchAbort = useRef(false)
  // Pause status: Pause only"Start new task", the ones that have been executed concurrently will run out.
  const batchPause = useRef(false)
  const [isPaused, setIsPaused] = useState(false)
  // The current batch task is in the task center ID(for updating progress)
  const currentTaskCenterId = useRef<string | null>(null)

  // ============ Registration policy template ============
  const [templates, setTemplates] = useState<RegisterTemplate[]>(loadTemplates)
  const [showTemplatesMenu, setShowTemplatesMenu] = useState(false)

  const collectCurrentConfig = useCallback((): RegisterConfig => {
    // mixedEnabledSources Declare it below in this component to avoid hoisting Limit: from localStorage Read the latest value
    let mixed: AutoEmailSource[] = ['outlook', 'tempmail']
    try {
      const raw = localStorage.getItem('kiro-register-mixed-sources')
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        mixed = arr.filter((x): x is AutoEmailSource => x === 'outlook' || x === 'tempmail' || x === 'proton' || x === 'gptmail')
        if (mixed.length === 0) mixed = ['outlook', 'tempmail']
      }
    } catch { /* ignore */ }
    return {
      mode,
      outlookData,
      fullName,
      batchCount,
      batchInterval,
      batchAutoImport,
      batchRetries,
      batchConcurrency,
      autoFetchProLink,
      proPlanType,
      tempMailEmail,
      tempMailEpin,
      tempMailDomain,
      protonBaseEmail,
      gptMailBaseURL,
      gptMailInboxEmail,
      gptMailDomain,
      gptMailPrefix,
      gptMailPrivatePassword,
      manualParentEmail: parentEmail,
      manualAnonymousEmail: anonymousEmail,
      mixedEnabledSources: mixed
    }
  }, [mode, outlookData, fullName, batchCount, batchInterval, batchAutoImport, batchRetries, batchConcurrency, autoFetchProLink, proPlanType, tempMailEmail, tempMailEpin, tempMailDomain, protonBaseEmail, gptMailBaseURL, gptMailInboxEmail, gptMailDomain, gptMailPrefix, gptMailPrivatePassword, parentEmail, anonymousEmail])

  const applyTemplate = useCallback((tpl: RegisterTemplate) => {
    const c = tpl.config
    // Compatible with old templates:mode === 'moemail' fall back to outlook
    setMode((c.mode === ('moemail' as RegMode) ? 'outlook' : c.mode) as RegMode)
    setOutlookData(c.outlookData || '')
    setFullName(c.fullName || '')
    setBatchCount(c.batchCount ?? 1)
    setBatchInterval(c.batchInterval ?? 5)
    setBatchAutoImport(c.batchAutoImport ?? true)
    setBatchRetries(c.batchRetries ?? 1)
    setBatchConcurrency(c.batchConcurrency ?? 1)
    setAutoFetchProLink(c.autoFetchProLink ?? false)
    setProPlanType(c.proPlanType ?? 'Q_DEVELOPER_STANDALONE_PRO')
    setTempMailEmail(c.tempMailEmail || '')
    setTempMailEpin(c.tempMailEpin || '')
    setTempMailDomain(c.tempMailDomain || '')
    setProtonBaseEmail(c.protonBaseEmail || '')
    setGptMailBaseURL(c.gptMailBaseURL || '')
    setGptMailInboxEmail(c.gptMailInboxEmail || '')
    setGptMailDomain(c.gptMailDomain || '')
    setGptMailPrefix(c.gptMailPrefix || '')
    setGptMailPrivatePassword(c.gptMailPrivatePassword || '')
    setParentEmail(c.manualParentEmail || '')
    setAnonymousEmail(c.manualAnonymousEmail ?? false)
    if (c.mixedEnabledSources) setMixedEnabledSources(c.mixedEnabledSources)
    addLog(`[Template] Template applied:${tpl.name}`)
    setShowTemplatesMenu(false)
  }, [addLog])

  const saveCurrentAsTemplate = useCallback(() => {
    const name = prompt('To save the current configuration as a template, enter a template name:')?.trim()
    if (!name) return
    const tpl: RegisterTemplate = {
      id: crypto.randomUUID(),
      name,
      config: collectCurrentConfig(),
      createdAt: Date.now()
    }
    const next = [tpl, ...templates]
    setTemplates(next)
    saveTemplates(next)
    addLog(`[Template] Saved template:${name}`)
  }, [collectCurrentConfig, templates, addLog])

  const removeTemplate = useCallback((id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return
    const next = templates.filter((t) => t.id !== id)
    setTemplates(next)
    saveTemplates(next)
  }, [templates])

  // ============ scheduled tasks + daily quota ============
  // Daily number of successful registrations (aggregated by local date, automatically reset across days)
  const dailyQuotaKey = useMemo(() => {
    const d = new Date()
    return `kiro-register-quota-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }, [])
  const [dailyQuotaUsed, setDailyQuotaUsedState] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(dailyQuotaKey) || '0', 10) || 0 } catch { return 0 }
  })
  const incrementDailyQuota = useCallback((n: number) => {
    setDailyQuotaUsedState((prev) => {
      const next = prev + n
      try { localStorage.setItem(dailyQuotaKey, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [dailyQuotaKey])

  const [dailyQuotaLimit, setDailyQuotaLimit] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-dailyquota-limit') || '0', 10) || 0 } catch { return 0 }
  })
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('kiro-register-schedule-enabled') === '1' } catch { return false }
  })
  const [scheduleTime, setScheduleTime] = useState<string>(() => {
    try { return localStorage.getItem('kiro-register-schedule-time') || '03:00' } catch { return '03:00' }
  })
  /** C6: day of the week mask (bit 0=Sunday ... Bit 6=Saturday), default every day (127） */
  const [scheduleWeekMask, setScheduleWeekMask] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-schedule-week-mask') || '127', 10) } catch { return 127 }
  })

  useEffect(() => { try { localStorage.setItem('kiro-register-dailyquota-limit', String(dailyQuotaLimit)) } catch { /* ignore */ } }, [dailyQuotaLimit])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-enabled', scheduleEnabled ? '1' : '0') } catch { /* ignore */ } }, [scheduleEnabled])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-time', scheduleTime) } catch { /* ignore */ } }, [scheduleTime])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-week-mask', String(scheduleWeekMask)) } catch { /* ignore */ } }, [scheduleWeekMask])

  // Scheduled task: Check whether the time is up every minute (including weekday filtering)
  const scheduleTriggered = useRef<string>('')  // Mark whether it has been triggered today to prevent duplication
  useEffect(() => {
    if (!scheduleEnabled) return
    const tick = (): void => {
      if (batchRunning) return
      const now = new Date()
      const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
      if (scheduleTriggered.current === todayKey) return
      // C6: Weekday mask filter (bit 0=Sunday ... Bit 6=Saturday)
      const dow = now.getDay()
      if (!(scheduleWeekMask & (1 << dow))) return
      const [hh, mm] = scheduleTime.split(':').map((s) => parseInt(s, 10))
      if (now.getHours() === hh && now.getMinutes() === mm) {
        scheduleTriggered.current = todayKey
        addLog(`[Schedule] Reach scheduled start time ${scheduleTime}, automatically start batch registration`)
        void startBatch()
      }
    }
    const timer = setInterval(tick, 60_000)
    tick()
    return () => clearInterval(timer)
    // deliberately ignore startBatch Dependencies (it depends on too many state, the reference changes every time;scheduleTriggered prevent reentrancy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleEnabled, scheduleTime, scheduleWeekMask, batchRunning])

  // ============ speed limit + Risk control ============
  // Persistent user rate limit configuration
  const [rateLimitEnabled, setRateLimitEnabled] = useState<boolean>(() => {
    try { const v = localStorage.getItem('kiro-register-ratelimit-enabled'); return v === null ? true : v === '1' } catch { return true }
  })
  const [maxPerMinute, setMaxPerMinute] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-ratelimit-max') || '10', 10) || 10 } catch { return 10 }
  })
  const [burstSize, setBurstSize] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-ratelimit-burst') || '3', 10) || 3 } catch { return 3 }
  })
  const [backoffBaseSec, setBackoffBaseSec] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-backoff-base-sec') || '8', 10) || 8 } catch { return 8 }
  })
  const [backoffMaxSec, setBackoffMaxSec] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-backoff-max-sec') || '120', 10) || 120 } catch { return 120 }
  })
  const [autoBackoff, setAutoBackoff] = useState<boolean>(() => {
    try { return localStorage.getItem('kiro-register-autobackoff') !== '0' } catch { return true }
  })
  // Automatically pause after risk control is triggered (B3）
  const [autoPauseOnRisk, setAutoPauseOnRisk] = useState<boolean>(() => {
    try { return localStorage.getItem('kiro-register-autopause-risk') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-enabled', rateLimitEnabled ? '1' : '0') } catch { /* ignore */ } }, [rateLimitEnabled])
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-max', String(maxPerMinute)) } catch { /* ignore */ } }, [maxPerMinute])
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-burst', String(burstSize)) } catch { /* ignore */ } }, [burstSize])
  useEffect(() => { try { localStorage.setItem('kiro-register-backoff-base-sec', String(backoffBaseSec)) } catch { /* ignore */ } }, [backoffBaseSec])
  useEffect(() => { try { localStorage.setItem('kiro-register-backoff-max-sec', String(backoffMaxSec)) } catch { /* ignore */ } }, [backoffMaxSec])
  useEffect(() => { try { localStorage.setItem('kiro-register-autobackoff', autoBackoff ? '1' : '0') } catch { /* ignore */ } }, [autoBackoff])
  useEffect(() => { try { localStorage.setItem('kiro-register-autopause-risk', autoPauseOnRisk ? '1' : '0') } catch { /* ignore */ } }, [autoPauseOnRisk])

  // Rate limiter instance (singleton ref）
  const rateLimiterRef = useRef<RateLimiter | null>(null)
  // Rate limiter snapshot (refreshed every second to React state）
  const [rateSnapshot, setRateSnapshot] = useState<RateLimiterSnapshot | null>(null)
  // Track the last risk control status to avoid continuous triggering webhook
  const lastRiskWarningRef = useRef(false)
  useEffect(() => {
    if (!batchRunning) {
      setRateSnapshot(null)
      lastRiskWarningRef.current = false
      return
    }
    const timer = setInterval(() => {
      if (rateLimiterRef.current) {
        const snap = rateLimiterRef.current.snapshot()
        setRateSnapshot(snap)
        // Risk control signal rising edge: never warned → warning, trigger webhook + May automatically pause
        if (snap.riskWarning && !lastRiskWarningRef.current) {
          lastRiskWarningRef.current = true
          // auto-pause
          if (autoPauseOnRisk && !batchPause.current) {
            batchPause.current = true
            setIsPaused(true)
            if (currentTaskCenterId.current) {
              useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
            }
            addLog(`[RiskControl] Risk control triggers and automatically pauses (success rate ${Math.round(snap.successRate * 100)}%）`)
          }
          void useWebhookStore.getState().triggerEvent('risk-warning', {
            title: 'Risk control signal trigger',
            message: `The batch registration success rate is reduced to ${Math.round(snap.successRate * 100)}%${autoPauseOnRisk ? ', automatically paused' : ', it is recommended to suspend inspection'}`,
            level: 'warn',
            fields: {
              'success rate': `${Math.round(snap.successRate * 100)}%`,
              'consecutive failures': snap.consecutiveFailures,
              'Hesitation': `${snap.throughputPerMinute}/min`,
              action: autoPauseOnRisk ? 'Automatically paused' : 'Please check manually'
            }
          })
        } else if (!snap.riskWarning && lastRiskWarningRef.current) {
          // Risk control recovery
          lastRiskWarningRef.current = false
        }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [batchRunning])

  // Automatically save configuration to localStorage
  useEffect(() => {
    saveConfig({ mode, outlookData, fullName, batchCount, batchInterval, batchAutoImport, batchRetries, batchConcurrency, autoFetchProLink, proPlanType, tempMailEmail, tempMailEpin, tempMailDomain, protonBaseEmail, gptMailBaseURL, gptMailInboxEmail, gptMailDomain, gptMailPrefix, gptMailPrivatePassword, manualParentEmail: parentEmail, manualAnonymousEmail: anonymousEmail })
  }, [mode, outlookData, fullName, batchCount, batchInterval, batchAutoImport, batchRetries, batchConcurrency, autoFetchProLink, proPlanType, tempMailEmail, tempMailEpin, tempMailDomain, protonBaseEmail, gptMailBaseURL, gptMailInboxEmail, gptMailDomain, gptMailPrefix, gptMailPrivatePassword, parentEmail, anonymousEmail])

  // Anonymous mailbox preview calculation — by anonymousEmail/parentEmail/accounts Next variant for relying on real-time cold calculations
  const anonymousPreview = useMemo(() => {
    if (!anonymousEmail) return null
    const parent = parentEmail.trim()
    if (!parent) return { error: 'empty' as const }
    const split = splitEmail(parent)
    if (!split) return { error: 'invalid' as const }
    const used = new Set<string>()
    for (const acc of accounts.values()) {
      if (acc.email) used.add(acc.email.toLowerCase())
    }
    for (const item of loadHistory()) {
      if (item.email) used.add(item.email.toLowerCase())
    }
    const result = generateNextDotVariant(parent, used)
    const sameRootCount = countSameRootVariants(parent, used)
    const localLen = split[0].replace(/\./g, '').length
    // The upper limit is estimated to 5 points, enough to cope with most scenarios (to avoid the large binomial UI misleading)
    const totalCapacity = totalVariantCount(localLen, 5)
    return { ...result, sameRootCount, totalCapacity, localLen, error: null as null | 'empty' | 'invalid' }
  }, [anonymousEmail, parentEmail, accounts])

  // ============ Registration history ============

  const [history, _setHistory] = useState<HistoryItem[]>(loadHistory)

  const setHistory = useCallback((updater: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => {
    _refSetHistory?.((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saveHistory(next)
      return next
    })
  }, [])

  const addHistory = useCallback((item: Omit<HistoryItem, 'id' | 'time' | 'imported'>) => {
    setHistory((prev) => [{
      ...item,
      id: crypto.randomUUID(),
      time: Date.now(),
      imported: false
    }, ...prev])
  }, [setHistory])

  // Register module level setter refs, ensuring that asynchronous code calls the latest across component lifecycles setter
  useEffect(() => {
    _refSetPhase = _setPhase
    _refSetResult = _setResult
    _refSetLogs = setLogs
    _refSetBatchRunning = _setBatchRunning
    _refSetBatchDone = _setBatchDone
    _refSetBatchSuccess = _setBatchSuccess
    _refSetBatchFail = _setBatchFail
    _refSetBatchItems = _setBatchItems
    _refSetHistory = _setHistory
    // Synchronize module-level status to when component is remounted React state
    _setPhase(_phase)
    _setResult(_result)
    setLogs([..._logs])
    _setBatchRunning(_batchRunning)
    _setBatchDone(_batchDone)
    _setBatchSuccess(_batchSuccess)
    _setBatchFail(_batchFail)
    _setBatchItems([..._batchItems])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Automatically import a single successful result
  const autoImportResult = useCallback(async (regResult: RegResult): Promise<boolean> => {
    if (!regResult.refreshToken || !regResult.clientId || !regResult.clientSecret) return false
    const now = Date.now()
    const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

    // Fast Path: Backend verifyAlive Complete information returned (verify.alive=true), directly use it to import
    // avoid resetting verifyAccountCredentials flower 30-60 seconds (network request redundancy)
    const v = regResult.verify as Record<string, unknown> | undefined
    if (v && v.alive) {
      const sub = String(v.subscription || 'KIRO FREE')
      const creditUsed = Number(v.credit_used) || 0
      const creditLimit = Number(v.credit_limit) || 0
      const subType = sub.includes('PRO_PLUS') ? 'Pro_Plus' as const
        : sub.includes('PRO') ? 'Pro' as const
        : sub.includes('POWER') ? 'Pro_Plus' as const
        : 'Free' as const
      addAccount({
        email: String(v.email || regResult.email),
        password: regResult.password,
        idp: 'BuilderId',
        status: 'active',
        credentials: {
          refreshToken: regResult.refreshToken,
          clientId: regResult.clientId,
          clientSecret: regResult.clientSecret,
          accessToken: regResult.accessToken || '',
          csrfToken: '',
          region: regResult.region || 'us-east-1',
          authMethod: 'IdC' as const,
          provider: 'BuilderId' as const,
          expiresAt: now + 3600000
        },
        subscription: { type: subType, title: sub },
        usage: creditLimit > 0
          ? { current: creditUsed, limit: creditLimit, percentUsed: Math.round((creditUsed / creditLimit) * 100), lastUpdated: now }
          : defaultUsage,
        tags: [],
        lastUsedAt: now
      })
      return true
    }

    // Downgrade path: backend verify When information is missing, go to the Internet for verification (recovery)
    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: regResult.refreshToken,
        clientId: regResult.clientId,
        clientSecret: regResult.clientSecret,
        region: regResult.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600000
        const usage = verifyResult.data.usage
          ? { ...verifyResult.data.usage, percentUsed: verifyResult.data.usage.limit > 0 ? Math.round((verifyResult.data.usage.current / verifyResult.data.usage.limit) * 100) : 0, lastUpdated: now }
          : defaultUsage
        addAccount({
          email: verifyResult.data.email || regResult.email, password: regResult.password, idp: 'BuilderId', status: 'active',
          credentials: { refreshToken: regResult.refreshToken, clientId: regResult.clientId, clientSecret: regResult.clientSecret, accessToken: verifyResult.data.accessToken || regResult.accessToken || '', csrfToken: '', region: regResult.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt },
          subscription: { type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free', title: verifyResult.data.subscriptionTitle || 'Free Tier' },
          usage, tags: [], lastUsedAt: now
        })
      } else {
        addAccount({
          email: regResult.email, password: regResult.password, idp: 'BuilderId', status: 'active',
          credentials: { refreshToken: regResult.refreshToken, clientId: regResult.clientId, clientSecret: regResult.clientSecret, accessToken: regResult.accessToken || '', csrfToken: '', region: regResult.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt: now + 3600000 },
          subscription: { type: 'Free', title: 'Free Tier' }, usage: defaultUsage, tags: [], lastUsedAt: now
        })
      }
      return true
    } catch {
      return false
    }
  }, [addAccount])

  // get Pro Subscription link and write the subscription page link list
  const fetchProSubscriptionUrl = useCallback(async (regResult: RegResult, email: string): Promise<string | undefined> => {
    const accessToken = regResult.accessToken
    if (!accessToken) return undefined
    const linkId = crypto.randomUUID()
    appendSubscriptionLink({ accountId: linkId, email, status: 'loading' })
    try {
      addLog(`[Pro Link] ${email}: ${t('register.fetchingProLink')} (${proPlanType.replace('Q_DEVELOPER_STANDALONE_', '')})...`)
      const result = await window.api.accountGetSubscriptionUrl(
        accessToken,
        proPlanType,
        regResult.region || 'us-east-1',
        undefined,
        undefined,
        'BuilderId',
        'IdC',
        undefined
      )
      if (result.success && result.url) {
        addLog(`[Pro Link] ${email}: ${result.url}`)
        updateSubscriptionLink(linkId, { status: 'success', url: result.url })
        return result.url
      }
      const errMsg = result.error || 'Failed to get link'
      addLog(`[Pro Link] ${email}: ${errMsg}`)
      updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
      return undefined
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      addLog(`[Pro Link] ${email}: ${errMsg}`)
      updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
      return undefined
    }
  }, [addLog, t])

  // Monitoring registration completed - Record to history at the same time + Automatic import
  const onRegComplete = useCallback(async (res: RegResult) => {
    setResult(res)
    setPhase('done')
    if (res.status === 'success') {
      addLog(`${t('register.logRegSuccess')} ${res.email}`)
      addHistory({ email: res.email, status: 'success', password: res.password, result: res })
      // trigger Webhook
      void useWebhookStore.getState().triggerEvent('register-success', {
        title: 'Account registration successful',
        message: `new account ${res.email} Registration completed`,
        level: 'success',
        fields: { Mail: res.email, model: mode }
      })
      // with manual mode submitOTP State machine remains consistent: advancement during post-processing phase，
      // Avoid postprocessing while still running phase Change in advance 'done' lead to"New registration"Button appears early + reset Competition
      const needImport = batchAutoImport
      const needProLink = autoFetchProLink
      if (needImport) {
        setPhase('importing')
        const ok = await autoImportResult(res)
        if (ok) {
          setImported(true)
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === res.email && !h.imported)
            if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], imported: true }; return u }
            return prev
          })
        }
      }
      if (needProLink) {
        setPhase('fetching-link')
        await fetchProSubscriptionUrl(res, res.email)
      }
      // All post-processing completed → finalized;Hold when no postprocessing is enabled done(Semantic equivalent)
      if (needImport || needProLink) {
        setPhase('finalized')
      }
    } else {
      addLog(`${t('register.logRegFailed')} ${res.error}`)
      addHistory({ email: res.email, status: res.status, error: res.error, password: res.password, result: res })
      // Single mode failure compensation: add to blacklist when mailbox is occupied (similar to batch runSingleWithRetry logical alignment),
      // next time generateProtonEmail / Anonymous transfiguration collectUsedEmails automatically skip
      if (res.email && classifyError(res.error) === 'email_used') {
        const set = loadEmailBlacklist()
        set.add(res.email.toLowerCase())
        saveEmailBlacklist(set)
        addLog(`[Precheck] Mail ${res.email} Already added to occupation blacklist`)
      }
      // trigger Webhook
      void useWebhookStore.getState().triggerEvent('register-failed', {
        title: 'Account registration failed',
        message: `${res.email || '(Unknown email)'} Registration failed`,
        level: 'error',
        fields: { Mail: res.email || '-', mistake: res.error || '-', model: mode }
      })
    }
  }, [addLog, addHistory, t, batchAutoImport, autoImportResult, autoFetchProLink, fetchProSubscriptionUrl, mode])

  // overwrite the original onRegistrationComplete monitor
  useEffect(() => {
    const unsub = window.api.onRegistrationComplete(onRegComplete)
    return () => unsub()
  }, [onRegComplete])

  // Mixed Mode: Subsources Enabled + weight + Cumulative scheduling status
  const [mixedEnabledSources, setMixedEnabledSources] = useState<AutoEmailSource[]>(() => {
    try {
      const raw = localStorage.getItem('kiro-register-mixed-sources')
      if (raw) {
        // Compatible with old data: filter out obsolete data moemail
        const arr = JSON.parse(raw) as string[]
        const valid = arr.filter((x): x is AutoEmailSource => x === 'outlook' || x === 'tempmail' || x === 'proton' || x === 'gptmail')
        return valid.length > 0 ? valid : ['outlook', 'tempmail']
      }
    } catch { /* ignore */ }
    return ['outlook', 'tempmail']
  })
  /** The weight of each source (default 1） — weighted polling */
  const [mixedWeights, setMixedWeights] = useState<Record<AutoEmailSource, number>>(() => {
    try {
      const raw = localStorage.getItem('kiro-register-mixed-weights')
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>
        return { outlook: parsed.outlook ?? 1, tempmail: parsed.tempmail ?? 1, proton: parsed.proton ?? 1, gptmail: parsed.gptmail ?? 1 }
      }
    } catch { /* ignore */ }
    return { outlook: 1, tempmail: 1, proton: 1, gptmail: 1 }
  })
  useEffect(() => {
    try { localStorage.setItem('kiro-register-mixed-sources', JSON.stringify(mixedEnabledSources)) } catch { /* ignore */ }
  }, [mixedEnabledSources])
  useEffect(() => {
    try { localStorage.setItem('kiro-register-mixed-weights', JSON.stringify(mixedWeights)) } catch { /* ignore */ }
  }, [mixedWeights])

  // Weighted round-robin scheduling: maintain the"Credit"Score, choose the one with the highest credit each time, and accumulate after deduction
  // This is Smooth Weighted Round-Robin algorithm(nginx Use the same style)
  const mixedCredits = useRef<Record<AutoEmailSource, number>>({ outlook: 0, tempmail: 0, proton: 0, gptmail: 0 })

  /** Pick next valid subsource in weighted polling in mixed mode */
  const pickNextSource = useCallback((): AutoEmailSource | null => {
    const candidates = mixedEnabledSources.filter((src) => {
      // The sub-source must fill in the corresponding configuration.
      if (src === 'outlook') return !!outlookData.trim()
      if (src === 'tempmail') return !!(tempMailDomain.trim() && tempMailEmail.trim() && tempMailEpin.trim())
      if (src === 'proton') return !!protonBaseEmail.trim()
      // GPTmail: As long as there is a domain name OK（inboxEmail Leave blank = Private direct collection mode)
      if (src === 'gptmail') return !!gptMailDomain.trim()
      return false
    })
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]

    // SWRR: Give all candidates each time credit += weight, pick credit highest, then the item credit -= totalWeight
    let totalWeight = 0
    for (const c of candidates) totalWeight += Math.max(0, mixedWeights[c] || 0)
    if (totalWeight === 0) totalWeight = candidates.length // Cover: all 0 Degradation to simple polling when weighting

    let best: AutoEmailSource | null = null
    let bestCredit = -Infinity
    for (const c of candidates) {
      const w = Math.max(0, mixedWeights[c] || 0) || 1
      mixedCredits.current[c] = (mixedCredits.current[c] || 0) + w
      if (mixedCredits.current[c] > bestCredit) {
        best = c
        bestCredit = mixedCredits.current[c]
      }
    }
    if (best) {
      mixedCredits.current[best] -= totalWeight
    }
    return best
  }, [mixedEnabledSources, mixedWeights, outlookData, tempMailDomain, tempMailEmail, tempMailEpin, protonBaseEmail, gptMailDomain, gptMailInboxEmail])

  // Build automatic mode configuration
  const buildAutoConfig = useCallback((): Parameters<typeof window.api.registrationStartAuto>[0] => {
    const config: Record<string, unknown> = {}

    // Mixed mode: pick one subsource per call
    const effectiveMode: AutoEmailSource | null = mode === 'mixed'
      ? pickNextSource()
      : (mode === 'manual' ? null : (mode as AutoEmailSource))

    if (effectiveMode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (effectiveMode === 'outlook') {
      config.useOutlook = true
      config.outlookData = outlookData
    } else if (effectiveMode === 'proton') {
      config.useProton = true
      const variant = generateProtonEmail()
      if (variant) config.protonEmail = variant
    } else if (effectiveMode === 'gptmail') {
      config.useGptMail = true
      config.gptMailBaseURL = gptMailBaseURL.trim()
      config.gptMailInboxEmail = gptMailInboxEmail.trim()
      config.gptMailDomain = gptMailDomain
      config.gptMailPrefix = gptMailPrefix.trim()
      config.gptMailPrivatePassword = gptMailPrivatePassword
    }
    return config as Parameters<typeof window.api.registrationStartAuto>[0]
  }, [mode, pickNextSource, outlookData, tempMailEmail, tempMailEpin, tempMailDomain, generateProtonEmail, gptMailBaseURL, gptMailInboxEmail, gptMailDomain, gptMailPrefix, gptMailPrivatePassword])

  // Agent pool: Automatically select an exit agent for each task when registering (effective after enabling)
  const { proxyPool, proxyPoolConfig, pickNextProxy, reportProxyResult } = useAccountsStore()

  /**
   * Outlook Single row pool: when starting in batches shuffle once, every task Exclusively occupy a row to avoid concurrent preemption.
   * previous bug:all task share the same outlookData, used by the main process Math.random() Pick → Concurrent tasks may hit the same mailbox.
   */
  const outlookPoolRef = useRef<string[]>([])

  // Perform single registration (including retries) - Restart every time buildAutoConfig,let mixed Mode weights take effect correctly
  const runSingleWithRetry = useCallback(async (
    itemId: string,
    taskId: string,
    maxRetries: number
  ): Promise<{ success: boolean; result?: RegResult }> => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // When paused, block and wait for recovery; when stopped, exit immediately —— let pause/Stop talking about"Try again"Also effective immediately
      while (batchPause.current && !batchAbort.current) {
        await new Promise((r) => setTimeout(r, 300))
      }
      if (batchAbort.current) return { success: false }

      if (attempt > 0) {
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: 'retrying' as BatchItemStatus, retryCount: attempt } : it
        ))
        addLog(t('register.batchRetrying').replace('{current}', String(attempt)).replace('{max}', String(maxRetries)))
        // Interruptible retry wait (per 100ms Check once abort,most 3s）
        for (let w = 0; w < 30 && !batchAbort.current; w++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        if (batchAbort.current) return { success: false }
      } else {
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: 'running' as BatchItemStatus } : it
        ))
      }

      // Restart every time build: each in blend mode task / Each retry selects the source independently (the weights take effect correctly)
      const config = buildAutoConfig()
      const enrichedConfig: Record<string, unknown> = { ...config, taskId }

      // Outlook Mode: from shuffle Take a single row from the last pool (different task Will not grab the same email address)
      // Fallback to full list when pool is empty (main process random pick, compatible with pocket)
      if (config.useOutlook && outlookPoolRef.current.length > 0) {
        const line = outlookPoolRef.current.shift()
        if (line) {
          enrichedConfig.outlookData = line
          addLog(`[Outlook] Assign mailbox: ${line.split('----')[0]}`)
        }
      }

      // Pick a proxy from the proxy pool (only when enabled); re-pick every time you try again, allowing failed proxy to be automatically avoided
      let pickedProxy: ReturnType<typeof pickNextProxy> = null
      if (proxyPoolConfig.enabled) {
        // Strict proxy mode: When the proxy pool is enabled, naked direct connections are never allowed (exposing the true identity of the machine). IP Give AWS It’s a taboo)
        if (proxyPool.size === 0) {
          addLog('[Proxy] The agent pool has been enabled but there is no agent in the pool. Registration has been terminated (please add an agent on the "Agent Pool" page first)')
          return { success: false, result: { status: 'failed', email: '', error: 'Agent pool is enabled but the pool is empty' } as RegResult }
        }
        pickedProxy = pickNextProxy()
        if (!pickedProxy) {
          addLog('[Proxy] Agent pool is enabled but no agents are currently available (all dead/disabled), registration has been suspended to prevent naked direct connection')
          return { success: false, result: { status: 'failed', email: '', error: 'There are no available agents in the agent pool.' } as RegResult }
        }
        const proxyUrl = injectProxySession(pickedProxy.url)
        enrichedConfig.proxy = proxyUrl
        enrichedConfig.strictProxy = true
        if (proxyPoolConfig.upstreamProxy && proxyPoolConfig.upstreamProxy.trim()) {
          enrichedConfig.upstreamProxy = proxyPoolConfig.upstreamProxy.trim()
        }
        const sessionTag = proxyUrl !== pickedProxy.url ? ' (session Injected)' : ''
        addLog(`[Proxy] Using ${pickedProxy.protocol}://${pickedProxy.host}:${pickedProxy.port}${sessionTag}`)
      }

      const res = await window.api.registrationStartAuto(enrichedConfig as typeof config)

      // Report agent usage results
      if (pickedProxy) {
        const ok = res.success && (res.result as RegResult | undefined)?.status === 'success'
        const emailUsed = (res.result as RegResult | undefined)?.email
        const errMsg = res.error || (res.result as RegResult | undefined)?.error
        reportProxyResult(pickedProxy.id, ok, emailUsed, errMsg)
      }

      if (res.success && res.result) {
        const regResult = res.result as RegResult
        if (regResult.status === 'success') {
          return { success: true, result: regResult }
        }
        if (attempt === maxRetries) {
          return { success: false, result: regResult }
        }
      } else if (!res.success) {
        if (attempt === maxRetries) return { success: false }
      }
    }
    return { success: false }
  }, [addLog, t, proxyPool, proxyPoolConfig.enabled, pickNextProxy, reportProxyResult, buildAutoConfig])

  // Processing of single batch registration task completed
  const handleBatchOutcome = async (
    itemId: string,
    outcome: { success: boolean; result?: RegResult }
  ): Promise<void> => {
    if (outcome.success && outcome.result) {
      setBatchSuccess((p) => p + 1)
      // Daily quota count (deducted only on success)
      if (dailyQuotaLimit > 0) incrementDailyQuota(1)
      setBatchItems((prev) => prev.map((it) =>
        it.id === itemId ? { ...it, status: 'success', email: outcome.result!.email } : it
      ))
      addHistory({ email: outcome.result.email, status: 'success', password: outcome.result.password, result: outcome.result })

      if (batchAutoImport) {
        const imported = await autoImportResult(outcome.result)
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: imported ? 'imported' : 'import_failed' } : it
        ))
        if (imported) {
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === outcome.result!.email && !h.imported)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = { ...updated[idx], imported: true }
              return updated
            }
            return prev
          })
        }
      }
      if (autoFetchProLink) {
        await fetchProSubscriptionUrl(outcome.result, outcome.result.email)
      }
    } else {
      setBatchFail((p) => p + 1)
      const errEmail = outcome.result?.email || ''
      const errMsg = outcome.result?.error || 'unknown'
      setBatchItems((prev) => prev.map((it) =>
        it.id === itemId ? { ...it, status: 'failed', email: errEmail, error: errMsg } : it
      ))
      if (outcome.result) {
        addHistory({ email: errEmail, status: 'failed', error: errMsg })
      }
      const errCategory = classifyError(errMsg)
      // Empirical pre-verification: the mailbox is occupied error and is added to the blacklist
      if (errEmail && errCategory === 'email_used') {
        const set = loadEmailBlacklist()
        set.add(errEmail.toLowerCase())
        saveEmailBlacklist(set)
        addLog(`[Precheck] Mail ${errEmail} Already added to occupation blacklist`)
      }
      // AWS Risk control trigger: immediate pause (if automatic pause is enabled)
      if (errCategory === 'risk_control' && autoPauseOnRisk && !batchPause.current) {
        batchPause.current = true
        setIsPaused(true)
        if (currentTaskCenterId.current) {
          useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
        }
        addLog(`[RiskControl] detected AWS Risk control (${errEmail || 'account'}), automatically suspend batch registration`)
        void useWebhookStore.getState().triggerEvent('risk-warning', {
          title: 'AWS Risk control triggered and automatically suspended',
          message: `account ${errEmail || '(Creating)'} trigger AWS Risk control and current limiting. It is recommended to enable proxy pool + Live test, or change IP and then resume.`,
          level: 'error',
          fields: { Mail: errEmail || '-', mistake: errMsg }
        })
      }
    }
    setBatchDone((p) => p + 1)
  }

  // Batch registration of main logic (supports concurrency + pause/recover + Progress reporting in task center)
  // second parameter retryItems used for"Retry queue from failure"Start: Rerun specified only items instead of creating a new N indivual
  const startBatch = async (retryItems?: BatchItem[]): Promise<void> => {
    if (mode === 'manual') return

    // Daily quota check
    if (dailyQuotaLimit > 0) {
      const remainingQuota = Math.max(0, dailyQuotaLimit - dailyQuotaUsed)
      if (remainingQuota === 0) {
        addLog(`[Quota] Quota is full today (${dailyQuotaUsed}/${dailyQuotaLimit}), skip startup`)
        alert(`Today’s registration quota has been exhausted (${dailyQuotaUsed}/${dailyQuotaLimit})`)
        return
      }
      const want = retryItems ? retryItems.length : batchCount
      if (want > remainingQuota) {
        addLog(`[Quota] This application ${want} , remaining quota today ${remainingQuota}, automatically reduced to ${remainingQuota}`)
        if (!retryItems) {
          setBatchCount(remainingQuota)
        }
      }
    }

    setBatchRunning(true)
    batchAbort.current = false
    batchPause.current = false
    setIsPaused(false)

    let items: BatchItem[]
    if (retryItems && retryItems.length > 0) {
      // Only resets the status of the incoming item
      items = retryItems.map((it) => ({ ...it, status: 'pending' as BatchItemStatus, error: undefined, retryCount: 0 }))
      // Merge back into full list, keeping other successful items visible
      const ids = new Set(items.map((i) => i.id))
      setBatchItems((prev) => [
        ...prev.filter((it) => !ids.has(it.id)),
        ...items
      ])
      // Statistics in retry mode only reset the failure count
      setBatchFail(0)
      setBatchDone((prev) => Math.max(0, prev - items.length))
    } else {
      setBatchDone(0)
      setBatchSuccess(0)
      setBatchFail(0)
      items = Array.from({ length: batchCount }, (_, i) => ({
        id: crypto.randomUUID(),
        index: i + 1,
        status: 'pending' as BatchItemStatus,
        email: '',
        retryCount: 0
      }))
      setBatchItems(items)
    }

    const concurrency = Math.max(1, batchConcurrency)
    const totalCount = items.length

    // initialization Outlook Single row pool (avoid Concurrent preemption)—— only if outlook / mixed Enabled and filled in outlookData
    const needsOutlook = mode === 'outlook' || (mode === 'mixed' && mixedEnabledSources.includes('outlook'))
    if (needsOutlook && outlookData.trim()) {
      const lines = outlookData.split('\n').map((s) => s.trim()).filter((s) => s.includes('----'))
      // Fisher-Yates shuffle
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[lines[i], lines[j]] = [lines[j], lines[i]]
      }
      outlookPoolRef.current = lines
      if (lines.length < totalCount) {
        addLog(`[Outlook] Warning: Mailbox pools are only ${lines.length} individual, this batch ${totalCount} tasks, the remaining parts will be randomly reused (possible number collision)`)
      } else {
        addLog(`[Outlook] Mailbox pool is ready (${lines.length} indivual,shuffle post allocation)`)
      }
    } else {
      outlookPoolRef.current = []
    }

    setPhase('running')

    // Initialize the speed limiter (if enabled)
    if (rateLimitEnabled) {
      const cfg = {
        maxPerMinute,
        burst: burstSize,
        backoffBaseMs: backoffBaseSec * 1000,
        backoffMaxMs: backoffMaxSec * 1000,
        consecutiveFailureThreshold: autoBackoff ? 5 : 999999  // Turn off automatic backoff when disabled by large threshold
      }
      if (!rateLimiterRef.current) {
        rateLimiterRef.current = createRateLimiter(cfg)
      } else {
        rateLimiterRef.current.updateConfig(cfg)
        rateLimiterRef.current.reset()
      }
      addLog(`[RateLimit] Enabled:${maxPerMinute}/minute burst=${burstSize} retreat ${backoffBaseSec}~${backoffMaxSec}s, automatic retreat:${autoBackoff ? 'open' : 'close'}`)
    } else {
      rateLimiterRef.current = null
    }

    // Create task entries in Task Center
    const taskCenter = useTaskStore.getState()
    const taskCenterId = taskCenter.createTask({
      kind: 'register-batch',
      title: retryItems ? `Try again ${totalCount} failed tasks` : `Batch registration ${totalCount} accounts`,
      subtitle: `${mode === 'outlook' ? 'Outlook' : mode === 'tempmail' ? 'TempMail.Plus' : mode === 'proton' ? 'Proton' : mode === 'gptmail' ? 'GPTmail' : mode === 'mixed' ? 'Mixed' : 'Manual'},concurrent ${concurrency}${proxyPoolConfig.enabled ? ' + proxy pool' : ''}${rateLimitEnabled ? ` + ${maxPerMinute}/minute` : ''}`,
      total: totalCount,
      onPause: () => {
        batchPause.current = true
        setIsPaused(true)
        useTaskStore.getState().updateTask(taskCenterId, { status: 'paused' })
      },
      onResume: () => {
        batchPause.current = false
        setIsPaused(false)
        useTaskStore.getState().updateTask(taskCenterId, { status: 'running' })
      },
      onCancel: () => {
        batchAbort.current = true
        window.api.registrationCancel()
      }
    })
    currentTaskCenterId.current = taskCenterId

    // Concurrency pool execution
    const executing = new Set<Promise<void>>()
    let launched = 0

    for (let i = 0; i < items.length; i++) {
      if (batchAbort.current) {
        addLog(t('register.batchStopped').replace('{done}', String(launched)).replace('{total}', String(totalCount)))
        break
      }

      // Pause: Waiting to resume
      while (batchPause.current && !batchAbort.current) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (batchAbort.current) break

      // Rate limit: waiting for token (including backoff)
      if (rateLimiterRef.current) {
        await rateLimiterRef.current.waitForSlot({ get aborted() { return batchAbort.current } })
        if (batchAbort.current) break
      }

      const itemId = items[i].id
      const taskId = `batch-${itemId.slice(0, 8)}`
      taskIdToItemId.current.set(taskId, itemId)
      addLog(`--- Batch ${i + 1}/${totalCount} ---`)
      launched++

      const task = (async () => {
        const outcome = await runSingleWithRetry(itemId, taskId, batchRetries)
        taskIdToItemId.current.delete(taskId)
        await handleBatchOutcome(itemId, outcome)
        // Report rate limiter results (used for dynamic backoff + Risk control judgment)
        if (rateLimiterRef.current) {
          rateLimiterRef.current.reportResult(outcome.success)
        }
        // Report progress to task center
        useTaskStore.getState().updateTask(taskCenterId, {
          done: _batchDone,
          successCount: _batchSuccess,
          failedCount: _batchFail,
          progress: Math.round((_batchDone / totalCount) * 100)
        })
      })()

      const tracked = task.finally(() => executing.delete(tracked))
      executing.add(tracked)

      // Control the number of concurrencies: wait for vacancies when the pool is full
      if (executing.size >= concurrency) {
        await Promise.race(executing)
      }

      // The waiting interval after each start of the task (0 then do not wait)
      if (i < items.length - 1 && !batchAbort.current && batchInterval > 0) {
        await new Promise((r) => setTimeout(r, batchInterval * 1000))
      }
    }

    // Wait for all executing tasks to complete
    await Promise.all(executing)

    setBatchRunning(false)
    setIsPaused(false)
    setPhase('idle')
    addLog(t('register.batchCompleted'))

    // Complete Mission Center entry
    useTaskStore.getState().completeTask(taskCenterId, {
      successCount: _batchSuccess,
      failedCount: _batchFail
    })
    currentTaskCenterId.current = null

    // trigger Webhook notify
    void useWebhookStore.getState().triggerEvent('batch-completed', {
      title: `Batch registration${retryItems ? 'Try again' : ''}Finish`,
      message: `common ${totalCount} mission, success ${_batchSuccess},fail ${_batchFail}`,
      level: _batchFail === 0 ? 'success' : (_batchSuccess === 0 ? 'error' : 'warn'),
      fields: {
        model: mode === 'outlook' ? 'Outlook' : mode === 'tempmail' ? 'TempMail.Plus' : mode === 'proton' ? 'Proton' : mode === 'gptmail' ? 'GPTmail' : mode === 'mixed' ? 'Mixed' : 'Manual',
        concurrent: concurrency,
        success: _batchSuccess,
        fail: _batchFail,
        total: totalCount
      }
    })
  }

  /** pause / Resume batch registration */
  const togglePauseBatch = (): void => {
    if (!batchRunning) return
    if (batchPause.current) {
      batchPause.current = false
      setIsPaused(false)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'running' })
      }
    } else {
      batchPause.current = true
      setIsPaused(true)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
      }
    }
  }

  const stopBatch = (): void => {
    batchAbort.current = true
    // At the same time, cancel the pause to avoid the main loop in the paused state. / Retry loop stuck at while wait
    batchPause.current = false
    setIsPaused(false)
    addLog(isEn ? '[Batch] Stopping, aborting in-flight requests...' : '[Batch] Stopping, request in transit aborted...')
    // Cancel all registrations in progress on the backend (interrupt the currently running registrationStartAuto）
    window.api.registrationCancel()
    if (currentTaskCenterId.current) {
      useTaskStore.getState().cancelTask(currentTaskCenterId.current)
      currentTaskCenterId.current = null
    }
  }

  /** Retry by filter from failed list */
  const retryFailed = (filter?: 'network' | 'otp_timeout' | 'rate_limit' | 'all'): void => {
    const failedItems = _batchItems.filter((it) => {
      if (it.status !== 'failed' && it.status !== 'import_failed') return false
      if (!filter || filter === 'all') return true
      return classifyError(it.error) === filter
    })
    if (failedItems.length === 0) {
      addLog(`[Retry] There are no matching failed tasks to retry`)
      return
    }
    addLog(`[Retry] Try again ${failedItems.length} failed tasks (filter: ${filter || 'all'}）`)
    void startBatch(failedItems)
  }

  // Import accounts from history
  const importHistoryItem = async (item: HistoryItem): Promise<void> => {
    if (!item.result || item.result.status !== 'success' || !item.result.refreshToken) return
    const r = item.result

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: r.refreshToken!,
        clientId: r.clientId!,
        clientSecret: r.clientSecret!,
        region: r.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600000
        const usage = verifyResult.data.usage
          ? { ...verifyResult.data.usage, percentUsed: verifyResult.data.usage.limit > 0 ? Math.round((verifyResult.data.usage.current / verifyResult.data.usage.limit) * 100) : 0, lastUpdated: now }
          : defaultUsage

        addAccount({
          email: verifyResult.data.email || r.email,
          idp: 'BuilderId', status: 'active',
          credentials: { refreshToken: r.refreshToken!, clientId: r.clientId!, clientSecret: r.clientSecret!, accessToken: verifyResult.data.accessToken || r.accessToken || '', csrfToken: '', region: r.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt },
          subscription: { type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free', title: verifyResult.data.subscriptionTitle || 'Free Tier' },
          usage, tags: [], lastUsedAt: now
        })
      } else {
        addAccount({
          email: r.email, idp: 'BuilderId', status: 'active',
          credentials: { refreshToken: r.refreshToken!, clientId: r.clientId!, clientSecret: r.clientSecret!, accessToken: r.accessToken || '', csrfToken: '', region: r.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt: now + 3600000 },
          subscription: { type: 'Free', title: 'Free Tier' }, usage: defaultUsage, tags: [], lastUsedAt: now
        })
      }

      setHistory((prev) => prev.map((h) => h.id === item.id ? { ...h, imported: true } : h))
    } catch { /* ignore */ }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary/10">
            <UserPlus className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{t('register.title')}</h1>
            <p className="text-sm text-muted-foreground">{isEn ? 'Register new Kiro accounts automatically or manually' : 'Register new ones automatically or manually Kiro account'}</p>
          </div>
        </div>
      </div>

      {/* Mode selection + Configuration */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            {t('register.mode')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
            {([
              ['manual', t('register.manual')],
              ['outlook', 'Outlook'],
              ['tempmail', t('register.tempmail')],
              ['proton', 'Proton'],
              ['gptmail', 'GPTmail'],
              ['mixed', isEn ? 'Mixed' : 'mix']
            ] as [RegMode, string][]).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isRunning || batchRunning}
                className={cn(
                  'px-4 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50',
                  mode === m
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>


          {/* Automatic import switch */}
          <div className="flex items-center gap-3">
            <Switch
              checked={batchAutoImport}
              onCheckedChange={setBatchAutoImport}
              disabled={isRunning || batchRunning}
            />
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{t('register.batchAutoImport')}</span>
              <span className="text-xs text-muted-foreground">— {t('register.batchAutoImportDesc')}</span>
            </div>
          </div>

          {/* Get automatically Pro Subscribe link switch + Plan selection */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <Switch
                checked={autoFetchProLink}
                onCheckedChange={setAutoFetchProLink}
                disabled={isRunning || batchRunning}
              />
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t('register.autoFetchProLink')}</span>
                <span className="text-xs text-muted-foreground">— {t('register.autoFetchProLinkDesc')}</span>
              </div>
            </div>

            {/* Plan type selection (only displayed when the switch is on)*/}
            {autoFetchProLink && (
              <div className="ml-11 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{isEn ? 'Plan:' : 'plan:'}</span>
                {([
                  { value: 'Q_DEVELOPER_STANDALONE_PRO' as ProPlanType, label: 'Pro', color: 'bg-blue-500' },
                  { value: 'Q_DEVELOPER_STANDALONE_PRO_PLUS' as ProPlanType, label: 'Pro+', color: 'bg-purple-500' },
                  { value: 'Q_DEVELOPER_STANDALONE_POWER' as ProPlanType, label: 'Power', color: 'bg-amber-500' }
                ]).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setProPlanType(opt.value)}
                    disabled={isRunning || batchRunning}
                    className={`px-3 h-7 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 border ${
                      proPlanType === opt.value
                        ? `${opt.color} text-white border-transparent shadow-sm`
                        : 'bg-background border-border text-muted-foreground hover:text-foreground hover:border-primary/40'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {proPlanType === opt.value && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    {opt.label}
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground ml-1 italic">
                  {isEn ? '(Plan ID will be sent to Kiro API)' : '(plan ID will be sent as a subscription type)'}
                </span>
              </div>
            )}
          </div>

          {/* Outlook Configuration (standalone mode or Blending mode is enabled outlook displayed) */}
          {(mode === 'outlook' || (mode === 'mixed' && mixedEnabledSources.includes('outlook'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-1.5">
              <Label>{t('register.outlookAccounts')} ({t('register.outlookFormat')})</Label>
              <textarea
                value={outlookData}
                onChange={(e) => setOutlookData(e.target.value)}
                placeholder={t('register.outlookPlaceholder')}
                rows={3}
                disabled={isRunning || batchRunning}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono disabled:opacity-50 resize-none"
              />
            </div>
          )}

          {/* Mixed mode configuration: Check the subsources to participate in polling + weight */}
          {mode === 'mixed' && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-3">
              <Label>{isEn ? 'Enabled email sources (Weighted Round-Robin)' : 'Enabled mailbox sources (weighted polling)'}</Label>
              <div className="space-y-2">
                {(['outlook', 'tempmail', 'proton', 'gptmail'] as AutoEmailSource[]).map((src) => {
                  const enabled = mixedEnabledSources.includes(src)
                  const label = src === 'outlook' ? 'Outlook' : src === 'tempmail' ? 'TempMail.Plus' : src === 'proton' ? 'Proton' : 'GPTmail'
                  const configured = src === 'outlook' ? !!outlookData.trim()
                    : src === 'proton' ? !!protonBaseEmail.trim()
                    : src === 'gptmail' ? !!gptMailDomain.trim()
                    : !!(tempMailDomain.trim() && tempMailEmail.trim() && tempMailEpin.trim())
                  return (
                    <div key={src} className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setMixedEnabledSources((prev) =>
                            enabled ? prev.filter((s) => s !== src) : [...prev, src]
                          )
                        }}
                        disabled={isRunning || batchRunning}
                        className={cn(
                          'flex-1 px-3 py-2 rounded-md border text-sm transition-colors flex items-center gap-2',
                          enabled
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-border hover:border-primary/50',
                          !configured && 'opacity-60'
                        )}
                        title={!configured ? 'The source has not been configured and will be skipped' : ''}
                      >
                        {enabled
                          ? <CheckCircle2 className="h-4 w-4" />
                          : <Square className="h-4 w-4" />
                        }
                        {label}
                        {!configured && <span className="text-[10px] text-amber-500 ml-auto">{isEn ? 'not configured' : 'Not configured'}</span>}
                      </button>
                      {enabled && configured && (
                        <div className="flex items-center gap-1 text-xs">
                          <span className="text-muted-foreground">{isEn ? 'Weight:' : 'weight:'}</span>
                          <Input
                            type="number" min={0} max={100}
                            value={mixedWeights[src] || 0}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10)
                              if (!isNaN(v) && v >= 0) {
                                setMixedWeights((prev) => ({ ...prev, [src]: v }))
                              }
                            }}
                            disabled={isRunning || batchRunning}
                            className="h-8 w-16 text-xs text-center"
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Smooth Weighted Round-Robin: e.g. moemail=4 + tempmail=1 means 80% / 20%. Set 0 to disable.'
                  : 'Smooth weighted polling: e.g. moemail=4 + tempmail=1 express 80% / 20%. The weight is 0 It means not participating.'
                }
              </p>
              {mixedEnabledSources.length === 0 && (
                <p className="text-xs text-amber-500">
                  {isEn ? 'Please enable at least one source.' : 'Please enable at least one source'}
                </p>
              )}
            </div>
          )}

          {/* TempMail.Plus Configuration (standalone mode or Blending mode is enabled tempmail displayed) */}
          {(mode === 'tempmail' || (mode === 'mixed' && mixedEnabledSources.includes('tempmail'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailDomain')}</Label>
                  <Input
                    value={tempMailDomain}
                    onChange={(e) => setTempMailDomain(e.target.value)}
                    placeholder="example.com  domain2.com  domain3.com"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                  {tempMailDomain.trim() && (() => {
                    const list = tempMailDomain.split(/[\s,;]+/).filter(Boolean)
                    return list.length > 1
                      ? <p className="text-[11px] text-muted-foreground">Domain name pool {list.length} Randomly select one for each account to reduce single domain name association</p>
                      : <p className="text-[11px] text-muted-foreground">Fill in multiple domain names (spaces/comma separated) to enable domain name rotation</p>
                  })()}
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEmail')}</Label>
                  <Input
                    value={tempMailEmail}
                    onChange={(e) => setTempMailEmail(e.target.value)}
                    placeholder={t('register.tempMailEmailPlaceholder')}
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEpin')}</Label>
                  <Input
                    type="password"
                    value={tempMailEpin}
                    onChange={(e) => setTempMailEpin(e.target.value)}
                    disabled={isRunning || batchRunning}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('register.tempMailDesc')}</p>
            </div>
          )}

          {/* Proton Configuration (standalone mode or Blending mode is enabled proton displayed) */}
          {(mode === 'proton' || (mode === 'mixed' && mixedEnabledSources.includes('proton'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-3">
              <div className="space-y-1.5">
                <Label>{isEn ? 'Proton base email (dot-alias parent)' : 'Proton Mother mailbox (dot number alias mother number)'}</Label>
                <Input
                  type="email"
                  value={protonBaseEmail}
                  onChange={(e) => setProtonBaseEmail(e.target.value)}
                  placeholder="evanbartellchae@protonmail.com"
                  disabled={isRunning || batchRunning}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                {protonBaseEmail.trim() && (() => {
                  const split = splitEmail(protonBaseEmail.trim())
                  if (!split) return <p className="text-[11px] text-destructive">{isEn ? 'Invalid email' : 'Email format is invalid'}</p>
                  const localLen = split[0].replace(/\./g, '').length
                  const capacity = totalVariantCount(localLen, 5)
                  return <p className="text-[11px] text-muted-foreground">{isEn ? `Auto-generates dot-variants of the local part, ~${capacity.toLocaleString()} available` : `Automatically generate dotted variant of username, approx. ${capacity.toLocaleString()} available`}</p>
                })()}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={protonChecking}
                  onClick={async () => {
                    setProtonChecking(true)
                    try {
                      const r = await window.api.protonOpenLogin()
                      setProtonLoggedIn(r.loggedIn)
                      addLog(r.loggedIn
                        ? (isEn ? '[Proton] Already logged in' : '[Proton] Logged in')
                        : (isEn ? '[Proton] Please complete login in the popup window' : '[Proton] Please complete the login in the pop-up window'))
                    } catch (err) {
                      addLog(`[Proton] ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setProtonChecking(false)
                    }
                  }}
                  className="px-3 py-1.5 rounded-md border border-primary bg-primary/10 text-primary text-sm font-medium transition-colors hover:bg-primary/20 disabled:opacity-50"
                >
                  {protonChecking ? (isEn ? 'Opening...' : 'Opening...') : (isEn ? 'Login Proton' : 'Log in Proton')}
                </button>
                <button
                  type="button"
                  disabled={protonChecking}
                  onClick={async () => {
                    setProtonChecking(true)
                    try {
                      const r = await window.api.protonLoginStatus()
                      setProtonLoggedIn(r.loggedIn)
                      addLog(r.loggedIn ? (isEn ? '[Proton] Logged in' : '[Proton] Login status is valid') : (isEn ? '[Proton] Not logged in' : '[Proton] Not logged in'))
                    } finally {
                      setProtonChecking(false)
                    }
                  }}
                  className="px-3 py-1.5 rounded-md border border-border text-sm transition-colors hover:border-primary/50 disabled:opacity-50"
                >
                  {isEn ? 'Check status' : 'Check login status'}
                </button>
                <span className={cn('text-xs', protonLoggedIn ? 'text-green-500' : 'text-muted-foreground')}>
                  {protonLoggedIn ? (isEn ? '● Logged in' : '● Logged in') : (isEn ? '○ Not logged in' : '○ Not logged in')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {isEn
                  ? 'Reads codes via the official Proton web page (login once, session persists). Each account uses a dot-variant of the base email (e.g. evanbar.tellcha.e@), all landing in the same inbox. Recommended concurrency: 1.'
                  : 'Backdoor Proton Get the code from the official website (log in once, session persistence). Each account uses a dotted variant of the parent email address (e.g. evanbar.tellcha.e@), all into the same inbox. It is recommended that the concurrency be set to 1。'}
              </p>
            </div>
          )}

          {/* GPTmail Configuration (standalone mode or Blending mode is enabled gptmail displayed)
              Two modes are supported:
                A. Direct delivery of private domain names (leave the receiving email address blank)—— MX parse directly to GPTmail, no need CF
                B. CF Forward (fill in the receiving email address)—— and TempMail.Plus Same gameplay */}
          {(mode === 'gptmail' || (mode === 'mixed' && mixedEnabledSources.includes('gptmail'))) && (() => {
            const isPrivateMode = !gptMailInboxEmail.trim()
            return (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              {/* Mode status label */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{isEn ? 'Current mode:' : 'Current mode:'}</span>
                <span className={cn(
                  'px-2 py-0.5 rounded-full font-medium',
                  isPrivateMode ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-600'
                )}>
                  {isPrivateMode
                    ? (isEn ? 'A · Private direct (MX → GPTmail)' : 'A · Private domain name direct collection (MX → GPTmail）')
                    : (isEn ? 'B · CF Email Routing forward' : 'B · CF Email Routing Forward')}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{isEn ? 'Your domain pool' : 'Self-built domain name pool'} <span className="text-destructive">*</span></Label>
                  <Input
                    value={gptMailDomain}
                    onChange={(e) => setGptMailDomain(e.target.value)}
                    placeholder="example.com  domain2.com"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                  {gptMailDomain.trim() && (() => {
                    const list = gptMailDomain.split(/[\s,;]+/).filter(Boolean)
                    return list.length > 1
                      ? <p className="text-[11px] text-muted-foreground">{isEn ? `Domain pool: ${list.length}, randomized per account` : `Domain name pool ${list.length} , randomly select one for each account (reduce association)`}</p>
                      : <p className="text-[11px] text-muted-foreground">{isEn ? 'Multiple domains (space/comma separated) enable rotation' : 'Fill in multiple domain names (spaces/comma separated) to enable domain name rotation'}</p>
                  })()}
                </div>

                <div className="space-y-1.5">
                  <Label>{isEn ? 'GPTmail inbox (optional, for CF forwarding)' : 'GPTmail Receiving email (optional,CF For forwarding)'}</Label>
                  <Input
                    type="email"
                    value={gptMailInboxEmail}
                    onChange={(e) => setGptMailInboxEmail(e.target.value)}
                    placeholder={isEn ? 'leave empty for private direct' : 'Leave blank = Direct transfer of private domain names'}
                    disabled={isRunning || batchRunning}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {isEn
                      ? 'Empty: register prefix@yourdomain directly as the inbox (MX must point to GPTmail). Filled: CF Email Routing forwards *@yourdomain to this inbox.'
                      : 'Leave blank:prefix@yourdomain itself inbox(domain name MX must be parsed to GPTmail). Filled out:CF Email Routing Bundle *@yourdomain Forward to this email.'}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>{isEn ? 'Private domain password (optional)' : 'Private domain name password (optional)'}</Label>
                  <Input
                    type="password"
                    value={gptMailPrivatePassword}
                    onChange={(e) => setGptMailPrivatePassword(e.target.value)}
                    placeholder={isEn ? 'only for private domains with password' : 'only in GPTmail Fill in the private password when setting it'}
                    disabled={isRunning || batchRunning}
                    autoComplete="off"
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {isEn
                      ? 'If you added your domain as "Private" on GPTmail, fill the password here. Auto-unlocks the inbox before polling.'
                      : 'if you are GPTmail Add domain name as"private domain name"And set a password, fill it in here. Will be automatically unlocked before polling inbox。'}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>{isEn ? 'Fixed prefix (optional)' : 'Fixed prefix (optional)'}</Label>
                  <Input
                    value={gptMailPrefix}
                    onChange={(e) => setGptMailPrefix(e.target.value)}
                    placeholder={isEn ? 'leave empty for random' : 'Leave blank to automatically generate a random prefix'}
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>{isEn ? 'Custom Base URL (optional)' : 'Customize BaseURL(optional)'}</Label>
                  <Input
                    value={gptMailBaseURL}
                    onChange={(e) => setGptMailBaseURL(e.target.value)}
                    placeholder="https://mail.chatgpt.org.uk"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">{isEn ? 'Defaults to https://mail.chatgpt.org.uk; change for self-hosted' : 'default https://mail.chatgpt.org.uk, private deployment can be modified'}</p>
                </div>
              </div>

              {/* Mode description */}
              <div className="p-2.5 bg-background/60 rounded border-l-2 border-primary/60 text-xs leading-relaxed text-muted-foreground space-y-1">
                {isPrivateMode ? (
                  <>
                    <p className="font-medium text-foreground">{isEn ? 'Mode A · Private direct (recommended):' : 'model A · Private domain name direct payment (recommended):'}</p>
                    <ol className="list-decimal pl-5 space-y-0.5">
                      <li>{isEn ? 'Add your domain on mail.chatgpt.org.uk (it gives you MX records)' : 'exist mail.chatgpt.org.uk add private/Public domain name (the page will give MX Parsing records)'}</li>
                      <li>{isEn ? 'Point your domain MX to GPTmail at your DNS provider' : 'exist DNS Provider takes your domain name MX point to GPTmail'}</li>
                      <li>{isEn ? 'Each registration uses prefix@yourdomain as both register email and inbox' : 'For each registration prefix@your domain name As the registered email address (also inbox）'}</li>
                      <li>{isEn ? 'GPTmail receives directly, we poll the API and extract the code' : 'GPTmail receive mail directly → We poll API Extract verification code'}</li>
                    </ol>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-foreground">{isEn ? 'Mode B · Cloudflare Email Routing forward:' : 'model B · Cloudflare Email Routing Forward:'}</p>
                    <ol className="list-decimal pl-5 space-y-0.5">
                      <li>{isEn ? 'Register a receiving inbox on mail.chatgpt.org.uk (e.g. abc@msn-mail-free-9224.dynv6.net)' : 'exist mail.chatgpt.org.uk Register a receiving email (such as abc@msn-mail-free-9224.dynv6.net）'}</li>
                      <li>{isEn ? 'In Cloudflare Email Routing, set catch-all *@yourdomain → that inbox' : 'exist Cloudflare Email Routing Bundle *@your domain name catch-all Forward to this email'}</li>
                      <li>{isEn ? 'Each registration uses prefix@yourdomain' : 'For each registration prefix@your domain name'}</li>
                      <li>{isEn ? 'AWS sends OTP → CF forwards to GPTmail → we poll GPTmail API and extract the code' : 'AWS Send verification code → CF forward to GPTmail → We poll GPTmail API Extract verification code'}</li>
                    </ol>
                  </>
                )}
              </div>
            </div>
            )
          })()}
        </CardContent>
      </Card>

      {/* Manual mode parent mailbox input + Anonymous mailbox switch (only phase=idle） */}
      {mode === 'manual' && phase === 'idle' && !batchRunning && (
        <Card className="hover-lift">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AtSign className="h-4 w-4 text-primary" />
              {t('register.parentEmailSection')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="parentEmail" className="text-xs">{t('register.parentEmailLabel')}</Label>
                <Input
                  id="parentEmail"
                  type="email"
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                  placeholder={t('register.parentEmailPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[11px] text-muted-foreground leading-snug">{t('register.parentEmailHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fullNameIdle" className="text-xs">{t('register.fullNameRandom')}</Label>
                <Input
                  id="fullNameIdle"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('register.fullNamePlaceholder')}
                />
              </div>
            </div>

            <div className="flex items-start gap-3 pt-1">
              <Switch
                id="anonymousEmail"
                checked={anonymousEmail}
                onCheckedChange={setAnonymousEmail}
              />
              <div className="flex-1 space-y-0.5">
                <Label htmlFor="anonymousEmail" className="cursor-pointer text-sm flex items-center gap-1.5">
                  <Shuffle className="h-3.5 w-3.5 text-primary" />
                  {t('register.anonymousEmailLabel')}
                </Label>
                <p className="text-[11px] text-muted-foreground leading-snug">{t('register.anonymousEmailHint')}</p>
              </div>
            </div>

            {/* preview panel */}
            {anonymousEmail && (
              <div className="text-xs">
                {anonymousPreview?.error === 'empty' && (
                  <div className="flex items-center gap-1.5 text-warning">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousNoParent')}</span>
                  </div>
                )}
                {anonymousPreview?.error === 'invalid' && (
                  <div className="flex items-center gap-1.5 text-destructive">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousInvalid')}</span>
                  </div>
                )}
                {anonymousPreview && !anonymousPreview.error && anonymousPreview.variant && (
                  <div className="bg-primary/[0.06] border border-primary/20 rounded-md p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="text-muted-foreground flex items-center gap-1"><Shuffle className="h-3 w-3" /> {t('register.nextVariant')}:</span>
                      <code className="bg-background px-2 py-0.5 rounded font-mono text-foreground border">
                        {anonymousPreview.variant}
                      </code>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
                      <span>{t('register.dotCount')}: <strong className="text-foreground">{anonymousPreview.dotCount}</strong></span>
                      <span>{t('register.sameRoot')}: <strong className="text-foreground">{anonymousPreview.sameRootCount}</strong> / ~{anonymousPreview.totalCapacity}</span>
                    </div>
                  </div>
                )}
                {anonymousPreview && !anonymousPreview.error && !anonymousPreview.variant && (
                  <div className="flex items-center gap-1.5 text-warning">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousExhausted')}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Manual mode progress step bar (dynamic steps:6-8 step, enabled according to the switch Import / ProLink） */}
      {mode === 'manual' && phase !== 'idle' && (
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between">
            {manualSteps.map((step, i) => {
              const isLast = i === manualSteps.length - 1
              const isDone = i < currentStep
              const isCurrent = i === currentStep
              // Differentiate core steps vs Post-processing steps (in different colors)
              const isExtra = step === 'Import' || step === 'ProLink'
              return (
                <div key={step} className={cn('flex items-center', isLast ? '' : 'flex-1 min-w-0')}>
                  <div
                    className={cn(
                      'flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all flex-shrink-0',
                      isDone && (isExtra
                        ? 'bg-cyan-500 text-white shadow-sm shadow-cyan-500/30'
                        : 'bg-green-500 text-white shadow-sm shadow-green-500/30'),
                      isCurrent && 'bg-primary text-primary-foreground animate-pulse shadow-sm shadow-primary/30',
                      !isDone && !isCurrent && 'bg-muted text-muted-foreground'
                    )}
                  >
                    {isDone ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <span
                    className={cn(
                      'ml-1.5 text-xs font-medium whitespace-nowrap',
                      (isDone || isCurrent) ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {step}
                  </span>
                  {!isLast && (
                    <div
                      className={cn(
                        'flex-1 h-0.5 mx-2 transition-colors',
                        isDone
                          ? (isExtra ? 'bg-cyan-500' : 'bg-green-500')
                          : 'bg-muted'
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* operating area */}
      <Card className="hover-lift">
        <CardContent className="pt-5 space-y-4">
          {/* manual mode email/otp enter */}
          {mode === 'manual' && phase === 'email' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.emailLabel')}</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('register.emailPlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('register.fullNameRandom')}</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('register.fullNamePlaceholder')}
                />
              </div>
              <Button onClick={submitEmail} size="sm">
                <Mail className="h-4 w-4 mr-2" />
                {t('register.submitEmail')}
              </Button>
            </div>
          )}

          {mode === 'manual' && phase === 'otp' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.otpLabel')}</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="font-mono text-lg tracking-widest"
                  onKeyDown={(e) => e.key === 'Enter' && submitOTP()}
                />
                <p className="text-xs text-muted-foreground">
                  {t('register.otpSentTo')} {email}
                </p>
              </div>
              <Button onClick={submitOTP} size="sm">
                <Key className="h-4 w-4 mr-2" />
                {t('register.submitOtp')}
              </Button>
            </div>
          )}

          {/* button */}
          <div className="flex gap-3">
            {phase === 'idle' && !batchRunning && (
              <Button
                onClick={mode === 'manual' ? startManual : startAuto}
                disabled={
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' && (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'gptmail' && !gptMailDomain.trim()) ||
                  (mode === 'proton' && !protonBaseEmail.trim()) ||
                  (mode === 'mixed' && pickNextSource() == null)
                }
              >
                <Play className="h-4 w-4 mr-2" />
                {t('register.startRegistration')}
              </Button>
            )}

            {(isRunning || batchRunning || phase === 'email' || phase === 'otp') && (
              <Button variant="destructive" onClick={batchRunning ? stopBatch : cancel}>
                <Square className="h-4 w-4 mr-2" />
                {t('register.cancel')}
              </Button>
            )}

            {(phase === 'done' || phase === 'finalized') && !batchRunning && (
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="h-4 w-4 mr-2" />
                {t('register.newRegistration')}
              </Button>
            )}
          </div>

          {isRunning && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {t('register.processing')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Log (followed by"Start registration"Cards make it easier to observe progress and are no longer placed at the bottom of the page) */}
      {logs.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{t('register.log')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { _logs = []; setLogs([]) }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div ref={logContainerRef} className="h-48 overflow-y-auto p-3 font-mono text-xs space-y-0.5 bg-muted/20">
              {logs.map((line, i) => (
                <div key={i} className="text-muted-foreground leading-relaxed">{line}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Batch registration (Non-manual mode) */}
      {mode !== 'manual' && (
        <Card className="hover-lift">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" />
              {t('register.batchTitle')}
            </CardTitle>
            {/* Policy template */}
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTemplatesMenu(!showTemplatesMenu)}
                disabled={batchRunning}
              >
                <Settings2 className="h-4 w-4 mr-1" />
                {isEn ? 'Templates' : 'template'} ({templates.length})
              </Button>
              {showTemplatesMenu && (
                <div className="absolute right-0 top-full mt-2 z-50 min-w-[280px] max-h-[400px] overflow-y-auto bg-popover border rounded-lg shadow-lg p-2">
                  <div className="flex items-center justify-between mb-2 px-2">
                    <span className="text-xs font-medium uppercase text-muted-foreground">{isEn ? 'Strategy Templates' : 'Policy template'}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={saveCurrentAsTemplate} className="h-7 text-xs">
                        <Download className="h-3 w-3 mr-1" />
                        {isEn ? 'Save current' : 'save current'}
                      </Button>
                      {/* C8: import/Export */}
                      <button
                        type="button"
                        onClick={() => {
                          const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `kiro-register-templates-${new Date().toISOString().slice(0, 10)}.json`
                          a.click()
                          setTimeout(() => URL.revokeObjectURL(url), 1000)
                        }}
                        title={isEn ? 'Export all templates' : 'Export all templates'}
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                      <label className="p-1 rounded hover:bg-muted text-muted-foreground cursor-pointer" title={isEn ? 'Import templates' : 'Import template'}>
                        <input
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            try {
                              const text = await file.text()
                              const arr = JSON.parse(text) as RegisterTemplate[]
                              if (!Array.isArray(arr)) throw new Error('Invalid file format')
                              const merged = [...arr, ...templates]
                              // according to ID Remove duplicates, new files first
                              const seen = new Set<string>()
                              const dedup: RegisterTemplate[] = []
                              for (const t of merged) {
                                if (seen.has(t.id)) continue
                                seen.add(t.id)
                                dedup.push(t)
                              }
                              setTemplates(dedup)
                              saveTemplates(dedup)
                              addLog(`[Template] Imported ${arr.length} templates`)
                            } catch (err) {
                              alert(`Import failed:${err instanceof Error ? err.message : String(err)}`)
                            }
                            e.currentTarget.value = ''
                          }}
                        />
                        <Upload className="h-3 w-3" />
                      </label>
                    </div>
                  </div>
                  <div className="border-t mb-1" />
                  {templates.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {isEn ? 'No templates yet. Click "Save current" to save the current config as a template.' : 'There is no template yet. Click "Save Current" to save the current configuration as a template.'}
                    </div>
                  ) : (
                    templates.map((tpl) => (
                      <div
                        key={tpl.id}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted rounded transition-colors"
                      >
                        <button
                          onClick={() => applyTemplate(tpl)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="text-sm truncate">{tpl.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {tpl.config.mode} · {isEn ? 'count' : 'batch'} {tpl.config.batchCount} · {isEn ? 'conc.' : 'concurrent'} {tpl.config.batchConcurrency}
                          </div>
                        </button>
                        <button
                          onClick={() => removeTemplate(tpl.id)}
                          className="p-1 rounded hover:bg-destructive/10 text-destructive"
                          title={isEn ? 'Delete' : 'delete'}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Configuration line */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchCount')}</Label>
                <Input
                  type="number" min={1} max={100}
                  value={batchCount}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setBatchCount(v) }}
                  onBlur={() => { if (batchCount < 1) setBatchCount(1) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchInterval')}</Label>
                <Input
                  type="number" min={0} max={300}
                  value={batchInterval}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0) setBatchInterval(v) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchRetries')}</Label>
                <Input
                  type="number" min={0} max={10}
                  value={batchRetries}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0) setBatchRetries(v) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchConcurrency')}</Label>
                <Input
                  type="number" min={1} max={100}
                  value={batchConcurrency}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setBatchConcurrency(v) }}
                  onBlur={() => { if (batchConcurrency < 1) setBatchConcurrency(1) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <Button
                variant={batchRunning ? 'destructive' : 'default'}
                onClick={batchRunning ? stopBatch : () => void startBatch()}
                disabled={
                  (!batchRunning && isRunning) ||
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' && (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'gptmail' && !gptMailDomain.trim()) ||
                  (mode === 'proton' && !protonBaseEmail.trim()) ||
                  (mode === 'mixed' && pickNextSource() == null)
                }
              >
                {batchRunning ? <><Square className="h-4 w-4 mr-2" />{t('register.batchStop')}</> : <><Play className="h-4 w-4 mr-2" />{t('register.batchStart')}</>}
              </Button>
              {batchRunning && (
                <Button variant="outline" onClick={togglePauseBatch} title={isPaused ? 'recover' : 'pause'}>
                  {isPaused ? <><Play className="h-4 w-4 mr-2" />{isEn ? 'Resume' : 'recover'}</> : <><Pause className="h-4 w-4 mr-2" />{isEn ? 'Pause' : 'pause'}</>}
                </Button>
              )}
            </div>

            {/* scheduled tasks + daily quota */}
            <div className="flex items-center gap-4 flex-wrap p-3 rounded-lg bg-muted/30 border border-dashed">
              <div className="flex items-center gap-2">
                <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} disabled={batchRunning} />
                <Label className="text-sm cursor-pointer flex items-center gap-1.5">
                  <CalendarClock className="h-4 w-4 text-primary" />
                  Scheduled start
                </Label>
              </div>
              {scheduleEnabled && (
                <>
                  <div className="flex items-center gap-1.5 text-xs">
                    <Input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      disabled={batchRunning}
                      className="h-8 w-28 text-xs"
                    />
                  </div>
                  {/* C6: Week selection */}
                  <div className="flex items-center gap-1 text-xs">
                    {(isEn ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['day', 'one', 'two', 'three', 'Four', 'five', 'six']).map((label, i) => {
                      const checked = !!(scheduleWeekMask & (1 << i))
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setScheduleWeekMask(scheduleWeekMask ^ (1 << i))}
                          disabled={batchRunning}
                          className={cn(
                            'w-7 h-7 rounded text-[10px] border transition-colors',
                            checked
                              ? 'border-primary bg-primary/10 text-primary font-medium'
                              : 'border-border text-muted-foreground hover:border-primary/50'
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => setScheduleWeekMask(scheduleWeekMask === 127 ? 0b0111110 : 127)}
                      disabled={batchRunning}
                      className="text-[10px] text-primary hover:underline ml-1"
                      title={isEn ? 'Toggle: all / weekdays only' : 'Toggle: select all / Working days only'}
                    >
                      {scheduleWeekMask === 127 ? (isEn ? 'Weekdays' : 'working days') : (isEn ? 'Daily' : 'every day')}
                    </button>
                  </div>
                </>
              )}
              <div className="w-px h-6 bg-border" />
              <div className="flex items-center gap-1.5 text-xs">
                <Timer className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">{isEn ? 'Daily quota:' : 'daily quota:'}</span>
                <Input
                  type="number" min={0} max={9999}
                  value={dailyQuotaLimit}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) setDailyQuotaLimit(v) }}
                  disabled={batchRunning}
                  className="h-8 w-20 text-xs text-center"
                />
                <span className="text-muted-foreground">{isEn ? '/day' : 'indivual/sky'}</span>
                {dailyQuotaLimit > 0 && (
                  <>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        dailyQuotaUsed >= dailyQuotaLimit
                          ? 'text-red-600 border-red-200'
                          : dailyQuotaUsed >= dailyQuotaLimit * 0.8
                            ? 'text-amber-600 border-amber-200'
                            : 'text-muted-foreground'
                      )}
                    >
                      {isEn ? 'Today' : 'today'}: {dailyQuotaUsed} / {dailyQuotaLimit}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(isEn ? `Reset today's used quota (currently ${dailyQuotaUsed})?` : `Reset today's used quota (currently ${dailyQuotaUsed}）？`)) {
                          setDailyQuotaUsedState(0)
                          try { localStorage.setItem(dailyQuotaKey, '0') } catch { /* ignore */ }
                          addLog(isEn ? "[Quota] Today's quota counter reset" : "[Quota] Today's quota count has been reset")
                        }
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      title={isEn ? "Manually reset today's used quota" : 'Manually reset today’s used quota'}
                    >
                      {isEn ? 'Reset' : 'reset'}
                    </button>
                  </>
                )}
                {dailyQuotaLimit === 0 && (
                  <span className="text-[10px] text-muted-foreground italic">{isEn ? '(0 = unlimited)' : '（0 = no limit)'}</span>
                )}
              </div>
            </div>

            {/* speed limit + Backoff configuration */}
            <div className="flex items-center gap-4 flex-wrap p-3 rounded-lg bg-muted/30 border border-dashed">
              <div className="flex items-center gap-2">
                <Switch checked={rateLimitEnabled} onCheckedChange={setRateLimitEnabled} disabled={batchRunning} />
                <Label className="text-sm cursor-pointer flex items-center gap-1.5">
                  <Gauge className="h-4 w-4 text-primary" />
                  {isEn ? 'Rate limit' : 'speed limit'}
                </Label>
              </div>
              {rateLimitEnabled && (
                <>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{isEn ? 'Max launch rate:' : 'maximum boot rate:'}</span>
                    <Input
                      type="number" min={1} max={300}
                      value={maxPerMinute}
                      onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setMaxPerMinute(v) }}
                      disabled={batchRunning}
                      className="w-20 h-8 text-xs text-center"
                    />
                    <span className="text-muted-foreground">{isEn ? '/ min' : '/ minute'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={autoBackoff} onCheckedChange={setAutoBackoff} disabled={batchRunning} />
                    <Label className="text-xs cursor-pointer">
                      {isEn ? 'Auto backoff on consecutive failures (exponential)' : 'Automatic backoff on consecutive failures (exponential)'}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={autoPauseOnRisk} onCheckedChange={setAutoPauseOnRisk} disabled={batchRunning} />
                    <Label className="text-xs cursor-pointer flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3 text-amber-500" />
                      {isEn ? 'Auto pause on risk control' : 'Risk control triggers automatic suspension'}
                    </Label>
                  </div>
                  {/* C3: Advanced configuration */}
                  <div className="w-full flex items-center gap-3 text-xs flex-wrap pt-2 border-t border-dashed">
                    <span className="text-muted-foreground">{isEn ? 'Advanced:' : 'advanced:'}</span>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Burst cap' : 'Burst upper limit'}</span>
                      <Input
                        type="number" min={1} max={100}
                        value={burstSize}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBurstSize(v) }}
                        disabled={batchRunning}
                        className="w-16 h-7 text-xs text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Backoff start' : 'Backoff start'}</span>
                      <Input
                        type="number" min={1} max={300}
                        value={backoffBaseSec}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBackoffBaseSec(v) }}
                        disabled={batchRunning}
                        className="w-16 h-7 text-xs text-center"
                      />
                      <span className="text-muted-foreground">{isEn ? 'sec' : 'Second'}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Backoff cap' : 'Backoff upper limit'}</span>
                      <Input
                        type="number" min={1} max={3600}
                        value={backoffMaxSec}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBackoffMaxSec(v) }}
                        disabled={batchRunning}
                        className="w-20 h-7 text-xs text-center"
                      />
                      <span className="text-muted-foreground">{isEn ? 'sec' : 'Second'}</span>
                    </div>
                  </div>
                </>
              )}
              {!rateLimitEnabled && (
                <span className="text-xs text-muted-foreground">
                  {isEn
                    ? 'When enabled, a token bucket paces launches and auto-extends intervals on consecutive failures to avoid risk control.'
                    : 'After being enabled, the token bucket will be used to control the startup rhythm, and the interval will be automatically extended when consecutive failures occur to prevent risk control.'}
                </span>
              )}
            </div>

            {/* Running: real-time rate + Risk control signal */}
            {batchRunning && rateSnapshot && (
              <div className={cn(
                'p-3 rounded-lg border space-y-2 transition-colors',
                rateSnapshot.riskWarning
                  ? 'bg-red-50 dark:bg-red-950/20 border-red-300 dark:border-red-800'
                  : (rateSnapshot.backoffRemainingMs > 0
                    ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-300 dark:border-amber-800'
                    : 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800')
              )}>
                <div className="flex items-center gap-2">
                  {rateSnapshot.riskWarning ? (
                    <>
                      <ShieldAlert className="h-4 w-4 text-red-500 animate-pulse" />
                      <span className="text-sm font-medium text-red-600 dark:text-red-400">
                        {isEn ? 'Risk warning: success rate too low' : 'Risk control warning: success rate is too low'} ({Math.round(rateSnapshot.successRate * 100)}%)
                      </span>
                    </>
                  ) : rateSnapshot.backoffRemainingMs > 0 ? (
                    <>
                      <Clock className="h-4 w-4 text-amber-500" />
                      <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
                        {isEn ? `Backing off: resuming in ${Math.ceil(rateSnapshot.backoffRemainingMs / 1000)}s` : `Retreating: Waiting ${Math.ceil(rateSnapshot.backoffRemainingMs / 1000)}s After recovery`}
                      </span>
                    </>
                  ) : (
                    <>
                      <Activity className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-medium text-blue-600 dark:text-blue-400">{isEn ? 'Running' : 'Running'}</span>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Throughput:' : 'Hesitation:'}</span>
                    <span className="font-mono tabular-nums">{rateSnapshot.throughputPerMinute}/min</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Success rate:' : 'success rate:'}</span>
                    <span className={cn(
                      'font-mono tabular-nums font-medium',
                      rateSnapshot.successRate >= 0.8 ? 'text-green-600' :
                      rateSnapshot.successRate >= 0.5 ? 'text-amber-600' : 'text-red-600'
                    )}>{Math.round(rateSnapshot.successRate * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Window:' : 'window:'}</span>
                    <span className="font-mono tabular-nums">
                      <span className="text-green-600">✓{rateSnapshot.windowSuccess}</span>
                      <span className="text-muted-foreground mx-0.5">/</span>
                      <span className="text-red-500">✗{rateSnapshot.windowFailed}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Consec. fails:' : 'consecutive failures:'}</span>
                    <span className={cn(
                      'font-mono tabular-nums',
                      rateSnapshot.consecutiveFailures >= 3 ? 'text-red-600 font-medium' : ''
                    )}>{rateSnapshot.consecutiveFailures}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Failed retry panel (only displayed on failure) */}
            {!batchRunning && batchFail > 0 && batchItems.some(it => it.status === 'failed' || it.status === 'import_failed') && (() => {
              // Bucket by error type
              const buckets: Record<string, number> = { network: 0, otp_timeout: 0, email_used: 0, rate_limit: 0, risk_control: 0, auth: 0, unknown: 0 }
              for (const it of batchItems) {
                if (it.status !== 'failed' && it.status !== 'import_failed') continue
                const k = classifyError(it.error)
                buckets[k] = (buckets[k] || 0) + 1
              }
              const labels: Record<string, string> = isEn ? {
                network: 'Network error',
                otp_timeout: 'OTP timeout',
                email_used: 'Email in use',
                rate_limit: 'Rate limited',
                risk_control: 'AWS risk control',
                auth: 'Auth error',
                unknown: 'Other/Unknown'
              } : {
                network: 'network error',
                otp_timeout: 'Verification code timeout',
                email_used: 'Email is occupied',
                rate_limit: 'Current limiting',
                risk_control: 'AWS Risk control',
                auth: 'Authentication error',
                unknown: 'other/unknown'
              }
              return (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-medium">{isEn ? `${batchFail} tasks failed` : `${batchFail} tasks failed`}</span>
                    <Button size="sm" variant="default" className="ml-auto" onClick={() => retryFailed('all')}>
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                      {isEn ? 'Retry all' : 'Retry all'}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(buckets).filter(([, c]) => c > 0).map(([k, c]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => retryFailed(k as 'network' | 'otp_timeout' | 'rate_limit' | 'all')}
                        className="px-2 py-0.5 rounded text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                        title={isEn ? 'Click to retry this category' : 'Click Retry This class failed'}
                      >
                        {labels[k]} ({c})
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* schedule + Each status */}
            {(batchRunning || batchDone > 0) && (
              <div className="space-y-3">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium">{t('register.batchProgress')}: {batchDone}/{batchCount}</span>
                  <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30">{t('register.batchSuccess')}: {batchSuccess}</Badge>
                  <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30">{t('register.batchFail')}: {batchFail}</Badge>
                </div>
                <Progress value={batchCount > 0 ? (batchDone / batchCount) * 100 : 0} className="h-2" />

                {/* List of each status */}
                {batchItems.length > 0 && (
                  <div className="max-h-60 overflow-y-auto border rounded-lg bg-muted/20">
                    {batchItems.map((item) => <BatchItemRow key={item.id} item={item} t={t} batchClock={batchClock} />)}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* result */}
      {result && (
        <Card className={cn('border shadow-sm',
          result.status === 'success' ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
        )}>
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-2">
              {result.status === 'success' ? (
                <div className="p-1.5 rounded-full bg-green-100 dark:bg-green-900/50">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
              ) : (
                <div className="p-1.5 rounded-full bg-red-100 dark:bg-red-900/50">
                  <XCircle className="h-5 w-5 text-red-600" />
                </div>
              )}
              <h3 className="text-lg font-semibold">
                {result.status === 'success' ? t('register.success') : t('register.failed')}
              </h3>
            </div>

            {result.status === 'success' && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm p-3 bg-background/50 rounded-lg">
                  <div><span className="text-muted-foreground">{t('register.emailField')}</span> <span className="font-mono font-medium">{result.email}</span></div>
                  <div><span className="text-muted-foreground">{t('register.passwordField')}</span> <span className="font-mono font-medium">{result.password}</span></div>
                </div>
                <Button
                  onClick={importAccount}
                  disabled={imported}
                  variant={imported ? 'outline' : 'default'}
                  className={imported ? 'text-green-600 border-green-300' : ''}
                  size="sm"
                >
                  {imported ? (
                    <><CheckCircle2 className="h-4 w-4 mr-2" />{t('register.imported')}</>
                  ) : (
                    <><UserPlus className="h-4 w-4 mr-2" />{t('register.importToManager')}</>
                  )}
                </Button>
              </>
            )}

            {result.status === 'failed' && (
              <p className="text-sm text-red-600 dark:text-red-400">{result.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Registration result analysis report (visual upgraded version) */}
      {history.length >= 5 && <RegisterAnalyticsReport history={history} />}

      {/* Occupied mailbox blacklist management */}
      <EmailBlacklistManager />

      {/* Registration history */}
      {history.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                {t('register.historyTitle')} ({history.length})
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setHistory([])}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('register.historyClear')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-48 overflow-y-auto">
              {history.map((item) => {
                const fp = item.result?.fingerprint
                return (
                  <div key={item.id} className="flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {item.status === 'success' ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" /> : <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                      <span className="font-mono text-xs truncate">{item.email}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">{new Date(item.time).toLocaleTimeString()}</span>
                      {/* Fingerprint summary badge (B7） */}
                      {fp && (
                        <span
                          className="text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0 cursor-help"
                          title={`Chrome ${fp.chromeVer}\nUA: ${fp.ua}\nGPU: ${fp.gpuVendor} ${fp.gpuModel}\nCanvas: ${fp.canvasHash}\nScreen: ${fp.screen.width}x${fp.screen.height}\nProxy: ${fp.proxyUrl || '(direct)'}\nExit IP: ${fp.exitIP || 'N/A'}`}
                        >
                          🔒 {fp.chromeVer.split('.')[0]}・{fp.screen.width}×{fp.screen.height}{fp.exitIP ? `・${fp.exitIP}` : ''}
                        </span>
                      )}
                    </div>
                    {item.status === 'success' && item.result?.refreshToken && (
                      <Badge
                        variant="outline"
                        className={cn('cursor-pointer text-xs', item.imported ? 'text-green-600 border-green-200' : 'text-primary border-primary/30 hover:bg-primary/10')}
                        onClick={() => !item.imported && importHistoryItem(item)}
                      >
                        {item.imported ? t('register.imported') : t('register.historyImport')}
                      </Badge>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

    </div>
  )
}

// ============ Registration result analysis report (visual upgraded version) ============

interface RegisterAnalyticsProps {
  history: HistoryItem[]
}

function RegisterAnalyticsReport({ history }: RegisterAnalyticsProps): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const analytics = useMemo(() => {
    const total = history.length
    let success = 0, failed = 0
    const byMode: Record<string, { success: number; failed: number }> = {}
    const byHour: Record<number, { success: number; failed: number }> = {}
    const byDay: Record<string, { success: number; failed: number }> = {}  // 7 daily trend
    const errorBuckets: Record<string, number> = {}

    const now = Date.now()
    // prepare recently 7 bucket of days (including today)
    const sevenDays: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 86400000)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      sevenDays.push(key)
      byDay[key] = { success: 0, failed: 0 }
    }

    for (const h of history) {
      if (h.status === 'success') success++; else failed++
      const m = (h.result as { provider?: string } | undefined)?.provider || 'BuilderId'
      if (!byMode[m]) byMode[m] = { success: 0, failed: 0 }
      if (h.status === 'success') byMode[m].success++; else byMode[m].failed++
      const dt = new Date(h.time)
      const hr = dt.getHours()
      if (!byHour[hr]) byHour[hr] = { success: 0, failed: 0 }
      if (h.status === 'success') byHour[hr].success++; else byHour[hr].failed++
      // Daily barrel (7 within days)
      const dayKey = `${dt.getMonth() + 1}/${dt.getDate()}`
      if (byDay[dayKey]) {
        if (h.status === 'success') byDay[dayKey].success++; else byDay[dayKey].failed++
      }
      if (h.status === 'failed') {
        const cat = classifyError(h.error)
        errorBuckets[cat] = (errorBuckets[cat] || 0) + 1
      }
    }
    const successRate = total > 0 ? success / total : 0
    const peakHours = Object.entries(byHour)
      .filter(([, v]) => v.success + v.failed >= 2)  // At least 2 samples
      .sort((a, b) => {
        const ar = a[1].success / (a[1].success + a[1].failed)
        const br = b[1].success / (b[1].success + b[1].failed)
        return br - ar
      })
      .slice(0, 3)
    const topErrors = Object.entries(errorBuckets).sort((a, b) => b[1] - a[1])

    return { total, success, failed, successRate, byMode, byHour, byDay, sevenDays, peakHours, topErrors }
  }, [history])

  const handleExportCSV = useCallback((): void => {
    const lines = ['time,email,status,error,password']
    for (const h of history) {
      const csvEsc = (v: string | undefined): string => {
        if (!v) return ''
        const escaped = v.replace(/"/g, '""')
        return /[,"\n]/.test(escaped) ? `"${escaped}"` : escaped
      }
      lines.push([
        new Date(h.time).toISOString(),
        csvEsc(h.email),
        h.status,
        csvEsc(h.error),
        csvEsc(h.password)
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `register-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [history])

  const errorLabels: Record<string, { label: string; color: string }> = {
    network: { label: isEn ? 'Network error' : 'network error', color: 'bg-blue-500' },
    otp_timeout: { label: isEn ? 'OTP timeout' : 'Verification code timeout', color: 'bg-amber-500' },
    email_used: { label: isEn ? 'Email in use' : 'Email is occupied', color: 'bg-slate-500' },
    rate_limit: { label: isEn ? 'Rate limited' : 'Current limiting', color: 'bg-orange-500' },
    risk_control: { label: isEn ? 'AWS risk control' : 'AWS Risk control', color: 'bg-red-500' },
    auth: { label: isEn ? 'Auth error' : 'Authentication error', color: 'bg-purple-500' },
    unknown: { label: isEn ? 'Other/Unknown' : 'other/unknown', color: 'bg-gray-500' }
  }

  const successColor = analytics.successRate >= 0.85 ? '#22c55e'
    : analytics.successRate >= 0.6 ? '#f59e0b' : '#ef4444'

  // SVG Donut chart parameters
  const ringRadius = 36
  const ringStroke = 8
  const ringCircum = 2 * Math.PI * ringRadius
  const ringOffset = ringCircum * (1 - analytics.successRate)

  return (
    <Card className="hover-lift overflow-hidden">
      <CardHeader className="pb-2 bg-gradient-to-br from-primary/5 to-transparent">
        <CardTitle className="text-sm flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <span>{isEn ? 'Registration Analytics' : 'Registration result analysis report'}</span>
          <Badge variant="outline" className="text-[10px] ml-auto">
            {isEn ? 'Samples' : 'sample'} {analytics.total}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] -mr-1"
            onClick={handleExportCSV}
          >
            <Download className="h-3 w-3 mr-1" />
            CSV
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {/* Top: donut chart + key indicators */}
        <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 items-center">
          {/* donut chart */}
          <div className="relative flex items-center justify-center">
            <svg width="120" height="120" viewBox="0 0 100 100">
              {/* Bottom circle */}
              <circle
                cx="50" cy="50" r={ringRadius}
                fill="none"
                stroke="currentColor"
                strokeWidth={ringStroke}
                opacity="0.1"
              />
              {/* success rate circle */}
              <circle
                cx="50" cy="50" r={ringRadius}
                fill="none"
                stroke={successColor}
                strokeWidth={ringStroke}
                strokeLinecap="round"
                strokeDasharray={ringCircum}
                strokeDashoffset={ringOffset}
                transform="rotate(-90 50 50)"
                className="transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-2xl font-bold tabular-nums" style={{ color: successColor }}>
                {Math.round(analytics.successRate * 100)}%
              </div>
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Success rate' : 'success rate'}</div>
            </div>
          </div>

          {/* key indicators */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{isEn ? 'Success' : 'success'}</span>
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              </div>
              <div className="text-xl font-bold tabular-nums text-green-600 mt-0.5">{analytics.success}</div>
            </div>
            <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{isEn ? 'Failed' : 'fail'}</span>
                <XCircle className="h-3 w-3 text-red-500" />
              </div>
              <div className="text-xl font-bold tabular-nums text-red-600 mt-0.5">{analytics.failed}</div>
            </div>
            <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 col-span-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {isEn ? 'Top 3 success hours' : 'High success rate period TOP3'}
                </span>
              </div>
              {analytics.peakHours.length === 0 ? (
                <p className="text-xs text-muted-foreground">{isEn ? 'Not enough data' : 'Insufficient sample'}</p>
              ) : (
                <div className="flex gap-2">
                  {analytics.peakHours.map(([h, v]) => {
                    const sr = Math.round(v.success / (v.success + v.failed) * 100)
                    return (
                      <div key={h} className="flex-1 text-center">
                        <div className="text-sm font-bold font-mono">{h.padStart(2, '0')}:00</div>
                        <div className="text-[10px] text-green-600 font-mono">{sr}%</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 24 Hourly distribution (SVG smooth curve + gradient fill) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">{isEn ? '24-hour distribution' : '24 Hourly distribution'}</span>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" /> {isEn ? 'Success' : 'success'}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500" /> {isEn ? 'Failed' : 'fail'}
              </span>
            </div>
          </div>
          <HourDistributionChart byHour={analytics.byHour} />
        </div>

        {/* 7 daily trend */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">{isEn ? '7-day trend' : '7 daily trend'}</span>
            <span className="text-[10px] text-muted-foreground">{isEn ? 'Registrations' : 'Number of registrations'}</span>
          </div>
          <SevenDayChart sevenDays={analytics.sevenDays} byDay={analytics.byDay} />
        </div>

        {/* Failure reason distribution (refined version) */}
        {analytics.topErrors.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">{isEn ? 'Failure reasons' : 'Failure reason distribution'}</span>
              <span className="text-[10px] text-muted-foreground">{isEn ? `${analytics.failed} failures total` : `common ${analytics.failed} failed`}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {analytics.topErrors.map(([cat, count]) => {
                const meta = errorLabels[cat] || { label: cat, color: 'bg-gray-500' }
                const pct = Math.round((count / analytics.failed) * 100)
                return (
                  <div key={cat} className="p-2 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={cn('w-2 h-2 rounded-full', meta.color)} />
                      <span className="text-xs font-medium flex-1 truncate">{meta.label}</span>
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">{count}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full transition-all', meta.color)} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground tabular-nums mt-0.5">{pct}%</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Comparison of login methods */}
        {Object.keys(analytics.byMode).length > 1 && (
          <div>
            <div className="text-xs font-medium mb-2">{isEn ? 'Mode comparison' : 'Comparison of login methods'}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {Object.entries(analytics.byMode).map(([m, v]) => {
                const tot = v.success + v.failed
                const sr = tot > 0 ? Math.round(v.success / tot * 100) : 0
                const srColor = sr >= 80 ? 'text-green-600' : sr >= 50 ? 'text-amber-600' : 'text-red-600'
                const srBg = sr >= 80 ? 'bg-green-500' : sr >= 50 ? 'bg-amber-500' : 'bg-red-500'
                return (
                  <div key={m} className="p-3 rounded-lg border bg-card">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium">{m}</span>
                      <span className={cn('text-xs font-mono tabular-nums font-bold', srColor)}>{sr}%</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full', srBg)} style={{ width: `${sr}%` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      ✓{v.success} / ✗{v.failed} ({isEn ? 'total' : 'common'} {tot})
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 24 Hourly distribution SVG graph (smooth curve + gradient fill) */
function HourDistributionChart({ byHour }: { byHour: Record<number, { success: number; failed: number }> }): React.ReactNode {
  const width = 720, height = 100, padTop = 8, padBottom = 18, padX = 12
  const innerH = height - padTop - padBottom
  const stepX = (width - padX * 2) / 23  // 24 point

  // Calculate the maximum value
  let maxVal = 0
  for (let h = 0; h < 24; h++) {
    const v = byHour[h] || { success: 0, failed: 0 }
    maxVal = Math.max(maxVal, v.success + v.failed)
  }
  if (maxVal === 0) maxVal = 1

  const pointAt = (h: number, count: number): [number, number] => {
    const x = padX + h * stepX
    const y = padTop + innerH - (count / maxVal) * innerH
    return [x, y]
  }

  // Generate two smooth paths
  const buildPath = (key: 'success' | 'failed'): { line: string; area: string } => {
    const points: [number, number][] = []
    for (let h = 0; h < 24; h++) {
      const v = byHour[h] || { success: 0, failed: 0 }
      points.push(pointAt(h, v[key]))
    }
    // smooth curve (Catmull-Rom change Bezier）
    let line = `M${points[0][0]},${points[0][1]}`
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? i : i - 1]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6
      line += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`
    }
    // Close the lower area
    const area = line + ` L${padX + 23 * stepX},${padTop + innerH} L${padX},${padTop + innerH} Z`
    return { line, area }
  }

  const succ = buildPath('success')
  const fail = buildPath('failed')

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id="succGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(34 197 94)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="failGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(239 68 68)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="rgb(239 68 68)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* grid */}
      {[0.25, 0.5, 0.75].map((p) => (
        <line
          key={p}
          x1={padX} x2={width - padX}
          y1={padTop + innerH * p} y2={padTop + innerH * p}
          stroke="currentColor" strokeOpacity="0.06" strokeDasharray="2,3"
        />
      ))}

      {/* Failure areas and lines */}
      <path d={fail.area} fill="url(#failGradient)" />
      <path d={fail.line} fill="none" stroke="rgb(239 68 68)" strokeWidth="1.5" opacity="0.8" />

      {/* Success areas and lines */}
      <path d={succ.area} fill="url(#succGradient)" />
      <path d={succ.line} fill="none" stroke="rgb(34 197 94)" strokeWidth="2" />

      {/* data points */}
      {Array.from({ length: 24 }).map((_, h) => {
        const v = byHour[h] || { success: 0, failed: 0 }
        if (v.success === 0 && v.failed === 0) return null
        return (
          <g key={h}>
            {v.success > 0 && (() => {
              const [x, y] = pointAt(h, v.success)
              return <circle cx={x} cy={y} r="2.5" fill="rgb(34 197 94)" />
            })()}
            {v.failed > 0 && (() => {
              const [x, y] = pointAt(h, v.failed)
              return <circle cx={x} cy={y} r="2" fill="rgb(239 68 68)" />
            })()}
          </g>
        )
      })}

      {/* X axis scale */}
      {[0, 6, 12, 18, 23].map((h) => {
        const x = padX + h * stepX
        return (
          <g key={h}>
            <line x1={x} x2={x} y1={padTop + innerH} y2={padTop + innerH + 3} stroke="currentColor" opacity="0.3" />
            <text x={x} y={height - 4} fontSize="9" fill="currentColor" opacity="0.5" textAnchor="middle">
              {h.toString().padStart(2, '0')}:00
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 7 Daily trend histogram (overlay + gradient) */
function SevenDayChart({ sevenDays, byDay }: {
  sevenDays: string[]
  byDay: Record<string, { success: number; failed: number }>
}): React.ReactNode {
  const width = 720, height = 80, padTop = 8, padBottom = 18, padX = 16
  const innerH = height - padTop - padBottom
  const barW = (width - padX * 2) / sevenDays.length * 0.6
  const gap = (width - padX * 2) / sevenDays.length

  let maxTotal = 0
  for (const k of sevenDays) {
    const v = byDay[k] || { success: 0, failed: 0 }
    maxTotal = Math.max(maxTotal, v.success + v.failed)
  }
  if (maxTotal === 0) maxTotal = 1

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id="barSuccGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(34 197 94)" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="barFailGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(239 68 68)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(239 68 68)" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      {/* grid */}
      {[0.5].map((p) => (
        <line
          key={p}
          x1={padX} x2={width - padX}
          y1={padTop + innerH * p} y2={padTop + innerH * p}
          stroke="currentColor" strokeOpacity="0.06" strokeDasharray="2,3"
        />
      ))}

      {sevenDays.map((day, i) => {
        const v = byDay[day] || { success: 0, failed: 0 }
        const total = v.success + v.failed
        const totalH = (total / maxTotal) * innerH
        const succH = total > 0 ? (v.success / total) * totalH : 0
        const failH = total > 0 ? (v.failed / total) * totalH : 0
        const x = padX + i * gap + (gap - barW) / 2
        const yBase = padTop + innerH

        return (
          <g key={day}>
            {/* Failure (above) */}
            {v.failed > 0 && (
              <rect
                x={x} y={yBase - totalH}
                width={barW} height={failH}
                fill="url(#barFailGrad)"
                rx="2"
              />
            )}
            {/* Success (below) */}
            {v.success > 0 && (
              <rect
                x={x} y={yBase - succH}
                width={barW} height={succH}
                fill="url(#barSuccGrad)"
                rx="2"
              />
            )}
            {/* total label */}
            {total > 0 && (
              <text
                x={x + barW / 2}
                y={yBase - totalH - 3}
                fontSize="9"
                fill="currentColor"
                opacity="0.6"
                textAnchor="middle"
              >
                {total}
              </text>
            )}
            {/* X axis labels */}
            <text
              x={x + barW / 2}
              y={height - 4}
              fontSize="10"
              fill="currentColor"
              opacity={i === sevenDays.length - 1 ? 1 : 0.5}
              fontWeight={i === sevenDays.length - 1 ? 'bold' : 'normal'}
              textAnchor="middle"
            >
              {day}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Occupied mailbox blacklist management (A5 edge repair)
 * Users can view / search / Delete a single / Clear the mailboxes in the blacklist
 */
function EmailBlacklistManager(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<string[]>(() => Array.from(loadEmailBlacklist()))
  const [filter, setFilter] = useState('')

  const refresh = useCallback((): void => {
    setItems(Array.from(loadEmailBlacklist()))
  }, [])

  const removeOne = useCallback((email: string): void => {
    const set = loadEmailBlacklist()
    set.delete(email.toLowerCase())
    saveEmailBlacklist(set)
    refresh()
  }, [refresh])

  const clearAll = useCallback((): void => {
    if (!confirm(isEn ? `Clear all ${items.length} emails from blacklist?` : `Confirm to clear the blacklist ${items.length} Email?`)) return
    clearEmailBlacklist()
    refresh()
  }, [items.length, refresh, isEn])

  const filtered = useMemo(() => {
    if (!filter.trim()) return items
    const q = filter.toLowerCase()
    return items.filter((e) => e.includes(q))
  }, [items, filter])

  if (items.length === 0 && !expanded) return null

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => { setExpanded(!expanded); if (!expanded) refresh() }}
          className="w-full flex items-center justify-between"
        >
          <CardTitle className="text-sm flex items-center gap-2">
            <XCircle className="h-4 w-4 text-amber-500" />
            {isEn ? 'Used-email blacklist' : 'Occupy mailbox blacklist'}
            <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground">{expanded ? (isEn ? '▼ Collapse' : '▼ close') : (isEn ? '▶ Expand' : '▶ Expand')}</span>
        </button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={isEn ? 'Search email...' : 'Search mailbox...'}
              className="h-8 text-xs max-w-xs"
            />
            <Button size="sm" variant="ghost" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> {isEn ? 'Refresh' : 'refresh'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={clearAll}
              disabled={items.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> {isEn ? 'Clear all' : 'Clear all'}
            </Button>
          </div>

          {items.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {isEn ? 'Blacklist is empty' : 'Blacklist is empty'}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {isEn ? 'No matches' : 'No match'}
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto border rounded">
              {filtered.map((email) => (
                <div
                  key={email}
                  className="flex items-center justify-between gap-2 px-2 py-1 border-b last:border-b-0 hover:bg-muted/40 text-xs"
                >
                  <span className="font-mono truncate flex-1" title={email}>{email}</span>
                  <button
                    onClick={() => removeOne(email)}
                    className="p-1 rounded hover:bg-destructive/10 text-destructive"
                    title={isEn ? 'Remove from blacklist' : 'Remove from blacklist'}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            The blacklist is based on "email_used” errors are added automatically. The added email addresses will be skipped in subsequent batch registrations.
            if Kiro The expired mailbox is released and can be manually removed here to allow it to participate in registration again.
          </p>
        </CardContent>
      )}
    </Card>
  )
}
