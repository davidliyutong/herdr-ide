// Package loopback is about the two loopback addresses of a host: the name
// "localhost" leads to 127.0.0.1 and to ::1, and a browser tries either
// first. A program that listens on one of them for a port leaves the other
// to whoever takes it, who then answers under the same name and port.
package loopback

import (
	"errors"
	"net"
	"strconv"
	"syscall"
)

// wsaeaddrinuse is Windows' "address already in use", which its sockets
// report in the stead of EADDRINUSE.
const wsaeaddrinuse = syscall.Errno(10048)

// InUse reports whether err says that another program holds the address.
func InUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE) || errors.Is(err, wsaeaddrinuse)
}

// Other listens on the other loopback address for the port of ln, a
// listener on 127.0.0.1 or ::1. owned says whether "localhost" with that
// port then leads to this program whichever address is tried: true with
// the second listener, and when the host has no such address (nobody
// listens there); false when another program holds it (err says so) and
// for a listener that is not on a loopback address.
func Other(ln net.Listener) (other net.Listener, owned bool, err error) {
	a, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !a.IP.IsLoopback() {
		return nil, false, nil
	}
	network, host := "tcp6", "::1"
	if a.IP.To4() == nil {
		network, host = "tcp4", "127.0.0.1"
	}
	other, err = net.Listen(network, net.JoinHostPort(host, strconv.Itoa(a.Port)))
	switch {
	case err == nil:
		return other, true, nil
	case InUse(err):
		return nil, false, err
	}
	return nil, true, nil
}
