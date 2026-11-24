package gui

import (
	"context"
	"errors"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/embedded"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
)

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

// elsewhereRetry is how often a machine whose windows another core shows
// is tried again.
var elsewhereRetry = 15 * time.Second

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
	if m.enabled(mc.ID()) {
		m.ensure(mc, true)
		return
	}
	m.mu.Lock()
	d := m.get(mc)
	detachLocked(d)
	d.phase, d.err = PhaseOff, ""
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
}

// detachLocked ends the display's attach stream, if any, and forgets its
// windows; m.mu is held. The display keeps running on the machine until
// idle, and its programs keep their windows.
func detachLocked(d *display) {
	if d.stream != nil {
		d.stream.Close()
		d.stream = nil
		close(d.cmds)
	}
	d.windows, d.order = map[uint32]*agentproto.GUIWindow{}, nil
}

// Disconnected follows the machine leaving the connected states (disabled,
// reconnecting, failing): it detaches and shows the display as
// disconnected, so an earlier error or program windows do not stay on
// screen. The next connection prepares the display again.
func (m *Manager) Disconnected(mc *machines.Machine) {
	m.mu.Lock()
	d := m.ds[mc.ID()]
	if d == nil || (d.phase == PhaseDisconnected && d.stream == nil) {
		m.mu.Unlock()
		return
	}
	detachLocked(d)
	d.phase, d.err = PhaseDisconnected, ""
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
}

// Forget drops the display of a removed machine: it detaches, and browsers
// are told it is disconnected. A preparation still running for it
// publishes nothing more.
func (m *Manager) Forget(id string) {
	m.mu.Lock()
	d := m.ds[id]
	if d == nil {
		m.mu.Unlock()
		return
	}
	delete(m.ds, id)
	detachLocked(d)
	d.gone = true
	d.phase, d.err = PhaseDisconnected, ""
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
}

// onSession reports whether mc is still connected through sess.
func onSession(mc *machines.Machine, sess *transport.Session) bool {
	if mc.Session() != sess {
		return false
	}
	return mc.State().Status == machines.StatusReady
}

// fail shows that preparing or attaching the display over sess failed and
// retries later. A machine that lost that connection meanwhile shows no
// error: the failure is most likely the connection's, and the next one
// prepares the display again.
func (m *Manager) fail(d *display, sess *transport.Session, err error) {
	if !onSession(d.mc, sess) {
		m.setPhase(d, PhaseDisconnected, nil)
		return
	}
	m.setPhase(d, PhaseError, err)
	m.retryLater(d, sess)
}

func (m *Manager) setPhase(d *display, phase string, err error) {
	m.mu.Lock()
	if d.gone {
		m.mu.Unlock()
		return
	}
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

func (m *Manager) request(ctx context.Context, mc *machines.Machine, action string, args ...string) (*agentproto.GUIStatus, error) {
	conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpGUI, Action: action, Args: args})
	if err != nil {
		return nil, err
	}
	conn.Close()
	if rep.GUI == nil {
		return nil, errors.New("agent sent no display status")
	}
	return rep.GUI, nil
}

// wantKind is the kind of display a machine with status st gets when asked
// (the setting) is asked for.
func wantKind(st *agentproto.GUIStatus, asked string) string {
	if asked != DisplayXvfb && st.GPUDisplay {
		return agentproto.GUIXwayland
	}
	return agentproto.GUIXvfb
}

// plan decides from a display's status what preparing it takes: the agent
// actions to run, or the phase to stop at. Read-only mode starts nothing.
// A display of another kind than asked for is started anew, which the
// agent does only while no program uses it.
func plan(st *agentproto.GUIStatus, readOnly bool, asked string) (actions []string, stop string) {
	want := wantKind(st, asked)
	switch {
	case !st.Supported:
		return nil, PhaseUnsupported
	case st.Running && (readOnly || st.Kind == "" || st.Kind == want):
		return nil, ""
	case readOnly:
		return nil, PhaseNotRunning
	case st.Running, want == agentproto.GUIXwayland:
		return []string{"start"}, ""
	case st.Xvfb == "" && !st.Installable:
		return nil, PhaseUnavailable
	case st.Xvfb == "":
		return []string{"install", "start"}, ""
	}
	return []string{"start"}, ""
}

