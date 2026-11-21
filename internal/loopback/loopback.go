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

// Windows' sockets report their own codes in the stead of EADDRINUSE,
// EADDRNOTAVAIL and EAFNOSUPPORT.
const (
	wsaeafnosupport  = syscall.Errno(10047)
	wsaeaddrinuse    = syscall.Errno(10048)
	wsaeaddrnotavail = syscall.Errno(10049)
)

// listen is net.Listen; tests replace it.
var listen = net.Listen

// InUse reports whether err says that another program holds the address.
func InUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE) || errors.Is(err, wsaeaddrinuse)
}

// NoAddress reports whether err says that the host has no such address or
// no such family of addresses: nobody listens there.
func NoAddress(err error) bool {
	return errors.Is(err, syscall.EADDRNOTAVAIL) || errors.Is(err, syscall.EAFNOSUPPORT) ||
		errors.Is(err, wsaeaddrnotavail) || errors.Is(err, wsaeafnosupport)
}

// Other listens on the other loopback address for the port of ln, a
// listener on 127.0.0.1 or ::1. owned says whether "localhost" with that
// port then leads to this program whichever address is tried: true with
// the second listener, and when the host has no such address or family
// (NoAddress: nobody listens there). Any other failure leaves the address
// to whoever holds or takes it: owned is false and err says why (InUse
// when another program holds it). A listener that is not on a loopback
// address has no other one: false, without an error.
func Other(ln net.Listener) (other net.Listener, owned bool, err error) {
	a, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !a.IP.IsLoopback() {
		return nil, false, nil
	}
	network, host := "tcp6", "::1"
	if a.IP.To4() == nil {
		network, host = "tcp4", "127.0.0.1"
	}
	other, err = listen(network, net.JoinHostPort(host, strconv.Itoa(a.Port)))
	switch {
	case err == nil:
		return other, true, nil
	case NoAddress(err):
		return nil, true, nil
	}
	return nil, false, err
}
