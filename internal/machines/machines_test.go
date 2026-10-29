package machines

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSpecsFromHerdrCatalog(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	client := filepath.Join(state, "herdr", "client")
	os.MkdirAll(filepath.Join(client, "ssh-metadata"), 0o755)
	os.WriteFile(filepath.Join(client, "endpoints.json"), []byte(`{"version":1,"selected_profile":"a1","ssh":[
		{"id":"a1","label":"gpu","target":"gpu-host","session":"default","enabled":true},
		{"id":"b2","label":"","target":"robot","session":"","enabled":false}]}`), 0o644)
	os.WriteFile(filepath.Join(client, "ssh-metadata", "a1.json"), []byte(`{"version":1,"target":"gpu-host","session":"default","metadata":{"os":"linux","executable":"/home/u/.local/bin/herdr"}}`), 0o644)

	specs := LoadSpecs("dev", []Spec{{Target: "extra"}, {ID: "a1", Target: "dup"}})
	if len(specs) != 4 {
		t.Fatalf("specs = %+v", specs)
	}
	if specs[0].ID != LocalID || specs[0].Session != "dev" {
		t.Fatalf("local = %+v", specs[0])
	}
	if s := specs[1]; s.Target != "gpu-host" || s.HerdrBin != "/home/u/.local/bin/herdr" || !s.Enabled {
		t.Fatalf("gpu = %+v", s)
	}
	if s := specs[2]; s.Label != "robot" || s.Session != "default" || s.Enabled {
		t.Fatalf("robot = %+v", s)
	}
	if s := specs[3]; s.ID != "extra" || s.Kind != KindSSH {
		t.Fatalf("extra = %+v", s)
	}
}

func TestIsReadOnly(t *testing.T) {
	for m, want := range map[string]bool{"session.snapshot": true, "pane.list": true, "layout.export": true, "pane.split": false, "agent.prompt": false} {
		if IsReadOnlyMethod(m) != want {
			t.Errorf("isReadOnly(%s) != %v", m, want)
		}
	}
}
