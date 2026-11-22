package chat

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// setup is the plugin bound to a test core whose machines' chat host is
// f; ready lists the machines connected.
type setup struct {
	p *Plugin
	f *fakeChatHost
	h *testHost

	mu    sync.Mutex
	ready []string
}

func newSetup(t *testing.T) *setup {
	t.Helper()
	s := &setup{p: New(), f: newFakeChatHost(t), h: newTestHost(t), ready: []string{"gpu"}}
	s.p.open = s.f.open
	s.p.ready = func() []string {
		s.mu.Lock()
		defer s.mu.Unlock()
		return slices.Clone(s.ready)
	}
	s.p.host = s.h
	return s
}

func (s *setup) setReady(ms ...string) {
	s.mu.Lock()
	s.ready = ms
	s.mu.Unlock()
	s.p.poke()
}

// call calls a route as the core would: a mutating one through an
// Outcome; it returns the status, the answer and the audit fields.
func (s *setup) call(method, m, path, body string) (int, map[string]any, map[string]any) {
	mux := http.NewServeMux()
	var fields map[string]any
	for _, rt := range s.p.Routes() {
		rt := rt
		mux.HandleFunc(plugin.Pattern(ID, rt), func(w http.ResponseWriter, r *http.Request) {
			c := &plugin.Call{Host: s.h}
			if rt.Machine {
				c.Machine = s.h.mg.Get(r.PathValue("id"))
			}
			if rt.Mutating {
				out := &plugin.Outcome{ResponseWriter: w}
				rt.Handler(c, out, r)
				fields = c.AuditFields()
				return
			}
			rt.Handler(c, w, r)
		})
	}
	url := "/api/p/chat/" + path
	if m != "" {
		url = "/api/m/" + m + "/p/chat/" + path
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, url, strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, fields
}

func TestPlugin(t *testing.T) {
	p := New()
	if p.ID() != "chat" || !plugin.ValidID(p.ID()) || plugin.EnableSetting(p) != "plugins.chat.enabled" {
		t.Fatalf("plugin %q", p.ID())
	}
	var _ plugin.Starter = p
}

// The routes: readers, audited changes, the states and the WebSocket.
func TestRoutes(t *testing.T) {
	var got []string
	for _, rt := range New().Routes() {
		desc := plugin.Pattern(ID, rt)
		if rt.Mutating {
			desc += " audited as chat." + rt.Audit
		}
		got = append(got, desc)
	}
	want := []string{
		"GET /api/m/{id}/p/chat/agents",
		"POST /api/m/{id}/p/chat/agents audited as chat.agents",
		"GET /api/m/{id}/p/chat/chats",
		"POST /api/m/{id}/p/chat/sessions audited as chat.sessions",
		"POST /api/m/{id}/p/chat/new audited as chat.new",
		"POST /api/m/{id}/p/chat/close audited as chat.close",
		"DELETE /api/m/{id}/p/chat/chat audited as chat.delete",
		"POST /api/m/{id}/p/chat/seen audited as chat.seen",
		"POST /api/m/{id}/p/chat/handoff audited as chat.handoff",
		"POST /api/m/{id}/p/chat/trust audited as chat.trust",
		"POST /api/m/{id}/p/chat/untrust audited as chat.untrust",
		"GET /api/p/chat/states",
		"GET /api/p/chat/ws",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("routes:\n%s", strings.Join(got, "\n"))
	}
}

// Each route is one request of the machine's chat host, which a change
// starts when none serves; what it takes is checked on the core first.
func TestRequests(t *testing.T) {
	s := newSetup(t)
	s.f.running = false
	s.f.agents["claude"] = true
	s.f.sessions = []chatproto.Session{{SessionID: "0c1d", Cwd: "/w", Title: "earlier"}}

	// A GET finds no host and starts none.
	if code, out, _ := s.call("GET", "gpu", "agents", ""); code != 409 || out["error"] != codeNotRunning || s.f.running {
		t.Fatalf("agents without a host: %d %v", code, out)
	}
	code, out, fields := s.call("POST", "gpu", "agents", "")
	if code != 200 {
		t.Fatalf("agents: %d %v", code, out)
	}
	agents, _ := out["agents"].([]any)
	if len(agents) != len(agentkinds.ChatKinds()) {
		t.Errorf("agents %v: one for each chat kind, none other", agents)
	}
	if a := agents[0].(map[string]any); a["kind"] != "claude" || a["available"] != true {
		t.Errorf("claude: %v", a)
	}
	if !slices.Equal(s.f.opens, []bool{false, true}) || !slices.Equal(s.f.requests[0].Kinds, chatKinds) {
		t.Errorf("open %v, kinds %v", s.f.opens, s.f.requests[0].Kinds)
	}
	if code, out, _ = s.call("GET", "gpu", "agents", ""); code != 200 || len(out["agents"].([]any)) != len(agentkinds.ChatKinds()) {
		t.Errorf("agents of a host that serves: %d %v", code, out)
	}

	if code, out, _ = s.call("GET", "gpu", "chats", ""); code != 200 || out["chats"] == nil {
		t.Errorf("chats: %d %v", code, out)
	}

	for _, q := range []string{"kind=bash&cwd=/w", "kind=claude&cwd=w", "kind=claude&cwd=/w/../x", "kind=claude&cwd=/w/",
		"kind=claude&cwd=/w&cursor=" + strings.Repeat("x", maxCursor+1)} {
		if code, out, _ = s.call("POST", "gpu", "sessions?"+q, ""); code != 400 || out["error"] != "bad_request" {
			t.Errorf("sessions?%s: %d %v", q, code, out)
		}
	}
	code, out, fields = s.call("POST", "gpu", "sessions?kind=codex&cwd=/w/x&cursor=c1", "")
	if code != 200 || out["nextCursor"] != "next" || len(out["sessions"].([]any)) != 1 || fields["kind"] != "codex" || fields["cwd"] != "/w/x" {
		t.Errorf("sessions: %d %v, audited %v", code, out, fields)
	}
	last := s.f.requests[len(s.f.requests)-1]
	if last.Op != chatproto.OpSessions || last.Kind != "codex" || last.Cwd != "/w/x" || last.Cursor != "c1" {
		t.Errorf("sessions asked %+v", last)
	}
	// Listing sessions may run the agent: the host took the settings
	// before.
	if req := s.f.requests[len(s.f.requests)-2]; req.Op != chatproto.OpConfigure {
		t.Errorf("before sessions %+v", req)
	}

	for _, body := range []string{`{`, `{"kind":"bash","cwd":"/w"}`, `{"kind":"claude","cwd":"rel"}`,
		`{"kind":"claude","cwd":"/w","resume":"-x"}`, `{"kind":"claude","cwd":"/w","import":true}`,
		`{"kind":"claude","cwd":"/w","options":{"mode":"yolo"}}`, `{"kind":"claude","cwd":"/w","options":{"model":"a\nb"}}`,
		`{"kind":"claude","cwd":"/w","pad":"` + strings.Repeat("x", maxBody) + `"}`} {
		if code, out, _ = s.call("POST", "gpu", "new", body); code != 400 || out["error"] != "bad_request" {
			t.Errorf("new %.60s: %d %v", body, code, out)
		}
	}
	// A host started again takes the settings anew before a new chat.
	s.f.pid = 2
	n := len(s.f.requests)
	code, out, fields = s.call("POST", "gpu", "new", `{"kind":"claude","cwd":"/w","resume":"5f0c","import":true,"options":{"model":"m","mode":"full"}}`)
	chat, _ := out["chat"].(map[string]any)
	if code != 200 || chat == nil || !chatproto.ValidChatID(chat["id"].(string)) {
		t.Fatalf("new: %d %v", code, out)
	}
	if req := s.f.requests[n]; req.Op != chatproto.OpConfigure || *req.Settings != HostSettings(s.h.st, "gpu") {
		t.Errorf("before new %+v", req)
	}
	req := s.f.requests[n+1]
	if req.Op != chatproto.OpNew || req.Kind != "claude" || req.Cwd != "/w" || req.Resume != "5f0c" || !req.Import ||
		req.Options == nil || req.Options.Model != "m" || req.Options.Mode != chatproto.ModeFull {
		t.Errorf("new asked %+v", req)
	}
	if fields["kind"] != "claude" || fields["cwd"] != "/w" || fields["resume"] != "5f0c" || fields["import"] != true ||
		fields["mode"] != "full" || fields["chat"] != chat["id"] {
		t.Errorf("new audited %v", fields)
	}
	id := chat["id"].(string)
	n = len(s.f.requests)
	s.call("POST", "gpu", "new", `{"kind":"codex","cwd":"/w"}`)
	if ops := s.f.ops()[n:]; !slices.Equal(ops, []string{chatproto.OpNew}) {
		t.Errorf("a second new: %v", ops)
	}
	s.h.st.OnChange(s.p.settingsChanged) // as Start does
	if err := s.h.st.Set(SettingAllowFull, "gpu", true); err != nil {
		t.Fatal(err)
	}
	n = len(s.f.requests)
	s.call("POST", "gpu", "new", `{"kind":"codex","cwd":"/w"}`)
	if ops := s.f.ops()[n:]; !slices.Equal(ops, []string{chatproto.OpConfigure, chatproto.OpNew}) || !s.f.requests[n].Settings.AllowFull {
		t.Errorf("a new after the settings changed: %v", ops)
	}

	for _, tc := range []struct{ method, path, op string }{
		{"POST", "close?chat=" + id, chatproto.OpClose},
		{"DELETE", "chat?chat=" + id, chatproto.OpDelete},
		{"POST", "seen?chat=" + id + "&seq=12", chatproto.OpSeen},
	} {
		code, out, fields := s.call(tc.method, "gpu", tc.path, "")
		req := s.f.requests[len(s.f.requests)-1]
		if code != 200 || req.Op != tc.op || req.Chat != id || fields["chat"] != id {
			t.Errorf("%s %s: %d %v, asked %+v, audited %v", tc.method, tc.path, code, out, req, fields)
		}
	}
	if req := s.f.requests[len(s.f.requests)-1]; req.Seq != 12 {
		t.Errorf("seen asked %+v", req)
	}
	code, out, fields = s.call("POST", "gpu", "trust?cwd=/w/p", "")
	if req := s.f.requests[len(s.f.requests)-1]; code != 200 || req.Op != chatproto.OpTrust || req.Cwd != "/w/p" || fields["cwd"] != "/w/p" {
		t.Errorf("trust: %d %v, asked %+v, audited %v", code, out, req, fields)
	}
	code, out, fields = s.call("POST", "gpu", "untrust?cwd=/w/p", "")
	if req := s.f.requests[len(s.f.requests)-1]; code != 200 || req.Op != chatproto.OpUntrust || req.Cwd != "/w/p" || fields["cwd"] != "/w/p" {
		t.Errorf("untrust: %d %v, asked %+v, audited %v", code, out, req, fields)
	}
	for _, path := range []string{"close", "close?chat=x", "seen?chat=" + id, "seen?chat=" + id + "&seq=-1", "handoff?chat=C0123",
		"trust", "trust?cwd=rel", "trust?cwd=/a/../b", "untrust", "untrust?cwd=rel", "untrust?cwd=/a/../b"} {
		if code, out, _ := s.call("POST", "gpu", path, ""); code != 400 {
			t.Errorf("%s: %d %v", path, code, out)
		}
	}
	if code, out, _ := s.call("DELETE", "gpu", "chat", ""); code != 400 {
		t.Errorf("delete without a chat: %d %v", code, out)
	}
}

// A GET route (which a browser sends without Origin from any page) never
// starts the machine's chat host, nor does a read-only core: they answer
// not_running; a read-only core asks no agent's program.
func TestGetStartsNoHost(t *testing.T) {
	s := newSetup(t)
	s.f.running = false
	for _, path := range []string{"agents", "chats"} {
		if code, out, _ := s.call("GET", "gpu", path, ""); code != 409 || out["error"] != codeNotRunning {
			t.Errorf("%s: %d %v", path, code, out)
		}
	}
	if code, _, _ := s.call("GET", "", "states", ""); code != 200 {
		t.Errorf("states: %d", code)
	}
	if code, _, _ := s.call("GET", "gpu", "sessions?kind=codex&cwd=/w", ""); code != 405 && code != 404 {
		t.Errorf("GET sessions: %d", code)
	}
	s.f.mu.Lock()
	if !slices.Equal(s.f.opens, []bool{false, false}) || s.f.running || len(s.f.requests) != 0 {
		t.Errorf("opens %v, requests %v", s.f.opens, s.f.requests)
	}
	s.f.mu.Unlock()

	s.h.readOnly = true
	s.f.running = true
	if code, out, _ := s.call("GET", "gpu", "agents", ""); code != 403 || out["error"] != CodeReadOnly {
		t.Errorf("read-only agents: %d %v", code, out)
	}
	if s.f.mu.Lock(); s.f.count(chatproto.OpAgents) != 0 || len(s.f.opens) != 2 {
		t.Errorf("a read-only core asked: %v", s.f.ops())
	}
	s.f.mu.Unlock()
}

// A read-only core leaves out the agents' standard error, which may tell
// what their environment holds.
func TestReadOnlyRedacts(t *testing.T) {
	s := newSetup(t)
	id := chatproto.NewChatID()
	s.f.chats[id] = chatproto.Chat{ID: id, Kind: "claude", State: chatproto.StateFailed,
		Error: &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "m", Stderr: "TOKEN=secret"}}
	_, out, _ := s.call("GET", "gpu", "chats", "")
	if b, _ := json.Marshal(out); !strings.Contains(string(b), "TOKEN=secret") {
		t.Fatalf("a core that is not read-only: %s", b)
	}
	s.h.readOnly = true
	_, out, _ = s.call("GET", "gpu", "chats", "")
	if b, _ := json.Marshal(out); strings.Contains(string(b), "TOKEN") || !strings.Contains(string(b), "start_failed") {
		t.Errorf("read-only: %s", b)
	}
	// A read-only core starts no host: it shows what runs.
	s.f.end(false)
	code, out, _ := s.call("GET", "gpu", "chats", "")
	if code != 409 || out["error"] != codeNotRunning || s.f.running {
		t.Errorf("read-only without a host: %d %v", code, out)
	}
	line := []byte(`{"seq":4,"t":"state","state":"failed","error":{"code":"failed","message":"m","stderr":"TOKEN=secret"}}`)
	if got := string(redactEvent(line)); strings.Contains(got, "TOKEN") || !strings.Contains(got, `"seq":4`) || strings.HasSuffix(got, "\n") {
		t.Errorf("event %s", got)
	}
	if got := redactChat(json.RawMessage(`{"id":"c1","error":{"code":"failed","message":"m","stderr":"x"}}`)); strings.Contains(string(got), "stderr") {
		t.Errorf("chat %s", got)
	}
}

