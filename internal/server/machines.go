package server

// Managing machines from the UI (docs/features/02): the core's own registry
// of SSH machines (internal/machines). Adding one stores it and connects it;
// a machine that needs an interactive login turns auth_required, and the
// authentication terminal (auth.go) logs in. Renaming, enabling, disabling
// and removing change the registry and the running machine at once.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"herdr-ide/internal/machines"
)

// maxLabelLen bounds a label: no odd bytes in the audit log. Targets are
// checked by machines.ValidTarget.
const maxLabelLen = 64

// validLabel accepts a short label without control characters.
func validLabel(l string) bool {
	if !utf8.ValidString(l) || utf8.RuneCountInString(l) > maxLabelLen {
		return false
	}
	for _, r := range l {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (s *Server) broadcastMachines() {
	s.broadcast(map[string]any{"t": "machines", "list": s.mg.States()})
}

func (s *Server) handleMachines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.mg.States())
}

// newMachineID is a random id: machine ids appear in URLs and in per-machine
// settings, so they are never derived from what the user typed.
func newMachineID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// machineFailed answers a registry or manager error.
func machineFailed(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, machines.ErrUnknownMachine):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown"})
	case errors.Is(err, machines.ErrMachineExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "machine_exists"})
	case errors.Is(err, machines.ErrLabelTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "label_taken"})
	case errors.Is(err, machines.ErrLocalMachine):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "local"})
	case errors.Is(err, machines.ErrInvalidTarget):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": machines.CodeInvalidTarget})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save", "detail": err.Error()})
	}
}

// handleMachineAdd adds an SSH machine ({"target", "label"}): stored, then
// connected. The reply is its state; whether it connects, needs a login
// (auth_required) or fails follows as machine messages on /ws.
func (s *Server) handleMachineAdd(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Target string `json:"target"`
		Label  string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	target, label := strings.TrimSpace(body.Target), strings.TrimSpace(body.Label)
	if !machines.ValidTarget(target) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": machines.CodeInvalidTarget})
		return
	}
	if !validLabel(label) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	if label == "" {
		label = target
	}
	spec := machines.Spec{ID: newMachineID(), Label: label, Kind: machines.KindSSH, Target: target, Enabled: true}
	ev := map[string]any{"machine": spec.ID, "target": target, "label": label}
	if err := s.mg.Add(spec); err != nil {
		ev["error"] = err.Error()
		s.audit.log(r, "machine.add", ev)
		machineFailed(w, err)
		return
	}
	s.audit.log(r, "machine.add", ev)
	s.broadcastMachines()
	writeJSON(w, http.StatusCreated, s.mg.Get(spec.ID).State())
}

// handleMachineRemove removes a machine: its record goes, its session ends
// (its terminal core and programs keep running there) and it leaves every
// browser. The local machine stays.
func (s *Server) handleMachineRemove(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	id := mc.ID()
	ev := map[string]any{"machine": id, "target": mc.State().Target}
	if err := s.mg.Remove(id); err != nil {
		ev["error"] = err.Error()
		s.audit.log(r, "machine.remove", ev)
		machineFailed(w, err)
		return
	}
	s.gui.Forget(id)
	s.audit.log(r, "machine.remove", ev)
	s.broadcastMachines()
	writeJSON(w, http.StatusOK, map[string]string{"removed": id})
}

// handleMachineRename renames an SSH machine ({"label": "..."}, trimmed).
// The reply is the machine's state.
func (s *Server) handleMachineRename(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var body struct {
		Label *string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil || body.Label == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	label := strings.TrimSpace(*body.Label)
	if label == "" || !validLabel(label) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	ev := map[string]any{"machine": mc.ID(), "from": mc.Label(), "label": label}
	if err := s.mg.SetLabel(mc.ID(), label); err != nil {
		ev["error"] = err.Error()
		s.audit.log(r, "machine.rename", ev)
		machineFailed(w, err)
		return
	}
	s.audit.log(r, "machine.rename", ev)
	writeJSON(w, http.StatusOK, mc.State())
}

// handleMachineEnabled enables or disables a machine ({"enabled": bool}):
// stored and applied at once. The reply is the machine's state.
func (s *Server) handleMachineEnabled(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil || body.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	event := "machine.disable"
	if *body.Enabled {
		event = "machine.enable"
	}
	ev := map[string]any{"machine": mc.ID()}
	if err := s.mg.SetEnabled(mc.ID(), *body.Enabled); err != nil {
		ev["error"] = err.Error()
		s.audit.log(r, event, ev)
		machineFailed(w, err)
		return
	}
	s.audit.log(r, event, ev)
	writeJSON(w, http.StatusOK, mc.State())
}
