//go:build unix

package history

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"path"
	"sort"
	"strconv"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// How a capture reads the terminals (docs/features/21-terminal-core.md):
// one connection to the instance's terminal core; per live terminal, the
// screen's text (terminal.read without history lines, which never scrolls
// a program) to see whether anything changed, then an observing attach
// with history lines, which neither the program nor other viewers notice,
// whose first paint is the snapshot.
//
// What this relies on of herdr-core (0.1.21, crates/herdr-core/src/
// viewers.rs and wire.rs): every paint it sends starts with CAN (0x18) and
// begins a DATA frame, as it is queued on an empty queue (the first paint
// when the viewer attaches, a repaint after the queue was dropped), so a
// DATA frame that starts with CAN starts a paint, and a first DATA frame
// that does not is the program's output. An attach's first paint is the
// history lines, the screen, the window title, then ESC[?9001h or
// ESC[?9001l and the status reports. A first paint above 4 MiB is dropped
// without a word: what arrives then is the program's live output. When the
// terminal is resized before the paint was sent whole, or the reader falls
// more than 4 MiB behind, the core drops what it had not sent and sends a
// new grid and a repaint without history: what was read then is no
// snapshot of the lines asked for.

// hcSocketName is the instance's terminal core's API socket in the agent's
// run directory (internal/agent/hc.go): never the user's own herdr-core.
const hcSocketName = "hc.sock"

// Bounds of a capture's waits (tests shorten them).
var (
	// captureTimeout bounds one capture: shorter than the core waits for
	// its answer (30 s), so that the result, with the terminals the time
	// did not reach, arrives in time.
	captureTimeout = 25 * time.Second
	// dialTimeout bounds connecting to the terminal core.
	dialTimeout = 5 * time.Second
	// probeTimeout bounds reading one terminal's screen.
	probeTimeout = 5 * time.Second
	// attachLimit bounds one attach: its paint is read within it.
	attachLimit = 5 * time.Second
	// firstByteWait: an attach of a quiet terminal whose paint has not
	// begun by then got none (the core dropped it); a terminal with output
	// shows that sooner, by output that is no paint.
	firstByteWait = 2 * time.Second
	// lockWait is how long a capture waits for the snapshots' directory
	// that another writer holds: a list or a read that prunes holds it a
	// moment, another agent's capture much longer (Busy).
	lockWait = 2 * time.Second
)

// goneGrace is how long the snapshots of a terminal gone from the terminal
// core's records are kept after a capture first saw it gone: a page whose
// pane's terminal was replaced by another address removes the old
// terminal's record, and adopts its snapshots for the new one meanwhile.
const goneGrace = 2 * time.Minute

// repaintTries bounds how often a terminal whose paint the core replaced
// (errRepainted) is attached to again within one capture.
const repaintTries = 3

// paintEnd ends the screen part of a first paint: herdr-core follows the
// screen and the window title with the terminal's win32-input-mode,
// ESC[?9001h or ESC[?9001l, then the status reports (first_paint in
// viewers.rs). The program's own output may carry the same sequence: the
// core relays it to viewers (only its own `hc attach` client filters it),
// so the paint ends at the first one after the paint's start. The snapshot
// is what comes before it.
var paintEnd = []byte("\x1b[?9001")

// restoredLine is the text of the line herdr-core writes into a kept
// terminal's new shell below the screen and history of the program before,
// when its configuration has restore_screen = true: RESTORED in
// crates/herdr-core/src/kept.rs of herdr-core 0.1.21, "\x1b[0m\r\n\x1b[2m--
// the program above ended; this is a new shell --\x1b[0m\r\n". The terminal
// core's records do not keep why a program was replaced (a kept terminal's
// live record has no reason), so this line is how a capture knows that the
// core restored the screen itself.
var restoredLine = []byte("the program above ended; this is a new shell")

