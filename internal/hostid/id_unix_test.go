//go:build unix

package hostid

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

// The machine id is the system's own: macOS's platform UUID as ioreg
// shows it, elsewhere the first machine-id file that has one.
func TestMachineID(t *testing.T) {
	out := []byte(`+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000256, registered>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformUUID" = "AB77F40E-2F67-5607-B4F1-6D5E54732E35"
      "serial-number" = <0000>
    }
`)
	if got := ioregUUID(out); got != "AB77F40E-2F67-5607-B4F1-6D5E54732E35" {
		t.Errorf("ioregUUID = %q", got)
	}
	if got := ioregUUID([]byte("nothing")); got != "" {
		t.Errorf("ioregUUID of nothing = %q", got)
	}
	id := machineID()
	if runtime.GOOS == "darwin" {
		if id == "" {
			t.Error("no platform UUID")
		}
		return
	}
	want := ""
	for _, p := range machineIDFiles {
		if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) != "" {
			want = strings.TrimSpace(string(b))
			break
		}
	}
	if id != want {
		t.Errorf("machineID = %q, want %q", id, want)
	}
}
