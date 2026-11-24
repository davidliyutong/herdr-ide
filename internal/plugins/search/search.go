// Package search is the core's side of the Project Search plugin
// (docs/features/41-project-search.md): a route below
// /api/m/{id}/p/search/ that searches the contents of the files below a
// directory of the machine with its machine side
// (internal/agent/plugin/search). A search only reads: the route is not
// mutating, and read-only mode searches too.
package search

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"veldr/internal/plugin"
)

const (
	// ID names the plugin on every side.
	ID = "search"
	// MaxQuery and MaxGlobs bound a query and the include or exclude
	// patterns (the agent's limits); MaxResults the matches asked for.
	MaxQuery   = 2000
	MaxGlobs   = 4000
	MaxResults = 5000
	// maxBody bounds a search's JSON.
	maxBody = 16 << 10
	// timeout bounds a search: the agent stops its own after 30 s and
	// answers what it found; this covers the transfer of the result.
	timeout = 45 * time.Second
)

// Plugin is Project Search.
type Plugin struct{}

// New returns the plugin.
func New() Plugin { return Plugin{} }

func (Plugin) ID() string { return ID }

func (Plugin) Routes() []plugin.Route {
	return []plugin.Route{
		// A POST for the length of its query and patterns; it reads only:
		// not mutating.
		{Method: http.MethodPost, Path: "search", Machine: true, Handler: search},
	}
}

// Params are a search's parameters (the agent's search.Params).
type Params struct {
	Dir           string `json:"dir"`
	Query         string `json:"query"`
	Regex         bool   `json:"regex,omitempty"`
	CaseSensitive bool   `json:"caseSensitive,omitempty"`
	WholeWord     bool   `json:"wholeWord,omitempty"`
	Include       string `json:"include,omitempty"`
	Exclude       string `json:"exclude,omitempty"`
	MaxResults    int    `json:"maxResults,omitempty"`
}

// check validates p; the error is the answer's message.
func check(p Params) error {
	switch {
	case p.Query == "" || len(p.Query) > MaxQuery || strings.ContainsAny(p.Query, "\x00\r\n"):
		return errors.New("a query of one line, 1 to 2000 bytes")
	case p.Dir == "" || strings.ContainsRune(p.Dir, 0):
		return errors.New("dir required")
	case len(p.Include) > MaxGlobs || len(p.Exclude) > MaxGlobs:
		return errors.New("patterns of at most 4000 bytes")
	case p.MaxResults < 0 || p.MaxResults > MaxResults:
		return errors.New("maxResults between 0 and 5000")
	}
	return nil
}

// search runs a search ({dir, query, regex, caseSensitive, wholeWord,
// include, exclude, maxResults}) and answers the agent's result: the
// files with their matching lines, the engine that ran and whether the
// search stopped early. A search the machine does not answer within
// timeout is a 504.
func search(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var p Params
	if err := plugin.ReadJSON(r, maxBody, &p); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if err := check(p); err != nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
		return
	}
	if c.Machine == nil {
		plugin.WriteError(w, plugin.ErrOffline)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	var out json.RawMessage
	if err := plugin.Request(ctx, c.Machine, ID, "search", p, &out); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			plugin.WriteJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "timeout", "message": "the machine did not answer in time"})
			return
		}
		plugin.WriteError(w, err)
		return
	}
	if len(out) == 0 {
		out = json.RawMessage("{}")
	}
	plugin.WriteRaw(w, out)
}
