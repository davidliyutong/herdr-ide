// Package files is the core's side of the file explorer plugin
// (docs/features/28-file-explorer.md): routes below
// /api/m/{id}/p/files/ that run the actions of its machine side
// (internal/agent/plugin/files). Listing directories and reading files
// use the core's own routes (/api/m/{id}/list, /file, /download); the
// plugin adds the changes, the stat the explorer polls, and saving an
// editor's text.
package files

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/plugin"
)

const (
	// MaxWrite bounds an editor's save (the agent's limit).
	MaxWrite = 8 << 20
	// MaxStat bounds the paths of one stat (the agent's limit).
	MaxStat = 200
	// MaxUpload bounds an upload into the explorer (the agent's limit, as
	// the core's /upload).
	MaxUpload = 4 << 30
	// maxBody bounds the JSON of a change.
	maxBody = 1 << 20
	// timeout bounds an action; copies and removals of large trees take
	// the longest.
	timeout = 10 * time.Minute
)

// Plugin is the file explorer.
type Plugin struct{}

// New returns the plugin.
func New() Plugin { return Plugin{} }

func (Plugin) ID() string { return "files" }

// Entry is the stat of a path (the agent's files.Entry); Error tells why
// its state is not known.
type Entry struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	IsDir  bool   `json:"is_dir,omitempty"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"`
	Error  string `json:"error,omitempty"`
}

// params are an action's parameters (the agent's files.Params).
type params struct {
	Path   string   `json:"path,omitempty"`
	Paths  []string `json:"paths,omitempty"`
	To     string   `json:"to,omitempty"`
	Dir    string   `json:"dir,omitempty"`
	Expect *Entry   `json:"expect,omitempty"`
	Force  bool     `json:"force,omitempty"`
	// Method is how a save writes a file that is there (auto, replace).
	Method  string `json:"method,omitempty"`
	Replace bool   `json:"replace,omitempty"`
	Unique  bool   `json:"unique,omitempty"`
}

func (Plugin) Routes() []plugin.Route {
	change := func(action string) plugin.Route {
		return plugin.Route{Method: http.MethodPost, Path: action, Machine: true, Mutating: true, Audit: action, Handler: run(action)}
	}
	return []plugin.Route{
		// A POST for the length of its paths, but it changes nothing: not
		// mutating, so read-only mode polls too.
		{Method: http.MethodPost, Path: "stat", Machine: true, Handler: stat},
		change("mkdir"),
		change("mkdirs"),
		change("create"),
		change("rename"),
		change("move"),
		change("copy"),
		change("trash"),
		change("remove"),
		{Method: http.MethodPost, Path: "write", Machine: true, Mutating: true, Audit: "write", Handler: write},
		{Method: http.MethodPost, Path: "upload", Machine: true, Mutating: true, Audit: "upload", Handler: upload},
	}
}

