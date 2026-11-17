package browser

import (
	"reflect"
	"strings"
	"testing"
)

// The kernel's tables as /proc/net/tcp and tcp6 print them on a
// little-endian machine: addresses in hex, each 32-bit word in host byte
// order, then the port.
const (
	procTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0
   2: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0
   3: 0F02000A:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0
   4: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55555 1 0000000000000000 100 0 0 10 0
   5: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 66666 1 0000000000000000 20 4 30 10 -1
   6: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 77777 1 0000000000000000 100 0 0 10 0
   7: 0100007F0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 88888 1 0000000000000000 100 0 0 10 0
   8: 0100007F:0BB9 00000000:0000 0A
`
	procTCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1451 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12121 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23232 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:2710 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 34343 1 0000000000000000 100 0 0 10 0
   3: 000080FE00000000FF005452FE563412:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45454 1 0000000000000000 100 0 0 10 0
   4: 0000000000000000FFFF00000F02000A:1F92 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 56565 1 0000000000000000 100 0 0 10 0
`
)

// The listening sockets of the user that a dial to loopback reaches: on
// 127.0.0.0/8, ::1, a mapped loopback address or every address; not
// another user's, not a connection, not one bound to another address, and
// no line that does not read.
func TestListeners(t *testing.T) {
	got := map[string]int{}
	listeners(strings.NewReader(procTCP), "1000", got)
	listeners(strings.NewReader(procTCP6), "1000", got)
	want := map[string]int{
		"11111": 3000,  // 127.0.0.1
		"22222": 8080,  // 0.0.0.0
		"33333": 53,    // 127.0.0.53
		"12121": 5201,  // ::1
		"23232": 9000,  // ::
		"34343": 10000, // ::ffff:127.0.0.1
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("listeners: %v, want %v", got, want)
	}
	// Another user's table: only that user's socket.
	got = map[string]int{}
	listeners(strings.NewReader(procTCP), "0", got)
	if !reflect.DeepEqual(got, map[string]int{"55555": 5432}) {
		t.Errorf("of user 0: %v", got)
	}
	// An empty table, and a header alone.
	got = map[string]int{}
	listeners(strings.NewReader(""), "1000", got)
	listeners(strings.NewReader(strings.SplitAfter(procTCP, "\n")[0]), "1000", got)
	if len(got) != 0 {
		t.Errorf("of an empty table: %v", got)
	}
}

func TestReachable(t *testing.T) {
	for addr, want := range map[string]bool{
		"0100007F":                         true,  // 127.0.0.1
		"0101007F":                         true,  // 127.0.1.1
		"00000000":                         true,  // 0.0.0.0
		"0F02000A":                         false, // 10.0.2.15
		"0100A8C0":                         false, // 192.168.0.1
		"00000000000000000000000001000000": true,  // ::1
		"00000000000000000000000000000000": true,  // ::
		"0000000000000000FFFF00000100007F": true,  // ::ffff:127.0.0.1
		"000080FE00000000FF005452FE563412": false, // fe80::...
		"B80D0120000000000000000001000000": false, // 2001:db8::1
		"":                                 false,
		"0100007":                          false,
		"xyz":                              false,
		"0100007F00":                       false,
	} {
		if got := reachable(addr); got != want {
			t.Errorf("reachable(%q) = %v, want %v", addr, got, want)
		}
	}
}