// The host's refusals keep their codes, with a status that fits; a host of
// another protocol and a machine that is not connected are errors of their
// own.
func TestRequestErrors(t *testing.T) {
	s := newSetup(t)
	id := chatproto.NewChatID()
	for code, status := range map[string]int{
		chatproto.CodeUnknownChat: 404, chatproto.CodeBusy: 409, chatproto.CodeTooMany: 409, chatproto.CodeBadRequest: 400,
		chatproto.CodeStartFailed: 502, chatproto.CodeUnsupported: 422, chatproto.CodeNotAllowed: 403,
		chatproto.CodeSleeping: 409, codeNotRunning: 409, "upgrading": 503, "no_terminal_core": 503, chatproto.CodeUnsafeFolder: 403,
	} {
		s.f.reqErr[chatproto.OpClose] = &chatproto.Error{Code: code, Message: "m"}
		got, out, fields := s.call("POST", "gpu", "close?chat="+id, "")
		if got != status || out["error"] != code || out["message"] != "m" || fields["chat"] != id {
			t.Errorf("%s: %d %v", code, got, out)
		}
	}
	s.f.proto = 1
	if got, out, _ := s.call("GET", "gpu", "chats", ""); got != 502 || out["error"] != chatproto.CodeProtocol {
		t.Errorf("another protocol: %d %v", got, out)
	}
	s.f.proto = chatproto.Proto
	// A host that refuses its settings still gets the request.
	s.f.reqErr[chatproto.OpConfigure] = &chatproto.Error{Code: chatproto.CodeBadRequest, Message: "m"}
	if got, out, _ := s.call("POST", "gpu", "new", `{"kind":"claude","cwd":"/w"}`); got != 200 || s.f.count(chatproto.OpNew) != 1 {
		t.Errorf("new after a refused configure: %d %v", got, out)
	}
	s.f.openErr = "offline"
	if got, out, _ := s.call("GET", "gpu", "chats", ""); got != 409 || out["error"] != "offline" {
		t.Errorf("offline: %d %v", got, out)
	}
}

