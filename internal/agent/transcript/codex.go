//go:build unix

package transcript

import (
	"encoding/json"
	"io"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"herdr-ide/internal/agentproto"
)

// Codex's rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
// lines {timestamp, type, payload}. Newer versions record each item of a
// turn once it completed (event_msg item_completed) and the same content
// again in the model's wire form (response_item); older ones have no items
// and are read from response_item and their own event_msg forms. Which
// form a line belongs to goes by the nearest line before it that tells
// (codexEvidence): within the page read, else within a bounded look back
// from the page's start, else the first such line after it in the page.

type codexFormat struct{}

// The forms of a rollout.
const (
	formUnknown = iota
	formOld
	formNew
)

const (
	// codexBack and codexBackLines bound the look back for a run's state.
	codexBack      = 1 << 20
	codexBackLines = 2000
)

// codexRun is the state of a run of a rollout's lines.
type codexRun struct {
	// form is the form the latest telling line gave; fallback the first
	// one a run's chunk has, for the lines before any.
	form, fallback int
	// model is the latest turn's model, "" when unknown.
	model string
}

func (codexFormat) run(r io.ReaderAt, off int64) run {
	c := &codexRun{}
	// Not below what the bounds let it reach with lines of up to maxLine:
	// a longer line ends the look back, as it would by its length.
	br := newBackReader(r, off, max(off-codexBack-maxLine-1, 0))
	// The lines it looks for are mostly near: small reads first.
	br.block = 4 << 10
	var n int64
	for i := 0; i < codexBackLines && n < codexBack && (c.form == formUnknown || c.model == ""); i++ {
		l, ok := br.prev()
		if !ok {
			break
		}
		n += l.n
		if l.long || len(l.b) == 0 {
			continue
		}
		if c.form == formUnknown {
			c.form = codexEvidence(l.b)
		}
		if c.model == "" && memberString(l.b, "type") == "turn_context" {
			c.model = turnModel(l.b)
		}
	}
	return c
}

func (c *codexRun) prepare(lines []rawLine) {
	if c.form != formUnknown {
		return
	}
	for i := range lines {
		if f := codexEvidence(lines[i].b); f != formUnknown {
			c.fallback = f
			return
		}
	}
}

// current is the form of the line being parsed; the older one when nothing
// tells.
func (c *codexRun) current() int {
	switch {
	case c.form != formUnknown:
		return c.form
	case c.fallback != formUnknown:
		return c.fallback
	}
	return formOld
}

// codexEvidence is the form a line tells: an item, or a turn started with
// the newer attribution, is the newer form's; the older event_msg forms of
// messages are the older one's.
func codexEvidence(b []byte) int {
	if memberString(b, "type") != "event_msg" {
		return formUnknown
	}
	p, _ := member(b, "payload")
	switch memberString(p, "type") {
	case "item_completed":
		return formNew
	case "task_started":
		if v, ok := member(p, "turn_attribution"); ok && present(v) {
			return formNew
		}
	case "user_message", "agent_message", "agent_reasoning", "agent_reasoning_raw_content":
		return formOld
	}
	return formUnknown
}

func turnModel(b []byte) string {
	p, _ := member(b, "payload")
	return memberString(p, "model")
}

func (c *codexRun) parse(l *rawLine, o *lineOut) {
	typ := memberString(l.b, "type")
	switch typ {
	case "event_msg", "turn_context", "compacted":
	case "response_item":
		if c.current() == formNew {
			// The items' content again.
			return
		}
	case "":
		if _, ok := member(l.b, "type"); !ok {
			o.unknown++
		}
		return
	default:
		// session_meta, world_state, token_usage_record, …
		return
	}
	p, ok := member(l.b, "payload")
	if !ok && typ != "compacted" {
		o.unknown++
		return
	}
	o.setTime(memberString(l.b, "timestamp"))
	switch typ {
	case "compacted":
		o.notice(agentproto.NoticeCompacted, nil)
	case "turn_context":
		if m := memberString(p, "model"); m != "" {
			if c.model != "" && m != c.model {
				o.notice(agentproto.NoticeModel, obj{"model": m})
			}
			c.model = m
		}
	case "event_msg":
		c.event(p, o)
	case "response_item":
		v, ok := o.decode(p)
		it := asObj(v)
		if !ok || it == nil {
			o.unknown++
			return
		}
		codexResponse(it, l.off, o)
	}
}

