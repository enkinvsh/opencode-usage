import { execFile } from "node:child_process"
import { readNamespacedCacheEntry, writeNamespacedCache, tryAcquireFetchLock, releaseFetchLock } from "./cache"
import type { AntigravityAccount, AntigravityPool, AntigravityPoolWindow, AntigravityQuota, AntigravityState, AntigravityWindow } from "./types"

// Без UA клиента Antigravity Google отвечает 403 SUBSCRIPTION_REQUIRED даже
// для аккаунта с подпиской — квота видна только "родному" клиенту.
export const ANTIGRAVITY_USER_AGENT = "antigravity/1.104.0 darwin/arm64"

// 2026-10-13 прод-хост cloudcode-pa отвечал 429, а daily-* отдавали ту же квоту.
// 2026-10-17 наоборот: daily-* отвечают 200, но только с группой «Claude and GPT
// models» (3p-*) без Gemini, а прод отдаёт обе группы. Поэтому прод первым, а
// ответ без Gemini-группы считается неудачей хоста (см. GEMINI_GROUP_JQ).
export const ANTIGRAVITY_QUOTA_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
] as const

// Тот же критерий, что у parseQuotaSummary: группа с gemini-* бакетом или
// «gemini» в имени. Без этой проверки 200 с чужой группой обрывает перебор
// хостов, и аккаунт навсегда показывается как «нет данных».
const GEMINI_GROUP_JQ = `[.groups[]? | (.displayName // ""), (.buckets[]?.bucketId // "")] | any(test("gemini"; "i"))`

const SSH_TIMEOUT_MS = 30_000
const SSH_MAX_BUFFER = 1024 * 1024

// См. codex-fetcher.ts: тик рендера чаще интервала фетча, чтобы все процессы
// TUI быстро подхватывали общий дисковый кэш; в сеть ходит только держатель лока.
const MAX_TICK_MS = 15_000