// A handoff attaches without the log, sends the command and answers what
// the host answered it.
func TestHandoff(t *testing.T) {
	s := newSetup(t)
	id := chatproto.NewChatID()
	s.f.chats[id] = chatproto.Chat{ID: id, Kind: "claude", State: chatproto.StateIdle}
	code, out, fields := s.call("POST", "gpu", "handoff?chat="+id, "")
	if code != 200 || fields["chat"] != id {
		t.Fatalf("handoff: %d %v", code, out)
	}
	req := s.f.requests[len(s.f.requests)-1]
	if req.Op != chatproto.OpAttach || req.Chat != id || req.From != math.MaxUint64 {
		t.Errorf("attached %+v", req)
	}
	if len(s.f.commands) != 1 || s.f.commands[0].Op != chatproto.OpHandoff {
		t.Errorf("commands %+v", s.f.commands)
	}
	s.f.ackErr[chatproto.OpHandoff] = &chatproto.Error{Code: chatproto.CodeBusy, Message: "a turn runs"}
	if code, out, _ := s.call("POST", "gpu", "handoff?chat="+id, ""); code != 409 || out["error"] != chatproto.CodeBusy {
		t.Errorf("busy: %d %v", code, out)
	}
	if code, out, _ := s.call("POST", "gpu", "handoff?chat="+chatproto.NewChatID(), ""); code != 404 || out["error"] != chatproto.CodeUnknownChat {
		t.Errorf("unknown chat: %d %v", code, out)
	}
}