// coreEnded are the reasons a terminal finished for when its terminal core
// or its machine ended rather than its program (web/src/restore.ts): its
// snapshots are what the page shows above the shell that replaces it.
var coreEnded = map[string]bool{"stopped_by_restart": true, "holder_lost": true, "server_stop": true, "host_shutdown": true}

// capturable tells whether a terminal of the terminal core's records gets
// snapshots: live, running a program (its pid tells the program's
// generations apart), of this terminal core with an address that can name
// files (a machine linked to the core has addresses machine/t7), and none
// of the product's own helpers (agentproto.HiddenLabel: the chat host),
// which no client shows. Every terminal a capture snapshots passes here.
func capturable(t *hc.Terminal) bool {
	if _, hidden := t.Labels[agentproto.HiddenLabel]; hidden {
		return false
	}
	return t.State == "live" && t.PID != nil && *t.PID > 0 && agentproto.ValidHistoryTerminal(t.Address)
}

// finishedForGood tells whether a terminal ended with its program (an exit
// with a code, a kill): its snapshots go.
func finishedForGood(t *hc.Terminal) bool {
	return t.State == "finished" && (t.Reason == nil || !coreEnded[*t.Reason])
}

// limits are a capture's parameters clamped to the hard limits.
type limits struct {
	lines, terminals, days int
	total                  int64
}

func limitsOf(p agentproto.HistoryCaptureParams) limits {
	return limits{
		lines:     clamp(p.Lines, agentproto.HistoryMinLines, agentproto.HistoryMaxLines),
		terminals: clamp(p.MaxTerminals, agentproto.HistoryMinTerminals, agentproto.HistoryMaxTerminals),
		total:     clamp(p.MaxTotalBytes, agentproto.HistoryMinTotalBytes, agentproto.HistoryMaxTotalBytes),
		days:      clamp(p.Days, agentproto.HistoryMinDays, agentproto.HistoryMaxDays),
	}
}

// clock is the time (tests replace it).
var clock = time.Now

// errNotRunning: the instance's terminal core cannot be reached. Its
// wording is fixed: the error goes to the core, without the socket's path.
var errNotRunning = plugin.Errorf("not_running", "history: the terminal core is not running")

// dial connects to the instance's terminal core.
func dial(ctx context.Context, runDir string) (*hc.Conn, error) {
	if !path.IsAbs(runDir) {
		return nil, errors.New("no run directory")
	}
	c, err := net.DialTimeout("unix", path.Join(runDir, hcSocketName), dialTimeout)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	conn, _, err := hc.Dial(ctx, c)
	return conn, err
}

// capture snapshots the live terminals of the instance's terminal core
// within p's limits; see the package's documentation.
func capture(ctx context.Context, env *plugin.Env, p agentproto.HistoryCaptureParams) (agentproto.HistoryCaptureResult, error) {
	lim := limitsOf(p)
	var res agentproto.HistoryCaptureResult
	lctx, cancel := context.WithTimeout(ctx, lockWait)
	s, removed, err := openStore(lctx, env.Base, true, clock())
	cancel()
	if err != nil && ctx.Err() == nil && (errors.Is(err, errBusy) || errors.Is(err, context.DeadlineExceeded)) {
		res.Busy = true
		return res, nil
	}
	if err != nil {
		return res, storeError(err)
	}
	defer s.close()
	res.Removed = removed + s.pruneAge(clock(), lim.days)
	err = run(ctx, env, s, lim, &res)
	res.Bytes = s.total()
	return res, err
}

