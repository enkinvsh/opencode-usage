import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let tmpCacheDir: string

beforeEach(() => {
  tmpCacheDir = mkdtempSync(join(tmpdir(), "cache-test-"))
  process.env.XDG_CACHE_HOME = tmpCacheDir
  vi.resetModules()
})

afterEach(() => {
  rmSync(tmpCacheDir, { recursive: true, force: true })
  delete process.env.XDG_CACHE_HOME
})

describe("readNamespacedCache / writeNamespacedCache", () => {
  it("returns null when no cache file exists", async () => {
    const { readNamespacedCache } = await import("../cache.js")
    expect(readNamespacedCache("claude")).toBeNull()
    expect(readNamespacedCache("codex")).toBeNull()
  })

  it("writes claude namespace and reads it back", async () => {
    const { readNamespacedCache, writeNamespacedCache } = await import("../cache.js")
    const payload = { foo: "bar" }
    writeNamespacedCache("claude", payload)
    expect(readNamespacedCache<typeof payload>("claude")).toEqual(payload)
  })

  it("writes codex without disturbing existing claude entry", async () => {
    const { readNamespacedCache, writeNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("claude", { side: "claude" })
    writeNamespacedCache("codex", { side: "codex" })
    expect(readNamespacedCache<{ side: string }>("claude")?.side).toBe("claude")
    expect(readNamespacedCache<{ side: string }>("codex")?.side).toBe("codex")
  })

  it("exposes the entry timestamp so callers can decide freshness", async () => {
    const { readNamespacedCacheEntry, writeNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("codex", { x: 1 })
    const entry = readNamespacedCacheEntry<{ x: number }>("codex")
    expect(entry?.result.x).toBe(1)
    expect(typeof entry?.timestamp).toBe("number")
  })

  it("keeps entries readable past short intervals (no aggressive max-age)", async () => {
    const { readNamespacedCache, writeNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("claude", { x: 1 })
    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValue(Date.now() + 60 * 60 * 1000) // 1h later: still displayable
    expect(readNamespacedCache("claude")).toEqual({ x: 1 })
    nowSpy.mockRestore()
  })

  it("drops entries older than the display max age (24h)", async () => {
    const { readNamespacedCache, writeNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("claude", { x: 1 })
    const nowSpy = vi.spyOn(Date, "now")
    nowSpy.mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    expect(readNamespacedCache("claude")).toBeNull()
    nowSpy.mockRestore()
  })

  it("returns null when cache file contains malformed JSON", async () => {
    const { writeNamespacedCache, readNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("claude", { ok: true })
    const cacheFile = join(tmpCacheDir, "opencode-usage", "last.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(cacheFile, "not-json{", { encoding: "utf8" })
    expect(readNamespacedCache("claude")).toBeNull()
  })

  it("returns null when namespace entry has null result", async () => {
    const { writeNamespacedCache, readNamespacedCache } = await import("../cache.js")
    writeNamespacedCache("codex", null)
    expect(readNamespacedCache("codex")).toBeNull()
  })
})

describe("readClaudeFileEntry / writeClaudeFileCache", () => {
  it("stores entries keyed by auth file basename", async () => {
    const { readClaudeFileEntry, writeClaudeFileCache } = await import("../cache.js")
    writeClaudeFileCache("auth.json", { session: 81 })
    writeClaudeFileCache("_auth.json", { session: 12 })
    expect(readClaudeFileEntry<{ session: number }>("auth.json")?.result.session).toBe(81)
    expect(readClaudeFileEntry<{ session: number }>("_auth.json")?.result.session).toBe(12)
  })

  it("returns entries with timestamps", async () => {
    const { readClaudeFileEntry, writeClaudeFileCache } = await import("../cache.js")
    writeClaudeFileCache("auth.json", { session: 81 })
    const entry = readClaudeFileEntry<{ session: number }>("auth.json")
    expect(entry?.result.session).toBe(81)
    expect(typeof entry?.timestamp).toBe("number")
  })

  it("returns null for an unknown auth file", async () => {
    const { readClaudeFileEntry } = await import("../cache.js")
    expect(readClaudeFileEntry("auth.json")).toBeNull()
  })
})

describe("cooldowns", () => {
  it("stores and reads a cooldown deadline", async () => {
    const { readCooldown, writeCooldown } = await import("../cache.js")
    const until = Date.now() + 60_000
    writeCooldown("claude:abc", until)
    expect(readCooldown("claude:abc")).toBe(until)
  })

  it("returns 0 for unknown keys", async () => {
    const { readCooldown } = await import("../cache.js")
    expect(readCooldown("nope")).toBe(0)
  })

  it("prunes expired cooldowns on write", async () => {
    const { readCooldown, writeCooldown } = await import("../cache.js")
    writeCooldown("old", Date.now() - 1000)
    writeCooldown("new", Date.now() + 60_000)
    expect(readCooldown("old")).toBe(0)
  })

  it("does not disturb cache entries when writing cooldowns", async () => {
    const { writeNamespacedCache, readNamespacedCache, writeCooldown } = await import("../cache.js")
    writeNamespacedCache("codex", { x: 1 })
    writeCooldown("claude:abc", Date.now() + 1000)
    expect(readNamespacedCache("codex")).toEqual({ x: 1 })
  })
})

describe("fetch locks (cross-process single-flight)", () => {
  it("grants the lock to the first caller only", async () => {
    const { tryAcquireFetchLock, releaseFetchLock } = await import("../cache.js")
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(true)
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(false)
    releaseFetchLock("claude-auth.json")
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(true)
    releaseFetchLock("claude-auth.json")
  })

  it("uses independent locks per key", async () => {
    const { tryAcquireFetchLock, releaseFetchLock } = await import("../cache.js")
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(true)
    expect(tryAcquireFetchLock("codex")).toBe(true)
    releaseFetchLock("claude-auth.json")
    releaseFetchLock("codex")
  })

  it("takes over a stale lock left by a dead process", async () => {
    const { tryAcquireFetchLock, releaseFetchLock } = await import("../cache.js")
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(true)
    // Backdate the lock file far past the stale threshold.
    const lockPath = join(tmpCacheDir, "opencode-usage", "fetch-claude-auth.json.lock")
    const old = (Date.now() - 10 * 60 * 1000) / 1000
    utimesSync(lockPath, old, old)
    expect(tryAcquireFetchLock("claude-auth.json")).toBe(true)
    releaseFetchLock("claude-auth.json")
  })

  it("releasing an unheld lock is a no-op", async () => {
    const { releaseFetchLock } = await import("../cache.js")
    expect(() => releaseFetchLock("never-acquired")).not.toThrow()
  })

  it("does not release a lock now owned by another process", async () => {
    const { tryAcquireFetchLock, releaseFetchLock } = await import("../cache.js")
    expect(tryAcquireFetchLock("contested")).toBe(true)
    // Simulate another process taking over the lock (different nonce content).
    const lockPath = join(tmpCacheDir, "opencode-usage", "fetch-contested.lock")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(lockPath, "9999:other-process-nonce", "utf8")
    releaseFetchLock("contested")
    expect(tryAcquireFetchLock("contested")).toBe(false)
  })
})
