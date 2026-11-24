// Command veldr is the machine build: the program the core (the
// TypeScript core, backend/) uploads to every machine and runs there, the
// machine's node and the helpers it starts.
//
//	veldr node [dial | stop] [--instance NAME]
//	                                 the machine's node, which serves the
//	                                 core's protocol (Linux and macOS)
//	veldr mcp [--instance NAME]   the variable vault's MCP server (stdio)
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
package main

import (
	"fmt"
	"os"

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
	cmd, args := "", os.Args[1:]
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch {
	case cmd == "version":
		fmt.Println(brand.CoreBin, agentproto.Version)
	case cmd == "mcp":
		os.Exit(vaultmcp.Main(os.Args[0], args))
	case machineCommand(cmd, args):
	default:
		fmt.Fprintf(os.Stderr, "usage: %s %smcp [--instance NAME] | version\n", brand.CoreBin, machineUsage)
		os.Exit(2)
	}
}
