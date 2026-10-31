package endpoint

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// ---- server-side encoders for tests ----

func (w *writer) rect(r Rect) { w.u16(r.X); w.u16(r.Y); w.u16(r.W); w.u16(r.H) }

func (w *writer) cell(c Cell) {
	w.string(c.Symbol)
	w.u32(c.Fg)
	w.u32(c.Bg)
	w.u16(c.Mod)
	w.bool(c.Skip)
	if c.HasLink {
		w.u8(1)
		w.u32(c.Link)
	} else {
		w.u8(0)
	}
}

func (w *writer) cells(cs []Cell) {
	w.varint(uint64(len(cs)))
	for _, c := range cs {
		w.cell(c)
	}
}

func (w *writer) cursor(c *Cursor) {
	if c == nil {
		w.u8(0)
		return
	}
	w.u8(1)
	w.u16(c.X)
	w.u16(c.Y)
	w.bool(c.Visible)
	w.u8(c.Shape)
}

func (w *writer) frameData(f Frame, meta bool) {
	if meta {
		w.varint(0)
	} else {
		w.cells(f.Cells)
	}
	w.u16(f.W)
	w.u16(f.H)
	w.cursor(f.Cursor)
	w.varint(uint64(len(f.Links)))
	for _, l := range f.Links {
		w.string(l)
	}
	w.varint(0) // graphics
}

func (w *writer) pane(p Pane) {
	w.string(p.ID)
	w.varint(p.ContentRevision)
	w.rect(p.Rect)
	w.rect(p.Inner)
	if p.Scrollbar != nil {
		w.u8(1)
		w.rect(*p.Scrollbar)
	} else {
		w.u8(0)
	}
	if p.Scroll != nil {
		w.u8(1)
		w.varint(p.Scroll.OffsetFromBottom)
		w.varint(p.Scroll.MaxOffsetFromBottom)
		w.varint(p.Scroll.ViewportRows)
	} else {
		w.u8(0)
	}
	w.bool(p.Focused)
	w.bool(p.MouseReporting)
	w.bool(p.SGRPixelMouse)
	w.bool(p.AltScreen)
	w.u32(p.PixelW)
	w.u32(p.PixelH)
}

func (w *writer) surfaceBody(s *Surface, meta bool) {
	w.string(s.BootID)
	w.varint(s.ProjectionRevision)
	w.varint(s.SurfaceRevision)
	w.frameData(s.Frame, meta)
	w.varint(uint64(len(s.Panes)))
	for _, p := range s.Panes {
		w.pane(p)
	}
	w.varint(uint64(len(s.Splits)))
	for _, sp := range s.Splits {
		if sp.Vertical {
			w.variant(1)
		} else {
			w.variant(0)
		}
		w.u16(sp.Pos)
		w.rect(sp.Area)
		w.rect(sp.Hit)
		w.varint(uint64(len(sp.Path)))
		for _, b := range sp.Path {
			w.bool(b)
		}
	}
	w.u8(0) // popup
	w.varint(0)
	w.varint(0)
	w.varint(0) // graphics scene
}

func (w *writer) rows(rs []PatchRow) {
	w.varint(uint64(len(rs)))
	for _, r := range rs {
		w.u16(r.X)
		w.u16(r.Y)
		w.cells(r.Cells)
	}
}

func encodePatch(p *Patch) []byte {
	w := &writer{}
	w.variant(19)
	w.string(p.BootID)
	w.varint(p.ProjectionRevision)
	w.varint(p.BaseRevision)
	w.varint(p.SurfaceRevision)
	w.rows(p.Rows)
	w.varint(uint64(len(p.Panes)))
	for _, pn := range p.Panes {
		w.pane(pn)
	}
	w.cursor(p.Cursor)
	return w.b
}

func encodeSurface(s *Surface) []byte {
	w := &writer{}
	w.variant(13)
	w.surfaceBody(s, false)
	return w.b
}

func blank(w, h uint16, ch string) []Cell {
	cs := make([]Cell, int(w)*int(h))
	for i := range cs {
		cs[i] = Cell{Symbol: ch}
	}
	return cs
}

