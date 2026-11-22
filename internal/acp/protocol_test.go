package acp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestInitialize(t *testing.T) {
	c, a := start(t, nil)
	res := async(func() (*InitializeResult, error) {
		return c.Initialize(bg, Implementation{Name: "editor", Title: "The Editor", Version: "1.2.3"})
	})
	req := a.next()
	if req.Method != "initialize" || string(req.ID) != "1" {
		t.Fatalf("request = %s", req.line)
	}
	const wantParams = `{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"editor","title":"The Editor","version":"1.2.3"}}`
	if string(req.Params) != wantParams {
		t.Fatalf("params = %s\n  want %s", req.Params, wantParams)
	}

	const caps = `{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"resume":{}},"auth":{"logout":{}}}`
	const methods = `[{"id":"agent-login","name":"Agent login","description":"Sign in using the agent's login flow"}]`
	a.reply(req, `{"protocolVersion":1,"agentCapabilities":`+caps+`,"agentInfo":{"name":"my-agent","title":"My Agent","version":"1.0.0"},"authMethods":`+methods+`}`)

	got := await(t, res, "initialize")
	if got.err != nil {
		t.Fatal(got.err)
	}
	want := &InitializeResult{
		ProtocolVersion: 1,
		AgentCapabilities: AgentCapabilities{
			LoadSession:         true,
			PromptCapabilities:  PromptCapabilities{Image: true, EmbeddedContext: true},
			SessionCapabilities: SessionCapabilities{List: true, Resume: true},
			Raw:                 json.RawMessage(caps),
		},
		AgentInfo:   Implementation{Name: "my-agent", Title: "My Agent", Version: "1.0.0"},
		AuthMethods: json.RawMessage(methods),
	}
	if !reflect.DeepEqual(got.res, want) {
		t.Fatalf("result = %+v\n  want %+v", got.res, want)
	}
}

func TestInitializeCapabilities(t *testing.T) {
	tests := []struct {
		result string
		want   AgentCapabilities
	}{
		// A capability left out is one the agent does not have.
		{`{"protocolVersion":1}`, AgentCapabilities{}},
		{`{"protocolVersion":1,"agentCapabilities":null,"agentInfo":null,"authMethods":[]}`, AgentCapabilities{}},
		{`{"protocolVersion":1,"agentCapabilities":{}}`, AgentCapabilities{Raw: json.RawMessage(`{}`)}},
		{`{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"list":null}}}`,
			AgentCapabilities{Raw: json.RawMessage(`{"sessionCapabilities":{"list":null}}`)}},
		{`{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"close":{}}}}`,
			AgentCapabilities{Raw: json.RawMessage(`{"sessionCapabilities":{"close":{}}}`)}},
		{`{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"list":{"_meta":{"x":1}}}}}`,
			AgentCapabilities{SessionCapabilities: SessionCapabilities{List: true}, Raw: json.RawMessage(`{"sessionCapabilities":{"list":{"_meta":{"x":1}}}}`)}},
	}
	c, a := start(t, nil)
	for _, tt := range tests {
		res := async(func() (*InitializeResult, error) {
			return c.Initialize(bg, Implementation{Name: "editor", Version: "1"})
		})
		req := a.next()
		if strings.Contains(req.line, "title") {
			t.Fatalf("empty title sent: %s", req.line)
		}
		a.reply(req, tt.result)
		got := await(t, res, "initialize")
		if got.err != nil {
			t.Fatalf("%s: %v", tt.result, got.err)
		}
		if !reflect.DeepEqual(got.res.AgentCapabilities, tt.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tt.result, got.res.AgentCapabilities, tt.want)
		}
	}

	// Capabilities of another shape fail the call, not the connection.
	res := async(func() (*InitializeResult, error) {
		return c.Initialize(bg, Implementation{Name: "editor", Version: "1"})
	})
	a.reply(a.next(), `{"protocolVersion":1,"agentCapabilities":{"loadSession":"yes"}}`)
	if got := await(t, res, "initialize"); got.err == nil || got.res != nil || errors.Is(got.err, ErrProtocolVersion) || c.Err() != nil {
		t.Fatalf("capabilities of another shape: %+v, err = %v, connection: %v", got.res, got.err, c.Err())
	}

	// The typed members encode as the protocol writes them.
	if b, err := json.Marshal([]Supported{true, false}); err != nil || string(b) != `[{},null]` {
		t.Fatalf("encoded %s, %v", b, err)
	}
	b, err := json.Marshal(AgentCapabilities{LoadSession: true, SessionCapabilities: SessionCapabilities{List: true}, Raw: json.RawMessage(`{"x":1}`)})
	if want := `{"loadSession":true,"promptCapabilities":{},"sessionCapabilities":{"list":{}}}`; err != nil || string(b) != want {
		t.Fatalf("encoded %s, %v; want %s", b, err, want)
	}
}

