// Package settings is the one settings system of the core and of every
// client (web UI, desktop app, macOS application), modeled on VS Code's: a
// registry of typed definitions, a hand-editable JSON file on the core host,
// layered values and generic settings UIs rendered from the definitions.
//
// Packages define the settings they use (Module) and the core registers them
// all (internal/registry). Labels and descriptions are not here: the UIs
// translate settings.<key>, settings.<key>.desc and settings.<key>.<option>.
//
// A value comes from, in order: the command line (which locks the setting,
// also for every machine), the machine's own value for settings whose scope
// allows one, the file's global value, the default.
//
// The file (settings[-<instance>].json) holds global values as top-level
// "key": value pairs and a machine's own values under "[machine:<id>]".
// Keys it does not know and values that do not validate are kept when it is
// rewritten and reported as problems; such a value counts as unset.
package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/userfile"
)

// Type is the type of a setting's value.
type Type string

const (
	TypeBool   Type = "bool"
	TypeNumber Type = "number"
	TypeString Type = "string"
	TypeEnum   Type = "enum"
	TypeColor  Type = "color" // "#rrggbb"
	TypeList   Type = "list"  // of Item values
)

// Scope tells which machines may have their own value of a setting.
type Scope string

const (
	ScopeApp           Scope = "app"            // one value for everything
	ScopeMachine       Scope = "machine"        // any machine may differ
	ScopeRemoteMachine Scope = "remote-machine" // machines other than the core's host may differ
)

// Source tells where a setting's current value comes from.
type Source string

const (
	SourceDefault Source = "default"
	SourceGlobal  Source = "global"
	SourceMachine Source = "machine"
	SourceFlag    Source = "flag"
)

// Platforms a setting can be limited to (Def.Platforms).
const (
	PlatformWeb   = "web"   // the browser UI, also inside the desktop app
	PlatformMacOS = "macos" // the native macOS application
)

// Errors of Set and Reset; the API reports them as codes.
var (
	ErrUnknown = errors.New("unknown setting")
	ErrLocked  = errors.New("setting is fixed by a command-line flag")
	ErrInvalid = errors.New("invalid value")
	ErrScope   = errors.New("setting has no per-machine values")
	ErrFile    = errors.New("the settings file has errors")
)

// Section groups settings in the UIs; sections are shown by Order.
type Section struct {
	ID    string `json:"id"`
	Order int    `json:"order"`
}

// Def defines a setting.
type Def struct {
	Key  string // dotted, e.g. "terminal.fontSize"
	Type Type
	// Default is a bool, float64, string or []string, by Type.
	Default any
	// Enum lists the values of a TypeEnum setting.
	Enum []string
	// Min and Max bound a TypeNumber setting (nil: unbounded); Integer
	// refuses fractions.
	Min, Max *float64
	Integer  bool
	// Item is the type of a list's items (TypeString or TypeColor); Length
	// the number of items a list must have (0: any up to 256).
	Item   Type
	Length int
	Scope  Scope
	// Section and Order place the setting in the UIs.
	Section string
	Order   int
	// Platforms lists the clients that use the setting; empty for all.
	Platforms []string
	// Flag names a command-line flag that sets and locks the setting, with
	// Usage as its help text.
	Flag, Usage string
	// Validate checks a value beyond its type; nil accepts any.
	Validate func(any) error
}

// Range returns pointers for Def.Min and Def.Max.
func Range(min, max float64) (*float64, *float64) { return &min, &max }

// Migration moves a value of an older file format: From is the old key,
// To the new one ("" drops it), Convert turns the old string value into a
// new value (false keeps the entry under its old key).
type Migration struct {
	From, To string
	Convert  func(string) (any, bool)
}

// Module is what a package registers: its sections, settings and the
// migrations of its old keys.
type Module struct {
	Sections   []Section
	Defs       []Def
	Migrations []Migration
}