func (c *codexRun) event(p []byte, o *lineOut) {
	switch memberString(p, "type") {
	case "task_started":
		if v, ok := member(p, "turn_attribution"); ok && present(v) {
			c.form = formNew
		}
		o.turn(agentproto.TurnStart, "")
	case "task_complete":
		o.turn(agentproto.TurnEnd, "")
	case "turn_aborted":
		o.turn(agentproto.TurnEnd, "cancelled")
	case "token_count":
		var t struct {
			Info *struct {
				Last *struct {
					// Codex's input tokens include the cached ones.
					Input int64 `json:"input_tokens"`
				} `json:"last_token_usage"`
				Window int64 `json:"model_context_window"`
			} `json:"info"`
		}
		if json.Unmarshal(p, &t) != nil || t.Info == nil || t.Info.Last == nil {
			return
		}
		u := obj{"sessionUpdate": "usage_update", "used": t.Info.Last.Input}
		if t.Info.Window > 0 {
			u["size"] = t.Info.Window
		}
		o.update(u)
	case "item_completed":
		c.form = formNew
		item, _ := member(p, "item")
		v, ok := o.decode(item)
		it := asObj(v)
		if !ok || it == nil {
			o.unknown++
			return
		}
		codexItem(it, o)
	case "user_message":
		c.form = formOld
		// The images are counted, not decoded.
		var m struct {
			Message     string          `json:"message"`
			Kind        string          `json:"kind"`
			Images      json.RawMessage `json:"images"`
			LocalImages json.RawMessage `json:"local_images"`
		}
		err := json.Unmarshal(p, &m)
		images, ok1 := countStrings(m.Images)
		local, ok2 := countStrings(m.LocalImages)
		if err != nil || !ok1 || !ok2 {
			o.unknown++
			return
		}
		if m.Kind != "" && m.Kind != "plain" || injected(m.Message) {
			return
		}
		var blocks []any
		if m.Message != "" {
			blocks = append(blocks, o.textBlock(m.Message))
		}
		for range min(images+local, maxItems) {
			blocks = append(blocks, imageBlock())
		}
		if len(blocks) > 0 {
			o.turn(agentproto.TurnStart, "")
			o.user(blocks)
		}
	case "agent_message", "agent_reasoning", "agent_reasoning_raw_content":
		// The response_item lines have the same.
		c.form = formOld
	}
}

// countStrings is the length of a JSON array of strings (or nulls), as
// encoding/json decodes it into a []string; false where that fails (raw is
// no array, or holds something else). Absent and null are none.
func countStrings(raw []byte) (int, bool) {
	if !present(raw) {
		return 0, true
	}
	n := 0
	bad := false
	_, ok := elements(raw, -1, func(v []byte) bool {
		if v[0] != '"' && string(v) != "null" {
			bad = true
			return false
		}
		n++
		return true
	})
	return n, ok && !bad
}

// injected tells the context Codex puts before a conversation as the
// user's message.
func injected(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "<environment_context>") || strings.HasPrefix(s, "<user_instructions>")
}

// normType is an item's type with case and underscores left out:
// "CommandExecution", "commandExecution" and "command_execution" alike.
func normType(s string) string { return strings.ToLower(strings.ReplaceAll(s, "_", "")) }

// failedStatus tells an item's status that is no success.
func failedStatus(s string) bool {
	switch normType(s) {
	case "failed", "declined", "cancelled", "canceled", "error", "rejected":
		return true
	}
	return false
}

