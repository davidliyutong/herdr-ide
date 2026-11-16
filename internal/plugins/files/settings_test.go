package files

import (
	"testing"

	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

func TestExcludePatterns(t *testing.T) {
	for _, ok := range [][]string{DefaultExclude, {"**/node_modules", "*.pyc", "[Tt]humbs.db", "?.tmp"}, {}} {
		if err := validExclude(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range [][]string{{""}, {"**/"}, {"a/b"}, {"src/**/x"}, {"[a"}, make([]string, 101)} {
		if err := validExclude(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The save method is a machine's own value, else the global one; without
// settings the agent's default (auto) applies.
func TestSaveMethodPerMachine(t *testing.T) {
	st := settings.New("", Settings)
	if got := methodFor(st, "m1"); got != "auto" {
		t.Fatalf("default %q", got)
	}
	if err := st.Set(SettingSaveMethod, "m2", "replace"); err != nil {
		t.Fatal(err)
	}
	if methodFor(st, "m1") != "auto" || methodFor(st, "m2") != "replace" {
		t.Fatalf("per machine: %q %q", methodFor(st, "m1"), methodFor(st, "m2"))
	}
	if err := st.Set(SettingSaveMethod, "", "bogus"); err == nil {
		t.Fatal("an unknown method accepted")
	}
	if methodFor(nil, "m1") != "" || saveMethod(&plugin.Call{}) != "" {
		t.Fatal("without settings")
	}
	// Every setting is in the plugin's section, which names the plugin.
	for _, d := range Settings.Defs {
		if d.Section != "files" {
			t.Errorf("%s in %s", d.Key, d.Section)
		}
	}
	if s := Settings.Sections[0]; s.ID != "files" || s.Plugin != New().ID() {
		t.Fatalf("section %+v", s)
	}
}
