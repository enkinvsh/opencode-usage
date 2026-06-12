import { describe, it, expect, vi, beforeEach } from "vitest"
import { snakeToCamel, fetchOAuthUsage, fetchOAuthProfile } from "../oauth-client.js"

describe("snakeToCamel", () => {
  it("converts snake_case keys to camelCase", () => {
    const input = { five_hour: { utilization: 45, resets_at: "2026-05-01T00:00:00Z" } }
    const result = snakeToCamel(input) as any
    expect(result.fiveHour).toBeDefined()
    expect(result.fiveHour.utilization).toBe(45)
    expect(result.fiveHour.resetsAt).toBe("2026-05-01T00:00:00Z")
  })

  it("handles nested objects", () => {
    const input = { extra_usage: { is_enabled: true, monthly_limit: 50000 } }
    const result = snakeToCamel(input) as any
    expect(result.extraUsage.isEnabled).toBe(true)
    expect(result.extraUsage.monthlyLimit).toBe(50000)
  })
})

describe("fetchOAuthUsage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  it("returns auth_failed on 401 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    expect(await fetchOAuthUsage("invalid-token")).toEqual({ status: "auth_failed" })
  })

  it("returns auth_failed on 403 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }))
    expect(await fetchOAuthUsage("scope-missing-token")).toEqual({ status: "auth_failed" })
  })

  it("returns rate_limited without retryAfterMs when 429 has no retry-after header", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 429 }))
    expect(await fetchOAuthUsage("rate-limited-token")).toEqual({ status: "rate_limited" })
  })

  it("preserves retry-after: 0 as retryAfterMs 0 (immediate-retry hint)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
    expect(await fetchOAuthUsage("rate-limited-token")).toEqual({ status: "rate_limited", retryAfterMs: 0 })
  })

  it("converts a positive retry-after to milliseconds", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "30" } }))
    expect(await fetchOAuthUsage("rate-limited-token")).toEqual({ status: "rate_limited", retryAfterMs: 30_000 })
  })

  it("parses valid usage response with snake_case conversion", async () => {
    const rawBody = JSON.stringify({
      five_hour: { utilization: 45, resets_at: "2026-05-01T12:00:00Z" },
      seven_day: { utilization: 62, resets_at: "2026-05-05T00:00:00Z" },
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthUsage("valid-token")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.usage.fiveHour?.utilization).toBe(45)
      expect(result.usage.sevenDay?.utilization).toBe(62)
    }
  })
})

describe("fetchOAuthProfile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  it("extracts email and display name from the nested account object", async () => {
    const rawBody = JSON.stringify({
      account: { email: "primary@example.com", display_name: "Primary", full_name: "Primary Example" },
      organization: { organization_type: "claude_max" },
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthProfile("valid-token")
    expect(result?.email).toBe("primary@example.com")
    expect(result?.name).toBe("Primary")
    expect(result?.plan).toBe("claude_max")
  })

  it("returns null when the account has no email", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ organization: {} }), { status: 200 }))
    expect(await fetchOAuthProfile("token")).toBeNull()
  })

  it("returns null on 401", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    expect(await fetchOAuthProfile("token")).toBeNull()
  })
})
