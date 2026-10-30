// Package settings holds core settings that can be changed at runtime from
// the web UI. Each setting is defined once (kind, default, allowed values,
// command-line flag) and the UI renders its form from those definitions, so
// adding a setting needs no UI code beyond its translated label.
//
// Values come from, in order: the command line (which locks the setting in
// the UI), the settings file on the core host, the default.
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
)

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
	mu    sync.Mutex
	defs  []Def
	saved map[string]string // from the file; unknown keys are kept
	flags map[string]string // given on the command line
	path  string
	subs  []func(key, value string)
}

// New returns a store for defs, saved in path ("" keeps values in memory).
func New(path string, defs ...Def) *Store {
	for _, d := range defs {
		if err := d.check(d.Default); d.Default != "" && err != nil {
			panic(err)
		}
	}
	return &Store{defs: defs, saved: map[string]string{}, flags: map[string]string{}, path: path}
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
	saved := map[string]string{}
	if err := json.Unmarshal(b, &saved); err != nil {
		return fmt.Errorf("%s: %w", s.path, err)
	}
	s.mu.Lock()
	s.saved = saved
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

// Get returns a setting's current value ("" for unknown keys).
func (s *Store) Get(key string) string {
	d, ok := s.def(key)
	if !ok {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, _ := s.value(d)
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
		fn(key, v)
	}
	return nil
}

// write saves the file atomically; s.mu must be held.
func (s *Store) write() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.saved, "", "  ")
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

// OnChange registers fn to be called after a setting changes.
func (s *Store) OnChange(fn func(key, value string)) {
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
}

// List returns every setting with its current value, in definition order.
func (s *Store) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, 0, len(s.defs))
	for _, d := range s.defs {
		v, src := s.value(d)
		out = append(out, Entry{Key: d.Key, Kind: d.Kind, Default: d.Default, Options: d.Options, Value: v, Source: src})
	}
	return out
}
