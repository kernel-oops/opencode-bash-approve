import { createEvaluator, type Config as EvaluatorConfig } from "./evaluator"
import { logInfo } from "./logger"

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MODES = new Set(["disabled", "audit-only", "permit-only", "enforce"])
const EXPECTED_FIELDS = ["implementation", "version", "commit", "protocol", "platform"] as const

export interface Config extends EvaluatorConfig {
  readonly mode: "disabled" | "audit-only" | "permit-only" | "enforce"
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * Same shape and bounds as the retired `bash_permission_evaluator` core config key, but read
 * from this plugin's own `options` instead of a top-level config key. An invalid or missing
 * configuration is always treated as disabled: this must never fail open.
 */
export function readConfig(options: Record<string, unknown> | undefined): Config | undefined {
  if (!options || typeof options.mode !== "string" || !MODES.has(options.mode)) return
  const mode = options.mode as Config["mode"]
  if (mode === "disabled") return { mode, executable: "", policy: "", executable_sha256: "", policy_sha256: "", expected: { implementation: "", version: "", commit: "", protocol: "", platform: "" } }

  if (!nonEmptyString(options.executable) || !nonEmptyString(options.policy)) return
  if (typeof options.executable_sha256 !== "string" || !SHA256_PATTERN.test(options.executable_sha256)) return
  if (typeof options.policy_sha256 !== "string" || !SHA256_PATTERN.test(options.policy_sha256)) return
  const expectedInput = options.expected
  if (typeof expectedInput !== "object" || expectedInput === null) return
  const expectedValues: string[] = []
  for (const field of EXPECTED_FIELDS) {
    const value = (expectedInput as Record<string, unknown>)[field]
    if (!nonEmptyString(value)) return
    expectedValues.push(value)
  }
  const [implementation, version, commit, protocol, platform] = expectedValues as [string, string, string, string, string]
  const expected: Config["expected"] = { implementation, version, commit, protocol, platform }

  const timeoutSeconds = options.timeout_seconds === undefined ? 2 : Number(options.timeout_seconds)
  if (!(timeoutSeconds > 0 && timeoutSeconds <= 30)) return
  const capacity = options.capacity === undefined ? 4 : Number(options.capacity)
  if (!(Number.isInteger(capacity) && capacity > 0)) return
  const maxInputBytes = options.max_input_bytes === undefined ? 256 * 1024 : Number(options.max_input_bytes)
  if (!(Number.isInteger(maxInputBytes) && maxInputBytes > 0 && maxInputBytes <= 256 * 1024)) return
  const maxOutputBytes = options.max_output_bytes === undefined ? 4 * 1024 : Number(options.max_output_bytes)
  if (!(Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 4 * 1024)) return

  return {
    mode,
    executable: options.executable,
    policy: options.policy,
    executable_sha256: options.executable_sha256,
    policy_sha256: options.policy_sha256,
    expected,
    timeout_seconds: timeoutSeconds,
    capacity,
    max_input_bytes: maxInputBytes,
    max_output_bytes: maxOutputBytes,
  }
}

const DENIED_MESSAGE = "Denied by the configured Bash permission evaluator."

interface PermissionEvaluateEvent {
  action: string
  effect: string
  message?: string
  sessionID: string
  metadata?: Record<string, unknown>
}

type PermissionContext = {
  readonly permission: {
    readonly hook: (
      name: "evaluate",
      callback: (event: PermissionEvaluateEvent) => Promise<void> | void,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  readonly options?: Record<string, unknown>
}

const BashPermissionEvaluatorPlugin = {
  id: "opencode-bash-permission-evaluator",
  async setup(ctx: PermissionContext) {
    const config = readConfig(ctx.options)
    if (!config) {
      if (ctx.options !== undefined) logInfo("configuration rejected, evaluator disabled", {})
      return
    }
    if (config.mode === "disabled") return

    const evaluator = createEvaluator()

    const registration = await ctx.permission.hook("evaluate", async (event) => {
      // Only pending asks are eligible; configured modes may approve them, but never override static denies.
      if (event.action !== "shell" || event.effect !== "ask") return
      const command = event.metadata?.command
      const cwd = event.metadata?.cwd
      if (typeof command !== "string" || typeof cwd !== "string") return

      const evaluate = async () => {
        const started = Date.now()
        const run = await evaluator.prepare(config, { command, cwd })
        const result = await run.result
        const decision = "decision" in result ? result.decision : undefined
        logInfo("bash permission evaluation", {
          sessionID: event.sessionID,
          mode: config.mode,
          admitted: run.admitted,
          settled: run.isSettled(),
          result: "decision" in result ? result.decision : result.failure,
          latencyMs: Date.now() - started,
        })
        return { decision, settled: run.isSettled() }
      }

      if (config.mode === "audit-only") {
        void evaluate()
        return
      }
      const { decision, settled } = await evaluate()
      if (!settled) return
      if (decision === "allow") {
        event.effect = "allow"
        return
      }
      if (config.mode === "enforce" && decision === "deny") {
        event.effect = "deny"
        event.message = DENIED_MESSAGE
      }
    })

    return () => registration.dispose()
  },
}

export default BashPermissionEvaluatorPlugin
