package machines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"runtime"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/transport"
)

// LocalSupported tells whether the local machine has an agent: the agent
// (terminals, files, VS Code, program windows) runs on Linux and macOS. On
// Windows the core reaches SSH machines only, and lists the local machine
// in error with CodeLocalUnsupported.
var LocalSupported = runtime.GOOS != "windows"

// CodeLocalUnsupported is the code of the local machine where no agent runs
// (State.Code): it is shown, never dialed.
const CodeLocalUnsupported = "local_unsupported"

// ErrLocalUnsupported is returned for dialing the local machine where no
// agent runs.
var ErrLocalUnsupported = errors.New("the local machine needs Linux or macOS")

// Status of a machine connection.
type Status string

const (
	StatusConnecting Status = "connecting"
	StatusReady      Status = "ready" // the agent answered
	StatusAuth       Status = "auth_required"
	StatusError      Status = "error"
	StatusDisabled   Status = "disabled"
)

// State is what clients see for one machine.
type State struct {
	Spec
	Status Status `json:"status"`
	// Code says why a machine in error is never dialed:
	// CodeInvalidTarget for a stored ssh target ValidTarget refuses,
	// CodeLocalUnsupported for the local machine on Windows. Error
	// is what ssh or the agent said when a connection failed.
	Code     string           `json:"code,omitempty"`
	Error    string           `json:"error,omitempty"`
	Platform string           `json:"platform,omitempty"`
	Info     *agentproto.Info `json:"info,omitempty"`
	// HC is the state of the core's connection to the machine's terminal
	// core, while it has one (internal/server/term.go).
	HC        *HCState `json:"hc,omitempty"`
	UpdatedAt int64    `json:"updated_at"`
}

// HCState is what the core's connection to a machine's terminal core is
// doing: State "starting", "ready" or "error", Code why it is not ready,
// Version the terminal core's.
type HCState struct {
	State   string `json:"state"`
	Code    string `json:"code,omitempty"`
	Version string `json:"version,omitempty"`
}

// SetHC publishes the state of the connection to the machine's terminal
// core; nil when the core has none.
func (m *Machine) SetHC(hc *HCState) {
	m.mu.Lock()
	same := (m.state.HC == nil && hc == nil) || (m.state.HC != nil && hc != nil && *m.state.HC == *hc)
	m.mu.Unlock()
	if !same {
		m.update(func(st *State) { st.HC = hc })
	}
}

// AgentEvent is a terminal's agent status change, used for notifications
// (Manager.PublishAgent).
type AgentEvent struct {
	Machine string          `json:"m"`
	Data    json.RawMessage `json:"data"`
}

// Dialer connects to the agent for a spec.
type Dialer func(ctx context.Context, spec Spec) (*transport.Session, string, error)

// Machine keeps one agent session alive.
type Machine struct {
	spec    Spec
	dial    Dialer
	logger  *log.Logger
	publish func(State)

	mu      sync.Mutex
	state   State
	sess    *transport.Session
	retryCh chan struct{}
	// ssh is what the agent said of its ssh session in its last hello
	// (agentproto.Reply.SSH); it is not part of State, which clients see.
	ssh string
	// enabled is the spec's flag as the user last set it; stopRun ends the
	// connection loop of an enabled machine; enableCh wakes a disabled one
	// (under mu).
	enabled  bool
	stopRun  context.CancelFunc
	enableCh chan struct{}
	// unusable is the code of a machine that is never dialed
	// (CodeInvalidTarget, CodeLocalUnsupported); "" for the others.
	unusable string

	streams StreamHandler
}

