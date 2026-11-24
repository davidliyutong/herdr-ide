package server

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/hostdirs"
	"herdr-ide/internal/machines"
)

// hiddenTermCore is a terminal core on machine x's socket that calls itself
// c0ffee or box, has the terminals snap, answers terminal.list with list,
// terminal.get with recs (by address or name; not_found for others) and
// terminal.attach with the record of attached (else recs), and records
// every call it gets, as "method params", and the channels the server
// closed.
type hiddenTermCore struct {
	mu       sync.Mutex
	snap     string
	list     string
	recs     map[string]string
	attached map[string]string
	reqs     []string
	closed   []uint32
	subs     []func(line string)
}

// listenHiddenCore starts a hiddenTermCore on the socket of the server's
// machine x.
func listenHiddenCore(t *testing.T, snap, list string, recs map[string]string) *hiddenTermCore {
	t.Helper()
	socket := filepath.Join(hostdirs.RunDir(filepath.Join(os.Getenv("HOME"), brand.DataDir(""))), "hc.sock")
	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	f := &hiddenTermCore{snap: snap, list: list, recs: recs, attached: map[string]string{}}
	var mu sync.Mutex
	var conns []net.Conn
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}

// event sends an event about a terminal to every subscriber.
func (f *hiddenTermCore) event(typ, terminal, data string) {
	f.notify(`{"jsonrpc":"2.0","method":"event","params":{"seq":9,"type":"` + typ + `","terminal":"` + terminal + `","data":` + data + `}}`)
}

func (f *hiddenTermCore) notify(line string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, send := range f.subs {
		send(line)
	}
}

// set makes rec the record of terminal.get for each of keys.
func (f *hiddenTermCore) set(rec string, keys ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, k := range keys {
		f.recs[k] = rec
	}
}

// got reports whether the core got a call that has want in its line.
func (f *hiddenTermCore) got(want string) bool { return f.gotSince(0, want) }

// mark is the number of calls the core got so far, for gotSince.
func (f *hiddenTermCore) mark() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

// gotSince reports whether a call the core got after the first n has want
// in its line.
func (f *hiddenTermCore) gotSince(n int, want string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.reqs[n:] {
		if strings.Contains(r, want) {
			return true
		}
	}
	return false
}

func (f *hiddenTermCore) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reqs...)
}

// waitClosed waits until the server closed n streams.
func (f *hiddenTermCore) waitClosed(t *testing.T, n int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		f.mu.Lock()
		got := len(f.closed)
		f.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d streams closed, want %d", got, n)
		}
	}
}

