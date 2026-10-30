// Package settings holds core settings that can be changed at runtime from
// the web UI. Each setting is defined once (kind, default, allowed values,
// command-line flag) and the UI renders its form from those definitions, so
// adding a setting needs no UI code beyond its translated label.
//
// Values come from, in order: the command line (which locks the setting in
// the UI, also for every machine), the machine's own value for settings that
// can differ per machine, the settings file on the core host, the default.
package settings

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// Kind is the type of a setting's value; values are always carried as
// strings ("true"/"false" for KindBool).
type Kind string

const (
	KindEnum   Kind = "enum"
	KindString Kind = "string"
	KindBool   Kind = "bool"
)

// Source tells where a setting's current value comes from.
type Source string

const (
	SourceDefault Source = "default"
	SourceSaved   Source = "saved"
	SourceFlag    Source = "flag"
	SourceMachine Source = "machine"
)

// Scope tells which machines may have their own value of a setting.
type Scope string

const (
	ScopeNone   Scope = ""
	ScopeAll    Scope = "all"
	ScopeRemote Scope = "remote" // machines other than the core's host
)

// machinesKey holds per-machine values in the settings file:
// {"machines": {"<machine id>": {"<key>": "<value>"}}}.
const machinesKey = "machines"

// Errors returned by Set; the API reports them as codes.
var (
	ErrUnknown = errors.New("unknown setting")
	ErrLocked  = errors.New("setting is fixed by a command-line flag")
	ErrInvalid = errors.New("invalid value")
)

// Def defines a setting. Key doubles as the flag name and as the UI's
// translation key (settings.<key>).
type Def struct {
	Key     string
	Kind    Kind
	Default string
	// Options lists the allowed values of a KindEnum setting.
	Options []string
	// Usage is the flag's help text.
	Usage string
	// Validate checks a value beyond its kind; nil accepts any.
	Validate func(string) error
	// PerMachine lets machines override the value.
	PerMachine Scope
}

func (d Def) check(v string) error {
	switch d.Kind {
	case KindEnum:
		if !slices.Contains(d.Options, v) {
			return fmt.Errorf("%w: %s must be one of %s", ErrInvalid, d.Key, strings.Join(d.Options, ", "))
		}
	case KindBool:
		if _, err := strconv.ParseBool(v); err != nil {
			return fmt.Errorf("%w: %s must be true or false", ErrInvalid, d.Key)
		}
	}
	if strings.ContainsAny(v, "\x00\n\r") {
		return fmt.Errorf("%w: %s contains control characters", ErrInvalid, d.Key)
	}
	if d.Validate != nil {
		if err := d.Validate(v); err != nil {
			return fmt.Errorf("%w: %s: %v", ErrInvalid, d.Key, err)
		}
	}
	return nil
}

// Store holds the definitions and current values.
type Store struct {
	mu       sync.Mutex
	defs     []Def
	saved    map[string]string                     // from the file; unknown keys are kept
	machines map[string]map[string]json.RawMessage // machine id → key → value, as in the file
	other    map[string]json.RawMessage            // entries of the file that are not strings
	flags    map[string]string                     // given on the command line
	path     string
	subs     []func(key, machine, value string)
}

// New returns a store for defs, saved in path ("" keeps values in memory).
func New(path string, defs ...Def) *Store {
	for _, d := range defs {
		if err := d.check(d.Default); d.Default != "" && err != nil {
			panic(err)
		}
	}
	return &Store{defs: defs, saved: map[string]string{}, machines: map[string]map[string]json.RawMessage{},
		other: map[string]json.RawMessage{}, flags: map[string]string{}, path: path}
}

// SetPath sets the file values are saved in (before Load).
func (s *Store) SetPath(path string) {
	s.mu.Lock()
	s.path = path
	s.mu.Unlock()
}

