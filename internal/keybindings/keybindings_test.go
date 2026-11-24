package keybindings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"
)

// The vectors every client's parser runs (design/testdata/keys/parse.json).
func TestParseVectors(t *testing.T) {
	b, err := os.ReadFile("../../design/testdata/keys/parse.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct{ Input, Key, Error string }
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 30 {
		t.Fatalf("%d cases", len(v.Cases))
	}
	for _, c := range v.Cases {
		got, err := Normalize(c.Input)
		var pe *ParseError
		switch {
		case c.Error != "":
			if !errors.As(err, &pe) || pe.Code != c.Error {
				t.Errorf("Normalize(%q) = %q, %v; want error %s", c.Input, got, err, c.Error)
			}
		case err != nil || got != c.Key:
			t.Errorf("Normalize(%q) = %q, %v; want %q", c.Input, got, err, c.Key)
		default:
			// The canonical form reads back as itself.
			if again, err := Normalize(got); err != nil || again != got {
				t.Errorf("Normalize(%q) = %q, %v", got, again, err)
			}
		}
	}
}

// The defaults are the applications' direct shortcuts, Ctrl+B for escaping
// focus from a pane to app chrome, and a few keys browsers leave to pages.
func TestDefaults(t *testing.T) {
	s := New("", Commands)
	find := func(platform, command string) []string {
		var out []string
		for _, r := range s.Defaults(platform) {
			if r.Command == command {
				out = append(out, r.Key)
			}
		}
		return out
	}
	for _, c := range []struct {
		platform, command string
		keys              []string
	}{
		{PlatformMac, "tab.new", []string{"cmd+t"}},
		{PlatformWindows, "tab.new", []string{"ctrl+shift+t"}},
		{PlatformLinux, "tab.new", []string{"ctrl+shift+t"}},
		{PlatformMacBrowser, "tab.new", nil},
		{PlatformWindowsBrowser, "find.open", []string{"ctrl+shift+f"}},
		{PlatformLinuxBrowser, "find.open", []string{"ctrl+shift+f"}},
		{PlatformMacBrowser, "find.open", []string{"cmd+f"}},
		{PlatformMac, "pane.close", []string{"cmd+w"}},
		{PlatformWindows, "tab.close", []string{"ctrl+shift+w"}},
		{PlatformLinux, "tab.close", []string{"ctrl+shift+w"}},
		{PlatformMac, "app.commandPalette", []string{"cmd+shift+p"}},
		{PlatformWindows, "app.commandPalette", []string{"ctrl+shift+p"}},
		{PlatformLinux, "app.commandPalette", []string{"ctrl+shift+p"}},
		{PlatformMacBrowser, "app.commandPalette", []string{"cmd+k"}},
		{PlatformWindowsBrowser, "app.commandPalette", nil},
		{PlatformLinuxBrowser, "app.commandPalette", nil},
		{PlatformMac, "app.keyboardShortcuts", []string{"cmd+slash"}},
		{PlatformMacBrowser, "app.keyboardShortcuts", []string{"cmd+slash"}},
		{PlatformWindows, "app.keyboardShortcuts", []string{"ctrl+shift+slash"}},
		{PlatformLinux, "app.keyboardShortcuts", []string{"ctrl+shift+slash"}},
		{PlatformWindowsBrowser, "app.keyboardShortcuts", []string{"ctrl+shift+slash"}},
		{PlatformLinuxBrowser, "app.keyboardShortcuts", []string{"ctrl+shift+slash"}},
		{PlatformWindowsBrowser, "tab.select9", nil},
		{PlatformLinuxBrowser, "tab.select9", nil},
		{PlatformMacBrowser, "tab.select1", nil},
		{PlatformMac, "tab.select1", []string{"cmd+1"}},
		{PlatformMac, "tab.select9", []string{"cmd+9"}},
		{PlatformWindows, "tab.select2", []string{"alt+2"}},
		{PlatformLinux, "tab.select2", []string{"alt+2"}},
		{PlatformMac, "tab.close", []string{"cmd+shift+w"}},
		{PlatformMac, "tab.next", []string{"cmd+shift+bracketright", "ctrl+tab"}},
		{PlatformWindows, "tab.previous", []string{"ctrl+shift+tab"}},
		{PlatformLinux, "tab.previous", []string{"ctrl+shift+tab", "ctrl+pageup"}},
		{PlatformMac, "pane.zoom", []string{"cmd+shift+enter"}},
		{PlatformMac, "pane.leave", []string{"ctrl+b"}},
		{PlatformWindows, "pane.leave", []string{"ctrl+b"}},
		{PlatformLinux, "pane.leave", []string{"ctrl+b"}},
		{PlatformMacBrowser, "pane.leave", []string{"ctrl+b"}},
		{PlatformWindowsBrowser, "pane.leave", []string{"ctrl+b"}},
		{PlatformLinuxBrowser, "pane.leave", []string{"ctrl+b"}},
		{PlatformMac, "pane.splitRight", []string{"cmd+d"}},
		{PlatformWindows, "pane.splitRight", []string{"alt+shift+equal"}},
		{PlatformLinux, "pane.splitRight", []string{"ctrl+shift+d"}},
		{PlatformMac, "pane.splitDown", []string{"cmd+shift+d"}},
		{PlatformWindows, "pane.splitDown", []string{"alt+shift+minus"}},
		{PlatformLinux, "pane.splitDown", []string{"ctrl+shift+o"}},
		{PlatformMac, "pane.focusLeft", []string{"cmd+alt+left"}},
		{PlatformWindows, "pane.focusLeft", []string{"alt+shift+left"}},
		{PlatformLinux, "pane.focusLeft", []string{"alt+shift+left"}},
		{PlatformMac, "pane.focusNext", nil},
		{PlatformMac, "pane.back", []string{"cmd+bracketleft"}},
		{PlatformMac, "pane.forward", []string{"cmd+bracketright"}},
		{PlatformWindows, "pane.back", []string{"alt+left"}},
		{PlatformLinux, "pane.back", []string{"alt+left"}},
		{PlatformWindows, "pane.forward", []string{"alt+right"}},
		{PlatformLinux, "pane.forward", []string{"alt+right"}},
		{PlatformMac, "pane.undoClose", []string{"cmd+z"}},
		{PlatformWindows, "pane.undoClose", []string{"ctrl+shift+z"}},
		{PlatformLinux, "pane.undoClose", []string{"ctrl+shift+z"}},
		{PlatformWindows, "workspace.next", []string{"ctrl+shift+pagedown"}},
		{PlatformLinux, "workspace.next", []string{"ctrl+alt+down"}},
		{PlatformMacBrowser, "pane.zoom", nil},
		{PlatformMac, "code.open", []string{"cmd+j"}},
		{PlatformWindows, "code.open", []string{"ctrl+shift+j"}},
		{PlatformLinux, "code.open", []string{"ctrl+shift+j"}},
		{PlatformLinuxBrowser, "code.open", nil},
		// Browsers zoom pages with these keys themselves.
		{PlatformMac, "view.zoomIn", []string{"cmd+shift+equal", "cmd+equal"}},
		{PlatformWindows, "view.zoomOut", []string{"ctrl+minus"}},
		{PlatformLinux, "view.zoomReset", []string{"ctrl+0"}},
		{PlatformMacBrowser, "view.zoomIn", nil},
		{PlatformLinuxBrowser, "view.zoomReset", nil},
	} {
		if got := find(c.platform, c.command); !slices.Equal(got, c.keys) {
			t.Errorf("%s %s = %v, want %v", c.platform, c.command, got, c.keys)
		}
	}
	for _, p := range Platforms {
		for _, r := range s.Defaults(p) {
			seq, err := Parse(r.Key)
			if err != nil || len(seq) != 1 {
				t.Errorf("%s: %s's default %q is not a single stroke", p, r.Command, r.Key)
				continue
			}
			// Keys programs in terminals read: Ctrl or Alt with a letter
			// alone, function keys (except pane.leave's ctrl+b focus escape).
			k := seq[0]
			if r.Command != "pane.leave" && ((k.Ctrl || k.Alt) && !k.Cmd && !k.Shift && len(k.Key) == 1 && k.Key[0] >= 'a' && k.Key[0] <= 'z' || functionKey.MatchString(k.Key)) {
				t.Errorf("%s: %s's default %q is a key of terminal programs", p, r.Command, r.Key)
			}
		}
		// No platform has conflicting defaults.
		if c := Conflicts(s.Defaults(p)); len(c) != 0 {
			t.Errorf("%s: default conflicts %v", p, c)
		}
		// The command palette and the list of shortcuts are on the keyboard
		// wherever a key is left for them.
		if len(find(p, "app.keyboardShortcuts")) == 0 || (p != PlatformWindowsBrowser && p != PlatformLinuxBrowser && len(find(p, "app.commandPalette")) == 0) {
			t.Errorf("%s: no key for the command palette or the shortcuts", p)
		}
	}
}

// Chords bound in the user's file still work, ctrl+b chords included once
// pane.leave is unbound (otherwise ctrl+b reports a prefix conflict).
func TestUserChords(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "keybindings.json"), Commands)
	err := s.SetUser(rules(t,
		`{"key": "ctrl+b", "command": "-pane.leave"}`,
		`{"key": "ctrl+b c", "command": "tab.new"}`,
		`{"key": "ctrl+b shift+slash", "command": "app.keyboardShortcuts"}`,
		`{"key": "ctrl+b x", "command": "pane.close"}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	st := s.State()
	for _, p := range Platforms {
		if got := effective(st, p, "tab.new"); !slices.Contains(got, "ctrl+b c@terminal") {
			t.Errorf("%s: tab.new = %v", p, got)
		}
		if c := st.Conflicts[p]; len(c) != 0 {
			t.Errorf("%s: conflicts %v", p, c)
		}
	}
	if got := effective(st, PlatformLinuxBrowser, "app.keyboardShortcuts"); !slices.Equal(got, []string{"ctrl+shift+slash@terminal", "ctrl+b shift+slash@terminal"}) {
		t.Errorf("app.keyboardShortcuts = %v", got)
	}
	// Keeping ctrl+b bound to pane.leave while adding a ctrl+b chord reports a prefix conflict.
	if err := s.SetUser(rules(t, `{"key": "ctrl+b c", "command": "tab.new"}`)); err != nil {
		t.Fatal(err)
	}
	if c := s.State().Conflicts[PlatformMac]; len(c) != 1 || !c[0].Prefix || c[0].Key != "ctrl+b" {
		t.Errorf("expected ctrl+b prefix conflict, got %+v", c)
	}
}

func rules(t *testing.T, list ...string) []json.RawMessage {
	t.Helper()
	out := make([]json.RawMessage, len(list))
	for i, r := range list {
		out[i] = json.RawMessage(r)
	}
	return out
}

func effective(st State, platform, command string) []string {
	var out []string
	for _, r := range st.Effective[platform] {
		if r.Command == command {
			out = append(out, r.Key+"@"+string(r.When))
		}
	}
	return out
}

// User rules add bindings and remove defaults ("-<command>"), in order; a
// rule for a command this version does not know is kept but does nothing.
func TestUserRules(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keybindings.json")
	s := New(path, Commands)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	changed := 0
	s.OnChange(func() { changed++ })
	err := s.SetUser(rules(t,
		`{"key": "Cmd+Shift+T", "command": "tab.new"}`,
		`{"key": "cmd+t", "command": "-tab.new"}`,
		`{"command": "-pane.zoom"}`,
		`{"key": "ctrl+k z", "command": "pane.zoom", "when": "always"}`,
		`{"key": "ctrl+k x", "command": "future.command", "args": {"x": 1}}`,
		`{"key": "cmd+w", "command": "tab.close"}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	st := s.State()
	if got := effective(st, PlatformMac, "tab.new"); !slices.Equal(got, []string{"cmd+shift+t@terminal"}) {
		t.Errorf("tab.new = %v", got)
	}
	// User rules apply on every platform.
	if got := effective(st, PlatformWindows, "tab.new"); !slices.Equal(got, []string{"ctrl+shift+t@terminal", "cmd+shift+t@terminal"}) {
		t.Errorf("tab.new on windows = %v", got)
	}
	if got := effective(st, PlatformLinux, "tab.new"); !slices.Equal(got, []string{"ctrl+shift+t@terminal", "cmd+shift+t@terminal"}) {
		t.Errorf("tab.new on linux = %v", got)
	}
	if got := effective(st, PlatformMac, "pane.zoom"); !slices.Equal(got, []string{"ctrl+k z@always"}) {
		t.Errorf("pane.zoom = %v", got)
	}
	if len(st.Problems) != 1 || st.Problems[0].Index != 4 || st.Problems[0].Code != "unknown" {
		t.Errorf("problems = %+v", st.Problems)
	}
	// cmd+w closes the pane and the tab now.
	if c := st.Conflicts[PlatformMac]; len(c) != 1 || c[0].Key != "cmd+w" || !slices.Equal(c[0].Commands, []string{"pane.close", "tab.close"}) {
		t.Errorf("conflicts = %+v", c)
	}
	if changed != 1 {
		t.Errorf("changed = %d", changed)
	}

	// The file keeps every entry as written, unknown ones included.
	var file []map[string]any
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &file); err != nil || len(file) != 6 || file[4]["args"] == nil || file[0]["key"] != "Cmd+Shift+T" {
		t.Errorf("file = %s (%v)", b, err)
	}
	if fi, _ := os.Stat(path); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}

	for _, bad := range [][]json.RawMessage{
		rules(t, `{"key": "x", "command": "tab.new"}`),
		rules(t, `{"key": "ctrl+x", "command": "tab new"}`),
		rules(t, `{"key": "ctrl+x", "command": "tab.new", "when": "sometimes"}`),
		rules(t, `{"key": "ctrl+x"}`),
		rules(t, `"ctrl+x"`),
		rules(t, `{"key": "", "command": "tab.new"}`),
	} {
		if err := s.SetUser(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("SetUser(%s) = %v", bad, err)
		}
	}
	if len(s.State().User) != 6 {
		t.Error("a refused change replaced the rules")
	}
}