func testSurface() *Surface {
	return &Surface{
		BootID: "boot", ProjectionRevision: 3, SurfaceRevision: 7,
		Frame:  Frame{Cells: blank(6, 4, " "), W: 6, H: 4, Cursor: &Cursor{X: 1, Y: 2, Visible: true, Shape: 5}, Links: []string{"https://example.com"}},
		Panes:  []Pane{{ID: "w1:p1", Rect: Rect{0, 0, 6, 4}, Inner: Rect{0, 0, 5, 4}, Scroll: &Scroll{1, 300, 4}, Focused: true, MouseReporting: true, PixelW: 40, PixelH: 64}},
		Splits: []Split{{Vertical: true, Pos: 2, Area: Rect{0, 0, 6, 4}, Hit: Rect{0, 1, 6, 2}, Path: []bool{true, false}}},
	}
}

// ---- tests ----

func TestEncodeControlVector(t *testing.T) {
	// herdr's wire.rs: EndpointControl{kind:"", data:""} encodes to [20,0,0].
	if got := EncodeControl("", ""); !bytes.Equal(got, []byte{3, 0, 0, 0, 20, 0, 0}) {
		t.Fatalf("got %v", got)
	}
}

func TestVarintBoundaries(t *testing.T) {
	for _, v := range []uint64{0, 250, 251, 65535, 65536, 1<<32 - 1, 1 << 32} {
		w := &writer{}
		w.varint(v)
		r := &reader{b: w.b}
		got, err := r.varint()
		if err != nil || got != v || r.remaining() != 0 {
			t.Fatalf("%d: %d %v (%v)", v, got, err, w.b)
		}
	}
	w := &writer{}
	w.varint(70000)
	if _, err := (&reader{b: w.b}).u16(); err == nil {
		t.Fatal("u16 accepted 70000")
	}
	w = &writer{}
	for _, v := range []int32{0, -1, 1, -2147483648, 2147483647} {
		w.varint(uint64(uint32(v<<1) ^ uint32(v>>31)))
	}
	r := &reader{b: w.b}
	for _, want := range []int32{0, -1, 1, -2147483648, 2147483647} {
		if got, err := r.i32(); err != nil || got != want {
			t.Fatalf("i32 %d: %d %v", want, got, err)
		}
	}
}

func TestSurfaceRoundTrip(t *testing.T) {
	s := testSurface()
	s.Frame.Cells[3] = Cell{Symbol: "宽", Fg: 0x02ff8000, Bg: 0x01000010, Mod: 1 | 8 | 3<<12, HasLink: true, Link: 0}
	s.Frame.Cells[4] = Cell{Symbol: " ", Skip: true}
	m, err := DecodeMessage(encodeSurface(s))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(m, s) {
		t.Fatalf("decoded %+v", m)
	}
}

func TestDecodeRejectsBadInput(t *testing.T) {
	s := encodeSurface(testSurface())
	for i := 1; i < len(s); i += 7 {
		if _, err := DecodeMessage(s[:i]); err == nil {
			t.Fatalf("truncated at %d accepted", i)
		}
	}
	if _, err := DecodeMessage(append(append([]byte{}, s...), 0)); err == nil {
		t.Fatal("trailing byte accepted")
	}
	// A sequence length larger than the payload is rejected before allocating.
	w := &writer{}
	w.variant(19)
	w.string("b")
	w.varint(1)
	w.varint(1)
	w.varint(2)
	w.varint(1 << 40)
	if _, err := DecodeMessage(w.b); err == nil {
		t.Fatal("huge row count accepted")
	}
	// Grids beyond herdr's limits are refused.
	big := testSurface()
	big.Frame = Frame{W: 4097, H: 1}
	if _, err := DecodeMessage(encodeSurface(big)); err == nil {
		t.Fatal("oversized grid accepted")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0x7f}), MaxFrame); err == nil {
		t.Fatal("oversized frame accepted")
	}
}

