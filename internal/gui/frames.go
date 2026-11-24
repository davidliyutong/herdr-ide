package gui

import (
	"encoding/json"
	"net"
	"slices"
	"strings"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/transport"
)

// Viewer is one browser window showing one program window.
type Viewer struct {
	// Send queues a message (agentproto.GUIJSON or GUIFrame payload) without
	// blocking; false means the viewer's queue is full.
	Send func(kind byte, payload []byte) bool
	// Codecs are the kinds of video streams the browser decodes ("avc1",
	// "vp8"); none means pictures only.
	Codecs []string

	sent      []sentFrame // frames sent and not acknowledged
	sentBytes int         // their size
	stale     bool        // frames were dropped: needs the whole window again
	refreshed time.Time   // last refresh this viewer asked for
	// needKey: video frames were dropped (or none came yet), so the
	// viewer cannot decode until the next key frame.
	needKey  bool
	keyAsked time.Time
}

// refreshEvery bounds how often one viewer may have a window sent in full.
const refreshEvery = 500 * time.Millisecond

type sentFrame struct {
	seq   uint32
	at    time.Time
	bytes int
}

// A viewer skips frames while the oldest frame it has not shown was shown
// by another viewer and sent viewerLag ago (the agent goes at the pace of
// the fastest viewer), or while it has viewerMaxFrames or viewerMaxBytes
// unshown.
const (
	viewerLag       = 250 * time.Millisecond
	viewerMaxFrames = 64
	viewerMaxBytes  = 16 << 20
)

// behind reports whether v should skip frames of a window whose frames up
// to acked were shown by some viewer.
func (v *Viewer) behind(acked uint32, now time.Time) bool {
	if len(v.sent) >= viewerMaxFrames || v.sentBytes >= viewerMaxBytes {
		return true
	}
	return len(v.sent) > 0 && v.sent[0].seq <= acked && now.Sub(v.sent[0].at) > viewerLag
}

// closeGrace lets a viewer that is reloading come back before its window
// is closed.
var closeGrace = 2 * time.Second

func writeCommands(conn net.Conn, cmds <-chan []byte) {
	for b := range cmds {
		if err := agentproto.WriteGUI(conn, agentproto.GUIJSON, b); err != nil {
			conn.Close()
			for range cmds {
			}
			return
		}
	}
}

// stableAttach is how long an attachment must last for its end not to count
// as a failure in the retry backoff.
const stableAttach = time.Minute

// read handles the attach stream until it ends.
func (m *Manager) read(d *display, sess *transport.Session, conn net.Conn) {
	attached := time.Now()
	var err error
	for {
		var kind byte
		var payload []byte
		kind, payload, err = agentproto.ReadGUI(conn)
		if err != nil {
			break
		}
		switch kind {
		case agentproto.GUIJSON:
			m.event(d, payload)
		case agentproto.GUIFrame:
			m.frame(d, payload)
		}
	}
	conn.Close()
	m.mu.Lock()
	if d.stream != conn {
		m.mu.Unlock()
		return // replaced or disabled
	}
	d.stream = nil
	close(d.cmds)
	d.windows, d.order = map[uint32]*agentproto.GUIWindow{}, nil
	if time.Since(attached) >= stableAttach {
		d.failures = 0
	}
	m.mu.Unlock()
	if d.mc.Session() != sess {
		return // the machine reconnects and ensures again
	}
	m.fail(d, sess, err)
}

