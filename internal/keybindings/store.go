// Package keybindings is the one keybinding system of every client (web UI,
// desktop app), modeled on VS Code's: commands with
// default keys per platform, registered here, and a hand-editable file of
// the user's rules ({key, command, when}; command "-<id>" removes a binding)
// on the core host. The core serves the effective bindings of every platform
// and their conflicts (GET /api/keybindings); the clients only match keys.
// See docs/features/04-layout-and-keyboard.md.
package keybindings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"veldr/internal/userfile"
)

// Rule is a binding: a user's rule, or one in effect.
type Rule struct {
	Key     string `json:"key"`
	Command string `json:"command"`
	When    When   `json:"when,omitempty"`
}

// Problem is something wrong in the user's file: an entry that is not a
// valid rule ("invalid"), a command no version of the core has ("unknown"),
// or a file that is not a JSON array ("parse", Index -1).
type Problem struct {
	Index  int    `json:"index"`
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// Conflict is a key that runs more than one command in the same place, or
// a stroke bound on its own that also starts chords (which then never run).
type Conflict struct {
	Key      string   `json:"key"`
	Commands []string `json:"commands"`
	Prefix   bool     `json:"prefix,omitempty"`
}

// Errors of SetUser.
var (
	ErrInvalid = errors.New("invalid keybindings")
	ErrFile    = errors.New("the keybindings file has errors")
)

// Limits of the user's rules.
const (
	MaxRules = 1000
	maxBytes = 256 << 10
)

var commandRE = regexp.MustCompile(`^-?[A-Za-z0-9_.:-]{1,128}$`)

// Store holds the commands and the user's rules.
type Store struct {
	commands []Command
	byID     map[string]Command

	mu   sync.Mutex
	path string
	sig  userfile.Sig
	// user is the file's entries as written, kept whatever they hold.
	user     []json.RawMessage
	rules    []Rule // the entries that apply, in order
	problems []Problem
	broken   bool
	subs     []func()
}

// New returns a store for the commands, saved in path ("" keeps rules in
// memory). Invalid default keys panic: they are programming errors.
func New(path string, commands []Command) *Store {
	s := &Store{commands: commands, byID: map[string]Command{}, path: path}
	for _, c := range commands {
		if _, dup := s.byID[c.ID]; dup || !commandRE.MatchString(c.ID) || strings.HasPrefix(c.ID, "-") || !validWhen(c.When) {
			panic("keybindings: invalid command " + c.ID)
		}
		for _, d := range c.Defaults {
			if n, err := Normalize(d.Key); err != nil || n != d.Key {
				panic(fmt.Sprintf("keybindings: %s: default %q is not canonical (%v)", c.ID, d.Key, err))
			}
		}
		s.byID[c.ID] = c
	}
	return s
}

// SetPath sets the file rules are saved in (before Load).
func (s *Store) SetPath(path string) {
	s.mu.Lock()
	s.path = path
	s.mu.Unlock()
}

// Path is the keybindings file.
func (s *Store) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path
}

// Load reads the file; a missing file has no rules.
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return nil
	}
	return s.read()
}

// read loads the file; s.mu is held. A file that is not a JSON array keeps
// the rules read before and is reported.
func (s *Store) read() error {
	b, sig, err := userfile.Read(s.path)
	if err != nil {
		return err
	}
	s.sig = sig
	var user []json.RawMessage
	if len(bytes.TrimSpace(b)) > 0 {
		if err := json.Unmarshal(b, &user); err != nil {
			s.broken = true
			s.problems = []Problem{{Index: -1, Code: "parse", Detail: err.Error()}}
			return nil
		}
	}
	s.broken = false
	s.set(user)
	return nil
}

// set makes user the current entries; s.mu is held.
func (s *Store) set(user []json.RawMessage) {
	var rules []Rule
	var problems []Problem
	for i, raw := range user {
		r, err := parseRule(raw)
		if err != nil {
			problems = append(problems, Problem{Index: i, Code: "invalid", Detail: err.Error()})
			continue
		}
		id := strings.TrimPrefix(r.Command, "-")
		if _, ok := s.byID[id]; !ok {
			problems = append(problems, Problem{Index: i, Code: "unknown", Detail: r.Command})
			continue
		}
		rules = append(rules, r)
	}
	s.user, s.rules, s.problems = user, rules, problems
}