func TestGridPatch(t *testing.T) {
	var g Grid
	g.Full(testSurface())
	p := &Patch{BootID: "boot", ProjectionRevision: 3, BaseRevision: 7, SurfaceRevision: 8,
		Rows:   []PatchRow{{X: 2, Y: 1, Cells: []Cell{{Symbol: "h"}, {Symbol: "i"}}}},
		Panes:  []Pane{{ID: "w1:p1", Rect: Rect{0, 0, 6, 4}, Inner: Rect{0, 0, 5, 4}, Focused: false}},
		Cursor: nil}
	m, err := DecodeMessage(encodePatch(p))
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Patch(m.(*Patch)); err != nil {
		t.Fatal(err)
	}
	if text(g.Surface, 1) != "  hi" || g.Surface.SurfaceRevision != 8 || g.Surface.Frame.Cursor != nil || g.Surface.Panes[0].Focused {
		t.Fatalf("after patch: %q %+v", text(g.Surface, 1), g.Surface)
	}
	// Replaying the same patch, or a patch from another projection, fails.
	if err := g.Patch(p); err == nil {
		t.Fatal("stale patch applied")
	}
	bad := *p
	bad.BaseRevision, bad.SurfaceRevision = 8, 9
	bad.Rows = []PatchRow{{X: 5, Y: 0, Cells: []Cell{{Symbol: "a"}, {Symbol: "b"}}}}
	if err := g.Patch(&bad); err == nil {
		t.Fatal("patch past the row end applied")
	}
}

func TestGridDelta(t *testing.T) {
	var g Grid
	base := testSurface()
	g.Full(base)
	next := testSurface()
	next.ProjectionRevision, next.SurfaceRevision = 4, 8
	next.Frame.Cursor = nil
	w := &writer{}
	w.varint(3)
	w.varint(7)
	w.surfaceBody(next, true)
	w.rows([]PatchRow{{X: 0, Y: 3, Cells: []Cell{{Symbol: "z"}}}})
	w.u8(0)
	s, err := g.Delta(base64.RawStdEncoding.EncodeToString(w.b))
	if err != nil {
		t.Fatal(err)
	}
	if text(s, 3) != "z" || s.SurfaceRevision != 8 || g.Surface != s || s.Frame.Cursor != nil {
		t.Fatalf("delta: %q %+v", text(s, 3), s)
	}
	if text(base, 3) != "" {
		t.Fatal("delta changed the previous surface")
	}
	if _, err := g.Delta(base64.RawStdEncoding.EncodeToString(w.b)); err == nil {
		t.Fatal("delta applied twice")
	}
}

func TestApplyScroll(t *testing.T) {
	// A 1-wide region of rows a..e: shift 2 moves content up by two.
	mk := func() []Cell {
		var cs []Cell
		for _, s := range []string{"a", "b", "c", "d", "e"} {
			cs = append(cs, Cell{Symbol: s})
		}
		return cs
	}
	str := func(cs []Cell) string {
		var b strings.Builder
		for _, c := range cs {
			b.WriteString(c.Symbol)
		}
		return b.String()
	}
	cs := mk()
	ApplyScroll(cs, 1, RowMove{Rect{0, 0, 1, 5}, 2})
	if got := str(cs)[:3]; got != "cde" {
		t.Fatalf("up: %s", str(cs))
	}
	cs = mk()
	ApplyScroll(cs, 1, RowMove{Rect{0, 0, 1, 5}, -2})
	if got := str(cs)[2:]; got != "abc" {
		t.Fatalf("down: %s", str(cs))
	}
}