func TestInitializeOtherVersion(t *testing.T) {
	c, a := start(t, nil)
	res := async(func() (*InitializeResult, error) {
		return c.Initialize(bg, Implementation{Name: "editor", Version: "1"})
	})
	a.reply(a.next(), `{"protocolVersion":2,"agentCapabilities":{},"agentInfo":{"name":"agent-of-tomorrow","version":"9.0"}}`)
	got := await(t, res, "initialize")
	if !errors.Is(got.err, ErrProtocolVersion) || !strings.HasSuffix(got.err.Error(), ": 2") {
		t.Fatalf("err = %v, want ErrProtocolVersion with the version", got.err)
	}
	if got.res == nil || got.res.ProtocolVersion != 2 || got.res.AgentInfo.Name != "agent-of-tomorrow" {
		t.Fatalf("result = %+v, want the agent's answer", got.res)
	}
	// The connection is the owner's to end.
	if err := c.Err(); err != nil {
		t.Fatalf("connection ended: %v", err)
	}

	// An answer without a version is none this client speaks either.
	res = async(func() (*InitializeResult, error) {
		return c.Initialize(bg, Implementation{Name: "editor", Version: "1"})
	})
	a.reply(a.next(), `{}`)
	if got := await(t, res, "initialize"); !errors.Is(got.err, ErrProtocolVersion) {
		t.Fatalf("err = %v, want ErrProtocolVersion", got.err)
	}
}

