import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../keychain.js", () => ({
  readKeychainCredentials: vi.fn(),
  readCredentialsFile: vi.fn(),
  readOpenCodeAuth: vi.fn(),
  readOpenCodeAuthFrom: vi.fn(),
  listOpenCodeAuthFiles: vi.fn(),
  refreshToken: vi.fn(),
  isTokenExpired: vi.fn(),
  writeOpenCodeAuthTo: vi.fn(),
  isPrimaryAuthFile: vi.fn((p: string) => p.endsWith("/auth.json")),
}))
vi.mock("../oauth-client.js", () => ({
  fetchOAuthUsage: vi.fn(),
  fetchOAuthProfile: vi.fn(),
}))
vi.mock("../cookie-reader.js", () => ({
  extractSessionKey: vi.fn(),
  fetchWebUsage: vi.fn(),
}))
vi.mock("../cli-probe.js", () => ({
  detectClaude: vi.fn(),
  probeCLIUsage: vi.fn(),
  probeStatus: vi.fn(),
}))
vi.mock("../cache.js", () => ({
  readClaudeAccountCache: vi.fn(() => null),
  readClaudeAccountKeyCacheEntry: vi.fn(() => null),
  writeClaudeAccountCache: vi.fn(),
  writeClaudeAccountKeyCache: vi.fn(),
}))

import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, readOpenCodeAuthFrom, listOpenCodeAuthFiles, refreshToken, isTokenExpired, writeOpenCodeAuthTo } from "../keychain.js"
import { fetchOAuthUsage, fetchOAuthProfile } from "../oauth-client.js"
import { extractSessionKey, fetchWebUsage } from "../cookie-reader.js"
import { detectClaude, probeCLIUsage, probeStatus } from "../cli-probe.js"
import { readClaudeAccountCache, readClaudeAccountKeyCacheEntry } from "../cache.js"
import { fetchUsageData, createClaudeRefreshLoop } from "../fetcher.js"
import type { OAuthUsageResponse, ClaudeAccount } from "../types.js"

const USAGE: OAuthUsageResponse = {
  fiveHour: { utilization: 10, resetsAt: null },
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  sevenDayDesign: null,
  sevenDayRoutines: null,
  sevenDayOAuthApps: null,
  extraUsage: null,
}

