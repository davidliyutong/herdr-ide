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
// saves the response itself, and the core tells the page how much of it it
// wrote and how it ended, and cancels it on request. Events are
// {t: "download", id, state: running|done|failed|cancelled|unknown, sent,
// total?, name?, error?}, sent only to the page that follows the id: it says
// so ("download.watch") before it starts the download and again after a
// reconnect, and is answered with the download's state at once. How a
// download ended is kept for downloadKeep, so that a page that missed it
// (its request arrived first, or its connection dropped) still learns it;
// "unknown" answers an id the core has not seen or no longer knows.

// downloadID is the form of an id the page makes (random, URL-safe).
var downloadID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

const (
	// downloadEvery is how often a running download's progress is sent.
	downloadEvery = 250 * time.Millisecond
	// maxWatchIDs bounds the ids of one download.watch.
	maxWatchIDs = 256
	// downloadKeep is how long a download's end, and a page's interest in
	// an id that never came, are kept; maxEndedDownloads bounds the ends
	// kept and maxDownloadWatchers the ids followed.
	downloadKeep        = 10 * time.Minute
	maxEndedDownloads   = 256
	maxDownloadWatchers = 1024
)

// Codes of failed downloads, translated by the page.
const (
	dlNotFound    = "not_found"   // the path or machine does not exist
	dlUnavailable = "unavailable" // the machine is not connected
	dlInvalid     = "invalid"     // the paths were refused
	dlInterrupted = "interrupted" // the transfer broke off
	dlChanged     = "changed"     // the file is shorter than the range asked for
)

type downloadsHub struct {
	mu      sync.Mutex
	running map[string]*download
	// ended holds the last event of downloads that ended, by id.
	ended map[string]endedDownload
	// watchers are the pages following each id.
	watchers map[string]downloadWatcher
}

type endedDownload struct {
	ev map[string]any
	at time.Time
	// early: cancelled before its request arrived, which is then refused.
	early bool
}

type downloadWatcher struct {
	c     *wsClient
	since time.Time
}

