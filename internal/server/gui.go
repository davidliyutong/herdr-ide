package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

// GUI windows (docs/features/14-gui-windows.md): every /ws client gets the
// window list of each machine ("gui" messages); a browser window showing a
// program window has its own WebSocket on /m/{id}/gui/{win}/ws.

func (s *Server) initGUI() {
	s.gui = gui.New(s.opts.Settings, s.logger)
	s.gui.ReadOnly = s.opts.ReadOnly
	s.gui.Audit = func(event string, fields map[string]any) { s.audit.log(nil, event, fields) }
	s.gui.OnState = func(st gui.State) {
		s.broadcast(map[string]any{"t": "gui", "state": st})
	}
	s.mg.Subscribe(func(st machines.State) {
		mc := s.mg.Get(st.ID)
		if mc == nil {
			return
		}
		if st.Status == machines.StatusReady {
			s.gui.Ensure(mc)
			return
		}
		// Disabled, reconnecting or failing: no display error or windows
		// stay on screen for a machine that is not connected.
		s.gui.Disconnected(mc)
	}, func(machines.AgentEvent) {})
	if s.opts.Settings != nil {
		s.opts.Settings.OnChange(func(changes []settings.Change) {
			for _, c := range changes {
				if c.Key != gui.SettingGUI && c.Key != gui.SettingVideo && c.Key != gui.SettingDisplay && c.Key != gui.SettingGPUPick {
					continue
				}
				// A global change affects every machine without its own value.
				for _, st := range s.mg.States() {
					if c.Machine != "" && st.ID != c.Machine {
						continue
					}
					if mc := s.mg.Get(st.ID); mc != nil && st.Status == machines.StatusReady {
						switch c.Key {
						case gui.SettingVideo:
							s.gui.ApplyVideo(mc)
						case gui.SettingDisplay:
							s.gui.ApplyDisplay(mc)
						case gui.SettingGPUPick:
							s.gui.ApplyPick(mc)
						default:
							s.gui.Apply(mc)
						}
					}
				}
			}
		})
	}
}

// handleGUIEnable gives open terminals of a machine's terminal core the
// display's environment (see gui.Manager.Enable). Body: {"terminals": [...]}
// (empty or absent for all of them).
func (s *Server) handleGUIEnable(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var req struct {
		Terminals []string `json:"terminals"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	b := s.term.existing(mc.ID())
	if b == nil || b.connection() == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_terminals"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	res, err := s.gui.Enable(ctx, mc, termShells{b}, req.Terminals)
	if res != nil {
		ev := map[string]any{"machine": mc.ID(), "typed": res.Typed, "busy": res.Busy, "failed": res.Failed}
		if err != nil {
			ev["error"] = err.Error()
		}
		s.audit.log(r, "gui.enable", ev)
	}
	switch {
	case errors.Is(err, gui.ErrOff):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "off"})
	case errors.Is(err, gui.ErrNotReady):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_ready"})
	case err != nil:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport", "detail": err.Error()})
	default:
		writeJSON(w, http.StatusOK, res)
	}
}

// addEnv sets env in the "env" object of parameters p and returns the names
// it set: with replace also those the caller gave a value, else only the
// others. ok is false when "env" is not an object of strings (p is then
// unchanged).
func addEnv(p map[string]json.RawMessage, env map[string]string, replace bool) (names []string, ok bool) {
	var given map[string]string
	if raw, set := p["env"]; set && json.Unmarshal(raw, &given) != nil {
		return nil, false
	}
	if given == nil {
		given = map[string]string{}
	}
	for k, v := range env {
		if _, set := given[k]; set && !replace {
			continue
		}
		given[k] = v
		names = append(names, k)
	}
	if len(names) == 0 {
		return nil, true
	}
	sort.Strings(names)
	b, err := json.Marshal(given)
	if err != nil {
		return nil, false
	}
	p["env"] = b
	return names, true
}

// handleGUIPage serves the app shell, which shows one window on this path.
func (s *Server) handleGUIPage(w http.ResponseWriter, r *http.Request) {
	if s.opts.Static == nil {
		http.NotFound(w, r)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	spaHandler(s.opts.Static, s.appCSP).ServeHTTP(w, r2)
}

// handleGUIWS streams one window to a browser window: JSON events and
// binary frames out, commands in. Input is refused in read-only mode.
func (s *Server) handleGUIWS(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	win, err := strconv.ParseUint(r.PathValue("win"), 10, 32)
	if err != nil {
		http.Error(w, "bad window", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is verified by guard. Frames are compressed images.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 16)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	out := make(chan outMsg, 64)
	v := &gui.Viewer{Send: func(kind byte, payload []byte) bool {
		select {
		case out <- outMsg{binary: kind == agentproto.GUIFrame, data: payload}:
			return true
		default:
			return false
		}
	}, Codecs: videoCodecs(r.URL.Query().Get("video"))}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-out:
				typ := websocket.MessageText
				if m.binary {
					typ = websocket.MessageBinary
				}
				wctx, wcancel := context.WithTimeout(ctx, 20*time.Second)
				err := conn.Write(wctx, typ, m.data)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	id := uint32(win)
	if !s.gui.Attach(mc.ID(), id, v) {
		b, _ := json.Marshal(agentproto.GUIEvent{Ev: "gone", ID: id})
		conn.Write(ctx, websocket.MessageText, b)
		conn.Close(websocket.StatusNormalClosure, "no such window")
		return
	}
	s.audit.log(r, "gui.open", map[string]any{"machine": mc.ID(), "window": id})
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageText {
			continue
		}
		var c agentproto.GUICommand
		if json.Unmarshal(data, &c) != nil {
			continue
		}
		s.gui.Command(mc.ID(), id, v, c, !s.opts.ReadOnly)
	}
	s.gui.Detach(mc.ID(), id, v)
	conn.Close(websocket.StatusNormalClosure, "")
}

// videoCodecs parses the video streams a browser window decodes
// (?video=avc1,vp8): at most four short lowercase names.
func videoCodecs(q string) []string {
	var out []string
	for _, c := range strings.Split(q, ",") {
		if len(out) == 4 || c == "" || len(c) > 8 || strings.Trim(c, "abcdefghijklmnopqrstuvwxyz0123456789") != "" || slices.Contains(out, c) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// handleGUIClose is sent (as a beacon) when a browser window showing a
// program window is closed or reloaded; see gui.Manager.Close.
func (s *Server) handleGUIClose(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	win, err := strconv.ParseUint(r.PathValue("win"), 10, 32)
	if err != nil {
		http.Error(w, "bad window", http.StatusBadRequest)
		return
	}
	s.audit.log(r, "gui.close", map[string]any{"machine": mc.ID(), "window": win})
	s.gui.Close(mc.ID(), uint32(win))
	w.WriteHeader(http.StatusNoContent)
}

// handleGUIStates lists the program windows of every machine, as /ws sends
// them, for clients that do not hold a /ws connection.
func (s *Server) handleGUIStates(w http.ResponseWriter, r *http.Request) {
	states := s.gui.States()
	if states == nil {
		states = []gui.State{}
	}
	writeJSON(w, http.StatusOK, states)
}