// Problem is something wrong in the settings file: a key no definition
// has ("unknown"), a value that does not validate ("invalid"), a
// per-machine value of a setting without them ("scope") or a file that is
// not JSON ("parse", without a key).
type Problem struct {
	Key     string `json:"key,omitempty"`
	Machine string `json:"machine,omitempty"`
	Code    string `json:"code"`
	Detail  string `json:"detail,omitempty"`
}

// Change names a setting whose value changed, globally (Machine "") or for
// one machine.
type Change struct {
	Key, Machine string
}

var colorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const maxString = 4096

// Normalize checks v (as decoded from JSON) against the definition and
// returns it in its canonical form: bool, float64, string or []string.
func (d Def) Normalize(v any) (any, error) {
	out, err := d.normalize(v)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrInvalid, d.Key, err)
	}
	if d.Validate != nil {
		if err := d.Validate(out); err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrInvalid, d.Key, err)
		}
	}
	return out, nil
}

func (d Def) normalize(v any) (any, error) {
	switch d.Type {
	case TypeBool:
		b, ok := v.(bool)
		if !ok {
			return nil, errors.New("must be true or false")
		}
		return b, nil
	case TypeNumber:
		var n float64
		switch x := v.(type) {
		case float64:
			n = x
		case int:
			n = float64(x)
		default:
			return nil, errors.New("must be a number")
		}
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return nil, errors.New("must be a finite number")
		}
		if d.Integer && n != math.Trunc(n) {
			return nil, errors.New("must be a whole number")
		}
		if d.Min != nil && n < *d.Min || d.Max != nil && n > *d.Max {
			return nil, fmt.Errorf("must be between %s and %s", fmtNum(d.Min), fmtNum(d.Max))
		}
		return n, nil
	case TypeString, TypeEnum, TypeColor:
		s, ok := v.(string)
		if !ok {
			return nil, errors.New("must be a string")
		}
		return normalizeString(d.Type, d.Enum, s)
	case TypeList:
		var items []string
		switch x := v.(type) {
		case []any:
			for _, it := range x {
				s, ok := it.(string)
				if !ok {
					return nil, errors.New("items must be strings")
				}
				items = append(items, s)
			}
		case []string:
			items = x
		default:
			return nil, errors.New("must be a list")
		}
		if d.Length > 0 && len(items) != d.Length {
			return nil, fmt.Errorf("must have %d items", d.Length)
		}
		if len(items) > 256 {
			return nil, errors.New("too many items")
		}
		out := make([]string, len(items))
		for i, s := range items {
			n, err := normalizeString(d.Item, nil, s)
			if err != nil {
				return nil, fmt.Errorf("item %d: %v", i+1, err)
			}
			out[i] = n.(string)
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown type %s", d.Type)
}

func normalizeString(t Type, enum []string, s string) (any, error) {
	if strings.ContainsAny(s, "\x00\n\r") || len(s) > maxString {
		return nil, errors.New("contains control characters or is too long")
	}
	switch t {
	case TypeEnum:
		if !slices.Contains(enum, s) {
			return nil, fmt.Errorf("must be one of %s", strings.Join(enum, ", "))
		}
	case TypeColor:
		if !colorRE.MatchString(s) {
			return nil, errors.New("must be a color #rrggbb")
		}
		s = strings.ToLower(s)
	}
	return s, nil
}

func fmtNum(p *float64) string {
	if p == nil {
		return "any"
	}
	return strconv.FormatFloat(*p, 'f', -1, 64)
}

// parseFlag turns a flag's text into a value of the setting.
func (d Def) parseFlag(s string) (any, error) {
	switch d.Type {
	case TypeBool:
		switch strings.ToLower(s) {
		case "true", "on", "yes", "1":
			return d.Normalize(true)
		case "false", "off", "no", "0":
			return d.Normalize(false)
		}
		return nil, fmt.Errorf("%w: %s must be true or false (on or off)", ErrInvalid, d.Key)
	case TypeNumber:
		n, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %s must be a number", ErrInvalid, d.Key)
		}
		return d.Normalize(n)
	case TypeList:
		var items []string
		if s != "" {
			items = strings.Split(s, ",")
		}
		return d.Normalize(items)
	}
	return d.Normalize(s)
}

