package main

import (
	"path/filepath"
	"slices"
	"testing"

	"herdr-ide/internal/settings"
)

func TestKeys(t *testing.T) {
	web, mac := keys("web"), keys("macos")
	for _, k := range []string{"settings.terminal.fontSize", "settings.terminal.cursorStyle.bar", "settings.section.colors",
		"command.tab.new", "command.section.pane", "settings.gui.gpu.vglrun"} {
		if !slices.Contains(web, k) || !slices.Contains(mac, k) {
			t.Errorf("%s missing", k)
		}
	}
	// Both user interfaces show every setting.
	if !slices.Equal(web, mac) {
		t.Errorf("the clients differ:\nweb   %v\nmacos %v", web, mac)
	}
	// A setting limited to some clients is not asked of the others, nor is
	// a section it alone fills.
	defs := []settings.Def{{Key: "a.b", Section: "s", Enum: []string{"x"}, Platforms: []string{settings.PlatformWeb}}}
	sections := []settings.Section{{ID: "s"}}
	if got := keysOf(defs, sections, settings.PlatformWeb); !slices.Contains(got, "settings.a.b.x") || !slices.Contains(got, "settings.section.s") {
		t.Errorf("web keys %v", got)
	}
	if got := keysOf(defs, sections, settings.PlatformMacOS); slices.Contains(got, "settings.a.b") || slices.Contains(got, "settings.section.s") {
		t.Errorf("platforms ignored: %v", got)
	}
}

// The repository's file is current.
func TestRepository(t *testing.T) {
	if err := run(filepath.Join("..", ".."), true); err != nil {
		t.Fatal(err)
	}
}