func (m *Manager) prepare(d *display, sess *transport.Session) {
	mc := d.mc
	if !m.enabled(mc.ID()) {
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
		m.fail(d, sess, err)
		return
	}
	m.mu.Lock()
	d.status = st
	m.mu.Unlock()
	asked := m.displayKind(mc.ID())
	actions, stop := plan(st, m.ReadOnly, asked)
	if stop != "" {
		m.setPhase(d, stop, nil)
		return
	}
	for _, a := range actions {
		m.setPhase(d, map[string]string{"install": PhaseInstalling, "start": PhaseStarting}[a], nil)
		m.audit("gui."+a, map[string]any{"machine": mc.ID()})
		var args []string
		if a == "start" {
			args = []string{asked}
		}
		if st, err = m.request(ctx, mc, a, args...); err != nil {
			m.fail(d, sess, err)
			return
		}
	}
	conn, rep, err := mc.Open(context.Background(), agentproto.Header{Op: agentproto.OpGUI, Action: "attach"})
	if err != nil && rep != nil && rep.Code == agentproto.CodeGUIInUse {
		m.setPhase(d, PhaseElsewhere, nil)
		time.AfterFunc(elsewhereRetry, func() {
			if d.mc.Session() == sess {
				m.ensure(d.mc, true)
			}
		})
		return
	}
	if err != nil {
		m.fail(d, sess, err)
		return
	}
	m.mu.Lock()
	// The setting may have been turned off while the display was prepared.
	if !m.enabled(mc.ID()) {
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
	// The keeper is asked for below; the next change with the terminal
	// core reachable asks again, in case it was down meanwhile.
	d.up = false
	d.cmds = make(chan []byte, 256)
	d.windows, d.order, d.layers = map[uint32]*agentproto.GUIWindow{}, nil, map[uint32]agentproto.GUILayer{}
	// The new window manager numbers frames from the start and has no
	// video streams yet.
	d.acked = map[uint32]uint32{}
	d.video, d.codecs = map[uint32][]byte{}, map[uint32]string{}
	for _, vs := range d.viewers {
		for v := range vs {
			v.sent, v.sentBytes, v.stale, v.needKey = nil, 0, false, false
		}
	}
	go writeCommands(conn, d.cmds)
	m.mu.Unlock()
	m.setPhase(d, PhaseReady, nil)
	go m.read(d, sess, conn)
	if keep, _ := afterAttach(m.ReadOnly, false); keep {
		go m.keeper(d)
	}
	if _, push := afterAttach(m.ReadOnly, m.video(mc.ID())); push {
		go m.prepareVideo(d)
	}
	if _, push := afterAttach(m.ReadOnly, m.pick(mc.ID())); push {
		go m.preparePick(d)
	}
}

// ApplyDisplay follows a change of the display setting for a machine: a
// display of another kind than now asked for is prepared anew, which
// replaces it unless a program uses it (then it stays until it ends).
func (m *Manager) ApplyDisplay(mc *machines.Machine) {
	if !m.enabled(mc.ID()) || mc.Local() {
		return
	}
	m.mu.Lock()
	d := m.ds[mc.ID()]
	if d != nil && d.stream != nil {
		if d.status != nil && d.status.Kind == wantKind(d.status, m.displayKind(mc.ID())) {
			m.mu.Unlock()
			return
		}
		detachLocked(d)
		d.phase, d.err = PhaseStarting, ""
		st := m.stateLocked(d)
		m.mu.Unlock()
		m.publish(st)
	} else {
		m.mu.Unlock()
	}
	m.ensure(mc, true)
}

// ApplyPick follows a change of the GPU selection setting for a machine:
// turning it on puts the library on the machine; new panes get it, or no
// longer.
func (m *Manager) ApplyPick(mc *machines.Machine) {
	m.mu.Lock()
	d := m.ds[mc.ID()]
	if d == nil || d.stream == nil {
		m.mu.Unlock()
		return
	}
	st := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(st)
	if _, push := afterAttach(m.ReadOnly, m.pick(mc.ID())); push {
		go m.preparePick(d)
	}
}

// preparePick has a machine with several NVIDIA GPUs install the library
// that shows a program only the GPUs of its CUDA_VISIBLE_DEVICES, which
// the agent carries. Without it panes get the display as before.
func (m *Manager) preparePick(d *display) {
	mc := d.mc
	m.mu.Lock()
	need := d.status != nil && vulkanGPU(d.status) != nil && d.status.Pick == ""
	m.mu.Unlock()
	if !need {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	m.audit("gui.pick", map[string]any{"machine": mc.ID()})
	st, err := m.request(ctx, mc, "pick")
	if err != nil {
		m.Logger.Printf("gui %s: GPU selection: %v", mc.Label(), err)
		return
	}
	m.mu.Lock()
	if d.status == nil || d.gone {
		m.mu.Unlock()
		return
	}
	d.status.Pick = st.Pick
	state := m.stateLocked(d)
	m.mu.Unlock()
	m.publish(state)
}

// ApplyVideo follows a change of the video setting for a machine: viewed
// windows get the streams their viewers share (none when off), and turning
// it on puts the encoder on the machine.
func (m *Manager) ApplyVideo(mc *machines.Machine) {
	m.mu.Lock()
	d := m.ds[mc.ID()]
	if d == nil || d.stream == nil {
		m.mu.Unlock()
		return
	}
	for id, vs := range d.viewers {
		if len(vs) == 0 {
			continue
		}
		old := d.codecs[id]
		if c := m.updateCodecsLocked(d, id); d.codecs[id] != old {
			m.sendLocked(d, agentproto.GUICommand{Cmd: "codecs", ID: id, Codecs: c})
		}
	}
	m.mu.Unlock()
	if _, push := afterAttach(m.ReadOnly, m.video(mc.ID())); push {
		go m.prepareVideo(d)
	}
}

// afterAttach is what the core does on a machine once its display is
// ready: start the display keeper, push the video encoder (when video is
// on for it; the same decides installing the GPU selection library).
// Read-only mode starts and pushes nothing.
func afterAttach(readOnly, video bool) (keep, push bool) {
	if readOnly {
		return false, false
	}
	return true, video
}

// ServerReady follows the machine's terminal core, whose programs get the
// display: each time it is reachable again (or for the first time) while
// the display is attached, the machine is asked to keep the display while
// the terminal core runs, since a keeper started while it was down has
// left.
func (m *Manager) ServerReady(mc *machines.Machine, ready bool) {
	m.mu.Lock()
	d := m.ds[mc.ID()]
	if d == nil {
		m.mu.Unlock()
		return
	}
	start := ready && !d.up && d.stream != nil && d.phase == PhaseReady
	d.up = ready && (d.up || start)
	m.mu.Unlock()
	if keep, _ := afterAttach(m.ReadOnly, false); start && keep {
		go m.keeper(d)
	}
}

// keep has the machine keep its display while its terminal core runs, also
// after this connection ends.
func (m *Manager) keep(d *display) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	m.audit("gui.keep", map[string]any{"machine": d.mc.ID()})
	if _, err := m.request(ctx, d.mc, "keep"); err != nil {
		m.Logger.Printf("gui %s: keeping the display: %v", d.mc.Label(), err)
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