func codexItem(it obj, o *lineOut) {
	id := str(it["id"])
	switch normType(str(it["type"])) {
	case "usermessage":
		o.user(codexUserContent(asArr(it["content"]), o))
	case "agentmessage":
		var text []string
		for _, b := range asArr(it["content"]) {
			text = append(text, str(asObj(b)["text"]))
		}
		u := o.chunk("agent_message_chunk", strings.Join(text, ""), id)
		if ph := str(it["phase"]); ph != "" {
			setMeta(u, "phase", ph)
		}
		o.update(u)
	case "reasoning":
		summary := stringsOf(first(it, "summary_text", "summary"))
		o.update(o.chunk("agent_thought_chunk", strings.Join(summary, "\n\n"), id))
	case "commandexecution":
		cmd := str(it["command"])
		if argv := stringsOf(it["command"]); argv != nil {
			cmd = shellCommand(argv)
		}
		status := "completed"
		code, hasCode := num(first(it, "exit_code", "exitCode"))
		if hasCode && code != 0 || failedStatus(str(it["status"])) {
			status = "failed"
		}
		u := o.execCall(id, cmd, fileURLPath(str(it["cwd"])), status)
		if c := o.output(u, str(first(it, "aggregated_output", "aggregatedOutput"))); c != nil {
			u["content"] = c
		}
		if hasCode {
			setMeta(u, "exitCode", int64(code))
		}
		o.update(u)
	case "filechange", "patchapply":
		codexFileChange(it, id, o)
	case "mcptoolcall":
		codexMCPCall(it, id, o)
	case "websearch":
		q := str(it["query"])
		if q == "" {
			q = str(asObj(it["action"])["query"])
		}
		o.update(o.searchCall(id, q))
	case "todolist":
		if entries := planEntries(asArr(it["items"]), "text", o); entries != nil {
			o.update(obj{"sessionUpdate": "plan", "entries": entries})
		}
	case "imageview":
		u := o.pathCall(id, str(it["path"]), "read")
		u["status"] = "completed"
		o.update(u)
	case "contextcompaction":
		// The rollout's compacted line makes the notice.
	default:
		o.unknown++
	}
}

// codexUserContent are the blocks of a user's message item; images stand
// for themselves only.
func codexUserContent(content []any, o *lineOut) []any {
	var blocks []any
	for _, b := range content[:min(len(content), maxItems)] {
		m := asObj(b)
		switch normType(str(m["type"])) {
		case "text", "inputtext":
			blocks = append(blocks, o.textBlock(str(m["text"])))
		case "image", "localimage", "inputimage":
			blocks = append(blocks, imageBlock())
		default:
			o.unknown++
		}
	}
	return blocks
}

// execCall is the tool call of a shell command.
func (o *lineOut) execCall(id, cmd, cwd, status string) obj {
	title, _ := cutText(cmd, maxTitle)
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": title, "status": status}
	in := obj{"command": cmd}
	if cwd != "" {
		in["cwd"] = cwd
	}
	u["rawInput"] = o.bounded(u, in)
	return u
}

// searchCall is the tool call of a web search.
func (o *lineOut) searchCall(id, query string) obj {
	title, _ := cutText(query, maxTitle)
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "fetch", "title": title, "status": "completed"}
	if query != "" {
		u["rawInput"] = o.bounded(u, obj{"query": query})
	}
	return u
}

// pathCall is the tool call of a tool that acts on a file.
func (o *lineOut) pathCall(id, p, kind string) obj {
	title, _ := cutText(p, maxTitle)
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": kind, "title": title, "status": "pending"}
	if p != "" {
		u["locations"] = []any{obj{"path": p}}
	}
	return u
}

var shells = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true, "fish": true}