// stat answers the state of the paths ({"paths"}, at most MaxStat): the
// explorer polls the directories it shows expanded. The paths are a body,
// not a query: 200 of them make a URL longer than proxies take.
func stat(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	var p params
	if err := plugin.ReadJSON(r, maxBody, &p); err != nil {
		plugin.WriteError(w, err)
		return
	}
	paths := p.Paths
	if len(paths) == 0 || len(paths) > MaxStat {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "between 1 and 200 paths"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var out []Entry
	if err := plugin.Request(ctx, c.Machine, "files", "stat", params{Paths: paths}, &out); err != nil {
		plugin.WriteError(w, err)
		return
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// run answers a change: its JSON body is the action's parameters.
func run(action string) func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	return func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		var p params
		if err := plugin.ReadJSON(r, maxBody, &p); err != nil {
			plugin.WriteError(w, err)
			return
		}
		p.Expect, p.Force, p.Method, p.Replace = nil, false, "", false
		auditTargets(c, p)
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		var out json.RawMessage
		if err := plugin.Request(ctx, c.Machine, "files", action, p, &out); err != nil {
			plugin.WriteError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if len(out) == 0 {
			out = json.RawMessage("{}")
		}
		w.Write(out)
	}
}

// maxAuditPaths bounds the paths an audit record lists; it counts them all.
const maxAuditPaths = 50

// auditTargets adds the paths a change acts on to its audit record.
func auditTargets(c *plugin.Call, p params) {
	if p.Path != "" {
		c.AuditField("path", p.Path)
	}
	if len(p.Paths) > 0 {
		c.AuditField("paths", p.Paths[:min(len(p.Paths), maxAuditPaths)])
		c.AuditField("count", len(p.Paths))
	}
	if p.To != "" {
		c.AuditField("to", p.To)
	}
	if p.Dir != "" {
		c.AuditField("dir", p.Dir)
	}
}

// writeParams reads a save's query: path, and the state the editor loaded
// the file in (mtime and size), or new=1 for a file that must not exist,
// or force=1.
func writeParams(r *http.Request) (params, error) {
	q := r.URL.Query()
	p := params{Path: q.Get("path"), Force: q.Get("force") == "1"}
	if p.Path == "" {
		return p, errors.New("path required")
	}
	if p.Force || q.Get("new") == "1" {
		return p, nil
	}
	mtime, err1 := strconv.ParseInt(q.Get("mtime"), 10, 64)
	size, err2 := strconv.ParseInt(q.Get("size"), 10, 64)
	if err1 != nil || err2 != nil {
		return p, errors.New("mtime and size, new=1 or force=1 required")
	}
	p.Expect = &Entry{Path: p.Path, Exists: true, MTime: mtime, Size: size}
	return p, nil
}

// write saves an editor's text (the body, at most MaxWrite bytes) into a
// file. A file that changed since the editor loaded it is a 409 conflict
// with its state now ("current"), which the editor offers to reload or
// overwrite.
func write(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p, err := writeParams(r)
	if err != nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
		return
	}
	auditTargets(c, p)
	if p.Force {
		c.AuditField("force", true)
	}
	p.Method = saveMethod(c)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxWrite))
	if err != nil {
		plugin.WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too_large", "message": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	res, err := send(ctx, c, "write", p, bytes.NewReader(body))
	if err != nil {
		var pe *plugin.Error
		if errors.As(err, &pe) && pe.Code == "conflict" {
			var cur Entry
			json.Unmarshal([]byte(strings.TrimPrefix(pe.Message, "conflict: ")), &cur)
			plugin.WriteJSON(w, http.StatusConflict, map[string]any{"error": "conflict", "current": cur})
			return
		}
		plugin.WriteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(res)
}

// uploadParams reads an upload's query: path, and replace=1 to write the
// file there instead of taking a free name.
func uploadParams(r *http.Request) (params, error) {
	q := r.URL.Query()
	p := params{Path: q.Get("path"), Replace: q.Get("replace") == "1"}
	if p.Path == "" {
		return p, errors.New("path required")
	}
	return p, nil
}

// upload writes a file from the browser (the body, at most MaxUpload
// bytes) into a folder of the explorer: under a free name, or replacing
// the file there (replace=1), as the agent's upload does. The body streams
// to the machine; a request that ends early leaves nothing there.
func upload(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	p, err := uploadParams(r)
	if err != nil {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
		return
	}
	auditTargets(c, p)
	c.AuditField("size", r.ContentLength)
	if p.Replace {
		c.AuditField("replace", true)
		p.Method = saveMethod(c)
	}
	if r.ContentLength > MaxUpload {
		plugin.WriteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too_large", "message": "more than 4 GiB"})
		return
	}
	res, err := send(r.Context(), c, "upload", p, io.LimitReader(r.Body, MaxUpload+1))
	if err != nil {
		plugin.WriteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(res)
}

// send runs an agent action that takes a body (write, upload): its reply,
// the body as chunks, then the line with the result.
func send(ctx context.Context, c *plugin.Call, action string, p params, body io.Reader) (json.RawMessage, error) {
	conn, _, err := plugin.Open(ctx, c.Machine, "files", action, p)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	cw := agentproto.ChunkWriter{W: conn}
	if _, err := io.Copy(cw, body); err != nil {
		return nil, &plugin.Error{Code: "transport", Message: err.Error()}
	}
	if err := cw.Finish(); err != nil {
		return nil, &plugin.Error{Code: "transport", Message: err.Error()}
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil {
		return nil, &plugin.Error{Code: "transport", Message: err.Error()}
	}
	if !rep.OK {
		code := rep.Code
		if code == "" {
			code = "failed"
		}
		return nil, &plugin.Error{Code: code, Message: rep.Error}
	}
	return rep.Plugin, nil
}
