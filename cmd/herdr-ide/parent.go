package main

import (
	"context"
	"encoding/json"
	"io"
	"os/signal"
	"syscall"
)

// ignoreBrokenPipes keeps the core alive when the launcher that reads its
// stdout and stderr is gone: writes then fail with EPIPE instead of raising
// SIGPIPE, which would kill the process before its cleanup finishes.
func ignoreBrokenPipes() {
	signal.Ignore(syscall.SIGPIPE)
}

// The pipe belongs to the launcher. EOF also covers a launcher crash; no
// separate pid file or polling is needed. Bytes on stdin have no meaning.
func stopWithParent(in io.Reader, cancel context.CancelFunc) {
	_, _ = io.Copy(io.Discard, in)
	cancel()
}

func writeReady(out io.Writer, address string) error {
	return json.NewEncoder(out).Encode(struct {
		Event string `json:"event"`
		URL   string `json:"url"`
	}{Event: "ready", URL: "http://" + address})
}
