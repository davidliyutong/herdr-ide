//go:build unix

package history

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// fast shortens the capture's waits for the test.
func fast(t *testing.T) {
	t.Helper()
	fb, al, lw := firstByteWait, attachLimit, lockWait
	firstByteWait, attachLimit, lockWait = 100*time.Millisecond, 2*time.Second, 50*time.Millisecond
	t.Cleanup(func() { firstByteWait, attachLimit, lockWait = fb, al, lw })
}

// ticking makes the clock start at start and go one second further at
// every reading, so that every snapshot has a time of its own.
func ticking(t *testing.T, start time.Time) *time.Time {
	t.Helper()
	now := start
	old := clock
	clock = func() time.Time {
		now = now.Add(time.Second)
		return now
	}
	t.Cleanup(func() { clock = old })
	return &now
}

func live(addr string, pid int) hc.Terminal {
	return hc.Terminal{Address: addr, State: "live", PID: &pid, Cols: 80, Rows: 24, Labels: map[string]string{}}
}

func finished(addr, reason string) hc.Terminal {
	t := hc.Terminal{Address: addr, State: "finished", Cols: 80, Rows: 24, Labels: map[string]string{}}
	if reason != "" {
		t.Reason = &reason
	}
	return t
}

// paintHead starts a first paint as herdr-core makes it.
const paintHead = "\x18\x1b[!p\x1b[?2026l\x1b[?1049l\x1b[H\x1b[2J"

// paintTail ends it: the end marker and a status report.
const paintTail = "\x1b[?9001l\x1b]7501;state=idle\x1b\\"

// body is a paint's screen and history part as herdr-core draws it: what a
// snapshot keeps, with the title the paint carries (title) or not. A paint
// without history lines (a repaint) has no history part.
func body(history, width int, screen string, title bool) []byte {
	var b bytes.Buffer
	b.WriteString(paintHead)
	for i := range history {
		fmt.Fprintf(&b, "\x1b[32m%05d %s\x1b[0m\r\n", i, strings.Repeat("x", width))
	}
	if history > 0 {
		b.WriteString("\x1b[0m\r\n\n\n\x1b[H\x1b[2J")
	}
	b.WriteString(screen)
	if title {
		b.WriteString("\x1b]2;vim notes.txt\x1b\\")
	}
	return b.Bytes()
}

// painter paints a terminal with up to avail history lines of width
// characters.
func painter(avail, width int, screen string) func(int) []byte {
	return func(h int) []byte { return append(body(min(h, avail), width, screen, true), paintTail...) }
}

var params = agentproto.HistoryCaptureParams{Lines: 2000, MaxTerminals: 32, MaxTotalBytes: 64 << 20, Days: 7}

func mustCapture(t *testing.T, env *plugin.Env, p agentproto.HistoryCaptureParams) agentproto.HistoryCaptureResult {
	t.Helper()
	res, err := capture(context.Background(), env, p)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	return res
}

func historyPath(env *plugin.Env, name string) string { return path.Join(env.Base, dirName, name) }

func slurp(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func metaOf(t *testing.T, env *plugin.Env, addr string, prev bool) *meta {
	t.Helper()
	return readMeta(path.Join(env.Base, dirName), addr, prev)
}

// call runs an action as the agent does and decodes its result into out.
func call(t *testing.T, env *plugin.Env, action string, p any, out any) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	defer b.Close()
	raw, _ := json.Marshal(p)
	go handle(context.Background(), a, action, raw, env)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatal(err)
	}
	res := rep.Plugin
	if rep.PluginLength > 0 {
		var err error
		if res, err = agentproto.ReadBody(b, rep.PluginLength); err != nil {
			t.Fatal(err)
		}
	}
	if rep.OK && out != nil {
		if err := json.Unmarshal(res, out); err != nil {
			t.Fatal(err)
		}
	}
	return rep
}

// The plugin is registered and answers an action it does not have as
// unknown.
func TestUnknownActions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if plugin.Lookup(ID) == nil {
		t.Fatal("not registered")
	}
	for _, action := range []string{"", "tail", "Capture"} {
		if rep := call(t, &plugin.Env{}, action, map[string]any{}, nil); rep.OK || rep.Code != "bad_params" {
			t.Errorf("%q: %+v", action, rep)
		}
	}
}

// A capture stores a terminal's first paint as an observer gets it, across
// frames and beyond the terminal core's window (credit goes back), up to
// the paint's end and without its title; it reads the screen without a
// lines member; a terminal whose screen and grid did not change is not
// attached to again.
func TestCapture(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	t1 := live("t1", 100)
	t1.Cols, t1.Rows = 120, 40
	f.set(t1)
	f.setText("t1", "$ ls")
	f.setPaint("t1", painter(5000, 100, "$ ls"))
	f.after["t1"] = []byte("live output that follows\r\n")
	res := mustCapture(t, env, agentproto.HistoryCaptureParams{Lines: 4000, MaxTerminals: 32, MaxTotalBytes: 64 << 20, Days: 7})
	if res.Captured != 1 || res.Failed != 0 || res.Skipped != 0 {
		t.Fatalf("result %+v", res)
	}
	data := slurp(t, historyPath(env, "t1.vt"))
	want := body(4000, 100, "$ ls", false)
	if !bytes.Equal(data, want) {
		t.Fatalf("snapshot of %d bytes, want %d", len(data), len(want))
	}
	if len(data) <= window {
		t.Fatalf("paint of %d bytes does not exceed the window", len(data))
	}
	if res.Bytes != int64(len(data)) {
		t.Errorf("bytes %d, want %d", res.Bytes, len(data))
	}
	m := metaOf(t, env, "t1", false)
	if m == nil || m.PID != 100 || m.Cols != 120 || m.Rows != 40 || m.Lines != 4000 || m.Bytes != int64(len(data)) || m.Days != 7 || m.At <= 0 {
		t.Fatalf("meta %+v", m)
	}
	at := f.attached()
	if len(at) != 1 || !at[0].Observe || !at[0].ResizeNotifications || at[0].History != 4000 || at[0].Cols != 120 || at[0].Rows != 40 {
		t.Fatalf("attaches %+v", at)
	}
	if m.Restored {
		t.Fatal("restored without the terminal core's line")
	}
	// Unchanged: probed, not attached.
	if res := mustCapture(t, env, params); res.Skipped != 1 || res.Captured != 0 {
		t.Fatalf("unchanged: %+v", res)
	}
	if n := len(f.attached()); n != 1 {
		t.Fatalf("%d attaches", n)
	}
	// Changed: captured again, the same program's snapshot replaced.
	f.setText("t1", "$ ls -l")
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("changed: %+v", res)
	}
	if metaOf(t, env, "t1", true) != nil {
		t.Fatal("a previous generation without a new program")
	}
	// The grid alone changed: captured again, with the new grid.
	f.mu.Lock()
	f.terms[0].Cols = 100
	f.mu.Unlock()
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("resized: %+v", res)
	}
	if m := metaOf(t, env, "t1", false); m.Cols != 100 || m.Rows != 40 {
		t.Fatalf("grid %dx%d", m.Cols, m.Rows)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reads) != 4 {
		t.Fatalf("%d reads", len(f.reads))
	}
	for _, r := range f.reads {
		if _, has := r["lines"]; has || r["terminal"] != "t1" {
			t.Errorf("read %v", r)
		}
	}
}

