package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/earthboundkid/versioninfo/v2"
	_ "modernc.org/sqlite"
)

func telemetryDBPath(homeDir func() (string, error)) (string, bool) {
	if xdgStateHome := os.Getenv("XDG_STATE_HOME"); xdgStateHome != "" && filepath.IsAbs(xdgStateHome) {
		return filepath.Join(xdgStateHome, "claude-bash-approve", "telemetry.db"), true
	}

	home, err := homeDir()
	if err != nil || home == "" {
		return "", false
	}

	return filepath.Join(home, ".local", "state", "claude-bash-approve", "telemetry.db"), true
}

func legacyTelemetryDBPath(executable func() (string, error)) (string, bool) {
	exe, err := executable()
	if err != nil || exe == "" {
		return "", false
	}

	return filepath.Join(filepath.Dir(exe), "telemetry.db"), true
}

func sqliteFilesFor(base string) []string {
	candidates := []string{base, base + "-wal", base + "-shm", base + "-journal"}
	files := make([]string, 0, len(candidates))
	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			files = append(files, path)
		}
	}
	return files
}

var (
	telemetryHomeDir     = os.UserHomeDir
	telemetryExecutable  = os.Executable
	copyFile             = copyFileStdlib
	renameFile           = os.Rename
	deleteLegacyFiles    = deleteLegacyTelemetryFiles
	telemetryVersionInfo = versioninfo.Short
)

type pluginMetadata struct {
	Version string `json:"version"`
}

func copyFileStdlib(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := in.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
	}()

	if err := ensurePrivateTelemetryDirectory(dst); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
	}()

	if _, err = io.Copy(out, in); err != nil {
		return err
	}

	return os.Chmod(dst, 0o600)
}

func ensurePrivateTelemetryDirectory(dbPath string) error {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("telemetry directory is not a real directory: %s", dir)
	}
	return os.Chmod(dir, 0o700)
}

