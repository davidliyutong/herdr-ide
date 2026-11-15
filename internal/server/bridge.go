package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
)

// bridgeWindow is one VS Code window (extension host) of code-server: a
// VS Code pane of a page, or VS Code opened on its own.
type bridgeWindow struct {
	m       string
	id      string
	folders []string
	// hello is when the window said hello; zero before.
	hello   time.Time
	active  time.Time
	conn    net.Conn
	wmu     sync.Mutex
	pending sync.Map // cmd id -> chan error
}

func (w *bridgeWindow) send(v any) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return agentproto.WriteLine(w.conn, v)
}

// bridgeHub routes commands from the web UI to VS Code windows and messages
// from VS Code (e.g. "send selection to agent") back to browsers.
type bridgeHub struct {
	s       *Server
	mu      sync.Mutex
	windows map[*bridgeWindow]bool
	changed chan struct{}
	seq     atomic.Uint64
	// theme is the color theme kind ("dark" or "light") last chosen in a
	// browser; every VS Code window follows it.
	theme string
}

func newBridgeHub(s *Server) *bridgeHub {
	return &bridgeHub{s: s, windows: map[*bridgeWindow]bool{}, changed: make(chan struct{})}
}

func (h *bridgeHub) notify() {
	h.mu.Lock()
	close(h.changed)
	h.changed = make(chan struct{})
	h.mu.Unlock()
}

type bridgeMsg struct {
	Type    string   `json:"type"`
	ID      string   `json:"id"`
	Folders []string `json:"folders"`
	// Focused: the window has the keyboard as it says hello.
	Focused bool     `json:"focused"`
	OK      bool     `json:"ok"`
	Error   string   `json:"error"`
	Text    string   `json:"text"`
	File    string   `json:"file"`
	Line    int      `json:"line"`
	EndLine int      `json:"end_line"`
	Paths   []string `json:"paths"`
}

// serve handles one bridge connection tunnelled from the agent.
func (h *bridgeHub) serve(mc *machines.Machine, conn net.Conn) {
	if err := agentproto.WriteLine(conn, agentproto.Reply{OK: true}); err != nil {
		conn.Close()
		return
	}
	w := &bridgeWindow{m: mc.ID(), conn: conn, active: time.Now()}
	defer func() {
		conn.Close()
		h.mu.Lock()
		delete(h.windows, w)
		h.mu.Unlock()
		w.pending.Range(func(_, v any) bool {
			v.(chan error) <- errors.New("VS Code window closed")
			return true
		})
		h.notify()
	}()
	r := bufio.NewReaderSize(conn, 64<<10)
	for {
		line, err := readFullLine(r)
		if err != nil {
			return
		}
		var msg bridgeMsg
		if json.Unmarshal(line, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "hello":
			h.mu.Lock()
			w.id = msg.ID
			w.folders = msg.Folders
			w.active = time.Now()
			if w.hello.IsZero() {
				w.hello = w.active
			}
			h.windows[w] = true
			theme := h.theme
			h.mu.Unlock()
			h.notify()
			if theme != "" {
				_ = w.send(map[string]string{"type": "theme", "kind": theme})
			}
			if msg.Focused {
				h.focused(mc, w)
			}
		case "focus":
			h.mu.Lock()
			w.active = time.Now()
			h.mu.Unlock()
			h.focused(mc, w)
		case "ack":
			if ch, ok := w.pending.LoadAndDelete(msg.ID); ok {
				if msg.OK {
					ch.(chan error) <- nil
				} else {
					ch.(chan error) <- errors.New(msg.Error)
				}
			}
		case "sendToAgent":
			// The browser decides which agent pane receives it (the
			// focused one, or one of the workspace whose panel shows this
			// window's folders) and pastes without submitting. Only this
			// goroutine sets w.folders. A window that has not said hello
			// has unknown folders, sent as none at all (not as an empty
			// list, which is a window without a folder).
			ev := map[string]any{"t": "bridge.send", "m": mc.ID(), "text": msg.Text, "file": msg.File, "line": msg.Line, "end_line": msg.EndLine}
			if w.folders != nil {
				ev["folders"] = w.folders
			}
			if w.id != "" {
				ev["window"] = w.id
			}
			h.s.broadcast(ev)
		case "download":
			// Files chosen in VS Code's explorer: the page showing that
			// VS Code (the one with focus) downloads them (handleDownload).
			if len(msg.Paths) > 0 && len(msg.Paths) <= maxDownloadPaths {
				ev := map[string]any{"t": "bridge.download", "m": mc.ID(), "paths": msg.Paths}
				if w.id != "" {
					ev["window"] = w.id
				}
				h.s.broadcast(ev)
			}
		}
	}
}

// focused tells the pages that a window that said hello got the keyboard:
// the page whose VS Code pane has it learns which window that pane shows,
// and names it in the commands it sends there (command).
func (h *bridgeHub) focused(mc *machines.Machine, w *bridgeWindow) {
	if w.id == "" {
		return
	}
	ev := map[string]any{"t": "bridge.focus", "m": mc.ID(), "window": w.id}
	if w.folders != nil {
		ev["folders"] = w.folders
	}
	h.s.broadcast(ev)
}

// setTheme makes every VS Code window, now and later, use a theme of kind.
func (h *bridgeHub) setTheme(kind string) {
	if kind != "dark" && kind != "light" {
		return
	}
	h.mu.Lock()
	if h.theme == kind {
		h.mu.Unlock()
		return
	}
	h.theme = kind
	var ws []*bridgeWindow
	for w := range h.windows {
		ws = append(ws, w)
	}
	h.mu.Unlock()
	for _, w := range ws {
		_ = w.send(map[string]string{"type": "theme", "kind": kind})
	}
}