// The paint's end is found also when its marker straddles two frames, and
// output after it is not stored.
func TestPaintEnd(t *testing.T) {
	for _, c := range []struct {
		b    string
		from int
		want int
	}{
		{"abc\x1b[?9001lxyz", 0, 3},
		{"abc\x1b[?9001h", 0, 3},
		{"abc\x1b[?9001", 0, -1},
		{"abc\x1b[?900", 0, -1},
		{"\x1b[?90012h\x1b[?9001l", 0, 9},
		{"abc", 0, -1},
		{"ab\x1b[?9001lc\x1b[?9001h", 3, 11},
	} {
		if got := endOf([]byte(c.b), c.from); got != c.want {
			t.Errorf("%q from %d: %d, want %d", c.b, c.from, got, c.want)
		}
	}
	env, f := testEnv(t)
	fast(t)
	f.chunk = 5
	f.set(live("t1", 7))
	f.setText("t1", "x")
	f.setPaint("t1", painter(30, 10, "$ "))
	f.after["t1"] = []byte("more output\x1b[?9001h after")
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
	if got := slurp(t, historyPath(env, "t1.vt")); !bytes.Equal(got, body(30, 10, "$ ", false)) {
		t.Fatalf("snapshot %q", got)
	}
	// A program that writes all the time does not hold the capture: the
	// stream ends at the paint's end.
	f.chunk = 1
	f.after["t1"] = bytes.Repeat([]byte("y"), 1<<20)
	f.setText("t1", "busy")
	start := time.Now()
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("a busy terminal took %v", d)
	}
}

// A terminal resized while its paint arrives: herdr-core drops the rest of
// the paint and sends the new grid and a repaint without history, which is
// never stored as a snapshot of the lines asked for. The capture attaches
// again with the new grid; a terminal resized at every attach fails as
// repainted and keeps what it had.
func TestResizeDuringPaint(t *testing.T) {
	for _, cut := range []int{300, 0} {
		t.Run(fmt.Sprint(cut), func(t *testing.T) {
			env, f := testEnv(t)
			fast(t)
			f.set(live("t1", 7))
			f.setText("t1", "x")
			f.setPaint("t1", painter(100, 10, "$ "))
			f.regrid["t1"] = &splice{cut: cut, times: 1, grid: [2]int{100, 30}}
			if res := mustCapture(t, env, params); res.Captured != 1 {
				t.Fatalf("%+v", res)
			}
			if got := slurp(t, historyPath(env, "t1.vt")); !bytes.Equal(got, body(100, 10, "$ ", false)) {
				t.Fatalf("snapshot of %d bytes", len(got))
			}
			if m := metaOf(t, env, "t1", false); m.Cols != 100 || m.Rows != 30 || m.Lines != 2000 {
				t.Fatalf("meta %+v", m)
			}
			at := f.attached()
			if len(at) != 2 || at[1].History != 2000 || at[1].Cols != 100 || at[1].Rows != 30 {
				t.Fatalf("attaches %+v", at)
			}

			// Resized at every attach: a bounded number of attaches, then
			// the terminal fails and its snapshot stays as it was.
			before := snapshotFiles(t, env, "t1")
			f.setText("t1", "y")
			f.regrid["t1"] = &splice{cut: cut, times: 100, grid: [2]int{90, 20}}
			res := mustCapture(t, env, params)
			if res.Failed != 1 || res.Errors["t1"] != "repainted" {
				t.Fatalf("%+v", res)
			}
			if n := len(f.attached()) - len(at); n != 1+repaintTries {
				t.Fatalf("%d attaches", n)
			}
			sameFiles(t, env, "t1", before)
		})
	}
}

// A reader that fell more than 4 MiB behind gets a repaint without history
// in the middle of the stream (a second CAN): the capture attaches again;
// one that falls behind at every attach fails as repainted.
func TestBehindRepaint(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 7))
	f.setText("t1", "x")
	f.setPaint("t1", painter(3000, 100, "$ ")) // ~350 KiB
	f.behind["t1"] = &splice{cut: 2 * f.chunk, times: 1}
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
	if got := slurp(t, historyPath(env, "t1.vt")); !bytes.Equal(got, body(2000, 100, "$ ", false)) {
		t.Fatalf("snapshot of %d bytes", len(got))
	}
	if n := len(f.attached()); n != 2 {
		t.Fatalf("%d attaches", n)
	}
	before := snapshotFiles(t, env, "t1")
	f.setText("t1", "y")
	f.behind["t1"] = &splice{cut: f.chunk, times: 100}
	if res := mustCapture(t, env, params); res.Failed != 1 || res.Errors["t1"] != "repainted" {
		t.Fatalf("%+v", res)
	}
	sameFiles(t, env, "t1", before)
}

// A paint the terminal core dropped while the program writes: its output
// arrives without a paint before it, which counts as no paint at once,
// without waiting for one.
func TestDroppedPaintWithOutput(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	firstByteWait = 5 * time.Second
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", func(h int) []byte {
		if h > 600 {
			return nil
		}
		return painter(5000, 10, "a")(h)
	})
	f.after["t1"] = []byte("live output\r\n")
	start := time.Now()
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("took %v", d)
	}
	if m := metaOf(t, env, "t1", false); m == nil || m.Lines != 500 {
		t.Fatalf("meta %+v", m)
	}
	if got := slurp(t, historyPath(env, "t1.vt")); !bytes.Equal(got, body(500, 10, "a", false)) {
		t.Fatalf("snapshot %q", got)
	}
}

// A kept terminal that lost its program and waits for its shell answers
// attaches with unavailable: skipped, its snapshots kept.
func TestUnavailable(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 7))
	f.setText("t1", "x")
	f.setPaint("t1", painter(10, 10, "x"))
	mustCapture(t, env, params)
	before := snapshotFiles(t, env, "t1")
	f.setText("t1", "y")
	f.unavailable["t1"] = true
	if res := mustCapture(t, env, params); res.Skipped != 1 || res.Failed != 0 {
		t.Fatalf("%+v", res)
	}
	sameFiles(t, env, "t1", before)
}

// snapshotFiles are the bytes of a terminal's files.
func snapshotFiles(t *testing.T, env *plugin.Env, addr string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, name := range []string{addr + ".vt", addr + ".json", addr + ".prev.vt", addr + ".prev.json"} {
		if b, err := os.ReadFile(historyPath(env, name)); err == nil {
			out[name] = b
		}
	}
	if len(out) == 0 {
		t.Fatalf("%s has no files", addr)
	}
	return out
}

// sameFiles fails unless a terminal's files are byte for byte those before.
func sameFiles(t *testing.T, env *plugin.Env, addr string, before map[string][]byte) {
	t.Helper()
	now := map[string][]byte{}
	for _, name := range []string{addr + ".vt", addr + ".json", addr + ".prev.vt", addr + ".prev.json"} {
		if b, err := os.ReadFile(historyPath(env, name)); err == nil {
			now[name] = b
		}
	}
	if len(now) != len(before) {
		t.Fatalf("files %d, were %d", len(now), len(before))
	}
	for name, b := range before {
		if !bytes.Equal(now[name], b) {
			t.Fatalf("%s changed", name)
		}
	}
	entries, _ := os.ReadDir(path.Join(env.Base, dirName))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), tmpSuffix) {
			t.Fatalf("a temporary file stayed: %s", e.Name())
		}
	}
}

// A terminal that fails, however its read failed, keeps its files byte for
// byte: nothing is written before a whole paint was read.
func TestFailureKeepsFiles(t *testing.T) {
	for name, fail := range map[string]func(f *fakeCore){
		"no_paint":   func(f *fakeCore) { f.setPaint("t1", func(int) []byte { return nil }) },
		"too_large":  func(f *fakeCore) { f.setPaint("t1", func(int) []byte { return painter(1000, 3000, "b")(1000) }) },
		"incomplete": func(f *fakeCore) { f.setPaint("t1", func(int) []byte { return body(10, 10, "b", true) }) },
		"repainted":  func(f *fakeCore) { f.regrid["t1"] = &splice{cut: 100, times: 100, grid: [2]int{70, 20}} },
		"ended":      func(f *fakeCore) { f.unavailable["t1"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			env, f := testEnv(t)
			fast(t)
			attachLimit = 300 * time.Millisecond
			f.set(live("t1", 7))
			f.setText("t1", "a")
			f.setPaint("t1", painter(50, 10, "a"))
			mustCapture(t, env, params)
			f.set(live("t1", 8))
			f.setText("t1", "b")
			f.setPaint("t1", painter(50, 10, "b"))
			mustCapture(t, env, params) // a previous generation too
			before := snapshotFiles(t, env, "t1")
			f.setText("t1", "c")
			fail(f)
			res := mustCapture(t, env, params)
			if res.Captured != 0 {
				t.Fatalf("%+v", res)
			}
			sameFiles(t, env, "t1", before)
		})
	}
}

