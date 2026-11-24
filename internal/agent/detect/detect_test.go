package detect

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// screen joins lines as herdr-core's terminal.read returns a screen.
func screen(lines ...string) string { return strings.Join(lines, "\n") + "\n" }

// Screens of the agents the UI starts, written after the agents' own
// interfaces and the manifests' rules, with the state each gives.
var fixtures = []struct {
	agent, name string
	in          Input
	want        string
	skip        bool
}{
	{"claude", "a turn in progress", Input{Screen: screen(
		"⏺ Reading the test files…",
		"",
		"✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)",
		"",
		"──────────────────────────────────────",
		"❯ ",
		"──────────────────────────────────────",
		"  ? for shortcuts",
	)}, Working, false},
	{"claude", "the prompt", Input{Screen: screen(
		"⏺ Done: the tests pass.",
		"",
		"──────────────────────────────────────",
		"❯ ",
		"──────────────────────────────────────",
		"  ? for shortcuts",
	)}, Idle, false},
	{"claude", "a permission dialog", Input{Screen: screen(
		" Bash command",
		"",
		"   rm -rf build",
		"   Remove the build directory",
		"",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. Yes, and don't ask again for rm commands in /src",
		"   3. No, and tell Claude what to do differently (esc)",
	)}, Blocked, false},
	{"claude", "the transcript viewer", Input{Screen: screen(
		"⏺ Earlier output",
		"  Showing detailed transcript · ctrl+o to toggle",
	)}, Unknown, true},
	{"claude", "a spinner in the title", Input{Screen: screen("text"), Title: "⠂ Claude Code"}, Working, false},
	{"codex", "a spinner in the title", Input{Screen: screen("› Explain this"), Title: "⠋ codex"}, Working, false},
	{"codex", "an approval in the title", Input{Screen: screen("› "), Title: "Action Required"}, Blocked, false},
	{"codex", "a confirmation on screen", Input{Screen: screen("Allow command?", "  rm -rf build", "Press enter to confirm or esc to cancel")}, Blocked, false},
	{"codex", "its title at rest", Input{Screen: screen("› "), Title: "codex"}, Idle, false},
	{"gemini", "working", Input{Screen: screen("⠼ Reading files (esc to cancel, 4s)")}, Working, false},
	{"gemini", "an edit to allow", Input{Screen: screen("╭──────╮", "│ Apply this change?", "│ ● 1. Yes, allow once", "╰──────╯")}, Blocked, false},
	{"gemini", "the prompt", Input{Screen: screen(">   Type your message or @path/to/file")}, Idle, false},
	{"opencode", "working", Input{Screen: screen("  ■■■■⬝⬝⬝⬝  esc to interrupt")}, Working, false},
	{"opencode", "a permission", Input{Screen: screen("△ Permission required", "  bash: rm -rf build")}, Blocked, false},
	{"opencode", "the prompt", Input{Screen: screen("  > ", "  enter send")}, Idle, false},
	{"kimi", "thinking", Input{Screen: screen("⠋ Thinking...")}, Working, false},
	{"kimi", "a command to approve", Input{Screen: screen("Run this command?", "  ls -la", "▶ Approve once", "  Reject", "↑↓ select · 1/2 choose · ↵ confirm")}, Blocked, false},
	{"kimi", "the prompt", Input{Screen: screen("✨ ")}, Idle, false},
	{"grok", "a tool running", Input{Screen: screen("⠋ Reading src/main.rs [stop]")}, Working, false},
	{"grok", "a permission", Input{Screen: screen("Allow running ls?", "↑↓:select  enter:confirm  ctrl+o:yolo  ctrl+c:cancel")}, Blocked, false},
	{"grok", "the prompt", Input{Screen: screen("> ", "ctrl+.:shortcuts")}, Idle, false},
	{"cursor", "working", Input{Screen: screen("⬢ Generating…", "  ctrl+c to stop")}, Working, false},
	{"cursor", "a command to run", Input{Screen: screen("Run this command?", "  npm test", " → Run (once) (y) (enter)", "   Skip (esc or n)")}, Blocked, false},
	{"cursor", "the prompt", Input{Screen: screen("→ Plan, search, build anything")}, Idle, false},
	{"copilot", "working", Input{Screen: screen("◉ Thinking (Esc to cancel)")}, Working, false},
	{"copilot", "a selection", Input{Screen: screen("Do you want to run this command?", "❯ 1. Yes", "  2. No", "↑↓ to navigate · Enter to select · Esc to cancel")}, Blocked, false},
	{"copilot", "the prompt", Input{Screen: screen("> Type @ to mention files")}, Idle, false},
	{"qwen", "working", Input{Screen: screen("⠼ Reticulating splines… (12s · esc to cancel)")}, Working, false},
	{"qwen", "a tool to confirm", Input{Screen: screen("Shell command execution", "Do you want to proceed?", "● 1. Yes, allow once", "  2. No")}, Blocked, false},
	{"qwen", "the prompt", Input{Screen: screen(">   Type your message or @path/to/file")}, Idle, false},
	{"amp", "working", Input{Screen: screen("╰ amp thinking ──────── esc to cancel")}, Working, false},
	{"amp", "a command to approve", Input{Screen: screen("Run this command?", "  rm -rf build", "Approve  Deny with feedback")}, Blocked, false},
	{"amp", "its title at rest", Input{Screen: screen("> "), Title: "src - amp - main"}, Idle, false},
}

