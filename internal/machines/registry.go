package machines

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Kind of machine transport.
const (
	KindLocal = "local"
	KindSSH   = "ssh"
)

// LocalID is the id of the machine herdr-ide runs on.
const LocalID = "local"

// Spec describes one machine.
type Spec struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Kind    string `json:"kind"`
	Target  string `json:"target,omitempty"`
	Session string `json:"session"`
	Enabled bool   `json:"enabled"`
	// Saved: the machine is one of herdr's saved machines (not an --ssh
	// target), which `herdr machine remove` removes.
	Saved    bool   `json:"saved,omitempty"`
	HerdrBin string `json:"-"`
}

// herdr's saved machine catalog (~/.local/state/herdr/client/endpoints.json).
type endpointCatalog struct {
	Version int `json:"version"`
	SSH     []struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Target  string `json:"target"`
		Session string `json:"session"`
		Enabled bool   `json:"enabled"`
	} `json:"ssh"`
}

type sshMetadata struct {
	Metadata struct {
		OS         string `json:"os"`
		Executable string `json:"executable"`
	} `json:"metadata"`
}

// HerdrStateDir mirrors herdr's state_dir().
func HerdrStateDir() string {
	if x := os.Getenv("XDG_STATE_HOME"); x != "" {
		return filepath.Join(x, "herdr")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "herdr")
}

// HerdrExecutable is the herdr path herdr recorded for a saved SSH machine
// (it updates the record when it installs herdr there); "" when unknown.
func HerdrExecutable(id string) string {
	b, err := os.ReadFile(filepath.Join(HerdrStateDir(), "client", "ssh-metadata", id+".json"))
	if err != nil {
		return ""
	}
	var md sshMetadata
	if json.Unmarshal(b, &md) != nil {
		return ""
	}
	return md.Metadata.Executable
}

// SavedSpecs returns herdr's saved SSH machines, as herdr's catalog has
// them now (herdr's `herdr machine add`, `remove` and `rename` change it).
// No catalog means none; one that cannot be read is an error, so that the
// machines are not taken for removed.
func SavedSpecs() ([]Spec, error) {
	b, err := os.ReadFile(filepath.Join(HerdrStateDir(), "client", "endpoints.json"))
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
		s := Spec{ID: e.ID, Label: e.Label, Kind: KindSSH, Target: e.Target, Session: e.Session, Enabled: e.Enabled, Saved: true}
		if s.Label == "" {
			s.Label = s.Target
		}
		if s.Session == "" {
			s.Session = "default"
		}
		s.HerdrBin = HerdrExecutable(e.ID)
		specs = append(specs, s)
	}
	return specs, nil
}

// LoadSpecs returns the local machine followed by herdr's saved SSH machines.
func LoadSpecs(localSession string, extra []Spec) []Spec {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSuffix(hostname, ".local")
	if localSession == "" {
		localSession = "default"
	}
	specs := []Spec{{ID: LocalID, Label: hostname + " (local)", Kind: KindLocal, Session: localSession, Enabled: true}}
	saved, _ := SavedSpecs() // as before: an unreadable catalog has no machines
	specs = append(specs, saved...)
	seen := map[string]bool{}
	for _, s := range specs {
		seen[s.ID] = true
	}
	for _, s := range extra {
		if s.ID == "" {
			s.ID = s.Target
		}
		if seen[s.ID] {
			continue
		}
		if s.Kind == "" {
			s.Kind = KindSSH
		}
		if s.Label == "" {
			s.Label = s.Target
		}
		if s.Session == "" {
			s.Session = "default"
		}
		specs = append(specs, s)
		seen[s.ID] = true
	}
	return specs
}
