package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type OpenCodeInput struct {
	Tool    string `json:"tool"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
}

type OpenCodeOutput struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
	Error    string `json:"error,omitempty"`
}

func validateOpenCodeInput(input OpenCodeInput) error {
	if strings.TrimSpace(input.Tool) == "" {
		return fmt.Errorf("invalid OpenCode input: tool is required")
	}
	if input.Tool != "bash" {
		return nil
	}
	if input.Command == "" {
		return fmt.Errorf("invalid OpenCode input: bash command is required")
	}
	if input.Cwd == "" || !filepath.IsAbs(input.Cwd) {
		return fmt.Errorf("invalid OpenCode input: bash cwd must be absolute")
	}
	return nil
}

func emitOpenCodeOutput(out OpenCodeOutput) {
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	os.Exit(0)
}

func evaluateOpenCodeToolUse(input OpenCodeInput, cfg Config) (string, *result) {
	if input.Tool != "bash" {
		return "", nil
	}
	return input.Command, Evaluate(input.Command, cfg, evalContext{cwd: input.Cwd})
}

func buildOpenCodeOutput(r *result) OpenCodeOutput {
	if r == nil {
		return OpenCodeOutput{Decision: "noop"}
	}
	if r.decision == "" {
		return OpenCodeOutput{Decision: "noop", Reason: r.reason}
	}
	reason := r.reason
	if r.decision == decisionDeny && r.denyReason != "" {
		reason = r.denyReason
	}
	return OpenCodeOutput{Decision: r.decision, Reason: reason}
}
