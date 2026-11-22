//go:build unix

package transcript

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"

	"herdr-ide/internal/agentproto"
)

// Claude Code's transcripts: <claude dir>/projects/<dir>/<session>.jsonl,
// a line per message (an assistant's message a line per content block,
// the lines of one response sharing message.id and its usage) and lines of
// the program's own state. Each line maps on its own; the usage of a
// response is reported once a page (by message.id).

type claudeFormat struct{}

// A Claude transcript needs nothing of the lines before a run.
func (claudeFormat) run(io.ReaderAt, int64) run { return claudeRun{} }

type claudeRun struct{}

func (claudeRun) prepare([]rawLine) {}

// claudeLine is what a line of a Claude transcript gives that is read.
type claudeLine struct {
	Type        string `json:"type"`
	Subtype     string `json:"subtype"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	// The summary a compaction left as the user's message, shown by the
	// compaction's notice instead.
	IsCompactSummary          bool            `json:"isCompactSummary"`
	IsVisibleInTranscriptOnly bool            `json:"isVisibleInTranscriptOnly"`
	IsAPIErrorMessage         bool            `json:"isApiErrorMessage"`
	Message                   *claudeMessage  `json:"message"`
	ToolUseResult             json.RawMessage `json:"toolUseResult"`
	// Content is a system line's (local_command).
	Content         json.RawMessage `json:"content"`
	CompactMetadata *struct {
		Trigger   string `json:"trigger"`
		PreTokens int64  `json:"preTokens"`
	} `json:"compactMetadata"`
}

type claudeMessage struct {
	ID      string          `json:"id"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *struct {
		Input         int64 `json:"input_tokens"`
		CacheRead     int64 `json:"cache_read_input_tokens"`
		CacheCreation int64 `json:"cache_creation_input_tokens"`
	} `json:"usage"`
}