func newMachine(spec Spec, dial Dialer, logger *log.Logger, publish func(State)) *Machine {
	m := &Machine{
		spec:     spec,
		dial:     dial,
		logger:   logger,
		publish:  publish,
		retryCh:  make(chan struct{}, 1),
		enabled:  spec.Enabled,
		enableCh: make(chan struct{}, 1),
	}
	m.state = State{Spec: spec, Status: StatusConnecting}
	if !spec.Enabled {
		m.state.Status = StatusDisabled
	}
	if spec.Kind == KindSSH && !ValidTarget(spec.Target) {
		// A stored record whose target could reach ssh as an option or a
		// shell's metacharacter: shown, so that it can be renamed or
		// removed, and never dialed, enabled or not.
		m.unusable = CodeInvalidTarget
	}
	if spec.Kind == KindLocal && !LocalSupported {
		m.unusable = CodeLocalUnsupported
	}
	if m.unusable != "" {
		m.state.Status, m.state.Code = StatusError, m.unusable
	}
	return m
}

// ID returns the machine id.
func (m *Machine) ID() string { return m.spec.ID }

// Label returns the display label.
func (m *Machine) Label() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state.Label
}

// Local reports whether this is the machine the core runs on.
func (m *Machine) Local() bool { return m.spec.Kind == KindLocal }

// SSHConnection is the SSH_CONNECTION of the ssh session the machine's
// agent runs in, as it last reported it ("" when it did not).
func (m *Machine) SSHConnection() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ssh
}

// Kind returns the machine's kind (KindLocal, KindSSH).
func (m *Machine) Kind() string { return m.spec.Kind }

// Target returns an ssh machine's target as configured ("" for the local
// machine).
func (m *Machine) Target() string { return m.spec.Target }

// StreamHandler handles streams opened by the agent (VS Code bridge).
type StreamHandler func(m *Machine, conn net.Conn, h agentproto.Header)

// State returns a copy of the current state.
func (m *Machine) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

func (m *Machine) update(fn func(*State)) {
	m.mu.Lock()
	fn(&m.state)
	m.state.UpdatedAt = time.Now().UnixMilli()
	st := m.state
	m.mu.Unlock()
	m.publish(st)
}

func (m *Machine) setStatus(s Status, err error) {
	m.update(func(st *State) {
		st.Status = s
		st.Error = ""
		if err != nil {
			st.Error = err.Error()
		}
	})
}

// Wake ends a backoff wait at once (after an interactive authentication);
// a connected machine is not affected.
func (m *Machine) Wake() {
	select {
	case m.retryCh <- struct{}{}:
	default:
	}
}

// Session returns the live agent session, if any.
func (m *Machine) Session() *transport.Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sess
}

// ErrNotConnected is returned when the machine has no live session.
var ErrNotConnected = errors.New("machine not connected")

// Open starts an agent stream on this machine.
func (m *Machine) Open(ctx context.Context, h agentproto.Header) (net.Conn, *agentproto.Reply, error) {
	return m.OpenWith(ctx, h, nil)
}

// OpenWith starts an agent stream on this machine with body after the
// header line (transport.Session.OpenWith).
func (m *Machine) OpenWith(ctx context.Context, h agentproto.Header, body []byte) (net.Conn, *agentproto.Reply, error) {
	sess := m.Session()
	if sess == nil {
		return nil, nil, ErrNotConnected
	}
	return sess.OpenWith(ctx, h, body)
}

// Run keeps the machine connected while it is enabled, until ctx ends. A
// machine that is never dialed waits for ctx only.
func (m *Machine) Run(ctx context.Context) {
	if m.unusable != "" {
		<-ctx.Done()
		return
	}
	for ctx.Err() == nil {
		m.mu.Lock()
		on := m.enabled
		var rctx context.Context
		if on {
			var cancel context.CancelFunc
			rctx, cancel = context.WithCancel(ctx)
			m.stopRun = cancel
		}
		m.mu.Unlock()
		if !on {
			select {
			case <-ctx.Done():
				return
			case <-m.enableCh:
			}
			continue
		}
		m.connect(rctx)
		m.mu.Lock()
		m.stopRun()
		m.stopRun = nil
		on = m.enabled
		m.mu.Unlock()
		if !on {
			// The session's last steps may have published a status since.
			m.markDisabled()
		}
	}
}

