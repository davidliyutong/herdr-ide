package main

import (
	"context"
	"encoding/json"
	"io"
)

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
