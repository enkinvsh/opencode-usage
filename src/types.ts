// OAuth API response types
export interface OAuthUsageWindow {
  utilization: number | null
  resetsAt: string | null
}

export interface OAuthExtraUsage {
  isEnabled: boolean | null
  monthlyLimit: number | null
  usedCredits: number | null
  utilization: number | null
  currency: string | null
}

/** One model within a scoped usage limit (limits[].scope.model). */
export interface OAuthLimitModel {
  id: string | null
  displayName: string | null
}

export interface OAuthLimitScope {
  model: OAuthLimitModel | null
  surface: string | null
}

/**
 * One entry of the `limits` array — the newer usage format Anthropic introduced
 * with the Claude 5 family. Per-model windows (e.g. Fable) appear ONLY here, as a
 * `weekly_scoped` entry with `scope.model.displayName`, and are absent from the
 * legacy top-level `seven_day_*` keys.
 */
export interface OAuthLimit {
  kind: string | null
  group: string | null
  percent: number | null
  severity: string | null
  resetsAt: string | null
  scope: OAuthLimitScope | null
  isActive: boolean | null
}

export interface OAuthUsageResponse {
  fiveHour: OAuthUsageWindow | null
  sevenDay: OAuthUsageWindow | null
  /** Fable per-model weekly window, derived from the `limits` array (new Claude 5 format). */
  sevenDayFable: OAuthUsageWindow | null
  sevenDaySonnet: OAuthUsageWindow | null
  sevenDayOpus: OAuthUsageWindow | null
  sevenDayDesign: OAuthUsageWindow | null
  sevenDayRoutines: OAuthUsageWindow | null
  sevenDayOAuthApps: OAuthUsageWindow | null
  extraUsage: OAuthExtraUsage | null
  /** Raw newer-format limit windows; source for scoped per-model windows like Fable. */
  limits?: OAuthLimit[] | null
}

export type UsageFetchStatus = "ok" | "rate_limited" | "auth_failed" | "unavailable"

export type UsageFetchResult =
  | { status: "ok"; usage: OAuthUsageResponse }
  | { status: "rate_limited"; retryAfterMs?: number }
  | { status: "auth_failed" }
  | { status: "unavailable" }

// Profile response
export interface ProfileResponse {
  email: string
  name: string | null
  plan: string | null
}

// Keychain payload wrapper (actual JSON structure from macOS Keychain)
export interface KeychainPayload {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number // Unix timestamp in milliseconds
    scopes: string[]
    subscriptionType?: string
    rateLimitTier?: string
  }
}

// Parsed credentials with derived fields
export interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in milliseconds
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
  hasProfileScope: boolean
}

// CLI probe result
export interface CLIProbeResult {
  sessionPercent: number | null
  weeklyPercent: number | null
  opusPercent: number | null
  sonnetPercent: number | null
  sessionReset: string | null
  weeklyReset: string | null
  email: string | null
  org: string | null
}

// Plugin state
export type FetchStatus = "idle" | "loading" | "success" | "error" | "not-configured"
export type AuthMethod = "oauth" | "cookie" | "cli" | "none"
export type ClaudeAuthMethod = AuthMethod

export interface UsageState {
  status: FetchStatus
  data: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
  error: string | null
}

// One displayable Claude account section (one per OpenCode auth file).
export interface ClaudeAccount {
  id: string
  label: string
  status: FetchStatus
  data: OAuthUsageResponse | null
  authMethod: AuthMethod
  error: string | null
  /** Cached usage shown while a secondary token is expired and intentionally not refreshed: real but possibly out of date. */
  stale?: boolean
}

export interface CodexUsageWindow {
  usedPercent: number | null
  limitWindowSeconds: number | null
  resetAfterSeconds: number | null
  resetAt: number | null // Unix timestamp in seconds (raw API value, not ms)
}

export interface CodexRateLimit {
  allowed: boolean | null
  limitReached: boolean | null
  primaryWindow: CodexUsageWindow | null
  secondaryWindow: CodexUsageWindow | null
}

export interface CodexCredits {
  hasCredits: boolean | null
  unlimited: boolean | null
  overageLimitReached: boolean | null
  balance: string | null
}

export interface CodexUsageResponse {
  userId: string | null
  accountId: string | null
  email: string | null
  planType: string | null
  rateLimit: CodexRateLimit | null
  credits: CodexCredits | null
  rateLimitReachedType: { type: string } | null
}

export interface CodexProfile {
  email: string | null
  planType: string | null
}

export interface CodexJwtPayload {
  email: string | null
  chatgptPlanType: string | null
  chatgptAccountId: string | null
  chatgptUserId: string | null
  exp: number | null // Unix timestamp in seconds (JWT standard)
}

export interface CodexCredentials {
  accessToken: string
  refreshToken: string
  accountId: string | null
  expiresAt: number // Unix timestamp in milliseconds (normalised from JWT seconds)
}

export type CodexAuthMethod = "oauth-codex-cli" | "oauth-opencode" | "env" | "none"

export interface CodexState {
  status: FetchStatus
  data: CodexUsageResponse | null
  profile: CodexProfile | null
  authMethod: CodexAuthMethod
  error: string | null
}

export interface AntigravityWindow { usedPercent: number | null; resetAt: string | null }
export interface AntigravityQuota { groupName: string | null; fiveHour: AntigravityWindow | null; weekly: AntigravityWindow | null }
/** quota === null — аккаунт не ответил (протух токен, 403, таймаут). */
export interface AntigravityAccount { id: string; quota: AntigravityQuota | null }
/**
 * Google отдаёт только долю остатка, без абсолютных чисел, поэтому пул меряется
 * в «аккаунт-эквивалентах»: remainingAccounts = сумма остатков по аккаунтам.
 * Ultra считается одним аккаунтом наравне с Pro (его недельный лимит больше,
 * но во сколько раз — Google не публикует).
 */
export interface AntigravityPoolWindow { usedPercent: number; remainingAccounts: number; counted: number; nextResetAt: string | null }
export interface AntigravityPool {
  accounts: AntigravityAccount[]
  fiveHour: AntigravityPoolWindow | null
  weekly: AntigravityPoolWindow | null
  /** Аккаунты, у которых выбито хотя бы одно окно (5h или weekly). */
  exhausted: number
}
export interface AntigravityState { status: FetchStatus; data: AntigravityPool | null; stale: boolean; error: string | null }

// Plugin configuration options (from tui.json)
export type DisplayMode = "text" | "bar"

export interface PluginOptions {
  refreshInterval?: number
  displayMode?: DisplayMode
  headerColor?: string
  valueColor?: string
  dimColor?: string
  showClaude?: boolean
  showCodex?: boolean
  codexHeaderColor?: string
  /** Секция Antigravity по умолчанию выключена: ей нужен ssh-хост с файлом аккаунта. */
  showAntigravity?: boolean
  antigravitySshHost?: string
  /** Каталог пула кредов cliproxyapi: берутся все antigravity-*.json. Приоритетнее antigravityAuthFile. */
  antigravityAuthDir?: string
  antigravityAuthFile?: string
  /** Аккаунты с подпиской AI Ultra (отдают Argon) — помечаются «· U» в списке пула. */
  antigravityUltraAccounts?: string[]
  antigravityLabel?: string
  antigravityHeaderColor?: string
}
