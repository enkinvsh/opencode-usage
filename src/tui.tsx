/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { AntigravityAccount, AntigravityPoolWindow, AntigravityState, ClaudeAccount, CodexState, PluginOptions, OAuthUsageResponse } from "./types"
import { createClaudeRefreshLoop } from "./fetcher"
import { createCodexRefreshLoop } from "./codex-fetcher"
import { accountIdFromFile, createAntigravityRefreshLoop } from "./antigravity-fetcher"
import { formatRelativeTime, formatPercentage, formatBar, formatCost, windowLabel } from "./format"

const CLAUDE_ORANGE = "#E07A3A"
const CLAUDE_AMBER = "#F0A875"
const CODEX_GREEN = "#10A37F"
const CODEX_AMBER = "#5FC2A8"
const ANTIGRAVITY_BLUE = "#4285F4"
const ANTIGRAVITY_AMBER = "#8AB4F8"

const CLAUDE_WINDOW_KEYS = [
  "fiveHour",
  "sevenDay",
  "sevenDayFable",
  "sevenDaySonnet",
  "sevenDayOpus",
  "sevenDayDesign",
  "sevenDayRoutines",
  "sevenDayOAuthApps",
] as const

const CODEX_WINDOW_KEYS = ["primaryWindow", "secondaryWindow"] as const

type ClaudeWindowKey = (typeof CLAUDE_WINDOW_KEYS)[number]
type CodexWindowKey = (typeof CODEX_WINDOW_KEYS)[number]

const DEFAULT_REFRESH_INTERVAL_S = 60
const EXPECTED_LOAD_S = 25

