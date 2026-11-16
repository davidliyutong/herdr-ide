package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/signal"
	"regexp"
	"syscall"
)

// ignoreBrokenPipes keeps the core alive when the launcher that reads its
// stdout and stderr is gone: writes then fail with EPIPE instead of raising
// SIGPIPE, which would kill the process before its cleanup finishes.
func ignoreBrokenPipes() {
	signal.Ignore(syscall.SIGPIPE)
}

// The pipe belongs to the launcher. EOF also covers a launcher crash; no
// separate pid file or polling is needed. Bytes after the hello have no
// meaning.
func stopWithParent(in io.Reader, cancel context.CancelFunc) {
	_, _ = io.Copy(io.Discard, in)
	cancel()
}

// hello is the launcher's first line on stdin (--parent-stdio): what the
// core needs from it before it serves. DesktopToken is the desktop app's
// token of this launch (internal/server's DesktopCookie); stdin, unlike
// the environment, is inherited by nothing the core starts.
type hello struct {
	DesktopToken string `json:"desktop_token,omitempty"`
}

// maxHello bounds the hello line.
const maxHello = 4096

// validToken: a token the launcher made of random bytes, which a cookie
// carries as it is.
var validToken = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

// readHello reads the launcher's hello, a JSON object on one line, from in.
// An error means the launcher sent no usable hello: gone before it (EOF),
// a line too long, not JSON or a malformed token.
func readHello(in *bufio.Reader) (hello, error) {
	var h hello
	line, err := in.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, bufio.ErrBufferFull) {
			return h, errors.New("launcher hello too long")
		}
		return h, fmt.Errorf("launcher hello: %w", err)
	}
	if err := json.Unmarshal(line, &h); err != nil {
		return hello{}, fmt.Errorf("launcher hello: %w", err)
	}
	if h.DesktopToken != "" && !validToken.MatchString(h.DesktopToken) {
		return hello{}, errors.New("launcher hello: malformed desktop token")
	}
	return h, nil
}

func writeReady(out io.Writer, address string) error {
	return json.NewEncoder(out).Encode(struct {
		Event string `json:"event"`
		URL   string `json:"url"`
	}{Event: "ready", URL: "http://" + address})
}