function tickMsFor(intervalMs: number): number {
  return Math.max(1, Math.min(MAX_TICK_MS, Math.floor(intervalMs / 4)))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type AntigravitySource = { dir: string } | { file: string }

/**
 * Скрипт целиком выполняется на удалённом хосте: access_token не покидает его
 * (файл аккаунта root-only, копировать его на Mac нельзя). Токен идёт в curl
 * через stdin (`-H @-`), а не через argv — argv других процессов видно в `ps`.
 * printf — встроенная команда sh, отдельного процесса с токеном в argv нет.
 *
 * Аккаунты опрашиваются параллельно: при зависшем хосте один аккаунт тратит до
 * 3×8 с (укладывается в SSH_TIMEOUT_MS = 30 с), а последовательно пул из 4 не
 * уложился бы. Каждый пишет в свой файл — ответ Google длиннее PIPE_BUF и в
 * общем stdout перемешался бы. На выходе по строке JSON на аккаунт:
 * {id: имя файла, quota: ответ | null}.
 */
export function buildRemoteScript(source: AntigravitySource): string {
  const hosts = ANTIGRAVITY_QUOTA_HOSTS.join(" ")
  const files = "dir" in source ? `${shellQuote(source.dir)}/antigravity-*.json` : shellQuote(source.file)
  return [
    `t=$(mktemp -d) || exit 5`,
    `trap 'rm -rf "$t"' EXIT`,
    `i=0`,
    `for f in ${files}; do`,
    `  [ -e "$f" ] || continue`,
    `  i=$((i+1))`,
    `  (`,
    `    n=$(basename "$f")`,
    `    tok=$( (sudo -n cat "$f" 2>/dev/null || cat "$f") | jq -r .access_token )`,
    `    out=""`,
    `    if [ -n "$tok" ] && [ "$tok" != "null" ]; then`,
    `      for h in ${hosts}; do`,
    `        out=$(printf 'Authorization: Bearer %s\\n' "$tok" | curl -fsS -m 8 -H @- -H 'Content-Type: application/json' -A ${shellQuote(ANTIGRAVITY_USER_AGENT)} -X POST "https://$h/v1internal:retrieveUserQuotaSummary" -d '{}') && printf '%s' "$out" | jq -e ${shellQuote(GEMINI_GROUP_JQ)} >/dev/null 2>&1 && break`,
    `        out=""`,
    `      done`,
    `    fi`,
    `    if [ -n "$out" ] && printf '%s' "$out" | jq -c --arg id "$n" '{id:$id,quota:.}' 2>/dev/null; then exit 0; fi`,
    `    jq -cn --arg id "$n" '{id:$id,quota:null}'`,
    `  ) > "$t/$i" &`,
    `done`,
    `wait`,
    `[ "$i" -gt 0 ] || exit 3`,
    `cat "$t"/*`,
  ].join("\n")
}

export function accountIdFromFile(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/, "").replace(/^antigravity-/, "")
  return base.split("@")[0] || base
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bucketsOf(group: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : []
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === "string" ? v : null
}

function toWindow(bucket: Record<string, unknown> | undefined): AntigravityWindow | null {
  if (!bucket) return null
  const resetAt = stringField(bucket, "resetTime")
  const fraction = bucket.remainingFraction
  if (typeof fraction === "number" && Number.isFinite(fraction)) {
    return { usedPercent: Math.min(100, Math.max(0, (1 - fraction) * 100)), resetAt }
  }
  // Protobuf JSON не сериализует нулевые значения: resetTime без
  // remainingFraction означает остаток 0, т.е. лимит выбран полностью.
  if (resetAt !== null) return { usedPercent: 100, resetAt }
  return null
}

function bucketMatches(bucket: Record<string, unknown>, window: string, suffix: string): boolean {
  if (bucket.window === window) return true
  return stringField(bucket, "bucketId")?.endsWith(suffix) ?? false
}

export function parseQuotaSummary(raw: unknown): AntigravityQuota | null {
  if (!isRecord(raw) || !Array.isArray(raw.groups)) return null
  const groups = raw.groups.filter(isRecord)
  const gemini =
    groups.find((g) => bucketsOf(g).some((b) => stringField(b, "bucketId")?.startsWith("gemini-") ?? false)) ??
    groups.find((g) => /gemini/i.test(stringField(g, "displayName") ?? ""))
  if (!gemini) return null

  const buckets = bucketsOf(gemini)
  const fiveHour = toWindow(buckets.find((b) => bucketMatches(b, "5h", "-5h")))
  const weekly = toWindow(buckets.find((b) => bucketMatches(b, "weekly", "-weekly")))
  if (!fiveHour && !weekly) return null
  return { groupName: stringField(gemini, "displayName"), fiveHour, weekly }
}

export function parseAccountLines(stdout: string): AntigravityAccount[] {
  const accounts: AntigravityAccount[] = []
  for (const line of stdout.split("\n")) {
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      // Мусор вне JSON (баннеры, предупреждения sudo) — пропускаем строку.
      continue
    }
    if (!isRecord(rec) || typeof rec.id !== "string") continue
    accounts.push({ id: accountIdFromFile(rec.id), quota: parseQuotaSummary(rec.quota) })
  }
  return accounts.sort((a, b) => a.id.localeCompare(b.id))
}

type UsedWindow = { usedPercent: number; resetAt: string | null }

function earliestReset(windows: UsedWindow[]): string | null {
  let best: { at: string; ms: number } | null = null
  for (const w of windows) {
    if (w.resetAt === null) continue
    const ms = Date.parse(w.resetAt)
    if (Number.isNaN(ms)) continue
    if (best === null || ms < best.ms) best = { at: w.resetAt, ms }
  }
  return best?.at ?? null
}

