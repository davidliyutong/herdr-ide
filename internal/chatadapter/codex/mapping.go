package codex

import (
	"bytes"
	"encoding/json"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/chatproto"
)

// obj is an ACP value as the adapter builds it.
type obj = map[string]any

const (
	// maxTitle is the most bytes of a tool call's title.
	maxTitle = 1 << 10
	// maxSessionTitle is the most bytes of a session's title in a list.
	maxSessionTitle = 200
)

// cutText is s cut to at most n bytes at a character's start.
func cutText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// setMeta sets a member of m's own metadata: _meta.<slug>.key.
func setMeta(m obj, key string, v any) {
	meta, _ := m["_meta"].(obj)
	if meta == nil {
		meta = obj{}
		m["_meta"] = meta
	}
	own, _ := meta[brand.Slug].(obj)
	if own == nil {
		own = obj{}
		meta[brand.Slug] = own
	}
	own[key] = v
}

// raw is v's JSON, the characters of HTML not escaped.
func raw(v any) json.RawMessage {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if e.Encode(v) != nil {
		return json.RawMessage("null")
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

func textBlock(s string) obj { return obj{"type": "text", "text": s} }

// updateEvent is an EventUpdate of an item.
func updateEvent(itemID, parent string, live bool, u obj, at time.Time) chatproto.Event {
	return chatproto.Event{T: chatproto.EventUpdate, At: at, Item: itemID, Parent: parent, Live: live, Update: raw(u)}
}

// noticeEvent is a notice of the product's own (agentproto.NoticeMethod).
func noticeEvent(name, parent string, params obj, at time.Time) chatproto.Event {
	ev := chatproto.Event{T: chatproto.EventNotice, At: at, Parent: parent, Method: agentproto.NoticeMethod(name)}
	if len(params) > 0 {
		ev.Params = raw(params)
	}
	return ev
}

// chunk is a message's or a thought's text as an ACP chunk of the message
// id.
func chunk(kind, text, messageID string) obj {
	return obj{"sessionUpdate": kind, "content": textBlock(text), "messageId": messageID}
}

const (
	agentMessageChunk = "agent_message_chunk"
	agentThoughtChunk = "agent_thought_chunk"
)

// The statuses of an ACP tool call.
const (
	toolPending    = "pending"
	toolInProgress = "in_progress"
	toolCompleted  = "completed"
	toolFailed     = "failed"
	toolCancelled  = "cancelled"
)

// itemTime is when an item completed or started, else fallback.
func itemTime(it *item, fallback time.Time) time.Time {
	for _, ms := range []*int64{it.CompletedAtMs, it.StartedAtMs} {
		if ms != nil && *ms > 0 {
			return time.UnixMilli(*ms)
		}
	}
	return fallback
}

// mapper turns Codex's items into chatproto events. It keeps no state: the
// session adds what depends on the conversation so far (whose prompt a
// user message is, which subagent a thread is).
type mapper struct {
	// cwd is the session's directory: paths under it are shown relative
	// to it in titles.
	cwd string
}

// rel is p relative to the session's directory when it is under it.
func (m mapper) rel(p string) string {
	if m.cwd == "" || !path.IsAbs(p) {
		return p
	}
	if r, ok := strings.CutPrefix(p, strings.TrimSuffix(m.cwd, "/")+"/"); ok && r != "" {
		return r
	}
	return p
}

// itemEvents are the stored events of an item, started (completed false)
// or completed. Messages, thoughts and plans are stored once complete;
// tool calls when they start and when they complete. User messages,
// subagents' activity and items of other types are the session's (nil
// here); ok is false for a type the adapter does not map.
func (m mapper) itemEvents(it *item, completed bool, parent string, at time.Time) (evs []chatproto.Event, ok bool) {
	at = itemTime(it, at)
	one := func(u obj) []chatproto.Event { return []chatproto.Event{updateEvent(it.ID, parent, false, u, at)} }
	switch it.Type {
	case itemAgentMessage:
		if !completed {
			return nil, true
		}
		u := chunk(agentMessageChunk, it.Text, it.ID)
		if it.Phase != nil && *it.Phase != "" {
			setMeta(u, "phase", *it.Phase)
		}
		return one(u), true
	case itemPlan:
		if !completed {
			return nil, true
		}
		u := chunk(agentMessageChunk, it.Text, it.ID)
		setMeta(u, "plan", true)
		return one(u), true
	case itemReasoning:
		if !completed {
			return nil, true
		}
		return one(chunk(agentThoughtChunk, strings.Join(it.Summary, "\n\n"), it.ID)), true
	case itemCommand:
		return one(m.commandCall(it)), true
	case itemFileChange:
		return one(m.fileCall(it)), true
	case itemMCPToolCall:
		return one(m.mcpCall(it)), true
	case itemDynamicTool:
		u := toolCall(it.ID, it.Tool, "other", toolStatus(it.Status))
		if len(it.Arguments) > 0 && string(it.Arguments) != "null" {
			u["rawInput"] = it.Arguments
		}
		return one(u), true
	case itemCollabTool:
		return one(collabCall(it)), true
	case itemWebSearch:
		return one(webSearchCall(it, completed)), true
	case itemImageView:
		u := toolCall(it.ID, m.rel(it.Path), "read", toolInProgress)
		if completed {
			u["status"] = toolCompleted
		}
		if it.Path != "" {
			u["locations"] = []any{obj{"path": it.Path}}
		}
		return one(u), true
	case itemCompaction:
		if completed {
			return []chatproto.Event{noticeEvent(agentproto.NoticeCompacted, parent, nil, at)}, true
		}
		return []chatproto.Event{noticeEvent(agentproto.NoticeCompacting, parent, nil, at)}, true
	}
	return nil, false
}

func toolCall(id, title, kind, status string) obj {
	return obj{"sessionUpdate": "tool_call", "toolCallId": id, "title": cutText(title, maxTitle), "kind": kind, "status": status}
}

// toolStatus is an item's status as an ACP tool call's: inProgress,
// completed, failed, declined (refused by the user: failed, marked) and
// interrupted.
func toolStatus(s string) string {
	switch s {
	case "completed":
		return toolCompleted
	case "failed", "declined":
		return toolFailed
	case "interrupted":
		return toolCancelled
	}
	return toolInProgress
}

// commandCall is a commandExecution as an execute tool call: titled by the
// script its shell runs, its output (aggregatedOutput, the whole of it:
// the deltas miss the first chunk) as text content.
func (m mapper) commandCall(it *item) obj {
	script := shellScript(it.Command, it.CommandActions)
	status := toolStatus(it.Status)
	if status == toolCompleted && it.ExitCode != nil && *it.ExitCode != 0 {
		status = toolFailed
	}
	u := toolCall(it.ID, script, "execute", status)
	in := obj{"command": script}
	if it.Cwd != "" {
		in["cwd"] = it.Cwd
	}
	u["rawInput"] = in
	if it.AggregatedOutput != nil && *it.AggregatedOutput != "" {
		u["content"] = []any{obj{"type": "content", "content": textBlock(*it.AggregatedOutput)}}
	}
	if it.ExitCode != nil {
		setMeta(u, "exitCode", *it.ExitCode)
	}
	if it.Status == "declined" {
		setMeta(u, "declined", true)
	}
	return u
}

// fileCall is a fileChange as an edit tool call, a diff per file: an added
// file's diff is its whole content (an ACP v1 diff from nothing), a
// deleted one's its old content, an update's a hunk without headers (a v2
// diff whose patch gets the file's headers).
func (m mapper) fileCall(it *item) obj {
	u := toolCall(it.ID, "", "edit", toolStatus(it.Status))
	if it.Status == "declined" {
		setMeta(u, "declined", true)
	}
	content, locs, titles := fileDiffs(it.Changes, m)
	u["title"] = cutText(strings.Join(titles, ", "), maxTitle)
	if len(content) > 0 {
		u["content"] = content
		u["locations"] = locs
	}
	return u
}

func fileDiffs(changes []fileChange, m mapper) (content, locs []any, titles []string) {
	for _, c := range changes {
		p := c.Path
		switch c.Kind.Type {
		case "add":
			content = append(content, obj{"type": "diff", "path": p, "oldText": nil, "newText": c.Diff})
		case "delete":
			content = append(content, obj{"type": "diff", "path": p, "oldText": c.Diff, "newText": ""})
		default:
			change := obj{"operation": "modify", "path": p}
			to := p
			if c.Kind.MovePath != nil && *c.Kind.MovePath != "" {
				to = *c.Kind.MovePath
				change = obj{"operation": "move", "path": to, "oldPath": p}
			}
			d := obj{"type": "diff", "changes": []any{change}}
			if c.Diff != "" {
				d["patch"] = obj{"format": "unified", "text": "--- " + p + "\n+++ " + to + "\n" + c.Diff}
			}
			content = append(content, d)
			p = to
		}
		locs = append(locs, obj{"path": p})
		titles = append(titles, m.rel(p))
	}
	return content, locs, titles
}

func (m mapper) mcpCall(it *item) obj {
	title := it.Tool
	if it.Server != "" {
		title = it.Server + "/" + it.Tool
	}
	u := toolCall(it.ID, title, "other", toolStatus(it.Status))
	if len(it.Arguments) > 0 && string(it.Arguments) != "null" {
		u["rawInput"] = it.Arguments
	}
	var text []string
	if it.Result != nil {
		for _, b := range it.Result.Content {
			var blk struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if json.Unmarshal(b, &blk) == nil && blk.Type == "text" {
				text = append(text, blk.Text)
			}
		}
	}
	if it.Error != nil && it.Error.Message != "" {
		u["status"] = toolFailed
		text = append(text, it.Error.Message)
	}
	if len(text) > 0 {
		u["content"] = []any{obj{"type": "content", "content": textBlock(strings.Join(text, "\n"))}}
	}
	return u
}

// collabCall is a collaboration tool of the agent with its subagents:
// spawning one or giving it work is thinking (as Claude Code's Task is),
// waiting for one, closing one and the like are other.
func collabCall(it *item) obj {
	kind := "other"
	switch it.Tool {
	case "spawnAgent", "sendInput", "sendMessage", "followupTask", "resumeAgent":
		kind = "think"
	}
	u := toolCall(it.ID, it.Tool, kind, toolStatus(it.Status))
	in := obj{"tool": it.Tool}
	if len(it.ReceiverThreadIDs) > 0 {
		in["receiverThreadIds"] = it.ReceiverThreadIDs
	}
	if it.Prompt != nil && *it.Prompt != "" {
		in["prompt"] = *it.Prompt
		u["title"] = cutText(it.Tool+": "+*it.Prompt, maxTitle)
	}
	if it.Model != nil && *it.Model != "" {
		in["model"] = *it.Model
	}
	u["rawInput"] = in
	return u
}

// subAgentCall is the tool call of a subagent Codex started (a
// subAgentActivity of kind started): what its thread does belongs to it.
func subAgentCall(it *item, status string) obj {
	u := toolCall(it.ID, it.AgentPath, "think", status)
	in := obj{"agentPath": it.AgentPath}
	if it.Model != nil && *it.Model != "" {
		in["model"] = *it.Model
	}
	if it.ReasoningEffort != nil && *it.ReasoningEffort != "" {
		in["reasoningEffort"] = *it.ReasoningEffort
	}
	u["rawInput"] = in
	return u
}

func webSearchCall(it *item, completed bool) obj {
	q := it.Query
	in := obj{}
	if a := it.Action; a != nil {
		switch {
		case q == "" && a.Query != nil:
			q = *a.Query
		case q == "" && a.URL != nil:
			q = *a.URL
		}
		if a.URL != nil {
			in["url"] = *a.URL
		}
	}
	status := toolInProgress
	if completed {
		status = toolCompleted
	}
	u := toolCall(it.ID, q, "fetch", status)
	if q != "" {
		in["query"] = q
	}
	if len(in) > 0 {
		u["rawInput"] = in
	}
	return u
}

// cancelledCall is the stored state of a tool call that will not complete:
// its last state with the status cancelled.
func cancelledCall(last obj) obj {
	u := obj{}
	for k, v := range last {
		u[k] = v
	}
	u["sessionUpdate"] = "tool_call"
	u["status"] = toolCancelled
	return u
}

var shells = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "fish": true}

// shellScript is what a command runs: the script of a shell's -c (Codex
// runs every command as `/bin/zsh -lc '<script>'`), else the command, else
// its parsed actions.
func shellScript(command string, actions []commandAction) string {
	if command == "" {
		var parts []string
		for _, a := range actions {
			if a.Command != "" {
				parts = append(parts, a.Command)
			}
		}
		return strings.Join(parts, "; ")
	}
	sh, rest, ok := strings.Cut(command, " ")
	if !ok || !shells[path.Base(sh)] {
		return command
	}
	flag, script, ok := strings.Cut(rest, " ")
	if !ok || !strings.HasPrefix(flag, "-") || !strings.Contains(flag, "c") {
		return command
	}
	if s, ok := unquote(script); ok {
		return s
	}
	return command
}

// unquote is a shell word in single or double quotes, or a plain one,
// without them; false when s is more than one word.
func unquote(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return "", false
			}
			b.WriteString(s[i+1 : i+1+j])
			i += j + 2
		case '"':
			i++
			for ; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("$`\"\\\n", s[i+1]) >= 0 {
					i++
				}
				b.WriteByte(s[i])
			}
			if i >= len(s) {
				return "", false
			}
			i++
		case '\\':
			if i+1 >= len(s) {
				return "", false
			}
			b.WriteByte(s[i+1])
			i += 2
		case ' ', '\t', '\n':
			return "", false
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), true
}