func hardenTelemetryArtifacts(dbPath string) error {
	if err := ensurePrivateTelemetryDirectory(dbPath); err != nil {
		return err
	}
	for _, path := range telemetryArtifactPaths(dbPath) {
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("telemetry artifact is not a regular file: %s", path)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func prepareTelemetryDBPath(dbPath string) error {
	if err := ensurePrivateTelemetryDirectory(dbPath); err != nil {
		return err
	}
	info, err := os.Lstat(dbPath)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("telemetry database is not a regular file: %s", dbPath)
		}
		if err := os.Chmod(dbPath, 0o600); err != nil {
			return err
		}
	} else {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		file, createErr := os.OpenFile(dbPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if createErr != nil {
			return createErr
		}
		if closeErr := file.Close(); closeErr != nil {
			return closeErr
		}
	}
	return hardenTelemetryArtifacts(dbPath)
}

func cleanupFiles(paths []string) {
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

type copiedTelemetryFile struct {
	dst         string
	backup      string
	temp        string
	hadExisting bool
}

func rollbackCopiedTelemetryFiles(files []copiedTelemetryFile) {
	for _, file := range slices.Backward(files) {
		cleanupFiles([]string{file.temp})
		if file.backup == "" {
			if !file.hadExisting {
				cleanupFiles([]string{file.dst})
			}
			continue
		}
		cleanupFiles([]string{file.dst})
		_ = renameFile(file.backup, file.dst)
	}
}

func finalizeCopiedTelemetryFiles(files []copiedTelemetryFile) {
	for _, file := range files {
		cleanupFiles([]string{file.backup, file.temp})
	}
}

func temporaryTelemetryFilePath(path, pattern string) (string, error) {
	temp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+pattern)
	if err != nil {
		return "", err
	}
	name := temp.Name()
	if err := temp.Close(); err != nil {
		cleanupFiles([]string{name})
		return "", err
	}
	cleanupFiles([]string{name})
	return name, nil
}

func copyLegacyTelemetryFiles(legacyPath, destPath string) error {
	if err := ensurePrivateTelemetryDirectory(destPath); err != nil {
		return err
	}
	if err := hardenTelemetryArtifacts(destPath); err != nil {
		return err
	}

	copied := make([]copiedTelemetryFile, 0, 4)
	for _, src := range sqliteFilesFor(legacyPath) {
		dst := destPath + strings.TrimPrefix(src, legacyPath)
		tempPath, err := temporaryTelemetryFilePath(dst, ".tmp-*")
		if err != nil {
			rollbackCopiedTelemetryFiles(copied)
			return err
		}

		entry := copiedTelemetryFile{dst: dst, temp: tempPath}
		if _, err := os.Stat(dst); err == nil {
			entry.hadExisting = true
		} else if !errors.Is(err, os.ErrNotExist) {
			rollbackCopiedTelemetryFiles(append(copied, entry))
			return err
		}

		if err := copyFile(src, tempPath); err != nil {
			rollbackCopiedTelemetryFiles(append(copied, entry))
			return err
		}

		if entry.hadExisting {
			backupPath, backupErr := temporaryTelemetryFilePath(dst, ".bak-*")
			if backupErr != nil {
				rollbackCopiedTelemetryFiles(append(copied, entry))
				return backupErr
			}
			if err := renameFile(dst, backupPath); err != nil {
				cleanupFiles([]string{backupPath})
				rollbackCopiedTelemetryFiles(append(copied, entry))
				return err
			}
			entry.backup = backupPath
		} else if _, err := os.Stat(dst); err == nil {
			cleanupFiles([]string{tempPath})
			return os.ErrExist
		} else if !errors.Is(err, os.ErrNotExist) {
			rollbackCopiedTelemetryFiles(append(copied, entry))
			return err
		}

		copied = append(copied, entry)
		if err := renameFile(tempPath, dst); err != nil {
			if errors.Is(err, os.ErrExist) {
				cleanupFiles([]string{tempPath, copied[len(copied)-1].backup})
				copied[len(copied)-1].temp = ""
				copied[len(copied)-1].backup = ""
				return err
			}
			rollbackCopiedTelemetryFiles(copied)
			return err
		}
		if err := os.Chmod(dst, 0o600); err != nil {
			rollbackCopiedTelemetryFiles(copied)
			return err
		}
		copied[len(copied)-1].temp = ""
	}

	finalizeCopiedTelemetryFiles(copied)
	return nil
}

func deleteLegacyTelemetryFiles(legacyPath string) error {
	for _, path := range sqliteFilesFor(legacyPath) {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func resetTelemetryTestHooks() {
	telemetryHomeDir = os.UserHomeDir
	telemetryExecutable = os.Executable
	copyFile = copyFileStdlib
	renameFile = os.Rename
	deleteLegacyFiles = deleteLegacyTelemetryFiles
	telemetryVersionInfo = versioninfo.Short
}

func telemetryArtifactPaths(base string) []string {
	return []string{base, base + "-wal", base + "-shm", base + "-journal"}
}

func cleanupTelemetryArtifacts(base string) {
	cleanupFiles(telemetryArtifactPaths(base))
}

func initTelemetrySchema(db *sql.DB) bool {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS decisions (
		id       INTEGER PRIMARY KEY,
		ts       TEXT DEFAULT (datetime('now')),
		agent    TEXT DEFAULT 'claude',
		binary_version TEXT DEFAULT 'unknown',
		payload  TEXT,
		command  TEXT,
		decision TEXT,
		reason   TEXT
	)`)
	if err != nil {
		return false
	}
	if !ensureTelemetryColumn(db, "agent", "TEXT DEFAULT 'claude'") {
		return false
	}
	if !ensureTelemetryColumn(db, "binary_version", "TEXT DEFAULT 'unknown'") {
		return false
	}
	_, err = db.Exec(`UPDATE decisions SET agent = 'claude' WHERE agent IS NULL OR agent = ''`)
	if err != nil {
		return false
	}
	_, err = db.Exec(`UPDATE decisions SET binary_version = 'unknown' WHERE binary_version IS NULL OR binary_version = ''`)
	return err == nil
}

func telemetryBinaryVersion() string {
	if version := telemetryPluginVersion(); version != "" {
		return version
	}
	if version := strings.TrimSpace(telemetryVersionInfo()); version != "" {
		return version
	}
	return "unknown"
}

func telemetryPluginVersion() string {
	exe, err := telemetryExecutable()
	if err != nil || exe == "" {
		return ""
	}

	for _, path := range telemetryPluginMetadataPaths(exe) {
		version := telemetryPluginVersionFromPath(path)
		if version != "" {
			return version
		}
	}
	return ""
}

func telemetryPluginMetadataPaths(exe string) []string {
	dir := filepath.Dir(exe)
	return []string{
		filepath.Join(dir, "plugin.json"),
		filepath.Clean(filepath.Join(dir, "..", "..", ".claude-plugin", "plugin.json")),
	}
}

func telemetryPluginVersionFromPath(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var metadata pluginMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return ""
	}
	return strings.TrimSpace(metadata.Version)
}

func ensureTelemetryColumn(db *sql.DB, name, definition string) bool {
	rows, err := db.Query(`PRAGMA table_info(decisions)`)
	if err != nil {
		return false
	}
	defer rows.Close() //nolint:errcheck // best-effort telemetry validation

	for rows.Next() {
		var cid int
		var columnName string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false
		}
		if columnName == name {
			return rows.Err() == nil
		}
	}
	if err := rows.Err(); err != nil {
		return false
	}

	_, err = db.Exec(`ALTER TABLE decisions ADD COLUMN ` + name + ` ` + definition)
	return err == nil
}

func validateTelemetryDBPath(path string) bool {
	if err := prepareTelemetryDBPath(path); err != nil {
		return false
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return false
	}
	defer db.Close() //nolint:errcheck // best-effort telemetry validation

	return initTelemetrySchema(db) && hardenTelemetryArtifacts(path) == nil
}

func openAndValidateTelemetryDB(path string) (*sql.DB, bool) {
	if err := prepareTelemetryDBPath(path); err != nil {
		return nil, false
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, false
	}
	if !initTelemetrySchema(db) {
		db.Close() //nolint:errcheck // best-effort telemetry
		return nil, false
	}
	if err := hardenTelemetryArtifacts(path); err != nil {
		db.Close() //nolint:errcheck // best-effort telemetry
		return nil, false
	}
	return db, true
}

func migrateLegacyTelemetryDB(legacyPath, destPath string) (string, bool) {
	sourceFiles := sqliteFilesFor(legacyPath)
	if len(sourceFiles) == 0 {
		cleanupTelemetryArtifacts(destPath)
		return "", false
	}

	if err := copyLegacyTelemetryFiles(legacyPath, destPath); err != nil {
		if errors.Is(err, os.ErrExist) && validateTelemetryDBPath(destPath) {
			return destPath, true
		}
		cleanupTelemetryArtifacts(destPath)
		return "", false
	}

	for _, src := range sourceFiles {
		dst := destPath + strings.TrimPrefix(src, legacyPath)
		if _, err := os.Stat(dst); err != nil {
			cleanupTelemetryArtifacts(destPath)
			return "", false
		}
	}
	if !validateTelemetryDBPath(destPath) {
		cleanupTelemetryArtifacts(destPath)
		return "", false
	}

	_ = deleteLegacyFiles(legacyPath)
	return destPath, true
}

func ensureTelemetryDBReady(destPath string) (string, bool) {
	if err := ensurePrivateTelemetryDirectory(destPath); err != nil {
		return "", false
	}
	if _, err := os.Stat(destPath); err == nil {
		if validateTelemetryDBPath(destPath) {
			return destPath, true
		}

		legacyPath, ok := legacyTelemetryDBPath(telemetryExecutable)
		if !ok {
			return "", false
		}
		if _, err := os.Stat(legacyPath); err != nil {
			return "", false
		}

		cleanupTelemetryArtifacts(destPath)
		return migrateLegacyTelemetryDB(legacyPath, destPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		cleanupTelemetryArtifacts(destPath)
		return "", false
	}

	legacyPath, ok := legacyTelemetryDBPath(telemetryExecutable)
	if !ok {
		return destPath, true
	}
	if _, err := os.Stat(legacyPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return "", false
		}
		return destPath, true
	}

	return migrateLegacyTelemetryDB(legacyPath, destPath)
}

// openTelemetryDB opens telemetry.db from XDG state, migrating any legacy copy as needed.
// Returns nil if anything goes wrong — telemetry must never break the hook.
func openTelemetryDB() *sql.DB {
	dbPath, ok := telemetryDBPath(telemetryHomeDir)
	if !ok {
		return nil
	}
	readyPath, ok := ensureTelemetryDBReady(dbPath)
	if !ok {
		return nil
	}
	db, ok := openAndValidateTelemetryDB(readyPath)
	if !ok {
		return nil
	}
	return db
}

// logDecision inserts a telemetry row. Silently ignores all errors.
func logDecision(db *sql.DB, agent, payload, command, decision, reason string) {
	if db == nil {
		return
	}
	_, _ = db.Exec(`INSERT INTO decisions (agent, binary_version, payload, command, decision, reason) VALUES (?, ?, ?, ?, ?, ?)`,
		agent, telemetryBinaryVersion(), payload, command, decision, reason)
	hardenOpenTelemetryFiles(db)
}

func hardenOpenTelemetryFiles(db *sql.DB) {
	rows, err := db.Query(`PRAGMA database_list`)
	if err != nil {
		return
	}
	defer rows.Close() //nolint:errcheck // best-effort telemetry hardening
	for rows.Next() {
		var sequence int
		var name, path string
		if err := rows.Scan(&sequence, &name, &path); err != nil {
			return
		}
		if name == "main" && path != "" {
			_ = hardenTelemetryArtifacts(path)
			return
		}
	}
}
