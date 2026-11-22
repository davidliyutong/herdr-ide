//go:build unix

package main

import (
	"fmt"
	"os"

	"herdr-ide/internal/brand"
)

// chatHost runs the chat-host command, the process of a machine that runs
// coding agents headless for the chat plugin (internal/chatproto), and
// returns its exit status. This version has no chat host: it prints its
// usage and fails.
func chatHost(args []string) int {
	fmt.Fprintf(os.Stderr, "usage: %s chat-host --instance NAME (not available in this version)\n", brand.CoreBin)
	return 2
}
