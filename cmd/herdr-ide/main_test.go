package main

import (
	"os"
	"strings"
	"testing"

	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

func TestSelectSpecsDedup(t *testing.T) {
	specs := []machines.Spec{
		{ID: "local", Label: "mac (local)", Kind: machines.KindLocal},
		{ID: "a1", Label: "gpu", Target: "gpu.example.com"},
		{ID: "b2", Label: "robot", Target: "robot"},
		{ID: "x", Label: "x", Target: "x"},
	}
	got := selectSpecs(specs, false, nil, []string{"a1", "gpu", "gpu.example.com", "local"})
	if len(got) != 2 || got[0].ID != "local" || got[1].ID != "a1" {
		t.Fatalf("--machine selection = %+v", got)
	}
	got = selectSpecs(specs, true, []string{"x", "x"}, nil)
	if len(got) != 2 || got[1].ID != "x" {
		t.Fatalf("--local-only with --ssh = %+v", got)
	}
}

// Every core setting has a label, a description and option labels in the
// UI's messages; a browser shows the bare key otherwise.
func TestSettingsTranslated(t *testing.T) {
	b, err := os.ReadFile("../../web/src/i18n/en.ts")
	if err != nil {
		t.Fatal(err)
	}
	en := string(b)
	defs := append(append([]settings.Def{}, codeserver.SettingDefs...), gui.SettingDefs...)
	for _, d := range defs {
		keys := []string{"settings." + d.Key, "settings." + d.Key + ".desc"}
		if d.Kind == settings.KindEnum {
			for _, o := range d.Options {
				keys = append(keys, "settings."+d.Key+"."+o)
			}
		}
		for _, k := range keys {
			if !strings.Contains(en, "'"+k+"':") {
				t.Errorf("web/src/i18n/en.ts lacks %s", k)
			}
		}
	}
}
