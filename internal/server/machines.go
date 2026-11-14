package server

// Adding, removing, renaming and reloading SSH machines from the UI
// (docs/features/02). Machines are herdr's saved machines, so changes go
// through herdr's own commands on the core host: `herdr machine add` in a
// terminal (it may ask questions), `herdr machine remove` and
// `herdr machine rename`. The core then follows herdr's catalog; it never
// writes the catalog itself.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"herdr-ide/internal/machines"
)

// Limits of what the forms accept. herdr checks them again; these keep a
// target from reading as an option and odd bytes out of the audit log.
const (
	maxTargetLen = 255
	maxLabelLen  = 64
)

var sessionName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// herdrCommandTimeout bounds herdr's non-interactive machine commands.
const herdrCommandTimeout = 30 * time.Second

// validTarget accepts an ssh destination (a ~/.ssh/config alias, host,
// user@host or ssh:// URL): printable ASCII without spaces, not starting
// with "-", which herdr and ssh would take for an option.
func validTarget(t string) bool {
	if t == "" || len(t) > maxTargetLen || t[0] == '-' {
		return false
	}
	for i := 0; i < len(t); i++ {
		if t[i] <= ' ' || t[i] > '~' {
			return false
		}
	}
	return true
}

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

// machineAddArgs are herdr's arguments to save target. Options take their
// value in the same argument, so a value never reads as an option; the
// target is checked not to start with "-" (herdr has no "--").
func machineAddArgs(target, label, session string) []string {
	args := []string{"machine", "add"}
	if label != "" {
		args = append(args, "--label="+label)
	}
	if session != "" {
		args = append(args, "--remote-session="+session)
	}
	return append(args, target)
}

// machineRenameArgs are herdr's arguments to rename machine id. herdr's
// rename takes the label as the argument after --label, whatever it starts
// with (it has no --label=).
func machineRenameArgs(id, label string) []string {
	return []string{"machine", "rename", id, "--label", label}
}

func (s *Server) broadcastMachines() {
	s.broadcast(map[string]any{"t": "machines", "list": s.mg.States()})
}

// catalogChanges are what following herdr's catalog changed, by machine id.
type catalogChanges struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Updated []string `json:"updated"`
}

func (c catalogChanges) any() bool { return len(c.Added)+len(c.Removed)+len(c.Updated) > 0 }

// syncCatalog makes the machines follow herdr's catalog: saved machines it
// no longer has are removed (their session ends), changed labels and
// enabled flags are applied, and machines the core does not have are added
// when take says so. Browsers get the new list when machines came or went;
// a changed machine reaches them as its state.
func (s *Server) syncCatalog(take func(machines.Spec) bool) (catalogChanges, error) {
	var c catalogChanges
	saved, err := s.opts.Catalog()
	if err != nil {
		return c, err
	}
	in := map[string]bool{}
	for _, sp := range saved {
		in[sp.ID] = true
		if s.mg.Get(sp.ID) != nil {
			if changed, err := s.mg.Update(sp); err == nil && changed {
				c.Updated = append(c.Updated, sp.ID)
			}
			continue
		}
		if take(sp) && s.mg.Add(sp) == nil {
			c.Added = append(c.Added, sp.ID)
		}
	}
	for _, st := range s.mg.States() {
		if st.Saved && !in[st.ID] && s.mg.Remove(st.ID) == nil {
			s.gui.Forget(st.ID)
			c.Removed = append(c.Removed, st.ID)
		}
	}
	if len(c.Added)+len(c.Removed) > 0 {
		s.broadcastMachines()
	}
	return c, nil
}

// selected reports whether the core's machine selection takes sp.
func (s *Server) selected(sp machines.Spec) bool {
	return s.opts.Selected == nil || s.opts.Selected(sp)
}

// runHerdr runs one of herdr's non-interactive machine commands with the
// local herdr, bounded in time, and returns its output.
func (s *Server) runHerdr(ctx context.Context, args ...string) (string, error) {
	bin := s.herdrCLI()
	if bin == "" {
		return "", errNoLocalHerdr
	}
	ctx, cancel := context.WithTimeout(ctx, herdrCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = herdrClientEnv(os.Environ())
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

var errNoLocalHerdr = errors.New("no_local_herdr")

// herdrFailed answers a herdr command that did not do what was asked, with
// its output as the detail.
func herdrFailed(w http.ResponseWriter, out string, err error) {
	if errors.Is(err, errNoLocalHerdr) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_local_herdr"})
		return
	}
	if out == "" && err != nil {
		out = err.Error()
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "herdr", "detail": out})
}

// handleMachinesRefresh reloads herdr's machines, for changes made outside
// the UI (herdr's own commands or TUI): new machines the core's selection
// takes are added, removed ones dropped, renamed or enabled and disabled
// ones updated. The reply lists the machines that changed.
func (s *Server) handleMachinesRefresh(w http.ResponseWriter, r *http.Request) {
	if s.opts.Catalog == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unsupported"})
		return
	}
	c, err := s.syncCatalog(s.selected)
	if err != nil {
		s.audit.log(r, "machine.refresh", map[string]any{"error": err.Error()})
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "catalog", "detail": err.Error()})
		return
	}
	if c.any() {
		s.audit.log(r, "machine.refresh", map[string]any{"added": c.Added, "removed": c.Removed, "updated": c.Updated})
	}
	writeJSON(w, http.StatusOK, c)
}