// Window titles go; other sequences stay.
func TestStripTitles(t *testing.T) {
	for in, want := range map[string]string{
		"a\x1b]2;title\x1b\\b":                   "ab",
		"a\x1b]0;both\x07b":                      "ab",
		"a\x1b]1;icon\x1b\\b\x1b]2;t\x07":        "ab",
		"a\x1b]7;file:///tmp\x1b\\b":             "a\x1b]7;file:///tmp\x1b\\b",
		"a\x1b]8;;http://x\x1b\\l\x1b]8;;\x1b\\": "a\x1b]8;;http://x\x1b\\l\x1b]8;;\x1b\\",
		"a\x1b]22;x\x07b":                        "a\x1b]22;x\x07b",
		"a\x1b]2;cut":                            "a",
		"a\x1b]2;t\x1b[31mred":                   "a\x1b[31mred",
		"a\x1b]2;t\x18b":                         "a\x18b",
		"\x1b]":                                  "\x1b]",
		"plain":                                  "plain",
	} {
		if got := string(stripTitles([]byte(in))); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// A paint the terminal core dropped (none arrives) is asked again with
// half the lines, down to the fewest; then the terminal fails for this
// capture.
func TestDroppedPaintHalvesLines(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", func(h int) []byte {
		if h > 600 {
			return nil
		}
		return painter(5000, 10, "a")(h)
	})
	f.setPaint("t2", func(int) []byte { return nil })
	res := mustCapture(t, env, params)
	if res.Captured != 1 || res.Failed != 1 || res.Errors["t2"] != "no_paint" {
		t.Fatalf("%+v", res)
	}
	var t1, t2 []int
	for _, a := range f.attached() {
		if a.Terminal == "t1" {
			t1 = append(t1, a.History)
		} else {
			t2 = append(t2, a.History)
		}
	}
	if fmt.Sprint(t1) != "[2000 1000 500]" || fmt.Sprint(t2) != "[2000 1000 500 250 125 100]" {
		t.Fatalf("history asked: t1 %v, t2 %v", t1, t2)
	}
	if m := metaOf(t, env, "t1", false); m == nil || m.Lines != 500 {
		t.Fatalf("meta %+v", m)
	}
	if _, err := os.Lstat(historyPath(env, "t2.vt")); err == nil {
		t.Fatal("t2 stored")
	}
}

// A paint over the per-generation limit is asked again with half the
// lines; one over it with the fewest lines is not stored (too_large).
func TestTooLargeHalvesLines(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", func(h int) []byte {
		if h >= 1000 {
			return painter(h, 3000, "a")(h) // ~3 MiB
		}
		return painter(5000, 10, "a")(h)
	})
	f.setPaint("t2", func(int) []byte { return painter(1000, 3000, "b")(1000) })
	res := mustCapture(t, env, params)
	if res.Captured != 1 || res.Failed != 1 || res.Errors["t2"] != "too_large" {
		t.Fatalf("%+v", res)
	}
	if m := metaOf(t, env, "t1", false); m == nil || m.Lines != 500 || m.Bytes > agentproto.HistoryMaxBytes {
		t.Fatalf("meta %+v", m)
	}
	if _, err := os.Lstat(historyPath(env, "t2.vt")); err == nil {
		t.Fatal("t2 stored")
	}
}

// A new program in a terminal (its pid changed) makes the snapshot the
// previous generation, once: before the new one is written, and not again
// at the next capture of the same program, also when the first capture of
// the new program failed.
func TestNewProgramRotatesOnce(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	ticking(t, time.Now())
	f.set(live("t1", 100))
	f.setText("t1", "old program")
	f.setPaint("t1", painter(50, 10, "old program"))
	mustCapture(t, env, params)
	old := slurp(t, historyPath(env, "t1.vt"))
	oldAt := metaOf(t, env, "t1", false).At

	// The new shell's first capture fails (no paint): the old snapshot is
	// the previous generation already, and there is no current one.
	f.set(live("t1", 200))
	f.setText("t1", "new shell")
	f.setPaint("t1", func(int) []byte { return nil })
	if res := mustCapture(t, env, params); res.Failed != 1 {
		t.Fatalf("%+v", res)
	}
	if p := metaOf(t, env, "t1", true); p == nil || p.PID != 100 || p.At != oldAt || metaOf(t, env, "t1", false) != nil {
		t.Fatalf("previous %+v", p)
	}
	f.setPaint("t1", painter(50, 10, "new shell"))
	for i := range 2 {
		f.setText("t1", fmt.Sprintf("new shell %d", i))
		if res := mustCapture(t, env, params); res.Captured != 1 {
			t.Fatalf("%+v", res)
		}
		p, c := metaOf(t, env, "t1", true), metaOf(t, env, "t1", false)
		if p == nil || p.PID != 100 || p.At != oldAt || c == nil || c.PID != 200 {
			t.Fatalf("capture %d: previous %+v, current %+v", i, p, c)
		}
		if !bytes.Equal(slurp(t, historyPath(env, "t1.prev.vt")), old) {
			t.Fatal("previous bytes changed")
		}
	}
	// Another program again: the new shell's snapshot replaces the
	// previous one.
	f.set(live("t1", 300))
	f.setText("t1", "third")
	mustCapture(t, env, params)
	if p := metaOf(t, env, "t1", true); p == nil || p.PID != 200 {
		t.Fatalf("previous %+v", p)
	}
}

// What the core asks for is clamped to the hard limits.
func TestLimitsClamped(t *testing.T) {
	lo := limitsOf(agentproto.HistoryCaptureParams{Lines: -5, MaxTerminals: 0, MaxTotalBytes: 10, Days: 0})
	hi := limitsOf(agentproto.HistoryCaptureParams{Lines: 1 << 30, MaxTerminals: 1 << 30, MaxTotalBytes: 1 << 50, Days: 1000})
	if lo != (limits{lines: 100, terminals: 1, total: 1 << 20, days: 1}) {
		t.Errorf("low %+v", lo)
	}
	if hi != (limits{lines: 10000, terminals: 128, total: 512 << 20, days: 30}) {
		t.Errorf("high %+v", hi)
	}
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", painter(20000, 1, "a"))
	for _, c := range []struct{ ask, want int }{{5, 100}, {99999, 10000}} {
		f.setText("t1", fmt.Sprint(c.ask))
		mustCapture(t, env, agentproto.HistoryCaptureParams{Lines: c.ask, MaxTerminals: 8, MaxTotalBytes: 64 << 20, Days: 7})
		at := f.attached()
		if got := at[len(at)-1].History; got != c.want {
			t.Errorf("lines %d: asked %d, want %d", c.ask, got, c.want)
		}
	}
}