func (f *hiddenTermCore) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	if _, err := br.ReadString('\n'); err != nil {
		return
	}
	io.WriteString(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"9.9.9","framed":true,"core":{"id":"c0ffee","name":"box"}}}`+"\n")
	var wmu sync.Mutex
	write := func(b []byte) {
		wmu.Lock()
		c.Write(b)
		wmu.Unlock()
	}
	next := uint32(1)
	for {
		var h [9]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			return
		}
		payload := make([]byte, binary.LittleEndian.Uint32(h[5:]))
		if _, err := io.ReadFull(br, payload); err != nil {
			return
		}
		if ch := binary.LittleEndian.Uint32(h[:4]); ch != 0 {
			if h[4] == 2 { // the server closed the stream
				f.mu.Lock()
				f.closed = append(f.closed, ch)
				f.mu.Unlock()
			}
			continue // a stream's input or credit
		}
		var req struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		json.Unmarshal(payload, &req)
		id, _ := json.Marshal(req.ID)
		reply := func(body string) []byte {
			return frameOf(0, 0, []byte(`{"jsonrpc":"2.0","id":`+string(id)+`,`+body+`}`))
		}
		var p struct {
			Terminal string `json:"terminal"`
		}
		json.Unmarshal(req.Params, &p)
		f.mu.Lock()
		if req.Method != "events.subscribe" {
			f.reqs = append(f.reqs, req.Method+" "+string(req.Params))
		}
		rec, known := f.recs[p.Terminal]
		if a, ok := f.attached[p.Terminal]; ok && req.Method == "terminal.attach" {
			rec, known = a, true
		}
		f.mu.Unlock()
		notFound := `"error":{"code":-32000,"message":"no terminal ` + strconv.Quote(p.Terminal) + `","data":{"kind":"not_found"}}`
		switch req.Method {
		case "events.subscribe":
			next++
			ch := next
			f.mu.Lock()
			f.subs = append(f.subs, func(line string) { write(frameOf(ch, 0, []byte(line+"\n"))) })
			snap := f.snap
			f.mu.Unlock()
			chJSON, _ := json.Marshal(ch)
			write(reply(`"result":{"channel":` + string(chJSON) + `,"seq":1,"terminals":` + snap + `}`))
		case "terminal.list":
			f.mu.Lock()
			list := f.list
			f.mu.Unlock()
			write(reply(`"result":` + list))
		case "terminal.attach":
			if !known {
				write(reply(notFound))
				break
			}
			next++
			chJSON, _ := json.Marshal(next)
			write(append(reply(`"result":{"channel":`+string(chJSON)+`,"automatic_input":true,"terminal":`+rec+`}`),
				frameOf(next, 0, []byte("paint"))...))
		case "terminal.get":
			if !known {
				write(reply(notFound))
				break
			}
			write(reply(`"result":` + rec))
		default:
			write(reply(`"result":{"method":"` + req.Method + `"}`))
		}
	}
}

// rec is a terminal's record: live, of name ("" for none), with labels
// (JSON).
func rec(addr, name, labels string) string {
	n := ""
	if name != "" {
		n = `"name":"` + name + `",`
	}
	return `{"address":"` + addr + `",` + n + `"state":"live","pid":42,"cols":80,"rows":24,"argv":[],"cwd":"/","created_ms":1,"labels":` + labels + `,"screen":"exact"}`
}

func plainRec(addr string) string { return rec(addr, "", `{"name":"mine"}`) }

// hiddenRec is the record of a chat host: its name and the hidden label.
func hiddenRec(addr string) string {
	return rec(addr, agentproto.ChatHostName, `{"`+agentproto.HiddenLabel+`":"`+agentproto.HiddenChatHost+`"}`)
}

// addresses are the addresses of a list of terminal records.
func addresses(list any) string {
	var out []string
	for _, rec := range list.([]any) {
		out = append(out, rec.(map[string]any)["address"].(string))
	}
	return strings.Join(out, " ")
}

// nextEvent is the next event the client gets, which must be typ of
// terminal: one that was not to reach it would come before.
func nextEvent(t *testing.T, c *termConn, typ, terminal string) map[string]any {
	t.Helper()
	ev := c.until("event")
	if ev["type"] != typ || ev["terminal"] != terminal {
		t.Fatalf("event %v, want %s of %s", ev, typ, terminal)
	}
	return ev
}

// call sends a call and returns its reply.
func (c *termConn) call(rid int, method string, params map[string]any) map[string]any {
	c.t.Helper()
	c.send(map[string]any{"t": "call", "rid": rid, "m": "x", "method": method, "params": params})
	m := c.until("res")
	if m["rid"] != float64(rid) {
		c.t.Fatalf("reply to %d: %v", rid, m)
	}
	return m
}

// errKind is the kind of a reply's error, "" for none.
func errKind(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	k, _ := e["kind"].(string)
	return k
}

// The chat host's terminal (agentproto.ChatHostName with the hidden label
// agentproto.HiddenChatHost) is none of the clients': it is in no
// snapshot, event, agent state, list or shell that is typed into, and a
// call or an attach that names it, by its address or its name, is answered
// as for a terminal that does not exist, without reaching the terminal
// core. A client can neither set the hidden label nor take the chat host's
// name. A terminal that carries the label without the name (a program of
// the machine set it), or the name without the label, is the clients' as
// any other; one that gets the label while it has the name leaves them,
// with the streams they had of it.
func TestTermHiddenTerminals(t *testing.T) {
	s, _, audit := termServer(t, Options{}, false)
	host := agentproto.ChatHostName
	labeled := rec("t6", "helper", `{"`+agentproto.HiddenLabel+`":"`+agentproto.HiddenChatHost+`"}`)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+hiddenRec("t5")+`,`+labeled+`]`,
		`{"terminals":[`+plainRec("t1")+`,`+hiddenRec("t5")+`,`+labeled+`],"hidden_finished":2}`,
		map[string]string{"t1": plainRec("t1"), "t5": hiddenRec("t5"), host: hiddenRec("t5"), "t6": labeled, "helper": labeled})
	var mu sync.Mutex
	var ws []string
	s.mg.Subscribe(func(machines.State) {}, func(ev machines.AgentEvent) {
		mu.Lock()
		ws = append(ws, string(ev.Data))
		mu.Unlock()
	})
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1 t6" && got != "t6 t1" {
		t.Fatalf("snapshot has %q, want t1 and t6", got)
	}

	// Events: what happens to the hidden terminal is not passed on; a
	// terminal that gets the label without the name stays the clients'.
	core.event("title", "t5", `{"title":"the chat host"}`)
	core.event("created", "t2", plainRec("t2"))
	nextEvent(t, c, "created", "t2")
	core.event("labels", "t2", `{"labels":{"name":"mine","`+agentproto.HiddenLabel+`":"`+agentproto.HiddenChatHost+`"}}`)
	nextEvent(t, c, "labels", "t2")
	core.event("finished", "t5", `{"reason":"exited","exit_code":0,"signal":null,"finished_ms":1}`)
	core.event("removed", "t5", `{}`)
	core.event("title", "t1", `{"title":"shown"}`)
	nextEvent(t, c, "title", "t1")

	// A terminal that takes the name, without the label, is the clients':
	// one attaches to it by its address after the core's name. When it
	// gets the label it leaves them, and the stream ends.
	core.event("created", "t7", rec("t7", host, `{}`))
	nextEvent(t, c, "created", "t7")
	core.set(rec("t7", host, `{}`), "t7")
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": "box/t7", "cols": 80, "rows": 24})
	sid := c.until("attached")["s"]
	// Another client watches it and stops following the machine: its
	// stream stays, until the terminal is hidden too.
	u := dialTerm(t, s)
	u.send(map[string]any{"t": "sub", "m": "x"})
	u.until("snapshot")
	u.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": "t7", "cols": 80, "rows": 24, "observe": true})
	usid := u.until("attached")["s"]
	u.send(map[string]any{"t": "unsub", "m": "x"})
	if m := u.call(2, "terminal.get", map[string]any{"terminal": "t1"}); errKind(m) != "unavailable" {
		t.Fatalf("a call after unsub: %v", m)
	}
	core.event("labels", "t7", `{"labels":{"`+agentproto.HiddenLabel+`":"`+agentproto.HiddenChatHost+`"},"record":`+hiddenRec("t7")+`}`)
	nextEvent(t, c, "removed", "t7")
	if m := c.until("closed"); m["s"] != sid {
		t.Fatalf("closed %v, want stream %v", m, sid)
	}
	if m := u.until("closed"); m["s"] != usid {
		t.Fatalf("closed %v, want stream %v", m, usid)
	}
	core.waitClosed(t, 2)
	core.set(hiddenRec("t7"), "t7", host)
	core.event("labels", "t7", `{"labels":{}}`) // hidden until removed
	core.event("title", "t7", `{"title":"still hidden"}`)
	core.event("title", "t1", `{"title":"again"}`)
	nextEvent(t, c, "title", "t1")
	hiddenSince := core.mark()

	// An agent in the hidden terminal is no news, for /api/v1/term or /ws.
	b := s.term.existing("x")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t7", Agent: "claude", Status: "working"})
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "codex", Status: "working"})
	nextEvent(t, c, "agent", "t1")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		mu.Lock()
		got := strings.Join(ws, " ")
		mu.Unlock()
		if strings.Contains(got, `"t7"`) {
			t.Fatalf("/ws agent messages %q", got)
		}
		if strings.Contains(got, `"terminal":"t1"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/ws agent messages %q", got)
		}
	}

	// A later client's snapshot, the list and the shells have only the
	// clients' terminals.
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	if got := strings.Fields(addresses(c2.until("snapshot")["terminals"])); len(got) != 3 || strings.Contains(strings.Join(got, " "), "t7") {
		t.Fatalf("second client's snapshot has %q, want t1, t2 and t6", got)
	}
	res, _ := c.call(2, "terminal.list", map[string]any{"all": true})["result"].(map[string]any)
	if got := addresses(res["terminals"]); got != "t1 t6" || res["hidden_finished"] != float64(2) {
		t.Fatalf("list %v", res)
	}
	sh := termShells{b}
	if all, _ := sh.All(context.Background()); strings.Join(all, " ") != "t1 t2 t6" {
		t.Fatalf("shells %v", all)
	}
	for _, target := range []string{"t7", host, "box/t7"} {
		if _, _, err := sh.Shell(context.Background(), target); err == nil || !strings.Contains(err.Error(), "not_found") {
			t.Fatalf("the shell of %s: %v", target, err)
		}
		if err := sh.Send(context.Background(), target, "exit\r"); err == nil {
			t.Fatalf("typed into %s", target)
		}
	}

	// A call that names it, by address or by name, with or without the
	// terminal core's own id or name before it, as its terminal, its
	// caller or a new terminal's parent.
	rid := 10
	refused := func(method string, params map[string]any, message string) {
		t.Helper()
		rid++
		m := c.call(rid, method, params)
		if e, _ := m["error"].(map[string]any); errKind(m) != "not_found" || e["message"] != message {
			t.Fatalf("%s %v: %v, want not_found %s", method, params, m, message)
		}
	}
	refused("terminal.read", map[string]any{"terminal": "t7"}, `no terminal "t7"`)
	refused("terminal.get", map[string]any{"terminal": host}, `no terminal "`+host+`"`)
	refused("terminal.kill", map[string]any{"terminal": "box/t7"}, `no terminal "t7"`)
	refused("terminal.rm", map[string]any{"terminal": "c0ffee/" + host}, `no terminal "`+host+`"`)
	refused("terminal.keep", map[string]any{"terminal": "box/" + host, "keep": true}, `no terminal "`+host+`"`)
	refused("terminal.interrupt", map[string]any{"terminal": "t7"}, `no terminal "t7"`)
	refused("terminal.label", map[string]any{"terminal": "t7", "labels": map[string]string{"x": "y"}}, `no terminal "t7"`)
	refused("terminal.run", map[string]any{"argv": []string{"sh"}, "parent": "t7"}, `no terminal "t7"`)
	refused("terminal.run", map[string]any{"argv": []string{"sh"}, "caller": host}, `no terminal "`+host+`"`)
	// Attaching is refused alike, also to observe.
	for _, terminal := range []string{"t7", host, "box/t7", "c0ffee/" + host} {
		rid++
		c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": terminal, "cols": 80, "rows": 24, "observe": true})
		if m := c.until("res"); m["rid"] != float64(rid) || errKind(m) != "not_found" {
			t.Fatalf("attach to %s: %v", terminal, m)
		}
	}

	// A client neither sets the hidden label nor takes the chat host's
	// name.
	for _, call := range []map[string]any{
		{"method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}, "labels": map[string]string{agentproto.HiddenLabel: "mine"}}},
		{"method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}, "name": host}},
		{"method": "terminal.label", "params": map[string]any{"terminal": "t1", "labels": map[string]string{"name": "x", agentproto.HiddenLabel: ""}}},
	} {
		rid++
		call["t"], call["rid"], call["m"] = "call", rid, "x"
		c.send(call)
		if m := c.until("res"); errKind(m) != "refused" {
			t.Fatalf("%v: %v", call, m)
		}
	}
	// Nor through an escape in its JSON: the parameters are read as the
	// terminal core reads them.
	rid++
	raw := `{"t":"call","rid":` + strconv.Itoa(rid) + `,"m":"x","method":"terminal.run","params":{"argv":["sh"],"labels":{"` +
		strings.Replace(agentproto.HiddenLabel, ".", `.`, 1) + `":"x"}}}`
	if err := c.ws.Write(context.Background(), websocket.MessageText, []byte(raw)); err != nil {
		t.Fatal(err)
	}
	if m := c.until("res"); errKind(m) != "refused" {
		t.Fatalf("an escaped label: %v", m)
	}

	// None of it reached the terminal core.
	for _, word := range []string{"t5", "t7", host, "terminal.attach", "terminal.run", "terminal.label", "terminal.get", "terminal.read"} {
		if core.gotSince(hiddenSince, word) {
			t.Errorf("the terminal core got a call with %q: %q", word, core.calls())
		}
	}
	a := audit.String()
	for _, want := range []string{`"method":"terminal.read","param":"terminal","reason":"hidden"`, `"terminal":"box/t7"`,
		`"method":"terminal.run","param":"parent"`, `"method":"terminal.run","param":"caller"`, `"method":"terminal.attach","param":"terminal"`,
		`"method":"terminal.run","param":"labels"`, `"method":"terminal.run","param":"name"`, `"method":"terminal.label","param":"labels"`} {
		if !strings.Contains(a, want) {
			t.Errorf("audit lacks %s: %s", want, a)
		}
	}

	// Other terminals are the clients' as before: by address, with labels
	// and names of their own, the one labeled as a helper's included.
	passes := func(method string, params map[string]any) {
		t.Helper()
		rid++
		if m := c.call(rid, method, params); m["error"] != nil {
			t.Fatalf("%s %v: %v", method, params, m)
		}
	}
	passes("terminal.read", map[string]any{"terminal": "t1"})
	passes("terminal.read", map[string]any{"terminal": "t6"})
	passes("terminal.get", map[string]any{"terminal": "box/t1"})
	passes("terminal.label", map[string]any{"terminal": "t1", "labels": map[string]string{"name": "x", "hidden": "no"}})
	passes("terminal.run", map[string]any{"argv": []string{"sh"}, "name": agentproto.HiddenChatHost, "labels": map[string]string{"name": "y"}, "parent": "t1"})
	rid++
	c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": "t6", "cols": 80, "rows": 24})
	if at := c.until("attached"); at["rid"] != float64(rid) {
		t.Fatalf("attached %v", at)
	}
	// A terminal that was removed is hidden no more: its address is any
	// address the terminal core does not know. The chat host's name stays
	// kept for it while none runs.
	core.event("removed", "t7", `{}`)
	core.event("title", "t1", `{"title":"after"}`)
	nextEvent(t, c, "title", "t1")
	core.set(plainRec("t7"), "t7")
	passes("terminal.read", map[string]any{"terminal": "t7"})
	if !core.got(`terminal.read {"terminal":"t7"}`) {
		t.Errorf("a call for a removed terminal did not reach the terminal core: %q", core.calls())
	}
	refused("terminal.kill", map[string]any{"terminal": host}, `no terminal "`+host+`"`)
	if core.got("terminal.kill") {
		t.Errorf("a call by the chat host's name reached the terminal core: %q", core.calls())
	}
}

// A terminal the backend does not know yet (its creation's event has not
// arrived) or that a client names by a name is looked up before the call:
// a hidden one is refused, its record read but nothing else asked of it,
// and any other is called by its address. An attach whose reply shows a
// hidden terminal (it became one since the lookup) ends the stream unread
// and is answered as for no terminal; termShells read the record and keep
// away from a hidden one alike.
func TestTermHiddenCreationWindow(t *testing.T) {
	s, _, audit := termServer(t, Options{}, false)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+plainRec("t2")+`]`, `{"terminals":[]}`,
		map[string]string{"t1": plainRec("t1"), "t2": plainRec("t2"), "t9": hiddenRec("t9"),
			"t4": rec("t4", "work", `{}`), "work": rec("t4", "work", `{}`), "t3": plainRec("t3")})
	c := dialTerm(t, s)
	c.ready()
	c.until("snapshot")

	// The chat host just started as t9: its event is on its way.
	for i, target := range []string{"t9", "box/t9", "c0ffee/t9"} {
		if m := c.call(i+1, "terminal.read", map[string]any{"terminal": target}); errKind(m) != "not_found" {
			t.Fatalf("read %s: %v", target, m)
		}
		c.send(map[string]any{"t": "attach", "rid": 10 + i, "m": "x", "terminal": target, "cols": 80, "rows": 24})
		if m := c.until("res"); m["rid"] != float64(10+i) || errKind(m) != "not_found" {
			t.Fatalf("attach %s: %v", target, m)
		}
	}
	if !core.got(`terminal.get {"terminal":"t9"}`) || core.got("terminal.read") || core.got("terminal.attach") {
		t.Fatalf("calls %q", core.calls())
	}
	sh := termShells{s.term.existing("x")}
	if _, _, err := sh.Shell(context.Background(), "t9"); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("the shell of t9: %v", err)
	}
	// A terminal the backend has as the clients' whose record says it is
	// the chat host by now.
	core.set(hiddenRec("t2"), "t2")
	if _, _, err := sh.Shell(context.Background(), "t2"); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("the shell of t2: %v", err)
	}
	if err := sh.Send(context.Background(), "t2", "exit\r"); err == nil || core.got("terminal.attach") {
		t.Fatalf("typed into t2: %v %q", err, core.calls())
	}

	// A name is looked up, and the call names the terminal by its address.
	if m := c.call(20, "terminal.read", map[string]any{"terminal": "work", "caller": "box/t1"}); m["error"] != nil {
		t.Fatalf("read work: %v", m)
	}
	if !core.got(`terminal.get {"terminal":"work"}`) || !core.got(`terminal.read {"caller":"t1","terminal":"t4"}`) {
		t.Fatalf("calls %q", core.calls())
	}
	c.send(map[string]any{"t": "attach", "rid": 21, "m": "x", "terminal": "work", "cols": 80, "rows": 24})
	at := c.until("attached")
	if at["rid"] != float64(21) || at["terminal"] != "work" {
		t.Fatalf("attached %v", at)
	}
	work := at["s"]
	if !core.got(`terminal.attach {"terminal":"t4"`) {
		t.Fatalf("calls %q", core.calls())
	}
	// A terminal that is hidden by the time it is attached to.
	core.mu.Lock()
	core.attached["t3"] = hiddenRec("t3")
	core.mu.Unlock()
	c.send(map[string]any{"t": "attach", "rid": 22, "m": "x", "terminal": "t3", "cols": 80, "rows": 24})
	if m := c.until("res"); m["rid"] != float64(22) || errKind(m) != "not_found" {
		t.Fatalf("attach t3: %v", m)
	}
	core.waitClosed(t, 1)
	// Nothing of it reached the client: until the reply to the next call,
	// it gets the output of the stream of work only.
	c.send(map[string]any{"t": "call", "rid": 23, "m": "x", "method": "terminal.get", "params": map[string]any{"terminal": "t1"}})
	for {
		m := c.next()
		if m["bin"] != nil && m["bin"] != work || m["t"] == "attached" || m["t"] == "closed" {
			t.Fatalf("got %v", m)
		}
		if m["t"] == "res" {
			if m["rid"] != float64(23) || m["error"] != nil {
				t.Fatalf("get t1: %v", m)
			}
			break
		}
	}
	if a := audit.String(); strings.Count(a, `"reason":"hidden"`) < 7 {
		t.Errorf("audit %s", a)
	}
}

