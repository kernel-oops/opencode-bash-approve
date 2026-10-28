export * as BashEvaluator from "./evaluator.js"

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, normalize, parse, relative } from "node:path"

// This is a plain-Node port of the core `permission/bash-evaluator.ts` service, so it can run as
// an ordinary external plugin instead of a patch to the OpenCode binary. The wire protocol, the
// integrity pinning and the TOCTOU protection (open + hash + snapshot into an anonymous O_TMPFILE
// copy + re-verify before invocation, exec by /proc/self/fd/N rather than a stable path) are
// unchanged; only the process-spawning and concurrency plumbing had to be rewritten without
// Effect or core's ChildProcessSpawner, using Node's own child_process + AbortController instead.

export type Decision = "allow" | "ask" | "deny" | "noop"
export type Failure = "input" | "capacity" | "integrity" | "identity" | "protocol" | "process" | "timeout"
export type Result = { decision: Decision } | { failure: Failure }

export interface Expected {
  readonly implementation: string
  readonly version: string
  readonly commit: string
  readonly protocol: string
  readonly platform: string
}

export interface Config {
  readonly executable: string
  readonly policy: string
  readonly executable_sha256: string
  readonly policy_sha256: string
  readonly expected: Expected
  readonly timeout_seconds?: number
  readonly capacity?: number
  readonly max_input_bytes?: number
  readonly max_output_bytes?: number
}

export interface Action {
  readonly command: string
  readonly cwd: string
}

export interface Run {
  readonly admitted: boolean
  readonly result: Promise<Result>
  /** Resolves once the background operation (bind, spawn, verify, cleanup) has fully finished. */
  readonly settled: Promise<void>
  readonly abort: () => void
  readonly isSettled: () => boolean
}

interface Operation {
  readonly controller: AbortController
  settled: boolean
}

const ENVIRONMENT = { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" }
const EXECUTABLE_FD = 3
const POLICY_FD = 4
const EXECUTABLE_PATH = `/proc/self/fd/${EXECUTABLE_FD}`
const POLICY_PATH = `/proc/self/fd/${POLICY_FD}`
const FORCE_KILL_AFTER_MS = 250
const FORBIDDEN_JSON_WHITESPACE = /[ ﻿]/u
// Linux defines O_TMPFILE as __O_TMPFILE | O_DIRECTORY. Node does not expose it.
const O_TMPFILE = 0o20200000

function unavailable(failure: Failure): Run {
  return {
    admitted: false,
    result: Promise.resolve({ failure }),
    settled: Promise.resolve(),
    abort: () => {},
    isSettled: () => true,
  }
}

function flatObject(text: string): Record<string, string> | undefined {
  if (FORBIDDEN_JSON_WHITESPACE.test(text)) return
  let index = 0
  const skip = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      index++
    }
  }
  const string = () => {
    skip()
    if (text[index] !== '"') return
    const start = index++
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2
        continue
      }
      if (text[index++] !== '"') continue
      try {
        const value: unknown = JSON.parse(text.slice(start, index))
        return typeof value === "string" && !FORBIDDEN_JSON_WHITESPACE.test(value) ? value : undefined
      } catch {
        return
      }
    }
  }

  skip()
  if (text[index++] !== "{") return
  const result: Record<string, string> = Object.create(null)
  skip()
  if (text[index] === "}") index++
  else {
    while (index < text.length) {
      const key = string()
      if (key === undefined || Object.hasOwn(result, key)) return
      skip()
      if (text[index++] !== ":") return
      const value = string()
      if (value === undefined) return
      result[key] = value
      skip()
      if (text[index] === "}") {
        index++
        break
      }
      if (text[index++] !== ",") return
    }
  }
  skip()
  return index === text.length ? result : undefined
}

function output(text: string): Result {
  const value = flatObject(text)
  if (!value || Object.keys(value).sort().join(",") !== "decision,reason") return { failure: "protocol" }
  if (!(["allow", "ask", "deny", "noop"] as const).includes(value.decision as Decision)) {
    return { failure: "protocol" }
  }
  if (Buffer.byteLength(value.reason, "utf8") > 512 || /[\r\n]/.test(value.reason)) return { failure: "protocol" }
  return { decision: value.decision as Decision }
}

