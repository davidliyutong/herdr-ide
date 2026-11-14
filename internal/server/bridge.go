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

// bridgeWindow is one VS Code window (extension host) of code-server.
type bridgeWindow struct {
	m       string
	id      string
	folders []string
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
			h.windows[w] = true
			theme := h.theme
			h.mu.Unlock()
			h.notify()
			if theme != "" {
				_ = w.send(map[string]string{"type": "theme", "kind": theme})
			}
		case "focus":
			h.mu.Lock()
			w.active = time.Now()
			h.mu.Unlock()
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
			h.s.broadcast(ev)
		case "download":
			// Files chosen in VS Code's explorer: the browser showing that
			// VS Code (the one with focus) downloads them (handleDownload).
			if len(msg.Paths) > 0 && len(msg.Paths) <= maxDownloadPaths {
				h.s.broadcast(map[string]any{"t": "bridge.download", "m": mc.ID(), "paths": msg.Paths})
			}
		}
	}
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

// command sends cmd to the VS Code window for folder. The iframe may still be
// navigating to that folder, so an exact match is awaited briefly before a
// window containing the folder (or, with no folder, any window) is used.
func (h *bridgeHub) command(ctx context.Context, m, folder string, cmd map[string]any) error {
	start := time.Now()
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	var w *bridgeWindow
	for {
		h.mu.Lock()
		changed := h.changed
		h.mu.Unlock()
		cand, sc := h.pick(m, folder)
		grace := time.Since(start) > 4*time.Second
		if cand != nil && (sc == 3 || folder == "" || grace && sc >= 2) {
			w = cand
			break
		}
		select {
		case <-changed:
		case <-time.After(time.Second):
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			if cand != nil {
				w = cand
				break
			}
			return errors.New("no VS Code window is connected (code-server may still be starting)")
		}
		if w != nil {
			break
		}
	}
	id := strconv.FormatUint(h.seq.Add(1), 10)
	cmd["type"] = "command"
	cmd["id"] = id
	ch := make(chan error, 1)
	w.pending.Store(id, ch)
	if err := w.send(cmd); err != nil {
		w.pending.Delete(id)
		return err
	}
	select {
	case err := <-ch:
		return err
	case <-time.After(30 * time.Second):
		w.pending.Delete(id)
		return errors.New("VS Code did not answer")
	case <-ctx.Done():
		return ctx.Err()
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
	folder, _ := body["folder"].(string)
	delete(body, "folder")
	s.audit.log(r, "bridge.command", map[string]any{"machine": mc.ID(), "cmd": body["cmd"], "folder": folder})
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	// Bring code-server up if the panel has not been opened yet.
	if !s.cs.Ready(mc) {
		if err := s.cs.Ensure(ctx, mc); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
	}
	if err := s.bridge.command(ctx, mc.ID(), folder, body); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleAgentStream dispatches streams opened by agents.
func (s *Server) handleAgentStream(mc *machines.Machine, conn net.Conn, h agentproto.Header) {
	switch h.Op {
	case agentproto.OpBridge:
		s.bridge.serve(mc, conn)
	default:
		agentproto.Fail(conn, errors.New("unsupported op"))
		conn.Close()
	}
}
