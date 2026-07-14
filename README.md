# opencode-usage

An [opencode](https://opencode.ai) TUI sidebar plugin that displays your **Claude** and **Codex (ChatGPT)** account usage side by side. Shows session and weekly rate limits with reset countdowns for both providers.

**Text mode** (default):
```
▼ Claude Usage
 Session      31%  resets in 3h 16m
 Weekly       11%  resets in 4d 5h
 Fable        99%  resets in 2d 3h
 Sonnet        2%  resets in 6d 21h

▼ Codex Usage
 Session       1%  resets in 4h 51m
 Weekly       23%  resets in 5d 12h
```

**Bar mode** (`"displayMode": "bar"`):
```
▼ Claude Usage
 Session  █████░░░░░░░░░  31% (3h 16m)
 Weekly   ██░░░░░░░░░░░░  11% (4d 5h)
 Fable    █████████████  99% (2d 3h)

▼ Codex Usage
 Session  ░░░░░░░░░░░░░░   1% (4h 51m)
 Weekly   ███░░░░░░░░░░░  23% (5d 12h)
```

Click either header (`▼`/`▶`) to collapse that section independently.

## Install

> [!WARNING]
> **opencode 1.17.10 breaks TUI plugins installed by npm package spec** ([anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884)): the sidebar silently never renders. It is an opencode-side regression (OpenTUI 0.3.4 → 0.4.2) that affects *every* npm-spec TUI plugin — not just this one — and is slated to be fixed in a future opencode release. **Until then, use the `file://` workaround below.** The plain npm install further down works again once that fix ships.

### Workaround: `file://` install (opencode 1.17.10)

A `file://` path lives outside `node_modules`, so opencode runs its Solid JSX transform on it and binds it to the host renderer — exactly why it loads when the npm spec does not. Clone the repo and point opencode at the local source:

```bash
git clone https://github.com/coin-seeker/opencode-usage.git ~/.opencode-plugins/opencode-usage
cd ~/.opencode-plugins/opencode-usage && npm install
```

Then set **`~/.config/opencode/tui.json`** to the absolute local path (replace any `opencode-usage-sidebar` entry, and use *your* real home directory):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["file:///Users/YOU/.opencode-plugins/opencode-usage/src/tui.tsx", { "enabled": true }]
  ]
}
```

Restart opencode. Update later with `git -C ~/.opencode-plugins/opencode-usage pull`. Options work the same way — pass them as the second element of the entry (see [Options](#options)).

#### Let an AI agent switch it for you

Already installed via the npm spec? Paste this to your opencode / Claude agent and it will do the switch:

> opencode 1.17.10 has bug #33884 that silently breaks npm-spec TUI plugins. Set up `opencode-usage-sidebar` as a local `file://` plugin instead:
> 1. Clone & install: `git clone https://github.com/coin-seeker/opencode-usage.git ~/.opencode-plugins/opencode-usage && cd ~/.opencode-plugins/opencode-usage && npm install`
> 2. Edit `~/.config/opencode/tui.json`: remove any plugin entry whose name starts with `opencode-usage-sidebar`, and add `["file://<ABS_PATH>/src/tui.tsx", { "enabled": true }]`, where `<ABS_PATH>` is the clone's real absolute path (expand `~` to my home directory). Keep my other plugins and any options I already had.
> 3. Then tell me to restart opencode and confirm the **Claude Usage** / **Codex Usage** panels appear.

---

Paste below into your OpenCode.

```
Install and configure opencode-usage-sidebar by following the instructions here:
https://raw.githubusercontent.com/coin-seeker/opencode-usage/refs/heads/main/docs/installation.md
```

### Setup

One config file. Restart. Done.

**`~/.config/opencode/tui.json`**

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["opencode-usage-sidebar", { "enabled": true }]]
}
```

opencode resolves the npm package on startup automatically.

### Options

```json
{
  "plugin": [["opencode-usage-sidebar", {
    "enabled": true,
    "refreshInterval": 60,
    "displayMode": "text",
    "headerColor": "#E07A3A",
    "valueColor": "#82AAFF",
    "dimColor": "#546E7A",
    "showClaude": true,
    "showCodex": true,
    "codexHeaderColor": "#10A37F"
  }]]
}
```

| Option | Default | Description |
|---|---|---|
| `refreshInterval` | `60` | Seconds between data refreshes (applies to both providers) |
| `displayMode` | `"text"` | `"text"` shows percentage + reset time, `"bar"` shows progress bar + percentage + reset time |
| `headerColor` | theme text | Color of window labels (Session, Weekly, etc.) |
| `valueColor` | `#82AAFF` | Color of percentage values |
| `dimColor` | theme muted | Color of reset times and secondary text |
| `showClaude` | `true` | Show the Claude section. Set to `false` to hide and stop polling. |
| `showCodex` | `true` | Show the Codex section. Set to `false` to hide and stop polling. |
| `codexHeaderColor` | `#10A37F` | Color of the Codex header label and high-usage percentage |

## How It Works

### Claude

**Multiple accounts.** If OpenCode auth files exist, one Claude section is shown per file —
`auth.json` (current account) and `_auth.json` (previous account) — each labeled by the
account's display name. Each account is fetched independently and keyed separately, so one
account's data never appears under another. The active account's usage endpoint is sometimes
rate limited (HTTP 429) while OpenCode is using it for inference; the plugin honors the
server `Retry-After`, keeps that account's last known data during the cooldown, and never
falls back to a different account.

