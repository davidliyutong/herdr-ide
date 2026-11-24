//go:build unix

package chathost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"veldr/internal/brand"
)

// The agents' programs live in directories that only the user's shell
// startup files add to PATH (a version manager's, ~/.local/bin, a package
// manager's), and the host itself is started without those files being
// read. So the host asks an interactive login shell for its environment,
// and gives that to the agents. The shell runs the user's startup files,
// which may start programs of their own: it is asked again only when one
// of the startup files changed (startupFiles), or envKeep after it was
// asked last.
const (
	// shellTimeout is how long the shell has to print its environment.
	shellTimeout = 10 * time.Second
	// shellOutput is the most the shell may print.
	shellOutput = 1 << 20
	// envKeep is how long an environment is used before the shell is asked
	// again, unless a startup file changes: what the user installs and
	// configures by other files is found without a new host.
	envKeep = 6 * time.Hour
	// failKeep is how long the host's own environment stands in for one the
	// shell did not tell.
	failKeep = 5 * time.Minute
	// shellPipes is how long the shell's output is waited for once the
	// shell exited: a program its startup files left running may hold the
	// pipe open.
	shellPipes = 500 * time.Millisecond
)

// environment is the user's environment, asked for when needed and kept
// while the startup files stay as they were, for envKeep at most.
type environment struct {
	logger *log.Logger
	// lookup replaces the shell (tests).
	lookup func(context.Context) []string

	mu     sync.Mutex
	env    []string
	at     time.Time
	keep   time.Duration // envKeep, or failKeep for the host's own
	stamps string        // the startup files' as env was asked for
}

// get is the user's environment: the login shell's, or the host's own when
// the shell did not tell.
func (e *environment) get(ctx context.Context) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	stamps := fileStamps(startupFiles(e.env))
	if e.env != nil && time.Since(e.at) < e.keep && stamps == e.stamps {
		return e.env
	}
	var env []string
	keep := envKeep
	if e.lookup != nil {
		env = e.lookup(ctx)
	} else {
		var err error
		if env, err = loginEnv(ctx, os.Getenv("SHELL"), shellTimeout); err != nil {
			if ctx.Err() != nil {
				// The caller gave up, not the shell: nothing to keep.
				return os.Environ()
			}
			e.logger.Printf("the login shell's environment: %v; using the host's own", err)
			env, keep = os.Environ(), failKeep
		}
	}
	if !slices.Equal(startupFiles(env), startupFiles(e.env)) {
		// The shell told a ZDOTDIR of its own.
		stamps = fileStamps(startupFiles(env))
	}
	e.env, e.at, e.keep, e.stamps = env, time.Now(), keep, stamps
	return env
}

// systemStartup are the startup files of the system's shells (bash, zsh,
// sh, fish) and the files macOS's path_helper reads.
var systemStartup = []string{
	"/etc/profile", "/etc/profile.d", "/etc/environment", "/etc/paths", "/etc/paths.d",
	"/etc/bashrc", "/etc/bash.bashrc", "/etc/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin",
	"/etc/zsh/zshenv", "/etc/zsh/zprofile", "/etc/zsh/zshrc", "/etc/zsh/zlogin", "/etc/fish/config.fish",
}

// homeStartup are the startup files of the shells in the user's home (and
// zsh's in ZDOTDIR).
var homeStartup = []string{
	".profile", ".bash_profile", ".bash_login", ".bashrc", ".zshenv", ".zprofile", ".zshrc", ".zlogin",
	".config/fish/config.fish", ".config/fish/conf.d",
}

// startupFiles are the files whose change has the login shell asked again:
// the system's, the home's, and zsh's in ZDOTDIR (the host's, or the one
// the shell told in env).
func startupFiles(env []string) []string {
	files := slices.Clone(systemStartup)
	dirs := []string{}
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		dirs = append(dirs, home)
	}
	for _, z := range []string{os.Getenv("ZDOTDIR"), func() string { v, _ := getenv(env, "ZDOTDIR"); return v }()} {
		if filepath.IsAbs(z) && !slices.Contains(dirs, z) {
			dirs = append(dirs, z)
		}
	}
	for _, d := range dirs {
		for _, f := range homeStartup {
			files = append(files, filepath.Join(d, f))
		}
	}
	return files
}

