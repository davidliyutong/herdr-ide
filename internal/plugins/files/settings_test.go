package files

import (
	"testing"
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

// Every setting is in the plugin's section, which names the plugin.
func TestSettingsSection(t *testing.T) {
	for _, d := range Settings.Defs {
		if d.Section != "files" {
			t.Errorf("%s in %s", d.Key, d.Section)
		}
	}
	if s := Settings.Sections[0]; s.ID != "files" || s.Plugin != New().ID() {
		t.Fatalf("section %+v", s)
	}
}
