import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, readOpenCodeAuthFrom, listOpenCodeAuthFiles, refreshToken, isTokenExpired } from "./keychain"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe"
import { readClaudeAccountCache, writeClaudeAccountCache } from "./cache"
import type { OAuthUsageResponse, ProfileResponse, AuthMethod, UsageFetchStatus, ClaudeAccount } from "./types"

interface FetchResult {
  usage: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
  identity: string | null
  usageStatus: UsageFetchStatus
  retryAfterMs?: number
}

function readCache(identity: string | null): FetchResult | null {
  const cached = readClaudeAccountCache<FetchResult>(identity)
  if (!cached?.usage) return null
  return cached
}

function writeCache(result: FetchResult): void {
  if (result.usage && result.identity) writeClaudeAccountCache(result.identity, result)
}

/**
 * Fetch Claude usage data.
 *
 * If OpenCode auth.json exists, the account it authenticates is the anchor: the result
 * always belongs to that account and the chain never falls through to another auth source
 * (which may belong to a DIFFERENT Claude account). A transient HTTP 429 on the anchor is
 * surfaced (not swallowed) so the UI keeps the same account's data instead of flipping to
 * another account.
 *
 * With no OpenCode auth.json, the legacy single-account fallback applies:
 * 1. Environment variable token (CLAUDE_CODE_OAUTH_TOKEN)
 * 2. Credentials file (~/.claude/.credentials.json)
 * 3. Keychain (macOS only, user:profile scope required)
 * 4. CLI PTY probe (macOS/Linux, Python3 required)
 * 5. Browser cookies (Chrome/Firefox)
 *
 * Never throws. Always returns a FetchResult.
 */
const failedTokens = new Set<string>()
let lastRefreshedToken: string | null = null

interface OAuthAttempt {
  usage: OAuthUsageResponse | null
  usageStatus: UsageFetchStatus
  profile: ProfileResponse | null
  retryAfterMs?: number
}

async function attemptOAuth(token: string): Promise<OAuthAttempt> {
  try {
    const [usageResult, profile] = await Promise.all([
      fetchOAuthUsage(token),
      fetchOAuthProfile(token),
    ])
    return {
      usage: usageResult.status === "ok" ? usageResult.usage : null,
      usageStatus: usageResult.status,
      profile,
      retryAfterMs: usageResult.status === "rate_limited" ? usageResult.retryAfterMs : undefined,
    }
  } catch {
    return { usage: null, usageStatus: "unavailable", profile: null }
  }
}

function identityOf(profile: ProfileResponse | null): string | null {
  return profile?.email ? profile.email.toLowerCase() : null
}

async function tryOAuthToken(token: string): Promise<FetchResult | null> {
  if (failedTokens.has(token)) return null
  const attempt = await attemptOAuth(token)
  if (attempt.usageStatus === "ok" && attempt.usage) {
    return {
      usage: attempt.usage,
      profile: attempt.profile,
      authMethod: "oauth",
      identity: identityOf(attempt.profile),
      usageStatus: "ok",
    }
  }
  if (attempt.usageStatus === "auth_failed") failedTokens.add(token)
  return null
}

