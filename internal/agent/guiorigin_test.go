package agent

import (
	"strings"
	"testing"
)

// A program's window names the terminal of the instance's terminal core it
// was started in; a terminal of another terminal core (the user's own) is
// not named.
func TestTerminalFromEnv(t *testing.T) {
	env := func(kv ...string) []byte { return []byte(strings.Join(kv, "\x00") + "\x00") }
	const sock = "/home/u/.herdr-ide/run/hc.sock"
	for _, c := range []struct {
		env  []byte
		want string
		ok   bool
	}{
		{env("PATH=/bin", "HC_TERMINAL_ID=t7", "HC_TERMINAL_SOCKET="+sock), "t7", true},
		{env("HC_TERMINAL_ID=t7", "HC_TERMINAL_SOCKET=/run/user/1000/herdr-core/default.sock"), "", true},
		{env("PATH=/bin", "DISPLAY=:20"), "", false},
		{nil, "", false},
	} {
		if term, ok := terminalFromEnv(c.env, sock); term != c.want || ok != c.ok {
			t.Errorf("%q: %q %v, want %q %v", c.env, term, ok, c.want, c.ok)
		}
	}
}