func (m *Manager) event(d *display, payload []byte) {
	var ev agentproto.GUIEvent
	if json.Unmarshal(payload, &ev) != nil {
		return
	}
	m.mu.Lock()
	var st *State
	var targets []*Viewer
	switch ev.Ev {
	case "window":
		if ev.Window == nil {
			break
		}
		w := *ev.Window
		isNew := d.windows[w.ID] == nil
		if isNew {
			d.order = append(d.order, w.ID)
			if len(d.viewers[w.ID]) > 0 {
				// Viewers from before a reconnect.
				m.sendLocked(d, agentproto.GUICommand{Cmd: "watch", ID: w.ID})
			}
		}
		d.windows[w.ID] = &w
		if b, err := json.Marshal(agentproto.GUIEvent{Ev: "window", Window: &w}); err == nil {
			payload = b
		}
		if isNew && w.Transient != 0 {
			// A dialog: the browser window showing its parent opens it, still
			// allowed to by the click that caused it.
			if b, err := json.Marshal(agentproto.GUIEvent{Ev: "child", Window: &w}); err == nil {
				for _, v := range viewersOf(d, w.Transient) {
					v.Send(agentproto.GUIJSON, b)
				}
			}
		}
		s := m.stateLocked(d)
		st = &s
		targets = viewersOf(d, w.ID)
	case "gone":
		delete(d.windows, ev.ID)
		delete(d.video, ev.ID)
		delete(d.codecs, ev.ID)
		for i, id := range d.order {
			if id == ev.ID {
				d.order = append(d.order[:i], d.order[i+1:]...)
				break
			}
		}
		for id, l := range d.layers {
			if l.Window == ev.ID {
				delete(d.layers, id)
			}
		}
		if t := d.closing[ev.ID]; t != nil {
			t.Stop()
			delete(d.closing, ev.ID)
		}
		s := m.stateLocked(d)
		st = &s
		targets = viewersOf(d, ev.ID)
	case "layer":
		if ev.Layer != nil {
			d.layers[ev.Layer.ID] = *ev.Layer
			targets = viewersOf(d, ev.Layer.Window)
		}
	case "layer_gone":
		if l, ok := d.layers[ev.ID]; ok {
			delete(d.layers, ev.ID)
			targets = viewersOf(d, l.Window)
		}
	case "cursor":
		d.cursor = payload
		for id := range d.viewers {
			targets = append(targets, viewersOf(d, id)...)
		}
	case "stats":
		if ev.Stats != nil {
			targets = viewersOf(d, ev.Stats.Window)
		}
	case "role":
		// This core controls the windows, or views them while another
		// does: every viewer is told.
		d.viewOnly = !ev.Control
		s := m.stateLocked(d)
		st = &s
		for id := range d.viewers {
			targets = append(targets, viewersOf(d, id)...)
		}
	case "video":
		// A new stream, which starts with a key frame, or (no codec) the
		// end of the window's stream.
		if ev.Video != nil && d.windows[ev.Video.Window] != nil {
			if ev.Video.Codec == "" {
				delete(d.video, ev.Video.Window)
			} else {
				d.video[ev.Video.Window] = payload
			}
			targets = viewersOf(d, ev.Video.Window)
		}
	}
	for _, v := range targets {
		v.Send(agentproto.GUIJSON, payload)
	}
	m.mu.Unlock()
	if st != nil {
		m.publish(*st)
	}
}

func viewersOf(d *display, id uint32) []*Viewer {
	out := make([]*Viewer, 0, len(d.viewers[id]))
	for v := range d.viewers[id] {
		out = append(out, v)
	}
	return out
}

// frame passes a frame to the viewers of its window; a viewer that is
// behind skips it and gets the whole window once it caught up.
func (m *Manager) frame(d *display, payload []byte) {
	h, err := agentproto.ParseGUIFrameHeader(payload)
	if err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delivered := false
	video := h.Enc == agentproto.GUIEncVideo || h.Enc == agentproto.GUIEncVideoKey
	now := time.Now()
	for v := range d.viewers[h.Window] {
		if video && v.needKey && h.Enc != agentproto.GUIEncVideoKey {
			// Undecodable without the frames it missed.
			m.askKeyLocked(d, h.Window, v)
			continue
		}
		if v.behind(d.acked[h.Window], now) || !v.Send(agentproto.GUIFrame, payload) {
			if video {
				v.needKey = true
			} else {
				v.stale = true
			}
			continue
		}
		if h.Enc == agentproto.GUIEncVideoKey {
			v.needKey = false
		}
		v.sent = append(v.sent, sentFrame{h.Seq, now, len(payload)})
		v.sentBytes += len(payload)
		delivered = true
	}
	// A frame nobody got will not be acknowledged by a viewer; the agent
	// must not wait for it.
	if !delivered && h.Seq > d.acked[h.Window] {
		d.acked[h.Window] = h.Seq
		m.sendLocked(d, agentproto.GUICommand{Cmd: "ack", ID: h.Window, Seq: h.Seq})
	}
}

