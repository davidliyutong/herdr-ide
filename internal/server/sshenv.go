package server

import (
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"veldr/internal/machines"
	"veldr/internal/uisettings"
)

// machineSSHEnv returns SSH_CONNECTION and SSH_CLIENT for the new terminals
// of an ssh machine, as the ssh session of its agent has them. A terminal
// core started as a service of the user does not pass them on, and programs
// take them as the sign that the user's clipboard and browser are not on
// the machine: Codex then also copies through the terminal (OSC 52), reads
// pastes from it and logs in with a device code. None for the local
// machine, where they would not be true, nor with terminal.sshEnv off.
func (s *Server) machineSSHEnv(mc *machines.Machine) map[string]string {
	if mc.Local() {
		return nil
	}
	if st := s.opts.Settings; st != nil && !st.Bool(uisettings.SSHEnv, mc.ID()) {
		return nil
	}
	return sshEnv(mc.SSHConnection())
}

// zone is an IPv6 zone that may reach a terminal: none, or an interface's
// name.
var zone = regexp.MustCompile(`^[A-Za-z0-9._-]{0,32}$`)

// sshEnv parses an SSH_CONNECTION ("client port server port") into the two
// variables; nil for anything else, so that only addresses and ports reach
// a terminal's environment.
func sshEnv(conn string) map[string]string {
	f := strings.Fields(conn)
	if len(f) != 4 || len(conn) > 200 {
		return nil
	}
	for i, v := range f {
		if i%2 == 0 {
			// A link-local address names its interface after "%": only
			// what an interface is called, since a zone is any text.
			a, err := netip.ParseAddr(v)
			if err != nil || !zone.MatchString(a.Zone()) {
				return nil
			}
		} else if n, err := strconv.Atoi(v); err != nil || n < 0 || n > 65535 {
			return nil
		}
	}
	return map[string]string{
		"SSH_CONNECTION": strings.Join(f, " "),
		"SSH_CLIENT":     f[0] + " " + f[1] + " " + f[3],
	}
}
