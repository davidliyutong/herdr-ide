// Command registry writes design/generated/registry.json from what the core
// registers (internal/registry), for the clients that need it before or
// without a core:
//
//   - "settings": each setting's default, which the web UI uses until the
//     core's values arrive;
//   - "commands" and "keybindings": the commands and the default bindings
//     of each platform, which the web UI and the desktop app's shell use
//     until they have read the core's;
//   - "i18n": the translation keys each user interface needs for the
//     settings and commands it shows. The web UI's and the macOS
//     application's tests fail when one of them lacks a key listed for it.
//
//	go run ./scripts/registry           writes the file
//	go run ./scripts/registry -check    writes nothing; fails if it is stale
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"

	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/registry"
	"herdr-ide/internal/settings"
)

const out = "design/generated/registry.json"

// clients are the user interfaces and the platform name settings use for each.
var clients = map[string]string{"web": settings.PlatformWeb, "macos": settings.PlatformMacOS}

// keys returns the translation keys of a client: every section, setting
// label and enum option it shows, and every command with its section.
func keys(platform string) []string {
	store := settings.New("", registry.Settings()...)
	return keysOf(store.Defs(), store.Sections(), platform)
}

// keysOf returns the translation keys of a client from the settings'
// definitions and sections.
func keysOf(defs []settings.Def, sections []settings.Section, platform string) []string {
	set := map[string]bool{}
	used := map[string]bool{}
	for _, d := range defs {
		if len(d.Platforms) > 0 && !slices.Contains(d.Platforms, platform) {
			continue
		}
		used[d.Section] = true
		set["settings."+d.Key] = true
		for _, o := range d.Enum {
			set["settings."+d.Key+"."+o] = true
		}
	}
	for _, s := range sections {
		if used[s.ID] {
			set["settings.section."+s.ID] = true
		}
	}
	for _, s := range keybindings.Sections {
		set["command.section."+s.ID] = true
	}
	for _, c := range registry.Commands() {
		set["command."+c.ID] = true
	}
	list := make([]string, 0, len(set))
	for k := range set {
		list = append(list, k)
	}
	sort.Strings(list)
	return list
}

func generate() []byte {
	i18n := map[string][]string{}
	for client, platform := range clients {
		i18n[client] = keys(platform)
	}
	defaults := map[string]any{}
	for _, d := range settings.New("", registry.Settings()...).Defs() {
		defaults[d.Key] = d.Default
	}
	kb := keybindings.New("", registry.Commands())
	doc := map[string]any{
		"settings":    defaults,
		"commands":    kb.CommandList(),
		"keybindings": kb.AllDefaults(),
		"i18n":        i18n,
	}
	b, _ := json.MarshalIndent(doc, "", "  ")
	return append(b, '\n')
}

func run(root string, check bool) error {
	path := filepath.Join(root, out)
	want := generate()
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, want) {
		return nil
	}
	if check {
		return fmt.Errorf("stale: %s (run `make tokens`)", out)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, want, 0o644)
}

func main() {
	check := flag.Bool("check", false, "write nothing; fail if the file is stale")
	root := flag.String("root", ".", "the repository")
	flag.Parse()
	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, "registry:", err)
		os.Exit(1)
	}
}
