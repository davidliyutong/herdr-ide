//go:build unix

package server

import (
	"context"
	"log"
	"testing"

	"veldr/internal/agent"
	"veldr/internal/transport"
)

// dialAgent returns a dial of an in-process agent, the machine of these
// tests.
func dialAgent(t *testing.T) func(context.Context, *log.Logger) (*transport.Session, error) {
	return func(ctx context.Context, logger *log.Logger) (*transport.Session, error) {
		return transport.DialLocal(ctx, agent.Options{Logger: logger})
	}
}
