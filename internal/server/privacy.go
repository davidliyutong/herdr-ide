package server

import (
	"context"
	"net/http"
	"time"

	"herdr-ide/internal/agentproto"
)

// handlePrivacy reports what macOS's Full Disk Access lets a machine's
// processes do (GET /api/m/{id}/privacy, op privacy): files, for the
// agent's own process (on the local machine the core's, which the desktop
// app started), and terminals, for the terminal core's; each granted,
// denied or unknown, with the terminal core's executable, which a grant for
// terminals names. The agent only opens and closes protected folders, and
// in a terminal core that runs; it starts none.
func (s *Server) handlePrivacy(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	sess := mc.Session()
	if sess == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": termCodeOffline})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	rep, err := sess.Request(ctx, agentproto.Header{Op: agentproto.OpPrivacy})
	if err != nil || rep.Privacy == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport"})
		return
	}
	writeJSON(w, http.StatusOK, rep.Privacy)
}
