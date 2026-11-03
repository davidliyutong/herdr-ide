// Package gui shows windows of programs running on machines in the
// browser: it prepares each remote machine's virtual display through the
// agent, keeps the list of windows, and routes frames and input between the
// agent and the browser windows viewing them (see
// docs/features/14-gui-windows.md).
package gui

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/embedded"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/transport"
)

// Settings.
const (
	SettingGUI = "gui"
	SettingGPU = "gui-gpu"

	GPUVglrun = "vglrun"
	GPUAll    = "all"
)

// SettingDefs are the GUI settings that can be changed at runtime.
var SettingDefs = []settings.Def{
	{
		Key: SettingGUI, Kind: settings.KindEnum, Default: "on", Options: []string{"on", "off"},
		Usage:      "show windows of programs on remote Linux machines: new panes get a virtual display (DISPLAY), Xvfb is fetched in user space when missing; also per machine in the UI",
		PerMachine: settings.ScopeRemote,
	},
	{
		Key: SettingGPU, Kind: settings.KindEnum, Default: GPUVglrun, Options: []string{GPUVglrun, GPUAll},
		Usage:      "OpenGL on machines with VirtualGL: vglrun (programs started with vglrun render on the GPU) or all (every program in new panes runs under VirtualGL); also per machine in the UI",
		PerMachine: settings.ScopeRemote,
	},
}

// Phases of a machine's display; the UI translates them.
const (
	PhaseOff         = "off"
	PhaseLocal       = "local" // windows open on the user's own screen
	PhaseUnsupported = "unsupported"
	PhaseUnavailable = "unavailable" // no Xvfb and none can be fetched
	PhaseInstalling  = "installing"
	PhaseStarting    = "starting"
	PhaseReady       = "ready"
	PhaseError       = "error"
	// PhaseNotRunning: read-only mode, which only shows a display that runs.
	PhaseNotRunning = "not_running"
)

// State is what browsers see for one machine.
type State struct {
	Machine string                 `json:"m"`
	Phase   string                 `json:"phase"`
	Error   string                 `json:"error,omitempty"`
	GPU     bool                   `json:"gpu,omitempty"`
	Windows []agentproto.GUIWindow `json:"windows"`
}

// Viewer is one browser window showing one program window.
type Viewer struct {
	// Send queues a message (agentproto.GUIJSON or GUIFrame payload) without
	// blocking; false means the viewer's queue is full.
	Send func(kind byte, payload []byte) bool
	// Codecs are the kinds of video streams the browser decodes ("avc1",
	// "vp8"); none means pictures only.
	Codecs []string

	sent      []uint32  // frames sent and not acknowledged
	stale     bool      // frames were dropped: needs the whole window again
	refreshed time.Time // last refresh this viewer asked for
	// needKey: video frames were dropped (or none came yet), so the
	// viewer cannot decode until the next key frame.
	needKey  bool
	keyAsked time.Time
}

// refreshEvery bounds how often one viewer may have a window sent in full.
const refreshEvery = 500 * time.Millisecond

// viewerBacklog bounds frames sent to a viewer and not yet shown; frames
// beyond it are dropped for that viewer.
const viewerBacklog = 4

// closeGrace lets a viewer that is reloading come back before its window
// is closed.
var closeGrace = 2 * time.Second

// Manager prepares displays and routes their windows.
type Manager struct {
	Settings *settings.Store
	Logger   *log.Logger
	// OnState is called, without locks held, when a machine's state changes.
	OnState func(State)
	// ReadOnly attaches only to displays that already run: nothing is
	// installed or started on machines.
	ReadOnly bool
	// Audit records installing and starting displays.
	Audit func(event string, fields map[string]any)
	// Video lets machines send windows that keep changing as video to
	// browsers that decode it (--gui-video).
	Video bool

	mu sync.Mutex
	ds map[string]*display
}

