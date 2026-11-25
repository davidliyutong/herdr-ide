package detect

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The cases of testdata/ are shared with the TypeScript machine side
// (backend/features/agents/machine/detect), which runs them against the
// same manifests: screens of the agents, identification, regions, the
// semantics of gates and the parse of every manifest.
var update = flag.Bool("update", false, "rewrite testdata/manifests.json from the manifests")

// screen joins lines as herdr-core's terminal.read returns a screen.
func screen(lines ...string) string { return strings.Join(lines, "\n") + "\n" }

// readCases decodes testdata/name into v.
func readCases(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// Screens of the agents the UI starts, written after the agents' own
// interfaces and the manifests' rules, with the state each gives.
func TestRulesPerAgent(t *testing.T) {
	var cases []struct {
		Agent, Name string
		Screen      []string
		Title, Want string
		Skip        bool
	}
	readCases(t, "screens.json", &cases)
	if len(cases) < 30 {
		t.Fatalf("%d screens", len(cases))
	}
	for _, c := range cases {
		m := ManifestFor(c.Agent)
		if m == nil {
			t.Fatalf("no manifest for %s", c.Agent)
		}
		r := m.Evaluate(Input{Screen: screen(c.Screen...), Title: c.Title})
		if r.State != c.Want || r.Skip != c.Skip {
			t.Errorf("%s, %s: %s (rule %q, skip %v), want %s", c.Agent, c.Name, r.State, r.Rule, r.Skip, c.Want)
		}
	}
}

// Gates: contains are case-insensitive, regexes all match, line regexes
// match a line each; all, any and not nest; the highest priority wins and
// no match reads idle. Manifests outside herdr's format or limits fail.
func TestRuleSemantics(t *testing.T) {
	var v struct {
		Manifest string
		Cases    []struct{ Screen, Want, Rule string }
		Bad      []string
		Good     []string
	}
	readCases(t, "rules.json", &v)
	m, err := Parse([]byte(v.Manifest))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		r := m.Evaluate(Input{Screen: c.Screen})
		if r.State != c.Want || r.Rule != c.Rule {
			t.Errorf("%q: %+v, want %s by %q", c.Screen, r, c.Want, c.Rule)
		}
	}
	for _, bad := range v.Bad {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, good := range v.Good {
		if _, err := Parse([]byte(good)); err != nil {
			t.Errorf("refused %q: %v", good, err)
		}
	}
}

// Regions cut the screen as herdr does.
func TestRegions(t *testing.T) {
	var v struct {
		Cases []struct {
			Screen, Title, Progress, Region, Want string
		}
		Valid, Invalid []string
		Rewrites       []struct{ In, Want string }
	}
	readCases(t, "regions.json", &v)
	for _, c := range v.Cases {
		if got := region(Input{Screen: c.Screen, Title: c.Title, Progress: c.Progress}, c.Region); got != c.Want {
			t.Errorf("%s of %q: %q, want %q", c.Region, c.Screen, got, c.Want)
		}
	}
	for _, s := range v.Valid {
		if !validRegion(s) {
			t.Errorf("%q refused", s)
		}
	}
	for _, s := range v.Invalid {
		if validRegion(s) {
			t.Errorf("%q accepted", s)
		}
	}
	for _, c := range v.Rewrites {
		if got := goRegex(c.In); got != c.Want {
			t.Errorf("goRegex(%s): %s, want %s", c.In, got, c.Want)
		}
	}
}

func TestIdentify(t *testing.T) {
	var cases []struct {
		Name string
		Argv []string
		Want string
	}
	readCases(t, "identify.json", &cases)
	for _, c := range cases {
		if got := Identify(c.Name, c.Argv); got != c.Want {
			t.Errorf("%s %q: %q, want %q", c.Name, c.Argv, got, c.Want)
		}
	}
}

// gateJSON is a gate as testdata/manifests.json writes it: only what it
// has, regexes as the manifest spells them.
func gateJSON(g Gate) map[string]any {
	out := map[string]any{}
	for k, list := range map[string][]Gate{"all": g.All, "any": g.Any, "not": g.Not} {
		if len(list) > 0 {
			var gs []any
			for _, x := range list {
				gs = append(gs, gateJSON(x))
			}
			out[k] = gs
		}
	}
	for k, list := range map[string][]string{"contains": g.Contains, "regex": g.Regex, "line_regex": g.LineRegex} {
		if len(list) > 0 {
			out[k] = list
		}
	}
	return out
}

// manifestsJSON is every manifest as parsed, with the defaults applied.
func manifestsJSON(t *testing.T) []byte {
	t.Helper()
	ms, err := Manifests()
	if err != nil {
		t.Fatal(err)
	}
	all := map[string]any{}
	for id, m := range ms {
		var rules []any
		for _, r := range m.Rules {
			rule := gateJSON(r.Gate)
			rule["id"], rule["state"], rule["priority"], rule["region"] = r.ID, r.State, r.Priority, r.Region
			for k, v := range map[string]bool{"visible_idle": r.VisibleIdle, "visible_blocker": r.VisibleBlocker, "visible_working": r.VisibleWorking, "skip_state_update": r.SkipStateUpdate} {
				if v {
					rule[k] = true
				}
			}
			rules = append(rules, rule)
		}
		man := map[string]any{"id": m.ID, "version": m.Version, "min_engine_version": m.MinEngineVersion, "updated_at": m.UpdatedAt, "rules": rules}
		if len(m.Aliases) > 0 {
			man["aliases"] = m.Aliases
		}
		all[id] = man
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(all); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// testdata/manifests.json is what the manifests parse to; the TypeScript
// side's parser must read the same (go test -update rewrites it after a
// change of the manifests).
func TestManifestsParsed(t *testing.T) {
	got := manifestsJSON(t)
	if *update {
		if err := os.WriteFile(filepath.Join("testdata", "manifests.json"), got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(filepath.Join("testdata", "manifests.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("testdata/manifests.json is not what the manifests parse to: go test ./internal/agent/detect -run TestManifestsParsed -update")
	}
}

var (
	working = Input{Screen: screen("✻ Thinking… (3s · esc to interrupt)")}
	plain   = Input{Screen: screen("⏺ All done.")}
	prompt  = Input{Screen: screen("⏺ All done.", "──────", "❯ ", "──────")}
	dialog  = Input{Screen: screen(" Do you want to proceed?", " ❯ 1. Yes", "   2. No")}
)

// Nothing is read during the startup grace; working → idle without the
// prompt on screen waits for three more reads or 700 ms, and becomes done;
// the visible prompt confirms at once; done stays until a new turn.
func TestTrackerDebounceAndDone(t *testing.T) {
	t0 := time.Unix(1000, 0)
	tr := NewTracker(ManifestFor("claude"), t0)
	if s, ch := tr.Observe(t0.Add(time.Second), working); ch || s != Unknown {
		t.Fatalf("read during the grace: %s %v", s, ch)
	}
	at := t0.Add(StartupGrace)
	if s, ch := tr.Observe(at, working); !ch || s != Working {
		t.Fatalf("working: %s %v", s, ch)
	}
	// A spinner frame that reads as idle, then working again: no change.
	if _, ch := tr.Observe(at.Add(100*time.Millisecond), plain); ch || !tr.Pending() {
		t.Fatal("idle without the prompt was not held")
	}
	if s, ch := tr.Observe(at.Add(200*time.Millisecond), working); ch || s != Working || tr.Pending() {
		t.Fatalf("working again: %s %v", s, ch)
	}
	// The first idle read and three confirmations.
	for i := 1; i <= 4; i++ {
		s, ch := tr.Observe(at.Add(time.Duration(300+100*i)*time.Millisecond), plain)
		if (i < 4) != !ch {
			t.Fatalf("read %d: %s %v", i, s, ch)
		}
		if i == 4 && s != Done {
			t.Fatalf("done: %s", s)
		}
	}
	if s, ch := tr.Observe(at.Add(time.Second), prompt); ch || s != Done {
		t.Fatalf("done stays while idle: %s %v", s, ch)
	}
	if s, _ := tr.Observe(at.Add(2*time.Second), working); s != Working {
		t.Fatalf("a new turn: %s", s)
	}
	// The cap: one read 700 ms later is enough.
	tr.Observe(at.Add(3*time.Second), plain)
	if s, ch := tr.Observe(at.Add(3*time.Second+IdleCap), plain); !ch || s != Done {
		t.Fatalf("after the cap: %s %v", s, ch)
	}
	// The prompt confirms at once; blocked → idle is done too.
	tr.Observe(at.Add(4*time.Second), working)
	if s, ch := tr.Observe(at.Add(5*time.Second), prompt); !ch || s != Done {
		t.Fatalf("prompt: %s %v", s, ch)
	}
	if s, _ := tr.Observe(at.Add(6*time.Second), dialog); s != Blocked {
		t.Fatalf("dialog: %s", s)
	}
	if s, ch := tr.Observe(at.Add(7*time.Second), prompt); !ch || s != Done {
		t.Fatalf("answered: %s %v", s, ch)
	}
	// An agent that exits in the middle of a turn is done; at rest nothing.
	tr.Observe(at.Add(8*time.Second), working)
	if s, ch := tr.Exit(); !ch || s != Done {
		t.Fatalf("exit while working: %s %v", s, ch)
	}
	if _, ch := tr.Exit(); ch {
		t.Fatal("exit at rest changed the status")
	}
}

// A status the program reports itself wins over the screen, at once and
// also during the grace; once cleared, the screen counts again.
func TestTrackerSelfReported(t *testing.T) {
	t0 := time.Unix(1000, 0)
	tr := NewTracker(ManifestFor("claude"), t0)
	if s, ch := tr.Report(Working); !ch || s != Working || !tr.SelfReported() {
		t.Fatalf("reported working: %s %v", s, ch)
	}
	if s, ch := tr.Observe(t0.Add(time.Hour), prompt); ch || s != Working {
		t.Fatalf("the screen overrode the report: %s %v", s, ch)
	}
	if s, ch := tr.Report(Idle); !ch || s != Done {
		t.Fatalf("reported idle after working: %s %v", s, ch)
	}
	if s, ch := tr.Report("error"); !ch || s != Blocked {
		t.Fatalf("error: %s %v", s, ch)
	}
	if s, ch := tr.Report(Done); !ch || s != Done {
		t.Fatalf("done: %s %v", s, ch)
	}
	if _, ch := tr.Report(Done); ch {
		t.Fatal("done twice")
	}
	tr.Report("")
	if s, _ := tr.Observe(t0.Add(time.Hour), working); s != Working || tr.SelfReported() {
		t.Fatalf("the screen after the report was cleared: %s", s)
	}
	// Without a manifest only the program's own report gives a status.
	none := NewTracker(nil, t0)
	if s, ch := none.Observe(t0.Add(time.Hour), working); ch || s != Unknown {
		t.Fatalf("no manifest: %s", s)
	}
}

// The settings offer every agent the manifests know as a silent agent:
// the kinds of the core's registry (spec/generated/registry.json), which
// the settings list, are the manifests'.
func TestSettingsListEveryAgent(t *testing.T) {
	ms, err := Manifests()
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for id := range ms {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	b, err := os.ReadFile("../../../spec/generated/registry.json")
	if err != nil {
		t.Fatal(err)
	}
	var reg struct {
		Agents []struct {
			ID string `json:"id"`
		} `json:"agents"`
	}
	if err := json.Unmarshal(b, &reg); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, a := range reg.Agents {
		kinds = append(kinds, a.ID)
	}
	slices.Sort(kinds)
	if !slices.Equal(ids, kinds) {
		t.Errorf("the core's kinds %v, manifests %v", kinds, ids)
	}
}