func within(path, folder string) bool {
	folder = strings.TrimRight(folder, "/")
	return path == folder || strings.HasPrefix(path, folder+"/")
}

// pick returns the best window on machine m for folder with its score:
// 3 = shows exactly folder, 2 = a workspace folder contains it, 1 = any
// window on the machine (most recently active wins ties).
func (h *bridgeHub) pick(m, folder string) (*bridgeWindow, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var best *bridgeWindow
	score := 0
	for w := range h.windows {
		if w.m != m {
			continue
		}
		sc := 1
		for _, f := range w.folders {
			if folder == "" {
				break
			}
			if strings.TrimRight(f, "/") == strings.TrimRight(folder, "/") {
				sc = 3
			} else if within(folder, f) && sc < 2 {
				sc = 2
			}
		}
		if sc > score || sc == score && best != nil && w.active.After(best.active) {
			best, score = w, sc
		}
	}
	return best, score
}

// byID returns the window of machine m that said hello as id.
func (h *bridgeHub) byID(m, id string) *bridgeWindow {
	h.mu.Lock()
	defer h.mu.Unlock()
	for w := range h.windows {
		if w.m == m && w.id == id {
			return w
		}
	}
	return nil
}

// pickNew returns a window of machine m showing folder (any folder for "")
// that said hello after since: one a page has just opened.
func (h *bridgeHub) pickNew(m, folder string, since time.Time) *bridgeWindow {
	h.mu.Lock()
	defer h.mu.Unlock()
	var best *bridgeWindow
	for w := range h.windows {
		if w.m != m || w.hello.Before(since) {
			continue
		}
		ok := folder == ""
		for _, f := range w.folders {
			ok = ok || strings.TrimRight(f, "/") == strings.TrimRight(folder, "/")
		}
		if ok && (best == nil || w.hello.Before(best.hello)) {
			best = w
		}
	}
	return best
}

// bridgeTarget is the window a command goes to: the one a page named
// (window, a window id it learned from bridge.focus or an earlier reply),
// else a window opened after the request (fresh: the page has just opened
// a VS Code pane for folder), else the best window for folder (pick).
type bridgeTarget struct {
	folder, window string
	fresh          bool
}

// command sends cmd to the VS Code window of t and returns that window's
// id. A named window that is gone counts as unnamed. The iframe may still be
// loading, so a fresh window or an exact match is awaited; without fresh, a
// window containing the folder (or, with no folder, any window) is used
// after a grace period.
func (h *bridgeHub) command(ctx context.Context, m string, t bridgeTarget, cmd map[string]any) (string, error) {
	start := time.Now()
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	var w *bridgeWindow
	if t.window != "" {
		w = h.byID(m, t.window)
	}
	for w == nil {
		h.mu.Lock()
		changed := h.changed
		h.mu.Unlock()
		var cand *bridgeWindow
		ready := false
		if t.fresh {
			cand = h.pickNew(m, t.folder, start)
			ready = cand != nil
		} else {
			var sc int
			cand, sc = h.pick(m, t.folder)
			grace := time.Since(start) > 4*time.Second
			ready = cand != nil && (sc == 3 || t.folder == "" || grace && sc >= 2)
		}
		if ready {
			w = cand
			break
		}
		select {
		case <-changed:
		case <-time.After(time.Second):
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			if cand != nil {
				w = cand
				break
			}
			return "", errors.New("no VS Code window is connected (code-server may still be starting)")
		}
	}
	id := strconv.FormatUint(h.seq.Add(1), 10)
	cmd["type"] = "command"
	cmd["id"] = id
	ch := make(chan error, 1)
	w.pending.Store(id, ch)
	if err := w.send(cmd); err != nil {
		w.pending.Delete(id)
		return "", err
	}
	h.mu.Lock()
	window := w.id
	h.mu.Unlock()
	select {
	case err := <-ch:
		return window, err
	case <-time.After(30 * time.Second):
		w.pending.Delete(id)
		return "", errors.New("VS Code did not answer")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// handleBridge forwards a command from the UI to VS Code on a machine.
func (s *Server) handleBridge(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var body map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var t bridgeTarget
	t.folder, _ = body["folder"].(string)
	t.window, _ = body["window"].(string)
	t.fresh, _ = body["fresh"].(bool)
	delete(body, "folder")
	delete(body, "window")
	delete(body, "fresh")
	s.audit.log(r, "bridge.command", map[string]any{"machine": mc.ID(), "cmd": body["cmd"], "folder": t.folder})
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	// Bring code-server up if no VS Code pane has been shown yet.
	if !s.cs.Ready(mc) {
		if err := s.cs.Ensure(ctx, mc); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
	}
	window, err := s.bridge.command(ctx, mc.ID(), t, body)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "window": window})
}

// handleAgentStream dispatches streams opened by agents.
func (s *Server) handleAgentStream(mc *machines.Machine, conn net.Conn, h agentproto.Header) {
	switch h.Op {
	case agentproto.OpBridge:
		s.bridge.serve(mc, conn)
	default:
		if s.servePluginStream(mc, conn, h) {
			return
		}
		agentproto.Fail(conn, errors.New("unsupported op"))
		conn.Close()
	}
}