// Load reads the settings file; a missing file is not an error. Saved values
// that are no longer valid are ignored.
func (s *Store) Load() error {
	if s.path == "" {
		return nil
	}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &raw); err != nil {
		return fmt.Errorf("%s: %w", s.path, err)
	}
	saved, machines, other := map[string]string{}, map[string]map[string]json.RawMessage{}, map[string]json.RawMessage{}
	for k, v := range raw {
		var str string
		switch {
		case k == machinesKey && json.Unmarshal(v, &machines) == nil:
		case json.Unmarshal(v, &str) == nil:
			saved[k] = str
		default:
			other[k] = v
		}
	}
	// "machines": null, or a machine with null, decode to nil maps.
	if machines == nil {
		machines = map[string]map[string]json.RawMessage{}
	}
	for m, vals := range machines {
		if vals == nil {
			delete(machines, m)
		}
	}
	s.mu.Lock()
	s.saved, s.machines, s.other = saved, machines, other
	s.mu.Unlock()
	return nil
}

type flagValue struct {
	s *Store
	d Def
}

func (f flagValue) String() string {
	if f.s == nil {
		return ""
	}
	return f.d.Default
}

func (f flagValue) Set(v string) error {
	if err := f.d.check(v); err != nil {
		return err
	}
	f.s.mu.Lock()
	f.s.flags[f.d.Key] = v
	f.s.mu.Unlock()
	return nil
}

func (f flagValue) IsBoolFlag() bool { return f.d.Kind == KindBool }

// RegisterFlags adds a flag per setting to fs.
func (s *Store) RegisterFlags(fs *flag.FlagSet) {
	for _, d := range s.defs {
		fs.Var(flagValue{s, d}, d.Key, d.Usage)
	}
}

func (s *Store) def(key string) (Def, bool) {
	for _, d := range s.defs {
		if d.Key == key {
			return d, true
		}
	}
	return Def{}, false
}

// value returns the current value and its source; s.mu must be held.
func (s *Store) value(d Def) (string, Source) {
	if v, ok := s.flags[d.Key]; ok {
		return v, SourceFlag
	}
	if v, ok := s.saved[d.Key]; ok && d.check(v) == nil {
		return v, SourceSaved
	}
	return d.Default, SourceDefault
}

// valueFor is value with the machine's own value; s.mu must be held.
func (s *Store) valueFor(d Def, machine string) (string, Source) {
	if _, ok := s.flags[d.Key]; !ok && machine != "" && d.PerMachine != ScopeNone {
		if v, ok := s.machineValue(machine, d); ok {
			return v, SourceMachine
		}
	}
	return s.value(d)
}

// machineValue is a machine's own valid value of d; s.mu must be held.
func (s *Store) machineValue(machine string, d Def) (string, bool) {
	raw, ok := s.machines[machine][d.Key]
	var v string
	if !ok || json.Unmarshal(raw, &v) != nil || d.check(v) != nil {
		return "", false
	}
	return v, true
}

// Get returns a setting's current value ("" for unknown keys).
func (s *Store) Get(key string) string {
	return s.GetFor(key, "")
}

// GetFor returns a setting's value for a machine ("" for the global value).
func (s *Store) GetFor(key, machine string) string {
	d, ok := s.def(key)
	if !ok {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, _ := s.valueFor(d, machine)
	return v
}

// Bool returns a KindBool setting's value.
func (s *Store) Bool(key string) bool {
	b, _ := strconv.ParseBool(s.Get(key))
	return b
}

// Set validates, saves and applies a value. An empty value of a setting
// whose default is not empty restores the default.
func (s *Store) Set(key, value string) error {
	d, ok := s.def(key)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknown, key)
	}
	reset := value == "" && d.Default != ""
	if !reset {
		if err := d.check(value); err != nil {
			return err
		}
	}
	s.mu.Lock()
	if _, ok := s.flags[key]; ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: --%s", ErrLocked, key)
	}
	old, hadOld := s.saved[key]
	if reset {
		delete(s.saved, key)
	} else {
		s.saved[key] = value
	}
	if err := s.write(); err != nil {
		if hadOld {
			s.saved[key] = old
		} else {
			delete(s.saved, key)
		}
		s.mu.Unlock()
		return err
	}
	v, _ := s.value(d)
	subs := slices.Clone(s.subs)
	s.mu.Unlock()
	for _, fn := range subs {
		fn(key, "", v)
	}
	return nil
}

