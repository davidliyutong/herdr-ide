//go:build unix

package transcript

import (
	"context"
	"io"
	"math"

	"herdr-ide/internal/agentproto"
)

// Frame is what one line of a Claude Code transcript gives, read on its
// own: the events a read gives of it, without their places, and what a
// reader that follows a whole conversation needs to name the items they
// belong to (the chat host's import, its adapter's live frames).
type Frame struct {
	// Events are the line's events, in their order; their Seq is 0.
	Events []agentproto.TranscriptEvent
	// Blocks holds, for each event, the index among the line's content
	// blocks of the block it was made of; -1 for an event of no block.
	Blocks []int
	// Message is the id of the assistant message whose content blocks the
	// line holds, and Count how many it holds; First is the index in the
	// message of the first of them, -1 when the line does not say (an SDK
	// frame, an older transcript).
	Message string
	Count   int
	First   int
	// Unknown counts what could not be read.
	Unknown int
	// Title is the session's title the line gives; Custom: the user named
	// the session.
	Title  string
	Custom bool
}

// ClaudeFrame is the Frame of one line of a Claude Code transcript, or of
// one assistant or user message of Claude Code's SDK protocol (whose
// shapes are the transcript's; its tool_use_result is the line's
// toolUseResult), within lim. A line longer than the parsers read gives a
// notice that it was skipped.
func ClaudeFrame(line []byte, lim Limits) Frame {
	l := lim.norm()
	var o lineOut
	o.reset(&l)
	if len(line) > maxLine {
		o.notice(noticeSkipped, obj{"bytes": len(line)})
	} else if len(line) > 0 {
		claudeRun{}.parse(&rawLine{b: line, n: int64(len(line))}, &o)
	}
	return frameOf(&o)
}

// frameOf is the Frame of a parsed line.
func frameOf(o *lineOut) Frame {
	if o.over {
		o.unknown++
	}
	f := Frame{Message: o.message, Count: o.count, First: o.first - 1, Unknown: o.unknown, Title: o.title, Custom: o.custom}
	for i := range o.events {
		p := &o.events[i]
		ev, _ := encode(p, 0)
		f.Events = append(f.Events, ev)
		f.Blocks = append(f.Blocks, p.block-1)
	}
	return f
}

// EachClaude reads the Claude Code transcript r forward, from the first
// line that starts at or after from to size, and calls fn with each
// complete line's offset and Frame until fn returns false or ctx ends (its
// error is ctx's). A line longer than the parsers read gives a notice that
// it was skipped; a last line without its newline (still being written)
// is not read.
func EachClaude(ctx context.Context, r io.ReaderAt, from, size int64, lim Limits, fn func(off int64, f Frame) bool) error {
	l := lim.norm()
	v := &view{b: &budget{r: r, ctx: ctx, left: math.MaxInt64}}
	fr := newFwdReader(v, min(max(from, 0), size), size)
	var o lineOut
	for {
		line, ok := fr.next()
		if !ok {
			break
		}
		o.reset(&l)
		switch {
		case line.cont:
			// The rest of a line that began before from.
			continue
		case line.long:
			o.notice(noticeSkipped, obj{"bytes": line.skipped()})
		case len(line.b) > 0:
			claudeRun{}.parse(&line, &o)
		}
		if !fn(line.off, frameOf(&o)) {
			return nil
		}
	}
	return fr.err
}
