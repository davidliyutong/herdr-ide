package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"herdr-ide/internal/agentproto"
)

// systemHerdrPaths are package-manager install locations (a variable for tests).
var systemHerdrPaths = []string{"/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", "/usr/bin/herdr"}

// resolveHerdr finds the herdr binary. Non-interactive ssh sessions often lack
// ~/.local/bin in PATH, so well-known install locations and the login shell
// are consulted as well. An installed herdr wins over the application's
// managed copy of the bundled one, which only stands in for a missing
// installation (herdrmgr.go).
func (a *Agent) resolveHerdr(hint string) (string, error) {
	a.herdrMu.Lock()
	defer a.herdrMu.Unlock()
	if bin, ok := a.herdrCache[hint]; ok {
		if isExecutable(bin) {
			return bin, nil
		}
		delete(a.herdrCache, hint)
	}
	candidates := []string{hint, os.Getenv("HERDR_BIN")}
	if p, err := exec.LookPath("herdr"); err == nil {
		candidates = append(candidates, p)
	}
	candidates = append(candidates,
		filepath.Join(a.home, ".local", "bin", "herdr"),
		filepath.Join(a.home, ".cargo", "bin", "herdr"),
	)
	candidates = append(candidates, systemHerdrPaths...)
	for _, c := range candidates {
		if c == "" {
			continue
		}
		c = expandHome(a.home, c)
		if isExecutable(c) {
			a.herdrCache[hint] = c
			return c, nil
		}
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := runOutput(ctx, shell, "-lc", "command -v herdr")
	if err == nil {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "/") && isExecutable(line) {
				a.herdrCache[hint] = line
				return line, nil
			}
		}
	}
	if bin := a.managedHerdr(); bin != "" {
		a.herdrCache[hint] = bin
		return bin, nil
	}
	return "", agentproto.ErrHerdrNotFound
}

// herdrSocket mirrors herdr's api_socket_path_for: the default session lives
// in the config dir, named sessions under sessions/<name>/.
func (a *Agent) herdrSocket(session string) string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" && (session == "" || session == "default") {
		return p
	}
	cfg := filepath.Join(a.home, ".config", "herdr")
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		cfg = filepath.Join(x, "herdr")
	}
	if session == "" || session == "default" {
		return filepath.Join(cfg, "herdr.sock")
	}
	return filepath.Join(cfg, "sessions", session, "herdr.sock")
}

// herdrClientSocket mirrors herdr's client_socket_path: a named session's
// socket sits beside its API socket; otherwise HERDR_SOCKET_PATH's stem plus
// "-client.sock", then HERDR_CLIENT_SOCKET_PATH, then the config dir.
func (a *Agent) herdrClientSocket(session string) string {
	if session == "" || session == "default" {
		if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
			stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
			return filepath.Join(filepath.Dir(p), stem+"-client.sock")
		}
		if p := os.Getenv("HERDR_CLIENT_SOCKET_PATH"); p != "" {
			return p
		}
	}
	return filepath.Join(filepath.Dir(a.herdrSocket(session)), "herdr-client.sock")
}

// herdrArgs prefixes global session selection for a herdr invocation.
func herdrArgs(session string, args ...string) []string {
	if session == "" || session == "default" {
		return args
	}
	return append([]string{"--session", session}, args...)
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

func expandHome(home, p string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

func runOutput(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = nil
	if err := cmd.Run(); err != nil {
		return stdout.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
