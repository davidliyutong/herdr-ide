//go:build unix

package transcript

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// obj is a JSON object as the events are built: maps and []any all the
// way down, so that shrink can walk them.
type obj = map[string]any

// noticeSkipped is the notice of a line that was not read (too long), or
// of an event too large for a reply.
const noticeSkipped = "skipped"

const (
	// maxTitle is the most bytes of a tool call's title.
	maxTitle = 1 << 10
	// maxSessionTitle is the most bytes of a session's title: escaped in
	// JSON (at most six bytes a byte) it stays within a reply's envelope.
	maxSessionTitle = 512
	// maxItems is the most items of an array a tool call's input keeps.
	maxItems = 256
	// maxDepth is how deep a tool call's input is kept.
	maxDepth = 16
	// maxBlocks is the most elements of an array of content blocks a
	// parser reads of a line: the line counts as unknown once for those
	// beyond (it would make more events than a line may).
	maxBlocks = 4 * agentproto.MaxLineEvents
)

// pev is an event a parser made of a line, before it has its place.
type pev struct {
	t       string
	at      time.Time
	update  obj
	content []any
	state   string
	stop    string
	method  string
	params  obj
	// usage is the message whose usage an update reports: of the updates
	// of one message a page keeps the last.
	usage string
	// block is 1 + the index among the line's content blocks of the block
	// the event was made of, 0 for none (ClaudeFrame).
	block int
}

// limits are a read's Limits with the defaults in place.
type limits struct{ bytes, text, tool int }

// lineOut is what a parser made of a line.
type lineOut struct {
	lim     *limits
	at      time.Time
	events  []pev
	unknown int
	// title is the session's title the line gives; custom: the user named
	// the session.
	title  string
	custom bool
	// over: the line would make more than agentproto.MaxLineEvents events;
	// those beyond were not made, and the line counts as unknown once.
	over bool
	// nodes is how many more JSON values the line's parse may decode
	// (decode); cut: a decode left something out, and the updates made
	// after it are marked as truncated.
	nodes int
	cut   bool
	// message is the id of the assistant message whose content blocks the
	// line holds, count how many; first is 1 + the index in the message of
	// the first of them, 0 when the line does not say; block is 1 + the
	// index of the block being mapped, 0 for none (ClaudeFrame).
	message             string
	count, first, block int
}

// reset makes o ready for the next line, its events' array used again
// (emptied, so that it holds on to nothing of the line before).
func (o *lineOut) reset(lim *limits) {
	clear(o.events)
	*o = lineOut{lim: lim, nodes: maxLineNodes, events: o.events[:0]}
}

func (o *lineOut) add(p pev) {
	if len(o.events) >= agentproto.MaxLineEvents {
		o.over = true
		return
	}
	p.at, p.block = o.at, o.block
	o.events = append(o.events, p)
}

func (o *lineOut) update(u obj) {
	if o.cut {
		setMeta(u, "truncated", true)
	}
	o.add(pev{t: agentproto.TranscriptUpdate, update: u})
}

// decode is the JSON value raw as encoding/json decodes it into an any,
// but of at most the line's remaining values (lineOut.nodes) and
// decodeDepth levels: what is beyond is left out (lineOut.cut). ok is false
// when raw is no JSON value, or holds a number a float64 does not hold
// (encoding/json fails on those too; v is what it would decode).
func (o *lineOut) decode(raw []byte) (v any, ok bool) {
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		return nil, false
	}
	d := decoder{nodes: &o.nodes}
	v, _ = d.value(raw, 0, 0)
	o.cut = o.cut || d.cut
	return v, !d.bad
}

func (o *lineOut) user(blocks []any) {
	if len(blocks) > 0 {
		o.add(pev{t: agentproto.TranscriptUser, content: blocks})
	}
}

func (o *lineOut) turn(state, stop string) {
	o.add(pev{t: agentproto.TranscriptTurn, state: state, stop: stop})
}

func (o *lineOut) notice(name string, params obj) {
	if len(params) == 0 {
		params = nil
	}
	o.add(pev{t: agentproto.TranscriptNotice, method: agentproto.NoticeMethod(name), params: params})
}

// setTime takes an RFC 3339 time for the line's events.
func (o *lineOut) setTime(s string) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		o.at = t.UTC()
	}
}

// setMeta sets a member of m's own metadata: _meta.<slug>.key.
func setMeta(m obj, key string, v any) {
	meta, _ := m["_meta"].(obj)
	if meta == nil {
		meta = obj{}
		m["_meta"] = meta
	}
	own, _ := meta[brand.Slug].(obj)
	if own == nil {
		own = obj{}
		meta[brand.Slug] = own
	}
	own[key] = v
}

// cutText is s cut to at most n bytes at a character's start.
func cutText(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n], true
}

// elision joins the start and the end of a tool's output that was cut.
const elision = "\n…\n"

// cutMiddle is s cut to about n bytes by leaving out its middle: a tool's
// output says most at its start and its end.
func cutMiddle(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	half := max(n-len(elision), 0) / 2
	head, _ := cutText(s, half)
	j := len(s) - half
	for j < len(s) && !utf8.RuneStart(s[j]) {
		j++
	}
	return head + elision + s[j:], true
}

// text is the text of a message or a thought, cut to the limit; cut tells
// whether it was.
func (o *lineOut) text(s string) (string, bool) { return cutText(s, o.lim.text) }

// textBlock is an ACP text block, its text cut to the limit (marked in its
// _meta).
func (o *lineOut) textBlock(s string) obj {
	s, cut := o.text(s)
	b := obj{"type": "text", "text": s}
	if cut {
		setMeta(b, "truncated", true)
	}
	return b
}

