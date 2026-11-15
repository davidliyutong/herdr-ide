package agentproto

import (
	"log"
	"time"

	"github.com/hashicorp/yamux"
)

// YamuxConfig is the session configuration of both ends, the core and the
// agent.
func YamuxConfig(logger *log.Logger) *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 15 * time.Second
	cfg.ConnectionWriteTimeout = 30 * time.Second
	cfg.MaxStreamWindowSize = 1 << 20
	cfg.AcceptBacklog = 512
	cfg.LogOutput = nil
	cfg.Logger = logger
	return cfg
}
