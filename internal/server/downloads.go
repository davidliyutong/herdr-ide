package server

import (
	"context"
	"net/http"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// Downloads the page started with an id (GET /api/m/{id}/download?dl=…), for
// its downloads panel (docs/features/06-quick-look-and-files.md): the browser
// saves the response itself, and the core tells the pages how much of it it
// wrote, how it ended, and cancels it on request. Events are
// {t: "download", id, state: running|done|failed|cancelled, sent, total?,
// name?, error?}; only the page that made the id follows it.

// downloadID is the form of an id the page makes (random, URL-safe).
var downloadID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

const (
	// downloadEvery is how often a running download's progress is sent.
	downloadEvery = 250 * time.Millisecond
	// maxTrackedDownloads bounds the downloads followed at once; others
	// still download, without events.
	maxTrackedDownloads = 64
)

// Codes of failed downloads, translated by the page.
const (
	dlNotFound    = "not_found"   // the path or machine does not exist
	dlUnavailable = "unavailable" // the machine is not connected
	dlInvalid     = "invalid"     // the paths were refused
	dlInterrupted = "interrupted" // the transfer broke off
)

type downloadsHub struct {
	mu      sync.Mutex
	running map[string]*download
}

type download struct {
	s      *Server
	id     string
	parent context.Context // the browser's request
	cancel context.CancelFunc
	byUser atomic.Bool

	mu       sync.Mutex
	sent     int64
	total    int64 // -1 while not known (an archive)
	name     string
	code     string // set when it failed
	complete bool
	last     time.Time
}

// trackDownload follows the download of r when the page gave it an id. It
// returns the writer and request to serve it with: the writer counts what
// goes out, the request's context also ends when the page cancels it. A
// HEAD request, an id in use or too many downloads are not followed.
func (s *Server) trackDownload(w http.ResponseWriter, r *http.Request) (*download, http.ResponseWriter, *http.Request) {
	id := r.URL.Query().Get("dl")
	if r.Method != http.MethodGet || !downloadID.MatchString(id) {
		return nil, w, r
	}
	ctx, cancel := context.WithCancel(r.Context())
	d := &download{s: s, id: id, parent: r.Context(), cancel: cancel, total: -1}
	h := &s.downloads
	h.mu.Lock()
	if h.running == nil {
		h.running = map[string]*download{}
	}
	if h.running[id] != nil || len(h.running) >= maxTrackedDownloads {
		h.mu.Unlock()
		cancel()
		return nil, w, r
	}
	h.running[id] = d
	h.mu.Unlock()
	d.publish("running")
	return d, &downloadWriter{ResponseWriter: w, d: d}, r.WithContext(ctx)
}

// describe sets the name the file is saved under and its size, -1 when it
// is not known in advance.
func (d *download) describe(name string, total int64) {
	if d == nil {
		return
	}
	d.mu.Lock()
	d.name, d.total = name, total
	d.mu.Unlock()
	d.publish("running")
}

// fail records why the download failed (the first reason counts).
func (d *download) fail(code string) {
	if d == nil {
		return
	}
	d.mu.Lock()
	if d.code == "" {
		d.code = code
	}
	d.mu.Unlock()
}

// done records that the whole response was written.
func (d *download) done() {
	if d == nil {
		return
	}
	d.mu.Lock()
	d.complete = true
	d.mu.Unlock()
}

// broken reports whether an unfinished response should be aborted rather
// than ended: the browser is still there, so ending it normally would save
// a truncated file (an archive has no length the browser could check).
func (d *download) broken() bool {
	return d != nil && d.parent.Err() == nil
}

// finish sends how the download ended and forgets it.
func (d *download) finish() {
	if d == nil {
		return
	}
	d.cancel()
	h := &d.s.downloads
	h.mu.Lock()
	delete(h.running, d.id)
	h.mu.Unlock()
	d.mu.Lock()
	state := "done"
	switch {
	case d.byUser.Load() || (!d.complete && d.code == "" && d.parent.Err() != nil):
		state = "cancelled" // from the panel, or in the browser
	case d.code != "":
		state = "failed"
	case !d.complete:
		state, d.code = "failed", dlInterrupted
	}
	d.mu.Unlock()
	d.publish(state)
}

func (d *download) wrote(n int) {
	d.mu.Lock()
	d.sent += int64(n)
	due := time.Since(d.last) >= downloadEvery
	d.mu.Unlock()
	if due {
		d.publish("running")
	}
}

func (d *download) publish(state string) {
	d.mu.Lock()
	ev := map[string]any{"t": "download", "id": d.id, "state": state, "sent": d.sent}
	if d.total >= 0 {
		ev["total"] = d.total
	}
	if d.name != "" {
		ev["name"] = d.name
	}
	if state == "failed" && d.code != "" {
		ev["error"] = d.code
	}
	d.last = time.Now()
	d.mu.Unlock()
	d.s.broadcast(ev)
}

// downloadWriter counts the bytes of a followed download.
type downloadWriter struct {
	http.ResponseWriter
	d *download
}

func (w *downloadWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.d.wrote(n)
	return n, err
}

func (w *downloadWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// handleDownloadCancel stops a followed download from the downloads panel:
// the browser's download fails, and the agent's stream closes.
func (s *Server) handleDownloadCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("dl")
	s.downloads.mu.Lock()
	d := s.downloads.running[id]
	s.downloads.mu.Unlock()
	if d == nil {
		http.NotFound(w, r)
		return
	}
	s.audit.log(r, "file.download.cancel", map[string]any{"id": id})
	d.byUser.Store(true)
	d.cancel()
	w.WriteHeader(http.StatusNoContent)
}
