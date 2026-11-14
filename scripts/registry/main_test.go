package main

import (
	"path/filepath"
	"slices"
	"strings"
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

// The reference's tables are written between their markers, list every
// setting and command, and a document without the markers is refused.
func TestFillReference(t *testing.T) {
	sb, se := markers("settings")
	cb, ce := markers("commands")
	doc := "intro\n" + sb + "\nSTALE-TABLE\n" + se + "\nmiddle\n" + cb + "\n" + ce + "\nend\n"
	out, err := fillReference([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"intro\n" + sb + "\n\n| Setting |", "| `terminal.fontSize` |", "| `gui.enabled` |", "`--gui`",
		"| `tab.new` | `terminal` | `ctrl+b c`, `cmd+t` |", se + "\nmiddle\n", "\nend\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	if strings.Contains(text, "STALE-TABLE") {
		t.Error("the old table was kept")
	}
	again, _ := fillReference(out)
	if string(again) != text {
		t.Error("filling twice changes the document")
	}
	if _, err := fillReference([]byte("no markers")); err == nil {
		t.Error("a document without markers was accepted")
	}
}
