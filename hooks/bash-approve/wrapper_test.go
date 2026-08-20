package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.yaml.in/yaml/v4"
)

func TestShippedConfigHasExplicitPolicy(t *testing.T) {
	data, err := os.ReadFile("categories.yaml")
	require.NoError(t, err)
	var cfg Config
	require.NoError(t, yaml.Unmarshal(data, &cfg))
	assert.Equal(t, []string{"all"}, cfg.Enabled)
}

func TestLegacyWrappersRequireAndPassExplicitConfig(t *testing.T) {
	tests := []struct {
		name            string
		script          string
		missingExitCode int
		wantArgs        []string
	}{
		{name: "claude", script: "run-hook.sh", missingExitCode: 0, wantArgs: []string{"--config"}},
		{name: "opencode", script: "run-opencode-hook.sh", missingExitCode: 1, wantArgs: []string{"--opencode", "--config"}},
		{name: "codex", script: "run-codex-hook.sh", missingExitCode: 0, wantArgs: []string{"--codex", "--config"}},
		{name: "pi", script: "run-pi-runtime.sh", missingExitCode: 1, wantArgs: []string{"--pi", "--config"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			scriptData, err := os.ReadFile(tt.script)
			require.NoError(t, err)
			scriptPath := filepath.Join(dir, tt.script)
			require.NoError(t, os.WriteFile(scriptPath, scriptData, 0o755))

			argsPath := filepath.Join(dir, "args")
			binaryPath := filepath.Join(dir, "approve-bash")
			fakeBinary := "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$ARGS_FILE\"\n"
			require.NoError(t, os.WriteFile(binaryPath, []byte(fakeBinary), 0o755))

			cmd := exec.Command(scriptPath)
			cmd.Env = append(os.Environ(), "ARGS_FILE="+argsPath)
			err = cmd.Run()
			if tt.missingExitCode == 0 {
				require.NoError(t, err)
			} else {
				var exitErr *exec.ExitError
				require.ErrorAs(t, err, &exitErr)
				assert.Equal(t, tt.missingExitCode, exitErr.ExitCode())
			}
			_, err = os.Stat(argsPath)
			assert.True(t, errors.Is(err, os.ErrNotExist), "binary ran without config")

			configPath := filepath.Join(dir, "categories.yaml")
			require.NoError(t, os.WriteFile(configPath, []byte("enabled:\n  - all\n"), 0o600))
			cmd = exec.Command(scriptPath)
			cmd.Env = append(os.Environ(), "ARGS_FILE="+argsPath)
			require.NoError(t, cmd.Run())
			got, err := os.ReadFile(argsPath)
			require.NoError(t, err)
			want := append(append([]string{}, tt.wantArgs...), configPath)
			assert.Equal(t, want, strings.Fields(string(got)))
		})
	}
}
