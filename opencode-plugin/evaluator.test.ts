import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createEvaluator, type Config } from "./evaluator"

// Use a canonical temp root because the evaluator rejects symlinked path components.
const TMP_ROOT = realpathSync(tmpdir())

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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
const configIndex = args.indexOf("--config")
if (args[configIndex + 1] !== policyDescriptor) process.exit(91)
const input = await Bun.stdin.text()
if (policy.capture) await Bun.write(policy.capture, JSON.stringify({ args, env: process.env, input, cwd: process.cwd() }))
if (policy.delay) await Bun.sleep(policy.delay)
if (policy.stderr) process.stderr.write(policy.stderr)
if (policy.raw !== undefined) process.stdout.write(policy.raw)
else process.stdout.write(JSON.stringify({ decision: policy.decision ?? "allow", reason: policy.reason ?? "fixed" }))
process.exit(policy.exit ?? 0)
`
const source = executable(checker)
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

async function fixture(policyValue: Record<string, unknown> = {}, executableSource = source) {
  const directory = await mkdtemp(path.join(TMP_ROOT, "bash-evaluator-plugin-"))
  directories.push(directory)
  const parent = path.join(directory, "checker")
  const executablePath = path.join(parent, "evaluator")
  const policyPath = path.join(parent, "policy.json")
  const policyText = JSON.stringify(policyValue)
  await mkdir(parent)
  await Bun.write(executablePath, executableSource)
  await chmod(executablePath, 0o700)
  await Bun.write(policyPath, policyText)
  const config: Config = {
    mode: "enforce",
    executable: executablePath,
    policy: policyPath,
    executable_sha256: digest(executableSource),
    policy_sha256: digest(policyText),
    expected: identity,
    timeout_seconds: 2,
    capacity: 4,
    max_input_bytes: 256 * 1024,
    max_output_bytes: 4 * 1024,
  } as unknown as Config
  return { directory, executable: executablePath, policy: policyPath, parent, config }
}

const action = (cwd: string, command = "git status") => ({ command, cwd })

test("invokes the exact argv with a minimal environment and canonical payload", async () => {
  const directory = await mkdtemp(path.join(TMP_ROOT, "bash-evaluator-plugin-"))
  directories.push(directory)
  const capture = path.join(directory, "capture.json")
  const test1 = await fixture({ capture, decision: "allow" })
  const evaluator = createEvaluator()
  const run = await evaluator.prepare(test1.config, action(directory))
  expect(run.admitted).toBe(true)
  expect(await run.result).toEqual({ decision: "allow" })
  const observed = await Bun.file(capture).json()
  expect(observed.args).toEqual(["--opencode", "--config", "/proc/self/fd/4", "--no-telemetry"])
  expect(observed.input).toBe(JSON.stringify({ tool: "bash", command: "git status", cwd: directory }))
  expect(observed.cwd).toBe("/")
  expect(observed.env).toEqual({ HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" })
})

test("returns each decision and treats noisy or malformed output as protocol failure", async () => {
  const evaluator = createEvaluator()
  for (const decision of ["allow", "ask", "deny", "noop"] as const) {
    const test1 = await fixture({ decision })
    const run = await evaluator.prepare(test1.config, action(test1.directory))
    expect(await run.result).toEqual({ decision })
  }
  for (const policy of [
    { raw: "not json" },
    { raw: JSON.stringify({ decision: "maybe", reason: "x" }) },
    { raw: JSON.stringify({ decision: "allow" }) },
    { raw: JSON.stringify({ decision: "allow", reason: "x", extra: "y" }) },
    { decision: "allow", stderr: "diagnostic" },
    { decision: "allow", exit: 3 },
  ]) {
    const test1 = await fixture(policy)
    const run = await evaluator.prepare(test1.config, action(test1.directory))
    const result = await run.result
    expect("failure" in result).toBe(true)
  }
})

test("fails closed for missing or non-canonical actions", async () => {
  const test1 = await fixture()
  const evaluator = createEvaluator()
  for (const invalid of [undefined, action("relative"), action(`${test1.directory}/../x`)]) {
    const run = await evaluator.prepare(test1.config, invalid)
    expect(run.admitted).toBe(false)
    expect(await run.result).toEqual({ failure: "input" })
  }
})

test("checks file hashes and exact executable identity before evaluation", async () => {
  const test1 = await fixture()
  const evaluator = createEvaluator()
  for (const config of [
    { ...test1.config, executable_sha256: "0".repeat(64) },
    { ...test1.config, policy_sha256: "0".repeat(64) },
    ...Object.keys(identity).map((field) => ({ ...test1.config, expected: { ...identity, [field]: "wrong" } })),
  ]) {
    const run = await evaluator.prepare(config as Config, action(test1.directory))
    expect("failure" in (await run.result)).toBe(true)
  }
})

test("rejects symlinked executable, policy or parent directory", async () => {
  const evaluator = createEvaluator()
  for (const field of ["executable", "policy"] as const) {
    const test1 = await fixture()
    const target = `${test1[field]}.regular`
    await rename(test1[field], target)
    await symlink(target, test1[field])
    const run = await evaluator.prepare(test1.config, action(test1.directory))
    expect(await run.result).toEqual({ failure: "integrity" })
  }
  const parentFixture = await fixture()
  await rename(parentFixture.parent, `${parentFixture.parent}.regular`)
  await symlink(`${parentFixture.parent}.regular`, parentFixture.parent)
  const run = await evaluator.prepare(parentFixture.config, action(parentFixture.directory))
  expect(await run.result).toEqual({ failure: "integrity" })
})

test("rejects a non-absolute or non-canonical configured executable or policy path", async () => {
  const test1 = await fixture()
  const evaluator = createEvaluator()
  for (const config of [
    { ...test1.config, executable: path.relative(process.cwd(), test1.executable) },
    { ...test1.config, policy: path.relative(process.cwd(), test1.policy) },
    {
      ...test1.config,
      executable: `${test1.directory}/../${path.basename(test1.directory)}/${path.basename(test1.executable)}`,
    },
  ]) {
    const run = await evaluator.prepare(config as Config, action(test1.directory))
    expect(await run.result).toEqual({ failure: "integrity" })
  }
})

test("times out slow evaluators and reports capacity exhaustion", async () => {
  const evaluator = createEvaluator()
  const slow = await fixture({ delay: 5_000 })
  const run = await evaluator.prepare({ ...slow.config, timeout_seconds: 0.5 }, action(slow.directory))
  expect(await run.result).toEqual({ failure: "timeout" })
  await run.settled

  const busy = await fixture({ delay: 1_000 })
  const runs = []
  for (let index = 0; index < 4; index++) {
    runs.push(await evaluator.prepare({ ...busy.config, capacity: 4 }, action(busy.directory)))
  }
  const extra = await evaluator.prepare({ ...busy.config, capacity: 4 }, action(busy.directory))
  expect(extra.admitted).toBe(false)
  expect(await extra.result).toEqual({ failure: "capacity" })
  for (const item of runs) item.abort()
  for (const item of runs) await item.settled
}, 10_000)
