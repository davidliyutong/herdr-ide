package machines

import (
	"context"
	"log"
	"testing"

	"veldr/internal/transport"
)

// dialAgent skips the test: the agent runs on Linux and macOS.
func dialAgent(t *testing.T) func(context.Context, *log.Logger) (*transport.Session, error) {
	t.Skip("the agent runs on Linux and macOS")
	return nil
}
