//go:build !unix

package codex

import (
	"veldr/internal/chatproto"
)

// The chat host runs on Linux and macOS only.
func startProcess(argv []string, dir string, env []string) (*process, error) {
	return nil, &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "codex: chats run on unix machines only"}
}

func (p *process) end() { <-p.exited }
