//go:build unix

// Command herdr-ide-agent is the per-machine helper started by herdr-ide over
// ssh. It speaks yamux on stdin/stdout; logs go to stderr.
package main

import (
	"context"
	"flag"
	"fmt"
	"herdr-ide/internal/brand"
	"log"
	"os"
	"os/signal"
	"syscall"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/vaultmcp"
)

type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (stdio) Close() error {
	os.Stdin.Close()
	return os.Stdout.Close()
}

func main() {
	// Started by the stable link <data dir>/bin/<slug>-mcp: the vault's MCP
	// server.
	if vaultmcp.IsLink(os.Args[0]) {
		os.Exit(vaultmcp.Main(os.Args[0], os.Args[1:]))
	}
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: "+brand.AgentBin+" serve [--instance NAME] | mcp [--instance NAME] | version")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(agentproto.Version)
	case "serve":
		logger := log.New(os.Stderr, brand.AgentBin+": ", log.LstdFlags)
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
		defer cancel()
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		instance := fs.String("instance", "", "state directory instance (see "+brand.CoreBin+" --instance)")
		fs.Parse(os.Args[2:])
		if err := agent.Serve(ctx, stdio{}, agent.Options{Instance: *instance, Logger: logger}); err != nil {
			logger.Printf("exit: %v", err)
			os.Exit(1)
		}
	case "mcp":
		os.Exit(vaultmcp.Main(os.Args[0], os.Args[2:]))
	case "gui-keep":
		// Started by the agent: holds the virtual display while the
		// instance's terminal core runs.
		logger := log.New(os.Stderr, brand.AgentBin+" gui-keep: ", log.LstdFlags)
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		fs := flag.NewFlagSet("gui-keep", flag.ExitOnError)
		instance := fs.String("instance", "", "state directory instance")
		fs.Parse(os.Args[2:])
		if err := agent.KeepDisplay(ctx, *instance, logger); err != nil {
			logger.Printf("exit: %v", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}
