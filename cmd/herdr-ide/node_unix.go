//go:build unix

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/brand"
)

// nodeCommand runs `node` (the machine's node, started by its clients),
// `node dial` (standard input and output piped to the node, which it
// starts when none answers; what ssh runs for a core) or `node stop` (asks
// the instance's nodes of every build to stop, with --terminal-core also
// its terminal core). It returns the exit code.
func nodeCommand(args []string) int {
	sub := ""
	if len(args) > 0 && (args[0] == "dial" || args[0] == "stop") {
		sub, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("node", flag.ContinueOnError)
	instance := fs.String("instance", "", "state directory instance (see serve's --instance)")
	client := fs.String("client", "", "dial: the core that dials (its process), the same for its reconnects")
	takeover := fs.Bool("takeover", false, "take over from the instance's running node, which drains")
	core := fs.Bool("terminal-core", false, "stop: also stop the instance's terminal core on this host, ending its terminals")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	logger := log.New(os.Stderr, brand.CoreBin+" node: ", log.LstdFlags)
	switch sub {
	case "dial":
		return nodeDial(*instance, *client, logger)
	case "stop":
		n, err := agent.StopNodes(*instance)
		if err != nil {
			logger.Print(err)
			return 1
		}
		fmt.Printf("stopped %d node(s)\n", n)
		if *core {
			stopped, err := agent.StopTerminalCore(context.Background(), *instance)
			if err != nil {
				logger.Print(err)
				return 1
			}
			if stopped {
				fmt.Println("stopped the terminal core")
			}
		}
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	// A node outlives the ssh session or terminal that started it.
	signal.Ignore(syscall.SIGHUP)
	if err := agent.RunNode(ctx, agent.Options{Instance: *instance, Logger: logger}, *takeover); err != nil {
		logger.Printf("exit: %v", err)
		return 1
	}
	return 0
}

// nodeDial pipes standard input and output to the node until either side
// ends.
func nodeDial(instance, client string, logger *log.Logger) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer cancel()
	c, err := agent.DialNode(ctx, instance, client, os.Getenv("SSH_CONNECTION"), logger)
	if err != nil {
		logger.Print(err)
		return 1
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(c, os.Stdin)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(os.Stdout, c)
		done <- struct{}{}
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	c.Close()
	return 0
}
