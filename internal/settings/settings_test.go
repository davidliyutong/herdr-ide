package settings

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testDefs() []Def {
	return []Def{
		{Key: "mode", Kind: KindEnum, Default: "a", Options: []string{"a", "b"}},
		{Key: "path", Kind: KindString, Validate: func(v string) error {
			if v != "" && !filepath.IsAbs(v) {
				return errors.New("not absolute")
			}
			return nil
		}},
		{Key: "on", Kind: KindBool, Default: "false"},
	}
}

func TestSourcesAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "settings.json")
	s := New(path, testDefs()...)
	if got := s.Get("mode"); got != "a" {
		t.Fatalf("default = %q", got)
	}
	var changed []string
	s.OnChange(func(k, _, v string) { changed = append(changed, k+"="+v) })
	if err := s.Set("mode", "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("on", "true"); err != nil {
		t.Fatal(err)
	}
	if !s.Bool("on") || len(changed) != 2 || changed[0] != "mode=b" {
		t.Fatalf("on=%v changed=%v", s.Bool("on"), changed)
	}
	if st, err := os.Stat(path); err != nil || st.Mode().Perm()&0o077 != 0 {
		t.Fatalf("settings file: %v %v", st, err)
	}

	// A new store reads the file; a flag overrides and locks.
	s2 := New(path, testDefs()...)
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	s2.RegisterFlags(fs)
	if err := fs.Parse([]string{"--path", "/opt/x"}); err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Entry{}
	for _, e := range s2.List() {
		byKey[e.Key] = e
	}
	if e := byKey["mode"]; e.Value != "b" || e.Source != SourceSaved {
		t.Errorf("mode = %+v", e)
	}
	if e := byKey["path"]; e.Value != "/opt/x" || e.Source != SourceFlag {
		t.Errorf("path = %+v", e)
	}
	if err := s2.Set("path", "/other"); !errors.Is(err, ErrLocked) {
		t.Errorf("set locked: %v", err)
	}

	// Empty restores the default.
	if err := s2.Set("mode", ""); err != nil {
		t.Fatal(err)
	}
	if e := s2.List()[0]; e.Value != "a" || e.Source != SourceDefault {
		t.Errorf("after reset: %+v", e)
	}
}

func TestValidation(t *testing.T) {
	s := New("", testDefs()...)
	for _, c := range []struct{ k, v string }{
		{"mode", "c"},
		{"on", "maybe"},
		{"path", "relative"},
		{"path", "/a\nb"},
	} {
		if err := s.Set(c.k, c.v); !errors.Is(err, ErrInvalid) {
			t.Errorf("Set(%q, %q) = %v, want ErrInvalid", c.k, c.v, err)
		}
	}
	if err := s.Set("nope", "x"); !errors.Is(err, ErrUnknown) {
		t.Errorf("unknown: %v", err)
	}
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	fs.SetOutput(new(nopWriter))
	s.RegisterFlags(fs)
	if err := fs.Parse([]string{"--mode", "z"}); err == nil {
		t.Error("invalid flag value accepted")
	}
}

func TestInvalidSavedValueIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"mode":"zzz","future":"kept"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(path, testDefs()...)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if got := s.Get("mode"); got != "a" {
		t.Errorf("mode = %q", got)
	}
	if err := s.Set("on", "true"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if want := `"future": "kept"`; !strings.Contains(string(b), want) {
		t.Errorf("unknown key dropped: %s", b)
	}
}

type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }

// Machines can have their own value of a per-machine setting; the command
// line still wins everywhere, and the values survive a reload.
func TestPerMachine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte(`{"gui":"on","future":{"x":1}}`), 0o600)
	defs := []Def{
		{Key: "gui", Kind: KindEnum, Default: "on", Options: []string{"on", "off"}, PerMachine: ScopeRemote},
		{Key: "mode", Kind: KindEnum, Default: "a", Options: []string{"a", "b"}},
	}
	s := New(path, defs...)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	var changes []string
	s.OnChange(func(k, m, v string) { changes = append(changes, k+"/"+m+"="+v) })
	if err := s.SetFor("gui", "m1", "off"); err != nil {
		t.Fatal(err)
	}
	if s.GetFor("gui", "m1") != "off" || s.GetFor("gui", "m2") != "on" || s.Get("gui") != "on" {
		t.Fatalf("m1=%s m2=%s global=%s", s.GetFor("gui", "m1"), s.GetFor("gui", "m2"), s.Get("gui"))
	}
	if err := s.SetFor("mode", "m1", "b"); !errors.Is(err, ErrUnknown) {
		t.Errorf("per-machine value of a global setting: %v", err)
	}
	if err := s.SetFor("gui", "m1", "maybe"); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid value: %v", err)
	}
	list := s.List()
	if list[0].PerMachine != ScopeRemote || list[0].Machines["m1"] != "off" || list[1].Machines != nil {
		t.Errorf("list = %+v", list)
	}

	// Saved with the other keys, including ones this version does not know.
	reloaded := New(path, defs...)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if reloaded.GetFor("gui", "m1") != "off" {
		t.Error("machine value not saved")
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), `"future"`) {
		t.Errorf("unknown entry dropped: %s", b)
	}

	// "" goes back to the global value.
	if err := s.SetFor("gui", "m1", ""); err != nil || s.GetFor("gui", "m1") != "on" {
		t.Errorf("reset: %v, %s", err, s.GetFor("gui", "m1"))
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), `"machines"`) {
		t.Errorf("empty machine values kept: %s", b)
	}
	if strings.Join(changes, " ") != "gui/m1=off gui/m1=on" {
		t.Errorf("changes = %v", changes)
	}

	// A flag fixes the value for every machine.
	locked := New(path, defs...)
	locked.Load()
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	locked.RegisterFlags(fs)
	fs.Parse([]string{"--gui", "off"})
	if err := locked.SetFor("gui", "m1", "on"); !errors.Is(err, ErrLocked) {
		t.Errorf("flag did not lock the machine value: %v", err)
	}
	if locked.GetFor("gui", "m1") != "off" {
		t.Error("flag does not win over the machine value")
	}
}

// A hand-edited file cannot break per-machine values: null maps load as
// empty, and entries this version does not understand survive a save.
func TestPerMachineFileEdits(t *testing.T) {
	defs := []Def{{Key: "gui", Kind: KindEnum, Default: "on", Options: []string{"on", "off"}, PerMachine: ScopeRemote}}
	for _, content := range []string{`{"machines":null}`, `{"machines":{"a":null}}`} {
		path := filepath.Join(t.TempDir(), "settings.json")
		os.WriteFile(path, []byte(content), 0o600)
		s := New(path, defs...)
		if err := s.Load(); err != nil {
			t.Fatal(err)
		}
		if err := s.SetFor("gui", "a", "off"); err != nil || s.GetFor("gui", "a") != "off" {
			t.Errorf("%s: %v, %s", content, err, s.GetFor("gui", "a"))
		}
	}
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte(`{"machines":{"a":{"gui":"off","x":1},"b":{"gui":7}}}`), 0o600)
	s := New(path, defs...)
	s.Load()
	if s.GetFor("gui", "a") != "off" || s.GetFor("gui", "b") != "on" {
		t.Errorf("a=%s b=%s", s.GetFor("gui", "a"), s.GetFor("gui", "b"))
	}
	if err := s.SetFor("gui", "c", "off"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	for _, keep := range []string{`"x": 1`, `"gui": 7`, `"c"`} {
		if !strings.Contains(string(b), keep) {
			t.Errorf("saved file lacks %s: %s", keep, b)
		}
	}
}
