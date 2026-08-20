import { describe, expect, test } from "bun:test"

const keys = ["commit", "implementation", "platform", "protocol", "version"]

describe("release identity contract", () => {
  test("accepts only the closed OpenCode identity object", () => {
    const identity = {
      implementation: "approve-bash",
      version: "1.0.0-opencode.1",
      commit: "0123456789abcdef0123456789abcdef01234567",
      protocol: "opencode-bash-approve",
      platform: "linux",
    }

    expect(Object.keys(identity).sort()).toEqual(keys)
    expect(identity.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(identity).toEqual({
      implementation: "approve-bash",
      version: "1.0.0-opencode.1",
      commit: "0123456789abcdef0123456789abcdef01234567",
      protocol: "opencode-bash-approve",
      platform: "linux",
    })
  })
})