type display struct {
	mc       *machines.Machine
	phase    string
	err      string
	status   *agentproto.GUIStatus
	ensuring bool
	// again: a forced ensure arrived while one was running.
	again bool
	// prepared is the session the last preparation ran for, whatever its
	// outcome; state changes of that session do not prepare again.
	prepared *transport.Session
	// failures counts failed preparations and short-lived attachments in a
	// row, for the retry backoff.
	failures int

	sess   *transport.Session
	stream net.Conn
	cmds   chan []byte // to the agent, written by one goroutine per stream

	windows map[uint32]*agentproto.GUIWindow
	order   []uint32
	layers  map[uint32]agentproto.GUILayer
	cursor  []byte
	// video holds each window's current stream (its "video" event), for
	// viewers that join; codecs what its viewers were last said to decode.
	video   map[uint32][]byte
	codecs  map[uint32]string
	viewers map[uint32]map[*Viewer]bool
	acked   map[uint32]uint32
	closing map[uint32]*time.Timer
	// typed: panes whose shell got the export command, with the display.
	// A shell's environment as seen in /proc does not show it.
	typed map[string]string
}

// New returns a manager; settings may be nil (GUI on, vglrun).
func New(st *settings.Store, logger *log.Logger) *Manager {
	return &Manager{Settings: st, Logger: logger, ds: map[string]*display{}}
}

// setting returns a setting's value for a machine.
func (m *Manager) setting(key, machine string) string {
	if m.Settings == nil {
		for _, d := range SettingDefs {
			if d.Key == key {
				return d.Default
			}
		}
		return ""
	}
	return m.Settings.GetFor(key, machine)
}

// get returns the display record of a machine; m.mu is held.
func (m *Manager) get(mc *machines.Machine) *display {
	d := m.ds[mc.ID()]
	if d == nil {
		d = &display{mc: mc, windows: map[uint32]*agentproto.GUIWindow{}, layers: map[uint32]agentproto.GUILayer{},
			video: map[uint32][]byte{}, codecs: map[uint32]string{},
			viewers: map[uint32]map[*Viewer]bool{}, acked: map[uint32]uint32{}, closing: map[uint32]*time.Timer{}, typed: map[string]string{}}
		m.ds[mc.ID()] = d
	}
	return d
}

// Ensure prepares the machine's display and attaches to it, unless that is
// done, under way, or was tried for the machine's current connection (it is
// called on every state change of the machine). It returns at once.
func (m *Manager) Ensure(mc *machines.Machine) {
	m.ensure(mc, false)
}

// ensure prepares the display; force also retries after a preparation that
// did not end attached for the current connection.
func (m *Manager) ensure(mc *machines.Machine, force bool) {
	m.mu.Lock()
	d := m.get(mc)
	sess := mc.Session()
	start := d.claim(sess, force)
	m.mu.Unlock()
	if !start {
		return
	}
	go func() {
		for {
			m.prepare(d, sess)
			m.mu.Lock()
			next := d.finish(sess, mc.Session())
			m.mu.Unlock()
			if next == nil {
				return
			}
			sess = next
		}
	}()
}

// claim decides, with m.mu held, whether to prepare the display for sess
// now; true marks a preparation as running.
func (d *display) claim(sess *transport.Session, force bool) bool {
	if sess == nil || (d.stream != nil && d.sess == sess) {
		return false
	}
	if d.ensuring {
		d.again = d.again || force
		return false
	}
	if !force && d.prepared == sess {
		return false
	}
	if d.prepared != sess {
		d.failures = 0
	}
	d.ensuring = true
	return true
}

// finish records, with m.mu held, that a preparation for sess ended, and
// returns the connection to prepare again for, if any: when a forced ensure
// came in meanwhile, or the machine reconnected (cur).
func (d *display) finish(sess, cur *transport.Session) *transport.Session {
	d.prepared = sess
	again := cur != nil && (d.again || cur != sess) && !(d.stream != nil && d.sess == cur)
	if cur != sess {
		d.failures = 0
	}
	d.again = false
	d.ensuring = again
	if !again {
		return nil
	}
	return cur
}

// retryDelay is the wait before the next attempt after n failures in a row.
func retryDelay(n int) time.Duration {
	return min(5*time.Second<<min(n, 6), 5*time.Minute)
}