// run is a capture once the store is open: what the terminal core's
// records say no longer belongs goes, the limits apply, then each
// capturable terminal is captured, those captured longest ago first. The
// terminals the capture's time does not reach fail as timeout.
func run(ctx context.Context, env *plugin.Env, s *store, lim limits, res *agentproto.HistoryCaptureResult) error {
	conn, err := dial(ctx, env.RunDir)
	if err != nil {
		return errNotRunning
	}
	defer conn.Close()
	lctx, cancel := context.WithTimeout(ctx, probeTimeout)
	var list struct {
		Terminals []hc.Terminal `json:"terminals"`
	}
	err = conn.Call(lctx, "terminal.list", map[string]any{"all": true}, &list)
	cancel()
	if err != nil {
		return errNotRunning
	}
	byAddr := make(map[string]*hc.Terminal, len(list.Terminals))
	for i := range list.Terminals {
		byAddr[list.Terminals[i].Address] = &list.Terminals[i]
	}
	now := clock().UnixMilli()
	for addr := range s.terms {
		t := byAddr[addr]
		switch {
		case t != nil && finishedForGood(t):
			if s.remove(addr) {
				res.Removed++
			}
		case t != nil:
			vanished.forget(addr)
		default:
			// Gone from the records: kept for goneGrace, in which a page
			// may give them to the terminal that took its place (adopt).
			since, seen := vanished.get(addr)
			if !seen {
				vanished.set(addr, now)
			} else if now-since >= goneGrace.Milliseconds() && s.remove(addr) {
				res.Removed++
			}
		}
	}
	withSnapshots := make(map[string]bool, len(s.terms))
	for addr := range s.terms {
		withSnapshots[addr] = true
	}
	vanished.keepOnly(withSnapshots)
	res.Evicted += s.fit(lim.terminals, lim.total, nil)
	live := map[string]bool{}
	var todo []*hc.Terminal
	for i := range list.Terminals {
		if t := &list.Terminals[i]; capturable(t) {
			live[t.Address] = true
			todo = append(todo, t)
		}
	}
	keepOnlyLive(live)
	sort.SliceStable(todo, func(i, j int) bool {
		a, b := lastTried(s, todo[i].Address), lastTried(s, todo[j].Address)
		return a < b || a == b && todo[i].Address < todo[j].Address
	})
	c := &capturer{conn: conn, s: s, lim: lim, written: map[string]bool{}}
	for _, t := range todo {
		code, evicted := "timeout", 0
		if ctx.Err() == nil {
			code, evicted = c.one(ctx, t)
		}
		res.Evicted += evicted
		switch code {
		case "":
			res.Captured++
		case skipped:
			res.Skipped++
		default:
			res.Failed++
			if res.Errors == nil {
				res.Errors = map[string]string{}
			}
			if len(res.Errors) < agentproto.HistoryMaxErrors {
				res.Errors[t.Address] = code
			}
		}
	}
	return nil
}

// lastTried is when terminal addr was captured or tried last, in ms: its
// newest stored generation (which outlives the agent), or a later attempt
// that stored nothing (tried).
func lastTried(s *store, addr string) int64 {
	var at int64
	if st := s.terms[addr]; st != nil {
		at = st.newest()
	}
	if t, ok := tried.get(addr); ok && t > at {
		at = t
	}
	return at
}

// skipped is capturer.one's answer for a terminal it left as it was.
const skipped = "skipped"

// capturer captures the terminals of one capture.
type capturer struct {
	conn *hc.Conn
	s    *store
	lim  limits
	// written are the terminals captured in this capture, which its later
	// terminals do not evict.
	written map[string]bool
}

// screenHash identifies what terminal.read showed of a terminal of a
// grid: its text alone does not change with the grid.
func screenHash(cols, rows int, text string) string {
	h := sha256.New()
	h.Write([]byte(strconv.Itoa(cols) + "x" + strconv.Itoa(rows) + "\n"))
	h.Write([]byte(text))
	return hex.EncodeToString(h.Sum(nil))
}

// one captures terminal t: "" when it wrote a new current generation,
// skipped when nothing changed (or the terminal ended meanwhile), else the
// failure's code. A terminal that fails keeps the generations it had.
func (c *capturer) one(ctx context.Context, t *hc.Terminal) (code string, evicted int) {
	code, evicted = c.try(ctx, t)
	if code != "" && code != skipped {
		tried.set(t.Address, clock().UnixMilli())
	}
	return code, evicted
}