const tui: TuiPlugin = async (api, rawOptions, _meta) => {
  const options = (rawOptions as PluginOptions | undefined) ?? {}
  const refreshIntervalMs = (options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S) * 1000
  const displayMode = options.displayMode ?? "text"
  const showClaude = options.showClaude !== false
  const showCodex = options.showCodex !== false
  const codexHeaderColor = options.codexHeaderColor ?? CODEX_GREEN
  const showAntigravity = options.showAntigravity === true
  const antigravityLabel = options.antigravityLabel ?? "Antigravity Usage"
  const antigravityHeaderColor = options.antigravityHeaderColor ?? ANTIGRAVITY_BLUE
  const antigravityUltra = new Set((options.antigravityUltraAccounts ?? []).map(accountIdFromFile))

  const [claudeAccounts, setClaudeAccounts] = createSignal<ClaudeAccount[]>([])
  const [claudeCollapsed, setClaudeCollapsed] = createSignal<Record<string, boolean>>({})

  const [codexState, setCodexState] = createSignal<CodexState>({
    status: "idle",
    data: null,
    profile: null,
    authMethod: "none",
    error: null,
  })
  const [codexOpen, setCodexOpen] = createSignal(true)
  const [codexCountdown, setCodexCountdown] = createSignal(EXPECTED_LOAD_S)
  let codexTickTimer: ReturnType<typeof setInterval> | null = null
  let codexCountdownStart = Date.now()

  const wrappedSetCodexState = (s: CodexState) => {
    if (s.status === "loading" && !s.data) {
      codexCountdownStart = Date.now()
      setCodexCountdown(EXPECTED_LOAD_S)
      if (!codexTickTimer) {
        codexTickTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - codexCountdownStart) / 1000)
          setCodexCountdown(Math.max(0, EXPECTED_LOAD_S - elapsed))
        }, 1000)
      }
    } else if (codexTickTimer) {
      clearInterval(codexTickTimer)
      codexTickTimer = null
    }
    setCodexState(s)
  }

  const [antigravityState, setAntigravityState] = createSignal<AntigravityState>({
    status: "idle",
    data: null,
    stale: false,
    error: null,
  })
  const [antigravityOpen, setAntigravityOpen] = createSignal(true)
  const [antigravityAccountsOpen, setAntigravityAccountsOpen] = createSignal(false)

  const claudeLoop = createClaudeRefreshLoop(setClaudeAccounts, refreshIntervalMs)
  const codexLoop = createCodexRefreshLoop(wrappedSetCodexState, refreshIntervalMs)

  if (showClaude) claudeLoop.start()
  if (showCodex) codexLoop.start()

  const antigravityLoop = createAntigravityRefreshLoop(setAntigravityState, refreshIntervalMs, {
    sshHost: options.antigravitySshHost,
    authDir: options.antigravityAuthDir,
    authFile: options.antigravityAuthFile,
  })
  if (showAntigravity) antigravityLoop.start()

  api.lifecycle.onDispose(() => {
    claudeLoop.stop()
    codexLoop.stop()
    antigravityLoop.stop()
    if (codexTickTimer) clearInterval(codexTickTimer)
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(ctx: TuiSlotContext, _props: unknown) {
        const t = ctx.theme.current
        const dim = options.dimColor ?? t.textMuted ?? "#546E7A"
        const fg = options.headerColor ?? t.text ?? "#EEFFFF"
        const valueFg = options.valueColor ?? "#82AAFF"

        const renderClaudeWindows = (data: OAuthUsageResponse) => (
          <box flexDirection="column">
            {CLAUDE_WINDOW_KEYS.map((key) => {
              const w = data[key as ClaudeWindowKey]
              if (!w) return null
              const pct = w.utilization
              const label = windowLabel(key)
              const pctColor = pct === null ? valueFg
                : pct >= 80 ? CLAUDE_ORANGE
                : pct >= 51 ? CLAUDE_AMBER
                : valueFg

              if (displayMode === "bar") {
                const bar = formatBar(pct)
                const resetStr = formatRelativeTime(w.resetsAt)
                const resetSuffix = resetStr && resetStr !== "—" ? ` (${resetStr})` : ""
                return (
                  <box height={1} flexDirection="row">
                    <text fg={fg}>{` ${label.padEnd(8)}`}</text>
                    <text fg={pctColor}>{bar.filled + bar.empty + formatPercentage(pct).padStart(4)}</text>
                    <text fg={dim}>{resetSuffix}</text>
                  </box>
                )
              }

              const resetStr = formatRelativeTime(w.resetsAt)
              return (
                <box height={1} flexDirection="row">
                  <text fg={fg}>{` ${label.padEnd(9)}`}</text>
                  <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
                  <text fg={dim}>{`  resets in ${resetStr}`}</text>
                </box>
              )
            })}

            {data.extraUsage?.isEnabled ? (
              <box height={1} flexDirection="row">
                <text fg={fg}>{"Credit  "}</text>
                <text fg={valueFg}>
                  {formatCost(data.extraUsage.usedCredits, data.extraUsage.monthlyLimit, data.extraUsage.currency)}
                </text>
              </box>
            ) : null}
          </box>
        )

        const renderClaudeAccount = (acc: ClaudeAccount) => {
          const isOpen = claudeCollapsed()[acc.id] !== true
          const body = acc.status === "not-configured"
            ? <box height={1}><text fg={dim}>{"Token invalid or expired"}</text></box>
            : acc.status === "error"
            ? <box height={1}><text fg={dim}>{"Failed to fetch usage"}</text></box>
            : !acc.data
            ? <box height={1}><text fg={dim}>{"Loading..."}</text></box>
            : acc.stale
            ? (
              <box flexDirection="column">
                {renderClaudeWindows(acc.data)}
                <box height={1}><text fg={dim}>{" cached \u2014 token expired"}</text></box>
              </box>
            )
            : renderClaudeWindows(acc.data)

          return (
            <box flexDirection="column">
              <box height={1} flexDirection="row" onMouseDown={() => setClaudeCollapsed({ ...claudeCollapsed(), [acc.id]: isOpen })}>
                <text fg={CLAUDE_ORANGE}>
                  <b>{isOpen ? "\u25BC" : "\u25B6"}{" "}{acc.label}</b>
                </text>
              </box>
              {isOpen ? body : null}
            </box>
          )
        }

        const renderClaude = () => {
          const accounts = claudeAccounts()
          if (accounts.length === 0) {
            const hint = process.env.CLAUDE_CODE_OAUTH_TOKEN
              ? "Loading..."
              : "Set CLAUDE_CODE_OAUTH_TOKEN or run 'claude login'"
            return (
              <box flexDirection="column">
                <box height={1}><text fg={CLAUDE_ORANGE}><b>{"Claude Usage"}</b></text></box>
                <box height={1}><text fg={dim}>{hint}</text></box>
              </box>
            )
          }
          return (
            <box flexDirection="column" gap={1}>
              {accounts.map(renderClaudeAccount)}
            </box>
          )
        }

        const renderCodex = () => {
          const s = codexState()

          if (s.status === "not-configured") {
            const hint = process.env.CODEX_OAUTH_ACCESS_TOKEN
              ? "Token invalid or expired"
              : "Run 'codex login' or set CODEX_OAUTH_ACCESS_TOKEN"
            return (
              <box flexDirection="column">
                <box height={1}><text fg={codexHeaderColor}><b>{"Codex Usage"}</b></text></box>
                <box height={1}><text fg={dim}>{hint}</text></box>
              </box>
            )
          }

          if (s.status === "error" && !s.data) {
            return (
              <box flexDirection="column">
                <box height={1}><text fg={codexHeaderColor}><b>{"Codex Usage"}</b></text></box>
                <box height={1}><text fg={dim}>{"Failed to fetch usage"}</text></box>
              </box>
            )
          }

          if ((s.status === "idle" || s.status === "loading") && !s.data) {
            const remaining = codexCountdown()
            const msg = remaining > 0 ? `Loading in ${remaining}s...` : "Loading shortly..."
            return (
              <box flexDirection="column">
                <box height={1}><text fg={codexHeaderColor}><b>{"Codex Usage"}</b></text></box>
                <box height={1}><text fg={dim}>{msg}</text></box>
              </box>
            )
          }

          const data = s.data
          const isOpen = codexOpen()
          const rateLimit = data?.rateLimit

          return (
            <box flexDirection="column">
              <box height={1} flexDirection="row" onMouseDown={() => setCodexOpen(!codexOpen())}>
                <text fg={codexHeaderColor}>
                  <b>{isOpen ? "\u25BC" : "\u25B6"}{" Codex Usage"}</b>
                </text>
              </box>

              {isOpen ? (
                <box flexDirection="column">
                  {rateLimit ? (
                    <box flexDirection="column">
                      {CODEX_WINDOW_KEYS.map((key) => {
                        const w = rateLimit[key as CodexWindowKey]
                        if (!w) return null
                        const pct = w.usedPercent
                        const label = windowLabel(key)
                        const pctColor = pct === null ? valueFg
                          : pct >= 80 ? codexHeaderColor
                          : pct >= 51 ? CODEX_AMBER
                          : valueFg

                        if (displayMode === "bar") {
                          const bar = formatBar(pct)
                          const resetStr = formatRelativeTime(w.resetAt)
                          const resetSuffix = resetStr && resetStr !== "—" ? ` (${resetStr})` : ""
                          return (
                            <box height={1} flexDirection="row">
                              <text fg={fg}>{` ${label.padEnd(8)}`}</text>
                              <text fg={pctColor}>{bar.filled + bar.empty + formatPercentage(pct).padStart(4)}</text>
                              <text fg={dim}>{resetSuffix}</text>
                            </box>
                          )
                        }

                        const resetStr = formatRelativeTime(w.resetAt)
                        return (
                          <box height={1} flexDirection="row">
                            <text fg={fg}>{` ${label.padEnd(9)}`}</text>
                            <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
                            <text fg={dim}>{`  resets in ${resetStr}`}</text>
                          </box>
                        )
                      })}

                      {data?.credits?.hasCredits ? (
                        <box height={1} flexDirection="row">
                          <text fg={fg}>{"Credit  "}</text>
                          <text fg={valueFg}>{data.credits.balance ?? "0"}</text>
                        </box>
                      ) : null}
                    </box>
                  ) : null}
                </box>
              ) : null}
            </box>
          )
        }

        const antigravityPctColor = (pct: number | null) => pct === null ? valueFg
          : pct >= 80 ? antigravityHeaderColor
          : pct >= 51 ? ANTIGRAVITY_AMBER
          : valueFg

        // Для пула в строку добавляется «3.4/4» (остаток в аккаунтах); бар
        // укорочен, чтобы строка осталась той же ширины, что у Claude/Codex.
        const POOL_BAR_WIDTH = 8

        const renderAntigravityRow = (label: string, w: AntigravityPoolWindow, poolSize: number) => {
          const pct = w.usedPercent
          const pctColor = antigravityPctColor(pct)
          const share = poolSize > 1 ? ` ${w.remainingAccounts.toFixed(1)}/${w.counted}` : ""
          const resetStr = formatRelativeTime(w.nextResetAt)
          const hasReset = resetStr !== "—"

          if (displayMode === "bar") {
            const bar = formatBar(pct, poolSize > 1 ? POOL_BAR_WIDTH : undefined)
            return (
              <box height={1} flexDirection="row">
                <text fg={fg}>{` ${label.padEnd(8)}`}</text>
                <text fg={pctColor}>{bar.filled + bar.empty + formatPercentage(pct).padStart(4)}</text>
                <text fg={valueFg}>{share}</text>
                <text fg={dim}>{hasReset ? ` (${resetStr})` : ""}</text>
              </box>
            )
          }

          return (
            <box height={1} flexDirection="row">
              <text fg={fg}>{` ${label.padEnd(9)}`}</text>
              <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
              <text fg={valueFg}>{share}</text>
              <text fg={dim}>{hasReset ? `  resets in ${resetStr}` : ""}</text>
            </box>
          )
        }

        // 14 вмещает и самое длинное имя (acct-alpha-01, 13), и «ultra-acct · U» (14),
        // чтобы колонки S и W стояли ровно.
        const ACCOUNT_NAME_WIDTH = 14
        const ULTRA_SUFFIX = " \u00B7 U"

        const renderAntigravityAccount = (a: AntigravityAccount) => {
          const isUltra = antigravityUltra.has(a.id)
          const maxId = isUltra ? ACCOUNT_NAME_WIDTH - ULTRA_SUFFIX.length : ACCOUNT_NAME_WIDTH
          const id = a.id.slice(0, maxId)
          const pad = " ".repeat(ACCOUNT_NAME_WIDTH - id.length - (isUltra ? ULTRA_SUFFIX.length : 0))
          const nameNodes = (
            <>
              <text fg={fg}>{` ${id}`}</text>
              {isUltra ? <text fg={antigravityHeaderColor}>{ULTRA_SUFFIX}</text> : null}
              {pad ? <text fg={fg}>{pad}</text> : null}
            </>
          )
          if (!a.quota) {
            return (
              <box height={1} flexDirection="row">
                {nameNodes}
                <text fg={dim}>{" нет данных"}</text>
              </box>
            )
          }
          const session = a.quota.fiveHour?.usedPercent ?? null
          const weekly = a.quota.weekly?.usedPercent ?? null
          return (
            <box height={1} flexDirection="row">
              {nameNodes}
              <text fg={dim}>{" S"}</text>
              <text fg={antigravityPctColor(session)}>{formatPercentage(session).padStart(5)}</text>
              <text fg={dim}>{"  W"}</text>
              <text fg={antigravityPctColor(weekly)}>{formatPercentage(weekly).padStart(5)}</text>
            </box>
          )
        }

        const renderAntigravity = () => {
          const s = antigravityState()
          const hint = s.status === "not-configured" ? "Set antigravitySshHost and antigravityAuthDir"
            : s.status === "error" && !s.data ? "Failed to fetch usage"
            : !s.data ? "Loading..."
            : null

          if (hint !== null || !s.data) {
            return (
              <box flexDirection="column">
                <box height={1}><text fg={antigravityHeaderColor}><b>{antigravityLabel}</b></text></box>
                <box height={1}><text fg={dim}>{hint ?? "Loading..."}</text></box>
              </box>
            )
          }

          const data = s.data
          const isOpen = antigravityOpen()
          const poolSize = data.accounts.length
          const accountsOpen = antigravityAccountsOpen()
          // Ultra-аккаунт держит основной расход (Argon), поэтому его S/W видны
          // без раскрытия списка; в самом списке он не дублируется. Для пула из
          // одного аккаунта строки Session/Weekly уже и есть его лимиты.
          const pinned = poolSize > 1 ? data.accounts.filter((a) => antigravityUltra.has(a.id)) : []
          const others = poolSize > 1 ? data.accounts.filter((a) => !antigravityUltra.has(a.id)) : []
          return (
            <box flexDirection="column">
              <box height={1} flexDirection="row" onMouseDown={() => setAntigravityOpen(!antigravityOpen())}>
                <text fg={antigravityHeaderColor}>
                  <b>{isOpen ? "\u25BC" : "\u25B6"}{" "}{antigravityLabel}{poolSize > 1 ? ` \u00D7${poolSize}` : ""}</b>
                </text>
              </box>
              {isOpen ? (
                <box flexDirection="column">
                  {data.fiveHour ? renderAntigravityRow("Session", data.fiveHour, poolSize) : null}
                  {data.weekly ? renderAntigravityRow("Weekly", data.weekly, poolSize) : null}
                  {pinned.map(renderAntigravityAccount)}
                  {poolSize > 1 ? (
                    <box height={1} flexDirection="row" onMouseDown={() => setAntigravityAccountsOpen(!antigravityAccountsOpen())}>
                      <text fg={data.exhausted > 0 ? antigravityHeaderColor : dim}>{` выбиты ${data.exhausted}/${poolSize}`}</text>
                      <text fg={dim}>{` \u00B7 ${accountsOpen ? "\u25BC" : "\u25B6"} аккаунты`}</text>
                    </box>
                  ) : null}
                  {poolSize > 1 && accountsOpen ? others.map(renderAntigravityAccount) : null}
                  {s.stale ? <box height={1}><text fg={dim}>{" cached \u2014 fetch failed"}</text></box> : null}
                </box>
              ) : null}
            </box>
          )
        }

        return (
          <box flexDirection="column" gap={1}>
            {showClaude ? renderClaude() : null}
            {showCodex ? renderCodex() : null}
            {showAntigravity ? renderAntigravity() : null}
          </box>
        ) as unknown as ReturnType<typeof renderClaude>
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-usage-sidebar",
  tui,
}

export default plugin
