package endpoint

import (
	"context"
	"net"
	"testing"
	"time"
)

// A window drag over a slow link: herdr answers every new grid size with a
// complete surface, so only one such resize is in flight and the sizes
// wanted meanwhile collapse into the latest.
func TestResizeOneInFlight(t *testing.T) {
	got := make(chan Size, 16)
	show := make(chan [2]uint16)
	c := fakeServer(t, goodWelcome(), func(s net.Conn) {
		go func() {
			for wh := range show {
				sf := testSurface()
				sf.Frame = Frame{Cells: blank(wh[0], wh[1], " "), W: wh[0], H: wh[1]}
				sf.Panes, sf.Splits = nil, nil
				s.Write(frame(encodeSurface(sf)))
			}
		}()
		for {
			p, err := ReadFrame(s, MaxFrame)
			if err != nil {
				return
			}
			r := &reader{b: p}
			if tag, _ := r.variant(); tag != tagResize {
				continue
			}
			cw, _ := r.u32()
			ch, _ := r.u32()
			cols, _ := r.u16()
			rows, _ := r.u16()
			got <- Size{Cols: cols, Rows: rows, CellW: cw, CellH: ch}
		}
	})
	defer close(show)
	conn, err := Handshake(context.Background(), c, Options{Size: Size{Cols: 80, Rows: 24, CellW: 8, CellH: 16}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	conn.rmu.Lock()
	conn.wait = time.Hour
	conn.rmu.Unlock()
	go conn.Run(context.Background(), func(Event) {})
	defer conn.Close()

	none := func(step string) {
		t.Helper()
		select {
		case s := <-got:
			t.Fatalf("%s: sent %+v while a resize is in flight", step, s)
		case <-time.After(100 * time.Millisecond):
		}
	}
	sent := func(step string, want Size) {
		t.Helper()
		select {
		case s := <-got:
			if s != want {
				t.Fatalf("%s: sent %+v, want %+v", step, s, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: %+v not sent", step, want)
		}
	}
	sz := func(cols, rows uint16, cell uint32) Size {
		return Size{Cols: cols, Rows: rows, CellW: cell, CellH: 2 * cell}
	}

	// The hello's size is in flight until herdr's first surface.
	conn.Resize(sz(90, 24, 8))
	conn.Resize(sz(100, 30, 8))
	none("before the first surface")
	show <- [2]uint16{80, 24}
	sent("after the first surface", sz(100, 30, 8))

	// A surface of an older size, still on its way, does not end the wait.
	conn.Resize(sz(110, 30, 8))
	conn.Resize(sz(120, 40, 8))
	show <- [2]uint16{80, 24}
	none("after an older surface")
	show <- [2]uint16{100, 30}
	sent("after the asked surface", sz(120, 40, 8))
	show <- [2]uint16{120, 40}

	// A new cell size on the same grid is not answered with a surface:
	// nothing waits for one.
	conn.Resize(sz(120, 40, 9))
	sent("cell size", sz(120, 40, 9))
	conn.Resize(sz(120, 40, 10))
	sent("cell size again", sz(120, 40, 10))

	// herdr answers with another size than asked: the latest size goes out
	// after the wait anyway.
	conn.rmu.Lock()
	conn.wait = 50 * time.Millisecond
	conn.rmu.Unlock()
	conn.Resize(sz(130, 40, 10))
	sent("resize", sz(130, 40, 10))
	conn.Resize(sz(140, 40, 10))
	show <- [2]uint16{129, 40}
	sent("after the wait", sz(140, 40, 10))
}
