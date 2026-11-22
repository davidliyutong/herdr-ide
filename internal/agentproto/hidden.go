package agentproto

import (
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

// HiddenValue is the value of HiddenLabel for a helper's terminal named
// name: the name without the product's prefix ("chat-host").
func HiddenValue(name string) string {
	return strings.TrimPrefix(name, brand.Slug+"-")
}
