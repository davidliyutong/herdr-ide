//go:build unix

package agent

import "veldr/internal/agent/plugin/history"

// The terminal history plugin's machine side (backend/features/history):
// its snapshots past their days leave with housekeeping, when the agent
// starts, as at each capture.
func init() { housekeepers = append(housekeepers, history.Prune) }
