import { createHash } from "node:crypto"
import { basename } from "node:path"
import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, readOpenCodeAuthFrom, listOpenCodeAuthFiles, isTokenExpired, isPrimaryAuthFile } from "./keychain"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe"
import { readClaudeFileEntry, writeClaudeFileCache, updateClaudeFileEntry, readNamespacedCacheEntry, writeNamespacedCache, readCooldown, writeCooldown, tryAcquireFetchLock, releaseFetchLock } from "./cache"
import type { NamespaceEntry } from "./cache"
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

/** Shape persisted to the shared disk cache (one entry per auth file). */
export interface StoredAccountUsage {
  usage: OAuthUsageResponse
  profile: ProfileResponse | null
  identity: string | null
  authMethod: AuthMethod
  /** Hash of the access token that produced this data; used to track accounts moving between auth files. */
  tokenHash: string | null
}

// The TUI loop ticks faster than the refresh interval so that every process
// quickly picks up data written to the shared disk cache by whichever process
// holds the fetch lock. Network fetches still happen at most once per
// intervalMs across ALL processes.
const MAX_TICK_MS = 15_000

function tickMsFor(intervalMs: number): number {
  return Math.max(1, Math.min(MAX_TICK_MS, Math.floor(intervalMs / 4)))
}

const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 120_000

// When several pollers contend for the same account (e.g. multiple TUI windows,
// possibly running older plugin versions), the usage endpoint answers 429 with
// `retry-after: 0` — an explicit immediate-retry permission. A few short retries
// reliably break through, whereas a single polite long backoff loses the race to
// the other pollers forever and the display goes permanently stale.
const RATE_LIMIT_INLINE_RETRIES = 6
const RATE_LIMIT_RETRY_HINT_MAX_MS = 2_000
const RATE_LIMIT_RETRY_SOON_COOLDOWN_MS = 20_000

function rateLimitRetryDelayMs(): number {
  const fromEnv = Number(process.env.OPENCODE_USAGE_RETRY_DELAY_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 2_000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tokenHashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32)
}

const failedTokens = new Set<string>()

interface OAuthAttempt {
  usage: OAuthUsageResponse | null
  usageStatus: UsageFetchStatus
  profile: ProfileResponse | null
  retryAfterMs?: number
}

