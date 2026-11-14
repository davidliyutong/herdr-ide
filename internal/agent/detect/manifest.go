// Package detect tells which coding agent runs in a terminal and what it is
// doing, the way herdr does it (herdr v0.9.5, src/detect): the foreground
// process names the agent, and an ordered set of rules over parts of the
// screen (the agent's manifest) gives its state. The manifests in
// manifests/ are herdr's, unchanged (Apache-2.0, licenses/herdr-detect).
package detect

import (
	"embed"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/pelletier/go-toml/v2"
)

// States of an agent, as screen rules and the core report them.
const (
	Idle    = "idle"
	Working = "working"
	Blocked = "blocked"
	Unknown = "unknown"
	// Done is reported once when an agent goes from working or blocked to
	// idle (a completed turn); it is not a screen rule's state.
	Done = "done"
)

//go:embed manifests/*.toml
var bundled embed.FS

// Limits of a manifest, as herdr checks them.
const (
	maxRules           = 128
	maxGateDepth       = 8
	maxTotalGates      = 512
	maxMatchersPerGate = 32
	maxTotalMatchers   = 1024
	maxMatcherChars    = 512
)

// Manifest is one agent's rules.
type Manifest struct {
	ID      string   `toml:"id"`
	Version string   `toml:"version"`
	Aliases []string `toml:"aliases"`
	Rules   []Rule   `toml:"rules"`

	MinEngineVersion int    `toml:"min_engine_version"`
	UpdatedAt        string `toml:"updated_at"`
}

// Rule gives a state when its gate matches its region of the screen. Of
// the rules that match, the one with the highest priority wins (the first
// one among equals).
type Rule struct {
	ID       string `toml:"id"`
	State    string `toml:"state"`
	Priority int    `toml:"priority"`
	Region   string `toml:"region"`
	// Visible* mark rules that see the agent's live chrome (its prompt, a
	// dialog, its spinner) rather than text that may be old.
	VisibleIdle    bool `toml:"visible_idle"`
	VisibleBlocker bool `toml:"visible_blocker"`
	VisibleWorking bool `toml:"visible_working"`
	// SkipStateUpdate: the screen shows a viewer of the agent (its
	// transcript), which says nothing about its state.
	SkipStateUpdate bool `toml:"skip_state_update"`
	Gate

	compiled *compiledGate
}

// Gate matches text: every contains (case-insensitive), every regex, every
// line_regex on some line, every gate of all, one of any (when there are
// any), and none of not.
type Gate struct {
	All       []Gate   `toml:"all"`
	Any       []Gate   `toml:"any"`
	Not       []Gate   `toml:"not"`
	Contains  []string `toml:"contains"`
	Regex     []string `toml:"regex"`
	LineRegex []string `toml:"line_regex"`
}

type compiledGate struct {
	all, any, not []*compiledGate
	contains      []string
	regex         []*regexp.Regexp
	lineRegex     []*regexp.Regexp
}

// Parse reads and checks a manifest in herdr's format.
func Parse(data []byte) (*Manifest, error) {
	var m Manifest
	dec := toml.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	if m.ID == "" {
		return nil, fmt.Errorf("manifest without an id")
	}
	if len(m.Rules) == 0 || len(m.Rules) > maxRules {
		return nil, fmt.Errorf("manifest %s: %d rules", m.ID, len(m.Rules))
	}
	var budget limits
	for i := range m.Rules {
		r := &m.Rules[i]
		if r.Region == "" {
			r.Region = "whole_recent"
		}
		switch r.State {
		case Idle, Working, Blocked, Unknown:
		case "":
			r.State = Unknown
		default:
			return nil, fmt.Errorf("rule %s: state %q", r.ID, r.State)
		}
		if strings.TrimSpace(r.ID) == "" {
			return nil, fmt.Errorf("manifest %s: a rule without an id", m.ID)
		}
		if r.SkipStateUpdate && (r.State != Unknown || r.VisibleIdle || r.VisibleBlocker || r.VisibleWorking) {
			return nil, fmt.Errorf("rule %s: skip_state_update with a state", r.ID)
		}
		if !validRegion(r.Region) {
			return nil, fmt.Errorf("rule %s: region %q", r.ID, r.Region)
		}
		g, err := budget.compile(r.Gate, 0, false)
		if err != nil {
			return nil, fmt.Errorf("rule %s: %w", r.ID, err)
		}
		r.compiled = g
	}
	return &m, nil
}

