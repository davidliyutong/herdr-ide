package agentproto

import (
	"regexp"
	"strings"
	"testing"
)

// The terminal core takes the chat host's name and the label: a name is 1
// to 32 of a-z 0-9 - _ . that starts with a letter or a digit and is not
// shaped like a terminal's address (t7), a label's key is not empty and
// has no "=". A rename of the product keeps that.
func TestHiddenTerminalNames(t *testing.T) {
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`).MatchString(ChatHostName) || regexp.MustCompile(`^t[0-9]+$`).MatchString(ChatHostName) {
		t.Errorf("the terminal core takes no terminal named %q", ChatHostName)
	}
	if HiddenLabel == "" || strings.ContainsAny(HiddenLabel, "= ") {
		t.Errorf("the terminal core takes no label %q", HiddenLabel)
	}
	if got := HiddenValue(ChatHostName); got != HiddenChatHost {
		t.Errorf("HiddenValue(%q) = %q, want %q", ChatHostName, got, HiddenChatHost)
	}
	if got := HiddenValue("other"); got != "other" {
		t.Errorf("HiddenValue of a name without the prefix = %q", got)
	}
}
