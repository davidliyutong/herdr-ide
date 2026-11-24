//go:build unix

package agent

// The migrate plugin's machine side registers itself.
import _ "veldr/internal/agent/plugin/migrate"