function canonical(action: Action | undefined) {
  if (!action) return
  if (typeof action.command !== "string" || typeof action.cwd !== "string" || !isAbsolute(action.cwd)) return
  if (normalize(action.cwd) !== action.cwd) return
  return { tool: "bash", command: action.command, cwd: action.cwd }
}

interface PathComponent {
  readonly path: string
  readonly device: string
  readonly inode: string
  readonly kind: "directory" | "file"
}

interface BoundFile {
  readonly original: FileHandle
  readonly snapshot: FileHandle
  readonly components: ReadonlyArray<PathComponent>
  readonly hash: string
}

interface BoundFiles {
  readonly executable: BoundFile
  readonly policy: BoundFile
}

async function inspectPath(file: string): Promise<ReadonlyArray<PathComponent>> {
  if (!isAbsolute(file) || normalize(file) !== file) throw new Error("path is not canonical")
  const root = parse(file).root
  const names = relative(root, file).split(/[\\/]/u).filter(Boolean)
  const paths = [root]
  for (const name of names) paths.push(join(paths.at(-1) ?? root, name))
  const result: Array<PathComponent> = []
  for (let index = 0; index < paths.length; index++) {
    const current = paths[index]
    const info = await lstat(current, { bigint: true })
    if (info.isSymbolicLink()) throw new Error("path component is a symbolic link")
    const final = index === paths.length - 1
    if (final ? !info.isFile() : !info.isDirectory()) throw new Error("path component has the wrong type")
    result.push({
      path: current,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      kind: final ? "file" : "directory",
    })
  }
  return result
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const digest = createHash("sha256")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (true) {
    const read = await handle.read(chunk, 0, chunk.length, position)
    if (read.bytesRead === 0) break
    digest.update(chunk.subarray(0, read.bytesRead))
    position += read.bytesRead
  }
  return digest.digest("hex")
}

async function copySnapshot(source: FileHandle, mode: number) {
  const destination = await open(tmpdir(), constants.O_RDWR | O_TMPFILE, mode)
  const digest = createHash("sha256")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let sourcePosition = 0
  let targetPosition = 0
  try {
    while (true) {
      const read = await source.read(chunk, 0, chunk.length, sourcePosition)
      if (read.bytesRead === 0) break
      const bytes = chunk.subarray(0, read.bytesRead)
      digest.update(bytes)
      sourcePosition += read.bytesRead
      let offset = 0
      while (offset < bytes.length) {
        const written = await destination.write(bytes, offset, bytes.length - offset, targetPosition)
        if (written.bytesWritten === 0) throw new Error("snapshot write made no progress")
        offset += written.bytesWritten
        targetPosition += written.bytesWritten
      }
    }
    await destination.sync()
    await destination.chmod(mode)
    const snapshot = await open(`/proc/self/fd/${destination.fd}`, constants.O_RDONLY)
    try {
      const destinationInfo = await destination.stat({ bigint: true })
      const snapshotInfo = await snapshot.stat({ bigint: true })
      if (
        destinationInfo.dev !== snapshotInfo.dev ||
        destinationInfo.ino !== snapshotInfo.ino ||
        !snapshotInfo.isFile()
      ) {
        throw new Error("snapshot descriptor mismatch")
      }
      return { hash: digest.digest("hex"), snapshot }
    } catch (error) {
      await snapshot.close().catch(() => {})
      throw error
    }
  } finally {
    await destination.close().catch(() => {})
  }
}

async function bindFile(file: string, expectedHash: string, mode: number): Promise<BoundFile> {
  // A relative path would otherwise resolve against the server process's cwd instead of failing.
  if (!isAbsolute(file) || normalize(file) !== file) throw new Error("path is not absolute or canonical")
  const components = await inspectPath(file)
  const original = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let snapshot: FileHandle | undefined
  try {
    const final = components.at(-1)
    const info = await original.stat({ bigint: true })
    if (!final || !info.isFile() || info.dev.toString() !== final.device || info.ino.toString() !== final.inode) {
      throw new Error("opened file does not match inspected file")
    }
    const copied = await copySnapshot(original, mode)
    snapshot = copied.snapshot
    if (copied.hash !== expectedHash || (await hashHandle(original)) !== expectedHash) throw new Error("hash mismatch")
    if ((await hashHandle(snapshot)) !== expectedHash) throw new Error("snapshot mismatch")
    return { original, snapshot, components, hash: expectedHash }
  } catch (error) {
    await snapshot?.close().catch(() => {})
    await original.close().catch(() => {})
    throw error
  }
}

