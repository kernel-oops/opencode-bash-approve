import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/log")
const LOG_FILE = join(LOG_DIR, "bash-permission-evaluator.log")

try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch {
  // best-effort; a missing/unwritable log directory must not block permission evaluation
}

export function logInfo(message: string, fields: Record<string, unknown>) {
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", message, ...fields })}\n`)
  } catch {
    // best-effort logging only
  }
}