// parseRule reads one entry of the file, normalizing its key.
func parseRule(raw json.RawMessage) (Rule, error) {
	var r Rule
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&r); err != nil {
		return r, errors.New("not a rule object")
	}
	if !commandRE.MatchString(r.Command) {
		return r, fmt.Errorf("invalid command %q", r.Command)
	}
	if r.When != "" && !validWhen(r.When) {
		return r, fmt.Errorf("invalid when %q", r.When)
	}
	if r.Key == "" && strings.HasPrefix(r.Command, "-") {
		// Removes every binding of the command.
		return r, nil
	}
	key, err := Normalize(r.Key)
	if err != nil {
		return r, err
	}
	r.Key = key
	return r, nil
}

// Watch reloads the file when it changes on disk, checking every interval
// until ctx ends.
func (s *Store) Watch(ctx context.Context, every time.Duration) {
	userfile.Poll(ctx, every, s.Reload)
}

// Reload reads the file again if it changed since it was last read or
// written, and notifies the subscribers.
func (s *Store) Reload() {
	s.mu.Lock()
	if s.path == "" || userfile.Stat(s.path) == s.sig {
		s.mu.Unlock()
		return
	}
	if err := s.read(); err != nil {
		s.mu.Unlock()
		return
	}
	subs := slices.Clone(s.subs)
	s.mu.Unlock()
	for _, fn := range subs {
		fn()
	}
}

// SetUser validates and saves the user's rules, replacing them. Entries
// naming commands this version does not have are kept (another version may);
// entries that are not valid rules are refused.
func (s *Store) SetUser(user []json.RawMessage) error {
	if len(user) > MaxRules {
		return fmt.Errorf("%w: more than %d rules", ErrInvalid, MaxRules)
	}
	for i, raw := range user {
		if _, err := parseRule(raw); err != nil {
			return fmt.Errorf("%w: rule %d: %v", ErrInvalid, i+1, err)
		}
	}
	data, err := encode(user)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	s.mu.Lock()
	if s.path != "" {
		// A file that is not an array is not written over: it is being
		// edited by hand.
		if userfile.Stat(s.path) != s.sig {
			s.read()
		}
		if s.broken {
			s.mu.Unlock()
			return ErrFile
		}
		sig, err := userfile.Write(s.path, data)
		if err != nil {
			s.mu.Unlock()
			return err
		}
		s.sig, s.broken = sig, false
	}
	s.set(slices.Clone(user))
	subs := slices.Clone(s.subs)
	s.mu.Unlock()
	for _, fn := range subs {
		fn()
	}
	return nil
}

