package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"

	"herdr-ide/internal/herdr/endpoint"
)

// fakeClient is a browser connection without a WebSocket.
func fakeClient(s *Server, readOnly bool) *wsClient {
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsClient{s: s, ctx: ctx, cancel: cancel, send: make(chan outMsg, 64), readOnly: readOnly}
	s.clientsMu.Lock()
	s.clients[c] = true
	s.clientsMu.Unlock()
	return c
}

func (c *wsClient) leaveForTest() {
	c.cancel()
	c.s.clientsMu.Lock()
	delete(c.s.clients, c)
	c.s.clientsMu.Unlock()
	c.s.surfLeave(c)
}

// lastState returns the last session state sent to c.
func lastState(t *testing.T, c *wsClient) string {
	t.Helper()
	state := ""
	for {
		select {
		case m := <-c.send:
			var v struct{ T, State string }
			if json.Unmarshal(m.data, &v) == nil && v.T == "session" {
				state = v.State
			}
		default:
			return state
		}
	}
}

func TestSessionOwnership(t *testing.T) {
	s := newTestServer()
	a := fakeClient(s, false)
	s.surfJoin(a)
	if st := lastState(t, a); st != "owner" {
		t.Fatalf("first browser: %q", st)
	}
	b := fakeClient(s, false)
	s.surfJoin(b)
	if st := lastState(t, b); st != "busy" {
		t.Fatalf("second browser: %q", st)
	}
	// Only the owner's input and view reach herdr.
	s.surfInput(b, "m", "p", []endpoint.InputEvent{{T: "text", Text: "x"}})
	s.surfTakeover(b)
	if st := lastState(t, b); st != "owner" {
		t.Fatalf("after takeover: %q", st)
	}
	if st := lastState(t, a); st != "taken_over" {
		t.Fatalf("previous owner: %q", st)
	}
	// A read-only browser cannot take over a writable one.
	r := fakeClient(s, true)
	s.surfJoin(r)
	s.surfTakeover(r)
	if st := lastState(t, r); st != "busy" {
		t.Fatalf("read-only takeover: %q", st)
	}
	// When the owner leaves, a writable browser is preferred.
	b.leaveForTest()
	if st := lastState(t, a); st != "owner" {
		t.Fatalf("handover: %q", st)
	}
	if st := lastState(t, r); st != "" {
		t.Fatalf("read-only got %q", st)
	}
	a.leaveForTest()
	if st := lastState(t, r); st != "owner" {
		t.Fatalf("read-only after writable left: %q", st)
	}
}

func TestReadOnlyClientSendsNothing(t *testing.T) {
	s := newTestServer()
	r := fakeClient(s, true)
	s.surfJoin(r)
	s.surfHost(r, hostMsg{Dark: true})
	s.surf.mu.Lock()
	theme := s.surf.theme
	s.surf.mu.Unlock()
	if theme != nil {
		t.Fatal("read-only browser set the host theme")
	}
}

func TestSurfaceBinaryEncoding(t *testing.T) {
	s := &endpoint.Surface{Frame: endpoint.Frame{W: 2, H: 1, Cells: []endpoint.Cell{
		{Symbol: "宽", Fg: 0x02010203, Mod: 1},
		{Symbol: " ", Skip: true, HasLink: true, Link: 7},
	}, Cursor: &endpoint.Cursor{X: 1, Y: 0, Visible: true, Shape: 5}}}
	b := encodeFull(9, s)
	if b[0] != binFull || binary.LittleEndian.Uint32(b[1:]) != 9 || binary.LittleEndian.Uint16(b[5:]) != 2 {
		t.Fatalf("header %v", b[:9])
	}
	// cursor flags present+visible, x=1, y=0, shape 5; no moves; one span
	if b[9] != 3 || binary.LittleEndian.Uint16(b[10:]) != 1 || b[14] != 5 || binary.LittleEndian.Uint16(b[15:]) != 0 || binary.LittleEndian.Uint32(b[17:]) != 1 {
		t.Fatalf("cursor/moves/spans %v", b[9:21])
	}
	span := b[21:]
	if binary.LittleEndian.Uint16(span[4:]) != 2 || span[6] != 3 || string(span[7:10]) != "宽" {
		t.Fatalf("span %v", span)
	}
	cell2 := span[10+4+4+2+1:]
	if cell2[0] != 1 || cell2[1] != ' ' || cell2[12] != 3 || binary.LittleEndian.Uint16(cell2[13:]) != 7 || len(cell2) != 15 {
		t.Fatalf("second cell %v", cell2)
	}
	p := encodePatch(9, []endpoint.RowMove{{Rect: endpoint.Rect{X: 0, Y: 0, W: 2, H: 3}, Shift: -1}}, &endpoint.Patch{})
	if p[0] != binPatch || binary.LittleEndian.Uint16(p[15:]) != 1 || int16(binary.LittleEndian.Uint16(p[17+8:])) != -1 {
		t.Fatalf("patch %v", p)
	}
}

