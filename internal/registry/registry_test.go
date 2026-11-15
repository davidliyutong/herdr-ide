package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/settings"
)

// The desktop app's old shortcut settings become keybinding rules, then
// leave the settings file instead of staying there as unknown settings.
func TestLegacyShortcutsLeaveTheSettings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"desktop-new-tab-key": "cmd+shift+t", "desktop-close-tab-key": "cmd+w", "appearance.theme": "dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	keys := keybindings.New(filepath.Join(dir, "keybindings.json"), Commands())
	if wrote, err := keys.MigrateDesktopShortcuts(path, true); err != nil || !wrote {
		t.Fatalf("migrated %v, %v", wrote, err)
	}
	store := settings.New(path, Settings()...)
	if err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if p := store.State().Problems; len(p) != 0 {
		t.Errorf("problems %+v", p)
	}
	var raw map[string]any
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 || raw["appearance.theme"] != "dark" {
		t.Errorf("settings file %s", b)
	}
	if store.String("appearance.theme", "") != "dark" {
		t.Error("the other settings were lost")
	}
}
