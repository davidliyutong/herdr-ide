// Package git is the core's side of the Git plugin
// (docs/features/31-git.md): routes below /api/m/{id}/p/git/ that run the
// actions of its machine side (internal/agent/plugin/git). Reads are GETs
// with their parameters in the query; changes are POSTs with a JSON body,
// refused in read-only mode and audited as git.<action>.
package git

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"herdr-ide/internal/plugin"
)

const (
	// maxBody bounds a change's JSON (a patch or a commit message with
	// the rest).
	maxBody = 5 << 20
	// readTimeout and writeTimeout bound an action; the agent's own
	// timeouts (15 s, 120 s) end git before them.
	readTimeout  = 40 * time.Second
	writeTimeout = 5 * time.Minute
)

// Reads are the actions that change nothing.
var Reads = []string{"repo", "status", "log", "show", "blob", "branches", "tags", "stashes", "diffStat", "watch"}

// Writes are the changes.
var Writes = []string{
	"stage", "unstage", "applyPatch", "discard", "commit",
	"checkout", "branchCreate", "branchDelete", "branchRename",
	"merge", "rebase", "abort", "continue", "cherryPick", "revert", "reset",
	"tagCreate", "tagDelete", "stashPush", "stashApply", "stashPop", "stashDrop",
	"fetch", "pull", "push",
}

// Plugin is Git.
type Plugin struct{}

// New returns the plugin.
func New() Plugin { return Plugin{} }

func (Plugin) ID() string { return "git" }

func (Plugin) Routes() []plugin.Route {
	var rts []plugin.Route
	for _, a := range Reads {
		rts = append(rts, plugin.Route{Method: http.MethodGet, Path: a, Machine: true, Handler: read(a)})
	}
	for _, a := range Writes {
		rts = append(rts, plugin.Route{Method: http.MethodPost, Path: a, Machine: true, Mutating: true, Audit: a, Handler: change(a)})
	}
	return rts
}

// queryParams reads a read's query: strings, numbers, booleans ("1" or
// "true") and the repeated branch.
func queryParams(r *http.Request) (map[string]any, error) {
	q := r.URL.Query()
	p := map[string]any{}
	for _, k := range []string{"repo", "path", "rev", "rev2", "source"} {
		if v := q.Get(k); v != "" {
			p[k] = v
		}
	}
	for _, k := range []string{"skip", "limit", "parent"} {
		if v := q.Get(k); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, &plugin.Error{Code: "bad_request", Message: k + " is not a number"}
			}
			p[k] = n
		}
	}
	if v := q.Get("remotes"); v == "1" || v == "true" {
		p["remotes"] = true
	}
	if bs := q["branch"]; len(bs) > 0 {
		p["branches"] = bs
	}
	return p, nil
}

func read(action string) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		p, err := queryParams(r)
		if err != nil {
			plugin.WriteError(w, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), readTimeout)
		defer cancel()
		forward(ctx, c, w, action, p)
	}
}

func change(action string) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		if err := plugin.ReadJSON(r, maxBody, &p); err != nil {
			plugin.WriteError(w, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), writeTimeout)
		defer cancel()
		forward(ctx, c, w, action, p)
	}
}

// forward runs the action on the machine and answers its result.
func forward(ctx context.Context, c *plugin.Call, w http.ResponseWriter, action string, p map[string]any) {
	var out json.RawMessage
	if err := plugin.Request(ctx, c.Machine, "git", action, p, &out); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if len(out) == 0 {
		out = json.RawMessage("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}
