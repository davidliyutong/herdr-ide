package keybindings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

// The defaults keep the prefix keymap and the applications' direct
// shortcuts.
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
		{PlatformMac, "tab.new", []string{"ctrl+b c", "cmd+t"}},
		{PlatformPC, "tab.new", []string{"ctrl+b c", "ctrl+shift+t"}},
		{PlatformMacBrowser, "tab.new", []string{"ctrl+b c"}},
		{PlatformPCBrowser, "find.open", []string{"ctrl+shift+f"}},
		{PlatformMacBrowser, "find.open", []string{"cmd+f"}},
		{PlatformMac, "pane.close", []string{"ctrl+b x", "cmd+w"}},
		{PlatformPC, "tab.close", []string{"ctrl+b shift+x", "ctrl+shift+w"}},
		{PlatformMac, "app.commandPalette", []string{"ctrl+b space", "ctrl+b g"}},
		{PlatformPCBrowser, "tab.select9", []string{"ctrl+b 9"}},
		{PlatformMac, "view.toggleCode", []string{"cmd+j"}},
		{PlatformPCBrowser, "view.toggleCode", nil},
	} {
		if got := find(c.platform, c.command); !slices.Equal(got, c.keys) {
			t.Errorf("%s %s = %v, want %v", c.platform, c.command, got, c.keys)
		}
	}
	// The prefix chords: the terminal keymap (tabs 1 to 9 each a command)
	// and the IDE's own.
	chords := 0
	for _, r := range s.Defaults(PlatformPCBrowser) {
		if strings.HasPrefix(r.Key, "ctrl+b ") {
			chords++
		}
	}
	if chords != 37 {
		t.Errorf("%d prefix chords", chords)
	}
	// No platform has conflicting defaults.
	for _, p := range Platforms {
		if c := Conflicts(s.Defaults(p)); len(c) != 0 {
			t.Errorf("%s: default conflicts %v", p, c)
		}
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
		`{"key": "ctrl+b x", "command": "tab.close"}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	st := s.State()
	if got := effective(st, PlatformMac, "tab.new"); !slices.Equal(got, []string{"ctrl+b c@terminal", "cmd+shift+t@terminal"}) {
		t.Errorf("tab.new = %v", got)
	}
	// User rules apply on every platform.
	if got := effective(st, PlatformPC, "tab.new"); !slices.Equal(got, []string{"ctrl+b c@terminal", "ctrl+shift+t@terminal", "cmd+shift+t@terminal"}) {
		t.Errorf("tab.new on pc = %v", got)
	}
	if got := effective(st, PlatformMac, "pane.zoom"); !slices.Equal(got, []string{"ctrl+k z@always"}) {
		t.Errorf("pane.zoom = %v", got)
	}
	if len(st.Problems) != 1 || st.Problems[0].Index != 4 || st.Problems[0].Code != "unknown" {
		t.Errorf("problems = %+v", st.Problems)
	}
	// ctrl+b x closes the pane and the tab now.
	if c := st.Conflicts[PlatformMac]; len(c) != 1 || c[0].Key != "ctrl+b x" || !slices.Equal(c[0].Commands, []string{"pane.close", "tab.close"}) {
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
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
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
	})
	want := []Conflict{
		{Key: "cmd+j", Commands: []string{"d", "e"}},
		{Key: "ctrl+b", Commands: []string{"a", "b"}, Prefix: true},
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
	if got := effective(s.State(), PlatformPCBrowser, "tab.new"); !slices.Equal(got, []string{"ctrl+b c@terminal", "ctrl+k m@terminal"}) || notified != 1 {
		t.Errorf("after edit: %v (%d)", got, notified)
	}
	edit(`[{"key": `)
	if got := effective(s.State(), PlatformPCBrowser, "tab.new"); len(got) != 2 || s.State().Problems[0].Code != "parse" {
		t.Errorf("broken file: %v %v", got, s.State().Problems)
	}
	if err := s.SetUser(nil); !errors.Is(err, ErrFile) {
		t.Errorf("write over a broken file: %v", err)
	}
	edit(`[]`)
	if got := effective(s.State(), PlatformPCBrowser, "tab.new"); len(got) != 1 || len(s.State().Problems) != 0 {
		t.Errorf("fixed file: %v", got)
	}
}

// Shortcuts the desktop app kept in settings become rules once.
func TestMigrateDesktopShortcuts(t *testing.T) {
	dir := t.TempDir()
	settingsFile := filepath.Join(dir, "settings.json")
	os.WriteFile(settingsFile, []byte(`{"desktop-new-tab-key": "cmd+shift+t", "desktop-settings-key": "none",
		"desktop-close-tab-key": "cmd+w", "desktop-toggle-code-key": "nonsense", "gui": "on"}`), 0o600)
	path := filepath.Join(dir, "keybindings.json")
	s := New(path, Commands)
	if ok, err := s.MigrateDesktopShortcuts(settingsFile, true); !ok || err != nil {
		t.Fatalf("migrate: %v %v", ok, err)
	}
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	st := s.State()
	if got := effective(st, PlatformMac, "tab.new"); !slices.Equal(got, []string{"ctrl+b c@terminal", "cmd+shift+t@terminal"}) {
		t.Errorf("tab.new = %v", got)
	}
	if got := effective(st, PlatformMac, "app.settings"); !slices.Equal(got, []string{"ctrl+b comma@terminal"}) {
		t.Errorf("app.settings = %v", got)
	}
	if got := effective(st, PlatformMac, "tab.close"); !slices.Equal(got, []string{"ctrl+b shift+x@terminal"}) {
		t.Errorf("tab.close = %v", got)
	}
	// Once only.
	if ok, _ := s.MigrateDesktopShortcuts(settingsFile, true); ok {
		t.Error("migrated twice")
	}
	// Nothing changed from the defaults: no file.
	os.WriteFile(settingsFile, []byte(`{"desktop-new-tab-key": "ctrl+shift+t"}`), 0o600)
	other := New(filepath.Join(dir, "other.json"), Commands)
	if ok, _ := other.MigrateDesktopShortcuts(settingsFile, false); ok {
		t.Error("defaults migrated")
	}
}
