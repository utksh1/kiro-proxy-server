/**
 * Dot variant mailbox generator (Dot Alias Generator）
 *
 * principle:Gmail Wait for the email service to ignore local partial `.`,so `john.doe@gmail.com` and
 *      `johndoe@gmail.com` It's actually the same email address. Using this feature, from a parent mailbox you can
 *      generate a large number of"Looks different but actually receives the same"A variation of , used to register multiple accounts.
 *
 * Note: This feature is only valid for some email services (Gmail / Outlook / iCloud / Yandex wait),
 *      ProtonMail / Yahoo / Self-created mailboxes usually do not support dot aliases. Whether to enable it or not is up to the user.
 *
 * algorithm:
 *  1. Normalize parent mailbox (remove local Partially owned `.`）
 *  2. according to dotCount = 1, 2, 3, ... Traverse in ascending order
 *  3. each dotCount Enumerate all possible dot position combinations (C(n, k)）
 *  4. filter out already in usedEmails Variants in the blacklist
 *  5. Randomly select one from the remaining candidates and return
 *  6. Return after all is used null
 */

/** generate [0, n) selected k All combinations of non-repeating elements (in ascending order) */
function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield [...prefix]
    return
  }
  // Pruning: the remaining space is not enough to fill k Exit directly when
  if (n - start < k - prefix.length) return
  for (let i = start; i < n; i++) {
    prefix.push(i)
    yield* combinations(n, k, i + 1, prefix)
    prefix.pop()
  }
}

/**
 * exist local Insert a period after the specified position in the string
 * @param positions character index List (increasing), meaning: in local[idx] Insert a character after `.`
 *                  Value range 0 ≤ idx ≤ local.length - 2
 */
function insertDots(local: string, positions: number[]): string {
  const positionSet = new Set(positions)
  let result = ''
  for (let i = 0; i < local.length; i++) {
    result += local[i]
    if (i < local.length - 1 && positionSet.has(i)) result += '.'
  }
  return result
}

/** Split the mailbox into [local, domain], invalid email is returned null */
export function splitEmail(email: string): [string, string] | null {
  const trimmed = email.trim()
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null
  const local = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  if (!local || !domain || domain.indexOf('.') < 0) return null
  return [local, domain]
}

/**
 * Normalized mailbox: removed local of all `.`, converted to lowercase as a whole
 * Used for: Determining multiple mailboxes"Is it actually the same mother number?"
 */
export function normalizeEmail(email: string): string {
  const split = splitEmail(email)
  if (!split) return email.toLowerCase()
  const [local, domain] = split
  return `${local.replace(/\./g, '').toLowerCase()}@${domain.toLowerCase()}`
}

/** Calculate binomial coefficients C(n, k), to avoid large number overflow (used to estimate the total number of variants)*/
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1)
  }
  return Math.round(result)
}

/** Calculate given local length, all dotCount=1..maxDot The total number of variants */
export function totalVariantCount(localLength: number, maxDot = Number.POSITIVE_INFINITY): number {
  const positions = localLength - 1
  if (positions <= 0) return 0
  let sum = 0
  for (let k = 1; k <= Math.min(positions, maxDot); k++) {
    sum += binomial(positions, k)
  }
  return sum
}

/**
 * statistics usedEmails How many of them are variations of "the same parent mailbox"?
 * Right now:local Same after going to point + domain same
 */
export function countSameRootVariants(parentEmail: string, usedEmails: Iterable<string>): number {
  const parentSplit = splitEmail(parentEmail)
  if (!parentSplit) return 0
  const baseLocal = parentSplit[0].replace(/\./g, '').toLowerCase()
  const baseDomain = parentSplit[1].toLowerCase()
  let count = 0
  for (const e of usedEmails) {
    const split = splitEmail(e)
    if (!split) continue
    const [local, domain] = split
    if (domain.toLowerCase() === baseDomain && local.replace(/\./g, '').toLowerCase() === baseLocal) {
      count++
    }
  }
  return count
}

export interface DotVariantResult {
  /** The next variant mailbox selected will be returned after all is used up. null */
  variant: string | null
  /** The number of points currently in use (1..n);return null time is 0 */
  dotCount: number
  /** same dotCount How many unused candidates are left? */
  remainingInBucket: number
  /** The parent email address is standardized. local Length, used to estimate the total capacity of the upper layer */
  localLength: number
}

/**
 * Generate the next unused dot variant
 *
 * @param parentEmail Parent mailbox (with or without original dot number)
 * @param usedEmails  Used mailbox collection (case-insensitive, keeping dot numbers intact for comparison)
 *                    Usually includes: everything in the local account inventory email + in registration history email
 * @returns DotVariantResult; if all variants have been used,variant=null
 */
export function generateNextDotVariant(
  parentEmail: string,
  usedEmails: Iterable<string>
): DotVariantResult {
  const split = splitEmail(parentEmail)
  if (!split) return { variant: null, dotCount: 0, remainingInBucket: 0, localLength: 0 }

  const local = split[0].replace(/\./g, '')
  const domain = split[1].toLowerCase()
  const localLength = local.length
  const positions = localLength - 1

  if (positions <= 0) {
    return { variant: null, dotCount: 0, remainingInBucket: 0, localLength }
  }

  // Blacklist: Keep the point numbers as they are + all lowercase
  const used = new Set<string>()
  for (const e of usedEmails) {
    const t = e.trim().toLowerCase()
    if (t) used.add(t)
  }
  // The parent mailbox itself (as is + Go to the click version) and also exclude: avoid sending the verification code to the original account occupier
  used.add(parentEmail.trim().toLowerCase())
  used.add(`${local.toLowerCase()}@${domain}`)

  // according to dotCount Ascending order first:1 point → 2 point → ...
  for (let k = 1; k <= positions; k++) {
    const candidates: string[] = []
    for (const combo of combinations(positions, k)) {
      const variant = `${insertDots(local, combo)}@${domain}`
      if (!used.has(variant.toLowerCase())) {
        candidates.push(variant)
      }
    }
    if (candidates.length > 0) {
      // same dotCount Randomly select one within the list to avoid starting from the smallest lexicographic order every time
      const variant = candidates[Math.floor(Math.random() * candidates.length)]
      return {
        variant,
        dotCount: k,
        remainingInBucket: candidates.length - 1,
        localLength
      }
    }
  }

  return { variant: null, dotCount: 0, remainingInBucket: 0, localLength }
}
