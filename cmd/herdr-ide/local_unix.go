//go:build unix && !machine

package main

import (
	"context"
	"log"
	"os"

	"herdr-ide/internal/transport"
)

// dialLocal connects to the local machine's node, starting it from this
// executable when none answers.
func dialLocal(ctx context.Context, instance string, logger *log.Logger) (*transport.Session, error) {
	return transport.DialNode(ctx, instance, os.Getenv("SSH_CONNECTION"), logger)
}
