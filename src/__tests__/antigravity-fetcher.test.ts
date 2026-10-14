import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../cache.js", () => ({
  readNamespacedCacheEntry: vi.fn(() => null),
  writeNamespacedCache: vi.fn(),
  tryAcquireFetchLock: vi.fn(() => true),
  releaseFetchLock: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

import { execFile } from "node:child_process"
import { readNamespacedCacheEntry } from "../cache.js"
import {
  ANTIGRAVITY_QUOTA_HOSTS,
  ANTIGRAVITY_USER_AGENT,
  accountIdFromFile,
  aggregatePool,
  buildRemoteScript,
  createAntigravityRefreshLoop,
  fetchAntigravityPool,
  parseAccountLines,
  parseQuotaSummary,
} from "../antigravity-fetcher.js"
import type { AntigravityAccount, AntigravityPool, AntigravityState } from "../types"

const realPayload = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-10-14T23:38:12Z", description: "...", remainingFraction: 0.97068536 },
        { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-10-13T21:00:14Z", description: "...", remainingFraction: 0.9884768 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "...",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-18T12:30:02Z", remainingFraction: 0.00932064 },
        { bucketId: "3p-5h", window: "5h", resetTime: "2026-10-13T21:54:17Z", remainingFraction: 1 },
      ],
    },
  ],
  description: "Within each group, models share a weekly limit and a 5-hour limit...",
}