// ---- prompts ----

// toUserInput is a prompt's ACP content blocks as Codex's input: text as
// text, an image as a data URL (never a local file: the item would keep
// only its path), a file named with @ (resource_link) as a mention, an
// embedded resource's text as text. Other blocks are refused.
func toUserInput(blocks []json.RawMessage) ([]userInput, error) {
	var in []userInput
	for _, b := range blocks {
		var blk struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Data     string `json:"data"`
			MimeType string `json:"mimeType"`
			URI      string `json:"uri"`
			Name     string `json:"name"`
			Resource *struct {
				URI  string  `json:"uri"`
				Text *string `json:"text"`
			} `json:"resource"`
		}
		if err := json.Unmarshal(b, &blk); err != nil {
			return nil, &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "codex: a content block that is no JSON object"}
		}
		switch blk.Type {
		case "text":
			in = append(in, userInput{Type: "text", Text: blk.Text, TextElements: []string{}})
		case "image":
			if !strings.HasPrefix(blk.MimeType, "image/") || blk.Data == "" {
				return nil, &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "codex: an image without data or an image type"}
			}
			in = append(in, userInput{Type: "image", URL: "data:" + blk.MimeType + ";base64," + blk.Data})
		case "resource_link":
			if p, ok := filePath(blk.URI); ok {
				name := blk.Name
				if name == "" {
					name = path.Base(p)
				}
				in = append(in, userInput{Type: "mention", Name: name, Path: p})
			} else {
				in = append(in, userInput{Type: "text", Text: blk.URI, TextElements: []string{}})
			}
		case "resource":
			if blk.Resource == nil || blk.Resource.Text == nil {
				return nil, &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "codex: an embedded resource without text"}
			}
			in = append(in, userInput{Type: "text", Text: *blk.Resource.Text, TextElements: []string{}})
		default:
			return nil, &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "codex: content of type " + cutText(blk.Type, 64)}
		}
	}
	if len(in) == 0 {
		return nil, &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "codex: an empty prompt"}
	}
	return in, nil
}

