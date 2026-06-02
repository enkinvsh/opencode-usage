import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-usage")
const CACHE_FILE = join(CACHE_DIR, "last.json")
const CACHE_MAX_AGE_MS = 10 * 60 * 1000

export type CacheNamespace = "claude" | "codex"

export interface NamespaceEntry<T> {
  timestamp: number
  result: T
}

interface CacheFile {
  claude?: NamespaceEntry<unknown>
  codex?: NamespaceEntry<unknown>
  claudeAccounts?: Record<string, NamespaceEntry<unknown>>
  claudeAccountKeys?: Record<string, NamespaceEntry<unknown>>
  claudeActiveIdentity?: string
}

function validEntry<T>(entry: NamespaceEntry<T> | undefined): NamespaceEntry<T> | null {
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_MAX_AGE_MS) return null
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

export function readNamespacedCache<T>(ns: CacheNamespace): T | null {
  const file = readCacheFile()
  const entry = file[ns] as NamespaceEntry<T> | undefined
  return validEntry(entry)?.result ?? null
}

export function writeNamespacedCache<T>(ns: CacheNamespace, result: T): void {
  const existing = readCacheFile()
  const updated: CacheFile = {
    ...existing,
    [ns]: { timestamp: Date.now(), result },
  }
  writeCacheFile(updated)
}

export function readClaudeAccountCacheEntry<T>(identity: string | null): NamespaceEntry<T> | null {
  const file = readCacheFile()
  const id = identity ?? file.claudeActiveIdentity
  if (!id) return null
  const entry = file.claudeAccounts?.[id] as NamespaceEntry<T> | undefined
  return validEntry(entry)
}

export function readClaudeAccountCache<T>(identity: string | null): T | null {
  return readClaudeAccountCacheEntry<T>(identity)?.result ?? null
}

export function readClaudeAccountKeyCacheEntry<T>(key: string): NamespaceEntry<T> | null {
  const file = readCacheFile()
  const entry = file.claudeAccountKeys?.[key] as NamespaceEntry<T> | undefined
  return validEntry(entry)
}

export function readClaudeAccountKeyCache<T>(key: string): T | null {
  return readClaudeAccountKeyCacheEntry<T>(key)?.result ?? null
}

export function writeClaudeAccountCache<T>(identity: string, result: T): void {
  const existing = readCacheFile()
  const accounts = { ...(existing.claudeAccounts ?? {}), [identity]: { timestamp: Date.now(), result } }
  writeCacheFile({ ...existing, claudeAccounts: accounts, claudeActiveIdentity: identity })
}

export function writeClaudeAccountKeyCache<T>(key: string, result: T): void {
  const existing = readCacheFile()
  const accounts = { ...(existing.claudeAccountKeys ?? {}), [key]: { timestamp: Date.now(), result } }
  writeCacheFile({ ...existing, claudeAccountKeys: accounts })
}
