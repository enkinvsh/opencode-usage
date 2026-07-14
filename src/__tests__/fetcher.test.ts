import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { OAuthUsageResponse, ClaudeAccount, ProfileResponse } from "../types.js"

// The cache module is intentionally NOT mocked: these tests run against the real
// disk cache (in a temp XDG_CACHE_HOME) to verify the cross-process single-flight
// behavior — shared cache entries, shared cooldowns, and fetch locks.
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

const USAGE: OAuthUsageResponse = {
  fiveHour: { utilization: 10, resetsAt: null },
  sevenDay: null,
  sevenDayFable: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  sevenDayDesign: null,
  sevenDayRoutines: null,
  sevenDayOAuthApps: null,
  extraUsage: null,
}

function usageAt(utilization: number): OAuthUsageResponse {
  return { ...USAGE, fiveHour: { utilization, resetsAt: null } }
}

function tokenHashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32)
}

interface StoredAccount {
  usage: OAuthUsageResponse
  profile: ProfileResponse | null
  identity: string | null
  authMethod: string
  tokenHash: string | null
}

let tmpCacheDir: string
let keychain: typeof import("../keychain.js")
let oauthClient: typeof import("../oauth-client.js")
let cookieReader: typeof import("../cookie-reader.js")
let cliProbe: typeof import("../cli-probe.js")
let fetcher: typeof import("../fetcher.js")

function writeRawCache(data: unknown): void {
  const dir = join(tmpCacheDir, "opencode-usage")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "last.json"), JSON.stringify(data), "utf8")
}

function storedEntry(timestamp: number, result: StoredAccount) {
  return { timestamp, result }
}

beforeEach(async () => {
  tmpCacheDir = mkdtempSync(join(tmpdir(), "fetcher-test-"))
  process.env.XDG_CACHE_HOME = tmpCacheDir
  vi.resetModules()
  keychain = await import("../keychain.js")
  oauthClient = await import("../oauth-client.js")
  cookieReader = await import("../cookie-reader.js")
  cliProbe = await import("../cli-probe.js")
  fetcher = await import("../fetcher.js")

  vi.clearAllMocks()
  vi.mocked(keychain.isPrimaryAuthFile).mockImplementation((p: string) => p.endsWith("/auth.json"))
  vi.mocked(keychain.readKeychainCredentials).mockResolvedValue(null)
  vi.mocked(keychain.readCredentialsFile).mockReturnValue(null)
  vi.mocked(keychain.readOpenCodeAuth).mockReturnValue(null)
  vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue(null)
  vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue([])
  vi.mocked(keychain.refreshToken).mockResolvedValue(null)
  vi.mocked(keychain.isTokenExpired).mockReturnValue(false)
  vi.mocked(keychain.writeOpenCodeAuthTo).mockReturnValue(true)
  vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "auth_failed" })
  vi.mocked(oauthClient.fetchOAuthProfile).mockResolvedValue(null)
  vi.mocked(cookieReader.extractSessionKey).mockResolvedValue(null)
  vi.mocked(cookieReader.fetchWebUsage).mockResolvedValue(null)
  vi.mocked(cliProbe.detectClaude).mockResolvedValue(false)
  vi.mocked(cliProbe.probeCLIUsage).mockResolvedValue(null)
  vi.mocked(cliProbe.probeStatus).mockResolvedValue(null)
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.OPENCODE_USAGE_RETRY_DELAY_MS = "10"
})

afterEach(() => {
  rmSync(tmpCacheDir, { recursive: true, force: true })
  delete process.env.XDG_CACHE_HOME
  delete process.env.OPENCODE_USAGE_RETRY_DELAY_MS
})