// setLabel shows the machine under a new label and reports whether it
// changed.
func (m *Machine) setLabel(label string) bool {
	m.mu.Lock()
	same := m.state.Label == label
	m.mu.Unlock()
	if same {
		return false
	}
	m.update(func(st *State) { st.Label = label })
	return true
}

// setEnabled enables or disables the machine and reports whether that
// changed it. Disabling ends its session (the agent exits and stops what it
// started, such as code-server); programs keep running in its terminal
// core.
func (m *Machine) setEnabled(on bool) bool {
	m.mu.Lock()
	changed := m.enabled != on
	m.enabled = on
	stop := m.stopRun
	m.mu.Unlock()
	if !changed {
		return false
	}
	if m.unusable != "" {
		// Its flag is kept; it stays in error, and is never dialed.
		m.update(func(st *State) { st.Enabled = on })
		return true
	}
	if on {
		m.update(func(st *State) {
			st.Enabled = true
			st.Status = StatusConnecting
			st.Error = ""
		})
		select {
		case m.enableCh <- struct{}{}:
		default:
		}
		return true
	}
	if stop != nil {
		stop()
	}
	m.markDisabled()
	return true
}

func (m *Machine) markDisabled() {
	m.update(func(st *State) {
		st.Enabled = false
		st.Status = StatusDisabled
		st.Error = ""
	})
}

// connect keeps the machine connected until ctx ends.
func (m *Machine) connect(ctx context.Context) {
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		m.setStatus(StatusConnecting, nil)
		sess, platform, err := m.dial(ctx, m.spec)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			wait := backoff
			if errors.Is(err, transport.ErrAuthRequired) {
				m.setStatus(StatusAuth, err)
				wait = 30 * time.Second
			} else {
				m.setStatus(StatusError, err)
				backoff = min(backoff*2, 120*time.Second)
			}
			m.logger.Printf("machine %s: %v (retry in %s)", m.Label(), err, wait)
			select {
			case <-ctx.Done():
				return
			case <-m.retryCh:
				backoff = 500 * time.Millisecond
			case <-time.After(wait):
			}
			continue
		}
		backoff = 500 * time.Millisecond
		err = m.serve(ctx, sess, platform)
		sess.Close()
		m.mu.Lock()
		m.sess = nil
		m.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		m.setStatus(StatusError, err)
		m.logger.Printf("machine %s: session ended: %v", m.Label(), err)
		select {
		case <-ctx.Done():
			return
		case <-m.retryCh:
		case <-time.After(time.Second):
		}
	}
}

func (m *Machine) serve(ctx context.Context, sess *transport.Session, platform string) error {
	hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	rep, err := sess.Request(hctx, agentproto.Header{Op: agentproto.OpHello})
	cancel()
	if err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	info := rep.Info
	m.mu.Lock()
	m.sess = sess
	m.ssh = rep.SSH
	m.mu.Unlock()
	// The agent answered: the machine is ready.
	m.update(func(st *State) {
		st.Info = info
		st.Platform = platform
		if platform == "" && info != nil {
			st.Platform = info.OS + "/" + info.Arch
		}
		st.Status, st.Error = StatusReady, ""
	})
	go m.acceptLoop(sess)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-sess.Done():
		return sess.Err()
	}
}

// acceptLoop serves streams the agent opens towards the core.
func (m *Machine) acceptLoop(sess *transport.Session) {
	for {
		st, err := sess.Accept()
		if err != nil {
			return
		}
		go func() {
			var h agentproto.Header
			_ = st.SetReadDeadline(time.Now().Add(15 * time.Second))
			if err := agentproto.ReadLine(st, &h); err != nil {
				st.Close()
				return
			}
			_ = st.SetReadDeadline(time.Time{})
			if m.streams == nil {
				agentproto.Fail(st, errors.New("unsupported"))
				st.Close()
				return
			}
			m.streams(m, st, h)
		}()
	}
}
