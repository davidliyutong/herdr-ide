//go:build unix

package agent_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/hostdirs"
)

// Op privacy reports unknown off macOS and, on macOS, opens the protected
// folders itself and leaves the terminals unknown while no terminal core
// runs, which it does not start. It always names the terminal core's
// executable.
func TestPrivacyOp(t *testing.T) {
	s, home := hcAgent(t, "dev")
	ctx := context.Background()
	hcPath := filepath.Join(hostdirs.Of(filepath.Join(home, brand.DataDir("dev"))).Host, "hc", "herdr-core")
	ask := func() agentproto.PrivacyStatus {
		t.Helper()
		rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpPrivacy})
		if err != nil || rep.Privacy == nil {
			t.Fatalf("privacy: %+v %v", rep, err)
		}
		return *rep.Privacy
	}
	unknown := agentproto.AccessUnknown
	defer agent.SetPrivacyOS("linux")()
	if err := os.MkdirAll(filepath.Join(home, "Library", "Safari"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := ask(); got != (agentproto.PrivacyStatus{Files: unknown, Terminals: unknown, HC: hcPath}) {
		t.Fatalf("off macOS: %+v", got)
	}
	agent.SetPrivacyOS("darwin")
	if got := ask(); got != (agentproto.PrivacyStatus{Files: agentproto.AccessGranted, Terminals: unknown, HC: hcPath}) {
		t.Fatalf("on macOS without a terminal core: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(hostdirs.RunDir(filepath.Join(home, brand.DataDir("dev"))), "hc.sock")); !os.IsNotExist(err) {
		t.Fatalf("a terminal core was started: %v", err)
	}
}
