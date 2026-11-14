package main

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestKeys(t *testing.T) {
	web, mac := keys("web"), keys("macos")
	for _, k := range []string{"settings.terminal.fontSize", "settings.terminal.cursorStyle.bar", "settings.section.colors",
		"command.tab.new", "command.section.pane", "settings.gui.gpu.vglrun"} {
		if !slices.Contains(web, k) || !slices.Contains(mac, k) {
			t.Errorf("%s missing", k)
		}
	}
	// Web-only settings are not asked of the macOS application.
	if !slices.Contains(web, "settings.terminal.mathHover") || slices.Contains(mac, "settings.terminal.mathHover") {
		t.Error("platforms ignored")
	}
}

// The repository's file is current.
func TestRepository(t *testing.T) {
	if err := run(filepath.Join("..", ".."), true); err != nil {
		t.Fatal(err)
	}
}