// The settings are the chat host's, with its bounds, per machine; a
// machine's own values reach its host clamped.
func TestHostSettings(t *testing.T) {
	if got := HostSettings(nil, "m"); got != chatproto.DefaultHostSettings() {
		t.Errorf("no settings: %+v", got)
	}
	st := settings.New("", Settings)
	if got := HostSettings(st, "m"); got != chatproto.DefaultHostSettings() {
		t.Errorf("defaults: %+v", got)
	}
	for _, d := range Settings.Defs {
		if d.Scope != settings.ScopeMachine || d.Section != ID {
			t.Errorf("%s: scope %s, section %s", d.Key, d.Scope, d.Section)
		}
	}
	set := func(key, m string, v any) {
		t.Helper()
		if err := st.Set(key, m, v); err != nil {
			t.Fatal(key, err)
		}
	}
	set(SettingPermissionMode, "gpu", chatproto.ModeFull)
	if got := HostSettings(st, "gpu"); got.DefaultMode != chatproto.ModeDefault || got.AllowFull {
		t.Errorf("full access without its setting: %+v", got)
	}
	set(SettingAllowFull, "gpu", true)
	set(SettingIdleStopMinutes, "gpu", 1440.0)
	set(SettingMaxLive, "", 2.0)
	set(SettingMaxChats, "gpu", 50.0)
	set(SettingRetentionDays, "gpu", 365.0)
	set(SettingMaxTotalMB, "gpu", 2048.0)
	set(SettingMaxChatMB, "gpu", 8.0)
	want := chatproto.HostSettings{IdleStopMinutes: 1440, MaxLive: 2, MaxChats: 50, RetentionDays: 365,
		MaxTotalBytes: 2048 << 20, MaxChatBytes: 8 << 20, DefaultMode: chatproto.ModeFull, AllowFull: true}
	if got := HostSettings(st, "gpu"); got != want {
		t.Errorf("gpu: %+v", got)
	}
	if got := HostSettings(st, "other"); got.MaxLive != 2 || got.DefaultMode != chatproto.ModeDefault || got.MaxTotalBytes != 512<<20 || got.AllowFull {
		t.Errorf("another machine: %+v", got)
	}
	// Values beyond the host's bounds are not settings.
	for key, v := range map[string]any{
		SettingIdleStopMinutes: 4.0, SettingMaxLive: 33.0, SettingMaxChats: 2001.0, SettingRetentionDays: 0.0,
		SettingMaxTotalMB: 4096.0, SettingMaxChatMB: 7.0, SettingPermissionMode: "bypassPermissions",
	} {
		if err := st.Set(key, "", v); err == nil {
			t.Errorf("%s took %v", key, v)
		}
	}
}

