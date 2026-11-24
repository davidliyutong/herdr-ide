//go:build unix

package agent

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/hc"
)

// Full Disk Access on macOS (op privacy, docs/features/16). macOS grants it
// to a process's responsible process, the one it attributes the file
// accesses to. The agent's is the core's (the local machine's agent runs in
// the core), and the core's is the desktop app that started it, as is
// code-server's. The terminal core is not the app's: herdr-core starts it as
// a launchd job, and the core and each terminal's holder disclaim the
// responsibility they inherit, so the programs of a terminal have what
// herdr-core's executable was granted. Each side is checked by opening, and
// closing again, a folder only Full Disk Access opens; nothing is read.

// privacyOS is the system the probes run on; a test may pretend.
var privacyOS = runtime.GOOS

// fdaFolders are folders under home that only Full Disk Access opens and
// that a Mac has without the user's doing: the folder of the user's privacy
// database, and Safari's.
func fdaFolders(home string) []string {
	return []string{
		filepath.Join(home, "Library", "Application Support", "com.apple.TCC"),
		filepath.Join(home, "Library", "Safari"),
	}
}

// accessOf classifies the error of opening a protected folder: macOS
// refuses it with EPERM; another error (EACCES from the folder's mode, an
// I/O error) says nothing about Full Disk Access.
func accessOf(err error) string {
	switch {
	case err == nil:
		return agentproto.AccessGranted
	case errors.Is(err, syscall.EPERM):
		return agentproto.AccessDenied
	}
	return agentproto.AccessUnknown
}

// filesAccess opens the first of folders that exists in this process.
func filesAccess(folders []string) string {
	for _, p := range folders {
		f, err := os.Open(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err == nil {
			f.Close()
		}
		return accessOf(err)
	}
	return agentproto.AccessUnknown
}

// fdaScript exits 0 when the shell may open the first of its arguments that
// is a folder, 1 when it may not, 3 when none is. The redirection is
// given to true: on a special builtin such as : a failed one would end the
// shell.
const fdaScript = `for d; do [ -d "$d" ] || continue; { true <"$d"; } 2>/dev/null && exit 0; exit 1; done; exit 3`

// terminalsAccess runs fdaScript in the terminal core (machine.exec: its
// child, so the core is its responsible process, as a terminal's holder is
// for the terminal's programs). Without a core answering on socket it is
// unknown; nothing is started.
func terminalsAccess(ctx context.Context, socket string, folders []string) string {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := net.DialTimeout("unix", socket, 2*time.Second)
	if err != nil {
		return agentproto.AccessUnknown
	}
	conn, _, err := hc.Dial(ctx, c)
	if err != nil {
		return agentproto.AccessUnknown
	}
	defer conn.Close()
	var res struct {
		Code     *int `json:"code"`
		TimedOut bool `json:"timed_out"`
	}
	params := map[string]any{
		"argv":    append([]string{"/bin/sh", "-c", fdaScript, "sh"}, folders...),
		"timeout": 10,
	}
	if err := conn.Call(ctx, "machine.exec", params, &res); err != nil || res.Code == nil || res.TimedOut {
		return agentproto.AccessUnknown
	}
	switch *res.Code {
	case 0:
		return agentproto.AccessGranted
	case 1:
		return agentproto.AccessDenied
	}
	return agentproto.AccessUnknown
}

// handlePrivacy answers op privacy; one check runs at a time.
func (a *Agent) handlePrivacy(ctx context.Context, st net.Conn) error {
	defer st.Close()
	p := &agentproto.PrivacyStatus{Files: agentproto.AccessUnknown, Terminals: agentproto.AccessUnknown, HC: a.hcBin()}
	if privacyOS == "darwin" {
		a.privacyMu.Lock()
		folders := fdaFolders(a.home)
		p.Files = filesAccess(folders)
		p.Terminals = terminalsAccess(ctx, a.hcSocket(), folders)
		a.privacyMu.Unlock()
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Privacy: p})
}
