import { timingSafeEqual } from 'crypto'

/** Reads the bearer token off an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/** Constant-time comparison, false for anything missing or the wrong length
 *  rather than throwing. */
export function tokensMatch(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