// Over maxTerminals the terminals captured longest ago go first; a
// terminal written in the same capture is not evicted for another.
func TestMaxTerminals(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	ticking(t, time.Now())
	f.set(live("t1", 1), live("t2", 2), live("t3", 3))
	for _, a := range []string{"t1", "t2", "t3"} {
		f.setText(a, a)
		f.setPaint(a, painter(10, 10, a))
	}
	p := params
	p.MaxTerminals = 2
	res := mustCapture(t, env, p)
	if res.Captured != 2 || res.Failed != 1 || res.Errors["t3"] != "limit" || res.Evicted != 0 {
		t.Fatalf("first: %+v", res)
	}
	// Decided before its paint was read: t3 was not attached to.
	for _, a := range f.attached() {
		if a.Terminal == "t3" {
			t.Fatal("t3 attached to without room")
		}
	}
	// t3 unchanged: remembered as refused, not read again.
	if res := mustCapture(t, env, p); res.Errors["t3"] != "limit" || res.Skipped != 2 || len(f.attached()) != 2 {
		t.Fatalf("again: %+v", res)
	}
	// t3 changes: it takes the place of the terminal captured longest ago.
	f.setText("t3", "t3 again")
	res = mustCapture(t, env, p)
	if res.Captured != 1 || res.Skipped != 2 || res.Evicted != 1 {
		t.Fatalf("second: %+v", res)
	}
	if metaOf(t, env, "t1", false) != nil || metaOf(t, env, "t2", false) == nil || metaOf(t, env, "t3", false) == nil {
		t.Fatal("evicted the wrong terminal")
	}
	// A lower limit evicts at once, before anything is captured; a
	// terminal with two generations counts once.
	f.set(live("t2", 2), live("t3", 33))
	f.setText("t3", "t3 new program")
	res = mustCapture(t, env, p)
	if metaOf(t, env, "t3", true) == nil || metaOf(t, env, "t2", false) == nil {
		t.Fatalf("two generations: %+v", res)
	}
	p.MaxTerminals = 1
	res = mustCapture(t, env, p)
	if res.Evicted != 1 || metaOf(t, env, "t2", false) != nil || metaOf(t, env, "t3", true) == nil {
		t.Fatalf("lower limit: %+v", res)
	}
}

// Over maxTotalBytes the terminals captured longest ago go first, checked
// before writing; a terminal's own previous generation goes only when the
// terminal alone exceeds the total; a generation larger than the total is
// not written.
func TestMaxTotalBytes(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	ticking(t, time.Now())
	f.set(live("t1", 1), live("t2", 2), live("t3", 3))
	for _, a := range []string{"t1", "t2", "t3"} {
		f.setText(a, a)
		f.setPaint(a, painter(400, 1000, a)) // ~400 KiB
	}
	p := params
	p.MaxTotalBytes = 1 << 20
	res := mustCapture(t, env, p)
	if res.Captured != 2 || res.Errors["t3"] != "limit" || res.Bytes > 1<<20 {
		t.Fatalf("first: %+v", res)
	}
	f.setText("t3", "t3 again")
	res = mustCapture(t, env, p)
	if res.Captured != 1 || res.Evicted != 1 || res.Bytes > 1<<20 || metaOf(t, env, "t1", false) != nil || metaOf(t, env, "t3", false) == nil {
		t.Fatalf("second: %+v", res)
	}

	// One terminal whose two generations exceed the total: its previous
	// one goes.
	env, f = testEnv(t)
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", painter(700, 1000, "a")) // ~700 KiB
	mustCapture(t, env, p)
	f.set(live("t1", 2))
	f.setText("t1", "b")
	res = mustCapture(t, env, p)
	if res.Captured != 1 || metaOf(t, env, "t1", true) != nil || metaOf(t, env, "t1", false).PID != 2 || res.Bytes > 1<<20 {
		t.Fatalf("alone: %+v", res)
	}
	// A generation larger than the total.
	f.setText("t1", "c")
	f.setPaint("t1", painter(1500, 1000, "c")) // ~1.5 MiB
	res = mustCapture(t, env, p)
	if res.Failed != 1 || res.Errors["t1"] != "limit" || metaOf(t, env, "t1", false).PID != 2 {
		t.Fatalf("larger than the total: %+v", res)
	}
}

// Snapshots older than days go at every capture and, by the days they
// were written under, when the agent starts (Prune).
func TestAge(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	start := time.Now()
	now := ticking(t, start)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", painter(10, 10, "a"))
	f.setPaint("t2", painter(10, 10, "b"))
	p := params
	p.Days = 3
	mustCapture(t, env, p)
	*now = start.Add(2 * 24 * time.Hour)
	f.setText("t2", "b2")
	mustCapture(t, env, p) // t2 captured again two days later
	*now = start.Add(3*24*time.Hour + time.Hour)
	f.set() // nothing live: no capture, but the age applies first
	f.setText("t1", "")
	res, err := capture(context.Background(), env, p)
	if err != nil || res.Removed != 1 || metaOf(t, env, "t2", false) == nil {
		// t1 is too old; t2 is gone from the records, kept for goneGrace.
		t.Fatalf("%+v %v", res, err)
	}
	*now = now.Add(goneGrace)
	if res, err = capture(context.Background(), env, p); err != nil || res.Removed != 1 || metaOf(t, env, "t2", false) != nil {
		t.Fatalf("after the grace: %+v %v", res, err)
	}

	// Prune keeps what is younger than the days it was written under.
	env, f = testEnv(t)
	*now = start
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", painter(10, 10, "a"))
	f.setPaint("t2", painter(10, 10, "b"))
	p.Days = 2
	f.set(live("t1", 1))
	mustCapture(t, env, p)
	p.Days = 5
	f.set(live("t1", 1), live("t2", 2))
	mustCapture(t, env, p)
	Prune(env.Base, start.Add(3*24*time.Hour))
	if metaOf(t, env, "t1", false) != nil || metaOf(t, env, "t2", false) == nil {
		t.Fatal("pruned the wrong snapshot")
	}
	// Prune of a machine without snapshots creates nothing.
	empty := t.TempDir()
	Prune(empty, time.Now())
	if _, err := os.Lstat(path.Join(empty, dirName)); err == nil {
		t.Fatal("Prune created the directory")
	}
}

// A terminal that finished with its program loses its snapshots at the
// next capture, one gone from the records once it has been gone for
// goneGrace; one that finished with its terminal core keeps them (the page
// shows them above its new shell).
func TestFinishedPruned(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	now := ticking(t, time.Now())
	addrs := []string{"t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"}
	var all []hc.Terminal
	for i, a := range addrs {
		all = append(all, live(a, i+1))
		f.setText(a, a)
		f.setPaint(a, painter(10, 10, a))
	}
	f.set(all...)
	if res := mustCapture(t, env, params); res.Captured != len(addrs) {
		t.Fatalf("%+v", res)
	}
	f.set(finished("t1", "exited"), finished("t2", "killed"), finished("t3", "stopped_by_restart"),
		finished("t4", "holder_lost"), finished("t5", "server_stop"), finished("t6", "host_shutdown"),
		finished("t7", ""), finished("t8", "signaled"))
	res := mustCapture(t, env, params)
	if res.Removed != 4 {
		t.Errorf("removed %d", res.Removed)
	}
	kept := map[string]bool{"t1": false, "t2": false, "t3": true, "t4": true, "t5": true, "t6": true, "t7": false, "t8": false, "t9": true}
	for a, keep := range kept {
		if got := metaOf(t, env, a, false) != nil; got != keep {
			t.Errorf("%s kept %v, want %v", a, got, keep)
		}
	}
	// t9 has been gone for the grace.
	*now = now.Add(goneGrace)
	if res := mustCapture(t, env, params); res.Removed != 1 || metaOf(t, env, "t9", false) != nil {
		t.Errorf("after the grace: %+v", res)
	}
}

