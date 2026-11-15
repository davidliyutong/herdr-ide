package machines

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"herdr-ide/internal/userfile"
)

// Kind of machine transport.
const (
	KindLocal = "local"
	KindSSH   = "ssh"
)

// LocalID is the id of the machine the core runs on.
const LocalID = "local"

// Spec describes one machine: the record the core keeps in its machines
// file (Registry).
type Spec struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Kind    string `json:"kind"`
	Target  string `json:"target,omitempty"`
	Enabled bool   `json:"enabled"`
}

// Errors of the machine registry and manager.
var (
	// ErrUnknownMachine is returned for a machine the core does not know.
	ErrUnknownMachine = errors.New("unknown machine")
	// ErrMachineExists is returned when adding a machine (an id or an ssh
	// target) the core has already.
	ErrMachineExists = errors.New("machine exists")
	// ErrLocalMachine is returned when removing the machine the core runs
	// on.
	ErrLocalMachine = errors.New("the local machine cannot be removed")
	// ErrLabelTaken is returned when another machine has the label
	// (--machine selects machines by label).
	ErrLabelTaken = errors.New("another machine has this label")
	// ErrInvalidOrder is returned for an order of the machines that does
	// not name each of them once.
	ErrInvalidOrder = errors.New("the order does not name each machine once")
)

// registryVersion is the version of the machines file this core writes.
const registryVersion = 1

// specFields are the fields of a record Spec reads; a record's other fields
// are kept as they are.
var specFields = []string{"id", "label", "kind", "target", "enabled"}

// record is one entry of the machines file: a machine (spec) with the
// fields this version does not know (extra), or, when raw is set, an entry
// that is no machine this version can use (not an object, no id, an id
// already taken, a kind it does not have), kept as written.
type record struct {
	spec  Spec
	extra map[string]json.RawMessage
	raw   json.RawMessage
}

// Registry is the core's own list of machines, in the machines file beside
// its settings: the SSH machines added from the UI (or imported once from
// herdr's saved machines) and, once it was enabled or disabled, a record of
// the local machine. Machines given with --ssh are not in it. Every change
// is written at once; the file is the core's, read when it starts. Writing
// it keeps what the core does not use: entries it cannot read as machines,
// fields of records and of the file it does not know, and machines whose
// target ValidTarget refuses (they are listed, in an error state, and
// never dialed: Machine).
type Registry struct {
	path string
	mu   sync.Mutex
	list []record
	// order is the order the user put the machines in (ids, the local
	// machine's and those given with --ssh included); machines it does not
	// name follow, as they come (SortByOrder).
	order []string
	// version and extra are the file's version and its fields other than
	// "version", "machines" and "order".
	version int
	extra   map[string]json.RawMessage
}

