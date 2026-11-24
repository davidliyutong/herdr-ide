//go:build unix

package hostid

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// machineIDFiles are where systems other than macOS keep the machine's id:
// systemd's (and dbus's, which systemd links to it) and FreeBSD's.
var machineIDFiles = []string{"/etc/machine-id", "/var/lib/dbus/machine-id", "/etc/hostid"}

// machineID is the machine's own id, which the system keeps on the machine
// (not on a home that hosts share): on macOS the platform's UUID
// (IOPlatformUUID), elsewhere the first of machineIDFiles that has one; ""
// for none.
func machineID() string {
	if runtime.GOOS == "darwin" {
		return platformUUID()
	}
	for _, p := range machineIDFiles {
		if b, err := os.ReadFile(p); err == nil {
			if id := strings.TrimSpace(string(b)); id != "" && len(id) <= 256 {
				return id
			}
		}
	}
	return ""
}

// platformUUID is macOS's hardware UUID, as ioreg shows it, "" when it
// cannot be read in 5 s.
func platformUUID() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return ""
	}
	return ioregUUID(out)
}

// ioregUUID is the IOPlatformUUID of ioreg's output.
func ioregUUID(out []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok && strings.TrimSpace(k) == `"IOPlatformUUID"` {
			return strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return ""
}
