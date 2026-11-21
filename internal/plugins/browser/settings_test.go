package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"herdr-ide/internal/settings"
)

// The links' setting: localhost in a pane by default, and the value of
// earlier versions (pane, their default) read as it, the file rewritten.
func TestLinksSetting(t *testing.T) {
	load := func(t *testing.T, content string) (*settings.Store, string) {
		t.Helper()
		path := filepath.Join(t.TempDir(), "settings.json")
		if content != "" {
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		st := settings.New(path, Settings)
		if err := st.Load(); err != nil {
			t.Fatal(err)
		}
		return st, path
	}
	if st, _ := load(t, ""); st.Get(SettingLinks) != LinksLoopback {
		t.Fatalf("default %v", st.Get(SettingLinks))
	}
	st, path := load(t, `{"browser.openLinks": "pane"}`)
	if st.Get(SettingLinks) != LinksLoopback || len(st.State().Problems) != 0 {
		t.Fatalf("pane read as %v, problems %v", st.Get(SettingLinks), st.State().Problems)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(b, &file); err != nil || file[SettingLinks] != LinksLoopback {
		t.Fatalf("file %s", b)
	}
	for _, v := range []string{LinksAll, LinksExternal, LinksLoopback} {
		if st, _ := load(t, `{"browser.openLinks": "`+v+`"}`); st.Get(SettingLinks) != v {
			t.Fatalf("%s read as %v", v, st.Get(SettingLinks))
		}
	}
	// Anything else is no value of the setting.
	if st, _ := load(t, `{"browser.openLinks": "tab"}`); st.Get(SettingLinks) != LinksLoopback || len(st.State().Problems) != 1 {
		t.Fatalf("tab read as %v, problems %v", st.Get(SettingLinks), st.State().Problems)
	}
}
