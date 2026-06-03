import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, readOpenCodeAuthFrom, listOpenCodeAuthFiles, refreshToken, isTokenExpired, writeOpenCodeAuthTo, isPrimaryAuthFile } from "./keychain"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe"
import { readClaudeAccountCache, readClaudeAccountKeyCacheEntry, writeClaudeAccountCache, writeClaudeAccountKeyCache } from "./cache"
import type { OAuthUsageResponse, ProfileResponse, AuthMethod, UsageFetchStatus, ClaudeAccount } from "./types"

interface FetchResult {
  usage: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
  identity: string | null
  usageStatus: UsageFetchStatus
  retryAfterMs?: number
  effectiveAccessToken?: string
}

const CLAUDE_ACCOUNT_MIN_FETCH_INTERVAL_MS = 60_000

function readCache(identity: string | null): FetchResult | null {
  const cached = readClaudeAccountCache<FetchResult>(identity)
  if (!cached?.usage) return null
  return cached
}

function writeCache(result: FetchResult, accountKeys?: readonly string[]): void {
  if (!result.usage) return
  if (result.identity) writeClaudeAccountCache(result.identity, result)
  for (const key of accountKeys ?? []) writeClaudeAccountKeyCache(key, result)
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
interface RefreshedTokenCache {
  sourceAccessToken: string
  accessToken: string
  expiresAt: number
}

function validRefreshedAccessToken(cached: RefreshedTokenCache | null | undefined, sourceAccessToken: string): string | null {
  if (!cached) return null
  if (cached.sourceAccessToken !== sourceAccessToken) return null
  if (isTokenExpired(cached.expiresAt)) return null
  return cached.accessToken
}

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
    if (isTokenExpired(ocAuth.expiresAt)) {
      return { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "unavailable" }
    }
    const attempt = await attemptOAuth(ocAuth.accessToken)
    const identity = identityOf(attempt.profile)
    if (attempt.usageStatus === "ok" && attempt.usage) {
      return { usage: attempt.usage, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: "ok" }
    }
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


const refreshedTokens = new Map<string, RefreshedTokenCache>()

function accountStateKey(filePath: string, accessToken: string): string {
  const tokenHash = createHash("sha256").update(accessToken).digest("hex").slice(0, 16)
  return `${filePath}\0${tokenHash}`
}

function accountCacheKey(stateKey: string): string {
  return createHash("sha256").update(stateKey).digest("hex")
}

function tokenCacheKey(accessToken: string): string {
  return `token:${createHash("sha256").update(accessToken).digest("hex")}`
}

function siblingAuthFile(filePath: string): string | null {
  const base = basename(filePath)
  if (base === "auth.json") return join(dirname(filePath), "_auth.json")
  if (base === "_auth.json") return join(dirname(filePath), "auth.json")
  return null
}

function accountCacheKeys(filePath: string, accessToken: string): readonly string[] {
  const currentStateKey = accountStateKey(filePath, accessToken)
  const sibling = siblingAuthFile(filePath)
  const keys = [tokenCacheKey(accessToken), accountCacheKey(currentStateKey)]
  if (sibling) keys.push(accountCacheKey(accountStateKey(sibling, accessToken)))
  return keys
}

function readAccountKeyCache(accountKeys: readonly string[]) {
  for (const key of accountKeys) {
    const cached = readClaudeAccountKeyCacheEntry<FetchResult>(key)
    if (cached?.result.usage) return cached
  }
  return null
}

/**
 * Fetch usage for a single OpenCode auth file (one Claude account). Each file is a distinct
 * account, so this never falls back to other auth sources. A transient 429 is surfaced
 * (usage null, usageStatus "rate_limited") so the caller keeps that account's last data.
 */
async function fetchAccountUsage(filePath: string, auth = readOpenCodeAuthFrom(filePath)): Promise<FetchResult> {
  if (!auth) {
    return { usage: null, profile: null, authMethod: "none", identity: null, usageStatus: "unavailable" }
  }
  const cachedRefresh = refreshedTokens.get(filePath)
  const refreshedAccessToken = validRefreshedAccessToken(cachedRefresh, auth.accessToken)
  let token = refreshedAccessToken ?? auth.accessToken
  if (!refreshedAccessToken && isTokenExpired(auth.expiresAt)) {
    if (isPrimaryAuthFile(filePath)) {
      return { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "unavailable" }
    }
    if (!auth.refreshToken) {
      return { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "auth_failed" }
    }
    const refreshed = await refreshToken(auth.refreshToken).catch(() => null)
    if (!refreshed) {
      return { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "auth_failed" }
    }
    const persisted = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt }
    token = persisted.accessToken
    refreshedTokens.set(filePath, { sourceAccessToken: auth.accessToken, accessToken: token, expiresAt: persisted.expiresAt })
    try { writeOpenCodeAuthTo(filePath, persisted) } catch {}
  }
  const attempt = await attemptOAuth(token)
  const identity = identityOf(attempt.profile)
  if (attempt.usageStatus === "ok" && attempt.usage) {
    return { usage: attempt.usage, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: "ok", effectiveAccessToken: token }
  }
  return { usage: null, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: attempt.usageStatus, retryAfterMs: attempt.retryAfterMs, effectiveAccessToken: token }
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
  const lastRequestedAt = new Map<string, number>()

  function labelFor(id: string, stateKey: string, profile: ProfileResponse | null, override?: string): string {
    if (override) return override
    const base = id.split("/").pop() ?? "auth.json"
    const p = profile ?? lastProfiles.get(stateKey) ?? slots.get(stateKey)?.profile ?? null
    const who = p?.name ?? p?.email ?? null
    return who ? `Claude (${base}, ${who.slice(0, 4)})` : `Claude (${base})`
  }

  // Honor the server Retry-After: while an account is cooling down, do not re-query its
  // usage endpoint (re-querying keeps the limit alive). Show its last known data instead.
  async function fetchOne(file: string): Promise<ClaudeAccount> {
    const auth = readOpenCodeAuthFrom(file)
    if (!auth) return toAccount(file, file, { usage: null, profile: null, authMethod: "none", identity: null, usageStatus: "unavailable" })

    const preToken = validRefreshedAccessToken(refreshedTokens.get(file), auth.accessToken) ?? auth.accessToken
    const stateKey = accountStateKey(file, preToken)
    const cacheKeys = accountCacheKeys(file, preToken)
    const cached = readAccountKeyCache(cacheKeys)
    const cachedSlot = hydrateSlotFromCache(stateKey, cached)
    const now = Date.now()
    const preCooldownKey = tokenCacheKey(preToken)
    if (now < (rateLimitedUntil.get(preCooldownKey) ?? 0)) {
      if (cachedSlot) {
        return accountFromSlot(file, stateKey, cachedSlot)
      }
      return { id: file, label: labelFor(file, stateKey, null), status: "loading", data: null, authMethod: "none", error: null }
    }

    const lastRequest = lastRequestedAt.get(preCooldownKey) ?? cached?.timestamp ?? 0
    if (cachedSlot && now - lastRequest < CLAUDE_ACCOUNT_MIN_FETCH_INTERVAL_MS) {
      return accountFromSlot(file, stateKey, cachedSlot)
    }

    lastRequestedAt.set(preCooldownKey, now)
    const result = await fetchAccountUsage(file, auth)
    const effToken = result.effectiveAccessToken ?? preToken
    const effStateKey = effToken === preToken ? stateKey : accountStateKey(file, effToken)
    const effCacheKeys = effToken === preToken ? cacheKeys : accountCacheKeys(file, effToken)
    const cooldownKey = tokenCacheKey(effToken)
    if (cooldownKey !== preCooldownKey) lastRequestedAt.set(cooldownKey, now)
    if (result.profile) lastProfiles.set(effStateKey, result.profile)
    if (result.usageStatus === "rate_limited") {
      rateLimitedUntil.set(cooldownKey, Date.now() + (result.retryAfterMs ?? Math.max(intervalMs, 120_000)))
    } else {
      rateLimitedUntil.delete(cooldownKey)
    }
    return toAccount(file, effStateKey, result, undefined, effCacheKeys)
  }

  function hydrateSlotFromCache(stateKey: string, cached: ReturnType<typeof readAccountKeyCache>): AccountSlot | null {
    const existing = slots.get(stateKey)
    if (existing) return existing
    const usage = cached?.result.usage
    if (!usage) return null
    const slot = { data: usage, profile: cached.result.profile, authMethod: cached.result.authMethod }
    slots.set(stateKey, slot)
    if (cached.result.profile) lastProfiles.set(stateKey, cached.result.profile)
    return slot
  }

  function accountFromSlot(id: string, stateKey: string, slot: AccountSlot, labelOverride?: string): ClaudeAccount {
    return { id, label: labelFor(id, stateKey, slot.profile, labelOverride), status: "success", data: slot.data, authMethod: slot.authMethod, error: null }
  }

  function toAccount(id: string, stateKey: string, result: FetchResult, labelOverride?: string, accountKeys?: readonly string[]): ClaudeAccount {
    if (result.usage) {
      slots.set(stateKey, { data: result.usage, profile: result.profile, authMethod: result.authMethod })
      writeCache(result, accountKeys)
      return { id, label: labelFor(id, stateKey, result.profile, labelOverride), status: "success", data: result.usage, authMethod: result.authMethod, error: null }
    }
    if (result.authMethod === "none") {
      slots.delete(stateKey)
      return { id, label: labelFor(id, stateKey, null, labelOverride), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    const slot = slots.get(stateKey)
    if (slot) {
      return { id, label: labelFor(id, stateKey, result.profile, labelOverride), status: "success", data: slot.data, authMethod: slot.authMethod, error: null }
    }
    const keyCached = accountKeys ? readAccountKeyCache(accountKeys) : null
    const keySlot = hydrateSlotFromCache(stateKey, keyCached)
    if (keySlot) return accountFromSlot(id, stateKey, keySlot, labelOverride)

    const cached = result.identity ? readCache(result.identity) : null
    if (cached?.usage) {
      slots.set(stateKey, { data: cached.usage, profile: cached.profile, authMethod: cached.authMethod })
      writeCache(cached, accountKeys)
      return { id, label: labelFor(id, stateKey, cached.profile ?? result.profile, labelOverride), status: "success", data: cached.usage, authMethod: cached.authMethod, error: null }
    }
    if (result.usageStatus === "auth_failed") {
      return { id, label: labelFor(id, stateKey, result.profile, labelOverride), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    return { id, label: labelFor(id, stateKey, result.profile, labelOverride), status: "loading", data: null, authMethod: "none", error: null }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const files = listOpenCodeAuthFiles()
      if (files.length === 0) {
        const result = await fetchUsageData()
        setAccounts([toAccount("claude", "claude", result, "Claude")])
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