// askKeyLocked asks the agent for a key frame for a viewer that cannot
// decode the window's video, once it has nothing in flight and at most
// every refreshEvery.
func (m *Manager) askKeyLocked(d *display, id uint32, v *Viewer) {
	if len(v.sent) > 0 || time.Since(v.keyAsked) < refreshEvery {
		return
	}
	v.keyAsked = time.Now()
	m.sendLocked(d, agentproto.GUICommand{Cmd: "keyframe", ID: id})
}

// codecPreference orders the video streams agents are offered: H.264
// (encoded on the GPU) before VP8 (on the CPU); others after, by name.
var codecPreference = []string{"avc1", "vp8"}

// codecsLocked returns the video streams every viewer of window id
// decodes, in codecPreference order.
func (m *Manager) codecsLocked(d *display, id uint32) []string {
	if !m.video(d.mc.ID()) {
		return nil
	}
	var out []string
	first := true
	for v := range d.viewers[id] {
		if first {
			out = append([]string(nil), v.Codecs...)
			first = false
			continue
		}
		out = slices.DeleteFunc(out, func(c string) bool { return !slices.Contains(v.Codecs, c) })
	}
	rank := func(c string) int {
		if i := slices.Index(codecPreference, c); i >= 0 {
			return i
		}
		return len(codecPreference)
	}
	slices.SortStableFunc(out, func(a, b string) int {
		if r := rank(a) - rank(b); r != 0 {
			return r
		}
		return strings.Compare(a, b)
	})
	return out
}

// updateCodecsLocked tells the agent when what the viewers of window id
// decode changed.
func (m *Manager) updateCodecsLocked(d *display, id uint32) []string {
	c := m.codecsLocked(d, id)
	d.codecs[id] = strings.Join(c, ",")
	return c
}

// sendLocked queues a command for the agent; m.mu is held. Commands are
// dropped while the agent does not keep up.
func (m *Manager) sendLocked(d *display, c agentproto.GUICommand) {
	if d.stream == nil {
		return
	}
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	select {
	case d.cmds <- b:
	default:
	}
}

// Attach adds a viewer to a window and sends it what it needs to draw it.
// It returns false when the window does not exist.
func (m *Manager) Attach(machine string, id uint32, v *Viewer) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ds[machine]
	if d == nil || d.windows[id] == nil {
		return false
	}
	if t := d.closing[id]; t != nil {
		t.Stop()
		delete(d.closing, id)
	}
	if b, err := json.Marshal(agentproto.GUIEvent{Ev: "window", Window: d.windows[id]}); err == nil {
		v.Send(agentproto.GUIJSON, b)
	}
	if d.cursor != nil {
		v.Send(agentproto.GUIJSON, d.cursor)
	}
	if b, err := json.Marshal(agentproto.GUIEvent{Ev: "role", Control: !d.viewOnly}); err == nil {
		v.Send(agentproto.GUIJSON, b)
	}
	if b := d.video[id]; b != nil {
		v.Send(agentproto.GUIJSON, b)
		v.needKey = true
	}
	first := len(d.viewers[id]) == 0
	if first {
		d.viewers[id] = map[*Viewer]bool{}
	}
	d.viewers[id][v] = true
	codecs := m.updateCodecsLocked(d, id)
	if first {
		m.sendLocked(d, agentproto.GUICommand{Cmd: "watch", ID: id, Codecs: codecs})
	} else {
		// The whole window, and a key frame to start decoding with.
		m.sendLocked(d, agentproto.GUICommand{Cmd: "refresh", ID: id, Codecs: codecs})
	}
	return true
}

