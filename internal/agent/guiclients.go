//go:build unix

package agent

import (
	"encoding/json"
	"net"
	"slices"
	"sync"

	"github.com/jezek/xgb/xproto"

	"herdr-ide/internal/agentproto"
)

// Several cores attach to one window manager, one stream each (gui.attach):
// one controls the windows, the others view them. Every client gets every
// window's events and the frames of the windows it watches. Input, focus
// and closing come from the controller only; a viewer asks for control
// (command control) and gets it at once, the controller then viewing. When
// the controller leaves, the client attached longest takes over. Each
// client learns its role from a role event.
//
// Frames go through a queue per client. A window's flow is paced by one
// client, its pacer: the controller while it watches the window, else the
// client attached longest that does. The pacer's acknowledgements make the
// window's flow and its frames wait for room in the pacer's queue; another
// client's frames that do not fit its queue are dropped, and the window is
// sent to it again in full (a key frame for video) once its queue has room.
// A client whose events do not fit its queue is closed: it attaches again.

// guiQueue bounds a client's queued messages.
const guiQueue = 256

// guiOut is one message of the stream to a client.
type guiOut struct {
	kind  byte
	parts [][]byte
}

// guiClient is one core's attach stream.
type guiClient struct {
	conn net.Conn
	s    *session
	q    chan guiOut
	done chan struct{}
	once sync.Once

	// Guarded by the window manager's mu: the windows it watches with the
	// video codecs it decodes, the windows whose frames were dropped (sent
	// in full again once its queue has room), and per window the first
	// frame that is for it (frames before a full one are not).
	watched map[xproto.Window][]string
	stale   map[xproto.Window]bool
	from    map[xproto.Window]uint32
	control bool
}

func newGUIClient(s *session, conn net.Conn) *guiClient {
	return &guiClient{
		conn:    conn,
		s:       s,
		q:       make(chan guiOut, guiQueue),
		done:    make(chan struct{}),
		watched: map[xproto.Window][]string{},
		stale:   map[xproto.Window]bool{},
		from:    map[xproto.Window]uint32{},
	}
}

// writeLoop writes the client's queue to its stream until it closes.
func (c *guiClient) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case m := <-c.q:
			if err := agentproto.WriteGUI(c.conn, m.kind, m.parts...); err != nil {
				c.close()
				return
			}
		}
	}
}

func (c *guiClient) close() {
	c.once.Do(func() {
		close(c.done)
		if c.conn != nil {
			c.conn.Close()
		}
	})
}

// offer queues m without waiting; false when the queue is full or the
// client closed.
func (c *guiClient) offer(m guiOut) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.q <- m:
		return true
	default:
		return false
	}
}

// put queues m, waiting for room; false when the client closed.
func (c *guiClient) put(m guiOut, wmDone <-chan struct{}) bool {
	select {
	case c.q <- m:
		return true
	case <-c.done:
	case <-wmDone:
	}
	return false
}

// event queues ev for c; a client that cannot take it is closed.
func (c *guiClient) event(ev agentproto.GUIEvent) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if !c.offer(guiOut{kind: agentproto.GUIJSON, parts: [][]byte{b}}) {
		c.close()
	}
}

// emit sends ev to every client. Called with mu held.
func (wm *windowManager) emit(ev agentproto.GUIEvent) {
	for _, c := range wm.clients {
		c.event(ev)
	}
}

// serve runs client c's stream: what exists is announced to it, then its
// commands are applied until the stream ends. A newer client of the same
// core replaces an older one (after a reconnect), with its role. False
// when the window manager has ended.
func (wm *windowManager) serve(c *guiClient) (bool, error) {
	wm.mu.Lock()
	select {
	case <-wm.done:
		wm.mu.Unlock()
		return false, nil
	default:
	}
	for _, o := range wm.clients {
		if o.s == c.s || (c.s.client != "" && o.s.client == c.s.client) {
			c.control = c.control || o.control
			o.close()
			wm.dropLocked(o)
		}
	}
	wm.clients = append(wm.clients, c)
	if wm.controller() == nil {
		c.control = true
	}
	go c.writeLoop()
	wm.announce(c)
	wm.mu.Unlock()
	defer func() {
		c.close()
		wm.mu.Lock()
		wm.dropLocked(c)
		last := len(wm.clients) == 0
		wm.mu.Unlock()
		if last {
			wm.close()
		}
	}()
	for {
		kind, payload, err := agentproto.ReadGUI(c.conn)
		if err != nil {
			if isClosedErr(err) {
				err = nil
			}
			return true, err
		}
		if kind != agentproto.GUIJSON {
			continue
		}
		var cmd agentproto.GUICommand
		if json.Unmarshal(payload, &cmd) != nil {
			continue
		}
		wm.mu.Lock()
		wm.command(c, cmd)
		wm.mu.Unlock()
	}
}

