//go:build unix

package history

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"sync"
	"testing"

	"veldr/internal/agent/plugin"
	"veldr/internal/hc"
)

// fakeCore is a terminal core on a unix socket that speaks enough of
// herdr-core's API for captures: the hello, terminal.list, terminal.read and
// observing attaches whose output it sends against credit, in frames of
// chunk bytes, as herdr-core 0.1.21 does (crates/herdr-core/src/viewers.rs,
// wire.rs): the terminal's grid first, then the first paint, then the
// program's output; a paint the core replaces starts a frame of its own.
type fakeCore struct {
	t  *testing.T
	ln net.Listener

	mu    sync.Mutex
	terms []hc.Terminal
	text  map[string]string
	// paint is a terminal's first paint for an attach with history lines;
	// nil when the core drops it (a paint above 4 MiB): the attach succeeds
	// and only the program's output follows, after the grid.
	paint map[string]func(history int) []byte
	// after is output that follows a terminal's paint at once.
	after map[string][]byte
	// regrid: the terminal is resized after cut bytes of its paint were
	// sent: the core drops the paint's rest and sends the new grid and a
	// repaint without history; the terminal keeps the new grid.
	regrid map[string]*splice
	// behind: the reader fell behind after cut bytes of the paint: the
	// core drops the backlog and sends a repaint without history.
	behind map[string]*splice
	// unavailable terminals wait for their new shell: attaches fail so.
	unavailable map[string]bool
	chunk       int
	// What clients asked for.
	reads    []map[string]any
	attaches []hc.AttachParams
	lists    int
}

// splice replaces the paint of the next times attaches after cut bytes.
type splice struct {
	cut, times int
	grid       [2]int
}

// take tells whether the splice applies to this attach, and counts it.
func (s *splice) take() bool {
	if s == nil || s.times <= 0 {
		return false
	}
	s.times--
	return true
}

const window = 256 << 10

func newFakeCore(t *testing.T, socket string) *fakeCore {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeCore{t: t, ln: ln, text: map[string]string{}, paint: map[string]func(int) []byte{},
		after: map[string][]byte{}, regrid: map[string]*splice{}, behind: map[string]*splice{},
		unavailable: map[string]bool{}, chunk: 16 << 10}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

// set replaces the terminals' records.
func (f *fakeCore) set(terms ...hc.Terminal) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.terms = terms
}

func (f *fakeCore) setText(addr, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.text[addr] = text
}

func (f *fakeCore) setPaint(addr string, fn func(int) []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paint[addr] = fn
}

func (f *fakeCore) attached() []hc.AttachParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hc.AttachParams(nil), f.attaches...)
}

// channel is an attach's credit.
type channel struct {
	mu     sync.Mutex
	cond   *sync.Cond
	credit int
	closed bool
}

func (c *channel) add(n int) {
	c.mu.Lock()
	c.credit += n
	c.mu.Unlock()
	c.cond.Broadcast()
}

func (c *channel) close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.cond.Broadcast()
}

// take waits for credit and takes up to n of it; 0 once closed.
func (c *channel) take(n int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	for c.credit == 0 && !c.closed {
		c.cond.Wait()
	}
	if c.closed {
		return 0
	}
	n = min(n, c.credit)
	c.credit -= n
	return n
}

func frame(ch uint32, kind byte, payload []byte) []byte {
	b := binary.LittleEndian.AppendUint32(nil, ch)
	b = append(b, kind)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(payload)))
	return append(b, payload...)
}

func readFrame(r io.Reader) (uint32, byte, []byte, error) {
	var h [9]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, 0, nil, err
	}
	p := make([]byte, binary.LittleEndian.Uint32(h[5:]))
	if _, err := io.ReadFull(r, p); err != nil {
		return 0, 0, nil, err
	}
	return binary.LittleEndian.Uint32(h[:4]), h[4], p, nil
}

