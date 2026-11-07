package machines

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Overrides are the machines the user enabled or disabled in the UI. They
// take precedence over the enabled flag of herdr's saved machines and live in
// a file of the core (beside its settings), so herdr's own catalog is never
// written. Entries of machines that are not configured at the moment are
// kept.
type Overrides struct {
	path    string
	mu      sync.Mutex
	enabled map[string]bool
}

type overridesFile struct {
	Enabled map[string]bool `json:"enabled,omitempty"`
}

// LoadOverrides reads path; a missing or unreadable file gives none. An
// empty path keeps overrides in memory only.
func LoadOverrides(path string) *Overrides {
	o := &Overrides{path: path, enabled: map[string]bool{}}
	if path == "" {
		return o
	}
	if b, err := os.ReadFile(path); err == nil {
		var f overridesFile
		if json.Unmarshal(b, &f) == nil && f.Enabled != nil {
			o.enabled = f.Enabled
		}
	}
	return o
}

// Apply sets the enabled flag of the specs the user changed.
func (o *Overrides) Apply(specs []Spec) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range specs {
		if on, ok := o.enabled[specs[i].ID]; ok {
			specs[i].Enabled = on
		}
	}
}

// SetEnabled records the user's choice for machine id and saves the file.
func (o *Overrides) SetEnabled(id string, on bool) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.enabled[id] = on
	if o.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(overridesFile{Enabled: o.enabled}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(o.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(o.path), ".machines-*")
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
	return os.Rename(tmp.Name(), o.path)
}

// ErrUnknownMachine is returned for a machine the core does not know.
var ErrUnknownMachine = errors.New("unknown machine")
