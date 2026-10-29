package server

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

type keyCommand struct {
	Key         string `json:"key"`
	Type        string `json:"type"`
	Command     string `json:"command"`
	Description string `json:"description,omitempty"`
}

type keyConfig struct {
	Prefix   string            `json:"prefix,omitempty"`
	Bindings map[string]string `json:"bindings"`
	Commands []keyCommand      `json:"commands"`
}

// herdrConfigPath mirrors herdr: HERDR_CONFIG_PATH, else <config_dir>/config.toml.
func herdrConfigPath() string {
	if p := os.Getenv("HERDR_CONFIG_PATH"); p != "" {
		return p
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "herdr", "config.toml")
}

// loadKeyConfig reads the [keys] section of the host's herdr config so the
// web UI uses the same prefix bindings as the herdr TUI.
func loadKeyConfig() keyConfig {
	out := keyConfig{Bindings: map[string]string{}, Commands: []keyCommand{}}
	b, err := os.ReadFile(herdrConfigPath())
	if err != nil {
		return out
	}
	var doc struct {
		Keys map[string]any `toml:"keys"`
	}
	if err := toml.Unmarshal(b, &doc); err != nil {
		return out
	}
	for k, v := range doc.Keys {
		switch val := v.(type) {
		case string:
			if k == "prefix" {
				out.Prefix = val
			} else {
				out.Bindings[k] = val
			}
		case []any:
			if k != "command" {
				continue
			}
			for _, item := range val {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				c := keyCommand{}
				c.Key, _ = m["key"].(string)
				c.Type, _ = m["type"].(string)
				c.Command, _ = m["command"].(string)
				c.Description, _ = m["description"].(string)
				if c.Key != "" && c.Command != "" {
					out.Commands = append(out.Commands, c)
				}
			}
		}
	}
	return out
}

func (s *Server) handleKeymap(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, loadKeyConfig())
}