func TestRulesPerAgent(t *testing.T) {
	for _, f := range fixtures {
		m := ManifestFor(f.agent)
		if m == nil {
			t.Fatalf("no manifest for %s", f.agent)
		}
		r := m.Evaluate(f.in)
		if r.State != f.want || r.Skip != f.skip {
			t.Errorf("%s, %s: %s (rule %q, skip %v), want %s", f.agent, f.name, r.State, r.Rule, r.Skip, f.want)
		}
	}
}

// Gates: contains are case-insensitive, regexes all match, line regexes
// match a line each; all, any and not nest; the highest priority wins and
// no match reads idle.
func TestRuleSemantics(t *testing.T) {
	m, err := Parse([]byte(`
id = "test"
[[rules]]
id = "low"
state = "working"
priority = 10
contains = ["BUSY"]
[[rules]]
id = "high"
state = "blocked"
priority = 20
region = "bottom_non_empty_lines(2)"
line_regex = ['^\s*\? ']
any = [{ contains = ["yes"] }, { regex = ['(?i)allow'] }]
not = [{ contains = ["ignore me"] }]
[[rules]]
id = "same"
state = "idle"
priority = 20
contains = ["busy"]
`))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		screen, want, rule string
	}{
		{"busy\n", Idle, "same"}, // equal priority: the first rule that matched ("same" ranks over "low")
		{"Busy\n? Allow it\n", Blocked, "high"},
		{"? allow\nlast\n", Idle, "same"}, // not in the bottom two non-empty lines with... (checked below)
		{"nothing here\n", Idle, ""},
		{"? yes\nignore me\nbusy\n", Idle, "same"},
	} {
		r := m.Evaluate(Input{Screen: c.screen})
		if c.screen == "? allow\nlast\n" {
			// The bottom two non-empty lines hold the question: blocked, by
			// priority over "same", which does not match ("busy" is absent).
			if r.State != Blocked {
				t.Errorf("%q: %+v", c.screen, r)
			}
			continue
		}
		if r.State != c.want || r.Rule != c.rule {
			t.Errorf("%q: %+v, want %s by %q", c.screen, r, c.want, c.rule)
		}
	}
	for _, bad := range []string{
		`id = "x"`,
		"id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\n",
		"id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\nregion = \"middle\"\ncontains = [\"a\"]\n",
		"id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\nregex = ['(']\n",
		"id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\ncontains = [\"a\"]\nunknown_field = 1\n",
		"id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\nskip_state_update = true\ncontains = [\"a\"]\n",
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

// Regions cut the screen as herdr does.
func TestRegions(t *testing.T) {
	s := screen("one", "", "two", "──────", "› typed", "• done", "────── title", "box", "──────", "three", "")
	for spec, want := range map[string]string{
		"bottom_non_empty_lines(2)":                  "──────\nthree\n\n",
		"bottom_lines(2)":                            "three\n\n",
		"top_non_empty_lines(2)":                     "one\n\ntwo\n",
		"prompt_box_body":                            "box\n",
		"after_last_horizontal_rule":                 "three\n\n",
		"last_non_empty_above_prompt_box":            "• done",
		"after_last_prompt_marker":                   "• done\n────── title\nbox\n──────\nthree\n\n",
		"whole_recent_without_current_prompt_marker": s, // a block marker follows the prompt
	} {
		if got := region(Input{Screen: s}, spec); got != want {
			t.Errorf("%s: %q, want %q", spec, got, want)
		}
	}
	if got := region(Input{Screen: "a\n› now\n"}, "before_current_prompt_marker"); got != "a\n" {
		t.Errorf("before_current_prompt_marker: %q", got)
	}
	if region(Input{Title: "t", Progress: "4;1"}, "osc_progress") != "4;1" || region(Input{Title: "t"}, "osc_title") != "t" {
		t.Error("OSC regions")
	}
	in := "[" + `\u2800-\u28FF]\p{Alphabetic}` + `\u{fe0f}\\u`
	if goRegex(in) != `[\x{2800}-\x{28FF}]\p{L}\x{fe0f}\\u` {
		t.Errorf("goRegex: %s", goRegex(in))
	}
}

func TestIdentify(t *testing.T) {
	for _, c := range []struct {
		name string
		argv []string
		want string
	}{
		{"claude", []string{"claude"}, "claude"},
		{"node", []string{"claude", "--resume"}, "claude"},
		{"codex", []string{"/usr/local/bin/codex"}, "codex"},
		{"sh", []string{"/bin/sh", "/home/u/bin/claude", "-p", "x"}, "claude"},
		{"bash", []string{"bash", "-c", "codex"}, ""},
		{"node", []string{"node", "--require", "x.js", "/usr/lib/node_modules/@qwen-code/qwen-code/dist/index.js"}, "qwen"},
		{"node", []string{"node", "/opt/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"}, "kimi"},
		{"node", []string{"node", "-e", "require('codex')"}, ""},
		{"python3.12", []string{"python3.12", "-m", "hermes"}, ""},
		{"python3", []string{"python3", "/opt/hermes-agent"}, "hermes"},
		{"Cursor-Agent.EXE", nil, "cursor"},
		{"muse-bin-0.1.0-R708.1", nil, "muse"},
		{"muse-binary", nil, ""},
		{"zsh", []string{"-zsh"}, ""},
		{"vim", []string{"vim", "claude"}, ""},
	} {
		if got := Identify(c.name, c.argv); got != c.want {
			t.Errorf("%s %q: %q, want %q", c.name, c.argv, got, c.want)
		}
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
