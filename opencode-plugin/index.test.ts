import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import Plugin, { readConfig } from "./index"

const TMP_ROOT = realpathSync(tmpdir())

const identity = {
  implementation: "test-evaluator",
  version: "1.2.3",
  commit: "0123456789abcdef",
  protocol: "opencode-bash-approve",
  platform: process.platform,
}
const executable = (code: string) => `#!/bin/bash
exec /usr/bin/env -u PWD -u SHLVL ${process.execPath} -e '${code.replaceAll("'", "'\\''")}' -- "$@"
`
const checker = `
const args = process.argv.slice(1)
const policyDescriptor = "/proc/self/fd/4"
const policyText = await Bun.file(policyDescriptor).text()
const policy = JSON.parse(policyText)
if (args.length === 1 && args[0] === "--version-json") {
  process.stdout.write(JSON.stringify(${JSON.stringify(identity)}))
  process.exit(0)
}
const input = await Bun.stdin.text()
if (policy.delay) await Bun.sleep(policy.delay)
process.stdout.write(JSON.stringify({ decision: policy.decision ?? "allow", reason: "fixed" }))
process.exit(0)
`
const source = executable(checker)
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeOptions(mode: string, policyValue: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(TMP_ROOT, "bash-evaluator-index-"))
  directories.push(directory)
  const executablePath = path.join(directory, "evaluator")
  const policyPath = path.join(directory, "policy.json")
  const policyText = JSON.stringify(policyValue)
  await mkdir(directory, { recursive: true })
  await Bun.write(executablePath, source)
  await chmod(executablePath, 0o700)
  await Bun.write(policyPath, policyText)
  return {
    mode,
    executable: executablePath,
    policy: policyPath,
    executable_sha256: digest(source),
    policy_sha256: digest(policyText),
    expected: identity,
    timeout_seconds: 2,
    capacity: 4,
  }
}

test("readConfig rejects malformed or missing options rather than defaulting to an insecure mode", () => {
  expect(readConfig(undefined)).toBeUndefined()
  expect(readConfig({})).toBeUndefined()
  expect(readConfig({ mode: "not-a-real-mode" })).toBeUndefined()
  expect(readConfig({ mode: "enforce" })).toBeUndefined() // missing executable/policy/hashes/expected
  expect(readConfig({ mode: "enforce", executable: "/x", policy: "/y", executable_sha256: "zz", policy_sha256: "0".repeat(64), expected: identity })).toBeUndefined() // bad sha shape
  expect(readConfig({ mode: "disabled" })).toMatchObject({ mode: "disabled" })
})

function fakeCtx(options: Record<string, unknown> | undefined) {
  const handlers: Array<(event: any) => Promise<void> | void> = []
  const disposed = { count: 0 }
  return {
    options,
    ctx: {
      options,
      permission: {
        hook: async (_name: "evaluate", callback: (event: any) => Promise<void> | void) => {
          handlers.push(callback)
          return { dispose: async () => { disposed.count++ } }
        },
      },
    },
    async fire(event: any) {
      for (const handler of handlers) await handler(event)
    },
    disposed,
  }
}

test("permit-only mode allows on an allow decision and never denies", async () => {
  const options = await makeOptions("permit-only", { decision: "allow" })
  const { ctx, fire } = fakeCtx(options)
  const cleanup = await Plugin.setup(ctx as any)
  expect(typeof cleanup).toBe("function")
  const event: any = { action: "shell", effect: "ask", sessionID: "ses_1", metadata: { command: "echo hi", cwd: TMP_ROOT } }
  await fire(event)
  expect(event.effect).toBe("allow")
})

test("permit-only mode leaves a deny decision as an unresolved ask", async () => {
  const options = await makeOptions("permit-only", { decision: "deny" })
  const { ctx, fire } = fakeCtx(options)
  await Plugin.setup(ctx as any)
  const event: any = { action: "shell", effect: "ask", sessionID: "ses_1", metadata: { command: "rm -rf /x", cwd: TMP_ROOT } }
  await fire(event)
  expect(event.effect).toBe("ask")
})

test("enforce mode both allows and denies", async () => {
  for (const decision of ["allow", "deny"] as const) {
    const options = await makeOptions("enforce", { decision })
    const { ctx, fire } = fakeCtx(options)
    await Plugin.setup(ctx as any)
    const event: any = { action: "shell", effect: "ask", sessionID: "ses_1", metadata: { command: "x", cwd: TMP_ROOT } }
    await fire(event)
    expect(event.effect).toBe(decision === "allow" ? "allow" : "deny")
    if (decision === "deny") expect(event.message).toBe("Denied by the configured Bash permission evaluator.")
  }
})

test("only fires for the shell action with a pending ask", async () => {
  const options = await makeOptions("enforce", { decision: "deny" })
  const { ctx, fire } = fakeCtx(options)
  await Plugin.setup(ctx as any)
  for (const event of [
    { action: "read", effect: "ask", sessionID: "s", metadata: { command: "x", cwd: TMP_ROOT } },
    { action: "shell", effect: "allow", sessionID: "s", metadata: { command: "x", cwd: TMP_ROOT } },
    { action: "shell", effect: "ask", sessionID: "s", metadata: {} },
    // Stock 2.2.0 does not pass shell metadata to the permission hook.
    { action: "shell", effect: "ask", sessionID: "s" },
  ] as any[]) {
    const before = event.effect
    await fire(event)
    expect(event.effect).toBe(before)
  }
})

test("disabled mode never registers the hook", async () => {
  const { ctx, disposed } = fakeCtx({ mode: "disabled" })
  const cleanup = await Plugin.setup(ctx as any)
  expect(cleanup).toBeUndefined()
  expect(disposed.count).toBe(0)
})

test("a process failure (bad executable) leaves the human ask in place, never denies", async () => {
  const directory = await mkdtemp(path.join(TMP_ROOT, "bash-evaluator-index-"))
  directories.push(directory)
  const options = {
    mode: "enforce",
    executable: path.join(directory, "missing"),
    policy: path.join(directory, "missing.json"),
    executable_sha256: "0".repeat(64),
    policy_sha256: "0".repeat(64),
    expected: identity,
  }
  const { ctx, fire } = fakeCtx(options)
  await Plugin.setup(ctx as any)
  const event: any = { action: "shell", effect: "ask", sessionID: "s", metadata: { command: "x", cwd: TMP_ROOT } }
  await fire(event)
  expect(event.effect).toBe("ask")
})

test("cleanup prevents late grants, including across asynchronous preparation", async () => {
  for (const delayBeforeCleanup of [0, 100]) {
    const options = await makeOptions("enforce", { delay: 500 })
    const { ctx, fire, disposed } = fakeCtx(options)
    const cleanup = await Plugin.setup(ctx as any)
    const event: any = { action: "shell", effect: "ask", sessionID: "synthetic", metadata: { command: "echo hi", cwd: TMP_ROOT } }
    const evaluation = fire(event)
    if (delayBeforeCleanup) await Bun.sleep(delayBeforeCleanup)
    await cleanup!()
    await evaluation
    expect(disposed.count).toBe(1)
    expect(event.effect).toBe("ask")
    await fire(event)
    expect(event.effect).toBe("ask")
  }
})