// shellCommand is the command line of an argv: the script of a shell's
// "-c" (as in ["/bin/zsh", "-lc", "echo hi"]), else the words quoted.
func shellCommand(argv []string) string {
	if n := len(argv); n >= 3 && shells[path.Base(argv[0])] {
		flags := argv[1 : n-1]
		ok := true
		for _, f := range flags {
			ok = ok && strings.HasPrefix(f, "-")
		}
		if ok && strings.Contains(flags[len(flags)-1], "c") {
			return argv[n-1]
		}
	}
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = quoteWord(a)
	}
	return strings.Join(words, " ")
}

var plainWord = regexp.MustCompile(`^[A-Za-z0-9_./=:@%+,-]+$`)

func quoteWord(s string) string {
	if plainWord.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// fileURLPath is the path of a file: URL; other text is a path already.
func fileURLPath(s string) string {
	if !strings.HasPrefix(s, "file://") {
		return s
	}
	if u, err := url.Parse(s); err == nil && u.Path != "" {
		return u.Path
	}
	return strings.TrimPrefix(s, "file://")
}

// changeFields are the members of one file's change, whatever the shape:
// {type, …}, {kind: {type, …}, …} or {add|delete|update: {…}}.
func changeFields(m obj) (string, obj) {
	if t := str(m["type"]); t != "" {
		return t, m
	}
	if k := asObj(m["kind"]); k != nil {
		f := obj{}
		for key, v := range m {
			f[key] = v
		}
		for key, v := range k {
			f[key] = v
		}
		return str(k["type"]), f
	}
	for _, k := range []string{"add", "delete", "update"} {
		if f := asObj(m[k]); f != nil {
			return k, f
		}
	}
	return "", m
}

func codexFileChange(it obj, id string, o *lineOut) {
	status := "completed"
	if failedStatus(str(it["status"])) {
		status = "failed"
	}
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "edit", "status": status}
	var content, locs []any
	var paths []string
	add := func(p string, m obj) {
		if len(content) >= maxItems || m == nil {
			return
		}
		kind, f := changeFields(m)
		switch normType(kind) {
		case "add":
			content = append(content, o.diff(u, p, "", str(first(f, "content", "diff")), false))
		case "delete":
			content = append(content, o.diff(u, p, str(first(f, "content", "diff")), "", true))
		default:
			change := obj{"operation": "modify", "path": p}
			if mv := str(first(f, "move_path", "movePath")); mv != "" {
				change = obj{"operation": "move", "path": mv, "oldPath": p}
				p = mv
			}
			d := obj{"type": "diff", "changes": []any{change}}
			if text, cut := o.text(str(first(f, "unified_diff", "unifiedDiff", "diff"))); text != "" {
				d["patch"] = obj{"format": "unified", "text": text}
				if cut {
					setMeta(u, "truncated", true)
				}
			}
			content = append(content, d)
		}
		paths = append(paths, p)
		locs = append(locs, obj{"path": p})
	}
	switch ch := it["changes"].(type) {
	case obj:
		keys := make([]string, 0, len(ch))
		for k := range ch {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			add(k, asObj(ch[k]))
		}
	case []any:
		for _, e := range ch {
			m := asObj(e)
			add(str(m["path"]), m)
		}
	}
	u["title"], _ = cutText(strings.Join(paths, ", "), maxTitle)
	if content != nil {
		u["content"] = content
		u["locations"] = locs
	}
	o.update(u)
}

