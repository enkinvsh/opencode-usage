import { execFile } from "node:child_process"
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, basename, dirname } from "node:path"
import type { OAuthCredentials } from "./types"

const KEYCHAIN_SERVICE = "Claude Code-credentials"
const PROFILE_SCOPE = "user:profile"
const EXPIRY_BUFFER_MS = 5 * 60 * 1000
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json")
const OPENCODE_DIR = process.platform === "win32"
  ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode")
  : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode")
const OPENCODE_AUTH_FILE = join(OPENCODE_DIR, "auth.json")
const OPENCODE_SECONDARY_AUTH_FILE = join(OPENCODE_DIR, "_auth.json")
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
const REFRESH_TIMEOUT_MS = 10_000

export function isTokenExpired(expiresAtMs: number): boolean {
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAtMs
}

function parseCredentials(raw: string): OAuthCredentials | null {
  try {
    const parsed = JSON.parse(raw)
    const inner = parsed.claudeAiOauth ?? parsed
    if (!inner?.accessToken) return null
    if (isTokenExpired(inner.expiresAt)) return null
    return {
      accessToken: inner.accessToken,
      refreshToken: inner.refreshToken ?? "",
      expiresAt: inner.expiresAt,
      scopes: inner.scopes ?? [],
      subscriptionType: inner.subscriptionType ?? null,
      rateLimitTier: inner.rateLimitTier ?? null,
      hasProfileScope: (inner.scopes ?? []).includes(PROFILE_SCOPE),
    }
  } catch {
    return null
  }
}

export function readCredentialsFile(): OAuthCredentials | null {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf8")
    return parseCredentials(raw)
  } catch {
    return null
  }
}

export interface OpenCodeAuth {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export function readOpenCodeAuthFrom(filePath: string): OpenCodeAuth | null {
  try {
    const raw = readFileSync(filePath, "utf8")
    const data = JSON.parse(raw)
    const ant = data.anthropic
    if (!ant?.access) return null
    return {
      accessToken: ant.access,
      refreshToken: ant.refresh ?? "",
      expiresAt: ant.expires ?? 0,
    }
  } catch {
    return null
  }
}

export function readOpenCodeAuth(): OpenCodeAuth | null {
  return readOpenCodeAuthFrom(OPENCODE_AUTH_FILE)
}

export function listOpenCodeAuthFiles(): string[] {
  const files: string[] = []
  if (existsSync(OPENCODE_AUTH_FILE)) files.push(OPENCODE_AUTH_FILE)
  if (existsSync(OPENCODE_SECONDARY_AUTH_FILE)) files.push(OPENCODE_SECONDARY_AUTH_FILE)
  return files
}

export function isPrimaryAuthFile(filePath: string): boolean {
  return basename(filePath) === "auth.json"
}

export function writeOpenCodeAuthTo(filePath: string, tokens: OpenCodeAuth): void {
  try {
    const raw = readFileSync(filePath, "utf8")
    const data = JSON.parse(raw) as Record<string, unknown>
    const prev = (data.anthropic ?? {}) as Record<string, unknown>
    data.anthropic = {
      ...prev,
      type: "oauth",
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    }
    const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, filePath)
    chmodSync(filePath, 0o600)
  } catch {}
}

export async function refreshToken(refreshTokenStr: string): Promise<OAuthCredentials | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenStr,
      client_id: OAUTH_CLIENT_ID,
    })
    const resp = await fetch(REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>
    const accessToken = data.access_token as string | undefined
    if (!accessToken) return null
    const expiresIn = (data.expires_in as number | undefined) ?? 28800
    const newRefresh = (data.refresh_token as string | undefined) ?? refreshTokenStr
    const expiresAt = Date.now() + expiresIn * 1000
    return {
      accessToken,
      refreshToken: newRefresh,
      expiresAt,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    }
  } catch {
    return null
  }
}

export function readKeychainCredentials(): Promise<OAuthCredentials | null> {
  if (process.platform !== "darwin") return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }
        resolve(parseCredentials(stdout.trim()))
      },
    )
  })
}
