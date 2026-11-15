package machines

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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
	// ErrLocalMachine is returned when removing or renaming the machine the
	// core runs on.
	ErrLocalMachine = errors.New("the local machine cannot be removed or renamed")
	// ErrLabelTaken is returned when another machine has the label
	// (--machine selects machines by label).
	ErrLabelTaken = errors.New("another machine has this label")
)

// registryFile is the content of machines[-<instance>].json.
type registryFile struct {
	Version  int    `json:"version"`
	Machines []Spec `json:"machines"`
	// Enabled is what an earlier version kept in the file: the machines the
	// user enabled or disabled over herdr's saved machines. It is read once,
	// when the machines are imported.
	Enabled map[string]bool `json:"enabled,omitempty"`
}

const registryVersion = 1

// Registry is the core's own list of machines, in the machines file beside
// its settings: the SSH machines added from the UI (or imported once from
// herdr's saved machines) and, once it was enabled or disabled, a record of
// the local machine. Machines given with --ssh are not in it. Every change
// is written at once; the file is the core's, read when it starts.
type Registry struct {
	path string
	mu   sync.Mutex
	list []Spec
}

// OpenRegistry reads the machines file at path. When there is none, or it
// holds what an earlier version kept there, the machines come once from imp
// (herdr's saved machines, SavedSpecs) with the user's earlier choices
// applied, and are written: herdr's catalog is not read again. An empty
// path keeps the machines in memory only. On an error the registry returned
// keeps its machines in memory only, so that a file that could not be read
// is not overwritten.
func OpenRegistry(path string, imp func() ([]Spec, error)) (*Registry, error) {
	if path == "" {
		return &Registry{}, nil
	}
	b, _, err := userfile.Read(path)
	if err != nil {
		return &Registry{}, err
	}
	var f registryFile
	if b != nil {
		if err := json.Unmarshal(b, &f); err != nil {
			return &Registry{}, fmt.Errorf("%s: %w", path, err)
		}
		if f.Version != 0 || f.Machines != nil {
			r := &Registry{path: path}
			for _, s := range f.Machines {
				if s, ok := valid(s); ok && r.index(s.ID) < 0 {
					r.list = append(r.list, s)
				}
			}
			return r, nil
		}
	}
	r := &Registry{path: path}
	if imp != nil {
		saved, err := imp()
		if err != nil {
			return &Registry{}, fmt.Errorf("importing herdr's machines: %w", err)
		}
		for _, s := range saved {
			if on, ok := f.Enabled[s.ID]; ok {
				s.Enabled = on
			}
			if s, ok := valid(s); ok && r.index(s.ID) < 0 {
				r.list = append(r.list, s)
			}
		}
	}
	if on, ok := f.Enabled[LocalID]; ok && !on {
		r.list = append(r.list, Spec{ID: LocalID, Kind: KindLocal})
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r, r.save()
}

// MaxTargetLen bounds an ssh target.
const MaxTargetLen = 255

// ValidTarget accepts an ssh destination: a ~/.ssh/config alias, host,
// user@host, host:port, [IPv6] or ssh://user@host:port URL. Only letters,
// digits and . _ - @ : / [ ] % are allowed, so a target holds no space,
// control character or shell metacharacter, and it does not start with "-",
// which ssh would take for an option. Every ssh command also puts "--"
// before it (internal/transport).
func ValidTarget(t string) bool {
	if t == "" || len(t) > MaxTargetLen || t[0] == '-' {
		return false
	}
	for i := 0; i < len(t); i++ {
		switch c := t[i]; {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		case strings.IndexByte("._-@:/[]%", c) >= 0:
		default:
			return false
		}
	}
	return true
}

// ErrInvalidTarget is returned for a machine whose ssh target ValidTarget
// refuses.
var ErrInvalidTarget = errors.New("invalid ssh target")

// valid returns a record as it is stored: an SSH machine with an id and a
// valid target, or the local machine's.
func valid(s Spec) (Spec, bool) {
	switch {
	case s.ID == LocalID:
		return Spec{ID: LocalID, Kind: KindLocal, Enabled: s.Enabled}, true
	case s.ID == "" || !ValidTarget(s.Target):
		return s, false
	}
	s.Kind = KindSSH
	if s.Label == "" {
		s.Label = s.Target
	}
	return s, true
}

// index returns the position of machine id; r.mu is held or r is not shared.
func (r *Registry) index(id string) int {
	for i, s := range r.list {
		if s.ID == id {
			return i
		}
	}
	return -1
}

// Specs returns the stored machines in their order.
func (r *Registry) Specs() []Spec {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Spec(nil), r.list...)
}

// Get returns machine id's record.
func (r *Registry) Get(id string) (Spec, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if i := r.index(id); i >= 0 {
		return r.list[i], true
	}
	return Spec{}, false
}

// Put adds a record, or replaces the one with its id, and writes the file.
func (r *Registry) Put(s Spec) error {
	s, ok := valid(s)
	if !ok {
		return fmt.Errorf("machine record without an id or a valid target: %w", ErrInvalidTarget)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := append([]Spec(nil), r.list...)
	if i := r.index(s.ID); i >= 0 {
		r.list[i] = s
	} else {
		r.list = append(r.list, s)
	}
	if err := r.save(); err != nil {
		r.list = prev
		return err
	}
	return nil
}

// Delete removes machine id's record, if there is one, and writes the file.
func (r *Registry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	i := r.index(id)
	if i < 0 {
		return nil
	}
	prev := append([]Spec(nil), r.list...)
	r.list = append(r.list[:i:i], r.list[i+1:]...)
	if err := r.save(); err != nil {
		r.list = prev
		return err
	}
	return nil
}

// save writes the file atomically (0600); r.mu is held.
func (r *Registry) save() error {
	if r.path == "" {
		return nil
	}
	list := r.list
	if list == nil {
		list = []Spec{}
	}
	b, err := json.MarshalIndent(registryFile{Version: registryVersion, Machines: list}, "", "  ")
	if err != nil {
		return err
	}
	_, err = userfile.Write(r.path, append(b, '\n'))
	return err
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
// record gives its enabled flag; its label is the host's name. Machines
// whose target ValidTarget refuses are left out.
func LoadSpecs(stored, extra []Spec) []Spec {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSuffix(hostname, ".local")
	local := Spec{ID: LocalID, Label: hostname + " (local)", Kind: KindLocal, Enabled: true}
	specs := []Spec{local}
	seen := map[string]bool{LocalID: true}
	for _, s := range stored {
		if s.ID == LocalID {
			specs[0].Enabled = s.Enabled
			continue
		}
		if seen[s.ID] || s.Kind != KindSSH || !ValidTarget(s.Target) {
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