func codexMCPCall(it obj, id string, o *lineOut) {
	server, tool := str(it["server"]), str(it["tool"])
	title := tool
	if server != "" {
		title = server + "/" + tool
	}
	status := "completed"
	if failedStatus(str(it["status"])) {
		status = "failed"
	}
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "other", "status": status}
	u["title"], _ = cutText(title, maxTitle)
	if args := it["arguments"]; args != nil {
		u["rawInput"] = o.bounded(u, args)
	}
	var text []string
	images := 0
	res := asObj(it["result"])
	if ok := asObj(res["Ok"]); ok != nil {
		res = ok
	}
	if e := first(res, "Err"); e != nil {
		status = "failed"
		text = append(text, str(e))
	}
	for _, b := range asArr(res["content"]) {
		switch m := asObj(b); str(m["type"]) {
		case "text":
			text = append(text, str(m["text"]))
		case "image":
			images++
		}
	}
	if e := it["error"]; e != nil {
		status = "failed"
		if s := str(e); s != "" {
			text = append(text, s)
		} else {
			text = append(text, str(asObj(e)["message"]))
		}
	}
	u["status"] = status
	content := o.output(u, strings.Join(text, "\n"))
	for range min(images, maxItems) {
		content = append(content, obj{"type": "content", "content": imageBlock()})
	}
	if content != nil {
		u["content"] = content
	}
	o.update(u)
}

// ---- the older form ----

// codexResponse maps a response_item of the older form; off is its line's
// offset, the id of a call that has none.
func codexResponse(it obj, off int64, o *lineOut) {
	callID := str(first(it, "call_id", "id"))
	switch str(it["type"]) {
	case "message":
		if str(it["role"]) != "assistant" {
			// The user's are the event_msg's; the first is the injected
			// context.
			return
		}
		var text []string
		for _, b := range asArr(it["content"]) {
			m := asObj(b)
			if t := str(m["type"]); t == "output_text" || t == "text" {
				text = append(text, str(m["text"]))
			}
		}
		if len(text) == 0 {
			return
		}
		u := o.chunk("agent_message_chunk", strings.Join(text, ""), str(it["id"]))
		if ph := str(it["phase"]); ph != "" {
			setMeta(u, "phase", ph)
		}
		o.update(u)
	case "reasoning":
		var text []string
		for _, b := range asArr(it["summary"]) {
			text = append(text, str(asObj(b)["text"]))
		}
		o.update(o.chunk("agent_thought_chunk", strings.Join(text, "\n\n"), str(it["id"])))
	case "function_call":
		args := str(it["arguments"])
		v, _ := o.decode([]byte(args))
		codexCall(str(it["name"]), callID, asObj(v), args, o)
	case "custom_tool_call":
		input := str(it["input"])
		if str(it["name"]) == "apply_patch" {
			o.update(o.patchCall(callID, input))
			return
		}
		codexCall(str(it["name"]), callID, obj{"input": input}, input, o)
	case "local_shell_call":
		action := asObj(it["action"])
		o.update(o.execCall(callID, shellCommand(stringsOf(action["command"])), str(first(action, "working_directory", "workdir")), "pending"))
	case "function_call_output", "custom_tool_call_output":
		codexCallOutput(it, o)
	case "web_search_call":
		id := str(it["id"])
		if id == "" {
			id = "web_search:" + strconv.FormatInt(off, 10)
		}
		o.update(o.searchCall(id, str(asObj(it["action"])["query"])))
	}
}

// codexCall maps a function call of the older form by its tool; args is
// its arguments as the model wrote them.
func codexCall(name, id string, a obj, args string, o *lineOut) {
	switch name {
	case "shell", "container.exec", "shell_command", "exec_command", "local_shell":
		var cmd string
		switch v := first(a, "command", "cmd").(type) {
		case []any:
			cmd = shellCommand(stringsOf(v))
		case string:
			cmd = v
		}
		o.update(o.execCall(id, cmd, str(first(a, "workdir", "cwd", "working_directory")), "pending"))
	case "apply_patch":
		patch := str(first(a, "input", "patch"))
		if a == nil {
			patch = args
		}
		o.update(o.patchCall(id, patch))
	case "update_plan":
		if entries := planEntries(asArr(a["plan"]), "step", o); entries != nil {
			o.update(obj{"sessionUpdate": "plan", "entries": entries})
		}
	case "view_image":
		o.update(o.pathCall(id, str(a["path"]), "read"))
	default:
		u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "other", "status": "pending"}
		u["title"], _ = cutText(name, maxTitle)
		if a != nil {
			u["rawInput"] = o.bounded(u, a)
		}
		o.update(u)
	}
}