**Per-model windows (Fable).** Beyond Session and Weekly, each Claude section shows any
per-model weekly window the account is currently using — including **Fable**, Anthropic's
Claude 5 flagship. Fable reports through Anthropic's newer usage format (the `limits` array,
as a `weekly_scoped` entry) rather than the legacy top-level keys, so the plugin reads it from
there. Rows only appear when the account has usage on that model, so most sections show just
Session and Weekly until you use Fable, Sonnet, or Opus on their own weekly caps.

When no OpenCode auth file exists, a single Claude section is fetched via a 6-step fallback chain:

```
1. OpenCode auth.json + token refresh     → OAuth API (all OS)
2. CLAUDE_CODE_OAUTH_TOKEN env var        → OAuth API (all OS)
3. ~/.claude/.credentials.json            → OAuth API (all OS)
4. macOS Keychain                         → OAuth API (macOS)
5. Claude CLI PTY probe (/usage command)  → parse TUI output (macOS/Linux)
6. Browser cookies (Chrome/Firefox)       → claude.ai Web API (macOS/Linux)
```

### Codex

Uses a 3-step fallback chain to fetch Codex (ChatGPT) usage data:

```
1. CODEX_OAUTH_ACCESS_TOKEN + CODEX_ACCOUNT_ID env vars → /wham/usage (all OS)
2. ~/.codex/auth.json (Codex CLI native)               → /wham/usage (all OS)
3. OpenCode auth.json (openai key)                     → /wham/usage (all OS)
```

The plugin calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access_token>` and `ChatGPT-Account-Id: <account_id>`. Expired access tokens are automatically refreshed via `https://auth.openai.com/oauth/token`.

### Multi-TUI synchronization

Many OpenCode TUI windows can run this plugin at the same time. The shared disk cache
(`~/.cache/opencode-usage/last.json`) is the single source of truth:

- **Single-flight fetching** — per account, at most ONE process (the fetch-lock holder)
  queries the usage API per `refreshInterval`. Everyone else renders from the shared cache.
- **Fast convergence** — every process re-reads the cache on a fast tick (≤15s), so all
  TUIs show identical numbers within seconds of a refresh.
- **Shared cooldowns** — a server `Retry-After` (HTTP 429) is recorded in the shared cache,
  so no process re-queries a rate-limited account.
- **Token safety** — the plugin NEVER refreshes or writes the primary `auth.json`
  (OpenCode owns it). `_auth.json` tokens are refreshed only while holding the
  cross-process fetch lock, with the file re-read immediately beforehand, so two processes
  can never race the same single-use refresh token.

### Cross-Platform Support

| Platform | Claude OAuth | Claude CLI Probe | Claude Cookies | Codex (all 3 steps) |
|----------|--------------|------------------|----------------|---------------------|
| **macOS** | ✅ | ✅ (Python3 required) | ✅ Chrome + Firefox | ✅ |
| **Linux** | ✅ | ✅ (Python3 required) | ✅ Chrome + Firefox | ✅ |
| **Windows** | ✅ | ❌ | ❌ | ✅ |

Windows users: set `CLAUDE_CODE_OAUTH_TOKEN` for Claude (run `claude setup-token` to generate). Codex works out of the box if `~/.codex/auth.json` exists from `codex login`.

## Features

|   | What | Why it matters |
|:---:|---|---|
| ⏱ | **Auto-refresh** | Configurable interval, default 60 seconds, applied to both providers |
| 🛡 | **Robust fallback** | 6-step chain for Claude, 3-step chain for Codex — always finds a way |
| 💾 | **Disk cache** | Instant startup, no waiting on second launch |
| 🎨 | **Color grading** | Per-provider color gradients (Claude orange / Codex green) as usage rises |
| ⏳ | **Loading countdown** | Shows estimated time remaining during initial load |
| 🔄 | **Token refresh** | Automatically refreshes expired tokens for both Anthropic and OpenAI OAuth |
| 🔀 | **Independent sections** | Click either `▼`/`▶` header to collapse Claude or Codex independently |
| 🎚 | **Per-provider toggle** | `showClaude: false` or `showCodex: false` to disable a section entirely |

## Requirements

- [opencode](https://opencode.ai) with plugin support (`@opencode-ai/plugin` >= 1.4.3)
- For **Claude**: Claude CLI login, `CLAUDE_CODE_OAUTH_TOKEN` env var, or browser session on claude.ai
- For **Codex**: Codex CLI login (`codex login`), `CODEX_OAUTH_ACCESS_TOKEN` + `CODEX_ACCOUNT_ID` env vars, or OpenCode `openai` provider auth

Either provider can be missing — the section will simply show "Token invalid or expired" or similar hint, and the other section continues to work.

## Manual Install

Skip npm. Copy the source files directly:

```bash
mkdir -p ~/.config/opencode/plugins/opencode-usage-sidebar
cp src/tui.tsx src/types.ts src/format.ts src/cache.ts \
   src/keychain.ts src/oauth-client.ts src/cookie-reader.ts src/cli-probe.ts src/fetcher.ts \
   src/codex-auth.ts src/codex-oauth-client.ts src/codex-fetcher.ts \
   ~/.config/opencode/plugins/opencode-usage-sidebar/
```

Register the local path:

```json
{
  "plugin": [["./plugins/opencode-usage-sidebar/tui.tsx", { "enabled": true }]]
}
```

## Development

```bash
git clone https://github.com/coin-seeker/opencode-usage.git
cd opencode-usage
npm install
```

Run tests:

```bash
npm test
```

Edit, restart opencode, see changes live.

## License

MIT — see [LICENSE](LICENSE).

This project is a fork of [stevejkang/opencode-claude-usage](https://github.com/stevejkang/opencode-claude-usage) (MIT). The original copyright is preserved alongside this fork's modifications (Codex support, refactor).