// announce tells a new client its role, the windows, their layers and the
// pointer. Called with mu held.
func (wm *windowManager) announce(c *guiClient) {
	c.event(agentproto.GUIEvent{Ev: "role", Control: c.control})
	for _, m := range wm.wins {
		c.event(wm.windowEvent(m))
	}
	for _, l := range wm.layers {
		if ev, ok := wm.layerEvent(l); ok {
			c.event(ev)
		}
	}
	if ev, ok := wm.cursorEvent(); ok {
		c.event(ev)
	}
}

// controller is the client in control; nil without clients. Called with mu
// held.
func (wm *windowManager) controller() *guiClient {
	for _, c := range wm.clients {
		if c.control {
			return c
		}
	}
	return nil
}

// setControl gives c control, the others viewing; held keys and buttons
// are let go. Called with mu held.
func (wm *windowManager) setControl(c *guiClient) {
	if c.control {
		return
	}
	wm.releaseAll()
	for _, o := range wm.clients {
		was := o.control
		o.control = o == c
		if was != o.control {
			o.event(agentproto.GUIEvent{Ev: "role", Control: o.control})
		}
	}
}

// dropLocked removes client c: its windows are watched by the others only,
// and the client attached longest takes control from a controller that
// left. Called with mu held.
func (wm *windowManager) dropLocked(c *guiClient) {
	i := slices.Index(wm.clients, c)
	if i < 0 {
		return
	}
	wm.clients = slices.Delete(wm.clients, i, i+1)
	for id := range c.watched {
		if m := wm.wins[id]; m != nil {
			wm.watchersChanged(m)
		}
	}
	if c.control && len(wm.clients) > 0 {
		c.control = false
		wm.setControl(wm.clients[0])
	}
}

// watchersChanged updates whether window m is watched and the video codecs
// all its watchers decode. Called with mu held.
func (wm *windowManager) watchersChanged(m *managedWin) {
	var codecs []string
	watched := false
	for _, c := range wm.clients {
		cs, ok := c.watched[m.id]
		if !ok {
			continue
		}
		if !watched {
			codecs = slices.Clone(cs)
		} else {
			codecs = slices.DeleteFunc(codecs, func(k string) bool { return !slices.Contains(cs, k) })
		}
		watched = true
	}
	m.watched, m.codecs = watched, codecs
}

// pacer is the client whose acknowledgements pace window m: the controller
// while it watches m, else the client attached longest that does. Called
// with mu held.
func (wm *windowManager) pacer(m *managedWin) *guiClient {
	if c := wm.controller(); c != nil {
		if _, ok := c.watched[m.id]; ok {
			return c
		}
	}
	for _, c := range wm.clients {
		if _, ok := c.watched[m.id]; ok {
			return c
		}
	}
	return nil
}

// repace starts window m's flow anew when its pacer changed: what was on
// its way and what was measured were about another client. Called with mu
// held.
func (wm *windowManager) repace(m *managedWin) {
	p := wm.pacer(m)
	if p == m.pacer {
		return
	}
	m.pacer = p
	m.acked = m.seq
	m.flow = flow{}
	m.inflight = nil
}

// resend sends window m in full to the clients whose frames were dropped,
// once their queues have room. Called with mu held.
func (wm *windowManager) resend(m *managedWin) {
	full := false
	for _, c := range wm.clients {
		if !c.stale[m.id] || len(c.q) > guiQueue/2 {
			continue
		}
		if !full {
			full = true
			m.keyWanted = true
			wm.refresh(m)
		}
		delete(c.stale, m.id)
		c.from[m.id] = m.seq + 1
	}
}

// frameTarget is a client a frame goes to, and whether it paces the window.
type frameTarget struct {
	c    *guiClient
	pace bool
}

// targets are the clients a frame of window w with sequence seq goes to.
// Called with mu held.
func (wm *windowManager) targets(w xproto.Window, seq uint32) []frameTarget {
	m := wm.wins[w]
	if m == nil {
		return nil
	}
	var out []frameTarget
	for _, c := range wm.clients {
		if _, ok := c.watched[w]; !ok || c.stale[w] || int32(seq-c.from[w]) < 0 {
			continue
		}
		out = append(out, frameTarget{c, c == m.pacer})
	}
	return out
}

// deliver queues a frame for its targets: the pacer waits for room,
// another client that has none misses it and is sent the window again
// later. Called without mu.
func (wm *windowManager) deliver(w xproto.Window, ts []frameTarget, msgs []guiOut) {
	for _, t := range ts {
		for _, msg := range msgs {
			if t.pace {
				if !t.c.put(msg, wm.done) {
					break
				}
				continue
			}
			if !t.c.offer(msg) {
				wm.mu.Lock()
				t.c.stale[w] = true
				wm.mu.Unlock()
				break
			}
		}
	}
}