// patchHeaders are the lines of Codex's patch language that name a file.
var patchHeaders = []struct{ prefix, operation string }{
	{"*** Update File: ", "modify"},
	{"*** Add File: ", "add"},
	{"*** Delete File: ", "delete"},
	{"*** Move to: ", "move"},
}

// patchCall is the tool call of an apply_patch: an edit whose diff is the
// patch in Codex's own language, the files it names its changes.
func (o *lineOut) patchCall(id, patch string) obj {
	var changes, locs []any
	var paths []string
	for line := range strings.Lines(patch) {
		line = strings.TrimRight(line, "\r\n")
		for _, h := range patchHeaders {
			p, ok := strings.CutPrefix(line, h.prefix)
			if !ok || p == "" || len(changes) >= maxItems {
				continue
			}
			if h.operation == "move" {
				if len(changes) > 0 {
					c := changes[len(changes)-1].(obj)
					c["oldPath"], c["path"], c["operation"] = c["path"], p, "move"
					paths[len(paths)-1] = p
					locs[len(locs)-1] = obj{"path": p}
				}
				continue
			}
			changes = append(changes, obj{"operation": h.operation, "path": p})
			paths = append(paths, p)
			locs = append(locs, obj{"path": p})
		}
	}
	u := obj{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "edit", "status": "pending"}
	u["title"], _ = cutText(strings.Join(paths, ", "), maxTitle)
	text, cut := o.text(patch)
	if cut {
		setMeta(u, "truncated", true)
	}
	if changes == nil {
		changes = []any{}
	}
	u["content"] = []any{obj{"type": "diff", "changes": changes, "patch": obj{"format": "apply_patch", "text": text}}}
	if locs != nil {
		u["locations"] = locs
	}
	return u
}

// planUpdated is what update_plan answers: its plan was the update.
const planUpdated = "Plan updated"

func codexCallOutput(it obj, o *lineOut) {
	var text []string
	images := 0
	status := "completed"
	switch v := it["output"].(type) {
	case string:
		text = append(text, v)
	case []any:
		for _, b := range v {
			switch m := asObj(b); str(m["type"]) {
			case "input_text", "output_text", "text":
				text = append(text, str(m["text"]))
			case "input_image", "image":
				images++
			}
		}
	case obj:
		text = append(text, str(v["content"]))
		if ok, isBool := v["success"].(bool); isBool && !ok {
			status = "failed"
		}
	}
	out := strings.Join(text, "")
	if strings.TrimSpace(out) == planUpdated {
		return
	}
	code, hasCode := 0, false
	var j struct {
		Output   *string `json:"output"`
		Metadata struct {
			ExitCode *int `json:"exit_code"`
		} `json:"metadata"`
	}
	if strings.HasPrefix(strings.TrimSpace(out), "{") && json.Unmarshal([]byte(out), &j) == nil && j.Output != nil {
		// Older outputs: {"output": …, "metadata": {"exit_code": …}}.
		out = *j.Output
		if j.Metadata.ExitCode != nil {
			code, hasCode = *j.Metadata.ExitCode, true
		}
	} else {
		code, hasCode = exitCode(out)
	}
	if hasCode && code != 0 {
		status = "failed"
	}
	u := obj{"sessionUpdate": "tool_call_update", "toolCallId": str(it["call_id"]), "status": status}
	if hasCode {
		setMeta(u, "exitCode", code)
	}
	content := o.output(u, out)
	for range min(images, maxItems) {
		content = append(content, obj{"type": "content", "content": imageBlock()})
	}
	if content != nil {
		u["content"] = content
	}
	o.update(u)
}
