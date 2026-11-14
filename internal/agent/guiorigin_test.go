package agent

import (
	"strings"
	"testing"
)

// A program's window names the herdr pane or the terminal of the
// instance's terminal core it was started in; a terminal of another
// terminal core (the user's own) is not named.
func TestOriginFromEnv(t *testing.T) {
	env := func(kv ...string) []byte { return []byte(strings.Join(kv, "\x00") + "\x00") }
	const sock = "/home/u/.herdr-ide/run/hc.sock"
	for _, c := range []struct {
		env  []byte
		want origin
		ok   bool
	}{
		{env("PATH=/bin", "HC_TERMINAL_ID=t7", "HC_TERMINAL_SOCKET="+sock), origin{terminal: "t7"}, true},
		{env("HC_TERMINAL_ID=t7", "HC_TERMINAL_SOCKET=/run/user/1000/herdr-core/default.sock"), origin{}, true},
		{env("HERDR_PANE_ID=p_3", "HERDR_SOCKET_PATH=/s"), origin{pane: "p_3", socket: "/s"}, true},
		{env("HERDR_PANE_ID=p_3", "HC_TERMINAL_ID=t1", "HC_TERMINAL_SOCKET="+sock), origin{pane: "p_3", terminal: "t1"}, true},
		{env("PATH=/bin", "DISPLAY=:20"), origin{}, false},
		{nil, origin{}, false},
	} {
		if o, ok := originFromEnv(c.env, sock); o != c.want || ok != c.ok {
			t.Errorf("%q: %+v %v, want %+v %v", c.env, o, ok, c.want, c.ok)
		}
	}
}
