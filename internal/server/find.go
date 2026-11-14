package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/panefind"
)

// handleFind searches a pane's text for the find bar
// (docs/features/20-find-in-panes.md): the machine's agent reads the text
// from herdr and searches it there (agentproto.OpPaneFind). It only reads,
// so read-only pages may search too. Body: agentproto.FindRequest; answer:
// agentproto.FindResult, or {"error": code, "detail": …}.
func (s *Server) handleFind(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	var req agentproto.FindRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || req.Pane == "" || req.Query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
		return
	}
	if len(req.Query) > panefind.MaxQuery {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": agentproto.FindTooLarge})
		return
	}
	// A newer query cancels the request, which closes the agent's stream
	// and stops its search.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	rep, err := requestAgent(ctx, mc, agentproto.Header{Op: agentproto.OpPaneFind, Find: &req})
	switch {
	case err == nil && rep.Find != nil:
		writeJSON(w, http.StatusOK, rep.Find)
	case errors.Is(err, context.Canceled) || r.Context().Err() != nil:
		// The browser is gone; nobody reads the answer.
	case rep != nil && rep.Code == agentproto.FindInvalidRegex:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": rep.Code, "detail": rep.Error})
	case rep != nil && rep.Code != "":
		writeJSON(w, http.StatusConflict, map[string]string{"error": rep.Code, "detail": rep.Error})
	default:
		detail := "no answer"
		if err != nil {
			detail = err.Error()
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "transport", "detail": detail})
	}
}