// Addresses: only what can name files of the history directory, from the
// terminal core's records and from requests alike.
func TestAddresses(t *testing.T) {
	for s, ok := range map[string]bool{
		"t1": true, "t-1_x": true, "0_a-": true, strings.Repeat("a", 64): true,
		"": false, "../x": false, "..": false, ".": false, ".x": false, "a/b": false, "m/t7": false,
		strings.Repeat("a", 65): false, "t1.prev": false, "t-1_x.y": false, "-x": false, "_x": false,
		"t 1": false, "t1\n": false, "ü": false,
	} {
		if agentproto.ValidHistoryTerminal(s) != ok {
			t.Errorf("%q: %v", s, !ok)
		}
	}
	env, f := testEnv(t)
	fast(t)
	bad := []string{"../x", "m/t7", strings.Repeat("a", 65), ".hidden"}
	var terms []hc.Terminal
	for i, a := range bad {
		terms = append(terms, live(a, i+1))
		f.setText(a, "x")
		f.setPaint(a, painter(1, 1, "x"))
	}
	f.set(terms...)
	if res := mustCapture(t, env, params); res.Captured != 0 || len(f.attached()) != 0 {
		t.Fatalf("captured a bad address: %+v", res)
	}
	f.mu.Lock()
	reads := len(f.reads)
	f.mu.Unlock()
	if reads != 0 {
		t.Fatal("read a bad address")
	}
	for _, a := range append(bad, "") {
		if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: a, Generation: "current"}, nil); rep.Code != "bad_params" {
			t.Errorf("read %q: %+v", a, rep)
		}
		if a == "" {
			continue
		}
		if rep := call(t, env, "clear", agentproto.HistoryClearParams{Terminal: a}, nil); rep.Code != "bad_params" {
			t.Errorf("clear %q: %+v", a, rep)
		}
	}
	for _, g := range []string{"", "prev", "Current", "../current"} {
		if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: "t1", Generation: g}, nil); rep.Code != "bad_params" {
			t.Errorf("generation %q: %+v", g, rep)
		}
	}
}

// The directory is 0700 (also one that existed with wider access), the
// files 0600.
func TestFilesPrivate(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	if err := os.Mkdir(path.Join(env.Base, dirName), 0o755); err != nil {
		t.Fatal(err)
	}
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", painter(10, 10, "a"))
	mustCapture(t, env, params)
	f.set(live("t1", 2))
	f.setText("t1", "b")
	mustCapture(t, env, params)
	st, err := os.Lstat(path.Join(env.Base, dirName))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("directory %v %v", st.Mode(), err)
	}
	for _, name := range []string{"t1.vt", "t1.json", "t1.prev.vt", "t1.prev.json", lockName} {
		if st, err := os.Lstat(historyPath(env, name)); err != nil || st.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v %v", name, st, err)
		}
	}
	// A directory that is a link is refused.
	other := t.TempDir()
	base := t.TempDir()
	if err := os.Symlink(other, path.Join(base, dirName)); err != nil {
		t.Fatal(err)
	}
	if _, err := historyDir(base); err == nil {
		t.Fatal("a linked directory was taken")
	}
}

// Links and other files that a capture did not write are removed, never
// followed; a generation that is not whole is removed.
func TestNotWholeRemoved(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", painter(10, 10, "a"))
	f.setPaint("t2", painter(10, 10, "b"))
	mustCapture(t, env, params)
	secret := path.Join(t.TempDir(), "secret")
	os.WriteFile(secret, []byte("secret"), 0o600)
	dir := path.Join(env.Base, dirName)
	os.Remove(path.Join(dir, "t1.vt"))
	if err := os.Symlink(secret, path.Join(dir, "t1.vt")); err != nil {
		t.Fatal(err)
	}
	// t2's bytes are not what its description says.
	os.WriteFile(path.Join(dir, "t2.vt"), []byte("short"), 0o600)
	// A .vt alone.
	os.WriteFile(path.Join(dir, "t3.prev.vt"), []byte("x"), 0o600)
	if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: "t1", Generation: "current"}, nil); rep.Code != "not_found" {
		t.Fatalf("read through a link: %+v", rep)
	}
	var l agentproto.HistoryListResult
	call(t, env, "list", nil, &l)
	if len(l.Terminals) != 0 {
		t.Fatalf("listed %+v", l.Terminals)
	}
	f.set() // nothing to capture: only the scan
	mustCapture(t, env, params)
	for _, name := range []string{"t1.vt", "t1.json", "t2.vt", "t2.json", "t3.prev.vt"} {
		if _, err := os.Lstat(path.Join(dir, name)); err == nil {
			t.Errorf("%s stayed", name)
		}
	}
	if b, err := os.ReadFile(secret); err != nil || string(b) != "secret" {
		t.Fatal("the link's target changed")
	}
}

// Temporary files older than an hour go, younger ones stay; clear removes
// them all.
func TestTempFiles(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	dir, err := historyDir(env.Base)
	if err != nil {
		t.Fatal(err)
	}
	old, young := path.Join(dir, ".t1.vt.aa.tmp"), path.Join(dir, ".t1.json.bb.tmp")
	os.WriteFile(old, nil, 0o600)
	os.WriteFile(young, nil, 0o600)
	past := time.Now().Add(-2 * time.Hour)
	os.Chtimes(old, past, past)
	f.set()
	mustCapture(t, env, params)
	if _, err := os.Lstat(old); err == nil {
		t.Error("an old temporary file stayed")
	}
	if _, err := os.Lstat(young); err != nil {
		t.Error("a young temporary file went")
	}
	call(t, env, "clear", agentproto.HistoryClearParams{}, nil)
	if _, err := os.Lstat(young); err == nil {
		t.Error("clear left a temporary file")
	}
}

// list, read and clear through the agent's plugin op.
func TestListReadClear(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	var l agentproto.HistoryListResult
	if rep := call(t, env, "list", nil, &l); !rep.OK || l.Terminals == nil || len(l.Terminals) != 0 {
		t.Fatalf("empty list: %+v %+v", rep, l)
	}
	if _, err := os.Lstat(path.Join(env.Base, dirName)); err == nil {
		t.Fatal("list created the directory")
	}
	if rep := call(t, env, "clear", agentproto.HistoryClearParams{}, nil); !rep.OK {
		t.Fatalf("clear without snapshots: %+v", rep)
	}
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", painter(2000, 40, "a")) // above the inline size
	f.setPaint("t2", painter(10, 10, "b"))
	if rep := call(t, env, "capture", params, nil); !rep.OK {
		t.Fatalf("capture: %+v", rep)
	}
	f.set(live("t1", 11), live("t2", 2))
	f.setText("t1", "a2")
	mustCapture(t, env, params)
	if rep := call(t, env, "list", nil, &l); !rep.OK || len(l.Terminals) != 2 {
		t.Fatalf("list: %+v %+v", rep, l)
	}
	e := l.Terminals[0]
	if e.Terminal != "t1" || e.PID != 11 || e.Previous == nil || e.Previous.PID != 1 || e.Previous.Lines != 2000 || e.Cols != 80 || l.Terminals[1].Previous != nil {
		t.Fatalf("entries %+v", l.Terminals)
	}
	var d agentproto.HistoryData
	if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: "t1", Generation: "previous"}, &d); !rep.OK || rep.PluginLength == 0 {
		t.Fatalf("read: %+v", rep)
	}
	if !bytes.Equal(d.Data, body(2000, 40, "a", false)) || d.PID != 1 || d.Bytes != int64(len(d.Data)) || d.Generation != "previous" || d.Terminal != "t1" {
		t.Fatalf("read %d bytes, %+v", len(d.Data), d.HistorySnapshot)
	}
	if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: "t2", Generation: "previous"}, nil); rep.Code != "not_found" {
		t.Fatalf("no previous: %+v", rep)
	}
	var cl agentproto.HistoryClearResult
	if rep := call(t, env, "clear", agentproto.HistoryClearParams{Terminal: "t1"}, &cl); !rep.OK || cl.Removed != 1 {
		t.Fatalf("clear t1: %+v %+v", rep, cl)
	}
	call(t, env, "list", nil, &l)
	if len(l.Terminals) != 1 || l.Terminals[0].Terminal != "t2" {
		t.Fatalf("after clearing t1: %+v", l.Terminals)
	}
	if call(t, env, "clear", agentproto.HistoryClearParams{}, &cl); cl.Removed != 1 {
		t.Fatalf("clear all: %+v", cl)
	}
	call(t, env, "list", nil, &l)
	if len(l.Terminals) != 0 {
		t.Fatalf("after clearing: %+v", l.Terminals)
	}
}

