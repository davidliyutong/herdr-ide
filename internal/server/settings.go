package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/settings"
)

// Settings and keybindings (docs/features/13-settings-and-appearance.md):
// the definitions and values for every UI, changed through the API or by
// editing the files, and pushed to every /ws client after each change
// ("settings" and "keybindings" messages carry the new state, so clients
// need not ask again).

func (s *Server) initSettings() {
	if st := s.opts.Settings; st != nil {
		st.OnChange(func([]settings.Change) { s.broadcast(settingsMessage(st)) })
	}
	if kb := s.opts.Keybindings; kb != nil {
		kb.OnChange(func() { s.broadcast(keybindingsMessage(kb)) })
	}
}

func settingsMessage(st *settings.Store) map[string]any {
	state := st.State()
	return map[string]any{"t": "settings", "values": state.Values, "problems": state.Problems}
}

func keybindingsMessage(kb *keybindings.Store) map[string]any {
	state := kb.State()
	return map[string]any{"t": "keybindings", "user": state.User, "effective": state.Effective,
		"conflicts": state.Conflicts, "problems": state.Problems}
}

// handleSettings lists the sections, definitions and values, so the UIs
// render their forms without knowing the settings in advance.
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	st := s.opts.Settings
	if st == nil {
		writeJSON(w, http.StatusOK, map[string]any{"sections": []any{}, "definitions": []any{}, "values": map[string]any{},
			"problems": []any{}, "read_only": s.opts.ReadOnly})
		return
	}
	state := st.State()
	writeJSON(w, http.StatusOK, map[string]any{
		"sections":    st.Sections(),
		"definitions": st.Definitions(),
		"values":      state.Values,
		"problems":    state.Problems,
		"read_only":   s.opts.ReadOnly,
		"file":        st.Path(),
	})
}

// settingTarget checks the machine of a per-machine change: a machine the
// core has, and not the core's own for settings of remote machines only.
func (s *Server) settingTarget(w http.ResponseWriter, key, machine string) bool {
	if machine == "" {
		return true
	}
	mc := s.mg.Get(machine)
	if mc == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown", "detail": "machine " + machine})
		return false
	}
	if d, ok := s.opts.Settings.Lookup(key); ok && d.Scope == settings.ScopeRemoteMachine && mc.Local() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope", "detail": key + " applies to remote machines only"})
		return false
	}
	return true
}

// settingResult answers a change: the new state, or an error code the UIs
// translate.
func (s *Server) settingResult(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		state := s.opts.Settings.State()
		writeJSON(w, http.StatusOK, map[string]any{"values": state.Values, "problems": state.Problems})
	case errors.Is(err, settings.ErrUnknown):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
	case errors.Is(err, settings.ErrLocked):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "locked"})
	case errors.Is(err, settings.ErrFile):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "file"})
	case errors.Is(err, settings.ErrScope):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope", "detail": err.Error()})
	case errors.Is(err, settings.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
	default:
		s.logger.Printf("saving settings: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save", "detail": err.Error()})
	}
}

// handleSetSetting changes one value: {key, value, machine?}, the value
// typed as the definition says (true, 14, "dark", ["#000000", …]).
func (s *Server) handleSetSetting(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
		// Machine sets that machine's own value.
		Machine string `json:"machine"`
	}
	var value any
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req)
	if err == nil {
		if len(req.Value) == 0 {
			err = errors.New("no value")
		} else {
			err = json.Unmarshal(req.Value, &value)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
		return
	}
	if s.opts.Settings == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
		return
	}
	if !s.settingTarget(w, req.Key, req.Machine) {
		return
	}
	err = s.opts.Settings.Set(req.Key, req.Machine, value)
	if err == nil {
		s.audit.log(r, "settings.set", map[string]any{"key": req.Key, "value": value, "machine": req.Machine})
	}
	s.settingResult(w, err)
}

// handleResetSetting removes a value (?key=&machine=): the global value
// goes back to the default, a machine's own value to the global one.
func (s *Server) handleResetSetting(w http.ResponseWriter, r *http.Request) {
	key, machine := r.URL.Query().Get("key"), r.URL.Query().Get("machine")
	if s.opts.Settings == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
		return
	}
	if !s.settingTarget(w, key, machine) {
		return
	}
	err := s.opts.Settings.Reset(key, machine)
	if err == nil {
		s.audit.log(r, "settings.reset", map[string]any{"key": key, "machine": machine})
	}
	s.settingResult(w, err)
}

// handleKeybindings lists the commands, the default bindings, the user's
// rules and, per platform, the bindings in effect and their conflicts.
func (s *Server) handleKeybindings(w http.ResponseWriter, r *http.Request) {
	kb := s.opts.Keybindings
	if kb == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
		return
	}
	state := kb.State()
	writeJSON(w, http.StatusOK, map[string]any{
		"sections":  keybindings.Sections,
		"commands":  kb.CommandList(),
		"defaults":  kb.AllDefaults(),
		"user":      state.User,
		"effective": state.Effective,
		"conflicts": state.Conflicts,
		"problems":  state.Problems,
		"read_only": s.opts.ReadOnly,
		"file":      kb.Path(),
	})
}

// handleSetKeybindings replaces the user's rules with the array in the body.
func (s *Server) handleSetKeybindings(w http.ResponseWriter, r *http.Request) {
	kb := s.opts.Keybindings
	if kb == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
		return
	}
	var user []json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&user); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
		return
	}
	err := kb.SetUser(user)
	switch {
	case err == nil:
		s.audit.log(r, "keybindings.set", map[string]any{"rules": len(user)})
		state := kb.State()
		writeJSON(w, http.StatusOK, map[string]any{"user": state.User, "effective": state.Effective,
			"conflicts": state.Conflicts, "problems": state.Problems})
	case errors.Is(err, keybindings.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid", "detail": err.Error()})
	case errors.Is(err, keybindings.ErrFile):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "file"})
	default:
		s.logger.Printf("saving keybindings: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save", "detail": err.Error()})
	}
}