describe("fetchUsageData fallback chain", () => {
  it("returns authMethod none when all methods fail", async () => {
    const result = await fetcher.fetchUsageData()
    expect(result.authMethod).toBe("none")
    expect(result.usage).toBeNull()
  })

  it("uses CLI probe when claude is installed", async () => {
    vi.mocked(cliProbe.detectClaude).mockResolvedValue(true)
    vi.mocked(cliProbe.probeCLIUsage).mockResolvedValue({
      sessionPercent: 45,
      weeklyPercent: 62,
      opusPercent: null,
      sonnetPercent: null,
      sessionReset: "Resets5pm(Asia/Seoul)",
      weeklyReset: "ResetsMay2at7pm(Asia/Seoul)",
      email: null,
      org: null,
    })
    vi.mocked(cliProbe.probeStatus).mockResolvedValue({ email: "test@example.com", org: null })

    const result = await fetcher.fetchUsageData()
    expect(result.authMethod).toBe("cli")
    expect(result.usage?.fiveHour?.utilization).toBe(45)
    expect(result.profile?.email).toBe("test@example.com")
  })

  it("skips OAuth when hasProfileScope is false", async () => {
    vi.mocked(keychain.readKeychainCredentials).mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })

    await fetcher.fetchUsageData()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("prefers OpenCode auth.json over env var and credentials file", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token"
    vi.mocked(keychain.readCredentialsFile).mockReturnValue({
      accessToken: "file-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(keychain.readOpenCodeAuth).mockReturnValue({
      accessToken: "opencode-token",
      refreshToken: "opencode-refresh",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { status: "ok", usage: USAGE }
        : { status: "auth_failed" },
    )

    const result = await fetcher.fetchUsageData()

    expect(result.authMethod).toBe("oauth")
    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledWith("opencode-token")
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalledWith("env-token")
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalledWith("file-token")
  })

  it("never refreshes or queries usage for an expired primary auth.json (fallback path)", async () => {
    vi.mocked(keychain.readOpenCodeAuth).mockReturnValue({
      accessToken: "expired-primary",
      refreshToken: "opencode-refresh",
      expiresAt: 1,
    })
    vi.mocked(keychain.isTokenExpired).mockReturnValue(true)
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    const result = await fetcher.fetchUsageData()

    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
    expect(result.usage).toBeNull()
    expect(result.usageStatus).toBe("unavailable")
  })

  it("does not fall through to a different account when OpenCode usage is rate limited", async () => {
    vi.mocked(keychain.readOpenCodeAuth).mockReturnValue({
      accessToken: "opencode-token",
      refreshToken: "opencode-refresh",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(keychain.readKeychainCredentials).mockResolvedValue({
      accessToken: "keychain-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(oauthClient.fetchOAuthProfile).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { email: "primary@example.com", name: "Primary", plan: null }
        : { email: "secondary@example.com", name: "Secondary", plan: null },
    )
    vi.mocked(oauthClient.fetchOAuthUsage).mockImplementation(async (token) =>
      token === "opencode-token"
        ? { status: "rate_limited" }
        : { status: "ok", usage: USAGE },
    )

    const result = await fetcher.fetchUsageData()

    expect(result.identity).toBe("primary@example.com")
    expect(result.usage).toBeNull()
    expect(result.usageStatus).toBe("rate_limited")
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalledWith("keychain-token")
  })
})

describe("createClaudeRefreshLoop (shared disk cache + single-flight)", () => {
  beforeEach(() => {
    vi.mocked(keychain.readOpenCodeAuthFrom).mockImplementation((p) => ({
      accessToken: p.endsWith("_auth.json") ? "tokB" : "tokA",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    }))
    vi.mocked(oauthClient.fetchOAuthProfile).mockImplementation(async (t) =>
      t === "tokA"
        ? { email: "a@x.com", name: "Alice", plan: null }
        : { email: "b@x.com", name: "Bob", plan: null },
    )
  })

  it("renders one section per auth file labeled by display_name", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json", "/d/_auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    loop.stop()

    expect(captured.map((a) => a.label)).toEqual(["Claude (auth.json, Alic)", "Claude (_auth.json, Bob)"])
    expect(captured[0].data).not.toBeNull()
    expect(captured[1].data).not.toBeNull()
  })

  it("keeps a rate-limited account's own section without leaking another account's data", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json", "/d/_auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockImplementation(async (t) =>
      t === "tokA" ? { status: "rate_limited" } : { status: "ok", usage: USAGE },
    )

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    loop.stop()

    const alice = captured.find((a) => a.label === "Claude (auth.json, Alic)")
    const bob = captured.find((a) => a.label === "Claude (_auth.json, Bob)")
    expect(alice?.data).toBeNull()
    expect(bob?.data).not.toBeNull()
  })

  it("retries through transient 429 (retry-after: 0) and renders fresh data", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage)
      .mockResolvedValueOnce({ status: "rate_limited", retryAfterMs: 0 })
      .mockResolvedValueOnce({ status: "rate_limited", retryAfterMs: 0 })
      .mockResolvedValue({ status: "ok", usage: usageAt(42) })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(42))
    loop.stop()

    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(3)
  })

  it("gives up after bounded retries on persistent retry-after: 0 and applies a short cooldown", async () => {
    const cache = await import("../cache.js")
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 0 })

    const before = Date.now()
    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    loop.stop()

    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(7)
    const cooldownUntil = cache.readCooldown(`claude:${tokenHashOf("tokA")}`)
    expect(cooldownUntil).toBeGreaterThan(before)
    expect(cooldownUntil).toBeLessThanOrEqual(Date.now() + 20_000)
  })

  it("does not inline-retry a 429 without a retry-after hint and applies the long cooldown", async () => {
    const cache = await import("../cache.js")
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })

    const before = Date.now()
    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    loop.stop()

    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(1)
    expect(cache.readCooldown(`claude:${tokenHashOf("tokA")}`)).toBeGreaterThanOrEqual(before + 120_000)
  })

  it("honors Retry-After via the shared cooldown and does not re-query during it", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })

    const loop = fetcher.createClaudeRefreshLoop(() => {}, 60)
    loop.start()
    await new Promise((r) => setTimeout(r, 250))
    loop.stop()

    expect(vi.mocked(oauthClient.fetchOAuthUsage).mock.calls.length).toBe(1)
  })

  it("renders a fresh disk cache entry without querying the usage endpoint", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now(), {
          usage: usageAt(77),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokA"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(77))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (auth.json, Alic)")
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("follows an account that moved between auth.json and _auth.json via its token hash", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    // Bob's data was cached while his token lived in auth.json; now the file is _auth.json.
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now(), {
          usage: usageAt(64),
          profile: { email: "b@x.com", name: "Bob", plan: null },
          identity: "b@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokB"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(64))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (_auth.json, Bob)")
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("fetches once per refresh interval even with a fast render tick", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 400)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data).not.toBeNull())
    await new Promise((r) => setTimeout(r, 280))
    loop.stop()

    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("does not reuse cached data after auth.json switches to a different account", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({
      accessToken: "tokB",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    })
    // Stale cache from the PREVIOUS account (Alice) that owned auth.json.
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(88),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokA"),
        }),
      },
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.label).toBe("Claude (auth.json, Bob)"))
    loop.stop()

    expect(captured[0]?.data).toBeNull()
  })

  it("keeps last known data across a routine token rotation when the fetch fails", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    // Cache was written under the OLD token, identity unchanged (OpenCode rotated tokens).
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(55),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokOld"),
        }),
      },
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "unavailable" })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(55))
    loop.stop()

    expect(captured[0]?.status).toBe("success")
  })

  it("renders cached usage as stale for an expired secondary _auth.json WITHOUT refreshing or writing (S1)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredB", refreshToken: "R", expiresAt: 1 })
    vi.mocked(keychain.isTokenExpired).mockImplementation((exp) => exp <= 1)
    // A refresh WOULD succeed if attempted — the point is that it must NOT be attempted.
    vi.mocked(keychain.refreshToken).mockResolvedValue({
      accessToken: "freshB",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })
    // Last-known usage cached under this exact (now-expired) token: trusted but stale.
    writeRawCache({
      claudeFiles: {
        "_auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(64),
          profile: { email: "b@x.com", name: "Bob", plan: null },
          identity: "b@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("expiredB"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(64))
    loop.stop()

    expect(captured[0]?.status).toBe("success")
    expect(captured[0]?.stale).toBe(true)
    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(keychain.writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("renders untrusted own cache as stale for an expired secondary _auth.json without refreshing (S-A2)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredB", refreshToken: "R", expiresAt: 1 })
    vi.mocked(keychain.isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(keychain.refreshToken).mockResolvedValue({
      accessToken: "freshB",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })
    // Cache written under a DIFFERENT (already rotated) token: own entry, hash mismatch ⇒ untrusted.
    writeRawCache({
      claudeFiles: {
        "_auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(71),
          profile: { email: "b@x.com", name: "Bob", plan: null },
          identity: "b@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("someOldTokenB"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(71))
    loop.stop()

    expect(captured[0]?.stale).toBe(true)
    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(keychain.writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("shows not-configured for an expired secondary with no cache, never refreshing or fetching (S2)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredB", refreshToken: "R", expiresAt: 1 })
    vi.mocked(keychain.isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(keychain.refreshToken).mockResolvedValue({
      accessToken: "freshB",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.status).toBe("not-configured"))
    loop.stop()

    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(keychain.writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("never refreshes/persists/queries an expired primary auth.json and hides its mismatched cache (S3)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "expiredA", refreshToken: "R", expiresAt: 1 })
    vi.mocked(keychain.isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })
    // A cache from a DIFFERENT token (account swap) must never be shown for the primary file.
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(88),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokOld"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    loop.stop()

    expect(captured[0]?.data).toBeNull()
    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(keychain.writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("never refreshes or writes an expired secondary across fast ticks, rendering cached usage (S8)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/pf/_auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "pfExpired", refreshToken: "R", expiresAt: 1 })
    vi.mocked(keychain.isTokenExpired).mockImplementation((exp) => exp <= 1)
    vi.mocked(keychain.refreshToken).mockResolvedValue({
      accessToken: "pfFresh",
      refreshToken: "rotR",
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })
    writeRawCache({
      claudeFiles: {
        "_auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(48),
          profile: { email: "p@x.com", name: "PF", plan: null },
          identity: "p@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("pfExpired"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60)
    loop.start()
    await new Promise((r) => setTimeout(r, 250))
    loop.stop()

    expect(captured[0]?.data?.fiveHour?.utilization).toBe(48)
    expect(captured[0]?.stale).toBe(true)
    expect(keychain.refreshToken).not.toHaveBeenCalled()
    expect(keychain.writeOpenCodeAuthTo).not.toHaveBeenCalled()
    expect(oauthClient.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("refetches immediately when auth.json holds a different account despite a fresh cache", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({
      accessToken: "tokB",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    })
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now(), {
          usage: usageAt(88),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokA"),
        }),
      },
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: usageAt(33) })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(33))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude (auth.json, Bob)")
    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("re-attributes rotated-token data so cooldown ticks keep showing it", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    writeRawCache({
      claudeFiles: {
        "auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(55),
          profile: { email: "a@x.com", name: "Alice", plan: null },
          identity: "a@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("tokOld"),
        }),
      },
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 999_999 })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(55))
    await new Promise((r) => setTimeout(r, 150))
    loop.stop()

    expect(captured[0]?.data?.fiveHour?.utilization).toBe(55)
    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("does not show stale own cache for a VALID secondary whose account changed (stale is expired-only)", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/_auth.json"])
    // _auth.json now holds a DIFFERENT, still-valid account token.
    vi.mocked(keychain.readOpenCodeAuthFrom).mockReturnValue({ accessToken: "newAcct", refreshToken: "", expiresAt: Date.now() + 3_600_000 })
    vi.mocked(oauthClient.fetchOAuthProfile).mockResolvedValue({ email: "new@x.com", name: "New", plan: null })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "rate_limited" })
    // Stale own cache belongs to the PREVIOUS _auth.json account; identity must gate it.
    writeRawCache({
      claudeFiles: {
        "_auth.json": storedEntry(Date.now() - 10 * 60_000, {
          usage: usageAt(91),
          profile: { email: "old@x.com", name: "Old", plan: null },
          identity: "old@x.com",
          authMethod: "oauth",
          tokenHash: tokenHashOf("oldAcct"),
        }),
      },
    })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.label).toBe("Claude (_auth.json, New)"))
    loop.stop()

    expect(captured[0]?.data).toBeNull()
  })

  it("lets concurrent loops (multiple TUI processes) share a single fetch", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue(["/d/auth.json"])
    vi.mocked(oauthClient.fetchOAuthUsage).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return { status: "ok", usage: USAGE }
    })

    let capturedA: ClaudeAccount[] = []
    let capturedB: ClaudeAccount[] = []
    const loopA = fetcher.createClaudeRefreshLoop((a) => { capturedA = a }, 400)
    const loopB = fetcher.createClaudeRefreshLoop((a) => { capturedB = a }, 400)
    loopA.start()
    loopB.start()
    await vi.waitFor(() => {
      expect(capturedA[0]?.data?.fiveHour?.utilization).toBe(10)
      expect(capturedB[0]?.data?.fiveHour?.utilization).toBe(10)
    })
    loopA.stop()
    loopB.stop()

    expect(oauthClient.fetchOAuthUsage).toHaveBeenCalledTimes(1)
  })

  it("renders the legacy single-account section when no auth files exist", async () => {
    vi.mocked(keychain.listOpenCodeAuthFiles).mockReturnValue([])
    vi.mocked(keychain.readOpenCodeAuth).mockReturnValue({
      accessToken: "opencode-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    })
    vi.mocked(oauthClient.fetchOAuthUsage).mockResolvedValue({ status: "ok", usage: USAGE })

    let captured: ClaudeAccount[] = []
    const loop = fetcher.createClaudeRefreshLoop((a) => { captured = a }, 60_000)
    loop.start()
    await vi.waitFor(() => expect(captured[0]?.data?.fiveHour?.utilization).toBe(10))
    loop.stop()

    expect(captured[0]?.label).toBe("Claude")
    expect(captured[0]?.status).toBe("success")
  })
})
