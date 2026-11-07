package shortcuts

import (
	"errors"
	"testing"

	"herdr-ide/internal/settings"
)

func TestValidate(t *testing.T) {
	for _, ok := range []string{"none", "cmd+t", "ctrl+w", "ctrl+shift+t", "alt+f4", "cmd+alt+bracketleft", "ctrl+1"} {
		if err := Validate(ok); err != nil {
			t.Errorf("Validate(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "t", "shift+t", "cmd+", "cmd+tt", "Cmd+T", "meta+t", "cmd+cmd+t", "ctrl+f25", "cmd+t+ctrl", "none+t"} {
		if err := Validate(bad); err == nil {
			t.Errorf("Validate(%q) accepted", bad)
		}
	}
}

func TestDefaults(t *testing.T) {
	keys := []string{SettingNewTab, SettingCloseTab, SettingSettings, SettingNewWS, SettingCode}
	for goos, want := range map[string][]string{
		"darwin":  {"cmd+t", "cmd+w", "cmd+comma", "cmd+n", "cmd+j"},
		"linux":   {"ctrl+shift+t", "ctrl+shift+w", "ctrl+comma", "ctrl+shift+n", "ctrl+shift+j"},
		"windows": {"ctrl+shift+t", "ctrl+shift+w", "ctrl+comma", "ctrl+shift+n", "ctrl+shift+j"},
	} {
		d := defs(goos)
		if len(d) != len(keys) {
			t.Fatalf("%s: %d settings", goos, len(d))
		}
		for i := range d {
			if d[i].Key != keys[i] || d[i].Default != want[i] {
				t.Errorf("%s: %s = %q, want %s = %q", goos, d[i].Key, d[i].Default, keys[i], want[i])
			}
		}
		for _, def := range d {
			if err := Validate(def.Default); err != nil {
				t.Errorf("%s: default %q: %v", def.Key, def.Default, err)
			}
		}
	}
}

func TestSetting(t *testing.T) {
	s := settings.New("", defs("darwin")...)
	if err := s.Set(SettingNewTab, "ctrl+shift+t"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(SettingCloseTab, "w"); !errors.Is(err, settings.ErrInvalid) {
		t.Fatalf("plain key: %v", err)
	}
	if err := s.Set(SettingCloseTab, None); err != nil || s.Get(SettingCloseTab) != None {
		t.Fatalf("none: %v %q", err, s.Get(SettingCloseTab))
	}
	if err := s.Set(SettingNewTab, ""); err != nil || s.Get(SettingNewTab) != "cmd+t" {
		t.Fatalf("reset: %v %q", err, s.Get(SettingNewTab))
	}
}
