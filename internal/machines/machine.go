package machines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"webherdr/internal/agentproto"
	"webherdr/internal/herdr"
	"webherdr/internal/transport"
)

// Status of a machine connection.
type Status string

const (
	StatusConnecting Status = "connecting"
	StatusReady      Status = "ready"
	StatusDegraded   Status = "degraded" // agent connected, herdr unreachable
	StatusAuth       Status = "auth_required"
	StatusError      Status = "error"
	StatusDisabled   Status = "disabled"
)

// State is what clients see for one machine.
type State struct {
	Spec
	Status    Status                     `json:"status"`
	Error     string                     `json:"error,omitempty"`
	Platform  string                     `json:"platform,omitempty"`
	Info      *agentproto.Info           `json:"info,omitempty"`
	Snapshot  json.RawMessage            `json:"snapshot,omitempty"`
	Layouts   map[string]json.RawMessage `json:"layouts,omitempty"`
	UpdatedAt int64                      `json:"updated_at"`
}

// AgentEvent is a pane agent status transition, used for notifications.
type AgentEvent struct {
	Machine string          `json:"m"`
	Data    json.RawMessage `json:"data"`
}

// Dialer connects to the agent for a spec.
type Dialer func(ctx context.Context, spec Spec) (*transport.Session, string, error)

// Machine keeps one agent session and herdr view alive.
type Machine struct {
	spec    Spec
	dial    Dialer
	logger  *log.Logger
	publish func(State)
	onAgent func(AgentEvent)

	mu      sync.Mutex
	state   State
	sess    *transport.Session
	api     *herdr.Client
	paneIDs []string
	// paneChange restarts the agent status subscription when panes change.
	paneChange chan struct{}

	refreshCh chan struct{}
	retryCh   chan struct{}

	streams StreamHandler
}

func newMachine(spec Spec, dial Dialer, logger *log.Logger, publish func(State), onAgent func(AgentEvent)) *Machine {
	m := &Machine{
		spec:      spec,
		dial:      dial,
		logger:    logger,
		publish:   publish,
		onAgent:   onAgent,
		refreshCh: make(chan struct{}, 1),
		retryCh:   make(chan struct{}, 1),
	}
	m.state = State{Spec: spec, Status: StatusConnecting}
	if !spec.Enabled {
		m.state.Status = StatusDisabled
	}
	return m
}

// ID returns the machine id.
func (m *Machine) ID() string { return m.spec.ID }

// Label returns the display label.
func (m *Machine) Label() string { return m.spec.Label }

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

// Retry wakes a machine waiting in backoff (e.g. after interactive auth).
func (m *Machine) Retry() {
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

// Call issues a herdr API request on this machine.
func (m *Machine) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	m.mu.Lock()
	api := m.api
	m.mu.Unlock()
	if api == nil {
		return nil, ErrNotConnected
	}
	res, err := api.Call(ctx, method, params)
	if !IsReadOnlyMethod(method) {
		m.Refresh()
	}
	return res, err
}

// IsReadOnlyMethod reports whether a herdr API method only reads state.
func IsReadOnlyMethod(method string) bool {
	switch method {
	case "session.snapshot", "ping":
		return true
	}
	for _, suffix := range []string{".list", ".get", ".read", ".current", ".layout", ".export", ".explain", ".process_info", ".edges", ".neighbor", ".resolve"} {
		if strings.HasSuffix(method, suffix) {
			return true
		}
	}
	return false
}

// Open starts an agent stream on this machine, filling in herdr selection.
func (m *Machine) Open(ctx context.Context, h agentproto.Header) (net.Conn, *agentproto.Reply, error) {
	sess := m.Session()
	if sess == nil {
		return nil, nil, ErrNotConnected
	}
	if h.Session == "" {
		h.Session = m.spec.Session
	}
	if h.HerdrBin == "" {
		m.mu.Lock()
		if m.state.Info != nil {
			h.HerdrBin = m.state.Info.HerdrBin
		}
		m.mu.Unlock()
	}
	return sess.Open(ctx, h)
}

// Refresh schedules a snapshot refetch.
func (m *Machine) Refresh() {
	select {
	case m.refreshCh <- struct{}{}:
	default:
	}
}

// Run keeps the machine connected until ctx ends.
func (m *Machine) Run(ctx context.Context) {
	if !m.spec.Enabled {
		return
	}
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
			m.logger.Printf("machine %s: %v (retry in %s)", m.spec.Label, err, wait)
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
		m.api = nil
		m.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		m.setStatus(StatusError, err)
		m.logger.Printf("machine %s: session ended: %v", m.spec.Label, err)
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
	rep, err := sess.Request(hctx, agentproto.Header{Op: agentproto.OpHello, Session: m.spec.Session, HerdrBin: m.spec.HerdrBin})
	cancel()
	if err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	info := rep.Info
	api := &herdr.Client{Dial: func(ctx context.Context) (net.Conn, error) {
		st, _, err := sess.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrAPI, Session: m.spec.Session})
		return st, err
	}}
	m.mu.Lock()
	m.sess = sess
	m.api = api
	m.mu.Unlock()
	m.update(func(st *State) {
		st.Info = info
		st.Platform = platform
		if platform == "" && info != nil {
			st.Platform = info.OS + "/" + info.Arch
		}
	})
	if info.HerdrError != "" {
		m.setStatus(StatusDegraded, errors.New(info.HerdrError))
	}

	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	go m.acceptLoop(sess)
	go m.lifecycleLoop(sctx, api)
	go m.agentStatusLoop(sctx, api)

	failures := 0
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	m.Refresh()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-sess.Done():
			return sess.Err()
		case <-ticker.C:
		case <-m.refreshCh:
			// Coalesce bursts of events into one fetch.
			select {
			case <-time.After(40 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
			select {
			case <-m.refreshCh:
			default:
			}
		}
		if err := m.fetch(sctx, api); err != nil {
			failures++
			if failures >= 2 {
				m.setStatus(StatusDegraded, err)
			}
			continue
		}
		if failures > 0 || m.State().Status != StatusReady {
			m.setStatus(StatusReady, nil)
		}
		failures = 0
	}
}

