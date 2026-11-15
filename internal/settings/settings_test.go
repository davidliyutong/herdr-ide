package settings

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func testModule() Module {
	min, max := Range(8, 32)
	return Module{
		Sections: []Section{{ID: "b", Order: 20}, {ID: "a", Order: 10}},
		Defs: []Def{
			{Key: "a.mode", Type: TypeEnum, Default: "x", Enum: []string{"x", "y"}, Section: "a", Order: 2, Flag: "mode"},
			{Key: "a.size", Type: TypeNumber, Default: 13, Min: min, Max: max, Section: "a", Order: 1},
			{Key: "a.lines", Type: TypeNumber, Default: 100, Integer: true, Section: "a", Order: 3},
			{Key: "b.on", Type: TypeBool, Default: true, Scope: ScopeRemoteMachine, Section: "b", Flag: "on"},
			{Key: "b.path", Type: TypeString, Default: "", Scope: ScopeMachine, Section: "b", Order: 1, Validate: func(v any) error {
				if s := v.(string); s != "" && !path.IsAbs(s) {
					return errors.New("not absolute")
				}
				return nil
			}},
			{Key: "b.color", Type: TypeColor, Default: "#000000", Section: "b", Order: 2},
			{Key: "b.palette", Type: TypeList, Item: TypeColor, Length: 2, Default: []string{"#000000", "#ffffff"}, Section: "b", Order: 3},
		},
		Migrations: []Migration{
			{From: "old-mode", To: "a.mode", Convert: Renamed},
			{From: "gui", To: "b.on", Convert: func(v any) (any, bool) {
				switch v {
				case "on":
					return true, true
				case "off":
					return false, true
				}
				return nil, false
			}},
			{From: "desktop-key"},
		},
	}
}

func newStore(t *testing.T, content string) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sub", "settings.json")
	if content != "" {
		os.MkdirAll(filepath.Dir(path), 0o700)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s := New(path, testModule())
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	return s, path
}

func readFile(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return out
}

func TestDefinitionsOrder(t *testing.T) {
	s := New("", testModule())
	var keys []string
	for _, d := range s.Definitions() {
		keys = append(keys, d.Key)
	}
	if got := strings.Join(keys, " "); got != "a.size a.mode a.lines b.on b.path b.color b.palette" {
		t.Errorf("order = %s", got)
	}
	if s.Sections()[0].ID != "a" {
		t.Errorf("sections = %v", s.Sections())
	}
	for _, bad := range []Def{
		{Key: "x", Type: TypeEnum, Default: "z", Enum: []string{"a"}, Section: "a"},
		{Key: "x", Type: TypeNumber, Default: 1, Section: "nope"},
		{Key: "a.mode", Type: TypeBool, Default: true, Section: "a"},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("%+v accepted", bad)
				}
			}()
			m := testModule()
			m.Defs = append(m.Defs, bad)
			New("", m)
		}()
	}
}

// Command line, then the machine's own value, then the global value, then
// the default.
func TestMergeOrder(t *testing.T) {
	s, path := newStore(t, "")
	if v := s.Get("a.size"); v != 13.0 {
		t.Fatalf("default = %v", v)
	}
	if err := s.Set("a.size", "", 15); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("b.on", "", false); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("b.on", "m1", true); err != nil {
		t.Fatal(err)
	}
	if s.Bool("b.on", "") || !s.Bool("b.on", "m1") || s.Bool("b.on", "m2") {
		t.Errorf("global=%v m1=%v m2=%v", s.Bool("b.on", ""), s.Bool("b.on", "m1"), s.Bool("b.on", "m2"))
	}
	st := s.State()
	if v := st.Values["b.on"]; v.Value != false || v.Source != SourceGlobal || v.Machines["m1"] != true {
		t.Errorf("state = %+v", v)
	}
	if v := st.Values["a.mode"]; v.Value != "x" || v.Source != SourceDefault {
		t.Errorf("state = %+v", v)
	}
	if fi, err := os.Stat(path); err != nil || runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode: %v %v", fi, err)
	}

	// Another store reads the same; a flag wins everywhere and locks.
	s2 := New(path, testModule())
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	s2.RegisterFlags(fs)
	if err := fs.Parse([]string{"--on", "off", "--mode=y"}); err != nil {
		t.Fatal(err)
	}
	if s2.Bool("b.on", "m1") || s2.String("a.mode", "") != "y" || s2.Get("a.size") != 15.0 {
		t.Errorf("flag: on/m1=%v mode=%v size=%v", s2.Bool("b.on", "m1"), s2.Get("a.mode"), s2.Get("a.size"))
	}
	if v := s2.State().Values["b.on"]; !v.Locked || v.Source != SourceFlag {
		t.Errorf("locked = %+v", v)
	}
	for _, m := range []string{"", "m1"} {
		if err := s2.Set("b.on", m, true); !errors.Is(err, ErrLocked) {
			t.Errorf("set locked (%q): %v", m, err)
		}
		if err := s2.Reset("b.on", m); !errors.Is(err, ErrLocked) {
			t.Errorf("reset locked (%q): %v", m, err)
		}
	}

	// Reset: the machine follows the global value, the global value the default.
	if err := s.Reset("b.on", "m1"); err != nil || s.Bool("b.on", "m1") {
		t.Errorf("reset machine: %v %v", err, s.Bool("b.on", "m1"))
	}
	if err := s.Reset("b.on", ""); err != nil || !s.Bool("b.on", "m1") {
		t.Errorf("reset global: %v", err)
	}
	if f := readFile(t, path); len(f) != 1 || f["a.size"] != 15.0 {
		t.Errorf("file after resets = %v", f)
	}
}