function aggregateWindow(windows: (AntigravityWindow | null | undefined)[]): AntigravityPoolWindow | null {
  const counted = windows.filter((w): w is UsedWindow => w != null && w.usedPercent !== null)
  if (counted.length === 0) return null
  const remainingAccounts = counted.reduce((sum, w) => sum + (100 - w.usedPercent) / 100, 0)
  // У нетронутого аккаунта resetTime скользящий (now + окно) и ничего не значит.
  // Если кто-то выбит — важнее всего, когда вернётся первый выбитый.
  const exhausted = counted.filter((w) => w.usedPercent >= 100)
  const candidates = exhausted.length > 0 ? exhausted : counted.filter((w) => w.usedPercent > 0)
  return {
    usedPercent: 100 - (remainingAccounts / counted.length) * 100,
    remainingAccounts,
    counted: counted.length,
    nextResetAt: earliestReset(candidates),
  }
}

export function aggregatePool(accounts: AntigravityAccount[]): AntigravityPool {
  const isOut = (w: AntigravityWindow | null | undefined) => (w?.usedPercent ?? 0) >= 100
  return {
    accounts,
    fiveHour: aggregateWindow(accounts.map((a) => a.quota?.fiveHour)),
    weekly: aggregateWindow(accounts.map((a) => a.quota?.weekly)),
    exhausted: accounts.filter((a) => isOut(a.quota?.fiveHour) || isOut(a.quota?.weekly)).length,
  }
}

function runOverSsh(host: string, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, script],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: SSH_MAX_BUFFER },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

export async function fetchAntigravityPool(
  sshHost: string,
  source: AntigravitySource,
  run: (host: string, script: string) => Promise<string> = runOverSsh,
): Promise<AntigravityPool | null> {
  try {
    const accounts = parseAccountLines(await run(sshHost, buildRemoteScript(source)))
    if (!accounts.some((a) => a.quota !== null)) return null
    return aggregatePool(accounts)
  } catch {
    // Любой сбой ssh или ненулевой exit скрипта для сайдбара равнозначен
    // "данных нет": цикл обновления покажет кэш или ошибку.
    return null
  }
}

export function createAntigravityRefreshLoop(
  setState: (s: AntigravityState) => void,
  intervalMs: number,
  cfg: { sshHost?: string; authDir?: string; authFile?: string },
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false
  let announcedLoading = false

  const show = (data: AntigravityPool, stale: boolean): void => {
    setState({ status: "success", data, stale, error: null })
  }

  const announceLoading = (): void => {
    if (announcedLoading) return
    announcedLoading = true
    setState({ status: "loading", data: null, stale: false, error: null })
  }

  async function refresh(sshHost: string, source: AntigravitySource): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const entry = readNamespacedCacheEntry<AntigravityPool>("antigravityPool")
      const cached = entry?.result ?? null
      if (entry !== null && cached !== null && Date.now() - entry.timestamp < intervalMs) {
        show(cached, false)
        return
      }

      if (!tryAcquireFetchLock("antigravityPool")) {
        // Фетчит другой процесс OpenCode — рисуем общий кэш, пока он не обновит.
        if (cached) show(cached, false)
        else announceLoading()
        return
      }

      try {
        if (!cached) announceLoading()
        const result = await fetchAntigravityPool(sshHost, source)
        if (result) {
          writeNamespacedCache("antigravityPool", result)
          show(result, false)
        } else if (cached) {
          show(cached, true)
        } else {
          setState({ status: "error", data: null, stale: false, error: "fetch failed" })
        }
      } finally {
        releaseFetchLock("antigravityPool")
      }
    } finally {
      refreshing = false
    }
  }

  return {
    start() {
      if (timer !== null) return
      const { sshHost, authDir, authFile } = cfg
      const source: AntigravitySource | null = authDir ? { dir: authDir } : authFile ? { file: authFile } : null
      if (!sshHost || !source) {
        setState({ status: "not-configured", data: null, stale: false, error: null })
        return
      }
      void refresh(sshHost, source)
      timer = setInterval(() => { void refresh(sshHost, source) }, tickMsFor(intervalMs))
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
