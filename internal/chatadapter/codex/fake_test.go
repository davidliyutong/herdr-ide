package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The test binary is also a fake app-server: with fakeEnv set it plays a
// recorded conversation (spec/vectors/chat/codex) to whatever client
// talks to it on its standard input and output. The client's requests are
// matched to the recording's by method (and their parameters, where
// several have the method); what the recording's app-server sent after a
// request is sent again, its answers renumbered to the client's ids. A
// request of the app-server in the recording waits for the client's answer
// before the rest is sent.
//
// The environment:
//
//	fakeEnv       "1"
//	FAKE_DIR      where the fake records: started-N (one per process),
//	              recv-N.jsonl (every line the client sent), events-N.txt
//	              (eof, term, timeout)
//	FAKE_SCRIPTS  the recordings, one per process started (the last one
//	              for those after), separated by the path list separator
//	FAKE_FALLBACK recordings whose answers serve the requests the
//	              process's own does not have (not used up)
//	FAKE_MODE     ignore-eof: keep running when the input ends;
//	              ignore-term: keep running after SIGTERM
//	FAKE_CHILD    a file: the fake starts a process of its group that
//	              ignores SIGTERM (childEnv) and then writes its pid there
//
// A recording's line {"dir": "in", "exit": N} ends the fake with status
// N; {"dir": "in", "sleep": N} waits N milliseconds; {"dir": "in", "raw": "..."} sends a line as it is; {"dir": "in",
// "big": N} sends a line of N bytes.
const fakeEnv = "CODEX_ADAPTER_TEST_FAKE"

// childEnv makes the test binary a command an app-server left running: it
// ignores SIGTERM, then writes its pid to the file childEnv names, and
// sleeps.
const childEnv = "CODEX_ADAPTER_TEST_CHILD"

func TestMain(m *testing.M) {
	if file := os.Getenv(childEnv); file != "" {
		signal.Ignore(syscall.SIGTERM)
		os.WriteFile(file, []byte(strconv.Itoa(os.Getpid())), 0o600)
		time.Sleep(time.Hour)
		exitNow(0)
	}
	if os.Getenv(fakeEnv) != "" {
		exitNow(fakeMain())
	}
	os.Exit(m.Run())
}

// startChild starts a process of the fake's group that ignores SIGTERM;
// it writes its pid to file once it does.
func startChild(file string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "-test.run=^$")
	cmd.Env = append(os.Environ(), childEnv+"="+file)
	return cmd.Start()
}

type scriptLine struct {
	Dir   string          `json:"dir"`
	Sleep int             `json:"sleep"`
	Msg   json.RawMessage `json:"msg"`
	Raw   *string         `json:"raw"`
	Big   int             `json:"big"`
	Exit  *int            `json:"exit"`
}

type wire struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// step is what a segment does: send a line, or wait for the answer to a
// request it sent.
type step struct {
	send  *scriptLine
	await string // the id of the request answered
}

// segment is a request of the recording's client and what followed it.
type segment struct {
	method string
	id     string
	params map[string]json.RawMessage
	steps  []step
	used   bool
}

func loadScript(path string) (head []step, segs []*segment, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var cur *segment
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) == 0 {
			continue
		}
		var sl scriptLine
		if err := json.Unmarshal(l, &sl); err != nil {
			return nil, nil, fmt.Errorf("%s: %v", path, err)
		}
		add := func(st step) {
			if cur == nil {
				head = append(head, st)
			} else {
				cur.steps = append(cur.steps, st)
			}
		}
		if sl.Dir != "out" {
			add(step{send: &sl})
			continue
		}
		var w wire
		if len(sl.Msg) == 0 || json.Unmarshal(sl.Msg, &w) != nil {
			continue
		}
		hasID := len(w.ID) > 0 && string(w.ID) != "null"
		switch {
		case w.Method != "" && hasID:
			cur = &segment{method: w.Method, id: string(w.ID)}
			json.Unmarshal(w.Params, &cur.params)
			segs = append(segs, cur)
		case hasID:
			add(step{await: string(w.ID)})
		}
	}
	return head, segs, nil
}

type fake struct {
	out    *bufio.Writer
	omu    sync.Mutex
	recv   *os.File
	events *os.File
	segs   []*segment
	fall   []*segment
	ids    map[string]json.RawMessage // the recording's request ids → the client's
	in     chan wire
	later  []wire
}

// exitNow ends the fake at once. A race-enabled test binary that exits
// through os.Exit first sleeps for GORACE's atexit_sleep_ms, a second by
// default: as long as the tests' closeWait, so that a fake that exits at
// the end of its input would also get the SIGTERM that follows it ("the
// probe saw [eof term]").
func exitNow(code int) { syscall.Exit(code) }

// event records what happened to the fake. Its files are written, not
// synced (the tests read them through the same page cache): a sync on
// macOS waits for the disk, between "eof" and the fake's exit.
func (f *fake) event(s string) {
	fmt.Fprintln(f.events, s)
}

func (f *fake) write(b []byte) {
	f.omu.Lock()
	defer f.omu.Unlock()
	f.out.Write(b)
	f.out.WriteByte('\n')
	f.out.Flush()
}