// handleMachineAdd saves a new SSH machine the way herdr does it: a
// terminal on the core host runs the local herdr's `herdr machine add`,
// which checks the machine over ssh with the user's configuration, prepares
// its herdr server and saves it in herdr's catalog, asking in the terminal
// when it needs to (a password, a host key, which session). Query: target,
// and optionally label and session. Machines that appeared in the catalog
// meanwhile are added and connect; the socket closes with "added <id>" for
// the first of them, or "none".
func (s *Server) handleMachineAdd(w http.ResponseWriter, r *http.Request) {
	if s.opts.Catalog == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unsupported"})
		return
	}
	q := r.URL.Query()
	target := strings.TrimSpace(q.Get("target"))
	label := strings.TrimSpace(q.Get("label"))
	session := strings.TrimSpace(q.Get("session"))
	if !validTarget(target) || !validLabel(label) || (session != "" && !sessionName.MatchString(session)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	bin := s.herdrCLI()
	if bin == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_local_herdr"})
		return
	}
	saved, err := s.opts.Catalog()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "catalog", "detail": err.Error()})
		return
	}
	before := map[string]bool{}
	for _, sp := range saved {
		before[sp.ID] = true
	}
	s.audit.log(r, "machine.add", map[string]any{"target": target, "label": label, "session": session})
	servePTYThen(w, r, append([]string{bin}, machineAddArgs(target, label, session)...), herdrClientEnv(os.Environ()), func() string {
		// Only what herdr saved now: machines the selection left out stay out.
		c, err := s.syncCatalog(func(sp machines.Spec) bool { return !before[sp.ID] })
		if err != nil || len(c.Added) == 0 {
			return "none"
		}
		s.audit.log(r, "machine.added", map[string]any{"machines": c.Added, "target": target})
		return "added " + c.Added[0]
	})
}

// savedMachine returns the machine of the request if it is one of herdr's
// saved machines; otherwise it answers.
func (s *Server) savedMachine(w http.ResponseWriter, r *http.Request) *machines.Machine {
	mc := s.machine(w, r)
	if mc == nil {
		return nil
	}
	if mc.Local() || !mc.State().Saved || s.opts.Catalog == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not_saved"})
		return nil
	}
	return mc
}

// catalogEntry returns herdr's saved machine id, if the catalog has it.
func (s *Server) catalogEntry(id string) (*machines.Spec, error) {
	saved, err := s.opts.Catalog()
	if err != nil {
		return nil, err
	}
	for i := range saved {
		if saved[i].ID == id {
			return &saved[i], nil
		}
	}
	return nil, nil
}

// handleMachineRemove removes a saved SSH machine with the local herdr's
// `herdr machine remove`; once it is gone from herdr's catalog its session
// ends (panes keep running in its herdr) and it leaves every browser.
// Machines given with --ssh are not herdr's and the local machine stays.
func (s *Server) handleMachineRemove(w http.ResponseWriter, r *http.Request) {
	mc := s.savedMachine(w, r)
	if mc == nil {
		return
	}
	id := mc.ID()
	out, runErr := s.runHerdr(r.Context(), "machine", "remove", id)
	ev := map[string]any{"machine": id, "target": mc.State().Target}
	// herdr reports a machine removed elsewhere as not found: what counts is
	// that the catalog no longer has it.
	entry, err := s.catalogEntry(id)
	if err != nil || entry != nil {
		if err != nil {
			out, runErr = err.Error(), err
		}
		ev["error"] = out
		s.audit.log(r, "machine.remove", ev)
		herdrFailed(w, out, runErr)
		return
	}
	if err := s.mg.Remove(id); err != nil && !errors.Is(err, machines.ErrUnknownMachine) {
		ev["error"] = err.Error()
		s.audit.log(r, "machine.remove", ev)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "remove", "detail": err.Error()})
		return
	}
	s.gui.Forget(id)
	s.audit.log(r, "machine.remove", ev)
	s.broadcastMachines()
	writeJSON(w, http.StatusOK, map[string]string{"removed": id})
}

// handleMachineRename renames a saved SSH machine ({"label": "..."}) with
// the local herdr's `herdr machine rename`, after checking that no other
// saved machine has the label (herdr's --machine selects by label). The
// reply is the machine's state.
func (s *Server) handleMachineRename(w http.ResponseWriter, r *http.Request) {
	mc := s.savedMachine(w, r)
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
	id := mc.ID()
	saved, err := s.opts.Catalog()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "catalog", "detail": err.Error()})
		return
	}
	for _, sp := range saved {
		if sp.ID != id && sp.Label == label {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "label_taken"})
			return
		}
	}
	ev := map[string]any{"machine": id, "from": mc.Label(), "label": label}
	out, runErr := s.runHerdr(r.Context(), machineRenameArgs(id, label)...)
	entry, err := s.catalogEntry(id)
	if err != nil || entry == nil || entry.Label != label {
		switch {
		case err != nil:
			out, runErr = err.Error(), err
		case entry == nil && out == "":
			out = "the machine is no longer saved in herdr"
		}
		ev["error"] = out
		s.audit.log(r, "machine.rename", ev)
		herdrFailed(w, out, runErr)
		return
	}
	s.mg.Update(*entry)
	s.audit.log(r, "machine.rename", ev)
	writeJSON(w, http.StatusOK, mc.State())
}
