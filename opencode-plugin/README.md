# OpenCode Bash permission evaluator

This optional server plugin invokes the separately installed `approve-bash` checker for pending shell permission asks. It does not supply an executable or policy; choose and verify both independently. It requires Linux, procfs and a temporary filesystem supporting `O_TMPFILE` and execution through `/proc/self/fd`. Hashes and the complete `--version-json` identity must match, and paths must be absolute, canonical and free of symlink components. The checker runs with telemetry disabled and a minimal environment. Integrity, identity, timeout, protocol and process errors leave the existing ask unresolved.

**Stock OpenCode 2.2.0 limitation:** its shell tool does not supply `metadata.command` and `metadata.cwd` to the permission evaluation hook. Consequently this plugin leaves shell asks unchanged on that stock release. It needs a core that supplies those exact fields (a proposed upstream fix); the plugin hook contract alone does not establish functional compatibility. No stock end-to-end qualification has been performed.

Example (replace every placeholder with your own verified values, including all five identity fields):

```jsonc
{
  "plugins": [{
    "package": "@kerneloops/opencode-bash-permission-evaluator",
    "options": {
      "mode": "audit-only",
      "executable": "/absolute/path/approve-bash",
      "policy": "/absolute/path/policy.yaml",
      "executable_sha256": "<64 lowercase hexadecimal characters>",
      "policy_sha256": "<64 lowercase hexadecimal characters>",
      "expected": {
        "implementation": "<implementation>", "version": "<version>",
        "commit": "<commit>", "protocol": "<protocol>", "platform": "linux"
      }
    }
  }]
}
```

Modes are `disabled`, `audit-only`, `permit-only` and `enforce`. Audit-only observes without changing decisions; permit-only applies checker allows; enforce applies checker allows and denies. The plugin acts only on `shell` asks, never static denies or already-allowed actions. Other decisions and malformed configuration leave host handling unchanged. Optional `timeout_seconds` (default 2, maximum 30), `capacity` (default 4), `max_input_bytes` (default/maximum 262144), and `max_output_bytes` (default/maximum 4096) constrain evaluation. A checker allow is an automatic permission grant; review your policy carefully before enabling it.

Best-effort logs under `$XDG_DATA_HOME/opencode/log` (or the user's local data directory) contain session IDs, mode, outcome and timings; they do not deliberately contain commands. Treat logs as sensitive. Tests use synthetic fixtures. See the repository's `PROVENANCE.md`, `NOTICE`, `LICENSE` and `OPENCODE-LICENSE` for provenance and licensing.