// filePath is the absolute path of a file: URI.
func filePath(uri string) (string, bool) {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" || (u.Host != "" && u.Host != "localhost") || !path.IsAbs(u.Path) {
		return "", false
	}
	return u.Path, true
}

// userContent is a userMessage's input as ACP content blocks: an image
// given as a data URL as an image, a local image, a mention and a skill as
// links to their files.
func userContent(content json.RawMessage) []json.RawMessage {
	var in []userInput
	if json.Unmarshal(content, &in) != nil {
		return nil
	}
	var out []json.RawMessage
	for _, i := range in {
		switch i.Type {
		case "text":
			out = append(out, raw(textBlock(i.Text)))
		case "image":
			if mime, data, ok := dataURL(i.URL); ok {
				out = append(out, raw(obj{"type": "image", "mimeType": mime, "data": data}))
			} else if i.URL != "" {
				out = append(out, raw(obj{"type": "resource_link", "uri": i.URL, "name": path.Base(i.URL)}))
			}
		case "localImage", "mention", "skill", "localAudio":
			if i.Path != "" {
				name := i.Name
				if name == "" {
					name = path.Base(i.Path)
				}
				out = append(out, raw(obj{"type": "resource_link", "uri": (&url.URL{Scheme: "file", Path: i.Path}).String(), "name": name}))
			}
		}
	}
	return out
}

