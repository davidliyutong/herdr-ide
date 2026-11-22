//go:build unix

package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/brand"
)

// machineUsage names the commands of a machine's helper in the usage line.
const machineUsage = "agent [--instance NAME] | "

type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (stdio) Close() error {
	os.Stdin.Close()
	return os.Stdout.Close()
}

// machineCommand runs a command of a machine's helper: agent, which speaks
// yamux on stdin and stdout and logs to stderr, gui-keep, gui-wl and
// chat-host (chathost_unix.go). It reports whether cmd is one.
func machineCommand(cmd string, args []string) bool {
	switch cmd {
	case "agent":
		logger := log.New(os.Stderr, brand.CoreBin+" agent: ", log.LstdFlags)
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
		defer cancel()
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		instance := fs.String("instance", "", "state directory instance (see serve's --instance)")
		fs.Parse(args)
		if err := agent.Serve(ctx, stdio{}, agent.Options{Instance: *instance, Logger: logger}); err != nil {
			logger.Printf("exit: %v", err)
			os.Exit(1)
		}
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