// formatFlag writes a value the way the flag takes it.
func formatFlag(v any) string {
	switch x := v.(type) {
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []string:
		return strings.Join(x, ",")
	case string:
		return x
	}
	return ""
}

// machinePrefix and machineSuffix enclose a machine's id in the file:
// "[machine:<id>]".
const (
	machinePrefix = "[machine:"
	machineSuffix = "]"
)

func machineKey(id string) string { return machinePrefix + id + machineSuffix }

func machineOf(key string) (string, bool) {
	if strings.HasPrefix(key, machinePrefix) && strings.HasSuffix(key, machineSuffix) && len(key) > len(machinePrefix)+len(machineSuffix) {
		return key[len(machinePrefix) : len(key)-len(machineSuffix)], true
	}
	return "", false
}

// validMachine bounds machine ids taken from requests.
func validMachine(id string) bool {
	return id != "" && len(id) <= 256 && !strings.ContainsAny(id, "\x00\n\r[]")
}

// Store holds the definitions and the current values.
type Store struct {
	sections   []Section
	defs       []Def
	byKey      map[string]int
	migrations []Migration

	mu   sync.Mutex
	path string
	sig  userfile.Sig
	// raw is the file's content as last read or written: entries this
	// version does not know or cannot use are kept from here.
	raw      map[string]json.RawMessage
	global   map[string]any            // valid global values
	machines map[string]map[string]any // machine id → valid own values
	problems []Problem
	// broken is set while the file is not JSON: values stay as they were and
	// nothing is written over it.
	broken bool
	flags  map[string]any
	subs   []func([]Change)
}

// New returns a store for the modules' settings, saved in path ("" keeps
// values in memory). Invalid definitions panic: they are programming errors.
func New(path string, modules ...Module) *Store {
	s := &Store{byKey: map[string]int{}, path: path, raw: map[string]json.RawMessage{},
		global: map[string]any{}, machines: map[string]map[string]any{}, flags: map[string]any{}}
	sectionIDs := map[string]bool{}
	for _, m := range modules {
		for _, sec := range m.Sections {
			if sectionIDs[sec.ID] {
				panic("settings: duplicate section " + sec.ID)
			}
			sectionIDs[sec.ID] = true
			s.sections = append(s.sections, sec)
		}
		s.migrations = append(s.migrations, m.Migrations...)
	}
	sort.SliceStable(s.sections, func(i, j int) bool { return s.sections[i].Order < s.sections[j].Order })
	for _, m := range modules {
		for _, d := range m.Defs {
			if _, dup := s.byKey[d.Key]; dup || d.Key == "" || strings.HasPrefix(d.Key, "[") {
				panic("settings: invalid or duplicate key " + d.Key)
			}
			if !sectionIDs[d.Section] {
				panic("settings: " + d.Key + " is in unknown section " + d.Section)
			}
			if d.Scope == "" {
				d.Scope = ScopeApp
			}
			def, err := d.Normalize(d.Default)
			if err != nil {
				panic(err)
			}
			d.Default = def
			s.byKey[d.Key] = len(s.defs)
			s.defs = append(s.defs, d)
		}
	}
	sort.SliceStable(s.defs, func(i, j int) bool {
		a, b := s.defs[i], s.defs[j]
		if a.Section != b.Section {
			return sectionIndex(s.sections, a.Section) < sectionIndex(s.sections, b.Section)
		}
		return a.Order < b.Order
	})
	for i, d := range s.defs {
		s.byKey[d.Key] = i
	}
	return s
}

func sectionIndex(list []Section, id string) int {
	return slices.IndexFunc(list, func(s Section) bool { return s.ID == id })
}

// SetPath sets the file values are saved in (before Load).
func (s *Store) SetPath(path string) {
	s.mu.Lock()
	s.path = path
	s.mu.Unlock()
}

