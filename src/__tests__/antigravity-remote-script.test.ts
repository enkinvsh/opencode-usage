import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRemoteScript, parseAccountLines } from "../antigravity-fetcher.js"

// Тест исполняет настоящий remote-скрипт в sh, подменяя только curl и sudo:
// проверяется то, что ломалось в проде, — поведение перебора хостов, а не текст скрипта.

const geminiPayload = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-21T05:00:05Z", remainingFraction: 0.9 },
        { bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-17T02:01:49Z", remainingFraction: 1 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [{ bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-18T12:30:02Z", remainingFraction: 1 }],
    },
  ],
}

// 17.10.2026: daily-* хосты отдают только группу Claude/GPT, без Gemini, но с HTTP 200.
const thirdPartyOnlyPayload = { groups: [geminiPayload.groups[1]] }

let root: string

function setup(daily: unknown, prod: unknown): void {
  const bin = join(root, "bin")
  const auth = join(root, "auth")
  mkdirSync(bin)
  mkdirSync(auth)
  writeFileSync(join(auth, "antigravity-acct-a@example.com.json"), JSON.stringify({ access_token: "tok" }))
  writeFileSync(join(root, "daily.json"), JSON.stringify(daily))
  writeFileSync(join(root, "prod.json"), JSON.stringify(prod))
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      "cat >/dev/null",
      'for a in "$@"; do case "$a" in https://*) url=$a;; esac; done',
      'case "$url" in',
      '  https://cloudcode-pa.googleapis.com/*) cat "$FIXTURE_DIR/prod.json";;',
      '  *) cat "$FIXTURE_DIR/daily.json";;',
      "esac",
    ].join("\n"),
  )
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\nshift\nexec "$@"\n')
  chmodSync(join(bin, "curl"), 0o755)
  chmodSync(join(bin, "sudo"), 0o755)
}

function run(): ReturnType<typeof parseAccountLines> {
  const stdout = execFileSync("sh", ["-c", buildRemoteScript({ dir: join(root, "auth") })], {
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_DIR: root },
    encoding: "utf8",
  })
  return parseAccountLines(stdout)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-script-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("buildRemoteScript host fallback", () => {
  it("skips a 200 response without the Gemini group and takes it from the next host", () => {
    setup(thirdPartyOnlyPayload, geminiPayload)
    const [acct] = run()
    expect(acct?.id).toBe("acct-a")
    expect(acct?.quota?.groupName).toBe("Gemini Models")
    expect(acct?.quota?.weekly?.usedPercent).toBeCloseTo(10, 5)
  })

  it("reports the account as no-data when no host returns the Gemini group", () => {
    setup(thirdPartyOnlyPayload, thirdPartyOnlyPayload)
    const [acct] = run()
    expect(acct?.id).toBe("acct-a")
    expect(acct?.quota).toBeNull()
  })

  it("accepts the first host when it already has the Gemini group", () => {
    setup(geminiPayload, thirdPartyOnlyPayload)
    expect(run()[0]?.quota?.groupName).toBe("Gemini Models")
  })
})
