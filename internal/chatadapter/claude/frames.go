//go:build unix

package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agent/transcript"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/chatproto"
)

// maxTracked bounds the maps of tool calls and tasks a session keeps for
// its subagents' events: beyond it they start over (an event of an
// older subagent then has no Parent).
const maxTracked = 4096

// read reads the program's output until it ends, then ends the session
// unless the program was replaced (a restart).
func (s *session) read(pr *proc) {
	br := pr.reader()
	for {
		line, err := chatproto.ReadLine(br)
		if errors.Is(err, chatproto.ErrTooLarge) {
			err = skipLine(br)
			s.change(func(*out) { s.pass("a line longer than chatproto.MaxLine") })
			s.lines.Add(1)
			if err == nil {
				continue
			}
		}
		if err != nil {
			break
		}
		s.handle(pr, line)
		s.lines.Add(1)
	}
	pr.end()
	// The output ended: the program ends, or is made to, and what it left
	// in its group goes too.
	select {
	case <-pr.exited:
	case <-time.After(pr.closeGrace):
		pr.stop()
	}
	<-pr.done
	s.finish(pr, pr.exitError(chatproto.CodeEnded))
}

// skipLine reads the rest of a line ReadLine refused.
func skipLine(br *bufio.Reader) error {
	for {
		_, err := br.ReadSlice('\n')
		if !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}

// handle takes a line of the program's output.
func (s *session) handle(pr *proc, line []byte) {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(line, &head) != nil {
		s.change(func(*out) { s.pass("a line that is no JSON object") })
		return
	}
	switch head.Type {
	case "control_response":
		var r controlResponse
		if json.Unmarshal(line, &r) != nil || !pr.resolve(r.Response) {
			// The program echoes the answers it is sent.
			s.mu.Lock()
			s.echoes++
			s.mu.Unlock()
		}
	case "control_request":
		var r controlRequest
		if json.Unmarshal(line, &r) != nil || r.RequestID == "" {
			s.change(func(*out) { s.pass("a control request of another shape") })
			return
		}
		s.incoming(pr, r)
	case "control_cancel_request":
		var r struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal(line, &r)
		pr.cancelIncoming(r.RequestID)
	case "keep_alive":
		s.change(func(*out) { s.pass("keep_alive") })
	default:
		s.change(func(o *out) { s.frame(pr, head.Type, line, o) })
	}
}

// frame maps a message of the program; mu held.
func (s *session) frame(pr *proc, typ string, line []byte, o *out) {
	switch typ {
	case "stream_event":
		s.streamEvent(line, o)
	case "assistant":
		s.assistant(line, o)
	case "user":
		s.user(line, o)
	case "system":
		s.system(line, o)
	case "result":
		s.result(pr, line, o)
	case "command_lifecycle":
		s.lifecycle(line, o)
	case "rate_limit_event":
		s.rateLimit(line, o)
	case "tool_progress", "tool_use_summary", "auth_status", "prompt_suggestion", "streamlined_text", "streamlined_tool_use_summary":
		// Known, and nothing the chat shows.
	default:
		s.pass("frame " + typ)
	}
}

// ensureTurn starts a turn unless one runs: the program works (a message
// it took, a background task's notification); mu held.
func (s *session) ensureTurn(o *out) {
	if !s.inTurn {
		s.startTurn(o)
	}
}

// itemOf is the item of a message's content block.
func itemOf(message string, block int) string { return message + "/" + strconv.Itoa(block) }

// updateHead is what an event's update says of what it belongs to.
type updateHead struct {
	SessionUpdate string `json:"sessionUpdate"`
	ToolCallID    string `json:"toolCallId"`
	MessageID     string `json:"messageId"`
}

func headOf(u json.RawMessage) updateHead {
	var h updateHead
	_ = json.Unmarshal(u, &h)
	return h
}

func isChunk(kind string) bool {
	return kind == "agent_message_chunk" || kind == "agent_thought_chunk"
}

// eventOf is a transcript's event as the chat's.
func eventOf(ev agentproto.TranscriptEvent) chatproto.Event {
	return chatproto.Event{T: ev.T, At: ev.At, Update: ev.Update, Content: ev.Content, State: ev.State,
		StopReason: ev.StopReason, Method: ev.Method, Params: ev.Params}
}

// live is a streaming increment of an item.
func live(item, parent string, update map[string]any) chatproto.Event {
	return chatproto.Event{T: chatproto.EventUpdate, Live: true, Item: item, Parent: parent, Update: mustJSON(update)}
}

// ownMeta is the update's _meta member of the product's own.
func ownMeta(kv map[string]any) map[string]any {
	return map[string]any{brand.Slug: kv}
}

func (s *session) streamEvent(line []byte, o *out) {
	var f struct {
		Event struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message *struct {
				ID string `json:"id"`
			} `json:"message"`
			Block *struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta *struct {
				Type      string `json:"type"`
				Text      string `json:"text"`
				Thinking  string `json:"thinking"`
				Estimated *int64 `json:"estimated_tokens"`
			} `json:"delta"`
		} `json:"event"`
		Parent *string `json:"parent_tool_use_id"`
	}
	if json.Unmarshal(line, &f) != nil {
		s.pass("a stream_event of another shape")
		return
	}
	if f.Parent != nil && *f.Parent != "" {
		// Subagents do not stream; their frames come whole.
		return
	}
	ev, st := &f.Event, &s.stream
	switch ev.Type {
	case "message_start":
		s.ensureTurn(o)
		if ev.Message != nil {
			*st = streamState{message: ev.Message.ID, open: -1}
		}
	case "content_block_start":
		if ev.Block == nil {
			return
		}
		st.open, st.kind, st.tool, st.estimated = ev.Index, ev.Block.Type, "", 0
		if (ev.Block.Type == "tool_use" || ev.Block.Type == "server_tool_use") && ev.Block.ID != "" {
			st.tool = ev.Block.ID
			if u := toolCallUpdate(ev.Block.ID, ev.Block.Name, nil); u != nil {
				o.event(live(ev.Block.ID, "", u))
			}
		}
	case "content_block_delta":
		if ev.Delta == nil || ev.Index != st.open || st.message == "" {
			return
		}
		item := itemOf(st.message, st.open)
		switch ev.Delta.Type {
		case "text_delta":
			if ev.Delta.Text != "" {
				o.event(live(item, "", map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(ev.Delta.Text), "messageId": st.message}))
			}
		case "thinking_delta":
			u := map[string]any{"sessionUpdate": "agent_thought_chunk", "content": textBlock(ev.Delta.Thinking), "messageId": st.message}
			if ev.Delta.Estimated != nil {
				// Claude Code keeps the thinking's text to itself: what is
				// shown is how much of it there is.
				st.estimated = *ev.Delta.Estimated
				u["_meta"] = ownMeta(map[string]any{"estimatedTokens": st.estimated})
			} else if ev.Delta.Thinking == "" {
				return
			}
			o.event(live(item, "", u))
		}
	case "content_block_stop":
		if ev.Index == st.open {
			st.open = -1
		}
	case "message_delta", "message_stop":
	default:
		s.pass("stream event " + ev.Type)
	}
}

