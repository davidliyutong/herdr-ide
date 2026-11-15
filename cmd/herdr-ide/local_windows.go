package main

import (
	"context"
	"log"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
)

// dialLocal is never called on Windows: the agent runs on Linux and macOS,
// so the local machine is listed with machines.CodeLocalUnsupported and
// never dialed.
func dialLocal(context.Context, string, *log.Logger) (*transport.Session, error) {
	return nil, machines.ErrLocalUnsupported
}