// A second capture of the same directory (another agent of the instance)
// does nothing while one runs; without a terminal core a capture still
// applies the age and fails as not_running.
func TestBusyAndNotRunning(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	dir, _ := historyDir(env.Base)
	lock, err := lockDir(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if res, err := capture(context.Background(), env, params); err != nil || !res.Busy || f.lists != 0 {
		t.Fatalf("busy: %+v %v", res, err)
	}
	lock.Close()
	env.RunDir = t.TempDir()
	if rep := call(t, env, "capture", params, nil); rep.OK || rep.Code != "not_running" || strings.Contains(rep.Error, env.RunDir) {
		t.Fatalf("no terminal core: %+v", rep)
	}
}

// A writer that holds the directory a moment (a list or a read that
// prunes) does not make a capture busy: it waits for it.
func TestCaptureWaitsForPrune(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	lockWait = 2 * time.Second
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", painter(10, 10, "a"))
	dir, _ := historyDir(env.Base)
	lock, err := lockDir(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(100*time.Millisecond, func() { lock.Close() })
	if res := mustCapture(t, env, params); res.Busy || res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
}

// Errors reach the core with a code and a fixed wording: never a path of
// the machine.
func TestErrorsWithoutPaths(t *testing.T) {
	env, _ := testEnv(t)
	fast(t)
	// The data directory's history is a file: nothing can be written.
	if err := os.WriteFile(path.Join(env.Base, dirName), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"capture", "clear"} {
		var p any = params
		if action == "clear" {
			// A clear of a directory that is not one has nothing to clear;
			// one whose lock cannot be taken fails.
			os.Remove(path.Join(env.Base, dirName))
			os.MkdirAll(path.Join(env.Base, dirName, lockName), 0o700)
			p = agentproto.HistoryClearParams{}
		}
		rep := call(t, env, action, p, nil)
		if rep.OK || rep.Code != "io" || strings.Contains(rep.Error, env.Base) || strings.Contains(rep.Error, "/") {
			t.Errorf("%s: %+v", action, rep)
		}
	}
}

// restore_screen as herdr-core reads it from the user's configuration.
func TestRestoreScreen(t *testing.T) {
	for text, want := range map[string]bool{
		"restore_screen = true\n":                  true,
		"restore_screen=true":                      true,
		"  restore_screen = true # mine\r\n":       true,
		"\"restore_screen\" = true\n":              true,
		"\xef\xbb\xbfrestore_screen = true\n":      true,
		"\xef\xbb\xbf# x\nrestore_screen = true\n": true,
		"history_mb = 10\nshell = [\n  \"zsh\",\n  \"-l\",\n]\nrestore_screen = true\n": true,
		"restore_screen = false\n":          false,
		"":                                  false,
		"history_mb = 10\n":                 false,
		"# restore_screen = true\n":         false,
		"[server]\nrestore_screen = true\n": false,
		"restore_screen = yes\n":            false,
		"restore_screen = \"true\"\n":       false,
		"restore_screen = true\nrestore_screen = true\n": false,
		"restore_screen_x = true\n":                      false,
		"\xff\xfe restore_screen = true\n":               false,
		"\x00\x01\x02garbage":                            false,
	} {
		if got := parseRestoreScreen([]byte(text)); got != want {
			t.Errorf("%q: %v", text, got)
		}
	}
	home := t.TempDir()
	write := func(dir, text string) {
		os.MkdirAll(path.Join(dir, "herdr-core"), 0o700)
		os.WriteFile(path.Join(dir, "herdr-core", "config.toml"), []byte(text), 0o600)
	}
	if restoreScreen(home, nil) {
		t.Error("no file")
	}
	write(path.Join(home, ".config"), "restore_screen = true\n")
	if !restoreScreen(home, nil) || !restoreScreen(home, []string{"XDG_CONFIG_HOME=relative"}) {
		t.Error("~/.config")
	}
	xdg := t.TempDir()
	if restoreScreen(home, []string{"XDG_CONFIG_HOME=" + xdg}) {
		t.Error("XDG_CONFIG_HOME without the file")
	}
	write(xdg, "restore_screen = true\n")
	if !restoreScreen(home, []string{"XDG_CONFIG_HOME=" + xdg}) {
		t.Error("XDG_CONFIG_HOME")
	}
	// Too large, or not a regular file: false, without waiting.
	write(xdg, "restore_screen = true\n"+strings.Repeat("#\n", maxConfig))
	if restoreScreen(home, []string{"XDG_CONFIG_HOME=" + xdg}) {
		t.Error("a file over the limit")
	}
	fifo := path.Join(xdg, "herdr-core", "config.toml")
	os.Remove(fifo)
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() { done <- restoreScreen(home, []string{"XDG_CONFIG_HOME=" + xdg}) }()
	select {
	case got := <-done:
		if got {
			t.Error("a FIFO")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reading a FIFO waited")
	}
	// The list reports it.
	env, _ := testEnv(t)
	write(path.Join(env.Home, ".config"), "restore_screen = true\n")
	var l agentproto.HistoryListResult
	if call(t, env, "list", nil, &l); !l.RestoreScreen {
		t.Error("list without restoreScreen")
	}
}

// restored is the terminal core's line below a screen it restored, as
// kept.rs writes it into the new shell's terminal.
const restored = "\x1b[0m\r\n\x1b[2m-- the program above ended; this is a new shell --\x1b[0m\r\n"

// A snapshot of a new shell below a screen the terminal core restored
// itself says so, in the list too; later snapshots of the same program say
// so although their lines no longer reach the core's line; another
// program's do not.
func TestRestored(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 100))
	f.setText("t1", "old")
	f.setPaint("t1", painter(10, 10, "old"))
	mustCapture(t, env, params)
	// The core started again with restore_screen: the new shell's terminal
	// holds the old screen, the core's line, then the shell.
	f.set(live("t1", 200))
	f.setText("t1", "old\nnew shell")
	f.setPaint("t1", painter(10, 10, "old"+restored+"$ "))
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("%+v", res)
	}
	if m := metaOf(t, env, "t1", false); m == nil || !m.Restored || m.PID != 200 {
		t.Fatalf("meta %+v", m)
	}
	if p := metaOf(t, env, "t1", true); p == nil || p.Restored {
		t.Fatalf("previous %+v", p)
	}
	var l agentproto.HistoryListResult
	if call(t, env, "list", nil, &l); len(l.Terminals) != 1 || !l.Terminals[0].Restored {
		t.Fatalf("list %+v", l.Terminals)
	}
	// The core's line scrolled out of the lines kept: still restored.
	f.setText("t1", "much later")
	f.setPaint("t1", painter(10, 10, "much later"))
	mustCapture(t, env, params)
	if m := metaOf(t, env, "t1", false); !m.Restored {
		t.Fatal("restored lost with the same program")
	}
	// Another program: not restored.
	f.set(live("t1", 300))
	f.setText("t1", "third")
	f.setPaint("t1", painter(10, 10, "third"))
	mustCapture(t, env, params)
	if m := metaOf(t, env, "t1", false); m.Restored || m.PID != 300 {
		t.Fatalf("meta %+v", m)
	}
	var l2 agentproto.HistoryListResult
	if call(t, env, "list", nil, &l2); l2.Terminals[0].Restored {
		t.Fatal("listed restored")
	}
}