type limits struct{ gates, matchers int }

func (l *limits) compile(g Gate, depth int, negated bool) (*compiledGate, error) {
	if depth > maxGateDepth {
		return nil, fmt.Errorf("gates nested deeper than %d", maxGateDepth)
	}
	if l.gates++; l.gates > maxTotalGates {
		return nil, fmt.Errorf("more than %d gates", maxTotalGates)
	}
	n := len(g.Contains) + len(g.Regex) + len(g.LineRegex)
	if n > maxMatchersPerGate {
		return nil, fmt.Errorf("%d matchers in one gate", n)
	}
	if l.matchers += n; l.matchers > maxTotalMatchers {
		return nil, fmt.Errorf("more than %d matchers", maxTotalMatchers)
	}
	positive := n > 0 || len(g.All) > 0 || len(g.Any) > 0
	if !positive && !(negated && len(g.Not) > 0) {
		return nil, fmt.Errorf("a gate without a positive matcher")
	}
	c := &compiledGate{}
	for _, s := range append(append(append([]string{}, g.Contains...), g.Regex...), g.LineRegex...) {
		if len([]rune(s)) > maxMatcherChars {
			return nil, fmt.Errorf("a matcher longer than %d characters", maxMatcherChars)
		}
	}
	for _, s := range g.Contains {
		c.contains = append(c.contains, strings.ToLower(s))
	}
	for _, list := range []struct {
		src []string
		dst *[]*regexp.Regexp
	}{{g.Regex, &c.regex}, {g.LineRegex, &c.lineRegex}} {
		for _, s := range list.src {
			re, err := regexp.Compile(goRegex(s))
			if err != nil {
				return nil, err
			}
			*list.dst = append(*list.dst, re)
		}
	}
	for _, nested := range g.All {
		x, err := l.compile(nested, depth+1, negated)
		if err != nil {
			return nil, err
		}
		c.all = append(c.all, x)
	}
	for _, nested := range g.Any {
		x, err := l.compile(nested, depth+1, negated)
		if err != nil {
			return nil, err
		}
		c.any = append(c.any, x)
	}
	for _, nested := range g.Not {
		x, err := l.compile(nested, depth+1, true)
		if err != nil {
			return nil, err
		}
		c.not = append(c.not, x)
	}
	return c, nil
}

