import {
  isCodexTokenExpired,
  readCodexAuthFile,
  readOpenCodeCodexAuth,
  refreshCodexToken,
  decodeAccessTokenJwt,
} from "./codex-auth"
import { fetchCodexUsage } from "./codex-oauth-client"
import { readNamespacedCacheEntry, writeNamespacedCache, tryAcquireFetchLock, releaseFetchLock } from "./cache"
import type {
  CodexState,
  CodexUsageResponse,
  CodexProfile,
  CodexAuthMethod,
  CodexCredentials,
} from "./types"

interface CodexFetchResult {
  usage: CodexUsageResponse | null
  profile: CodexProfile | null
  authMethod: CodexAuthMethod
}

// See fetcher.ts: render tick is faster than the fetch interval so all TUI
// processes converge on the shared disk cache quickly; only the fetch-lock
// holder hits the network.
const MAX_TICK_MS = 15_000

function tickMsFor(intervalMs: number): number {
  return Math.max(1, Math.min(MAX_TICK_MS, Math.floor(intervalMs / 4)))
}

const failedTokens = new Set<string>()

// Refreshed Codex access tokens are reused in-memory instead of being written
// back to ~/.codex/auth.json (that file is owned by the Codex CLI). Without
// this, an expired auth file would trigger a token refresh on EVERY interval.
interface RefreshedCodexToken {
  sourceRefreshToken: string
  accessToken: string
  accountId: string | null
  expiresAt: number
}
let refreshedCodexToken: RefreshedCodexToken | null = null

function profileFromUsage(usage: CodexUsageResponse | null, accessToken: string): CodexProfile | null {
  if (usage?.email || usage?.planType) {
    return { email: usage.email, planType: usage.planType }
  }
  const jwt = decodeAccessTokenJwt(accessToken)
  if (!jwt) return null
  if (!jwt.email && !jwt.chatgptPlanType) return null
  return { email: jwt.email, planType: jwt.chatgptPlanType }
}

async function attemptUsage(token: string, accountId: string, method: CodexAuthMethod): Promise<CodexFetchResult | null> {
  if (failedTokens.has(token)) return null
  try {
    const usage = await fetchCodexUsage(token, accountId)
    if (usage) {
      return { usage, profile: profileFromUsage(usage, token), authMethod: method }
    }
    failedTokens.add(token)
  } catch {
    failedTokens.add(token)
  }
  return null
}

async function tryCredentials(
  creds: CodexCredentials | null,
  method: CodexAuthMethod,
): Promise<CodexFetchResult | null> {
  if (!creds || !creds.accountId) return null

  if (isCodexTokenExpired(creds.expiresAt)) {
    // Reuse a token we already refreshed for this refresh-token lineage.
    if (
      refreshedCodexToken &&
      refreshedCodexToken.sourceRefreshToken === creds.refreshToken &&
      !isCodexTokenExpired(refreshedCodexToken.expiresAt)
    ) {
      return attemptUsage(refreshedCodexToken.accessToken, refreshedCodexToken.accountId ?? creds.accountId, method)
    }
    if (!creds.refreshToken) return null
    const refreshed = await refreshCodexToken(creds.refreshToken)
    if (!refreshed?.accessToken) return null
    refreshedCodexToken = {
      sourceRefreshToken: creds.refreshToken,
      accessToken: refreshed.accessToken,
      accountId: refreshed.accountId ?? creds.accountId,
      expiresAt: refreshed.expiresAt,
    }
    return attemptUsage(refreshed.accessToken, refreshed.accountId ?? creds.accountId, method)
  }

  return attemptUsage(creds.accessToken, creds.accountId, method)
}

export async function fetchCodexUsageData(): Promise<CodexFetchResult> {
  failedTokens.clear()

  const envToken = process.env.CODEX_OAUTH_ACCESS_TOKEN
  const envAccountId = process.env.CODEX_ACCOUNT_ID
  if (envToken && envAccountId) {
    const result = await tryCredentials(
      { accessToken: envToken, refreshToken: "", accountId: envAccountId, expiresAt: Number.MAX_SAFE_INTEGER },
      "env",
    )
    if (result) return result
  }

  try {
    const fileCreds = readCodexAuthFile()
    const result = await tryCredentials(fileCreds, "oauth-codex-cli")
    if (result) return result
  } catch {}

  try {
    const ocCreds = readOpenCodeCodexAuth()
    const result = await tryCredentials(ocCreds, "oauth-opencode")
    if (result) return result
  } catch {}

  return { usage: null, profile: null, authMethod: "none" }
}

export function createCodexRefreshLoop(
  setState: (state: CodexState) => void,
  intervalMs: number,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false
  let announcedLoading = false

  function successState(result: CodexFetchResult): CodexState {
    return {
      status: "success",
      data: result.usage,
      profile: result.profile,
      authMethod: result.authMethod,
      error: null,
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const entry = readNamespacedCacheEntry<CodexFetchResult>("codex")
      const cached = entry?.result.usage ? entry.result : null
      const fresh = entry !== null && cached !== null && Date.now() - entry.timestamp < intervalMs

      if (fresh) {
        setState(successState(cached))
        return
      }

      if (!tryAcquireFetchLock("codex")) {
        // Another process is fetching; render the latest shared data meanwhile.
        if (cached) {
          setState(successState(cached))
        } else if (!announcedLoading) {
          announcedLoading = true
          setState({ status: "loading", data: null, profile: null, authMethod: "none", error: null })
        }
        return
      }

      try {
        if (!cached && !announcedLoading) {
          announcedLoading = true
          setState({ status: "loading", data: null, profile: null, authMethod: "none", error: null })
        }
        const result = await fetchCodexUsageData()
        if (result.authMethod !== "none" && result.usage) {
          writeNamespacedCache("codex", result)
          setState(successState(result))
        } else if (cached) {
          setState(successState(cached))
        } else if (result.authMethod === "none") {
          setState({ status: "not-configured", data: null, profile: null, authMethod: "none", error: null })
        } else {
          setState({ status: "error", data: null, profile: null, authMethod: result.authMethod, error: "fetch failed" })
        }
      } finally {
        releaseFetchLock("codex")
      }
    } catch (err) {
      const entry = readNamespacedCacheEntry<CodexFetchResult>("codex")
      const cached = entry?.result.usage ? entry.result : null
      if (cached) {
        setState(successState(cached))
      } else {
        setState({ status: "error", data: null, profile: null, authMethod: "none", error: String(err) })
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
