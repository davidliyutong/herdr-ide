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
	for goos, want := range map[string][2]string{"darwin": {"cmd+t", "cmd+w"}, "linux": {"ctrl+shift+t", "ctrl+shift+w"}, "windows": {"ctrl+shift+t", "ctrl+shift+w"}} {
		d := defs(goos)
		if d[0].Key != SettingNewTab || d[0].Default != want[0] || d[1].Key != SettingCloseTab || d[1].Default != want[1] {
			t.Errorf("%s: defaults %q, %q", goos, d[0].Default, d[1].Default)
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