func (c *capturer) try(ctx context.Context, t *hc.Terminal) (code string, evicted int) {
	addr, pid := t.Address, *t.PID
	// The program was replaced (a new shell of a kept terminal, also one
	// that is live again after the agent was away): what it held becomes
	// the previous generation before anything else is written.
	if st := c.s.terms[addr]; st != nil && st.cur != nil && st.cur.PID != pid {
		if err := c.s.rotate(addr); err != nil {
			return "write", 0
		}
	}
	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	var screen struct {
		Text string `json:"text"`
	}
	// Without a lines member (0, the same): with history lines the
	// terminal core scrolls a full-screen program to read its history. The
	// text is the terminal's last rows lines as plain text without the
	// trailing blank ones: neither the styles nor the grid change it, so
	// the hash covers the grid too.
	err := c.conn.Call(pctx, "terminal.read", map[string]any{"terminal": addr}, &screen)
	cancel()
	switch {
	case err == nil:
	case gone(err):
		return skipped, 0
	case ctx.Err() != nil:
		return "timeout", 0
	default:
		return "probe", 0
	}
	hash := screenHash(t.Cols, t.Rows, screen.Text)
	st := c.s.terms[addr]
	if st != nil && st.cur != nil && st.cur.Hash == hash {
		return skipped, 0
	}
	if st == nil || st.cur == nil {
		if k, ok := evictions.get(addr); ok && k == screenKey(pid, hash) {
			return skipped, 0
		}
	}
	key := screenKey(pid, hash) + "/" + strconv.Itoa(c.lim.terminals) + "/" + strconv.FormatInt(c.lim.total, 10)
	if r, ok := refusals.get(addr); ok && r.key == key {
		return r.code, 0
	}
	refuse := func(code string) string {
		refusals.set(addr, refusal{key: key, code: code})
		return code
	}
	if !c.s.room(addr, c.lim.terminals, c.lim.total, c.written) {
		return refuse("limit"), 0
	}
	p, err := grab(ctx, c.conn, t, c.lim.lines)
	switch {
	case err == nil:
	case ctx.Err() != nil:
		return "timeout", 0
	case gone(err):
		return skipped, 0
	case errors.Is(err, errNoPaint):
		return "no_paint", 0
	case errors.Is(err, errTooLarge):
		return refuse("too_large"), 0
	case errors.Is(err, errIncomplete):
		return "incomplete", 0
	case errors.Is(err, errRepainted):
		return "repainted", 0
	default:
		return "attach", 0
	}
	data := stripTitles(p.data)
	evicted, ok := c.s.makeRoom(addr, int64(len(data)), c.lim.terminals, c.lim.total, c.written)
	if !ok {
		return refuse("limit"), evicted
	}
	restored := restoredByCore(data)
	if st := c.s.terms[addr]; st != nil && st.cur != nil && st.cur.PID == pid && st.cur.Restored {
		restored = true
	}
	m := meta{Terminal: addr, Hash: hash, Days: c.lim.days, Restored: restored, HistorySnapshot: agentproto.HistorySnapshot{
		PID: pid, At: clock().UnixMilli(), Lines: p.lines, Cols: p.cols, Rows: p.rows,
	}}
	if err := c.s.write(m, data); err != nil {
		return "write", evicted
	}
	forgetTerminal(addr)
	c.written[addr] = true
	return "", evicted
}

// gone tells whether err says the terminal is gone, finished, or waits
// for its new shell (unavailable: a kept terminal that lost its program).
func gone(err error) bool {
	var he *hc.Error
	if errors.As(err, &he) && (he.Kind == "not_found" || he.Kind == "finished" || he.Kind == "unavailable") {
		return true
	}
	return errors.Is(err, errEnded)
}

