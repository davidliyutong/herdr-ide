package chat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// The routes are declared, each as a reader or an audited change, and
// answer 501 not_implemented in this version.
func TestRoutes(t *testing.T) {
	var got []string
	for _, rt := range New().Routes() {
		desc := plugin.Pattern(ID, rt)
		if rt.Mutating {
			desc += " audited as chat." + rt.Audit
		}
		got = append(got, desc)
		w := httptest.NewRecorder()
		rt.Handler(&plugin.Call{}, w, httptest.NewRequest(rt.Method, "/", nil))
		var body map[string]string
		json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != http.StatusNotImplemented || body["error"] != CodeNotImplemented {
			t.Errorf("%s: %d %s", desc, w.Code, w.Body)
		}
	}
	want := []string{
		"GET /api/m/{id}/p/chat/agents",
		"GET /api/m/{id}/p/chat/chats",
		"GET /api/m/{id}/p/chat/sessions",
		"POST /api/m/{id}/p/chat/new audited as chat.new",
		"POST /api/m/{id}/p/chat/close audited as chat.close",
		"DELETE /api/m/{id}/p/chat/chat audited as chat.delete",
		"POST /api/m/{id}/p/chat/seen audited as chat.seen",
		"GET /api/p/chat/ws",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("routes:\n%s", strings.Join(got, "\n"))
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
	set(SettingIdleStopMinutes, "gpu", 1440.0)
	set(SettingMaxLive, "", 2.0)
	set(SettingMaxChats, "gpu", 50.0)
	set(SettingRetentionDays, "gpu", 365.0)
	set(SettingMaxTotalMB, "gpu", 2048.0)
	set(SettingMaxChatMB, "gpu", 8.0)
	want := chatproto.HostSettings{IdleStopMinutes: 1440, MaxLive: 2, MaxChats: 50, RetentionDays: 365,
		MaxTotalBytes: 2048 << 20, MaxChatBytes: 8 << 20, DefaultMode: chatproto.ModeFull}
	if got := HostSettings(st, "gpu"); got != want {
		t.Errorf("gpu: %+v", got)
	}
	if got := HostSettings(st, "other"); got.MaxLive != 2 || got.DefaultMode != chatproto.ModeDefault || got.MaxTotalBytes != 512<<20 {
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
		{ServerMessage{T: TEvent, Sub: "s1", Ev: &chatproto.Event{Seq: 3, T: chatproto.EventTurn, State: chatproto.TurnStart}},
			`{"t":"event","sub":"s1","ev":{"seq":3,"t":"turn","state":"start"}}`},
		{ServerMessage{T: TDetached, Sub: "s1", Error: &chatproto.Error{Code: CodeOffline, Message: "m"}},
			`{"t":"detached","sub":"s1","error":{"code":"offline","message":"m"}}`},
		{ServerMessage{T: TAck, ID: "k1"}, `{"t":"ack","id":"k1"}`},
		{ServerMessage{T: TAck, ID: "k1", Error: &chatproto.Error{Code: CodeReadOnly, Message: "m"}}, `{"t":"ack","id":"k1","error":{"code":"read_only","message":"m"}}`},
		{StatesData{T: DataStates, States: []chatproto.ChatState{{ID: "c1", Kind: "claude", State: chatproto.StateWorking, Status: chatproto.StatusWorking}}, Full: true},
			`{"t":"states","states":[{"id":"c1","kind":"claude","title":"","cwd":"","state":"working","status":"working","updated":"0001-01-01T00:00:00Z","seq":0,"sessionId":""}],"full":true}`},
	} {
		b, err := json.Marshal(tc.v)
		if err != nil || string(b) != tc.want {
			t.Errorf("got  %s, %v\nwant %s", b, err, tc.want)
		}
	}
	if MaxClientMessage <= chatproto.MaxPrompt || MaxSubs < 1 {
		t.Error("the limits")
	}
}
