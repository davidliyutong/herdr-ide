// Command veldr is the terminal-first, multi-machine, agent-native web
// IDE: one program that is the core, which serves the web UI, and the helper
// the core starts on every machine.
//
//	veldr [serve] [flags]         run the server (default)
//	veldr fetch-assets DIR        download code-server and extensions for
//	                                 air-gapped installs (use with --seed-dir)
//	veldr mcp [--instance NAME]   the variable vault's MCP server (stdio)
//	veldr agent [--instance NAME] a machine's helper over stdio; started
//	                                 by the core over ssh (Linux and macOS)
//	veldr gui-keep --instance NAME
//	                                 holds a machine's virtual display;
//	                                 started by the agent (Linux and macOS)
//	veldr gui-wl --device NODE [--nvidia]
//	                                 the compositor of a machine's GPU
//	                                 display; started by the agent
//	veldr chat-host --base DIR --run DIR
//	                                 a machine's chat host, which runs coding
//	                                 agents headless; started by the agent as
//	                                 a hidden terminal (Linux and macOS)
//	veldr version
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

	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/vaultmcp"
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
