//go:build unix

package machines

import (
	"context"
	"log"
	"testing"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/transport"
)

// dialAgent returns a dial of an in-process agent, the machine of these
// tests.
func dialAgent(t *testing.T) func(context.Context, *log.Logger) (*transport.Session, error) {
	return func(ctx context.Context, logger *log.Logger) (*transport.Session, error) {
		return transport.DialLocal(ctx, agent.Options{Logger: logger})
	}
}