// dataURL is the type and the base64 data of a data: URL of base64 data.
func dataURL(s string) (mime, data string, ok bool) {
	rest, ok := strings.CutPrefix(s, "data:")
	if !ok {
		return "", "", false
	}
	head, data, ok := strings.Cut(rest, ",")
	if !ok {
		return "", "", false
	}
	mime, ok = strings.CutSuffix(head, ";base64")
	if !ok || mime == "" || data == "" {
		return "", "", false
	}
	return mime, data, true
}

// turnErrorOf is a failed turn's error: a Codex error that tells of a
// missing or refused sign-in is CodeAuthRequired.
func turnErrorOf(e *turnError) *chatproto.Error {
	if e == nil {
		return &chatproto.Error{Code: chatproto.CodeFailed, Message: "the turn failed"}
	}
	code := chatproto.CodeFailed
	var info any
	if json.Unmarshal(e.CodexErrorInfo, &info) == nil && unauthorized(info) {
		code = chatproto.CodeAuthRequired
	}
	return &chatproto.Error{Code: code, Message: e.Message}
}

// unauthorized tells a codexErrorInfo of a refused sign-in: "unauthorized",
// or a variant whose httpStatusCode is 401.
func unauthorized(v any) bool {
	switch x := v.(type) {
	case string:
		return x == "unauthorized"
	case map[string]any:
		if code, ok := x["httpStatusCode"].(float64); ok && code == 401 {
			return true
		}
		for _, e := range x {
			if unauthorized(e) {
				return true
			}
		}
	}
	return false
}