// Path is the settings file.
func (s *Store) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path
}

// Defs returns the definitions in UI order.
func (s *Store) Defs() []Def { return s.defs }

// Sections returns the sections in UI order.
func (s *Store) Sections() []Section { return s.sections }

// Lookup returns a setting's definition.
func (s *Store) Lookup(key string) (Def, bool) { return s.def(key) }

func (s *Store) def(key string) (Def, bool) {
	i, ok := s.byKey[key]
	if !ok {
		return Def{}, false
	}
	return s.defs[i], true
}

// Load reads the settings file (a missing file is empty) and migrates an
// older format once, rewriting the file. A file that is not JSON is
// reported as a problem and the defaults apply.
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return nil
	}
	if err := s.read(); err != nil {
		return err
	}
	if migrated, ok := s.migrate(s.raw); ok {
		if err := s.write(migrated); err != nil {
			return fmt.Errorf("migrating %s: %w", s.path, err)
		}
	}
	return nil
}

// read loads the file into raw and the values; s.mu is held.
func (s *Store) read() error {
	b, sig, err := userfile.Read(s.path)
	if err != nil {
		return err
	}
	s.sig = sig
	raw := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(b)) > 0 {
		if err := json.Unmarshal(b, &raw); err != nil || raw == nil {
			s.broken = true
			s.problems = []Problem{{Code: "parse", Detail: parseDetail(err)}}
			return nil
		}
	}
	s.broken = false
	s.raw = raw
	s.parse()
	return nil
}

func parseDetail(err error) string {
	if err == nil {
		return "not a JSON object"
	}
	return err.Error()
}

// parse derives the values and problems from raw; s.mu is held.
func (s *Store) parse() {
	global, machines := map[string]any{}, map[string]map[string]any{}
	var problems []Problem
	for _, k := range sortedKeys(s.raw) {
		if id, ok := machineOf(k); ok {
			var own map[string]json.RawMessage
			if json.Unmarshal(s.raw[k], &own) != nil {
				problems = append(problems, Problem{Key: k, Code: "invalid", Detail: "must be an object of settings"})
				continue
			}
			for _, key := range sortedKeys(own) {
				d, ok := s.def(key)
				switch {
				case !ok:
					problems = append(problems, Problem{Key: key, Machine: id, Code: "unknown"})
				case d.Scope == ScopeApp:
					problems = append(problems, Problem{Key: key, Machine: id, Code: "scope"})
				default:
					v, err := decodeValue(d, own[key])
					if err != nil {
						problems = append(problems, Problem{Key: key, Machine: id, Code: "invalid", Detail: err.Error()})
						continue
					}
					if machines[id] == nil {
						machines[id] = map[string]any{}
					}
					machines[id][key] = v
				}
			}
			continue
		}
		d, ok := s.def(k)
		if !ok {
			problems = append(problems, Problem{Key: k, Code: "unknown"})
			continue
		}
		v, err := decodeValue(d, s.raw[k])
		if err != nil {
			problems = append(problems, Problem{Key: k, Code: "invalid", Detail: err.Error()})
			continue
		}
		global[k] = v
	}
	s.global, s.machines, s.problems = global, machines, problems
}