var (
	// errNoPaint: no paint arrived, also with the fewest lines.
	errNoPaint = errors.New("history: no paint")
	// errTooLarge: the paint exceeds HistoryMaxBytes, also with the fewest
	// lines.
	errTooLarge = errors.New("history: paint too large")
	// errIncomplete: the paint did not end within attachLimit.
	errIncomplete = errors.New("history: paint incomplete")
	// errEnded: the terminal's program ended during the attach.
	errEnded = errors.New("history: terminal ended")
	// errRepainted: the terminal core replaced the paint before its end by
	// one without history (a new grid, or the reader fell behind).
	errRepainted = errors.New("history: paint replaced")
)

// paint is a terminal's first paint up to its end.
type paint struct {
	data              []byte
	cols, rows, lines int
}

// grab reads terminal t's first paint with lines of history. One the
// terminal core dropped or that is too large is asked again with half the
// lines, down to HistoryMinLines; one the core replaced by a repaint
// without history is asked again with as many lines, at most repaintTries
// times. What it returns with an error is never a snapshot.
func grab(ctx context.Context, conn *hc.Conn, t *hc.Terminal, lines int) (paint, error) {
	cols, rows := t.Cols, t.Rows
	repaints := 0
	for {
		p, err := attachOnce(ctx, conn, t.Address, cols, rows, lines)
		switch {
		case err == nil || ctx.Err() != nil:
			return p, err
		case errors.Is(err, errRepainted) && repaints < repaintTries:
			repaints++
			cols, rows = p.cols, p.rows
			continue
		case (errors.Is(err, errNoPaint) || errors.Is(err, errTooLarge)) && lines > agentproto.HistoryMinLines:
			lines = max(agentproto.HistoryMinLines, lines/2)
			continue
		}
		return paint{}, err
	}
}

// attachOnce attaches to terminal addr, last seen with a grid of cols ×
// rows, as an observer with lines of history and reads its first paint up
// to its end (paintEnd), within attachLimit. Credit goes back as the bytes
// arrive, so a paint larger than the terminal core's window arrives whole.
// With errRepainted, the paint's grid is the terminal's newest.
func attachOnce(ctx context.Context, conn *hc.Conn, addr string, cols, rows, lines int) (paint, error) {
	ctx, cancel := context.WithTimeout(ctx, attachLimit)
	defer cancel()
	start := time.Now()
	st, att, err := conn.Attach(ctx, hc.AttachParams{
		Terminal: addr, Cols: max(cols, 1), Rows: max(rows, 1),
		History: lines, Observe: true, ResizeNotifications: true,
	})
	if err != nil {
		return paint{}, err
	}
	defer st.Close()
	p := paint{cols: cols, rows: rows, lines: lines}
	// The reply's record is read after the paint was queued: a grid other
	// than the one listed means a resize that may have replaced the paint
	// before a byte of it was sent.
	if g := att.Terminal; g.Cols > 0 && g.Rows > 0 && (g.Cols != cols || g.Rows != rows) {
		p.cols, p.rows = g.Cols, g.Rows
		return p, errRepainted
	}
	var buf []byte
	gridSeen := false
	for {
		wait := attachLimit
		if buf == nil {
			if wait = firstByteWait - time.Since(start); wait <= 0 {
				return p, errNoPaint
			}
		}
		rctx, rcancel := context.WithTimeout(ctx, wait)
		o, err := st.Recv(rctx)
		rcancel()
		switch {
		case err == nil:
		case errors.Is(err, io.EOF):
			return paint{}, errEnded
		case errors.Is(err, context.DeadlineExceeded) && buf == nil:
			return p, errNoPaint
		case errors.Is(err, context.DeadlineExceeded):
			return p, errIncomplete
		default:
			return p, err
		}
		if len(o.Data) == 0 {
			if o.Cols == 0 && o.Rows == 0 {
				continue // an empty frame
			}
			// The grid the paint is drawn for comes first, once; a grid
			// after it, or another one than listed, comes with a repaint
			// without history.
			if gridSeen || buf != nil || o.Cols != p.cols || o.Rows != p.rows {
				p.cols, p.rows = o.Cols, o.Rows
				return p, errRepainted
			}
			gridSeen = true
			continue
		}
		st.Ack(len(o.Data))
		switch {
		case buf == nil && o.Data[0] != 0x18:
			// The program's output before any paint: the core dropped it.
			return p, errNoPaint
		case buf != nil && o.Data[0] == 0x18:
			// A second paint: the reader fell behind.
			return p, errRepainted
		}
		from := max(0, len(buf)-len(paintEnd))
		buf = append(buf, o.Data...)
		if i := endOf(buf, from); i >= 0 {
			p.data = buf[:i]
			return p, nil
		}
		if len(buf) > agentproto.HistoryMaxBytes {
			return paint{}, errTooLarge
		}
	}
}

