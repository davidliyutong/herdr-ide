//go:build unix

package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"herdr-ide/internal/brand"
	"herdr-ide/internal/chathost"

	// The adapters of the agents' protocols register themselves
	// (chatadapter.Register) under agentkinds.Adapters' names.
	_ "herdr-ide/internal/chatadapter/acp"
	_ "herdr-ide/internal/chatadapter/claude"
	_ "herdr-ide/internal/chatadapter/codex"
)

// chatHost runs the chat-host command, the process of a machine that runs
// coding agents headless for the chat plugin (internal/chathost), and
// returns its exit status: it serves the socket of the instance's run
// directory --run, keeps its journal in the instance's data directory
// --base, logs to standard error, and ends on SIGHUP, SIGTERM or SIGINT
// (the terminal core's stop), when told to, or when it has nothing left to
// do. Status 2 is a wrong command line, 1 a host that did not serve
// (another serves the socket, the directories are not the user's alone).
func chatHost(args []string) int {
	logger := log.New(os.Stderr, brand.CoreBin+" chat-host: ", log.LstdFlags)
	fs := flag.NewFlagSet("chat-host", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	base := fs.String("base", "", "the instance's data directory")
	run := fs.String("run", "", "the instance's run directory, where the socket is served")
	if err := fs.Parse(args); err != nil || *base == "" || *run == "" || fs.NArg() > 0 {
		os.Stderr.WriteString("usage: " + brand.CoreBin + " chat-host --base DIR --run DIR\n")
		return 2
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	err := chathost.Serve(context.Background(), chathost.Options{Base: *base, Run: *run, Logger: logger, Signals: signals})
	if errors.Is(err, chathost.ErrRunning) {
		logger.Printf("another chat host serves %s", *run)
		return 1
	}
	if err != nil {
		logger.Printf("exit: %v", err)
		return 1
	}
	return 0
}