// retryLater prepares the display again after a backoff, if the machine is
// still on the same connection.
func (m *Manager) retryLater(d *display, sess *transport.Session) {
	m.mu.Lock()
	delay := retryDelay(d.failures)
	d.failures++
	m.mu.Unlock()
	time.AfterFunc(delay, func() {
		if d.mc.Session() == sess {
			m.ensure(d.mc, true)
		}
	})
}

// Apply follows a change of the GUI setting for a machine: it detaches
// from the machine's display when the setting is off there, and prepares it
// otherwise. A detached display keeps running until idle; its programs keep
// their windows.
func (m *Manager) Apply(mc *machines.Machine) {
	if m.setting(SettingGUI, mc.ID()) != "off" {
		m.ensure(mc, true)
		return
	}
	m.mu.Lock()
	d := m.get(mc)
	if d.stream != nil {
		d.stream.Close()
		d.stream = nil
		close(d.cmds)
	}
	d.phase, d.err = PhaseOff, ""
	d.windows, d.order = map[uint32]*agentproto.GUIWindow{}, nil
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
}

func (m *Manager) setPhase(d *display, phase string, err error) {
	m.mu.Lock()
	d.phase, d.err = phase, ""
	if err != nil {
		d.err = err.Error()
	}
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
}

func (m *Manager) publish(states ...State) {
	if m.OnState == nil {
		return
	}
	for _, st := range states {
		m.OnState(st)
	}
}

func (m *Manager) request(ctx context.Context, mc *machines.Machine, action string) (*agentproto.GUIStatus, error) {
	conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpGUI, Action: action})
	if err != nil {
		return nil, err
	}
	conn.Close()
	if rep.GUI == nil {
		return nil, errors.New("agent sent no display status")
	}
	return rep.GUI, nil
}

// plan decides from a display's status what preparing it takes: the agent
// actions to run, or the phase to stop at. Read-only mode starts nothing.
func plan(st *agentproto.GUIStatus, readOnly bool) (actions []string, stop string) {
	switch {
	case !st.Supported:
		return nil, PhaseUnsupported
	case st.Running:
		return nil, ""
	case readOnly:
		return nil, PhaseNotRunning
	case st.Xvfb == "" && !st.Installable:
		return nil, PhaseUnavailable
	case st.Xvfb == "":
		return []string{"install", "start"}, ""
	}
	return []string{"start"}, ""
}

