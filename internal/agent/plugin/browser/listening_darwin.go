//go:build darwin

package browser

import (
	"context"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// listening asks lsof for the user's listening TCP sockets (fields: p the
// process, c its command, n the address) and keeps those bound to loopback
// or to every address, which a dial to loopback reaches.
func listening(ctx context.Context) []Port {
	cmd := exec.CommandContext(ctx, "/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-u", strconv.Itoa(os.Getuid()), "-F", "pcn")
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/bin", "LC_ALL=C"}
	b, _ := cmd.Output()
	var out []Port
	command := ""
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'c':
			command = line[1:]
		case 'n':
			host, port, err := net.SplitHostPort(line[1:])
			n, perr := strconv.Atoi(port)
			if err != nil || perr != nil {
				continue
			}
			if ip := net.ParseIP(strings.Trim(host, "[]")); host == "*" || (ip != nil && (ip.IsUnspecified() || ip.IsLoopback())) {
				out = append(out, Port{Port: n, Process: command})
			}
		}
	}
	return out
}