// toolCallUpdate is the ACP tool_call of a tool use, as the transcript's
// mapping makes it (title, kind, the input, diffs of the change it
// makes); nil for a tool that is no tool call (TodoWrite's plan).
func toolCallUpdate(id, name string, input json.RawMessage) map[string]any {
	if len(input) == 0 {
		input = json.RawMessage("{}")
	}
	line := mustJSON(map[string]any{"type": "assistant", "message": map[string]any{"id": "", "content": []any{
		map[string]any{"type": "tool_use", "id": id, "name": name, "input": input},
	}}})
	for _, ev := range transcript.ClaudeFrame(line, transcript.Limits{}).Events {
		if headOf(ev.Update).SessionUpdate == "tool_call" {
			var u map[string]any
			if json.Unmarshal(ev.Update, &u) == nil {
				return u
			}
		}
	}
	return nil
}

// trackTool remembers the agent a tool call belongs to; mu held.
func (s *session) trackTool(id, parent string) {
	if s.toolParent == nil || len(s.toolParent) >= maxTracked {
		s.toolParent = map[string]string{}
	}
	s.toolParent[id] = parent
}

func (s *session) assistant(line []byte, o *out) {
	var f struct {
		Parent *string `json:"parent_tool_use_id"`
		Error  string  `json:"error"`
	}
	_ = json.Unmarshal(line, &f)
	parent := ""
	if f.Parent != nil {
		parent = *f.Parent
	}
	if f.Error == "authentication_failed" {
		s.authFailed = true
	}
	if parent == "" {
		s.ensureTurn(o)
	}
	fr := transcript.ClaudeFrame(line, transcript.Limits{})
	s.unknown += fr.Unknown
	st := &s.stream
	base := s.blocks[fr.Message]
	switch {
	case parent == "" && fr.Message != "" && fr.Message == st.message && st.open >= 0 && fr.Count == 1:
		base = st.open
	case fr.First >= 0:
		base = fr.First
	}
	for k, ev := range fr.Events {
		switch ev.T {
		case agentproto.TranscriptUpdate:
			h := headOf(ev.Update)
			if h.SessionUpdate == "usage_update" {
				continue
			}
			e := eventOf(ev)
			e.At, e.Parent = time.Time{}, parent
			switch {
			case isChunk(h.SessionUpdate) && fr.Message != "":
				block := base + max(fr.Blocks[k], 0)
				e.Item = itemOf(fr.Message, block)
				if h.SessionUpdate == "agent_thought_chunk" && parent == "" && block == st.open && st.estimated > 0 {
					e.Update = withMeta(e.Update, "estimatedTokens", st.estimated)
				}
			case h.ToolCallID != "":
				e.Item = h.ToolCallID
				if h.SessionUpdate == "tool_call" {
					s.trackTool(h.ToolCallID, parent)
				}
			}
			o.event(e)
		case agentproto.TranscriptNotice:
			e := eventOf(ev)
			e.At, e.Parent = time.Time{}, parent
			o.event(e)
		}
	}
	if fr.Message != "" {
		s.blocks[fr.Message] = max(s.blocks[fr.Message], base+fr.Count)
		if len(s.blocks) > maxTracked {
			s.blocks = map[string]int{fr.Message: base + fr.Count}
		}
	}
}