func decodeValue(d Def, raw json.RawMessage) (any, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return d.Normalize(v)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// migrate returns raw in the current format when it holds entries of an
// older one: string values under old keys, and machines' values under
// "machines": {"<id>": {...}}.
func (s *Store) migrate(raw map[string]json.RawMessage) (map[string]json.RawMessage, bool) {
	changed := false
	// convert returns where an entry goes: its new key ("" when it is
	// dropped) and value; handled is false for entries of the current format.
	convert := func(k string, v json.RawMessage) (key string, val json.RawMessage, handled bool) {
		i := slices.IndexFunc(s.migrations, func(m Migration) bool { return m.From == k })
		var old string
		if i < 0 || json.Unmarshal(v, &old) != nil {
			return k, v, false
		}
		changed = true
		m := s.migrations[i]
		if m.To == "" {
			return "", nil, true
		}
		nv, ok := m.Convert(old)
		b, err := json.Marshal(nv)
		if !ok || err != nil {
			return k, v, true
		}
		return m.To, b, true
	}
	// place adds the entries to dst: those of the current format win over
	// migrated ones.
	place := func(dst, entries map[string]json.RawMessage) {
		var moved [][2]any
		for _, k := range sortedKeys(entries) {
			nk, nv, handled := convert(k, entries[k])
			switch {
			case !handled:
				dst[k] = entries[k]
			case nk != "":
				moved = append(moved, [2]any{nk, nv})
			}
		}
		for _, m := range moved {
			if _, ok := dst[m[0].(string)]; !ok {
				dst[m[0].(string)] = m[1].(json.RawMessage)
			}
		}
	}
	out := map[string]json.RawMessage{}
	top := map[string]json.RawMessage{}
	for k, v := range raw {
		if k != "machines" {
			top[k] = v
		}
	}
	place(out, top)
	var machines map[string]map[string]json.RawMessage
	if v, ok := raw["machines"]; ok {
		if json.Unmarshal(v, &machines) != nil {
			out["machines"] = v
		} else {
			changed = true
		}
	}
	for _, id := range sortedKeys(machines) {
		if machines[id] == nil || !validMachine(id) {
			continue
		}
		own := map[string]json.RawMessage{}
		if prev, ok := out[machineKey(id)]; ok && json.Unmarshal(prev, &own) != nil {
			continue
		}
		place(own, machines[id])
		if len(own) > 0 {
			b, _ := json.Marshal(own)
			out[machineKey(id)] = b
		}
	}
	return out, changed
}

// write saves raw as the file and makes it current; s.mu is held.
func (s *Store) write(raw map[string]json.RawMessage) error {
	if s.path != "" {
		if s.broken {
			return ErrFile
		}
		sig, err := userfile.Write(s.path, encode(raw))
		if err != nil {
			return err
		}
		s.sig = sig
	}
	s.raw = raw
	s.parse()
	return nil
}

// encode writes the file: global values first, then each machine's, keys
// sorted, two-space indentation.
func encode(raw map[string]json.RawMessage) []byte {
	var b bytes.Buffer
	b.WriteString("{")
	keys := sortedKeys(raw)
	sort.SliceStable(keys, func(i, j int) bool {
		_, mi := machineOf(keys[i])
		_, mj := machineOf(keys[j])
		return !mi && mj
	})
	for i, k := range keys {
		if i > 0 {
			b.WriteString(",")
		}
		name, _ := json.Marshal(k)
		var v bytes.Buffer
		if json.Indent(&v, raw[k], "  ", "  ") != nil {
			v.Reset()
			v.Write(raw[k])
		}
		fmt.Fprintf(&b, "\n  %s: %s", name, v.Bytes())
	}
	if len(keys) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return b.Bytes()
}

// Watch reloads the file when it changes on disk (edited by hand), checking
// every interval until ctx ends; subscribers learn what changed.
func (s *Store) Watch(ctx context.Context, every time.Duration) {
	userfile.Poll(ctx, every, s.Reload)
}

// Reload reads the file again if it changed since it was last read or
// written.
func (s *Store) Reload() {
	s.mu.Lock()
	if s.path == "" || userfile.Stat(s.path) == s.sig {
		s.mu.Unlock()
		return
	}
	before := s.effective()
	problems := slices.Clone(s.problems)
	if err := s.read(); err != nil {
		s.mu.Unlock()
		return
	}
	if migrated, ok := s.migrate(s.raw); ok {
		s.write(migrated)
	}
	changes := diff(before, s.effective())
	notify := len(changes) > 0 || !slices.Equal(problems, s.problems)
	subs := slices.Clone(s.subs)
	s.mu.Unlock()
	if notify {
		for _, fn := range subs {
			fn(changes)
		}
	}
}

// effective is every value the file sets: "" for global ones, else the
// machine; s.mu is held.
func (s *Store) effective() map[Change]any {
	out := map[Change]any{}
	for k, v := range s.global {
		out[Change{Key: k}] = v
	}
	for m, vals := range s.machines {
		for k, v := range vals {
			out[Change{Key: k, Machine: m}] = v
		}
	}
	return out
}

func diff(a, b map[Change]any) []Change {
	var out []Change
	for k, v := range a {
		if w, ok := b[k]; !ok || !equal(v, w) {
			out = append(out, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			out = append(out, k)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key != out[j].Key {
			return out[i].Key < out[j].Key
		}
		return out[i].Machine < out[j].Machine
	})
	return out
}

func equal(a, b any) bool {
	if x, ok := a.([]string); ok {
		y, ok := b.([]string)
		return ok && slices.Equal(x, y)
	}
	return a == b
}

type flagValue struct {
	s *Store
	d Def
}

func (f flagValue) String() string {
	if f.s == nil {
		return ""
	}
	return formatFlag(f.d.Default)
}

func (f flagValue) Set(v string) error {
	val, err := f.d.parseFlag(v)
	if err != nil {
		return err
	}
	f.s.mu.Lock()
	f.s.flags[f.d.Key] = val
	f.s.mu.Unlock()
	return nil
}

// RegisterFlags adds the settings' command-line flags to fs.
func (s *Store) RegisterFlags(fs *flag.FlagSet) {
	for _, d := range s.defs {
		if d.Flag != "" {
			fs.Var(flagValue{s, d}, d.Flag, d.Usage)
		}
	}
}

// valueFor returns a setting's value for a machine ("" for the global
// value) and its source; s.mu is held.
func (s *Store) valueFor(d Def, machine string) (any, Source) {
	if v, ok := s.flags[d.Key]; ok {
		return v, SourceFlag
	}
	if machine != "" && d.Scope != ScopeApp {
		if v, ok := s.machines[machine][d.Key]; ok {
			return v, SourceMachine
		}
	}
	if v, ok := s.global[d.Key]; ok {
		return v, SourceGlobal
	}
	return d.Default, SourceDefault
}

// Get returns a setting's global value (nil for unknown keys).
func (s *Store) Get(key string) any { return s.GetFor(key, "") }

// GetFor returns a setting's value for a machine ("" for the global value).
func (s *Store) GetFor(key, machine string) any {
	d, ok := s.def(key)
	if !ok {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, _ := s.valueFor(d, machine)
	if l, ok := v.([]string); ok {
		return slices.Clone(l)
	}
	return v
}

// String returns a string, enum or color setting's value for a machine.
func (s *Store) String(key, machine string) string {
	v, _ := s.GetFor(key, machine).(string)
	return v
}

// Bool returns a bool setting's value for a machine.
func (s *Store) Bool(key, machine string) bool {
	v, _ := s.GetFor(key, machine).(bool)
	return v
}

// Set validates and saves a value, globally (machine "") or as a machine's
// own value.
func (s *Store) Set(key, machine string, value any) error {
	d, ok := s.def(key)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknown, key)
	}
	if machine != "" && (d.Scope == ScopeApp || !validMachine(machine)) {
		return fmt.Errorf("%w: %s", ErrScope, key)
	}
	v, err := d.Normalize(value)
	if err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.change(d, machine, b)
}

// Reset removes a value: the global one (machine "") falls back to the
// default, a machine's own one to the global value.
func (s *Store) Reset(key, machine string) error {
	d, ok := s.def(key)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknown, key)
	}
	if machine != "" && !validMachine(machine) {
		return fmt.Errorf("%w: %s", ErrScope, key)
	}
	return s.change(d, machine, nil)
}

