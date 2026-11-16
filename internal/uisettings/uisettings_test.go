package uisettings

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"herdr-ide/internal/settings"
)

// Values of earlier versions change once, in place: the silent agents
// become a list, a scrollback above the maximum comes down to it, the
// VS Code panel's place goes; current values and unknown keys stay as they
// are.
func TestMigrateValues(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	os.WriteFile(path, []byte(`{"notifications.mutedAgents": "Droid, codex  gemini", "terminal.scrollback": 1000000, "layout.panelPosition": "bottom", "future.key": 1}`), 0o600)
	s := settings.New(path, Module)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if got := s.GetFor(MutedAgents, ""); !slices.Equal(got.([]string), []string{"droid", "codex", "gemini"}) {
		t.Errorf("silent agents %v", got)
	}
	if got := s.Get(Scrollback); got != float64(MaxScrollback) {
		t.Errorf("scrollback %v", got)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), `"future.key": 1`) || strings.Contains(string(b), `"Droid`) || strings.Contains(string(b), "panelPosition") {
		t.Errorf("file after migration:\n%s", b)
	}
	if p := s.State().Problems; len(p) != 1 || p[0].Key != "future.key" {
		t.Errorf("problems %v", p)
	}
	// Current values are not rewritten.
	before, _ := os.ReadFile(path)
	os.WriteFile(path, before, 0o600)
	s2 := settings.New(path, Module)
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Errorf("second load rewrote the file:\n%s", after)
	}
	os.WriteFile(path, []byte(`{"terminal.scrollback": 5000, "notifications.mutedAgents": []}`), 0o600)
	s3 := settings.New(path, Module)
	if err := s3.Load(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != `{"terminal.scrollback": 5000, "notifications.mutedAgents": []}` {
		t.Errorf("current values rewritten:\n%s", b)
	}
}

// Every color scheme and agent has a label in the UIs by its id; the
// schemes' colors are tested by the web UI (schemes.test.ts).
func TestOptions(t *testing.T) {
	if !slices.IsSorted(Agents) || !slices.IsSorted(Schemes[1:]) || Schemes[0] != "default" {
		t.Errorf("unsorted: %v %v", Agents, Schemes)
	}
}

// The color theme setting offers the design tokens' themes, the first by
// default.
func TestColorThemes(t *testing.T) {
	for _, d := range defs() {
		if d.Key != ColorTheme {
			continue
		}
		if !slices.Equal(d.Enum, tokenThemes) || d.Default != tokenThemes[0] {
			t.Errorf("enum %v default %v, tokens %v", d.Enum, d.Default, tokenThemes)
		}
		return
	}
	t.Fatal("no color theme setting")
}

func TestUndoCloseBounds(t *testing.T) {
	for _, d := range Module.Defs {
		if d.Key != UndoClose {
			continue
		}
		if d.Default != 5 || d.Min == nil || *d.Min != MinUndoClose || d.Max == nil || *d.Max != MaxUndoClose || !d.Integer {
			t.Errorf("layout.undoClose: %+v", d)
		}
		return
	}
	t.Error("layout.undoClose is not defined")
}
