// Command herdr-ide is the terminal-first, multi-machine, agent-native web
// IDE: one program that is the core, which serves the web UI, and the helper
// the core starts on every machine.
//
//	herdr-ide [serve] [flags]         run the server (default)
//	herdr-ide fetch-assets DIR        download code-server and extensions for
//	                                 air-gapped installs (use with --seed-dir)
//	herdr-ide mcp [--instance NAME]   the variable vault's MCP server (stdio)
//	herdr-ide agent [--instance NAME] a machine's helper over stdio; started
//	                                 by the core over ssh (Linux and macOS)
//	herdr-ide gui-keep --instance NAME
//	                                 holds a machine's virtual display;
//	                                 started by the agent (Linux and macOS)
//	herdr-ide gui-wl --device NODE [--nvidia]
//	                                 the compositor of a machine's GPU
//	                                 display; started by the agent
//	herdr-ide chat-host              a machine's chat host (Linux and
//	                                 macOS); not available in this version
//	herdr-ide version
//
// The copies the core carries for machines of other platforms are this
// program built with the tag "machine": without the server, the web UI and
// what the core embeds for machines, so they have the commands mcp, agent,
// gui-keep, gui-wl, chat-host and version only.
package main

import (
	"fmt"
	"os"
	"strings"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/vaultmcp"
)

func main() {
	// Started by the stable link <data dir>/bin/<slug>-mcp: the vault's MCP
	// server.
	if vaultmcp.IsLink(os.Args[0]) {
		os.Exit(vaultmcp.Main(os.Args[0], os.Args[1:]))
	}
	args := os.Args[1:]
	cmd := defaultCommand
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch {
	case cmd == "version":
		fmt.Println(brand.CoreBin, agentproto.Version)
	case cmd == "mcp":
		os.Exit(vaultmcp.Main(os.Args[0], args))
	case machineCommand(cmd, args), coreCommand(cmd, args):
	default:
		fmt.Fprintf(os.Stderr, "usage: %s %s%smcp [--instance NAME] | version\n", brand.CoreBin, coreUsage, machineUsage)
		os.Exit(2)
	}
}