// change saves value (nil removes it) and notifies the subscribers.
func (s *Store) change(d Def, machine string, value json.RawMessage) error {
	s.mu.Lock()
	if _, ok := s.flags[d.Key]; ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: --%s", ErrLocked, d.Flag)
	}
	before := s.effective()
	// Edits made by hand since the last read are kept.
	if s.path != "" && userfile.Stat(s.path) != s.sig {
		if err := s.read(); err != nil {
			s.mu.Unlock()
			return err
		}
	}
	raw := map[string]json.RawMessage{}
	for k, v := range s.raw {
		raw[k] = v
	}
	if machine == "" {
		if value == nil {
			delete(raw, d.Key)
		} else {
			raw[d.Key] = value
		}
	} else {
		own := map[string]json.RawMessage{}
		if prev, ok := raw[machineKey(machine)]; ok && json.Unmarshal(prev, &own) != nil {
			s.mu.Unlock()
			return ErrFile
		}
		if value == nil {
			delete(own, d.Key)
		} else {
			own[d.Key] = value
		}
		if len(own) == 0 {
			delete(raw, machineKey(machine))
		} else {
			b, _ := json.Marshal(own)
			raw[machineKey(machine)] = b
		}
	}
	if err := s.write(raw); err != nil {
		s.mu.Unlock()
		return err
	}
	changes := diff(before, s.effective())
	if !slices.Contains(changes, Change{Key: d.Key, Machine: machine}) {
		changes = append(changes, Change{Key: d.Key, Machine: machine})
	}
	subs := slices.Clone(s.subs)
	s.mu.Unlock()
	for _, fn := range subs {
		fn(changes)
	}
	return nil
}