func TestValidation(t *testing.T) {
	s, _ := newStore(t, "")
	for _, c := range []struct {
		key, machine string
		value        any
		want         error
	}{
		{"a.mode", "", "z", ErrInvalid},
		{"a.mode", "", 1.0, ErrInvalid},
		{"a.size", "", 7.0, ErrInvalid},
		{"a.size", "", "13", ErrInvalid},
		{"a.lines", "", 1.5, ErrInvalid},
		{"b.on", "", "true", ErrInvalid},
		{"b.path", "", "relative", ErrInvalid},
		{"b.path", "", "/a\nb", ErrInvalid},
		// Every control character: C0, DEL and C1.
		{"b.path", "", "/a\tb", ErrInvalid},
		{"b.path", "", "/a\x1b[31mb", ErrInvalid},
		{"b.path", "", "/a\x00b", ErrInvalid},
		{"b.path", "", "/a\x7fb", ErrInvalid},
		{"b.path", "", "/a\u0085b", ErrInvalid},
		{"b.path", "", "/a\u009bb", ErrInvalid},
		{"b.color", "", "red", ErrInvalid},
		{"b.palette", "", []any{"#000000"}, ErrInvalid},
		{"b.palette", "", []any{"#000000", 3.0}, ErrInvalid},
		{"nope", "", "x", ErrUnknown},
		{"a.mode", "m1", "y", ErrScope},
		{"b.on", "[x]", true, ErrScope},
	} {
		if err := s.Set(c.key, c.machine, c.value); !errors.Is(err, c.want) {
			t.Errorf("Set(%s, %q, %v) = %v, want %v", c.key, c.machine, c.value, err, c.want)
		}
	}
	if err := s.Set("b.path", "", "/srv/données é"); err != nil {
		t.Errorf("printable non-ASCII path: %v", err)
	}
	if err := s.Set("b.color", "", "#ABCDEF"); err != nil || s.String("b.color", "") != "#abcdef" {
		t.Errorf("color: %v %q", err, s.String("b.color", ""))
	}
	if err := s.Set("b.palette", "", []any{"#FFFFFF", "#000000"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Get("b.palette").([]string); !slices.Equal(got, []string{"#ffffff", "#000000"}) {
		t.Errorf("palette = %v", got)
	}
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	s.RegisterFlags(fs)
	if err := fs.Parse([]string{"--mode", "z"}); err == nil {
		t.Error("invalid flag value accepted")
	}
}

// The file of earlier versions: flat strings, old key names, machines'
// values under "machines".
func TestMigration(t *testing.T) {
	s, path := newStore(t, `{
  "old-mode": "y",
  "gui": "off",
  "desktop-key": "cmd+t",
  "future": {"x": 1},
  "machines": {"m1": {"gui": "on", "other": "kept"}, "m2": {"gui": "maybe"}, "m3": null}
}`)
	if s.String("a.mode", "") != "y" || s.Bool("b.on", "") || !s.Bool("b.on", "m1") {
		t.Errorf("migrated values: mode=%v on=%v m1=%v", s.Get("a.mode"), s.Get("b.on"), s.GetFor("b.on", "m1"))
	}
	f := readFile(t, path)
	want := map[string]any{
		"a.mode":       "y",
		"b.on":         false,
		"future":       map[string]any{"x": 1.0},
		"[machine:m1]": map[string]any{"b.on": true, "other": "kept"},
		"[machine:m2]": map[string]any{"gui": "maybe"},
	}
	b1, _ := json.Marshal(f)
	b2, _ := json.Marshal(want)
	if string(b1) != string(b2) {
		t.Errorf("migrated file:\n%s\nwant\n%s", b1, b2)
	}
	// Global values come first in the file.
	raw, _ := os.ReadFile(path)
	if i, j := strings.Index(string(raw), `"b.on"`), strings.Index(string(raw), `"[machine:`); i < 0 || j < i {
		t.Errorf("order:\n%s", raw)
	}
	// Loading the migrated file changes nothing.
	before, _ := os.ReadFile(path)
	if _, err := newStoreAt(path); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Errorf("second load rewrote the file")
	}
}

func newStoreAt(path string) (*Store, error) {
	s := New(path, testModule())
	return s, s.Load()
}

// Keys this version does not know and values that do not validate are kept
// when the file is rewritten, reported as problems and count as unset.
func TestUnknownAndInvalidKept(t *testing.T) {
	s, path := newStore(t, `{"a.size": 99, "zzz": [1, 2], "a.mode": "y", "[machine:m1]": {"a.mode": "y", "b.on": "yes", "nope": 1}}`)
	if s.Get("a.size") != 13.0 || s.String("a.mode", "") != "y" {
		t.Errorf("size=%v mode=%v", s.Get("a.size"), s.Get("a.mode"))
	}
	var codes []string
	for _, p := range s.State().Problems {
		codes = append(codes, p.Code+":"+p.Machine+"/"+p.Key)
	}
	if got := strings.Join(codes, " "); got != "scope:m1/a.mode invalid:m1/b.on unknown:m1/nope invalid:/a.size unknown:/zzz" {
		t.Errorf("problems = %s", got)
	}
	if err := s.Set("b.on", "m1", false); err != nil {
		t.Fatal(err)
	}
	f := readFile(t, path)
	if f["a.size"] != 99.0 || f["zzz"] == nil {
		t.Errorf("file = %v", f)
	}
	m1 := f["[machine:m1]"].(map[string]any)
	if m1["b.on"] != false || m1["nope"] != 1.0 || m1["a.mode"] != "y" {
		t.Errorf("machine = %v", m1)
	}
}

// Edits of the file by hand are read again, with the changes reported; a
// file that is not JSON keeps the values and refuses writes until fixed.
func TestReload(t *testing.T) {
	s, path := newStore(t, `{"a.size": 14}`)
	var got [][]Change
	s.OnChange(func(c []Change) { got = append(got, c) })
	s.Reload()
	if len(got) != 0 {
		t.Fatalf("reload without a change notified: %v", got)
	}
	// An API change is not reloaded as an edit.
	if err := s.Set("a.mode", "", "y"); err != nil {
		t.Fatal(err)
	}
	s.Reload()
	if len(got) != 1 || got[0][0] != (Change{Key: "a.mode"}) {
		t.Fatalf("changes = %v", got)
	}
	got = nil

	edit := func(content string) {
		t.Helper()
		// A different size or a later time: either tells the file changed.
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		future := time.Now().Add(time.Duration(len(got)+1) * time.Second)
		os.Chtimes(path, future, future)
		s.Reload()
	}
	edit(`{"a.size": 16, "a.mode": "y", "[machine:m]": {"b.on": false}}`)
	if s.Get("a.size") != 16.0 || s.Bool("b.on", "m") || len(got) != 1 {
		t.Fatalf("after edit: size=%v on/m=%v changes=%v", s.Get("a.size"), s.Bool("b.on", "m"), got)
	}
	if c := got[0]; len(c) != 2 || c[0] != (Change{Key: "a.size"}) || c[1] != (Change{Key: "b.on", Machine: "m"}) {
		t.Errorf("changes = %v", c)
	}

	edit(`{"a.size": 17,`)
	if s.Get("a.size") != 16.0 {
		t.Errorf("broken file changed values: %v", s.Get("a.size"))
	}
	if p := s.State().Problems; len(p) != 1 || p[0].Code != "parse" {
		t.Errorf("problems = %+v", p)
	}
	if err := s.Set("a.size", "", 20); !errors.Is(err, ErrFile) {
		t.Errorf("write over a broken file: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != `{"a.size": 17,` {
		t.Errorf("broken file rewritten: %s", b)
	}
	edit(`{"a.size": 18}`)
	if s.Get("a.size") != 18.0 || len(s.State().Problems) != 0 || s.String("a.mode", "") != "x" {
		t.Errorf("fixed file: size=%v problems=%v", s.Get("a.size"), s.State().Problems)
	}

	// A change through the API keeps an edit made since the last read.
	os.WriteFile(path, []byte(`{"a.size": 19, "kept": true}`), 0o600)
	future := time.Now().Add(time.Hour)
	os.Chtimes(path, future, future)
	if err := s.Set("a.mode", "", "y"); err != nil {
		t.Fatal(err)
	}
	if f := readFile(t, path); f["a.size"] != 19.0 || f["kept"] != true || f["a.mode"] != "y" {
		t.Errorf("file = %v", f)
	}

	// A removed file is empty: the defaults.
	os.Remove(path)
	s.Reload()
	if s.Get("a.size") != 13.0 {
		t.Errorf("removed file: %v", s.Get("a.size"))
	}
}

func TestMemoryStore(t *testing.T) {
	s := New("", testModule())
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("b.path", "m", "/x"); err != nil || s.String("b.path", "m") != "/x" || s.String("b.path", "") != "" {
		t.Errorf("memory: %v %q", err, s.String("b.path", "m"))
	}
	s.Reload()
}
