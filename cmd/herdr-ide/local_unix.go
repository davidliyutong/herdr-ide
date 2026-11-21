//go:build unix && !machine

package main

import (
	"context"
	"log"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/transport"
)

// dialLocal starts the local machine's agent in this process.
func dialLocal(ctx context.Context, instance string, logger *log.Logger) (*transport.Session, error) {
	return transport.DialLocal(ctx, agent.Options{Instance: instance, Logger: logger})
}
