package uisettings

import (
	"slices"
	"testing"
)

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
