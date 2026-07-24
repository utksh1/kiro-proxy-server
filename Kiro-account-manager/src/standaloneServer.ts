import fs from 'fs'
import path from 'path'
import { ProxyServer } from './main/proxy/proxyServer'
import type { ProxyAccount, ProxyConfig } from './main/proxy/types'

// Load environment variables
const PORT = parseInt(process.env.PORT || '5580', 10)
const HOST = process.env.HOST || '0.0.0.0'
const API_KEY = process.env.PROXY_API_KEY || process.env.API_KEY || ''
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || ''
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(process.cwd(), 'accounts.json')

// Configure proxy server settings
const config: ProxyConfig = {
  enabled: true,
  port: PORT,
  host: HOST,
  enableMultiAccount: true,
  selectedAccountIds: [],
  logRequests: true,
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '10', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  retryDelayMs: 1000,
  tokenRefreshBeforeExpiry: 300,
  clientDrivenToolExecution: true,
  enableTokenBufferReserve: false,
  tokenBufferReserve: 20000,
  allowExternalWithoutApiKey: !API_KEY,
  apiKeys: API_KEY ? [{
    id: 'env-key',
    name: 'Environment Key',
    key: API_KEY,
    format: 'sk',
    enabled: true,
    createdAt: Date.now(),
    usage: {
      totalRequests: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      daily: {}
    }
  }] : []
}

console.log('===================================================')
console.log('🚀 Starting Kiro Proxy Headless Server')
console.log(`Port: ${PORT}`)
console.log(`Host: ${HOST}`)
console.log(`API Key Authentication: ${API_KEY ? 'Enabled' : 'Disabled (No key set)'}`)
console.log('===================================================')

// Instantiate Proxy Server
const server = new ProxyServer(config, {
  onRequest: (info) => {
    console.log(`[Request] ${info.method} ${info.path}`)
  },
  onResponse: (info) => {
    if (info.error) {
      console.error(`[Response] ${info.path} -> Status ${info.status} Error: ${info.error}`)
    } else {
      console.log(`[Response] ${info.path} -> Status ${info.status} (${info.responseTime || 0}ms)`)
    }
  },
  onError: (error) => {
    console.error('[ProxyServer Error]', error)
  },
  onTokenRefresh: async (account) => {
    console.log(`[Token Refresh] Refreshing token for account: ${account.id}`)
    
    // Support AWS Builder ID / IdC token refresh natively
    if (account.refreshToken && account.clientId) {
      try {
        const region = account.region || 'us-east-1'
        const url = `https://oidc.${region}.amazonaws.com/token`
        const body: Record<string, string> = {
          grant_type: 'refresh_token',
          grantType: 'refresh_token',
          client_id: account.clientId,
          clientId: account.clientId,
          refresh_token: account.refreshToken,
          refreshToken: account.refreshToken
        }
        if (account.clientSecret) {
          body.client_secret = account.clientSecret
          body.clientSecret = account.clientSecret
        }
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        
        const data = await response.json() as any
        
        if (response.ok && (data.access_token || data.accessToken)) {
          return {
            success: true,
            accessToken: data.access_token || data.accessToken,
            refreshToken: data.refresh_token || data.refreshToken || account.refreshToken,
            expiresAt: Date.now() + ((data.expires_in || data.expiresIn) * 1000)
          }
        } else {
          return { success: false, error: data.error_description || data.message || 'OIDC refresh failed' }
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }

    return { success: false, error: 'Automatic refresh not configured or missing refresh token / client ID' }
  }
})

// Load accounts
const pool = server.getAccountPool()
let loadedAccountsCount = 0

if (ACCOUNTS_JSON) {
  try {
    let parsed = JSON.parse(ACCOUNTS_JSON) as any
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.accounts)) {
      parsed = parsed.accounts
    }
    const accounts = Array.isArray(parsed) ? parsed : [parsed]
    for (const rawAcc of accounts) {
      // Map GUI Account format to ProxyAccount format if needed
      const credentials = rawAcc.credentials || {}
      const acc = {
        id: rawAcc.id,
        email: rawAcc.email,
        accessToken: credentials.accessToken || rawAcc.accessToken,
        refreshToken: credentials.refreshToken || rawAcc.refreshToken,
        clientId: credentials.clientId || rawAcc.clientId,
        clientSecret: credentials.clientSecret || rawAcc.clientSecret,
        region: credentials.region || rawAcc.region,
        authMethod: credentials.authMethod || rawAcc.authMethod,
        provider: credentials.provider || rawAcc.provider,
        expiresAt: credentials.expiresAt || rawAcc.expiresAt,
        machineId: rawAcc.machineId
      }
      
      if (acc.id && acc.accessToken) {
        pool.addAccount(acc)
        loadedAccountsCount++
      }
    }
    console.log(`[Accounts] Loaded ${loadedAccountsCount} accounts from ACCOUNTS_JSON env variable`)
  } catch (err) {
    console.error('[Accounts] Failed to parse ACCOUNTS_JSON:', err)
  }
}

if (loadedAccountsCount === 0 && fs.existsSync(ACCOUNTS_FILE)) {
  try {
    const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8')
    let parsed = JSON.parse(content) as any
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.accounts)) {
      parsed = parsed.accounts
    }
    const accounts = Array.isArray(parsed) ? parsed : [parsed]
    for (const rawAcc of accounts) {
      // Map GUI Account format to ProxyAccount format if needed
      const credentials = rawAcc.credentials || {}
      const acc = {
        id: rawAcc.id,
        email: rawAcc.email,
        accessToken: credentials.accessToken || rawAcc.accessToken,
        refreshToken: credentials.refreshToken || rawAcc.refreshToken,
        clientId: credentials.clientId || rawAcc.clientId,
        clientSecret: credentials.clientSecret || rawAcc.clientSecret,
        region: credentials.region || rawAcc.region,
        authMethod: credentials.authMethod || rawAcc.authMethod,
        provider: credentials.provider || rawAcc.provider,
        expiresAt: credentials.expiresAt || rawAcc.expiresAt,
        machineId: rawAcc.machineId
      }
      
      if (acc.id && acc.accessToken) {
        pool.addAccount(acc)
        loadedAccountsCount++
      }
    }
    console.log(`[Accounts] Loaded ${loadedAccountsCount} accounts from ${ACCOUNTS_FILE}`)
  } catch (err) {
    console.error(`[Accounts] Failed to read ${ACCOUNTS_FILE}:`, err)
  }
}

if (loadedAccountsCount === 0) {
  console.warn('[Accounts] WARNING: No accounts loaded! Set ACCOUNTS_JSON env or create accounts.json file.')
}

// Start HTTP Proxy Server
server.start().then(() => {
  console.log(`\n✅ Kiro Proxy Headless Server running on http://${HOST}:${PORT}`)
  console.log(`Health check: http://${HOST}:${PORT}/health\n`)
}).catch((err) => {
  console.error('❌ Failed to start Proxy Server:', err)
  process.exit(1)
})

// Handle process signals for graceful shutdown
const shutdown = async () => {
  console.log('\nShutting down Kiro Proxy Server...')
  try {
    await server.stop()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