export async function fetchUsageData(): Promise<FetchResult> {
  failedTokens.clear()

  // ── Step 0: OpenCode auth.json — the account anchor (cross-platform).
  // When present, this account is authoritative and the chain never falls through to
  // another auth source, which may belong to a different Claude account.
  let ocAuth: ReturnType<typeof readOpenCodeAuth> = null
  try {
    ocAuth = readOpenCodeAuth()
  } catch {}
  if (ocAuth) {
    let token = lastRefreshedToken ?? ocAuth.accessToken
    if ((!lastRefreshedToken && isTokenExpired(ocAuth.expiresAt)) && ocAuth.refreshToken) {
      try {
        const refreshed = await refreshToken(ocAuth.refreshToken)
        if (refreshed) {
          token = refreshed.accessToken
          lastRefreshedToken = token
        }
      } catch {}
    }
    const attempt = await attemptOAuth(token)
    const identity = identityOf(attempt.profile)
    if (attempt.usageStatus === "ok" && attempt.usage) {
      return { usage: attempt.usage, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: "ok" }
    }
    // Anchor account but usage unavailable (e.g. transient 429): keep the pinned
    // identity and do NOT fall through to other (possibly different) accounts.
    return { usage: null, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: attempt.usageStatus }
  }

  // ── Step 1: Environment variable token (works on all OS)
  try {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (envToken) {
      const result = await tryOAuthToken(envToken)
      if (result) return result
    }
  } catch {}

  // ── Step 2: Credentials file (~/.claude/.credentials.json, cross-platform)
  try {
    const fileCreds = readCredentialsFile()
    if (fileCreds) {
      const result = await tryOAuthToken(fileCreds.accessToken)
      if (result) return result
    }
  } catch {}

  // ── Step 3: Keychain (macOS only, skip if no user:profile scope)
  try {
    const credentials = await readKeychainCredentials()
    if (credentials?.hasProfileScope) {
      const result = await tryOAuthToken(credentials.accessToken)
      if (result) return result
    }
  } catch {}

  // ── Step 4: CLI PTY probe (macOS/Linux, primary when OAuth unavailable)
  try {
    const installed = await detectClaude()
    if (installed) {
      const [probeResult, statusResult] = await Promise.all([
        probeCLIUsage(),
        probeStatus(),
      ])

      if (probeResult) {
        // Map CLIProbeResult → OAuthUsageResponse (best-effort)
        const usage: OAuthUsageResponse = {
          fiveHour: probeResult.sessionPercent !== null
            ? { utilization: probeResult.sessionPercent, resetsAt: probeResult.sessionReset }
            : null,
          sevenDay: probeResult.weeklyPercent !== null
            ? { utilization: probeResult.weeklyPercent, resetsAt: probeResult.weeklyReset }
            : null,
          sevenDaySonnet: probeResult.sonnetPercent !== null
            ? { utilization: probeResult.sonnetPercent, resetsAt: null }
            : null,
          sevenDayOpus: probeResult.opusPercent !== null
            ? { utilization: probeResult.opusPercent, resetsAt: null }
            : null,
          sevenDayDesign: null,
          sevenDayRoutines: null,
          sevenDayOAuthApps: null,
          extraUsage: null,
        }

        const profile: ProfileResponse | null = statusResult
          ? {
              email: statusResult.email,
              name: null,
              plan: statusResult.org,
            }
          : null

        return { usage, profile, authMethod: "cli", identity: identityOf(profile), usageStatus: "ok" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 5: Browser cookies (macOS/Linux)
  try {
    const sessionKey = await extractSessionKey()
    if (sessionKey) {
      const usage = await fetchWebUsage(sessionKey)
      if (usage) {
        return { usage, profile: null, authMethod: "cookie", identity: null, usageStatus: "ok" }
      }
    }
  } catch {
    // continue
  }

  // ── All failed ───────────────────────────────────────────────────────
  return { usage: null, profile: null, authMethod: "none", identity: null, usageStatus: "unavailable" }
}


const refreshedTokens = new Map<string, string>()

/**
 * Fetch usage for a single OpenCode auth file (one Claude account). Each file is a distinct
 * account, so this never falls back to other auth sources. A transient 429 is surfaced
 * (usage null, usageStatus "rate_limited") so the caller keeps that account's last data.
 */
async function fetchAccountUsage(filePath: string): Promise<FetchResult> {
  const auth = readOpenCodeAuthFrom(filePath)
  if (!auth) {
    return { usage: null, profile: null, authMethod: "none", identity: null, usageStatus: "unavailable" }
  }
  let token = refreshedTokens.get(filePath) ?? auth.accessToken
  if (!refreshedTokens.has(filePath) && isTokenExpired(auth.expiresAt) && auth.refreshToken) {
    try {
      const refreshed = await refreshToken(auth.refreshToken)
      if (refreshed) {
        token = refreshed.accessToken
        refreshedTokens.set(filePath, token)
      }
    } catch {}
  }
  const attempt = await attemptOAuth(token)
  const identity = identityOf(attempt.profile)
  if (attempt.usageStatus === "ok" && attempt.usage) {
    return { usage: attempt.usage, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: "ok" }
  }
  return { usage: null, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: attempt.usageStatus, retryAfterMs: attempt.retryAfterMs }
}

interface AccountSlot {
  data: OAuthUsageResponse
  profile: ProfileResponse | null
  authMethod: AuthMethod
}

/**
 * Create the Claude refresh loop. Renders one section per OpenCode auth file
 * (auth.json + _auth.json); falls back to the single-account fallback chain when none exist.
 * Per account, a transient 429 keeps the last known data instead of blanking.
 */
export function createClaudeRefreshLoop(
  setAccounts: (accounts: ClaudeAccount[]) => void,
  intervalMs: number,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false
  const slots = new Map<string, AccountSlot>()
  const lastProfiles = new Map<string, ProfileResponse>()
  const rateLimitedUntil = new Map<string, number>()

  function labelFor(id: string, profile: ProfileResponse | null, override?: string): string {
    if (override) return override
    const base = id.split("/").pop() ?? "auth.json"
    const p = profile ?? lastProfiles.get(id) ?? slots.get(id)?.profile ?? null
    const who = p?.name ?? p?.email ?? null
    return who ? `Claude (${base}, ${who.slice(0, 4)})` : `Claude (${base})`
  }

  // Honor the server Retry-After: while an account is cooling down, do not re-query its
  // usage endpoint (re-querying keeps the limit alive). Show its last known data instead.
  async function fetchOne(file: string): Promise<ClaudeAccount> {
    if (Date.now() < (rateLimitedUntil.get(file) ?? 0)) {
      const slot = slots.get(file)
      if (slot) {
        return { id: file, label: labelFor(file, null), status: "success", data: slot.data, authMethod: slot.authMethod, error: null }
      }
      return { id: file, label: labelFor(file, null), status: "loading", data: null, authMethod: "none", error: null }
    }
    const result = await fetchAccountUsage(file)
    if (result.profile) lastProfiles.set(file, result.profile)
    if (result.usageStatus === "rate_limited") {
      rateLimitedUntil.set(file, Date.now() + (result.retryAfterMs ?? Math.max(intervalMs, 120_000)))
    } else {
      rateLimitedUntil.delete(file)
    }
    return toAccount(file, result)
  }

  function toAccount(id: string, result: FetchResult, labelOverride?: string): ClaudeAccount {
    if (result.usage) {
      slots.set(id, { data: result.usage, profile: result.profile, authMethod: result.authMethod })
      writeCache(result)
      return { id, label: labelFor(id, result.profile, labelOverride), status: "success", data: result.usage, authMethod: result.authMethod, error: null }
    }
    if (result.authMethod === "none") {
      slots.delete(id)
      return { id, label: labelFor(id, null, labelOverride), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    const slot = slots.get(id)
    if (slot) {
      return { id, label: labelFor(id, result.profile, labelOverride), status: "success", data: slot.data, authMethod: slot.authMethod, error: null }
    }
    const cached = readCache(result.identity)
    if (cached && cached.usage) {
      slots.set(id, { data: cached.usage, profile: cached.profile, authMethod: cached.authMethod })
      return { id, label: labelFor(id, cached.profile ?? result.profile, labelOverride), status: "success", data: cached.usage, authMethod: cached.authMethod, error: null }
    }
    if (result.usageStatus === "auth_failed") {
      return { id, label: labelFor(id, result.profile, labelOverride), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    return { id, label: labelFor(id, result.profile, labelOverride), status: "loading", data: null, authMethod: "none", error: null }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const files = listOpenCodeAuthFiles()
      if (files.length === 0) {
        const result = await fetchUsageData()
        setAccounts([toAccount("claude", result, "Claude")])
      } else {
        setAccounts(await Promise.all(files.map(fetchOne)))
      }
    } finally {
      refreshing = false
    }
  }

  return {
    start() {
      if (timer !== null) return
      void refresh()
      timer = setInterval(() => { void refresh() }, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