// A snapshot after missed events is the whole state: its hidden terminals
// are kept from the clients and from their calls as those of the first
// one, the agents detected in them are forgotten, the clients' streams of
// them end, and a terminal it no longer has as hidden is the clients'
// again.
func TestTermHiddenAfterMissed(t *testing.T) {
	s, _, _ := termServer(t, Options{}, false)
	host := agentproto.ChatHostName
	finished := strings.Replace(hiddenRec("t5"), `"state":"live"`, `"state":"finished"`, 1)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+finished+`,`+rec("t7", host, `{}`)+`]`, `{"terminals":[]}`,
		map[string]string{"t1": plainRec("t1"), "t5": plainRec("t5"), "t7": rec("t7", host, `{}`)})
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1 t7" && got != "t7 t1" {
		t.Fatalf("snapshot has %q, want t1 and t7", got)
	}
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": "t7", "cols": 80, "rows": 24})
	sid := c.until("attached")["s"]
	b := s.term.existing("x")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t7", Agent: "claude", Status: "working"})
	nextEvent(t, c, "agent", "t7")
	hiddenSince := core.mark()

	core.notify(`{"jsonrpc":"2.0","method":"missed","params":{"seq":20,"terminals":[` + plainRec("t1") + `,` + plainRec("t5") + `,` + hiddenRec("t7") + `]}}`)
	for got := map[string]bool{}; !got["snapshot"] || !got["closed"]; {
		switch m := c.next(); m["t"] {
		case "snapshot":
			if a := addresses(m["terminals"]); a != "t1 t5" && a != "t5 t1" {
				t.Fatalf("snapshot after missed events has %q, want t1 and t5", a)
			}
			got["snapshot"] = true
		case "closed":
			if m["s"] != sid {
				t.Fatalf("closed %v", m)
			}
			got["closed"] = true
		case "event":
			t.Fatalf("event %v", m)
		}
	}
	core.waitClosed(t, 1)
	b.mu.Lock()
	_, agent := b.agents["t7"]
	b.mu.Unlock()
	if agent {
		t.Error("the agent of a terminal hidden meanwhile is kept")
	}
	for i, target := range []string{"t7", host, "box/t7"} {
		if m := c.call(i+2, "terminal.read", map[string]any{"terminal": target}); errKind(m) != "not_found" {
			t.Fatalf("read %s: %v", target, m)
		}
	}
	if m := c.call(9, "terminal.read", map[string]any{"terminal": "t5"}); m["error"] != nil {
		t.Fatalf("read t5: %v", m)
	}
	if core.gotSince(hiddenSince, "t7") || core.gotSince(hiddenSince, host) {
		t.Errorf("the terminal core got %q", core.calls())
	}
}

