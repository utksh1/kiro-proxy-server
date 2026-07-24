import { Pool } from 'pg'
import type { ProxyAccount } from './types'

let pool: Pool | null = null

export async function initDB() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.log('[DB] DATABASE_URL not set, running in memory-only mode.')
    return false
  }
  
  pool = new Pool({
    connectionString,
    // Render typically requires SSL for external connections, but internal might not.
    // It's safe to enable ssl with rejectUnauthorized: false
    ssl: { rejectUnauthorized: false }
  })

  // Create table if not exists
  const query = `
    CREATE TABLE IF NOT EXISTS accounts (
      id VARCHAR PRIMARY KEY,
      email VARCHAR,
      password VARCHAR,
      "machineId" VARCHAR,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "clientId" VARCHAR,
      "clientSecret" VARCHAR,
      region VARCHAR,
      "authMethod" VARCHAR,
      provider VARCHAR,
      "expiresAt" BIGINT,
      status VARCHAR,
      "isAvailable" BOOLEAN,
      "errorCount" INT,
      "lastUsed" BIGINT,
      "cooldownUntil" BIGINT,
      "quotaUsed" FLOAT,
      "quotaLimit" FLOAT,
      "quotaResetAt" BIGINT,
      "quotaExhaustedAt" BIGINT,
      "suspendedAt" BIGINT,
      "suspendReason" VARCHAR,
      "suspendMessage" TEXT
    )
  `
  try {
    await pool.query(query)
    console.log('[DB] PostgreSQL initialized successfully.')
    return true
  } catch (err) {
    console.error('[DB] Failed to initialize PostgreSQL:', err)
    return false
  }
}

export async function getAllAccountsFromDB(): Promise<ProxyAccount[]> {
  if (!pool) return []
  try {
    const res = await pool.query('SELECT * FROM accounts')
    // Parse numeric fields back to numbers, as some drivers return string for bigints
    return res.rows.map(row => ({
      ...row,
      expiresAt: row.expiresAt ? Number(row.expiresAt) : undefined,
      lastUsed: row.lastUsed ? Number(row.lastUsed) : undefined,
      cooldownUntil: row.cooldownUntil ? Number(row.cooldownUntil) : undefined,
      quotaUsed: row.quotaUsed ? Number(row.quotaUsed) : undefined,
      quotaLimit: row.quotaLimit ? Number(row.quotaLimit) : undefined,
      quotaResetAt: row.quotaResetAt ? Number(row.quotaResetAt) : undefined,
      quotaExhaustedAt: row.quotaExhaustedAt ? Number(row.quotaExhaustedAt) : undefined,
      suspendedAt: row.suspendedAt ? Number(row.suspendedAt) : undefined,
    }))
  } catch (err) {
    console.error('[DB] Failed to fetch accounts:', err)
    return []
  }
}

export async function upsertAccountToDB(acc: ProxyAccount): Promise<void> {
  if (!pool) return
  const query = `
    INSERT INTO accounts (
      id, email, password, "machineId", "accessToken", "refreshToken", "clientId", "clientSecret",
      region, "authMethod", provider, "expiresAt", status, "isAvailable", "errorCount", "lastUsed",
      "cooldownUntil", "quotaUsed", "quotaLimit", "quotaResetAt", "quotaExhaustedAt",
      "suspendedAt", "suspendReason", "suspendMessage"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      $22, $23, $24
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      password = EXCLUDED.password,
      "machineId" = EXCLUDED."machineId",
      "accessToken" = EXCLUDED."accessToken",
      "refreshToken" = EXCLUDED."refreshToken",
      "clientId" = EXCLUDED."clientId",
      "clientSecret" = EXCLUDED."clientSecret",
      region = EXCLUDED.region,
      "authMethod" = EXCLUDED."authMethod",
      provider = EXCLUDED.provider,
      "expiresAt" = EXCLUDED."expiresAt",
      status = EXCLUDED.status,
      "isAvailable" = EXCLUDED."isAvailable",
      "errorCount" = EXCLUDED."errorCount",
      "lastUsed" = EXCLUDED."lastUsed",
      "cooldownUntil" = EXCLUDED."cooldownUntil",
      "quotaUsed" = EXCLUDED."quotaUsed",
      "quotaLimit" = EXCLUDED."quotaLimit",
      "quotaResetAt" = EXCLUDED."quotaResetAt",
      "quotaExhaustedAt" = EXCLUDED."quotaExhaustedAt",
      "suspendedAt" = EXCLUDED."suspendedAt",
      "suspendReason" = EXCLUDED."suspendReason",
      "suspendMessage" = EXCLUDED."suspendMessage"
  `
  const values = [
    acc.id, acc.email, acc.password, acc.machineId, acc.accessToken, acc.refreshToken, acc.clientId, acc.clientSecret,
    acc.region, acc.authMethod, acc.provider, acc.expiresAt, acc.status, acc.isAvailable, acc.errorCount, acc.lastUsed,
    acc.cooldownUntil, acc.quotaUsed, acc.quotaLimit, acc.quotaResetAt, acc.quotaExhaustedAt,
    acc.suspendedAt, acc.suspendReason, acc.suspendMessage
  ]
  try {
    await pool.query(query, values)
  } catch (err) {
    console.error(`[DB] Failed to upsert account ${acc.id}:`, err)
  }
}

export async function bulkUpsertAccountsToDB(accounts: ProxyAccount[]): Promise<void> {
  if (!pool || accounts.length === 0) return
  // simple loop, for better performance could use pg-format or multiple values,
  // but this is called on import and avoids dependency on pg-format
  for (const acc of accounts) {
    await upsertAccountToDB(acc)
  }
}

export async function deleteAccountFromDB(id: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query('DELETE FROM accounts WHERE id = $1', [id])
  } catch (err) {
    console.error(`[DB] Failed to delete account ${id}:`, err)
  }
}