func TestPromptTurn(t *testing.T) {
	h := newRecorder()
	entered := make(chan PermissionRequest, 1)
	release := make(chan struct{})
	h.serve = func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		if method != MethodSessionRequestPermission {
			return nil, ErrMethodNotFound
		}
		var p PermissionRequest
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &Error{Code: CodeInvalidParams, Message: "Invalid params"}
		}
		entered <- p
		select {
		case <-release: // the user decided
			return PermissionSelected(p.Options[0].OptionID), nil
		case <-ctx.Done():
			return PermissionCancelled(), nil
		}
	}
	c, a := start(t, h)

	type turn struct {
		res   *PromptResult
		notes int // the notifications handled when Prompt returned
	}
	done := async(func() (turn, error) {
		res, err := c.Prompt(bg, PromptParams{SessionID: "sess_1", Prompt: []json.RawMessage{TextBlock("Fix the <failing> test")}})
		return turn{res, len(h.got())}, err
	})
	req := a.next()
	const wantParams = `{"sessionId":"sess_1","prompt":[{"type":"text","text":"Fix the <failing> test"}]}`
	if req.Method != "session/prompt" || string(req.Params) != wantParams {
		t.Fatalf("request = %s", req.line)
	}

	updates := []string{
		`{"sessionId":"sess_1","update":{"sessionUpdate":"plan","entries":[{"content":"Run the test","priority":"high","status":"pending"}]}}`,
		`{"sessionId":"sess_1","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{"type":"text","text":"Let me look."}}}`,
		`{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"go test ./...","kind":"execute","status":"pending"}}`,
		// Handed on as sent: spaces, member order, escapes, unknown members.
		`{ "update" : {"sessionUpdate":"agent_thought_chunk", "content":{"type":"text","text":"Waiting  for\tthe user \/ \"ok\""}, "_meta":{"x":[1, 2.50, 1e3]}},  "sessionId":"sess_1" }`,
		`{"sessionId":"sess_1","update":{"sessionUpdate":"usage_update","used":53000,"size":200000}}`,
		`{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed"}}`,
	}
	for _, u := range updates[:3] {
		a.update(u)
	}
	a.send(`{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"call_1"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}`)
	p := await(t, entered, "the permission request")
	wantRequest := PermissionRequest{
		SessionID: "sess_1",
		ToolCall:  json.RawMessage(`{"toolCallId":"call_1"}`),
		Options: []PermissionOption{
			{OptionID: "allow-once", Name: "Allow once", Kind: PermissionAllowOnce},
			{OptionID: "reject-once", Name: "Reject", Kind: PermissionRejectOnce},
		},
	}
	if !reflect.DeepEqual(p, wantRequest) {
		t.Fatalf("permission request = %+v", p)
	}
	// The updates before the request were handled before it was served.
	if n := len(h.got()); n != 3 {
		t.Fatalf("%d notifications handled before the request, want 3", n)
	}

	// The request waits for the user: notifications go on meanwhile.
	for range 3 {
		await(t, h.seen, "an update before the request")
	}
	a.update(updates[3])
	a.update(updates[4])
	for _, u := range updates[3:5] {
		if n := await(t, h.seen, "an update during the request"); n.params != u {
			t.Fatalf("update during the request = %s", n.params)
		}
	}
	select {
	case line := <-a.lines:
		t.Fatalf("client wrote %q before the user decided", line)
	default:
	}

	close(release)
	answer := a.next()
	if string(answer.ID) != `"perm-1"` || string(answer.Result) != `{"outcome":{"outcome":"selected","optionId":"allow-once"}}` || answer.Error != nil || answer.Method != "" {
		t.Fatalf("permission response = %s", answer.line)
	}

	a.update(updates[5])
	a.reply(req, `{"stopReason":"end_turn"}`)
	got := await(t, done, "the prompt")
	if got.err != nil || got.res.res.StopReason != StopEndTurn {
		t.Fatalf("prompt: %+v, err = %v", got.res.res, got.err)
	}
	if got.res.notes != len(updates) {
		t.Fatalf("%d notifications handled when Prompt returned, want %d", got.res.notes, len(updates))
	}
	notes := h.got()
	if len(notes) != len(updates) {
		t.Fatalf("%d notifications, want %d", len(notes), len(updates))
	}
	for i, n := range notes {
		if n.method != MethodSessionUpdate || n.params != updates[i] {
			t.Errorf("notification %d = %s %s\n  want %s", i, n.method, n.params, updates[i])
		}
	}
	if h.overlap.Load() {
		t.Error("notifications were handled side by side")
	}

	// What a host reads of an update: whose it is.
	var sn SessionNotification
	if err := json.Unmarshal([]byte(notes[3].params), &sn); err != nil || sn.SessionID != "sess_1" || !strings.HasPrefix(string(sn.Update), `{"sessionUpdate":"agent_thought_chunk"`) {
		t.Fatalf("session notification = %+v, %v", sn, err)
	}
}

func TestCancel(t *testing.T) {
	h := newRecorder()
	entered := make(chan struct{}, 1)
	cancelled := make(chan struct{})
	h.serve = func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		entered <- struct{}{}
		select {
		case <-cancelled:
		case <-ctx.Done():
		}
		return PermissionCancelled(), nil
	}
	c, a := start(t, h)
	done := async(func() (*PromptResult, error) {
		return c.Prompt(bg, PromptParams{SessionID: "sess_1", Prompt: []json.RawMessage{TextBlock("Run it")}})
	})
	req := a.next()
	a.send(`{"jsonrpc":"2.0","id":5,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"call_1"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}`)
	await(t, entered, "the permission request")

	// The user cancels the turn: the agent is told, and the request that
	// waits is answered with cancelled.
	if err := c.Cancel("sess_1"); err != nil {
		t.Fatal(err)
	}
	cancel := a.next()
	if cancel.Method != "session/cancel" || cancel.ID != nil || string(cancel.Params) != `{"sessionId":"sess_1"}` {
		t.Fatalf("cancel = %s", cancel.line)
	}
	if want := `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"sess_1"}}` + "\n"; cancel.line != want {
		t.Fatalf("cancel = %s, want %s", cancel.line, want)
	}
	close(cancelled)
	answer := a.next()
	if string(answer.ID) != "5" || string(answer.Result) != `{"outcome":{"outcome":"cancelled"}}` {
		t.Fatalf("permission response = %s", answer.line)
	}

	// The agent may still report what it ended, then ends the turn.
	select {
	case got := <-done:
		t.Fatalf("Prompt returned before the agent ended the turn: %+v, %v", got.res, got.err)
	default:
	}
	last := `{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"failed"}}`
	a.update(last)
	a.reply(req, `{"stopReason":"cancelled"}`)
	got := await(t, done, "the prompt")
	if got.err != nil || got.res.StopReason != StopCancelled {
		t.Fatalf("prompt: %+v, err = %v", got.res, got.err)
	}
	if notes := h.got(); len(notes) != 1 || notes[0].params != last {
		t.Fatalf("notifications = %v", notes)
	}
}

