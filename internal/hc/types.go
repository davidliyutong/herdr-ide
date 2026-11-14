package hc

import (
	"encoding/json"
	"fmt"
)

// Error is a JSON-RPC error from the core. Kind is stable ("not_found",
// "conflict", "unavailable", "needs_framed", ...); Message and Hint are the
// core's English text and are not shown to users.
type Error struct {
	Code    int
	Message string
	Kind    string
	Hint    string
}

func (e *Error) Error() string {
	if e.Kind == "" {
		return fmt.Sprintf("hc: %s (%d)", e.Message, e.Code)
	}
	return fmt.Sprintf("hc: %s: %s", e.Kind, e.Message)
}

// Hello is the core's answer to the handshake.
type Hello struct {
	Generation uint32   `json:"generation"`
	Version    string   `json:"version"`
	Framed     bool     `json:"framed"`
	Core       CoreInfo `json:"core"`
	Methods    []string `json:"methods"`
	Features   []string `json:"features"`
}

// Has reports whether the core advertises feature.
func (h *Hello) Has(feature string) bool {
	for _, f := range h.Features {
		if f == feature {
			return true
		}
	}
	return false
}

// CoreInfo identifies a core: ID stays until its state is wiped.
type CoreInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Status is what a program reported about itself through OSC 7501. The core
// never infers it from the screen.
type Status struct {
	State    string  `json:"state"`
	Kind     *string `json:"kind,omitempty"`
	App      string  `json:"app,omitempty"`
	Title    string  `json:"title,omitempty"`
	Msg      string  `json:"msg,omitempty"`
	Progress *int    `json:"progress,omitempty"`
}

// Foreground is the program running in a terminal now.
type Foreground struct {
	PID  int      `json:"pid"`
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
}

// Terminal is the core's record of a terminal, live or finished.
type Terminal struct {
	Address    string            `json:"address"`
	Name       *string           `json:"name,omitempty"`
	State      string            `json:"state"`
	Argv       []string          `json:"argv"`
	Cwd        string            `json:"cwd"`
	Cols       int               `json:"cols"`
	Rows       int               `json:"rows"`
	CreatedMS  uint64            `json:"created_ms"`
	FinishedMS *uint64           `json:"finished_ms,omitempty"`
	PID        *int              `json:"pid,omitempty"`
	Parent     *string           `json:"parent,omitempty"`
	Labels     map[string]string `json:"labels"`
	Title      string            `json:"title,omitempty"`
	Keep       bool              `json:"keep,omitempty"`
	Reason     *string           `json:"reason,omitempty"`
	ExitCode   *int              `json:"exit_code,omitempty"`
	Signal     *int              `json:"signal,omitempty"`
	Status     *Status           `json:"status,omitempty"`
	StatusMS   *uint64           `json:"status_ms,omitempty"`
	Records    map[string]Status `json:"records,omitempty"`
	Reported   bool              `json:"reported,omitempty"`
	Turn       uint64            `json:"turn,omitempty"`
	Foreground *Foreground       `json:"foreground,omitempty"`
	Screen     string            `json:"screen"`
}

// Display is what a viewer tells the core about itself: colors as the core's
// color strings and the cell size in pixels. Programs' color queries are
// answered from it.
type Display struct {
	FG     *string `json:"fg,omitempty"`
	BG     *string `json:"bg,omitempty"`
	Cursor *string `json:"cursor,omitempty"`
	Cell   []int   `json:"cell,omitempty"`
}

// AttachParams are the parameters of terminal.attach.
type AttachParams struct {
	Terminal string `json:"terminal"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	// History is the number of lines above the screen in the first paint.
	History int `json:"history,omitempty"`
	// Observe attaches a viewer that never types or resizes.
	Observe bool `json:"observe,omitempty"`
	// ResizeNotifications asks for the terminal's grid as Resize messages
	// in the stream (observers); Attached.ResizeNotifications says whether
	// the whole path sends them.
	ResizeNotifications bool `json:"resize_notifications,omitempty"`
	// Resumed marks an attach that continues a stream lost with its
	// connection.
	Resumed bool     `json:"resumed,omitempty"`
	Display *Display `json:"display,omitempty"`
}

// Attached is the reply to terminal.attach.
type Attached struct {
	Channel             uint32   `json:"channel"`
	Terminal            Terminal `json:"terminal"`
	AutomaticInput      bool     `json:"automatic_input"`
	ResizeNotifications bool     `json:"resize_notifications"`
}

// SubscribeParams filter an event subscription; the zero value subscribes to
// everything, documents included.
type SubscribeParams struct {
	Terminal   *string           `json:"terminal,omitempty"`
	ChildrenOf *string           `json:"children_of,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// Subscribed is the reply to events.subscribe: the terminals now and the
// sequence number the events follow.
type Subscribed struct {
	Channel   *uint32    `json:"channel"`
	Seq       uint64     `json:"seq"`
	Terminals []Terminal `json:"terminals"`
}

// Notification is one message of an event subscription.
type Notification struct {
	// Method is "event", "heartbeat" or "missed".
	Method string
	// Seq rises by one per event and restarts with the core process.
	Seq uint64
	// Type, Terminal, Machine and Data are set for an event: its type
	// ("created", "status", "doc", ...), the terminal it is about (none for
	// documents), the added machine it comes from, and its data.
	Type     string
	Terminal string
	Machine  string
	Data     json.RawMessage
	// Terminals is the fresh snapshot of a "missed": events whose Seq is not
	// above it are to be dropped.
	Terminals []Terminal
}

// Exit is why the core closed a stream: for a terminal, how its program
// ended (Reason "exited", "killed", "server_stop", ...).
type Exit struct {
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exit_code"`
	Signal   *int   `json:"signal"`
}