// SetFor sets a machine's own value; "" makes the machine use the global
// value again. machine "" sets the global value.
func (s *Store) SetFor(key, machine, value string) error {
	if machine == "" {
		return s.Set(key, value)
	}
	d, ok := s.def(key)
	if !ok || d.PerMachine == ScopeNone {
		return fmt.Errorf("%w: %s per machine", ErrUnknown, key)
	}
	if strings.ContainsAny(machine, "\x00\n\r") || len(machine) > 256 {
		return fmt.Errorf("%w: machine id", ErrInvalid)
	}
	if value != "" {
		if err := d.check(value); err != nil {
			return err
		}
	}
	v, subs, err := s.setMachine(d, machine, value)
	if err != nil {
		return err
	}
	for _, fn := range subs {
		fn(key, machine, v)
	}
	return nil
}

// setMachine changes and saves a machine's own value under s.mu; it returns
// the value now in effect and the subscribers to notify.
func (s *Store) setMachine(d Def, machine, value string) (string, []func(key, machine, value string), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.flags[d.Key]; ok {
		return "", nil, fmt.Errorf("%w: --%s", ErrLocked, d.Key)
	}
	old, hadOld := s.machines[machine][d.Key]
	apply := func(v json.RawMessage, set bool) {
		if !set {
			delete(s.machines[machine], d.Key)
			if len(s.machines[machine]) == 0 {
				delete(s.machines, machine)
			}
			return
		}
		if s.machines[machine] == nil {
			s.machines[machine] = map[string]json.RawMessage{}
		}
		s.machines[machine][d.Key] = v
	}
	b, _ := json.Marshal(value)
	apply(b, value != "")
	if err := s.write(); err != nil {
		apply(old, hadOld)
		return "", nil, err
	}
	v, _ := s.valueFor(d, machine)
	return v, slices.Clone(s.subs), nil
}

// write saves the file atomically; s.mu must be held.
func (s *Store) write() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	out := map[string]any{}
	for k, v := range s.other {
		out[k] = v
	}
	for k, v := range s.saved {
		out[k] = v
	}
	if len(s.machines) > 0 {
		out[machinesKey] = s.machines
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// OnChange registers fn to be called after a setting changes, with the
// machine whose own value changed ("" for the global value) and the value
// now in effect there.
func (s *Store) OnChange(fn func(key, machine, value string)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// Entry describes a setting for the UI.
type Entry struct {
	Key     string   `json:"key"`
	Kind    Kind     `json:"kind"`
	Default string   `json:"default"`
	Options []string `json:"options,omitempty"`
	Value   string   `json:"value"`
	Source  Source   `json:"source"`
	// PerMachine and Machines (machine id → own value) for settings that can
	// differ per machine.
	PerMachine Scope             `json:"per_machine,omitempty"`
	Machines   map[string]string `json:"machines,omitempty"`
}

// List returns every setting with its current value, in definition order.
func (s *Store) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, 0, len(s.defs))
	for _, d := range s.defs {
		v, src := s.value(d)
		e := Entry{Key: d.Key, Kind: d.Kind, Default: d.Default, Options: d.Options, Value: v, Source: src, PerMachine: d.PerMachine}
		if d.PerMachine != ScopeNone {
			for m := range s.machines {
				if mv, ok := s.machineValue(m, d); ok {
					if e.Machines == nil {
						e.Machines = map[string]string{}
					}
					e.Machines[m] = mv
				}
			}
		}
		out = append(out, e)
	}
	return out
}
