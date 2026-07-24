/**
 * Account view sharing tool — AccountCard / AccountListRow Reuse
 * Guaranteed two views (cards / list) visual system consistent
 */
import type { CSSProperties } from 'react'
import type { Account } from '@/types/account'

// ============ Color analysis ============

// parse ARGB Color converted to CSS rgba(support #AARRGGBB and #RRGGBB）
export function toRgba(argbColor: string): string {
  let alpha = 255
  let rgb = argbColor
  if (argbColor.length === 9 && argbColor.startsWith('#')) {
    alpha = parseInt(argbColor.slice(1, 3), 16)
    rgb = '#' + argbColor.slice(3)
  }
  const hex = rgb.startsWith('#') ? rgb.slice(1) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
}

// ============ tag halo ============

// Generate card version label halo style: single label → box-shadow;Multiple tags → Gradient border
export function generateGlowStyle(tagColors: string[]): CSSProperties {
  if (tagColors.length === 0) return {}
  if (tagColors.length === 1) {
    const color = toRgba(tagColors[0])
    const colorTransparent = color.replace('1)', '0.15)')
    return {
      boxShadow: `0 0 0 1px ${color}, 0 4px 12px -2px ${colorTransparent}`
    }
  }
  const gradientColors = tagColors.map((c, i) => {
    const percent = (i / tagColors.length) * 100
    const nextPercent = ((i + 1) / tagColors.length) * 100
    return `${toRgba(c)} ${percent}%, ${toRgba(c)} ${nextPercent}%`
  }).join(', ')
  return {
    background: `linear-gradient(var(--card-solid), var(--card-solid)) padding-box, linear-gradient(135deg, ${gradientColors}) border-box`,
    border: '1.5px solid transparent',
    boxShadow: '0 4px 12px -2px rgba(0, 0, 0, 0.05)'
  }
}

// List row use: label ribbon — Keep only the left side 3px The ribbon is used for identification, and does not dye the row background to avoid colorful multi-line lists.
export function generateRowGlowStyle(tagColors: string[]): CSSProperties {
  if (tagColors.length === 0) return {}
  if (tagColors.length === 1) {
    return {
      borderLeftColor: toRgba(tagColors[0]),
      borderLeftWidth: '3px'
    }
  }
  // Multi-label: vertical gradient left ribbon (double layer backgroundClip trick, the gradient is only in border-box of 3px area display)
  const gradientStops = tagColors.map((c, i) => {
    const percent = (i / (tagColors.length - 1)) * 100
    return `${toRgba(c)} ${percent}%`
  }).join(', ')
  return {
    borderLeftWidth: '3px',
    borderLeftColor: 'transparent',
    backgroundImage: `linear-gradient(var(--card-solid), var(--card-solid)), linear-gradient(180deg, ${gradientStops})`,
    backgroundOrigin: 'padding-box, border-box',
    backgroundClip: 'padding-box, border-box',
    backgroundRepeat: 'no-repeat'
  }
}

// ============ Ban status style ============

// Card version ban background style (use CSS variable)
export const unauthorizedCardStyle: CSSProperties = {
  backgroundColor: 'var(--card-unauthorized-bg)',
  borderColor: 'var(--card-unauthorized-border)',
  boxShadow: `
    0 0 0 1px var(--card-unauthorized-ring),
    0 4px 12px -2px var(--card-unauthorized-shadow)
  `
}

// List row ban background style (lighter, less eye-catching)
export const unauthorizedRowStyle: CSSProperties = {
  backgroundColor: 'var(--card-unauthorized-bg)',
  borderColor: 'var(--card-unauthorized-border)',
  boxShadow: `0 0 0 1px var(--card-unauthorized-ring)`
}

// ============ Subscribe badge color ============

export function getSubscriptionColor(type: string, title?: string): string {
  const text = (title || type).toUpperCase()
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS')) return 'bg-purple-500'
  if (text.includes('POWER')) return 'bg-amber-500'
  if (text.includes('PRO')) return 'bg-blue-500'
  return 'bg-gray-500'
}

// ============ status text ============

export const StatusLabelsZh: Record<string, string> = {
  active: 'normal',
  expired: 'Expired',
  error: 'mistake',
  refreshing: 'Refreshing',
  unknown: 'unknown'
}

export const StatusLabelsEn: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  error: 'Error',
  refreshing: 'Refreshing',
  unknown: 'Unknown'
}

// status badge Tailwind class
export function getStatusBadgeClass(status: string, isUnauthorized: boolean): string {
  if (isUnauthorized) return 'text-destructive bg-destructive/10'
  switch (status) {
    case 'active': return 'text-success bg-success/10'
    case 'error': return 'text-destructive bg-destructive/10'
    case 'expired': return 'text-warning bg-warning/10'
    case 'refreshing': return 'text-primary bg-primary/10'
    default: return 'text-muted-foreground bg-muted'
  }
}

// ============ display name ============

export function getDisplayName(account: Account): string {
  if (account.nickname) return account.nickname
  if (account.email) return account.email
  if (account.userId) return account.userId
  return 'Unknown'
}

// ============ Token Expired formatting ============

export function formatTokenExpiry(expiresAt: number, isEn: boolean): string {
  const now = Date.now()
  const diff = expiresAt - now
  if (diff <= 0) return isEn ? 'Expired' : 'Expired'
  const minutes = Math.floor(diff / (60 * 1000))
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (minutes < 60) {
    return isEn ? `${minutes}m` : `${minutes} minute`
  } else if (hours < 24) {
    const remainingMinutes = minutes % 60
    return isEn
      ? (remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`)
      : (remainingMinutes > 0 ? `${hours} Hour ${remainingMinutes} point` : `${hours} Hour`)
  } else {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return isEn
      ? (remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`)
      : (remainingHours > 0 ? `${days} sky ${remainingHours} Hour` : `${days} sky`)
  }
}

// ============ Banning error recognition ============

export function isBannedError(error: string | undefined): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('accountsuspendedexception') ||
    lower.includes('account suspended') ||
    lower.includes('temporarily_suspended') ||
    lower.includes('temporarily suspended') ||
    (lower.includes('user id is') && lower.includes('suspended')) ||
    lower.includes('Account has been banned') ||
    lower.includes('Banned') ||
    /\b423\b/.test(lower)
  )
}

// ============ date formatting ============

// Bundle nextResetDate / freeTrialExpiry and other types of safe formatting as YYYY-MM-DD
export function formatDateSafe(d: unknown): string {
  try {
    return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0]
  } catch {
    return ''
  }
}