// OpenRegistry reads the machines file at path. When there is none, or it
// holds what an earlier version kept there ({"enabled": {...}}), the
// machines come once from imp (herdr's saved machines, SavedSpecs) with the
// user's earlier choices applied, and are written: herdr's catalog is not
// read again. An empty path keeps the machines in memory only. On an error
// the registry returned keeps its machines in memory only, so that a file
// that could not be read is not overwritten.
func OpenRegistry(path string, imp func() ([]Spec, error)) (*Registry, error) {
	if path == "" {
		return &Registry{}, nil
	}
	b, _, err := userfile.Read(path)
	if err != nil {
		return &Registry{}, err
	}
	var top map[string]json.RawMessage
	if b != nil {
		if err := json.Unmarshal(b, &top); err != nil {
			return &Registry{}, fmt.Errorf("%s: %w", path, err)
		}
	}
	_, hasVersion := top["version"]
	_, hasMachines := top["machines"]
	if hasVersion || hasMachines {
		r := &Registry{path: path, version: registryVersion}
		if hasVersion && json.Unmarshal(top["version"], &r.version) != nil {
			return &Registry{}, fmt.Errorf("%s: version is not a number", path)
		}
		var entries []json.RawMessage
		if hasMachines && string(top["machines"]) != "null" && json.Unmarshal(top["machines"], &entries) != nil {
			return &Registry{}, fmt.Errorf("%s: machines is not a list", path)
		}
		for _, e := range entries {
			r.list = append(r.list, r.parse(e))
		}
		if raw, ok := top["order"]; ok && string(raw) != "null" && json.Unmarshal(raw, &r.order) != nil {
			return &Registry{}, fmt.Errorf("%s: order is not a list of ids", path)
		}
		for k, v := range top {
			if k != "version" && k != "machines" && k != "order" {
				if r.extra == nil {
					r.extra = map[string]json.RawMessage{}
				}
				r.extra[k] = v
			}
		}
		return r, nil
	}
	var old struct {
		Enabled map[string]bool `json:"enabled"`
	}
	if b != nil && json.Unmarshal(b, &old) != nil {
		return &Registry{}, fmt.Errorf("%s: enabled is not a map of flags", path)
	}
	r := &Registry{path: path, version: registryVersion}
	if imp != nil {
		saved, err := imp()
		if err != nil {
			return &Registry{}, fmt.Errorf("importing herdr's machines: %w", err)
		}
		for _, s := range saved {
			if on, ok := old.Enabled[s.ID]; ok {
				s.Enabled = on
			}
			e, _ := json.Marshal(s)
			r.list = append(r.list, r.parse(e))
		}
	}
	if on, ok := old.Enabled[LocalID]; ok && !on && r.index(LocalID) < 0 {
		r.list = append(r.list, record{spec: Spec{ID: LocalID, Kind: KindLocal}})
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r, r.save()
}

// parse reads one entry of the file; entries that are no machine this
// version can use come back raw. r is not shared yet.
func (r *Registry) parse(e json.RawMessage) record {
	var fields map[string]json.RawMessage
	var s Spec
	if json.Unmarshal(e, &fields) != nil || fields == nil || json.Unmarshal(e, &s) != nil {
		return record{raw: e}
	}
	s, ok := normalize(s)
	if !ok || r.index(s.ID) >= 0 {
		return record{raw: e}
	}
	for _, k := range specFields {
		delete(fields, k)
	}
	if len(fields) == 0 {
		fields = nil
	}
	return record{spec: s, extra: fields}
}

// normalize returns a record as the core uses it: the local machine's, or
// an SSH machine's with an id, labelled by its target when it has no label
// (by its id when the target is refused, so that no label shows what
// ValidTarget refuses). A record without an id, or of a kind this version
// does not have, is not one.
func normalize(s Spec) (Spec, bool) {
	switch {
	case s.ID == LocalID:
		return Spec{ID: LocalID, Label: s.Label, Kind: KindLocal, Enabled: s.Enabled}, true
	case s.ID == "" || (s.Kind != "" && s.Kind != KindSSH):
		return s, false
	}
	s.Kind = KindSSH
	if s.Label == "" {
		s.Label = s.Target
		if !ValidTarget(s.Target) {
			s.Label = s.ID
		}
	}
	return s, true
}

// index returns the position of machine id's record; r.mu is held or r is
// not shared.
func (r *Registry) index(id string) int {
	for i, e := range r.list {
		if e.raw == nil && e.spec.ID == id {
			return i
		}
	}
	return -1
}

// Specs returns the stored machines in their order, those whose target
// ValidTarget refuses included.
func (r *Registry) Specs() []Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Spec
	for _, e := range r.list {
		if e.raw == nil {
			out = append(out, e.spec)
		}
	}
	return out
}

// Kept returns how many entries of the file are no machine this version
// can use; they stay in the file as written.
func (r *Registry) Kept() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.list {
		if e.raw != nil {
			n++
		}
	}
	return n
}

// Get returns machine id's record.
func (r *Registry) Get(id string) (Spec, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if i := r.index(id); i >= 0 {
		return r.list[i].spec, true
	}
	return Spec{}, false
}

// Put adds a record, or replaces the one with its id (keeping the fields
// the core does not know), and writes the file. A new record, and a changed
// target, must pass ValidTarget; a stored record whose target fails it can
// still be renamed, enabled and disabled.
func (r *Registry) Put(s Spec) error {
	s, ok := normalize(s)
	if !ok {
		return errors.New("machine record without an id")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	i := r.index(s.ID)
	if s.Kind == KindSSH && !ValidTarget(s.Target) && (i < 0 || r.list[i].spec.Target != s.Target) {
		return ErrInvalidTarget
	}
	prev := append([]record(nil), r.list...)
	if i >= 0 {
		r.list[i].spec = s
	} else {
		r.list = append(r.list, record{spec: s})
	}
	if err := r.save(); err != nil {
		r.list = prev
		return err
	}
	return nil
}

// Order returns the order the user put the machines in.
func (r *Registry) Order() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.order)
}

// SetOrder stores the order of the machines (their ids) and writes the file.
func (r *Registry) SetOrder(ids []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.order
	r.order = slices.Clone(ids)
	if err := r.save(); err != nil {
		r.order = prev
		return err
	}
	return nil
}

