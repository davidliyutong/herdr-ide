package server

// Managing a machine's herdr from the UI (docs/features/17): its status and
// starting, stopping and restarting its server on any machine, and, on the
// local machine, updating the application's copy of herdr through herdr's
// own updater.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
)

// herdrActions are the actions of POST /api/m/{id}/herdr/{action}, with
// whether machines other than the core host accept them. Only the server's
// are: an update replaces the application's copy of herdr, and SSH machines
// update herdr through herdr's own `herdr --remote` (handleHerdrRemote).
var herdrActions = map[string]bool{"start": true, "stop": true, "restart": true, "check": false, "update": false}

func (s *Server) handleHerdrStatus(w http.ResponseWriter, r *http.Request) {
	s.herdrRequest(w, r, "status")
}

func (s *Server) handleHerdrAction(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	if _, ok := herdrActions[action]; !ok {
		http.Error(w, "unknown action", http.StatusNotFound)
		return
	}
	s.herdrRequest(w, r, action)
}

func (s *Server) herdrRequest(w http.ResponseWriter, r *http.Request, action string) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	if action != "status" && !herdrActions[action] && !mc.Local() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not_local"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	st, err := herdrOp(ctx, mc, action)
	if err == nil {
		// The machine shows the herdr found now, which may have been
		// removed, reinstalled or moved since its agent connected.
		mc.NoteHerdr(st.Bin, st.Version)
	}
	if action != "status" && action != "check" {
		ev := map[string]any{"machine": mc.ID(), "session": mc.State().Session}
		if err != nil {
			ev["error"] = err.Error()
		} else if st.Error != "" {
			ev["error"] = st.Error
		}
		s.audit.log(r, "herdr."+action, ev)
		mc.Refresh()
		if err == nil && st.Running {
			// Panes show again without waiting for the surface's backoff.
			s.wakeSurface(mc.ID())
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// herdrOp runs an OpHerdr action; its result is the second reply line.
func herdrOp(ctx context.Context, mc *machines.Machine, action string) (*agentproto.HerdrStatus, error) {
	conn, _, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpHerdr, Action: action})
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil {
		return nil, err
	}
	if !rep.OK || rep.Herdr == nil {
		return nil, fmt.Errorf("agent herdr %s: %s", action, rep.Error)
	}
	return rep.Herdr, nil
}

// handleHerdrRemote updates herdr on an SSH machine the way herdr does it:
// it runs the local herdr's `herdr --remote <target>` in a PTY on the core
// host, bridged to a WebSocket like the authentication terminal. herdr finds
// the remote installation, offers to install its own version there (asking
// first, verifying the download), asks before replacing a running server
// (live handoff only with ?handoff=1, herdr's --handoff) and then attaches.
// The application changes nothing on the machine itself; afterwards it
// reconnects so that a new agent uses the herdr now installed.
func (s *Server) handleHerdrRemote(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	st := mc.State()
	if st.Kind != machines.KindSSH {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not_ssh"})
		return
	}
	bin := s.localHerdr()
	if bin == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_local_herdr"})
		return
	}
	handoff := r.URL.Query().Get("handoff") == "1"
	s.audit.log(r, "herdr.remote", map[string]any{"machine": mc.ID(), "target": st.Target, "handoff": handoff})
	if servePTY(w, r, append([]string{bin}, remoteHerdrArgs(st.Target, st.Session, handoff)...), herdrClientEnv(os.Environ())) {
		mc.Reconnect(machines.HerdrExecutable(mc.ID()))
	}
}

// localHerdr is the herdr the local machine's agent uses (installed, or the
// application's copy): the version herdr installs on remote machines.
func (s *Server) localHerdr() string {
	if mc := s.mg.Get(machines.LocalID); mc != nil {
		if info := mc.State().Info; info != nil {
			return info.HerdrBin
		}
	}
	return ""
}

func remoteHerdrArgs(target, session string, handoff bool) []string {
	args := []string{"--remote=" + target} // one argument: a target never reads as an option
	if session != "" && session != "default" {
		args = append(args, "--session", session)
	}
	if handoff {
		args = append(args, "--handoff")
	}
	return args
}

// herdrClientEnv is the core's environment for a herdr client in a terminal:
// without the pane context of a herdr the core may itself run in.
func herdrClientEnv(parent []string) []string {
	var env []string
	for _, kv := range parent {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION", "TERM", "COLORTERM":
			continue
		}
		env = append(env, kv)
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
}
