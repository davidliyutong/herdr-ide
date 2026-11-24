//go:build unix

package claude

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// The messages a denial gives the model.
const (
	denyTool     = "The user declined this tool use."
	denyQuestion = "The user skipped the question; end your turn and wait for their next message."
	denyPlan     = "The user did not approve the plan. Stay in plan mode and revise the plan with the user."
	denyUnasked  = "The user could not be asked."
)

// incoming answers a request of the program's: can_use_tool asks the user
// through the sink in a goroutine of its own (the program's other output
// is read meanwhile); an MCP server's elicitation is declined; any other
// is refused, as the SDK refuses what it has no handler for.
func (s *session) incoming(pr *proc, r controlRequest) {
	var head struct {
		Subtype string `json:"subtype"`
	}
	_ = json.Unmarshal(r.Request, &head)
	switch head.Subtype {
	case "can_use_tool":
		ctx, cancel := context.WithCancel(s.ctx)
		if !pr.track(r.RequestID, cancel) {
			cancel()
			return
		}
		s.mu.Lock()
		s.waiting++
		s.mu.Unlock()
		go func() {
			defer func() {
				cancel()
				pr.untrack(r.RequestID)
				s.mu.Lock()
				s.waiting--
				s.mu.Unlock()
			}()
			resp, after := s.canUseTool(ctx, r.Request)
			// A request the program cancelled (an interrupt) or a session
			// that ended is not answered.
			if resp == nil || ctx.Err() != nil {
				return
			}
			if err := pr.answer(r.RequestID, resp, nil); err == nil && after != nil {
				after(pr)
			}
		}()
	case "elicitation":
		go pr.answer(r.RequestID, map[string]string{"action": "decline"}, nil)
	default:
		s.change(func(*out) { s.pass("request " + head.Subtype) })
		go pr.answer(r.RequestID, nil, errors.New("Unsupported control request subtype: "+head.Subtype))
	}
}

// toolRequest is a can_use_tool request.
type toolRequest struct {
	ToolName    string            `json:"tool_name"`
	Input       json.RawMessage   `json:"input"`
	ToolUseID   string            `json:"tool_use_id"`
	AgentID     string            `json:"agent_id"`
	Suggestions []json.RawMessage `json:"permission_suggestions"`
}

// allow is the answer that runs the tool with input as it was asked.
func allow(input json.RawMessage, updated []json.RawMessage) map[string]any {
	a := map[string]any{"behavior": "allow", "updatedInput": input}
	if len(updated) > 0 {
		a["updatedPermissions"] = updated
	}
	return a
}

func deny(msg string) map[string]any { return map[string]any{"behavior": "deny", "message": msg} }

// canUseTool asks the user about a tool use and makes the program's
// answer (nil for none: the request was cancelled), and what to do once it
// was sent.
func (s *session) canUseTool(ctx context.Context, raw json.RawMessage) (map[string]any, func(*proc)) {
	var q toolRequest
	if err := json.Unmarshal(raw, &q); err != nil {
		return deny(denyUnasked), nil
	}
	if len(q.Input) == 0 || string(q.Input) == "null" {
		q.Input = json.RawMessage("{}")
	}
	s.mu.Lock()
	parent := s.tasks[q.AgentID]
	s.mu.Unlock()
	call := toolCall(q.ToolUseID, q.ToolName, q.Input)
	switch q.ToolName {
	case "AskUserQuestion":
		return s.askQuestions(ctx, q, call, parent), nil
	case "ExitPlanMode":
		return s.approvePlan(ctx, q, call, parent)
	}
	opts := []chatproto.PermissionOption{{OptionID: chatadapter.OptionAllowOnce, Name: "Allow", Kind: chatproto.AllowOnce}}
	rules := sessionRules(q.Suggestions)
	if len(rules) > 0 {
		opts = append(opts, chatproto.PermissionOption{OptionID: chatadapter.OptionAllowSession, Name: "Allow for this session", Kind: chatproto.AllowAlways})
	}
	opts = append(opts, chatproto.PermissionOption{OptionID: chatadapter.OptionRejectOnce, Name: "Reject", Kind: chatproto.RejectOnce})
	a, err := s.sink.Permission(ctx, chatadapter.PermissionRequest{Kind: permissionKind(q.ToolName), ToolCall: call, Options: opts, Parent: parent})
	switch {
	case ctx.Err() != nil:
		return nil, nil
	case err != nil:
		return deny(denyUnasked), nil
	case a.Cancelled:
		return deny(denyTool), nil
	}
	switch a.Option {
	case chatadapter.OptionAllowOnce:
		return allow(q.Input, nil), nil
	case chatadapter.OptionAllowSession:
		if len(rules) > 0 {
			return allow(q.Input, rules), nil
		}
	}
	return deny(denyTool), nil
}