async function verifyBoundFile(bound: BoundFile) {
  const current = await inspectPath(bound.components.at(-1)?.path ?? "")
  if (
    current.length !== bound.components.length ||
    current.some((item, index) => {
      const expected = bound.components[index]
      return (
        !expected ||
        item.path !== expected.path ||
        item.device !== expected.device ||
        item.inode !== expected.inode ||
        item.kind !== expected.kind
      )
    })
  ) {
    throw new Error("path was replaced")
  }
  const final = bound.components.at(-1)
  const info = await bound.original.stat({ bigint: true })
  if (
    !final ||
    !info.isFile() ||
    info.dev.toString() !== final.device ||
    info.ino.toString() !== final.inode ||
    (await hashHandle(bound.original)) !== bound.hash ||
    (await hashHandle(bound.snapshot)) !== bound.hash
  ) {
    throw new Error("bound file changed")
  }
}

async function bindFiles(config: Config): Promise<BoundFiles> {
  if (globalThis.process.platform !== "linux") throw new Error("bound evaluator files require Linux")
  const proc = await lstat("/proc/self/fd")
  if (!proc.isDirectory()) throw new Error("procfs file descriptors are unavailable")
  let executable: BoundFile | undefined
  let policy: BoundFile | undefined
  try {
    executable = await bindFile(config.executable, config.executable_sha256, 0o500)
    policy = await bindFile(config.policy, config.policy_sha256, 0o400)
    await verifyBoundFile(executable)
    await verifyBoundFile(policy)
    return { executable, policy }
  } catch (error) {
    await Promise.allSettled([
      executable?.original.close(),
      executable?.snapshot.close(),
      policy?.original.close(),
      policy?.snapshot.close(),
    ])
    throw error
  }
}

async function closeFiles(files: BoundFiles) {
  await Promise.allSettled([
    files.executable.original.close(),
    files.executable.snapshot.close(),
    files.policy.original.close(),
    files.policy.snapshot.close(),
  ])
}

interface ProcessResult {
  readonly exitCode: number | null
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

function collect(stream: NodeJS.ReadableStream, maxBytes: number) {
  const chunks: Buffer[] = []
  let length = 0
  let truncated = false
  stream.on("data", (chunk: Buffer) => {
    if (truncated) return
    const remaining = maxBytes - length
    if (chunk.length <= remaining) {
      chunks.push(chunk)
      length += chunk.length
    } else {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      length = maxBytes
      truncated = true
    }
  })
  return {
    get buffer() {
      return Buffer.concat(chunks)
    },
    get truncated() {
      return truncated
    },
  }
}

function runProcess(
  args: readonly string[],
  files: BoundFiles,
  opts: { readonly signal: AbortSignal; readonly stdin?: string; readonly maxOutputBytes: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXECUTABLE_PATH, args, {
      cwd: "/",
      env: ENVIRONMENT,
      detached: true,
      // Fixed indices >= 3 pass the already-open, integrity-verified snapshot descriptors
      // straight into the child; the exec target itself is the executable snapshot's own
      // /proc/self/fd path, so no stable filesystem path to the reviewed bytes is ever named.
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", files.executable.snapshot.fd, files.policy.snapshot.fd],
    })
    // Always requested as "pipe" above, so these are never null in practice.
    if (!child.stdout || !child.stderr) throw new Error("spawned process is missing stdout/stderr pipes")
    const stdout = collect(child.stdout, opts.maxOutputBytes)
    const stderr = collect(child.stderr, opts.maxOutputBytes)
    let processError: Error | undefined
    let terminating = false
    let killTimer: NodeJS.Timeout | undefined
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        // already gone
      }
    }
    const terminate = () => {
      if (terminating) return
      terminating = true
      killGroup("SIGTERM")
      killTimer = setTimeout(() => killGroup("SIGKILL"), FORCE_KILL_AFTER_MS)
    }
    const onAbort = () => {
      processError ??= new Error("Checker cancelled")
      terminate()
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })
    const onError = (error: Error) => {
      processError ??= error
      terminate()
    }
    child.on("error", onError)
    child.stdin?.on("error", onError)
    child.stdout.on("error", onError)
    child.stderr.on("error", onError)
    // Settlement must wait for close, not AbortError or EPIPE: capacity includes live children.
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort)
      if (killTimer) clearTimeout(killTimer)
      killGroup("SIGKILL")
      if (processError) { reject(processError); return }
      resolve({
        exitCode: code,
        stdout: stdout.buffer,
        stderr: stderr.buffer,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      })
    })
    if (opts.signal.aborted) onAbort()
    if (opts.stdin !== undefined && !terminating) {
      try { child.stdin?.end(opts.stdin) } catch (error) { onError(error as Error) }
    }
  })
}