func text(s *Surface, y int) string {
	var b strings.Builder
	w := int(s.Frame.W)
	for x := 0; x < w; x++ {
		c := s.Frame.Cells[y*w+x]
		if !c.Skip {
			b.WriteString(c.Symbol)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

// A session recorded from herdr 0.9.5: replaying its patches and scroll
// controls must reproduce exactly the full surface herdr sent afterwards.
func TestRecordedSession(t *testing.T) {
	files, _ := filepath.Glob("testdata/session/*.bin")
	sort.Strings(files)
	if len(files) == 0 {
		t.Fatal("no recorded session")
	}
	var g Grid
	fulls, scrolls := 0, 0
	for _, f := range files {
		p, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		m, err := DecodeMessage(p)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		switch m := m.(type) {
		case *Surface:
			if g.Surface != nil {
				for y := 0; y < int(m.Frame.H); y++ {
					if a, b := text(g.Surface, y), text(m, y); a != b {
						t.Fatalf("%s row %d: replayed %q, herdr %q", f, y, a, b)
					}
				}
			}
			fulls++
			g.Full(m)
		case *Patch:
			if err := g.Patch(m); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
		case Control:
			switch m.Kind {
			case ScrollKind:
				scrolls++
				if _, _, err := g.ScrollPatch(m.Data); err != nil {
					t.Fatalf("%s: %v", f, err)
				}
			case SnapshotKind:
				var s Snapshot
				if err := json.Unmarshal([]byte(m.Data), &s); err != nil || s.BootID == "" || s.FocusedTabID == "" {
					t.Fatalf("snapshot %+v %v", s, err)
				}
			}
		}
	}
	if fulls < 2 || scrolls == 0 {
		t.Fatalf("recording lacks surfaces (%d) or scrolls (%d)", fulls, scrolls)
	}
	found := false
	for y := 0; y < int(g.Surface.Frame.H); y++ {
		found = found || strings.HasPrefix(text(g.Surface, y), "line20 ")
	}
	if !found {
		for y := 0; y < int(g.Surface.Frame.H); y++ {
			t.Logf("%q", text(g.Surface, y))
		}
		t.Fatal("final surface lacks the last line")
	}
}

func TestHerdrFixtures(t *testing.T) {
	// Every field of herdr's hello fixture is one we send.
	var fixture map[string]any
	data, _ := os.ReadFile("testdata/herdr/endpoint-hello-v1.json")
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	ours, _ := json.Marshal(hello{})
	var mine map[string]any
	json.Unmarshal(ours, &mine)
	for k := range fixture {
		if _, ok := mine[k]; !ok {
			t.Errorf("hello lacks %s", k)
		}
	}
	var w Welcome
	data, _ = os.ReadFile("testdata/herdr/endpoint-welcome-v1.json")
	if err := json.Unmarshal(data, &w); err != nil || w.Generation != 1 || w.SurfaceCodec != surfaceCodec || len(w.Methods) != 1 {
		t.Fatalf("welcome %+v %v", w, err)
	}
	var s Snapshot
	data, _ = os.ReadFile("testdata/herdr/endpoint-snapshot-v1.json")
	if err := json.Unmarshal(data, &s); err != nil || s.BootID != "boot-v1" || s.FocusedTabID != "w1:t1" || s.FocusedPaneID != "w1:p1" {
		t.Fatalf("snapshot %+v %v", s, err)
	}
}

func TestPaneInputEncoding(t *testing.T) {
	txt := "é"
	b, err := EncodePaneInput("p", []InputEvent{
		{T: "key", Key: &KeyEvent{Code: "Char", Char: "é", Mods: ModShift, Text: &txt, TracksRelease: false}},
		{T: "key", Key: &KeyEvent{Code: "F", F: 5, Kind: 2}},
		{T: "mouse", Mouse: &MouseEvent{Kind: "down", Button: 1, Col: 300, Row: 2, Mods: ModCtrl}},
		{T: "paste", Text: "x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{13, 1, 'p', 4,
		0, 15, 0xc3, 0xa9, 1, 0, 1, 0, 1, 2, 0xc3, 0xa9, 0, 0, 0,
		0, 16, 5, 0, 2, 1, 0, 0, 0, 0, 0,
		2, 0, 1, 0, 251, 44, 1, 2, 0, 2, 0,
		3, 1, 'x'}
	if got := b[4:]; !bytes.Equal(got, want) || int(binary.LittleEndian.Uint32(b)) != len(want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
	for _, bad := range []InputEvent{
		{T: "key", Key: &KeyEvent{Code: "Char", Char: "ab"}},
		{T: "key", Key: &KeyEvent{Code: "Nope"}},
		{T: "mouse", Mouse: &MouseEvent{Kind: "down", Button: 9}},
		{T: "other"},
	} {
		if _, err := EncodePaneInput("p", []InputEvent{bad}); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

// fakeServer answers the hello with welcome and then runs fn.
func fakeServer(t *testing.T, welcome Welcome, fn func(c net.Conn)) net.Conn {
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		p, err := ReadFrame(b, MaxHandshakeFrame)
		if err != nil {
			return
		}
		m, _ := DecodeMessage(p)
		if c, ok := m.(Control); !ok || c.Kind != HelloKind {
			t.Errorf("first message %+v", m)
			return
		}
		data, _ := json.Marshal(welcome)
		w := &writer{}
		w.variant(20)
		w.string(WelcomeKind)
		w.string(string(data))
		b.Write(frame(w.b))
		if fn != nil {
			fn(b)
		}
	}()
	return a
}

func goodWelcome() Welcome {
	return Welcome{Generation: 1, ServerVersion: "0.9.5", SnapshotCodec: snapshotCodec, SurfaceCodec: surfaceCodec, InputCodec: inputCodec, BlobCodec: blobCodec}
}

func TestHandshakeErrors(t *testing.T) {
	size := Options{Size: Size{Cols: 80, Rows: 24, CellW: 8, CellH: 16}, Active: true}
	w := goodWelcome()
	w.Error = &struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{"unsupported_generation", "no"}
	_, err := Handshake(context.Background(), fakeServer(t, w, nil), size)
	if he, ok := err.(*HandshakeError); !ok || he.Code != "unsupported_generation" {
		t.Fatalf("error %v", err)
	}
	w = goodWelcome()
	w.SurfaceCodec = "shell.surface.v2"
	if _, err := Handshake(context.Background(), fakeServer(t, w, nil), size); err == nil {
		t.Fatal("foreign codec accepted")
	}
	if _, err := Handshake(context.Background(), fakeServer(t, goodWelcome(), nil), Options{}); err == nil {
		t.Fatal("empty size accepted")
	}
}

func TestRequestAndEvents(t *testing.T) {
	c := fakeServer(t, goodWelcome(), func(s net.Conn) {
		snap := &writer{}
		snap.variant(20)
		snap.string(SnapshotKind)
		snap.string(`{"boot_id":"B","focused_tab_id":"w1:t2"}`)
		s.Write(frame(snap.b))
		s.Write(frame(encodeSurface(testSurface())))
		p, _ := ReadFrame(s, MaxFrame)
		r := &reader{b: p}
		tag, _ := r.variant()
		boot, _ := r.string()
		q, _ := r.string()
		var req struct{ ID, Method string }
		json.Unmarshal([]byte(q), &req)
		if tag != tagRequest || boot != "B" || req.Method != "tab.focus" {
			t.Errorf("request %d %s %s", tag, boot, q)
		}
		resp := `{"id":"` + req.ID + `","result":{"type":"ok"}}`
		for i, part := range []string{resp[:5], resp[5:]} {
			w := &writer{}
			w.variant(18)
			w.string("B")
			w.string(req.ID)
			w.bool(i == 1)
			w.varint(uint64(len(part)))
			w.b = append(w.b, part...)
			s.Write(frame(w.b))
		}
		clip := &writer{}
		clip.variant(5)
		clip.string("aGk=")
		s.Write(frame(clip.b))
		time.Sleep(50 * time.Millisecond)
	})
	conn, err := Handshake(context.Background(), c, Options{Size: Size{Cols: 6, Rows: 4}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan Event, 10)
	go conn.Run(context.Background(), func(e Event) { events <- e })
	if e := <-events; e.Snapshot == nil || e.Snapshot.FocusedTabID != "w1:t2" {
		t.Fatalf("event %+v", e)
	}
	if e := <-events; e.Surface == nil {
		t.Fatalf("event %+v", e)
	}
	res, err := conn.Request(context.Background(), "tab.focus", map[string]string{"tab_id": "w1:t2"})
	if err != nil || string(res) != `{"type":"ok"}` {
		t.Fatalf("result %s %v", res, err)
	}
	if e := <-events; e.Clipboard == nil || *e.Clipboard != "aGk=" {
		t.Fatalf("event %+v", e)
	}
	<-conn.Done()
}
