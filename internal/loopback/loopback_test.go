package loopback

import (
	"net"
	"testing"
)

// The other loopback address of a listener's port is taken, so "localhost"
// leads here; held by another program it is not, and the caller is told.
func TestOther(t *testing.T) {
	six, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback")
	}
	six.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	other, owned, err := Other(ln)
	if err != nil || !owned || other == nil {
		t.Fatalf("a free port: %v %v %v", other, owned, err)
	}
	if a := other.Addr().(*net.TCPAddr); !a.IP.IsLoopback() || a.IP.To4() != nil || a.Port != ln.Addr().(*net.TCPAddr).Port {
		t.Errorf("listening on %v", a)
	}
	// Asked again, this program's own listener holds it: in use.
	if again, owned, err := Other(ln); again != nil || owned || !InUse(err) {
		t.Errorf("a held port: %v %v %v", again, owned, err)
	}
	other.Close()
	// From ::1 the other is 127.0.0.1.
	six, _ = net.Listen("tcp6", "[::1]:0")
	defer six.Close()
	four, owned, err := Other(six)
	if err != nil || !owned || four.Addr().(*net.TCPAddr).IP.To4() == nil {
		t.Fatalf("from ::1: %v %v %v", four, owned, err)
	}
	four.Close()
	// A listener on every address has no other loopback address to take.
	all, _ := net.Listen("tcp4", "0.0.0.0:0")
	defer all.Close()
	if o, owned, err := Other(all); o != nil || owned || err != nil {
		t.Errorf("not on loopback: %v %v %v", o, owned, err)
	}
}
