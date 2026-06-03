import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readKeychainCredentials, writeOpenCodeAuthTo, isPrimaryAuthFile } from "../keychain.js"

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const mockExecFile = vi.mocked(execFile)
const originalPlatform = process.platform

function mockPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  })
}

describe("readKeychainCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlatform("darwin")
  })

  afterEach(() => {
    mockPlatform(originalPlatform)
  })

  it("returns null when security CLI fails", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(new Error("not found"), "", "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).toBeNull()
  })

  it("returns null when JSON is malformed", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, "not-json", "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).toBeNull()
  })

  it("parses credentials and sets hasProfileScope correctly", async () => {
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        refreshToken: "sk-ant-ort01-test",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default",
      },
    })
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, payload, "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe("sk-ant-oat01-test")
    expect(result?.hasProfileScope).toBe(false)
  })

  it("returns null without shelling out on non-macOS platforms", async () => {
    mockPlatform("linux")

    const result = await readKeychainCredentials()

    expect(result).toBeNull()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe("isPrimaryAuthFile", () => {
  it("treats auth.json as the primary opencode-managed file", () => {
    expect(isPrimaryAuthFile("/d/auth.json")).toBe(true)
  })

  it("treats _auth.json as a non-primary (secondary) file", () => {
    expect(isPrimaryAuthFile("/d/_auth.json")).toBe(false)
  })
})

describe("writeOpenCodeAuthTo", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auth-write-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("persists rotated anthropic tokens while preserving the openai block (S5)", () => {
    const file = join(dir, "_auth.json")
    const seed = {
      anthropic: { type: "oauth", access: "old", refresh: "oldR", expires: 1 },
      openai: { type: "oauth", refresh: "r", access: "a", expires: 2, accountId: "acc" },
    }
    writeFileSync(file, JSON.stringify(seed), "utf8")

    writeOpenCodeAuthTo(file, { accessToken: "newA", refreshToken: "newR", expiresAt: 9999 })

    const onDisk = JSON.parse(readFileSync(file, "utf8"))
    expect(onDisk.anthropic.access).toBe("newA")
    expect(onDisk.anthropic.refresh).toBe("newR")
    expect(onDisk.anthropic.expires).toBe(9999)
    expect(onDisk.anthropic.type).toBe("oauth")
    expect(onDisk.openai).toEqual(seed.openai)
  })

  it("writes the file with 0600 permissions", () => {
    const file = join(dir, "_auth.json")
    writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", access: "old", refresh: "oldR", expires: 1 } }), "utf8")

    writeOpenCodeAuthTo(file, { accessToken: "newA", refreshToken: "newR", expiresAt: 9999 })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("does not throw when the target file is missing", () => {
    const file = join(dir, "does-not-exist.json")
    expect(() => writeOpenCodeAuthTo(file, { accessToken: "a", refreshToken: "b", expiresAt: 3 })).not.toThrow()
  })
})