describe("fetchUsageData fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readClaudeAccountCache).mockReturnValue(null)
    vi.mocked(readClaudeAccountKeyCacheEntry).mockReturnValue(null)
    vi.mocked(readKeychainCredentials).mockResolvedValue(null)
    vi.mocked(readCredentialsFile).mockReturnValue(null)
    vi.mocked(readOpenCodeAuth).mockReturnValue(null)
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue(null)
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue([])
    vi.mocked(refreshToken).mockResolvedValue(null)
    vi.mocked(isTokenExpired).mockReturnValue(false)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "auth_failed" })
    vi.mocked(fetchOAuthProfile).mockResolvedValue(null)
    vi.mocked(detectClaude).mockResolvedValue(false)
    vi.mocked(probeCLIUsage).mockResolvedValue(null)
    vi.mocked(probeStatus).mockResolvedValue(null)
    vi.mocked(extractSessionKey).mockResolvedValue(null)
    vi.mocked(fetchWebUsage).mockResolvedValue(null)
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })

  it("returns authMethod none when all methods fail", async () => {
    const result = await fetchUsageData()
    expect(result.authMethod).toBe("none")
    expect(result.usage).toBeNull()
  })

  it("uses CLI probe when claude is installed", async () => {
    vi.mocked(detectClaude).mockResolvedValue(true)
    vi.mocked(probeCLIUsage).mockResolvedValue({
      sessionPercent: 45,
      weeklyPercent: 62,
      opusPercent: null,
      sonnetPercent: null,
      sessionReset: "Resets5pm(Asia/Seoul)",
      weeklyReset: "ResetsMay2at7pm(Asia/Seoul)",
      email: null,
      org: null,
    })
    vi.mocked(probeStatus).mockResolvedValue({ email: "test@example.com", org: null })

    const result = await fetchUsageData()
    expect(result.authMethod).toBe("cli")
    expect(result.usage?.fiveHour?.utilization).toBe(45)
    expect(result.profile?.email).toBe("test@example.com")
  })

  it("skips OAuth when hasProfileScope is false", async () => {
    vi.mocked(readKeychainCredentials).mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(detectClaude).mockResolvedValue(false)

    await fetchUsageData()
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("prefers OpenCode auth.json over env var and credentials file", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token"
    vi.mocked(readCredentialsFile).mockReturnValue({
      accessToken: "file-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(readOpenCodeAuth).mockReturnValue({
      accessToken: "opencode-token",
      refreshToken: "opencode-refresh",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(fetchOAuthUsage).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { status: "ok", usage: USAGE }
        : { status: "auth_failed" },
    )

    const result = await fetchUsageData()

    expect(result.authMethod).toBe("oauth")
    expect(fetchOAuthUsage).toHaveBeenCalledWith("opencode-token")
    expect(fetchOAuthUsage).not.toHaveBeenCalledWith("env-token")
    expect(fetchOAuthUsage).not.toHaveBeenCalledWith("file-token")
  })

  it("never refreshes or queries usage for an expired primary auth.json (fallback path)", async () => {
    vi.mocked(readOpenCodeAuth).mockReturnValue({
      accessToken: "expired-primary",
      refreshToken: "opencode-refresh",
      expiresAt: 1,
    })
    vi.mocked(isTokenExpired).mockReturnValue(true)
    vi.mocked(refreshToken).mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "opencode-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    const result = await fetchUsageData()

    expect(refreshToken).not.toHaveBeenCalled()
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
    expect(result.usage).toBeNull()
    expect(result.usageStatus).toBe("unavailable")
  })

  it("does not fall through to a different account when OpenCode usage is rate limited", async () => {
    vi.mocked(readOpenCodeAuth).mockReturnValue({
      accessToken: "opencode-token",
      refreshToken: "opencode-refresh",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(readKeychainCredentials).mockResolvedValue({
      accessToken: "keychain-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(fetchOAuthProfile).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { email: "primary@example.com", name: "Primary", plan: null }
        : { email: "secondary@example.com", name: "Secondary", plan: null },
    )
    vi.mocked(fetchOAuthUsage).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { status: "rate_limited" }
        : { status: "ok", usage: USAGE },
    )

    const result = await fetchUsageData()

    expect(result.identity).toBe("primary@example.com")
    expect(result.usage).toBeNull()
    expect(result.usageStatus).toBe("rate_limited")
    expect(fetchOAuthUsage).not.toHaveBeenCalledWith("keychain-token")
  })
})

describe("createClaudeRefreshLoop multi-account", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readClaudeAccountCache).mockReturnValue(null)
    vi.mocked(readClaudeAccountKeyCacheEntry).mockReturnValue(null)
    vi.mocked(readOpenCodeAuthFrom).mockImplementation((p) => ({
      accessToken: p.endsWith("_auth.json") ? "tokB" : "tokA",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    }))
    vi.mocked(isTokenExpired).mockReturnValue(false)
    vi.mocked(fetchOAuthProfile).mockImplementation(async (t) =>
      t === "tokA"
        ? { email: "a@x.com", name: "Alice", plan: null }
        : { email: "b@x.com", name: "Bob", plan: null },
    )
  })

  it("renders one section per auth file labeled by display_name", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json", "/d/_auth.json"])
    vi.mocked(fetchOAuthUsage).mockImplementation(async (t) =>
      t === "tokA" ? { status: "ok", usage: USAGE } : { status: "ok", usage: USAGE },
    )

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    loop.stop()

    expect(captured.map((a) => a.label)).toEqual(["Claude (auth.json, Alic)", "Claude (_auth.json, Bob)"])
    expect(captured[0].data).not.toBeNull()
    expect(captured[1].data).not.toBeNull()
  })

  it("keeps a rate-limited account's own section without leaking another account's data", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json", "/d/_auth.json"])
    vi.mocked(fetchOAuthUsage).mockImplementation(async (t) =>
      t === "tokA" ? { status: "rate_limited" } : { status: "ok", usage: USAGE },
    )

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    loop.stop()

    const alice = captured.find((a) => a.label === "Claude (auth.json, Alic)")
    const bob = captured.find((a) => a.label === "Claude (_auth.json, Bob)")
    expect(alice?.data).toBeNull()
    expect(bob?.data).not.toBeNull()
  })

  it("honors Retry-After and does not re-query usage during the cooldown", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })
    vi.mocked(fetchOAuthUsage).mockClear()

    const loop = createClaudeRefreshLoop(() => {}, 30)
    loop.start()
    await new Promise((r) => setTimeout(r, 200))
    loop.stop()

    expect(vi.mocked(fetchOAuthUsage).mock.calls.length).toBe(1)
  })

  it("renders fresh auth-file cache without querying the usage endpoint", async () => {
    const cachedUsage: OAuthUsageResponse = {
      ...USAGE,
      fiveHour: { utilization: 77, resetsAt: null },
    }
    const cachedResult = {
      usage: cachedUsage,
      profile: { email: "a@x.com", name: "Alice", plan: null },
      authMethod: "oauth" as const,
      identity: "a@x.com",
      usageStatus: "ok" as const,
    }
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(readClaudeAccountKeyCacheEntry).mockReturnValue({ timestamp: Date.now(), result: cachedResult })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 30)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(77))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (auth.json, Alic)")
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("reuses a token cache when an account moves from auth.json to _auth.json and profile is unavailable", async () => {
    const cachedUsage: OAuthUsageResponse = {
      ...USAGE,
      fiveHour: { utilization: 64, resetsAt: null },
    }
    const cachedResult = {
      usage: cachedUsage,
      profile: { email: "b@x.com", name: "Bob", plan: null },
      authMethod: "oauth" as const,
      identity: "b@x.com",
      usageStatus: "ok" as const,
    }
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({
      accessToken: "tokB",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(readClaudeAccountKeyCacheEntry).mockImplementation((key) => (
      key.startsWith("token:") ? { timestamp: Date.now(), result: cachedResult } : null
    ))
    vi.mocked(fetchOAuthProfile).mockResolvedValue(null)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 30)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(64))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (_auth.json, Bob)")
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("reuses the previous auth.json path cache when the same token is now in _auth.json", async () => {
    const cachedUsage: OAuthUsageResponse = {
      ...USAGE,
      fiveHour: { utilization: 71, resetsAt: null },
    }
    const cachedResult = {
      usage: cachedUsage,
      profile: { email: "b@x.com", name: "Bob", plan: null },
      authMethod: "oauth" as const,
      identity: "b@x.com",
      usageStatus: "ok" as const,
    }
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({
      accessToken: "tokB",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    })
    let cacheReads = 0
    vi.mocked(readClaudeAccountKeyCacheEntry).mockImplementation(() => {
      cacheReads += 1
      return cacheReads % 3 === 0 ? { timestamp: Date.now(), result: cachedResult } : null
    })
    vi.mocked(fetchOAuthProfile).mockResolvedValue(null)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 30)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(71))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (_auth.json, Bob)")
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("does not re-query a successful account inside the minimum fetch interval", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 20)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data).not.toBeNull())
    await new Promise((r) => setTimeout(r, 120))
    loop.stop()

    expect(fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("does not reuse a previous account slot after auth.json switches accounts", async () => {
    const previousUsage: OAuthUsageResponse = {
      ...USAGE,
      fiveHour: { utilization: 88, resetsAt: null },
    }
    let token = "tokA"
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockImplementation(() => ({
      accessToken: token,
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    }))
    vi.mocked(fetchOAuthProfile).mockImplementation(async (t) =>
      t === "tokA"
        ? { email: "a@x.com", name: "Alice", plan: null }
        : { email: "b@x.com", name: "Bob", plan: null },
    )
    vi.mocked(fetchOAuthUsage).mockImplementation(async (t) =>
      t === "tokA"
        ? { status: "ok", usage: previousUsage }
        : { status: "rate_limited" },
    )

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 30)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(88))

    token = "tokB"
    await vi.waitFor(() => expect(captured[0]?.label).toBe("Claude (auth.json, Bob)"))
    loop.stop()

    expect(captured[0]?.data).toBeNull()
  })

  it("persists the rotated token and renders usage for an expired secondary _auth.json (S1)", async () => {
    const future = Date.now() + 3_600_000
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredB", refreshToken: "R", expiresAt: 1 })
    vi.mocked(isTokenExpired).mockReturnValue(true)
    vi.mocked(refreshToken).mockResolvedValue({
      accessToken: "freshB",
      refreshToken: "rotR",
      expiresAt: future,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(fetchOAuthProfile).mockResolvedValue({ email: "b@x.com", name: "Bob", plan: null })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(10))
    loop.stop()

    expect(writeOpenCodeAuthTo).toHaveBeenCalledWith("/d/_auth.json", { accessToken: "freshB", refreshToken: "rotR", expiresAt: future })
    expect(fetchOAuthUsage).toHaveBeenCalledWith("freshB")
    expect(fetchOAuthUsage).not.toHaveBeenCalledWith("expiredB")
  })

  it("shows not-configured without sending the expired token when secondary refresh fails (S2)", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredB", refreshToken: "R", expiresAt: 1 })
    vi.mocked(isTokenExpired).mockReturnValue(true)
    vi.mocked(refreshToken).mockResolvedValue(null)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.status).toBe("not-configured"))
    loop.stop()

    expect(fetchOAuthUsage).not.toHaveBeenCalled()
    expect(writeOpenCodeAuthTo).not.toHaveBeenCalled()
  })

  it("never refreshes, persists, or queries the expired primary auth.json (S3)", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredA", refreshToken: "R", expiresAt: 1 })
    vi.mocked(isTokenExpired).mockReturnValue(true)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    loop.stop()

    expect(refreshToken).not.toHaveBeenCalled()
    expect(writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("honors Retry-After under the rotated token key after a secondary rotation (S6)", async () => {
    let diskAuth = { accessToken: "rotExpired", refreshToken: "R", expiresAt: 1 }
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/rot/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockImplementation(() => ({ ...diskAuth }))
    vi.mocked(writeOpenCodeAuthTo).mockImplementation((_file, tokens) => {
      diskAuth = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }
    })
    vi.mocked(isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(refreshToken).mockResolvedValue({
      accessToken: "rotFresh",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(fetchOAuthProfile).mockResolvedValue({ email: "b@x.com", name: "Bob", plan: null })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })

    const loop = createClaudeRefreshLoop(() => {}, 20)
    loop.start()
    await new Promise((r) => setTimeout(r, 160))
    loop.stop()

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("honors Retry-After when the same account moves between auth.json and _auth.json (S7)", async () => {
    let files = ["/d/auth.json"]
    vi.mocked(listOpenCodeAuthFiles).mockImplementation(() => files)
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({ accessToken: "MOVE", refreshToken: "", expiresAt: Date.now() + 3_600_000 })
    vi.mocked(isTokenExpired).mockReturnValue(false)
    vi.mocked(fetchOAuthProfile).mockResolvedValue({ email: "m@x.com", name: "Mover", plan: null })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })

    const loop = createClaudeRefreshLoop(() => {}, 20)
    loop.start()
    await vi.waitFor(() => expect(vi.mocked(fetchOAuthUsage)).toHaveBeenCalledTimes(1))
    files = ["/d/_auth.json"]
    await new Promise((r) => setTimeout(r, 120))
    loop.stop()

    expect(fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("honors Retry-After after rotation even if the disk persist fails (S8)", async () => {
    vi.mocked(listOpenCodeAuthFiles).mockReturnValue(["/pf/_auth.json"])
    vi.mocked(readOpenCodeAuthFrom).mockReturnValue({ accessToken: "pfExpired", refreshToken: "R", expiresAt: 1 })
    vi.mocked(isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(writeOpenCodeAuthTo).mockImplementation(() => { throw new Error("disk full") })
    vi.mocked(refreshToken).mockResolvedValue({
      accessToken: "pfFresh",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(fetchOAuthProfile).mockResolvedValue({ email: "p@x.com", name: "PF", plan: null })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })

    const loop = createClaudeRefreshLoop(() => {}, 20)
    loop.start()
    await new Promise((r) => setTimeout(r, 160))
    loop.stop()

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })
})
