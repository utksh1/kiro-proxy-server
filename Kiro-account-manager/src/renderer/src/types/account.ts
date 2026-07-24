// ============================================
// Multiple account manager type definition
// ============================================

export type IdpType = 'Google' | 'Github' | 'BuilderId' | 'Enterprise' | 'AWSIdC' | 'Internal' | 'IAM_SSO'

export type SubscriptionType = 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'

export type AccountStatus = 'active' | 'expired' | 'error' | 'refreshing' | 'unknown'

/**
 * Account credential information
 */
export interface AccountCredentials {
  accessToken: string
  csrfToken: string
  refreshToken?: string
  clientId?: string      // OIDC client ID(for refreshing token）
  clientSecret?: string  // OIDC client key
  region?: string        // AWS zone, default us-east-1
  startUrl?: string      // SSO Start URL（Enterprise account only)
  expiresAt: number      // Timestamp
  authMethod?: 'IdC' | 'social'  // Authentication method:IdC (BuilderId/Enterprise) or social (GitHub/Google)
  provider?: 'BuilderId' | 'Enterprise' | 'Github' | 'Google' | 'IAM_SSO'  // identity provider
  profileArn?: string    // Enterprise reality profileArn(from ListAvailableProfiles Get)
}

/**
 * Reward amount information
 */
export interface BonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

/**
 * Account usage information
 */
export interface AccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  // Detailed credit breakdown
  baseLimit?: number      // Basic amount
  baseCurrent?: number    // Basic used
  freeTrialLimit?: number // Trial amount
  freeTrialCurrent?: number
  freeTrialExpiry?: string
  bonuses?: BonusUsage[]  // Reward amount list
  nextResetDate?: string  // reset date
  resourceDetail?: ResourceDetail // Resource details
}

/**
 * Account subscription information
 */
export interface AccountSubscription {
  type: SubscriptionType
  title?: string // Original subscription title, such as "KIRO PRO+"
  rawType?: string // The original subscription type, such as "Q_DEVELOPER_STANDALONE_PRO_PLUS"
  expiresAt?: number // Subscription expiration timestamp
  daysRemaining?: number
  upgradeCapability?: string // Upgradeability
  overageCapability?: string // excess capacity
  managementTarget?: string // Subscription management goals
}

/**
 * Resource usage details
 */
export interface ResourceDetail {
  resourceType?: string // CREDIT
  displayName?: string // Credit
  displayNamePlural?: string // Credits
  currency?: string // USD
  unit?: string // INVOCATIONS
  overageRate?: number // 0.04
  overageCap?: number // 10000
  overageEnabled?: boolean
}

/**
 * Account label
 */
export interface AccountTag {
  id: string
  name: string
  color: string // hex color
}

/**
 * Account entity
 */
export interface Account {
  // Basic information
  id: string
  email: string
  password?: string // Registration password (card password export/for import)
  nickname?: string // Custom alias
  idp: IdpType
  userId?: string
  visitorId?: string
  machineId?: string // Device bound to the account ID（64bit hexadecimal)
  profileArn?: string // AWS Profile ARN

  // Certification information
  credentials: AccountCredentials

  // Subscription information
  subscription: AccountSubscription

  // Usage
  usage: AccountUsage

  // Grouping and labeling
  groupId?: string
  tags: string[] // tag ids

  // state
  status: AccountStatus
  lastError?: string
  isActive: boolean // Is it the currently activated account?

  // Timestamp
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number // Last status check time
}

/**
 * Account grouping
 */
export interface AccountGroup {
  id: string
  name: string
  description?: string
  color?: string
  order: number
  createdAt: number
}

/**
 * Filter criteria
 */
export interface AccountFilter {
  search?: string // Search keywords (email/alias)
  subscriptionTypes?: SubscriptionType[]
  statuses?: AccountStatus[]
  idps?: IdpType[]
  groupIds?: string[]
  tagIds?: string[]
  emailDomains?: string[] // Email domain name suffix (@ The following part, lowercase)
  usageMin?: number // Usage percentage
  usageMax?: number
  daysRemainingMin?: number
  daysRemainingMax?: number
  bannedOnly?: boolean // Show only banned accounts
}

/**
 * Sorting options
 */
export type SortField =
  | 'email'
  | 'nickname'
  | 'subscription'
  | 'usage'
  | 'daysRemaining'
  | 'lastUsedAt'
  | 'createdAt'
  | 'status'

export type SortOrder = 'asc' | 'desc'

export interface AccountSort {
  field: SortField
  order: SortOrder
}

/**
 * import/Export format
 */
export interface AccountExportData {
  version: string
  exportedAt: number
  accounts: Omit<Account, 'isActive'>[]
  groups: AccountGroup[]
  tags: AccountTag[]
}

/**
 * Account import items (simplified format)
 */
export interface AccountImportItem {
  email: string
  password?: string
  refreshToken: string
  accessToken?: string
  csrfToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  idp?: IdpType | string
  nickname?: string
  groupId?: string
  tags?: string[]
}

/**
 * Batch operation results
 */
export interface BatchOperationResult {
  success: number
  failed: number
  errors: { id: string; error: string }[]
}

/**
 * Account statistics
 */
export interface AccountStats {
  total: number
  byStatus: Record<AccountStatus, number>
  bySubscription: Record<SubscriptionType, number>
  byIdp: Record<IdpType, number>
  activeCount: number
  expiringSoonCount: number // 7Expires within days
  bannedCount: number // Number of banned accounts
}
