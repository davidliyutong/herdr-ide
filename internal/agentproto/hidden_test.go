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
	fb := ChatHostFallbackName(1)
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`).MatchString(fb) || !IsChatHostName(fb) {
		t.Errorf("bad fallback name %q", fb)
	}
	if got := HiddenValue(fb); got != HiddenChatHost {
		t.Errorf("HiddenValue(%q) = %q, want %q", fb, got, HiddenChatHost)
	}
	if got := HiddenValue("other"); got != "other" {
		t.Errorf("HiddenValue of a name without the prefix = %q", got)
	}
}

// A terminal is hidden only with the chat host's name and its label's
// value both.
func TestHidden(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        bool
	}{
		{ChatHostName, HiddenChatHost, true},
		{ChatHostFallbackName(1), HiddenChatHost, true},
		{ChatHostFallbackName(1), "", false},
		{ChatHostName, "", false},
		{ChatHostName, "other", false},
		{"", HiddenChatHost, false},
		{"build", HiddenChatHost, false},
		{"", "", false},
	} {
		if got := Hidden(tc.name, tc.value); got != tc.want {
			t.Errorf("Hidden(%q, %q) = %v", tc.name, tc.value, got)
		}
	}
}
