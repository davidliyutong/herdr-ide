//go:build unix

package codex

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"veldr/internal/chatproto"
)

// What the app-server left running in its group ends with it: SIGTERM
// once the app-server is gone, then SIGKILL for what ignores that, after a
// Close and after the app-server's own exit alike.
func TestLeftoversEnded(t *testing.T) {
	for _, crash := range []bool{false, true} {
		name := "close"
		if crash {
			name = "crash"
		}
		t.Run(name, func(t *testing.T) {
			var sc script
			sc.begin()
			if crash {
				sc.line(map[string]any{"dir": "in", "sleep": 1000})
				sc.line(map[string]any{"dir": "in", "exit": 3})
			}
			f := newFake(t, "", handshake, sc.file(t))
			pidFile := filepath.Join(t.TempDir(), "child")
			f.env = append(f.env, "FAKE_CHILD="+pidFile)
			s, _ := start(t, f, chatproto.Options{}, "")
			var b []byte
			for wait := time.Now().Add(10 * time.Second); len(b) == 0; time.Sleep(10 * time.Millisecond) {
				if time.Now().After(wait) {
					t.Fatal("the leftover did not start")
				}
				b, _ = os.ReadFile(pidFile)
			}
			pid, err := strconv.Atoi(string(b))
			if err != nil || pid <= 1 {
				t.Fatalf("child pid %q", b)
			}
			t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
			if !crash {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				s.Close(ctx)
			}
			select {
			case <-s.Done():
			case <-time.After(10 * time.Second):
				t.Fatal("the session did not end")
			}
			deadline := time.Now().Add(closeWait + 2*killWait + 5*time.Second)
			for syscall.Kill(pid, 0) == nil {
				if time.Now().After(deadline) {
					t.Fatal("the app-server's leftover still runs")
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
}