describe("parseQuotaSummary", () => {
  it("maps the gemini group of the real payload", () => {
    const q = parseQuotaSummary(realPayload)
    expect(q?.groupName).toBe("Gemini Models")
    expect(q?.fiveHour?.usedPercent).toBeCloseTo(1.15, 2)
    expect(q?.weekly?.usedPercent).toBeCloseTo(2.93, 2)
    expect(q?.fiveHour?.resetAt).toBe("2026-10-13T21:00:14Z")
    expect(q?.weekly?.resetAt).toBe("2026-10-14T23:38:12Z")
  })

  it("treats a bucket with resetTime but no remainingFraction as 100% used", () => {
    const q = parseQuotaSummary({
      groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-13T21:00:14Z" }] }],
    })
    expect(q?.fiveHour?.usedPercent).toBe(100)
    expect(q?.weekly).toBeNull()
  })

  it.each([
    ["null", null],
    ["string", "garbage"],
    ["no groups", { description: "x" }],
    ["no gemini group", { groups: [realPayload.groups[1]] }],
    ["gemini group without usable buckets", { groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h" }] }] }],
  ])("returns null for %s", (_name, raw) => {
    expect(parseQuotaSummary(raw)).toBeNull()
  })
})

describe("buildRemoteScript", () => {
  const poolScript = buildRemoteScript({ dir: "/opt/x/cli-proxy-api" })

  it("tries all hosts in order with the Antigravity UA", () => {
    expect(poolScript).toContain(`for h in ${ANTIGRAVITY_QUOTA_HOSTS.join(" ")}; do`)
    expect(poolScript).toContain(`-A '${ANTIGRAVITY_USER_AGENT}'`)
    expect(poolScript).toContain("-H @-")
  })

  it("keeps the token off the curl argv", () => {
    for (const line of poolScript.split("\n")) {
      const curlPart = line.split("| curl")[1]
      if (curlPart !== undefined) expect(curlPart).not.toContain("$tok")
    }
    expect(poolScript).toContain(`printf 'Authorization: Bearer %s\\n' "$tok"`)
  })

  it("globs antigravity-*.json outside the quoted pool dir", () => {
    expect(poolScript).toContain(`for f in '/opt/x/cli-proxy-api'/antigravity-*.json; do`)
  })

  it("queries accounts in parallel and waits for all of them", () => {
    expect(poolScript).toMatch(/\) > "\$t\/\$i" &$/m)
    expect(poolScript).toMatch(/^wait$/m)
  })

  it("single-quotes a single auth file containing a quote", () => {
    expect(buildRemoteScript({ file: "/tmp/it's.json" })).toContain(`for f in '/tmp/it'\\''s.json'; do`)
  })
})

describe("accountIdFromFile", () => {
  it.each([
    ["antigravity-ultra-acct@example.com.json", "ultra-acct"],
    ["/opt/x/antigravity-acct-zeta@example.com.json", "acct-zeta"],
    ["custom.json", "custom"],
  ])("%s -> %s", (file, id) => {
    expect(accountIdFromFile(file)).toBe(id)
  })
})

describe("parseAccountLines", () => {
  it("parses one JSON line per account, sorted by id, ignoring junk", () => {
    const stdout = [
      JSON.stringify({ id: "antigravity-ultra-acct@example.com.json", quota: realPayload }),
      "Warning: something on stdout",
      JSON.stringify({ id: "antigravity-acct-beta@example.com.json", quota: null }),
      "",
    ].join("\n")
    const accounts = parseAccountLines(stdout)
    expect(accounts.map((a) => a.id)).toEqual(["acct-beta", "ultra-acct"])
    expect(accounts[0].quota).toBeNull()
    expect(accounts[1].quota?.groupName).toBe("Gemini Models")
  })
})

const win = (usedPercent: number | null, resetAt: string | null = null) => ({ usedPercent, resetAt })
const acc = (id: string, fiveHour: ReturnType<typeof win> | null, weekly: ReturnType<typeof win> | null): AntigravityAccount => ({
  id,
  quota: { groupName: "Gemini Models", fiveHour, weekly },
})

describe("aggregatePool", () => {
  it("sums remaining quota in account-equivalents", () => {
    const pool = aggregatePool([
      acc("a", win(4), win(2, "2026-10-21T04:17:02Z")),
      acc("b", win(6), win(2, "2026-10-21T05:00:05Z")),
      acc("c", win(4), win(3, "2026-10-21T05:00:06Z")),
      acc("d", win(2), win(55, "2026-10-14T23:38:12Z")),
    ])
    expect(pool.weekly?.remainingAccounts).toBeCloseTo(3.38, 2)
    expect(pool.weekly?.counted).toBe(4)
    expect(pool.weekly?.usedPercent).toBeCloseTo(15.5, 1)
    expect(pool.fiveHour?.remainingAccounts).toBeCloseTo(3.84, 2)
    expect(pool.exhausted).toBe(0)
  })

  it("takes the earliest reset among used accounts, skipping untouched ones", () => {
    const pool = aggregatePool([
      acc("a", win(0, "2026-10-14T09:00:00Z"), null),
      acc("b", win(10, "2026-10-14T11:00:00Z"), null),
      acc("c", win(20, "2026-10-14T10:00:00Z"), null),
    ])
    expect(pool.fiveHour?.nextResetAt).toBe("2026-10-14T10:00:00Z")
  })

  it("prefers the earliest reset among exhausted accounts", () => {
    const pool = aggregatePool([
      acc("a", win(50, "2026-10-14T09:00:00Z"), win(10)),
      acc("b", win(100, "2026-10-14T12:00:00Z"), win(10)),
      acc("c", win(100, "2026-10-14T11:00:00Z"), win(10)),
    ])
    expect(pool.fiveHour?.nextResetAt).toBe("2026-10-14T11:00:00Z")
    expect(pool.exhausted).toBe(2)
  })

  it("counts an account as exhausted when either window is used up", () => {
    const pool = aggregatePool([acc("a", win(10), win(100)), acc("b", win(10), win(10))])
    expect(pool.exhausted).toBe(1)
  })

  it("has no reset when nothing has been used", () => {
    expect(aggregatePool([acc("a", win(0, "2026-10-14T09:00:00Z"), null)]).fiveHour?.nextResetAt).toBeNull()
  })

  it("leaves failed accounts out of the sums but keeps them in the list", () => {
    const pool = aggregatePool([acc("a", win(50), win(20)), { id: "b", quota: null }])
    expect(pool.accounts).toHaveLength(2)
    expect(pool.fiveHour?.counted).toBe(1)
    expect(pool.fiveHour?.remainingAccounts).toBeCloseTo(0.5, 5)
  })

  it("returns null windows when no account reports them", () => {
    const pool = aggregatePool([acc("a", win(5), null)])
    expect(pool.weekly).toBeNull()
  })
})

describe("fetchAntigravityPool", () => {
  const line = (file: string, quota: unknown) => JSON.stringify({ id: file, quota })

  it("aggregates the runner output", async () => {
    const out = [line("antigravity-a@x.json", realPayload), line("antigravity-b@x.json", realPayload)].join("\n")
    const pool = await fetchAntigravityPool("h", { dir: "/d" }, async () => out)
    expect(pool?.accounts.map((a) => a.id)).toEqual(["a", "b"])
    expect(pool?.weekly?.remainingAccounts).toBeCloseTo(2 * 0.97068536, 5)
  })

  it("returns null when no account produced a quota", async () => {
    expect(await fetchAntigravityPool("h", { dir: "/d" }, async () => line("antigravity-a@x.json", null))).toBeNull()
  })

  it("returns null when the runner rejects", async () => {
    expect(await fetchAntigravityPool("h", { dir: "/d" }, async () => { throw new Error("ssh exit 255") })).toBeNull()
  })

  it("returns null on non-JSON output", async () => {
    expect(await fetchAntigravityPool("h", { dir: "/d" }, async () => "<html>")).toBeNull()
  })
})

describe("createAntigravityRefreshLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reports not-configured without an auth dir or file", () => {
    const states: AntigravityState[] = []
    const loop = createAntigravityRefreshLoop((s) => states.push(s), 60_000, { sshHost: "sandbox" })
    loop.start()
    loop.stop()
    expect(states).toEqual([{ status: "not-configured", data: null, stale: false, error: null }])
    expect(execFile).not.toHaveBeenCalled()
  })

  it("shows stale cached data when the fetch fails", async () => {
    const cached: AntigravityPool = aggregatePool([acc("a", win(5), null)])
    vi.mocked(readNamespacedCacheEntry).mockReturnValue({ timestamp: Date.now() - 10 * 60_000, result: cached })
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error("ssh failed"), "")
    }) as unknown as typeof execFile)

    const states: AntigravityState[] = []
    const loop = createAntigravityRefreshLoop((s) => states.push(s), 60_000, { sshHost: "sandbox", authDir: "/d" })
    loop.start()
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0))
    loop.stop()
    expect(states.at(-1)).toEqual({ status: "success", data: cached, stale: true, error: null })
  })

  it("prefers the pool dir over a single auth file", async () => {
    vi.mocked(readNamespacedCacheEntry).mockReturnValue(null)
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error("ssh failed"), "")
    }) as unknown as typeof execFile)

    const states: AntigravityState[] = []
    const loop = createAntigravityRefreshLoop((s) => states.push(s), 60_000, { sshHost: "sandbox", authDir: "/d", authFile: "/f.json" })
    loop.start()
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("error"))
    loop.stop()
    const script = vi.mocked(execFile).mock.calls[0][1]?.at(-1)
    expect(script).toContain(`for f in '/d'/antigravity-*.json; do`)
  })
})
