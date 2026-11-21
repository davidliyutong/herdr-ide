package gui

import (
	"log"
	"net"
	"sort"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/transport"
)

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
	mu    sync.Mutex
	ds    map[string]*display
	// keeper asks a machine to keep its display (tests replace it).
	keeper func(d *display)
}

type display struct {
	mc    *machines.Machine
	phase string
	// up: the machine's terminal core was reachable at the last change
	// seen while the display was attached.
	up       bool
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
	// gone: the machine was removed; a preparation still running for it
	// publishes nothing.
	gone bool

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
	// typed: the terminals whose shell got the export command, with the
	// display.
	// A shell's environment as seen in /proc does not show it.
	typed map[string]string
}

// New returns a manager; settings may be nil (GUI on, vglrun).
func New(st *settings.Store, logger *log.Logger) *Manager {
	m := &Manager{Settings: st, Logger: logger, ds: map[string]*display{}}
	m.keeper = m.keep
	return m
}

// enabled tells whether program windows are shown for a machine.
func (m *Manager) enabled(machine string) bool {
	return m.Settings == nil || m.Settings.Bool(SettingGUI, machine)
}

// video tells whether moving windows of a machine are sent as video.
func (m *Manager) video(machine string) bool {
	return m.Settings == nil || m.Settings.Bool(SettingVideo, machine)
}

// gpu is the machine's VirtualGL mode.
func (m *Manager) gpu(machine string) string {
	if m.Settings == nil {
		return GPUVglrun
	}
	return m.Settings.String(SettingGPU, machine)
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

func (m *Manager) audit(event string, fields map[string]any) {
	if m.Audit != nil {
		m.Audit(event, fields)
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
	if !m.enabled(mc.ID()) || mc.Local() {
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
		if m.gpu(mc.ID()) == GPUAll && d.status.VGLPreload != "" {
			env["LD_PRELOAD"] = d.status.VGLPreload
			env["VGL_ISACTIVE"] = "1"
		}
	}
	return env
}