// SortByOrder returns ids with those order names first, in its order, then
// the others as they come.
func SortByOrder(ids, order []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range order {
		if slices.Contains(ids, id) && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	for _, id := range ids {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// Delete removes machine id's record, if there is one, and writes the file.
func (r *Registry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	i := r.index(id)
	if i < 0 {
		return nil
	}
	prev := append([]record(nil), r.list...)
	r.list = append(r.list[:i:i], r.list[i+1:]...)
	if err := r.save(); err != nil {
		r.list = prev
		return err
	}
	return nil
}

// save writes the file atomically (0600); r.mu is held. Known fields come
// first, in their usual order, then the others, sorted.
func (r *Registry) save() error {
	if r.path == "" {
		return nil
	}
	entries := make([]json.RawMessage, 0, len(r.list))
	for _, e := range r.list {
		if e.raw != nil {
			entries = append(entries, e.raw)
			continue
		}
		s := e.spec
		known := map[string]any{"id": s.ID, "label": s.Label, "kind": s.Kind, "enabled": s.Enabled}
		if s.Target != "" {
			known["target"] = s.Target
		}
		b, err := object(specFields, known, e.extra)
		if err != nil {
			return err
		}
		entries = append(entries, b)
	}
	top := map[string]any{"version": max(r.version, registryVersion), "machines": entries}
	if len(r.order) > 0 {
		top["order"] = r.order
	}
	b, err := object([]string{"version", "machines", "order"}, top, r.extra)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, b, "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	_, err = userfile.Write(r.path, out.Bytes())
	return err
}

// object encodes a JSON object: the keys of order that known has, then the
// other fields of extra, sorted.
func object(order []string, known map[string]any, extra map[string]json.RawMessage) ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	field := func(k string, v any) error {
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		vb, err := json.Marshal(v)
		if err != nil {
			return err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
		return nil
	}
	for _, k := range order {
		if v, ok := known[k]; ok {
			if err := field(k, v); err != nil {
				return nil, err
			}
		}
	}
	rest := make([]string, 0, len(extra))
	for k := range extra {
		if _, ok := known[k]; !ok && !slices.Contains(order, k) {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		if err := field(k, extra[k]); err != nil {
			return nil, err
		}
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// herdr's saved machine catalog, imported once (SavedSpecs).
type endpointCatalog struct {
	Version int `json:"version"`
	SSH     []struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Target  string `json:"target"`
		Enabled bool   `json:"enabled"`
	} `json:"ssh"`
}

// SavedSpecs returns the SSH machines saved by herdr, the terminal
// multiplexer an earlier version drew its panes from, for the registry's
// one-time import: herdr's client/endpoints.json in its state directory
// ($XDG_STATE_HOME/herdr or ~/.local/state/herdr). No catalog means none;
// one that cannot be read is an error.
func SavedSpecs() ([]Spec, error) {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		state = filepath.Join(home, ".local", "state")
	}
	b, err := os.ReadFile(filepath.Join(state, "herdr", "client", "endpoints.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cat endpointCatalog
	if err := json.Unmarshal(b, &cat); err != nil {
		return nil, fmt.Errorf("herdr's machines: %w", err)
	}
	var specs []Spec
	for _, e := range cat.SSH {
		specs = append(specs, Spec{ID: e.ID, Label: e.Label, Kind: KindSSH, Target: e.Target, Enabled: e.Enabled})
	}
	return specs, nil
}

// LoadSpecs returns the local machine, the stored SSH machines and the
// extra (--ssh) ones not stored, each once. The local machine's stored
// record gives its enabled flag; its label is the host's name. Stored
// machines whose target ValidTarget refuses are kept (they show an error
// and are never dialed); extra ones are left out (the core refuses to start
// with one).
func LoadSpecs(stored, extra []Spec) []Spec {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSuffix(hostname, ".local")
	local := Spec{ID: LocalID, Label: hostname + " (local)", Kind: KindLocal, Enabled: true}
	specs := []Spec{local}
	seen := map[string]bool{LocalID: true}
	for _, s := range stored {
		if s.ID == LocalID {
			specs[0].Enabled = s.Enabled
			if s.Label != "" {
				specs[0].Label = s.Label
			}
			continue
		}
		if seen[s.ID] || s.Kind != KindSSH {
			continue
		}
		specs = append(specs, s)
		seen[s.ID] = true
	}
	for _, s := range extra {
		if s.ID == "" {
			s.ID = s.Target
		}
		if seen[s.ID] || !ValidTarget(s.Target) {
			continue
		}
		s.Kind = KindSSH
		if s.Label == "" {
			s.Label = s.Target
		}
		specs = append(specs, s)
		seen[s.ID] = true
	}
	return specs
}