func TestMCPServersEmptyArray(t *testing.T) {
	// However the params are encoded, no servers are [] and never null.
	for _, v := range []any{
		NewSessionParams{Cwd: "/w"},
		&NewSessionParams{Cwd: "/w"},
		LoadSessionParams{SessionID: "s", Cwd: "/w"},
		struct {
			P NewSessionParams `json:"params"`
		}{NewSessionParams{Cwd: "/w", MCPServers: []json.RawMessage{}}},
	} {
		b, err := json.Marshal(v)
		if err != nil || !strings.Contains(string(b), `"mcpServers":[]`) {
			t.Errorf("%T encoded as %s, %v", v, b, err)
		}
	}
	if b, err := json.Marshal(PromptParams{SessionID: "s"}); err != nil || string(b) != `{"sessionId":"s","prompt":[]}` {
		t.Errorf("prompt without blocks encoded as %s, %v", b, err)
	}

	c, a := start(t, nil)
	res := async(func() (*NewSessionResult, error) {
		return c.NewSession(bg, NewSessionParams{Cwd: "/home/user/project"})
	})
	req := a.next()
	if want := `{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/home/user/project","mcpServers":[]}}` + "\n"; req.line != want {
		t.Fatalf("got  %swant %s", req.line, want)
	}
	a.reply(req, `{"sessionId":"sess_abc123def456"}`)
	if got := await(t, res, "session/new"); got.err != nil || !reflect.DeepEqual(got.res, &NewSessionResult{SessionID: "sess_abc123def456"}) {
		t.Fatalf("session/new: %+v, err = %v", got.res, got.err)
	}

	// The same through Call, and for session/load.
	errc := asyncErr(func() error { return c.Call(bg, MethodSessionNew, NewSessionParams{Cwd: "/w"}, nil) })
	req = a.next()
	if string(req.Params) != `{"cwd":"/w","mcpServers":[]}` {
		t.Fatalf("params = %s", req.Params)
	}
	a.reply(req, `{"sessionId":"s2"}`)
	if err := await(t, errc, "session/new"); err != nil {
		t.Fatal(err)
	}
	loaded := async(func() (*LoadSessionResult, error) {
		return c.LoadSession(bg, LoadSessionParams{SessionID: "sess_789xyz", Cwd: "/home/user/project"})
	})
	req = a.next()
	if req.Method != "session/load" || string(req.Params) != `{"sessionId":"sess_789xyz","cwd":"/home/user/project","mcpServers":[]}` {
		t.Fatalf("request = %s", req.line)
	}
	a.reply(req, `null`)
	if got := await(t, loaded, "session/load"); got.err != nil || !reflect.DeepEqual(got.res, &LoadSessionResult{}) {
		t.Fatalf("session/load: %+v, err = %v", got.res, got.err)
	}
}

