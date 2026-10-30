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
	s.OnChange(func(k, v string) { changed = append(changed, k+"="+v) })
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