// The binary surface messages are pinned in a file the web tests decode
// (web/src/__tests__/surface.test.ts); -update rewrites it.
var updateVectors = flag.Bool("update", false, "rewrite test vectors")

func TestSurfaceBinaryVector(t *testing.T) {
	s := &endpoint.Surface{Frame: endpoint.Frame{W: 3, H: 2, Cells: []endpoint.Cell{
		{Symbol: "a", Fg: 2, Bg: 0x01000010, Mod: 1},
		{Symbol: "宽", Fg: 0x02123456},
		{Symbol: " ", Skip: true},
		{Symbol: "─"},
		{Symbol: "é", HasLink: true, Link: 0},
		{Symbol: "", Mod: 0x40 | 3<<12},
	}, Cursor: &endpoint.Cursor{X: 2, Y: 1, Visible: true, Shape: 6}}}
	full := encodeFull(7, s)
	patch := encodePatch(7, []endpoint.RowMove{{Rect: endpoint.Rect{X: 0, Y: 0, W: 3, H: 2}, Shift: 1}},
		&endpoint.Patch{Rows: []endpoint.PatchRow{{X: 1, Y: 1, Cells: []endpoint.Cell{{Symbol: "z", Fg: 9}}}}})
	both, _ := json.MarshalIndent(map[string][]byte{"full": full, "patch": patch}, "", "  ")
	both = append(both, '\n')
	path := "../../web/src/__tests__/testdata/surface.json"
	if *updateVectors {
		if err := os.WriteFile(path, both, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, both) {
		t.Fatal("surface.json differs from the encoder (go test ./internal/server -run Vector -update)")
	}
}

// A browser handed the session before it joined is told it owns it, and a
// takeover by the owner repeats that.
func TestOwnerHandedOverBeforeJoin(t *testing.T) {
	s := newTestServer()
	a := fakeClient(s, false)
	s.surfJoin(a)
	b := fakeClient(s, false) // registered, not yet joined
	a.leaveForTest()
	if st := lastState(t, b); st != "owner" {
		t.Fatalf("handover: %q", st)
	}
	s.surfJoin(b)
	if st := lastState(t, b); st != "owner" {
		t.Fatalf("join after handover: %q", st)
	}
	s.surfTakeover(b)
	if st := lastState(t, b); st != "owner" {
		t.Fatalf("takeover by the owner: %q", st)
	}
}

// OSC 52 reaches a writable owner only, and only up to the cap.
func TestClipboardForwarding(t *testing.T) {
	for _, c := range []struct {
		readOnly bool
		size     int
		want     bool
	}{{false, 8, true}, {true, 8, false}, {false, maxClipboard + 1, false}} {
		s := newTestServer()
		o := fakeClient(s, c.readOnly)
		s.surfJoin(o)
		ss := &surfSession{s: s, m: "m"}
		s.surf.sessions["m"] = ss
		lastState(t, o)
		data := strings.Repeat("A", c.size)
		ss.event(endpoint.Event{Clipboard: &data})
		got := false
		for len(o.send) > 0 {
			m := <-o.send
			got = got || strings.Contains(string(m.data), `"clip"`)
		}
		if got != c.want {
			t.Errorf("%+v: forwarded %v", c, got)
		}
	}
}