func TestConflicts(t *testing.T) {
	got := Conflicts([]Rule{
		{Key: "ctrl+b", Command: "a", When: WhenTerminal},
		{Key: "ctrl+b c", Command: "b", When: WhenTerminal},
		{Key: "ctrl+b c", Command: "c", When: WhenVSCode},
		{Key: "cmd+j", Command: "d", When: WhenAlways},
		{Key: "cmd+j", Command: "e", When: WhenVSCode},
		{Key: "cmd+k", Command: "f", When: WhenDialog},
		{Key: "cmd+k", Command: "g", When: WhenTerminal},
		{Key: "cmd+e", Command: "h", When: WhenEditor},
		{Key: "cmd+e", Command: "i", When: WhenTerminal},
		{Key: "cmd+l", Command: "j", When: WhenEditor},
		{Key: "cmd+l", Command: "k", When: WhenDialog},
	})
	// The main UI's bindings apply in VS Code panes too: b and c meet there;
	// those outside terminals (editor) meet the main UI's, not dialogs'.
	want := []Conflict{
		{Key: "cmd+e", Commands: []string{"h", "i"}},
		{Key: "cmd+j", Commands: []string{"d", "e"}},
		{Key: "ctrl+b", Commands: []string{"a", "b", "c"}, Prefix: true},
		{Key: "ctrl+b c", Commands: []string{"b", "c"}},
	}
	b1, _ := json.Marshal(got)
	b2, _ := json.Marshal(want)
	if string(b1) != string(b2) {
		t.Errorf("conflicts = %s, want %s", b1, b2)
	}
}

