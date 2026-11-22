package agentproto

import (
	"strconv"
	"strings"

	"herdr-ide/internal/brand"
)

// Terminals of the product's own helpers. A machine's agent runs a helper
// that has to outlive it (the chat host) as a terminal of the instance's
// terminal core, so that the helper has the lifetime, the owner and the
// privacy attribution of the user's terminals. No client shows such a
// terminal: the agent marks it with HiddenLabel, and the core keeps every
// terminal that carries the label from its clients (internal/server's
// terminal protocol), which can neither address one nor make one.
const (
	// HiddenLabel is the key of the label that marks a terminal as one of
	// the product's own helpers. Its value says which helper it is.
	HiddenLabel = brand.Slug + ".hidden"
	// HiddenChatHost is HiddenLabel's value for the chat host.
	HiddenChatHost = "chat-host"
	// ChatHostName is the terminal name of a machine's chat host. The
	// terminal core gives a name to one live terminal at a time, so the
	// name is also the lock that keeps a second chat host from starting.
	// Clients can neither take the name nor address a terminal by it.
	ChatHostName = brand.Slug + "-" + HiddenChatHost
)

// IsChatHostName reports whether name is ChatHostName or one of its fallback
// names (ChatHostName-<suffix>) used when a user terminal occupies ChatHostName.
func IsChatHostName(name string) bool {
	return name == ChatHostName || strings.HasPrefix(name, ChatHostName+"-")
}

// ChatHostFallbackName returns the i-th fallback terminal name (1-based) for
// the chat host when ChatHostName is occupied by a non-helper terminal.
func ChatHostFallbackName(i int) string {
	return ChatHostName + "-" + strconv.Itoa(i)
}

// HiddenValue is the value of HiddenLabel for a helper's terminal named
// name: the name without the product's prefix ("chat-host").
func HiddenValue(name string) string {
	if IsChatHostName(name) {
		return HiddenChatHost
	}
	return strings.TrimPrefix(name, brand.Slug+"-")
}

// Hidden reports whether a terminal named name, whose HiddenLabel has
// value, is a helper's that no client sees: the chat host's, named
// ChatHostName (or a fallback ChatHostName-*) and labeled HiddenChatHost. Both
// are needed: the terminal core gives the name to one live terminal at a time
// and clients cannot take it, while labels are free-form, so a program of the
// machine that sets the label on another terminal does not hide that terminal.
// Every part that leaves the helpers' terminals out (the core's terminal
// protocol, the agent's detection of coding agents, terminal history's
// captures) decides by it.
func Hidden(name, value string) bool {
	return IsChatHostName(name) && value == HiddenChatHost
}
