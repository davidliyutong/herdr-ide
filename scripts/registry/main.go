// Command registry writes design/generated/registry.json from what the core
// registers (internal/registry), for the clients that need it before or
// without a core:
//
//   - "settings": each setting's default, which the web UI uses until the
//     core's values arrive;
//   - "commands" and "keybindings": the commands and the default bindings
//     of each platform, which the web UI and the desktop app's shell use
//     until they have read the core's;
//   - "i18n": the translation keys the web UI needs for the settings and
//     commands it shows; its tests fail when it lacks one;
//   - "agents": the kinds of coding agents (internal/agentkinds), which
//     the web UI starts, resumes and shows the conversations of.
//
// It also writes the tables of every setting and of every command with its
// default keys into docs/reference.md, between the markers there.
//
// Usage:
//
//	go run ./scripts/registry           writes the files
//	go run ./scripts/registry -check    writes nothing; fails if one is stale
//	go run ./scripts/registry -routes   prints the plugins' routes, for scripts/check.sh
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
	"strconv"
	"strings"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/registry"
	"herdr-ide/internal/settings"
)

const out = "design/generated/registry.json"

// keys returns the translation keys of the UI: every section, group,
// setting label and enum option, and every command with its section.
func keys() []string {
	store := settings.New("", registry.Settings()...)
	set := map[string]bool{}
	used := map[string]bool{}
	for _, d := range store.Defs() {
		used[d.Section] = true
		set["settings."+d.Key] = true
		if d.Group != "" {
			set["settings.group."+d.Group] = true
		}
		for _, o := range d.Enum {
			set["settings."+d.Key+"."+o] = true
		}
	}
	for _, s := range store.Sections() {
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
	defaults := map[string]any{}
	for _, d := range settings.New("", registry.Settings()...).Defs() {
		defaults[d.Key] = d.Default
	}
	kb := keybindings.New("", registry.Commands())
	doc := map[string]any{
		"settings":    defaults,
		"commands":    kb.CommandList(),
		"keybindings": kb.AllDefaults(),
		"i18n":        keys(),
		"agents":      agentkinds.All(),
	}
	b, _ := json.MarshalIndent(doc, "", "  ")
	return append(b, '\n')
}

// reference is the document whose tables of settings and commands are
// generated, each between its markers.
const reference = "docs/reference.md"

func markers(name string) (begin, end string) {
	return "<!-- scripts/registry: " + name + " -->", "<!-- end of scripts/registry: " + name + " -->"
}

// settingsTable lists every setting in the order of the settings dialog.
func settingsTable() string {
	store := settings.New("", registry.Settings()...)
	order := map[string]int{}
	for _, sec := range store.Sections() {
		order[sec.ID] = sec.Order
	}
	defs := slices.Clone(store.Defs())
	sort.SliceStable(defs, func(i, j int) bool {
		if order[defs[i].Section] != order[defs[j].Section] {
			return order[defs[i].Section] < order[defs[j].Section]
		}
		return defs[i].Order < defs[j].Order
	})
	var b strings.Builder
	b.WriteString("| Setting | Values | Default | Flag | Scope |\n| --- | --- | --- | --- | --- |\n")
	for _, d := range defs {
		flag := "–"
		if d.Flag != "" {
			flag = "`--" + d.Flag + "`"
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s |\n", d.Key, values(d), defaultOf(d), flag, scope(d))
	}
	return b.String()
}

// values describes the values a setting takes.
func values(d settings.Def) string {
	switch d.Type {
	case settings.TypeEnum:
		quoted := make([]string, len(d.Enum))
		for i, e := range d.Enum {
			quoted[i] = "`" + e + "`"
		}
		return strings.Join(quoted, ", ")
	case settings.TypeNumber:
		kind := "number"
		if d.Integer {
			kind = "integer"
		}
		if d.Min != nil && d.Max != nil {
			return fmt.Sprintf("%s, %s–%s", kind, num(*d.Min), num(*d.Max))
		}
		return kind
	case settings.TypeColor:
		return "color `#rrggbb`"
	case settings.TypeList:
		item := "strings"
		if d.Item == settings.TypeColor {
			item = "colors"
		}
		if d.Length > 0 {
			return fmt.Sprintf("%d %s", d.Length, item)
		}
		return "list of " + item
	case settings.TypeBool:
		return "`true`, `false`"
	}
	return string(d.Type)
}

func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// defaultOf is a setting's default as JSON; a list of colors is named by
// its length.
func defaultOf(d settings.Def) string {
	if list, ok := d.Default.([]string); ok && d.Item == settings.TypeColor && len(list) > 4 {
		return fmt.Sprintf("%d colors of `design/tokens.json`", len(list))
	}
	j, _ := json.Marshal(d.Default)
	return "`" + string(j) + "`"
}

// scope tells which machines a setting can differ for.
func scope(d settings.Def) string {
	switch d.Scope {
	case settings.ScopeMachine:
		return "per machine"
	case settings.ScopeRemoteMachine:
		return "per remote machine"
	}
	return "–"
}

// commandsTable lists every command with its default keys per platform.
func commandsTable() string {
	kb := keybindings.New("", registry.Commands())
	defaults := kb.AllDefaults()
	var b strings.Builder
	b.WriteString("| Command | When | `mac` | `mac-browser` | `windows` | `windows-browser` | `linux` | `linux-browser` |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n")
	for _, c := range kb.CommandList() {
		fmt.Fprintf(&b, "| `%s` | `%s` |", c.ID, c.When)
		for _, p := range []string{
			keybindings.PlatformMac,
			keybindings.PlatformMacBrowser,
			keybindings.PlatformWindows,
			keybindings.PlatformWindowsBrowser,
			keybindings.PlatformLinux,
			keybindings.PlatformLinuxBrowser,
		} {
			var keys []string
			for _, r := range defaults[p] {
				if r.Command == c.ID {
					keys = append(keys, "`"+r.Key+"`")
				}
			}
			if len(keys) == 0 {
				keys = []string{"–"}
			}
			b.WriteString(" " + strings.Join(keys, ", ") + " |")
		}
		b.WriteString("\n")
	}
	return b.String()
}

// fillReference returns doc with each generated table between its markers.
func fillReference(doc []byte) ([]byte, error) {
	text := string(doc)
	for _, t := range []struct {
		name  string
		table string
	}{{"settings", settingsTable()}, {"commands", commandsTable()}} {
		begin, end := markers(t.name)
		i, j := strings.Index(text, begin), strings.Index(text, end)
		if i < 0 || j < i {
			return nil, fmt.Errorf("%s: markers %q and %q missing", reference, begin, end)
		}
		text = text[:i+len(begin)] + "\n\n" + t.table + "\n" + text[j:]
	}
	return []byte(text), nil
}

// update writes want to path unless it holds it already; with check it
// only fails.
func update(path string, want []byte, check bool) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, want) {
		return nil
	}
	if check {
		return fmt.Errorf("stale: %s (run `make tokens`)", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, want, 0o644)
}

func run(root string, check bool) error {
	if err := update(filepath.Join(root, out), generate(), check); err != nil {
		return err
	}
	path := filepath.Join(root, reference)
	doc, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	want, err := fillReference(doc)
	if err != nil {
		return err
	}
	return update(path, want, check)
}

func main() {
	check := flag.Bool("check", false, "write nothing; fail if the file is stale")
	root := flag.String("root", ".", "the repository")
	routes := flag.Bool("routes", false, "print the plugins' routes (METHOD /path), one per line, and write nothing")
	flag.Parse()
	if *routes {
		for _, p := range registry.Plugins() {
			for _, rt := range p.Routes() {
				fmt.Println(plugin.Pattern(p.ID(), rt))
			}
		}
		return
	}
	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, "registry:", err)
		os.Exit(1)
	}
}
