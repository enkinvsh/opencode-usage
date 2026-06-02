import type { OAuthUsageResponse, ProfileResponse, UsageFetchResult } from "./types"

const BASE_URL = "https://api.anthropic.com"
const BETA_HEADER = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.1.0"
const TIMEOUT_MS = 10_000

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": BETA_HEADER,
    "User-Agent": USER_AGENT,
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    return response
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recursively convert snake_case keys to camelCase.
 * e.g. five_hour → fiveHour, resets_at → resetsAt
 */
export function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      result[camelKey] = snakeToCamel(value)
    }
    return result
  }
  return obj
}

/**
 * Fetch Claude usage data via OAuth API.
 *
 * Distinguishes HTTP 429 (transient rate limit, common when the same account is
 * actively used for inference) from auth failures (401/403). The caller relies on
 * this to avoid falling through to a DIFFERENT account's token on a transient 429.
 */
export async function fetchOAuthUsage(accessToken: string): Promise<UsageFetchResult> {
  const response = await fetchWithTimeout(
    `${BASE_URL}/api/oauth/usage`,
    makeHeaders(accessToken),
  )
  if (!response) return { status: "unavailable" }
  if (response.status === 429) {
    const retryAfterSec = Number(response.headers.get("retry-after"))
    return Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? { status: "rate_limited", retryAfterMs: retryAfterSec * 1000 }
      : { status: "rate_limited" }
  }
  if (response.status === 401 || response.status === 403) return { status: "auth_failed" }
  if (!response.ok) return { status: "unavailable" }

  try {
    const raw = await response.json() as Record<string, unknown>
    return { status: "ok", usage: snakeToCamel(raw) as OAuthUsageResponse }
  } catch {
    return { status: "unavailable" }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

export async function fetchOAuthProfile(accessToken: string): Promise<ProfileResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/api/oauth/profile`,
      makeHeaders(accessToken),
    )
    if (!response || !response.ok) return null

    const raw = await response.json() as Record<string, unknown>
    const converted = snakeToCamel(raw) as Record<string, unknown>

    // The OAuth profile nests identity under `account` (account.email, account.display_name);
    // older callers read the top level, which is always empty for the real API response.
    const account = asRecord(converted.account ?? converted)
    const organization = asRecord(converted.organization)

    const email = typeof account.email === "string" ? account.email : null
    if (!email) return null

    const name = typeof account.displayName === "string" ? account.displayName
      : typeof account.fullName === "string" ? account.fullName
      : null
    const plan = typeof organization.organizationType === "string" ? organization.organizationType
      : typeof account.subscriptionType === "string" ? account.subscriptionType
      : null

    return { email, name, plan }
  } catch {
    return null
  }
}