async function attemptOAuthOnce(token: string): Promise<OAuthAttempt> {
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

async function attemptOAuth(token: string): Promise<OAuthAttempt> {
  let attempt = await attemptOAuthOnce(token)
  for (let retry = 0; retry < RATE_LIMIT_INLINE_RETRIES; retry++) {
    if (attempt.usageStatus !== "rate_limited") break
    if (attempt.retryAfterMs === undefined || attempt.retryAfterMs > RATE_LIMIT_RETRY_HINT_MAX_MS) break
    const base = Math.max(attempt.retryAfterMs, rateLimitRetryDelayMs())
    await sleep(base + Math.floor(Math.random() * base * 0.35))
    const next = await attemptOAuthOnce(token)
    attempt = { ...next, profile: next.profile ?? attempt.profile }
  }
  return attempt
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

/**
 * Fetch Claude usage data (legacy single-account chain, used when no OpenCode
 * auth file exists).
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
    return { usage: null, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: attempt.usageStatus, retryAfterMs: attempt.retryAfterMs }
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
          sevenDayFable: null,
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

/**
 * Fetch usage for a single OpenCode auth file (one Claude account). Each file is a distinct
 * account, so this never falls back to other auth sources. A transient 429 is surfaced
 * (usage null, usageStatus "rate_limited") so the caller keeps that account's last data.
 *
 * Neither auth file is ever refreshed or written by this plugin: OpenCode owns both
 * auth.json and _auth.json and rotates their (single-use) tokens. An expired token is
 * reported, never refreshed, so the caller falls back to that account's last cached usage.
 * The expired secondary is reported as auth_failed only to drive the no-cache case to
 * "not-configured"; syncOne serves the cached case before calling here.
 */
async function fetchAccountUsage(filePath: string): Promise<FetchResult> {
  const auth = readOpenCodeAuthFrom(filePath)
  if (!auth) {
    return { usage: null, profile: null, authMethod: "none", identity: null, usageStatus: "unavailable" }
  }
  if (isTokenExpired(auth.expiresAt)) {
    return isPrimaryAuthFile(filePath)
      ? { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "unavailable" }
      : { usage: null, profile: null, authMethod: "oauth", identity: null, usageStatus: "auth_failed" }
  }
  const token = auth.accessToken
  const attempt = await attemptOAuth(token)
  const identity = identityOf(attempt.profile)
  if (attempt.usageStatus === "ok" && attempt.usage) {
    return { usage: attempt.usage, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: "ok", effectiveAccessToken: token }
  }
  return { usage: null, profile: attempt.profile, authMethod: "oauth", identity, usageStatus: attempt.usageStatus, retryAfterMs: attempt.retryAfterMs, effectiveAccessToken: token }
}

/**
 * Create the Claude refresh loop.
 *
 * Architecture: the shared disk cache (~/.cache/opencode-usage/last.json) is the single
 * source of truth. Every TUI process renders from it on a fast tick; at most ONE process
 * (the fetch-lock holder) refreshes a given account per intervalMs. Rate-limit cooldowns
 * are stored in the same shared file, so all processes honor the same Retry-After.
 */
export function createClaudeRefreshLoop(
  setAccounts: (accounts: ClaudeAccount[]) => void,
  intervalMs: number,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false

  function labelFor(base: string, profile: ProfileResponse | null, override?: string): string {
    if (override) return override
    const who = profile?.name ?? profile?.email ?? null
    return who ? `Claude (${base}, ${who.slice(0, 4)})` : `Claude (${base})`
  }

  function siblingBase(base: string): string | null {
    if (base === "auth.json") return "_auth.json"
    if (base === "_auth.json") return "auth.json"
    return null
  }

  interface ResolvedEntry {
    entry: NamespaceEntry<StoredAccountUsage>
    /** True when the entry's token hash matches the file's current token, i.e. the data provably belongs to this account. */
    trusted: boolean
  }

  /**
   * Resolve the cache entry for an auth file. A token-hash match (on the file's own entry
   * or its sibling's, covering accounts moved between auth.json and _auth.json) is trusted.
   * The untrusted own-entry fallback covers routine token rotation by OpenCode and may only
   * be displayed after a fetch confirms the identity is unchanged.
   */
  function entryFor(base: string, tokenHash: string): ResolvedEntry | null {
    const own = readClaudeFileEntry<StoredAccountUsage>(base)
    if (own && own.result.tokenHash === tokenHash) return { entry: own, trusted: true }
    const sib = siblingBase(base)
    const sibling = sib ? readClaudeFileEntry<StoredAccountUsage>(sib) : null
    if (sibling && sibling.result.tokenHash === tokenHash) return { entry: sibling, trusted: true }
    return own ? { entry: own, trusted: false } : null
  }

  function accountFromStored(id: string, base: string, stored: StoredAccountUsage, profile?: ProfileResponse | null, stale = false): ClaudeAccount {
    return {
      id,
      label: labelFor(base, profile ?? stored.profile),
      status: "success",
      data: stored.usage,
      authMethod: stored.authMethod,
      error: null,
      stale,
    }
  }

  function failureAccount(id: string, base: string, result: FetchResult, fallbackTokenHash: string): ClaudeAccount {
    const hash = result.effectiveAccessToken ? tokenHashOf(result.effectiveAccessToken) : fallbackTokenHash
    const resolved = entryFor(base, hash)
    if (resolved) {
      const { entry, trusted } = resolved
      const sameIdentity = result.identity !== null && entry.result.identity !== null && result.identity === entry.result.identity
      if (trusted || sameIdentity) {
        if (!trusted) {
          // Token rotated but the account is verified identical: re-attribute the
          // entry to the current token so cooldown ticks (and other processes)
          // keep rendering it as trusted data instead of "Loading...".
          updateClaudeFileEntry(base, { timestamp: entry.timestamp, result: { ...entry.result, tokenHash: hash } })
        }
        return accountFromStored(id, base, entry.result, result.profile ?? entry.result.profile)
      }
    }
    if (result.usageStatus === "auth_failed") {
      return { id, label: labelFor(base, result.profile), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    return { id, label: labelFor(base, result.profile), status: "loading", data: null, authMethod: "none", error: null }
  }

  async function syncOne(file: string): Promise<ClaudeAccount> {
    const base = basename(file)
    const auth = readOpenCodeAuthFrom(file)
    if (!auth) {
      return { id: file, label: labelFor(base, null), status: "not-configured", data: null, authMethod: "none", error: null }
    }
    const tokenHash = tokenHashOf(auth.accessToken)
    const resolved = entryFor(base, tokenHash)
    const now = Date.now()

    // Expired secondary _auth.json: OpenCode owns the file and its refresh token is
    // single-use, so the plugin must never refresh or write it. No live fetch is
    // possible, so render this file's last cached usage as stale instead of dropping
    // the account; with no cache there is nothing to show but "not-configured".
    if (!isPrimaryAuthFile(file) && isTokenExpired(auth.expiresAt)) {
      if (resolved) return accountFromStored(file, base, resolved.entry.result, undefined, true)
      return { id: file, label: labelFor(base, null), status: "not-configured", data: null, authMethod: "none", error: null }
    }

    const fresh = resolved !== null && resolved.trusted && now - resolved.entry.timestamp < intervalMs
    const coolingDown = now < readCooldown(`claude:${tokenHash}`)

    if (!fresh && !coolingDown && tryAcquireFetchLock(`claude-${base}`)) {
      try {
        const result = await fetchAccountUsage(file)
        if (result.usageStatus === "ok" && result.usage) {
          const effHash = tokenHashOf(result.effectiveAccessToken ?? auth.accessToken)
          const stored: StoredAccountUsage = {
            usage: result.usage,
            profile: result.profile,
            identity: result.identity,
            authMethod: result.authMethod,
            tokenHash: effHash,
          }
          writeClaudeFileCache(base, stored)
          return accountFromStored(file, base, stored)
        }
        if (result.usageStatus === "rate_limited") {
          const effHash = tokenHashOf(result.effectiveAccessToken ?? auth.accessToken)
          const cooldownMs = result.retryAfterMs !== undefined && result.retryAfterMs > 0
            ? result.retryAfterMs
            : result.retryAfterMs === 0
              ? RATE_LIMIT_RETRY_SOON_COOLDOWN_MS
              : Math.max(intervalMs, RATE_LIMIT_FALLBACK_COOLDOWN_MS)
          writeCooldown(`claude:${effHash}`, now + cooldownMs)
        }
        return failureAccount(file, base, result, tokenHash)
      } finally {
        releaseFetchLock(`claude-${base}`)
      }
    }

    // Render from the shared cache: data is fresh, the account is cooling down,
    // or another process holds the fetch lock and will update the cache shortly.
    // Only token-verified (trusted) entries may be shown without a fetch.
    if (resolved?.trusted) return accountFromStored(file, base, resolved.entry.result)
    return { id: file, label: labelFor(base, null), status: "loading", data: null, authMethod: "none", error: null }
  }

  async function syncLegacy(): Promise<ClaudeAccount> {
    const id = "claude"
    const entry = readNamespacedCacheEntry<StoredAccountUsage>("claude")
    const now = Date.now()
    const fresh = entry !== null && now - entry.timestamp < intervalMs

    if (!fresh && tryAcquireFetchLock("claude-legacy")) {
      try {
        const result = await fetchUsageData()
        if (result.usage) {
          const stored: StoredAccountUsage = {
            usage: result.usage,
            profile: result.profile,
            identity: result.identity,
            authMethod: result.authMethod,
            tokenHash: null,
          }
          writeNamespacedCache("claude", stored)
          return { id, label: "Claude", status: "success", data: result.usage, authMethod: result.authMethod, error: null }
        }
        if (entry) {
          return { id, label: "Claude", status: "success", data: entry.result.usage, authMethod: entry.result.authMethod, error: null }
        }
        if (result.authMethod === "none") {
          return { id, label: "Claude", status: "not-configured", data: null, authMethod: "none", error: null }
        }
        return { id, label: "Claude", status: "loading", data: null, authMethod: "none", error: null }
      } finally {
        releaseFetchLock("claude-legacy")
      }
    }

    if (entry) {
      return { id, label: "Claude", status: "success", data: entry.result.usage, authMethod: entry.result.authMethod, error: null }
    }
    return { id, label: "Claude", status: "loading", data: null, authMethod: "none", error: null }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const files = listOpenCodeAuthFiles()
      if (files.length === 0) {
        setAccounts([await syncLegacy()])
      } else {
        setAccounts(await Promise.all(files.map(syncOne)))
      }
    } finally {
      refreshing = false
    }
  }

  return {
    start() {
      if (timer !== null) return
      void refresh()
      timer = setInterval(() => { void refresh() }, tickMsFor(intervalMs))
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