func TestSessionCalls(t *testing.T) {
	const modes = `{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Code"}]}`
	const options = `[{"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"code","options":[{"value":"ask","name":"Ask"},{"value":"code","name":"Code"}]}]`
	const server = `{"name":"filesystem","command":"/path/to/mcp-server","args":["--stdio"],"env":[]}`

	tests := []struct {
		name   string
		call   func(c *Conn) (any, error)
		method string
		params string
		result string
		want   any
	}{
		{
			name:   "authenticate",
			call:   func(c *Conn) (any, error) { return nil, c.Authenticate(bg, "agent-login") },
			method: "authenticate", params: `{"methodId":"agent-login"}`,
			result: `{}`,
		},
		{
			name: "session/new",
			call: func(c *Conn) (any, error) {
				return c.NewSession(bg, NewSessionParams{Cwd: "/home/user/project", MCPServers: []json.RawMessage{json.RawMessage(server)}})
			},
			method: "session/new", params: `{"cwd":"/home/user/project","mcpServers":[` + server + `]}`,
			result: `{"sessionId":"sess_1","modes":` + modes + `,"configOptions":` + options + `}`,
			want:   &NewSessionResult{SessionID: "sess_1", Modes: json.RawMessage(modes), ConfigOptions: json.RawMessage(options)},
		},
		{
			name: "session/load",
			call: func(c *Conn) (any, error) {
				return c.LoadSession(bg, LoadSessionParams{SessionID: "sess_789xyz", Cwd: "/home/user/project"})
			},
			method: "session/load", params: `{"sessionId":"sess_789xyz","cwd":"/home/user/project","mcpServers":[]}`,
			result: `{"modes":` + modes + `,"configOptions":` + options + `}`,
			want:   &LoadSessionResult{Modes: json.RawMessage(modes), ConfigOptions: json.RawMessage(options)},
		},
		{
			name: "session/new with _meta",
			call: func(c *Conn) (any, error) {
				return c.NewSession(bg, NewSessionParams{Cwd: "/w", Meta: json.RawMessage(`{"yoloMode":false}`)})
			},
			method: "session/new", params: `{"cwd":"/w","mcpServers":[],"_meta":{"yoloMode":false}}`,
			result: `{"sessionId":"s3","models":{"currentModelId":"m"},"_meta":{"x":1}}`,
			want:   &NewSessionResult{SessionID: "s3", Models: json.RawMessage(`{"currentModelId":"m"}`), Meta: json.RawMessage(`{"x":1}`)},
		},
		{
			name: "session/resume",
			call: func(c *Conn) (any, error) {
				return c.ResumeSession(bg, LoadSessionParams{SessionID: "sess_789xyz", Cwd: "/w", Meta: json.RawMessage(`{"yoloMode":false}`)})
			},
			method: "session/resume", params: `{"sessionId":"sess_789xyz","cwd":"/w","mcpServers":[],"_meta":{"yoloMode":false}}`,
			result: `{"configOptions":` + options + `}`,
			want:   &LoadSessionResult{ConfigOptions: json.RawMessage(options)},
		},
		{
			name: "session/prompt with usage and _meta",
			call: func(c *Conn) (any, error) {
				return c.Prompt(bg, PromptParams{SessionID: "sess_1", Prompt: []json.RawMessage{TextBlock("hi")}})
			},
			method: "session/prompt", params: `{"sessionId":"sess_1","prompt":[{"type":"text","text":"hi"}]}`,
			result: `{"stopReason":"end_turn","usage":{"inputTokens":3},"_meta":{"usage":{"costUsdTicks":10}}}`,
			want:   &PromptResult{StopReason: StopEndTurn, Usage: json.RawMessage(`{"inputTokens":3}`), Meta: json.RawMessage(`{"usage":{"costUsdTicks":10}}`)},
		},
		{
			name: "session/set_mode",
			call: func(c *Conn) (any, error) {
				return nil, c.SetMode(bg, SetModeParams{SessionID: "sess_1", ModeID: "code"})
			},
			method: "session/set_mode", params: `{"sessionId":"sess_1","modeId":"code"}`,
			result: `null`,
		},
		{
			name: "session/set_config_option",
			call: func(c *Conn) (any, error) {
				return c.SetConfigOption(bg, SetConfigOptionParams{SessionID: "sess_1", ConfigID: "mode", Value: "code"})
			},
			method: "session/set_config_option", params: `{"sessionId":"sess_1","configId":"mode","value":"code"}`,
			result: `{"configOptions":` + options + `}`,
			want:   &SetConfigOptionResult{ConfigOptions: json.RawMessage(options)},
		},
		{
			name:   "session/list, first page",
			call:   func(c *Conn) (any, error) { return c.ListSessions(bg, ListSessionsParams{}) },
			method: "session/list", params: `{}`,
			result: `{"sessions":[{"sessionId":"sess_abc123def456","cwd":"/home/user/project","title":"Implement session list API","updatedAt":"2025-10-29T14:22:15Z","_meta":{"messageCount":12}},{"sessionId":"sess_uvw345rst678","cwd":"/home/user/project","title":null}],"nextCursor":"eyJwYWdlIjogM30="}`,
			want: &ListSessionsResult{
				Sessions: []SessionInfo{
					{SessionID: "sess_abc123def456", Cwd: "/home/user/project", Title: "Implement session list API", UpdatedAt: "2025-10-29T14:22:15Z", Meta: json.RawMessage(`{"messageCount":12}`)},
					{SessionID: "sess_uvw345rst678", Cwd: "/home/user/project"},
				},
				NextCursor: "eyJwYWdlIjogM30=",
			},
		},
		{
			name: "session/list, next page",
			call: func(c *Conn) (any, error) {
				return c.ListSessions(bg, ListSessionsParams{Cwd: "/home/user/project", Cursor: "eyJwYWdlIjogM30="})
			},
			method: "session/list", params: `{"cwd":"/home/user/project","cursor":"eyJwYWdlIjogM30="}`,
			result: `{"sessions":[]}`,
			want:   &ListSessionsResult{Sessions: []SessionInfo{}},
		},
	}
	c, a := start(t, nil)
	for _, tt := range tests {
		res := async(func() (any, error) { return tt.call(c) })
		req := a.next()
		if req.Method != tt.method || string(req.Params) != tt.params || req.ID == nil {
			t.Fatalf("%s: request = %s  want method %s, params %s", tt.name, req.line, tt.method, tt.params)
		}
		a.reply(req, tt.result)
		got := await(t, res, tt.name)
		if got.err != nil {
			t.Fatalf("%s: %v", tt.name, got.err)
		}
		if tt.want != nil && !reflect.DeepEqual(got.res, tt.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", tt.name, got.res, tt.want)
		}
	}

	// A session without an id is none.
	res := async(func() (*NewSessionResult, error) { return c.NewSession(bg, NewSessionParams{Cwd: "/w"}) })
	a.reply(a.next(), `{}`)
	if got := await(t, res, "session/new"); got.err == nil || got.res != nil {
		t.Fatalf("session/new without sessionId: %+v, err = %v", got.res, got.err)
	}
	// A result of another shape is an error of the call, not of the connection.
	res = async(func() (*NewSessionResult, error) { return c.NewSession(bg, NewSessionParams{Cwd: "/w"}) })
	a.reply(a.next(), `{"sessionId":17}`)
	if got := await(t, res, "session/new"); got.err == nil || errors.Is(got.err, ErrClosed) || c.Err() != nil {
		t.Fatalf("session/new with a number for an id: err = %v, connection: %v", got.err, c.Err())
	}
}