// The core's line is found in the paint's text, also when styles or a
// wrapped row split it; not when it is not there whole.
func TestRestoredByCore(t *testing.T) {
	for in, want := range map[string]bool{
		restored: true,
		"\x1b[2m-- the program above \x1b[1;38;2;1;2;3mended; this was a new\r\n shell --": false,
		"\x1b[2m-- the program above \x1b[1;38;2;1;2;3mended; this is a ne\r\nw shell --":  true,
		"the program above ended;\x1b]8;;http://x\x1b\\ this is a new shell":               true,
		"the program above ended; this is a new":                                           false,
		"\x1b[?1049h\x1b(Bthe program above ended; this is a new shell\x1b":                true,
		"":     false,
		"\x1b": false,
	} {
		if got := restoredByCore([]byte(in)); got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
	if got := string(paintText([]byte("a\x1b[31mb\x1b]2;t\x07c\x1b(Bd\x1bPq\x1b\\e\r\nf\x7f"))); got != "abcdef" {
		t.Errorf("text %q", got)
	}
}

// Terminals are taken least recently captured first, which survives the
// agent (the snapshots' times), and a terminal that failed comes after
// the others; terminals the capture's time did not reach fail as timeout.
func TestOrderAndTimeBudget(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	ticking(t, time.Now())
	f.set(live("t1", 1), live("t2", 2), live("t3", 3))
	for _, a := range []string{"t1", "t2", "t3"} {
		f.setText(a, a)
		f.setPaint(a, painter(10, 10, a))
	}
	mustCapture(t, env, params)
	// t1 captured again later; then all three change.
	f.setText("t1", "t1 b")
	mustCapture(t, env, params)
	for _, a := range []string{"t1", "t2", "t3"} {
		f.setText(a, a+" c")
	}
	forgetTerminal("") // a new agent: only the files tell
	n := len(f.attached())
	mustCapture(t, env, params)
	var order []string
	for _, a := range f.attached()[n:] {
		order = append(order, a.Terminal)
	}
	if fmt.Sprint(order) != "[t2 t3 t1]" {
		t.Fatalf("order %v", order)
	}

	// t1 is slow (its paint never comes) and its time runs out: the
	// terminals after it fail as timeout, without being read.
	env, f = testEnv(t)
	f.set(live("t1", 1), live("t2", 2), live("t3", 3))
	for _, a := range []string{"t1", "t2", "t3"} {
		f.setText(a, a)
		f.setPaint(a, painter(10, 10, a))
	}
	f.setPaint("t1", func(int) []byte { return nil })
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	res, err := capture(ctx, env, params)
	cancel()
	if err != nil || res.Failed != 3 || res.Errors["t1"] != "timeout" || res.Errors["t2"] != "timeout" || res.Errors["t3"] != "timeout" {
		t.Fatalf("%+v %v", res, err)
	}
	for _, a := range f.attached() {
		if a.Terminal != "t1" {
			t.Fatalf("%s read after the time ran out", a.Terminal)
		}
	}
	// Next time t1, which failed, comes last: the others are captured.
	ctx, cancel = context.WithTimeout(context.Background(), 250*time.Millisecond)
	res, _ = capture(ctx, env, params)
	cancel()
	if res.Captured != 2 || res.Errors["t1"] != "timeout" {
		t.Fatalf("%+v", res)
	}
}

// Twenty quiet terminals that did not change are not attached to; twenty
// that changed take no wait beyond their frames (the stream ends at the
// paint's end).
func TestCapturePerformance(t *testing.T) {
	env, f := testEnv(t)
	var terms []hc.Terminal
	for i := range 20 {
		a := fmt.Sprintf("t%d", i)
		terms = append(terms, live(a, 100+i))
		f.setText(a, a)
		f.setPaint(a, painter(200, 60, a))
	}
	f.set(terms...)
	start := time.Now()
	if res := mustCapture(t, env, params); res.Captured != 20 {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("20 changed terminals took %v", d)
	}
	n := len(f.attached())
	if res := mustCapture(t, env, params); res.Skipped != 20 || len(f.attached()) != n {
		t.Fatalf("unchanged: %+v, %d attaches", res, len(f.attached())-n)
	}
	for i := range 20 {
		f.setText(fmt.Sprintf("t%d", i), "changed")
	}
	start = time.Now()
	if res := mustCapture(t, env, params); res.Captured != 20 {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("20 changed terminals took %v", d)
	}
}

// A terminal too large with the fewest lines is not read again until its
// screen changes.
func TestTooLargeRemembered(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1))
	f.setText("t1", "a")
	f.setPaint("t1", func(int) []byte { return painter(1000, 3000, "a")(1000) })
	if res := mustCapture(t, env, params); res.Errors["t1"] != "too_large" {
		t.Fatalf("%+v", res)
	}
	n := len(f.attached())
	if res := mustCapture(t, env, params); res.Errors["t1"] != "too_large" || len(f.attached()) != n {
		t.Fatalf("again: %+v", res)
	}
	f.setText("t1", "b")
	f.setPaint("t1", painter(10, 10, "b"))
	if res := mustCapture(t, env, params); res.Captured != 1 {
		t.Fatalf("changed: %+v", res)
	}
}

