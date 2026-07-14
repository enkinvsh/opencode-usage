import { describe, it, expect, vi, beforeEach } from "vitest"
import { snakeToCamel, fetchOAuthUsage, fetchOAuthProfile, extractScopedWindow } from "../oauth-client.js"
import type { OAuthLimit } from "../types.js"

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

  it("derives sevenDayFable from the weekly_scoped Fable entry in the limits array", async () => {
    // Real API shape: Fable appears ONLY in `limits`, not as a top-level seven_day_* key.
    const rawBody = JSON.stringify({
      five_hour: { utilization: 21, resets_at: "2026-07-14T10:19:59Z" },
      seven_day: { utilization: 81, resets_at: "2026-07-14T18:59:59Z" },
      seven_day_opus: null,
      seven_day_sonnet: null,
      limits: [
        { kind: "session", group: "session", percent: 21, severity: "normal", resets_at: "2026-07-14T10:19:59Z", scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 81, severity: "warning", resets_at: "2026-07-14T18:59:59Z", scope: null, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 99, severity: "critical", resets_at: "2026-07-14T18:59:59Z", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
      ],
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthUsage("valid-token")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.usage.sevenDayFable?.utilization).toBe(99)
      expect(result.usage.sevenDayFable?.resetsAt).toBe("2026-07-14T18:59:59Z")
    }
  })

  it("leaves sevenDayFable null when no Fable-scoped limit is present", async () => {
    const rawBody = JSON.stringify({
      five_hour: { utilization: 5, resets_at: "2026-07-14T10:19:59Z" },
      limits: [
        { kind: "session", group: "session", percent: 5, severity: "normal", resets_at: "2026-07-14T10:19:59Z", scope: null, is_active: false },
      ],
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthUsage("valid-token")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.usage.sevenDayFable).toBeNull()
    }
  })
})

describe("extractScopedWindow", () => {
  const fableLimit: OAuthLimit = {
    kind: "weekly_scoped", group: "weekly", percent: 99, severity: "critical",
    resetsAt: "2026-07-14T18:59:59Z",
    scope: { model: { id: null, displayName: "Fable" }, surface: null },
    isActive: true,
  }

  it("finds a scoped window by model display name, case-insensitively", () => {
    expect(extractScopedWindow([fableLimit], "fable")).toEqual({
      utilization: 99,
      resetsAt: "2026-07-14T18:59:59Z",
    })
  })

  it("returns null for a missing model, empty array, or null input", () => {
    expect(extractScopedWindow([fableLimit], "Opus")).toBeNull()
    expect(extractScopedWindow([], "Fable")).toBeNull()
    expect(extractScopedWindow(null, "Fable")).toBeNull()
    expect(extractScopedWindow(undefined, "Fable")).toBeNull()
  })

  it("coerces a non-numeric percent or missing resetsAt to null", () => {
    const partial: OAuthLimit = {
      ...fableLimit, percent: null, resetsAt: null,
    }
    expect(extractScopedWindow([partial], "Fable")).toEqual({ utilization: null, resetsAt: null })
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