type download struct {
	s      *Server
	id     string
	parent context.Context // the browser's request
	ctx    context.Context // parent, also ended by a cancel from the panel
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
// HEAD request or an id in use is not followed. Every download in progress
// is (its memory goes with its request). ok is false when r was answered
// already: the page cancelled the download before its request arrived (the
// browser held it back), so it is refused.
func (s *Server) trackDownload(w http.ResponseWriter, r *http.Request) (d *download, _ http.ResponseWriter, _ *http.Request, ok bool) {
	id := r.URL.Query().Get("dl")
	if r.Method != http.MethodGet || !downloadID.MatchString(id) {
		return nil, w, r, true
	}
	ctx, cancel := context.WithCancel(r.Context())
	d = &download{s: s, id: id, parent: r.Context(), ctx: ctx, cancel: cancel, total: -1}
	h := &s.downloads
	h.mu.Lock()
	h.init()
	if e := h.ended[id]; e.early {
		h.mu.Unlock()
		cancel()
		http.Error(w, "download cancelled", http.StatusGone)
		return nil, w, r, false
	}
	if h.running[id] != nil {
		h.mu.Unlock()
		cancel()
		return nil, w, r, true
	}
	h.running[id] = d
	h.mu.Unlock()
	d.publish("running")
	return d, &downloadWriter{ResponseWriter: w, d: d}, r.WithContext(ctx), true
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

// fail records why the download failed (the first reason counts). Once
// the browser or the panel cancelled it, errors are that cancel's.
func (d *download) fail(code string) {
	if d == nil || d.ctx.Err() != nil {
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

// finish sends how the download ended, keeps that for a page that asks
// later, and stops following it.
func (d *download) finish() {
	if d == nil {
		return
	}
	d.cancel()
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
	ev := d.event(state)
	h := &d.s.downloads
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.running, d.id)
	h.pruneLocked(now)
	if len(h.ended) >= maxEndedDownloads {
		h.dropOldestLocked()
	}
	h.ended[d.id] = endedDownload{ev: ev, at: now}
	if w, ok := h.watchers[d.id]; ok {
		delete(h.watchers, d.id)
		w.c.sendJSON(ev)
	}
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

// publish sends the download's progress to the page following it.
func (d *download) publish(state string) {
	ev := d.event(state)
	h := &d.s.downloads
	h.mu.Lock()
	defer h.mu.Unlock()
	if w, ok := h.watchers[d.id]; ok {
		w.c.sendJSON(ev)
	}
}

// event is the download's event in state.
func (d *download) event(state string) map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
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
	return ev
}

func (h *downloadsHub) init() {
	if h.running == nil {
		h.running = map[string]*download{}
		h.ended = map[string]endedDownload{}
		h.watchers = map[string]downloadWatcher{}
	}
}

// pruneLocked forgets the ends, and the interest in ids that never came,
// older than downloadKeep.
func (h *downloadsHub) pruneLocked(now time.Time) {
	for id, e := range h.ended {
		if now.Sub(e.at) > downloadKeep {
			delete(h.ended, id)
		}
	}
	for id, w := range h.watchers {
		if h.running[id] == nil && now.Sub(w.since) > downloadKeep {
			delete(h.watchers, id)
		}
	}
}

func (h *downloadsHub) dropOldestLocked() {
	var oldest string
	for id, e := range h.ended {
		if oldest == "" || e.at.Before(h.ended[oldest].at) {
			oldest = id
		}
	}
	delete(h.ended, oldest)
}

// stateLocked is what the core knows of download id: its progress, how it
// ended, or that it does not know it.
func (h *downloadsHub) stateLocked(id string) map[string]any {
	if d := h.running[id]; d != nil {
		return d.event("running")
	}
	if e, ok := h.ended[id]; ok {
		return e.ev
	}
	return map[string]any{"t": "download", "id": id, "state": "unknown"}
}

// watchDownloads makes c the page following the downloads ids
// (download.watch), and sends it what the core knows of each.
func (s *Server) watchDownloads(c *wsClient, ids []string) {
	h := &s.downloads
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	h.pruneLocked(now)
	if len(ids) > maxWatchIDs {
		ids = ids[:maxWatchIDs]
	}
	for _, id := range ids {
		if !downloadID.MatchString(id) {
			continue
		}
		ev := h.stateLocked(id)
		if ev["state"] == "running" || ev["state"] == "unknown" {
			if _, ok := h.watchers[id]; ok || len(h.watchers) < maxDownloadWatchers {
				h.watchers[id] = downloadWatcher{c: c, since: now}
			}
		}
		c.sendJSON(ev)
	}
}

// forgetWatcher drops the ids page c followed (it disconnected).
func (s *Server) forgetWatcher(c *wsClient) {
	h := &s.downloads
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, w := range h.watchers {
		if w.c == c {
			delete(h.watchers, id)
		}
	}
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

// cancelDownload stops download id for page c (download.cancel): the
// browser's download fails, and the agent's stream closes. c follows the id
// from then on and hears how it ended. One the core has not seen counts as
// cancelled at once, and its request is refused if it comes after all.
func (s *Server) cancelDownload(c *wsClient, id string) {
	if !downloadID.MatchString(id) {
		return
	}
	h := &s.downloads
	h.mu.Lock()
	h.init()
	d := h.running[id]
	if d == nil {
		if _, ok := h.ended[id]; !ok {
			now := time.Now()
			h.pruneLocked(now)
			if len(h.ended) >= maxEndedDownloads {
				h.dropOldestLocked()
			}
			ev := map[string]any{"t": "download", "id": id, "state": "cancelled", "sent": 0}
			h.ended[id] = endedDownload{ev: ev, at: now, early: true}
			delete(h.watchers, id)
			s.audit.log(c.req, "file.download.cancel", map[string]any{"id": id})
		}
		ev := h.ended[id].ev
		h.mu.Unlock()
		c.sendJSON(ev)
		return
	}
	h.watchers[id] = downloadWatcher{c: c, since: time.Now()}
	h.mu.Unlock()
	s.audit.log(c.req, "file.download.cancel", map[string]any{"id": id})
	d.byUser.Store(true)
	d.cancel()
}