type snapshotResult struct {
	Snapshot json.RawMessage `json:"snapshot"`
}

type snapshotPanes struct {
	Tabs []struct {
		TabID string `json:"tab_id"`
	} `json:"tabs"`
	Panes []struct {
		PaneID string `json:"pane_id"`
	} `json:"panes"`
}

func (m *Machine) fetch(ctx context.Context, api *herdr.Client) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var res snapshotResult
	if err := api.CallInto(ctx, "session.snapshot", nil, &res); err != nil {
		return err
	}
	var sp snapshotPanes
	if err := json.Unmarshal(res.Snapshot, &sp); err != nil {
		return err
	}
	layouts := make(map[string]json.RawMessage, len(sp.Tabs))
	var lmu sync.Mutex
	var wg sync.WaitGroup
	for _, t := range sp.Tabs {
		wg.Add(1)
		go func(tabID string) {
			defer wg.Done()
			var out struct {
				Layout json.RawMessage `json:"layout"`
			}
			if err := api.CallInto(ctx, "layout.export", map[string]any{"tab_id": tabID}, &out); err == nil {
				lmu.Lock()
				layouts[tabID] = out.Layout
				lmu.Unlock()
			}
		}(t.TabID)
	}
	wg.Wait()

	ids := make([]string, 0, len(sp.Panes))
	for _, p := range sp.Panes {
		ids = append(ids, p.PaneID)
	}
	sort.Strings(ids)
	m.mu.Lock()
	changed := strings.Join(ids, ",") != strings.Join(m.paneIDs, ",")
	m.paneIDs = ids
	m.mu.Unlock()
	if changed {
		m.paneSetChanged()
	}

	m.mu.Lock()
	same := string(m.state.Snapshot) == string(res.Snapshot) && layoutsEqual(m.state.Layouts, layouts)
	m.mu.Unlock()
	if !same {
		m.update(func(st *State) {
			st.Snapshot = res.Snapshot
			st.Layouts = layouts
		})
	}
	return nil
}

func layoutsEqual(a, b map[string]json.RawMessage) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if string(b[k]) != string(v) {
			return false
		}
	}
	return true
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

var lifecycleSubs = []string{
	"workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed",
	"workspace.moved", "workspace.reordered", "workspace.closed", "workspace.focused",
	"worktree.created", "worktree.opened", "worktree.removed",
	"tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
	"pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited",
	"pane.agent_detected", "layout.updated",
}

func (m *Machine) lifecycleLoop(ctx context.Context, api *herdr.Client) {
	subs := make([]map[string]any, 0, len(lifecycleSubs))
	for _, t := range lifecycleSubs {
		subs = append(subs, map[string]any{"type": t})
	}
	for ctx.Err() == nil {
		err := api.Subscribe(ctx, subs, m.Refresh, func(herdr.Event) error {
			m.Refresh()
			return nil
		})
		if ctx.Err() != nil {
			return
		}
		m.logger.Printf("machine %s: lifecycle subscription: %v", m.spec.Label, err)
		m.Refresh()
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (m *Machine) paneSetChanged() {
	m.mu.Lock()
	ch := m.paneChange
	m.mu.Unlock()
	if ch != nil {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (m *Machine) agentStatusLoop(ctx context.Context, api *herdr.Client) {
	change := make(chan struct{}, 1)
	m.mu.Lock()
	m.paneChange = change
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.paneChange = nil
		m.mu.Unlock()
	}()
	for ctx.Err() == nil {
		m.mu.Lock()
		ids := append([]string(nil), m.paneIDs...)
		m.mu.Unlock()
		if len(ids) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-change:
				continue
			}
		}
		subs := make([]map[string]any, 0, len(ids))
		for _, id := range ids {
			subs = append(subs, map[string]any{"type": "pane.agent_status_changed", "pane_id": id})
		}
		sctx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- api.Subscribe(sctx, subs, nil, func(ev herdr.Event) error {
				m.onAgent(AgentEvent{Machine: m.spec.ID, Data: ev.Data})
				m.Refresh()
				return nil
			})
		}()
		select {
		case <-ctx.Done():
			cancel()
			<-done
			return
		case <-change:
			cancel()
			<-done
		case err := <-done:
			cancel()
			if ctx.Err() != nil {
				return
			}
			// A pane that closed between snapshot and subscribe makes the
			// whole request fail; refetch and retry shortly.
			m.logger.Printf("machine %s: agent status subscription: %v", m.spec.Label, err)
			m.Refresh()
			select {
			case <-ctx.Done():
				return
			case <-change:
			case <-time.After(2 * time.Second):
			}
		}
	}
}