func (m *Manager) prepare(d *display, sess *transport.Session) {
	mc := d.mc
	if m.setting(SettingGUI, mc.ID()) == "off" {
		m.setPhase(d, PhaseOff, nil)
		return
	}
	if mc.Local() {
		m.setPhase(d, PhaseLocal, nil)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	st, err := m.request(ctx, mc, "status")
	if err != nil {
		m.setPhase(d, PhaseError, err)
		m.retryLater(d, sess)
		return
	}
	m.mu.Lock()
	d.status = st
	m.mu.Unlock()
	actions, stop := plan(st, m.ReadOnly)
	if stop != "" {
		m.setPhase(d, stop, nil)
		return
	}
	for _, a := range actions {
		m.setPhase(d, map[string]string{"install": PhaseInstalling, "start": PhaseStarting}[a], nil)
		m.audit("gui."+a, map[string]any{"machine": mc.ID()})
		if st, err = m.request(ctx, mc, a); err != nil {
			m.setPhase(d, PhaseError, err)
			m.retryLater(d, sess)
			return
		}
	}
	conn, rep, err := mc.Open(context.Background(), agentproto.Header{Op: agentproto.OpGUI, Action: "attach"})
	if err != nil {
		m.setPhase(d, PhaseError, err)
		m.retryLater(d, sess)
		return
	}
	m.mu.Lock()
	// The setting may have been turned off while the display was prepared.
	if m.setting(SettingGUI, mc.ID()) == "off" {
		m.mu.Unlock()
		conn.Close()
		m.setPhase(d, PhaseOff, nil)
		return
	}
	if rep.GUI != nil {
		st = rep.GUI
	}
	if d.stream != nil { // from before a reconnect
		d.stream.Close()
		close(d.cmds)
	}
	d.status, d.sess, d.stream = st, sess, conn
	d.cmds = make(chan []byte, 256)
	d.windows, d.order, d.layers = map[uint32]*agentproto.GUIWindow{}, nil, map[uint32]agentproto.GUILayer{}
	// The new window manager numbers frames from the start.
	d.acked = map[uint32]uint32{}
	for _, vs := range d.viewers {
		for v := range vs {
			v.sent, v.stale = nil, false
		}
	}
	go writeCommands(conn, d.cmds)
	m.mu.Unlock()
	m.setPhase(d, PhaseReady, nil)
	go m.read(d, sess, conn)
	if m.Video && !m.ReadOnly {
		go m.prepareVideo(d)
	}
}

// prepareVideo puts the video encoder this build brings on the machine, so that
// its windows can be sent as video. Without it, or when it fails, windows
// are sent as pictures.
func (m *Manager) prepareVideo(d *display) {
	mc := d.mc
	info := mc.State().Info
	if info == nil {
		return
	}
	gz, digest, err := embedded.Encoder(info.OS, info.Arch)
	if err != nil {
		m.Logger.Printf("gui %s: video: %v", mc.Label(), err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpGUI, Action: "video", Digest: digest})
	if err == nil {
		conn.Close()
	}
	if err == nil && (rep.GUI == nil || !rep.GUI.Video) {
		m.audit("gui.video", map[string]any{"machine": mc.ID(), "sha256": digest})
		rep, err = upload(ctx, mc, agentproto.Header{Op: agentproto.OpGUI, Action: "video-install", Digest: digest}, gz)
	}
	if err != nil {
		m.Logger.Printf("gui %s: video: %v", mc.Label(), err)
		return
	}
	if rep.GUI != nil {
		m.Logger.Printf("gui %s: video encoders %v", mc.Label(), rep.GUI.VideoEncoders)
	}
}

// upload sends body through a chunked stream for an action that answers
// after reading it.
func upload(ctx context.Context, mc *machines.Machine, h agentproto.Header, body []byte) (*agentproto.Reply, error) {
	conn, _, err := mc.Open(ctx, h)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	cw := agentproto.ChunkWriter{W: conn}
	for len(body) > 0 {
		n := min(len(body), 256<<10)
		if _, err := cw.Write(body[:n]); err != nil {
			return nil, err
		}
		body = body[n:]
	}
	if err := cw.Finish(); err != nil {
		return nil, err
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil {
		return nil, err
	}
	if !rep.OK {
		return &rep, errors.New(rep.Error)
	}
	return &rep, nil
}

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
	m.setPhase(d, PhaseError, err)
	m.retryLater(d, sess)
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
		// A program from another herdr session has no pane here.
		if info := d.mc.State().Info; w.Socket != "" && info != nil && info.HerdrSocket != "" && w.Socket != info.HerdrSocket {
			w.Pane = ""
		}
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
	for v := range d.viewers[h.Window] {
		if video && v.needKey && h.Enc != agentproto.GUIEncVideoKey {
			// Undecodable without the frames it missed.
			m.askKeyLocked(d, h.Window, v)
			continue
		}
		if len(v.sent) >= viewerBacklog || !v.Send(agentproto.GUIFrame, payload) {
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
		v.sent = append(v.sent, h.Seq)
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
	if !m.Video {
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

func (m *Manager) audit(event string, fields map[string]any) {
	if m.Audit != nil {
		m.Audit(event, fields)
	}
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

func (m *Manager) stateLocked(d *display) State {
	st := State{Machine: d.mc.ID(), Phase: d.phase, Error: d.err, Windows: []agentproto.GUIWindow{}}
	if st.Phase == "" {
		st.Phase = PhaseStarting
	}
	if d.status != nil {
		st.GPU = d.status.GPU
	}
	for _, id := range d.order {
		if w := d.windows[id]; w != nil {
			st.Windows = append(st.Windows, *w)
		}
	}
	return st
}

// States returns the state of every machine seen so far.
func (m *Manager) States() []State {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.ds))
	for id := range m.ds {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]State, 0, len(ids))
	for _, id := range ids {
		out = append(out, m.stateLocked(m.ds[id]))
	}
	return out
}

// PaneEnv is the environment new panes on mc get, nil when they get none.
func (m *Manager) PaneEnv(mc *machines.Machine) map[string]string {
	if m.setting(SettingGUI, mc.ID()) == "off" || mc.Local() {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ds[mc.ID()]
	// Only a display the agent verified as its own: a number without a
	// server could be taken by someone else.
	if d == nil || d.status == nil || d.status.Display == "" || d.phase != PhaseReady {
		return nil
	}
	env := map[string]string{"DISPLAY": d.status.Display, "XAUTHORITY": d.status.XAuthority}
	if d.status.GPU {
		env["VGL_DISPLAY"] = "egl0"
		if m.setting(SettingGPU, mc.ID()) == GPUAll && d.status.VGLPreload != "" {
			env["LD_PRELOAD"] = d.status.VGLPreload
			env["VGL_ISACTIVE"] = "1"
		}
	}
	return env
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
	c.ID = id
	switch c.Cmd {
	case "ack":
		// Only frames this viewer was sent count; anything else would let
		// a viewer stall or speed up the window for everyone.
		i := 0
		for i < len(v.sent) && v.sent[i] <= c.Seq {
			i++
		}
		if i == 0 || v.sent[i-1] != c.Seq {
			return
		}
		v.sent = v.sent[i:]
		if c.Seq > d.acked[id] {
			d.acked[id] = c.Seq
			m.sendLocked(d, c)
		}
		if v.stale && len(v.sent) == 0 {
			v.stale = false
			m.sendLocked(d, agentproto.GUICommand{Cmd: "refresh", ID: id})
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
			m.sendLocked(d, c)
		}
	case "focus", "close", "pointer", "button", "wheel", "key", "release":
		if input {
			m.sendLocked(d, c)
		}
	}
}

// Errors of Enable.
var (
	ErrOff      = errors.New("program windows are off for this machine")
	ErrNotReady = errors.New("the display is not ready")
)

// EnableResult reports what Enable did.
type EnableResult struct {
	Enabled int      `json:"enabled"` // shells that got the variables typed in
	Already int      `json:"already"` // shells started with the display
	Busy    []string `json:"busy"`    // panes running a program
	Typed   []string `json:"typed"`   // panes typed into
	Failed  []string `json:"failed"`  // panes that could not be reached
	Command string   `json:"command"` // what was typed, for the busy panes
}

// ExportCommand is the shell command that sets env (values single-quoted;
// the leading space keeps it out of shell history where that is enabled).
func ExportCommand(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(" export")
	for _, k := range keys {
		b.WriteString(" " + k + "='" + strings.ReplaceAll(env[k], "'", `'\''`) + "'")
	}
	return b.String()
}

// shellAt returns a pane's shell and whether it waits at its prompt: an
// interactive shell is its own process group, in the foreground while it
// reads a command line.
func shellAt(ctx context.Context, mc *machines.Machine, pane string) (pid int, idle bool, err error) {
	raw, err := mc.Call(ctx, "pane.process_info", map[string]string{"pane_id": pane})
	if err != nil {
		return 0, false, err
	}
	var info struct {
		ProcessInfo struct {
			ShellPid *int `json:"shell_pid"`
			FG       *int `json:"foreground_process_group_id"`
		} `json:"process_info"`
	}
	json.Unmarshal(raw, &info)
	pi := info.ProcessInfo
	if pi.ShellPid == nil {
		return 0, false, nil
	}
	return *pi.ShellPid, pi.FG != nil && *pi.FG == *pi.ShellPid, nil
}

// interruptPause lets a shell handle Ctrl-C before the command follows: the
// terminal discards input that arrives with the interrupt.
var interruptPause = 200 * time.Millisecond

// shellNames are the shells the export command is written for, by
// executable name; anything else in a pane (a program that replaced its
// shell with exec, an agent) is never typed into.
var shellNames = map[string]bool{"bash": true, "zsh": true, "fish": true, "dash": true, "sh": true, "ksh": true, "mksh": true, "yash": true, "ash": true}

// Decisions of Enable for one pane.
const (
	enableAlready = "already"
	enableBusy    = "busy"
	enableType    = "type"
)

// decide tells what Enable does with a pane whose shell is p (nil when the
// agent could not see it): idle means it waits at its prompt, typed that
// the core typed the export into it before.
func decide(p *agentproto.GUIProc, idle, typed bool) string {
	switch {
	case typed || (p != nil && p.Display):
		return enableAlready
	case p == nil || !idle || !shellNames[p.Comm]:
		return enableBusy
	}
	return enableType
}

// typeExport discards a half-typed command line with Ctrl-C, then types
// cmd and Enter.
func typeExport(send func(text string) error, cmd string) error {
	if err := send("\x03"); err != nil {
		return err
	}
	time.Sleep(interruptPause)
	return send(cmd + "\r")
}

// Enable gives panes that were opened without the display (before it
// existed, or outside the UI) the display's environment: a known shell
// waiting at its prompt gets Ctrl-C and the export command; other panes are
// left alone and reported. Panes defaults to every pane of the machine. A
// pane that cannot be reached is reported in Failed; the result always
// lists what was typed, also with an error.
func (m *Manager) Enable(ctx context.Context, mc *machines.Machine, panes []string) (*EnableResult, error) {
	if m.setting(SettingGUI, mc.ID()) == "off" {
		return nil, ErrOff
	}
	env := m.PaneEnv(mc)
	if env == nil {
		return nil, ErrNotReady
	}
	if len(panes) == 0 {
		var snap struct {
			Panes []struct {
				PaneID string `json:"pane_id"`
			} `json:"panes"`
		}
		json.Unmarshal(mc.State().Snapshot, &snap)
		for _, p := range snap.Panes {
			panes = append(panes, p.PaneID)
		}
	}
	type shell struct {
		pane string
		pid  int
		idle bool
	}
	res := &EnableResult{Busy: []string{}, Typed: []string{}, Failed: []string{}, Command: ExportCommand(env)}
	var shells []shell
	var pids []string
	for _, p := range panes {
		pid, idle, err := shellAt(ctx, mc, p)
		switch {
		case err != nil:
			res.Failed = append(res.Failed, p)
		case pid == 0:
			res.Busy = append(res.Busy, p)
		default:
			shells = append(shells, shell{p, pid, idle})
			pids = append(pids, strconv.Itoa(pid))
		}
	}
	procs := map[int]*agentproto.GUIProc{}
	if len(pids) > 0 {
		conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpGUI, Action: "shells", Args: pids})
		if err != nil {
			return res, err // nothing typed yet
		}
		conn.Close()
		if rep.GUI != nil {
			for i := range rep.GUI.Procs {
				procs[rep.GUI.Procs[i].Pid] = &rep.GUI.Procs[i]
			}
		}
	}
	for _, sh := range shells {
		m.mu.Lock()
		typed := m.ds[mc.ID()].typed[sh.pane] == env["DISPLAY"]
		m.mu.Unlock()
		switch decide(procs[sh.pid], sh.idle, typed) {
		case enableAlready:
			res.Already++
			continue
		case enableBusy:
			res.Busy = append(res.Busy, sh.pane)
			continue
		}
		// Check again right before typing: the user may have started a
		// program meanwhile.
		pid, idle, err := shellAt(ctx, mc, sh.pane)
		if err != nil {
			res.Failed = append(res.Failed, sh.pane)
			continue
		}
		if !idle || pid != sh.pid {
			res.Busy = append(res.Busy, sh.pane)
			continue
		}
		send := func(text string) error {
			_, err := mc.Call(ctx, "pane.send_text", map[string]string{"pane_id": sh.pane, "text": text})
			return err
		}
		if err := typeExport(send, res.Command); err != nil {
			res.Failed = append(res.Failed, sh.pane)
			continue
		}
		m.mu.Lock()
		m.ds[mc.ID()].typed[sh.pane] = env["DISPLAY"]
		m.mu.Unlock()
		res.Enabled++
		res.Typed = append(res.Typed, sh.pane)
	}
	return res, nil
}