func (f *fakeCore) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	if _, err := br.ReadBytes('\n'); err != nil {
		return
	}
	io.WriteString(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"},"methods":[],"features":[]}}`+"\n")
	var wmu sync.Mutex
	write := func(b []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		c.Write(b)
	}
	chans := map[uint32]*channel{}
	var cmu sync.Mutex
	defer func() {
		cmu.Lock()
		for _, ch := range chans {
			ch.close()
		}
		cmu.Unlock()
	}()
	next := uint32(0)
	for {
		chID, kind, payload, err := readFrame(br)
		if err != nil {
			return
		}
		if chID != 0 {
			cmu.Lock()
			ch := chans[chID]
			cmu.Unlock()
			if ch == nil {
				continue
			}
			switch kind {
			case 1:
				ch.add(int(binary.LittleEndian.Uint32(payload)))
			case 2:
				ch.close()
			}
			continue
		}
		var req struct {
			ID     *uint64         `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(payload, &req) != nil || req.ID == nil {
			continue
		}
		reply := func(body string) {
			write(frame(0, 0, fmt.Appendf(nil, `{"jsonrpc":"2.0","id":%d,%s}`, *req.ID, body)))
		}
		result := func(v any) {
			b, _ := json.Marshal(v)
			reply(`"result":` + string(b))
		}
		failure := func(kind string) {
			reply(fmt.Sprintf(`"error":{"code":-32000,"message":%q,"data":{"kind":%q}}`, kind, kind))
		}
		f.mu.Lock()
		switch req.Method {
		case "terminal.list":
			f.lists++
			result(map[string]any{"terminals": f.terms, "hidden_finished": 0, "machines": []any{}})
		case "terminal.read":
			var p map[string]any
			json.Unmarshal(req.Params, &p)
			f.reads = append(f.reads, p)
			addr, _ := p["terminal"].(string)
			if text, ok := f.text[addr]; ok {
				result(map[string]any{"text": text, "complete": true, "how": "screen"})
			} else {
				failure("not_found")
			}
		case "terminal.attach":
			var p hc.AttachParams
			json.Unmarshal(req.Params, &p)
			f.attaches = append(f.attaches, p)
			var rec *hc.Terminal
			for i := range f.terms {
				if f.terms[i].Address == p.Terminal {
					rec = &f.terms[i]
				}
			}
			switch {
			case rec == nil:
				failure("not_found")
			case f.unavailable[p.Terminal]:
				failure("unavailable")
			default:
				f.attach(write, rec, p, &next, chans, &cmu, result)
			}
		default:
			reply(`"error":{"code":-32601,"message":"no method"}`)
		}
		f.mu.Unlock()
	}
}

// attach answers an attach of terminal rec and streams what the core
// would send for it. f.mu is held.
func (f *fakeCore) attach(write func([]byte), rec *hc.Terminal, p hc.AttachParams, next *uint32, chans map[uint32]*channel, cmu *sync.Mutex, result func(any)) {
	*next++
	id := *next
	ch := &channel{credit: window}
	ch.cond = sync.NewCond(&ch.mu)
	cmu.Lock()
	chans[id] = ch
	cmu.Unlock()
	addr, chunk, after := rec.Address, f.chunk, f.after[rec.Address]
	grid := [2]int{rec.Cols, rec.Rows}
	fn := f.paint[addr]
	var data []byte
	if fn != nil {
		data = fn(p.History)
	}
	rg := f.regrid[addr]
	// The core resizes nothing to the grid it has (viewers.rs).
	resized := data != nil && (rg == nil || rg.grid != grid) && rg.take()
	answered, newGrid := *rec, grid
	if resized {
		// The new grid is the terminal's from now on; the reply's record,
		// read after the paint was queued, has it when the resize came
		// before any byte was sent. The next resize goes back to the grid
		// before.
		newGrid, rg.grid = rg.grid, grid
		rec.Cols, rec.Rows = newGrid[0], newGrid[1]
		if rg.cut == 0 {
			answered = *rec
		}
	}
	result(map[string]any{"channel": id, "terminal": answered, "resize_notifications": true, "automatic_input": false})
	if data == nil {
		// Dropped: the grid goes with the first output, if any.
		if len(after) > 0 {
			go f.stream(write, id, ch, grid, after, chunk)
		}
		return
	}
	data = append(data, after...)
	switch bh := f.behind[addr]; {
	case resized && rg.cut == 0:
		// The grid and the paint were not sent yet: both are replaced.
		go f.stream(write, id, ch, newGrid, append(fn(0), after...), chunk)
	case resized:
		repaint, cut := append(fn(0), after...), rg.cut
		go func() {
			if f.stream(write, id, ch, grid, data[:cut], chunk) {
				f.stream(write, id, ch, newGrid, repaint, chunk)
			}
		}()
	case bh.take():
		repaint, cut := append(fn(0), after...), bh.cut
		go func() {
			if f.stream(write, id, ch, grid, data[:cut], chunk) {
				f.stream(write, id, ch, [2]int{}, repaint, chunk)
			}
		}()
	default:
		go f.stream(write, id, ch, grid, data, chunk)
	}
}

// stream sends a resize notification of grid (when set) and data in chunks
// as the credit allows; false once the channel closed.
func (f *fakeCore) stream(write func([]byte), id uint32, ch *channel, grid [2]int, data []byte, chunk int) bool {
	if grid[0] > 0 {
		p := binary.LittleEndian.AppendUint16(nil, uint16(grid[0]))
		write(frame(id, 3, binary.LittleEndian.AppendUint16(p, uint16(grid[1]))))
	}
	for len(data) > 0 {
		n := ch.take(min(chunk, len(data)))
		if n == 0 {
			return false
		}
		write(frame(id, 0, data[:n]))
		data = data[n:]
	}
	return true
}

// testEnv is an agent's environment in a fresh home with a terminal core
// on its run directory's socket. The home is short: macOS bounds a unix
// socket's path.
func testEnv(t *testing.T) (*plugin.Env, *fakeCore) {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "hst")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	base := path.Join(home, ".d")
	run := path.Join(base, "run")
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	f := newFakeCore(t, path.Join(run, hcSocketName))
	// The agent's process remembers terminals between captures: each test
	// starts without.
	forgetTerminal("")
	return &plugin.Env{Home: home, Base: base, RunDir: run, Environ: func() []string { return nil }}, f
}
