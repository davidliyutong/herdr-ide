package registry

import (
	"encoding/json"
	"testing"

	"veldr/internal/settings"
)

// A plugin's settings section names a plugin of the core, so the UIs can
// list it under the plugins and say when that plugin is off; the AI usage
// plugin's is one.
func TestPluginSectionsNameCorePlugins(t *testing.T) {
	ids := map[string]bool{}
	for _, p := range Plugins() {
		ids[p.ID()] = true
	}
	owned := map[string]string{}
	for _, sec := range settings.New("", Settings()...).Sections() {
		if sec.Plugin == "" {
			continue
		}
		if !ids[sec.Plugin] {
			t.Errorf("section %s names %q, which is not a plugin of the core", sec.ID, sec.Plugin)
		}
		owned[sec.ID] = sec.Plugin
	}
	if owned["usage"] != "usage" {
		t.Errorf("the usage section belongs to %q", owned["usage"])
	}
	b, err := json.Marshal(settings.Section{ID: "usage", Order: 66, Plugin: "usage"})
	if err != nil || string(b) != `{"id":"usage","order":66,"plugin":"usage"}` {
		t.Errorf("section as JSON: %s, %v", b, err)
	}
}
