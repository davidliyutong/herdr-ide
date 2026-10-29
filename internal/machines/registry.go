package machines

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Kind of machine transport.
const (
	KindLocal = "local"
	KindSSH   = "ssh"
)

// LocalID is the id of the machine webherdr runs on.
const LocalID = "local"

// Spec describes one machine.
type Spec struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Kind     string `json:"kind"`
	Target   string `json:"target,omitempty"`
	Session  string `json:"session"`
	Enabled  bool   `json:"enabled"`
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

// LoadSpecs returns the local machine followed by herdr's saved SSH machines.
func LoadSpecs(localSession string, extra []Spec) []Spec {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSuffix(hostname, ".local")
	if localSession == "" {
		localSession = "default"
	}
	specs := []Spec{{ID: LocalID, Label: hostname + " (local)", Kind: KindLocal, Session: localSession, Enabled: true}}

	clientDir := filepath.Join(HerdrStateDir(), "client")
	if b, err := os.ReadFile(filepath.Join(clientDir, "endpoints.json")); err == nil {
		var cat endpointCatalog
		if json.Unmarshal(b, &cat) == nil {
			for _, e := range cat.SSH {
				s := Spec{ID: e.ID, Label: e.Label, Kind: KindSSH, Target: e.Target, Session: e.Session, Enabled: e.Enabled}
				if s.Label == "" {
					s.Label = s.Target
				}
				if s.Session == "" {
					s.Session = "default"
				}
				if mb, err := os.ReadFile(filepath.Join(clientDir, "ssh-metadata", e.ID+".json")); err == nil {
					var md sshMetadata
					if json.Unmarshal(mb, &md) == nil {
						s.HerdrBin = md.Metadata.Executable
					}
				}
				specs = append(specs, s)
			}
		}
	}
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
