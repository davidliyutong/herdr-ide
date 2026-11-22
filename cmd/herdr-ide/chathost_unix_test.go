//go:build unix

package main

import "testing"

// The chat-host command is there and, without a chat host, fails.
func TestChatHostCommand(t *testing.T) {
	if got := chatHost(nil); got != 2 {
		t.Errorf("exit status %d, want 2", got)
	}
}