export interface Evaluator {
  readonly prepare: (config: Config, action: Action | undefined) => Promise<Run>
}

export function createEvaluator(): Evaluator {
  const operations = new Set<Operation>()

  const prepare: Evaluator["prepare"] = async (config, action) => {
    const canon = canonical(action)
    if (!canon) return unavailable("input")
    const capacity = config.capacity ?? 4
    const maxInputBytes = config.max_input_bytes ?? 256 * 1024
    const maxOutputBytes = config.max_output_bytes ?? 4 * 1024
    const timeoutSeconds = config.timeout_seconds ?? 2
    const payload = JSON.stringify(canon)
    if (Buffer.byteLength(payload, "utf8") > maxInputBytes) return unavailable("input")
    if (operations.size >= capacity) return unavailable("capacity")

    const controller = new AbortController()
    const operation: Operation = { controller, settled: false }
    operations.add(operation)

    const runOnce = (files: BoundFiles, args: readonly string[], stdin?: string) =>
      runProcess(args, files, { signal: controller.signal, stdin, maxOutputBytes })

    const verify = async (files: BoundFiles) => {
      try {
        await verifyBoundFile(files.executable)
        await verifyBoundFile(files.policy)
        return true
      } catch {
        return false
      }
    }

    const executeBound = async (files: BoundFiles): Promise<Result> => {
      if (config.expected.platform !== globalThis.process.platform) return { failure: "identity" }
      if (!(await verify(files))) return { failure: "integrity" }

      let version: ProcessResult
      try {
        version = await runOnce(files, ["--version-json"])
      } catch {
        return { failure: "process" }
      }
      if (version.exitCode !== 0 || version.stdoutTruncated || version.stderrTruncated || version.stderr.length !== 0) {
        return { failure: "identity" }
      }
      const identity = flatObject(version.stdout.toString("utf8"))
      const expected = config.expected
      if (
        !identity ||
        Object.keys(identity).sort().join(",") !== "commit,implementation,platform,protocol,version" ||
        identity.implementation !== expected.implementation ||
        identity.version !== expected.version ||
        identity.commit !== expected.commit ||
        identity.protocol !== expected.protocol ||
        identity.platform !== expected.platform
      ) {
        return { failure: "identity" }
      }

      if (!(await verify(files))) return { failure: "integrity" }
      let evaluated: ProcessResult
      try {
        evaluated = await runOnce(files, ["--opencode", "--config", POLICY_PATH, "--no-telemetry"], payload)
      } catch {
        return { failure: "process" }
      }
      if (
        evaluated.exitCode !== 0 ||
        evaluated.stdoutTruncated ||
        evaluated.stderrTruncated ||
        evaluated.stderr.length !== 0
      ) {
        return { failure: "process" }
      }
      return output(evaluated.stdout.toString("utf8"))
    }

    const backgroundPromise: Promise<Result> = (async (): Promise<Result> => {
      let files: BoundFiles | undefined
      try {
        files = await bindFiles(config)
        return await executeBound(files)
      } catch {
        return { failure: "integrity" }
      } finally {
        if (files) await closeFiles(files)
      }
    })().finally(() => {
      operation.settled = true
      operations.delete(operation)
    })

    const timeoutPromise = new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort()
        resolve({ failure: "timeout" })
      }, timeoutSeconds * 1000)
      void backgroundPromise.finally(() => clearTimeout(timer))
    })

    return {
      admitted: true,
      result: Promise.race([backgroundPromise, timeoutPromise]),
      settled: backgroundPromise.then(
        () => undefined,
        () => undefined,
      ),
      abort: () => controller.abort(),
      isSettled: () => operation.settled,
    }
  }

  return { prepare }
}