// fileStamps tells the files as they are: each one's modification time
// and size, or that it is not there.
func fileStamps(files []string) string {
	var b strings.Builder
	for _, f := range files {
		b.WriteString(f)
		if st, err := os.Stat(f); err == nil {
			fmt.Fprintf(&b, "\x00%d\x00%d\n", st.ModTime().UnixNano(), st.Size())
		} else {
			b.WriteString("\x00-\n")
		}
	}
	return b.String()
}

// loginEnv runs shell as an interactive login shell that prints its
// environment (shell -l -i -c env), and /bin/sh as a login shell when shell
// is no absolute path. The shell gets no input and a session of its own:
// without a terminal it cannot stop to ask for one. What its startup files
// leave running goes with it.
func loginEnv(ctx context.Context, shell string, timeout time.Duration) ([]string, error) {
	args := []string{"-l", "-i", "-c", "env"}
	if !filepath.IsAbs(shell) {
		shell, args = "/bin/sh", []string{"-l", "-c", "env"}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out := &capped{max: shellOutput}
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Stdout = out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = shellPipes
	if home, err := os.UserHomeDir(); err == nil && isDir(home) {
		cmd.Dir = home
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	err := cmd.Wait()
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	switch {
	case out.over:
		return nil, fmt.Errorf("%s printed more than %d bytes", shell, shellOutput)
	case ctx.Err() != nil:
		return nil, fmt.Errorf("%s did not answer within %s", shell, timeout)
	case err != nil && !errors.Is(err, exec.ErrWaitDelay):
		return nil, fmt.Errorf("%s: %w", shell, err)
	}
	env := parseEnv(out.buf.Bytes())
	if _, ok := getenv(env, "PATH"); !ok {
		return nil, fmt.Errorf("%s printed no PATH", shell)
	}
	return env, nil
}

// capped keeps what is written to it up to max bytes; more is an error.
type capped struct {
	buf  bytes.Buffer
	max  int
	over bool
}

var errOutput = errors.New("too much output")

func (c *capped) Write(p []byte) (int, error) {
	if c.over || c.buf.Len()+len(p) > c.max {
		c.over = true
		return 0, errOutput
	}
	return c.buf.Write(p)
}

// parseEnv reads the output of env: a line that starts with a variable's
// name and "=" is a variable, any other line the next line of the value
// before it. What the startup files printed ahead of the first variable is
// dropped, and so are the functions bash exports (BASH_FUNC_name%%=…),
// whose bodies take several lines.
func parseEnv(out []byte) []string {
	var env []string
	skip := true // the line belongs to nothing that is kept
	for line := range strings.SplitSeq(strings.TrimSuffix(string(out), "\n"), "\n") {
		switch {
		case isVariable(line):
			env = append(env, line)
			skip = false
		case strings.HasPrefix(line, "BASH_FUNC_") && strings.Contains(line, "%%="):
			skip = true
		case !skip:
			env[len(env)-1] += "\n" + line
		}
	}
	return env
}

// isVariable tells whether line starts with a variable's name and "=".
func isVariable(line string) bool {
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '=':
			return i > 0
		case c == '_', 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z':
		case '0' <= c && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return false
}

// getenv is the value of key in env; the last one counts, as for a program
// that is started with env.
func getenv(env []string, key string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}

// agentEnv is the environment of an agent started in dir: the user's
// without what agentVar leaves out, with PWD set to dir and the Chat
// spec's variables added.
func agentEnv(user []string, extra map[string]string, dir string) []string {
	env := make([]string, 0, len(user)+len(extra)+1)
	for _, kv := range user {
		k, _, _ := strings.Cut(kv, "=")
		if agentVar(k) {
			env = append(env, kv)
		}
	}
	if dir != "" {
		env = append(env, "PWD="+dir)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		if k != "" && !strings.ContainsAny(k, "=\x00") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+extra[k])
	}
	return env
}

// agentSessionVars are the variables by which Claude Code and Codex mark
// the programs of one of their sessions: an agent started with them would
// take itself for a tool of that session. A copy of the machine agent's
// list (internal/agent/procutil.go); TestAgentSessionVarsMatch keeps the
// two the same.
var agentSessionVars = map[string]bool{
	"CLAUDECODE":                      true,
	"CLAUDE_CODE_CHILD_SESSION":       true,
	"CLAUDE_CODE_CHILD_NOTES_DIR":     true,
	"CLAUDE_CODE_ENTRYPOINT":          true,
	"CLAUDE_CODE_EXECPATH":            true,
	"CLAUDE_CODE_SESSION_ID":          true,
	"CLAUDE_CODE_SESSION_ATTENDED":    true,
	"CLAUDE_CODE_MESSAGING_SOCKET":    true,
	"CLAUDE_CODE_MESSAGING_TOKEN":     true,
	"CLAUDE_CODE_BRIDGE_SESSION_ID":   true,
	"CLAUDE_PID":                      true,
	"CLAUDE_EFFORT":                   true,
	"CLAUDE_PLUGIN_DATA":              true,
	"CODEX_THREAD_ID":                 true,
	"CODEX_SESSION_ID":                true,
	"CODEX_TOOL_CALL_ID":              true,
	"CODEX_COMPANION_SESSION_ID":      true,
	"CODEX_COMPANION_TRANSCRIPT_PATH": true,
}

// agentVar says whether a variable of the user's environment is passed on
// to an agent. The host runs in a hidden terminal of the terminal core,
// started by the machine's agent that ssh may have started, and the user's
// login shell may have been started in another terminal or multiplexer
// still; an agent that saw their variables would take itself for a program
// of a terminal it does not run in. Left out:
//
//   - the terminal core's variables of the host's own terminal
//     (HC_TERMINAL_*: HC_TERMINAL_ID, HC_TERMINAL_SOCKET), which would name
//     the hidden terminal to what the agent runs (the vault's MCP server,
//     the GUI windows). The core's others stay: HC_SCOPE, by which the
//     core's sweep finds the agents should the host's terminal be lost,
//     and HC_SESSION and HC_SOCKET, which name the core itself as they do
//     to the programs of the user's terminals;
//   - herdr's and this product's (HERDR_*, brand.EnvPrefix);
//   - tmux's (TMUX, TMUX_PANE), GNU screen's (STY), zellij's (ZELLIJ,
//     ZELLIJ_*);
//   - ssh's (SSH_*), and the terminal's identity (TERM_PROGRAM*,
//     COLORTERM): no terminal is there;
//   - PWD and OLDPWD, the shell's (agentEnv sets PWD);
//   - the coding agents' session markers (agentSessionVars).
func agentVar(k string) bool {
	switch k {
	case "TMUX", "TMUX_PANE", "STY", "ZELLIJ", "COLORTERM", "PWD", "OLDPWD":
		return false
	}
	if agentSessionVars[k] {
		return false
	}
	for _, prefix := range []string{"HC_TERMINAL_", "HERDR_", brand.EnvPrefix, "ZELLIJ_", "SSH_", "TERM_PROGRAM"} {
		if strings.HasPrefix(k, prefix) {
			return false
		}
	}
	return true
}

// lookPath resolves a program as a shell would with env's PATH: a name
// without a slash in PATH's absolute directories, an absolute path as it
// is; anything else is not found. It returns an absolute path of an
// executable file.
func lookPath(file string, env []string) (string, bool) {
	if file == "" {
		return "", false
	}
	if strings.Contains(file, "/") {
		return file, filepath.IsAbs(file) && isExecutable(file)
	}
	path, _ := getenv(env, "PATH")
	for _, d := range filepath.SplitList(path) {
		if !filepath.IsAbs(d) {
			continue
		}
		if p := filepath.Join(d, file); isExecutable(p) {
			return p, true
		}
	}
	return "", false
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
