package vaultmcp

import (
	"os"
	"testing"

	"herdr-ide/internal/agentproto"
)

// helperEnv makes the test binary an MCP server on its stdin and stdout, as
// Main serves (signals included), with a core that gives every variable it
// is asked for: the tests that end a server with a signal start it
// (signal_unix_test.go).
const helperEnv = "VAULTMCP_TEST_SERVER"

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		os.Exit(serveStdio(&Server{Dial: fakeCore(nil, func(req agentproto.VaultRequest) agentproto.VaultResponse {
			values := map[string]string{}
			for _, n := range req.Names {
				values[n] = "secret-" + n
			}
			return agentproto.VaultResponse{OK: true, Values: values}
		}, nil)}))
	}
	os.Exit(m.Run())
}