// imageBlock stands for an image, which is never forwarded: an empty text
// block marked as an image.
func imageBlock() obj {
	b := obj{"type": "text", "text": ""}
	setMeta(b, "image", true)
	return b
}

// output is a tool call's output as its content, cut to the limit (marked
// in u's _meta); nil for no output.
func (o *lineOut) output(u obj, s string) []any {
	if s == "" {
		return nil
	}
	s, cut := cutMiddle(s, o.lim.tool)
	if cut {
		setMeta(u, "truncated", true)
	}
	return []any{obj{"type": "content", "content": obj{"type": "text", "text": s}}}
}

// bound is a copy of a value decoded from JSON with strings cut to text
// bytes, arrays to maxItems items and nothing deeper than maxDepth; cut
// tells whether anything was left out.
func bound(v any, text int, depth int) (any, bool) {
	switch x := v.(type) {
	case string:
		return cutText(x, text)
	case obj:
		if depth >= maxDepth {
			return nil, true
		}
		out := make(obj, len(x))
		cut := false
		for k, e := range x {
			var c bool
			out[k], c = bound(e, text, depth+1)
			cut = cut || c
		}
		return out, cut
	case []any:
		if depth >= maxDepth {
			return nil, true
		}
		n := min(len(x), maxItems)
		out := make([]any, n)
		cut := n < len(x)
		for i := range n {
			var c bool
			out[i], c = bound(x[i], text, depth+1)
			cut = cut || c
		}
		return out, cut
	}
	return v, false
}

// bounded is v bounded for an event (marked in u's _meta when cut).
func (o *lineOut) bounded(u obj, v any) any {
	v, cut := bound(v, o.lim.text, 0)
	if cut {
		setMeta(u, "truncated", true)
	}
	return v
}

// shrink is a copy of v with every string cut to n bytes and every array
// to n/64 items (at least 4): the last resort for an event that a reply
// cannot hold.
func shrink(v any, n int) any {
	switch x := v.(type) {
	case string:
		s, _ := cutText(x, n)
		return s
	case obj:
		out := make(obj, len(x))
		for k, e := range x {
			out[k] = shrink(e, n)
		}
		return out
	case []any:
		out := make([]any, min(len(x), max(n/64, 4)))
		for i := range out {
			out[i] = shrink(x[i], n)
		}
		return out
	}
	return v
}

// strBytes is the bytes of v's strings: of its maps' keys, and of the
// others. Their sum is at most what v takes in JSON.
func strBytes(v any) (keys, values int) {
	switch x := v.(type) {
	case string:
		return 0, len(x)
	case obj:
		for k, e := range x {
			ek, ev := strBytes(e)
			keys, values = keys+len(k)+ek, values+ev
		}
	case []any:
		for _, e := range x {
			ek, ev := strBytes(e)
			keys, values = keys+ek, values+ev
		}
	}
	return keys, values
}

// strBytes is the bytes of the event's strings (strBytes).
func (p *pev) strBytes() (keys, values int) {
	keys, values = strBytes(p.update)
	for _, v := range []any{p.content, p.params} {
		k, s := strBytes(v)
		keys, values = keys+k, values+s
	}
	return keys, values + len(p.t) + len(p.state) + len(p.stop) + len(p.method)
}

// shrunk is the event with its strings cut to n bytes, marked as cut.
func (p *pev) shrunk(n int) pev {
	q := *p
	if q.update != nil {
		q.update = shrink(q.update, n).(obj)
		setMeta(q.update, "truncated", true)
	}
	if len(q.content) > 0 {
		q.content = shrink(q.content, n).([]any)
		if b, ok := q.content[0].(obj); ok {
			setMeta(b, "truncated", true)
		}
	}
	if q.params != nil {
		q.params = shrink(q.params, n).(obj)
	}
	return q
}

// encode is the event with its place, and the bytes it takes in a reply.
func encode(p *pev, seq uint64) (agentproto.TranscriptEvent, int) {
	ev := agentproto.TranscriptEvent{Seq: seq, T: p.t, At: p.at, State: p.state, StopReason: p.stop, Method: p.method}
	if p.update != nil {
		ev.Update, _ = json.Marshal(p.update)
	}
	for _, c := range p.content {
		b, _ := json.Marshal(c)
		ev.Content = append(ev.Content, b)
	}
	if p.params != nil {
		ev.Params, _ = json.Marshal(p.params)
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return ev, 1 << 30
	}
	// A comma between events.
	return ev, len(b) + 1
}

// ---- values decoded from JSON ----

func str(v any) string {
	s, _ := v.(string)
	return s
}

func asObj(v any) obj {
	m, _ := v.(obj)
	return m
}

func asArr(v any) []any {
	a, _ := v.([]any)
	return a
}

// num is a number decoded from JSON.
func num(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// first is the first of m's members that is there and not null.
func first(m obj, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

// stringsOf is a JSON array of strings (other values left out).
func stringsOf(v any) []string {
	var out []string
	for _, e := range asArr(v) {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// plain is s without terminal escape sequences.
func plain(s string) string {
	if strings.IndexByte(s, 0x1b) < 0 {
		return s
	}
	return ansi.ReplaceAllString(s, "")
}

// exitCodeRE finds the exit code an error result states: Claude Code's
// "Exit code N", Codex's "Exit code: N" and "Process exited with code N".
var exitCodeRE = regexp.MustCompile(`(?m)^(?:Error: )?(?:Exit code:? |Process exited with code )(-?\d+)\s*$`)

// exitCode is the exit code the first lines of a command's output state.
func exitCode(s string) (int, bool) {
	head, _ := cutText(s, 512)
	m := exitCodeRE.FindStringSubmatch(head)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	return n, err == nil
}
