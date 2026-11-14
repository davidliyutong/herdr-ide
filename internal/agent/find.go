package agent

import (
	"context"
	"errors"
	"io"
	"net"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr"
	"herdr-ide/internal/panefind"
)

// findTimeout bounds one search: herdr's reads and the matching.
const findTimeout = 20 * time.Second

// handleFind searches a pane's text next to herdr (panefind.Pane): its
// requests to herdr stay on this machine, so a search crosses the link to
// the core once, with only the matches coming back. Nothing is kept.
func (a *Agent) handleFind(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if h.Find == nil {
		return agentproto.Fail(st, errors.New("missing find"))
	}
	ctx, cancel := context.WithTimeout(ctx, findTimeout)
	defer cancel()
	// The core closes the stream when the browser gave up on the search
	// (a newer query); the work then stops.
	go func() {
		_, _ = io.Copy(io.Discard, st)
		cancel()
	}()
	sock := a.herdrSocket(h.Session)
	c := &herdr.Client{Dial: func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}
	res, err := panefind.Pane(ctx, c, *h.Find)
	if err != nil {
		return agentproto.WriteLine(st, agentproto.Reply{Error: err.Error(), Code: findCode(err)})
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Find: res})
}

// findCode classifies a search error for the browser.
func findCode(err error) string {
	var inv *panefind.InvalidError
	var api *herdr.APIError
	switch {
	case errors.As(err, &inv):
		return agentproto.FindInvalidRegex
	case errors.Is(err, panefind.ErrTooLarge):
		return agentproto.FindTooLarge
	case errors.Is(err, panefind.ErrNoText):
		return agentproto.FindUnavailable
	case errors.As(err, &api):
		return api.Code
	}
	return ""
}