// withMeta is the update u with _meta.<slug>.key set to v.
func withMeta(u json.RawMessage, key string, v any) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(u, &m) != nil {
		return u
	}
	meta, _ := m["_meta"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		m["_meta"] = meta
	}
	own, _ := meta[brand.Slug].(map[string]any)
	if own == nil {
		own = map[string]any{}
		meta[brand.Slug] = own
	}
	own[key] = v
	return mustJSON(m)
}

func (s *session) user(line []byte, o *out) {
	var f struct {
		IsReplay    bool    `json:"isReplay"`
		IsSynthetic bool    `json:"isSynthetic"`
		Parent      *string `json:"parent_tool_use_id"`
	}
	_ = json.Unmarshal(line, &f)
	if f.IsReplay || f.IsSynthetic {
		// Echoes of the user's messages, and the summary of a compaction.
		return
	}
	parent := ""
	if f.Parent != nil {
		parent = *f.Parent
	}
	fr := transcript.ClaudeFrame(line, transcript.Limits{})
	s.unknown += fr.Unknown
	for _, ev := range fr.Events {
		if ev.T != agentproto.TranscriptUpdate {
			// The prompt a subagent was given, the record of an interrupt:
			// the turn's own events say those.
			continue
		}
		h := headOf(ev.Update)
		if h.SessionUpdate != "tool_call_update" && h.SessionUpdate != "plan" {
			continue
		}
		e := eventOf(ev)
		e.At, e.Parent, e.Item = time.Time{}, parent, h.ToolCallID
		o.event(e)
	}
}