// OnChange registers fn to be called after values change (by the API or
// an edit of the file); changes can be empty when only the problems did.
func (s *Store) OnChange(fn func([]Change)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// DefJSON is a definition as the API lists it.
type DefJSON struct {
	Key       string   `json:"key"`
	Type      Type     `json:"type"`
	Default   any      `json:"default"`
	Enum      []string `json:"enum,omitempty"`
	Min       *float64 `json:"min,omitempty"`
	Max       *float64 `json:"max,omitempty"`
	Integer   bool     `json:"integer,omitempty"`
	Item      Type     `json:"item,omitempty"`
	Length    int      `json:"length,omitempty"`
	Scope     Scope    `json:"scope"`
	Section   string   `json:"section"`
	Order     int      `json:"order"`
	Platforms []string `json:"platforms,omitempty"`
	Flag      string   `json:"flag,omitempty"`
}

// Definitions lists the definitions for the API, in UI order.
func (s *Store) Definitions() []DefJSON {
	out := make([]DefJSON, 0, len(s.defs))
	for _, d := range s.defs {
		out = append(out, DefJSON{Key: d.Key, Type: d.Type, Default: d.Default, Enum: d.Enum, Min: d.Min, Max: d.Max,
			Integer: d.Integer, Item: d.Item, Length: d.Length, Scope: d.Scope, Section: d.Section, Order: d.Order,
			Platforms: d.Platforms, Flag: d.Flag})
	}
	return out
}

// Value is a setting's state for the API: its global value and source,
// machines' own values, and whether a flag fixes it.
type Value struct {
	Value    any            `json:"value"`
	Source   Source         `json:"source"`
	Machines map[string]any `json:"machines,omitempty"`
	Locked   bool           `json:"locked,omitempty"`
}

// State is every setting's value and the file's problems: what the API
// returns and pushes after each change.
type State struct {
	Values   map[string]Value `json:"values"`
	Problems []Problem        `json:"problems"`
}

// State returns the current values and problems.
func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := State{Values: map[string]Value{}, Problems: slices.Clone(s.problems)}
	if out.Problems == nil {
		out.Problems = []Problem{}
	}
	for _, d := range s.defs {
		v, src := s.valueFor(d, "")
		e := Value{Value: v, Source: src, Locked: src == SourceFlag}
		if d.Scope != ScopeApp {
			for m, vals := range s.machines {
				if mv, ok := vals[d.Key]; ok {
					if e.Machines == nil {
						e.Machines = map[string]any{}
					}
					e.Machines[m] = mv
				}
			}
		}
		out.Values[d.Key] = e
	}
	return out
}