// sessionRules are the permission suggestions that allow calls like this
// one for the rest of the session: the addRules ones only, their
// destination rewritten to "session" (a setMode suggestion would switch
// the mode, a settings destination would write the user's settings).
func sessionRules(suggestions []json.RawMessage) []json.RawMessage {
	var out []json.RawMessage
	for _, raw := range suggestions {
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		var typ, behavior string
		_ = json.Unmarshal(m["type"], &typ)
		_ = json.Unmarshal(m["behavior"], &behavior)
		if typ != "addRules" || behavior != "allow" || len(m["rules"]) == 0 {
			continue
		}
		m["destination"] = json.RawMessage(`"session"`)
		out = append(out, mustJSON(m))
	}
	return out
}

// permissionKind is the kind of permission a tool's use is.
func permissionKind(tool string) string {
	switch {
	case tool == "Bash" || tool == "BashOutput" || tool == "KillShell" || tool == "KillBash":
		return chatproto.PermissionCommand
	case tool == "Edit" || tool == "MultiEdit" || tool == "Write" || tool == "NotebookEdit":
		return chatproto.PermissionFile
	case strings.HasPrefix(tool, "mcp__"):
		return chatproto.PermissionMCP
	}
	return chatproto.PermissionTool
}

// toolCall is the ACP ToolCall a permission is asked for.
func toolCall(id, name string, input json.RawMessage) json.RawMessage {
	u := toolCallUpdate(id, name, input)
	if u == nil {
		u = map[string]any{"toolCallId": id, "title": name, "kind": "other", "status": "pending", "rawInput": input}
	}
	delete(u, "sessionUpdate")
	return mustJSON(u)
}

// askQuestions asks the user AskUserQuestion's questions: the answers go
// back as the tool's input with "answers" (by question text: the label, or
// the labels joined with ", "); skipped, the tool is denied.
func (s *session) askQuestions(ctx context.Context, q toolRequest, call json.RawMessage, parent string) map[string]any {
	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
				Preview     string `json:"preview"`
			} `json:"options"`
		} `json:"questions"`
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(q.Input, &in) != nil || json.Unmarshal(q.Input, &input) != nil || len(in.Questions) == 0 {
		return deny(denyUnasked)
	}
	var qs []chatproto.Question
	for i, x := range in.Questions[:min(len(in.Questions), maxQuestions)] {
		cq := chatproto.Question{ID: strconv.Itoa(i), Header: cut(x.Header, maxText), Question: cut(x.Question, maxText), MultiSelect: x.MultiSelect, AllowOther: true}
		for _, o := range x.Options[:min(len(x.Options), maxOptions)] {
			cq.Options = append(cq.Options, chatproto.QuestionOption{Label: cut(o.Label, maxText), Description: cut(o.Description, maxText), Preview: cut(o.Preview, maxText)})
		}
		qs = append(qs, cq)
	}
	a, err := s.sink.Question(ctx, chatadapter.QuestionRequest{Questions: qs, ToolCall: call, Parent: parent})
	switch {
	case ctx.Err() != nil:
		return nil
	case err != nil:
		return deny(denyUnasked)
	}
	answers := map[string]string{}
	for i, x := range in.Questions[:len(qs)] {
		if got := a.Answers[strconv.Itoa(i)]; len(got) > 0 {
			answers[x.Question] = strings.Join(got, ", ")
		}
	}
	if a.Cancelled || len(answers) == 0 {
		return deny(denyQuestion)
	}
	input["answers"] = mustJSON(answers)
	return allow(mustJSON(input), nil)
}

// approvePlan asks the user to approve ExitPlanMode's plan: approved, the
// program goes on in the mode the option names (it leaves plan mode for
// default by itself; the chosen mode is set once the answer is sent);
// rejected, it keeps planning.
func (s *session) approvePlan(ctx context.Context, q toolRequest, call json.RawMessage, parent string) (map[string]any, func(*proc)) {
	opts := []chatproto.PermissionOption{
		{OptionID: chatadapter.PlanOption(chatproto.ModeDefault), Name: "Approve", Kind: chatproto.AllowOnce},
		{OptionID: chatadapter.PlanOption(chatproto.ModeAcceptEdits), Name: "Approve and accept edits", Kind: chatproto.AllowOnce},
		{OptionID: chatadapter.OptionRejectOnce, Name: "Keep planning", Kind: chatproto.RejectOnce},
	}
	a, err := s.sink.Permission(ctx, chatadapter.PermissionRequest{Kind: chatproto.PermissionPlan, ToolCall: call, Options: opts, Parent: parent})
	switch {
	case ctx.Err() != nil:
		return nil, nil
	case err != nil:
		return deny(denyUnasked), nil
	}
	mode, ok := strings.CutPrefix(a.Option, chatadapter.OptionPlanPrefix)
	if a.Cancelled || !ok || (mode != chatproto.ModeDefault && mode != chatproto.ModeAcceptEdits) {
		return deny(denyPlan), nil
	}
	return allow(q.Input, nil), func(pr *proc) {
		ctx, cancel := context.WithTimeout(s.ctx, requestTimeout)
		defer cancel()
		if err := s.applyMode(ctx, pr, mode); err != nil {
			s.p.Logger.Printf("claude: the mode after the plan: %v", err)
		}
	}
}