// claudeBlock is a content block of a message.
type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (claudeRun) parse(l *rawLine, o *lineOut) {
	typ := memberString(l.b, "type")
	switch typ {
	case "user", "assistant", "system":
	case "ai-title", "summary", "custom-title":
		var d struct {
			AITitle     string `json:"aiTitle"`
			Summary     string `json:"summary"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal(l.b, &d) == nil {
			o.title = strings.TrimSpace(d.AITitle + d.Summary + d.CustomTitle)
			o.custom = typ == "custom-title"
		}
		return
	case "attachment":
		claudeAttachment(l, o)
		return
	case "":
		// No object with a type: a line that could not be read.
		if _, ok := member(l.b, "type"); !ok {
			o.unknown++
		}
		return
	default:
		// The program's own state (mode, api-request, queue-operation,
		// file-history-snapshot, last-prompt, cost-state, …), and kinds of
		// lines newer versions add: no conversation.
		return
	}
	var d claudeLine
	if json.Unmarshal(l.b, &d) != nil {
		o.unknown++
		return
	}
	if d.IsSidechain {
		// A subagent's: its own transcript, not shown here.
		return
	}
	o.setTime(d.Timestamp)
	switch typ {
	case "user":
		claudeUser(&d, o)
	case "assistant":
		claudeAssistant(&d, o)
	case "system":
		claudeSystem(&d, o)
	}
}

// claudeSystem: a turn's end, a compaction, a local command; the other
// subtypes (hook summaries, retries of API errors, …) are no conversation.
func claudeSystem(d *claudeLine, o *lineOut) {
	switch d.Subtype {
	case "turn_duration":
		o.turn(agentproto.TurnEnd, "")
	case "compact_boundary":
		var params obj
		if m := d.CompactMetadata; m != nil {
			params = obj{}
			if m.Trigger != "" {
				params["trigger"] = m.Trigger
			}
			if m.PreTokens > 0 {
				params["preTokens"] = m.PreTokens
			}
		}
		o.notice(agentproto.NoticeCompacted, params)
	case "local_command":
		var s string
		if json.Unmarshal(d.Content, &s) == nil {
			commandNotice(s, o)
		}
	}
}

// interrupted is how Claude Code records that the user stopped a turn.
const interrupted = "[Request interrupted by user"

func claudeUser(d *claudeLine, o *lineOut) {
	if d.IsMeta || d.IsCompactSummary || d.IsVisibleInTranscriptOnly {
		return
	}
	if d.Message == nil {
		o.unknown++
		return
	}
	c := bytes.TrimSpace(d.Message.Content)
	if len(c) > 0 && c[0] == '"' {
		var s string
		if json.Unmarshal(c, &s) != nil {
			o.unknown++
			return
		}
		claudePromptText(s, true, o)
		return
	}
	if string(c) == "null" {
		return
	}
	// The blocks are read one at a time, the line's being valid JSON: a
	// line of many blocks takes no more than the events it may make.
	results := 0
	if _, ok := elements(c, maxBlocks, func(raw []byte) bool {
		if memberString(raw, "type") == "tool_result" {
			results++
		}
		return results < 2
	}); !ok {
		o.unknown++
		return
	}
	var prompt []any
	stopped := false
	more, _ := elements(c, maxBlocks, func(raw []byte) bool {
		var b claudeBlock
		if json.Unmarshal(raw, &b) != nil {
			o.unknown++
			return true
		}
		switch b.Type {
		case "tool_result":
			var res json.RawMessage
			if results == 1 {
				res = d.ToolUseResult
			}
			claudeToolResult(&b, res, o)
		case "text":
			if strings.HasPrefix(b.Text, interrupted) {
				stopped = true
				break
			}
			prompt = append(prompt, o.textBlock(b.Text))
		case "image":
			prompt = append(prompt, imageBlock())
		default:
			o.unknown++
		}
		return !o.over
	})
	o.over = o.over || more
	if len(prompt) > 0 {
		o.turn(agentproto.TurnStart, "")
		o.user(prompt)
	}
	if stopped {
		o.turn(agentproto.TurnEnd, "cancelled")
	}
}

// claudePromptText makes the events of a prompt the user wrote as a string:
// the notice of a slash command or a local command's output, the end of a
// turn the user stopped, or the user's message, which begins a turn when
// begins is set.
func claudePromptText(s string, begins bool, o *lineOut) {
	if commandNotice(s, o) {
		return
	}
	if strings.HasPrefix(s, interrupted) {
		o.turn(agentproto.TurnEnd, "cancelled")
		return
	}
	if strings.TrimSpace(s) == "" {
		return
	}
	if begins {
		o.turn(agentproto.TurnStart, "")
	}
	o.user([]any{o.textBlock(s)})
}

// queuedCommand is in every attachment line that may hold a message of the
// user's; the other attachments (the environment, skill listings, prompt
// snapshots, up to 140 KB a line) are passed over without a decode.
var queuedCommand = []byte(`"queued_command"`)

// claudeAttachment reads an attachment line, the program's own state but
// for one kind: a message the user sent while the agent was working.
// Claude Code records such a message, once the running turn takes it up,
// as a queued_command attachment of commandMode "prompt" whose origin is
// the human (other origins are other agents' messages and the program's
// task notifications), and writes no user line for it; a message still
// queued when the turn ends becomes the next turn's user line instead,
// with no attachment. So the attachment gives the user's message, and no
// turn's start: the turn it joins is running.
func claudeAttachment(l *rawLine, o *lineOut) {
	if !bytes.Contains(l.b, queuedCommand) {
		return
	}
	m := pick(l.b, "attachment", "isSidechain", "isMeta", "timestamp")
	var a struct {
		Type        string `json:"type"`
		CommandMode string `json:"commandMode"`
		IsMeta      bool   `json:"isMeta"`
		Origin      *struct {
			Kind string `json:"kind"`
		} `json:"origin"`
		Prompt json.RawMessage `json:"prompt"`
	}
	if json.Unmarshal(m["attachment"], &a) != nil || a.Type != "queued_command" || a.CommandMode != "prompt" || a.Origin == nil || a.Origin.Kind != "human" || a.IsMeta {
		return
	}
	var sidechain, meta bool
	var at string
	_ = json.Unmarshal(m["isSidechain"], &sidechain)
	_ = json.Unmarshal(m["isMeta"], &meta)
	_ = json.Unmarshal(m["timestamp"], &at)
	if sidechain || meta {
		// A subagent's, or a message of the program's own.
		return
	}
	o.setTime(at)
	c := bytes.TrimSpace(a.Prompt)
	if len(c) > 0 && c[0] == '"' {
		var s string
		if json.Unmarshal(c, &s) != nil {
			o.unknown++
			return
		}
		claudePromptText(s, false, o)
		return
	}
	// A message with pasted images: text and image blocks, read one at a
	// time.
	var prompt []any
	more, ok := elements(c, maxBlocks, func(raw []byte) bool {
		var b claudeBlock
		if json.Unmarshal(raw, &b) != nil {
			o.unknown++
			return true
		}
		switch b.Type {
		case "text":
			prompt = append(prompt, o.textBlock(b.Text))
		case "image":
			prompt = append(prompt, imageBlock())
		default:
			o.unknown++
		}
		return true
	})
	if !ok {
		o.unknown++
		return
	}
	o.over = o.over || more
	o.user(prompt)
}

// tagged is the text between <tag> and </tag> in s; false when s has no
// such tag.
func tagged(s, tag string) (string, bool) {
	i := strings.Index(s, "<"+tag+">")
	if i < 0 {
		return "", false
	}
	s = s[i+len(tag)+2:]
	if j := strings.Index(s, "</"+tag+">"); j >= 0 {
		s = s[:j]
	}
	return s, true
}

// commandNotice makes the notice of a slash command the user ran, or of a
// local command's output, from the text Claude Code records for it; false
// when the text is no such record.
func commandNotice(s string, o *lineOut) bool {
	t := strings.TrimSpace(s)
	if !strings.HasPrefix(t, "<command-") && !strings.HasPrefix(t, "<local-command-") && !strings.HasPrefix(t, "<bash-") {
		return false
	}
	params := obj{}
	if name, ok := tagged(t, "command-name"); ok {
		params["name"] = strings.TrimSpace(name)
		if args, _ := tagged(t, "command-args"); strings.TrimSpace(args) != "" {
			params["args"], _ = o.text(strings.TrimSpace(args))
		}
	}
	if cmd, ok := tagged(t, "bash-input"); ok {
		params["name"] = "!"
		params["args"], _ = o.text(cmd)
	}
	var out []string
	for _, tag := range []string{"local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr"} {
		if s, ok := tagged(t, tag); ok && strings.TrimSpace(s) != "" {
			out = append(out, plain(s))
		}
	}
	if len(out) > 0 {
		s, cut := o.text(strings.Join(out, "\n"))
		params["output"] = s
		if cut {
			setMeta(params, "truncated", true)
		}
	}
	if len(params) == 0 {
		// A caveat or another record of the program's own: nothing to show.
		return true
	}
	o.notice(agentproto.NoticeCommand, params)
	return true
}

func claudeAssistant(d *claudeLine, o *lineOut) {
	m := d.Message
	if m == nil {
		o.unknown++
		return
	}
	var blocks []claudeBlock
	more := false
	c := bytes.TrimSpace(m.Content)
	if len(c) > 0 && c[0] == '"' {
		var s string
		if json.Unmarshal(c, &s) != nil {
			o.unknown++
			return
		}
		blocks = []claudeBlock{{Type: "text", Text: s}}
	} else if string(c) != "null" {
		// At most maxBlocks of them, one at a time; a block that is no
		// block makes the line one not read, as a decode of all would.
		failed, ok := false, false
		more, ok = elements(c, maxBlocks, func(raw []byte) bool {
			var b claudeBlock
			if json.Unmarshal(raw, &b) != nil {
				failed = true
				return false
			}
			blocks = append(blocks, b)
			return true
		})
		if !ok || failed {
			o.unknown++
			return
		}
	}
	// Blocks beyond maxBlocks: more events than a line may make.
	defer func() { o.over = o.over || more }()
	if d.IsAPIErrorMessage || m.Model == "<synthetic>" {
		var text []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				text = append(text, b.Text)
			}
		}
		s, _ := o.text(strings.Join(text, "\n"))
		o.notice(agentproto.NoticeError, obj{"text": s})
		return
	}
	for i := range blocks {
		if claudeBlockEvents(m, &blocks[i], o); o.over {
			return
		}
	}
	if u := m.Usage; u != nil {
		if used := u.Input + u.CacheRead + u.CacheCreation; used > 0 {
			// The model's context window is not in the transcript: the
			// update gives no size.
			o.add(pev{t: agentproto.TranscriptUpdate, update: obj{"sessionUpdate": "usage_update", "used": used}, usage: m.ID})
		}
	}
}

// chunk is the update of a message's or a thought's text.
func (o *lineOut) chunk(kind, text, messageID string) obj {
	s, cut := o.text(text)
	u := obj{"sessionUpdate": kind, "content": obj{"type": "text", "text": s}}
	if messageID != "" {
		u["messageId"] = messageID
	}
	if cut {
		setMeta(u, "truncated", true)
	}
	return u
}

func claudeBlockEvents(m *claudeMessage, b *claudeBlock, o *lineOut) {
	switch b.Type {
	case "text":
		u := o.chunk("agent_message_chunk", b.Text, m.ID)
		if m.Model != "" {
			setMeta(u, "model", m.Model)
		}
		o.update(u)
	case "thinking":
		// Claude Code keeps the thinking's text hidden (empty): the view
		// shows that the agent thought.
		o.update(o.chunk("agent_thought_chunk", b.Thinking, m.ID))
	case "redacted_thinking":
		o.update(o.chunk("agent_thought_chunk", "", m.ID))
	case "image":
		u := obj{"sessionUpdate": "agent_message_chunk", "content": imageBlock()}
		if m.ID != "" {
			u["messageId"] = m.ID
		}
		o.update(u)
	case "tool_use", "server_tool_use":
		claudeToolUse(b, o)
	case "web_search_tool_result", "web_fetch_tool_result":
		if b.ToolUseID != "" {
			o.update(obj{"sessionUpdate": "tool_call_update", "toolCallId": b.ToolUseID, "status": "completed"})
		}
	default:
		o.unknown++
	}
}

// claudeToolKinds are the ACP kinds of Claude Code's tools; any other
// tool (an MCP server's mcp__*) is "other".
var claudeToolKinds = map[string]string{
	"Edit": "edit", "MultiEdit": "edit", "Write": "edit", "NotebookEdit": "edit",
	"Bash": "execute", "BashOutput": "execute", "KillShell": "execute", "KillBash": "execute",
	"Read": "read", "NotebookRead": "read",
	"Grep": "search", "Glob": "search", "LS": "search",
	"WebFetch": "fetch", "WebSearch": "fetch", "web_search": "fetch", "web_fetch": "fetch",
	"Task": "think", "Agent": "think",
	"ExitPlanMode": "switch_mode",
}

// claudeTitle is a tool call's title: what it acts on, as its input says;
// else the tool's name.
func claudeTitle(name string, in obj) string {
	var keys []string
	switch name {
	case "Bash":
		keys = []string{"description", "command"}
	case "Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "NotebookRead":
		keys = []string{"file_path", "notebook_path"}
	case "Grep", "Glob":
		keys = []string{"pattern"}
	case "LS":
		keys = []string{"path"}
	case "WebFetch", "web_fetch":
		keys = []string{"url"}
	case "WebSearch", "web_search":
		keys = []string{"query"}
	case "Task", "Agent":
		keys = []string{"description"}
	}
	for _, k := range keys {
		if s := strings.TrimSpace(str(in[k])); s != "" {
			s, _ = cutText(s, maxTitle)
			return s
		}
	}
	return name
}

func claudeToolUse(b *claudeBlock, o *lineOut) {
	v, ok := o.decode(b.Input)
	in := asObj(v)
	if b.Name == "TodoWrite" {
		if entries := planEntries(asArr(in["todos"]), "content", o); entries != nil {
			o.update(obj{"sessionUpdate": "plan", "entries": entries})
		}
		return
	}
	if b.ID == "" {
		o.unknown++
		return
	}
	kind := claudeToolKinds[b.Name]
	if kind == "" {
		kind = "other"
	}
	u := obj{"sessionUpdate": "tool_call", "toolCallId": b.ID, "title": claudeTitle(b.Name, in), "kind": kind, "status": "pending"}
	if ok && present(b.Input) {
		u["rawInput"] = o.bounded(u, v)
	}
	if kind == "edit" || kind == "read" {
		if p := str(first(in, "file_path", "notebook_path")); p != "" {
			loc := obj{"path": p}
			if line, ok := num(in["offset"]); ok && line > 0 {
				loc["line"] = int64(line)
			}
			u["locations"] = []any{loc}
		}
	}
	o.update(u)
}

// planEntries are the entries of a plan from a list of items whose text is
// in key; nil for no list.
func planEntries(items []any, key string, o *lineOut) []any {
	if items == nil {
		return nil
	}
	entries := []any{}
	for _, it := range items[:min(len(items), maxItems)] {
		m := asObj(it)
		if m == nil {
			continue
		}
		status := str(m["status"])
		switch status {
		case "pending", "in_progress", "completed":
		default:
			status = "pending"
		}
		if done, ok := m["completed"].(bool); ok && done {
			status = "completed"
		}
		priority := str(m["priority"])
		switch priority {
		case "high", "medium", "low":
		default:
			priority = "medium"
		}
		text, _ := o.text(str(m[key]))
		entries = append(entries, obj{"content": text, "status": status, "priority": priority})
	}
	return entries
}

// resultText is the text of a tool result's content (a string or blocks)
// and how many images it holds.
func resultText(raw json.RawMessage) (string, int) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", 0
	}
	if raw[0] == '"' {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s, 0
	}
	// One block at a time, at most maxBlocks; any that is no block makes
	// no text, as a decode of all would.
	var text strings.Builder
	images, texts := 0, 0
	failed := false
	_, ok := elements(raw, maxBlocks, func(v []byte) bool {
		var b claudeBlock
		if json.Unmarshal(v, &b) != nil {
			failed = true
			return false
		}
		switch b.Type {
		case "text":
			if texts > 0 {
				text.WriteByte('\n')
			}
			text.WriteString(b.Text)
			texts++
		case "image":
			images++
		}
		return true
	})
	if !ok || failed {
		return "", 0
	}
	return text.String(), images
}

// toolError is an error result's text without Claude Code's tags.
func toolError(s string) string {
	if t, ok := tagged(s, "tool_use_error"); ok {
		return t
	}
	return s
}

// claudeToolResult makes the update of a tool call from its result; res is
// the line's toolUseResult when the line has this result only, which tells
// the tool by its shape.
func claudeToolResult(b *claudeBlock, res json.RawMessage, o *lineOut) {
	status := "completed"
	if b.IsError {
		status = "failed"
	}
	u := obj{"sessionUpdate": "tool_call_update", "toolCallId": b.ToolUseID, "status": status}
	text, images := resultText(b.Content)
	if b.IsError {
		text = toolError(text)
		if code, ok := exitCode(text); ok {
			// A command that failed, as Claude Code words it.
			setMeta(u, "exitCode", code)
		}
	}
	// The members that tell the tool, without decoding the others.
	r := pick(bytes.TrimSpace(res), "newTodos", "oldString", "newString", "edits", "file", "stdout", "stderr", "filePath", "content", "originalFile")
	var content []any
	field := func(k string) (string, bool) {
		var s string
		v, ok := r[k]
		return s, ok && present(v) && json.Unmarshal(v, &s) == nil
	}
	_, isRead := r["file"]
	_, hasStdout := r["stdout"]
	_, hasStderr := r["stderr"]
	switch {
	case r == nil:
	case r["newTodos"] != nil:
		// TodoWrite's: its plan was the update.
		return
	case r["oldString"] != nil || r["newString"] != nil:
		path, _ := field("filePath")
		oldText, _ := field("oldString")
		newText, _ := field("newString")
		content = []any{o.diff(u, path, oldText, newText, true)}
	case r["edits"] != nil:
		path, _ := field("filePath")
		elements(r["edits"], maxItems, func(v []byte) bool {
			var e struct {
				Old string `json:"old_string"`
				New string `json:"new_string"`
			}
			_ = json.Unmarshal(v, &e)
			content = append(content, o.diff(u, path, e.Old, e.New, true))
			return true
		})
	case isRead:
		var f struct {
			Type string `json:"type"`
			File struct {
				FilePath  string `json:"filePath"`
				NumLines  int64  `json:"numLines"`
				StartLine int64  `json:"startLine"`
			} `json:"file"`
		}
		_ = json.Unmarshal(res, &f)
		if f.Type == "image" {
			content = []any{obj{"type": "content", "content": imageBlock()}}
		}
		if f.File.FilePath != "" {
			loc := obj{"path": f.File.FilePath}
			if f.File.StartLine > 0 {
				loc["line"] = f.File.StartLine
			}
			u["locations"] = []any{loc}
		}
		if f.File.NumLines > 0 {
			setMeta(u, "lines", f.File.NumLines)
		}
		// The file's text is not repeated.
		text, images = "", 0
	case hasStdout || hasStderr:
		var sh struct {
			Stdout      string `json:"stdout"`
			Stderr      string `json:"stderr"`
			Interrupted bool   `json:"interrupted"`
			IsImage     bool   `json:"isImage"`
			// A background shell's (BashOutput).
			ExitCode *int `json:"exitCode"`
		}
		_ = json.Unmarshal(res, &sh)
		if sh.ExitCode != nil {
			setMeta(u, "exitCode", *sh.ExitCode)
		}
		if sh.Interrupted {
			setMeta(u, "interrupted", true)
		}
		if sh.IsImage {
			text, images = "", 1
		} else {
			text = strings.TrimRight(sh.Stdout, "\n")
			if e := strings.TrimRight(sh.Stderr, "\n"); e != "" {
				if text != "" {
					text += "\n"
				}
				text += e
			}
		}
	default:
		path, okPath := field("filePath")
		newText, okNew := field("content")
		if okPath && okNew {
			// Write's: a new file, or a file written over.
			var oldText *string
			if s, ok := field("originalFile"); ok {
				oldText = &s
			}
			d := o.diff(u, path, "", newText, false)
			if oldText != nil {
				d["oldText"], _ = cutText(*oldText, o.lim.text)
			}
			content = []any{d}
		}
	}
	if content == nil {
		content = o.output(u, plain(text))
		for range min(images, maxItems) {
			content = append(content, obj{"type": "content", "content": imageBlock()})
		}
	}
	if content != nil {
		u["content"] = content
	}
	o.update(u)
}

// diff is an ACP v1 diff of a file; without hasOld the old text is null (a
// new file). Texts are cut to the limit (marked in u's _meta).
func (o *lineOut) diff(u obj, path, oldText, newText string, hasOld bool) obj {
	n, cutNew := o.text(newText)
	d := obj{"type": "diff", "path": path, "newText": n, "oldText": nil}
	cutOld := false
	if hasOld {
		d["oldText"], cutOld = o.text(oldText)
	}
	if cutNew || cutOld {
		setMeta(u, "truncated", true)
	}
	return d
}