// endOf is where the paint's end marker starts in b, at or after from; -1
// when b has none (yet).
func endOf(b []byte, from int) int {
	for {
		i := bytes.Index(b[from:], paintEnd)
		if i < 0 {
			return -1
		}
		at := from + i
		if n := at + len(paintEnd); n < len(b) && (b[n] == 'h' || b[n] == 'l') {
			return at
		} else if n >= len(b) {
			return -1 // its last byte is still on its way
		}
		from = at + 1
	}
}

// restoredByCore tells whether a paint shows the line the terminal core
// writes below a screen it restored (restoredLine), in its text: the bytes
// without escape sequences and control characters, so that the line is
// found also when the paint draws it in pieces (styles, a wrapped row).
func restoredByCore(b []byte) bool {
	return bytes.Contains(paintText(b), restoredLine)
}

// paintText is b without escape sequences (CSI, OSC and the other strings,
// two- and three-byte escapes) and control characters.
func paintText(b []byte) []byte {
	out := make([]byte, 0, len(b)/2)
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c == 0x1b && i+1 < len(b):
			i = escapeEnd(b, i)
		case c < 0x20 || c == 0x7f:
			i++
		default:
			out = append(out, c)
			i++
		}
	}
	return out
}

// escapeEnd is where the escape sequence at b[i] (an ESC with a byte after
// it) ends.
func escapeEnd(b []byte, i int) int {
	switch b[i+1] {
	case '[':
		for j := i + 2; j < len(b); j++ {
			if b[j] >= 0x40 && b[j] <= 0x7e {
				return j + 1
			}
		}
		return len(b)
	case ']', 'P', 'X', '^', '_':
		return oscEnd(b, i+2)
	}
	j := i + 1
	for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f {
		j++ // intermediate bytes (ESC ( B)
	}
	return min(j+1, len(b))
}

// stripTitles removes the window title sequences (OSC 0, 1 and 2) from a
// paint: a page that replays the snapshot must not take the old program's
// title for the terminal's. A title not terminated ends the bytes.
func stripTitles(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); {
		j := bytes.Index(b[i:], []byte("\x1b]"))
		if j < 0 {
			out = append(out, b[i:]...)
			break
		}
		j += i
		out = append(out, b[i:j]...)
		k := j + 2
		for k < len(b) && b[k] >= '0' && b[k] <= '9' {
			k++
		}
		if n := string(b[j+2 : k]); (n == "0" || n == "1" || n == "2") && k < len(b) && b[k] == ';' {
			i = oscEnd(b, k)
			continue
		}
		out = append(out, b[j:j+2]...)
		i = j + 2
	}
	return out
}

// oscEnd is where the string started before from ends: after its BEL or
// ST (ESC \), at an ESC that starts another sequence or a CAN or SUB that
// cancels it, else at the end of b.
func oscEnd(b []byte, from int) int {
	for m := from; m < len(b); m++ {
		switch b[m] {
		case 0x07:
			return m + 1
		case 0x18, 0x1a:
			return m
		case 0x1b:
			if m+1 < len(b) && b[m+1] == '\\' {
				return m + 2
			}
			return m
		}
	}
	return len(b)
}