// Without a capture, a snapshot past its days is neither listed nor read,
// and list removes it.
func TestListAndReadPruneAge(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	start := time.Now()
	now := ticking(t, start)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setText("t2", "b")
	f.setPaint("t1", painter(10, 10, "a"))
	f.setPaint("t2", painter(10, 10, "b"))
	p := params
	p.Days = 1
	mustCapture(t, env, p)
	*now = start.Add(2 * 24 * time.Hour)
	if rep := call(t, env, "read", agentproto.HistoryReadParams{Terminal: "t1", Generation: "current"}, nil); rep.Code != "not_found" {
		t.Fatalf("read: %+v", rep)
	}
	var l agentproto.HistoryListResult
	if call(t, env, "list", nil, &l); len(l.Terminals) != 0 {
		t.Fatalf("listed %+v", l.Terminals)
	}
	for _, name := range []string{"t1.vt", "t1.json", "t2.vt", "t2.json"} {
		if _, err := os.Lstat(historyPath(env, name)); err == nil {
			t.Errorf("%s stayed", name)
		}
	}
	// While a writer holds the directory, an expired snapshot is not
	// listed either.
	*now = start
	f.setText("t1", "a2")
	mustCapture(t, env, p)
	dir, _ := historyDir(env.Base)
	lock, err := lockDir(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	*now = start.Add(2 * 24 * time.Hour)
	if call(t, env, "list", nil, &l); len(l.Terminals) != 0 {
		t.Fatalf("listed while locked %+v", l.Terminals)
	}
	if _, err := os.Lstat(historyPath(env, "t1.vt")); err != nil {
		t.Fatal("removed without the lock")
	}
}

// adoptOf runs an adopt as the agent does.
func adoptOf(t *testing.T, env *plugin.Env, from, to string) (agentproto.HistoryAdoptResult, agentproto.Reply) {
	t.Helper()
	var res agentproto.HistoryAdoptResult
	rep := call(t, env, agentproto.HistoryAdopt, agentproto.HistoryAdoptParams{From: from, To: to}, &res)
	return res, rep
}

// files are the names of the history directory's generations.
func files(t *testing.T, env *plugin.Env) []string {
	t.Helper()
	var out []string
	for _, e := range entries(path.Join(env.Base, dirName)) {
		if n := e.Name(); !strings.HasPrefix(n, ".") {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out
}

// A terminal that took another's place gets the newest generation of the
// other's snapshots as its previous one, with its bytes, its time and the
// days it was written under, as a private file; the other's snapshots go,
// and what the snapshots take does not grow. A previous generation of its
// own captured later stays (the other's go all the same), one captured
// before is replaced; a terminal with only a previous generation gives
// that one.
func TestAdopt(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	ticking(t, time.Now())
	f.set(live("t1", 100))
	f.setText("t1", "old program")
	f.setPaint("t1", painter(50, 10, "old program"))
	mustCapture(t, env, params)
	f.set(live("t1", 200))
	f.setText("t1", "new shell")
	f.setPaint("t1", painter(50, 10, "new shell"))
	mustCapture(t, env, params)
	newest := metaOf(t, env, "t1", false)
	data := slurp(t, historyPath(env, "t1.vt"))
	// The terminal core started again with new addresses: t2 is t1's pane.
	f.set(live("t2", 300))
	f.setText("t2", "t2's shell")
	f.setPaint("t2", painter(5, 10, "t2's shell"))
	before := mustCapture(t, env, params)
	cur2 := metaOf(t, env, "t2", false)

	res, rep := adoptOf(t, env, "t1", "t2")
	if !rep.OK || !res.Adopted {
		t.Fatalf("adopt %+v %+v", rep, res)
	}
	p := metaOf(t, env, "t2", true)
	if p == nil || p.Terminal != "t2" || p.PID != 200 || p.At != newest.At || p.Days != newest.Days || p.Hash != newest.Hash {
		t.Fatalf("previous %+v, want of %+v", p, newest)
	}
	if !bytes.Equal(slurp(t, historyPath(env, "t2.prev.vt")), data) || *metaOf(t, env, "t2", false) != *cur2 {
		t.Fatal("the bytes moved, or t2's current changed")
	}
	if got := strings.Join(files(t, env), " "); got != "t2.json t2.prev.json t2.prev.vt t2.vt" {
		t.Fatalf("files %s", got)
	}
	for _, n := range []string{"t2.prev.json", "t2.prev.vt"} {
		if st, err := os.Stat(historyPath(env, n)); err != nil || st.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v %v", n, st.Mode(), err)
		}
	}
	var l agentproto.HistoryListResult
	call(t, env, agentproto.HistoryList, nil, &l)
	if len(l.Terminals) != 1 || l.Terminals[0].Terminal != "t2" || l.Terminals[0].Previous == nil || l.Terminals[0].Previous.PID != 200 {
		t.Fatalf("list %+v", l)
	}
	s, _, err := openStore(context.Background(), env.Base, true, clock())
	if err != nil {
		t.Fatal(err)
	}
	after := s.total()
	s.close()
	if after > before.Bytes {
		t.Errorf("the snapshots grew: %d, before %d", after, before.Bytes)
	}

	// t3 takes t2's place, with a previous generation of its own captured
	// later than t2's newest: it stays; t2's snapshots go all the same.
	f.set(live("t3", 400))
	f.setText("t3", "t3 old")
	f.setPaint("t3", painter(5, 10, "t3 old"))
	mustCapture(t, env, params)
	f.set(live("t3", 401))
	f.setText("t3", "t3 new")
	mustCapture(t, env, params)
	own := *metaOf(t, env, "t3", true)
	if res, rep := adoptOf(t, env, "t2", "t3"); !rep.OK || res.Adopted {
		t.Fatalf("a later previous: %+v %+v", rep, res)
	}
	if *metaOf(t, env, "t3", true) != own || metaOf(t, env, "t2", false) != nil || metaOf(t, env, "t2", true) != nil {
		t.Fatal("t3's own previous changed, or t2's snapshots stayed")
	}
	// One captured before the adopted one is replaced; a terminal with only
	// a previous generation gives that one.
	f.set(live("t3", 401), live("t4", 500))
	f.setText("t4", "t4")
	f.setPaint("t4", painter(5, 10, "t4"))
	mustCapture(t, env, params)
	f.set(live("t3", 401), live("t4", 501))
	f.setText("t4", "t4 again")
	f.setPaint("t4", func(int) []byte { return nil })
	mustCapture(t, env, params) // t4's current became its previous; no new one
	t4 := *metaOf(t, env, "t4", true)
	if metaOf(t, env, "t4", false) != nil || t4.At <= own.At {
		t.Fatalf("t4 %+v", t4)
	}
	if res, rep := adoptOf(t, env, "t4", "t3"); !rep.OK || !res.Adopted {
		t.Fatalf("an older previous: %+v %+v", rep, res)
	}
	if p := metaOf(t, env, "t3", true); p == nil || p.PID != t4.PID || p.At != t4.At || metaOf(t, env, "t4", true) != nil {
		t.Fatalf("t3's previous %+v", p)
	}
}

// An adopt names two valid, different addresses, the one that took the
// place a terminal of the terminal core's records; one without snapshots
// gives nothing, and a terminal core not running none either.
func TestAdoptRefused(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	f.set(live("t1", 1), live("t2", 2))
	f.setText("t1", "a")
	f.setPaint("t1", painter(5, 10, "a"))
	mustCapture(t, env, params)
	for _, c := range [][2]string{{"", "t2"}, {"t1", ""}, {"../t1", "t2"}, {"t1", "t2.prev"}, {"t1", "t1"}, {"t1", strings.Repeat("a", 65)}, {".lock", "t2"}} {
		if _, rep := adoptOf(t, env, c[0], c[1]); rep.OK || rep.Code != "bad_params" {
			t.Errorf("%q: %+v", c, rep)
		}
	}
	// Not of the records: refused, nothing changes.
	if _, rep := adoptOf(t, env, "t1", "t9"); rep.OK || rep.Code != "not_found" {
		t.Errorf("unknown to: %+v", rep)
	}
	if metaOf(t, env, "t1", false) == nil {
		t.Fatal("t1 lost its snapshot to a refused adopt")
	}
	// Nothing to adopt.
	if res, rep := adoptOf(t, env, "t5", "t2"); !rep.OK || res.Adopted || metaOf(t, env, "t2", true) != nil {
		t.Errorf("without snapshots: %+v %+v", rep, res)
	}
	// A machine without the directory creates none.
	empty, f2 := testEnv(t)
	f2.set(live("t2", 2))
	if res, rep := adoptOf(t, empty, "t1", "t2"); !rep.OK || res.Adopted {
		t.Errorf("no directory: %+v %+v", rep, res)
	}
	if _, err := os.Lstat(path.Join(empty.Base, dirName)); err == nil {
		t.Error("an adopt created the directory")
	}
	// No terminal core to tell the records.
	f.ln.Close()
	if _, rep := adoptOf(t, env, "t1", "t2"); rep.OK || rep.Code != "not_running" {
		t.Errorf("no terminal core: %+v", rep)
	}
}

// The snapshots of a terminal gone from the terminal core's records stay
// until a capture has seen it gone for goneGrace (an agent that starts
// again counts anew), so that a page can adopt them meanwhile; a record
// that comes back ends the count.
func TestVanishedGrace(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	start := time.Now()
	now := ticking(t, start)
	f.set(live("t1", 1), live("t2", 2))
	for _, a := range []string{"t1", "t2"} {
		f.setText(a, a)
		f.setPaint(a, painter(5, 10, a))
	}
	mustCapture(t, env, params)
	gone := func() {
		t.Helper()
		f.set(live("t2", 2))
	}
	kept := func(what string, want bool) {
		t.Helper()
		mustCapture(t, env, params)
		if got := metaOf(t, env, "t1", false) != nil; got != want {
			t.Fatalf("%s: kept %v", what, got)
		}
	}
	gone()
	kept("first seen gone", true)
	*now = now.Add(goneGrace - 10*time.Second)
	kept("within the grace", true)
	// Back in the records: the count starts again when it is gone again.
	f.set(live("t1", 1), live("t2", 2))
	kept("back", true)
	gone()
	kept("gone again", true)
	*now = now.Add(goneGrace - 10*time.Second)
	kept("within the new grace", true)
	// The agent started again: what it remembered is lost, the grace too.
	forgetTerminal("")
	kept("after a restart", true)
	*now = now.Add(goneGrace - 10*time.Second)
	kept("within the grace after the restart", true)
	*now = now.Add(20 * time.Second)
	kept("after the grace", false)

	// Adopted within the grace by the terminal that took its place.
	f.set(live("t3", 3))
	f.setText("t3", "t3")
	f.setPaint("t3", painter(5, 10, "t3"))
	mustCapture(t, env, params)
	if metaOf(t, env, "t2", false) == nil {
		t.Fatal("t2 went at once")
	}
	if res, rep := adoptOf(t, env, "t2", "t3"); !rep.OK || !res.Adopted || metaOf(t, env, "t3", true) == nil || metaOf(t, env, "t2", false) != nil {
		t.Fatalf("adopt in the grace: %+v %+v", rep, res)
	}
	// What was remembered of t2 went with its snapshots.
	if _, ok := vanished.get("t2"); ok {
		t.Error("t2 still remembered as gone")
	}
}
