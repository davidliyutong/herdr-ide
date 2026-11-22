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
	"herdr-ide/internal/machines"
)

// hiddenTermCore is a terminal core on machine x's socket that calls itself
// c0ffee or box, has the terminals snap, answers terminal.list with list,
// and records every call it gets, as "method params".
type hiddenTermCore struct {
	mu   sync.Mutex
	snap string
	list string
	reqs []string
	subs []func(line string)
}

// listenHiddenCore starts a hiddenTermCore on the socket of the server's
// machine x.
func listenHiddenCore(t *testing.T, snap, list string) *hiddenTermCore {
	t.Helper()
	socket := filepath.Join(os.Getenv("HOME"), brand.DataDir(""), "run", "hc.sock")
	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	f := &hiddenTermCore{snap: snap, list: list}
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

// got reports whether the core got a call that has want in its line.
func (f *hiddenTermCore) got(want string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.reqs {
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
		if binary.LittleEndian.Uint32(h[:4]) != 0 {
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
		f.mu.Lock()
		if req.Method != "events.subscribe" {
			f.reqs = append(f.reqs, req.Method+" "+string(req.Params))
		}
		f.mu.Unlock()
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
			next++
			chJSON, _ := json.Marshal(next)
			write(reply(`"result":{"channel":` + string(chJSON) + `,"automatic_input":true,"terminal":{"address":"t1","cols":80,"rows":24}}`))
		case "terminal.get":
			write(reply(`"result":{"address":"t1","state":"live","pid":42,"cols":80,"rows":24,"argv":[],"cwd":"/","created_ms":1,"labels":{},"screen":"exact","foreground":{"pid":42,"name":"zsh","argv":["zsh"],"cwd":"/"}}`))
		default:
			write(reply(`"result":{"method":"` + req.Method + `"}`))
		}
	}
}

func plainRec(addr string) string {
	return `{"address":"` + addr + `","state":"live","cols":80,"rows":24,"labels":{"name":"mine"}}`
}

func hiddenRec(addr, name string) string {
	return `{"address":"` + addr + `","name":"` + name + `","state":"live","cols":80,"rows":24,"labels":{"` + agentproto.HiddenLabel + `":"` + agentproto.HiddenChatHost + `"}}`
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

// Terminals of the product's own helpers (the label agentproto.HiddenLabel:
// the chat host) are none of the clients': they are in no snapshot, event,
// agent state, list or shell that is typed into, and a call or an attach
// that names one, by its address or its name, is answered as for a terminal
// that does not exist, without reaching the terminal core. A client can
// neither hide a terminal nor take the chat host's name. Other terminals
// are as they were.
func TestTermHiddenTerminals(t *testing.T) {
	s, _, audit := termServer(t, Options{}, false)
	host := agentproto.ChatHostName
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+hiddenRec("t5", host)+`]`,
		`{"terminals":[`+plainRec("t1")+`,`+hiddenRec("t5", host)+`,`+hiddenRec("t8", "later")+`],"hidden_finished":2}`)
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

	// Events: what happens to a hidden terminal, one created with the
	// label included, is not passed on.
	core.event("title", "t5", `{"title":"the chat host"}`)
	core.event("created", "t6", hiddenRec("t6", "helper"))
	core.event("size", "t6", `{"cols":10,"rows":10}`)
	core.event("foreground", "t6", `{"pid":7,"name":"sh","argv":["sh"],"cwd":"/"}`)
	core.event("created", "t2", plainRec("t2"))
	nextEvent(t, c, "created", "t2")
	// A terminal that gets the label leaves the clients, and stays away
	// whatever its labels become.
	core.event("labels", "t2", `{"labels":{"name":"mine","`+agentproto.HiddenLabel+`":"1"}}`)
	nextEvent(t, c, "removed", "t2")
	core.event("labels", "t2", `{"labels":{"name":"mine"}}`)
	core.event("title", "t2", `{"title":"still hidden"}`)
	core.event("finished", "t5", `{"reason":"exited","exit_code":0,"signal":null,"finished_ms":1}`)
	core.event("title", "t1", `{"title":"shown"}`)
	nextEvent(t, c, "title", "t1")

	// An agent in a hidden terminal is no news, for /api/v1/term or /ws.
	b := s.term.existing("x")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t5", Agent: "claude", Status: "working"})
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "codex", Status: "working"})
	nextEvent(t, c, "agent", "t1")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		mu.Lock()
		got := strings.Join(ws, " ")
		mu.Unlock()
		if strings.Contains(got, `"t5"`) {
			t.Fatalf("/ws agent messages %q", got)
		}
		if strings.Contains(got, `"terminal":"t1"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/ws agent messages %q", got)
		}
	}

	// A later client's snapshot, the list and the shells have none of them.
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	if got := addresses(c2.until("snapshot")["terminals"]); got != "t1" {
		t.Fatalf("second client's snapshot has %q, want t1", got)
	}
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.list", "params": map[string]any{"all": true}})
	if res, _ := c.until("res")["result"].(map[string]any); res == nil || addresses(res["terminals"]) != "t1" || res["hidden_finished"] != float64(2) {
		t.Fatalf("list %v", res)
	}
	sh := termShells{b}
	if all, _ := sh.All(context.Background()); len(all) != 1 || all[0] != "t1" {
		t.Fatalf("shells %v", all)
	}
	if _, _, err := sh.Shell(context.Background(), "t5"); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("the shell of a hidden terminal: %v", err)
	}
	if err := sh.Send(context.Background(), host, "exit\r"); err == nil {
		t.Fatal("typed into a hidden terminal")
	}

	// A call that names one, by address or by name, with or without the
	// terminal core's own id or name before it, as its terminal, its
	// caller or a new terminal's parent.
	rid := 10
	refused := func(method string, params map[string]any, message string) {
		t.Helper()
		rid++
		c.send(map[string]any{"t": "call", "rid": rid, "m": "x", "method": method, "params": params})
		m := c.until("res")
		e, _ := m["error"].(map[string]any)
		if m["rid"] != float64(rid) || e["kind"] != "not_found" || e["message"] != message {
			t.Fatalf("%s %v: %v, want not_found %s", method, params, m, message)
		}
	}
	refused("terminal.read", map[string]any{"terminal": "t5"}, `no terminal "t5"`)
	refused("terminal.get", map[string]any{"terminal": host}, `no terminal "`+host+`"`)
	refused("terminal.kill", map[string]any{"terminal": "box/t5"}, `no terminal "t5"`)
	refused("terminal.rm", map[string]any{"terminal": "c0ffee/" + host}, `no terminal "`+host+`"`)
	refused("terminal.keep", map[string]any{"terminal": "helper", "keep": true}, `no terminal "helper"`)
	refused("terminal.interrupt", map[string]any{"terminal": "box/helper"}, `no terminal "helper"`)
	refused("terminal.label", map[string]any{"terminal": "t2", "labels": map[string]string{agentproto.HiddenLabel: ""}}, `no terminal "t2"`)
	refused("terminal.run", map[string]any{"argv": []string{"sh"}, "parent": "t6"}, `no terminal "t6"`)
	refused("terminal.run", map[string]any{"argv": []string{"sh"}, "caller": "t5"}, `no terminal "t5"`)
	// Attaching is refused alike, also to observe.
	for _, terminal := range []string{"t5", host, "box/t6"} {
		rid++
		c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": terminal, "cols": 80, "rows": 24, "observe": true})
		m := c.until("res")
		if e, _ := m["error"].(map[string]any); m["rid"] != float64(rid) || e["kind"] != "not_found" {
			t.Fatalf("attach to %s: %v", terminal, m)
		}
	}

	// A client neither marks a terminal as a helper's nor takes the chat
	// host's name.
	for _, call := range []map[string]any{
		{"method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}, "labels": map[string]string{agentproto.HiddenLabel: "mine"}}},
		{"method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}, "name": host}},
		{"method": "terminal.label", "params": map[string]any{"terminal": "t1", "labels": map[string]string{"name": "x", agentproto.HiddenLabel: ""}}},
	} {
		rid++
		call["t"], call["rid"], call["m"] = "call", rid, "x"
		c.send(call)
		if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "refused" {
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
	if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "refused" {
		t.Fatalf("an escaped label: %v", m)
	}

	// None of it reached the terminal core.
	for _, word := range []string{"t5", "t6", "t2", host, "helper", "hidden", "terminal.attach", "terminal.run", "terminal.label", "terminal.get"} {
		if core.got(word) {
			t.Errorf("the terminal core got a call with %q: %q", word, core.calls())
		}
	}
	a := audit.String()
	for _, want := range []string{`"method":"terminal.read","param":"terminal"`, `"terminal":"box/t5"`, `"method":"terminal.run","param":"parent"`,
		`"method":"terminal.run","param":"caller"`, `"method":"terminal.attach","param":"terminal"`,
		`"method":"terminal.run","param":"labels"`, `"method":"terminal.run","param":"name"`, `"method":"terminal.label","param":"labels"`} {
		if !strings.Contains(a, want) {
			t.Errorf("audit lacks %s: %s", want, a)
		}
	}

	// Other terminals are the clients' as before: by address, with labels
	// and names of their own.
	passes := func(method string, params map[string]any) {
		t.Helper()
		rid++
		c.send(map[string]any{"t": "call", "rid": rid, "m": "x", "method": method, "params": params})
		if m := c.until("res"); m["rid"] != float64(rid) || m["error"] != nil {
			t.Fatalf("%s %v: %v", method, params, m)
		}
	}
	passes("terminal.read", map[string]any{"terminal": "t1"})
	passes("terminal.get", map[string]any{"terminal": "box/t1"})
	passes("terminal.label", map[string]any{"terminal": "t1", "labels": map[string]string{"name": "x", "hidden": "no"}})
	passes("terminal.run", map[string]any{"argv": []string{"sh"}, "name": agentproto.HiddenChatHost, "labels": map[string]string{"name": "y"}, "parent": "t1"})
	c.send(map[string]any{"t": "attach", "rid": 99, "m": "x", "terminal": "t1", "cols": 80, "rows": 24})
	if at := c.until("attached"); at["rid"] != float64(99) {
		t.Fatalf("attached %v", at)
	}
	// A terminal that was removed is hidden no more: its address is any
	// address the terminal core does not know. The chat host's name stays
	// kept for it while none runs.
	core.event("removed", "t6", `{}`)
	core.event("removed", "t5", `{}`)
	core.event("title", "t1", `{"title":"after"}`)
	nextEvent(t, c, "title", "t1")
	passes("terminal.read", map[string]any{"terminal": "t6"})
	if !core.got(`terminal.read {"terminal":"t6"}`) {
		t.Errorf("a call for a removed terminal did not reach the terminal core: %q", core.calls())
	}
	refused("terminal.kill", map[string]any{"terminal": host}, `no terminal "`+host+`"`)
	if core.got("terminal.kill") {
		t.Errorf("a call by the chat host's name reached the terminal core: %q", core.calls())
	}
}

// A snapshot after missed events is the whole state: its hidden terminals
// are kept from the clients and from their calls as those of the first
// one, and a terminal it no longer has as hidden is the clients' again.
func TestTermHiddenAfterMissed(t *testing.T) {
	s, _, _ := termServer(t, Options{}, false)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+hiddenRec("t5", agentproto.ChatHostName)+`]`, `{"terminals":[]}`)
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1" {
		t.Fatalf("snapshot has %q, want t1", got)
	}
	core.notify(`{"jsonrpc":"2.0","method":"missed","params":{"seq":20,"terminals":[` + plainRec("t1") + `,` + plainRec("t5") + `,` + hiddenRec("t7", "helper") + `]}}`)
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1 t5" && got != "t5 t1" {
		t.Fatalf("snapshot after missed events has %q, want t1 and t5", got)
	}
	for i, target := range []string{"t7", "helper", "box/t7"} {
		c.send(map[string]any{"t": "call", "rid": i + 1, "m": "x", "method": "terminal.read", "params": map[string]any{"terminal": target}})
		if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "not_found" {
			t.Fatalf("read %s: %v", target, m)
		}
	}
	c.send(map[string]any{"t": "call", "rid": 9, "m": "x", "method": "terminal.read", "params": map[string]any{"terminal": "t5"}})
	if m := c.until("res"); m["error"] != nil {
		t.Fatalf("read t5: %v", m)
	}
	if core.got("t7") || core.got("helper") {
		t.Errorf("the terminal core got %q", core.calls())
	}
}

// A read-only client is kept from hidden terminals as any other.
func TestTermHiddenReadOnly(t *testing.T) {
	s, _, _ := termServer(t, Options{ReadOnly: true}, false)
	core := listenHiddenCore(t, `[`+plainRec("t1")+`,`+hiddenRec("t5", agentproto.ChatHostName)+`]`,
		`{"terminals":[`+plainRec("t1")+`,`+hiddenRec("t5", agentproto.ChatHostName)+`]}`)
	c := dialTerm(t, s)
	c.ready()
	if got := addresses(c.until("snapshot")["terminals"]); got != "t1" {
		t.Fatalf("snapshot has %q, want t1", got)
	}
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": agentproto.ChatHostName, "cols": 80, "rows": 24})
	if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "not_found" {
		t.Fatalf("attach: %v", m)
	}
	c.send(map[string]any{"t": "call", "rid": 2, "m": "x", "method": "terminal.read", "params": map[string]any{"terminal": "t5"}})
	if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "not_found" {
		t.Fatalf("read: %v", m)
	}
	c.send(map[string]any{"t": "call", "rid": 3, "m": "x", "method": "terminal.list"})
	if res, _ := c.until("res")["result"].(map[string]any); res == nil || addresses(res["terminals"]) != "t1" {
		t.Fatalf("list %v", res)
	}
	if core.got("t5") || core.got("terminal.attach") {
		t.Errorf("the terminal core got %q", core.calls())
	}
}
