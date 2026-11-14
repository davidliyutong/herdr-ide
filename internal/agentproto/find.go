package agentproto

// FindRequest is Header.Find for OpPaneFind: a search of one pane's text,
// which the agent reads from herdr and searches next to it
// (internal/panefind, docs/features/20-find-in-panes.md).
type FindRequest struct {
	Pane      string `json:"pane"`
	Query     string `json:"query"`
	Regex     bool   `json:"regex,omitempty"`
	MatchCase bool   `json:"match_case,omitempty"`
	WholeWord bool   `json:"whole_word,omitempty"`
	// Backward searches towards older output from Cursor, or from
	// Previous (the current match) when set.
	Backward bool       `json:"backward,omitempty"`
	Cursor   TextPoint  `json:"cursor"`
	Previous *TextRange `json:"previous,omitempty"`
	// Cols is the pane's width as the browser shows it, a hint the agent
	// checks.
	Cols int `json:"cols,omitempty"`
	// Known is the Text of an answer the browser holds that had every
	// match: when the same search finds the same text, the answer is
	// Unchanged, with nothing else (a refresh that found nothing new).
	Known string `json:"known,omitempty"`
}

// TextPoint is a cell of a pane: its row counted from the oldest line kept,
// as herdr's selections and pane.copy_search count them, and its column.
type TextPoint struct {
	Row uint32 `json:"row"`
	Col uint16 `json:"col"`
}

// TextRange is a match: its first and last cell, both included.
type TextRange struct {
	Start TextPoint `json:"start"`
	End   TextPoint `json:"end"`
}

// FindResult is Reply.Find, shaped like herdr's pane.copy_search answer: a
// window of at most 1024 matches around the current one, Matches[Current],
// which is number CurrentGlobal (from 0) of Total.
type FindResult struct {
	Matches       []TextRange `json:"matches"`
	Total         int         `json:"total"`
	Current       *int        `json:"current,omitempty"`
	CurrentGlobal *int        `json:"current_global,omitempty"`
	// FirstRow is the oldest row searched (a very long scrollback is
	// searched from its newest rows back).
	FirstRow uint32 `json:"first_row,omitempty"`
	// Text identifies the search and the text it searched (a hash), for a
	// later FindRequest.Known.
	Text string `json:"text,omitempty"`
	// Unchanged answers a Known that still holds.
	Unchanged bool `json:"unchanged,omitempty"`
}

// Reply.Code values of OpPaneFind.
const (
	FindInvalidRegex = "invalid_regex"
	FindTooLarge     = "query_too_large"
	FindUnavailable  = "unavailable"
)
