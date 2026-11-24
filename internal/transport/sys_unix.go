//go:build unix

package transport

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"veldr/internal/brand"
)

// ControlDir returns the private directory holding an instance's ssh
// control sockets: s for the default instance, s-<instance> for another
// (h-<hash> for a name longer than maxControlName: a prefix of its own, as
// the hash is itself a valid short name), so instances never share a
// connection. It lives in /tmp because unix socket paths are
// limited to ~104 bytes; as /tmp is shared, both levels must be real
// directories owned by us and not accessible to anyone else, otherwise
// another local user could plant control sockets and hijack every ssh
// connection.
func ControlDir(instance string) (string, error) {
	parent := filepath.Join("/tmp", fmt.Sprintf("%s-%d", brand.Slug, os.Getuid()))
	dir := filepath.Join(parent, controlName(instance))
	for _, d := range []string{parent, dir} {
		if err := os.Mkdir(d, 0o700); err != nil && !os.IsExist(err) {
			return "", err
		}
		if err := checkPrivateDir(d); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// maxControlName keeps a control socket's path, <dir>/<%C: 40 hex> and the
// 17 characters ssh adds while it binds, within macOS's 104 bytes.
const maxControlName = 16

func controlName(instance string) string {
	switch {
	case instance == "":
		return "s"
	case len(instance) <= maxControlName:
		return "s-" + instance
	}
	sum := sha256.Sum256([]byte(instance))
	return "h-" + hex.EncodeToString(sum[:6])
}

func checkPrivateDir(d string) error {
	st, err := os.Lstat(d)
	if err != nil {
		return err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() {
		return fmt.Errorf("%s is not a directory owned by uid %d; refusing to use it for ssh control sockets", d, os.Getuid())
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s is accessible by other users (mode %v); run: chmod 700 %s", d, st.Mode().Perm(), d)
	}
	return nil
}

// noConsole does nothing outside Windows.
func noConsole(*exec.Cmd) {}