// Edits by hand are read again; a file that is not an array keeps the rules
// and is not written over.
func TestReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keybindings.json")
	os.WriteFile(path, []byte(`[{"key": "ctrl+k n", "command": "tab.new"}]`), 0o600)
	s := New(path, Commands)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	notified := 0
	s.OnChange(func() { notified++ })
	edit := func(content string) {
		os.WriteFile(path, []byte(content), 0o600)
		future := time.Now().Add(time.Duration(notified+1) * time.Minute)
		os.Chtimes(path, future, future)
		s.Reload()
	}
	edit(`[{"key": "ctrl+k m", "command": "tab.new"}]`)
	if got := effective(s.State(), PlatformLinux, "tab.new"); !slices.Equal(got, []string{"ctrl+shift+t@terminal", "ctrl+k m@terminal"}) || notified != 1 {
		t.Errorf("after edit: %v (%d)", got, notified)
	}
	edit(`[{"key": `)
	if got := effective(s.State(), PlatformLinux, "tab.new"); len(got) != 2 || s.State().Problems[0].Code != "parse" {
		t.Errorf("broken file: %v %v", got, s.State().Problems)
	}
	if err := s.SetUser(nil); !errors.Is(err, ErrFile) {
		t.Errorf("write over a broken file: %v", err)
	}
	edit(`[]`)
	if got := effective(s.State(), PlatformLinux, "tab.new"); len(got) != 1 || len(s.State().Problems) != 0 {
		t.Errorf("fixed file: %v", got)
	}
}
