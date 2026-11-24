//go:build unix

package claude

import (
	"encoding/json"
	"math"
	"slices"
	"strings"

	"veldr/internal/chatproto"
)

// maxLimits bounds the rate limit windows a chat states.
const maxLimits = 16

// result ends the turn: its stop reason, or its error; the chat's cost and
// context are what the result and then get_context_usage say. mu held.
func (s *session) result(pr *proc, line []byte, o *out) {
	var r struct {
		Subtype        string   `json:"subtype"`
		IsError        bool     `json:"is_error"`
		Result         string   `json:"result"`
		StopReason     *string  `json:"stop_reason"`
		TerminalReason string   `json:"terminal_reason"`
		Errors         []string `json:"errors"`
		// TotalCost is the session's, from its start (it survives a
		// resume).
		TotalCost  *float64 `json:"total_cost_usd"`
		ModelUsage map[string]struct {
			ContextWindow int64 `json:"contextWindow"`
		} `json:"modelUsage"`
		Usage struct {
			Iterations []struct {
				Input         int64 `json:"input_tokens"`
				CacheRead     int64 `json:"cache_read_input_tokens"`
				CacheCreation int64 `json:"cache_creation_input_tokens"`
				Output        int64 `json:"output_tokens"`
			} `json:"iterations"`
		} `json:"usage"`
	}
	if json.Unmarshal(line, &r) != nil {
		s.pass("a result of another shape")
		return
	}
	var ev chatproto.Event
	switch {
	case strings.HasPrefix(r.TerminalReason, "aborted"):
		// interrupt: aborted_streaming, aborted_tools.
		ev = chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: "cancelled"}
	case r.Subtype == "error_max_turns":
		ev = chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: "max_turn_requests"}
	case r.IsError || strings.HasPrefix(r.Subtype, "error"):
		code := chatproto.CodeFailed
		if s.authFailed {
			code = chatproto.CodeAuthRequired
		}
		msg := firstNonEmpty(r.Result, strings.Join(r.Errors, "; "), r.Subtype)
		ev = chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: &chatproto.Error{Code: code, Message: cut(msg, maxText)}}
	default:
		stop := "end_turn"
		if r.StopReason != nil {
			switch *r.StopReason {
			case "max_tokens", "model_context_window_exceeded":
				stop = "max_tokens"
			case "refusal":
				stop = "refusal"
			}
		}
		ev = chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: stop}
	}
	s.endTurn(o, ev)

	if r.TotalCost != nil {
		s.usage.Cost = &chatproto.Cost{Amount: *r.TotalCost, Currency: "USD"}
	}
	if n := len(r.Usage.Iterations); n > 0 {
		it := r.Usage.Iterations[n-1]
		if used := it.Input + it.CacheRead + it.CacheCreation + it.Output; used > 0 {
			s.usage.Used, s.usage.Percentage = used, 0
			if m, ok := r.ModelUsage[s.running]; ok && m.ContextWindow > 0 {
				s.usage.Size = m.ContextWindow
			}
		}
	}
	s.usageChanged(o)
	// The context's share in use, as Claude Code counts it.
	o.after = append(o.after, func() {
		_ = pr.requestAsync("get_context_usage", map[string]string{"detail": "summary"}, func(raw json.RawMessage, err error) {
			var cu contextUsage
			if err == nil && decode(raw, &cu) == nil {
				s.change(func(o *out) { s.takeContextUsage(&cu, o) })
			}
		})
	})
}

// lifecycle follows the user's messages: a queued one the program took
// (into the running turn after a tool's result, or as the next turn), one
// withdrawn, one done. mu held.
func (s *session) lifecycle(line []byte, o *out) {
	var f struct {
		UUID  string `json:"command_uuid"`
		State string `json:"state"`
	}
	if json.Unmarshal(line, &f) != nil {
		s.pass("a command_lifecycle of another shape")
		return
	}
	m := s.sent[f.UUID]
	switch f.State {
	case "queued":
	case "started":
		s.ensureTurn(o)
		if m != nil && m.queued && !m.taken {
			m.taken = true
			// The message is the user's prompt from now on.
			o.event(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedTaken, Message: m.message, Content: m.content, ClientID: m.clientID})
		}
	case "completed":
		if m != nil {
			delete(s.sent, f.UUID)
			delete(s.byMessage, m.message)
		}
	case "cancelled":
		s.withdrawn(o, f.UUID)
		if m != nil {
			delete(s.sent, f.UUID)
			delete(s.byMessage, m.message)
		}
	default:
		s.pass("command_lifecycle " + f.State)
	}
}

// rateLimit states the subscription's windows. mu held.
func (s *session) rateLimit(line []byte, o *out) {
	var f struct {
		Info struct {
			Windows map[string]struct {
				Utilization float64 `json:"utilization"`
				ResetsAt    int64   `json:"resetsAt"`
			} `json:"unifiedWindows"`
		} `json:"rate_limit_info"`
	}
	if json.Unmarshal(line, &f) != nil {
		s.pass("a rate_limit_event of another shape")
		return
	}
	if len(f.Info.Windows) == 0 {
		return
	}
	ids := make([]string, 0, len(f.Info.Windows))
	for id := range f.Info.Windows {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	var limits []chatproto.Limit
	for _, id := range ids[:min(len(ids), maxLimits)] {
		w := f.Info.Windows[id]
		limits = append(limits, chatproto.Limit{ID: cut(id, 64), UsedPercent: math.Round(min(max(w.Utilization*100, 0), 100)*1e4) / 1e4, ResetsAt: w.ResetsAt, WindowMinutes: windowMinutes(id)})
	}
	s.usage.Limits = limits
	s.usageChanged(o)
}

// windowMinutes is the length of a rate limit window Claude Code names.
func windowMinutes(id string) int {
	switch {
	case id == "five_hour":
		return 5 * 60
	case strings.HasPrefix(id, "seven_day"):
		return 7 * 24 * 60
	}
	return 0
}

// takeMode states the program's permission mode. mu held.
func (s *session) takeMode(mode string, o *out) {
	if m := chatMode(mode); m != "" && m != s.mode {
		s.mode = m
		s.configChanged(o)
	}
}

// task updates the tool call of a task (a subagent's Agent call, a
// command's Bash call): its status, and _meta.<slug>.task. mu held.
func (s *session) task(o *out, toolID, status string, meta map[string]any) {
	u := map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": toolID}
	if status != "" {
		u["status"] = status
	}
	if meta != nil {
		u["_meta"] = ownMeta(map[string]any{"task": meta})
	}
	o.event(chatproto.Event{T: chatproto.EventUpdate, Item: toolID, Parent: s.toolParent[toolID], Update: mustJSON(u)})
}

// taskStatus is the ACP status of a tool call of a task in status.
func taskStatus(status string) string {
	switch status {
	case "completed":
		return "completed"
	case "failed", "killed", "stopped", "error":
		return "failed"
	case "running", "pending":
		return "in_progress"
	}
	return ""
}