func (s *session) system(line []byte, o *out) {
	var f struct {
		Subtype        string          `json:"subtype"`
		State          string          `json:"state"`
		Status         *string         `json:"status"`
		PermissionMode string          `json:"permissionMode"`
		CompactResult  string          `json:"compact_result"`
		CompactError   string          `json:"compact_error"`
		Model          string          `json:"model"`
		Commands       json.RawMessage `json:"commands"`
		Metadata       *struct {
			Trigger    string `json:"trigger"`
			PreTokens  int64  `json:"pre_tokens"`
			PostTokens int64  `json:"post_tokens"`
		} `json:"compact_metadata"`
		TaskID      string `json:"task_id"`
		ToolUseID   string `json:"tool_use_id"`
		Description string `json:"description"`
		TaskType    string `json:"task_type"`
		Summary     string `json:"summary"`
		LastTool    string `json:"last_tool_name"`
		Usage       *struct {
			Tokens     int64 `json:"total_tokens"`
			ToolUses   int64 `json:"tool_uses"`
			DurationMS int64 `json:"duration_ms"`
		} `json:"usage"`
		Patch *struct {
			Status string `json:"status"`
		} `json:"patch"`
		Content     string          `json:"content"`
		Error       json.RawMessage `json:"error"`
		ErrorStatus *int            `json:"error_status"`
	}
	if json.Unmarshal(line, &f) != nil {
		s.pass("a system frame of another shape")
		return
	}
	switch f.Subtype {
	case "init":
		s.ensureTurn(o)
		if f.Model != "" {
			s.running = f.Model
		}
		s.takeMode(f.PermissionMode, o)
	case "status":
		s.takeMode(f.PermissionMode, o)
		if f.Status != nil && *f.Status == "compacting" {
			o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeCompacting)})
		}
		if f.CompactResult != "" && f.CompactResult != "success" {
			o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeError),
				Params: mustJSON(map[string]string{"message": cut(firstNonEmpty(f.CompactError, "compact: "+f.CompactResult), maxText)})})
		}
	case "api_retry":
		// A request failed and is tried again.
		var kind string
		_ = json.Unmarshal(f.Error, &kind)
		msg := firstNonEmpty(kind, "the API request failed")
		if f.ErrorStatus != nil && *f.ErrorStatus > 0 {
			msg = strconv.Itoa(*f.ErrorStatus) + " " + msg
		}
		o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeError),
			Params: mustJSON(map[string]any{"message": cut(msg, maxText), "willRetry": true})})
	case "compact_boundary":
		params := map[string]any{}
		if m := f.Metadata; m != nil {
			if m.Trigger != "" {
				params["trigger"] = m.Trigger
			}
			if m.PreTokens > 0 {
				params["preTokens"] = m.PreTokens
			}
			if m.PostTokens > 0 {
				params["postTokens"] = m.PostTokens
			}
		}
		o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeCompacted), Params: mustJSON(params)})
	case "session_state_changed":
		switch f.State {
		case "running":
			s.ensureTurn(o)
		case "idle":
			// After the turn's result; a turn that had none ends here.
			s.endTurn(o, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: "end_turn"})
		}
	case "commands_changed":
		var cs []struct {
			Name         string `json:"name"`
			Description  string `json:"description"`
			ArgumentHint string `json:"argumentHint"`
		}
		if json.Unmarshal(f.Commands, &cs) == nil {
			commands := slashCommands(cs)
			o.update(func(c *chatproto.Chat) { c.Commands = commands })
		}
	case "task_started":
		if f.TaskID != "" && f.ToolUseID != "" {
			if len(s.tasks) >= maxTracked {
				s.tasks = map[string]string{}
			}
			s.tasks[f.TaskID] = f.ToolUseID
			s.task(o, f.ToolUseID, "in_progress", map[string]any{"type": f.TaskType, "description": cut(f.Description, maxText)})
		}
	case "task_progress":
		if f.ToolUseID != "" && f.Usage != nil {
			s.task(o, f.ToolUseID, "", map[string]any{"description": cut(f.Description, maxText), "lastTool": f.LastTool,
				"tokens": f.Usage.Tokens, "toolUses": f.Usage.ToolUses, "durationMs": f.Usage.DurationMS})
		}
	case "task_updated":
		if id := s.tasks[f.TaskID]; id != "" && f.Patch != nil {
			if status := taskStatus(f.Patch.Status); status != "" {
				s.task(o, id, status, nil)
			}
		}
	case "task_notification":
		id := firstNonEmpty(f.ToolUseID, s.tasks[f.TaskID])
		if id != "" {
			meta := map[string]any{"summary": cut(f.Summary, maxText)}
			if f.Usage != nil {
				meta["tokens"], meta["toolUses"], meta["durationMs"] = f.Usage.Tokens, f.Usage.ToolUses, f.Usage.DurationMS
			}
			status := ""
			if f.Status != nil {
				status = *f.Status
			}
			s.task(o, id, taskStatus(status), meta)
			delete(s.tasks, f.TaskID)
		}
	case "local_command_output":
		if strings.TrimSpace(f.Content) != "" {
			o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeCommand),
				Params: mustJSON(map[string]string{"output": cut(f.Content, maxText)})})
		}
	case "thinking_tokens", "hook_started", "hook_progress", "hook_response", "files_persisted",
		"notification", "informational", "plugin_install", "background_tasks_changed", "memory_recall",
		"permission_denied", "elicitation_complete", "model_refusal_fallback", "model_refusal_no_fallback",
		"mirror_error", "session_writes_lost", "conversation_reset", "worker_shutting_down", "control_request_progress":
		// Known, and nothing the chat shows.
	default:
		s.pass("system/" + f.Subtype)
	}
}