func (g *compiledGate) match(text, lower string, lines []string) bool {
	for _, s := range g.contains {
		if !strings.Contains(lower, s) {
			return false
		}
	}
	for _, re := range g.regex {
		if !re.MatchString(text) {
			return false
		}
	}
	for _, re := range g.lineRegex {
		found := false
		for _, l := range lines {
			if re.MatchString(l) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	for _, x := range g.all {
		if !x.match(text, lower, lines) {
			return false
		}
	}
	if len(g.any) > 0 {
		found := false
		for _, x := range g.any {
			if x.match(text, lower, lines) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	for _, x := range g.not {
		if x.match(text, lower, lines) {
			return false
		}
	}
	return true
}

// Input is what a manifest is evaluated on: the screen's text (one line
// per row, trailing blanks trimmed) and the terminal's title. OSC progress
// reports are not available here and read as empty.
type Input struct {
	Screen   string
	Title    string
	Progress string
}

// Result is a manifest's verdict on a screen.
type Result struct {
	State string
	// Rule is the id of the rule that matched; "" when none did (a known
	// agent then reads as idle, as in herdr).
	Rule string
	// Skip: the screen shows something that says nothing about the
	// agent's state; keep the previous one.
	Skip bool
	// Visible* are the matched rule's flags, for the state it gave.
	VisibleIdle, VisibleBlocker, VisibleWorking bool
}

// Evaluate runs the manifest's rules over the input.
func (m *Manifest) Evaluate(in Input) Result {
	var best *Rule
	texts := map[string]string{}
	for i := range m.Rules {
		r := &m.Rules[i]
		text, ok := texts[r.Region]
		if !ok {
			text = region(in, r.Region)
			texts[r.Region] = text
		}
		if !r.compiled.match(text, strings.ToLower(text), splitLines(text)) {
			continue
		}
		if best == nil || r.Priority > best.Priority {
			best = r
		}
	}
	if best == nil {
		return Result{State: Idle}
	}
	return Result{
		State: best.State, Rule: best.ID, Skip: best.SkipStateUpdate,
		VisibleIdle:    best.VisibleIdle && best.State == Idle,
		VisibleBlocker: best.VisibleBlocker && best.State == Blocked,
		VisibleWorking: best.VisibleWorking && best.State == Working,
	}
}

var (
	loadOnce  sync.Once
	manifests map[string]*Manifest
	loadErr   error
)

// Manifests returns the embedded manifests by agent id.
func Manifests() (map[string]*Manifest, error) {
	loadOnce.Do(func() {
		manifests = map[string]*Manifest{}
		entries, err := fs.ReadDir(bundled, "manifests")
		if err != nil {
			loadErr = err
			return
		}
		for _, e := range entries {
			b, err := bundled.ReadFile(path.Join("manifests", e.Name()))
			if err != nil {
				loadErr = err
				return
			}
			m, err := Parse(b)
			if err != nil {
				loadErr = fmt.Errorf("%s: %w", e.Name(), err)
				return
			}
			manifests[m.ID] = m
		}
	})
	return manifests, loadErr
}

// ManifestFor returns the manifest of an agent id, nil without one.
func ManifestFor(agent string) *Manifest {
	all, _ := Manifests()
	return all[agent]
}

// splitLines splits text as Rust's str::lines does: on "\n", without a
// final empty line, with a trailing "\r" removed.
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

func validRegion(spec string) bool {
	switch strings.TrimSpace(spec) {
	case "whole_recent", "after_last_prompt_marker", "before_current_prompt_marker",
		"whole_recent_without_current_prompt_marker", "current_prompt_block_marker",
		"after_current_prompt_block_marker", "prompt_box_body", "above_prompt_box",
		"last_non_empty_above_prompt_box", "after_last_horizontal_rule", "osc_title", "osc_progress":
		return true
	}
	_, ok := regionCount(spec)
	return ok
}

// regionCount parses "bottom_lines(N)", "bottom_non_empty_lines(N)" and
// "top_non_empty_lines(N)".
func regionCount(spec string) (int, bool) {
	spec = strings.TrimSpace(spec)
	for _, name := range []string{"bottom_lines(", "bottom_non_empty_lines(", "top_non_empty_lines("} {
		if rest, ok := strings.CutPrefix(spec, name); ok {
			if digits, ok := strings.CutSuffix(rest, ")"); ok {
				n, err := strconv.Atoi(digits)
				return n, err == nil && n >= 0 && (name != "top_non_empty_lines(" || (n > 0 && n <= 65535 && digits[0] != '0'))
			}
		}
	}
	return 0, false
}

// region returns the part of the input a rule looks at, as herdr cuts it.
func region(in Input, spec string) string {
	spec = strings.TrimSpace(spec)
	switch spec {
	case "osc_title":
		return in.Title
	case "osc_progress":
		return in.Progress
	}
	content := in.Screen
	lines := splitLines(content)
	switch spec {
	case "whole_recent":
		return content
	case "after_last_prompt_marker":
		for i := len(lines) - 1; i >= 0; i-- {
			if codexPrompt(lines[i]) {
				return fromLine(content, lines, i+1)
			}
		}
		return content
	case "before_current_prompt_marker":
		if i, ok := currentCodexPrompt(lines); ok {
			return content[:lineOffset(content, lines, i)]
		}
		return content
	case "whole_recent_without_current_prompt_marker":
		if _, ok := currentCodexPrompt(lines); ok {
			return ""
		}
		return content
	case "current_prompt_block_marker":
		if p, ok := currentCodexPrompt(lines); ok {
			for i := p - 1; i >= 0; i-- {
				if codexBlockMarker(lines[i]) {
					return lines[i]
				}
			}
		}
		return ""
	case "after_current_prompt_block_marker":
		if p, ok := currentCodexPrompt(lines); ok {
			for i := p - 1; i >= 0; i-- {
				if codexBlockMarker(lines[i]) {
					return fromLine(content, lines, i)
				}
			}
		}
		return ""
	case "prompt_box_body":
		top, ok := promptBoxTop(lines)
		if !ok {
			return ""
		}
		end := len(lines)
		for i := top + 1; i < len(lines); i++ {
			if horizontalRule(lines[i]) {
				end = i
				break
			}
		}
		return content[lineOffset(content, lines, top+1):lineOffset(content, lines, end)]
	case "above_prompt_box":
		return abovePromptBox(content, lines)
	case "last_non_empty_above_prompt_box":
		above := splitLines(abovePromptBox(content, lines))
		for i := len(above) - 1; i >= 0; i-- {
			if strings.TrimSpace(above[i]) != "" {
				return above[i]
			}
		}
		return ""
	case "after_last_horizontal_rule":
		end, offset := 0, 0
		for _, l := range strings.Split(content, "\n") {
			next := offset + len(l) + 1
			if horizontalRule(strings.TrimSuffix(l, "\r")) {
				end = min(next, len(content))
			}
			offset = next
		}
		return content[end:]
	}
	n, _ := regionCount(spec)
	switch {
	case strings.HasPrefix(spec, "bottom_lines("):
		return fromLine(content, lines, max(len(lines)-n, 0))
	case strings.HasPrefix(spec, "bottom_non_empty_lines("):
		start, seen := -1, 0
		for i := len(lines) - 1; i >= 0 && seen < n; i-- {
			if strings.TrimSpace(lines[i]) != "" {
				start, seen = i, seen+1
			}
		}
		if start < 0 {
			return ""
		}
		return fromLine(content, lines, start)
	case strings.HasPrefix(spec, "top_non_empty_lines("):
		end, seen := -1, 0
		for i := 0; i < len(lines) && seen < n; i++ {
			if strings.TrimSpace(lines[i]) != "" {
				end, seen = i, seen+1
			}
		}
		if end < 0 {
			return ""
		}
		return content[:lineOffset(content, lines, end+1)]
	}
	return ""
}

// lineOffset is the byte offset of line i (each line and its "\n").
func lineOffset(content string, lines []string, i int) int {
	off := 0
	for _, l := range lines[:min(i, len(lines))] {
		off += len(l) + 1
	}
	return min(off, len(content))
}

func fromLine(content string, lines []string, i int) string {
	return content[lineOffset(content, lines, i):]
}

func codexPrompt(l string) bool { return l == "›" || strings.HasPrefix(l, "› ") }

func codexBlockMarker(l string) bool {
	for _, p := range []string{"•", "■", "✗", "✓"} {
		if strings.HasPrefix(l, p) {
			return true
		}
	}
	return false
}

// currentCodexPrompt is the last prompt line with no block marker after it.
func currentCodexPrompt(lines []string) (int, bool) {
	p := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if codexPrompt(lines[i]) {
			p = i
			break
		}
	}
	if p < 0 {
		return 0, false
	}
	for _, l := range lines[p+1:] {
		if codexBlockMarker(l) {
			return 0, false
		}
	}
	return p, true
}

// promptBoxTop is the second horizontal rule from the bottom.
func promptBoxTop(lines []string) (int, bool) {
	seen := 0
	for i := len(lines) - 1; i >= 0; i-- {
		if horizontalRule(lines[i]) {
			if seen++; seen == 2 {
				return i, true
			}
		}
	}
	return 0, false
}

func abovePromptBox(content string, lines []string) string {
	top, ok := promptBoxTop(lines)
	if !ok {
		return content
	}
	return content[:lineOffset(content, lines, top)]
}

// horizontalRule: a line of "─" alone, or of at least three followed by
// anything (a titled rule).
func horizontalRule(l string) bool {
	t := strings.TrimSpace(l)
	if t == "" {
		return false
	}
	n := 0
	rest := t
	for strings.HasPrefix(rest, "─") {
		rest = rest[len("─"):]
		n++
	}
	if n == 0 {
		return false
	}
	return strings.TrimSpace(rest) == "" || n >= 3
}

// goRegex writes the Rust regex syntax herdr's manifests use that Go's
// RE2 spells differently: \uXXXX and \u{X} code points, and the
// Alphabetic property (letters here).
func goRegex(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		rest := s[i+1:]
		switch {
		case strings.HasPrefix(rest, "u{"):
			if end := strings.IndexByte(rest, '}'); end > 0 {
				b.WriteString(`\x{` + rest[2:end] + "}")
				i += end + 1
				continue
			}
		case len(rest) >= 5 && rest[0] == 'u' && isHex(rest[1:5]):
			b.WriteString(`\x{` + rest[1:5] + "}")
			i += 5
			continue
		case strings.HasPrefix(rest, "p{Alphabetic}"), strings.HasPrefix(rest, "P{Alphabetic}"):
			b.WriteString(`\` + rest[:1] + "{L}")
			i += len("p{Alphabetic}")
			continue
		}
		// Any other escape, the escaped character included.
		b.WriteString(s[i : i+2])
		i++
	}
	return b.String()
}

func isHex(s string) bool {
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}