// Detach removes a viewer.
func (m *Manager) Detach(machine string, id uint32, v *Viewer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ds[machine]
	if d == nil || !d.viewers[id][v] {
		return
	}
	delete(d.viewers[id], v)
	if len(d.viewers[id]) > 0 {
		// Those left may decode more.
		old := d.codecs[id]
		if c := m.updateCodecsLocked(d, id); strings.Join(c, ",") != old {
			m.sendLocked(d, agentproto.GUICommand{Cmd: "codecs", ID: id, Codecs: c})
		}
		return
	}
	delete(d.viewers, id)
	delete(d.codecs, id)
	m.sendLocked(d, agentproto.GUICommand{Cmd: "release", ID: id})
	m.sendLocked(d, agentproto.GUICommand{Cmd: "unwatch", ID: id})
}

// Close closes a window whose browser window was closed: after closeGrace,
// unless a viewer is still (or again, after a reload) showing it.
func (m *Manager) Close(machine string, id uint32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ds[machine]
	if d == nil || d.windows[id] == nil || d.closing[id] != nil {
		return
	}
	d.closing[id] = time.AfterFunc(closeGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		delete(d.closing, id)
		if len(d.viewers[id]) == 0 && d.windows[id] != nil {
			m.sendLocked(d, agentproto.GUICommand{Cmd: "close", ID: id})
		}
	})
}

// Command handles a message from a viewer of window id. Input is passed on
// only when allowed (not in read-only mode).
func (m *Manager) Command(machine string, id uint32, v *Viewer, c agentproto.GUICommand, input bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ds[machine]
	if d == nil || !d.viewers[id][v] {
		return
	}
	// Commands for the agent are built here, not passed on: a viewer only
	// chooses which and with which input fields.
	c.ID, c.Codecs = id, nil
	switch c.Cmd {
	case "ack":
		// Only frames this viewer was sent count; anything else would let
		// a viewer stall or speed up the window for everyone.
		i := 0
		for i < len(v.sent) && v.sent[i].seq <= c.Seq {
			i++
		}
		if i == 0 || v.sent[i-1].seq != c.Seq {
			return
		}
		for _, f := range v.sent[:i] {
			v.sentBytes -= f.bytes
		}
		v.sent = v.sent[i:]
		if c.Seq > d.acked[id] {
			d.acked[id] = c.Seq
			m.sendLocked(d, agentproto.GUICommand{Cmd: "ack", ID: id, Seq: c.Seq})
		}
		if v.stale && len(v.sent) == 0 {
			v.stale = false
			m.sendLocked(d, agentproto.GUICommand{Cmd: "refresh", ID: id, Codecs: m.updateCodecsLocked(d, id)})
		}
		if v.needKey && d.video[id] != nil {
			m.askKeyLocked(d, id, v)
		}
	case "keyframe":
		// The browser could not decode the stream.
		if d.video[id] != nil {
			v.needKey = true
			m.askKeyLocked(d, id, v)
		}
	case "refresh":
		if time.Since(v.refreshed) >= refreshEvery {
			v.refreshed = time.Now()
			m.sendLocked(d, agentproto.GUICommand{Cmd: "refresh", ID: id, Codecs: m.updateCodecsLocked(d, id)})
		}
	case "control":
		// Taken at once from the core in control, which then views.
		if input && d.viewOnly {
			m.sendLocked(d, agentproto.GUICommand{Cmd: "control"})
		}
	case "focus", "close", "pointer", "button", "wheel", "key", "release":
		if input && !d.viewOnly {
			m.sendLocked(d, c)
		}
	}
}
