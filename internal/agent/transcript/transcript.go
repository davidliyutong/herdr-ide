//go:build unix

// Package transcript reads Claude Code's session transcripts (JSON lines)
// and the messages of its SDK protocol, whose shapes are the transcript's,
// into the conversation events of internal/agentproto: ACP v1 session
// updates, the user's prompts, turns and notices. Each line maps on its
// own (ClaudeFrame); EachClaude reads a file's lines forward.
//
// The transcripts are the agent's internal format and change between
// versions: the parser maps the lines it knows, passes over the kinds of
// lines known not to be conversation, and counts what it could not read
// (Frame.Unknown) without forwarding it. Every read is bounded: the text
// of an event, the output of a tool call, the length of a line, the events
// and the decoded values of a line; and it ends with its context.
package transcript

import "veldr/internal/agentproto"

// Limits bound a read. A member that is zero, or above agentproto's
// maximum, is that maximum.
type Limits struct {
	// Text is the most bytes of an event's text (agentproto.MaxTextBytes).
	Text int
	// ToolOutput is the most bytes of a tool call's output an event keeps,
	// its start and its end (agentproto.MaxToolOutput).
	ToolOutput int
}

func (l Limits) norm() limits {
	or := func(v, m int) int {
		if v <= 0 || v > m {
			return m
		}
		return v
	}
	return limits{or(l.Text, agentproto.MaxTextBytes), or(l.ToolOutput, agentproto.MaxToolOutput)}
}
