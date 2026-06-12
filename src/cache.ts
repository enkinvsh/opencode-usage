import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-usage")
const CACHE_FILE = join(CACHE_DIR, "last.json")

// Entries older than this are considered garbage and never displayed.
// Freshness for *fetch scheduling* is decided by the caller (refresh interval),
// not by this constant.
const DISPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000

// A fetch lock left behind by a crashed process is taken over after this long.
const FETCH_LOCK_STALE_MS = 90_000

export type CacheNamespace = "claude" | "codex"

export interface NamespaceEntry<T> {
  timestamp: number
  result: T
}

interface CacheFile {
  claude?: NamespaceEntry<unknown>
  codex?: NamespaceEntry<unknown>
  /** Per OpenCode auth file (key: basename, e.g. "auth.json" / "_auth.json"). */
  claudeFiles?: Record<string, NamespaceEntry<unknown>>
  /** Server rate-limit cooldowns shared across processes (key → epoch ms until which fetching is forbidden). */
  cooldowns?: Record<string, number>
}

function validEntry<T>(entry: NamespaceEntry<T> | undefined): NamespaceEntry<T> | null {
  if (!entry) return null
  if (typeof entry.timestamp !== "number") return null
  if (Date.now() - entry.timestamp > DISPLAY_MAX_AGE_MS) return null
  if (entry.result === null || entry.result === undefined) return null
  return entry
}

function readCacheFile(): CacheFile {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object") {
      return parsed as CacheFile
    }
  } catch {}
  return {}
}

function writeCacheFile(data: CacheFile): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(tmpFile, JSON.stringify(data), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpFile, CACHE_FILE)
  } catch {}
}

function mutateCacheFile(mutator: (file: CacheFile) => CacheFile): void {
  writeCacheFile(mutator(readCacheFile()))
}

// ── Namespaced cache (codex + legacy single-account claude) ─────────────────

export function readNamespacedCacheEntry<T>(ns: CacheNamespace): NamespaceEntry<T> | null {
  const file = readCacheFile()
  return validEntry(file[ns] as NamespaceEntry<T> | undefined)
}

export function readNamespacedCache<T>(ns: CacheNamespace): T | null {
  return readNamespacedCacheEntry<T>(ns)?.result ?? null
}

export function writeNamespacedCache<T>(ns: CacheNamespace, result: T): void {
  mutateCacheFile((existing) => ({
    ...existing,
    [ns]: { timestamp: Date.now(), result },
  }))
}

// ── Per-auth-file claude cache (key: file basename) ─────────────────────────

export function readClaudeFileEntry<T>(fileBase: string): NamespaceEntry<T> | null {
  const file = readCacheFile()
  return validEntry(file.claudeFiles?.[fileBase] as NamespaceEntry<T> | undefined)
}

export function writeClaudeFileCache<T>(fileBase: string, result: T): void {
  mutateCacheFile((existing) => ({
    ...existing,
    claudeFiles: { ...(existing.claudeFiles ?? {}), [fileBase]: { timestamp: Date.now(), result } },
  }))
}

/** Rewrite an entry preserving its original timestamp (used to re-attribute data after verified token rotation). */
export function updateClaudeFileEntry<T>(fileBase: string, entry: NamespaceEntry<T>): void {
  mutateCacheFile((existing) => ({
    ...existing,
    claudeFiles: { ...(existing.claudeFiles ?? {}), [fileBase]: entry },
  }))
}

// ── Cross-process rate-limit cooldowns ───────────────────────────────────────

export function readCooldown(key: string): number {
  const file = readCacheFile()
  const until = file.cooldowns?.[key]
  return typeof until === "number" ? until : 0
}

export function writeCooldown(key: string, untilMs: number): void {
  mutateCacheFile((existing) => {
    const cooldowns: Record<string, number> = {}
    const now = Date.now()
    for (const [k, v] of Object.entries(existing.cooldowns ?? {})) {
      if (typeof v === "number" && v > now) cooldowns[k] = v
    }
    cooldowns[key] = untilMs
    return { ...existing, cooldowns }
  })
}

// ── Cross-process single-flight fetch locks ──────────────────────────────────
//
// Only one process per key may hit the network per refresh interval. Other
// processes render from the shared disk cache, which the lock holder updates.
// This is also what serializes OAuth token refreshes for _auth.json so that
// two processes can never race the same (single-use) refresh token.

function fetchLockPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(CACHE_DIR, `fetch-${safe}.lock`)
}

// Nonce per held lock so a process can only ever release a lock it owns.
// Without this, a slow former holder could unlink a lock that has since been
// taken over by another process, letting a third process fetch concurrently.
const heldLockNonces = new Map<string, string>()

export function tryAcquireFetchLock(key: string, staleMs: number = FETCH_LOCK_STALE_MS): boolean {
  const lockPath = fetchLockPath(key)
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
  } catch {}
  const nonce = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, nonce, { encoding: "utf8", flag: "wx", mode: 0o600 })
      heldLockNonces.set(key, nonce)
      return true
    } catch {
      // Lock exists. Take it over only if its holder looks dead (stale mtime).
      // Re-stat immediately before unlinking to keep the takeover race window
      // as small as possible; the exclusive create above remains the arbiter.
      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs <= staleMs) return false
        unlinkSync(lockPath)
        continue
      } catch {
        // Lock vanished between writeFileSync and statSync — retry once.
        continue
      }
    }
  }
  return false
}

export function releaseFetchLock(key: string): void {
  const nonce = heldLockNonces.get(key)
  if (nonce === undefined) return
  heldLockNonces.delete(key)
  const lockPath = fetchLockPath(key)
  try {
    if (readFileSync(lockPath, "utf8") !== nonce) return
    unlinkSync(lockPath)
  } catch {}
}
