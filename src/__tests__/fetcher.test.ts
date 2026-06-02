import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../keychain.js", () => ({
  readKeychainCredentials: vi.fn(),
  readCredentialsFile: vi.fn(),
  readOpenCodeAuth: vi.fn(),
  readOpenCodeAuthFrom: vi.fn(),
  listOpenCodeAuthFiles: vi.fn(),
  refreshToken: vi.fn(),
  isTokenExpired: vi.fn(),
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
  writeClaudeAccountCache: vi.fn(),
}))

import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, readOpenCodeAuthFrom, listOpenCodeAuthFiles, refreshToken, isTokenExpired } from "../keychain.js"
import { fetchOAuthUsage, fetchOAuthProfile } from "../oauth-client.js"
import { extractSessionKey, fetchWebUsage } from "../cookie-reader.js"
import { detectClaude, probeCLIUsage, probeStatus } from "../cli-probe.js"
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
})