// The WebSocket's messages as the page reads and writes them
// (web/src/plugins/chat/protocol.ts).
func TestWireNames(t *testing.T) {
	for _, tc := range []struct {
		v    any
		want string
	}{
		{ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: "c0123456789abcdef", From: 7},
			`{"op":"attach","sub":"s1","m":"gpu","chat":"c0123456789abcdef","from":7}`},
		{ClientMessage{Op: OpDetach, Sub: "s1"}, `{"op":"detach","sub":"s1"}`},
		{ClientMessage{Op: OpCommand, ID: "k1", M: "gpu", Chat: "c1", Cmd: &chatproto.Command{Op: chatproto.OpCancel}},
			`{"op":"command","id":"k1","m":"gpu","chat":"c1","cmd":{"op":"cancel","id":""}}`},
		{ServerMessage{T: TAttached, Sub: "s1", Chat: &chatproto.Chat{ID: "c1", Kind: "codex"}, First: 1},
			`{"t":"attached","sub":"s1","chat":{"id":"c1","kind":"codex","title":"","cwd":"","sessionId":"","state":"","status":"",` +
				`"created":"0001-01-01T00:00:00Z","updated":"0001-01-01T00:00:00Z","seq":0,"seen":0,` +
				`"capabilities":{"images":false,"compact":false,"queue":false,"plan":false,"questions":false,"effort":false,"model":false,"cancelQueued":false}},"first":1}`},
		{attachedMsg{T: TAttached, Sub: "s1", Chat: json.RawMessage(`{"id":"c1"}`), First: 1}, `{"t":"attached","sub":"s1","chat":{"id":"c1"},"first":1}`},
		{ServerMessage{T: TEvent, Sub: "s1", Ev: &chatproto.Event{Seq: 3, T: chatproto.EventTurn, State: chatproto.TurnStart}},
			`{"t":"event","sub":"s1","ev":{"seq":3,"t":"turn","state":"start"}}`},
		{ServerMessage{T: TDetached, Sub: "s1", Error: &chatproto.Error{Code: CodeOffline, Message: "m"}},
			`{"t":"detached","sub":"s1","error":{"code":"offline","message":"m"}}`},
		{ServerMessage{T: TAck, ID: "k1"}, `{"t":"ack","id":"k1"}`},
		{ServerMessage{T: TAck, ID: "k1", Error: &chatproto.Error{Code: CodeReadOnly, Message: "m"}}, `{"t":"ack","id":"k1","error":{"code":"read_only","message":"m"}}`},
		{StatesData{T: DataStates, States: []chatproto.ChatState{{ID: "c1", Kind: "claude", State: chatproto.StateWorking, Status: chatproto.StatusWorking}}, Full: true, Rev: 4},
			`{"t":"states","states":[{"id":"c1","kind":"claude","title":"","cwd":"","state":"working","status":"working","updated":"0001-01-01T00:00:00Z","seq":0,"sessionId":""}],"full":true,"rev":4}`},
		{StatesSnapshot{Machines: map[string]StatesData{"gpu": {T: DataStates, States: []chatproto.ChatState{}, Full: true, Rev: 1}}},
			`{"machines":{"gpu":{"t":"states","states":[],"full":true,"rev":1}}}`},
	} {
		b, err := json.Marshal(tc.v)
		if err != nil || string(b) != tc.want {
			t.Errorf("got  %s, %v\nwant %s", b, err, tc.want)
		}
	}
	if MaxClientMessage <= chatproto.MaxPrompt || MaxSubs != 32 || MaxSubsPerMachine != 16 {
		t.Error("the limits")
	}
}

