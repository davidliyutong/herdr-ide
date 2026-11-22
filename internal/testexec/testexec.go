// Package testexec makes shell scripts for tests to run as programs.
//
// macOS assesses an executable file the first time it runs: a fraction of
// a second each, and seconds while the whole suite starts its test
// binaries, which macOS assesses one after another. A script made here is
// a symbolic link to one shell stub, assessed once (and kept in the
// temporary directory for the next runs), that runs the script's body
// from a file beside the link; the process is the stub's, so the body's
// $$ is the program's pid.
package testexec

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// stubBody runs the body beside the link it was started through.
const stubBody = "#!/bin/sh\nexec /bin/sh \"$0.sh\" \"$@\"\n"

var (
	stubOnce sync.Once
	stubPath string
	stubErr  error
)

func stub() (string, error) {
	stubOnce.Do(func() {
		sum := sha256.Sum256([]byte(stubBody))
		p := filepath.Join(os.TempDir(), "testexec-"+hex.EncodeToString(sum[:6]))
		// Reused only when it is this user's regular file, private and
		// unchanged: a shared temporary directory may hold another user's.
		if b, err := os.ReadFile(p); err == nil && string(b) == stubBody {
			if st, err := os.Lstat(p); err == nil && st.Mode().IsRegular() && st.Mode().Perm() == 0o700 && ownedByMe(st) {
				stubPath = p
				return
			}
		}
		f, err := os.CreateTemp(os.TempDir(), "testexec-*")
		if err != nil {
			stubErr = err
			return
		}
		_, err = f.WriteString(stubBody)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			err = os.Chmod(f.Name(), 0o700)
		}
		if err != nil {
			os.Remove(f.Name())
			stubErr = err
			return
		}
		// A name held by another user's file stays theirs: this run uses
		// its own stub.
		if os.Rename(f.Name(), p) != nil {
			stubPath = f.Name()
			return
		}
		stubPath = p
	})
	return stubPath, stubErr
}

// Script makes the program name in a new temporary directory of t that
// runs body with /bin/sh (no #! line), and returns its path.
func Script(t testing.TB, name, body string) string {
	t.Helper()
	return ScriptAt(t, filepath.Join(t.TempDir(), name), body)
}

// ScriptAt makes the program path (its directory must exist) that runs
// body with /bin/sh, replacing what was there, and returns path. Its body
// is at path+".sh".
func ScriptAt(t testing.TB, path, body string) string {
	t.Helper()
	s, err := stub()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".sh", []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Remove(path)
	if err := os.Symlink(s, path); err != nil {
		t.Fatal(err)
	}
	return path
}
