//go:build unix

package claude

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// maxGlobalConfig bounds the read of Claude Code's own configuration file
// (~/.claude.json), which keeps every project's state: a larger one is
// not read, and no folder is trusted by it.
const maxGlobalConfig = 32 << 20

// trustedByClaude tells whether Claude Code itself trusts dir: whether the
// user accepted its trust dialog for dir or a folder above it (the
// projects of its global configuration, hasTrustDialogAccepted), as the
// program started with env would read it. The file is only read, at most
// maxGlobalConfig bytes of it; one that cannot be read trusts nothing.
func trustedByClaude(env []string, dir string, logger *log.Logger) bool {
	file := globalConfig(env)
	if file == "" {
		return false
	}
	f, err := os.Open(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logger.Printf("claude: %s: %v; the folder is not trusted", file, err)
		}
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	switch {
	case err != nil || !st.Mode().IsRegular():
		logger.Printf("claude: %s is no file; the folder is not trusted", file)
		return false
	case st.Size() > maxGlobalConfig:
		logger.Printf("claude: %s has more than %d bytes, not read; the folder is not trusted", file, maxGlobalConfig)
		return false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxGlobalConfig+1))
	if err != nil || len(b) > maxGlobalConfig {
		logger.Printf("claude: %s not read (%v); the folder is not trusted", file, err)
		return false
	}
	var c struct {
		Projects map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		logger.Printf("claude: %s is no configuration (%v); the folder is not trusted", file, err)
		return false
	}
	dirs := []string{filepath.Clean(dir)}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != dirs[0] {
		dirs = append(dirs, real)
	}
	for _, d := range dirs {
		for {
			if c.Projects[d].HasTrustDialogAccepted {
				return true
			}
			up := filepath.Dir(d)
			if up == d {
				break
			}
			d = up
		}
	}
	return false
}

// globalConfig is the file of Claude Code's global configuration for a
// program started with env: in CLAUDE_CONFIG_DIR when it names a folder,
// else in the home directory; a legacy .config.json in Claude Code's own
// folder (CLAUDE_CONFIG_DIR, ~/.claude) first when there is one. "" when
// there is no home directory.
func globalConfig(env []string) string {
	vars := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			vars[k] = v
		}
	}
	home := vars["HOME"]
	if !filepath.IsAbs(home) {
		home, _ = os.UserHomeDir()
	}
	base, own := home, filepath.Join(home, ".claude")
	if d := vars["CLAUDE_CONFIG_DIR"]; filepath.IsAbs(d) {
		base, own = d, d
	} else if !filepath.IsAbs(home) {
		return ""
	}
	if legacy := filepath.Join(own, ".config.json"); isFile(legacy) {
		return legacy
	}
	return filepath.Join(base, ".claude.json")
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}