// The page's mirror of the protocol (web/src/plugins/chat/protocol.ts)
// lists every code an error it receives may have, by where it comes from,
// and the protocol's bounds the page relies on.
func TestProtocolMirror(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "src", "plugins", "chat", "protocol.ts"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	list := func(name string) []string {
		t.Helper()
		m := regexp.MustCompile(`export const ` + name + ` = \[([^\]]*)\]`).FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found", name)
		}
		var out []string
		for _, q := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(m[1], -1) {
			out = append(out, q[1])
		}
		return out
	}
	for name, codes := range map[string][]string{
		"HOST_CODES": {chatproto.CodeBadRequest, chatproto.CodeUnknownChat, chatproto.CodeTooMany, chatproto.CodeBusy,
			chatproto.CodeNotFound, chatproto.CodeStartFailed, chatproto.CodeProtocol, chatproto.CodeAuthRequired,
			chatproto.CodeUnsupported, chatproto.CodeTooLarge, chatproto.CodeEnded, chatproto.CodeFailed,
			chatproto.CodeInTerminal, chatproto.CodeHandedOff, chatproto.CodeSleeping, chatproto.CodeNotAllowed,
			chatproto.CodeUnsafeFolder},
		// The machine side's (internal/agent/plugin/chat) and the
		// transport's.
		"MACHINE_CODES": {codeNotRunning, "upgrading", "no_terminal_core", "start_failed", "transport"},
		"CORE_CODES": {CodeReadOnly, CodeOffline, CodeUnknownSub, CodeTooMany, CodeNotAttached, CodeLost,
			CodePluginDisabled, "timeout"},
	} {
		if got := list(name); !slices.Equal(got, codes) {
			t.Errorf("%s\n got %q\nwant %q", name, got, codes)
		}
	}
	for _, want := range []string{
		"export const MAX_STDERR = 2 << 10;",
		"export const MAX_SUBS = " + strconv.Itoa(MaxSubs) + ";",
		"export const MAX_SUBS_PER_MACHINE = " + strconv.Itoa(MaxSubsPerMachine) + ";",
		"export const MAX_PAGE_ID = " + strconv.Itoa(MaxPageID) + ";",
		"  full?: boolean;",
		"  allowFull?: boolean;",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("protocol.ts has no %q", want)
		}
	}
	if chatproto.MaxStderr != 2<<10 {
		t.Errorf("MaxStderr %d", chatproto.MaxStderr)
	}
	if got := list("REQUEST_OPS"); !slices.Contains(got, chatproto.OpTrust) || !slices.Contains(got, chatproto.OpUntrust) || !strings.Contains(src, "noCatchUp") {
		t.Errorf("REQUEST_OPS %q", got)
	}
}
