//go:build unix

package agent

// The file explorer plugin's machine side (docs/features/28-file-explorer.md).
import "veldr/internal/agent/plugin/files"

// What its uploads left when an agent ended during one goes after a while.
func init() { housekeepers = append(housekeepers, files.PruneStaged) }