// encode writes the file: the array, one rule after another.
func encode(user []json.RawMessage) ([]byte, error) {
	if user == nil {
		user = []json.RawMessage{}
	}
	b, err := json.MarshalIndent(user, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(b) > maxBytes {
		return nil, errors.New("too large")
	}
	return append(b, '\n'), nil
}

// OnChange registers fn to be called after the rules change.
func (s *Store) OnChange(fn func()) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// Defaults returns the default bindings on a platform, in command order.
func (s *Store) Defaults(platform string) []Rule {
	var out []Rule
	for _, c := range s.commands {
		for _, d := range c.Defaults {
			if len(d.Platforms) == 0 || slices.Contains(d.Platforms, platform) {
				out = append(out, Rule{Key: d.Key, Command: c.ID, When: c.When})
			}
		}
	}
	return out
}

// effective applies rules to the defaults on a platform; s.mu is held.
func (s *Store) effective(platform string) []Rule {
	out := s.Defaults(platform)
	for _, r := range s.rules {
		if id, remove := strings.CutPrefix(r.Command, "-"); remove {
			out = slices.DeleteFunc(out, func(e Rule) bool {
				return e.Command == id && (r.Key == "" || e.Key == r.Key) && (r.When == "" || e.When == r.When)
			})
			continue
		}
		if r.When == "" {
			r.When = s.byID[r.Command].When
		}
		if !slices.Contains(out, r) {
			out = append(out, r)
		}
	}
	if out == nil {
		out = []Rule{}
	}
	return out
}

// overlaps tells whether two bindings can apply at the same time; the main
// UI's (terminal) also apply in VS Code panes, for the keys VS Code leaves,
// and wherever outside terminals (editor) does.
func overlaps(a, b When) bool {
	if a == b || a == WhenAlways || b == WhenAlways {
		return true
	}
	main := func(w When) bool { return w == WhenTerminal || w == WhenEditor || w == WhenVSCode }
	return main(a) && main(b)
}

// Conflicts finds keys that run several commands in the same place, and
// strokes bound alone that start chords too.
func Conflicts(effective []Rule) []Conflict {
	var out []Conflict
	byKey := map[string][]Rule{}
	var keys []string
	for _, r := range effective {
		if _, ok := byKey[r.Key]; !ok {
			keys = append(keys, r.Key)
		}
		byKey[r.Key] = append(byKey[r.Key], r)
	}
	sort.Strings(keys)
	add := func(key string, prefix bool, rules []Rule) {
		var ids []string
		for _, r := range rules {
			if !slices.Contains(ids, r.Command) {
				ids = append(ids, r.Command)
			}
		}
		if len(ids) > 1 {
			out = append(out, Conflict{Key: key, Commands: ids, Prefix: prefix})
		}
	}
	for _, k := range keys {
		rules := byKey[k]
		var clash []Rule
		for i, a := range rules {
			for _, b := range rules[i+1:] {
				if a.Command != b.Command && overlaps(a.When, b.When) {
					clash = append(clash, a, b)
				}
			}
		}
		add(k, false, clash)
		if strings.Contains(k, " ") {
			continue
		}
		// A single stroke that starts chords shadows them where both apply.
		var shadow []Rule
		for _, a := range rules {
			for _, other := range keys {
				if strings.HasPrefix(other, k+" ") {
					for _, b := range byKey[other] {
						if overlaps(a.When, b.When) {
							shadow = append(shadow, a, b)
						}
					}
				}
			}
		}
		add(k, true, shadow)
	}
	if out == nil {
		out = []Conflict{}
	}
	return out
}

// CommandJSON is a command as the API lists it.
type CommandJSON struct {
	ID      string `json:"id"`
	Section string `json:"section"`
	When    When   `json:"when"`
}

// State is the user's rules and what follows from them on every platform:
// what the API returns and pushes after each change.
type State struct {
	User      []json.RawMessage     `json:"user"`
	Effective map[string][]Rule     `json:"effective"`
	Conflicts map[string][]Conflict `json:"conflicts"`
	Problems  []Problem             `json:"problems"`
}

// State returns the user's rules, the effective bindings and conflicts per
// platform, and the problems of the file.
func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := State{User: slices.Clone(s.user), Effective: map[string][]Rule{}, Conflicts: map[string][]Conflict{},
		Problems: slices.Clone(s.problems)}
	if st.User == nil {
		st.User = []json.RawMessage{}
	}
	if st.Problems == nil {
		st.Problems = []Problem{}
	}
	for _, p := range Platforms {
		eff := s.effective(p)
		st.Effective[p] = eff
		st.Conflicts[p] = Conflicts(eff)
	}
	return st
}

// CommandList lists the commands for the API.
func (s *Store) CommandList() []CommandJSON {
	out := make([]CommandJSON, len(s.commands))
	for i, c := range s.commands {
		out[i] = CommandJSON{ID: c.ID, Section: c.Section, When: c.When}
	}
	return out
}

// AllDefaults returns the default bindings of every platform.
func (s *Store) AllDefaults() map[string][]Rule {
	out := map[string][]Rule{}
	for _, p := range Platforms {
		out[p] = s.Defaults(p)
		if out[p] == nil {
			out[p] = []Rule{}
		}
	}
	return out
}
