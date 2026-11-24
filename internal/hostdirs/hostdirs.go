// Package hostdirs lays out a namespace's directories on a host. The data
// directory (~/.<slug>[-<instance>]) is on the user's home, which several
// hosts may share (NFS); what belongs to one host is kept apart:
//
//   - Run, host-local and private: sockets, locks, pid files, the display's
//     files. In /run/user/<uid> (tmpfs, one per host) where the system has
//     it, else <data>/run-<hostid.ID>.
//   - Host, <data>/hosts/<hostid.Key>: this host's persistent files that
//     must not be shared (executables replaced while another host runs
//     them, code-server's state, logs).
//
// Everything else in the data directory may be shared: files named per
// host (databases), or by content (agent builds).
package hostdirs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"herdr-ide/internal/brand"
	"herdr-ide/internal/hostid"
)

// Dirs are a namespace's directories on this host.
type Dirs struct {
	// Home is the user's home directory.
	Home string
	// Base is the namespace's data directory, ~/<brand.DataDir(instance)>.
	Base string
	// Host is Base/hosts/<hostid.Key>, this host's persistent files.
	Host string
	// Run is this host's private runtime directory of Base (RunDir).
	Run string
}

// HostsDir is the directory of the data directory holding the hosts'
// directories.
const HostsDir = "hosts"

// For returns the directories of instance, without creating them.
func For(instance string) (Dirs, error) {
	if !brand.ValidInstance(instance) {
		return Dirs{}, fmt.Errorf("invalid instance name %q", instance)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Dirs{}, err
	}
	return Of(filepath.Join(home, brand.DataDir(instance))), nil
}

// Of returns the directories of the data directory base (whose parent is
// the home), without creating them.
func Of(base string) Dirs {
	return Dirs{
		Home: filepath.Dir(base),
		Base: base,
		Host: filepath.Join(base, HostsDir, hostid.Key()),
		Run:  RunDir(base),
	}
}

// Make creates the directories, private to the user (0700), also when
// they existed with looser permissions: the run directory holds sockets
// with no other authentication.
func (d Dirs) Make() error {
	for _, p := range []string{d.Base, d.Host} {
		if err := os.MkdirAll(p, 0o700); err != nil {
			return err
		}
		_ = os.Chmod(p, 0o700)
	}
	return MakeRun(d.Run)
}

// MakeRun creates the runtime directory dir, a directory of the user's
// alone with mode 0700, and refuses one that is a link or another user's.
func MakeRun(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if !ownDir(fi) {
		return fmt.Errorf("%s is another user's", dir)
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// RunDir is the runtime directory of the data directory base on this
// host: in the user's runtime directory (userRuntime) a directory named
// after base and a hash of its real path, so a namespace of another home
// (tests set HOME) never meets it; else base/run-<hostid.ID>. Every
// process of a namespace finds the same: it depends on neither the
// environment nor the host's name.
func RunDir(base string) string {
	if dir, ok := userRuntime(); ok {
		return filepath.Join(dir, runName(base))
	}
	return filepath.Join(base, "run-"+hostid.ID())
}

// runName is the name of base's directory in the user's runtime
// directory: base's name without its dot and 8 hex digits of the SHA-256
// of base with its parent's links resolved (the parent, the home, exists
// before base does).
func runName(base string) string {
	real := base
	if p, err := filepath.EvalSymlinks(filepath.Dir(base)); err == nil {
		real = filepath.Join(p, filepath.Base(base))
	}
	sum := sha256.Sum256([]byte(real))
	return strings.TrimPrefix(filepath.Base(base), ".") + "-" + hex.EncodeToString(sum[:4])
}