func fakeMain() int {
	dir := os.Getenv("FAKE_DIR")
	n := 1
	for ; ; n++ {
		fl, err := os.OpenFile(filepath.Join(dir, "started-"+strconv.Itoa(n)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			fl.Close()
			break
		}
	}
	scripts := filepath.SplitList(os.Getenv("FAKE_SCRIPTS"))
	script := scripts[min(n, len(scripts))-1]
	recv, _ := os.Create(filepath.Join(dir, fmt.Sprintf("recv-%d.jsonl", n)))
	events, _ := os.Create(filepath.Join(dir, fmt.Sprintf("events-%d.txt", n)))
	f := &fake{out: bufio.NewWriter(os.Stdout), recv: recv, events: events, ids: map[string]json.RawMessage{}, in: make(chan wire, 64)}
	mode := os.Getenv("FAKE_MODE")
	head, segs, err := loadScript(script)
	if err != nil {
		f.event("error " + err.Error())
		return 2
	}
	f.segs = segs
	if file := os.Getenv("FAKE_CHILD"); file != "" {
		if err := startChild(file); err != nil {
			f.event("error " + err.Error())
			return 2
		}
	}
	for _, fb := range filepath.SplitList(os.Getenv("FAKE_FALLBACK")) {
		_, segs, _ := loadScript(fb)
		f.fall = append(f.fall, segs...)
	}
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGTERM)
	go func() {
		for range sig {
			f.event("term")
			if !strings.Contains(mode, "ignore-term") {
				exitNow(143)
			}
		}
	}()
	go func() {
		br := bufio.NewReaderSize(os.Stdin, 1<<20)
		for {
			line, err := br.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				f.recv.Write(bytes.TrimRight(line, "\n"))
				f.recv.Write([]byte("\n"))
				var w wire
				if json.Unmarshal(line, &w) == nil {
					f.in <- w
				}
			}
			if err != nil {
				f.event("eof")
				if !strings.Contains(mode, "ignore-eof") {
					exitNow(0)
				}
				select {}
			}
		}
	}()
	if code, done := f.play(head, nil); done {
		return code
	}
	for {
		var w wire
		if len(f.later) > 0 {
			w, f.later = f.later[0], f.later[1:]
		} else {
			w = <-f.in
		}
		if w.Method == "" || len(w.ID) == 0 {
			continue
		}
		seg := f.match(w)
		if seg == nil {
			f.write(mustJSON(map[string]any{"id": w.ID, "error": map[string]any{"code": -32600, "message": "fake: no recording of " + w.Method}}))
			continue
		}
		f.ids[seg.id] = w.ID
		if code, done := f.play(seg.steps, seg); done {
			return code
		}
	}
}

// match is the recording's request for w: the first unused one of its
// method whose parameters have most in common with w's, else the
// fallback's.
func (f *fake) match(w wire) *segment {
	var params map[string]json.RawMessage
	json.Unmarshal(w.Params, &params)
	pick := func(segs []*segment, use bool) *segment {
		var best *segment
		score := -1
		for _, s := range segs {
			if s.method != w.Method || (use && s.used) {
				continue
			}
			n := 0
			for k, v := range s.params {
				if bytes.Equal(v, params[k]) {
					n++
				}
			}
			if n > score {
				best, score = s, n
			}
		}
		if best != nil && use {
			best.used = true
		}
		return best
	}
	if s := pick(f.segs, true); s != nil {
		return s
	}
	return pick(f.fall, false)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// play sends a segment's lines: done when the fake ends.
func (f *fake) play(steps []step, seg *segment) (int, bool) {
	for _, st := range steps {
		if st.await != "" {
			if !f.await(st.await) {
				f.event("timeout " + st.await)
				return 1, true
			}
			continue
		}
		l := st.send
		switch {
		case l.Exit != nil:
			f.event("exit")
			return *l.Exit, true
		case l.Sleep > 0:
			time.Sleep(time.Duration(l.Sleep) * time.Millisecond)
		case l.Raw != nil:
			f.write([]byte(*l.Raw))
		case l.Big > 0:
			f.write(bytes.Repeat([]byte("x"), l.Big))
		case len(l.Msg) > 0:
			var w wire
			json.Unmarshal(l.Msg, &w)
			if w.Method == "" && len(w.ID) > 0 {
				// An answer: to the client's id of its request.
				id, ok := f.ids[string(w.ID)]
				if !ok {
					continue
				}
				var m map[string]json.RawMessage
				json.Unmarshal(l.Msg, &m)
				m["id"] = id
				f.write(mustJSON(m))
				continue
			}
			f.write(l.Msg)
		}
	}
	return 0, false
}

// await waits for the client's answer to the request id; the client's
// requests meanwhile wait for their turn.
func (f *fake) await(id string) bool {
	t := time.NewTimer(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case w := <-f.in:
			if w.Method == "" && string(w.ID) == id {
				return true
			}
			if w.Method != "" && len(w.ID) > 0 {
				f.later = append(f.later, w)
			}
		case <-t.C:
			return false
		}
	}
}