func TestCallsOnClosedConnection(t *testing.T) {
	c, _ := start(t, nil)
	c.Close()
	calls := map[string]func() (any, error){
		"Initialize":      func() (any, error) { return c.Initialize(bg, Implementation{Name: "editor", Version: "1"}) },
		"Authenticate":    func() (any, error) { return nil, c.Authenticate(bg, "agent-login") },
		"NewSession":      func() (any, error) { return c.NewSession(bg, NewSessionParams{Cwd: "/w"}) },
		"LoadSession":     func() (any, error) { return c.LoadSession(bg, LoadSessionParams{SessionID: "s", Cwd: "/w"}) },
		"ResumeSession":   func() (any, error) { return c.ResumeSession(bg, LoadSessionParams{SessionID: "s", Cwd: "/w"}) },
		"Prompt":          func() (any, error) { return c.Prompt(bg, PromptParams{SessionID: "s"}) },
		"Cancel":          func() (any, error) { return nil, c.Cancel("s") },
		"SetMode":         func() (any, error) { return nil, c.SetMode(bg, SetModeParams{SessionID: "s", ModeID: "code"}) },
		"SetConfigOption": func() (any, error) { return c.SetConfigOption(bg, SetConfigOptionParams{SessionID: "s"}) },
		"ListSessions":    func() (any, error) { return c.ListSessions(bg, ListSessionsParams{}) },
	}
	for name, call := range calls {
		res, err := call()
		if err != ErrClosed {
			t.Errorf("%s: err = %v, want ErrClosed", name, err)
		}
		if v := reflect.ValueOf(res); v.IsValid() && !v.IsNil() {
			t.Errorf("%s: result %+v with an error", name, res)
		}
	}
}

func TestPermissionOutcomes(t *testing.T) {
	for want, v := range map[string]PermissionResponse{
		`{"outcome":{"outcome":"selected","optionId":"allow-once"}}`: PermissionSelected("allow-once"),
		`{"outcome":{"outcome":"cancelled"}}`:                        PermissionCancelled(),
	} {
		if b, err := json.Marshal(v); err != nil || string(b) != want {
			t.Errorf("encoded %s, %v; want %s", b, err, want)
		}
	}
	if got, want := string(TextBlock("a\n\"b\" <c>")), `{"type":"text","text":"a\n\"b\" <c>"}`; got != want {
		t.Errorf("text block = %s, want %s", got, want)
	}
}
