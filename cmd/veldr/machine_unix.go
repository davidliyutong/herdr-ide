//go:build unix

package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"veldr/internal/agent"
	"veldr/internal/brand"
)

// machineUsage names the commands of a machine's helper in the usage line.
const machineUsage = "node [dial | stop] [--instance NAME] | "

// machineCommand runs a command of a machine's helper: node (node.go),
// gui-keep, gui-wl and chat-host (chathost_unix.go). It reports whether cmd
// is one.
func machineCommand(cmd string, args []string) bool {
	switch cmd {
	case "node":
		os.Exit(nodeCommand(args))
	case "gui-keep":
		// Started by the agent: holds the virtual display while the
		// instance's terminal core runs.
		logger := log.New(os.Stderr, brand.CoreBin+" gui-keep: ", log.LstdFlags)
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		instance := fs.String("instance", "", "state directory instance")
		fs.Parse(args)
		if err := agent.KeepDisplay(ctx, *instance, logger); err != nil {
			logger.Printf("exit: %v", err)
			os.Exit(1)
		}
	case "gui-wl":
		// Started by the agent with its client's socket as file descriptor
		// 3: the compositor of the GPU display, which shows nothing.
		logger := log.New(os.Stderr, brand.CoreBin+" gui-wl: ", log.LstdFlags)
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		device := fs.String("device", "", "render node of the GPU the client draws with")
		nvidia := fs.Bool("nvidia", false, "offer the buffer layouts of NVIDIA GPUs")
		fs.Parse(args)
		if err := agent.Compositor(3, *device, *nvidia, logger); err != nil {
			logger.Printf("exit: %v", err)
			os.Exit(1)
		}
	case "chat-host":
		os.Exit(chatHost(args))
	default:
		return false
	}
	return true
}
