// Package git is the core's side of the Git plugin
// (docs/features/31-git.md): routes below /api/m/{id}/p/git/ that run the
// actions of its machine side (internal/agent/plugin/git). Reads are GETs
// with their parameters in the query; changes are POSTs with a JSON body,
// refused in read-only mode and audited as git.<action> and, with what
// they acted on and how they ended, git.<action>.done.
package git

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"veldr/internal/plugin"
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
		plugin.ForwardJSON(c, w, r, "git", action, p, readTimeout)
	}
}

func change(action string) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		if err := plugin.ReadJSON(r, maxBody, &p); err != nil {
			plugin.WriteError(w, err)
			return
		}
		err := plugin.ForwardJSON(c, w, r, "git", action, p, writeTimeout)
		// The framework audits git.<action> with its status once this
		// returns; this records what was changed and how it ended.
		fields := auditFields(p)
		if c.Machine != nil {
			fields["machine"] = c.Machine.ID()
		}
		fields["ok"] = err == nil
		var pe *plugin.Error
		if errors.As(err, &pe) {
			fields["code"] = pe.Code
		}
		if c.Host != nil {
			c.Host.Audit(r, "git."+action+".done", fields)
		}
	}
}

// auditNames are the parameters of a change an audit records (what it
// acted on); auditFlags its switches. Patches and messages are never
// recorded; paths only by their number.
var (
	auditNames = []string{"repo", "rev", "rev2", "ref", "onto", "name", "to", "at", "remote", "branch", "tag", "mode", "op", "hash"}
	auditFlags = []string{"force", "forceWithLease", "amend", "all"}
)

// auditFields are the fields of a change's audit record.
func auditFields(p map[string]any) map[string]any {
	f := map[string]any{}
	for _, k := range auditNames {
		if v, ok := p[k].(string); ok && v != "" {
			if len(v) > 512 {
				v = v[:512]
			}
			f[k] = v
		}
	}
	for _, k := range auditFlags {
		if v, ok := p[k].(bool); ok && v {
			f[k] = true
		}
	}
	n := 0
	for _, k := range []string{"paths", "untracked"} {
		if ps, ok := p[k].([]any); ok {
			n += len(ps)
		}
	}
	if n > 0 {
		f["paths"] = n
	}
	return f
}