// A read-only client is kept from hidden terminals as any other.
func TestTermHiddenReadOnly(t *testing.T) {
	s, _, _ := termServer(t, Options{ReadOnly: true}, false)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+hiddenRec("t5")+`]`,
		`{"terminals":[`+plainRec("t1")+`,`+hiddenRec("t5")+`]}`, map[string]string{"t1": plainRec("t1"), "t5": hiddenRec("t5")})
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1" {
		t.Fatalf("snapshot has %q, want t1", got)
	}
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": agentproto.ChatHostName, "cols": 80, "rows": 24})
	if m := c.until("res"); errKind(m) != "not_found" {
		t.Fatalf("attach: %v", m)
	}
	if m := c.call(2, "terminal.read", map[string]any{"terminal": "t5"}); errKind(m) != "not_found" {
		t.Fatalf("read: %v", m)
	}
	if res, _ := c.call(3, "terminal.list", nil)["result"].(map[string]any); res == nil || addresses(res["terminals"]) != "t1" {
		t.Fatalf("list %v", res)
	}
	if core.got("t5") || core.got("terminal.attach") {
		t.Errorf("the terminal core got %q", core.calls())
	}
}

// The terminals of other machines the terminal core has (added with
// machine.add, or dialed in) are none of the clients': they are in no
// snapshot, event, list or agent state, the list names no machine, and a
// call or an attach that names one, or a terminal after any machine but
// the core's own id or name, is refused (audited) without reaching the
// terminal core.
func TestTermOtherMachines(t *testing.T) {
	s, _, audit := termServer(t, Options{}, false)
	far := strings.Replace(plainRec("far/t3"), `"labels"`, `"machine":"far","labels"`, 1)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+far+`]`,
		`{"terminals":[`+plainRec("t1")+`,`+far+`],"hidden_finished":0,"machines":[{"name":"far","target":"me@far.example"}]}`,
		map[string]string{"t1": plainRec("t1"), "far/t3": far, "farname": far})
	var mu sync.Mutex
	var ws []string
	s.mg.Subscribe(func(machines.State) {}, func(ev machines.AgentEvent) {
		mu.Lock()
		ws = append(ws, string(ev.Data))
		mu.Unlock()
	})
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1" {
		t.Fatalf("snapshot has %q, want t1", got)
	}
	core.event("title", "far/t3", `{"title":"far"}`)
	core.event("created", "far/t4", plainRec("far/t4"))
	core.notify(`{"jsonrpc":"2.0","method":"event","params":{"seq":10,"type":"doc","machine":"far","data":{"name":"d","version":2}}}`)
	b := s.term.existing("x")
	b.applyAgent(agentproto.DetectEvent{Terminal: "far/t3", Agent: "claude", Status: "blocked"})
	core.event("title", "t1", `{"title":"here"}`)
	nextEvent(t, c, "title", "t1")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "codex", Status: "working"})
	nextEvent(t, c, "agent", "t1")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		mu.Lock()
		got := strings.Join(ws, " ")
		mu.Unlock()
		if strings.Contains(got, "far") {
			t.Fatalf("/ws agent messages %q", got)
		}
		if strings.Contains(got, `"terminal":"t1"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/ws agent messages %q", got)
		}
	}
	res, _ := c.call(1, "terminal.list", map[string]any{"all": true})["result"].(map[string]any)
	if ms, _ := res["machines"].([]any); res == nil || addresses(res["terminals"]) != "t1" || res["machines"] == nil || len(ms) != 0 {
		t.Fatalf("list %v", res)
	}

	rid := 1
	for _, call := range []struct {
		method string
		params map[string]any
	}{
		{"terminal.read", map[string]any{"terminal": "far/t3"}},
		{"terminal.get", map[string]any{"terminal": "far/work"}},
		{"terminal.kill", map[string]any{"terminal": "unknown/t1"}},
		{"terminal.read", map[string]any{"terminal": "box/t1", "caller": "far/t1"}},
		{"terminal.run", map[string]any{"argv": []string{"sh"}, "parent": "far/t1"}},
		{"terminal.read", map[string]any{"terminal": "box/far/t3"}},
		{"terminal.read", map[string]any{"terminal": "/t1"}},
		// A name the core finds on another machine.
		{"terminal.read", map[string]any{"terminal": "farname"}},
	} {
		rid++
		if m := c.call(rid, call.method, call.params); errKind(m) != "not_found" {
			t.Fatalf("%s %v: %v", call.method, call.params, m)
		}
	}
	rid++
	c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": "far/t3", "cols": 80, "rows": 24, "observe": true})
	if m := c.until("res"); errKind(m) != "not_found" {
		t.Fatalf("attach far/t3: %v", m)
	}
	sh := termShells{b}
	if _, _, err := sh.Shell(context.Background(), "far/t3"); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("the shell of far/t3: %v", err)
	}
	if !core.got(`terminal.get {"terminal":"farname"}`) {
		t.Errorf("calls %q", core.calls())
	}
	for _, word := range []string{"far/", "unknown", "terminal.attach", "terminal.kill", "terminal.run", "terminal.read", `"terminal":"t1"`} {
		if core.got(word) {
			t.Errorf("the terminal core got a call with %q: %q", word, core.calls())
		}
	}
	if a := audit.String(); !strings.Contains(a, `"method":"terminal.read","param":"terminal","reason":"machine"`) || !strings.Contains(a, `"terminal":"far/t3"`) ||
		!strings.Contains(a, `"param":"caller","reason":"machine"`) || !strings.Contains(a, `"method":"terminal.attach","param":"terminal","reason":"machine"`) {
		t.Errorf("audit %s", a)
	}
	// The core's own id and name name its own terminals.
	for i, target := range []string{"box/t1", "c0ffee/t1"} {
		if m := c.call(20+i, "terminal.read", map[string]any{"terminal": target}); m["error"] != nil {
			t.Fatalf("read %s: %v", target, m)
		}
	}
	if !core.got(`terminal.read {"terminal":"t1"}`) {
		t.Errorf("calls %q", core.calls())
	}
}

// Labels that are not an object of strings are refused before they reach
// the terminal core: what the core would read is what was checked.
func TestTermLabelsParams(t *testing.T) {
	s, _, _ := termServer(t, Options{}, false)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`]`, `{"terminals":[]}`, map[string]string{"t1": plainRec("t1")})
	c := dialTerm(t, s)
	c.ready()
	c.until("snapshot")
	rid := 0
	for _, labels := range []string{`null`, `[]`, `"x"`, `1`, `{"a":1}`, `{"a":null}`, `{"a":{"b":"c"}}`, `{"a":["b"]}`} {
		for _, method := range []string{"terminal.run", "terminal.label", "terminal.list"} {
			rid++
			raw := `{"t":"call","rid":` + strconv.Itoa(rid) + `,"m":"x","method":"` + method + `","params":{"argv":["sh"],"terminal":"t1","labels":` + labels + `}}`
			if err := c.ws.Write(context.Background(), websocket.MessageText, []byte(raw)); err != nil {
				t.Fatal(err)
			}
			if m := c.until("res"); m["rid"] != float64(rid) || errKind(m) != "usage" {
				t.Fatalf("%s with labels %s: %v", method, labels, m)
			}
		}
	}
	if calls := core.calls(); len(calls) != 0 {
		t.Fatalf("the terminal core got %q", calls)
	}
	if m := c.call(100, "terminal.label", map[string]any{"terminal": "t1", "labels": map[string]string{"a": "b", "c": ""}}); m["error"] != nil {
		t.Fatalf("label: %v", m)
	}
	if m := c.call(101, "terminal.run", map[string]any{"argv": []string{"sh"}, "parent": nil}); m["error"] != nil || core.got("terminal.get") {
		t.Fatalf("run without a parent: %v %q", m, core.calls())
	}
}
